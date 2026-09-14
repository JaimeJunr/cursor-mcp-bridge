import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

/** CLIs suportados. Cada engine tem dialeto de args e parser de saída próprios. */
export type Engine = "cursor" | "grok" | "codex" | "claude";

/** Ordem host-agnostic para recuperar uma execução quando o ambiente do codex está quebrado. */
export const FALLBACK_ENGINE_ORDER: Engine[] = ["codex", "grok", "claude"];

/**
 * Detecta falhas de ambiente do codex que nenhum retry no mesmo engine resolve: CODEX_HOME
 * apontando para um diretório de conta que sumiu (gerenciado por apps externos como o orca), ou o
 * app-server interno falhando ao inicializar por filesystem read-only (ex.: conta montada RO).
 * Distinto de erros de auth/permissão do próprio codex, que não devem disparar fallback de engine.
 */
export function isCodexEnvError(stderr: string): boolean {
  if ((stderr.includes("Error finding codex home") || stderr.includes("CODEX_HOME points to"))
    && stderr.includes("does not exist")) return true;
  return stderr.includes("failed to initialize in-process app-server client")
    || stderr.includes("Read-only file system");
}

/**
 * Falha de processo do CLI com os três canais preservados separados. `message` é idêntica à de
 * antes (quem só lê `error.message` não vê diferença), mas o JSON estruturado que os CLIs emitem em
 * stdout deixa de ser descartado sempre que o stderr tem qualquer conteúdo — é ele que permite
 * classificar a causa (cota, rate limit, auth) a jusante.
 */
export class ProcessError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = "ProcessError";
  }
}

/** Formata um id de sessão com o engine que deve retomá-lo. */
export function formatSessionHandle(engine: Engine, id: string): string {
  return `${engine}:${id}`;
}

/** Extrai engine e id de um handle; ids antigos sem prefixo continuam válidos. */
export function parseSessionHandle(handle: string): { engine?: Engine; id: string } {
  const separator = handle.indexOf(":");
  if (separator === -1) return { id: handle };

  const prefix = handle.slice(0, separator);
  if (prefix !== "cursor" && prefix !== "grok" && prefix !== "codex" && prefix !== "claude") {
    return { id: handle };
  }
  return { engine: prefix, id: handle.slice(separator + 1) };
}

/**
 * Binário do Cursor CLI. Default `cursor-agent` (NÃO `agent`: no PATH do user `agent` pode ser o
 * grok — o bridge quebra ou some por acidente do sandbox). Override via POLYAGENT_CURSOR_BIN.
 */
export const POLYAGENT_CURSOR_BIN = process.env.POLYAGENT_CURSOR_BIN ?? "cursor-agent";
/** Binário do Grok CLI. Override via POLYAGENT_GROK_BIN. */
export const GROK_BIN = process.env.POLYAGENT_GROK_BIN ?? "grok";
/** Binário do Codex CLI. Override via POLYAGENT_CODEX_BIN. */
export const CODEX_BIN = process.env.POLYAGENT_CODEX_BIN ?? "codex";
/** Binário do Claude Code CLI. Override via POLYAGENT_CLAUDE_BIN. */
export const CLAUDE_BIN = process.env.POLYAGENT_CLAUDE_BIN ?? "claude";

/**
 * Modelo default do fallback cursor (só usado quando CURSOR_ENABLED e o engine é cursor). O
 * cursor-agent atual NÃO aceita mais o bracket `[fast=true]` — os ids viraram planos com sufixo
 * (`composer-2.5-fast`). NUNCA `auto`. Override via POLYAGENT_MODEL.
 */
export const DEFAULT_MODEL = process.env.POLYAGENT_MODEL ?? "composer-2.5-fast";

/**
 * Modelo barato de leitura do `explore`/`read_slice`/`run_filtered`/`web_lookup`: GPT-5.6 Luna via
 * codex (keyless, pela assinatura Codex), rodando read-only (`-s read-only`). Substitui o composer do
 * cursor cancelado — localizar/ler/filtrar pede o modelo mais barato e ágil. Override via
 * POLYAGENT_EXPLORE_MODEL. Só se aplica quando o chamador não passa `model`.
 */
const EXPLORE_MODEL_FALLBACK = "gpt-5.6-luna";
export const EXPLORE_MODEL = process.env.POLYAGENT_EXPLORE_MODEL ?? EXPLORE_MODEL_FALLBACK;

/**
 * Modelo codex que dispara o image_gen built-in (gpt-image-2 faz o trabalho pesado; effort baixo basta).
 * Override via POLYAGENT_IMAGE_MODEL.
 */
export const IMAGE_MODEL = process.env.POLYAGENT_IMAGE_MODEL ?? "gpt-5.6-sol";

/** Se truthy, passa --force (roda comandos sem prompt). Default off por segurança. */
export const FORCE = ["1", "true", "yes"].includes((process.env.POLYAGENT_FORCE ?? "").toLowerCase());

/**
 * Fallback para o cursor-agent. O usuário cancelou a assinatura do Cursor, então por padrão os tiers
 * NÃO caem no cursor quando a engine preferida (codex/grok/claude) falta — erram com mensagem clara.
 * Reative o fallback (código do cursor continua íntegro) com POLYAGENT_ENABLE_CURSOR=1.
 */
export const CURSOR_ENABLED = ["1", "true", "yes"].includes(
  (process.env.POLYAGENT_ENABLE_CURSOR ?? "").toLowerCase(),
);

/**
 * Timeout padrão (ms): rede de segurança generosa contra travamentos reais, não orçamento de trabalho.
 * Override via POLYAGENT_TIMEOUT_MS.
 */
