/**
 * History: targeted read-only recovery of conversation that left the active
 * surface. The DSH session log is the only transcript store — history items
 * are the log's shadowed surface events, recovered by literal search and
 * bounded reads, never reloaded wholesale.
 *
 * @module dsh-context-rollover/history
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { Seq } from './compat.ts'
import { sessionEvents } from './compat.ts'

/** Which kind of surface event one history item came from. */
export type HistoryItemKind = 'user' | 'assistant' | 'tool-result'

/** One recoverable history item. */
export interface HistoryItem {
  readonly seq: number
  readonly kind: HistoryItemKind
  /** 1-based number of the rollover that shadowed this item (1 = the first window). */
  readonly window: number
  /** The item's text content (joined text blocks). */
  readonly text: string
}

/** One literal search hit over history. */
export interface HistoryMatch {
  readonly seq: number
  readonly kind: HistoryItemKind
  readonly window: number
  /** 1-based character offset of the match in the item text. */
  readonly offset: number
  /** The item text around the match, bounded for model consumption. */
  readonly snippet: string
}

/** Extract an item's text content from its message blocks. */
function messageBlocksText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks
    .map(block => block.type === 'text' ? block.text : `[${block.type}]`)
    .filter((text): text is string => text !== undefined)
    .join('\n')
}

/**
 * Collect every item that has left the active surface, in log order. Current
 * surface content is active context, not history.
 * @param session - session whose log supplies the history.
 * @param windowCount - number of rollovers committed so far (window numbering).
 * @param rolloverSeqs - seqs of the rollover summary events, ascending.
 * @returns the shadowed items, oldest first.
 */
export function collectHistory(
  session: Session,
  windowCount: number,
  rolloverSeqs: readonly Seq[],
): HistoryItem[] {
  const surface = new Set(session.surface.nodes)
  const items: HistoryItem[] = []
  for (const event of sessionEvents(session)) {
    if (surface.has(event.seq)) continue
    let kind: HistoryItemKind
    let text: string
    switch (event.type) {
      case 'user/message':
        kind = 'user'
        text = messageBlocksText(event.data.content)
        break
      case 'assistant/message':
        kind = 'assistant'
        text = messageBlocksText(event.data.message.content)
        break
      case 'tool/result':
        kind = 'tool-result'
        text = messageBlocksText(event.data.message.content)
        break
      default:
        continue
    }
    if (text.length === 0) continue
    // Items shadowed by window N's rollover belong to window N: the number of
    // rollovers committed at or after the item's seq.
    let window = windowCount + 1
    for (const rolloverSeq of rolloverSeqs) {
      if (rolloverSeq >= event.seq) {
        window = rolloverSeqs.indexOf(rolloverSeq) + 1
        break
      }
    }
    items.push({ seq: event.seq as Seq, kind, window, text })
  }
  return items
}

/** Render a bounded snippet around one match. */
function snippetAround(text: string, offset: number, matchLength: number): string {
  const radius = 160
  const start = Math.max(0, offset - radius)
  const end = Math.min(text.length, offset + matchLength + radius)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end)}${suffix}`
}

/**
 * Literal case-insensitive search over history items.
 * @param session - session whose log supplies the history.
 * @param windowCount - number of rollovers committed so far.
 * @param rolloverSeqs - seqs of the rollover summary events, ascending.
 * @param query - literal substring to find.
 * @param maxMatches - upper bound on returned matches.
 * @returns the matches in log order.
 */
export function searchHistory(
  session: Session,
  windowCount: number,
  rolloverSeqs: readonly Seq[],
  query: string,
  maxMatches = 10,
): HistoryMatch[] {
  const lowerQuery = query.toLowerCase()
  if (lowerQuery.length === 0) return []
  const matches: HistoryMatch[] = []
  for (const item of collectHistory(session, windowCount, rolloverSeqs)) {
    const lowerText = item.text.toLowerCase()
    let offset = lowerText.indexOf(lowerQuery)
    while (offset !== -1) {
      matches.push({
        seq: item.seq,
        kind: item.kind,
        window: item.window,
        offset,
        snippet: snippetAround(item.text, offset, lowerQuery.length),
      })
      if (matches.length >= maxMatches) return matches
      offset = lowerText.indexOf(lowerQuery, offset + lowerQuery.length)
    }
  }
  return matches
}

/**
 * Read one history item's text by its logged seq.
 * @param session - session whose log supplies the history.
 * @param seq - the item's event seq (as returned by a search).
 * @param windowCount - number of rollovers committed so far.
 * @param rolloverSeqs - seqs of the rollover summary events, ascending.
 * @param maxChars - hard character bound for the returned text.
 * @returns the item, or `null` when the seq is unknown, still on the active
 *   surface, or carries no text.
 */
export function readHistoryItem(
  session: Session,
  seq: number,
  windowCount: number,
  rolloverSeqs: readonly Seq[],
  maxChars = 4000,
): HistoryItem | null {
  const item = collectHistory(session, windowCount, rolloverSeqs)
    .find(candidate => candidate.seq === seq)
  if (item === null || item === undefined) return null
  if (item.text.length > maxChars) {
    return { ...item, text: `${item.text.slice(0, maxChars)}…` }
  }
  return item
}
