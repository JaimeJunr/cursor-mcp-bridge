import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

/** CLIs suportados. Cada engine tem dialeto de args e parser de saída próprios. */
export type Engine = "cursor" | "grok" | "codex" | "claude";

/**
 * Binário do Cursor CLI. Default `cursor-agent` (NÃO `agent`: no PATH do user `agent` pode ser o
 * grok — o bridge quebra ou some por acidente do sandbox). Override via CURSOR_BIN.
 */
export const CURSOR_BIN = process.env.CURSOR_BIN ?? "cursor-agent";
/** Binário do Grok CLI. Override via CURSOR_BRIDGE_GROK_BIN. */
export const GROK_BIN = process.env.CURSOR_BRIDGE_GROK_BIN ?? "grok";
/** Binário do Codex CLI. Override via CURSOR_BRIDGE_CODEX_BIN. */
export const CODEX_BIN = process.env.CURSOR_BRIDGE_CODEX_BIN ?? "codex";
/** Binário do Claude Code CLI. Override via CURSOR_BRIDGE_CLAUDE_BIN. */
export const CLAUDE_BIN = process.env.CURSOR_BRIDGE_CLAUDE_BIN ?? "claude";

/**
 * Modelo default do fallback cursor (só usado quando CURSOR_ENABLED e o engine é cursor). O
 * cursor-agent atual NÃO aceita mais o bracket `[fast=true]` — os ids viraram planos com sufixo
 * (`composer-2.5-fast`). NUNCA `auto`. Override via CURSOR_BRIDGE_MODEL.
 */
export const DEFAULT_MODEL = process.env.CURSOR_BRIDGE_MODEL ?? "composer-2.5-fast";

/**
 * Modelo barato de leitura do `explore`/`read_slice`/`run_filtered`/`web_lookup`: GPT-5.6 Luna via
 * codex (keyless, pela assinatura Codex), rodando read-only (`-s read-only`). Substitui o composer do
 * cursor cancelado — localizar/ler/filtrar pede o modelo mais barato e ágil. Override via
 * CURSOR_BRIDGE_EXPLORE_MODEL. Só se aplica quando o chamador não passa `model`.
 */
export const EXPLORE_MODEL = process.env.CURSOR_BRIDGE_EXPLORE_MODEL ?? "gpt-5.6-luna";

/**
 * Modelo codex que dispara o image_gen built-in (gpt-image-2 faz o trabalho pesado; effort baixo basta).
 * Override via CURSOR_BRIDGE_IMAGE_MODEL.
 */
export const IMAGE_MODEL = process.env.CURSOR_BRIDGE_IMAGE_MODEL ?? "gpt-5.6-sol";

/** Se truthy, passa --force (roda comandos sem prompt). Default off por segurança. */
export const FORCE = ["1", "true", "yes"].includes((process.env.CURSOR_BRIDGE_FORCE ?? "").toLowerCase());

/**
 * Fallback para o cursor-agent. O usuário cancelou a assinatura do Cursor, então por padrão os tiers
 * NÃO caem no cursor quando a engine preferida (codex/grok/claude) falta — erram com mensagem clara.
 * Reative o fallback (código do cursor continua íntegro) com CURSOR_BRIDGE_ENABLE_CURSOR=1.
 */
export const CURSOR_ENABLED = ["1", "true", "yes"].includes(
  (process.env.CURSOR_BRIDGE_ENABLE_CURSOR ?? "").toLowerCase(),
);

/** Timeout padrão (ms). Override via CURSOR_BRIDGE_TIMEOUT_MS. */
export const DEFAULT_TIMEOUT_MS = Number(process.env.CURSOR_BRIDGE_TIMEOUT_MS ?? 600_000);

/** Se truthy, loga o comando spawnado e espelha o stderr do child em tempo real. Debug. */
export const DEBUG = ["1", "true", "yes"].includes((process.env.CURSOR_BRIDGE_DEBUG ?? "").toLowerCase());

