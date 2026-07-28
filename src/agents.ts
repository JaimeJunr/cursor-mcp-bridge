/**
 * Resolução de "agents" para o delegate. Um agent é uma persona/system-prompt especializado — no
 * ecossistema Claude Code, um arquivo markdown com frontmatter YAML (name/description/model) cujo
 * BODY é o system prompt. Aqui resolvemos o agent NO HOST (fora do sandbox) e extraímos só o body
 * como string portável, que cada engine injeta pelo seu canal aditivo (claude --append-system-prompt,
 * grok --rules, codex -c developer_instructions). Assim a feature NÃO é exclusiva do claude e o
 * sandbox continua com o $HOME vazio (a persona viaja como argumento, sem bind novo).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Persona resolvida: o body markdown vira system prompt portável cross-engine. */
export interface ResolvedAgent {
  prompt: string;
  name?: string;
  /** Modelo sugerido pelo frontmatter — advisory (o level/model explícito do delegate vence). */
  model?: string;
}

/** Entrada do param `agent`: um nome (resolve no host) ou um objeto inline (usa direto, sem FS). */
export type AgentInput = string | { prompt: string; name?: string; model?: string };

/** Roots onde procurar arquivos de agent (.md), na ordem. Extra via CURSOR_BRIDGE_AGENT_PATHS (`:`). */
export function agentRoots(cwd: string): string[] {
  const home = process.env.HOME ?? homedir();
  const extra = (process.env.CURSOR_BRIDGE_AGENT_PATHS ?? "")
    .split(":").map((p) => p.trim()).filter(Boolean);
  return [
    ...extra,
    join(cwd, ".claude", "agents"),
    join(home, ".claude", "agents"),
    join(home, ".claude", "plugins"), // agents de plugin (pit:issue-investigator → issue-investigator.md)
  ].filter(existsSync);
}

/**
 * Parse do frontmatter YAML simples (só name/model, linha única) + body. Sem dep externa: o body é
 * o que importa (a persona). Sem frontmatter, o arquivo inteiro é a persona.
 */
export function parseAgentFile(raw: string): ResolvedAgent {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { prompt: raw.trim() };
  const [, fm, body] = m;
  const field = (k: string): string | undefined => {
    const mm = fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m"));
    return mm ? mm[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  return { prompt: body.trim(), name: field("name"), model: field("model") };
}

/**
 * Coleta recursiva (profundidade limitada) de TODOS os `<base>.md` sob um root. Profundidade 6
 * alcança o layout de plugin `plugins/cache/<mp>/<plugin>/<versão>/agents/<base>.md`. Ignora dirs
 * ocultos. Retorna todos os matches — o chamador escolhe (ex.: versão de plugin mais recente).
 */
function findAgentFiles(root: string, base: string, depth = 6, acc: string[] = []): string[] {
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isFile() && e.name === `${base}.md`) acc.push(full);
    else if (e.isDirectory() && depth > 0 && !e.name.startsWith(".")) findAgentFiles(full, base, depth - 1, acc);
  }
  return acc;
}

/** Dos matches, escolhe o modificado mais recentemente (versão de plugin mais nova, best-effort). */
function newest(files: string[]): string {
  if (files.length === 1) return files[0];
  return files
    .map((f) => [f, statSync(f).mtimeMs] as const)
    .sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Resolve um agent para persona portável. Objeto inline → usa direto. Nome (ex "pit:issue-investigator"
 * ou "code-reviewer") → busca `<base>.md` (base = parte após ":") nos roots e extrai o body. Lança se
 * não achar. Segurança: nomes com `/` ou `..` são rejeitados (sem path traversal); a busca só desce
 * dentro dos roots allowlisted.
 */
export function resolveAgent(input: AgentInput, cwd: string): ResolvedAgent {
  if (typeof input !== "string") {
    if (!input.prompt?.trim()) {
      throw new Error(`invalid agent: object needs a non-empty 'prompt', received ${JSON.stringify(input)}`);
    }
    return input;
  }
  const base = input.includes(":") ? input.slice(input.lastIndexOf(":") + 1) : input;
  if (!base || base.includes("/") || base.includes("..")) {
    throw new Error(`invalid agent name: received ${JSON.stringify(input)}, expected a plain name or 'plugin:name'`);
  }
  for (const root of agentRoots(cwd)) {
    const files = findAgentFiles(root, base);
    if (files.length) {
      const parsed = parseAgentFile(readFileSync(newest(files), "utf8"));
      return { ...parsed, name: parsed.name ?? base };
    }
  }
  throw new Error(
    `agent '${input}' not found. Searched .claude/agents (project + home) and ~/.claude/plugins. ` +
    "Add roots via CURSOR_BRIDGE_AGENT_PATHS, or pass an inline { prompt } object.",
  );
}
