#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCursor, EXPLORE_MODEL, IMAGE_MODEL, hasEngine, resolveTier, type CliResult } from "./cli.js";
import { resolveAgent } from "./agents.js";
import {
  readSlicePrompt, runFilteredPrompt, explorePrompt, webLookupPrompt,
  generateImagePrompt, generateImageGrokPrompt, planPrompt, buildPrompt,
} from "./prompts.js";
import { logUsage, readUsage, aggregate } from "./usage.js";

const server = new McpServer({ name: "cursor-mcp-bridge", version: "0.4.0" });

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

/** Formata o resultado do Cursor e loga os chars devolvidos ao contexto (custo real). */
function format(tool: string, res: CliResult): { content: { type: "text"; text: string }[] } {
  const footer = res.sessionId
    ? `\n\n---\nsession_id: ${res.sessionId} (pass to follow_up to continue this session)`
    : "";
  const text = res.text + footer;
  logUsage(tool, text.length);
  return { content: [{ type: "text", text }] };
}

server.registerTool(
  "delegate",
  {
    description:
      "Delegate a task to a headless coding-agent CLI — the cheap/fast worker with full tool access (read, edit, shell) in cwd. As the orchestrator, offload grunt-work here instead of spending your own expensive tokens: commits, opening/updating PRs, writing tickets/comments, small mechanical or 2-line edits, running a build/test and fixing it, and routine implementation. The `level` (1-5) picks a DISTINCT model by task difficulty, spread across the codex/grok/claude subscriptions: 1=GPT-5.6 Luna (codex, cheapest), 2=Grok 4.5 (grok), 3=GPT-5.6 Terra (codex), 4=GPT-5.6 Sol (codex), 5=Claude Opus (claude). Pick the lowest level that can do the job. Give a complete, self-contained instruction — the worker does not see your context.",
    inputSchema: {
      prompt: z.string().describe("The complete task prompt for the worker agent."),
      level: z
        .number()
        .int()
        .min(1)
        .max(5)
        .describe("Task difficulty 1-5, each a distinct model: 1=GPT-5.6 Luna (codex), 2=Grok 4.5 (grok), 3=GPT-5.6 Terra (codex), 4=GPT-5.6 Sol (codex), 5=Claude Opus (claude). Use the lowest level that fits."),
      agent: agentSchema.optional().describe(agentDescription),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max wall-clock ms for this delegation. Default 600000 (10 min). Raise for build-heavy tasks that run a test suite or build multiple times (e.g. a full TDD red→green→refactor with slow builds)."),
      ...routing,
    },
  },
  // O nível escolhe engine+modelo+effort (resolveTier). force: no sandbox o $HOME isolado tira o
  // "trusted" do cursor-agent e todo shell é rejeitado sem --force; grok/codex auto-aprovam por args.
  // `model`/`effort` explícitos do chamador ainda sobrepõem o tier.
  async ({ prompt, level, agent, timeout_ms, cwd, model, effort }) => {
    const tier = resolveTier(level);
    // Resolve o agent no host (fora do sandbox): a persona vira string injetada por engine. O `model`
    // do frontmatter é advisory — o `model` explícito e o do tier vencem.
    const resolved = agent ? resolveAgent(agent, cwd ?? process.cwd()) : undefined;
    return format(
      "delegate",
      await runCursor({
        prompt,
        cwd,
        engine: tier.engine,
        model: model ?? tier.model,
        effort: effort ?? tier.effort,
        agentPrompt: resolved?.prompt,
        force: true,
        timeoutMs: timeout_ms,
      }),
    );
  },
);

server.registerTool(
  "explore",
  {
    description:
      "Read-only codebase exploration, the cheap Explore. Prefer this over spawning the Explore subagent for locating/mapping code: it runs on Cursor's composer model (cheap/fast) and keeps file dumps out of your context — you get back only the conclusion plus concrete file:line references. Three modes: (a) `question` alone → broad fan-out search across the repo (follows naming conventions, checks multiple locations) returning file:line refs; (b) `question`+`files` → scoped answer about those files; (c) neither → a general project map. It LOCATES, it does not review/audit — use a Task subagent for judgment.",
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
    return format("explore", await runCursor({ prompt, cwd, engine: "codex", model: model ?? EXPLORE_MODEL, effort, mode }));
  },
);

