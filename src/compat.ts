/**
 * Host-version compatibility helpers. Public dsh releases lag the internal
 * alpha line: 0.1.3-alpha moved the session log behind `snapshotEvents()`,
 * while older releases (the published rc line) expose the log as `events`.
 *
 * @module dsh-context-rollover/compat
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * One host-typed surface/log position: a branded seq on newer hosts, a plain
 * number on the published rc line. Values of this type always originate from
 * host APIs, so both shapes flow in without casts.
 */
export type Seq = Session['surface']['nodes'][number]

/**
 * Read one session's full event log across host versions.
 * @param session - the session whose log to read.
 * @returns the logged events in order.
 */
export function sessionEvents(session: Session): readonly SessionEvent[] {
  const reader = session as {
    snapshotEvents?: () => readonly SessionEvent[]
    events?: readonly SessionEvent[]
  }
  return reader.snapshotEvents !== undefined
    ? reader.snapshotEvents()
    : (reader.events ?? [])
}

/**
 * Read one logged event by seq across host versions: newer hosts expose
 * `session.eventAt(seq)`, older ones expose the `events` array directly.
 * @param session - the session to read.
 * @param seq - the event's log position.
 * @returns the event, or `undefined` when the log has no event at that seq.
 */
export function sessionEventAt(session: Session, seq: number): SessionEvent | undefined {
  const withEventAt = session as unknown as { eventAt?: (seq: number) => SessionEvent | undefined }
  if (withEventAt.eventAt !== undefined) return withEventAt.eventAt(seq)
  return sessionEvents(session)[seq]
}

/** One priced surface node, as shaped by either host line. */
interface SurfaceNode {
  readonly seq: number
  readonly tokens: number
  readonly heuristicTokens?: number
}

/**
 * Read a surface node's heuristic price across host versions: newer hosts
 * carry a separate `heuristicTokens` field, older ones price nodes with the
 * fixed heuristic in `tokens` directly.
 * @param node - one priced surface node from a meter measurement.
 * @returns the node's fixed-heuristic token price.
 */
export function nodeHeuristicTokens(node: SurfaceNode): number {
  return node.heuristicTokens ?? node.tokens
}
