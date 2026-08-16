#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  runCursor, EXPLORE_MODEL, IMAGE_MODEL, DEFAULT_TIMEOUT_MS, budgetNote,
  formatSessionHandle, parseSessionHandle, hasEngine, resolveTier, isDefaultTierEngine, withTerseStyle,
  raceFirstSuccess, CURSOR_ENABLED,
  type CliResult, type Engine,
} from "./cli.js";
import { resolveAgent } from "./agents.js";
import {
  readSlicePrompt, runFilteredPrompt, explorePrompt, webLookupPrompt,
  generateImagePrompt, generateImageGrokPrompt, planPrompt, buildPrompt, fanOutArbiterPrompt,
  type FanOutWorkerOutput,
} from "./prompts.js";
import {
  logUsage, readUsage, aggregate, computeEngineHealth, classifyOutcome,
  type TierReceipt, type UsageRun,
} from "./usage.js";
import { scrubSecrets } from "./scrub.js";

const server = new McpServer(
  { name: "cursor-mcp-bridge", version: "0.5.0" },
  {
    instructions:
      "cursor-mcp-bridge offloads work to cheap headless CLIs so you do not spend your own context. Routing: pure reading or locating a specific slice → read_slice; mapping or searching the codebase → explore; running a noisy command and keeping only the signal → run_filtered; web or docs lookup → web_lookup; self-contained implementation, commits, PRs, multi-file edits, or running and fixing a build → delegate (level 1-5). Two-phase work: plan → build. Prefer these tools over native Read, Grep, WebSearch, or Bash for pure reading, locating, web lookup, and grunt work; use native Read only when you are about to edit that file. Every tool returns a session_id for follow_up.",
  },
);

// Params de roteamento compartilhados.
const routing = {
  cwd: z.string().optional().describe("Absolute path to the project root. Defaults to the server's cwd."),
  model: z
    .string()
    .optional()
    .describe("Cursor model id (e.g. 'auto', 'composer-2.5', 'gpt-5.2'). Default 'auto' (cheapest)."),
  effort: z
    .string()
    .optional()
    .describe("Reasoning effort for parameterized models (e.g. 'low'|'high'). Ignored by 'auto'."),
};

// Persona especializada, resolvida no host por resolveAgent. Compartilhada por delegate e build.
const agentSchema = z.union([
  z.string(),
  z.object({ prompt: z.string(), name: z.string().optional(), model: z.string().optional() }),
]);
const agentDescription =
  "Run the worker as a specialized agent/persona. A name (e.g. 'pit:issue-investigator' or 'code-reviewer') is resolved from .claude/agents (project + home) and ~/.claude/plugins — its system prompt is injected via each engine's native channel (claude --append-system-prompt, grok --rules, codex developer_instructions). Or pass an inline { prompt } to skip file lookup. Works on every level/engine, not just claude.";

/**
 * Formata o resultado do Cursor: passa o texto pelo egress scrubber (scrubSecrets) antes do footer
 * de session_id, loga os chars devolvidos ao contexto (custo real) e — quando algo foi redigido —
 * loga também um evento "blocked_exfil". `tier` (opcional) carrega o tier-integrity receipt de
 * quem chamou resolveTier (delegate/plan/build); tools sem tier (explore, read_slice, ...) omitem.
 */
function format(
  tool: string,
  res: CliResult,
  tier?: TierReceipt,
  run?: UsageRun,
): { content: { type: "text"; text: string }[] } {
  const sessionHandle = res.engine && res.sessionId
    ? formatSessionHandle(res.engine, res.sessionId)
    : res.sessionId;
  const footer = res.sessionId
    ? `\n\n---\nsession_id: ${sessionHandle} (pass to follow_up to continue this session)`
    : "";
  const { text: scrubbed, redacted } = scrubSecrets(res.text);
  const text = scrubbed + footer;
  logUsage(tool, text.length, tier, run);
  if (redacted) logUsage("blocked_exfil", text.length);
  return { content: [{ type: "text", text }] };
}

/** Saúde atual das engines a partir do log. I/O + Date.now() ficam aqui — resolveTier permanece pura. */
function currentEngineHealth(): Record<string, number> {
  return computeEngineHealth(readUsage(), Date.now());
}

/**
 * Roda o worker e anexa engine/outcome/durationMs no log — inclusive em falha/timeout, senão o
 * computeEngineHealth nunca vê os negativos. Rejeita de novo após logar.
 */