server.registerTool(
  "read_slice",
  {
    description:
      "Read-only surgical read: the Cursor agent reads the given file(s) and returns ONLY the code relevant to `want` (exact lines with file:line), never the whole file. Use instead of Read when you need a specific function/section from large files — the full file never enters your context.",
    inputSchema: {
      files: z.array(z.string()).min(1).describe("File paths to read from (relative to cwd or absolute)."),
      want: z.string().describe("What to extract, e.g. 'the login handler and its imports'."),
      ...routing,
    },
  },
  async ({ files, want, cwd, model, effort }) =>
    format("read_slice", await runCursor({ prompt: readSlicePrompt(files, want), cwd, engine: "codex", model: model ?? EXPLORE_MODEL, effort, mode: "ask" })),
);

server.registerTool(
  "run_filtered",
  {
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
    format("run_filtered", await runCursor({ prompt: runFilteredPrompt(command, want), cwd, engine: "codex", model: model ?? EXPLORE_MODEL, effort, force: true })),
);

server.registerTool(
  "web_lookup",
  {
    description:
      "Delegate a web/documentation lookup to the Cursor agent (which has web access): library docs, API references, error messages, current versions. Cheap way to fetch info newer than your training data.",
    inputSchema: { query: z.string().describe("What to look up on the web."), ...routing },
  },
  async ({ query, cwd, model, effort }) =>
    // codex read-only (mode:'ask' → filesystem intocado) + web:true liga a busca web do codex
    // (-c tools.web_search=true). approval_policy=never evita pendurar em headless.
    format("web_lookup", await runCursor({ prompt: webLookupPrompt(query), cwd, engine: "codex", model: model ?? EXPLORE_MODEL, effort, mode: "ask", web: true })),
);

server.registerTool(
  "plan",
  {
    description:
      "Phase 1 of plan→build: a STRONG model reads the codebase and returns an implementation PLAN — read-only, it does NOT edit anything. Review/approve the plan, then hand it to `build` (which can run a cheaper executor). Defaults to level 4 (GPT-5.6 Sol on codex) — strong AND hard read-only (-s read-only). Level 5 (Claude Opus) is also strong but read-only-by-prompt only. Returns the plan + a session_id.",
    inputSchema: {
      task: z.string().describe("What to plan — the feature or fix to design."),
      level: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Model tier for planning (1-5). Default 4 (GPT-5.6 Sol, codex, hard read-only). Planning benefits from a strong tier."),
      ...routing,
    },
  },
  // mode:'plan' → read-only por engine (codex -s read-only é o mais forte; cursor --mode plan). O
  // planejador lê a codebase e propõe sem editar; o prompt reforça "não editar".
  async ({ task, level, cwd, model, effort }) => {
    const tier = resolveTier(level ?? 4);
    return format(
      "plan",
      await runCursor({
        prompt: planPrompt(task),
        cwd,
        engine: tier.engine,
        model: model ?? tier.model,
        effort: effort ?? tier.effort,
        mode: "plan",
      }),
    );
  },
);

server.registerTool(
  "build",
  {
    description:
      "Phase 2 of plan→build: an executor model IMPLEMENTS an approved plan (typically the output of `plan`), with full tool access (edits + tests). Defaults to level 1 (cheapest) — the thinking is already done, so a cheap executor usually suffices. Optionally run as an `agent`. Returns a summary + session_id.",
    inputSchema: {
      plan: z.string().describe("The approved plan to implement (typically the `plan` tool output)."),
      level: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Executor tier (1-5). Default 1 (cheapest). Raise only for harder implementations."),
      agent: agentSchema.optional().describe(agentDescription),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max wall-clock ms. Default 600000 (10 min). Raise for build-heavy tasks."),
      ...routing,
    },
  },
  async ({ plan, level, agent, timeout_ms, cwd, model, effort }) => {
    const tier = resolveTier(level ?? 1);
    const resolved = agent ? resolveAgent(agent, cwd ?? process.cwd()) : undefined;
    return format(
      "build",
      await runCursor({
        prompt: buildPrompt(plan),
        cwd,
        engine: tier.engine,
        model: model ?? tier.model,
        effort: effort ?? tier.effort,
        agentPrompt: resolved?.prompt,
        force: true,
        timeoutMs: timeout_ms,
      }),
    );
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
  async ({ session_id, question, mode, cwd, model, effort }) =>
    format("follow_up", await runCursor({ prompt: question, resume: session_id, mode, cwd, model, effort, force: true })),
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
