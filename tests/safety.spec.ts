/**
 * Runtime-driven safety tests: automatic pressure rollover, provider-confirmed
 * context-overflow recovery with retry, rollover requested at the turn-stop
 * boundary, and the forced-span `compactRegion` path.
 *
 * @module tests/safety.spec
 */

import { describe, expect, it } from 'vitest'

/** Capture the engine's swallowed warnings and failed compaction closes. */
function captureDiagnostics(ctx: { logger: { warn: (message: string) => void } }, session: { snapshotEvents(): readonly unknown[] }): { warnings: string[]; compactionErrors: string[] } {
  const warnings: string[] = []
  const original = ctx.logger.warn.bind(ctx.logger)
  ctx.logger.warn = (message: string): void => {
    warnings.push(message)
    original(message)
  }
  const compactionErrors: string[] = []
  for (const event of session.snapshotEvents()) {
    const data = (event as { type: string; data: { error?: string } }).data
    if ((event as { type: string }).type === 'compaction/end' && typeof data?.error === 'string') {
      compactionErrors.push(data.error)
    }
  }
  return { warnings, compactionErrors }
}

import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { countRollovers } from '../src/rollover.ts'
import {
  closedConversation,
  derivedTexts,
  engineHarness,
  errorFinish,
  followup,
  ScriptedAdapter,
  seedExchanges,
  textResponse,
  usageResponse,
} from './harness.ts'

describe('automatic pressure rollover', () => {
  it('rolls over with a recovery record when usage crosses the threshold', async () => {
    const { ctx, agent, session } = await engineHarness('pressure-auto', {
      // 100 tokens of a 100k window: the first honest reading crosses it.
      thresholdRatio: 0.001,
      reminderThresholdRatio: 0.001,
      // Tail budget above the whole (tiny) surface: the rollover replaces
      // everything, and the shrink guard compares against the full span.
      retainTokens: 2000,
    })
    // Long answers so the shadowed span's priced surface dwarfs the
    // checkpoint (the shrink guard compares heuristic node pricing).
    const adapter = new ScriptedAdapter([
      usageResponse(`research answer one ${'detail '.repeat(600)}`, 5000),
      usageResponse('research answer two', 6000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    expect(countRollovers(session)).toBe(0)

    await followup(agent, 'turn two')

    // The first post-usage pre-step crossed the threshold and rolled over
    // automatically; the turn then continued on the fresh window.
    const diagnostics = captureDiagnostics(ctx, session)
    const rolloverCount = countRollovers(session)
    if (rolloverCount !== 1) {
      throw new Error(
        `expected one committed rollover, got ${rolloverCount}; `
        + `warnings: ${diagnostics.warnings.join('; ')}; `
        + `compaction errors: ${diagnostics.compactionErrors.join('; ')}`,
      )
    }
    const texts = derivedTexts(session).join('\n')
    expect(texts).toContain('reason: pressure')
    expect(texts).toContain('Recovery record')
    expect(texts).toContain('turn one')
    expect(texts).toContain('research answer two')
  })
})

describe('context-overflow recovery', () => {
  it('rolls over on a provider overflow failure and retries the request', async () => {
    const { ctx, agent, session } = await engineHarness('overflow')
    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 20 }, (_unused, index) => textResponse(`finding ${index} details`)),
      errorFinish('request too large for model context window', CONTEXT_WINDOW_EXCEEDED_CODE),
      textResponse('recovered after rollover'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'next request should overflow')

    // The overflow forced one rollover and the loop resent the request.
    expect(countRollovers(session)).toBe(1)
    const texts = derivedTexts(session).join('\n')
    expect(texts).toContain('reason: overflow')
    expect(texts).toContain('Recovery record')
    expect(texts).toContain('recovered after rollover')
    // The failing request happened, then exactly one retry.
    const answered = adapter.requests.filter(request => JSON.stringify(request).includes('overflow'))
    expect(answered.length).toBe(2)
  })
})

describe('rollover at the turn-stop boundary', () => {
  it('consumes a pending request when the turn ends without a further pre-step', async () => {
    const { ctx, agent, engine } = await engineHarness('turn-stopping', { retainTokens: 0 })

    // A session with a closed history and one still-open turn, outside the
    // agent loop: the turn-stopping listener must roll it over on its own.
    const session = closedConversation(12)
    session.append('turn/start', { turn: 7 })
    session.append('step/start', { turn: 7, step: 1 })
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'mock' } },
      reason: 'resume',
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'final exchange before stop' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/end', { turn: 7, step: 1 })
    // Turn 7 stays open: this is the stop boundary under test.
    const fakeAgent = { session, options: {} } as Agent
    const pending = (engine as unknown as {
      pendingRollovers: Map<string, { handoff: string | null }>
    }).pendingRollovers
    pending.set(session.id, { handoff: 'stop here' })

    // Dispatch through the real agent fiber as the scope carrier, the way
    // the agent loop itself serially dispatches the stop boundary.
    await (ctx as unknown as {
      serial: (carrier: unknown, name: string, payload: unknown) => Promise<void>
    }).serial(agent, 'agent/turn-stopping', {
      agent: fakeAgent,
      turn: 7,
      signal: new AbortController().signal,
    })

    const diagnostics = captureDiagnostics(ctx, session)
    const rolloverCount = countRollovers(session)
    if (rolloverCount !== 1) {
      throw new Error(
        `expected one committed rollover, got ${rolloverCount}; `
        + `warnings: ${diagnostics.warnings.join('; ')}; `
        + `compaction errors: ${diagnostics.compactionErrors.join('; ')}`,
      )
    }
    const texts = derivedTexts(session).join('\n')
    expect(texts).toContain('reason: model-requested')
    expect(texts).toContain('stop here')
    expect(pending.has(session.id)).toBe(false)
  })
})

describe('forced-span compaction', () => {
  it('replaces the requested span with a rollover checkpoint', async () => {
    const { engine } = await engineHarness('compact-region')
    const session = closedConversation(8)
    session.append('turn/start', { turn: 5 })
    const fakeAgent = { session, options: {} } as Agent
    const nodes = session.surface.nodes
    const start = nodes[0]
    const end = nodes[nodes.length - 1]
    if (start === undefined || end === undefined) throw new Error('expected surface nodes')

    const result = await engine.compactRegion(start, end, fakeAgent)

    expect(countRollovers(session)).toBe(1)
    expect(result.shadowedSeqs.length).toBeGreaterThan(0)
    const texts = derivedTexts(session).join('\n')
    expect(texts).toContain('<context-rollover checkpoint>')
    expect(texts).toContain('reason: manual')
    // Assistant prose is excluded from the recovery record; direct user
    // messages are carried verbatim by design.
    expect(texts).not.toContain('assistant: exchange 1')
  })
})