/**
 * Sandbox: por padrão o agent roda dentro de um bubblewrap (`bwrap`) com $HOME isolado —
 * assim o cursor-agent NÃO carrega a config global de behavior do user (~/.cursor/rules,
 * mcp.json, hooks.json, skills, cli-config), que poluía o contexto e, pior, fazia cada
 * chamada tentar subir os MCP servers do user (lentidão/timeout). Só bindamos auth +
 * toolchains. Desliga com CURSOR_BRIDGE_SANDBOX=off (ou 0/false/no/vazio).
 */
const SANDBOX = (process.env.CURSOR_BRIDGE_SANDBOX ?? "bwrap").toLowerCase();
export const SANDBOX_ON = !["", "off", "0", "false", "no"].includes(SANDBOX);

/** Paths de sistema montados read-only no sandbox (só os que existirem). */
const SANDBOX_SYSTEM_RO = [
  "/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc/alternatives",
  "/etc/resolv.conf", "/etc/hosts", "/etc/ssl", "/etc/ca-certificates",
  "/etc/passwd", "/etc/group", "/etc/nsswitch.conf",
];
/** Subpaths do HOME liberados RO: SÓ auth + toolchains — nunca behavior config. */
const SANDBOX_HOME_RO = [
  ".config/cursor/auth.json", ".nvm", ".local", ".mise", ".config/mise", ".sdkman", ".gitconfig",
];
/**
 * Subpaths do HOME RO específicos por engine: SÓ o que o binário precisa (auth + libs), NUNCA a
 * config global (que carrega rules/MCP servers — o que inflava e travava). O que não é bindado cai
 * no $HOME isolado (vazio), então cada CLI roda sem sua config global. Só os que existirem entram.
 */
const SANDBOX_ENGINE_RO: Record<Engine, string[]> = {
  cursor: [], // auth do cursor já vem no SANDBOX_HOME_RO base
  grok: [], // grok precisa de RW em ~/.grok (auth, skills e cache) — ver SANDBOX_ENGINE_RW
  codex: [], // codex precisa de RW em ~/.codex (state/cache/locks/socket) — ver SANDBOX_ENGINE_RW
  // claude: SÓ a credencial de auth (oauth da assinatura). NUNCA ~/.claude inteiro — isso traz
  // settings/agents/mcp.json de volta, o que reinfla o contexto (o worker roda com --bare +
  // --append-system-prompt, então não precisa descobrir agents/rules no HOME).
  claude: [".claude/.credentials.json", ".claude.json"],
};
/**
 * Subpaths do HOME RW por engine. Grok precisa de auth/skills/cache em ~/.grok; o codex tem
 * arquitetura cliente-daemon (state, cache, locks, socket do app-server) e trava se ~/.codex for
 * read-only ou ausente. A config global do codex é neutralizada por `--ignore-user-config`.
 */
const SANDBOX_ENGINE_RW: Record<Engine, string[]> = {
  cursor: [],
  grok: [".grok"],
  codex: [".codex"],
  // claude escreve estado de sessão/telemetria em ~/.claude ao rodar headless; sem RW o run pode
  // falhar. Damos RW só em subpaths de estado, nunca settings/agents (que ficam no HOME isolado).
  claude: [".claude/statsig", ".claude/projects", ".claude/todos", ".claude/shell-snapshots"],
};
/** Subpaths do HOME liberados RW: caches de build (acelera runs seguidos). */
const SANDBOX_HOME_RW = [".gradle", ".m2", ".cache/uv", ".cache/pip"];
/**
 * Paths extras montados RW no sandbox além do cwd, separados por `:` em CURSOR_BRIDGE_SANDBOX_EXTRA.
 * O sandbox só monta o cwd como workspace; comandos que tocam paths fora dele (ex.: additional
 * working dirs, monorepos irmãos) davam "No such file or directory". Liste-os aqui uma vez.
 */
