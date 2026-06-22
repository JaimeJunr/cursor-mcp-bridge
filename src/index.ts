#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCursor, type CliResult } from "./cli.js";

const server = new McpServer({ name: "cursor-mcp-bridge", version: "0.1.0" });

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

function format(res: CliResult): { content: { type: "text"; text: string }[] } {
  const footer = res.sessionId
    ? `\n\n---\nsession_id: ${res.sessionId} (pass to follow_up to continue this session)`
    : "";
  return { content: [{ type: "text", text: res.text + footer }] };
}

server.registerTool(
  "delegate",
  {
    description:
      "Delegate a task to the Cursor CLI agent running headless (agent -p). Cheap/fast worker with full tool access (read, edit, shell) in cwd. Use for routine implementation, edits, and tasks where a cheaper model is enough.",
    inputSchema: { prompt: z.string().describe("The complete task prompt for the Cursor agent."), ...routing },
  },
  async ({ prompt, cwd, model, effort }) => format(await runCursor({ prompt, cwd, model, effort })),
);

server.registerTool(
  "discovery",
  {
    description:
      "Map and explain a project: structure, key modules, entry points, build/test commands, conventions. Read-only (plan mode). Use to onboard onto an unfamiliar codebase without spending your own context reading it.",
    inputSchema: {
      focus: z
        .string()
        .optional()
        .describe("Optional angle, e.g. 'how auth works', 'where the API routes live'. Omit for a general map."),
      ...routing,
    },
  },
  async ({ focus, cwd, model, effort }) => {
    const focusLine = focus
      ? `Focus on: ${focus}.`
      : "Give a general map: top-level layout, main modules and their responsibilities, entry points, how to build/test/run, and notable conventions.";
    const prompt = `Explore this project and produce a concise structured overview. Read-only — do not modify anything. ${focusLine} Cite concrete paths.`;
    return format(await runCursor({ prompt, cwd, model, effort, mode: "plan" }));
  },
);

server.registerTool(
  "analyze_files",
  {
    description:
      "Answer questions about specific files without loading them into your context. Read-only (ask mode). Cheaper alternative to reading large files yourself.",
    inputSchema: {
      files: z.array(z.string()).min(1).describe("File paths to analyze (relative to cwd or absolute)."),
      question: z.string().describe("What you want to know about these files."),
      ...routing,
    },
  },
  async ({ files, question, cwd, model, effort }) => {
    const prompt = `Read these files and answer the question. Read-only — do not modify anything.\nFiles: ${files.join(", ")}\n\nQuestion: ${question}`;
    return format(await runCursor({ prompt, cwd, model, effort, mode: "ask" }));
  },
);

server.registerTool(
  "follow_up",
  {
    description:
      "Continue a previous Cursor session by session_id (returned by every other tool). The prior context lives on Cursor's side, so you don't resend it.",
    inputSchema: {
      session_id: z.string().describe("The session id returned by a previous cursor-mcp-bridge call."),
      question: z.string().describe("The follow-up question."),
      ...routing,
    },
  },
  async ({ session_id, question, cwd, model, effort }) =>
    format(await runCursor({ prompt: question, resume: session_id, cwd, model, effort })),
);

const transport = new StdioServerTransport();
await server.connect(transport);