async function formatRun(
  tool: string,
  engine: Engine,
  work: () => Promise<CliResult>,
  receipt: TierReceipt,
): Promise<{ content: { type: "text"; text: string }[] }> {
  const started = Date.now();
  try {
    const res = await work();
    return format(tool, res, receipt, {
      engine: res.engine ?? engine,
      outcome: "success",
      durationMs: Date.now() - started,
    });
  } catch (err) {
    logUsage(tool, 0, receipt, {
      engine,
      outcome: classifyOutcome(err),
      durationMs: Date.now() - started,
    });
    throw err;
  }
}

server.registerTool(
  "delegate",
  {
    _meta: { "anthropic/alwaysLoad": true },
    description:
      "Delegate a task to a headless coding-agent CLI — the cheap/fast worker with full tool access (read, edit, shell) in cwd. As the orchestrator, offload grunt-work here instead of spending your own expensive tokens: commits, opening/updating PRs, writing tickets/comments, small mechanical or 2-line edits, running a build/test and fixing it, and routine implementation. The `level` (1-5) picks a DISTINCT model by task difficulty, spread across the codex/grok/claude subscriptions: 1=GPT-5.6 Luna max (codex, cheapest), 2=Grok 4.5 high (grok), 3=GPT-5.6 Sol xhigh (codex), 4=Grok 4.6 high (grok), 5=Opus max (claude). Pick the lowest level that can do the job. Give a complete, self-contained instruction — the worker does not see your context.",
    inputSchema: {
      prompt: z.string().describe("The complete task prompt for the worker agent."),
      level: z
        .number()
        .int()
        .min(1)
        .max(5)
        .describe("Task difficulty 1-5, each a distinct model: 1=GPT-5.6 Luna max (codex), 2=Grok 4.5 high (grok), 3=GPT-5.6 Sol xhigh (codex), 4=Grok 4.6 high (grok), 5=Opus max (claude). Use the lowest level that fits."),
      agent: agentSchema.optional().describe(agentDescription),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max wall-clock ms for this delegation. Default 1800000 (30 min). Raise for unusually long build-heavy tasks."),
      ...routing,
    },
  },
  // O nível escolhe engine+modelo+effort (resolveTier). force: no sandbox o $HOME isolado tira o
  // "trusted" do cursor-agent e todo shell é rejeitado sem --force; grok/codex auto-aprovam por args.
  // `model`/`effort` explícitos do chamador ainda sobrepõem o tier.
  async ({ prompt, level, agent, timeout_ms, cwd, model, effort }) => {
    const tier = resolveTier(level, hasEngine, CURSOR_ENABLED, currentEngineHealth());
    // Resolve o agent no host (fora do sandbox): a persona vira string injetada por engine. O `model`
    // do frontmatter é advisory — o `model` explícito e o do tier vencem.
    const resolved = agent ? resolveAgent(agent, cwd ?? process.cwd()) : undefined;
    return formatRun(
      "delegate",
      tier.engine,
      () => runCursor({
        prompt: prompt + budgetNote(timeout_ms ?? DEFAULT_TIMEOUT_MS),
        cwd,
        engine: tier.engine,
        model: model ?? tier.model,
        effort: effort ?? tier.effort,
        agentPrompt: withTerseStyle(resolved?.prompt),
        force: true,
        timeoutMs: timeout_ms,
      }),
      { requestedLevel: level, matchedRequest: isDefaultTierEngine(level, tier.engine) },
    );
  },
);

server.registerTool(
  "explore",
  {
    _meta: { "anthropic/alwaysLoad": true },
    description:
      "Read-only codebase exploration, the cheap Explore. Prefer this over spawning the Explore subagent for locating/mapping code: it runs on Codex Luna (cheap/fast) and keeps file dumps out of your context — you get back only the conclusion plus concrete file:line references. Three modes: (a) `question` alone → broad fan-out search across the repo (follows naming conventions, checks multiple locations) returning file:line refs; (b) `question`+`files` → scoped answer about those files; (c) neither → a general project map. It LOCATES, it does not review/audit — use a Task subagent for judgment.",
    inputSchema: {
      question: z
        .string()
        .optional()
        .describe("What you want to know. Alone: a fan-out search (e.g. 'where is X defined', 'all call sites of Y'). With `files`: a question about them. Omit entirely for a general map."),
      files: z
        .array(z.string())
        .optional()
        .describe("Optional file paths to scope the exploration to (relative to cwd or absolute)."),
      breadth: z
        .enum(["medium", "thorough"])
        .optional()
        .describe("How wide to sweep on a fan-out search (no `files`). 'thorough' chases every plausible location/naming convention. Default 'medium'."),
      ...routing,
    },
  },
  async ({ question, files, breadth, cwd, model, effort }) => {
    const { prompt, mode } = explorePrompt(question, files, breadth);
    // codex read-only (mode) com o modelo barato de leitura (luna). O worker localiza/mapeia sem editar.
    return format("explore", await runCursor({ prompt, cwd, engine: "codex", model: model ?? EXPLORE_MODEL, effort, mode, agentPrompt: withTerseStyle() }));
  },
);

