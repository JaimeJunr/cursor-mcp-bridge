# Installing cursor-mcp-bridge — agent guide

> **You are an AI coding agent reading this because the user asked you to install
> cursor-mcp-bridge.** Follow the steps in order. Every command is copy-paste; the only
> value you must fill in is `<ABS_PATH>` — the absolute path of this repo (`pwd` after step 1).
> Do read-only checks first, register only in the host(s) the user actually uses, then verify.

## What this installs

An MCP **stdio** server that lets the host agent delegate to the **Cursor CLI agent**
(`agent -p`) as a cheap/fast worker — routine edits, project mapping, surgical reads, filtered
command output, web lookups — so that work never burns the host agent's context. See
[`README.md`](README.md) for the tool list and env vars.

## 0. Prerequisites — verify, don't assume

```bash
node -v                 # need >= 18
agent --version         # Cursor CLI must be installed as `agent`
agent status            # must be authenticated; if not: run `agent login`
```

If `agent` is missing, tell the user to install the Cursor CLI (`curl https://cursor.com/install -fsS | bash`)
and authenticate — **stop and report**, do not proceed.

## 1. Get the code and build

```bash
git clone https://github.com/JaimeJunr/cursor-mcp-bridge.git
cd cursor-mcp-bridge
npm install
npm run build           # tsc → dist/index.js  (this is the artifact you register)
pwd                     # ← copy this; it is <ABS_PATH> for every command below
```

If the repo is already present, skip the clone: `cd` into it, `git pull`, `npm install`, `npm run build`.

The registered command is always: `node <ABS_PATH>/dist/index.js`.

## 2. Detect the host, then register

Detect which host(s) the user runs (check all — a user may use several):

| Host | Detection hint |
|------|----------------|
| Claude Code | `claude` CLI on `PATH`, or `~/.claude.json` exists |
| Cursor | `~/.cursor/` directory exists |
| OpenAI Codex CLI | `codex` CLI on `PATH`, or `~/.codex/` exists |
| Grok CLI (xAI) | `grok` CLI on `PATH`, or `~/.grok/` exists |
| Windsurf / Cline / VS Code / Gemini CLI / other | uses a generic `mcpServers` JSON block |

Ask the user which to install for if it is ambiguous. Register only where they work.

### Claude Code

```bash
claude mcp add cursor-bridge -s user -- node <ABS_PATH>/dist/index.js
```

`-s user` installs it globally for the user. Use `-s project` to scope it to the current repo
(writes `.mcp.json`). Manual alternative — add to `~/.claude.json` or project `.mcp.json`:

```json
{ "mcpServers": { "cursor-bridge": { "command": "node", "args": ["<ABS_PATH>/dist/index.js"] } } }
```

### Cursor

Global: `~/.cursor/mcp.json`. Project-scoped: `.cursor/mcp.json` at the repo root. Same shape:

```json
{ "mcpServers": { "cursor-bridge": { "command": "node", "args": ["<ABS_PATH>/dist/index.js"] } } }
```

### OpenAI Codex CLI

```bash
codex mcp add cursor-bridge -- node <ABS_PATH>/dist/index.js
```

Manual alternative — add to `~/.codex/config.toml` (TOML, not JSON):

```toml
[mcp_servers.cursor-bridge]
command = "node"
args = ["<ABS_PATH>/dist/index.js"]
```

### Grok CLI (xAI)

```bash
grok mcp add cursor-bridge -- node <ABS_PATH>/dist/index.js
```

Manual alternative — add to `~/.grok/config.toml`:

```toml
[mcp_servers.cursor-bridge]
command = "node"
args = ["<ABS_PATH>/dist/index.js"]
```

Grok also reads Cursor/Claude JSON (`.cursor/mcp.json`, project `.mcp.json`, `~/.claude.json`),
so a Cursor/Claude registration is picked up too.

### Generic host (Windsurf, Cline, VS Code MCP, Gemini CLI, …)

Almost every other host takes the same stdio JSON. Find its MCP config file (usually
`mcp.json` or a `mcpServers` block in the host's `settings.json`) and add:

```json
{ "mcpServers": { "cursor-bridge": { "command": "node", "args": ["<ABS_PATH>/dist/index.js"] } } }
```

To pass configuration (see [`README.md`](README.md) env table), add an `"env"` object, e.g.
`"env": { "CURSOR_BRIDGE_FORCE": "1" }`.

## 3. Verify the registration

```bash
claude mcp list                 # Claude Code — expect: cursor-bridge … ✔ Connected
codex mcp list                  # Codex
grok mcp list                   # Grok
```

For Cursor and GUI hosts: reload/restart the host and confirm `cursor-bridge` shows its tools
(`delegate`, `explore`, `read_slice`, `run_filtered`, `web_lookup`, `follow_up`, `bridge_stats`).
Report the connection status back to the user.

## 4. (Recommended, Claude Code) Make the agent actually use it

Registration alone is not enough — the bridge tools are **deferred** and lose to native
`Read`/`Grep`/`WebSearch` by default. Wire the shipped hook (`hooks/prefer-cursor-bridge.mjs`)
into `settings.json` for `PreToolUse`, `SessionStart`, and `Agent|Task`. The exact JSON blocks
and the reasoning are in [`README.md` → "Make the agent actually use it"](README.md#make-the-agent-actually-use-it).
Do this step only for Claude Code; other hosts do not run these hooks.

## Done — report to the user

State: which host(s) you registered, the verification result (Connected / tools visible), and
whether the Cursor CLI was authenticated. If any prerequisite failed, report that instead of
claiming success.
