import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Local development loop: type resolution and test execution read DSH source
// through the paths generated from the sibling checkout's tsconfig.base.json
// (scripts/generate-dsh-paths.mjs), so no build or publish step is needed.
// Everything executes from TypeScript source, transformed in place — the
// same source-plane the DSH repository's own vitest suites use.

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)))
const generated = JSON.parse(
  readFileSync(resolve(projectRoot, 'tsconfig.dsh-paths.json'), 'utf8'),
)

/** The runtime source entry: vendor declaration targets map back to src. */
function runtimeEntry(absoluteTarget) {
  const normalized = absoluteTarget.split(String.fromCharCode(92)).join('/')
  const declarationMarker = 'lib/types/index.d.ts'
  if (normalized.includes(declarationMarker)) {
    return normalized.replace(declarationMarker, 'src/index.ts')
  }
  return absoluteTarget.endsWith('.ts') ? absoluteTarget : `${absoluteTarget.replace(/[/\\]$/, '')}/index.ts`
}

/** Escape a path segment for embedding in a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Build one vite alias pair from a generated paths entry. */
function aliasFor(key, target) {
  // Generated paths entries are relative to the project root (that is how
  // tsc resolves them in the carrying tsconfig), so resolve against
  // projectRoot — resolving against the checkout dir would double-prefix.
  const absolute = resolve(projectRoot, target.replaceAll('*', '__STAR__'))
  if (!key.includes('*')) {
    return { find: new RegExp(`^${escapeRegExp(key)}$`), replacement: runtimeEntry(absolute) }
  }
  // Wildcard keys map 'prefix*suffix' imports onto the same-shaped target.
  const [before, after] = key.split('*')
  return {
    find: new RegExp(`^${escapeRegExp(before)}(.*)${escapeRegExp(after)}$`),
    replacement: runtimeEntry(absolute).replaceAll('__STAR__', '$1'),
  }
}

const aliases = Object.entries(generated.compilerOptions.paths)
  .flatMap(([key, targets]) => {
    const target = targets[0]
    return target === undefined ? [] : [aliasFor(key, target)]
  })

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
