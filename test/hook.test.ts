import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
// @ts-expect-error — hook is plain .mjs sem types; só a lógica pura importa aqui.
import { decide, sessionStartContext, subagentStartContext } from "../hooks/prefer-cursor-bridge.mjs";

const hookPath = fileURLToPath(new URL("../hooks/prefer-cursor-bridge.mjs", import.meta.url));

/** Roda o hook como processo filho com o env dado; retorna stdout. */
function runHook(evt: object, env: NodeJS.ProcessEnv = process.env): string {
  const r = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(evt),
    env,
    encoding: "utf8",
  });
  expect(r.error).toBeUndefined();
  expect(r.status).toBe(0);
  return r.stdout ?? "";
}

/** fs falso: N linhas num arquivo "grande o suficiente" em bytes mas abaixo do teto. */
const fakeFs = (lines: number) => ({
  statSync: () => ({ size: 1000 }),
  readFileSync: () => "a\n".repeat(Math.max(lines - 1, 0)) + "a",
  minLines: 300,
});

describe("decide — web tools", () => {
  it("nudges web_lookup on WebSearch and carries the one-time preload reminder", () => {
    const res = decide({ tool_name: "WebSearch", tool_input: {}, seen: new Set() });
    expect(res.keys).toContain("web");
    expect(res.keys).toContain("preload");
    expect(res.text).toMatch(/web_lookup/);
    expect(res.text).toMatch(/ToolSearch|deferred/);
    expect(res.redirect).toBe(true);
  });

  it("dedups: WebSearch já nudado nesta sessão → null", () => {
    const res = decide({ tool_name: "WebFetch", tool_input: {}, seen: new Set(["web", "preload"]) });
    expect(res).toBeNull();
  });

  it("fail-open: depois de marcar as chaves, a segunda WebSearch passa", () => {
    const seen = new Set<string>();
    const first = decide({ tool_name: "WebSearch", tool_input: {}, seen });
    for (const key of first.keys) seen.add(key);
    const second = decide({ tool_name: "WebSearch", tool_input: {}, seen });
    expect(second).toBeNull();
  });
});

describe("decide — Grep/Glob (preload once)", () => {
  it("primeira Grep emite o lembrete de preload", () => {
    const res = decide({ tool_name: "Grep", tool_input: {}, seen: new Set() });
    expect(res.keys).toEqual(["preload"]);
    expect(res.text).toMatch(/ToolSearch|deferred/);
    expect(res.redirect).toBeFalsy();
  });

  it("segunda Grep na mesma sessão → null (neutraliza o ruído)", () => {
    const res = decide({ tool_name: "Glob", tool_input: {}, seen: new Set(["preload"]) });
    expect(res).toBeNull();
  });
});

describe("decide — Read (threshold 300, dedup por arquivo)", () => {
  it("arquivo de 300 linhas → nudge read_slice", () => {
    const res = decide({ tool_name: "Read", tool_input: { file_path: "/x/big.ts" }, seen: new Set() }, fakeFs(300));
    expect(res.keys).toContain("read:/x/big.ts");
    expect(res.text).toMatch(/read_slice/);
    expect(res.redirect).toBe(true);
  });

  it("arquivo de 299 linhas → null (abaixo do threshold)", () => {
    const res = decide({ tool_name: "Read", tool_input: { file_path: "/x/small.ts" }, seen: new Set() }, fakeFs(299));
    expect(res).toBeNull();
  });

  it("Read cirúrgico (offset/limit) → null", () => {
    const res = decide({ tool_name: "Read", tool_input: { file_path: "/x/big.ts", offset: 10 }, seen: new Set() }, fakeFs(400));
    expect(res).toBeNull();
  });

  it("mesmo arquivo já nudado → null (não repete)", () => {
    const seen = new Set(["read:/x/big.ts", "preload"]);
    const res = decide({ tool_name: "Read", tool_input: { file_path: "/x/big.ts" }, seen }, fakeFs(400));
    expect(res).toBeNull();
  });

  it("segundo arquivo grande ainda nuda, mas sem repetir o preload", () => {
    const seen = new Set(["read:/x/a.ts", "preload"]);
    const res = decide({ tool_name: "Read", tool_input: { file_path: "/x/b.ts" }, seen }, fakeFs(400));
    expect(res.keys).toContain("read:/x/b.ts");
    expect(res.keys).not.toContain("preload");
  });
});

