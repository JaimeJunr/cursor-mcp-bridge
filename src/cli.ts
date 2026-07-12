import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

/** Binário do Cursor CLI. Override via env CURSOR_BIN. */
export const CURSOR_BIN = process.env.CURSOR_BIN ?? "agent";

/** Modelo default: `auto` — o Cursor escolhe o mais barato/adequado. Override via CURSOR_BRIDGE_MODEL. */
export const DEFAULT_MODEL = process.env.CURSOR_BRIDGE_MODEL ?? "auto";

/**
 * Modelo default do `explore`: `auto` — deixa a Cursor escolher o modelo ágil/barato (na prática
 * cai no composer), sem fixar um id que pode ficar lento/indisponível. A exploração (busca fan-out,
 * mapa) não escala para o modelo caro do orquestrador. Override via CURSOR_BRIDGE_EXPLORE_MODEL.
 * Só se aplica quando o chamador não passa `model` explícito.
 */
export const EXPLORE_MODEL = process.env.CURSOR_BRIDGE_EXPLORE_MODEL ?? "auto";

/** Se truthy, passa --force (roda comandos sem prompt). Default off por segurança. */
export const FORCE = ["1", "true", "yes"].includes((process.env.CURSOR_BRIDGE_FORCE ?? "").toLowerCase());

/** Timeout padrão (ms). Override via CURSOR_BRIDGE_TIMEOUT_MS. */
export const DEFAULT_TIMEOUT_MS = Number(process.env.CURSOR_BRIDGE_TIMEOUT_MS ?? 600_000);

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
/** Subpaths do HOME liberados RW: caches de build (acelera runs seguidos). */
const SANDBOX_HOME_RW = [".gradle", ".m2", ".cache/uv", ".cache/pip"];
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
function buildSandboxSpec(workspace: string): { spec: SandboxSpec; cleanup: () => void } {
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
    homeRo: SANDBOX_HOME_RO.map(abs).filter((p) => existsSync(p)),
    homeRw: SANDBOX_HOME_RW.map(abs).filter((p) => existsSync(p)),
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
  model?: string;
  effort?: string;
  resume?: string;
  /** read-only mode para discovery/analyze: "plan" | "ask". */
  mode?: "plan" | "ask";
  /** Auto-aprova as tools deste run (--force), independente do env global. web_lookup precisa. */
  force?: boolean;
  cwd?: string;
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
  args.push(opts.prompt);
  return args;
}

export interface CliResult {
  text: string;
  sessionId?: string;
}

/** Extrai texto e session_id do JSON do `agent -p --output-format json`. */
export function parseCliJson(raw: string): CliResult {
  const trimmed = raw.trim();
  try {
    const obj = JSON.parse(trimmed) as { result?: unknown; session_id?: unknown };
    return {
      text: typeof obj.result === "string" ? obj.result : trimmed,
      sessionId: typeof obj.session_id === "string" ? obj.session_id : undefined,
    };
  } catch {
    return { text: trimmed };
  }
}

/** Roda o Cursor agent em modo headless e devolve o resultado parseado. */
export function runCursor(opts: RunOpts): Promise<CliResult> {
  const cursorArgs = buildCursorArgs(opts);
  const workspace = opts.cwd ?? process.cwd();

  // Por padrão envelopa em bwrap com $HOME isolado; sem bwrap, roda direto (fallback).
  let cmd = CURSOR_BIN;
  let args = cursorArgs;
  let cleanup = () => {};
  const bwrap = SANDBOX_ON ? bwrapPath() : null;
  if (bwrap) {
    const built = buildSandboxSpec(workspace);
    cleanup = built.cleanup;
    cmd = bwrap;
    args = [...buildSandboxArgs(built.spec), CURSOR_BIN, ...cursorArgs];
  } else if (SANDBOX_ON) {
    process.stderr.write(
      "[cursor-bridge] bwrap não encontrado no PATH — rodando SEM sandbox (config global do user pode vazar). Instale com 'sudo apt install bubblewrap'.\n",
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: workspace, env: process.env });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error(`cursor agent timed out after ${DEFAULT_TIMEOUT_MS}ms`));
    }, DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`failed to spawn '${cmd}': ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      cleanup();
      if (code !== 0) {
        reject(new Error(`cursor agent exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve(parseCliJson(stdout));
    });
  });
}
