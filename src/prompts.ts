/**
 * Prompt builders puros — isolados de index.ts para serem testáveis sem subir o server.
 * Cada função devolve o texto (e o modo, quando aplicável) passado ao Cursor agent.
 */

/**
 * read_slice: extrai só o trecho relevante de arquivo(s). O arquivo inteiro nunca
 * entra no contexto do chamador — só as linhas pedidas (que são código). Ataca a
 * leitura de arquivo inteiro.
 * @example readSlicePrompt(["auth.ts"], "the login handler")
 */
export function readSlicePrompt(files: string[], want: string): string {
  return [
    "Read the file(s) below and return ONLY the code relevant to the target.",
    "Read-only — do not modify anything.",
    "Output the exact lines verbatim, each prefixed with `file:line`.",
    "Do NOT dump whole files, do NOT summarize, do NOT add commentary beyond the requested lines.",
    "If nothing matches, say so in one line.",
    "",
    `Files: ${files.join(", ")}`,
    `Target: ${want}`,
  ].join("\n");
}

/**
 * run_filtered: roda um comando e devolve só o que importa. Complementa filtros
 * mecânicos (rtk): aqui o Cursor filtra por relevância semântica.
 * @example runFilteredPrompt("npm test", "failing tests only")
 */
export function runFilteredPrompt(command: string, want?: string): string {
  const filter = want
    ? `Report ONLY what is relevant to: ${want}.`
    : "Report ONLY the meaningful signal (errors, failures, results) — drop noise.";
  return [
    "Run exactly this shell command in the project and inspect its output.",
    filter,
    "Be concise: no preamble, no full log dump, quote error lines verbatim.",
    "",
    `Command: ${command}`,
  ].join("\n");
}

/** Modo read-only do Cursor para exploração. */
export type ExploreMode = "plan" | "ask";

/**
 * explore: mapa geral do projeto (sem `files`) ou resposta escopada a arquivos
 * (com `files`), citando as linhas de código relevantes.
 */
export function explorePrompt(question?: string, files?: string[]): { prompt: string; mode: ExploreMode } {
  if (files?.length) {
    const q = question ?? "Summarize what these files do and how they fit together.";
    const prompt = [
      "Read these files and answer. Read-only — do not modify anything.",
      "Quote the relevant code snippets inline with `file:line` so the answer is self-contained.",
      "",
      `Files: ${files.join(", ")}`,
      `Question: ${q}`,
    ].join("\n");
    return { prompt, mode: "ask" };
  }
  const focusLine = question
    ? `Focus on: ${question}.`
    : "Give a general map: top-level layout, main modules and their responsibilities, entry points, how to build/test/run, and notable conventions.";
  const prompt = `Explore this project and produce a concise structured overview. Read-only — do not modify anything. ${focusLine} Cite concrete paths.`;
  return { prompt, mode: "plan" };
}

/** web_lookup: consulta web/docs delegada ao Cursor (que tem acesso à web). */
export function webLookupPrompt(query: string): string {
  return `Look this up on the web and answer concisely with sources/links.\n\nQuery: ${query}`;
}
