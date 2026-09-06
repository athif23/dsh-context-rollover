/**
 * Context-window rollover engine: the active `ctx.compaction` backend that
 * crosses context boundaries without summarization.
 *
 * Responsibilities stay split (the Codex lesson): the `new_context` tool only
 * requests a boundary, the pre-step / turn-stopping listeners decide when the
 * boundary is actually crossed, the token meter measures pressure and delivers
 * one reminder per window, and {@link commitRollover} performs the surface
 * replacement inside DSH's normal compaction transaction.
 *
 * @module dsh-context-rollover
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { CONTEXT_WINDOW_EXCEEDED_CODE, boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: makes the optional sibling service available to `ctx.get()`, and
// loads the system-prompt Context merge for the `ctx.systemPrompt` key.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Seq } from './compat.ts'
import { resolveConfig } from './config.ts'
import type { RolloverConfig, ResolvedRolloverConfig } from './config.ts'
import { buildRecoveryRecord } from './checkpoint.ts'
import type { RolloverReason } from './checkpoint.ts'
import { CONTEXT_MANAGEMENT_GUIDANCE } from './guidance.ts'
import { NotesStore } from './notes.ts'
import { sessionEventAt } from './compat.ts'
import { commitRollover, countRollovers, selectRolloverRange } from './rollover.ts'
import { createRolloverTools } from './tools.ts'
import type { PendingRollover } from './state.ts'

/** Cordis plugin name used by loader diagnostics and message-source attribution. */
export const name = 'context-rollover'

/** Identity of one agent turn for per-turn engine bookkeeping. */
function turnKey(sessionId: string, turn: number): string {
  return `${sessionId}#${turn}`
}

export type { RolloverConfig, ResolvedRolloverConfig } from './config.ts'
export { buildCheckpointText, buildRecoveryRecord } from './checkpoint.ts'
export { NotesStore, resolveNotePath } from './notes.ts'
export { collectHistory, readHistoryItem, searchHistory } from './history.ts'
export {
  commitRollover,
  countRollovers,
  rolloverSummarySeqs,
  selectRolloverRange,
  ROLLOVER_PROVIDER,
} from './rollover.ts'
export { createRolloverTools } from './tools.ts'
export { CONTEXT_MANAGEMENT_GUIDANCE } from './guidance.ts'

/**
 * Summarization-free compaction backend: durable notes + handoff/recovery
 * checkpoint + token-budgeted recent verbatim tail, with model-requested
 * rollover via the `new_context` tool and runtime-driven rollover as the
 * pressure/overflow safety net.
 */
