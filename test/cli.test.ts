import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCursorArgs, buildGrokArgs, buildCodexArgs, buildClaudeArgs, buildArgs, buildSandboxArgs, buildSandboxSpec,
  budgetNote, formatSessionHandle, parseSessionHandle, parseCliJson, parseCodexJsonl, resolveModel, resolveTier,
  isCodexHomeError, withTerseStyle, TERSE_STYLE, FALLBACK_ENGINE_ORDER, isDefaultTierEngine, raceFirstSuccess,
  type SandboxSpec, type Engine,
} from "../src/cli.js";
import { computeEngineHealth } from "../src/usage.js";

describe("codex CODEX_HOME fallback helpers", () => {
  it("detects the missing CODEX_HOME directory error", () => {
    expect(isCodexHomeError("Error finding codex home: CODEX_HOME points to /old/orca and does not exist")).toBe(true);
    expect(isCodexHomeError("CODEX_HOME points to '/gone' which does not exist")).toBe(true);
  });

  it("does not match generic or unrelated errors", () => {
    expect(isCodexHomeError("codex agent exited 1: authentication failed")).toBe(false);
    expect(isCodexHomeError("Error finding codex home: permission denied")).toBe(false);
    expect(isCodexHomeError("some directory does not exist")).toBe(false);
  });

  it("keeps the host-agnostic fallback order stable", () => {
    expect(FALLBACK_ENGINE_ORDER).toEqual(["codex", "grok", "claude"]);
  });

  // runCursor's spawn boundary is not mocked in this suite; retry wiring is integration-verified.
});

describe("raceFirstSuccess", () => {
  it("resolves with the first promise to fulfill, ignoring slower ones", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 20));
    const fast = new Promise<string>((resolve) => setTimeout(() => resolve("fast"), 1));
    await expect(raceFirstSuccess([slow, fast])).resolves.toBe("fast");
  });

  it("skips a rejected promise and resolves with a later success", async () => {
    const failing = Promise.reject(new Error("engine down"));
    const ok = new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 5));
    await expect(raceFirstSuccess([failing, ok])).resolves.toBe("ok");
  });

  it("rejects only when every promise rejects", async () => {
    const a = Promise.reject(new Error("a failed"));
    const b = Promise.reject(new Error("b failed"));
    await expect(raceFirstSuccess([a, b])).rejects.toThrow(/all/i);
  });
});

describe("withTerseStyle", () => {
  it("returns the non-empty terse addendum without a persona", () => {
    expect(withTerseStyle()).toBe(TERSE_STYLE);
    expect(withTerseStyle().length).toBeGreaterThan(0);
  });

  it("prepends the terse addendum to an existing persona", () => {
    expect(withTerseStyle("You are a strict reviewer.")).toBe(
      `${TERSE_STYLE}\n\nYou are a strict reviewer.`,
    );
  });
});

describe("session handles", () => {
  it("formata o engine junto com o id", () => {
    expect(formatSessionHandle("codex", "abc")).toBe("codex:abc");
  });

  it("extrai engine e id de um handle qualificado", () => {
    expect(parseSessionHandle("codex:abc")).toEqual({ engine: "codex", id: "abc" });
  });

  it("mantém ids legados sem prefixo", () => {
    expect(parseSessionHandle("raw-uuid-no-prefix")).toEqual({ id: "raw-uuid-no-prefix" });
  });

  it("mantém o handle inteiro quando o prefixo não é um engine válido", () => {
    expect(parseSessionHandle("foo:bar")).toEqual({ id: "foo:bar" });
  });
});

describe("budgetNote", () => {
  it("reports the effective timeout in rounded minutes", () => {
    expect(budgetNote(600_000)).toContain("~10 min");
    expect(budgetNote(1_800_000)).toContain("~30 min");
  });
});

