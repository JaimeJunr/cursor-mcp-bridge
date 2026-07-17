# cursor-mcp-bridge

MCP server that lets **any** agent or MCP host delegate to the **Cursor CLI agent** (`agent -p`)
running headless. Cursor is the **cheap/fast** worker in the fleet — use it for routine work and
to map unfamiliar projects without burning your own context.

Mirrors the ergonomics of `agy-bridge`: every tool takes an optional **model** and **effort**,
returns a `session_id`, and supports `follow_up`. Default model is **`auto`** (Cursor picks the
cheapest adequate model).

## Tools

| Tool | Purpose |
|------|---------|
| `delegate` | Run a task on the Cursor agent with full **read/edit/shell** access in `cwd` — the fleet's *worker*, for both execution and judgment. Takes a required `level` (1-5) that escalates difficulty→engine: `1`=`composer` (cursor, cheap; the default tier), `2`/`3`=Grok 4.5 medium/high, `4`/`5`=GPT-5.6 Sol medium/high (codex, top-quality — capable enough to *judge*: code review, impact analysis, hard debugging). Note the cost order is roughly `composer < Opus < Sol high`, so `level 4-5` is premium: reach for it for **quality**, not to save tokens. Hand it self-contained implementation, grunt-work, **or high-stakes judgment** — the constant win is context economy (the worker's raw output never enters your context); you review the result. |
| `explore` | Read-only exploration, the cheap Explore (runs on Cursor's `composer` model). `question` alone → broad fan-out search returning `file:line` refs; `question`+`files` → answer about those files; neither → general project map. `breadth: "thorough"` sweeps wider. Locates, does not review. Prefer it over spawning the Explore subagent. |
| `read_slice` | Surgical read-only read: returns ONLY the code relevant to `want` (exact lines with `file:line`) from the given `files` — the full file never enters your context. Use instead of reading large files whole. |
| `run_filtered` | Run a shell `command` and get back ONLY the lines relevant to `want` — semantic filtering of huge build/test/log output. |
| `web_lookup` | Web/docs lookup via the Cursor agent's web access. |
| `follow_up` | Continue a prior session by `session_id`. |
| `bridge_stats` | Report calls and chars returned to context per tool (needs `CURSOR_BRIDGE_LOG`). |

Every tool accepts: `cwd`, `model` (default `auto`), `effort` (applied only to parameterized
models; `auto` ignores it). `delegate` additionally takes a **required `level`** (1-5) that
picks the engine/model tier (see the table above); the explicit `model`/`effort` still override it.

## Requirements

- Node ≥ 18
- Cursor CLI installed as `agent` and authenticated (`agent login`).

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
| `CURSOR_BIN` | `agent` | Path to the Cursor CLI binary. |
| `CURSOR_BRIDGE_MODEL` | `auto` | Default model when a call omits `model`. |
| `CURSOR_BRIDGE_EXPLORE_MODEL` | `auto` | Model for `explore` when the call omits `model` — `auto` lets Cursor pick its cheap/fast model (in practice composer), so exploration never escalates to the orchestrator's expensive model. |
| `CURSOR_BRIDGE_SANDBOX` | `bwrap` | Isolates the Cursor CLI in a bubblewrap sandbox with an empty `$HOME`, so it never loads the user's global config (`~/.cursor/rules`, `mcp.json`, `hooks.json`, skills) — cuts a trivial call from ~57k to ~11k input tokens and stops the CLI spinning up the user's MCP servers per run. Only auth + toolchains are bound in. Set `off`/`0` to disable; falls back to unsandboxed if `bwrap` is missing. |
| `CURSOR_BRIDGE_FORCE` | _(off)_ | If `1`/`true`, pass `--force` so commands run without prompts. |
| `CURSOR_BRIDGE_TIMEOUT_MS` | `600000` | Per-call timeout. |
| `CURSOR_BRIDGE_LOG` | _(off)_ | Path to a JSONL file; when set, every call logs `{tool, outChars}` for `bridge_stats`. |
| `CURSOR_BRIDGE_HOOK_MIN_LINES` | `300` | Line threshold above which the optional hook (below) nudges toward `read_slice`. |
| `CURSOR_BRIDGE_AGENT_DELAY_MS` | `350` | Delay before the `Agent\|Task` injection emits, to win the last-wins race vs context-mode. `0` disables. |
| `CONTEXT_MODE_ROUTING` | _(marketplace path)_ | Override path to context-mode's `routing.mjs` (imported to preserve its block in subagents). |

> **Security:** `delegate` and `run_filtered` can run shell autonomously (with `CURSOR_BRIDGE_FORCE`).
> `explore`, `read_slice` and `web_lookup` run in read-only modes (`plan` / `ask`).

## Make the agent actually use it

Registering the tools is not enough. Two structural forces push the agent back to
native tools: (1) the host rule "prefer the dedicated file/search tools", and (2) these
MCP tools are usually **deferred** — the agent must run a tool-search to even load their
schemas, so the always-loaded `Read`/`Grep`/`WebSearch` win by default. Three fixes,
strongest first:

**1. Call-time hook (recommended).** A `PreToolUse` hook that nudges the agent toward
the bridge at the moment it reaches for a native tool — text in a config file loses under
pressure, a call-time reminder does not. This repo ships one at
[`hooks/prefer-cursor-bridge.mjs`](hooks/prefer-cursor-bridge.mjs): it is non-blocking,
runs on `node` (already required), and only fires where it pays. Wire it into your host's
settings (Claude Code `settings.json`):

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
file keyed by `session_id`), because a repeated nudge is worse than none: the agent learns
to ignore it *and* every fire costs tokens.

