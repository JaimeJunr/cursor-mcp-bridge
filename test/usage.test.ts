import { describe, it, expect } from "vitest";
import { aggregate, type UsageEntry } from "../src/usage.js";

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
