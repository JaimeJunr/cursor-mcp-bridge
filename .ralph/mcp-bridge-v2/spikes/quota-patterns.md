# SPIKE — detecção de cota/rate limit nos CLIs nativos

Data da investigação: 2026-09-14.

## Conclusão executiva

`isQuotaError(stderr, engine)` não é uma assinatura confiável para os três CLIs. Nos modos usados pelo bridge, os erros de execução estruturados saem em `stdout`:

- Codex: eventos JSONL `type: "error"` e `type: "turn.failed"`.
- Grok: objeto JSON `{"type":"error","message":"..."}`.
- Claude: objeto JSON terminal com `is_error`, `api_error_status`, `result`/`errors`; a documentação diz explicitamente que falhas ocorridas dentro do run saem em `stdout`.

Os exit codes também não classificam a causa: os três usam apenas sucesso versus falha genérica. A implementação deve receber `stdout`, `stderr` e `exitCode`, analisar primeiro campos JSON e aplicar regex somente às mensagens de erro. Além do booleano, convém preservar a distinção `quota_exhausted` versus `rate_limited`: um 429 pode ser throttle transitório, não cota esgotada.

Nenhuma cota foi deliberadamente consumida ou esgotada nesta investigação.

## Contexto do bridge e precedente existente

O bridge invoca exatamente estes formatos:

- Grok: `--single <prompt> --output-format json` em `src/cli.ts:353-364`.
- Codex: `exec --json ...` em `src/cli.ts:367-398`.
- Claude: `-p --output-format json ...` em `src/cli.ts:401-428`.

O precedente `isCodexEnvError(stderr)` usa comparações de fragmentos específicos e conservadores (`src/cli.ts:18-22`). Esse estilo é adequado para o fallback textual de cota, mas não para decidir qual stream inspecionar.

Há dois problemas adicionais no fluxo atual:

1. `parseCliJson` só lê `result`, `text` e IDs (`src/cli.ts:445-463`); ignora `type`, `is_error`, `api_error_status` e `errors`.
2. No exit não zero, `runOnce` mantém os streams separados até `close`, mas constrói o erro com `stderr.trim() || stdout.trim()` (`src/cli.ts:688-720`). Qualquer conteúdo em `stderr` elimina do erro final o JSON mais útil de `stdout`.

## Codex

### Ambiente local

- Instalado: `/home/jaime/.nvm/versions/node/v22.14.0/bin/codex`.
- Versão: `codex-cli 0.154.0`.
- Executável real: `/home/jaime/.nvm/versions/node/v22.14.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`.
- SHA-256: `3188814c35471432d4123203e0eb38e5bddc60226e3d7ddf0e59e649ea140022`.

O pacote npm é apenas um launcher para um binário Rust estático. Busca de strings no executável encontrou diretamente:

- `You've hit your usage limit` nos offsets `211620195`, `211620262`, `211620297` e outros.
- `usage_limit_exceeded` nos offsets `213080259`, `214987700` e `217163341`.
- `rate_limit_exceeded` nos offsets `213080279`, `213614754` e `214987720`.
- `quota_exceeded` nos offsets `213286412`, `213615070` e `215776330`.
- `rate limit exceeded` nos offsets `211461090`, `217003362` e `221359732`.
- `workspace is out of credits` nos offsets `216968219`, `216968277` e outros.

**Confiança: alta** para a presença dessas strings/códigos na versão instalada. Isso não prova sozinho qual campo ou stream os expõe.

### Forma estruturada observável

O contrato público de `codex exec --json` define `ThreadErrorEvent` com somente `message`. Tanto o evento de erro fatal quanto `turn.failed` usam esse tipo:

```json
{"type":"error","message":"..."}
{"type":"turn.failed","error":{"message":"..."}}
```

Evidência:

- [`exec_events.rs`, tipos de evento e `ThreadErrorEvent`](https://github.com/openai/codex/blob/3abbf9fe2c6b6910e9de61f6a0c5bb468f74b5c8/codex-rs/exec/src/exec_events.rs#L7-L87).
- [`event_processor_with_jsonl_output.rs`, projeção que conserva apenas `message`](https://github.com/openai/codex/blob/3abbf9fe2c6b6910e9de61f6a0c5bb468f74b5c8/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L419-L529).
- [Issue oficial #36562](https://github.com/openai/codex/issues/36562): documenta que `codex exec --json` descarta `codexErrorInfo`, embora Core/App Server já o tenham, e mostra a forma atual `{"type":"turn.failed","error":{"message":"..."}}`.

Internamente, o Codex já diferencia `RateLimitExceeded` de `UsageLimitExceeded`; `QuotaExceeded` também é convertido em `UsageLimitExceeded`. O dado tipado, porém, é perdido na projeção JSONL do `exec`:

- [`protocol/src/error.rs:431-440`](https://github.com/openai/codex/blob/3abbf9fe2c6b6910e9de61f6a0c5bb468f74b5c8/codex-rs/protocol/src/error.rs#L431-L440).

Um rollout persistido pode conter `"codex_error_info":"usage_limit_exceeded"`, como mostra a [issue oficial #20006](https://github.com/openai/codex/issues/20006), mas esse é o arquivo interno da sessão, não o `stdout` de `codex exec --json`. Não se deve depender desse campo no bridge hoje. Vale aceitá-lo como feature detection para uma versão futura.

**Confiança: alta** de que o JSONL atual não fornece um discriminador tipado de cota.

### Texto detectável

A fonte oficial forma variantes para usage limit, workspace sem créditos e spend cap.

Evidência: [`protocol/src/error.rs:655-753`](https://github.com/openai/codex/blob/3abbf9fe2c6b6910e9de61f6a0c5bb468f74b5c8/codex-rs/protocol/src/error.rs#L655-L753). A [issue oficial #38603](https://github.com/openai/codex/issues/38603) registra uma rejeição real do CLI com `ERROR: You've hit your usage limit...` e observa que ela pode chegar como erro de aplicação sobre WebSocket, sem HTTP 429.

Regexes conservadores, depois de normalizar apóstrofo curvo para ASCII e lowercase:

```text
\byou've hit your usage limit\b
\byour workspace is out of credits\b
\byou hit your spend cap\b
\brate limit exceeded\b
```

Os códigos `usage_limit_exceeded`, `quota_exceeded` e `rate_limit_exceeded` devem ser preferidos se surgirem em uma versão futura do JSONL. `429` isolado não é necessário nem suficiente para a cota de plano do Codex: há rejeições de usage limit sem status HTTP.

**Confiança: alta** para as três famílias de cota; **média** para `rate limit exceeded` como sinal terminal no JSONL, pois a string está no binário/fonte, mas não foi observada em uma execução limitada.

### Exit code e stream

O `exec` marca qualquer erro fatal/turn failed e termina com `std::process::exit(1)`; não existe exit code específico de cota: [`exec/src/lib.rs:1164-1264`](https://github.com/openai/codex/blob/3abbf9fe2c6b6910e9de61f6a0c5bb468f74b5c8/codex-rs/exec/src/lib.rs#L1164-L1264).

Com `--json`, o sinal útil deve ser buscado nos eventos JSONL de `stdout`, não apenas em `stderr`.

**Confiança: alta**.

## Grok

### Ambiente local

- Não instalado no `PATH`.
- Existe o symlink `/home/jaime/.local/bin/grok -> /home/jaime/.grok/bin/grok`, mas o alvo não existe.
- Não foi localizado pacote Grok utilizável nos módulos globais/caches consultados. Portanto não houve inspeção de binário nem confirmação de versão local.

**Confiança: alta** sobre a ausência local; isso limita a validação runtime.

### Classificação interna

O projeto oficial `xai-org/grok-build` contém um discriminador forte:

- `RATE_LIMITED_ERROR_CODE = -32003`, reservado por contrato a respostas HTTP 429 reais.
- `subscription:free-usage-exhausted`, código específico da cota gratuita esgotada.
- Mensagens canônicas distintas para cota gratuita, limite de plano OAuth e limite de time/API key.

Evidência: [`sampling/error.rs:11-56`](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-shell/src/sampling/error.rs#L11-L56). A mesma fonte separa overload/capacidade (`529`) de rate limit (`429`) em [`sampling/error.rs:75-100`](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-shell/src/sampling/error.rs#L75-L100).

**Confiança: alta** para o contrato do código-fonte oficial no commit analisado; não confirmado contra um binário local.

### O que o modo `--output-format json` preserva

O achado importante é negativo: o código `-32003` não chega ao JSON terminal usado pelo bridge. O headless detecta internamente `-32003`, escolhe/sanitiza a mensagem e chama o emissor. Para `OutputFormat::Json`, o emissor produz em `stdout` apenas:

```json
{"type":"error","message":"..."}
```

Evidência:

- [`headless.rs:1418-1443`, tratamento de `-32003`](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-pager/src/headless.rs#L1418-L1443).
- [`headless.rs:348-369`, envelope JSON de erro sem `code`](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-pager/src/headless.rs#L348-L369).
- [Guia oficial de headless, seção de falhas](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md#L184-L190): erro JSON e processo com exit não zero.

Assim, para a invocação atual, `type === "error"` confirma que o texto é erro, mas a causa ainda depende de regex sobre `message`. Regexes de alta confiança para as mensagens canônicas:

```text
\byou've reached your free grok build usage limit\b
\byou've hit the rate limit for your plan\b
\byou've hit your team's api rate limit\b
```

O servidor pode fornecer outro corpo para um 429; `format_rate_limited_user_message` o repassa depois de remover o prefixo `API error (status 429...)`. Logo esses três padrões não cobrem comprovadamente todo 429 possível.

**Confiança: alta** para as mensagens canônicas e para a perda do código no JSON; **baixa** para qualquer regex genérica que tente cobrir todos os corpos de 429.

### Exit code e stream

O exit não zero é genérico. No formato JSON, o envelope de erro é escrito em `stdout`; em formato plain, a mensagem vai para `stderr`. O bridge usa JSON.

**Confiança: alta** pelo código-fonte e guia oficiais; sem execução local.

## Claude

### Ambiente local

- Instalado: `/home/jaime/.local/bin/claude`.
- Executável real: `/home/jaime/.local/share/claude/versions/2.1.266`.
- Versão: `2.1.266 (Claude Code)`.
- SHA-256: `19842705e989393fce936804df6d2ab034860e24b8f8880357981d87ffd83fac`.

Busca direta no executável encontrou:

- `Usage limit reached` nos offsets `91938440`, `91938484`, `91938556` e outros.
- `weekly usage limit` nos offsets `91809074` e `203534652`.
- `Credit balance too low` nos offsets `92816888` e `201646344`.
- `Credit balance is too low` nos offsets `95241504` e `185136574`.
- `You've hit your monthly spend limit` nos offsets `92814880`, `95762380` e outros.
- `spend limit reached` nos offsets `99408276`, `200346488` e outros.
- `Request rejected (429)` nos offsets `95755184` e `185153151`.
- `Server is temporarily limiting requests` nos offsets `95243872` e `185140772`.
- Os nomes de campo `rate_limit_event` e `api_error_status` em vários offsets.

**Confiança: alta** para a presença dessas strings e campos na versão instalada.

### Forma estruturada no modo atual

A documentação oficial do headless afirma:

- exit `0` em sucesso e não zero em falha;
- erro de argumento pré-run vai para `stderr`;
- falha dentro do run, como autenticação, é impressa como resultado em `stdout`;
- `--output-format json` retorna um único objeto JSON.

Evidência: [Claude Code — programmatic/headless](https://code.claude.com/docs/en/headless), especialmente “Basic usage” e “Get structured output”.

O objeto terminal `ResultMessage` expõe:

- `is_error: true` quando o run termina em erro;
- `api_error_status`, status HTTP do erro terminal, somente no braço `subtype: "success"` que terminou em API error;
- `result`, que nesse braço contém a mensagem de API quando disponível;
- `errors[]` nos subtypes `error_*`.

Evidência: [Agent SDK Python — `ResultMessage`](https://code.claude.com/docs/en/agent-sdk/python), campos e semântica em torno de `ResultMessage`. A documentação explicita que `api_error_status` pode estar ausente e que `result` pode estar vazio mesmo com `is_error: true`.

Um `is_error === true && api_error_status === 429` é um sinal estruturado forte de rate limit, mas não distingue throttle transitório de spend cap/quota: a [referência oficial da API](https://platform.claude.com/docs/en/api/errors) diz que 429 cobre rate limit, monthly spend cap e limite de workspace do Claude Code. Um spend limit também pode chegar como 400; portanto `api_error_status` sozinho não cobre toda cota.

**Confiança: alta** para a semântica dos campos; **média** para a forma exata do objeto terminal em cada variante de cota de assinatura, pois não foi observada com a conta limitada.

### Sinal estruturado mais forte disponível fora do modo atual

No stream/Agent SDK existe `RateLimitEvent` com `rate_limit_info.status`. O valor `"rejected"` significa que o limite foi atingido; `rate_limit_type` identifica `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet` ou `overage`: [Agent SDK Python — `RateLimitEvent` e `RateLimitInfo`](https://code.claude.com/docs/en/agent-sdk/python).

Em `--output-format stream-json`, retries também geram `system/api_retry` com `error_status` e uma categoria `error`, entre elas `rate_limit` e `billing_error`: [Claude Code headless — “Handle API retries”](https://code.claude.com/docs/en/headless#handle-api-retries). Esse evento é intermediário: informa a causa de uma tentativa, mas sozinho não prova que o run terminou por ela.

Esses são sinais melhores que regex, mas o bridge usa `--output-format json`, que devolve apenas o resultado terminal. Trocar para `stream-json` exigiria mudar o parser e consumir o stream até o resultado final.

**Confiança: alta** no contrato do SDK/stream; **não aplicável diretamente** à invocação atual.

### Texto detectável e distinções importantes

A referência oficial de erros lista mensagens atuais para limites de sessão, semana, família de modelo, gasto mensal/individual/organização/equipe/canal, gateway e saldo de créditos.

Evidência: [Claude Code — Error reference, “Usage limits”](https://code.claude.com/docs/en/errors#usage-limits). A [issue oficial #78617](https://github.com/anthropics/claude-code/issues/78617) também registra `Usage limit reached` e `You've reached your usage limit. Try again after your limit resets.`. A [issue oficial #1491](https://github.com/anthropics/claude-code/issues/1491) mostra o erro de saldo vindo como HTTP 400/`invalid_request_error`, reforçando que procurar apenas 429 perde esse caso.

Rate limit transitório tem textos distintos:

- `API Error: Server is temporarily limiting requests (not your usage limit)` — explicitamente não é quota do plano.
- `API Error: Request rejected (429)...` — rate limit do provider/API key e possivelmente temporário.

Evidência: [“Server is temporarily limiting requests”](https://code.claude.com/docs/en/errors#server-is-temporarily-limiting-requests) e [“Request rejected (429)”](https://code.claude.com/docs/en/errors#request-rejected-429).

Isso exige separar `quota_exhausted` de `rate_limited`. Se o produto quiser que `isQuotaError` englobe ambos, o booleano pode ser derivado dessa classificação, mas a causa não deve ser descartada.

**Confiança: alta**.

## Resumo dos sinais

| engine | sinal detectável | tipo | confiança |
|---|---|---|---|
| codex | JSONL `type:"error".message` ou `type:"turn.failed".error.message` com `You've hit your usage limit`, `workspace is out of credits` ou `spend cap` | campo JSON + regex da mensagem em `stdout` | alta |
| codex | `codex_error_info: "usage_limit_exceeded"` | campo JSON tipado | alta no App Server/rollout, **indisponível hoje** em `codex exec --json` |
| codex | `rate_limit_exceeded` ou `rate limit exceeded` | código futuro/interno ou regex de mensagem | média no output do `exec` |
| codex | exit `1` | exit code genérico | baixa/inútil para classificar causa |
| grok | `type:"error"` + uma das três mensagens canônicas de free/plan/team rate limit | campo JSON + regex da mensagem em `stdout` | alta no fonte oficial; sem binário local |
| grok | ACP code `-32003`; `subscription:free-usage-exhausted` | código estruturado interno | alta internamente, **removido** do JSON headless atual |
| grok | exit não zero | exit code genérico | baixa/inútil para classificar causa |
| claude | `type:"result"`, `is_error:true`, `api_error_status:429` | campo JSON em `stdout` | alta para rate limit; média para dizer “quota esgotada” |
| claude | `RateLimitEvent.rate_limit_info.status:"rejected"` | campo JSON/SDK estruturado | alta, mas requer stream/SDK em vez do JSON único atual |
| claude | mensagens de session/weekly/model/spend limit ou credit balance | regex sobre `result`/`errors` do JSON de `stdout` | alta |
| claude | `Server is temporarily limiting requests` ou `Request rejected (429)` | categoria/regex de rate limit transitório | alta |
| claude | exit não zero | exit code genérico | baixa/inútil para classificar causa |

## Recomendação de API e implementação

Não implementar `isQuotaError(stderr: string, engine)`. Preservar os streams no erro do processo e usar:

```ts
type NativeEngine = Extract<Engine, "codex" | "grok" | "claude">;
type QuotaErrorKind = "quota_exhausted" | "rate_limited" | null;

export interface CliFailureOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export function isQuotaError(
  output: CliFailureOutput,
  engine: NativeEngine,
): boolean {
  return classifyQuotaError(output, engine) !== null;
}
```

Implementação concreta proposta:

```ts
type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function stringField(obj: JsonObject | undefined, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" ? value : undefined;
}

function parseJsonObjects(raw: string): JsonObject[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const whole = record(JSON.parse(trimmed));
    if (whole) return [whole];
  } catch { /* pode ser JSONL */ }

  const objects: JsonObject[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const value = record(JSON.parse(line));
      if (value) objects.push(value);
    } catch { /* ruído não JSON */ }
  }
  return objects;
}

function normalizeErrorText(value: string): string {
  return value.replace(/[‘’]/g, "'").toLowerCase();
}

const QUOTA_PATTERNS: Record<NativeEngine, RegExp[]> = {
  codex: [
    /\byou've hit your usage limit\b/,
    /\byour workspace is out of credits\b/,
    /\byou hit your spend cap\b/,
  ],
  grok: [
    /\byou've reached your free grok build usage limit\b/,
  ],
  claude: [
    /\busage limit reached\b/,
    /\byou've reached your usage limit\b/,
    /\byou've hit your (?:session|weekly|opus|sonnet) limit\b/,
    /\byou've hit your (?:monthly|individual|org's monthly|channel's monthly) (?:spend|usage) limit\b/,
    /\byou've hit your team's shared budget\b/,
    /\bspend limit reached\b/,
    /\bcredit balance (?:is )?too low\b/,
  ],
};

const RATE_LIMIT_PATTERNS: Record<NativeEngine, RegExp[]> = {
  codex: [/\brate limit exceeded\b/],
  grok: [
    /\byou've hit the rate limit for your plan\b/,
    /\byou've hit your team's api rate limit\b/,
  ],
  claude: [
    /\bserver is temporarily limiting requests\b/,
    /\brequest rejected \(429\)\b/,
  ],
};

export function classifyQuotaError(
  output: CliFailureOutput,
  engine: NativeEngine,
): QuotaErrorKind {
  // Evita classificar uma resposta bem-sucedida que apenas mencione essas mensagens.
  if (output.exitCode === 0) return null;

  const objects = parseJsonObjects(output.stdout);
  const serialized = normalizeErrorText(JSON.stringify(objects));
  let structuredRateLimit = false;

  // Campos/códigos estruturados, inclusive feature detection para versões futuras.
  if (engine === "codex" && /usage_limit_exceeded|quota_exceeded/.test(serialized)) {
    return "quota_exhausted";
  }
  if (engine === "grok" && /subscription:free-usage-exhausted/.test(serialized)) {
    return "quota_exhausted";
  }
  if (engine === "codex" && /rate_limit_exceeded/.test(serialized)) {
    structuredRateLimit = true;
  }

  const messages: string[] = [output.stderr];

  for (const obj of objects) {
    const nestedError = record(obj.error);
    const payload = record(obj.payload);

    if (engine === "codex") {
      if (obj.type === "error") messages.push(stringField(obj, "message") ?? "");
      if (obj.type === "turn.failed") messages.push(stringField(nestedError, "message") ?? "");
      if (payload?.type === "error") messages.push(stringField(payload, "message") ?? "");
    }

    if (engine === "grok" && obj.type === "error") {
      messages.push(stringField(obj, "message") ?? "");
      // O JSON atual não expõe -32003; aceita se isso mudar no futuro.
      if (obj.code === -32003) structuredRateLimit = true;
    }

    if (engine === "claude") {
      const isTerminalError = obj.is_error === true || obj.type === "error";
      if (obj.type === "rate_limit_event") {
        const info = record(obj.rate_limit_info);
        if (info?.status === "rejected") return "quota_exhausted";
      }
      // system/api_retry é intermediário; não o trate sozinho como causa terminal.
      if (isTerminalError && obj.api_error_status === 429) structuredRateLimit = true;
      if (stringField(nestedError, "type") === "rate_limit_error") structuredRateLimit = true;
      if (isTerminalError) {
        messages.push(stringField(obj, "result") ?? "");
        if (Array.isArray(obj.errors)) {
          messages.push(...obj.errors.filter((value): value is string => typeof value === "string"));
        }
        messages.push(stringField(nestedError, "message") ?? "");
      }
    }
  }

  // Se o processo quebrou antes de produzir JSON válido, ainda permite o fallback textual.
  if (objects.length === 0) messages.push(output.stdout);
  const text = normalizeErrorText(messages.join("\n"));

  if (QUOTA_PATTERNS[engine].some((pattern) => pattern.test(text))) {
    return "quota_exhausted";
  }
  if (structuredRateLimit || RATE_LIMIT_PATTERNS[engine].some((pattern) => pattern.test(text))) {
    return "rate_limited";
  }
  return null;
}
```

No runner, criar um erro próprio que mantenha `stdout`, `stderr`, `exitCode` e `engine`; classificar antes de reduzir tudo a uma string. Não usar `try again later`, `exceeded`, `insufficient`, `429` textual isolado ou exit não zero como regex: são genéricos demais.

Se for aceitável mudar o protocolo do Claude, `stream-json` + `rate_limit_info.status === "rejected"` elimina boa parte da dependência textual. Para Codex e Grok, o melhor reparo upstream seria preservar respectivamente `codex_error_info` e `-32003`/um `error.code` no output headless.

## Lacunas

- Não foi produzido um erro real de cota nos três CLIs, por restrição explícita e para não gastar quota. Portanto não há captura local completa de `stdout`, `stderr` e exit code de uma conta efetivamente bloqueada.
- O Grok não está instalado. Falta validar qual release/commit um ambiente de produção usa e comparar sua saída com o commit oficial analisado (`37949780c144e37df692e3d669051a21fec24f20`).
- No Codex 0.154.0, as strings e códigos estão no binário, mas `codex exec --json` perde o campo tipado. Falta saber em qual release futura a issue #36562 será resolvida; a implementação deve tratar o campo como opcional.
- No Claude 2.1.266, não foi observada a forma terminal exata de `claude -p --output-format json` para cada limite de assinatura. `is_error`/`api_error_status` são documentados, mas spend cap pode ser 400 e alguns bloqueios de plano podem depender de `rate_limit_info`, não do status terminal.
- `429` não separa cota permanente de throttle transitório no Claude. No Grok, o código interno também representa qualquer HTTP 429. Essa diferença só pode ser preservada por mensagem/headers adicionais ou por uma classificação mais rica do provider.
- Gateways customizados podem substituir mensagens. Não há evidência para uma lista exaustiva de textos de terceiros; adicionar regexes “plausíveis” reduziria a confiabilidade.
- Não foi verificado comportamento com localização diferente de inglês.
- Para fechar as lacunas sem esgotar cota deliberadamente: coletar amostras reais, sanitizadas, quando usuários já bloqueados encontrarem o erro; adicionar fixtures dessas capturas; e executar contract tests por versão do CLI. Para Grok, primeiro instalar a versão usada em produção e confirmar o JSON headless com um servidor mock que devolva 429 e `subscription:free-usage-exhausted`.

---

## ADENDO — captura real de cota do grok (2026-09-13)

Evidência **observada em runtime**, não inferida. O preflight do `ralph.sh` bateu na cota do grok
nesta máquina, e o sinal real **diverge do que este spike previu**.

### O que foi observado

Engine: `grok 1.0.26`, invocado em `--output-format streaming-messages-json`.

```json
{"type":"result","subtype":"error_during_execution","is_error":true,
 "errors":["Internal error: {\n  \"message\": \"API error (status 402 Payment Required): Grok Build usage balance exhausted\",\n  \"http_status\": 402\n}"]}
```

Também emitido em texto na saída:

```
Error: Internal error: {
  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",
  "http_status": 402
}
```

### Correções que isto impõe ao corpo deste spike

| O que o spike dizia | O que foi observado |
|---|---|
| Rate limit/cota do grok chega como HTTP **429** (`-32003`) | Cota esgotada chega como HTTP **402 Payment Required** |
| Regex `\byou've reached your free grok build usage limit\b` | String real: `Grok Build usage balance exhausted` — **não casa** |
| Campo estruturado some no headless | `http_status: 402` **está presente**, aninhado como JSON dentro da string de `errors[]` |

O campo `http_status` sobrevive, mas **serializado como texto dentro de `errors[0]`** — é um JSON
aninhado numa string, não um campo de primeiro nível. Qualquer parser precisa desaninhar.

### Padrão corrigido para o grok

```
http_status 402                      -> quota_exhausted  (alta confiança, observado)
/grok build usage balance exhausted/ -> quota_exhausted  (alta confiança, observado)
http_status 429 / -32003             -> rate_limited     (média, do fonte oficial, não observado)
```

`402` não aparecia em lugar nenhum da investigação original — nem nos três engines. Vale re-checar
se codex e claude também usam 402 para saldo/cota, já que a referência da Anthropic menciona 400
para saldo de crédito e 429 para rate limit, e agora sabemos que 402 é um terceiro caso possível.

### Lacuna que isto abre

Codex e claude **não** tiveram captura real — seus padrões continuam vindo de binário/documentação.
Dado que a única captura real que existe contradiz a previsão, trate os padrões de codex e claude
como **hipóteses não confirmadas**, não como fato.

---

## ADENDO 2 — captura real de cota do codex (2026-09-13)

Segunda captura de runtime, ~15 min após a do grok. Desta vez a previsão do spike **acertou**.

### O que foi observado

Engine: `codex-cli 0.154.0`, via `codex exec --json`, disparado pelo preflight do `ralph.sh`.

```
[STATUS] ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro),
visit https://chatgpt.com/codex/settings/usage to purchase more credits or
try again at Sep 14th, 2026 1:44 AM.
[STATUS] Codex event: turn.failed
```

### Confirmações

| Previsão do spike | Observado |
|---|---|
| String `You've hit your usage limit` | **Confirmada, literal** |
| Chega como evento `turn.failed` no JSONL | **Confirmado** |
| Sem discriminador tipado (`codex_error_info` ausente no `exec --json`) | **Confirmado** — só a mensagem |

O regex `\byou've hit your usage limit\b` proposto no corpo deste spike **casa** com a saída real.
A mensagem ainda carrega o horário de reset (`try again at <data>`), informação útil que vale
propagar no erro acionável da US-006 em vez de descartar.

### Estado de confiança, atualizado

| engine | padrão | status |
|---|---|---|
| grok | `402` + `Grok Build usage balance exhausted` | **confirmado em runtime** (adendo 1) — previsão original estava errada |
| codex | `You've hit your usage limit` em `turn.failed` | **confirmado em runtime** (este adendo) — previsão original certa |
| claude | strings de binário/doc | **ainda não confirmado** — único que resta |

O ASSUMPTION-LOCK do PRD sobre "codex e claude são hipótese não confirmada" ficou **parcialmente
resolvido**: vale agora só para o claude.

### Achado lateral, fora do escopo deste repo

O `ralph.sh` **detectou** a exaustão do codex e rotacionou (`Token/quota exhaustion detected for
codex → switching RALPH_TOOL to grok`), mas classificou o `402` do grok como `generic CLI error` e
abortou a cadeia em vez de seguir para claude/amp. A cegueira dele é específica ao 402 — não a
cota em geral. Reforça que `402` é o caso que ninguém previu.

---

## ADENDO 3 — auth expirado NÃO é cota (2026-09-13)

> **CORREÇÃO (2026-09-13, posterior):** o diagnóstico original deste adendo estava errado na
> **causa**, embora certo na **classificação**. O `OAuth session expired` do claude não era sessão
> expirando naturalmente nem falta de login: era **bug do próprio bridge**. O bind de
> `.claude/.credentials.json` no sandbox era read-only, então o CLI renovava o oauth dentro do
> bwrap, falhava com `EROFS` ao persistir o par novo, e — como o refresh token já havia sido
> rotacionado no servidor nesse ponto — o que ficava em disco era um token queimado, derrubando a
> auth do host inteiro, não só do worker. Corrigido em `d6c0687` (`fix(sandbox): montar a
> credencial oauth do claude como RW`), já em `origin/master`.
>
> Isso **reforça** a lição do adendo, não a enfraquece: rotacionar de engine diante de um erro de
> auth teria mascarado um bug do próprio bridge que estava destruindo a credencial do usuário a
> cada chamada. Um classificador que responda "cota, troque de engine" a esse sintoma esconde
> exatamente o tipo de falha que precisa ser vista.

Terceira captura de runtime. Revela uma **lacuna no PRD selado**, não só no spike.

### O que foi observado

`claude 2.1.266`, via `claude -p --output-format json`:

```
[AI] Failed to authenticate: OAuth session expired and could not be refreshed
```

`cursor-agent`:

```
Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.
```

### O falso positivo

O `ralph.sh` classificou o erro de OAuth do claude como **exaustão de cota**:

```
[ralph] Token/quota exhaustion detected for claude → switching RALPH_TOOL to agent
```

Isso está errado, e o erro é do tipo que causa dano: trocar de engine não resolve uma sessão
expirada. O remédio é re-autenticar aquele engine. Rotacionar só queima a próxima tentativa e
esconde do usuário a única ação que resolveria.

### Lacuna que isto abre no PRD

A US-006 do `prd-update-1.html` distingue `quota_exhausted` de `rate_limited`. **Não distingue
nenhum dos dois de falha de autenticação.** Um classificador que veja "não consegui usar este
engine" e conclua "cota" comete exatamente o erro que o `ralph.sh` acabou de cometer.

Falta um terceiro estado, algo como `auth_expired`, cuja mensagem acionável é **re-autenticar este
engine**, nunca trocar de engine. Material para o próximo update do PRD — não foi incorporado aqui
porque o documento já está selado.

### Padrões observados

```
/oauth session expired/i          -> auth_expired  (claude, alta confiança, observado)
/failed to authenticate/i         -> auth_expired  (claude, alta confiança, observado)
/authentication required/i        -> auth_expired  (cursor-agent, alta confiança, observado)
/please run '[a-z-]+ login'/i     -> auth_expired  (cursor-agent, alta confiança, observado)
```

### Estado de confiança, atualizado

| engine | cota | auth |
|---|---|---|
| grok | `402` + `Grok Build usage balance exhausted` — **confirmado** | não observado |
| codex | `You've hit your usage limit` — **confirmado** | não observado |
| claude | não observado | `OAuth session expired` — **confirmado** |
| cursor-agent | não observado | `Authentication required` — **confirmado** |
