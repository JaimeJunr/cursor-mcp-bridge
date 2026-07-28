# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server (stdio) that lets any MCP host delegate to headless coding-agent CLIs: Codex, Grok,
Claude Code, and an opt-in Cursor fallback. The fleet handles implementation, project mapping,
surgical reads, filtered command output, and web lookups without putting the worker's full raw
context into the caller. The design goal of every tool is **context economy**: `format()` in
`src/index.ts` logs the char count returned to context, because that char count is the real cost
being optimized.

## Commands

```bash
npm run build      # tsc → dist/ (the published/registered artifact is dist/index.js)
npm run dev        # run the server from source via tsx (no build step)
npm test           # vitest run — all unit tests
npx vitest run test/cli.test.ts   # single test file
npx vitest run -t "resolveModel"  # single test by name
```

There is no linter configured. `npm run build` (tsc, `strict: true`) is the type-check gate.
`prepublishOnly` runs the build; only `dist/` is published (see `files` in `package.json`).

## Architecture

Five small modules under `src/`, with pure logic covered by `test/*.test.ts`. The split exists so
the **pure logic is testable without spawning a worker process**:

- `index.ts` — MCP server + tool registrations (ten tools: `delegate`, `explore`, `read_slice`,
  `run_filtered`, `web_lookup`, `generate_image`, `plan`, `build`, `follow_up`, `bridge_stats`).
  Owns tool descriptions and the shared `routing` params (`cwd`/`model`/`effort`). The second arg
  to `new McpServer(...)` is an `instructions` string that states the routing boundary
  (read/locate/web/grunt-work → bridge tools; native Read only when about to edit). These load at
  **startup** and are visible to the host even while tool schemas are deferred — that is why they
  matter for adoption. The five core tools (`delegate`, `explore`, `read_slice`, `run_filtered`,
  `web_lookup`) register with `_meta: { "anthropic/alwaysLoad": true }` so Claude Code (≥2.1.121)
  eagerly loads their schemas; secondary tools (`generate_image`, `plan`, `build`, `follow_up`,
  `bridge_stats`) stay deferred. `format()` appends the `session_id` footer and logs usage;
  `follow_up` feeds that id back as `RunOpts.resume` so a prior worker session continues without
  resending its context — the footer and `follow_up` are two ends of the same loop.
  `follow_up` takes an optional `mode` — without it, a resumed session regains full tool access, so
  continuing a read-only session (`explore`/`read_slice`/`web_lookup`) must pass `mode:'ask'` to stay
  read-only. The default (no mode) is for continuing a `delegate`.
- `cli.ts` — the only module that touches the child process. `runCursor()` spawns the engine's CLI;
  `buildCursorArgs()`/`buildGrokArgs()`/`buildCodexArgs()`/`buildClaudeArgs()` (+ `buildArgs`
  dispatcher), `resolveModel()`, `parseCliJson()`/`parseCodexJsonl()` (+ `parseOutput` dispatcher),
  `resolveTier()`, `hasEngine()`, `binExists()`, `budgetNote()` are **pure** and unit-tested. Keep
  the spawn boundary here — do not spawn from elsewhere.
- `agents.ts` — resolves an optional `delegate`/`build` persona on the host. A name such as
  `pit:issue-investigator` searches project/home `.claude/agents` and `~/.claude/plugins`; plugin
  collisions pick the newest match by mtime. An inline `{prompt}` skips lookup. Only the markdown
  body crosses into the worker, and names containing `/` or `..` are rejected.

### Engines & tiers (multi-CLI)

The bridge drives four coding-agent CLIs, each with its own dialect and output format —
`RunOpts.engine` (`"cursor"|"grok"|"codex"|"claude"`) selects one. Cursor is outside the default
tier path; it is available as a fallback only when `CURSOR_BRIDGE_ENABLE_CURSOR=1`
(`CURSOR_ENABLED`).

