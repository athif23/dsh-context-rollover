/**
 * Tool rendering tests: every `notes` and `history` branch returns the stable
 * `{ action, text }` shape the renderer reads, verified through the actual DSH
 * tool runtime (execute + render), not only the underlying stores — so the
 * assertions cover the final model-visible content.
 *
 * @module tests/tools.spec
 */

import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { countRollovers } from '../src/rollover.ts'
import {
  engineHarness,
  followup,
  ScriptedAdapter,
  seedExchanges,
  textResponse,
} from './harness.ts'

/** Execute one tool through the registry and require success. */
async function executeTool(
  ctx: Context,
  agent: Agent,
  name: string,
  args: Record<string, unknown>,
  callId: string,
) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name,
    arguments: args,
    agent,
  })
  if (result.isError) throw new Error(`tool ${name} failed: ${JSON.stringify(result.content)}`)
  return result
}

/** The final model-visible text of a successful tool result. */
function renderedText(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content
    .map(block => block.type === 'text' ? block.text ?? '' : `[${block.type}]`)
    .join('\n')
}

describe('notes tool rendering', () => {
  it('renders write, append, read, and a non-empty list', async () => {
    const { ctx, agent } = await engineHarness('tools-notes-list')
    await executeTool(ctx, agent, 'notes', { action: 'write', path: 'state.md', text: 'goal: prove rendering' }, 'n1')
    await executeTool(ctx, agent, 'notes', { action: 'append', path: 'state.md', text: 'next: tests' }, 'n2')
    await executeTool(ctx, agent, 'notes', { action: 'write', path: 'plans/rollout.md', text: 'step 1' }, 'n3')

    const read = await executeTool(ctx, agent, 'notes', { action: 'read', path: 'state.md' }, 'n4')
    expect(renderedText(read)).toContain('goal: prove rendering')
    expect(renderedText(read)).toContain('next: tests')

    const list = await executeTool(ctx, agent, 'notes', { action: 'list' }, 'n5')
    const listText = renderedText(list)
    expect(listText).toContain('state.md')
    expect(listText).toContain('plans/rollout.md')
    expect(listText).not.toContain('undefined')
    expect(list.value).toMatchObject({ action: 'list' })
    expect((list.value as { text?: unknown }).text).toContain('state.md')
  })

  it('renders search hits', async () => {
    const { ctx, agent } = await engineHarness('tools-notes-search')
    await executeTool(ctx, agent, 'notes', { action: 'write', path: 'state.md', text: 'decided: no summary' }, 's1')

    const search = await executeTool(ctx, agent, 'notes', { action: 'search', query: 'SUMMARY' }, 's2')
    const searchText = renderedText(search)
    expect(searchText).toContain('state.md')
    expect(searchText).toContain('decided: no summary')
    expect(searchText).not.toContain('undefined')
  })
})

describe('history tool rendering', () => {
  it('renders search hits from earlier windows', async () => {
    const { ctx, engine, agent, session } = await engineHarness('tools-history-search')
    const adapter = new ScriptedAdapter(
      Array.from({ length: 30 }, (_unused, index) => textResponse(`background detail ${index}`)),
    )
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'orchard harvest plan')
    const compacted = await engine.compactNow(agent, new AbortController().signal)
    expect(compacted).not.toBeNull()
    expect(countRollovers(session)).toBe(1)

    const search = await executeTool(ctx, agent, 'history', { action: 'search', query: 'research question 0' }, 'h1')
    const searchText = renderedText(search)
    expect(searchText).toContain('research question 0')
    expect(searchText).toContain('[seq ')
    expect(searchText).not.toContain('undefined')
  })

  it('renders a full read of a shadowed item', async () => {
    const { ctx, engine, agent } = await engineHarness('tools-history-read')
    const adapter = new ScriptedAdapter(
      Array.from({ length: 30 }, (_unused, index) => textResponse(`background detail ${index}`)),
    )
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'orchard harvest plan')
    const compacted = await engine.compactNow(agent, new AbortController().signal)
    expect(compacted).not.toBeNull()

    const search = await executeTool(ctx, agent, 'history', { action: 'search', query: 'research question 1' }, 'h1')
    const seqMatch = /\[seq (\d+)\]/.exec(renderedText(search))
    if (seqMatch?.[1] === undefined) throw new Error('expected a history search hit with a seq')
    const read = await executeTool(ctx, agent, 'history', { action: 'read', seq: Number(seqMatch[1]) }, 'h2')
    const readText = renderedText(read)
    expect(readText).toContain('research question 1')
    expect(readText).toContain('[seq ')
    expect(readText).not.toContain('undefined')
    expect(read.value).toMatchObject({ action: 'read' })
  })
})