function resolveDefaultTimeoutMs(): number {
  const raw = Number(process.env.POLYAGENT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1_800_000;
}
export const DEFAULT_TIMEOUT_MS = resolveDefaultTimeoutMs();

/** Nota de time budget anexada ao prompt de tarefas longas: o worker se auto-gerencia em vez de
 *  ser morto cego ao estourar o timeout. */
export function budgetNote(timeoutMs: number): string {
  const min = Math.max(1, Math.round(timeoutMs / 60_000));
  return `\n\n[Time budget: ~${min} min. If you are running low on time, stop and return partial results with a clear note on what remains — do not risk being cut off mid-work.]`;
}

/** Se truthy, loga o comando spawnado e espelha o stderr do child em tempo real. Debug. */
export const DEBUG = ["1", "true", "yes"].includes((process.env.POLYAGENT_DEBUG ?? "").toLowerCase());

/**
 * Sandbox: por padrão o agent roda dentro de um bubblewrap (`bwrap`) com $HOME isolado —
 * assim o cursor-agent NÃO carrega a config global de behavior do user (~/.cursor/rules,
 * mcp.json, hooks.json, skills, cli-config), que poluía o contexto e, pior, fazia cada
 * chamada tentar subir os MCP servers do user (lentidão/timeout). Só bindamos auth +
 * toolchains. Desliga com POLYAGENT_SANDBOX=off (ou 0/false/no/vazio).
 */
const SANDBOX = (process.env.POLYAGENT_SANDBOX ?? "bwrap").toLowerCase();
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
  // claude: NUNCA ~/.claude inteiro — isso traz settings/agents/mcp.json de volta, o que reinfla o
  // contexto (o worker roda com --bare + --append-system-prompt, então não precisa descobrir
  // agents/rules no HOME). A credencial de oauth fica em SANDBOX_ENGINE_RW: precisa ser gravável.
  claude: [".claude.json"],
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
  // .credentials.json é RW de propósito: o CLI renova o oauth da assinatura e precisa persistir o
  // par novo. Montado RO, o refresh falha com EROFS e o refresh token — já rotacionado no servidor
  // — fica queimado no disco, derrubando TODA a auth do host com "401 OAuth token has been
  // revoked", não só o worker. Quem escreve ali é o próprio CLI renovando a credencial dele.
  claude: [
    ".claude/.credentials.json",
    ".claude/statsig",
    ".claude/projects",
    ".claude/todos",
    ".claude/shell-snapshots",
  ],
};
/** Subpaths do HOME liberados RW: caches de build (acelera runs seguidos). */
const SANDBOX_HOME_RW = [".gradle", ".m2", ".cache/uv", ".cache/pip"];
/**
 * Paths extras montados RW no sandbox além do cwd, separados por `:` em POLYAGENT_SANDBOX_EXTRA.
 * O sandbox só monta o cwd como workspace; comandos que tocam paths fora dele (ex.: additional
 * working dirs, monorepos irmãos) davam "No such file or directory". Liste-os aqui uma vez.
 */
const SANDBOX_EXTRA = (process.env.POLYAGENT_SANDBOX_EXTRA ?? "")
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
  /** cwd do run — sempre o último bind pra nunca ser sobreposto. */
  workspace: string;
  /** monta o workspace como somente leitura quando true. */
  workspaceRo: boolean;
  systemRo: string[];
  homeRo: string[];
  homeRw: string[];
  /** paths extras montados RW (POLYAGENT_SANDBOX_EXTRA), antes do workspace. */
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
  args.push(spec.workspaceRo ? "--ro-bind" : "--bind", spec.workspace, spec.workspace);
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

/** Mensagem única do bwrap ausente — usada no preflight e no runOnce. */
const BWRAP_MISSING =
  "polyagent-mcp: bwrap não encontrado no PATH. O sandbox é obrigatório — instale com 'sudo apt install bubblewrap', " +
  "ou desligue explicitamente com POLYAGENT_SANDBOX=off (nesse caso as tools read-only só aceitam codex).";

/**
 * Falha cedo (na inicialização do server) se o sandbox está ligado e o bwrap não existe. Antes,
 * a ausência do binário só virava um aviso em stderr que o chamador MCP nunca via, e o worker
 * rodava sem isolamento nenhum — degradação silenciosa de uma garantia de segurança.
 */
export function sandboxPreflight(sandboxOn = SANDBOX_ON): void {
  if (sandboxOn && !bwrapPath()) throw new Error(BWRAP_MISSING);
}

/**
 * Com o sandbox desligado por escolha do operador, o read-only das tools auxiliares deixa de vir
 * do `--ro-bind` do bwrap e passa a depender do engine: só o codex tem read-only próprio
 * (`-s read-only`). Grok ignora `mode` e sempre emite `--always-approve`; claude emite
 * `--dangerously-skip-permissions`. Por isso, sem sandbox, qualquer engine não-codex é recusado.
 */
export function assertReadOnlyEngine(tool: string, engine: Engine, sandboxOn = SANDBOX_ON): void {
  if (sandboxOn || engine === "codex") return;
  throw new Error(
    `${tool} é read-only e o sandbox está desligado (POLYAGENT_SANDBOX=off): engine '${engine}' recusado. ` +
    "Sem bwrap, só o codex garante read-only próprio (-s read-only) — use engine 'codex' ou religue o sandbox.",
  );
}

/** As quatro tools auxiliares, que resolvem engine/modelo próprios (as demais vão pelo tier). */
export type AuxTool = "explore" | "read_slice" | "run_filtered" | "web_lookup";

