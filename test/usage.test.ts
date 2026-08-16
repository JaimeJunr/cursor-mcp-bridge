import { describe, it, expect } from "vitest";
import { aggregate, buildUsageEntry, classifyOutcome, computeEngineHealth, type UsageEntry } from "../src/usage.js";

describe("aggregate", () => {
  it("sums calls and returned chars per tool", () => {
    const entries: UsageEntry[] = [
      { ts: 1, tool: "read_slice", outChars: 100 },
      { ts: 2, tool: "read_slice", outChars: 300 },
      { ts: 3, tool: "explore", outChars: 50 },
    ];
    const stats = aggregate(entries);
    expect(stats.read_slice).toEqual({ calls: 2, totalOutChars: 400, avgOutChars: 200 });
    expect(stats.explore).toEqual({ calls: 1, totalOutChars: 50, avgOutChars: 50 });
  });

  it("returns empty object for no entries", () => {
    expect(aggregate([])).toEqual({});
  });
});

describe("buildUsageEntry (tier-integrity receipt)", () => {
  it("includes requestedLevel and matchedRequest=true for the normal tier match", () => {
    const entry = buildUsageEntry("delegate", 120, { requestedLevel: 1, matchedRequest: true });
    expect(entry.requestedLevel).toBe(1);
    expect(entry.matchedRequest).toBe(true);
    expect(entry.tool).toBe("delegate");
    expect(entry.outChars).toBe(120);
  });

  it("marks matchedRequest=false when the tier fell back (e.g. to cursor)", () => {
    const entry = buildUsageEntry("delegate", 120, { requestedLevel: 1, matchedRequest: false });
    expect(entry.requestedLevel).toBe(1);
    expect(entry.matchedRequest).toBe(false);
  });

  it("omits tier fields when no tier info is given (non-tiered tools like explore)", () => {
    const entry = buildUsageEntry("explore", 80);
    expect(entry).not.toHaveProperty("requestedLevel");
    expect(entry).not.toHaveProperty("matchedRequest");
  });

  it("includes engine, outcome and durationMs when given a run", () => {
    const entry = buildUsageEntry(
      "delegate",
      120,
      { requestedLevel: 1, matchedRequest: true },
      { engine: "codex", outcome: "success", durationMs: 42 },
    );
    expect(entry.engine).toBe("codex");
    expect(entry.outcome).toBe("success");
    expect(entry.durationMs).toBe(42);
    expect(entry.requestedLevel).toBe(1);
    expect(entry.matchedRequest).toBe(true);
  });

  it("omits run fields when no run is given", () => {
    const entry = buildUsageEntry("delegate", 120, { requestedLevel: 1, matchedRequest: true });
    expect(entry).not.toHaveProperty("engine");
    expect(entry).not.toHaveProperty("outcome");
    expect(entry).not.toHaveProperty("durationMs");
  });
});

describe("classifyOutcome", () => {
  it("detects timeout from runCursor's setTimeout reject message", () => {
    expect(classifyOutcome(new Error("codex agent timed out after 1800000ms: "))).toBe("timeout");
    expect(classifyOutcome(new Error("grok agent timed out after 5000ms: hung"))).toBe("timeout");
  });

  it("classifies non-timeout errors as failure", () => {
    expect(classifyOutcome(new Error("codex agent exited 1: boom"))).toBe("failure");
    expect(classifyOutcome(new Error("failed to spawn 'codex': ENOENT"))).toBe("failure");
    expect(classifyOutcome("string error")).toBe("failure");
    expect(classifyOutcome(null)).toBe("failure");
  });
});

describe("computeEngineHealth", () => {
  const NOW = 1_000_000;
  const WINDOW = 30 * 60 * 1000;

  it("scores a consistently-failing engine low and a healthy engine high", () => {
    const records: UsageEntry[] = [
      { ts: NOW - 1000, tool: "delegate", outChars: 10, engine: "grok", outcome: "success" },
      { ts: NOW - 2000, tool: "delegate", outChars: 10, engine: "grok", outcome: "success" },
      { ts: NOW - 3000, tool: "delegate", outChars: 10, engine: "grok", outcome: "success" },
      { ts: NOW - 1000, tool: "delegate", outChars: 10, engine: "codex", outcome: "failure" },
      { ts: NOW - 2000, tool: "delegate", outChars: 10, engine: "codex", outcome: "timeout" },
      { ts: NOW - 3000, tool: "delegate", outChars: 10, engine: "codex", outcome: "failure" },
    ];
    const health = computeEngineHealth(records, NOW, WINDOW);
    expect(health.grok).toBeGreaterThan(0.8);
    expect(health.codex).toBeLessThan(0.2);
    expect(health.grok).toBeGreaterThan(health.codex);
  });

  it("weights recent records more than old ones (decay within the window)", () => {
    // Um engine que falhou há muito tempo (perto da borda da janela) mas teve sucesso recente
    // deve pontuar melhor que um que falhou recentemente e teve sucesso há muito tempo.
    const recentlyRecovered: UsageEntry[] = [
      { ts: NOW - WINDOW + 1000, tool: "delegate", outChars: 10, engine: "codex", outcome: "failure" },
      { ts: NOW - 500, tool: "delegate", outChars: 10, engine: "codex", outcome: "success" },
    ];
    const recentlyBroken: UsageEntry[] = [
      { ts: NOW - WINDOW + 1000, tool: "delegate", outChars: 10, engine: "codex", outcome: "success" },
      { ts: NOW - 500, tool: "delegate", outChars: 10, engine: "codex", outcome: "failure" },
    ];
    const recovered = computeEngineHealth(recentlyRecovered, NOW, WINDOW).codex;
    const broken = computeEngineHealth(recentlyBroken, NOW, WINDOW).codex;
    expect(recovered).toBeGreaterThan(broken);
  });

  it("drops records older than the decay window", () => {
    const records: UsageEntry[] = [
      { ts: NOW - WINDOW - 1, tool: "delegate", outChars: 10, engine: "codex", outcome: "failure" },
    ];
    expect(computeEngineHealth(records, NOW, WINDOW)).toEqual({});
  });

  it("ignores records without an engine field", () => {
    const records: UsageEntry[] = [
      { ts: NOW - 1000, tool: "explore", outChars: 10, outcome: "success" },
    ];
    expect(computeEngineHealth(records, NOW, WINDOW)).toEqual({});
  });

  it("penalizes high latency even on success", () => {
    const fast: UsageEntry[] = [
      { ts: NOW - 1000, tool: "delegate", outChars: 10, engine: "codex", outcome: "success", durationMs: 1000 },
    ];
    const slow: UsageEntry[] = [
      { ts: NOW - 1000, tool: "delegate", outChars: 10, engine: "codex", outcome: "success", durationMs: 600_000 },
    ];
    expect(computeEngineHealth(fast, NOW, WINDOW).codex).toBeGreaterThan(
      computeEngineHealth(slow, NOW, WINDOW).codex,
    );
  });

  it("returns empty object for no records", () => {
    expect(computeEngineHealth([], NOW, WINDOW)).toEqual({});
  });
});