const SANDBOX_EXTRA = (process.env.CURSOR_BRIDGE_SANDBOX_EXTRA ?? "")
  .split(":")
  .map((p) => p.trim())
  .filter(Boolean);
/** Env de proxy/SSL preservado do host, se setado. */
const SANDBOX_PROXY_ENV = [
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
];

export interface SandboxSpec {
  home: string;
  user: string;
  path: string;
  lang: string;
  lcAll: string;
  /** dir vazio montado como $HOME (RW, efêmero). */
  isoHome: string;
  /** dir montado como /tmp dentro do sandbox (RW, efêmero). */
  tmpDir: string;
  /** cwd do run, montado RW — sempre o último bind pra nunca ser sobreposto. */
  workspace: string;
  systemRo: string[];
  homeRo: string[];
  homeRw: string[];
  /** paths extras montados RW (CURSOR_BRIDGE_SANDBOX_EXTRA), antes do workspace. */
  extraBinds: string[];
  extraEnv: Array<[string, string]>;
}

/**
 * Monta os args do `bwrap` (sem o binário nem o comando alvo). Função pura — testável.
 * Ordem crítica: `isoHome` monta o $HOME vazio ANTES dos binds de subpaths do HOME
 * (senão o overlay de auth/toolchain some), e o `workspace` é o último bind.
 */
export function buildSandboxArgs(spec: SandboxSpec): string[] {
  const args: string[] = [];
  for (const p of spec.systemRo) args.push("--ro-bind", p, p);
  args.push("--bind", spec.isoHome, spec.home);
  args.push("--bind", spec.tmpDir, "/tmp", "--tmpfs", "/run");
  for (const p of spec.homeRo) args.push("--ro-bind", p, p);
  for (const p of spec.homeRw) args.push("--bind", p, p);
  for (const p of spec.extraBinds) args.push("--bind", p, p);
  args.push("--bind", spec.workspace, spec.workspace);
  args.push(
    "--setenv", "HOME", spec.home,
    "--setenv", "USER", spec.user,
    "--setenv", "PATH", spec.path,
    "--setenv", "LANG", spec.lang,
    "--setenv", "LC_ALL", spec.lcAll,
  );
  for (const [k, v] of spec.extraEnv) args.push("--setenv", k, v);
  args.push(
    "--proc", "/proc",
    "--dev", "/dev",
    "--share-net",
    "--unshare-pid", "--unshare-uts", "--unshare-ipc",
    "--die-with-parent", "--new-session",
    "--chdir", spec.workspace,
  );
  return args;
}

/** Procura o binário `bwrap` no PATH. Retorna o path absoluto ou null. */
function bwrapPath(): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, "bwrap"))) return join(dir, "bwrap");
  }
  return null;
}

/** Cria os dirs efêmeros e sonda os paths existentes pra montar o SandboxSpec. */
export function buildSandboxSpec(workspace: string, engine: Engine): { spec: SandboxSpec; cleanup: () => void } {
  const home = process.env.HOME ?? homedir();
  const isoHome = mkdtempSync(join(tmpdir(), "cbx-home-"));
  const tmpDir = mkdtempSync(join(tmpdir(), "cbx-tmp-"));
  const abs = (rel: string) => join(home, rel);
  const spec: SandboxSpec = {
    home,
    user: process.env.USER ?? userInfo().username,
    path: process.env.PATH ?? "/usr/bin:/bin",
    lang: process.env.LANG ?? "C.UTF-8",
    lcAll: process.env.LC_ALL ?? "C.UTF-8",
    isoHome,
    tmpDir,
    workspace,
    systemRo: SANDBOX_SYSTEM_RO.filter((p) => existsSync(p)),
    // base (toolchains + cursor auth) + os subpaths RO específicos do engine (auth/libs do CLI)
    homeRo: [...SANDBOX_HOME_RO, ...SANDBOX_ENGINE_RO[engine]].map(abs).filter((p) => existsSync(p)),
    homeRw: [...SANDBOX_HOME_RW, ...SANDBOX_ENGINE_RW[engine]].map(abs).filter((p) => existsSync(p)),
    // só os que existem e não são o próprio workspace (esse já é o último bind)
    extraBinds: SANDBOX_EXTRA.filter((p) => p !== workspace && existsSync(p)),
    extraEnv: SANDBOX_PROXY_ENV
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k] as string]),
  };
  const cleanup = () => {
    try { rmSync(isoHome, { recursive: true, force: true }); } catch { /* efêmero */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* efêmero */ }
  };
  return { spec, cleanup };
}

