import { describe, it, expect } from "vitest";
import {
  readSlicePrompt, runFilteredPrompt, explorePrompt, webLookupPrompt, generateImagePrompt,
} from "../src/prompts.js";

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
