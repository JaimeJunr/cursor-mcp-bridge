import { describe, it, expect } from "vitest";
import { buildCursorArgs, parseCliJson, resolveModel } from "../src/cli.js";

describe("resolveModel", () => {
  it("defaults to auto", () => {
    expect(resolveModel()).toBe("auto");
  });

  it("ignores effort for auto (auto takes no bracket override)", () => {
    expect(resolveModel(undefined, "high")).toBe("auto");
    expect(resolveModel("auto", "high")).toBe("auto");
  });

  it("appends effort bracket for parameterized models", () => {
    expect(resolveModel("gpt-5.2", "high")).toBe("gpt-5.2[effort=high]");
  });

  it("returns the bare model when no effort", () => {
    expect(resolveModel("composer-2.5")).toBe("composer-2.5");
  });
});

describe("buildCursorArgs", () => {
  it("runs headless json with trust and a resolved model", () => {
    const args = buildCursorArgs({ prompt: "hi" });
    expect(args.slice(0, 4)).toEqual(["-p", "--output-format", "json", "--trust"]);
    expect(args[args.indexOf("--model") + 1]).toBe("auto");
    expect(args.at(-1)).toBe("hi");
  });

  it("adds read-only mode when requested", () => {
    const args = buildCursorArgs({ prompt: "map it", mode: "plan" });
    expect(args[args.indexOf("--mode") + 1]).toBe("plan");
  });

  it("adds --resume for follow-ups", () => {
    const args = buildCursorArgs({ prompt: "more", resume: "s-9" });
    expect(args[args.indexOf("--resume") + 1]).toBe("s-9");
  });

  it("keeps a read-only mode on a resumed session (follow_up of a read-only explore)", () => {
    // Regressão: continuar uma sessão read-only (explore/read_slice/web_lookup) via
    // follow_up sem --mode devolvia acesso total a ferramentas. O modo deve sobreviver ao resume.
    const args = buildCursorArgs({ prompt: "more", resume: "s-9", mode: "ask" });
    expect(args[args.indexOf("--resume") + 1]).toBe("s-9");
    expect(args[args.indexOf("--mode") + 1]).toBe("ask");
  });
});

describe("parseCliJson", () => {
  it("extracts result and session_id", () => {
    const raw = JSON.stringify({ type: "result", result: "PONG", session_id: "s-1" });
    expect(parseCliJson(raw)).toEqual({ text: "PONG", sessionId: "s-1" });
  });

  it("falls back to raw text on non-json", () => {
    expect(parseCliJson("plain")).toEqual({ text: "plain" });
  });
});
