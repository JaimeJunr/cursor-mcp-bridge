import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const indexSrc = readFileSync(path.join(repoRoot, "src", "index.ts"), "utf8");
const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");

describe("tool surface (US-003)", () => {
  it("registra exatamente dez tools", () => {
    const calls = indexSrc.match(/server\.registerTool\(/g) ?? [];
    expect(calls).toHaveLength(10);
  });

  it("não registra mais as tools plan e build", () => {
    expect(indexSrc).not.toMatch(/registerTool\(\s*"plan"/);
    expect(indexSrc).not.toMatch(/registerTool\(\s*"build"/);
    expect(indexSrc).not.toMatch(/\bplanPrompt\b/);
    expect(indexSrc).not.toMatch(/\bbuildPrompt\b/);
  });

  it("as instructions do server não anunciam mais o two-phase plan → build", () => {
    expect(indexSrc).not.toMatch(/Two-phase work/);
    // o resto do roteamento continua intacto
    expect(indexSrc).toMatch(/self-contained implementation, commits, PRs/);
    expect(indexSrc).toMatch(/Every tool returns a session_id for follow_up\./);
  });

  it("prompts.ts não exporta mais planPrompt/buildPrompt, mas mantém ExploreMode", async () => {
    const mod = await import("../src/prompts.js");
    expect("planPrompt" in mod).toBe(false);
    expect("buildPrompt" in mod).toBe(false);
    const promptsSrc = readFileSync(path.join(repoRoot, "src", "prompts.ts"), "utf8");
    expect(promptsSrc).toMatch(/export type ExploreMode = "plan" \| "ask";/);
  });

  it("README lista as dez tools reais, sem linhas de plan/build", () => {
    for (const tool of [
      "delegate", "fast_delegate", "explore", "read_slice", "run_filtered",
      "web_lookup", "fan_out", "generate_image", "follow_up", "bridge_stats",
    ]) {
      expect(readme).toMatch(new RegExp(`^\\| \`${tool}\` \\|`, "m"));
    }
    expect(readme).not.toMatch(/^\| `plan` \|/m);
    expect(readme).not.toMatch(/^\| `build` \|/m);
    expect(readme).not.toMatch(/plan\(task\) then build\(plan\)/);
  });
});