export interface RunOpts {
  prompt: string;
  /** Qual CLI usar. Default "cursor". grok/codex têm dialeto e parser próprios. */
  engine?: Engine;
  model?: string;
  effort?: string;
  resume?: string;
  /** read-only mode para discovery/analyze: "plan" | "ask". No codex vira `-s read-only`. */
  mode?: "plan" | "ask";
  /** Habilita a busca web da engine (codex: `-c tools.web_search=true`). Usado por web_lookup. */
  web?: boolean;
  /** Auto-aprova as tools deste run (--force), independente do env global. web_lookup precisa. */
  force?: boolean;
  cwd?: string;
  /** Timeout deste run (ms). Sobrepõe DEFAULT_TIMEOUT_MS — tarefas que rodam build precisam de mais. */
  timeoutMs?: number;
  /** Imagens de entrada anexadas ao prompt (codex -i). Usado por generate_image para edição. */
  images?: string[];
  /**
   * Persona/system-prompt de um agent especializado, injetada pelo canal aditivo de cada engine
   * (claude --append-system-prompt, grok --rules, codex -c developer_instructions, cursor prefixo).
   * Resolvida no host por resolveAgent (src/agents.ts). Cross-engine — não é exclusiva do claude.
   */
  agentPrompt?: string;
}

/** Codifica uma string como TOML basic string (aspas + escapes) para `-c key=value` do codex. */
export function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "")}"`;
}

/**
 * Resolve o nome do modelo. `effort` só vira bracket em modelos parametrizados —
 * `auto` ignora effort (não aceita override). Função pura para teste.
 * @example resolveModel("gpt-5.2", "high") // "gpt-5.2[effort=high]"
 * @example resolveModel(undefined, "high") // "auto"
 */
export function resolveModel(model?: string, effort?: string): string {
  const base = model ?? DEFAULT_MODEL;
  if (effort && base !== "auto") return `${base}[effort=${effort}]`;
  return base;
}

/**
 * Monta os argumentos do `agent -p`. Função pura — isolada para teste.
 */
export function buildCursorArgs(opts: RunOpts): string[] {
  const args = ["-p", "--output-format", "json", "--trust", "--model", resolveModel(opts.model, opts.effort)];
  if (opts.mode) args.push("--mode", opts.mode);
  if (opts.resume) args.push("--resume", opts.resume);
  if (FORCE || opts.force) args.push("--force");
  // cursor-agent não tem canal de system-prompt aditivo; a persona vai como prefixo do prompt (fallback).
  args.push(opts.agentPrompt ? `${opts.agentPrompt}\n\n---\n\n${opts.prompt}` : opts.prompt);
  return args;
}

/**
 * Args do Grok CLI (`grok`). Dialeto próprio: prompt é VALOR de `--single`, effort é flag separada
 * (`--effort` — o xAI CLI atual renomeou `--reasoning-effort` → `--effort`), autonomia é
 * `--always-approve` (não `--force`). Função pura — testável.
 */
export function buildGrokArgs(opts: RunOpts): string[] {
  const args = ["--single", opts.prompt, "--output-format", "json"];
  if (opts.model) args.push("-m", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.agentPrompt) args.push("--rules", opts.agentPrompt); // canal aditivo de system prompt do grok
  args.push("--always-approve");
  if (opts.resume) args.push("-r", opts.resume);
  return args;
}

