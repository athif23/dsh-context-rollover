/**
 * Deterministic rollover checkpoint content. The normal path never calls an
 * LLM to summarize: the checkpoint is composed from durable notes plus the
 * model's own handoff (model-driven rollover) or an uncurated recovery record
 * (automatic rollover), and the recent raw tail stays on the surface outside
 * the checkpoint.
 *
 * @module dsh-context-rollover/checkpoint
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { sessionEventAt } from './compat.ts'
import type { Seq } from './compat.ts'

/** Why a context window rolled over. */
export type RolloverReason = 'model-requested' | 'pressure' | 'overflow' | 'manual'

/** Inputs for one deterministic checkpoint. */
export interface CheckpointInput {
  readonly reason: RolloverReason
  /** 1-based number of the window the rollover starts. */
  readonly windowNumber: number
  /** Rendered durable notes snapshot, or `null` when notes are disabled or empty. */
  readonly notes: string | null
  /** The model's own handoff text, or `null` when absent. */
  readonly handoff: string | null
  /** Uncurated recovery record for automatic rollovers, or `null`. */
  readonly recovery: string | null
}

/** Wrap checkpoint text in the rollover markers. */
function checkpointText(text: string): string {
  return [
    '<context-rollover checkpoint>',
    text,
    '</context-rollover checkpoint>',
  ].join('\n')
}

/**
 * Compose the replacement checkpoint blocks. Content is deterministic for a
 * given input — the same notes, handoff, and recovery record always render to
 * the same checkpoint, so the shrink guard's pricing is reproducible.
 * @param input - the rollover's reason, window number, and retained state.
 * @returns the checkpoint content for the replacement user message.
 */
export function buildCheckpointText(input: CheckpointInput): string {
  const lines: string[] = [
    `Context window rollover: earlier conversation left your active context `
    + `(window ${input.windowNumber} started; reason: ${input.reason}). `
    + `The full conversation remains persisted and recoverable with the history tool — `
    + `search for a specific missing detail and read only that; do not reconstruct whole windows.`,
  ]
  lines.push('', '## Durable notes')
  lines.push(input.notes ?? 'No notes were saved for this rollover.')
  if (input.handoff !== null) {
    lines.push('', '## Handoff', input.handoff)
  }
  if (input.recovery !== null) {
    lines.push(
      '',
      '## Recovery record (automatic rollover; uncurated)',
      'The record below is not proof of progress — verify live state before acting on it.',
      input.recovery,
    )
  }
  return checkpointText(lines.join('\n'))
}

/**
 * Build the automatic-rollover recovery record: the most recent DIRECT user
 * messages from the shadowed range, newest last, bounded to `maxChars`.
 * Only direct user inputs are authoritative enough to carry over verbatim;
 * assistant prose, injected plugin contexts, and tool output are deliberately
 * excluded. The newest message is always kept (truncated to the budget when
 * necessary) so current user intent is never lost to the bound.
 * @param session - session owning the shadowed events.
 * @param shadowedSeqs - the seqs being shadowed, in surface order.
 * @param maxChars - hard character bound for the record text.
 * @returns the record, or `null` when the range holds no direct user message.
 */
export function buildRecoveryRecord(
  session: Session,
  shadowedSeqs: readonly Seq[],
  maxChars: number,
): string | null {
  const userTexts: string[] = []
  let remaining = maxChars
  for (let index = shadowedSeqs.length - 1; index >= 0; index -= 1) {
    const seq = shadowedSeqs[index]
    if (seq === undefined) continue
    const event = sessionEventAt(session, seq)
    if (event?.type !== 'user/message') continue
    // Direct user inputs carry a `user` message source; injected plugin and
    // tool-formed contexts do not.
    if (event.data.source.kind !== 'user') continue
    const block = event.data.content[0]
    if (block === undefined || block.type !== 'text') continue
    const text = remaining > 0 && block.text.length > remaining
      ? block.text.slice(0, remaining)
      : block.text
    userTexts.unshift(text)
    remaining -= text.length
    if (remaining <= 0) break
  }
  if (userTexts.length === 0) return null
  return userTexts.join('\n\n---\n\n')
}
