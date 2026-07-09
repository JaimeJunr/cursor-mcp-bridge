#!/usr/bin/env node
/**
 * PreToolUse hook — nudges the agent toward cursor-mcp-bridge instead of the
 * token-expensive native tools, at the moment of the call (text alone in
 * CLAUDE.md loses to structural friction; a call-time reminder wins).
 *
 * Wire it for "Read|Grep|Glob|WebSearch|WebFetch" (main-loop nudges) AND for
 * "Agent|Task" (inject the preference into spawned subagent prompts). See README.
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
import { homedir, tmpdir } from "node:os";
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

// Comandos que PRODUZEM artefato barato (commit/PR/ticket/branch) — grunt-work a offloadar
// pro delegate. Read-only investigativo (status/diff/log/checkout) fica de fora: o orquestrador
// precisa entender o estado, e o rtk já filtra o ruído desses mecanicamente.
const BASH_MUTATE_RE =
  /\b(git\s+commit|git\s+push|git\s+worktree\s+add|gh\s+pr\s+create|gh\s+issue\s+create|bkt\s+pr\s+create)\b/;

const BASH_MUTATE_TEXT =
  "cursor-bridge available: writing commits/PRs/tickets/branches is cheap grunt-work — hand it to " +
  "delegate(prompt) (the Cursor worker runs git/gh/bkt with full tool access) instead of spending " +
  "expensive orchestrator tokens. You stay the orchestrator; Cursor does the mechanical work.";

/**
 * Texto injetado no SessionStart. O preload de carona no PreToolUse só dispara quando
 * o modelo usa a tool Grep/Read/etc — mas nas sessões reais ele "vai de Bash grep",
 * que não casa com nenhum matcher, então o preload nunca chegava. Injetar no início
 * da sessão fecha esse buraco: o lembrete existe ANTES da primeira decisão de tool,
 * independente de o modelo usar Bash grep ou a tool nativa.
 * @example sessionStartContext() // → "cursor-bridge MCP ... Run ToolSearch(...) ONCE ..."
 */
export function sessionStartContext() {
  return (
    "cursor-bridge MCP (cheap/fast Cursor worker) is available but its tools are DEFERRED — they are NOT " +
    "in your prompt and fail if called raw. Run " +
    'ToolSearch("select:mcp__cursor-bridge__read_slice,mcp__cursor-bridge__explore,' +
    'mcp__cursor-bridge__run_filtered,mcp__cursor-bridge__web_lookup,mcp__cursor-bridge__delegate") ' +
    "ONCE now so their schemas load; otherwise the always-loaded native Read/Grep/Bash win by default and " +
    "you burn expensive tokens on cheap work. For PURE reading/locating/web with no edit ahead, prefer " +
    "explore/read_slice/run_filtered/web_lookup over Read, Grep, or Bash grep. " +
    "You are the ORCHESTRATOR — hand cheap grunt-work to delegate(prompt) (the Cursor worker runs with " +
    "full read/edit/shell access): commits, PRs, tickets, small mechanical edits, and running/fixing " +
    "builds. Don't spend expensive tokens doing 2-line edits or writing PR/commit text yourself. " +
    "For locating/mapping code, call the bridge's explore(question) DIRECTLY instead of spawning the " +
    "native Explore subagent — the bridge runs on Cursor's composer model (cheap) while a spawned " +
    "Explore would run on your expensive model."
  );
}

// ---- Agent/Task injection: teach spawned subagents about cursor-bridge too ----
//
// Subagents never see the main-loop nudges above; the only way to reach a
// subagent's prompt from a PreToolUse hook is `updatedInput` on the Agent/Task
// call. The context-mode plugin already does exactly that — it appends a strong
// "route everything through context-mode" block to the subagent prompt, and it
// never mentions cursor-bridge. So subagents are born blind to the bridge.
//
// We append a cursor-bridge preference to the same prompt. But multiple hooks
// returning `updatedInput` for one tool DON'T merge — it's last-to-finish-wins,
// non-deterministic (Claude Code hooks are parallel). To never clobber
// context-mode's block, we reproduce it: import context-mode's live routing,
// take the prompt it would produce (already carrying its block), and append
// ours. Then whoever wins the race, context-mode's block survives; cursor-bridge
// survives only when WE win — which the delay below biases toward.
//
// If context-mode's routing can't be imported, we stay OUT entirely (return
// null): injecting a cursor-bridge-only prompt could win the race and drop
// context-mode's block. Preserving context-mode is the hard invariant.

/** Prompt field names a subagent call may carry, in the same order context-mode probes. */
const AGENT_FIELDS = ["prompt", "request", "objective", "question", "query", "task"];

/** Marker for idempotency — never inject twice into the same prompt. */
export const CURSOR_BRIDGE_MARKER = "<cursor_bridge_preference>";

/** Live context-mode routing module (exports routePreToolUse). Override for tests/relocation. */
const CM_ROUTING =
  process.env.CONTEXT_MODE_ROUTING ||
  join(homedir(), ".claude", "plugins", "marketplaces", "context-mode", "hooks", "core", "routing.mjs");

/** ms to wait before emitting, to finish after context-mode's heavier hook and win the last-wins race. 0 disables. */
const PARSED_DELAY = Number(process.env.CURSOR_BRIDGE_AGENT_DELAY_MS);
const AGENT_DELAY_MS = Number.isFinite(PARSED_DELAY) && PARSED_DELAY >= 0 ? PARSED_DELAY : 350;

