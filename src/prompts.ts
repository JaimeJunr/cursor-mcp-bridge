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
    "Output each matching line as `file:line: <the exact source code on that line>`.",
    "The line's source code is REQUIRED — never emit the `file:line` prefix by itself.",
    "Example of the expected format (one line per source line):",
    "  src/auth.ts:42: export function login(req, res) {",
    "  src/auth.ts:43:   const token = sign(req.user);",
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

/** Amplitude da varredura, espelhando o "medium" | "very thorough" do Explore do Claude Code. */
export type ExploreBreadth = "medium" | "thorough";

/**
 * explore: contraparte barata do Explore do Claude Code. Três modos:
 *  - com `files` → responde uma pergunta escopada a eles, citando trechos com file:line;
 *  - com `question` sem `files` → busca fan-out no repo (localizar/mapear), devolve a
 *    conclusão + referências file:line (não despeja arquivos);
 *  - sem nada → mapa geral do projeto.
 * Porta as características do Explore nativo: varredura ampla, conclusão em vez de dump,
 * localizar-não-revisar, e amplitude ajustável (`breadth`).
 */
export function explorePrompt(
  question?: string,
  files?: string[],
  breadth: ExploreBreadth = "medium",
): { prompt: string; mode: ExploreMode } {
  if (files?.length) {
    const q = question ?? "Summarize what these files do and how they fit together.";
    const prompt = [
      "Read these files and answer. Read-only — do not modify anything.",
      "Locate and explain — do not review, audit, or judge the code.",
      "Quote only the pivotal code snippets inline with `file:line` so the answer is self-contained; do not dump whole files.",
      "",
      `Files: ${files.join(", ")}`,
      `Question: ${q}`,
    ].join("\n");
    return { prompt, mode: "ask" };
  }
  if (question) {
    // Busca fan-out estilo Explore: varre amplo, segue convenções de nome, devolve refs.
    const depth =
      breadth === "thorough"
        ? "Be exhaustive: sweep every plausible directory and naming convention (plural/singular, synonyms, mirror paths like controller/model/view); don't stop at the first hit."
        : "Cast a reasonably wide net across the likely directories and naming conventions.";
    const prompt = [
      "Search this codebase to answer the question below. Read-only — do not modify anything.",
      "Answer the question directly — do NOT produce a plan, a task list, or next steps.",
      "Locate and map — do not review, audit, or judge the code.",
      depth,
      "Return a concise conclusion followed by concrete `file:line` references; quote only the pivotal lines, never whole files.",
      "If the answer spans several places, list each with its `file:line`.",
      "",
      `Question: ${question}`,
    ].join("\n");
    return { prompt, mode: "ask" };
  }
  const prompt =
    "Explore this project and produce a concise structured map. Read-only — do not modify anything. " +
    "Answer directly — do NOT produce a plan, a task list, or next steps. " +
    "Give a general map: top-level layout, main modules and their responsibilities, entry points, how to " +
    "build/test/run, and notable conventions. Cite concrete paths.";
  return { prompt, mode: "ask" };
}

/** web_lookup: consulta web/docs delegada ao Cursor (que tem acesso à web). */
export function webLookupPrompt(query: string): string {
  return `Look this up on the web and answer concisely with sources/links.\n\nQuery: ${query}`;
}

/**
 * plan (fase 1 do plan→build): um modelo forte lê a codebase e devolve um PLANO de implementação,
 * sem editar nada. O plano é revisado/aprovado pelo chamador e então passado ao `build`.
 */
export function planPrompt(task: string): string {
  return [
    "Produce a concrete, actionable implementation PLAN for the task below. DO NOT write or edit any code — planning only.",
    "Read whatever files you need to ground the plan in the REAL codebase (cite actual paths and symbols).",
    "Structure it as: (1) one-paragraph approach; (2) numbered steps, each naming the files to touch and a verification check; (3) risks/edge cases; (4) how to test.",
    "Be specific and tight — no boilerplate, no preamble.",
    "",
    `Task: ${task}`,
  ].join("\n");
}

/**
 * build (fase 2 do plan→build): o executor implementa um PLANO já aprovado (saída do `plan`),
 * com acesso total (edições + testes). Segue o plano fielmente.
 */
