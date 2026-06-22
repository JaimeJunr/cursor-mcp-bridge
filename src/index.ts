#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCursor, type CliResult } from "./cli.js";

const server = new McpServer({ name: "cursor-mcp-bridge", version: "0.2.0" });

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
  "explore",
  {
    description:
      "Read-only codebase exploration, the cheap counterpart to Claude's Explore. Two modes: omit `files` to get a general project map (layout, modules, entry points, build/test, conventions); pass `files` to answer a question about those specific files. Either way the code never enters your context — only the answer does.",
    inputSchema: {
      question: z
        .string()
        .optional()
        .describe("What you want to know. With `files`: a question about them. Without: an optional angle (e.g. 'how auth works'). Omit entirely for a general map."),
      files: z
        .array(z.string())
        .optional()
        .describe("Optional file paths to scope the exploration to (relative to cwd or absolute)."),
      ...routing,
    },
  },
  async ({ question, files, cwd, model, effort }) => {
    let prompt: string;
    let mode: "plan" | "ask";
    if (files?.length) {
      const q = question ?? "Summarize what these files do and how they fit together.";
      prompt = `Read these files and answer. Read-only — do not modify anything.\nFiles: ${files.join(", ")}\n\nQuestion: ${q}`;
      mode = "ask";
    } else {
      const focusLine = question
        ? `Focus on: ${question}.`
        : "Give a general map: top-level layout, main modules and their responsibilities, entry points, how to build/test/run, and notable conventions.";
      prompt = `Explore this project and produce a concise structured overview. Read-only — do not modify anything. ${focusLine} Cite concrete paths.`;
      mode = "plan";
    }
    return format(await runCursor({ prompt, cwd, model, effort, mode }));
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