/** O que cada engine garante no nível do CLI — base das recusas por capacidade. */
export interface EngineCapability {
  /** Busca web nativa. Só o codex lê RunOpts.web (-c tools.web_search=true); os outros ignoram o campo. */
  webSearch: boolean;
  /** Read-only próprio do engine, independente do sandbox. Só o codex (-s read-only). */
  engineReadOnly: boolean;
  /** Read-only via bwrap: buildSandboxSpec(workspace, engine, !!mode) monta o workspace --ro-bind. Vale para todos. */
  sandboxReadOnly: boolean;
  /** O que o engine faz com RunOpts.mode no nível do CLI — documenta por que o read-only depende do sandbox. */
  modeAtEngineLevel: string;
}

/**
 * Matriz de capacidade por engine. O ponto não-óbvio que ela registra: fora do codex, `mode` NÃO
 * significa read-only no nível do engine — buildGrokArgs ignora `mode` e emite sempre
 * `--always-approve`, e buildClaudeArgs emite `--dangerously-skip-permissions`, o oposto de
 * read-only. Por isso o read-only dessas tools fora do codex depende do sandbox bwrap (obrigatório
 * desde a US-008) e assertReadOnlyEngine recusa não-codex com o sandbox desligado.
 */
export const ENGINE_CAPABILITIES: Record<Engine, EngineCapability> = {
  codex: {
    webSearch: true,
    engineReadOnly: true,
    sandboxReadOnly: true,
    modeAtEngineLevel: '-s read-only -c approval_policy="never" (buildCodexArgs, fora do bwrap)',
  },
  grok: {
    webSearch: false,
    engineReadOnly: false,
    sandboxReadOnly: true,
    modeAtEngineLevel: "mode ignorado — sempre --always-approve (buildGrokArgs)",
  },
  claude: {
    webSearch: false,
    engineReadOnly: false,
    sandboxReadOnly: true,
    modeAtEngineLevel: "mode emite --dangerously-skip-permissions (buildClaudeArgs)",
  },
  cursor: {
    webSearch: false,
    engineReadOnly: false,
    sandboxReadOnly: true,
    modeAtEngineLevel: "mode vira --mode <mode> (buildCursorArgs), sem garantia de read-only",
  },
};

/** O que cada tool auxiliar exige do engine. run_filtered não exige nada: roda com force por desenho. */
export const AUX_TOOL_REQUIREMENTS: Record<AuxTool, { readOnly: boolean; webSearch: boolean }> = {
  explore: { readOnly: true, webSearch: false },
  read_slice: { readOnly: true, webSearch: false },
  run_filtered: { readOnly: false, webSearch: false },
  web_lookup: { readOnly: true, webSearch: true },
};

/** Prefixo do par de env de cada tool: <prefixo>_ENGINE e <prefixo>_MODEL. */
export const AUX_TOOL_ENV: Record<AuxTool, string> = {
  explore: "POLYAGENT_EXPLORE",
  read_slice: "POLYAGENT_READ_SLICE",
  run_filtered: "POLYAGENT_RUN_FILTERED",
  web_lookup: "POLYAGENT_WEB_LOOKUP",
};

const ENGINES = Object.keys(ENGINE_CAPABILITIES) as Engine[];

function parseEngine(raw: string, source: string): Engine {
  if ((ENGINES as string[]).includes(raw)) return raw as Engine;
  throw new Error(
    `engine inválida '${raw}' (${source}): use uma de ${ENGINES.join(", ")}.`,
  );
}

/**
 * Resolve (engine, modelo) de uma tool auxiliar. Precedência: parâmetro da chamada > env própria da
 * tool (POLYAGENT_<TOOL>_ENGINE/_MODEL) > default de hoje (codex + POLYAGENT_EXPLORE_MODEL, que
 * segue sendo o modelo barato de leitura das quatro). Com engine não-codex e sem modelo explícito
 * devolve `undefined`: o modelo default é um id de codex, mandá-lo para grok/claude falharia —
 * melhor deixar o CLI usar o próprio default.
 *
 * Recusa, nomeando o motivo, engine que não atenda o requisito da tool (read-only, web search).
 * Função pura: `env` e `sandboxOn` são injetados para teste.
 */
export function resolveAuxTool(
  tool: AuxTool,
  params: { engine?: string; model?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
  sandboxOn = SANDBOX_ON,
): { engine: Engine; model: string | undefined } {
  const prefix = AUX_TOOL_ENV[tool];
  const engine = params.engine
    ? parseEngine(params.engine, `parâmetro engine de ${tool}`)
    : env[`${prefix}_ENGINE`]
      ? parseEngine(env[`${prefix}_ENGINE`] as string, `${prefix}_ENGINE`)
      : "codex";

  const req = AUX_TOOL_REQUIREMENTS[tool];
  if (req.readOnly) assertReadOnlyEngine(tool, engine, sandboxOn);
  if (req.webSearch && !ENGINE_CAPABILITIES[engine].webSearch) {
    throw new Error(
      `${tool} exige web search e a engine '${engine}' não tem: só o codex lê o campo web ` +
      "(-c tools.web_search=true); as demais o ignoram silenciosamente. Use engine 'codex'.",
    );
  }

  const defaultModel = engine === "codex"
    ? env.POLYAGENT_EXPLORE_MODEL ?? EXPLORE_MODEL_FALLBACK
    : undefined;
  return { engine, model: params.model ?? env[`${prefix}_MODEL`] ?? defaultModel };
}

/** Cota do plano acabou (trocar de engine resolve) versus throttle transitório (só esperar resolve). */
export type QuotaErrorKind = "quota_exhausted" | "rate_limited";

/** Os três canais de uma falha de processo. O sinal de cota vive em stdout, não em stderr. */
export interface CliFailureOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function stringField(obj: JsonObject | undefined, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Aceita objeto único (grok/claude) ou JSONL (codex); linhas não-JSON são ruído e são puladas. */
function parseJsonObjects(raw: string): JsonObject[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const whole = record(JSON.parse(trimmed));
    if (whole) return [whole];
  } catch { /* pode ser JSONL */ }

  const objects: JsonObject[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const value = record(JSON.parse(line));
      if (value) objects.push(value);
    } catch { /* ruído não JSON */ }
  }
  return objects;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") { out.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) collectStrings(item, out); return; }
  const obj = record(value);
  if (obj) for (const item of Object.values(obj)) collectStrings(item, out);
}

