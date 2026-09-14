/**
 * Tool discoverability: what the model is told about invoking
 * `get_context_remaining`.
 *
 * A live session showed the failure this guards against. Asked for
 * `get_context_remaining()`, the model searched the repository for the
 * function, then reported a fabricated reading — "initial context window has
 * full capacity available" — in a plan that claimed the tool had been
 * executed, while the session log showed no call at all.
 *
 * The plugin cannot force a model to invoke a tool, but it owns the two texts
 * that make the invocation unambiguous: the tool's own description, and the
 * guidance section. Both now say the tool takes no arguments, that a reading
 * comes from calling it, and that the state is not derivable from source.
 *
 * @module tests/tool-discovery
 */

import { describe, expect, it } from 'vitest'
import { CONTEXT_MANAGEMENT_GUIDANCE } from '../src/guidance.ts'
import { engineHarness } from './harness.ts'

/** The registered definition of one tool, as the model receives it. */
function toolDefinition(ctx: { tools: unknown }, name: string): { description?: string } {
  const registry = ctx.tools as {
    get?: (name: string) => { description?: string } | undefined
    list?: () => { name: string; description?: string }[]
  }
  const direct = registry.get?.(name)
  if (direct !== undefined) return direct
  return registry.list?.().find(tool => tool.name === name) ?? {}
}

describe('get_context_remaining discoverability', () => {
  it('describes the tool as a no-argument call whose reading must be fetched', async () => {
    const { ctx } = await engineHarness('tool-discovery', {})
    const definition = toolDefinition(ctx, 'get_context_remaining')
    const description = definition.description ?? ''

    expect(description).not.toBe('')
    expect(description).toMatch(/no arguments/i)
    // The failure mode was reasoning from the repository instead of calling.
    expect(description).toMatch(/call it/i)
    expect(description).toMatch(/not derivable/i)
  })

  it('tells the model in the guidance that the state is not readable from source', () => {
    expect(CONTEXT_MANAGEMENT_GUIDANCE).toMatch(/get_context_remaining is a tool you invoke/i)
    expect(CONTEXT_MANAGEMENT_GUIDANCE).toMatch(/no arguments/i)
    expect(CONTEXT_MANAGEMENT_GUIDANCE).toMatch(/not readable from repository files/i)
    // Fabricating a reading is called out explicitly, because a plausible
    // guess is exactly what the live session produced.
    expect(CONTEXT_MANAGEMENT_GUIDANCE).toMatch(/fabrication/i)
  })
})
