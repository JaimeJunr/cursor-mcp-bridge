import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("branding (US-001)", () => {
  it("package.json identifies the project as polyagent-mcp", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expect(pkg.name).toBe("polyagent-mcp");
    expect(pkg.bin).toHaveProperty("polyagent-mcp", "dist/index.js");
    expect(pkg.description).toMatch(/codex/i);
    expect(pkg.description).toMatch(/grok/i);
    expect(pkg.description).toMatch(/claude/i);
  });

  it("src/index.ts registers the McpServer as polyagent-mcp", () => {
    const source = readFileSync(path.join(repoRoot, "src", "index.ts"), "utf8");
    expect(source).toMatch(/new McpServer\(\s*\{\s*name:\s*"polyagent-mcp"/);
    expect(source).not.toMatch(/name:\s*"cursor-mcp-bridge"/);
  });

  it("README and INSTALL document the polyagent host alias, not the old cursor-bridge alias", () => {
    const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const install = readFileSync(path.join(repoRoot, "INSTALL.md"), "utf8");
    expect(readme).toMatch(/mcp add polyagent\b/);
    expect(readme).toMatch(/"polyagent":/);
    expect(readme).not.toMatch(/mcp add cursor-bridge\b/);
    expect(install).toMatch(/mcp add polyagent\b/);
    expect(install).not.toMatch(/mcp add cursor-bridge\b/);
  });
});
