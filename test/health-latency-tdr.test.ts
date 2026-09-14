import { describe, it, expect } from "vitest";
import { computeEngineHealth, type UsageEntry } from "../src/usage.js";
import { resolveFastTier, resolveTier, type Engine } from "../src/cli.js";

const NOW = 1_700_000_000_000;
const WINDOW = 30 * 60 * 1000;
const TIMEOUT = 1_800_000; // DEFAULT_TIMEOUT_MS
const all: (e: Engine) => boolean = () => true;

function rec(durationMs: number): UsageEntry[] {
  return [{ ts: NOW - 1000, tool: "delegate", outChars: 10, engine: "grok", outcome: "success", durationMs }];
}

describe("regressão: latência sozinha nunca derruba uma engine abaixo do threshold", () => {
  it("sucesso de 22min (topo da faixa real observada) continua saudável", () => {
    const health = computeEngineHealth(rec(22 * 60_000), NOW, WINDOW, TIMEOUT);
    expect(health.grok).toBeGreaterThanOrEqual(0.3);
    // consequência de roteamento: grok segue disponível — zero falhas, só foi lento.
    expect(resolveTier(2, (e) => e === "grok", false, health)).toEqual({ engine: "grok", model: "grok-4.5", effort: "high" });
  });

  it("mesmo um sucesso arbitrariamente lento (10x o teto) não cruza o threshold — só failure/timeout derruba", () => {
    const health = computeEngineHealth(rec(10 * TIMEOUT), NOW, WINDOW, TIMEOUT);
    expect(health.grok).toBeGreaterThanOrEqual(0.3);
    const failing: UsageEntry[] = [
      { ts: NOW - 1000, tool: "delegate", outChars: 10, engine: "grok", outcome: "failure", durationMs: 1000 },
    ];
    expect(computeEngineHealth(failing, NOW, WINDOW, TIMEOUT).grok).toBeLessThan(0.3);
  });
});

describe("teto de latência degenerado cai pro default em vez de envenenar o score", () => {
  it("ceil=0 com durationMs=0 cai pro default e mantém o score em [0,1]", () => {
    const health = computeEngineHealth(rec(0), NOW, WINDOW, 0);
    expect(Number.isFinite(health.grok)).toBe(true);
    expect(health.grok).toBeGreaterThanOrEqual(0);
    expect(health.grok).toBeLessThanOrEqual(1);
  });

  it("ceil NaN (POLYAGENT_TIMEOUT_MS inválido) cai pro default e não envenena nenhuma engine", () => {
    const records: UsageEntry[] = [
      { ts: NOW - 1000, tool: "delegate", outChars: 1, engine: "grok", outcome: "success", durationMs: 1000 },
      { ts: NOW - 1000, tool: "delegate", outChars: 1, engine: "codex", outcome: "success", durationMs: 1000 },
      { ts: NOW - 1000, tool: "delegate", outChars: 1, engine: "claude", outcome: "success", durationMs: 1000 },
    ];
    const health = computeEngineHealth(records, NOW, WINDOW, Number(process.env.NOPE_NOT_A_NUMBER ?? "abc"));
    expect(Number.isNaN(health.grok)).toBe(false);
    expect(() => resolveFastTier(all, false, health)).not.toThrow();
  });

  it("ceil negativo cai pro default — respeita o contrato 0-1 (score <= 1)", () => {
    expect(computeEngineHealth(rec(1000), NOW, WINDOW, -1).grok).toBeLessThanOrEqual(1);
  });
});

describe("receipt de fast_delegate distingue fallback pro cursor de roteamento nativo", () => {
  it("resolveFastTier cai no cursor quando todas as nativas estão unhealthy", () => {
    const health = { codex: 0.0, claude: 0.0, grok: 0.0 };
    expect(resolveFastTier(all, true, health).engine).toBe("cursor");
    // src/index.ts computa matchedRequest via FAST_CANDIDATES.some(...) sobre esse resultado — o
    // fallback pro cursor (engine "cursor" não está em FAST_CANDIDATES) fica marcado como
    // matchedRequest:false no log de trust, diferente de um roteamento nativo bem-sucedido.
  });

  it("lança erro distinguindo instalado-mas-unhealthy de não instalado", () => {
    const unhealthy = { codex: 0, claude: 0, grok: 0 };
    expect(() => resolveFastTier(all, false, unhealthy)).toThrow(/installed but unhealthy/);
    const notInstalled: (e: Engine) => boolean = () => false;
    expect(() => resolveFastTier(notInstalled, false, undefined)).toThrow(/none of them is installed/);
  });
});
