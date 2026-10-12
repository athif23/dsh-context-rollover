/**
 * The pressure reminder's durable message source, against the running host
 * line's message-source admission.
 *
 * DSH session format v4 retired the shared `{ kind: 'plugin', plugin }` wrapper
 * and refuses it when a message is written to the durable log — the failure
 * this engine hit in production (`format v4 message requires a producer-owned
 * source kind`). These cases pin the producer-owned kind on every line, and
 * where the line ships the V3→V4 admission, run the engine's own reminder row
 * through it. The control case proves the admission is what rejects the
 * retired wrapper, so the positive case cannot pass vacuously.
 *
 * @module tests/reminder-source
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { sessionEvents } from '../src/compat.ts'
import {
  engineHarness,
  followup,
  ScriptedAdapter,
  usageResponse,
} from './harness.ts'
import {
  isPressureReminder,
  reminderSource,
  REMINDER_SOURCE_KIND,
  REMINDER_SUMMARY_PREFIX,
} from '../src/rollover.ts'

/** Native V4 row admission, when this host line ships the V3→V4 package. */
type RowAdmission = (row: unknown) => void

const V4_ADMISSION_MODULE = '@deepseek-ai/dsh-session-format-v3-to-v4'

/**
 * Load the current line's native V4 admission.
 *
 * The specifier is variable on purpose: a line without the package must load
 * this file and skip, not fail to resolve it. Anything but a missing module
 * still throws.
 * @returns the admission function, or `undefined` on a line without format v4.
 */
async function loadV4Admission(): Promise<RowAdmission | undefined> {
  try {
    const loaded = await import(V4_ADMISSION_MODULE) as { assertV4RowAdmission?: RowAdmission }
    return loaded.assertV4RowAdmission
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | null)?.code
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
      || message.includes('Cannot find module')
      || message.includes('Cannot find package')
      || message.includes('Failed to resolve import')) return undefined
    throw error
  }
}

const admitV4Row = await loadV4Admission()

/** One durable `user/message` row carrying the engine's reminder source. */
function reminderRow(): { type: string; seq: number; time: number; data: unknown } {
  return {
    type: 'user/message',
    seq: 0,
    time: 1,
    data: createUserMessage({
      content: [{ type: 'text', text: 'Context window: 80% used (~80000 of 100000 tokens).' }],
      source: reminderSource(80),
    }),
  }
}

/** The same row with the retired shared wrapper the fix replaced. */
function retiredWrapperRow(): ReturnType<typeof reminderRow> {
  const row = reminderRow()
  return {
    ...row,
    data: {
      ...(row.data as Record<string, unknown>),
      source: {
        kind: 'plugin',
        plugin: 'context-rollover',
        form: 'notice',
        summary: REMINDER_SUMMARY_PREFIX,
      },
    },
  }
}

describe('pressure reminder source', () => {
  it('names its own producer instead of the retired plugin wrapper', () => {
    const source = reminderSource(80)
    expect(source.kind).toBe(REMINDER_SOURCE_KIND)
    expect(source.kind).not.toBe('plugin')
    expect(source.form).toBe('notice')
    expect(source.summary.startsWith(REMINDER_SUMMARY_PREFIX)).toBe(true)
  })

  it('matches itself through the delivery predicate in every persisted shape', () => {
    const session = Session.create(SessionId(`reminder-source-${Math.random().toString(36).slice(2, 8)}`))
    // One cast, in one place: the legacy shapes are what a pre-fix or pre-v4
    // host persisted, and the current line's source union no longer declares
    // them. Every shape goes through the real log the predicate reads.
    const append = (source: unknown): void => {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'reminder' }],
        source: source as ReturnType<typeof reminderSource>,
      }), { surfaceOp: 'append' })
    }
    // Current producer-owned kind, the pre-v4 wrapper, and the V3→V4-migrated
    // rename all identify the same engine reminder.
    append(reminderSource(80))
    append({ kind: 'plugin', plugin: 'context-rollover', form: 'notice', summary: REMINDER_SUMMARY_PREFIX })
    append({ kind: 'plugin:context-rollover', form: 'notice', summary: REMINDER_SUMMARY_PREFIX })
    // A direct user message and another producer's notice stay excluded.
    append({ kind: 'user' })
    append({ kind: 'plugin:context-rollover', form: 'notice', summary: 'something else' })
    expect(sessionEvents(session).filter(isPressureReminder)).toHaveLength(3)
  })

  it.skipIf(admitV4Row === undefined)('is admitted by the current line\'s native V4 message-source admission', () => {
    const admit = admitV4Row
    if (admit === undefined) throw new Error('skipped without admission')
    expect(() => { admit(reminderRow()) }).not.toThrow()
  })

  it.skipIf(admitV4Row === undefined)('still refuses the retired wrapper this fix replaced', () => {
    const admit = admitV4Row
    if (admit === undefined) throw new Error('skipped without admission')
    expect(() => { admit(retiredWrapperRow()) }).toThrow(/producer-owned source kind/)
  })

  it.skipIf(admitV4Row === undefined)('admits the reminder a live engine actually logs', async () => {
    const admit = admitV4Row
    if (admit === undefined) throw new Error('skipped without admission')
    const { ctx, agent, session } = await engineHarness(`reminder-admission-${Math.random().toString(36).slice(2, 8)}`, {
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.01,
    })
    const adapter = new ScriptedAdapter([
      usageResponse('answer 1', 5000),
      usageResponse('answer 2', 6000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    // Turn one anchors the meter; turn two crosses the reminder threshold.
    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    const reminder = sessionEvents(session).find(isPressureReminder)
    if (reminder === undefined) throw new Error('expected the engine to log a pressure reminder')
    // The production failure was this row reaching durable admission.
    expect(() => { admit(reminder) }).not.toThrow()
  })
})
