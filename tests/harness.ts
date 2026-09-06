/**
 * Shared test harness: a real cordis context with the standard prerequisite
 * services, the invariant companions (so every rollover transaction is
 * validated by DSH's own compaction invariants), and scripted LLM adapters.
 *
 * @module tests/harness
 */

import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import * as CompactionInvariant from '@deepseek-ai/dsh-compaction/invariant'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

export const MODEL = 'mock'

/** The scripted adapter's per-request chunk script. */
export type StreamScript = readonly StreamChunk[][]

/** The context window the mock adapters advertise. */
export const CONTEXT_WINDOW = 100_000

/** One text answer per request, with a large advertised context window. */
export class TextAdapter extends LlmAdapter {
  readonly requests: Message[][] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: CONTEXT_WINDOW },
    })
  }

  override async *stream(options: { messages: readonly Message[] }): AsyncIterable<StreamChunk> {
    this.requests.push([...options.messages])
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * One scripted chunk sequence per request. Script entries are consumed in
 * order; a final entry repeats when the script is exhausted.
 */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: Message[][] = []

  constructor(private readonly script: StreamScript) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: CONTEXT_WINDOW },
    })
  }

  override async *stream(options: { messages: readonly Message[] }): AsyncIterable<StreamChunk> {
    this.requests.push([...options.messages])
    const entry = this.script[Math.min(this.requests.length - 1, this.script.length - 1)]
    if (entry === undefined) throw new Error('scripted adapter ran out of entries')
    for (const chunk of entry) yield chunk
  }
}

/** One streamed text answer with the given content. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One streamed `new_context` tool call with the given JSON arguments. */
export function newContextCall(argumentsJson: string, callId = 'c1'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(callId), name: 'new_context', argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(callId), argumentsDelta: argumentsJson.slice(5) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(callId), name: 'new_context', arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * Mount the full prerequisite stack, including the invariant companions: every
 * committed rollover is checked against DSH's own session/agent/compaction
 * invariants.
 */
export async function mountTestContext(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
  await ctx.plugin(CompactionInvariant)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  return ctx
}

/**
 * Append one closed conversational exchange to a session: direct user message,
 * assistant tool call, tool result, assistant answer, all inside one turn.
 */
export function appendExchange(
  session: Session,
  turn: number,
  text: string,
  withToolCall = false,
): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `user: ${text}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  if (turn === 1) {
    session.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL } },
      reason: 'initial',
    })
  }
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createAssistantMessage({
      content: withToolCall
        ? [{
            type: 'tool-call',
            id: ToolCallId(`t${turn}`),
            name: 'demo_tool',
            arguments: '{"x":1}',
          }]
        : [{ type: 'text', text: `assistant: ${text}` }],
      source: { provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  if (withToolCall) {
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId(`t${turn}`),
        content: [{ type: 'text', text: `result: ${text}` }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** A closed multi-turn session with tool calls in the early exchanges. */
export function closedConversation(turns = 4): Session {
  const session = Session.create(SessionId(`closed-${turns}-${Math.random().toString(36).slice(2, 8)}`))
  for (let index = 1; index <= turns; index += 1) {
    appendExchange(session, index, `exchange ${index}`, index <= 2)
  }
  return session
}

/** The text of every derived model-visible message, in request order. */
export function derivedTexts(session: Session): string[] {
  return session.deriveMessages().map((message: Message) => message.content
    .map(block => block.type === 'text' ? block.text : `[${block.type}]`)
    .join(''))
}

// ---- engine test harness (shared by engine.spec.ts and safety.spec.ts) ----

const cleanup: Array<() => Promise<void>> = []

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ContextRolloverEngine } from '../src/index.ts'
import type { RolloverConfig } from '../src/config.ts'

/** A notes base directory for one test. */
export async function tempNotesDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rollover-engine-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

export interface EngineHarness {
  readonly ctx: Context
  readonly engine: ContextRolloverEngine
  readonly agent: Agent
  readonly session: Session
  readonly notesBase: string
}

/** Mount one engine over the standard test stack with a temp notes base. */
export async function engineHarness(
  id: string,
  config: Partial<RolloverConfig> = {},
): Promise<EngineHarness> {
  const ctx = await mountTestContext()
  const notesBase = await tempNotesDir()
  const engine = new ContextRolloverEngine(ctx, { notesDir: notesBase, retainTokens: 40, ...config })
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: MODEL, model: MODEL })
  return { ctx, engine, agent, session: agent.session, notesBase }
}

/** One scripted response with an honest usage baseline of `inputTokens`. */
export function usageResponse(text: string, inputTokens: number): StreamChunk[] {
  return [
    ...textResponse(text).slice(0, -1),
    { type: 'usage', usage: { inputTokens, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One scripted response that fails with the given provider failure code. */
export function errorFinish(message: string, code: string): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'error', failure: { message, code } } }]
}

/** The plugin-attributed pressure reminder texts in the durable log. */
export function reminderTexts(session: Session): string[] {
  return session.snapshotEvents()
    .filter(event => event.type === 'user/message')
    .filter(event => event.data.source.kind === 'plugin'
      && 'plugin' in event.data.source
      && event.data.source.plugin === 'context-rollover')
    .map(event => event.data.content[0])
    .filter(block => block?.type === 'text')
    .map(block => block?.type === 'text' ? block.text : '')
    .filter(text => text.includes('% used'))
}

/** Send one direct user message to the agent and wait for the turn to close. */
export async function followup(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
}

/** Seed `count` small exchanges so a rollover has real content to shadow. */
export async function seedExchanges(agent: Agent, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await followup(agent, `research question ${index}`)
  }
}
