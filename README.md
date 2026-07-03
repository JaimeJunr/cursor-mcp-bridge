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
| `delegate` | Run a task on the Cursor agent with full tool access in `cwd`. |
| `explore` | Read-only exploration. No `files` → general project map; with `files` → answer about those files (quotes relevant code inline with `file:line`). The cheap counterpart to Claude's Explore. |
| `read_slice` | Surgical read-only read: returns ONLY the code relevant to `want` (exact lines with `file:line`) from the given `files` — the full file never enters your context. Use instead of reading large files whole. |
| `run_filtered` | Run a shell `command` and get back ONLY the lines relevant to `want` — semantic filtering of huge build/test/log output. |
| `web_lookup` | Web/docs lookup via the Cursor agent's web access. |
| `follow_up` | Continue a prior session by `session_id`. |
| `bridge_stats` | Report calls and chars returned to context per tool (needs `CURSOR_BRIDGE_LOG`). |

Every tool accepts: `cwd`, `model` (default `auto`), `effort` (applied only to parameterized
models; `auto` ignores it).

## Requirements

- Node ≥ 18
- Cursor CLI installed as `agent` and authenticated (`agent login`).

## Install

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
| `CURSOR_BRIDGE_FORCE` | _(off)_ | If `1`/`true`, pass `--force` so commands run without prompts. |
| `CURSOR_BRIDGE_TIMEOUT_MS` | `600000` | Per-call timeout. |
| `CURSOR_BRIDGE_LOG` | _(off)_ | Path to a JSONL file; when set, every call logs `{tool, outChars}` for `bridge_stats`. |
| `CURSOR_BRIDGE_HOOK_MIN_LINES` | `500` | Line threshold above which the optional hook (below) nudges toward `read_slice`. |

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
runs on `node` (already required), and only fires where it pays — a whole-file `Read`
over `CURSOR_BRIDGE_HOOK_MIN_LINES` lines, or any native `WebSearch`/`WebFetch`. Wire it
into your host's settings (Claude Code `settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|WebSearch|WebFetch",
        "hooks": [
          { "type": "command", "command": "node /abs/path/to/cursor-mcp-bridge/hooks/prefer-cursor-bridge.mjs", "timeout": 5 }
        ]
      }
    ]
  }
}
```

> Grep/Glob are left out on purpose: they fire constantly, so nudging them costs more
> tokens than it saves. Add them to the `matcher` only if you want the extra pressure.

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

## Develop

```bash
npm test       # vitest — unit tests for model resolution / arg building
npm run dev    # run from source via tsx
```

## License

MIT