- **cursor** (`cursor-agent`) — opt-in fallback only. `CURSOR_BIN` defaults to `cursor-agent`, NOT
  `agent` (in the user's PATH `agent` may be the grok binary). Dialect: `-p <prompt>` positional,
  `--trust`, effort encoded in model ids, `--force`. Output `{result, session_id}`. Its default model
  id is `composer-2.5-fast`; the old `composer-2.5[fast=true]` bracket is invalid now.
- **grok** (`grok`) — dialect: prompt is the VALUE of `--single`, `--effort` is a separate
  flag, autonomy is `--always-approve` (not `--force`). Output `{text, sessionId}`.
- **codex** (`codex exec`) — dialect: `exec` subcommand, JSONL output (`--json`, parsed by
  `parseCodexJsonl` → last `agent_message`), effort via `-c model_reasoning_effort=`, autonomy via
  `--dangerously-bypass-approvals-and-sandbox`, plus `--ignore-user-config`/`--ignore-rules` so it
  never loads `~/.codex/config.toml` (whose MCP servers hung the CLI, spawning runaway `mcp-server`
  procs). `parseCliJson` is tolerant of cursor AND grok single-object shapes; codex uses the JSONL parser.
  Session id: codex emits it as **`thread_id`** in the `thread.started` event (NOT `session_id`) —
  `parseCodexJsonl` reads `thread_id` (with `session_id` as fallback), else `follow_up` on a Codex
  delegate loses the session. Resume is a **subcommand**, not a flag: `buildCodexArgs` emits
  `exec resume <id> <prompt>` when `opts.resume` is set (cursor uses `--resume`, grok `-r`).
- **claude** (`claude -p`) — headless dialect: `-p --output-format json --strict-mcp-config
  --setting-sources project`; never add `--bare`, because it breaks auth with `Not logged in`.
  Output is `{result, session_id}` and deliberately reuses `parseCliJson` (no Claude-only parser).
  Resume uses `--resume`; force OR mode always adds `--dangerously-skip-permissions`, because
  headless Claude otherwise hangs waiting for approval.

`delegate` takes a required `level` (1-5) → `resolveTier` maps difficulty to (engine, model, effort),
using a distinct model at every level across the three active subscriptions: 1=GPT-5.6 Luna
(codex), 2=Grok 4.5 medium (grok), 3=GPT-5.6 Terra medium (codex), 4=GPT-5.6 Sol medium (codex),
5=Opus (claude). `resolveTier(level, has, cursorEnabled)` uses the preferred CLI when present. If it
is missing, it falls back to the equivalent Cursor model only when `cursorEnabled` is true;
otherwise it throws a clear error naming the missing CLI.
- `prompts.ts` — pure prompt builders (`readSlicePrompt`, `runFilteredPrompt`, `explorePrompt`,
  `webLookupPrompt`, `planPrompt`, `buildPrompt`). The tools' behavior lives in these prompt strings,
  so changing a tool's contract usually means editing a prompt here (and its test), not `cli.ts`.
- `usage.ts` — JSONL usage log behind `CURSOR_BRIDGE_LOG`; drives the `bridge_stats` tool.

### The sandbox (default-on, mandatory for ALL engines, in `cli.ts`)

`runCursor` wraps the spawn in **bubblewrap (`bwrap`)** with an isolated `$HOME`, so each CLI can't
load the user's global behavior config (`~/.cursor/rules`, `~/.grok/config.toml`,
`~/.codex/config.toml`, `~/.claude/settings`, `mcp.json`, hooks, skills). That config was the real
cost: it inflated every call to ~57k input tokens and made the CLI try to spin up the user's MCP
servers on each run (the "hangs until timeout" symptom).
Sandboxed, a trivial call drops to ~11k input tokens (−80%). Only auth + toolchains are bound in; the
workspace (`cwd`) is bound RW as the last mount. Per-engine HOME binds are declared in
`SANDBOX_ENGINE_RO` and `SANDBOX_ENGINE_RW`: grok and codex need their engine homes RW; Claude gets
RO `~/.claude/.credentials.json` + `~/.claude.json`, and RW
`~/.claude/{statsig,projects,todos,shell-snapshots}`. Never bind all of `~/.claude`: agent personas
are resolved on the host and injected as strings, preserving config and cost isolation. Design
points, all in `cli.ts`:

