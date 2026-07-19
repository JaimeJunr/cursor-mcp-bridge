#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCursor, EXPLORE_MODEL, IMAGE_MODEL, hasEngine, resolveTier, type CliResult } from "./cli.js";
import {
  readSlicePrompt, runFilteredPrompt, explorePrompt, webLookupPrompt,
  generateImagePrompt, generateImageGrokPrompt,
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
      "Delegate a task to a headless coding-agent CLI — the cheap/fast worker with full tool access (read, edit, shell) in cwd. As the orchestrator, offload grunt-work here instead of spending your own expensive tokens: commits, opening/updating PRs, writing tickets/comments, small mechanical or 2-line edits, running a build/test and fixing it, and routine implementation. The `level` (1-5) picks the model by task difficulty: 1=Composer 2.5 Fast (cheapest), 2=Grok 4.5, 3=Grok 4.5 (max effort), 4=GPT-5.6 Sol, 5=GPT-5.6 Sol (max effort). Pick the lowest level that can do the job. Give a complete, self-contained instruction — the worker does not see your context.",
    inputSchema: {
      prompt: z.string().describe("The complete task prompt for the worker agent."),
      level: z
        .number()
        .int()
        .min(1)
        .max(5)
        .describe("Task difficulty 1-5. 1=Composer 2.5 Fast, 2=Grok 4.5, 3=Grok 4.5 max, 4=GPT-5.6 Sol, 5=GPT-5.6 Sol max. Use the lowest level that fits."),
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
  async ({ prompt, level, timeout_ms, cwd, model, effort }) => {
    const tier = resolveTier(level);
    return format(
      "delegate",
      await runCursor({
        prompt,
        cwd,
        engine: tier.engine,
        model: model ?? tier.model,
        effort: effort ?? tier.effort,
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
    return format("explore", await runCursor({ prompt, cwd, model: model ?? EXPLORE_MODEL, effort, mode }));
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
    format("read_slice", await runCursor({ prompt: readSlicePrompt(files, want), cwd, model, effort, mode: "ask" })),
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
    // force: em headless o comando shell fica esperando aprovação que nunca chega e é rejeitado
    // pelo ambiente ("O comando foi rejeitado pelo ambiente"); --force auto-aprova. Rodar o
    // comando É o propósito do tool, então sempre auto-aprovamos (mesmo trade-off do web_lookup).
    format("run_filtered", await runCursor({ prompt: runFilteredPrompt(command, want), cwd, model, effort, force: true })),
);

server.registerTool(
  "web_lookup",
  {
    description:
      "Delegate a web/documentation lookup to the Cursor agent (which has web access): library docs, API references, error messages, current versions. Cheap way to fetch info newer than your training data.",
    inputSchema: { query: z.string().describe("What to look up on the web."), ...routing },
  },
  async ({ query, cwd, model, effort }) =>
    // force: em headless a web search fica esperando aprovação que nunca chega e leva timeout;
    // --force auto-aprova a tool, e mode:'ask' mantém o filesystem read-only.
    format("web_lookup", await runCursor({ prompt: webLookupPrompt(query), cwd, model, effort, mode: "ask", force: true })),
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
