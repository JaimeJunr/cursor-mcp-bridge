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
| `explore` | Read-only exploration. No `files` → general project map; with `files` → answer about those files. The cheap counterpart to Claude's Explore. |
| `follow_up` | Continue a prior session by `session_id`. |

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

> **Security:** `delegate` can edit files and (with `CURSOR_BRIDGE_FORCE`) run shell autonomously.
> `discovery` and `analyze_files` run in read-only modes (`plan` / `ask`).

## Develop

```bash
npm test       # vitest — unit tests for model resolution / arg building
npm run dev    # run from source via tsx
```

## License

MIT
