/**
 * Pressure-reminder delivery across engine rows.
 *
 * On the Web profile the engine is mounted twice — the host bundle row and the
 * session's agent-preset row — and each row loads its **own module instance**
 * behind a preset `isolate` realm (they cannot share a Cordis container: the
 * `compaction` service may only be provided once). `modelSurface` decides which
 * row owns the model-facing tools, but both rows register `agent/pre-step`
 * unconditionally, and that event is a waterfall: the outer listener decides
 * while the inner one runs, so neither decision has reached the log when the
 * second one asks.
 *
 * A module-scoped claim therefore cannot be the whole answer, and a
 * per-instance Set is not an answer at all. The durable log is what both rows
 * share, so `reminderDelivered` decides, and `claimReminder` adds the
 * synchronous claim that the same module instance needs inside one waterfall.
 *
 * @module tests/reminder-delivery
 */

import { describe, expect, it } from 'vitest'
import {
  claimReminder,
  countRollovers,
  reminderDelivered,
  reminderWindowKey,
  resetReminderClaims,
} from '../src/rollover.ts'
import {
  engineHarness,
  followup,
  reminderTexts,
  ScriptedAdapter,
  toolCall,
  usageResponse,
} from './harness.ts'

describe('pressure reminder delivery', () => {
  // Every case is an independent session; claims and delivered reminders are
  // per session, and these ids must not collide across cases in one process.
  let caseId = 0
  const sessionId = (label: string): string => `reminder-${label}-${(caseId += 1)}`

  it('is refused by a second module instance once the log carries the reminder', async () => {
    const { ctx, agent, session } = await engineHarness(sessionId('instance'), {
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.01,
    })
    const adapter = new ScriptedAdapter([
      usageResponse('answer 1', 5000),
      usageResponse('answer 2', 6000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    // Turn one anchors the meter; the reminder is computed at turn two's
    // pre-step, from that honest reading.
    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    expect(reminderTexts(session)).toHaveLength(1)
    expect(reminderDelivered(session)).toBe(true)

    // A second row in a preset realm is a distinct module instance, so its
    // in-process claim is empty — exactly what a cache-busted import models.
    // @ts-expect-error a cache-busted specifier has no declaration; the shape
    // is the module's own, which is the point: a distinct module instance.
    const fresh = await import('../src/rollover.ts?fresh-module-instance') as typeof import('../src/rollover.ts')
    expect(fresh.claimReminder).not.toBe(claimReminder)
    expect(fresh.claimReminder(session)).toBe(false)

    // Clearing the in-process claims does not reopen the window: the log is
    // the durable authority, and it still carries the delivered reminder.
    resetReminderClaims(session)
    expect(claimReminder(session)).toBe(false)
    expect(fresh.claimReminder(session)).toBe(false)
  })

  it('claims once per window, not once per session', async () => {
    const { ctx, agent, session } = await engineHarness(sessionId('window'), {
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.01,
    })
    const adapter = new ScriptedAdapter([
      usageResponse('answer 1', 5000),
      usageResponse('answer 2', 6000),
      usageResponse('answer 3', 7000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    // Turn one anchors the meter; turn two crosses the reminder threshold.
    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    expect(reminderTexts(session)).toHaveLength(1)

    // Same window: neither a repeat call nor a later turn may claim again.
    const key = reminderWindowKey(session)
    expect(claimReminder(session)).toBe(false)
    await followup(agent, 'turn three')
    expect(reminderTexts(session)).toHaveLength(1)
    expect(reminderWindowKey(session)).toBe(key)
  })

  it('opens a fresh claim slot when a rollover starts a new window', async () => {
    // The shape tests/safety.spec.ts uses to commit a pressure rollover: a low
    // threshold, no retained tail, and a second turn that opens with a tool
    // call so its pre-step sees turn one fully closed.
    const { ctx, agent, session } = await engineHarness(sessionId('rollover'), {
      thresholdRatio: 0.001,
      reminderThresholdRatio: 0.001,
      retainTokens: 0,
    })
    const adapter = new ScriptedAdapter([
      usageResponse(`research answer one ${'detail '.repeat(600)}`, 5000),
      toolCall('get_context_remaining', '{}', 'c1'),
      usageResponse(`research answer two ${'detail '.repeat(600)}`, 6000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    expect(countRollovers(session)).toBe(0)
    const firstWindowKey = reminderWindowKey(session)

    await followup(agent, 'turn two')
    expect(countRollovers(session)).toBe(1)

    // The rollover advanced the window, so the reminder identity changed: a
    // reminder delivered in window #0 cannot suppress window #1's.
    expect(firstWindowKey).toBe(`${session.id}#0`)
    expect(reminderWindowKey(session)).toBe(`${session.id}#1`)
  })
})
