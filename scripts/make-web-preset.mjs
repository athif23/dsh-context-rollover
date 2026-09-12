#!/usr/bin/env node
/**
 * Regenerate the shipped `standard-rollover` agent preset from the harness's
 * shipped `standard` composition, swapping only the compaction engine row.
 *
 * Maintainer tooling (`pnpm preset:sync`), not a user command: Web users get
 * the preset automatically through the bundle's preset-root registration, and
 * customize it through the supported preset-copy flow. Re-run after harness
 * updates and commit the refreshed `presets/` directory.
 *
 * Plain Node with no dependencies. The transform keeps everything else in the
 * composition byte-identical and fails loud when the shipped shape drifts.
 *
 * Usage:
 *   node scripts/make-web-preset.mjs [--presets-dir <dir>] [--out-dir <dir>]
 *     [--preset-id <id>] [--threshold-ratio <n>] [--reminder-ratio <n>]
 *     [--retain-tokens <n> | --retain-ratio <n>] [--handoff-max-chars <n>]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Id of the shipped preset the generated preset derives from. */
const SOURCE_PRESET = 'standard'

/** Default id (directory name) of the generated preset. */
const DEFAULT_PRESET_ID = 'standard-rollover'

/** Directory names must stay path-contained; mirrors the harness preset rule. */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/** The exact shipped row this script replaces (indent included). */
const BASIC_ROW = `    - id: compaction-basic\n      name: '@deepseek-ai/dsh-compaction-basic'`

/**
 * Candidate roots holding shipped presets (`<root>/standard/agent.cordis.yml`):
 * explicit `--presets-dir` first, then the sibling DSH checkout this repo
 * develops against.
 * @param presetsDir - value of `--presets-dir`, when given.
 * @returns candidate preset-root directories, nearest first.
 */
export function candidatePresetRoots(presetsDir) {
  if (presetsDir !== undefined) return [resolve(presetsDir)]
  return [join(packageDir, '..', 'deepseek-harness', 'packages', 'preset', 'agent-presets', 'presets')]
}

/**
 * Find the `standard` composition the preset derives from.
 * @param presetsDir - value of `--presets-dir`, when given.
 * @param source - source preset id.
 * @returns the absolute composition file path.
 * @throws when no candidate supplies the source preset.
 */
export function findSourcePreset(presetsDir, source = SOURCE_PRESET) {
  for (const root of candidatePresetRoots(presetsDir)) {
    const file = join(root, source, 'agent.cordis.yml')
    if (existsSync(file)) return file
  }
  throw new Error(
    `make-web-preset: no "${source}" preset found; pass --presets-dir <harness>/packages/preset/agent-presets/presets`,
  )
}

/**
 * Validate the numeric engine configuration, mirroring the engine's own
 * rules so a bad flag fails here instead of at session start.
 * @param config - raw numeric options.
 * @returns the validated options.
 * @throws on any out-of-range value.
 */
export function resolveOptions(config) {
  const thresholdRatio = config.thresholdRatio ?? 0.9
  const reminderRatio = config.reminderRatio ?? 0.75
  const handoffMaxChars = config.handoffMaxChars ?? 20000
  for (const [name, value] of [['threshold-ratio', thresholdRatio], ['reminder-ratio', reminderRatio]]) {
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      throw new Error(`make-web-preset: --${name} must be in (0, 1], got ${String(value)}`)
    }
  }
  if (reminderRatio > thresholdRatio) {
    throw new Error(
      `make-web-preset: --reminder-ratio (${reminderRatio}) must not exceed --threshold-ratio (${thresholdRatio})`,
    )
  }
  const retainTokens = config.retainTokens ?? null
  if (retainTokens !== null && (!Number.isSafeInteger(retainTokens) || retainTokens < 0)) {
    throw new Error(`make-web-preset: --retain-tokens must be a non-negative integer, got ${String(retainTokens)}`)
  }
  const retainRatio = config.retainRatio ?? 0.1
  if (retainTokens === null && (!Number.isFinite(retainRatio) || retainRatio <= 0 || retainRatio > 1)) {
    throw new Error(`make-web-preset: --retain-ratio must be in (0, 1], got ${String(retainRatio)}`)
  }
  if (!Number.isSafeInteger(handoffMaxChars) || handoffMaxChars <= 0) {
    throw new Error(`make-web-preset: --handoff-max-chars must be a positive integer, got ${String(handoffMaxChars)}`)
  }
  return { thresholdRatio, reminderRatio, retainTokens, retainRatio, handoffMaxChars }
}

/**
 * Render the replacement engine row (same 4-space nesting as the shipped row).
 * @param engineEntry - module specifier of the built engine, as the preset row
 *   names it (relative to the preset directory for shipped presets).
 * @param options - validated numeric options from {@link resolveOptions}.
 * @returns the row text, without trailing newline.
 */
export function renderEngineRow(engineEntry, options) {
  const tail = options.retainTokens !== null
    ? `        retainTokens: ${options.retainTokens}`
    : `        retainRatio: ${options.retainRatio}`
  return `    # Generated by dsh-context-rollover scripts/make-web-preset.mjs: the same\n`
    + `    # deterministic rollover backend the host bundle mounts, owned per-session here.\n`
    + `    # Do not edit; re-run \`pnpm preset:sync\` after harness updates.\n`
    + `    - id: context-rollover\n`
    + `      name: '${engineEntry}'\n`
    + `      config:\n`
    + `        thresholdRatio: ${options.thresholdRatio}\n`
    + `        reminderThresholdRatio: ${options.reminderRatio}\n`
    + `${tail}\n`
    + `        handoffMaxChars: ${options.handoffMaxChars}`
}