/**
 * Desaninha um JSON serializado DENTRO de uma string. É assim que o grok entrega o sinal: o
 * `http_status` real chega como texto dentro de `errors[0]` ("Internal error: { ... }"), não como
 * campo de primeiro nível — sem desaninhar, o 402 observado em runtime passa despercebido.
 */
function unnestJson(text: string): JsonObject | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return record(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return undefined;
  }
}

/** Todos os http_status visíveis: campo de primeiro nível ou aninhado como texto em qualquer string. */
function httpStatuses(objects: JsonObject[]): number[] {
  const out: number[] = [];
  const strings: string[] = [];
  for (const obj of objects) {
    if (typeof obj.http_status === "number") out.push(obj.http_status);
    collectStrings(obj, strings);
  }
  for (const text of strings) {
    const nested = unnestJson(text);
    if (nested && typeof nested.http_status === "number") out.push(nested.http_status);
  }
  return out;
}

function normalizeErrorText(value: string): string {
  return value.replace(/[‘’]/g, "'").toLowerCase();
}

/**
 * Padrões de cota esgotada por engine. Origem e confiança diferem e isso importa: o grok foi
 * OBSERVADO em runtime (2026-09-13), o codex teve a string confirmada em runtime, e o claude vem
 * só do fonte/binário — ainda sem captura. Nada de regex genérica ("exceeded", "429" solto): um
 * padrão frouxo classifica auth expirado como cota e esconde o remédio real (re-autenticar).
 */
const QUOTA_PATTERNS: Record<Engine, RegExp[]> = {
  codex: [
    /\byou've hit your usage limit\b/,
    /\byour workspace is out of credits\b/,
    /\byou hit your spend cap\b/,
  ],
  grok: [/\bgrok build usage balance exhausted\b/],
  claude: [
    /\busage limit reached\b/,
    /\byou've reached your usage limit\b/,
    /\byou've hit your (?:session|weekly|opus|sonnet) limit\b/,
    /\bspend limit reached\b/,
    /\bcredit balance (?:is )?too low\b/,
  ],
  // Nenhuma captura de cota do cursor-agent existe; o que foi observado nele é erro de auth.
  cursor: [],
};

/** Throttle transitório — distinto de cota. A mensagem correspondente pede espera, nunca troca. */
const RATE_LIMIT_PATTERNS: Record<Engine, RegExp[]> = {
  codex: [/\brate limit exceeded\b/],
  grok: [],
  claude: [
    /\bserver is temporarily limiting requests\b/,
    /\brequest rejected \(429\)\b/,
  ],
  cursor: [],
};

/**
 * Classifica a causa de uma falha de processo: cota esgotada, rate limit, ou nada (null).
 * Lê primeiro campos JSON estruturados e só depois aplica regex sobre as mensagens de erro
 * extraídas — os CLIs emitem o JSON útil em stdout, e o exit code só distingue sucesso de falha.
 * Um padrão que não casa devolve null e a falha propaga crua: classificar errado é pior que não
 * classificar (ver ADENDO 3 do spike — auth expirado tratado como cota mascarou um bug do bridge).
 * Função pura. Padrões: .ralph/mcp-bridge-v2/spikes/quota-patterns.md (com os três adendos).
 */
export function classifyQuotaError(output: CliFailureOutput, engine: Engine): QuotaErrorKind | null {
  // Guarda contra uma resposta bem-sucedida que apenas mencione essas mensagens.
  if (output.exitCode === 0) return null;

  const objects = parseJsonObjects(output.stdout);
  const serialized = normalizeErrorText(JSON.stringify(objects));
  let structuredRateLimit = false;

  if (engine === "grok") {
    const statuses = httpStatuses(objects);
    if (statuses.includes(402)) return "quota_exhausted";
    if (statuses.includes(429)) structuredRateLimit = true;
    if (serialized.includes("subscription:free-usage-exhausted")) return "quota_exhausted";
  }
  // Campos tipados do codex: ausentes no `exec --json` de hoje, aceitos se uma versão futura os expuser.
  if (engine === "codex") {
    if (/usage_limit_exceeded|quota_exceeded/.test(serialized)) return "quota_exhausted";
    if (/rate_limit_exceeded/.test(serialized)) structuredRateLimit = true;
  }

  const messages: string[] = [output.stderr];
  for (const obj of objects) {
    const nestedError = record(obj.error);
    const payload = record(obj.payload);

    if (engine === "codex") {
      if (obj.type === "error") messages.push(stringField(obj, "message") ?? "");
      if (obj.type === "turn.failed") messages.push(stringField(nestedError, "message") ?? "");
      if (payload?.type === "error") messages.push(stringField(payload, "message") ?? "");
    }

    if (engine === "grok") {
      if (obj.type === "error") messages.push(stringField(obj, "message") ?? "");
      // O JSON headless atual não expõe o -32003 do ACP; aceita se isso voltar.
      if (obj.code === -32003) structuredRateLimit = true;
      if (Array.isArray(obj.errors)) {
        messages.push(...obj.errors.filter((v): v is string => typeof v === "string"));
      }
    }

    if (engine === "claude") {
      const isTerminalError = obj.is_error === true || obj.type === "error";
      if (obj.type === "rate_limit_event" && record(obj.rate_limit_info)?.status === "rejected") {
        return "quota_exhausted";
      }
      // system/api_retry é intermediário; sozinho não é causa terminal.
      if (isTerminalError && obj.api_error_status === 429) structuredRateLimit = true;
      if (stringField(nestedError, "type") === "rate_limit_error") structuredRateLimit = true;
      if (isTerminalError) {
        messages.push(stringField(obj, "result") ?? "", stringField(nestedError, "message") ?? "");
        if (Array.isArray(obj.errors)) {
          messages.push(...obj.errors.filter((v): v is string => typeof v === "string"));
        }
      }
    }
  }
  // Se o processo quebrou antes de emitir JSON válido, ainda permite o fallback textual.
  if (objects.length === 0) messages.push(output.stdout);

  const text = normalizeErrorText(messages.join("\n"));
  if (QUOTA_PATTERNS[engine].some((pattern) => pattern.test(text))) return "quota_exhausted";
  if (structuredRateLimit || RATE_LIMIT_PATTERNS[engine].some((pattern) => pattern.test(text))) {
    return "rate_limited";
  }
  return null;
}