export class ContextRolloverEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions', 'tools', 'systemPrompt']

  static Config: z<RolloverConfig> = z.object({
    thresholdRatio: z.number(),
    reminderThresholdRatio: z.number(),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    handoffMaxChars: z.number().step(1).min(0),
    notesEnabled: z.boolean(),
    historyEnabled: z.boolean(),
    notesDir: z.string(),
  })

  /** Resolved and validated configuration. */
  readonly config: ResolvedRolloverConfig

  private readonly pendingRollovers = new Map<string, PendingRollover>()
  private readonly reminderDelivered = new Set<string>()
  /** Turns (session + seq at crossing time) that already had a pressure rollover. */
  private readonly pressureRolledTurns = new Set<string>()
  private readonly overflowRetries = new WeakMap<Agent, number>()

  constructor(ctx: Context, config: RolloverConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    this.registerTools()
    this.registerGuidance()
    this.registerLifecycle()
  }

  /** Mount the model-facing tools. */
  private registerTools(): void {
    const deps = {
      config: this.config,
      meter: this.ctx.tokenMeter,
      pendingRollovers: this.pendingRollovers,
    }
    for (const tool of createRolloverTools(deps, this.config.notesEnabled, this.config.historyEnabled)) {
      this.ctx.tools.register(tool)
    }
  }

  /** Mount the stable context-management guidance section. */
  private registerGuidance(): void {
    this.ctx.systemPrompt.section({
      name: 'context:rollover',
      order: 2350,
      text: CONTEXT_MANAGEMENT_GUIDANCE,
    })
  }

  /** Register the pending-rollover, pressure, and overflow lifecycle listeners. */
  private registerLifecycle(): void {
    const { ctx } = this

    // Cross the boundary before the next model request when the model asked
    // for it, then fall through to the pressure evaluation.
    ctx.on('agent/pre-step', async (
      { agent, turn, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          const pending = this.pendingRollovers.get(agent.session.id)
          if (pending !== undefined) {
            this.pendingRollovers.delete(agent.session.id)
            await this.performRollover(agent, {
              reason: 'model-requested',
              handoff: pending.handoff,
            }, signal)
          } else {
            await this.rollOverOnPressure(agent, turn, signal)
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`context rollover failed: ${message}; continuing the turn`)
        }
      }
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const reminder = this.pendingReminder(agent.session)
      if (reminder === undefined) return decision
      return { kind: 'enter', messages: [...decision.messages, reminder] }
    })

    // A rollover requested as the turn's last action still happens before the
    // next turn starts.
    ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
      const pending = this.pendingRollovers.get(agent.session.id)
      if (pending === undefined || signal.aborted) return
      this.pendingRollovers.delete(agent.session.id)
      try {
        await this.performRollover(agent, { reason: 'model-requested', handoff: pending.handoff }, signal)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`context rollover at turn stop failed: ${message}`)
      }
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    // Provider-confirmed context overflow: roll over (uncurated recovery
    // record, no tail) and let the loop resend the request.
    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      const generation = agent.session.surface.replaceGeneration
      const retries = this.overflowRetries.get(agent) ?? 0
      try {
        await this.performRollover(agent, { reason: 'overflow', handoff: null }, signal)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`context-overflow rollover failed: ${message}; preserving the original request error`)
        return next()
      }
      if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next()
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  /**
   * The one-per-window checkpoint reminder, when this step crosses the
   * reminder threshold for the first time in the current window.
   */
  private pendingReminder(session: Session): UserMessage | undefined {
    const contextWindow = session.requestContext()?.contextWindow
    if (contextWindow === undefined) return undefined
    const measurement = this.ctx.tokenMeter.measure(session)
    if (measurement.baseline.kind === 'none') return undefined
    const reminderTokens = Math.floor(contextWindow * this.config.reminderThresholdRatio)
    if (measurement.totalTokens < reminderTokens) return undefined
    if (this.reminderDelivered.has(session.id)) return undefined
    this.reminderDelivered.add(session.id)
    const rolloverTokens = Math.floor(contextWindow * this.config.thresholdRatio)
    const percent = Math.min(100, Math.round((measurement.totalTokens / contextWindow) * 100))
    return createUserMessage({
      content: [{
        type: 'text',
        text:
          `Context window: ${percent}% used (~${measurement.totalTokens} of ${contextWindow} tokens). `
          + `An automatic rollover starts around ${rolloverTokens} tokens. If a task boundary is near, `
          + 'save what matters to notes and call new_context with a short handoff; otherwise checkpoint soon.',
      }],
      source: {
        kind: 'plugin',
        plugin: name,
        form: 'notice',
        summary: boundContextSummary(`context pressure reminder (${percent}% used)`),
      },
    })
  }

  /**
   * Pressure evaluation: one reminder per window below the rollover point,
   * automatic rollover above it. Automatic pressure rollover happens at most
   * once per turn: crossing the threshold again within the same turn means
   * per-step re-injection plus tail exceed the threshold (a config/tail
   * mismatch), which no rollover fixes — rolling over again would burn the
   * prefix cache every step. Model-requested and overflow rollovers are exempt.
   */
  private async rollOverOnPressure(agent: Agent, turn: number, signal: AbortSignal): Promise<void> {
    const contextWindow = agent.session.requestContext()?.contextWindow
    if (contextWindow === undefined) return
    const measurement = this.ctx.tokenMeter.measure(agent.session)
    if (measurement.baseline.kind === 'none') return
    const rolloverTokens = Math.floor(contextWindow * this.config.thresholdRatio)
    if (measurement.totalTokens < rolloverTokens) return
    if (this.pressureRolledTurns.has(turnKey(agent.session.id, turn))) {
      this.ctx.logger.warn(
        `context rollover: usage is still above the automatic threshold after this turn's pressure `
        + `rollover (tail + per-step context likely exceed thresholdRatio * contextWindow); `
        + 'skipping further automatic rollovers this turn',
      )
      return
    }
    await this.performRollover(agent, { reason: 'pressure', handoff: null }, signal)
    this.pressureRolledTurns.add(turnKey(agent.session.id, turn))
  }

  /**
   * Perform one rollover: select the replacement range, resolve notes and the
   * checkpoint inputs for the reason, and commit the compaction transaction.
   * @param agent - agent whose session surface is rolled over.
   * @param request - rollover reason and the model's handoff, when any.
   * @param signal - live turn cancellation signal.
   * @returns the compaction result, or `null` when no useful range exists.
   */
  private async performRollover(
    agent: Agent,
    request: { reason: RolloverReason; handoff: string | null },
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    const session = agent.session
    const retainTokens = this.resolveRetainTokens(session)
    const range = selectRolloverRange(session, this.ctx.tokenMeter.measure(session), retainTokens)
    if (range === null) {
      this.ctx.logger.info('context rollover skipped: no compactable surface span (context is already minimal)')
      return null
    }
    const notes = this.config.notesEnabled
      ? await this.notesStore(session).renderAll(this.config.handoffMaxChars)
      : null
    const recovery = request.reason === 'model-requested'
      ? null
      : buildRecoveryRecord(session, range.shadowedSeqs, this.config.handoffMaxChars)
    const windowNumber = countRollovers(session) + 1
    const result = await commitRollover(
      { meter: this.ctx.tokenMeter },
      session,
      range.start,
      range.end,
      {
        owner: 'current-turn',
        checkpoint: {
          reason: request.reason,
          windowNumber,
          notes,
          handoff: request.handoff,
          recovery,
        },
      },
    )
    this.reminderDelivered.delete(session.id)
    this.ctx.logger.info(
      `context rollover (${request.reason}): window ${windowNumber} started; `
      + `shadowed ${result.shadowedSeqs.length} surface nodes (~${result.shadowedTokenCount} tokens)`,
    )
    return result
  }

  /**
   * The session's open turn number, or `-1` when none is open (the guard key
   * then falls back to one-shot-per-call semantics).
   */
  private openTurnNumber(session: Session): number {
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
      const event = sessionEventAt(session, seq)
      if (event === undefined) continue
      if (event.type === 'turn/start') return event.data.turn
      if (event.type === 'turn/end') return -1
    }
    return -1
  }

  /** Resolve the recent-tail token budget for one session. */
  private resolveRetainTokens(session: Session): number {
    if (this.config.retainTokens !== null) return this.config.retainTokens
    const contextWindow = session.requestContext()?.contextWindow
    return contextWindow === undefined
      ? 4096
      : Math.floor(contextWindow * this.config.retainRatio)
  }

  /** Resolve the notes store for one session. */
  private notesStore(session: Session): NotesStore {
    return new NotesStore(NotesStore.directoryFor(session.id, this.config.notesDir))
  }

  /**
   * Compact when the model failed to manage context: pressure rolls over with
   * a recovery record above the threshold; context-overflow forces the
   * reduction without a tail.
   * @param agent - agent whose latest routed request is measured.
   * @param trigger - step-boundary pressure or provider-confirmed overflow.
   * @param signal - live turn cancellation signal.
   * @returns the rollover result, or `null` when no rollover was warranted.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    if (trigger === 'context-overflow') {
      return this.performRollover(agent, { reason: 'overflow', handoff: null }, signal)
    }
    await this.rollOverOnPressure(agent, this.openTurnNumber(agent.session), signal)
    return null
  }

  /**
   * Manual rollover behind the `/compact` command: the same deterministic
   * checkpoint and recent tail, run exclusively on an idle agent.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this rollover request.
   * @param sourceCommandId - initiating command identity for presentation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    const run = async (): Promise<CompactionResult | null> => {
      const session = agent.session
      const range = selectRolloverRange(
        session,
        this.ctx.tokenMeter.measure(session),
        this.resolveRetainTokens(session),
      )
      if (range === null) return null
      const notes = this.config.notesEnabled
        ? await this.notesStore(session).renderAll(this.config.handoffMaxChars)
        : null
      const recovery = buildRecoveryRecord(session, range.shadowedSeqs, this.config.handoffMaxChars)
      const windowNumber = countRollovers(session) + 1
      return commitRollover(
        { meter: this.ctx.tokenMeter },
        session,
        range.start,
        range.end,
        {
          owner: null,
          ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
          checkpoint: {
            reason: 'manual',
            windowNumber,
            notes,
            handoff: null,
            recovery,
          },
          flush: async () => {
            await this.ctx.sessions.flush(session)
          },
        },
      )
    }
    return this.runMaintained(agent, run, signal)
  }

  /**
   * Replace one inclusive surface-position span with a rollover checkpoint.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session.
   * @param signal - optional cancellation signal.
   * @returns the durable rollover result.
   */
  override async compactRegion(
    start: Seq,
    end: Seq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    signal?.throwIfAborted()
    const session = agent.session
    const notes = this.config.notesEnabled
      ? await this.notesStore(session).renderAll(this.config.handoffMaxChars)
      : null
    const recovery = buildRecoveryRecord(session, this.surfaceSeqsBetween(session, start, end), this.config.handoffMaxChars)
    const windowNumber = countRollovers(session) + 1
    return commitRollover(
      { meter: this.ctx.tokenMeter },
      session,
      start,
      end,
      {
        owner: 'current-turn',
        checkpoint: {
          reason: 'manual',
          windowNumber,
          notes,
          handoff: null,
          recovery,
        },
      },
    )
  }

  /** The surface seqs from `start` through `end`, in surface order. */
  private surfaceSeqsBetween(
    session: Session,
    start: Seq,
    end: Seq,
  ): readonly Seq[] {
    const nodes = session.surface.nodes
    const startIdx = nodes.indexOf(start)
    const endIdx = nodes.indexOf(end)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return []
    return nodes.slice(startIdx, endIdx + 1)
  }

  /**
   * Run one idle-agent task under `runMaintenance`, mapping cancellation to
   * the manual-failure code `/compact` presents.
   */
  private async runMaintained<T>(
    agent: Agent,
    task: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    try {
      return await agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          return await task()
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError('cancelled', 'manual rollover was cancelled', { cause: error })
          }
          throw error
        }
      })
    } catch (error: unknown) {
      if (error instanceof ManualCompactionError) throw error
      throw new ManualCompactionError(
        'busy',
        'manual rollover requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }
}

export default ContextRolloverEngine