/**
 * Args do Codex CLI (`codex exec`). Dialeto próprio: subcomando `exec`, saída JSONL (`--json`),
 * effort via config override (`-c model_reasoning_effort=...`), autonomia via bypass. Função pura.
 */
export function buildCodexArgs(opts: RunOpts): string[] {
  // --ignore-user-config: NÃO carrega ~/.codex/config.toml (que traz MCP servers externos — o codex
  // pendurava tentando conectá-los até timeout, subindo N processos). --ignore-rules: idem para .rules.
  // Auth continua via CODEX_HOME. Isso complementa o sandbox (defense-in-depth).
  const flags = ["--json", "--ignore-user-config", "--ignore-rules"];
  // read-only (explore/read_slice/web_lookup) → sandbox read-only do codex + sem pedir aprovação
  // (senão pendura em headless). Sem mode (delegate/generate_image) → bypass total (full access).
  if (opts.mode) flags.push("-s", "read-only", "-c", 'approval_policy="never"');
  else flags.push("--dangerously-bypass-approvals-and-sandbox");
  if (opts.web) flags.push("-c", "tools.web_search=true"); // busca web (web_lookup)
  if (opts.model) flags.push("-m", opts.model);
  if (opts.effort) flags.push("-c", `model_reasoning_effort="${opts.effort}"`);
  // persona aditiva do codex: developer_instructions (developer-role), TOML-encoded. NÃO usamos
  // AGENTS.md nem model_instructions_file (esse último SUBSTITUI as instruções do codex).
  if (opts.agentPrompt) flags.push("-c", `developer_instructions=${tomlString(opts.agentPrompt)}`);
  if (opts.images?.length) {
    for (const file of opts.images) flags.push("-i", file);
  }
  // -i/--image é variádico (`<FILE>...`): sem o terminador `--`, o clap engole o prompt posicional
  // como se fosse mais um arquivo e o codex cai no stdin (fechado) → "No prompt provided via stdin".
  const sep = opts.images?.length ? ["--"] : [];
  // resume é subcomando próprio: `codex exec resume [OPTIONS] <id> <prompt>` (id e prompt posicionais).
  if (opts.resume) return ["exec", "resume", ...flags, ...sep, opts.resume, opts.prompt];
  return ["exec", ...flags, ...sep, opts.prompt];
}

/**
 * Args do Claude Code CLI (`claude -p`). Dialeto próprio: `--print` headless, prompt posicional,
 * autonomia via `--dangerously-skip-permissions`, resume via `--resume <id>`. Saída `--output-format
 * json` tem a forma `{result, session_id}` (mesma do cursor → parseCliJson).
 *
 * NÃO usar `--bare`: ele quebra a resolução de auth (a CLI retorna "Not logged in"). Em vez disso
 * isolamos a config do usuário como o sandbox faz para os outros engines: `--strict-mcp-config` (sem
 * `--mcp-config` → ZERO MCP servers, o codex/cursor não sobem os MCP do user e o claude também não) e
 * `--setting-sources project` (ignora ~/.claude/settings, o HOME isolado do sandbox já está vazio).
 * Função pura — testável.
 */
export function buildClaudeArgs(opts: RunOpts): string[] {
  const args = [
    "-p", "--output-format", "json",
    "--strict-mcp-config",
    "--setting-sources", "project",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.agentPrompt) args.push("--append-system-prompt", opts.agentPrompt); // canal nativo do claude
  // autonomia: em headless o claude bloqueia em permissões sem isso. O sandbox contém o raio ao cwd.
  if (FORCE || opts.force) args.push("--dangerously-skip-permissions");
  if (opts.resume) args.push("--resume", opts.resume);
  args.push(opts.prompt);
  return args;
}

