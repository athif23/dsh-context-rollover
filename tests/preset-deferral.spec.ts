/**
 * Host/preset ownership: the host engine stands down when the session's agent
 * preset provides its own compaction backend, so two backends never race one
 * pressure signal. Rosterless deployments keep the host behavior (covered by
 * the engine suite's no-roster tests).
 *
 * @module tests/preset-deferral
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { countRollovers } from '../src/rollover.ts'
import { ContextRolloverEngine } from '../src/index.ts'
import {
  engineHarness,
  followup,
  mountTestContext,
  newContextCall,
  ScriptedAdapter,
  seedExchanges,
  tempNotesDir,
  textResponse,
} from './harness.ts'

/** Install a fake preset roster whose composition owns `compaction`. */
function provideRoster(ctx: Context, owner: CompactionEngine | undefined): void {
  (ctx as unknown as { provide(name: string, value: unknown): void })
    .provide('agentPresets', { serviceFor: () => owner })
}

describe('preset ownership', () => {
  it('stands down manual and automatic compaction for a preset-owned session', async () => {
    const { ctx, engine, agent, session } = await engineHarness('defer-other')
    const adapter = new ScriptedAdapter(
      Array.from({ length: 20 }, (_unused, index) => textResponse(`background ${index}`)),
    )
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'background work')
    provideRoster(ctx, {} as CompactionEngine)

    const compacted = await engine.compactNow(agent, new AbortController().signal)
    expect(compacted).toBeNull()
    const pressured = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    expect(pressured).toBeNull()
    expect(countRollovers(session)).toBe(0)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
  })

  it('refuses host-region commits for a preset-owned session, but not otherwise', async () => {
    // compactRegion never reaches the commit path here (empty surface), so
    // this exercises only the ownership gate in both directions.
    const start = 0 as unknown as SessionSeq
    const end = 1 as unknown as SessionSeq
    const noRoster = await engineHarness('defer-none')
    await expect(noRoster.engine.compactRegion(start, end, noRoster.agent)).rejects.toThrow(/not found in surface/)

    const owned = await engineHarness('defer-region')
    provideRoster(owned.ctx, {} as CompactionEngine)
    await expect(owned.engine.compactRegion(start, end, owned.agent)).rejects.toThrow(/owned by its agent preset/)

    const selfOwned = await engineHarness('defer-region-self')
    provideRoster(selfOwned.ctx, selfOwned.engine)
    await expect(selfOwned.engine.compactRegion(start, end, selfOwned.agent)).rejects.toThrow(/not found in surface/)
  })

  it('answers new_context honestly instead of promising a boundary', async () => {
    const { ctx, agent, session } = await engineHarness('defer-honest')
    provideRoster(ctx, {} as CompactionEngine)
    const adapter = new ScriptedAdapter([
      newContextCall('{"handoff":"Continue the work."}'),
      textResponse('noted'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'Roll over, please.')

    // Nothing was recorded and nothing committed; the model-visible result
    // points at the preset that actually rolls over.
    expect(countRollovers(session)).toBe(0)
    const tailResultSeq = session.surface.nodes
      .map(seq => session.eventAt(seq))
      .filter(event => event?.type === 'tool/result')
      .map(event => event?.seq)
      .pop()
    const tailResult = tailResultSeq === undefined ? undefined : session.eventAt(tailResultSeq)
    expect(JSON.stringify(tailResult?.data)).toContain('agent preset')
  })

  it('registers no global tools where a preset roster exists', async () => {
    const ctx = await mountTestContext()
    provideRoster(ctx, undefined)
    const engine = new ContextRolloverEngine(ctx, { notesDir: await tempNotesDir() })
    expect(engine).toBeDefined()
    // Preset deployments surface these tools from their own composition;
    // globals would leak rollover-framed tools into unopted presets.
    for (const name of ['new_context', 'get_context_remaining', 'notes', 'history']) {
      expect(ctx.tools.get(name)).toBeUndefined()
    }
  })

  it('registers global tools on rosterless deployments', async () => {
    const { ctx } = await engineHarness('defer-tools-present')
    for (const name of ['new_context', 'get_context_remaining', 'notes', 'history']) {
      expect(ctx.tools.get(name)).toBeDefined()
    }
  })
})