- **stdin MUST be closed (`stdio: ["ignore",…]`).** `codex exec` hangs forever ("Reading additional
  input from stdin…") if stdin is an open pipe — this, NOT the namespace, was why codex appeared to
  "not survive the sandbox". With stdin closed, codex runs in the bwrap like the others (~9s).
  cursor, grok, and claude take the prompt by arg and never read stdin, so closing it is safe for
  all four.
- **codex config is neutralized by flags, not just the sandbox:** `buildCodexArgs` always passes
  `--ignore-user-config`/`--ignore-rules` so `~/.codex/config.toml` (with its external MCP servers,
  which spawned runaway `mcp-server` procs) is never loaded; auth still resolves via `CODEX_HOME`.
- **`buildSandboxArgs(spec)` is pure and unit-tested** (like `buildCursorArgs`). Bind order is
  load-bearing: `isoHome` mounts the empty `$HOME` **before** the HOME-subpath overlays (auth/
  toolchain), and the `workspace` bind is **last** so it's never shadowed. `buildSandboxSpec(workspace,
  engine)` is the impure half (mkdtemp + `existsSync` probing) — keep the fs/tmp side effects there.
- **Only `cwd` is mounted — paths outside it are invisible.** A command touching a sibling path
  (additional working dir, adjacent monorepo) fails with `No such file or directory`. Mount extras
  RW via `CURSOR_BRIDGE_SANDBOX_EXTRA` (`:`-separated absolute paths); `buildSandboxSpec` keeps only
  the ones that exist and aren't the workspace, and `buildSandboxArgs` binds them **after** the HOME
  overlays but **before** the workspace, so the workspace stays the last (never-shadowed) bind.
- **Default-on with graceful fallback.** `SANDBOX_ON` is true unless `CURSOR_BRIDGE_SANDBOX` is
  `off`/`0`/`false`/`no`/empty. If `bwrap` isn't on PATH, it logs to stderr and runs unsandboxed
  (never fails the call). The two ephemeral tmp dirs (iso-home, /tmp) are `cleanup()`-ed on
  close/error/timeout.
- The spawn boundary stays in `cli.ts` — the sandbox composes `bwrap <args> <engineBin> <engineArgs>`
  in the single `spawn()`; don't spawn `bwrap` from elsewhere.

### Key invariants (violating these breaks tools or tests)

- **Read-only modes are load-bearing for safety.** `explore`, `read_slice`, and `web_lookup` run on
  codex with `RunOpts.mode`, which `buildCodexArgs` converts to `-s read-only -c
  approval_policy="never"`. `plan` also passes a mode: its default level 4 gets hard Codex
  read-only; level 5 Claude is read-only by prompt only, and force OR mode must still add
  `--dangerously-skip-permissions` so Claude headless does not hang. `run_filtered`, `delegate`, and
  `build` omit mode and get full/bypass access because they execute commands or edit. Do not
  silently remove a read-only tool's mode.
- **The Cursor fallback default is `composer-2.5-fast`, never the old bracket or `auto`.**
  `DEFAULT_MODEL` (env `CURSOR_BRIDGE_MODEL`) applies to the opt-in Cursor path. The current
  cursor-agent rejects `composer-2.5[fast=true]`. `resolveModel` still accepts caller-supplied
  `auto`, but it is not the default.
- **`explore`/`read_slice`/`run_filtered`/`web_lookup` run on codex at
  `EXPLORE_MODEL=gpt-5.6-luna`.** An explicit `model` still wins. `explore` and `read_slice` pass a
  mode for `-s read-only`; `web_lookup` also sets `RunOpts.web`, which adds
  `-c tools.web_search=true` for real web search; `run_filtered` deliberately omits mode and uses
  bypass so it can run the requested command. `explore` takes `breadth` (`medium`|`thorough`) and
  LOCATES, never reviews.
- **`plan` and `build` are a two-phase boundary.** `plan(task, level=4)` uses a strong planner and
  returns an implementation plan without editing; default Codex Sol is hard read-only, while level
  5 Claude relies on the prompt for read-only behavior. `build(plan, level=1, agent?)` implements
  the approved plan with full access, defaulting to the cheap Luna executor. Keep `planPrompt` and
  `buildPrompt` aligned with that contract.
- **Agent personas are additive and cross-engine.** `delegate` and `build` accept a named or inline
  agent. Resolve it on the host in `agents.ts`, then pass its body via `RunOpts.agentPrompt`: Claude
  `--append-system-prompt`, Grok `--rules`, Codex `-c developer_instructions=` encoded by
  `tomlString`, Cursor prompt prefix. Do not mount agent directories into the sandbox.
- **`read_slice` must return source lines, not just `file:line` prefixes** — this is an explicit
  instruction in `readSlicePrompt` and was a real regression (commit c41c2af). Preserve it.
- **`generate_image` is codex-only.** It is the sole tool with no cursor fallback: the built-in
  `image_gen`/`gpt-image-2` (keyless, via the ChatGPT/Codex subscription) exists only in codex, so the
  handler hard-fails when `hasEngine("codex")` is false. It forces `codex exec` at `IMAGE_MODEL` (env
  `CURSOR_BRIDGE_IMAGE_MODEL`, default `gpt-5.6-sol`) with `effort:"low"` — the built-in tool does the
  pixels, the driver model just fires it. `RunOpts.images` (input files for editing) become `-i <file>`
  in `buildCodexArgs`, **followed by a `--` terminator**: `-i/--image` is variadic (`<FILE>...`), so
  without `--` the clap parser swallows the positional prompt as another image file and codex falls back
  to the (closed) stdin → "No prompt provided via stdin". `generateImagePrompt` pins gpt-image-2
  best-effort (the tool has no model selector) and enforces generate-then-move into the cwd; the tool
  returns only the saved path, never the bytes (context economy). `out_path` must live inside `cwd`.
- **`parseCliJson` degrades gracefully**: non-JSON stdout falls back to raw text; `usage.ts`
  skips malformed JSONL lines. Match this best-effort posture — logging/parsing must never throw
  up into a tool call.
- **Core tools are `alwaysLoad`.** The five core tools (`delegate`, `explore`, `read_slice`,
  `run_filtered`, `web_lookup`) register with `_meta: { "anthropic/alwaysLoad": true }` so Claude
  Code (≥2.1.121) eagerly loads their schemas instead of deferring them. Deferred tools lose to
  always-loaded native Read/Grep — that was the root adoption bug. Secondary tools
  (`generate_image`, `plan`, `build`, `follow_up`, `bridge_stats`) stay deferred. Do not strip
  `alwaysLoad` from the core five or add it to the secondary set without intent.
- **Timeout is a safety net, not a work budget.** `DEFAULT_TIMEOUT_MS` is 30 min (`1_800_000`),
  overridable via `CURSOR_BRIDGE_TIMEOUT_MS`. Pure helper `budgetNote(timeoutMs)` appends a
  `[Time budget: ~N min ... return partial results ...]` note to the prompt of the three
  **execution** tools (`delegate`, `plan`, `build`) so the worker self-manages instead of being
  killed blind. Read tools (`explore`, `read_slice`, `run_filtered`, `web_lookup`) do not get it.
  Keep that split.

## The hook (`hooks/prefer-cursor-bridge.mjs`)

Ships separately from the server: a hook the host wires (in its `settings.json`) as a `PreToolUse`
matcher for `Read|Grep|Glob|WebSearch|WebFetch|Bash|Edit|Write` (main-loop nudges), plus a
`SessionStart` entry and a `SubagentStart` entry — each pointing at
`hooks/prefer-cursor-bridge.mjs`. It steers the agent toward the bridge. Env
`CURSOR_BRIDGE_HOOK_MODE` = `off` | `nudge` | `redirect` (default **`redirect`**): `off` does
nothing; `nudge` is the old non-blocking `additionalContext` behavior; `redirect` returns
`permissionDecision: "deny"` (via `denyRedirect()`) for the two safe-to-block cases. On `Bash` it
only fires for artifact-writing commands (`git commit`/`push`, `git worktree add`, `gh pr create`,
`bkt pr create`) — nudging that grunt-work to `delegate`; read-only Bash is left alone (rtk already
trims it). Design constraints, all tested in `test/hook.test.ts`:

- Pure decision in `decide(input, deps)` with injectable fs — that's what the tests exercise.
  `decide()` returns `{ keys, text, redirect }`. The I/O wrapper (`main`) only runs when invoked as
  a script.
- **Redirect mode (default):** for WebSearch/WebFetch → `web_lookup` and whole-file large Read
  (no offset/limit, ≥ `CURSOR_BRIDGE_HOOK_MIN_LINES`) → `read_slice`, the hook **denies** the native
  call once and names the bridge tool in the reason. It is **one-shot + fail-open**: per-session
  dedup keys are saved **before** emitting, so the second identical call is allowed through; the
  deny reason (`FAILOPEN_SUFFIX`) explicitly tells the model it may retry — critical under headless
  `-p` so it never hard-stalls. It **never** redirects Grep/Glob/Bash/Edit/Write (those stay
  nudge-only; blocking edits or git would break the host).
- **Dedup per session** (keyed by `session_id` in an `os.tmpdir()` file, mode `0600`): every
  nudge/redirect fires at most once. A repeated fire is worse than none. This is why `Grep`/`Glob`
  can sit in the matcher — they collapse to a single preload reminder.
- The first qualifying nudge of a session also carries the one-time preload reminder.
- **`SessionStart` closes the Bash-grep hole:** the PreToolUse preload only fires on the `Grep`/`Read`
  tool, but agents often use `Bash grep` (matches no matcher), so the preload never arrived.
  `sessionStartContext()` injects it as `additionalContext` before the first tool decision and
  pre-marks `preload` in the dedup file so the PreToolUse piggyback never repeats it.
- Fail-open on errors: any error → print nothing, exit 0. SubagentStart and SessionStart paths are
  unchanged by redirect mode.
- Threshold for the large-Read redirect/nudge is `CURSOR_BRIDGE_HOOK_MIN_LINES` (default 300).

**`SubagentStart` reaches spawned subagents.** Main-loop PreToolUse nudges never reach subagents, so
the hook wires a dedicated `SubagentStart` entry. When `hook_event_name === "SubagentStart"`,
`main()` emits `{ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext:
subagentStartContext(data.agent_type) } }`. Pure `subagentStartContext(agent_type)` reuses
`AGENT_PREF_BODY` and appends `EXPLORE_EXTRA` when `agent_type === "Explore"` — an extra line
telling that run (spawned on the orchestrator's expensive model) to route all reading through
`explore`/`read_slice` (which run on Codex Luna). `sessionStartContext()` carries the matching
main-loop steer: prefer calling `explore()` directly over spawning the Explore subagent. The bridge
and context-mode coexist without a race: they use separate channels (context-mode may still do its
own thing; the bridge injects via `additionalContext` only). Fail-open/non-throwing as elsewhere.

When changing hook behavior, update the pure functions (`decide`, `sessionStartContext`,
`subagentStartContext`) not the I/O wrapper (`main`), and add/adjust a case in `test/hook.test.ts`
— the test imports the `.mjs` directly and injects fakes for fs.

## Conventions

- ESM + TypeScript, Node16 module resolution. `dist/` and `node_modules/` are gitignored;
  imports use `.js` extensions (Node16 requirement) even though sources are `.ts`. Note "Node16"
  is the TS `moduleResolution`, not the runtime — `package.json` `engines` requires Node `>=18`.
- Comments are in Portuguese; code identifiers and prompt strings are in English. Match this.
- Cross-cutting env vars are read once as module-level consts in `cli.ts`/`usage.ts` — add new
  config there, don't scatter `process.env` reads.
