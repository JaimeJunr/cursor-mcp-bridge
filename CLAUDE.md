# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server (stdio) that lets any MCP host delegate to the **Cursor CLI agent** (`agent -p`)
running headless. Cursor is the cheap/fast worker: routine implementation, project mapping,
surgical reads, filtered command output, and web lookups — done on Cursor's side so the full
output never enters the caller's context. The design goal of every tool is **context economy**:
`format()` in `src/index.ts` logs the char count returned to context, because that char count is
the real cost being optimized.

## Commands

```bash
npm run build      # tsc → dist/ (the published/registered artifact is dist/index.js)
npm run dev        # run the server from source via tsx (no build step)
npm test           # vitest run — all unit tests
npx vitest run test/cli.test.ts   # single test file
npx vitest run -t "resolveModel"  # single test by name
```

There is no linter configured. `npm run build` (tsc, `strict: true`) is the type-check gate.

## Architecture

Four small modules under `src/`, each with a matching `test/*.test.ts`. The split exists so the
**pure logic is testable without spawning the Cursor process**:

- `index.ts` — MCP server + tool registrations (seven tools: `delegate`, `explore`, `read_slice`,
  `run_filtered`, `web_lookup`, `follow_up`, `bridge_stats`). Owns tool descriptions and the shared
  `routing` params (`cwd`/`model`/`effort`). `format()` appends the `session_id` footer and logs
  usage; `follow_up` feeds that id back as `RunOpts.resume` (`--resume`) so a prior Cursor session
  continues without resending its context — the footer and `follow_up` are two ends of the same loop.
  `follow_up` takes an optional `mode` — without it, a resumed session regains full tool access, so
  continuing a read-only session (`explore`/`read_slice`/`web_lookup`) must pass `mode:'ask'` to stay
  read-only. The default (no mode) is for continuing a `delegate`.
- `cli.ts` — the only module that touches the child process. `runCursor()` spawns `agent -p`;
  `buildCursorArgs()`, `resolveModel()`, `parseCliJson()` are **pure** and unit-tested. Keep the
  spawn boundary here — do not spawn from elsewhere.
- `prompts.ts` — pure prompt builders (`readSlicePrompt`, `runFilteredPrompt`, `explorePrompt`,
  `webLookupPrompt`). The tools' behavior lives in these prompt strings, so changing a tool's
  contract usually means editing a prompt here (and its test), not `cli.ts`.
- `usage.ts` — JSONL usage log behind `CURSOR_BRIDGE_LOG`; drives the `bridge_stats` tool.

### The sandbox (default-on, in `cli.ts`)

By default `runCursor` wraps the spawn in **bubblewrap (`bwrap`)** with an isolated `$HOME`, so the
Cursor CLI can't load the user's global behavior config (`~/.cursor/rules`, `mcp.json`, `hooks.json`,
`skills-cursor`, `cli-config.json`). That config was the real cost: it inflated every call to ~57k
input tokens and made the CLI try to spin up the user's MCP servers on each run (the "hangs until
timeout" symptom). Sandboxed, a trivial call drops to ~11k input tokens (−80%). Only auth
(`~/.config/cursor/auth.json`) and toolchains (`~/.local`, `~/.nvm`, mise/sdkman, gradle/m2 caches)
are bound in; the workspace (`cwd`) is bound RW as the last mount. Design points, all in `cli.ts`:

- **`buildSandboxArgs(spec)` is pure and unit-tested** (like `buildCursorArgs`). Bind order is
  load-bearing: `isoHome` mounts the empty `$HOME` **before** the HOME-subpath overlays (auth/
  toolchain), and the `workspace` bind is **last** so it's never shadowed. `buildSandboxSpec` is the
  impure half (mkdtemp + `existsSync` probing) — keep the fs/tmp side effects there.
- **Default-on with graceful fallback.** `SANDBOX_ON` is true unless `CURSOR_BRIDGE_SANDBOX` is
  `off`/`0`/`false`/`no`/empty. If `bwrap` isn't on PATH, it logs to stderr and runs unsandboxed
  (never fails the call). The two ephemeral tmp dirs (iso-home, /tmp) are `cleanup()`-ed on
  close/error/timeout.
- The spawn boundary stays in `cli.ts` — the sandbox composes `bwrap <args> <CURSOR_BIN> <cursorArgs>`
  in the single `spawn()`; don't spawn `bwrap` from elsewhere.

### Key invariants (violating these breaks tools or tests)

- **Read-only modes are load-bearing for safety.** `explore`, `read_slice` and
  `web_lookup` use `ask` — passed via `RunOpts.mode` → `--mode`. `delegate` and `run_filtered`
  run with full tool access (and shell autonomy when `CURSOR_BRIDGE_FORCE=1`). Do not silently
  change a read-only tool to run without a mode. `explore` must use `ask`, never `plan`: `plan`
  makes the Cursor worker emit an implementation plan ("vou formalizar no plano") instead of
  answering the question — a real regression. `RunOpts.mode` keeps `"plan"` as a valid CLI value.
