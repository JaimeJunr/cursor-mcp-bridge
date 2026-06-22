import { spawn } from "node:child_process";

/** Binário do Cursor CLI. Override via env CURSOR_BIN. */
export const CURSOR_BIN = process.env.CURSOR_BIN ?? "agent";

/** Modelo default: `auto` — o Cursor escolhe o mais barato/adequado. Override via CURSOR_BRIDGE_MODEL. */
export const DEFAULT_MODEL = process.env.CURSOR_BRIDGE_MODEL ?? "auto";

/** Se truthy, passa --force (roda comandos sem prompt). Default off por segurança. */
export const FORCE = ["1", "true", "yes"].includes((process.env.CURSOR_BRIDGE_FORCE ?? "").toLowerCase());

/** Timeout padrão (ms). Override via CURSOR_BRIDGE_TIMEOUT_MS. */
export const DEFAULT_TIMEOUT_MS = Number(process.env.CURSOR_BRIDGE_TIMEOUT_MS ?? 600_000);

export interface RunOpts {
  prompt: string;
  model?: string;
  effort?: string;
  resume?: string;
  /** read-only mode para discovery/analyze: "plan" | "ask". */
  mode?: "plan" | "ask";
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
  if (FORCE) args.push("--force");
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
  const args = buildCursorArgs(opts);
  return new Promise((resolve, reject) => {
    const child = spawn(CURSOR_BIN, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cursor agent timed out after ${DEFAULT_TIMEOUT_MS}ms`));
    }, DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn '${CURSOR_BIN}': ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`cursor agent exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve(parseCliJson(stdout));
    });
  });
}
