# dsh-context-rollover

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle for
**model-driven context self-management**: the model can deliberately end one
working context window and continue in a fresh one while preserving durable
state — with **no summarization**.

```text
fresh working context + durable model-managed notes + small recent raw tail + recoverable full history
```

Inspired by the context-management architecture in `openai/codex` (the
`new_context` tool, token-budget compaction without a summarizer, history/notes
separation) and `pi-posthorse`. Codex is the architectural reference; DSH is the
implementation authority — everything runs through DSH's own surface-replace
protocol and compaction transaction.

## How it works

The plugin provides the active `ctx.compaction` engine (it disables
`dsh-compaction-basic` in its bundle patch). A rollover is a real DSH
compaction: `compaction/start` → `compaction/summary` → one replacement
`user/message` with full source provenance → `compaction/end` — but the
"summary" is a **deterministic checkpoint** (durable notes + handoff or
recovery record), never an LLM call. Raw session events stay persisted; a
token-budgeted recent tail stays verbatim on the surface; `deriveMessages()`
rebuilds automatically.

Responsibilities stay split (the Codex lesson):

| Concern | Owner |
|---|---|
| Request a boundary | `new_context` tool (records a pending request only) |
| Cross the boundary | `agent/pre-step` (before the next model request) and `agent/turn-stopping` |
| Track windows | rollover count + summary seqs read from the durable log |
| Measure pressure | `ctx.tokenMeter` + the routed model's context window |
| Replace the surface | `commitRollover` inside DSH's compaction transaction |
| Preserve selected state | `notes` tool (markdown files per session) |
| Recover old details | `history` tool (search/read over shadowed surface events) |

### Model-facing tools

- **`new_context({ handoff? })`** — request a context boundary at the next safe
  point. The handoff (bounded) becomes part of the new window's checkpoint. The
  boundary is crossed at a safe lifecycle point, never mid-tool-batch.
- **`get_context_remaining()`** — honest headroom: tokens left before the hard
  window and before the automatic rollover, or "not measured yet".
- **`notes`** — `list | read | write | append | search` over per-session
  markdown files under `<dsh home>/notes/<session id>/`. Nothing is written
  automatically; the model decides what survives.
- **`history`** — `search | read` over conversation that left the active
  surface. Targeted recovery, not wholesale reconstruction.

### Rollover paths

1. **Model-driven** (preferred): the model saves notes, calls `new_context`
   with a short handoff at a phase boundary (research → implementation, etc.).
2. **Pressure** (safety net): above `thresholdRatio` of the window the engine
   rolls over automatically with an uncurated **recovery record** (recent direct
   user messages, explicitly marked as possibly stale — the fresh model is told
   to verify live state). Below that, a **one-per-window** checkpoint reminder
   suggests saving notes and rolling over.
3. **Overflow**: a provider-confirmed `CONTEXT_WINDOW_EXCEEDED` forces a
   rollover (no tail) and the request retries.
4. **Manual**: `/compact` keeps working — it performs a standalone rollover
   with recovery record + tail on an idle agent.

## Host version compatibility

The plugin typechecks against **both** host lines: your development checkout
(0.1.3-alpha, via generated tsconfig paths) and the newest packages published
to public npm (`pnpm typecheck:compat` against `compat/node_modules`). Runtime
differences — `snapshotEvents()` vs `events`, `eventAt`, the `TokenMeter`
export shape, per-node heuristic pricing — are bridged in `src/compat.ts`.

Note the published `@deepseek-ai/dsh-*` packages are a *partial* mirror: some
of their peers reference packages that were never published publicly, so a
standalone npm-only host graph cannot be assembled. That is expected — the
plugin's peers resolve from the running dsh host's installation closure, and
installing the plugin itself into a profile fetches only this package.

## Install

From npm (recommended):

```sh
dsh plugin --profile <profile> add dsh-context-rollover
# or, without the dsh CLI:
pnpm --dir "$DSH_HOME/profiles/<profile>" add dsh-context-rollover
```

A custom profile initializes with just `dsh-base`; the bundle's patch applies
automatically because the package declares `dsh.bundle.patch`. After the first
install (a bundle-membership change is a boot-time composition), start the
profile once — the plugin's peer packages resolve from the running host's
installation closure, never from npm.

From GitHub instead of npm:

```sh
dsh plugin --profile <profile> add github:athif23/dsh-context-rollover
```

From a local checkout (development, see the HMR section below):

```sh
dsh plugin --profile <profile> add D:/path/to/dsh-context-rollover
```

**Windows note**: if the plugin loads but its `@deepseek-ai/*` imports fail at
runtime after an install from Git Bash, pnpm may have materialized broken
`link:` junctions (a Git Bash/Windows path-mangling bug). Recreate them with
`cmd /c mklink /J` as described in the HMR section below — the same fix
applies to any linked sibling package in the profile.