/** As tools que passam por runCursor. Define a FORMA da sugestão no erro de cota. */
export type BridgeTool =
  | AuxTool | "delegate" | "fast_delegate" | "fan_out" | "generate_image" | "follow_up";

/**
 * Erro de cota/rate limit. Nunca dispara retry automático: só a falha de AMBIENTE do codex
 * (isCodexEnvError) entra no FALLBACK_ENGINE_ORDER. Trocar de engine por conta própria diante de
 * cota gastaria a próxima assinatura sem o usuário decidir; diante de rate limit, nem resolveria.
 */
export class QuotaError extends Error {
  constructor(
    readonly kind: QuotaErrorKind,
    readonly engine: Engine,
    message: string,
  ) {
    super(message);
    this.name = "QuotaError";
  }
}

/**
 * Engines que o usuário pode realmente usar depois da cota estourar: instaladas, habilitadas
 * (cursor só sob POLYAGENT_ENABLE_CURSOR) e capazes do que a tool exige — nunca sugerir uma engine
 * que a resolução daquela tool recusaria em seguida. `has`/`cursorEnabled`/`sandboxOn` injetados
 * para teste, mesmo padrão de resolveTier.
 */
export function quotaCandidates(
  tool: BridgeTool | undefined,
  exhausted: Engine,
  has: (e: Engine) => boolean = hasEngine,
  cursorEnabled: boolean = CURSOR_ENABLED,
  sandboxOn: boolean = SANDBOX_ON,
): Engine[] {
  const req = tool === undefined
    ? undefined
    : (AUX_TOOL_REQUIREMENTS as Partial<Record<BridgeTool, { readOnly: boolean; webSearch: boolean }>>)[tool];
  return ENGINES.filter((engine) => {
    if (engine === exhausted || !has(engine)) return false;
    if (engine === "cursor" && !cursorEnabled) return false;
    // generate_image roda só nas engines com tool de imagem keyless própria (image_gen/grok-build).
    if (tool === "generate_image") return IMAGE_ENGINES.includes(engine);
    if (!req) return true;
    const cap = ENGINE_CAPABILITIES[engine];
    if (req.webSearch && !cap.webSearch) return false;
    if (req.readOnly && !cap.engineReadOnly && !sandboxOn) return false;
    return true;
  });
}

/** Engines com tool de imagem própria — as únicas que generate_image sabe usar. */
const IMAGE_ENGINES: Engine[] = ["codex", "grok"];

/** Menor nível do delegate (1-5) cuja engine primária está entre as candidatas. */
function lowestLevelFor(candidates: Engine[]): number | undefined {
  for (const level of Object.keys(TIERS).map(Number).sort((a, b) => a - b)) {
    if (candidates.includes(TIERS[level].primary.engine)) return level;
  }
  return undefined;
}

/**
 * Erro acionável: nomeia a engine que estourou, as que sobraram e COMO trocar — a sugestão segue a
 * superfície da tool (parâmetro `engine` nas auxiliares, `level` no delegate, nenhum onde a tool
 * escolhe sozinha). Rate limit não sugere troca nenhuma: é espera, não engine errada. Função pura.
 */
export function quotaErrorMessage(
  kind: QuotaErrorKind,
  engine: Engine,
  tool: BridgeTool | undefined,
  candidates: Engine[],
): string {
  if (kind === "rate_limited") {
    return `${engine} rate limited — this is a transient throttle, not an exhausted plan quota: ` +
      "wait and retry the same engine. Switching engines does not help here.";
  }
  if (candidates.length === 0) {
    return `${engine} quota exhausted — no other engine is available for ${tool ?? "this tool"} ` +
      "(installed, enabled and capable of what this tool requires). " +
      `Top up or switch plans on ${engine}, or install another CLI.`;
  }

  const head = `${engine} quota exhausted — available engines: ${candidates.join(", ")}`;
  if (tool === "delegate") {
    const level = lowestLevelFor(candidates);
    return level === undefined ? head : `${head} — retry with level:${level}`;
  }
  if (tool === "follow_up") {
    return `${head} — follow_up is pinned to the engine of the resumed session; ` +
      "start a new call on another engine instead of retrying here.";
  }
  if (tool === "fast_delegate" || tool === "fan_out") {
    return `${head} — this tool picks the engine itself and exposes no engine parameter.`;
  }
  // generate_image tem parâmetro engine, mas só entre codex e grok — a lista já está restrita a essas.
  if (tool === "generate_image") return `${head} — generate_image runs on codex or grok only.`;
  // Sem tool declarada não há superfície conhecida para sugerir — nomeia as engines e para por aí.
  return tool === undefined ? head : `${head} — retry with engine:"${candidates[0]}"`;
}

