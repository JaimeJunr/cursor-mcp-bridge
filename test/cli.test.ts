import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCursorArgs, buildGrokArgs, buildCodexArgs, buildArgs, buildSandboxArgs, buildSandboxSpec,
  parseCliJson, parseCodexJsonl, resolveModel, resolveTier,
  type SandboxSpec, type Engine,
} from "../src/cli.js";

describe("resolveModel", () => {
  it("defaults to Composer 2.5 Fast (nunca auto)", () => {
    expect(resolveModel()).toBe("composer-2.5[fast=true]");
  });

  it("ignores effort for auto (auto takes no bracket override)", () => {
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
    expect(args[args.indexOf("--model") + 1]).toBe("composer-2.5[fast=true]");
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

  it("does not force tool approval by default", () => {
    expect(buildCursorArgs({ prompt: "hi" })).not.toContain("--force");
  });

  it("forces tool approval when opts.force is set (web_lookup needs it or the web tool hangs)", () => {
    // Regressão: em headless a web search fica esperando aprovação que nunca chega e leva
    // timeout. --force auto-aprova a tool; mode:'ask' mantém o filesystem read-only.
    const args = buildCursorArgs({ prompt: "search", mode: "ask", force: true });
    expect(args).toContain("--force");
    expect(args[args.indexOf("--mode") + 1]).toBe("ask");
  });
});

describe("buildSandboxArgs", () => {
  const spec: SandboxSpec = {
    home: "/home/u",
    user: "u",
    path: "/home/u/.local/bin:/usr/bin",
    lang: "C.UTF-8",
    lcAll: "C.UTF-8",
    isoHome: "/tmp/iso",
    tmpDir: "/tmp/sbx",
    workspace: "/repo",
    systemRo: ["/usr", "/bin"],
    homeRo: ["/home/u/.config/cursor/auth.json", "/home/u/.local"],
    homeRw: ["/home/u/.gradle"],
    extraBinds: ["/mnt/extra"],
    extraEnv: [["HTTPS_PROXY", "http://proxy:8080"]],
  };

  it("monta o $HOME isolado ANTES dos binds de subpaths do HOME", () => {
    const args = buildSandboxArgs(spec);
    const isoHomeAt = args.indexOf("/tmp/iso");
    const authAt = args.indexOf("/home/u/.config/cursor/auth.json");
    expect(isoHomeAt).toBeGreaterThanOrEqual(0);
    expect(authAt).toBeGreaterThan(isoHomeAt);
  });

  it("binda o workspace por último (após binds do HOME e extras, antes do --setenv)", () => {
    const args = buildSandboxArgs(spec);
    const setenv = args.indexOf("--setenv");
    // o último --bind antes do --setenv é o workspace, nunca sobreposto
    let lastBind = -1;
    for (let i = 0; i < setenv; i++) if (args[i] === "--bind") lastBind = i;
    expect(args[lastBind + 1]).toBe("/repo");
    expect(args[lastBind + 2]).toBe("/repo");
  });

  it("monta os binds extras RW depois dos binds do HOME e antes do workspace", () => {
    const args = buildSandboxArgs(spec);
    const gradleBind = args.indexOf("/home/u/.gradle");
    const extraAt = args.indexOf("/mnt/extra");
    const wsBind = args.lastIndexOf("/repo");
    expect(extraAt).toBeGreaterThan(gradleBind);
    expect(extraAt).toBeLessThan(wsBind);
    // é um --bind RW (path duplicado: source e dest iguais)
    expect(args[extraAt - 1]).toBe("--bind");
    expect(args[extraAt + 1]).toBe("/mnt/extra");
  });

  it("isola HOME/USER/PATH via --setenv e preserva proxy do host", () => {
    const args = buildSandboxArgs(spec);
    expect(args[args.indexOf("HOME") + 1]).toBe("/home/u");
    expect(args[args.indexOf("USER") + 1]).toBe("u");
    expect(args[args.indexOf("HTTPS_PROXY") + 1]).toBe("http://proxy:8080");
  });

  it("aplica isolamento de namespaces e chdir no workspace", () => {
    const args = buildSandboxArgs(spec);
    expect(args).toContain("--unshare-pid");
    expect(args).toContain("--die-with-parent");
    expect(args[args.indexOf("--chdir") + 1]).toBe("/repo");
  });

  it("inclui ~/.grok como bind RW somente para o engine grok", () => {
    const oldHome = process.env.HOME;
    const fakeHome = mkdtempSync(join(tmpdir(), "cbx-test-home-"));
    mkdirSync(join(fakeHome, ".grok"));
    process.env.HOME = fakeHome;
    const grok = buildSandboxSpec("/repo", "grok");
    const cursor = buildSandboxSpec("/repo", "cursor");
    try {
      const grokHome = join(fakeHome, ".grok");
      const grokArgs = buildSandboxArgs(grok.spec);
      const grokBind = grokArgs.indexOf(grokHome);
      expect(grok.spec.homeRw).toContain(grokHome);
      expect(grokArgs[grokBind - 1]).toBe("--bind");
      expect(grokArgs[grokBind + 1]).toBe(grokHome);
      expect(cursor.spec.homeRw).not.toContain(grokHome);
    } finally {
      grok.cleanup();
      cursor.cleanup();
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("buildGrokArgs", () => {
  it("passa o prompt como valor de --single e usa flags próprias do grok", () => {
    const args = buildGrokArgs({ prompt: "do it", model: "grok-4.5", effort: "high" });
    expect(args[args.indexOf("--single") + 1]).toBe("do it");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("-m") + 1]).toBe("grok-4.5");
    expect(args[args.indexOf("--reasoning-effort") + 1]).toBe("high");
    expect(args).toContain("--always-approve"); // autonomia é --always-approve, não --force
    expect(args).not.toContain("--trust");
  });

  it("adiciona -r no resume", () => {
    const args = buildGrokArgs({ prompt: "more", model: "grok-4.5", resume: "g-1" });
    expect(args[args.indexOf("-r") + 1]).toBe("g-1");
  });

  it("é selecionado pelo dispatcher e ignora images (grok lê os paths pelo prompt)", () => {
    const opts = { prompt: "edit refs/a.png", images: ["refs/a.png"] };
    expect(buildArgs("grok", opts)).toEqual(buildGrokArgs(opts));
    expect(buildArgs("grok", opts)).not.toContain("-i");
  });
});

describe("buildCodexArgs", () => {
  it("usa o subcomando exec, --json e bypass de aprovação", () => {
    const args = buildCodexArgs({ prompt: "fix it", model: "gpt-5.6-sol", effort: "medium" });
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.6-sol");
    // effort é config override, não flag
    expect(args[args.indexOf("-c") + 1]).toBe('model_reasoning_effort="medium"');
    expect(args.at(-1)).toBe("fix it"); // prompt é posicional no fim
  });

  it("usa o subcomando resume com o id quando há resume", () => {
    // resume do codex é subcomando: `codex exec resume [OPTIONS] <id> <prompt>`. buildCodexArgs
    // ignorava opts.resume → follow_up começava sessão nova em vez de continuar.
    const args = buildCodexArgs({ prompt: "more", model: "gpt-5.6-sol", resume: "uuid-1" });
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    expect(args).toContain("--json");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    // posicionais no fim: <id> depois <prompt>
    expect(args.at(-2)).toBe("uuid-1");
    expect(args.at(-1)).toBe("more");
  });

  it("anexa -i por imagem de entrada quando opts.images está setado", () => {
    const args = buildCodexArgs({ prompt: "edit", model: "gpt-5.6-sol", images: ["a.png", "b.png"] });
    expect(args).toContain("-i");
    expect(args[args.indexOf("-i") + 1]).toBe("a.png");
    expect(args[args.indexOf("-i", args.indexOf("-i") + 1) + 1]).toBe("b.png");
  });

  it("com images, separa o prompt posicional com `--` (senão o -i variádico o engole)", () => {
    const args = buildCodexArgs({ prompt: "edit", images: ["a.png"] });
    // o prompt é o último arg e vem logo após o terminador `--`
    expect(args.at(-1)).toBe("edit");
    expect(args.at(-2)).toBe("--");
  });

  it("não inclui -i nem `--` quando opts.images está ausente ou vazio", () => {
    expect(buildCodexArgs({ prompt: "gen" })).not.toContain("-i");
    expect(buildCodexArgs({ prompt: "gen" })).not.toContain("--");
    expect(buildCodexArgs({ prompt: "gen", images: [] })).not.toContain("-i");
  });

  it("inclui -i no resume path quando há resume e images", () => {
    const args = buildCodexArgs({
      prompt: "more",
      model: "gpt-5.6-sol",
      resume: "uuid-1",
      images: ["src.png"],
    });
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    expect(args).toContain("-i");
    expect(args[args.indexOf("-i") + 1]).toBe("src.png");
    // `--` termina o -i variádico antes dos posicionais <id> <prompt> do resume
    expect(args.at(-3)).toBe("--");
    expect(args.at(-2)).toBe("uuid-1");
    expect(args.at(-1)).toBe("more");
  });
});

describe("resolveTier", () => {
  const all: (e: Engine) => boolean = () => true;
  const none: (e: Engine) => boolean = (e) => e === "cursor";

  it("nível 1 é sempre Composer 2.5 Fast no cursor-agent", () => {
    expect(resolveTier(1, all)).toEqual({ engine: "cursor", model: "composer-2.5[fast=true]" });
  });

  it("níveis 2/3 usam Grok 4.5 com effort crescente quando o grok existe", () => {
    expect(resolveTier(2, all)).toEqual({ engine: "grok", model: "grok-4.5", effort: "medium" });
    expect(resolveTier(3, all)).toEqual({ engine: "grok", model: "grok-4.5", effort: "high" });
  });

  it("níveis 4/5 usam GPT-5.6 Sol no codex com effort crescente", () => {
    expect(resolveTier(4, all)).toEqual({ engine: "codex", model: "gpt-5.6-sol", effort: "medium" });
    expect(resolveTier(5, all)).toEqual({ engine: "codex", model: "gpt-5.6-sol", effort: "high" });
  });

  it("cai para o cursor-agent quando grok/codex não estão instalados", () => {
    expect(resolveTier(3, none)).toEqual({ engine: "cursor", model: "cursor-grok-4.5-high-fast" });
    expect(resolveTier(5, none)).toEqual({ engine: "cursor", model: "gpt-5.6-sol-xhigh-fast" });
  });

  it("rejeita nível fora de 1-5", () => {
    expect(() => resolveTier(0, all)).toThrow(/expected integer 1-5/);
    expect(() => resolveTier(6, all)).toThrow(/expected integer 1-5/);
  });
});

describe("parseCliJson", () => {
  it("extracts result and session_id (cursor)", () => {
    const raw = JSON.stringify({ type: "result", result: "PONG", session_id: "s-1" });
    expect(parseCliJson(raw)).toEqual({ text: "PONG", sessionId: "s-1" });
  });

  it("extracts text and sessionId (grok)", () => {
    const raw = JSON.stringify({ text: "PONG", sessionId: "g-1", stopReason: "EndTurn" });
    expect(parseCliJson(raw)).toEqual({ text: "PONG", sessionId: "g-1" });
  });

  it("falls back to raw text on non-json", () => {
    expect(parseCliJson("plain")).toEqual({ text: "plain" });
  });
});

describe("parseCodexJsonl", () => {
  it("pega o último agent_message ignorando logs e outros eventos", () => {
    const raw = [
      "2026-07-16T23:08:40Z ERROR some noisy log line",
      JSON.stringify({ type: "item.completed", item: { id: "1", type: "error", message: "skill trimmed" } }),
      JSON.stringify({ type: "item.completed", item: { id: "2", type: "agent_message", text: "PONG" } }),
      JSON.stringify({ type: "turn.completed", usage: { output_tokens: 6 } }),
    ].join("\n");
    expect(parseCodexJsonl(raw)).toEqual({ text: "PONG", sessionId: undefined });
  });

  it("degrada para texto cru quando não há agent_message", () => {
    expect(parseCodexJsonl("just noise\nno json here")).toEqual({ text: "just noise\nno json here", sessionId: undefined });
  });

  it("captura o thread_id do evento thread.started como sessionId", () => {
    // o codex emite o id da sessão como `thread_id` no `thread.started`, não como `session_id`.
    // sem isso o follow_up de um delegate 4-5 (codex) perdia a sessão.
    const raw = [
      JSON.stringify({ type: "thread.started", thread_id: "019f7049-22af-79a2" }),
      JSON.stringify({ type: "item.completed", item: { id: "1", type: "agent_message", text: "PONG" } }),
      JSON.stringify({ type: "turn.completed", usage: { output_tokens: 6 } }),
    ].join("\n");
    expect(parseCodexJsonl(raw)).toEqual({ text: "PONG", sessionId: "019f7049-22af-79a2" });
  });
});
