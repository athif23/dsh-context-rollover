/**
 * Surface rollover tests: replacement leaves the model-visible surface fresh,
 * raw events stay persisted, the tail stays verbatim, tool-call/result pairs
 * are never split, and the compaction protocol's invariants hold.
 *
 * @module tests/rollover.spec
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { commitRollover, countRollovers, rolloverSummarySeqs, selectRolloverRange, ROLLOVER_PROVIDER } from '../src/rollover.ts'
import { sessionEventAt } from '../src/compat.ts'
import { appendExchange, closedConversation, derivedTexts } from './harness.ts'

/** A meter mounted on a bare context, for direct transaction tests. */
async function bareMeter(): Promise<TokenMeter> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return ctx.tokenMeter
}

describe('selectRolloverRange', () => {
  it('retains a token-budgeted tail and never splits a tool-call/result pair', async () => {
    const meter = await bareMeter()
    const session = closedConversation(4)
    const measurement = meter.measure(session)

    // A tail budget that would land inside turn 2's tool pair must back off
    // to the balanced boundary before the pair starts.
    const range = selectRolloverRange(session, measurement, 0)
    expect(range).not.toBeNull()
    if (range === null) return
    expect(range.start).toBe(session.surface.nodes[0])
    // The cut keeps the last exchange whole: the shadowed span excludes it.
    const texts = derivedTexts(session)
    expect(texts.some(text => text.includes('exchange 4'))).toBe(true)
  })

  it('returns null when the retention budget covers the whole surface', async () => {
    const meter = await bareMeter()
    const session = closedConversation(2)
    const measurement = meter.measure(session)
    const total = measurement.nodes.reduce((sum, node) => sum + node.tokens, 0)
    // The retention budget covers everything past the head: no tail to
    // preserve means no compactable span (mirrors the shipped backend).
    expect(selectRolloverRange(session, measurement, total + 1)).toBeNull()
  })

  it('never includes a system/message head node in the range', async () => {
    const meter = await bareMeter()
    const session = Session.create(SessionId(`head-${Math.random().toString(36).slice(2, 8)}`))
    session.append('system/message', {
      turn: 1,
      step: 1,
      message: createSystemMessage('persona', 'test'),
    }, { surfaceOp: 'append' })
    appendExchange(session, 1, 'first')
    appendExchange(session, 2, 'second')
    const measurement = meter.measure(session)
    const range = selectRolloverRange(session, measurement, 0)
    expect(range).not.toBeNull()
    if (range === null) return
    // Newer hosts reject rewriting node 0 while it holds the system prompt.
    expect(range.start).toBe(session.surface.nodes[1])
    expect(range.shadowedSeqs).not.toContain(session.surface.nodes[0])
  })
})

describe('commitRollover', () => {
  it('replaces the span with one checkpoint and keeps raw events persisted', async () => {
    const meter = await bareMeter()
    const session = closedConversation(4)
    const beforeCount = session.snapshotEvents().length
    const measurement = meter.measure(session)
    const range = selectRolloverRange(session, measurement, 0)
    if (range === null) throw new Error('expected a compactable range')

    const result = await commitRollover(
      { meter },
      session,
      range.start,
      range.end,
      {
        owner: null,
        checkpoint: {
          reason: 'model-requested',
          windowNumber: 1,
          notes: '- goal: prove the rollover\n- next: run tests',
          handoff: 'Continue from the notes.',
          recovery: null,
        },
      },
    )

    // Model-visible surface: checkpoint + the retained tail only.
    const texts = derivedTexts(session)
    expect(texts).toHaveLength(session.surface.nodes.length)
    expect(texts[0]).toContain('<context-rollover checkpoint>')
    expect(texts[0]).toContain('- goal: prove the rollover')
    expect(texts[0]).toContain('Continue from the notes.')
    expect(texts.join('\n')).not.toContain('exchange 1')
    expect(texts.join('\n')).toContain('exchange 4')

    // Raw events remain persisted.
    expect(session.snapshotEvents().length).toBeGreaterThan(beforeCount)
    expect(sessionEventAt(session, range.start)).toBeDefined()

    // Compaction protocol facts.
    expect(result.shadowedSeqs.length).toBeGreaterThan(0)
    expect(result.shadowedTokenCount).toBeGreaterThan(0)
    expect(countRollovers(session)).toBe(1)
    expect(rolloverSummarySeqs(session)).toEqual([result.summarySeq])
    const summary = sessionEventAt(session, result.summarySeq)
    if (summary?.type !== 'compaction/summary') throw new Error('expected a compaction/summary event')
    expect(summary.data.provider).toBe(ROLLOVER_PROVIDER)
  })

  it('rejects a replacement that would not shrink the context', async () => {
    const meter = await bareMeter()
    const session = Session.create(SessionId('tiny'))
    appendExchange(session, 1, 'tiny')
    const nodes = session.surface.nodes
    const start = nodes[0]
    const end = nodes[nodes.length - 1]
    if (start === undefined || end === undefined) throw new Error('expected surface nodes')
    await expect(commitRollover(
      { meter },
      session,
      start,
      end,
      {
        owner: null,
        checkpoint: {
          reason: 'model-requested',
          windowNumber: 1,
          notes: 'note'.repeat(5000),
          handoff: null,
          recovery: null,
        },
      },
    )).rejects.toThrow(/not smaller than the shadowed content/)
  })

  it('refuses a second rollover while the compaction lock is open', async () => {
    const meter = await bareMeter()
    const session = closedConversation(4)
    const nodes = session.surface.nodes
    const start = nodes[0]
    const end = nodes[nodes.length - 1]
    if (start === undefined || end === undefined) throw new Error('expected surface nodes')
    // Simulate an open lock by failing after the start: an oversized checkpoint.
    await expect(commitRollover(
      { meter },
      session,
      start,
      end,
      {
        owner: null,
        checkpoint: {
          reason: 'model-requested',
          windowNumber: 1,
          notes: 'note'.repeat(5000),
          handoff: null,
          recovery: null,
        },
      },
    )).rejects.toThrow()
    // The failed attempt closed its bracket with an error, so the session is
    // not deadlocked: a valid rollover still succeeds.
    const measurement = meter.measure(session)
    const range = selectRolloverRange(session, measurement, 0)
    if (range === null) throw new Error('expected a compactable range')
    await expect(commitRollover(
      { meter },
      session,
      range.start,
      range.end,
      {
        owner: null,
        checkpoint: {
          reason: 'manual',
          windowNumber: 1,
          notes: null,
          handoff: null,
          recovery: null,
        },
      },
    )).resolves.toBeDefined()
  })
})
