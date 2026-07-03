#!/usr/bin/env node
/**
 * PreToolUse hook — nudges the agent toward cursor-mcp-bridge instead of the
 * token-expensive native tools, at the moment of the call (text alone in
 * CLAUDE.md loses to structural friction; a call-time reminder wins).
 *
 * Wire it for the matcher "Read|Grep|Glob|WebSearch|WebFetch" (see README).
 *
 * Design constraints:
 *  - Cheap: only emits a nudge when it actually pays off (large whole-file
 *    Read, native web call, or the first exploration tool of a session).
 *    Never fires on small/surgical reads.
 *  - De-duplicated per session: each nudge fires at most once per session
 *    (keyed by session_id in a tmp file). A repeated nudge is worse than none —
 *    the agent learns to ignore it AND every fire costs tokens. This is what
 *    lets Grep/Glob into the matcher without the constant-noise cost.
 *  - Preload once: the first qualifying nudge of a session also carries the
 *    one-time reminder to run ToolSearch, because these MCP tools are deferred
 *    and lose to the always-loaded native Read/Grep until their schemas load.
 *  - Non-blocking: always allows the tool; only injects `additionalContext`.
 *  - Never breaks the tool: any error → print nothing, exit 0.
 *
 * Env:
 *  - CURSOR_BRIDGE_HOOK_MIN_LINES: line threshold for the Read nudge (default 300).
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PARSED_MIN_LINES = Number(process.env.CURSOR_BRIDGE_HOOK_MIN_LINES);
const MIN_LINES = Number.isFinite(PARSED_MIN_LINES) && PARSED_MIN_LINES > 0 ? PARSED_MIN_LINES : 300;
const BIG_BYTES = 2 * 1024 * 1024; // acima disto não conta linhas — já é "grande"
const SKIP_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tar|wasm|mp4|mov|woff2?)$/i;

const PRELOAD_TEXT =
  "cursor-bridge tools are DEFERRED — run ToolSearch(\"select:mcp__cursor-bridge__read_slice," +
  "mcp__cursor-bridge__explore,mcp__cursor-bridge__run_filtered,mcp__cursor-bridge__web_lookup\") " +
  "ONCE this session so their schemas load; otherwise the always-loaded native Read/Grep/Glob win by " +
  "default. For pure reading/locating (no edit ahead), prefer explore/read_slice over Grep/Read.";

const WEB_TEXT =
  "cursor-bridge available: prefer web_lookup(query) over native web tools — the Cursor agent reads the " +
  "pages and returns summary+links instead of dumping raw results into your context. Skip only if you " +
  "need the raw HTML/DOM to parse.";

/**
 * Pure decision: given the tool call and the set of nudges already fired this
 * session, return the nudge to emit ({ keys, text }) or null. fs deps are
 * injectable for testing.
 * @example decide({ tool_name: "WebSearch", tool_input: {}, seen: new Set() })
 */
export function decide(input, deps = {}) {
  const stat = deps.statSync ?? statSync;
  const read = deps.readFileSync ?? readFileSync;
  const minLines = deps.minLines ?? MIN_LINES;
  const seen = input?.seen instanceof Set ? input.seen : new Set();
  const base = baseDecision(input, { stat, read, minLines }, seen);
  if (!base) return null;
  // O primeiro nudge da sessão carrega junto o lembrete único de preload.
  if (base.key !== "preload" && !seen.has("preload")) {
    return { keys: [base.key, "preload"], text: `${base.text}\n\n${PRELOAD_TEXT}` };
  }
  return { keys: [base.key], text: base.text };
}

/** Decisão base por tipo de tool, já respeitando o dedup (`seen`). */
function baseDecision(input, { stat, read, minLines }, seen) {
  const tool = input?.tool_name;
  const ti = input?.tool_input ?? {};

  if (tool === "WebSearch" || tool === "WebFetch") {
    return seen.has("web") ? null : { key: "web", text: WEB_TEXT };
  }

  // Grep/Glob disparam muito — por isso só o lembrete de preload, 1× por sessão.
  if (tool === "Grep" || tool === "Glob") {
    return seen.has("preload") ? null : { key: "preload", text: PRELOAD_TEXT };
  }

  if (tool === "Read") {
    const file = ti.file_path;
    // Já cirúrgico (offset/limit), sem path, ou binário → nada a sugerir.
    if (!file || ti.limit != null || ti.offset != null || SKIP_EXT.test(file)) return null;
    let lines;
    try {
      const size = stat(file).size;
      lines = size > BIG_BYTES ? Infinity : read(file, "utf8").split("\n").length;
    } catch {
      return null; // arquivo inexistente/ilegível → deixa o Read nativo errar.
    }
    if (lines < minLines) return null;
    const key = `read:${file}`;
    if (seen.has(key)) return null;
    const shown = lines === Infinity ? "very large" : `${lines}-line`;
    return {
      key,
      text:
        `cursor-bridge available: ${file} is a ${shown} file. If you will NOT Edit it, use ` +
        `read_slice(files, want) to load only the needed lines instead of Read (which puts the whole ` +
        `file in context, re-billed every turn). If you will Edit it, native Read is correct.`,
    };
  }

  return null;
}

// ---- I/O wrapper (só roda quando invocado como hook, não no import de teste) ----

function seenPath(sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(tmpdir(), `cursor-bridge-nudged-${safe}.json`);
}

function loadSeen(p) {
  try {
    return new Set(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return new Set();
  }
}

function saveSeen(p, set) {
  try {
    // mode 0600: estado por sessão em tmp compartilhado não deve ser legível/gravável
    // por outros usuários (evita que influenciem o dedup). Best-effort.
    writeFileSync(p, JSON.stringify([...set]), { mode: 0o600 });
  } catch {
    // best-effort: falha ao persistir só significa que o nudge pode repetir.
  }
}

function nudge(text) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } }),
  );
}

function main() {
  let data;
  try {
    data = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // sem input parseável → não atrapalha
  }
  const sessionId = typeof data?.session_id === "string" && data.session_id ? data.session_id : "default";
  const path = seenPath(sessionId);
  const seen = loadSeen(path);
  const res = decide({ tool_name: data?.tool_name, tool_input: data?.tool_input, seen });
  if (!res) process.exit(0);
  for (const k of res.keys) seen.add(k);
  saveSeen(path, seen);
  nudge(res.text);
  process.exit(0);
}

const isMain = () => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
};

if (isMain()) main();
