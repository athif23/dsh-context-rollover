/**
 * Engine integration tests over the real agent loop: model-requested rollover
 * through the `new_context` tool, notes/handoff carry-over, one-per-window
 * pressure reminders, and manual rollover behind the compaction command.
 *
 * @module tests/engine.spec
 */

import { describe, expect, it } from 'vitest'
import { countRollovers } from '../src/rollover.ts'
import { NotesStore } from '../src/notes.ts'
import {
  derivedTexts,
  engineHarness,
  followup,
  newContextCall,
  reminderTexts,
  ScriptedAdapter,
  seedExchanges,
  textResponse,
  usageResponse,
} from './harness.ts'

describe('ContextRolloverEngine', () => {
  it('rolls over when the model calls new_context mid-turn and continues from notes + tail', async () => {
    const { ctx, agent, session, notesBase } = await engineHarness('model-requested')

    // Seed durable notes as if the model had saved its research.
    const store = new NotesStore(NotesStore.directoryFor(session.id, notesBase))
    await store.write('state.md', 'goal: prove model-driven rollover\nnext: implement')

    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 20 }, (_unused, index) => textResponse(`finding ${index} details`)),
      newContextCall('{"handoff":"Implement the notes next steps."}'),
      textResponse('implementing now'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'Research is done; roll over and implement.')

    // The rollover committed exactly once and the fresh window carries the
    // notes and the handoff.
    expect(countRollovers(session)).toBe(1)
    const texts = derivedTexts(session).join('\n')
    expect(texts).toContain('<context-rollover checkpoint>')
    expect(texts).toContain('prove model-driven rollover')
    expect(texts).toContain('Implement the notes next steps.')
    expect(texts).toContain('reason: model-requested')
    // The new_context tool result stayed in the recent tail, next to the
    // post-rollover answer.
    const tailResultSeq = session.surface.nodes
      .map(seq => session.eventAt(seq))
      .filter(event => event?.type === 'tool/result')
      .map(event => event?.seq)
      .pop()
    const tailResult = tailResultSeq === undefined ? undefined : session.eventAt(tailResultSeq)
    expect(JSON.stringify(tailResult?.data)).toContain('A new context window will start')
    // The assistant's post-rollover answer arrived on the fresh window.
    expect(texts).toContain('implementing now')
  })

  it('delivers the pressure reminder at most once per window', async () => {
    const { ctx, agent, session } = await engineHarness('reminder', {
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.01,
    })
    const adapter = new ScriptedAdapter([
      usageResponse('answer 1', 5000),
      usageResponse('answer 2', 6000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    // The first post-usage pre-step crossed the 1% threshold and reminded
    // once; the second turn must not repeat it (same window, no rollover).
    const reminders = reminderTexts(session)
    expect(reminders).toHaveLength(1)
    expect(reminders[0]).toContain('automatic rollover')
    expect(countRollovers(session)).toBe(0)
  })

  it('performs a manual rollover via compactNow on an idle agent', async () => {
    const { ctx, engine, agent, session } = await engineHarness('manual')
    const adapter = new ScriptedAdapter(
      Array.from({ length: 20 }, (_unused, index) => textResponse(`investigation step ${index} result`)),
    )
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'investigate the thing')

    const compacted = await engine.compactNow(agent, new AbortController().signal)
    expect(compacted).not.toBeNull()
    expect(countRollovers(session)).toBe(1)
    // The manual checkpoint carries the uncurated recovery record with the
    // direct user intent.
    const texts = derivedTexts(session).join('\n')
    expect(texts).toContain('Recovery record')
    expect(texts).toContain('investigate the thing')
  })

  it('mounts the context-management guidance section', async () => {
    const { ctx } = await engineHarness('guidance')
    const assembled = await ctx.systemPrompt.assemble({})
    expect(assembled.sections.some(section => section.text.includes('temporary working memory'))).toBe(true)
  })
})
