# REVISÃO 4 — consolidação integral da distribuição

**Data:** 30/10/2026
**Versão da distribuição:** **REV4** · Kirana **0.5.4** · Gateway **0.4.1**
**Base direta:** REV3, SHA-256 `3081caf4a5c1c86c1743240f8159a1eeb2b34b19fe1837a24d72041b43d97882`
**Versões do produto NÃO mudaram** (0.5.4 / 0.4.1): a REV4 é consolidação + ferramenta de validação, não reescrita.

---

## 1. Por que esta revisão existe

Até a REV3 a instalação completa era um ZIP, e a validação de modelos vivia **fora** dele
(`Kirana-REV3-Validacao-Modelos-Reais-v2.zip`). Isso obrigava a aplicar dois pacotes e deixava o
usuário com duas verdades sobre "o que é a distribuição atual".

A REV4 resolve isso: **um ZIP**, com o verificador dentro, nos diretórios corretos, e um comando
próprio (`VALIDAR-MODELOS-REAIS.cmd`) ao lado de `INSTALAR-WINDOWS.cmd` e `INICIAR-TUDO.cmd`.

Nada do produto foi reescrito. O código de `Kirana/src` e `Gateway/src` é **byte a byte** o da REV3.

---

## 2. O que entrou

| Caminho | Origem | Finalidade |
|---|---|---|
| `tools/validar-modelos-reais.mjs` | pacote auxiliar, **revisado nesta etapa** | V00 (estado/catálogo/capacidades), inferência, identidade via `/v1/runs`, streaming, cancelamento, erros, segredos em log; escreve os relatórios |
| `VALIDAR-MODELOS-REAIS.cmd` | pacote auxiliar | atalho Windows, com mensagens claras para 0/1/3 de saída |
| `tools/duble-gateway-autorizado.mjs` | pacote auxiliar, **alinhado ao contrato real** | testa o verificador sem SIWC; nunca é o Gateway e não fala com provedor |
| `docs/validacao/LEIA-ME.txt` | novo | explica que a pasta recebe a execução **do usuário** |
| `docs/validacao/*.md` | execução de 30/10 | amostra do formato, marcada como BLOQUEADO por SIWC |
| `docs/TAMA_T03_B0_BLOQUEIO_SIWC.md` | pacote auxiliar | procedimento operacional do bloqueio (o que fazer no Windows) |
| `docs/GATEWAY_REV3_ACESSO_PRIVADO_STATUS.md` | pacote auxiliar | estado do acesso privado + procedimento de rollback do Serve |
| `VERSAO-DISTRIBUICAO.txt` | novo | identidade da distribuição e rastreabilidade REV4 → REV3 → REV2 |
| `docs/REVISAO-4.md` | este arquivo | relatório de alterações |

`tools/verificar-pacote.mjs` passou a **exigir** esses arquivos — se alguém remover o verificador do
pacote no futuro, a verificação falha em vez de passar silenciosamente.

---

## 3. Divergências encontradas ao conferir o código (e o que foi feito)

Esta é a parte técnica desta revisão. Foram conferidas as afirmações do verificador contra
`Gateway/src/responses.js`, `Gateway/src/gateway.js` e `Gateway/src/auth.js`.

### 3.1 `max_tokens` não existe no Gateway — a promessa de "custo controlado" estava errada

**Achado.** O Gateway é um proxy da **Responses API**. O payload montado (linhas 38–47) leva apenas
`model`, `input`, `store`, `stream`, `instructions`, `tools`, `tool_choice`, `parallel_tool_calls`.
**Não há `max_tokens` nem `max_output_tokens`.** Qualquer `max_tokens` enviado pelo cliente é ignorado.

**Impacto.** O verificador anunciava "custo controlado por `max_tokens=16`". Isso era **falso** — o
valor era descartado sem efeito. O limite real da versão é `MAX_OUTPUT_CHARS = 4 MiB` e timeout de 180 s.

**Correção.** O cabeçalho do script e a seção de custo do relatório agora dizem a verdade:
`--max-tokens` é enviado por compatibilidade e **ignorado**; o controle efetivo é prompt de uma frase
+ no máximo 2 requisições por execução + teto de 4 MiB do Gateway. **Não existe teto de tokens
configurável nesta versão** — quem decidir sobre custo precisa saber disso.

### 3.2 Identidade do modelo não vem da resposta HTTP