/** Cria os dirs efêmeros e sonda os paths existentes pra montar o SandboxSpec. */
export function buildSandboxSpec(
  workspace: string,
  engine: Engine,
  workspaceRo = false,
): { spec: SandboxSpec; cleanup: () => void } {
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
    workspaceRo,
    systemRo: SANDBOX_SYSTEM_RO.filter((p) => existsSync(p)),
    // base (toolchains + cursor auth) + os subpaths RO específicos do engine (auth/libs do CLI)
    homeRo: [...SANDBOX_HOME_RO, ...SANDBOX_ENGINE_RO[engine]].map(abs).filter((p) => existsSync(p)),
    homeRw: [
      ...[...SANDBOX_HOME_RW, ...SANDBOX_ENGINE_RW[engine]].map(abs),
      // Apps externos (ex.: orca) roteiam múltiplas contas do codex setando CODEX_HOME pra fora do
      // ~/.codex bindado acima. Sem isso, o sandbox esconde a conta ativa (isoHome cobre $HOME) e o
      // codex falha ao inicializar (CODEX_HOME inexistente, ou "Read-only file system" — ver
      // isCodexEnvError). Só o engine codex precisa enxergá-lo, e só se o path existir de fato.
      ...(engine === "codex" && process.env.CODEX_HOME ? [process.env.CODEX_HOME] : []),
    ].filter((p) => existsSync(p)),
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
  /**
   * Tool que originou o run. Não muda a execução: define a forma da sugestão no erro de cota
   * (parâmetro `engine` nas auxiliares, `level` no delegate, nenhuma onde a tool escolhe sozinha).
   */
  tool?: BridgeTool;
}

/**
 * Always-on terse-style addendum injected into every worker's native additive system-prompt
 * channel (agentPrompt) to reduce output token cost — the project's core context-economy goal.
 * LITE intensity: keeps articles/full sentences, drops filler/hedging/narration.
 */
export const TERSE_STYLE = [
  "Reply tersely: drop filler, hedging, pleasantries, and narration of what you are about to do",
  "before doing it. Fragments are fine. Short synonyms over long phrasing. Keep ALL technical",
  "substance verbatim — code blocks, function/API names, CLI commands, exact error strings. No",
  "emoji, no decorative tables. Never announce or name this style. For security warnings or",
  "irreversible-action confirmations, answer normally then resume terseness.",
].join(" ");

/** Prepends TERSE_STYLE to an optional existing agent persona prompt. */
export function withTerseStyle(agentPrompt?: string): string {
  return agentPrompt ? `${TERSE_STYLE}\n\n${agentPrompt}` : TERSE_STYLE;
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
export function buildCodexArgs(opts: RunOpts, sandboxed = false): string[] {
  // --ignore-user-config: NÃO carrega ~/.codex/config.toml (que traz MCP servers externos — o codex
  // pendurava tentando conectá-los até timeout, subindo N processos). --ignore-rules: idem para .rules.
  // Auth continua via CODEX_HOME. Isso complementa o sandbox (defense-in-depth).
  const flags = ["--json", "--ignore-user-config", "--ignore-rules"];
  // read-only (explore/read_slice/web_lookup). Se o cursor-bridge JÁ envolve o codex em bwrap
  // (`sandboxed`), o read-only vem do `--ro-bind` do workspace (buildSandboxArgs): usar o sandbox
  // INTERNO do codex (`-s read-only`) aninharia um namespace DENTRO do bwrap e quebra com
  // "bwrap: No permissions to create new namespace". Então bypass o sandbox do codex e confia no
  // bwrap externo. SEM bwrap externo (sandbox off), usa o `-s read-only` do codex (não há o que
  // aninhar). Sem mode (delegate/generate_image) → bypass total.
  if (opts.mode && !sandboxed) flags.push("-s", "read-only", "-c", 'approval_policy="never"');
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
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.agentPrompt) args.push("--append-system-prompt", opts.agentPrompt); // canal nativo do claude
  // Headless PRECISA auto-aprovar ou pendura esperando confirmação (inclusive `--permission-mode plan`,
  // que trava pedindo aprovação do plano). force (delegate) e mode read-only rodam não-interativos →
  // skip-permissions. O read-only "duro" do mode fica com o codex (-s read-only); no claude ele é
  // read-only por prompt + sandbox (o worker é instruído a não editar e o sandbox contém o raio ao cwd).
  if (FORCE || opts.force || opts.mode) args.push("--dangerously-skip-permissions");
  if (opts.resume) args.push("--resume", opts.resume);
  args.push(opts.prompt);
  return args;
}

/** Despacha a montagem de args pelo engine. `sandboxed` = o bridge vai envolver em bwrap (afeta codex). */
export function buildArgs(engine: Engine, opts: RunOpts, sandboxed = false): string[] {
  if (engine === "grok") return buildGrokArgs(opts);
  if (engine === "codex") return buildCodexArgs(opts, sandboxed);
  if (engine === "claude") return buildClaudeArgs(opts);
  return buildCursorArgs(opts);
}

export interface CliResult {
  text: string;
  sessionId?: string;
  engine?: Engine;
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
 * read_slice) reaproveita o modelo do nível 1 (gpt-5.6-luna). Níveis 1/3 usam Codex Luna/Sol,
 * 2/4 usam Grok 4.5/4.6, e 5 usa Claude Opus.
 */
const TIERS: Record<number, TierEntry> = {
  1: { primary: { engine: "codex", model: "gpt-5.6-luna", effort: "max" }, cursorModel: "gpt-5.6-luna-max-fast" },
  2: { primary: { engine: "grok", model: "grok-4.5", effort: "high" }, cursorModel: "cursor-grok-4.5-high-fast" },
  3: { primary: { engine: "codex", model: "gpt-5.6-sol", effort: "xhigh" }, cursorModel: "gpt-5.6-sol-xhigh-fast" },
  4: { primary: { engine: "grok", model: "grok-4.6", effort: "high" }, cursorModel: "grok-4.6-high-fast" },
  5: { primary: { engine: "claude", model: "opus", effort: "max" }, cursorModel: "claude-opus-max-fast" },
};

