import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

// Sandbox off: o spawn é fake, então bwrap/bind mounts não teriam o que isolar aqui.
process.env.POLYAGENT_SANDBOX = "off";
const { runCursor, QuotaError, ProcessError } = await import("../src/cli.js");

/** Child fake que emite stdout/stderr e fecha com o código pedido. */
function fakeChild(stdout: string, stderr: string, code: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child;
}

// Captura real de runtime (2026-09-13) — ver ADENDO de spikes/quota-patterns.md.
const GROK_QUOTA_STDOUT = JSON.stringify({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  errors: [
    'Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402\n}',
  ],
});

describe("runCursor converte cota em erro acionável (US-006)", () => {
  beforeEach(() => spawnMock.mockReset());

  it("rejeita com QuotaError nomeando a engine e a sugestão da tool", async () => {
    spawnMock.mockImplementation(() => fakeChild(GROK_QUOTA_STDOUT, "", 1));

    const error = await runCursor({ prompt: "x", engine: "grok", tool: "delegate" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(QuotaError);
    const quota = error as InstanceType<typeof QuotaError>;
    expect(quota.kind).toBe("quota_exhausted");
    expect(quota.engine).toBe("grok");
    expect(quota.message).toContain("grok quota exhausted");
  });

  it("NUNCA retenta sozinha: cota não entra no fallback de engine", async () => {
    spawnMock.mockImplementation(() => fakeChild(GROK_QUOTA_STDOUT, "", 1));

    await runCursor({ prompt: "x", engine: "grok", tool: "delegate" }).catch(() => {});

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("deixa passar crua a falha que não é cota", async () => {
    spawnMock.mockImplementation(() => fakeChild("", "boom: unrelated failure\n", 2));

    const error = await runCursor({ prompt: "x", engine: "claude", tool: "delegate" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProcessError);
    expect(error).not.toBeInstanceOf(QuotaError);
  });
});

describe("superfície: toda chamada a runCursor declara a tool", () => {
  it("todo runCursor de index.ts passa `tool`", () => {
    const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    const indexSrc = readFileSync(path.join(repoRoot, "src", "index.ts"), "utf8");
    const calls = indexSrc.match(/runCursor\(\{/g) ?? [];
    const declared = indexSrc.match(/\btool: "/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(declared.length).toBe(calls.length);
  });
});
