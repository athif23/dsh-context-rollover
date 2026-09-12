/**
 * Pre-step selection coverage: at an open turn the replacement span starts
 * after the system head and covers closed turns, keeping the open turn's
 * messages in the verbatim tail.
 *
 * @module tests/pressure-range
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { selectRolloverRange } from '../src/rollover.ts'
import {
  engineHarness,
  followup,
  ScriptedAdapter,
  usageResponse,
} from './harness.ts'

describe('pre-step range selection', () => {
  it('covers closed turns past the system head at an open turn', async () => {
    const { ctx, agent, session } = await engineHarness('pre-step-range', {
      thresholdRatio: 0.001,
      reminderThresholdRatio: 0.001,
      retainTokens: 0,
    })
    const adapter = new ScriptedAdapter([
      usageResponse(`research answer one ${'detail '.repeat(600)}`, 5000),
      usageResponse(`research answer two ${'detail '.repeat(600)}`, 6000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    await followup(agent, 'turn one')

    // The turn-two pre-step state: turn opened, user message appended, no
    // request made yet — the span must cover turn one past the system head.
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'turn two' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const nodes = session.surface.nodes
    const range = selectRolloverRange(session, ctx.tokenMeter.measure(session), 0)
    expect(range).not.toBeNull()
    if (range === null) return
    expect(range.start).toBe(nodes[1])
    expect(range.end).toBe(nodes[nodes.length - 2])
    expect(range.shadowedSeqs).not.toContain(nodes[0])
  })
})
