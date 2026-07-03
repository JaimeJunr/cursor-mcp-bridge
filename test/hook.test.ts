import { describe, it, expect } from "vitest";
// @ts-expect-error — hook is plain .mjs sem types; só a lógica pura importa aqui.
import { decide } from "../hooks/prefer-cursor-bridge.mjs";

/** fs falso: N linhas num arquivo "grande o suficiente" em bytes mas abaixo do teto. */
const fakeFs = (lines: number) => ({
  statSync: () => ({ size: 1000 }),
  readFileSync: () => "a\n".repeat(Math.max(lines - 1, 0)) + "a",
  minLines: 300,
});

describe("decide — web tools", () => {
  it("nudges web_lookup on WebSearch and carries the one-time preload reminder", () => {
    const res = decide({ tool_name: "WebSearch", tool_input: {}, seen: new Set() });
    expect(res.keys).toContain("web");
    expect(res.keys).toContain("preload");
    expect(res.text).toMatch(/web_lookup/);
    expect(res.text).toMatch(/ToolSearch|deferred/);
  });

  it("dedups: WebSearch já nudado nesta sessão → null", () => {
    const res = decide({ tool_name: "WebFetch", tool_input: {}, seen: new Set(["web", "preload"]) });
    expect(res).toBeNull();
  });
});

describe("decide — Grep/Glob (preload once)", () => {
  it("primeira Grep emite o lembrete de preload", () => {
    const res = decide({ tool_name: "Grep", tool_input: {}, seen: new Set() });
    expect(res.keys).toEqual(["preload"]);
    expect(res.text).toMatch(/ToolSearch|deferred/);
  });

  it("segunda Grep na mesma sessão → null (neutraliza o ruído)", () => {
    const res = decide({ tool_name: "Glob", tool_input: {}, seen: new Set(["preload"]) });
    expect(res).toBeNull();
  });
});

describe("decide — Read (threshold 300, dedup por arquivo)", () => {
  it("arquivo de 300 linhas → nudge read_slice", () => {
    const res = decide({ tool_name: "Read", tool_input: { file_path: "/x/big.ts" }, seen: new Set() }, fakeFs(300));
    expect(res.keys).toContain("read:/x/big.ts");
    expect(res.text).toMatch(/read_slice/);
  });

  it("arquivo de 299 linhas → null (abaixo do threshold)", () => {
    const res = decide({ tool_name: "Read", tool_input: { file_path: "/x/small.ts" }, seen: new Set() }, fakeFs(299));
    expect(res).toBeNull();
  });

  it("Read cirúrgico (offset/limit) → null", () => {
    const res = decide({ tool_name: "Read", tool_input: { file_path: "/x/big.ts", offset: 10 }, seen: new Set() }, fakeFs(400));
    expect(res).toBeNull();
  });

  it("mesmo arquivo já nudado → null (não repete)", () => {
    const seen = new Set(["read:/x/big.ts", "preload"]);
    const res = decide({ tool_name: "Read", tool_input: { file_path: "/x/big.ts" }, seen }, fakeFs(400));
    expect(res).toBeNull();
  });

  it("segundo arquivo grande ainda nuda, mas sem repetir o preload", () => {
    const seen = new Set(["read:/x/a.ts", "preload"]);
    const res = decide({ tool_name: "Read", tool_input: { file_path: "/x/b.ts" }, seen }, fakeFs(400));
    expect(res.keys).toContain("read:/x/b.ts");
    expect(res.keys).not.toContain("preload");
  });
});
