import { describe, it, expect } from "vitest";
import {
  isFullFileRequest, readSlicePrompt, runFilteredPrompt, explorePrompt, webLookupPrompt,
  generateImagePrompt, generateImageGrokPrompt, planPrompt, buildPrompt, fanOutArbiterPrompt,
} from "../src/prompts.js";

describe("planPrompt", () => {
  it("pede um PLANO read-only (não editar) e inclui a task", () => {
    const p = planPrompt("add a redis cache");
    expect(p).toMatch(/DO NOT write or edit/i);
    expect(p).toContain("add a redis cache");
  });
});

describe("buildPrompt", () => {
  it("embrulha o plano aprovado e exige código + testes", () => {
    const p = buildPrompt("step 1: create Foo");
    expect(p).toContain("APPROVED PLAN");
    expect(p).toContain("step 1: create Foo");
    expect(p).toMatch(/tests/i);
  });
});

describe("readSlicePrompt", () => {
  it("names the files and the target, and forbids the full dump", () => {
    const p = readSlicePrompt(["a.ts", "b.ts"], "the foo function");
    expect(p).toContain("a.ts, b.ts");
    expect(p).toContain("the foo function");
    expect(p).toMatch(/file:line/i);
    expect(p).toMatch(/read-only|do not modify/i);
  });

  it("demands the source code alongside the prefix, not the prefix alone", () => {
    const p = readSlicePrompt(["a.ts"], "the foo function");
    // Regressão: o Cursor devolvia só `file:line` sem o código. O prompt precisa
    // exigir o código na mesma linha e dar um exemplo do formato.
    expect(p).toMatch(/file:line:\s*<.*code.*>/i);
    expect(p).toMatch(/never emit the .*prefix by itself/i);
    expect(p).toMatch(/\.ts:\d+:\s+\S+/); // exemplo tem prefixo seguido de código real
  });
});

describe("isFullFileRequest", () => {
  it("detects the reported full-file verbatim request", () => {
    const want = "full content of the file, verbatim, especially control flow sections for INTAKE, SPEC, RED/GREEN, VERIFY, CLASSIFY, SHIP, CI-GATE and the loop between fix-implementer and fix-verifier on FAIL";
    expect(isFullFileRequest(want)).toBe(true);
  });

  it.each(["the whole file", "entire content", "complete source"])(
    "detects %s",
    (want) => expect(isFullFileRequest(want)).toBe(true),
  );

  it.each([
    "the login handler and its imports",
    "the full name of the exported function",
    "quote this line verbatim",
  ])("does not block narrow request %s", (want) => {
    expect(isFullFileRequest(want)).toBe(false);
  });

  it.each([
    "the full text search query builder",
    "where the full file path is computed",
    "the complete source map generation function",
    "the full content-type header validation",
  ])("does not block qualified narrow request %s", (want) => {
    expect(isFullFileRequest(want)).toBe(false);
  });

  it.each([
    "content of the whole configuration file",
    "the whole config file",
    "give me the full-file dump",
    "entire files, top to bottom",
    "the file in full",
    "all contents of the file",
    "print every line of the file",
  ])("detects natural full-file request %s", (want) => {
    expect(isFullFileRequest(want)).toBe(true);
  });

  it("conservatively blocks an ambiguous full-file request narrowed afterward", () => {
    expect(isFullFileRequest(
      "the function that reads the entire file into memory - just its signature",
    )).toBe(true);
  });

  it("treats verbatim plus a file mention as an independent full-file signal", () => {
    expect(isFullFileRequest("copy the error message verbatim from the file")).toBe(true);
  });
});

describe("runFilteredPrompt", () => {
  it("embeds the command and the relevance filter", () => {
    const p = runFilteredPrompt("npm test", "failing tests only");
    expect(p).toContain("npm test");
    expect(p).toContain("failing tests only");
  });

  it("works without an explicit filter", () => {
    const p = runFilteredPrompt("npm run build");
    expect(p).toContain("npm run build");
  });
});