const AGENT_PREF_BODY =
  "cursor-bridge MCP is available to you (a subagent) — the cheap/fast Cursor worker. For PURE " +
  "reading/locating/web where you will NOT edit the file, prefer it over native Read/Grep/Glob/" +
  "WebSearch/WebFetch: explore(question,files?) to map or answer, read_slice(files,want) for one " +
  "section of a large file, run_filtered(command,want) to strip noisy build/test output, " +
  "web_lookup(query) for docs/errors/versions. These tools are DEFERRED — run " +
  'ToolSearch("select:mcp__cursor-bridge__read_slice,mcp__cursor-bridge__explore,' +
  'mcp__cursor-bridge__run_filtered,mcp__cursor-bridge__web_lookup") ONCE before exploring so their ' +
  "schemas load. If you WILL edit a file, native Read is correct. This complements the context-mode " +
  "routing above — both keep raw output out of your context; when both fit, either is fine.";

// Reforço só para o subagente Explore: ele foi spawnado no modelo caro do orquestrador
// (o Explore herda o modelo da sessão, capado em Opus), então empurra TODO o trabalho de
// leitura pro cursor-bridge, que roda no composer barato — o shell caro só orquestra.
const EXPLORE_EXTRA =
  " You are an Explore run spawned on the orchestrator's expensive model: do ALL file reading and " +
  "locating via explore(question)/read_slice(files,want), which run on Cursor's composer model (cheap) " +
  "and keep dumps out of your context. Use native Read only for a file you are about to edit.";

/** Monta o bloco de preferência, com o reforço extra quando o subagente é o Explore nativo. */
function agentPref(subagentType) {
  const extra = subagentType === "Explore" ? EXPLORE_EXTRA : "";
  return `\n\n${CURSOR_BRIDGE_MARKER}\n${AGENT_PREF_BODY}${extra}\n</cursor_bridge_preference>`;
}

/**
 * Pure builder for the Agent/Task `updatedInput`. `routeFn(toolInput)` must return
 * context-mode's normalized decision ({ action:"modify", updatedInput }) so its block
 * is preserved. Returns the combined updatedInput, or null to inject nothing (already
 * injected, or context-mode routing unavailable/unexpected).
 * @example buildAgentUpdatedInput({ prompt: "do x" }, () => ({ action: "modify", updatedInput: { prompt: "do x<CM>" } }))
 */
export function buildAgentUpdatedInput(toolInput, routeFn) {
  const field = AGENT_FIELDS.find((f) => f in toolInput) ?? "prompt";
  const cur = typeof toolInput[field] === "string" ? toolInput[field] : "";
  if (cur.includes(CURSOR_BRIDGE_MARKER)) return null; // idempotente
  let base;
  try {
    const d = routeFn(toolInput);
    if (!d || d.action !== "modify" || !d.updatedInput) return null;
    base = d.updatedInput;
  } catch {
    return null;
  }
  // Anexa no MESMO campo detectado em toolInput: context-mode reusa a mesma ordem de
  // AGENT_FIELDS e faz spread do input, então base[field] existe (>= o bloco dele) e o
  // marcador de idempotência (checado em toolInput[field]) e a escrita coincidem. O spread
  // de `base` preserva qualquer outro campo que o context-mode alterou (ex.: subagent_type
  // Bash → general-purpose). O `?? cur` cobre um routeFn degenerado que não setou o campo.
  return { ...base, [field]: String(base[field] ?? cur) + agentPref(toolInput.subagent_type) };
}

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

  // Bash de MUTAÇÃO (commit/PR/ticket/branch) → offload pro delegate, 1× por sessão.
  if (tool === "Bash") {
    const cmd = typeof ti.command === "string" ? ti.command : "";
    if (!BASH_MUTATE_RE.test(cmd)) return null;
    return seen.has("bash-mutate") ? null : { key: "bash-mutate", text: BASH_MUTATE_TEXT };
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

/**
 * Agent/Task path: append the cursor-bridge preference to the subagent prompt,
 * preserving context-mode's block. No session dedup — every spawned subagent
 * needs its own injection; idempotency is by the marker in the prompt.
 */
async function handleAgent(data) {
  const toolInput = data?.tool_input ?? {};
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  let routeFn;
  try {
    const mod = await import(pathToFileURL(CM_ROUTING).href);
    if (typeof mod.routePreToolUse !== "function") return; // context-mode ausente → não arrisca clobber
    routeFn = (ti) => mod.routePreToolUse("Agent", ti, projectDir, "claude-code");
  } catch {
    return;
  }
  const updatedInput = buildAgentUpdatedInput(toolInput, routeFn);
  if (!updatedInput) return;
  // Best-effort: atrasa a emissão para terminar depois do hook (mais pesado) do
  // context-mode e vencer o last-wins não-determinístico. NÃO é garantia — se o
  // context-mode demorar mais que AGENT_DELAY_MS, ele vence e a preferência não entra
  // (o bloco dele sempre sobrevive). Ajuste via CURSOR_BRIDGE_AGENT_DELAY_MS.
  if (AGENT_DELAY_MS > 0) await new Promise((r) => setTimeout(r, AGENT_DELAY_MS));
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "cursor-bridge preference added to subagent prompt",
        updatedInput,
      },
    }),
  );
}

async function main() {
  let data;
  try {
    data = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0); // sem input parseável → não atrapalha
  }
  if (data?.tool_name === "Agent" || data?.tool_name === "Task") {
    await handleAgent(data);
    process.exit(0);
  }
  const sessionId = typeof data?.session_id === "string" && data.session_id ? data.session_id : "default";
  const path = seenPath(sessionId);
  if (data?.hook_event_name === "SessionStart") {
    // Marca "preload" como visto para o piggyback do PreToolUse não repetir o lembrete.
    const seen = loadSeen(path);
    seen.add("preload");
    saveSeen(path, seen);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionStartContext() },
      }),
    );
    process.exit(0);
  }
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
