/**
 * Plugin configuration: validated once at load, resolved against model context
 * windows at runtime. Ratios scale defaults across models; absolute overrides
 * stay available for stable experiments.
 *
 * @module dsh-context-rollover/config
 */

import z from '@deepseek-ai/schemastery'

/** Model-facing configuration surface for the rollover engine. */
export interface RolloverConfig {
  /**
   * Automatic rollover pressure point as a fraction of the routed model's
   * context window. Defaults to `0.9`.
   */
  thresholdRatio?: number
  /**
   * One-time checkpoint reminder point as a fraction of the context window.
   * Defaults to `0.75`.
   */
  reminderThresholdRatio?: number
  /**
   * Recent verbatim tail retained across a rollover, as a fraction of the
   * context window. Defaults to `0.1`.
   */
  retainRatio?: number
  /**
   * Absolute recent-tail budget in tokens; overrides `retainRatio` when set.
   */
  retainTokens?: number
  /** Maximum accepted handoff text size in characters. Defaults to `20000`. */
  handoffMaxChars?: number
  /** Mount the `notes` tool and render notes into rollover checkpoints. */
  notesEnabled?: boolean
  /** Mount the `history` tool. */
  historyEnabled?: boolean
  /** Base directory for note files; defaults to `<dsh home>/notes/<session id>`. */
  notesDir?: string
  /**
   * Model-surface registration: `auto` registers tools and guidance only
   * where no preset roster exists (the host row), while `always` registers
   * them unconditionally (the preset row, which owns its composition).
   * Defaults to `auto`.
   */
  modelSurface?: 'auto' | 'always'
}

/** Schemastery validation for {@link RolloverConfig}. */
export const Config: z<RolloverConfig> = z.object({
  thresholdRatio: z.number(),
  reminderThresholdRatio: z.number(),
  retainRatio: z.number(),
  retainTokens: z.number().step(1).min(0),
  handoffMaxChars: z.number().step(1).min(0),
  notesEnabled: z.boolean(),
  historyEnabled: z.boolean(),
  notesDir: z.string(),
  modelSurface: z.union(['auto', 'always'] as const),
})

/** Resolved and validated rollover configuration. */
export interface ResolvedRolloverConfig {
  readonly thresholdRatio: number
  readonly reminderThresholdRatio: number
  readonly retainRatio: number
  /** `null` keeps the ratio-based tail budget. */
  readonly retainTokens: number | null
  readonly handoffMaxChars: number
  readonly notesEnabled: boolean
  readonly historyEnabled: boolean
  readonly notesDir: string | undefined
  readonly modelSurface: 'auto' | 'always'
}

/** Reject a ratio that cannot represent a fraction of a context window. */
function validateRatio(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new TypeError(`context-rollover: ${name} must be in (0, 1], got ${String(value)}`)
  }
}

/**
 * Validate and fill configuration defaults. Invalid values fail plugin load
 * (misconfiguration fails loud).
 * @param config - raw configuration from the plugin's cordis.yml row.
 * @returns the resolved configuration.
 */
export function resolveConfig(config: RolloverConfig): ResolvedRolloverConfig {
  const thresholdRatio = config.thresholdRatio ?? 0.9
  const reminderThresholdRatio = config.reminderThresholdRatio ?? 0.75
  const retainRatio = config.retainRatio ?? 0.1
  validateRatio('thresholdRatio', thresholdRatio)
  validateRatio('reminderThresholdRatio', reminderThresholdRatio)
  validateRatio('retainRatio', retainRatio)
  if (reminderThresholdRatio > thresholdRatio) {
    throw new TypeError(
      `context-rollover: reminderThresholdRatio (${reminderThresholdRatio}) must not exceed `
      + `thresholdRatio (${thresholdRatio})`,
    )
  }
  const retainTokens = config.retainTokens ?? null
  if (retainTokens !== null && (!Number.isSafeInteger(retainTokens) || retainTokens < 0)) {
    throw new TypeError(`context-rollover: retainTokens must be a non-negative integer, got ${String(retainTokens)}`)
  }
  const handoffMaxChars = config.handoffMaxChars ?? 20000
  if (!Number.isSafeInteger(handoffMaxChars) || handoffMaxChars <= 0) {
    throw new TypeError(`context-rollover: handoffMaxChars must be a positive integer, got ${String(handoffMaxChars)}`)
  }
  const modelSurface = config.modelSurface ?? 'auto'
  if (modelSurface !== 'auto' && modelSurface !== 'always') {
    throw new TypeError(
      `context-rollover: modelSurface must be 'auto' or 'always', got ${String(modelSurface)}`,
    )
  }
  return {
    thresholdRatio,
    reminderThresholdRatio,
    retainRatio,
    retainTokens,
    handoffMaxChars,
    notesEnabled: config.notesEnabled ?? true,
    historyEnabled: config.historyEnabled ?? true,
    notesDir: config.notesDir,
    modelSurface,
  }
}