server.registerTool(
  "read_slice",
  {
    _meta: { "anthropic/alwaysLoad": true },
    description:
      "Read-only surgical read: the Cursor agent reads the given file(s) and returns ONLY the code relevant to `want` (exact lines with file:line), never the whole file. Use instead of Read when you need a specific function/section from large files — the full file never enters your context.",
    inputSchema: {
      files: z.array(z.string()).min(1).describe("File paths to read from (relative to cwd or absolute)."),
      want: z.string().describe("What to extract, e.g. 'the login handler and its imports'."),
      ...routing,
    },
  },
  async ({ files, want, cwd, model, effort }) =>
    format("read_slice", await runCursor({ prompt: readSlicePrompt(files, want), cwd, engine: "codex", model: model ?? EXPLORE_MODEL, effort, mode: "ask", agentPrompt: withTerseStyle() })),
);

server.registerTool(
  "run_filtered",
  {
    _meta: { "anthropic/alwaysLoad": true },
    description:
      "Run a shell command via the Cursor agent and get back ONLY the relevant lines/summary — semantic filtering of huge output (build/test/log). Complements mechanical filters: use when the noise needs judgment to strip. The full output stays on Cursor's side.",
    inputSchema: {
      command: z.string().describe("The exact shell command to run."),
      want: z.string().optional().describe("What matters in the output, e.g. 'only failing tests'. Omit for meaningful-signal-only."),
      ...routing,
    },
  },
  async ({ command, want, cwd, model, effort }) =>
    // codex sem mode → bypass total: rodar o comando (que pode escrever) É o propósito do tool.
    // force mantém a paridade quando o fallback é cursor. O worker filtra o output por relevância.
    format("run_filtered", await runCursor({ prompt: runFilteredPrompt(command, want), cwd, engine: "codex", model: model ?? EXPLORE_MODEL, effort, force: true, agentPrompt: withTerseStyle() })),
);

server.registerTool(
  "web_lookup",
  {
    _meta: { "anthropic/alwaysLoad": true },
    description:
      "Delegate a web/documentation lookup to the Cursor agent (which has web access): library docs, API references, error messages, current versions. Cheap way to fetch info newer than your training data.",
    inputSchema: { query: z.string().describe("What to look up on the web."), ...routing },
  },
  async ({ query, cwd, model, effort }) =>
    // codex read-only (mode:'ask' → filesystem intocado) + web:true liga a busca web do codex
    // (-c tools.web_search=true). approval_policy=never evita pendurar em headless.
    format("web_lookup", await runCursor({ prompt: webLookupPrompt(query), cwd, engine: "codex", model: model ?? EXPLORE_MODEL, effort, mode: "ask", web: true, agentPrompt: withTerseStyle() })),
);

server.registerTool(
  "plan",
  {
    description:
      "Phase 1 of plan→build: a STRONG model reads the codebase and returns an implementation PLAN — read-only, it does NOT edit anything. Review/approve the plan, then hand it to `build` (which can run a cheaper executor). Defaults to level 3 (GPT-5.6 Sol xhigh on codex) — strong AND hard read-only (-s read-only). Level 5 (Opus max on claude) is also strong but read-only-by-prompt only. Returns the plan + a session_id.",
    inputSchema: {
      task: z.string().describe("What to plan — the feature or fix to design."),
      level: z
        .number()
        .int()
        .min(1)
        .max(5)
        .default(3)
        .describe("Model tier for planning (1-5). Default 3 (GPT-5.6 Sol xhigh, codex, hard read-only). Planning benefits from a strong tier; level 5 is Opus max."),
      ...routing,
    },
  },
  // mode:'plan' → read-only por engine (codex -s read-only é o mais forte; cursor --mode plan). O
  // planejador lê a codebase e propõe sem editar; o prompt reforça "não editar".
  async ({ task, level, cwd, model, effort }) => {
    const tier = resolveTier(level, hasEngine, CURSOR_ENABLED, currentEngineHealth());
    return formatRun(
      "plan",
      tier.engine,
      () => runCursor({
        prompt: planPrompt(task) + budgetNote(DEFAULT_TIMEOUT_MS),
        cwd,
        engine: tier.engine,
        model: model ?? tier.model,
        effort: effort ?? tier.effort,
        mode: "plan",
        agentPrompt: withTerseStyle(),
      }),
      { requestedLevel: level, matchedRequest: isDefaultTierEngine(level, tier.engine) },
    );
  },
);

