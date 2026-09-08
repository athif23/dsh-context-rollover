/**
 * History recovery tests: shadowed content stays searchable and readable,
 * current surface content is not history, and window numbering follows the
 * committed rollovers.
 *
 * @module tests/history.spec
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session } from '@deepseek-ai/dsh-session'
import { collectHistory, readHistoryItem, searchHistory } from '../src/history.ts'
import { commitRollover, countRollovers, rolloverSummarySeqs, selectRolloverRange } from '../src/rollover.ts'
import { appendExchange, closedConversation } from './harness.ts'

/** A meter on a bare context, for direct transaction tests. */
async function bareMeter(): Promise<TokenMeter> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return ctx.tokenMeter
}

/** Commit a full-surface rollover (standalone bracket) and return its result. */
async function rollEverything(session: Session, windowNumber: number): Promise<void> {
  const meter = await bareMeter()
  const range = selectRolloverRange(session, meter.measure(session), 0)
  if (range === null) throw new Error('expected a compactable range')
  await commitRollover(
    { meter },
    session,
    range.start,
    range.end,
    {
      owner: null,
      checkpoint: {
        reason: 'manual',
        windowNumber,
        notes: null,
        handoff: null,
        recovery: null,
      },
    },
  )
}

describe('history', () => {
  it('finds and reads shadowed content that left the active surface', async () => {
    const session = closedConversation(4)
    await rollEverything(session, 1)

    // Shadowed conversation is recoverable.
    const matches = searchHistory(session, countRollovers(session), rolloverSummarySeqs(session), 'exchange 1')
    expect(matches.length).toBeGreaterThan(0)
    const hit = matches.find(match => match.kind === 'user')
    expect(hit).toBeDefined()

        if (hit === undefined) throw new Error('expected a user-kind match')
    const item = readHistoryItem(session, hit.seq, countRollovers(session), rolloverSummarySeqs(session))
    expect(item).not.toBeNull()
    expect(item?.text).toContain('exchange 1')
    expect(item?.window).toBe(1)

    // ...and is not in the active surface anymore.
    const surface = session.deriveMessages().map(message => JSON.stringify(message.content)).join('\n')
    expect(surface).not.toContain('exchange 1')
  })

  it('excludes current-surface content from history', async () => {
    const session = closedConversation(2)
    const items = collectHistory(session, 0, [])
    expect(items).toEqual([])
  })

  it('numbers windows by the rollovers committed before each item', async () => {
    const session = closedConversation(4)
    await rollEverything(session, 1)

    // After one rollover everything shadowed belongs to window 1 and the
    // checkpoint itself is current surface, not history.
    let items = collectHistory(session, countRollovers(session), rolloverSummarySeqs(session))
    expect(items.every(item => item.window === 1)).toBe(true)

    // New conversation lands in the fresh window; rolling over again shadows
    // the first checkpoint (window 2's start) plus the new exchanges.
    appendExchange(session, 5, 'exchange 5', false)
    appendExchange(session, 6, 'exchange 6', false)
    await rollEverything(session, 2)
    items = collectHistory(session, countRollovers(session), rolloverSummarySeqs(session))
    const windows = new Set(items.map(item => item.window))
    expect(windows.has(1)).toBe(true)
    expect(windows.has(2)).toBe(true)
    expect(searchHistory(session, countRollovers(session), rolloverSummarySeqs(session), 'exchange 1')
      .every(match => match.window === 1)).toBe(true)
    expect(searchHistory(session, countRollovers(session), rolloverSummarySeqs(session), 'exchange 5')
      .every(match => match.window === 2)).toBe(true)
  })

  it('refuses to read an item that is still on the active surface', async () => {
    const session = closedConversation(2)
    const nodes = session.surface.nodes
    const last = nodes[nodes.length - 1]
    if (last === undefined) throw new Error('expected a surface node')
    expect(readHistoryItem(session, last, 0, [])).toBeNull()
  })

  it('excludes rollover checkpoints from history across two rollovers', async () => {
    const session = closedConversation(4)
    await rollEverything(session, 1)
    appendExchange(session, 5, 'exchange 5', false)
    appendExchange(session, 6, 'exchange 6', false)
    await rollEverything(session, 2)
    expect(countRollovers(session)).toBe(2)

    const windowCount = countRollovers(session)
    const rolloverSeqs = rolloverSummarySeqs(session)

    // Direct user messages from earlier windows remain searchable.
    const early = searchHistory(session, windowCount, rolloverSeqs, 'exchange 1')
    expect(early.length).toBeGreaterThan(0)
    expect(early.every(match => match.kind !== undefined && match.window === 1)).toBe(true)
    expect(early.some(match => match.kind === 'user')).toBe(true)
    const later = searchHistory(session, windowCount, rolloverSeqs, 'exchange 5')
    expect(later.length).toBeGreaterThan(0)
    expect(later.every(match => match.window === 2)).toBe(true)

    // Checkpoint-only marker text never surfaces as user history, even
    // though two checkpoints (one per rollover) are now shadowed or current.
    expect(searchHistory(session, windowCount, rolloverSeqs, 'Durable notes')).toEqual([])
    expect(searchHistory(session, windowCount, rolloverSeqs, 'context-rollover checkpoint')).toEqual([])
    const items = collectHistory(session, windowCount, rolloverSeqs)
    expect(items.some(item => item.text.includes('<context-rollover checkpoint>'))).toBe(false)
  })

  it('refuses to read a rollover checkpoint by seq', async () => {
    const session = closedConversation(4)
    await rollEverything(session, 1)
    appendExchange(session, 5, 'exchange 5', false)
    await rollEverything(session, 2)

    // The first checkpoint is now shadowed (not on the surface), but it is
    // still not readable as history: provenance excludes it, not position.
    const shadowedCheckpoint = session.snapshotEvents()
      .filter(event => event.type === 'user/message')
      .filter(event => !session.surface.nodes.includes(event.seq))
      .find(event => JSON.stringify(event.data).includes('context-rollover checkpoint'))
    if (shadowedCheckpoint === undefined) throw new Error('expected a shadowed checkpoint event')
    expect(readHistoryItem(session, shadowedCheckpoint.seq, countRollovers(session), rolloverSummarySeqs(session))).toBeNull()
  })

  it('excludes plugin-injected notices while keeping conversation kinds', async () => {
    const session = closedConversation(2)
    // A pressure-reminder-shaped plugin notice on the surface, like the
    // engine's one-per-window checkpoint reminder.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Context window: 80% used reminder marker xyz' }],
      source: { kind: 'plugin', plugin: 'context-rollover', form: 'notice', summary: 'context pressure reminder' },
    }), { surfaceOp: 'append' })
    // Later conversation pushes the notice off the retained tail so the
    // rollover genuinely shadows it (a zero tail budget keeps the last node).
    appendExchange(session, 3, 'exchange 3', false)
    await rollEverything(session, 1)

    const windowCount = countRollovers(session)
    const rolloverSeqs = rolloverSummarySeqs(session)

    // Direct user conversation stays recoverable with its kinds intact.
    expect(searchHistory(session, windowCount, rolloverSeqs, 'exchange 1').length).toBeGreaterThan(0)
    const kinds = new Set(collectHistory(session, windowCount, rolloverSeqs).map(item => item.kind))
    expect(kinds.has('user')).toBe(true)
    expect(kinds.has('assistant')).toBe(true)
    expect(kinds.has('tool-result')).toBe(true)

    // The plugin notice is neither searchable nor readable as history.
    expect(searchHistory(session, windowCount, rolloverSeqs, 'reminder marker xyz')).toEqual([])
    const notice = session.snapshotEvents()
      .filter(event => event.type === 'user/message')
      .find(event => JSON.stringify(event.data).includes('reminder marker xyz'))
    if (notice === undefined) throw new Error('expected the reminder event in the log')
    expect(readHistoryItem(session, notice.seq, windowCount, rolloverSeqs)).toBeNull()
  })
})
