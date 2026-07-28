import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentFile, resolveAgent, agentRoots } from "../src/agents.js";

describe("parseAgentFile", () => {
  it("extrai body como persona + name/model do frontmatter", () => {
    const raw = "---\nname: code-reviewer\nmodel: opus\ndescription: reviews\n---\nYou are a strict reviewer.\nBe terse.";
    expect(parseAgentFile(raw)).toEqual({
      prompt: "You are a strict reviewer.\nBe terse.",
      name: "code-reviewer",
      model: "opus",
    });
  });

  it("sem frontmatter, o arquivo inteiro é a persona", () => {
    expect(parseAgentFile("Just a persona, no frontmatter.")).toEqual({ prompt: "Just a persona, no frontmatter." });
  });

  it("tira aspas dos valores do frontmatter", () => {
    const raw = '---\nname: "my-agent"\n---\nbody';
    expect(parseAgentFile(raw).name).toBe("my-agent");
  });
});

describe("resolveAgent", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    delete process.env.CURSOR_BRIDGE_AGENT_PATHS;
  });

  it("objeto inline com prompt é usado direto (sem tocar o FS)", () => {
    expect(resolveAgent({ prompt: "inline persona" }, "/nope")).toEqual({ prompt: "inline persona" });
  });

  it("objeto inline sem prompt não-vazio lança erro claro", () => {
    expect(() => resolveAgent({ prompt: "  " }, "/nope")).toThrow(/non-empty 'prompt'/);
  });

  it("rejeita nomes com traversal (sem path traversal)", () => {
    expect(() => resolveAgent("../../etc/passwd", "/nope")).toThrow(/invalid agent name/);
    expect(() => resolveAgent("a/b", "/nope")).toThrow(/invalid agent name/);
  });

  it("resolve um nome buscando <base>.md num root e usa a parte após ':' (plugin)", () => {
    const root = mkdtempSync(join(tmpdir(), "cbx-agents-"));
    dirs.push(root);
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(join(root, "nested", "issue-investigator.md"), "---\nname: issue-investigator\n---\nInvestigate root cause.");
    process.env.CURSOR_BRIDGE_AGENT_PATHS = root;
    const r = resolveAgent("pit:issue-investigator", "/nope");
    expect(r.prompt).toBe("Investigate root cause.");
    expect(r.name).toBe("issue-investigator");
  });

  it("lança erro listando onde procurou quando o agent não existe", () => {
    expect(() => resolveAgent("ghost", tmpdir())).toThrow(/agent 'ghost' not found/);
  });
});

describe("agentRoots", () => {
  it("inclui roots extras do env antes dos padrões", () => {
    const root = mkdtempSync(join(tmpdir(), "cbx-roots-"));
    process.env.CURSOR_BRIDGE_AGENT_PATHS = root;
    try {
      expect(agentRoots(tmpdir())[0]).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
      delete process.env.CURSOR_BRIDGE_AGENT_PATHS;
    }
  });
});
