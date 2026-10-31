# REVISÃO 4.1 — correção do verificador integrado

**Data:** 30/10/2026
**Versão da distribuição:** **REV4.1** (Kirana **0.5.4** · Gateway **0.4.1** — versões internas **não** mudaram)
**Base:** REV4, SHA-256 `30b7e8817c892b6f8a1e9fd8d9b3710a70af3ad7c3ea6bc50263f189371abffa`
**Escopo:** corrigir a incompatibilidade do verificador com o contrato do Gateway. Nada mais foi tocado.

---

## 1. Causa-raiz (confirmada no código, com prova de execução)

O verificador enviava `max_tokens` no corpo do Chat Completions. O Gateway **rejeita** esse campo:

`Gateway/src/responses.js:298` — `validateChatRequest()`

```js
const supported = new Set(['model','messages','stream','tools','tool_choice','parallel_tool_calls','stream_options']);
const unsupported = Object.keys(r).filter((key) => !supported.has(key));
if (unsupported.length) throw new UpstreamError(400, 'unsupported_parameter',
  `Unsupported request field: ${unsupported[0]}. ...`);
```

Prova obtida contra o Gateway real (log `evidencias/prova-defeito.log`):

```
corpo COM max_tokens  → HTTP 400 {"code":"unsupported_parameter",
                          "message":"Unsupported request field: max_tokens. ..."}
corpo SEM max_tokens  → HTTP 401 {"code":"authentication_required"}
```

O primeiro caso morria **antes de chegar ao modelo**. Isso não é reprovação do modelo — é o teste
fora do contrato. A classificação anterior tratava qualquer falha como suspeita do modelo.

**Correção de uma afirmação minha anterior:** na REV4 eu escrevi que o Gateway "ignora" `max_tokens`.
Estava errado: ele **rejeita**. O efeito prático era pior do que eu havia descrito.

## 2. O que foi corrigido

| # | Antes | Depois |
|---|---|---|
| 1 | `max_tokens` em todos os corpos | **nenhum** corpo envia campo fora do contrato; há um módulo único que monta o corpo (`tools/contrato-chat.mjs`) |
| 2 | `.cmd` prometia "no maximo 2 requisicoes … max_tokens=16" | `.cmd` diz que **não existe limite de tokens** e informa as chamadas de geração |
| 3 | cancelamento rodava sempre (3ª chamada silenciosa) | só com `--com-cancelamento`; o padrão faz **exatamente 2** chamadas |
| 4 | 400 por campo inválido podia virar "modelo reprovado" | classificação própria: `INCOMPATIBILIDADE_DO_VERIFICADOR` |
| 5 | limites misturados ("tokens", "custo") | tabela separando tempo, tamanho, mensagens, chamadas/min, tokens (inexistente) e custo |
| 6 | veredito binário | `APROVADO`, `APROVADO_PARCIAL`, `REPROVADO`, `INCONCLUSIVO_IDENTIDADE`, `MODELO_INDISPONIVEL`, `BLOQUEADO_AUTENTICACAO`, `BLOQUEADO_CUSTO`, `INCOMPATIBILIDADE_DO_VERIFICADOR`, `NAO_EXECUTADO` |
| 7 | — | `stream_options.include_usage` (campo aceito) para obter tokens no SSE |
| 8 | — | `tools/teste-verificador.mjs` com 14 testes que impedem a regressão |

## 3. Chamadas de geração — máximo por execução

| Fluxo | Chamadas | Observação |
|---|---|---|
| padrão | **2** | 1 inferência (`stream:false`) + 1 streaming (`stream:true`) |
| `--com-cancelamento` | **3** | a 3ª é abortada no 1º delta; é consentimento explícito |
| `--catalogo` | **0** | só lista modelos |
| testes de erro | **0** | modelo inexistente, JSON inválido e rota inexistente são rejeitados antes do modelo |

O total é impresso no fim (`chamadas de geração nesta execução: N`).

## 4. Limites — cada controle é um controle

| Controle | Valor | Onde |
|---|---|---|
| Tempo por requisição | 180 s | Gateway (`AbortSignal.timeout(180_000)`) |
| Tempo por requisição (verificador) | 60 s | verificador |
| Tamanho da resposta | 4 MiB | Gateway (`MAX_OUTPUT_CHARS`) |
| Tamanho lido | 200 kB | verificador |
| Mensagens por requisição | 1–100 | Gateway (`validateChatRequest`) |
| Chamadas por minuto | limite local, 429 | Gateway |
| **Tokens de saída** | **não existe parâmetro** | `max_tokens` é rejeitado |
| Custo | `plan-only`; `cost_blocked` = 402 | motor |

> Prompt curto reduz consumo, mas **não** é teto de custo. Nenhum número de tokens é apresentado
> como limite, porque não existe um.

## 5. Identidade do modelo — preservada

Continua por `GET /v1/runs`: `modelReported`, `identityVerified`, `upstreamId`, `usage`,
`firstUsefulMs`. Sem `identityVerified === true` o veredito é **INCONCLUSIVO_IDENTIDADE**;
o campo `model` da resposta (nome pedido, ecoado) nunca é aceito como prova.

## 6. Arquivos alterados nesta revisão

| Arquivo | Mudança |
|---|---|
| `tools/contrato-chat.mjs` | **novo** — campos aceitos, `montarCorpo`, `garantirContrato`, limites do Gateway e do verificador |
| `tools/validar-modelos-reais.mjs` | reescrito: sem `max_tokens`, contador de chamadas, classificação nova, `stream_options` |
| `tools/duble-gateway-autorizado.mjs` | passou a ser **estrito**: rejeita campo extra com 400 `unsupported_parameter` |
| `tools/teste-verificador.mjs` | **novo** — 14 testes (estáticos, unitários e integrados) |
| `VALIDAR-MODELOS-REAIS.cmd` | texto corrigido: sem "16 tokens"; informa chamadas e limites |
| `tools/verificar-pacote.mjs` | passa a exigir `contrato-chat.mjs`, `teste-verificador.mjs` e `docs/REVISAO-4.1.md` |
| `docs/TESTES-E-EVIDENCIAS.md`, `README.md`, `VERSAO-DISTRIBUICAO.txt` | contagens e instruções da REV4.1 |

**Não alterado:** `Kirana/src`, `Gateway/src`, testes existentes, instalador, inicializador, ponte,
autenticação, SSE, Tailscale, versões 0.5.4 / 0.4.1.
