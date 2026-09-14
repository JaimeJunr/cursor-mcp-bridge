import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  resolveAuxTool, ENGINE_CAPABILITIES, AUX_TOOL_REQUIREMENTS, AUX_TOOL_ENV,
  type Engine,
} from "../src/cli.js";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const indexSrc = readFileSync(path.join(repoRoot, "src", "index.ts"), "utf8");

const AUX = ["explore", "read_slice", "run_filtered", "web_lookup"] as const;

describe("matriz de capacidade por engine (US-004)", () => {
  it("declara web search só no codex", () => {
    expect(ENGINE_CAPABILITIES.codex.webSearch).toBe(true);
    for (const engine of ["grok", "claude", "cursor"] as Engine[]) {
      expect(ENGINE_CAPABILITIES[engine].webSearch).toBe(false);
    }
  });

  it("declara read-only de engine só no codex, e read-only de sandbox em todos", () => {
    expect(ENGINE_CAPABILITIES.codex.engineReadOnly).toBe(true);
    for (const engine of ["grok", "claude", "cursor"] as Engine[]) {
      expect(ENGINE_CAPABILITIES[engine].engineReadOnly).toBe(false);
    }
    for (const engine of Object.keys(ENGINE_CAPABILITIES) as Engine[]) {
      expect(ENGINE_CAPABILITIES[engine].sandboxReadOnly).toBe(true);
    }
  });

  it("registra o que cada engine faz com mode no nível do CLI", () => {
    expect(ENGINE_CAPABILITIES.codex.modeAtEngineLevel).toMatch(/-s read-only/);
    expect(ENGINE_CAPABILITIES.grok.modeAtEngineLevel).toMatch(/--always-approve/);
    expect(ENGINE_CAPABILITIES.claude.modeAtEngineLevel).toMatch(/--dangerously-skip-permissions/);
  });

  it("exige read-only só nas três tools de leitura e web search só no web_lookup", () => {
    expect(AUX_TOOL_REQUIREMENTS.explore.readOnly).toBe(true);
    expect(AUX_TOOL_REQUIREMENTS.read_slice.readOnly).toBe(true);
    expect(AUX_TOOL_REQUIREMENTS.web_lookup.readOnly).toBe(true);
    expect(AUX_TOOL_REQUIREMENTS.run_filtered.readOnly).toBe(false);
    expect(AUX_TOOL_REQUIREMENTS.web_lookup.webSearch).toBe(true);
    expect(AUX_TOOL_REQUIREMENTS.explore.webSearch).toBe(false);
  });

  it("mapeia cada tool para o par de env POLYAGENT_<TOOL>_*", () => {
    expect(AUX_TOOL_ENV).toEqual({
      explore: "POLYAGENT_EXPLORE",
      read_slice: "POLYAGENT_READ_SLICE",
      run_filtered: "POLYAGENT_RUN_FILTERED",
      web_lookup: "POLYAGENT_WEB_LOOKUP",
    });
  });
});

describe("resolveAuxTool — precedência (US-004)", () => {
  it("sem override, as quatro mantêm codex + gpt-5.6-luna", () => {
    for (const tool of AUX) {
      expect(resolveAuxTool(tool, {}, {}, true)).toEqual({ engine: "codex", model: "gpt-5.6-luna" });
    }
  });

  it("a env da tool sobrepõe o default", () => {
    const env = { POLYAGENT_READ_SLICE_ENGINE: "claude", POLYAGENT_READ_SLICE_MODEL: "claude-haiku-4-5" };
    expect(resolveAuxTool("read_slice", {}, env, true)).toEqual({
      engine: "claude",
      model: "claude-haiku-4-5",
    });
  });

  it("a env de uma tool não vaza para outra", () => {
    const env = { POLYAGENT_READ_SLICE_ENGINE: "claude" };
    expect(resolveAuxTool("explore", {}, env, true).engine).toBe("codex");
  });

  it("o parâmetro da chamada sobrepõe a env da tool", () => {
    const env = { POLYAGENT_EXPLORE_ENGINE: "claude", POLYAGENT_EXPLORE_MODEL: "claude-haiku-4-5" };
    expect(resolveAuxTool("explore", { engine: "grok", model: "grok-4.5" }, env, true)).toEqual({
      engine: "grok",
      model: "grok-4.5",
    });
  });

  it("POLYAGENT_EXPLORE_MODEL segue valendo como default de modelo do codex nas quatro", () => {
    const env = { POLYAGENT_EXPLORE_MODEL: "gpt-5.6-sol" };
    expect(resolveAuxTool("run_filtered", {}, env, true).model).toBe("gpt-5.6-sol");
  });

  it("engine não-codex sem modelo explícito usa o default do próprio CLI", () => {
    expect(resolveAuxTool("run_filtered", { engine: "grok" }, {}, true).model).toBeUndefined();
  });
});

describe("resolveAuxTool — recusas (US-004)", () => {
  it("recusa engine inválida nomeando as válidas", () => {
    expect(() => resolveAuxTool("explore", { engine: "gpt5" }, {}, true)).toThrow(/gpt5/);
    expect(() => resolveAuxTool("explore", { engine: "gpt5" }, {}, true)).toThrow(/codex/);
    expect(() => resolveAuxTool("explore", {}, { POLYAGENT_EXPLORE_ENGINE: "nope" }, true))
      .toThrow(/POLYAGENT_EXPLORE_ENGINE/);
  });

  it("recusa engine sem web search no web_lookup, mesmo com sandbox ligado", () => {
    expect(() => resolveAuxTool("web_lookup", { engine: "grok" }, {}, true)).toThrow(/web search/i);
    expect(() => resolveAuxTool("web_lookup", { engine: "claude" }, {}, true)).toThrow(/codex/);
  });

  it("recusa engine não-codex nas tools read-only quando o sandbox está desligado", () => {
    for (const tool of ["explore", "read_slice", "web_lookup"] as const) {
      expect(() => resolveAuxTool(tool, { engine: "claude" }, {}, false)).toThrow(/read-only/);
    }
  });

  it("aceita engine não-codex nas tools read-only quando o sandbox está ligado", () => {
    expect(resolveAuxTool("explore", { engine: "claude" }, {}, true).engine).toBe("claude");
    expect(resolveAuxTool("read_slice", { engine: "grok" }, {}, true).engine).toBe("grok");
  });

  it("run_filtered aceita qualquer engine, inclusive com sandbox desligado", () => {
    for (const engine of ["grok", "claude", "cursor", "codex"] as Engine[]) {
      expect(resolveAuxTool("run_filtered", { engine }, {}, false).engine).toBe(engine);
    }
  });
});

describe("superfície das tools auxiliares (US-004)", () => {
  it("o objeto routing compartilhado não ganha engine", () => {
    const routing = indexSrc.match(/const routing = \{[\s\S]*?\n\};/)?.[0] ?? "";
    expect(routing).not.toMatch(/engine/);
  });

  it("as quatro auxiliares declaram engine no próprio inputSchema", () => {
    for (const tool of AUX) {
      const block = indexSrc.match(
        new RegExp(`registerTool\\(\\s*"${tool}"[\\s\\S]*?\\n  \\},\\n`),
      )?.[0] ?? "";
      expect(block, tool).toMatch(/engine: z\s*\n?\s*\.string\(\)|engine: z\.string\(\)/);
    }
  });

  it("as quatro auxiliares resolvem engine/modelo pelo resolver puro", () => {
    const calls = indexSrc.match(/resolveAuxTool\(/g) ?? [];
    expect(calls).toHaveLength(4);
  });
});
