import { describe, expect, it } from "vitest";
import {
  classifyQuotaError, quotaCandidates, quotaErrorMessage, QuotaError,
  type Engine, type BridgeTool,
} from "../src/cli.js";
import { classifyOutcome, computeEngineHealth, type UsageEntry } from "../src/usage.js";

/**
 * Fixtures por engine, com ORIGEM DECLARADA — a diferença importa para o grau de confiança:
 *
 * - grok: payload REAL capturado em runtime (2026-09-13), registrado no ADENDO de
 *   .ralph/mcp-bridge-v2/spikes/quota-patterns.md. Contradisse a previsão original do spike
 *   (402, não 429; "Grok Build usage balance exhausted", não "free grok build usage limit").
 * - codex: mensagem canônica do binário (0.154.0) confirmada em runtime no ADENDO 2 — o evento
 *   JSONL abaixo é reconstruído no formato do `exec --json`, não uma captura byte-a-byte.
 * - claude: mensagens canônicas do fonte/documentação, SEM captura real (única lacuna que
 *   permanece aberta no spike). Tratar como hipótese, não como fato observado.
 */
const FIXTURES = {
  // Origem: captura real (adendo 1). http_status vem aninhado como TEXTO dentro de errors[0].
  grokQuota: JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: [
      'Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402\n}',
    ],
  }),
  // Origem: fonte oficial (429/-32003), NÃO observado — throttle, não cota.
  grokRateLimit: JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: [
      'Internal error: {\n  "message": "API error (status 429 Too Many Requests): rate limit",\n  "http_status": 429\n}',
    ],
  }),
  // Origem: string do binário, confirmada em runtime (adendo 2), no envelope JSONL do exec --json.
  codexQuota: [
    JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
    JSON.stringify({
      type: "turn.failed",
      error: {
        message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 14th, 2026 1:44 AM.",
      },
    }),
  ].join("\n"),
  // Origem: fonte/binário, sem captura.
  codexRateLimit: JSON.stringify({ type: "error", message: "Rate limit exceeded, try again shortly" }),
  // Origem: fonte/doc do claude, SEM captura real.
  claudeQuota: JSON.stringify({
    type: "result",
    is_error: true,
    result: "Claude usage limit reached. Your limit will reset at 3pm.",
  }),
  claudeRateLimit: JSON.stringify({
    type: "result",
    is_error: true,
    api_error_status: 429,
    result: "Request rejected (429)",
  }),
  // Adendo 3: auth expirado NÃO é cota — trocar de engine mascara o remédio real (re-autenticar).
  claudeAuthExpired: JSON.stringify({
    type: "result",
    is_error: true,
    result: "Failed to authenticate: OAuth session expired and could not be refreshed",
  }),
};

const fail = (stdout: string, stderr = "", exitCode: number | null = 1) => ({ stdout, stderr, exitCode });

