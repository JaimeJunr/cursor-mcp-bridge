import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (...p: string[]) => readFileSync(path.join(repoRoot, ...p), "utf8");

/** Fontes que leem env (corte limpo: nenhuma delas pode ler o nome antigo). */
const SOURCES = [
  ["src", "cli.ts"],
  ["src", "usage.ts"],
  ["src", "agents.ts"],
  ["src", "index.ts"],
  ["hooks", "prefer-polyagent.mjs"],
];

/** Tabela de migração da US-002: 16 sufixos + CURSOR_BIN → POLYAGENT_CURSOR_BIN. */
const RENAMED_SUFFIXES = [
  "AGENT_PATHS",
  "GROK_BIN",
  "CODEX_BIN",
  "CLAUDE_BIN",
  "MODEL",
  "EXPLORE_MODEL",
  "IMAGE_MODEL",
  "FORCE",
  "ENABLE_CURSOR",
  "TIMEOUT_MS",
  "DEBUG",
  "SANDBOX",
  "SANDBOX_EXTRA",
  "LOG",
  "HOOK_MODE",
  "HOOK_MIN_LINES",
];

describe("env var rename CURSOR_BRIDGE_* → POLYAGENT_* (US-002)", () => {
  it("nenhuma fonte lê process.env.CURSOR_BRIDGE_* nem process.env.CURSOR_BIN", () => {
    for (const parts of SOURCES) {
      const src = read(...parts);
      expect(src, parts.join("/")).not.toMatch(/process\.env\.CURSOR_BRIDGE_/);
      expect(src, parts.join("/")).not.toMatch(/process\.env\.CURSOR_BIN\b/);
    }
  });

  it("cli.ts lê os novos nomes POLYAGENT_* para cada var que ele possui", () => {
    const src = read("src", "cli.ts");
    for (const suffix of [
      "GROK_BIN",
      "CODEX_BIN",
      "CLAUDE_BIN",
      "MODEL",
      "EXPLORE_MODEL",
      "IMAGE_MODEL",
      "FORCE",
      "ENABLE_CURSOR",
      "TIMEOUT_MS",
      "DEBUG",
      "SANDBOX",
      "SANDBOX_EXTRA",
    ]) {
      expect(src, suffix).toContain(`process.env.POLYAGENT_${suffix}`);
    }
  });

  it("CURSOR_BIN vira POLYAGENT_CURSOR_BIN — env var e const exportada", () => {
    const src = read("src", "cli.ts");
    expect(src).toContain("process.env.POLYAGENT_CURSOR_BIN");
    expect(src).toMatch(/export const POLYAGENT_CURSOR_BIN\s*=/);
    expect(src).not.toMatch(/export const CURSOR_BIN\b/);
  });

  it("usage.ts lê POLYAGENT_LOG e agents.ts lê POLYAGENT_AGENT_PATHS", () => {
    expect(read("src", "usage.ts")).toContain("process.env.POLYAGENT_LOG");
    expect(read("src", "agents.ts")).toContain("process.env.POLYAGENT_AGENT_PATHS");
  });

  it("o hook lê POLYAGENT_HOOK_MIN_LINES e POLYAGENT_HOOK_MODE", () => {
    const hook = read("hooks", "prefer-polyagent.mjs");
    expect(hook).toContain("process.env.POLYAGENT_HOOK_MIN_LINES");
    expect(hook).toContain("process.env.POLYAGENT_HOOK_MODE");
  });

  it("CURSOR_ENABLED e CURSOR_BRIDGE_MARKER sobrevivem como identificadores (fora da tabela)", () => {
    expect(read("src", "cli.ts")).toMatch(/export const CURSOR_ENABLED\s*=/);
    expect(read("hooks", "prefer-polyagent.mjs")).toMatch(/export const CURSOR_BRIDGE_MARKER\s*=/);
  });

  it("strings e comentários de usuário não citam mais os nomes antigos", () => {
    for (const parts of SOURCES) {
      expect(read(...parts), parts.join("/")).not.toMatch(/CURSOR_BRIDGE_(?!MARKER)/);
    }
  });

  it("README documenta a migração como breaking change, old → new, para as 17 vars", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/breaking change/i);
    for (const suffix of RENAMED_SUFFIXES) {
      expect(readme, suffix).toMatch(new RegExp(`CURSOR_BRIDGE_${suffix}\\b[\\s\\S]{0,80}POLYAGENT_${suffix}\\b`));
    }
    expect(readme).toMatch(/CURSOR_BIN\b[\s\S]{0,80}POLYAGENT_CURSOR_BIN\b/);
  });

  it("README e INSTALL usam só os nomes novos fora da tabela de migração", () => {
    const install = read("INSTALL.md");
    expect(install).not.toMatch(/CURSOR_BRIDGE_/);
    expect(install).toMatch(/POLYAGENT_FORCE/);
  });
});
