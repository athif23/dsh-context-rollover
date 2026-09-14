/**
 * Deterministic rollover checkpoint content. The normal path never calls an
 * LLM to summarize: the checkpoint is composed from durable notes plus the
 * model's own handoff when provided, and the recent raw tail stays on the
 * surface outside the checkpoint.
 *
 * @module dsh-context-rollover/checkpoint
 */

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
 * given input, so the shrink guard's pricing is reproducible.
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
  return checkpointText(lines.join('\n'))
}
