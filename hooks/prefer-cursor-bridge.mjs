#!/usr/bin/env node
/**
 * PreToolUse hook — nudges the agent toward cursor-mcp-bridge instead of the
 * token-expensive native tools, at the moment of the call (text alone in
 * CLAUDE.md loses to structural friction; a call-time reminder wins).
 *
 * Wire it for the matcher "Read|WebSearch|WebFetch" (see README).
 *
 * Design constraints:
 *  - Cheap: only emits a nudge when it actually pays off (large whole-file
 *    Read, or any native web call). Never fires on small/surgical reads.
 *  - Non-blocking: always allows the tool; only injects a one-line
 *    `additionalContext` so the agent can reconsider.
 *  - Never breaks the tool: any error → print nothing, exit 0.
 *
 * Env:
 *  - CURSOR_BRIDGE_HOOK_MIN_LINES: line threshold for the Read nudge (default 500).
 */
import { readFileSync, statSync } from "node:fs";

const MIN_LINES = Number(process.env.CURSOR_BRIDGE_HOOK_MIN_LINES ?? 500);
const BIG_BYTES = 2 * 1024 * 1024; // acima disto não conta linhas — já é "grande"
const SKIP_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tar|wasm|mp4|mov|woff2?)$/i;

/** Emite additionalContext no formato PreToolUse e sai. */
function nudge(text) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } }),
  );
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

let data;
try {
  data = JSON.parse(readStdin());
} catch {
  process.exit(0); // sem input parseável → não atrapalha
}

const tool = data?.tool_name;
const ti = data?.tool_input ?? {};

if (tool === "WebSearch" || tool === "WebFetch") {
  nudge(
    "cursor-bridge available: prefer web_lookup(query) over native web tools — the Cursor agent reads the pages and returns summary+links instead of dumping raw results into your context. Skip only if you need the raw HTML/DOM to parse.",
  );
}

if (tool === "Read") {
  const file = ti.file_path;
  // Já cirúrgico (offset/limit) ou sem path → nada a sugerir.
  if (!file || ti.limit != null || ti.offset != null || SKIP_EXT.test(file)) process.exit(0);
  try {
    const size = statSync(file).size;
    let lines = size > BIG_BYTES ? Infinity : readFileSync(file, "utf8").split("\n").length;
    if (lines >= MIN_LINES) {
      const shown = lines === Infinity ? "very large" : `${lines}-line`;
      nudge(
        `cursor-bridge available: ${file} is a ${shown} file. If you will NOT Edit it, use read_slice(files, want) to load only the needed lines instead of Read (which puts the whole file in context, re-billed every turn). If you will Edit it, native Read is correct.`,
      );
    }
  } catch {
    // arquivo inexistente/ilegível → deixa o Read nativo lidar com o erro.
  }
}

process.exit(0);
