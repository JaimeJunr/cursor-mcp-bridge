# cursor-mcp-bridge

MCP server that lets **any** agent or MCP host delegate to headless **Codex, Grok, and Claude Code
CLIs**, with Cursor available as an opt-in fallback. Use the fleet for implementation, planning,
and project exploration without burning the caller's context on raw worker output.

Worker tools take optional **model** and **effort** overrides, return a `session_id`, and support
`follow_up`. Difficulty levels select a distinct default model across the three active
subscriptions.

## Tools

The server exposes ten tools:

| Tool | Purpose |
|------|---------|
| `delegate` | Run a task with full **read/edit/shell** access in `cwd`. Required `level`: 1=GPT-5.6 Luna (codex), 2=Grok 4.5 medium (grok), 3=GPT-5.6 Terra medium (codex), 4=GPT-5.6 Sol medium (codex), 5=Opus (claude). Optionally accepts an `agent` persona by name or inline `{prompt}`. |
| `explore` | Read-only exploration on Codex with `gpt-5.6-luna`. `question` alone → broad fan-out search returning `file:line` refs; `question`+`files` → answer about those files; neither → general project map. `breadth: "thorough"` sweeps wider. Locates, does not review. |
| `read_slice` | Surgical read-only read: returns ONLY the code relevant to `want` (exact lines with `file:line`) from the given `files` — the full file never enters your context. Use instead of reading large files whole. |
| `run_filtered` | Run a shell `command` through Codex/Luna with full access and get back ONLY the lines relevant to `want` — semantic filtering of huge build/test/log output. |
| `web_lookup` | Web/docs lookup through Codex/Luna with real web search enabled and a read-only filesystem. |
| `generate_image` | Generate or edit an image through Codex's built-in image tool and save it inside `cwd`. |
| `plan` | Phase 1: read the codebase and return an implementation plan without editing. Defaults to level 4 (Codex Sol, hard read-only); level 5 Claude is read-only by prompt only. |
| `build` | Phase 2: implement an approved plan with full access. Defaults to level 1 (Codex Luna) and optionally accepts an `agent` persona. |
| `follow_up` | Continue a prior session by `session_id`. |
| `bridge_stats` | Report calls and chars returned to context per tool (needs `CURSOR_BRIDGE_LOG`). |

Worker tools accept `cwd`, `model`, and `effort` where applicable. `delegate` requires a **level**
(1-5); `plan` and `build` default to levels 4 and 1 respectively. Explicit `model`/`effort`
values override the selected tier.

## Requirements

- Node ≥ 18
- Codex installed and authenticated for read tools and levels 1/3/4; Grok for level 2; Claude Code
  for level 5.
- Optional Cursor fallback: install `cursor-agent` and set `CURSOR_BRIDGE_ENABLE_CURSOR=1`.

## Install

> **Installing via an AI agent?** Point it at [`INSTALL.md`](INSTALL.md) — an agent-facing,
> copy-paste guide that detects the host and registers the bridge in Claude Code, Cursor,
> Codex, Grok, or any generic MCP host.

```bash
git clone https://github.com/JaimeJunr/cursor-mcp-bridge.git
cd cursor-mcp-bridge
npm install
npm run build
```

## Register in an MCP host

**Claude Code:**
```bash
claude mcp add cursor-bridge -s user -- node /abs/path/to/cursor-mcp-bridge/dist/index.js
```

**Any host** — add to its `mcp.json`:
```json
{
  "mcpServers": {
    "cursor-bridge": {
      "command": "node",
      "args": ["/abs/path/to/cursor-mcp-bridge/dist/index.js"]
    }
  }
}
```

