/**
 * Egress scrubber: detecta strings com forma de credencial no texto devolvido por um worker
 * (chaves de provedor conhecidas, tokens rotulados, strings alfanuméricas de alta entropia) e as
 * substitui por um placeholder fixo. Função pura — wired em format() (src/index.ts) antes do
 * footer de session_id.
 */
const PLACEHOLDER = "[REDACTED]";

/** Padrões de credencial, do mais específico (prefixo de provedor) ao mais genérico (entropia). */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /\bghp_[A-Za-z0-9]{36}\b/g, // GitHub PAT clássico
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, // GitHub PAT fine-grained
  /\bsk-[A-Za-z0-9]{20,}\b/g, // chave estilo OpenAI
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // token Slack
  /Bearer\s+[A-Za-z0-9\-_.]{20,}/g, // bearer token
  /(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret)\s*[:=]\s*['"]?[A-Za-z0-9\-_./+]{16,}['"]?/gi, // segredo rotulado
  // string mista maiúscula+minúscula+dígito, 32+ chars: alta entropia sem depender de rótulo.
  // Exclui hashes hex puros (git SHA), que não têm letra maiúscula.
  /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{32,}\b/g,
];

/** Detecta e redige credenciais no texto. Devolve o texto (possivelmente alterado) e se algo foi redigido. */
export function scrubSecrets(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  let out = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0; // regex global mantém estado entre usos — sempre reseta antes de testar
    if (!pattern.test(out)) continue;
    redacted = true;
    pattern.lastIndex = 0;
    out = out.replace(pattern, PLACEHOLDER);
  }
  return { text: out, redacted };
}