/**
 * Health mínimo (0-1) pra considerar uma engine viável num tier. Abaixo disso, trata como indisponível.
 * Exportado só pra teste: um teste de invariante em test/usage.test.ts prova que LATENCY_FLOOR
 * (src/usage.ts) fica acima disso, senão latência sozinha (sem nenhuma falha) volta a derrubar uma
 * engine — era exatamente o bug original.
 */
export const HEALTH_THRESHOLD = 0.3;

/**
 * Ordem de velocidade observada (mais rápido primeiro), independente de nível de dificuldade —
 * usada por fast_delegate para sempre pegar a engine/modelo mais rápido disponível e saudável,
 * sem escolha manual de nível. Grok, mesmo em modelos "rápidos", mostrou latência de vários
 * minutos em runs reais bem-sucedidos (ver POLYAGENT_LOG) — por isso fica por último entre
 * as engines nativas; cursor só entra como fallback final, igual ao resolveTier.
 */
export const FAST_CANDIDATES: Tier[] = [
  { engine: "codex", model: "gpt-5.6-luna", effort: "low" },
  { engine: "claude", model: "haiku" },
  { engine: "grok", model: "grok-4.5", effort: "low" },
];

/**
 * Resolve a engine mais rápida instalada E saudável, sem nível — primeira candidata de
 * FAST_CANDIDATES que passar em has()+healthy(). Cai pro cursor-agent (DEFAULT_MODEL) só quando
 * nenhuma engine nativa está disponível/saudável E cursorEnabled; senão lança erro claro listando
 * o que falta. `has`/`cursorEnabled`/`health` são injetados para teste, mesmo padrão de resolveTier.
 */
export function resolveFastTier(
  has: (e: Engine) => boolean = hasEngine,
  cursorEnabled: boolean = CURSOR_ENABLED,
  health?: Record<string, number>,
): Tier {
  const healthy = (e: Engine): boolean => health === undefined || (health[e] ?? 1) >= HEALTH_THRESHOLD;
  for (const candidate of FAST_CANDIDATES) {
    if (has(candidate.engine) && healthy(candidate.engine)) return candidate;
  }
  if (cursorEnabled && healthy("cursor")) return { engine: "cursor", model: DEFAULT_MODEL };
  const anyInstalled = FAST_CANDIDATES.some((c) => has(c.engine));
  const reason = anyInstalled
    ? "they are installed but unhealthy (recent failures/timeouts) — retry later or use delegate with an explicit level"
    : "none of them is installed";
  const cursorNote = cursorEnabled
    ? " The cursor-agent fallback is also unhealthy."
    : " Set POLYAGENT_ENABLE_CURSOR=1 to fall back to cursor-agent.";
  throw new Error(
    `fast_delegate needs at least one healthy CLI among codex, claude, or grok, but ${reason}.${cursorNote}`,
  );
}

/**
 * Roteia o nível (1-5) para (engine, modelo, effort). Usa a engine preferida do nível se instalada
 * E saudável (quando `health` é passado — ver computeEngineHealth em src/usage.ts). Se faltar ou
 * estiver unhealthy: cai para o cursor-agent equivalente SÓ quando CURSOR_ENABLED E o próprio cursor
 * está saudável; senão lança erro claro. `has`/`cursorEnabled`/`health` são injetados para teste.
 * `health` omitido preserva o comportamento anterior (toda engine é tratada como saudável).
 */
export function resolveTier(
  level: number,
  has: (e: Engine) => boolean = hasEngine,
  cursorEnabled: boolean = CURSOR_ENABLED,
  health?: Record<string, number>,
): Tier {
  const entry = TIERS[level];
  if (!entry) throw new Error(`invalid delegate level: received ${level}, expected integer 1-5`);
  const healthy = (e: Engine): boolean => health === undefined || (health[e] ?? 1) >= HEALTH_THRESHOLD;
  if (has(entry.primary.engine) && healthy(entry.primary.engine)) return entry.primary;
  if (cursorEnabled && healthy("cursor")) return { engine: "cursor", model: entry.cursorModel };
  const reason = has(entry.primary.engine) ? "is unhealthy (recent failures/timeouts)" : "is not installed";
  throw new Error(
    `delegate level ${level} needs the '${entry.primary.engine}' CLI, which ${reason}. ` +
    "Install it, pick another level, or set POLYAGENT_ENABLE_CURSOR=1 to fall back to cursor-agent.",
  );
}

/**
 * Tier-integrity receipt: true se `engine` é a engine PADRÃO (preferida) do nível — false quando
 * resolveTier caiu no fallback (ex.: cursor) ou o nível é inválido. Usado pelo usage log para emitir
 * o "matched_request" do trust layer (src/usage.ts), sem acoplar usage.ts à matriz TIERS.
 */
export function isDefaultTierEngine(level: number, engine: Engine): boolean {
  return TIERS[level]?.primary.engine === engine;
}

/**
 * Resolve com o primeiro sucesso da lista, ignorando rejeições (usadas pelo `fan_out` em modo
 * "race" para não esperar os engines mais lentos). Só rejeita se TODAS as promises rejeitarem.
 * Função pura e genérica — testável sem spawnar processo.
 */
export function raceFirstSuccess<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise((resolve, reject) => {
    let remaining = promises.length;
    for (const p of promises) {
      p.then(resolve).catch(() => {
        remaining -= 1;
        if (remaining === 0) reject(new Error("all promises rejected"));
      });
    }
  });
}