- **`auto` ignores `effort`.** `resolveModel` only appends `[effort=...]` for non-`auto` models.
  `auto` is the default model (cheapest); keep it the default.
- **`explore` defaults to `auto` via `EXPLORE_MODEL`.** `EXPLORE_MODEL` (env `CURSOR_BRIDGE_EXPLORE_MODEL`)
  is applied in the `explore` handler as `model ?? EXPLORE_MODEL` — `auto` lets Cursor pick its cheap/fast
  model (in practice composer) without pinning an id that can go slow/unavailable, so exploration never
  escalates to the caller's expensive model. An explicit `model` still wins.
  `explore` also takes `breadth` (`medium`|`thorough`) → passed to `explorePrompt`; it LOCATES, never reviews.
- **`read_slice` must return source lines, not just `file:line` prefixes** — this is an explicit
  instruction in `readSlicePrompt` and was a real regression (commit c41c2af). Preserve it.
- **`parseCliJson` degrades gracefully**: non-JSON stdout falls back to raw text; `usage.ts`
  skips malformed JSONL lines. Match this best-effort posture — logging/parsing must never throw
  up into a tool call.

## The hook (`hooks/prefer-cursor-bridge.mjs`)

Ships separately from the server: a hook the host wires for `PreToolUse`
(`Read|Grep|Glob|WebSearch|WebFetch|Bash` and `Agent|Task`) and for `SessionStart`. It nudges the
agent toward the bridge because these MCP tools are **deferred** (schemas load only via ToolSearch)
and lose to always-loaded native tools by default. On `Bash` it only fires for artifact-writing
commands (`git commit`/`push`, `git worktree add`, `gh pr create`, `bkt pr create`) — nudging that
grunt-work to `delegate`; read-only Bash is left alone (rtk already trims it). Design constraints,
all tested in `test/hook.test.ts`:

- Pure decision in `decide(input, deps)` with injectable fs — that's what the tests exercise.
  The I/O wrapper (`main`) only runs when invoked as a script.
- **Dedup per session** (keyed by `session_id` in an `os.tmpdir()` file, mode `0600`): every
  nudge fires at most once. A repeated nudge is worse than none. This is why `Grep`/`Glob` can
  sit in the matcher — they collapse to a single preload reminder.
- The first qualifying nudge of a session also carries the one-time preload reminder.
- **`SessionStart` closes the Bash-grep hole:** the PreToolUse preload only fires on the `Grep`/`Read`
  tool, but agents often use `Bash grep` (matches no matcher), so the preload never arrived.
  `sessionStartContext()` injects it as `additionalContext` before the first tool decision and
  pre-marks `preload` in the dedup file so the PreToolUse piggyback never repeats it.
- Never blocks the tool; any error → print nothing, exit 0.
- Threshold for the Read nudge is `CURSOR_BRIDGE_HOOK_MIN_LINES` (default 300).

The hook also matches **`Agent|Task`** to reach spawned subagents (`buildAgentUpdatedInput` +
`handleAgent`). When `subagent_type === "Explore"`, `agentPref()` appends `EXPLORE_EXTRA` — an extra
line telling that run (spawned on the orchestrator's expensive model) to route all reading through
`explore`/`read_slice` (which run on cheap composer). `sessionStartContext()` carries the matching
main-loop steer: prefer calling `explore()` directly over spawning the Explore subagent.
Subagents never see the main-loop nudges, and the context-mode plugin's own
`Agent|Task` hook appends a "route everything through context-mode" block that never mentions the
bridge. **Critical constraint:** multiple PreToolUse hooks returning `updatedInput` for one tool do
NOT merge — last-to-finish-wins, non-deterministic. So `handleAgent` **imports context-mode's live
`routing.mjs`** (`CONTEXT_MODE_ROUTING`, default marketplace path), takes the prompt it would
produce (already carrying context-mode's block), and appends the bridge preference — so whoever
wins the race, context-mode's block survives. If that import fails, inject **nothing** (never
clobber context-mode; that's the invariant). `CURSOR_BRIDGE_AGENT_DELAY_MS` (default 350ms) biases
the race toward this hook by finishing last. This path bypasses the session dedup (every subagent
needs its own injection); idempotency is by the `CURSOR_BRIDGE_MARKER` already being in the prompt.

When changing hook behavior, update the pure functions (`decide`, `buildAgentUpdatedInput`) not the
I/O wrappers (`main`/`handleAgent`), and add/adjust a case in `test/hook.test.ts` — the test
imports the `.mjs` directly and injects fakes for fs and context-mode's route function.

## Conventions

- ESM + TypeScript, Node16 module resolution. `dist/` and `node_modules/` are gitignored;
  imports use `.js` extensions (Node16 requirement) even though sources are `.ts`.
- Comments are in Portuguese; code identifiers and prompt strings are in English. Match this.
- Cross-cutting env vars are read once as module-level consts in `cli.ts`/`usage.ts` — add new
  config there, don't scatter `process.env` reads.
