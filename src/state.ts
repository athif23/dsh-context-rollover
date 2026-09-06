/**
 * Engine-side rollover request state, shared by the `new_context` tool and the
 * lifecycle listeners that consume it.
 *
 * @module dsh-context-rollover/state
 */

/** A pending model-requested rollover awaiting a safe lifecycle point. */
export interface PendingRollover {
  /** The model's handoff text, or `null` when it supplied none. */
  readonly handoff: string | null
}