export function buildPrompt(plan: string): string {
  return [
    "Implement the APPROVED plan below. Follow it faithfully; if you must deviate, say why in your final summary.",
    "Write the code AND the tests. Run the tests and make them pass before finishing.",
    "Keep the change minimal and match the existing code style. Return a concise summary (files changed, tests run).",
    "",
    "=== APPROVED PLAN ===",
    plan,
  ].join("\n");
}

/** Saída de um worker do `fan_out`, repassada ao arbiter para comparação. */
export interface FanOutWorkerOutput {
  engine: string;
  level: number;
  sessionId?: string;
  text: string;
  /** true quando o worker falhou/timeout — o texto vira a mensagem de erro. */
  error?: boolean;
}

/**
 * fan_out (modo "consensus"): pede a um engine barato que compare N outputs do MESMO prompt
 * e devolva um digest compacto — nunca um reprocessamento integral de cada output (isso
 * derrotaria a economia de contexto que o `fan_out` existe para dar).
 */
export function fanOutArbiterPrompt(outputs: FanOutWorkerOutput[]): string {
  const sections = outputs
    .map((o, i) => {
      const tag = [`engine: ${o.engine}`, `level: ${o.level}`];
      if (o.sessionId) tag.push(`session_id: ${o.sessionId}`);
      if (o.error) tag.push("FAILED");
      return `--- Worker ${i + 1} (${tag.join(", ")}) ---\n${o.text}`;
    })
    .join("\n\n");
  return [
    "Multiple worker agents were given the SAME task independently. Compare their outputs below and",
    "produce a COMPACT consensus/disagreement digest — do NOT restate or rehash each output in full.",
    "Structure your reply as:",
    "1. Agreement summary — what all/most workers agree on.",
    "2. Points of divergence — where workers disagree, citing WHICH worker (its engine + level, and",
    "   session_id when present) holds which claim.",
    "3. Recommendation — if workers diverge, which claim you'd trust most and why. Note any worker",
    "   that FAILED and should be disregarded.",
    "Be terse and concise: the digest is read instead of the raw outputs, so it must stay short.",
    "",
    sections,
  ].join("\n");
}

/**
 * generate_image: instrui o codex a usar o image_gen built-in (gpt-image-2) para gerar ou editar
 * uma imagem e salvar no outPath dentro do cwd.
 */
export function generateImagePrompt(description: string, outPath: string, inputImages?: string[]): string {
  const modelRule = [
    "Use your built-in image generation tool (image_gen) with the gpt-image-2 model.",
    "NEVER silently downgrade to gpt-image-1 or gpt-image-1.5; if gpt-image-2 is unavailable, say so explicitly.",
  ].join(" ");

  const task = inputImages?.length
    ? `Edit the attached image(s) according to: ${description}. Keep everything not explicitly mentioned (subject, framing, identity, text). Save non-destructively (do not overwrite the source).`
    : `Generate a new image: ${description}.`;

  const saveRule = [
    `The final PNG MUST be saved to the path ${outPath} inside the current working directory.`,
    "If you save it first under ~/.codex/generated_images, MOVE it to that path.",
    "Never leave the result only in the codex cache.",
  ].join(" ");

  const report = [
    "Report in plain text: the final saved path, the file size, and which image model was actually used.",
  ].join(" ");

  return [modelRule, task, saveRule, report].join("\n\n");
}

/** generate_image via Grok: usa image_gen/image_edit built-in e salva o PNG dentro do cwd. */
export function generateImageGrokPrompt(description: string, outPath: string, inputImages?: string[]): string {
  const task = inputImages?.length
    ? `Use your built-in \`image_edit\` tool. Source/reference image(s) (filesystem paths in the current working directory): ${inputImages.join(", ")}. Edit them as follows: ${description}.`
    : `Use your built-in \`image_gen\` tool to generate the following image: ${description}.`;

  const saveRule = [
    `Save the final result as a PNG at the exact path \`${outPath}\` inside the current working directory.`,
    `If the tool produces a JPEG or saves to a cache/downloads location first, convert to PNG and move it to \`${outPath}\`.`,
    "Never leave it only in a cache.",
  ].join(" ");

  return [task, saveRule, "Report ONLY the final saved path — no summary."].join("\n\n");
}
