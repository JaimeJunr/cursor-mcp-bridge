import { appendFileSync, readFileSync } from "node:fs";

/** Arquivo de log de uso (JSONL). Logging só acontece se esta env estiver setada. */
export const USAGE_LOG = process.env.CURSOR_BRIDGE_LOG;

export interface UsageEntry {
  ts: number;
  tool: string;
  /** Chars devolvidos ao contexto do chamador — o custo real da chamada. */
  outChars: number;
}

export interface ToolStats {
  calls: number;
  totalOutChars: number;
  avgOutChars: number;
}

/** Registra uma chamada no JSONL. No-op se CURSOR_BRIDGE_LOG não estiver setada. */
export function logUsage(tool: string, outChars: number): void {
  if (!USAGE_LOG) return;
  const entry: UsageEntry = { ts: Date.now(), tool, outChars };
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
