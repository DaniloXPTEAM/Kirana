# Changelog — Kirana

## 0.2.1 — 24/10/2026 (correção do indicador de geração)

### Corrigido
- **Indicador "Kirana está escrevendo…" eterno** (bug existente desde a 0.1.0). Duas causas:
  - `public/styles.css`: `.composer-status { display: flex }` vencia a regra do navegador para
    `[hidden]`; `hidden = true` não escondia o bloco. Adicionada regra global
    `[hidden] { display: none !important; }`.
  - `public/app.js`: estado do compositor misturado em flags; um stream encerrado sem evento
    `done` deixava a UI presa. Agora há uma máquina de estados em `public/stream-state.js`, que
    sempre volta a ocioso (`done`, `error`, cancelamento, encerramento inesperado).
- `src/sse.js`: a resposta do gateway não era cancelada ao parar de ler em `[DONE]`, mantendo o
  socket aberto (um vazamento por turno com gateway keep-alive).

### Adicionado
- `test/ui-state.test.js` (11 testes): conclusão, erro, cancelamento, encerramento inesperado,
  idempotência.
- `test/ui-css.test.js` (6 testes): guarda estática da regra `[hidden]` e dos elementos do
  compositor.
- `test/stream-close.test.js` (5 testes): `done` como último evento, fechamento do SSE, erro,
  cancelamento do cliente e liberação da conexão com o gateway.

### Preservado
- LangGraph, contrato do gateway, ferramentas, confirmação, memória, layout e comportamento visual.

## 0.2.0 — 24/10/2026 (Fase 2, Marco 0 + Marco 1)

### Adicionado
- **Orquestração com LangGraph** (`src/graph.js`): grafo de estados
  `prepare → model → (tools → prepare)* → finalize`, com nó `overflow` para o limite de rodadas.
- Dependências `@langchain/langgraph@1.5.2` e `@langchain/core@1.3.0` (versões exatas).
- `KIRANA_ORCHESTRATOR` (`langgraph` padrão, `legacy` para rollback).
- `scripts/run-tests.mjs`: executor de testes multiplataforma com lista explícita de arquivos.
- `test/orchestrator.test.js`: 9 testes, incluindo paridade langgraph × legacy e rollback.
- Evento `done` passa a informar `orchestrator` (evidência de qual fluxo executou).
- `docs/HANDOFF-KIRANA-FASE2.md`.

### Corrigido
- `testar.bat` não falha mais com `MODULE_NOT_FOUND` (não passa mais a pasta como módulo).
- Contagem de testes deixou de ser inflada: `node --test test/` contava `test/helpers.js` como
  teste (+1). Agora `npm test` reporta a contagem real.

### Alterado
- `src/agent.js`: turno delega ao grafo; lógica virou primitivas reutilizadas.
- `npm install` passa a ser necessário (o projeto deixou de ser zero-dependência).

### Preservado
- Contrato do Gateway v0.2.0 (`payload.js` + `contract.js`), interface da Fase 1 em `public/`,
  ferramentas, confirmação de escrita, memória, fallback, `iniciar.bat`, `diagnostico.bat`.

## 0.1.2 — 24/10/2026
- Auditoria de erros similares: `content: null` com `tool_calls`, chamada de ferramenta sem
  resposta no limite de rodadas, ferramenta desconhecida sem aviso na interface.
- `src/contract.js`: validação local do payload antes do envio. 94 → depois 93 testes reais.

## 0.1.1 — 24/10/2026
- Correção do HTTP 400 `unsupported_parameter`: payload com allowlist (`src/payload.js`),
  sem `temperature`/`max_tokens`/`tool_choice` por padrão, recuperação automática de campo rejeitado.

## 0.1.0 — 24/10/2026
- Fase 1: interface, streaming, sessões, memória, 7 ferramentas, confirmação, testes e docs.

