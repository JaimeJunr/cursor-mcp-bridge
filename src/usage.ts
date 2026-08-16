import { appendFileSync, readFileSync } from "node:fs";

/** Arquivo de log de uso (JSONL). Logging só acontece se esta env estiver setada. */
export const USAGE_LOG = process.env.CURSOR_BRIDGE_LOG;

export interface UsageEntry {
  ts: number;
  tool: string;
  /** Chars devolvidos ao contexto do chamador — o custo real da chamada. */
  outChars: number;
  /** Tier-integrity receipt: nível pedido pelo chamador (só presente em tools com resolveTier). */
  requestedLevel?: number;
  /** true se a engine resolvida é a preferida do nível; false quando resolveTier caiu no fallback. */
  matchedRequest?: boolean;
  /** Engine que rodou a chamada (ex. "codex"|"grok"|"claude"|"cursor"). Usado por computeEngineHealth. */
  engine?: string;
  /** Resultado da chamada. Usado por computeEngineHealth para medir falha/timeout. */
  outcome?: "success" | "failure" | "timeout";
  /** Duração do run em ms. Usado por computeEngineHealth para penalizar latência alta. */
  durationMs?: number;
}

export interface ToolStats {
  calls: number;
  totalOutChars: number;
  avgOutChars: number;
}

/** Receipt do tier resolvido para o nível pedido, injetado por quem chama resolveTier (src/cli.ts). */
export interface TierReceipt {
  requestedLevel: number;
  matchedRequest: boolean;
}

/** Métricas do run (engine que rodou, resultado, duração) — populadas pelo wrap em src/index.ts. */
export interface UsageRun {
  engine?: string;
  outcome?: UsageEntry["outcome"];
  durationMs?: number;
}

/**
 * Classifica o erro rejeitado por runCursor. Timeout vem do setTimeout em cli.ts, que mata o
 * child com SIGKILL e rejeita com `<engine> agent timed out after <ms>ms: ...`. Qualquer outro
 * erro (exit ≠ 0, spawn fail) é "failure". Função pura.
 */
export function classifyOutcome(error: unknown): "failure" | "timeout" {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return /agent timed out after \d+ms/.test(msg) ? "timeout" : "failure";
}

/** Monta o UsageEntry. Função pura — separada de logUsage para ser testável sem tocar o filesystem. */
export function buildUsageEntry(tool: string, outChars: number, tier?: TierReceipt, run?: UsageRun): UsageEntry {
  return { ts: Date.now(), tool, outChars, ...tier, ...run };
}

/** Registra uma chamada no JSONL. No-op se CURSOR_BRIDGE_LOG não estiver setada. */
export function logUsage(tool: string, outChars: number, tier?: TierReceipt, run?: UsageRun): void {
  if (!USAGE_LOG) return;
  const entry = buildUsageEntry(tool, outChars, tier, run);
  try {
    appendFileSync(USAGE_LOG, JSON.stringify(entry) + "\n");
  } catch {
    // logging é best-effort; nunca derruba a chamada real.
  }
}

/** Lê e parseia o JSONL. Devolve [] se o arquivo não existir ou não houver log. */
export function readUsage(): UsageEntry[] {
  if (!USAGE_LOG) return [];
  let raw: string;
  try {
    raw = readFileSync(USAGE_LOG, "utf8");
  } catch {
    return [];
  }
  // Parse linha a linha e ignora as malformadas — uma escrita parcial ou edição
  // manual não deve zerar todas as stats.
  const out: UsageEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as UsageEntry);
    } catch {
      // pula a linha corrompida
    }
  }
  return out;
}

/** Duração (ms) acima da qual um run bem-sucedido é tratado como "no limite" (score de latência → 0). */
const LATENCY_CEIL_MS = 300_000;

/**
 * Deriva um score de saúde (0-1) por engine a partir do log de uso, dentro de uma janela de decaimento
 * (`windowMs`, default 30min). Cada registro pesa por idade dentro da janela (decaimento exponencial —
 * meia-vida de 1/4 da janela), então falhas/timeouts recentes derrubam o score mais que os antigos.
 * Combina taxa de falha/timeout (0 se outcome ruim, 1 se sucesso) com um score de latência (penaliza
 * runs bem-sucedidos mas lentos). Registros sem `engine` são ignorados — não há o que atribuir. Função
 * pura; `now` é injetado pelo chamador (src/index.ts fica com o I/O de ler o log e pegar Date.now()).
 */
export function computeEngineHealth(
  records: UsageEntry[],
  now: number,
  windowMs: number = 30 * 60 * 1000,
): Record<string, number> {
  const halfLife = windowMs / 4;
  const byEngine: Record<string, { weight: number; weightedScore: number }> = {};
  for (const r of records) {
    if (!r.engine) continue;
    const age = now - r.ts;
    if (age < 0 || age > windowMs) continue;
    const weight = Math.pow(0.5, age / halfLife);
    const outcomeScore = r.outcome === "failure" || r.outcome === "timeout" ? 0 : 1;
    const latencyScore = r.durationMs !== undefined
      ? Math.max(0, 1 - r.durationMs / LATENCY_CEIL_MS)
      : 1;
    const bucket = byEngine[r.engine] ?? { weight: 0, weightedScore: 0 };
    bucket.weight += weight;
    bucket.weightedScore += weight * outcomeScore * latencyScore;
    byEngine[r.engine] = bucket;
  }
  const out: Record<string, number> = {};
  for (const [engine, b] of Object.entries(byEngine)) {
    out[engine] = b.weight > 0 ? b.weightedScore / b.weight : 1;
  }
  return out;
}

/** Agrega entradas por tool: nº de chamadas, total e média de chars devolvidos. Função pura. */
export function aggregate(entries: UsageEntry[]): Record<string, ToolStats> {
  const out: Record<string, ToolStats> = {};
  for (const e of entries) {
    const s = out[e.tool] ?? { calls: 0, totalOutChars: 0, avgOutChars: 0 };
    s.calls += 1;
    s.totalOutChars += e.outChars;
    s.avgOutChars = Math.round(s.totalOutChars / s.calls);
    out[e.tool] = s;
  }
  return out;
}