## Configuration (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `CURSOR_BIN` | `cursor-agent` | Path to the optional Cursor CLI fallback. |
| `CURSOR_BRIDGE_GROK_BIN` | `grok` | Path to the Grok CLI. |
| `CURSOR_BRIDGE_CODEX_BIN` | `codex` | Path to the Codex CLI. |
| `CURSOR_BRIDGE_CLAUDE_BIN` | `claude` | Path to the Claude Code CLI. |
| `CURSOR_BRIDGE_ENABLE_CURSOR` | _(off)_ | Set to `1`/`true` to allow Cursor fallback when a tier's preferred CLI is missing. Otherwise the call fails with the missing CLI named. |
| `CURSOR_BRIDGE_MODEL` | `composer-2.5-fast` | Default model for the optional Cursor path. |
| `CURSOR_BRIDGE_EXPLORE_MODEL` | `gpt-5.6-luna` | Codex model for `explore`, `read_slice`, `run_filtered`, and `web_lookup` when the call omits `model`. |
| `CURSOR_BRIDGE_AGENT_PATHS` | _(off)_ | Additional `:`-separated roots for named agent personas, searched before project/home `.claude/agents` and `~/.claude/plugins`. |
| `CURSOR_BRIDGE_SANDBOX` | `bwrap` | Isolates every engine in a bubblewrap sandbox with an empty `$HOME`, preventing global config, MCP servers, hooks, and skills from loading. Only auth, required engine state, and toolchains are bound in. Set `off`/`0` to disable; falls back to unsandboxed if `bwrap` is missing. |
| `CURSOR_BRIDGE_FORCE` | _(off)_ | If `1`/`true`, force-enable non-interactive approval for Cursor and Claude runs. |
| `CURSOR_BRIDGE_TIMEOUT_MS` | `1800000` (30 min) | Per-call safety-net timeout (not a work budget). Execution tools (`delegate`/`plan`/`build`) also get a prompt note so the worker returns partial results before being killed. |
| `CURSOR_BRIDGE_LOG` | _(off)_ | Path to a JSONL file; when set, every call logs `{tool, outChars}` for `bridge_stats`. |
| `CURSOR_BRIDGE_HOOK_MODE` | `redirect` | Hook behavior: `off` (no-op), `nudge` (non-blocking `additionalContext` only), or `redirect` (deny once + name bridge tool for WebSearch/WebFetch and whole-file large Read; fail-open on retry). Grep/Glob/Bash/Edit/Write stay nudge-only. |
| `CURSOR_BRIDGE_HOOK_MIN_LINES` | `300` | Line threshold above which the optional hook (below) redirects/nudges whole-file Read toward `read_slice`. |
| `CURSOR_BRIDGE_AGENT_DELAY_MS` | `350` | Delay before the `Agent\|Task` injection emits, to win the last-wins race vs context-mode. `0` disables. |
| `CONTEXT_MODE_ROUTING` | _(marketplace path)_ | Override path to context-mode's `routing.mjs` (imported to preserve its block in subagents). |

> **Security:** `delegate`, `build`, and `run_filtered` have full access and auto-approve their
> work. `explore`, `read_slice`, and `web_lookup` use Codex's read-only sandbox. `plan` is hard
> read-only on Codex; level 5 Claude enforces read-only through its prompt. Named agents are resolved
> on the host, reject path traversal, and are injected without mounting agent directories.

## Make the agent actually use it

Registering the tools is not enough. Two structural forces push the agent back to
native tools: (1) the host rule "prefer the dedicated file/search tools", and (2) MCP
tools used to be **deferred** — the agent had to run a tool-search to load their schemas,
so always-loaded `Read`/`Grep`/`WebSearch` won by default. The server now publishes
**startup `instructions`** (routing boundary) and marks the five core tools with
`_meta: { "anthropic/alwaysLoad": true }` (Claude Code ≥2.1.121) so their schemas load
eagerly; secondary tools stay deferred. Four fixes, strongest first:

**1. Call-time hook (recommended).** A `PreToolUse` hook that steers the agent toward
the bridge at the moment it reaches for a native tool — text in a config file loses under
pressure, a call-time reminder does not. This repo ships one at
[`hooks/prefer-cursor-bridge.mjs`](hooks/prefer-cursor-bridge.mjs): it runs on `node`
(already required) and only fires where it pays. Default mode is **`redirect`**
(`CURSOR_BRIDGE_HOOK_MODE=redirect`): for the two safe-to-block cases it returns
`permissionDecision: "deny"` once and names the bridge tool; other cases stay non-blocking
nudges. Wire it into your host's settings (Claude Code `settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Grep|Glob|WebSearch|WebFetch|Bash|Edit|Write|MultiEdit",
        "hooks": [
          { "type": "command", "command": "node /abs/path/to/cursor-mcp-bridge/hooks/prefer-cursor-bridge.mjs", "timeout": 5 }
        ]
      }
    ]
  }
}
```

What it emits, and when — each fires **at most once per session** (deduplicated in a tmp
file keyed by `session_id`), because a repeated fire is worse than none: the agent learns
to ignore it *and* every fire costs tokens. Dedup keys are saved **before** emitting so
redirect is one-shot and fail-open (a second identical call is allowed through).

> - **`Read`** whole-file (no offset/limit) over `CURSOR_BRIDGE_HOOK_MIN_LINES` lines →
>   **redirect** (default) or nudge toward `read_slice` (once per file). Partial reads are left alone.
> - **`WebSearch`/`WebFetch`** → **redirect** (default) or nudge toward `web_lookup` (once).
> - **`Grep`/`Glob`** → emits the one-time **preload** reminder to run the `ToolSearch` for any
>   still-deferred bridge tools (nudge only — never redirected). The dedup collapses them to a
>   single fire.
> - **`Bash`** whose command writes an artifact (`git commit`/`push`, `git worktree add`,
>   `gh pr create`, `gh issue create`, `bkt pr create`) → suggests offloading that grunt-work to
>   `delegate` (once, nudge only). Read-only Bash (status/diff/log/checkout) is left alone — the
>   orchestrator needs that state, and a mechanical filter (e.g. rtk) already trims the noise.
> - **`Edit`/`Write`/`MultiEdit`** → once per session, reminds that a *self-contained* task
>   (feature, bugfix, mechanical multi-file change, build fix) can go **whole** to `delegate(prompt, level)`
>   — the selected worker edits with full access — instead of the orchestrator implementing
>   it on expensive tokens. It never blocks the edit (nudge only); the once-per-session dedup means
>   the orchestrator still edits inline freely (the nudge repositions execution, it doesn't police every edit).
> - The **first** qualifying fire of the session (whichever tool triggers it) also carries
>   that preload reminder, so secondary schemas get loaded even in a Read-only or web-only session.
> - Redirect deny reasons end with a fail-open suffix: if the bridge tool isn't loaded yet, run
>   ToolSearch first; if the native tool is genuinely needed, call it again and it will be allowed
>   (critical under headless `-p` so the agent never hard-stalls).

Set `CURSOR_BRIDGE_HOOK_MODE=nudge` for the old non-blocking behavior, or `off` to disable.
To reset the dedup and see the fires again, start a new session (or delete
`cursor-bridge-nudged-<session_id>.json` from your OS temp dir — `os.tmpdir()`,
e.g. `/tmp` on Linux, not necessarily `$TMPDIR`).

### Preloading at session start (`SessionStart`)

The PreToolUse preload above only fires when the agent uses the **`Grep`/`Read`** tool. But
under pressure agents often reach for **`Bash grep`** instead, which matches no PreToolUse
matcher — so the preload reminder never arrives. Wire the same hook for `SessionStart` to
close that hole: the preload reminder then lands in context **before the first tool decision**,
regardless of how the agent searches.

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node /abs/path/to/cursor-mcp-bridge/hooks/prefer-cursor-bridge.mjs", "timeout": 5 }] }
    ]
  }
}
```

On `SessionStart` the hook emits the `ToolSearch` preload as `additionalContext` and pre-marks
`preload` as seen in the session's dedup file, so the PreToolUse piggyback never repeats it.

### Reaching subagents too (`Agent|Task` matcher)