describe("resolveModel", () => {
  it("defaults to Composer 2.5 Fast (nunca auto; id plano, sem bracket)", () => {
    expect(resolveModel()).toBe("composer-2.5-fast");
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
    expect(args[args.indexOf("--model") + 1]).toBe("composer-2.5-fast");
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
    workspaceRo: false,
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
    // o último bind antes do --setenv é o workspace, nunca sobreposto
    let lastBind = -1;
    for (let i = 0; i < setenv; i++) {
      if (args[i] === "--bind" || args[i] === "--ro-bind") lastBind = i;
    }
    expect(args[lastBind + 1]).toBe("/repo");
    expect(args[lastBind + 2]).toBe("/repo");
  });

  it("monta o workspace read-only como o último bind quando workspaceRo é true", () => {
    const args = buildSandboxArgs({ ...spec, workspaceRo: true });
    const setenv = args.indexOf("--setenv");
    let lastBind = -1;
    for (let i = 0; i < setenv; i++) {
      if (args[i] === "--bind" || args[i] === "--ro-bind") lastBind = i;
    }
    expect(args[lastBind]).toBe("--ro-bind");
    expect(args.slice(lastBind, lastBind + 3)).toEqual(["--ro-bind", "/repo", "/repo"]);
  });

  it("mantém o workspace read-write quando workspaceRo é false", () => {
    const args = buildSandboxArgs(spec);
    const setenv = args.indexOf("--setenv");
    let lastBind = -1;
    for (let i = 0; i < setenv; i++) {
      if (args[i] === "--bind" || args[i] === "--ro-bind") lastBind = i;
    }
    expect(args[lastBind]).toBe("--bind");
    expect(args.slice(lastBind, lastBind + 3)).toEqual(["--bind", "/repo", "/repo"]);
  });

  it("propaga workspaceRo no spec e usa false por padrão", () => {
    const readOnly = buildSandboxSpec("/repo", "codex", true);
    const readWrite = buildSandboxSpec("/repo", "codex");
    try {
      expect(readOnly.spec.workspaceRo).toBe(true);
      expect(readWrite.spec.workspaceRo).toBe(false);
    } finally {
      readOnly.cleanup();
      readWrite.cleanup();
    }
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
    expect(args[args.indexOf("--effort") + 1]).toBe("high"); // xAI CLI renomeou --reasoning-effort → --effort
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

  it("read-only (mode) SEM bwrap externo usa -s read-only do codex + approval_policy never", () => {
    const args = buildCodexArgs({ prompt: "read", model: "gpt-5.6-luna", mode: "ask" }); // sandboxed=false
    expect(args[args.indexOf("-s") + 1]).toBe("read-only");
    expect(args).toContain('approval_policy="never"');
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("read-only (mode) SOB bwrap externo (sandboxed) usa bypass, NÃO -s read-only (evita nested namespace)", () => {
    // Regressão: `codex -s read-only` cria um sandbox interno; aninhado dentro do bwrap do bridge ele
    // quebra com "bwrap: No permissions to create new namespace". Com bwrap externo o read-only vem
    // do --ro-bind do workspace, então o codex roda em bypass (não aninha).
    const args = buildCodexArgs({ prompt: "read", model: "gpt-5.6-luna", mode: "ask" }, true);
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("read-only");
    expect(args).not.toContain("-s");
  });

  it("buildArgs repassa sandboxed ao codex (mode+sandboxed → bypass)", () => {
    const opts = { prompt: "read", mode: "ask" as const };
    expect(buildArgs("codex", opts, true)).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(buildArgs("codex", opts, true)).not.toContain("read-only");
  });

  it("sem mode usa o bypass total (delegate/generate_image podem escrever)", () => {
    const args = buildCodexArgs({ prompt: "do", model: "gpt-5.6-sol" });
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("read-only");
  });

  it("web:true liga a busca web do codex (web_lookup)", () => {
    const args = buildCodexArgs({ prompt: "search", mode: "ask", web: true });
    expect(args).toContain("tools.web_search=true");
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
  const noCodex: (e: Engine) => boolean = (e) => e !== "codex";

  it("mapeia cada nível para a engine+modelo preferido (matriz mista 3 assinaturas)", () => {
    expect(resolveTier(1, all)).toEqual({ engine: "codex", model: "gpt-5.6-luna", effort: "max" });
    expect(resolveTier(2, all)).toEqual({ engine: "grok", model: "grok-4.5", effort: "high" });
    expect(resolveTier(3, all)).toEqual({ engine: "codex", model: "gpt-5.6-sol", effort: "xhigh" });
    expect(resolveTier(4, all)).toEqual({ engine: "grok", model: "grok-4.6", effort: "high" });
    expect(resolveTier(5, all)).toEqual({ engine: "claude", model: "opus", effort: "max" });
  });

  it("usa um modelo DISTINTO em cada nível (sem repetição)", () => {
    const models = [1, 2, 3, 4, 5].map((l) => resolveTier(l, all).model);
    expect(new Set(models).size).toBe(5);
  });

  it("cai para o cursor-agent equivalente só quando CURSOR habilitado e a engine preferida falta", () => {
    expect(resolveTier(1, noCodex, true)).toEqual({ engine: "cursor", model: "gpt-5.6-luna-max-fast" });
    expect(resolveTier(3, noCodex, true)).toEqual({ engine: "cursor", model: "gpt-5.6-sol-xhigh-fast" });
    expect(resolveTier(5, (e) => e !== "claude", true)).toEqual({
      engine: "cursor",
      model: "claude-opus-max-fast",
    });
  });

  it("lança erro claro quando a engine preferida falta e o cursor está desabilitado (default)", () => {
    expect(() => resolveTier(1, noCodex, false)).toThrow(/needs the 'codex' CLI/);
    expect(() => resolveTier(5, (e) => e !== "claude", false)).toThrow(/needs the 'claude' CLI/);
  });

  it("rejeita nível fora de 1-5", () => {
    expect(() => resolveTier(0, all)).toThrow(/expected integer 1-5/);
    expect(() => resolveTier(6, all)).toThrow(/expected integer 1-5/);
  });

  it("ignora health quando omitido (comportamento existente inalterado)", () => {
    expect(resolveTier(1, all)).toEqual({ engine: "codex", model: "gpt-5.6-luna", effort: "max" });
    expect(resolveTier(1, all, true)).toEqual({ engine: "codex", model: "gpt-5.6-luna", effort: "max" });
  });

  it("trata health vazio (log sem registros relevantes) igual a omitir health", () => {
    const empty = computeEngineHealth([], Date.now());
    expect(empty).toEqual({});
    expect(resolveTier(1, all, true, empty)).toEqual(resolveTier(1, all, true));
    expect(resolveTier(2, all, false, empty)).toEqual(resolveTier(2, all, false));
    expect(resolveTier(5, all, true, {})).toEqual(resolveTier(5, all, true));
  });

  it("cai pro cursor quando a engine preferida está instalada mas com health baixo", () => {
    expect(resolveTier(1, all, true, { codex: 0.1 })).toEqual({
      engine: "cursor",
      model: "gpt-5.6-luna-max-fast",
    });
  });

  it("mantém a engine preferida quando health está OK", () => {
    expect(resolveTier(1, all, true, { codex: 0.9 })).toEqual({
      engine: "codex",
      model: "gpt-5.6-luna",
      effort: "max",
    });
  });

  it("lança erro quando toda engine candidata do tier (preferida + cursor) está unhealthy", () => {
    expect(() => resolveTier(1, all, true, { codex: 0.1, cursor: 0.1 })).toThrow(/needs the 'codex' CLI/);
    expect(() => resolveTier(1, all, true, { codex: 0.1, cursor: 0.1 })).toThrow(/unhealthy/);
  });

  it("lança erro quando a engine preferida está unhealthy e o cursor está desabilitado", () => {
    expect(() => resolveTier(1, all, false, { codex: 0.1 })).toThrow(/needs the 'codex' CLI/);
  });
});

describe("isDefaultTierEngine (tier-integrity receipt)", () => {
  it("is true when the resolved engine matches the tier's preferred engine", () => {
    expect(isDefaultTierEngine(1, "codex")).toBe(true);
    expect(isDefaultTierEngine(2, "grok")).toBe(true);
    expect(isDefaultTierEngine(3, "codex")).toBe(true);
    expect(isDefaultTierEngine(4, "grok")).toBe(true);
    expect(isDefaultTierEngine(5, "claude")).toBe(true);
  });

  it("is false when the resolved engine is a fallback (e.g. cursor)", () => {
    expect(isDefaultTierEngine(1, "cursor")).toBe(false);
    expect(isDefaultTierEngine(3, "grok")).toBe(false);
    expect(isDefaultTierEngine(5, "cursor")).toBe(false);
  });

  it("is false for an invalid level (no tier entry to match)", () => {
    expect(isDefaultTierEngine(0, "codex")).toBe(false);
    expect(isDefaultTierEngine(6, "codex")).toBe(false);
  });
});

describe("buildClaudeArgs", () => {
  it("roda headless print json isolando MCP/settings do user, prompt posicional no fim", () => {
    const args = buildClaudeArgs({ prompt: "do it", model: "opus" });
    expect(args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(args).toContain("--strict-mcp-config"); // zero MCP servers (não sobe os do user)
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("project");
    expect(args).not.toContain("--bare"); // --bare quebra a auth ("Not logged in")
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args.at(-1)).toBe("do it");
  });

  it("auto-aprova com --dangerously-skip-permissions quando force (delegate)", () => {
    expect(buildClaudeArgs({ prompt: "x", force: true })).toContain("--dangerously-skip-permissions");
  });

  it("inclui --effort quando informado e omite quando ausente", () => {
    const withEffort = buildClaudeArgs({ prompt: "x", model: "opus", effort: "max" });
    expect(withEffort[withEffort.indexOf("--effort") + 1]).toBe("max");
    expect(buildClaudeArgs({ prompt: "x", model: "opus" })).not.toContain("--effort");
  });

  it("não auto-aprova por padrão", () => {
    expect(buildClaudeArgs({ prompt: "x" })).not.toContain("--dangerously-skip-permissions");
  });

  it("adiciona --resume no follow-up", () => {
    const args = buildClaudeArgs({ prompt: "more", resume: "c-1" });
    expect(args[args.indexOf("--resume") + 1]).toBe("c-1");
  });

  it("mode (plan) auto-aprova em headless (senão pendura) — sem --permission-mode plan", () => {
    // --permission-mode plan trava em headless esperando aprovação do plano; usamos skip-permissions
    // e o read-only do plan no claude fica por prompt+sandbox (o read-only duro é do codex).
    const args = buildClaudeArgs({ prompt: "map", mode: "plan" });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
  });

  it("não auto-aprova sem force nem mode (evita pendurar só quando não há intenção de rodar)", () => {
    expect(buildClaudeArgs({ prompt: "x" })).not.toContain("--dangerously-skip-permissions");
  });

  it("é selecionado pelo dispatcher buildArgs", () => {
    const opts = { prompt: "hi", model: "opus" };
    expect(buildArgs("claude", opts)).toEqual(buildClaudeArgs(opts));
  });
});

describe("agentPrompt injection (cross-engine, não só claude)", () => {
  const persona = "You are a strict reviewer.";

  it("claude injeta a persona via --append-system-prompt", () => {
    const args = buildClaudeArgs({ prompt: "review", agentPrompt: persona });
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(persona);
  });

  it("grok injeta a persona via --rules", () => {
    const args = buildGrokArgs({ prompt: "review", agentPrompt: persona });
    expect(args[args.indexOf("--rules") + 1]).toBe(persona);
  });

  it("codex injeta a persona via -c developer_instructions (TOML-encoded)", () => {
    const args = buildCodexArgs({ prompt: "review", agentPrompt: 'has "quotes"\nand newline' });
    const ci = args.find((a) => a.startsWith("developer_instructions="));
    expect(ci).toBe('developer_instructions="has \\"quotes\\"\\nand newline"');
  });

  it("cursor (fallback) prefixa a persona no prompt", () => {
    const args = buildCursorArgs({ prompt: "review", agentPrompt: persona });
    expect(args.at(-1)).toBe(`${persona}\n\n---\n\nreview`);
  });

  it("nenhum canal aparece quando agentPrompt está ausente", () => {
    expect(buildClaudeArgs({ prompt: "x" })).not.toContain("--append-system-prompt");
    expect(buildGrokArgs({ prompt: "x" })).not.toContain("--rules");
    expect(buildCodexArgs({ prompt: "x" }).some((a) => a.startsWith("developer_instructions="))).toBe(false);
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
    // sem isso o follow_up de um delegate codex perdia a sessão.
    const raw = [
      JSON.stringify({ type: "thread.started", thread_id: "019f7049-22af-79a2" }),
      JSON.stringify({ type: "item.completed", item: { id: "1", type: "agent_message", text: "PONG" } }),
      JSON.stringify({ type: "turn.completed", usage: { output_tokens: 6 } }),
    ].join("\n");
    expect(parseCodexJsonl(raw)).toEqual({ text: "PONG", sessionId: "019f7049-22af-79a2" });
  });
});
