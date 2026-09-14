import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

// Sandbox LIGADO (default): esta suíte exercita justamente a obrigatoriedade do bwrap.
delete process.env.POLYAGENT_SANDBOX;
const { runCursor, sandboxPreflight, assertReadOnlyEngine } = await import("../src/cli.js");

/** Child fake que fecha com sucesso devolvendo um JSON mínimo. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    child.stdout.emit("data", Buffer.from(JSON.stringify({ result: "ok", session_id: "s1" })));
    child.emit("close", 0);
  });
  return child;
}

const REMEDY = "sudo apt install bubblewrap";
let binDir: string;
const origPath = process.env.PATH;

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild());
  binDir = mkdtempSync(join(tmpdir(), "bwrap-bin-"));
  process.env.PATH = binDir;
});

afterEach(() => {
  process.env.PATH = origPath;
  rmSync(binDir, { recursive: true, force: true });
});

/** Cria um `bwrap` fake dentro do PATH stubado. */
function installFakeBwrap(): string {
  const p = join(binDir, "bwrap");
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o755);
  return p;
}

describe("bwrap obrigatório", () => {
  it("com bwrap no PATH, roda normalmente dentro do sandbox", async () => {
    const bwrap = installFakeBwrap();
    const res = await runCursor({ prompt: "oi", engine: "claude" });
    expect(res.text).toBe("ok");
    expect(spawnMock.mock.calls[0][0]).toBe(bwrap);
  });

  it("sem bwrap no PATH, a chamada falha nomeando o remédio (nunca roda degradado)", async () => {
    await expect(runCursor({ prompt: "oi", engine: "claude" })).rejects.toThrow(REMEDY);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("sandboxPreflight lança na inicialização quando o bwrap não está no PATH", () => {
    expect(() => sandboxPreflight()).toThrow(REMEDY);
  });

  it("sandboxPreflight passa quando o bwrap existe", () => {
    installFakeBwrap();
    expect(() => sandboxPreflight()).not.toThrow();
  });

  it("sandboxPreflight passa sem bwrap quando o operador desligou o sandbox por env", () => {
    expect(() => sandboxPreflight(false)).not.toThrow();
  });
});

describe("read-only sem sandbox só aceita codex", () => {
  it("recusa engine não-codex numa tool read-only quando o sandbox está desligado", () => {
    expect(() => assertReadOnlyEngine("explore", "grok", false)).toThrow(/explore/);
    expect(() => assertReadOnlyEngine("explore", "grok", false)).toThrow(/codex/);
    expect(() => assertReadOnlyEngine("web_lookup", "claude", false)).toThrow(/POLYAGENT_SANDBOX/);
  });

  it("aceita codex com o sandbox desligado", () => {
    expect(() => assertReadOnlyEngine("read_slice", "codex", false)).not.toThrow();
  });

  it("aceita qualquer engine enquanto o sandbox estiver ligado", () => {
    expect(() => assertReadOnlyEngine("explore", "grok", true)).not.toThrow();
  });
});