describe("classifyQuotaError (US-006)", () => {
  it("classifica a cota real do grok pelo http_status 402 aninhado em errors[0]", () => {
    expect(classifyQuotaError(fail(FIXTURES.grokQuota), "grok")).toBe("quota_exhausted");
  });

  it("classifica a cota do grok também pela string observada, sem depender do http_status", () => {
    const textOnly = "Error: Internal error: API error: Grok Build usage balance exhausted";
    expect(classifyQuotaError(fail("", textOnly), "grok")).toBe("quota_exhausted");
  });

  it("classifica o 429 do grok como rate_limited, não como cota esgotada", () => {
    expect(classifyQuotaError(fail(FIXTURES.grokRateLimit), "grok")).toBe("rate_limited");
  });

  it("classifica a cota do codex pela mensagem do turn.failed", () => {
    expect(classifyQuotaError(fail(FIXTURES.codexQuota), "codex")).toBe("quota_exhausted");
  });

  it("classifica o rate limit do codex como rate_limited", () => {
    expect(classifyQuotaError(fail(FIXTURES.codexRateLimit), "codex")).toBe("rate_limited");
  });

  it("classifica a cota do claude pela mensagem terminal", () => {
    expect(classifyQuotaError(fail(FIXTURES.claudeQuota), "claude")).toBe("quota_exhausted");
  });

  it("classifica o 429 do claude como rate_limited", () => {
    expect(classifyQuotaError(fail(FIXTURES.claudeRateLimit), "claude")).toBe("rate_limited");
  });

  it("não classifica auth expirado como cota (adendo 3 do spike)", () => {
    expect(classifyQuotaError(fail(FIXTURES.claudeAuthExpired), "claude")).toBeNull();
  });

  it("devolve null para falha genérica — nunca adivinha a causa", () => {
    expect(classifyQuotaError(fail("", "ENOENT: no such file or directory"), "codex")).toBeNull();
    expect(classifyQuotaError(fail("some plain text output"), "grok")).toBeNull();
    expect(classifyQuotaError(fail(""), "claude")).toBeNull();
  });

  it("nunca classifica exit 0 como cota, mesmo com a mensagem presente no output", () => {
    expect(classifyQuotaError(fail(FIXTURES.grokQuota, "", 0), "grok")).toBeNull();
    expect(classifyQuotaError(fail(FIXTURES.codexQuota, "", 0), "codex")).toBeNull();
    expect(classifyQuotaError(fail(FIXTURES.claudeQuota, "", 0), "claude")).toBeNull();
  });

  it("não classifica o cursor: nenhuma captura de cota existe para ele", () => {
    expect(classifyQuotaError(fail(FIXTURES.grokQuota), "cursor")).toBeNull();
  });
});

describe("quotaCandidates — lista de engines sugeríveis (US-006)", () => {
  const all = (e: Engine) => e !== "cursor";

  it("exclui a engine que estourou e mantém a ordem das demais instaladas", () => {
    expect(quotaCandidates("delegate", "codex", all, false, true)).toEqual(["grok", "claude"]);
  });

  it("exclui engine não instalada", () => {
    const onlyClaude = (e: Engine) => e === "claude";
    expect(quotaCandidates("delegate", "codex", onlyClaude, false, true)).toEqual(["claude"]);
  });

  it("só inclui cursor sob POLYAGENT_ENABLE_CURSOR", () => {
    expect(quotaCandidates("delegate", "codex", () => true, false, true)).not.toContain("cursor");
    expect(quotaCandidates("delegate", "codex", () => true, true, true)).toContain("cursor");
  });

  it("intersecta com a matriz de capacidade: web_lookup só aceita codex", () => {
    expect(quotaCandidates("web_lookup", "codex", () => true, true, true)).toEqual([]);
    expect(quotaCandidates("web_lookup", "grok", () => true, true, true)).toEqual(["codex"]);
  });

  it("com o sandbox desligado, tool read-only só aceita codex", () => {
    expect(quotaCandidates("explore", "codex", () => true, true, false)).toEqual([]);
    expect(quotaCandidates("explore", "grok", () => true, true, false)).toEqual(["codex"]);
    expect(quotaCandidates("explore", "codex", () => true, false, true)).toEqual(["grok", "claude"]);
  });

  it("run_filtered aceita qualquer engine — roda com force por desenho", () => {
    expect(quotaCandidates("run_filtered", "codex", () => true, false, true)).toEqual(["grok", "claude"]);
  });

  it("generate_image só considera as engines com tool de imagem própria (codex/grok)", () => {
    expect(quotaCandidates("generate_image", "codex", () => true, true, true)).toEqual(["grok"]);
    expect(quotaCandidates("generate_image", "grok", () => true, true, true)).toEqual(["codex"]);
    const noGrok = (e: Engine) => e !== "grok";
    expect(quotaCandidates("generate_image", "codex", noGrok, true, true)).toEqual([]);
  });
});

