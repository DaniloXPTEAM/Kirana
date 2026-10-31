# GATEWAY — VALIDAÇÃO DE MODELOS REAIS

**Data:** 2026-10-30 · **Gateway:** 0.4.1 · **Base:** http://127.0.0.1:1461
**Gerado por:** `tools/validar-modelos-reais.mjs` (execução real, não editada à mão)


## 1. Estado inicial

- Gateway respondeu em `http://127.0.0.1:1461`
- Versão: **0.4.1** · provedor: siwc-responses
- Conta autorizada (SIWC): **sim**
- Catálogo: **2** modelo(s)
- Chamadas de geração nesta execução: **0** (previstas: 2)

## 2. Contrato do corpo (o que foi enviado)

Campos aceitos pelo Gateway v0.4.1: `model`, `messages`, `stream`, `tools`, `tool_choice`, `parallel_tool_calls`, `stream_options`.

Este verificador envia **somente** esses campos. `max_tokens` não é enviado — o Gateway o rejeita
com `400 unsupported_parameter` **antes de chegar ao modelo**, e isso **não** reprova o modelo.

## 3. Autenticação

SIWC **concluído** nesta execução.

## 4. Modelos encontrados

- `modelo-falso-a`
- `modelo-falso-b`

## 5. Requisições realizadas

_Nenhuma chamada de geração foi feita (bloqueado, `--catalogo`, ou nenhum modelo)._

**Prompt enviado** (sintético, sem dado pessoal): `Responda apenas com a palavra: ok`

## 6. Identidade do modelo

_Não disponível (sem execução registrada)._

## 7. Limites — cada controle separado

| Controle | Valor efetivo | Onde |
|---|---|---|
| Tempo por requisição | 180 s (responses.js: AbortSignal.timeout(180_000)) | Gateway |
| Tempo por requisição (este verificador) | 60000 ms | verificador |
| Tamanho da resposta | 4 MiB de saída (responses.js: MAX_OUTPUT_CHARS = 4 * 1024 * 1024) | Gateway |
| Tamanho lido pelo verificador | 200000 bytes | verificador |
| Mensagens por requisição | 1 a 100 (validateChatRequest) | Gateway |
| Chamadas por minuto | limite local por cliente em gateway.js (gateway_rate_limit, 429) | Gateway |
| **Tokens de saída** | NÃO existe parâmetro — `max_tokens`/`max_output_tokens` são REJEITADOS com 400 unsupported_parameter | Gateway |
| Custo | política `plan-only` no /v1/engine; `cost_blocked` (HTTP 402) vem do motor, não do chat | Gateway |
| Chamadas de geração (padrão) | 2 (inferência + streaming) | verificador |
| Chamada extra de cancelamento | 1 (só com `--com-cancelamento`) | verificador |

> **Um prompt curto reduz consumo, mas não é garantia de custo.** Não existe teto de tokens
> configurável nesta versão; apresentar um número de tokens como "limite" seria falso.

## 8. Streaming

_Não executado._

## 9. Cancelamento

_Não executado — fora do fluxo padrão de propósito, para não acrescentar chamada de geração inesperada._

## 10. Erros

_Não executados._

## 11. Resultado por teste

| # | Teste | Estado | Detalhe |
|---|---|---|---|
| 0.1 | Gateway responde em /health | **PASS** | HTTP 200 · 98ms |
| 0.2 | estado do motor (/v1/engine) | **PASS** | version=0.4.1 · authenticated=true · catálogo=2 · routing=false · primário=modelo-falso-a |
| 0.3 | conta autorizada (SIWC) | **PASS** | authenticated=true |
| 0.4 | /auth/status | **PASS** | authenticated=true · armazenamento=memory-only · escopos=chat |
| 0.5 | /v1/capabilities | **PASS** | 2 declarada(s) · prontas: text.chat,files.create · não prontas: (nenhuma) |
| 1.1 | catálogo real obtido | **PASS** | 2 modelo(s): modelo-falso-a, modelo-falso-b |
| 2.1 | inferência real | **NAO_EXECUTADO** | --catalogo pedido: nenhuma chamada de geração |
| 6.1 | nenhum segredo nos logs | **PASS** | 0 arquivo(s) · 0 ocorrência(s) |

## 12. Veredito do modelo

**NAO_EXECUTADO**

Veredito que **não** promove o modelo. Veja o estado de cada teste acima: bloqueio de autenticação, custo, incompatibilidade do verificador, identidade inconclusiva e falha real são coisas diferentes.

## 13. Pendências

- Repetir com outro modelo antes de definir fallback: `VALIDAR-MODELOS-REAIS.cmd --modelo <slug>`
- Tool calling não é testado aqui; sem teste, **não** é suportado por evidência.
- Acesso privado: ver `docs/GATEWAY_REV3_ACESSO_PRIVADO_STATUS.md`.