The nudges above only steer the **main loop**. Spawned subagents never see them —
and if you also run the [context-mode](https://github.com/) plugin, its own
`Agent|Task` hook appends a strong "route everything through context-mode" block
to each subagent prompt that never mentions the bridge, so subagents are born
blind to it. Wire this hook for `Agent|Task` as well to fix that:

```json
{ "matcher": "Agent|Task",
  "hooks": [{ "type": "command", "command": "node /abs/path/to/cursor-mcp-bridge/hooks/prefer-cursor-bridge.mjs", "timeout": 10 }] }
```

On an `Agent`/`Task` call the hook appends a compact cursor-bridge preference
(plus the `ToolSearch` preload line) to the subagent's prompt via `updatedInput`.
When `subagent_type` is `Explore` it appends an extra line: that Explore run was spawned on the
orchestrator's expensive model (Explore inherits the session model, capped at Opus), so it should
route **all** reading through `explore`/`read_slice` (which run on Codex Luna) and
keep the expensive shell to orchestration only.

> **Coexisting with context-mode.** Multiple PreToolUse hooks returning
> `updatedInput` for one tool do **not** merge — it's last-to-finish-wins,
> non-deterministic. To never clobber context-mode's block, this hook **imports
> context-mode's live routing**, takes the prompt it would produce (already
> carrying its block), and appends the bridge preference to it. So whoever wins
> the race, context-mode's block survives; the bridge preference lands whenever
> **this** hook wins — which `CURSOR_BRIDGE_AGENT_DELAY_MS` (default `350`ms)
> biases toward by finishing after context-mode's heavier hook. If context-mode's
> routing can't be imported the hook injects **nothing** (preserving context-mode
> is the invariant). Set `CONTEXT_MODE_ROUTING` to point at a non-default path,
> or `CURSOR_BRIDGE_AGENT_DELAY_MS=0` to disable the delay.

**2. Preload any still-deferred tools.** The five core tools are already `alwaysLoad` on
Claude Code ≥2.1.121. For secondary tools (or older hosts), tell the agent to load schemas
once per session. Add to your `CLAUDE.md`/`AGENTS.md`:

```
At the start of any session involving code reading/exploration, run tool-search once for
`read_slice, explore, run_filtered, web_lookup` (and any secondary bridge tools you need) so
their schemas are loaded if the host still defers them.
```

**3. Reconcile the conflict in `CLAUDE.md`.** State the precedence explicitly:

```
The host rule "prefer dedicated file/search tools" applies to the EDIT path (Edit needs the
file content → native Read). For PURE reading/locating/web (no edit), cursor-bridge takes
precedence over native Read/Grep/Glob/WebSearch/WebFetch. Read a large file whole with native
Read ONLY when you are about to edit it.
```

**4. Delegate execution, not just exploration.** The bridge is not only for reading — `delegate`
runs implementation work with full read/edit/shell access, so the orchestrator shouldn't burn its
own tokens on self-contained tasks. State this in `CLAUDE.md` so the agent routes *doing*, not just
*finding*, to the cheap worker:

```
You are the ORCHESTRATOR. delegate(prompt, level) is the DEFAULT for BOTH execution AND judgment.
`level` picks a distinct tier: 1=GPT-5.6 Luna (codex), 2=Grok 4.5 medium, 3=GPT-5.6 Terra medium
(codex), 4=GPT-5.6 Sol medium (codex), 5=Opus (claude). The worker has full read/edit/shell access
in cwd when you delegate. The constant win is context economy: the worker's raw output never enters
your context. Delegate it, then review the result; edit inline only for a quick one-off you're
already positioned for. Use plan(task) then build(plan) when you want a strong read-only planning
phase followed by a cheaper executor. Pass agent:"name" or agent:{prompt:"..."} when the worker
needs a specialized persona.
```

## Develop

```bash
npm test       # vitest — unit tests for model resolution / arg building
npm run dev    # run from source via tsx
```

## License

MIT