describe("quotaErrorMessage — erro acionável por tool (US-006)", () => {
  it("nomeia a engine, a lista e o parâmetro engine nas tools auxiliares", () => {
    const msg = quotaErrorMessage("quota_exhausted", "grok", "explore", ["codex", "claude"]);
    expect(msg).toContain("grok quota exhausted");
    expect(msg).toContain("available engines: codex, claude");
    expect(msg).toContain('retry with engine:"codex"');
  });

  it("no delegate sugere o menor level cuja engine primária está disponível", () => {
    // grok estourou: níveis 2 e 4 saem; o menor restante é 1 (codex).
    expect(quotaErrorMessage("quota_exhausted", "grok", "delegate", ["codex", "claude"]))
      .toContain("retry with level:1");
    // codex estourou: sobram 2/4 (grok) e 5 (claude) — o menor é 2.
    expect(quotaErrorMessage("quota_exhausted", "codex", "delegate", ["grok", "claude"]))
      .toContain("retry with level:2");
    expect(quotaErrorMessage("quota_exhausted", "codex", "delegate", ["claude"]))
      .toContain("retry with level:5");
  });

  it("em fast_delegate/fan_out/generate_image informa a cota sem sugerir parâmetro", () => {
    for (const tool of ["fast_delegate", "fan_out", "generate_image"] as BridgeTool[]) {
      const msg = quotaErrorMessage("quota_exhausted", "codex", tool, ["grok", "claude"]);
      expect(msg).toContain("codex quota exhausted");
      expect(msg).not.toContain("retry with engine:");
      expect(msg).not.toContain("retry with level:");
    }
  });

  it("em follow_up diz que a engine está presa à sessão retomada", () => {
    const msg = quotaErrorMessage("quota_exhausted", "codex", "follow_up", ["grok"]);
    expect(msg).toMatch(/pinned to the engine of the resumed session/i);
    expect(msg).not.toContain("retry with engine:");
  });

  it("sem nenhum candidato válido, diz isso em vez de sugerir lista vazia", () => {
    const msg = quotaErrorMessage("quota_exhausted", "codex", "explore", []);
    expect(msg).toContain("codex quota exhausted");
    expect(msg).toMatch(/no other engine is available/i);
    expect(msg).not.toContain("available engines: ");
  });

  it("rate_limited pede espera e NUNCA sugere troca de engine", () => {
    const msg = quotaErrorMessage("rate_limited", "claude", "delegate", ["codex", "grok"]);
    expect(msg).toContain("claude rate limited");
    expect(msg).toMatch(/wait/i);
    expect(msg).not.toContain("retry with engine:");
    expect(msg).not.toContain("retry with level:");
    expect(msg).not.toContain("available engines:");
  });
});

describe("QuotaError e o registro de uso (US-006)", () => {
  it("carrega kind e engine, e nunca retenta sozinha", () => {
    const err = new QuotaError("quota_exhausted", "codex", "codex quota exhausted — ...");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("QuotaError");
    expect(err.kind).toBe("quota_exhausted");
    expect(err.engine).toBe("codex");
  });

  it("classifyOutcome dá um outcome próprio para cota, distinto de failure/timeout", () => {
    expect(classifyOutcome(new QuotaError("quota_exhausted", "grok", "x"))).toBe("quota");
    expect(classifyOutcome(new QuotaError("rate_limited", "grok", "x"))).toBe("quota");
    expect(classifyOutcome(new Error("grok agent exited 1: boom"))).toBe("failure");
    expect(classifyOutcome(new Error("grok agent timed out after 1000ms: "))).toBe("timeout");
  });

  it("computeEngineHealth ignora registros de cota — não inflam nem derrubam o health", () => {
    const now = 1_000_000;
    const quotaOnly: UsageEntry[] = [
      { ts: now - 1000, tool: "delegate", outChars: 0, engine: "grok", outcome: "quota" },
      { ts: now - 2000, tool: "delegate", outChars: 0, engine: "grok", outcome: "quota" },
    ];
    // Sem nenhum registro atribuível, a engine fica fora do mapa (tratada como saudável por omissão)
    // em vez de pontuar 1 como se fosse sucesso — era o bug de usage.ts:130.
    expect(computeEngineHealth(quotaOnly, now)).toEqual({});

    const mixed: UsageEntry[] = [
      ...quotaOnly,
      { ts: now - 1000, tool: "delegate", outChars: 0, engine: "grok", outcome: "failure" },
    ];
    expect(computeEngineHealth(mixed, now).grok).toBe(0);
  });
});