/**
 * Swap the shipped `compaction-basic` row for the rollover engine row.
 * Everything else in the composition stays byte-identical.
 * @param text - the shipped composition text.
 * @param engineEntry - module specifier of the built engine.
 * @param options - validated numeric options from {@link resolveOptions}.
 * @returns the preset composition text.
 * @throws when the anchor row is absent or carries an unexpected config block.
 */
export function transformPresetText(text, engineEntry, options) {
  const index = text.indexOf(BASIC_ROW)
  if (index === -1) {
    throw new Error(
      'make-web-preset: the installed standard preset no longer contains the expected compaction-basic row; '
      + 'update scripts/make-web-preset.mjs to the new shape',
    )
  }
  if (text.indexOf(BASIC_ROW, index + 1) !== -1) {
    throw new Error('make-web-preset: refusing to rewrite: more than one compaction-basic row found')
  }
  // A future harness may add keys (e.g. `config:`) to the shipped row. Those
  // deeper-indented lines would then attach to the replacement row, so fail loud.
  const after = text.slice(index + BASIC_ROW.length).split('\n')
  const next = after.slice(1).find(line => line.trim() !== '' && !line.trim().startsWith('#'))
  if (next !== undefined && /^ {5,}/.test(next)) {
    throw new Error(
      'make-web-preset: the installed compaction-basic row carries an unexpected config block; '
      + 'update scripts/make-web-preset.mjs to the new shape',
    )
  }
  return text.slice(0, index) + renderEngineRow(engineEntry, options) + text.slice(index + BASIC_ROW.length)
}

/**
 * Render the preset metadata file.
 * @returns the `preset.yml` text.
 */
export function renderPresetMeta() {
  return `name: Standard + rollover (experimental)\n`
    + `description: Full coding agent with model-driven context rollover instead of summarization (generated from standard). Experimental opt-in; standard remains the default.\n`
    + `order: 2\n`
}

/**
 * Minimal `--key value` / `--key=value` argument parser.
 * @param argv - process arguments without the node/script prefix.
 * @returns the parsed flags.
 */
export function parseArgs(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) throw new Error(`make-web-preset: unexpected argument ${arg}; see --help`)
    const [key, inline] = arg.slice(2).split('=', 2)
    if (key === 'help') {
      flags.help = true
      continue
    }
    const value = inline ?? argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`make-web-preset: --${key} needs a value; see --help`)
    }
    if (inline === undefined) index += 1
    flags[key] = value
  }
  return flags
}

/** Print usage. */
export function printHelp() {
  console.log(`make-web-preset: regenerate the shipped standard-rollover preset (maintainer sync)

Options:
  --presets-dir <dir>     shipped presets root (default: sibling DSH checkout)
  --out-dir <dir>         presets root to write into (default: this package's presets/)
  --preset-id <id>        generated preset id (default: ${DEFAULT_PRESET_ID})
  --threshold-ratio <n>   auto-rollover point, fraction of window (default: 0.9)
  --reminder-ratio <n>    one-time checkpoint reminder point (default: 0.75)
  --retain-tokens <n>     absolute recent-tail budget (default: unset)
  --retain-ratio <n>      tail budget fraction when --retain-tokens is unset (default: 0.1)
  --handoff-max-chars <n> max handoff/notes text (default: 20000)`)
}

/**
 * Run the generator.
 * @param argv - process arguments without the node/script prefix.
 */
export async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv)
  if (flags.help) {
    printHelp()
    return
  }
  const presetId = flags['preset-id'] ?? DEFAULT_PRESET_ID
  if (!PRESET_ID.test(presetId)) {
    throw new Error(`make-web-preset: --preset-id must match ${PRESET_ID}, got ${presetId}`)
  }
  const number = (name) => {
    const raw = flags[name]
    if (raw === undefined) return undefined
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(`make-web-preset: --${name} must be a number, got ${raw}`)
    return value
  }
  const options = resolveOptions({
    thresholdRatio: number('threshold-ratio'),
    reminderRatio: number('reminder-ratio'),
    retainTokens: number('retain-tokens'),
    retainRatio: number('retain-ratio'),
    handoffMaxChars: number('handoff-max-chars'),
  })
  if (flags['retain-tokens'] !== undefined && flags['retain-ratio'] !== undefined) {
    throw new Error('make-web-preset: --retain-tokens and --retain-ratio are exclusive')
  }
  const engineEntryAbs = join(packageDir, 'lib', 'index.js')
  if (!existsSync(engineEntryAbs)) {
    throw new Error(`make-web-preset: built engine missing at ${engineEntryAbs}; run npm run build first`)
  }
  const source = findSourcePreset(flags['presets-dir'])
  const text = readFileSync(source, 'utf8')
  const outDir = flags['out-dir'] === undefined ? join(packageDir, 'presets') : resolve(flags['out-dir'])
  const dir = join(outDir, presetId)
  // The engine specifier stays portable across install layouts: relative from
  // the preset directory to this package's built entry. A preset on another
  // drive (or otherwise unreachable relatively) cannot name it, so fail loud.
  const rawEntry = relative(dir, engineEntryAbs).split(sep).join('/')
  if (isAbsolute(rawEntry) || rawEntry === '') {
    throw new Error(`make-web-preset: --out-dir ${outDir} cannot relatively reach ${engineEntryAbs}`)
  }
  const entry = rawEntry.startsWith('.') ? rawEntry : `./${rawEntry}`
  const preset = transformPresetText(text, entry, options)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), preset)
  writeFileSync(join(dir, 'preset.yml'), renderPresetMeta())
  console.log(`make-web-preset: derived ${presetId} from ${source}`)
  console.log(`make-web-preset: wrote ${join(dir, 'agent.cordis.yml')}`)
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