/** Despacha a montagem de args pelo engine. */
export function buildArgs(engine: Engine, opts: RunOpts): string[] {
  if (engine === "grok") return buildGrokArgs(opts);
  if (engine === "codex") return buildCodexArgs(opts);
  if (engine === "claude") return buildClaudeArgs(opts);
  return buildCursorArgs(opts);
}

export interface CliResult {
  text: string;
  sessionId?: string;
}

/**
 * Extrai texto e session id do JSON headless. Tolerante aos dois dialetos de objeto único:
 * cursor (`{result, session_id}`) e grok (`{text, sessionId}`). Degrada para texto cru.
 */
export function parseCliJson(raw: string): CliResult {
  const trimmed = raw.trim();
  try {
    const obj = JSON.parse(trimmed) as {
      result?: unknown; text?: unknown; session_id?: unknown; sessionId?: unknown;
    };
    const text = typeof obj.result === "string" ? obj.result
      : typeof obj.text === "string" ? obj.text : trimmed;
    const sessionId = typeof obj.session_id === "string" ? obj.session_id
      : typeof obj.sessionId === "string" ? obj.sessionId : undefined;
    return { text, sessionId };
  } catch {
    return { text: trimmed };
  }
}

/**
 * Parser do Codex `exec --json`: stdout é JSONL de eventos (com ruído de log entremeado). A resposta
 * final é o último evento `item.completed` cujo `item.type === "agent_message"`. Best-effort: linhas
 * não-JSON são ignoradas, nunca lança.
 */
export function parseCodexJsonl(raw: string): CliResult {
  let text = "";
  let sessionId: string | undefined;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const ev = JSON.parse(t) as {
        item?: { type?: unknown; text?: unknown }; session_id?: unknown; thread_id?: unknown;
      };
      if (ev.item?.type === "agent_message" && typeof ev.item.text === "string") text = ev.item.text;
      // o codex emite o id como `thread_id` no evento `thread.started`; `session_id` fica de fallback
      if (typeof ev.session_id === "string") sessionId = ev.session_id;
      else if (typeof ev.thread_id === "string") sessionId = ev.thread_id;
    } catch { /* linha de log não-JSON — ignora */ }
  }
  return { text: text || raw.trim(), sessionId };
}

/** Despacha o parse de saída pelo engine. */
export function parseOutput(engine: Engine, raw: string): CliResult {
  return engine === "codex" ? parseCodexJsonl(raw) : parseCliJson(raw);
}

/** true se `bin` é um path existente ou um nome encontrável no PATH. */
export function binExists(bin: string): boolean {
  if (bin.includes("/")) return existsSync(bin);
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, bin))) return true;
  }
  return false;
}

/** true se o CLI do engine está instalado. cursor é sempre assumido presente. */
export function hasEngine(engine: Engine): boolean {
  if (engine === "cursor") return true;
  if (engine === "grok") return binExists(GROK_BIN);
  if (engine === "codex") return binExists(CODEX_BIN);
  return binExists(CLAUDE_BIN); // claude
}

export interface Tier {
  engine: Engine;
  model: string;
  effort?: string;
}

/** Entrada da matriz de tiers: engine/modelo preferido + o id equivalente no cursor (fallback). */
interface TierEntry {
  primary: Tier;
  /** Modelo cursor-agent equivalente, usado só quando CURSOR_ENABLED e a engine preferida falta. */
  cursorModel: string;
}

/**
 * Matriz do `delegate`: cada nível usa um MODELO DISTINTO, sem repetir entre níveis, escalando a
 * dificuldade e distribuindo pelas 3 assinaturas (codex/grok/claude). O cursor saiu do caminho
 * padrão (assinatura cancelada) — vira fallback só sob CURSOR_ENABLED. Leitura barata (explore/
 * read_slice) reaproveita o modelo do nível 1 (gpt-5.6-luna).
 */
