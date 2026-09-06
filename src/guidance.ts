/**
 * Stable context-management guidance for the model. Kept deliberately small:
 * the same text ships with every request until a rollover replaces it.
 *
 * @module dsh-context-rollover/guidance
 */

/** System-prompt section text for the context-management plugin. */
export const CONTEXT_MANAGEMENT_GUIDANCE = `
# Context management

Your active context is temporary working memory. Older conversation leaves your
active context at a context rollover; it stays recoverable through the history
tool.

- Keep goal, verified progress, important decisions, constraints, files
  involved, known failures, and next steps in notes. Update notes as facts
  change; explicitly mark unverified hypotheses as hypotheses.
- You may call new_context at a natural task boundary when carrying the
  exploratory working context forward would only add noise — for example after
  finishing research before starting implementation, or after a major phase
  before verification. Before rolling over, save what the next context actually
  needs to notes and pass a short handoff.
- After a rollover, continue primarily from your notes, the recent conversation,
  and live repository state. Do not reconstruct the previous context from
  history; use history only to recover a specific missing detail.
- get_context_remaining reports how much context you have left. A reminder near
  the automatic rollover point appears at most once per window.
`.trim()