> - **`Read`** over `CURSOR_BRIDGE_HOOK_MIN_LINES` lines → suggests `read_slice` (once per file).
> - **`WebSearch`/`WebFetch`** → suggests `web_lookup` (once).
> - **`Grep`/`Glob`** → emits the one-time **preload** reminder to run the `ToolSearch` for the
>   deferred bridge tools. This is why Grep/Glob can sit in the matcher without the old
>   constant-noise cost — the dedup collapses them to a single fire.
> - **`Bash`** whose command writes an artifact (`git commit`/`push`, `git worktree add`,
>   `gh pr create`, `gh issue create`, `bkt pr create`) → suggests offloading that grunt-work to
>   `delegate` (once). Read-only Bash (status/diff/log/checkout) is left alone — the orchestrator
>   needs that state, and a mechanical filter (e.g. rtk) already trims the noise.
> - **`Edit`/`Write`/`MultiEdit`** → once per session, reminds that a *self-contained* task
>   (feature, bugfix, mechanical multi-file change, build fix) can go **whole** to `delegate(prompt, level)`
>   — the Cursor worker edits with full access on a cheap model — instead of the orchestrator implementing
>   it on expensive tokens. It never blocks the edit; the once-per-session dedup means the orchestrator
>   still edits inline freely (the nudge repositions execution, it doesn't police every edit).
> - The **first** qualifying nudge of the session (whichever tool triggers it) also carries
>   that preload reminder, so the schemas get loaded even in a Read-only or web-only session.

To reset the dedup and see the nudges again, start a new session (or delete
`cursor-bridge-nudged-<session_id>.json` from your OS temp dir — `os.tmpdir()`,
e.g. `/tmp` on Linux, not necessarily `$TMPDIR`).

### Preloading at session start (`SessionStart`)

The PreToolUse preload above only fires when the agent uses the **`Grep`/`Read`** tool. But
under pressure agents often reach for **`Bash grep`** instead, which matches no PreToolUse
matcher — so the preload reminder never arrives and the deferred bridge tools stay unloaded
the whole session. Wire the same hook for `SessionStart` to close that hole: the preload
reminder then lands in context **before the first tool decision**, regardless of how the agent
searches.

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
route **all** reading through `explore`/`read_slice` (which run on the cheap `composer` model) and
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

**2. Preload the deferred tools.** Tell the agent to load the schemas once per session so
they are "in hand". Add to your `CLAUDE.md`/`AGENTS.md`:

```
At the start of any session involving code reading/exploration, run tool-search once for
`read_slice, explore, run_filtered, web_lookup` so their schemas are loaded — otherwise the
deferred tools lose to the always-loaded native Read/Grep by default.
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
`level` picks the tier: 1=cheap composer (mechanical work — features, bugfixes, multi-file edits,
commits/PRs/tickets, build fixes), 4-5=GPT-5.6 Sol, top-quality (real reasoning — code review with
a verdict, cross-file impact analysis, hard debugging). The Cursor worker has full read/edit/shell
access in cwd, so cursor is NOT read-only when you delegate. Cost order is roughly composer < Opus
< Sol high, so level 4-5 is PRICIER than doing it on your own model — reach for it for quality, not
to save tokens; the constant win of delegating is context economy (the worker's raw output never
enters your context). Delegate it, then review the result; edit inline only for a quick one-off
you're already positioned for. Only spawn a Task subagent when you need a SPECIALIZED agent with its
own toolset (e.g. Playwright/MCP-backed reviewers).
```

## Develop

```bash
npm test       # vitest — unit tests for model resolution / arg building
npm run dev    # run from source via tsx
```

## License

MIT