server.registerTool(
  "build",
  {
    description:
      "Phase 2 of plan→build: an executor model IMPLEMENTS an approved plan (typically the output of `plan`), with full tool access (edits + tests). Defaults to level 1 (GPT-5.6 Luna max on codex, cheapest) — the thinking is already done, so a cheap executor usually suffices. Optionally run as an `agent`. Returns a summary + session_id.",
    inputSchema: {
      plan: z.string().describe("The approved plan to implement (typically the `plan` tool output)."),
      level: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Executor tier (1-5). Default 1 (GPT-5.6 Luna max, codex, cheapest). Raise only for harder implementations."),
      agent: agentSchema.optional().describe(agentDescription),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max wall-clock ms. Default 1800000 (30 min). Raise for unusually long build-heavy tasks."),
      ...routing,
    },
  },
  async ({ plan, level, agent, timeout_ms, cwd, model, effort }) => {
    const requestedLevel = level ?? 1;
    const tier = resolveTier(requestedLevel, hasEngine, CURSOR_ENABLED, currentEngineHealth());
    const resolved = agent ? resolveAgent(agent, cwd ?? process.cwd()) : undefined;
    return formatRun(
      "build",
      tier.engine,
      () => runCursor({
        prompt: buildPrompt(plan) + budgetNote(timeout_ms ?? DEFAULT_TIMEOUT_MS),
        cwd,
        engine: tier.engine,
        model: model ?? tier.model,
        effort: effort ?? tier.effort,
        agentPrompt: withTerseStyle(resolved?.prompt),
        force: true,
        timeoutMs: timeout_ms,
      }),
      { requestedLevel, matchedRequest: isDefaultTierEngine(requestedLevel, tier.engine) },
    );
  },
);

server.registerTool(
  "fan_out",
  {
    description:
      "Run the SAME prompt across N engines/tiers in parallel isolated sandboxes, for cross-checking a claim or catching a single worker's blind spot. Returns ONLY a compact digest, never the N raw transcripts — context economy on the caller side. mode:'race' (default) resolves on the first successful result and skips the slower ones. mode:'consensus' waits for every worker then runs one cheap arbiter call that compares all outputs and returns its consensus/disagreement digest plus each worker's session_id for follow_up.",
    inputSchema: {
      prompt: z.string().describe("The task prompt sent identically to every worker."),
      levels: z
        .array(z.number().int().min(1).max(5))
        .min(2)
        .describe("Which delegate tiers (1-5) to fan out to, one worker per entry. Repeat a level (e.g. [1,1,1]) to sample the same model N times instead of diversifying engines."),
      mode: z
        .enum(["race", "consensus"])
        .default("race")
        .describe("'race': return the first successful worker's result, skip the rest. 'consensus': wait for all, then return an arbiter digest + all session_ids."),
      ...routing,
    },
  },
  async ({ prompt, levels, mode, cwd }) => {
    const tiers = levels.map((level) => ({ level, tier: resolveTier(level) }));
    const runs = tiers.map(({ level, tier }) =>
      runCursor({ prompt, cwd, engine: tier.engine, model: tier.model, effort: tier.effort, force: true })
        .then((res) => ({ level, tier, res })),
    );

    if (mode === "race") {
      const { res, level, tier } = await raceFirstSuccess(runs);
      return format("fan_out", res, { requestedLevel: level, matchedRequest: isDefaultTierEngine(level, tier.engine) });
    }

    const settled = await Promise.allSettled(runs);
    const outputs: FanOutWorkerOutput[] = settled.map((s, i) =>
      s.status === "fulfilled"
        ? { engine: s.value.tier.engine, level: s.value.level, sessionId: s.value.res.sessionId, text: s.value.res.text }
        : { engine: tiers[i].tier.engine, level: tiers[i].level, text: String(s.reason), error: true },
    );
    const arbiter = await runCursor({
      prompt: fanOutArbiterPrompt(outputs),
      cwd,
      engine: "codex",
      model: EXPLORE_MODEL,
      mode: "ask",
      agentPrompt: withTerseStyle(),
    });
    const footer = outputs
      .map((o) => `- ${o.engine} (level ${o.level})${o.sessionId ? `: ${formatSessionHandle(o.engine as Engine, o.sessionId)}` : o.error ? ": FAILED" : ": no session_id"}`)
      .join("\n");
    return format("fan_out", { ...arbiter, text: `${arbiter.text}\n\nWorker sessions (pass to follow_up):\n${footer}` });
  },
);