describe("explorePrompt", () => {
  it("uses ask mode and a general map when no files and no question", () => {
    const { prompt, mode } = explorePrompt();
    expect(mode).toBe("ask");
    expect(prompt).toMatch(/map|layout/i);
  });

  it("uses ask mode, scopes to files, and asks for code snippets", () => {
    const { prompt, mode } = explorePrompt("how does auth work", ["auth.ts"]);
    expect(mode).toBe("ask");
    expect(prompt).toContain("auth.ts");
    expect(prompt).toContain("how does auth work");
    expect(prompt).toMatch(/snippet|file:line|relevant code/i);
  });

  it("question without files → fan-out search (Explore-grade): ask mode, file:line refs, locate-not-review", () => {
    const { prompt, mode } = explorePrompt("where is the login handler defined");
    expect(mode).toBe("ask");
    expect(prompt).toContain("where is the login handler defined");
    expect(prompt).toMatch(/file:line/i);
    expect(prompt).toMatch(/fan.?out|sweep|multiple|naming convention/i);
    expect(prompt).toMatch(/locate|do not (review|audit|judge)/i);
    // Regressão: mode=plan fazia o worker "formalizar um plano" em vez de responder.
    expect(prompt).toMatch(/answer (the question )?directly|do not (produce|write) a plan/i);
  });

  it("breadth 'thorough' pushes exhaustiveness harder than the default", () => {
    const medium = explorePrompt("find all call sites of foo").prompt;
    const thorough = explorePrompt("find all call sites of foo", undefined, "thorough").prompt;
    expect(thorough).toMatch(/exhaustive|every|thorough|don.t stop/i);
    expect(thorough).not.toEqual(medium);
  });
});

describe("webLookupPrompt", () => {
  it("embeds the query and asks for sources", () => {
    const p = webLookupPrompt("zod v4 changes");
    expect(p).toContain("zod v4 changes");
    expect(p).toMatch(/source|link/i);
  });
});

describe("generateImagePrompt", () => {
  it("generate mode: exige gpt-image-2, outPath e proíbe downgrade silencioso", () => {
    const p = generateImagePrompt("a red circle on white", "out/hero.png");
    expect(p).toContain("gpt-image-2");
    expect(p).toContain("out/hero.png");
    expect(p).toMatch(/gpt-image-1|downgrade|never silently/i);
    expect(p).toMatch(/generate a new image/i);
  });

  it("edit mode: instrui edição preservando o resto e inclui outPath", () => {
    const p = generateImagePrompt("make the sky purple", "out/edited.png", ["src/photo.png"]);
    expect(p).toContain("out/edited.png");
    expect(p).toMatch(/edit.*attached|attached image/i);
    expect(p).toMatch(/keep everything|not explicitly mentioned/i);
    expect(p).toMatch(/make the sky purple/i);
  });
});

describe("fanOutArbiterPrompt", () => {
  it("embeds each worker's engine, level, session_id, and text", () => {
    const p = fanOutArbiterPrompt([
      { engine: "codex", level: 1, sessionId: "abc", text: "the bug is in auth.ts:42" },
      { engine: "grok", level: 2, sessionId: "def", text: "the bug is in auth.ts:42" },
    ]);
    expect(p).toContain("codex");
    expect(p).toContain("grok");
    expect(p).toContain("abc");
    expect(p).toContain("def");
    expect(p).toContain("auth.ts:42");
  });

  it("asks for a compact consensus/disagreement digest, not a rehash", () => {
    const p = fanOutArbiterPrompt([{ engine: "codex", level: 1, text: "x" }]);
    expect(p).toMatch(/agree/i);
    expect(p).toMatch(/diverg|disagree/i);
    expect(p).toMatch(/compact|concise|terse/i);
  });

  it("marks failed workers distinctly", () => {
    const p = fanOutArbiterPrompt([
      { engine: "codex", level: 1, text: "ok result" },
      { engine: "grok", level: 2, text: "timed out", error: true },
    ]);
    expect(p).toMatch(/fail/i);
  });
});

describe("generateImageGrokPrompt", () => {
  it("generate mode: usa image_gen, exige PNG/outPath e não vaza instruções do codex", () => {
    const p = generateImageGrokPrompt("a red circle on white", "out/hero.png");
    expect(p).toContain("image_gen");
    expect(p).toContain("out/hero.png");
    expect(p).toMatch(/PNG.*convert|convert.*PNG/is);
    expect(p).not.toMatch(/gpt-image-2|~\/\.codex/i);
  });

  it("edit mode: usa image_edit e inclui todos os paths de referência", () => {
    const p = generateImageGrokPrompt(
      "make the sky purple",
      "out/edited.png",
      ["src/photo.png", "refs/style.jpg"],
    );
    expect(p).toContain("image_edit");
    expect(p).toContain("src/photo.png");
    expect(p).toContain("refs/style.jpg");
    expect(p).toContain("out/edited.png");
    expect(p).toMatch(/PNG.*convert|convert.*PNG/is);
    expect(p).not.toMatch(/gpt-image-2|~\/\.codex/i);
  });
});