/**
 * Subconjunto de RunOpts seguro para retomar num OUTRO engine depois de uma falha de ambiente.
 * ALLOWLIST deliberada (não blocklist): um campo só atravessa pro fallback se listado aqui, então
 * uma opção nova ou esquecida em RunOpts nunca vaza por omissão. Campos excluídos e o porquê:
 * - model/effort: escolha feita pro codex; o fallback usa o default do próprio engine.
 * - mode: vira `--ro-bind` do workspace em buildSandboxSpec, mas só o codex tem `-s read-only`
 *   pra honrar isso sem quebrar — grok guarda sessão indexada pelo cwd e falha ("Read-only file
 *   system") tentando criar a sessão se o cwd virou somente-leitura. Foi exatamente este bug.
 * - resume: id de sessão no formato/namespace do engine original; não existe no fallback.
 * - images: hoje só generate_image usa (`-i`, exclusivo codex); grok/claude ignoram silenciosamente
 *   o valor, o que dropa a imagem de entrada sem avisar — pior que falhar.
 */
export function fallbackOpts(opts: RunOpts, engine: Engine): RunOpts {
  const { prompt, cwd, timeoutMs, force, web, agentPrompt } = opts;
  return { prompt, cwd, timeoutMs, force, web, agentPrompt, engine };
}

/** Roda o CLI do engine em modo headless e devolve o resultado parseado. */
export function runCursor(opts: RunOpts): Promise<CliResult> {
  const runOnce = (runOpts: RunOpts): Promise<CliResult> => {
    const engine = runOpts.engine ?? "cursor";
    const bin = engine === "grok" ? GROK_BIN
      : engine === "codex" ? CODEX_BIN
      : engine === "claude" ? CLAUDE_BIN
      : POLYAGENT_CURSOR_BIN;
    const workspace = runOpts.cwd ?? process.cwd();

    // O sandbox bwrap ($HOME isolado) é OBRIGATÓRIO para TODOS os engines — nenhum modelo roda fora
    // dele. Isola a config global de cada CLI (~/.cursor/rules, ~/.grok/config.toml, ~/.codex/config)
    // que carregava rules/MCP servers, inflando tokens.
    const bwrap = SANDBOX_ON ? bwrapPath() : null;
    // `!!bwrap`: com bwrap externo, o read-only do codex vem do --ro-bind do workspace — NÃO do sandbox
    // interno do codex, que aninharia um namespace dentro do bwrap e quebraria. Ver buildCodexArgs.
    const engineArgs = buildArgs(engine, runOpts, !!bwrap);
    let cmd = bin;
    let args = engineArgs;
    let cleanup = () => {};
    if (bwrap) {
      const built = buildSandboxSpec(workspace, engine, !!runOpts.mode);
      cleanup = built.cleanup;
      cmd = bwrap;
      args = [...buildSandboxArgs(built.spec), bin, ...engineArgs];
    } else if (SANDBOX_ON) {
      // Sem degradação implícita: o bwrap sumiu do PATH depois do preflight, então a chamada falha.
      // Rejeita em vez de lançar síncrono — runCursor encadeia .catch() sobre o retorno de runOnce.
      return Promise.reject(new Error(BWRAP_MISSING));
    }
    if (DEBUG) process.stderr.write(`[cursor-bridge:debug] ${cmd} ${args.map((a) => JSON.stringify(a)).join(" ")}\n`);

    return new Promise((resolve, reject) => {
      // stdin fechado ("ignore"): o `codex exec` fica pendurado ("Reading additional input from
      // stdin...") se o stdin for um pipe aberto. cursor/grok recebem o prompt por arg e não usam stdin.
      const child = spawn(cmd, args, { cwd: workspace, env: process.env, stdio: ["ignore", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";
      const timeoutMs = runOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
          reject(new ProcessError(
            `${engine} agent exited ${code}: ${stderr.trim() || stdout.trim()}`,
            stdout,
            stderr,
            code,
          ));
          return;
        }
        resolve({ ...parseOutput(engine, stdout), engine });
      });
    });
  };

  const engine = opts.engine ?? "cursor";
  /**
   * Converte a falha crua em erro acionável quando a causa é cota/rate limit. Distinto de
   * isCodexEnvError de propósito: só a falha de AMBIENTE entra no FALLBACK_ENGINE_ORDER automático;
   * cota nunca retenta sozinha — quem decide a troca (e gasta a próxima assinatura) é o usuário.
   */
  const asQuotaError = (err: unknown, failedEngine: Engine): unknown => {
    if (!(err instanceof ProcessError)) return err;
    const kind = classifyQuotaError(
      { stdout: err.stdout, stderr: err.stderr, exitCode: err.exitCode },
      failedEngine,
    );
    if (!kind) return err;
    const candidates = quotaCandidates(opts.tool, failedEngine);
    return new QuotaError(kind, failedEngine, quotaErrorMessage(kind, failedEngine, opts.tool, candidates));
  };

  return runOnce(opts).catch((originalError: unknown) => {
    const message = originalError instanceof Error ? originalError.message : String(originalError);
    if (engine !== "codex" || !message.startsWith("codex agent exited ") || !isCodexEnvError(message)) {
      throw asQuotaError(originalError, engine);
    }

    const candidates: Engine[] = [
      ...FALLBACK_ENGINE_ORDER.filter((candidate) => candidate !== "codex"),
      ...(CURSOR_ENABLED ? ["cursor" as const] : []),
    ];
    const fallback = candidates.find((candidate) => hasEngine(candidate));
    if (!fallback) throw originalError;

    return runOnce(fallbackOpts(opts, fallback)).catch((fallbackError: unknown) => {
      throw asQuotaError(fallbackError, fallback);
    }).then((result) => ({
      ...result,
      text: result.text +
        `\n\n[note: codex unavailable (environment issue — missing CODEX_HOME or read-only app-server init) — retried on ${fallback} with its default model]`,
    }));
  });
}