**Achado.** `responses.js` devolve `model: request.model` — ou seja, **ecoa o nome pedido** por
compatibilidade de contrato. Uma resposta 200 **não prova** qual modelo o provedor serviu.

**O que o Gateway já oferece.** O registro de execução guarda `modelRequested`, `modelReported`,
`identityVerified`, `upstreamId`, `usage`, `firstUsefulMs`, `totalMs`, `toolCalls`, consultáveis em
`GET /v1/runs` (`/v1/runs/:id`).

**Correção.** O verificador passou a consultar `/v1/runs` após a inferência e a reportar
`identityVerified` como **teste próprio (2.2)**. O veredito da matriz mudou: se `identityVerified`
não for `true`, o modelo **não** pode ser "APROVADO", no máximo "TESTADO (identidade não confirmada)".

### 3.3 Código de erro de modelo inexistente

**Achado.** O Gateway real responde **400 `model_not_available`** (linha 35), não 404.
**Correção.** O dublê foi alinhado (400 `model_not_available`) e o dublê passou a **registrar runs**,
para exercitar o caminho novo de identidade de ponta a ponta.

### 3.4 `cost_blocked` existe, mas não no caminho de chat

**Achado.** `cost_blocked` está em `Gateway/src/engine.js:43` e é tratado em
`gateway.js:288` com HTTP **402** (política de custo do motor). Não é o que um chat sem SIWC devolve —
esse é `401 authentication_required`.
**Ação.** Registrado no mapa de erros da documentação; não foi alterado (não há defeito).

### 3.5 Encerramento de streaming

**Achado.** Confirmado no código: chunk com `finish_reason` → `data: [DONE]` → `res.end()`
(`responses.js:140–143`), e em erro durante o stream o Gateway emite
`data: {"error":{...}}` e encerra (`responses.js:167–172`). É exatamente o que a REV3 do agente
espera (`stream_interrupted` quando o `[DONE]` não chega).
**Ação.** Nenhuma — contrato íntegro.

---

## 4. Mapa de erro consolidado (conferido no código)

| HTTP | `error.code` | Origem | O que significa |
|---|---|---|---|
| 401 | `invalid_api_key` | `gateway.js` (bearer local) | chave local errada → `INSTALAR-WINDOWS.cmd` |
| 401 | `authentication_required` | `auth.js` | falta SIWC → `/auth/start` |
| 400 | `invalid_json` | `gateway.js` | corpo inválido |
| 400 | `model_not_available` | `responses.js:35` | modelo fora do catálogo da conta |
| 402 | `cost_blocked` | `engine.js` | política de custo do motor bloqueou |
| 404 | `not_found` / `run_not_found` | `gateway.js` | rota/execução inexistente |
| 429 | `gateway_rate_limit` | `gateway.js` | limite local por cliente |
| 502 | `upstream_connection_error`, `invalid_upstream_stream`, `response_too_large` | `responses.js` | falha do provedor/stream |
| 504 | `upstream_timeout` | `responses.js` | 180 s excedidos |

---

## 5. O que foi preservado (conferido, não reescrito)

- Instalador idempotente, chave local automática, backups com SHA-256, proteção de PID/processos.
- `INSTALAR-WINDOWS.cmd` e `INICIAR-TUDO.cmd` como os **dois** comandos de operação.
- Ponte `/api/gateway/*`: lista fechada, token próprio, HTTPS atrás do Serve, rate limit, SSE sem buffer.
- Autenticação SIWC memory-only, `/auth/start`, `/auth/status`.
- Descoberta de modelos, cache (5 min sucesso / 3 s falha), `KIRANA_PRIMARY_MODEL`/`FALLBACK`.
- Correções A/B/C da REV3 (`stream_interrupted`, `gateway_auth_unknown`, reconsulta imediata).
- Scripts e documentação do Tailscale privado (Serve, nunca Funnel).
- Cliente Kotlin de exemplo — intocado, sem dependência no núcleo.

---

## 6. O que continua bloqueado (não é regressão)

| Item | Motivo |
|---|---|
| Catálogo real, inferência, streaming com modelo, identidade verificada, tool calling, fallback, custos | **falta SIWC** — a sessão é do proprietário, na máquina dele |
| Tailscale / celular | exige a máquina e o aparelho do proprietário |
| PowerShell 5.1 | o ambiente de desenvolvimento só tem pwsh 7.4.6 sobre Linux |

O verificador foi projetado exatamente para fechar esses itens **na máquina do proprietário**, com uma
execução curta, sem eu precisar de acesso remoto.