The bundle's `cordis.patch.yml` disables `dsh-compaction-basic` and mounts the
`context-rollover` engine itself. `command-compact`, the token meter, and the
compaction invariant companions need no changes — they depend only on
`ctx.compaction`.

Configuration (cordis.yml `config` on the plugin row):

```yaml
- insert:
    - id: context-rollover
      name: dsh-context-rollover
      config:
        thresholdRatio: 0.9          # automatic rollover point (fraction of window)
        reminderThresholdRatio: 0.75 # one-time checkpoint reminder point
        retainRatio: 0.1             # recent verbatim tail (fraction of window)
        retainTokens: null           # absolute tail budget; overrides retainRatio
        handoffMaxChars: 20000
        notesEnabled: true
        historyEnabled: true
        notesDir: null               # base dir override; default <dsh home>/notes
```

## Local development with HMR

The fast loop runs DSH from your checkout with the plugin linked from this
directory and Cordis HMR watching the source:

1. **Create a dedicated profile and link this package**

   ```sh
   dsh plugin --profile rollover-dev add D:/path/to/dsh-context-rollover
   ```

   (A custom profile initializes with just `dsh-base`; the bundle's patch
   applies automatically because the package declares `dsh.bundle.patch`.)

2. **Enable the `hmr` row** in `$DSH_HOME/profiles/rollover-dev/cordis.patch.yml`
   (patch rows replace whole configs, so restate `root`):

   ```yaml
   - id: hmr
     config:
       root: ['.', 'D:/path/to/dsh-context-rollover/src']
       debounce: 100
   ```

   The base bundle mounts `hmr` disabled by default; the `timer` row it needs
   is already active.

3. **Run DSH from source**

   ```sh
   cd /path/to/deepseek-harness
   pnpm run build          # once; Typert host artifacts are required
   pnpm dsh --profile rollover-dev
   ```

   Source launch runs through tsx (`node --import tsx/esm`), which is what makes
   hot reload of TypeScript plugin sources work.

4. **Edit `src/*.ts` in this package** — the affected plugin reloads in place;
   registrations (tools, system-prompt sections, event listeners) unwind and
   reapply through Cordis effects. Profile patch edits also recompose live
   (`patchReload: live` is the default for custom profiles).

5. **Restart is still required for**: initial bundle installation, bundle
   membership changes (`dsh.plugin add/remove`), framework-level dependency
   changes (Cordis falls back to `loader.exit()`), and anything HMR cannot
   safely swap.

### Windows: `link:` junctions and Git Bash

`pnpm install` in a profile run from Git Bash mangles `link:D:/...`
specifiers into junctions with invalid targets (the drive colon is treated
as relative). If a profile's linked plugins fail to load after an install,
recreate the junctions with the real targets:

```sh
cmd /c mklink /J "%DSH_HOME%\profiles\web\node_modules\dsh-context-rollover" "D:\path\to\dsh-context-rollover"
```

(or run the install from PowerShell/cmd). This package's own runtime peers
are junctions into the shared installation closure at
`$DSH_HOME/profiles/node_modules/@deepseek-ai/*`. That is what lets the
engine share the host's module instances: a service plugin that extends
`CompactionEngine` must import the exact classes the host loaded, so
resolving its `@deepseek-ai/*` imports through the same closure as the host
is load-bearing, not an optimization.

## Tests and typecheck (no DSH build needed)

The sibling DSH checkout is the source of truth: `tsconfig.base.json` paths are
generated into `tsconfig.dsh-paths.json` and vitest aliases execute everything
from TypeScript source — the same source plane DSH's own suites use. Vendored
packages typecheck against their built declarations so `skipLibCheck` absorbs
their relaxed strictness.

```sh
pnpm install
pnpm test        # 18 tests: surface, notes, history, engine integration
pnpm typecheck
```

Tests mount the real session store, token meter, tool runtime, agent loop, and
**the compaction invariant companions**, so every committed rollover is
validated against DSH's own invariants. The integration test proves the
semantic experiment end to end: the model researches, calls `new_context`
mid-turn, and the fresh window carries notes + handoff + recent tail while the
turn continues.

## Scope and limits

- Notes survive context rollovers within a session; no cross-session sync,
  embeddings, or cloud storage.
- Notes are files, not session events: `Session.append` cannot mark a plugin's
  custom event types `ignorable`, so unknown plugin events on a session log
  would make that log unreadable by any DSH build without the plugin. Only
  known event types (`compaction/*`, `user/message`) are written.
- The generic `<compaction>` checkpoint provenance is reused, so transcript UIs
  recognize rollover checkpoints like any compaction.
- No DSH core was forked or patched; the plugin only consumes public seams.

## License

MIT