server.registerTool(
  "generate_image",
  {
    description:
      "Generate or edit bitmap images via the keyless codex or grok CLI image tools. Returns ONLY the saved file path (never image bytes) to preserve context. out_path must be inside cwd (the sandbox only mounts cwd).",
    inputSchema: {
      description: z.string().describe("What image to generate, or — when input_images is set — how to edit them. Free-form natural language."),
      out_path: z.string().describe("Where to save the resulting PNG, relative to cwd (the sandbox only mounts cwd, so paths outside it fail)."),
      input_images: z
        .array(z.string())
        .optional()
        .describe("Optional source image file paths to EDIT (relative to cwd). Omit to generate a fresh image."),
      engine: z
        .enum(["codex", "grok"])
        .optional()
        .describe("Image engine: 'codex' (gpt-image-2, default) or 'grok' (grok-4.5-build via Grok subscription). Both keyless."),
      cwd: z.string().optional().describe("Absolute path to the project root. Defaults to the server's cwd."),
    },
  },
  async ({ description, out_path, input_images, engine, cwd }) => {
    const eng = engine ?? "codex";
    if (!hasEngine(eng)) {
      return {
        content: [{
          type: "text" as const,
          text: eng === "grok"
            ? "generate_image requires the grok CLI — install it and run `grok login`."
            : "generate_image requires the codex CLI (for image_gen / gpt-image-2). Install codex and log in.",
        }],
      };
    }
    const prompt = eng === "grok"
      ? generateImageGrokPrompt(description, out_path, input_images)
      : generateImagePrompt(description, out_path, input_images);
    if (eng === "grok") {
      return format(
        "generate_image",
        await runCursor({ prompt, cwd, engine: "grok", force: true }),
      );
    }
    return format(
      "generate_image",
      await runCursor({
        prompt,
        cwd,
        engine: "codex",
        model: IMAGE_MODEL,
        effort: "low",
        force: true,
        images: input_images,
      }),
    );
  },
);

server.registerTool(
  "follow_up",
  {
    description:
      "Continue a previous Cursor session by session_id (returned by every other tool). The prior context lives on Cursor's side, so you don't resend it. When continuing a read-only session (explore/read_slice/web_lookup), pass mode:'ask' to keep it read-only — otherwise the resumed run regains full tool access.",
    inputSchema: {
      session_id: z.string().describe("The session id returned by a previous cursor-mcp-bridge call."),
      question: z.string().describe("The follow-up question."),
      mode: z
        .enum(["plan", "ask"])
        .optional()
        .describe("Read-only mode to keep on the resumed session. Use 'ask' when continuing an explore/read_slice/web_lookup. Omit to continue a delegate with full tool access."),
      ...routing,
    },
  },
  // force: mesma razão do delegate — ao continuar uma sessão que roda shell (delegate/run_filtered),
  // o sandbox rejeita todo comando sem --force. mode:'ask' (quando passado) mantém o filesystem read-only.
  async ({ session_id, question, mode, cwd, model, effort }) => {
    const { engine, id } = parseSessionHandle(session_id);
    return format(
      "follow_up",
      await runCursor({ prompt: question, engine, resume: id, mode, cwd, model, effort, force: true, agentPrompt: withTerseStyle() }),
    );
  },
);

server.registerTool(
  "bridge_stats",
  {
    description:
      "Report this bridge's usage: calls and chars returned to context per tool (the real cost). Requires CURSOR_BRIDGE_LOG to be set so calls are logged; otherwise reports that logging is off.",
    inputSchema: {},
  },
  async () => {
    const stats = aggregate(readUsage());
    const tools = Object.keys(stats);
    if (!tools.length) {
      return {
        content: [
          { type: "text" as const, text: "No usage logged. Set CURSOR_BRIDGE_LOG=/path/to/log.jsonl to enable logging." },
        ],
      };
    }
    const lines = tools
      .sort((a, b) => stats[b].totalOutChars - stats[a].totalOutChars)
      .map((t) => `${t}: ${stats[t].calls} calls, ${stats[t].totalOutChars} chars returned (avg ${stats[t].avgOutChars})`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
