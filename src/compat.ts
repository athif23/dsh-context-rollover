/**
 * Host-version compatibility helpers. Public dsh releases lag the internal
 * alpha line: 0.1.3-alpha moved the session log behind `snapshotEvents()`,
 * while older releases (the published rc line) expose the log as `events`.
 * The replace `surfaceOp` moved the same way: newer hosts take
 * `{ op: 'replace', startSeq, endSeq }`, older ones `{ op: 'replace', start,
 * end }`, and both reject the other shape.
 *
 * @module dsh-context-rollover/compat
 */

import { randomUUID } from 'node:crypto'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

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

/**
 * Cached replace-op shape probe: true once the running host accepts
 * `startSeq`/`endSeq`. One probe per process; the host never changes under a
 * loaded engine.
 */
let hostAcceptsSeqOp: boolean | undefined

/**
 * Whether the running host takes the newer `{ op: 'replace', startSeq,
 * endSeq }` shape. Probed once against a detached session: the candidate op
 * passes shape validation on a matching host (failing later on surface
 * position, which is the observable answer) and fails shape validation with
 * `invalid replace surfaceOp` on the other line. Shape is always validated
 * before position, so the classification is exact on both lines.
 * @returns true for the newer shape, false for `{ op: 'replace', start, end }`.
 */
function hostTakesSeqOp(): boolean {
  if (hostAcceptsSeqOp !== undefined) return hostAcceptsSeqOp
  const probe = Session.create(SessionId(`probe-${randomUUID()}`))
  try {
    probe.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'probe' }],
        source: { kind: 'user' },
      }),
      { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } } as never,
    )
    hostAcceptsSeqOp = true
  } catch (error: unknown) {
    hostAcceptsSeqOp = !(error instanceof Error && error.message.includes('invalid replace surfaceOp'))
  }
  return hostAcceptsSeqOp
}

/**
 * Build the surface-replacement op in the running host's shape. The return
 * stays opaque (`unknown`) because neither line's type accepts the other's
 * fields; callers cast at the single `append` site.
 * @param start - inclusive first surface-node seq of the replaced span.
 * @param end - inclusive last surface-node seq of the replaced span.
 * @returns the replace op the running host validates.
 */
export function replaceSurfaceOp(start: Seq, end: Seq): unknown {
  if (hostTakesSeqOp()) return { op: 'replace', startSeq: start, endSeq: end }
  return { op: 'replace', start, end }
}