const TIERS: Record<number, TierEntry> = {
  1: { primary: { engine: "codex", model: "gpt-5.6-luna" }, cursorModel: "composer-2.5-fast" },
  2: { primary: { engine: "grok", model: "grok-4.5", effort: "medium" }, cursorModel: "cursor-grok-4.5-medium-fast" },
  3: { primary: { engine: "codex", model: "gpt-5.6-terra", effort: "medium" }, cursorModel: "gpt-5.6-terra-medium-fast" },
  4: { primary: { engine: "codex", model: "gpt-5.6-sol", effort: "medium" }, cursorModel: "gpt-5.6-sol-medium-fast" },
  5: { primary: { engine: "claude", model: "opus" }, cursorModel: "claude-opus-4-8-high-fast" },
};

/**
 * Roteia o nível (1-5) para (engine, modelo, effort). Usa a engine preferida do nível se instalada.
 * Se faltar: cai para o cursor-agent SÓ quando CURSOR_ENABLED (assinatura reativada); senão lança
 * erro claro dizendo o que instalar. `has`/`cursorEnabled` são injetados para teste.
 */
export function resolveTier(
  level: number,
  has: (e: Engine) => boolean = hasEngine,
  cursorEnabled: boolean = CURSOR_ENABLED,
): Tier {
  const entry = TIERS[level];
  if (!entry) throw new Error(`invalid delegate level: received ${level}, expected integer 1-5`);
  if (has(entry.primary.engine)) return entry.primary;
  if (cursorEnabled) return { engine: "cursor", model: entry.cursorModel };
  throw new Error(
    `delegate level ${level} needs the '${entry.primary.engine}' CLI, which is not installed. ` +
    "Install it, pick another level, or set CURSOR_BRIDGE_ENABLE_CURSOR=1 to fall back to cursor-agent.",
  );
}

/** Roda o CLI do engine em modo headless e devolve o resultado parseado. */
export function runCursor(opts: RunOpts): Promise<CliResult> {
  const engine = opts.engine ?? "cursor";
  const bin = engine === "grok" ? GROK_BIN
    : engine === "codex" ? CODEX_BIN
    : engine === "claude" ? CLAUDE_BIN
    : CURSOR_BIN;
  const engineArgs = buildArgs(engine, opts);
  const workspace = opts.cwd ?? process.cwd();

  // O sandbox bwrap ($HOME isolado) é OBRIGATÓRIO para TODOS os engines — nenhum modelo roda fora
  // dele. Isola a config global de cada CLI (~/.cursor/rules, ~/.grok/config.toml, ~/.codex/config)
  // que carregava rules/MCP servers, inflando tokens.
  let cmd = bin;
  let args = engineArgs;
  let cleanup = () => {};
  const bwrap = SANDBOX_ON ? bwrapPath() : null;
  if (bwrap) {
    const built = buildSandboxSpec(workspace, engine);
    cleanup = built.cleanup;
    cmd = bwrap;
    args = [...buildSandboxArgs(built.spec), bin, ...engineArgs];
  } else if (SANDBOX_ON) {
    process.stderr.write(
      "[cursor-bridge] bwrap não encontrado no PATH — rodando SEM sandbox (config global do user pode vazar). Instale com 'sudo apt install bubblewrap'.\n",
    );
  }
  if (DEBUG) process.stderr.write(`[cursor-bridge:debug] ${cmd} ${args.map((a) => JSON.stringify(a)).join(" ")}\n`);

  return new Promise((resolve, reject) => {
    // stdin fechado ("ignore"): o `codex exec` fica pendurado ("Reading additional input from
    // stdin...") se o stdin for um pipe aberto. cursor/grok recebem o prompt por arg e não usam stdin.
    const child = spawn(cmd, args, { cwd: workspace, env: process.env, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error(`${engine} agent timed out after ${timeoutMs}ms: ${stderr.trim().slice(-500)}`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (DEBUG) process.stderr.write(d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`failed to spawn '${cmd}': ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      cleanup();
      if (code !== 0) {
        reject(new Error(`${engine} agent exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve(parseOutput(engine, stdout));
    });
  });
}