describe("sessionStartContext — preload injetado no início da sessão", () => {
  it("instrui rodar ToolSearch com os nomes das tools deferidas", () => {
    const text = sessionStartContext();
    expect(text).toMatch(/ToolSearch/);
    expect(text).toMatch(/mcp__cursor-bridge__read_slice/);
    expect(text).toMatch(/mcp__cursor-bridge__explore/);
  });

  it("cobre o buraco do Bash grep: menciona preferir explore/read_slice sobre Read/Grep", () => {
    const text = sessionStartContext();
    expect(text).toMatch(/read_slice|explore/);
    expect(text).toMatch(/Bash|Grep|Read/);
  });

  it("passa a filosofia orquestrador: offload de commit/PR/edição mecânica pro delegate", () => {
    const text = sessionStartContext();
    expect(text).toMatch(/delegate\(/);
    expect(text).toMatch(/orchestrat/i);
    expect(text).toMatch(/grunt|commits\b/i);
  });

  it("enquadra delegate como executor E juiz (levels 3 and 5 = Sol/Opus), Task só pra subagent especializado", () => {
    const text = sessionStartContext();
    expect(text).toMatch(/delegate\(prompt, level\)/);
    expect(text).toMatch(/DEFAULT/);
    // delegate cobre julgamento também, via os tiers altos (GPT-5.6 Sol e Claude Opus)
    expect(text).toMatch(/judgment/i);
    expect(text).toMatch(/levels 3 and 5/i);
    expect(text).toMatch(/Sol xhigh.*Opus max/i);
    // Task fica só pra subagent com toolset próprio, não pra julgamento genérico
    expect(text).toMatch(/specialized|toolset/i);
  });

  it("empurra explore() direto em vez de spawnar o subagente Explore (caro)", () => {
    const text = sessionStartContext();
    expect(text).toMatch(/explore\(/);
    expect(text).toMatch(/Explore/); // o subagente nativo
  });
});

describe("decide — Bash de mutação (grunt-work → delegate)", () => {
  it("git commit → nudge delegate (com preload de carona na 1ª vez)", () => {
    const res = decide({ tool_name: "Bash", tool_input: { command: "git commit -m 'x'" }, seen: new Set() });
    expect(res.keys).toContain("bash-mutate");
    expect(res.keys).toContain("preload");
    expect(res.text).toMatch(/delegate/);
    expect(res.redirect).toBeFalsy();
  });

  it("gh pr create → nudge delegate", () => {
    const res = decide({ tool_name: "Bash", tool_input: { command: "gh pr create --fill" }, seen: new Set(["preload"]) });
    expect(res.keys).toEqual(["bash-mutate"]);
    expect(res.text).toMatch(/delegate/);
  });

  it("git status (read-only) → null (não cutuca; rtk já filtra)", () => {
    const res = decide({ tool_name: "Bash", tool_input: { command: "git status --short" }, seen: new Set(["preload"]) });
    expect(res).toBeNull();
  });

  it("segunda mutação na mesma sessão → null (dedup)", () => {
    const res = decide({ tool_name: "Bash", tool_input: { command: "git push" }, seen: new Set(["bash-mutate", "preload"]) });
    expect(res).toBeNull();
  });
});

describe("decide — Edit/Write (execução self-contained → delegate)", () => {
  it("primeira Edit → nudge delegate(level) (com preload de carona)", () => {
    const res = decide({ tool_name: "Edit", tool_input: { file_path: "/x/a.ts" }, seen: new Set() });
    expect(res.keys).toContain("edit-delegate");
    expect(res.keys).toContain("preload");
    expect(res.text).toMatch(/delegate\(/);
    expect(res.text).toMatch(/level/);
  });

  it("Write também dispara o mesmo nudge", () => {
    const res = decide({ tool_name: "Write", tool_input: { file_path: "/x/n.ts" }, seen: new Set(["preload"]) });
    expect(res.keys).toEqual(["edit-delegate"]);
    expect(res.text).toMatch(/delegate\(/);
  });

  it("MultiEdit também dispara", () => {
    const res = decide({ tool_name: "MultiEdit", tool_input: { file_path: "/x/m.ts" }, seen: new Set(["preload"]) });
    expect(res.keys).toEqual(["edit-delegate"]);
  });

  it("segunda edição na mesma sessão → null (dedup, não cutuca toda edição)", () => {
    const res = decide({ tool_name: "Edit", tool_input: { file_path: "/x/b.ts" }, seen: new Set(["edit-delegate", "preload"]) });
    expect(res).toBeNull();
  });
});

describe("subagentStartContext — contexto injetado no subagente", () => {
  it("retorna a preferência cursor-bridge para um subagente comum", () => {
    const text = subagentStartContext("general-purpose");
    expect(text).toMatch(/read_slice|explore|web_lookup/);
    expect(text).toMatch(/ToolSearch/);
  });

  it("agent_type Explore inclui o reforço específico", () => {
    const text = subagentStartContext("Explore");
    expect(text).toMatch(/Explore run|you are an explore/i);
    expect(text).toMatch(/Codex Luna/i);
  });

  it("tipos diferentes de Explore não recebem o reforço específico", () => {
    expect(subagentStartContext("general-purpose")).not.toMatch(/Explore run/i);
    expect(subagentStartContext("explore")).not.toMatch(/Explore run/i);
  });
});

describe("HOOK_MODE=off — no-op total (subprocess)", () => {
  const offEnv = { ...process.env, CURSOR_BRIDGE_HOOK_MODE: "off" };

  it("SessionStart com off → stdout vazio (não injeta routing prompt)", () => {
    const out = runHook({ hook_event_name: "SessionStart", session_id: "test-off-ss" }, offEnv);
    expect(out).toBe("");
  });

  it("SubagentStart com off → stdout vazio (não injeta agent context)", () => {
    const out = runHook(
      { hook_event_name: "SubagentStart", agent_type: "Explore" },
      offEnv,
    );
    expect(out).toBe("");
  });

  it("SessionStart sem off (default/redirect) → stdout não-vazio", () => {
    // Isola dedup por session_id único; não depende de ~/.claude.
    const env = { ...process.env };
    delete env.CURSOR_BRIDGE_HOOK_MODE;
    const out = runHook(
      { hook_event_name: "SessionStart", session_id: `test-on-ss-${Date.now()}` },
      env,
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out).toMatch(/cursor-bridge|SessionStart|additionalContext/);
  });
});
