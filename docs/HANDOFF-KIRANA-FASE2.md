# HANDOFF — Kirana Fase 2 (checkpoint: Marco 0 + Marco 1 concluídos)

**Data:** 24/10/2026
**Versão do projeto:** 0.2.1 (base: Fase 1 v0.1.2 + LangGraph + correção do indicador de geração)
**Estado:** base corrigida, orquestração LangGraph integrada e validada por testes. CopilotKit,
capacidades, imagens, voz e widget **ainda não iniciados**.
**Este documento existe para permitir continuar em outra sessão sem refazer trabalho.**

---

## 0. Correção 0.2.1 — indicador de geração travado (validado no Windows pelo proprietário)

O dono do projeto confirmou que a Kirana conversa pelo gateway real, mas o indicador
"Kirana está escrevendo…", o spinner e o botão Interromper continuavam visíveis após a resposta.

**Duas causas independentes, ambas corrigidas:**

| # | Causa | Onde | Correção |
|---|---|---|---|
| 1 | `.composer-status { display: flex }` vencia a regra do navegador `[hidden] { display: none }`; `hidden = true` não escondia o bloco | `public/styles.css` | regra global `[hidden] { display: none !important; }` |
| 2 | Estado do compositor em flags soltas; encerramento do stream sem `done` deixava a UI presa | `public/app.js` | máquina de estados `public/stream-state.js`, que sempre volta a ocioso |
| 3 | A resposta do gateway não era cancelada ao parar em `[DONE]` (socket aberto por turno) | `src/sse.js` | `reader.cancel()` no `finally` quando a leitura para antes do fim |

**Backend verificado (não presumido):** `done` é emitido uma única vez e é o último evento; o SSE é
fechado em < 100 ms; erro fecha o stream; cancelamento do cliente encerra o turno; a conexão com o
gateway é liberada. Coberto por `test/stream-close.test.js`.

**Testes:** 102 → **124** (11 de estado do cliente, 6 de guarda de CSS, 5 de encerramento do SSE).
`npm test` continua passando 100% e `npm run audit` segue com 0 violações de contrato.

**Arquivos novos nesta correção:** `public/stream-state.js`, `test/ui-state.test.js`,
`test/ui-css.test.js`, `test/stream-close.test.js`.

## 1. Estado do projeto e caminho

| Item | Valor |
|---|---|
| Pasta do projeto | `/home/user/kirana` (ambiente Arena, Linux) |
| No Windows do proprietário | `C:\CRiando coisa nova\Kirana\kirana-fase1-v0.1.0\kirana\Kirana` |
| Git | repositório existe **só no Windows**; o Arena não tem `.git`. Entregas vão em ZIP |
| Versão | `package.json` e `src/config.js` → **0.2.0** |
| Dependências | `@langchain/langgraph@1.5.2`, `@langchain/core@1.3.0` (versões exatas) |
| Node aqui / no Windows | v20.20.2 / v24.15.0 |
| Gateway | Kirana ChatGPT Gateway v0.2.0 em `http://127.0.0.1:1455` (não modificado) |

> **Atenção:** a partir desta versão o projeto **não é mais zero-dependência**.
> É preciso rodar `npm install` antes de `iniciar.bat`. `node_modules/` fica fora do Git e do ZIP.

---

## 2. Arquivos criados/alterados nesta etapa e motivo

| Arquivo | Ação | Motivo |
|---|---|---|
| `scripts/run-tests.mjs` | **novo** | Lista `test/*.test.js` com `fs` e passa a lista explícita ao runner. Corrige o `MODULE_NOT_FOUND` do `testar.bat` e a contagem inflada (94 → 93) |
| `testar.bat` | alterado | Passa a chamar `node scripts\run-tests.mjs`; não depende mais de glob do `cmd`; propaga o código de saída |
| `package.json` | alterado | `version 0.2.0`; `test` → `run-tests.mjs`; `test:legacy` preservado; dependências LangGraph |
| `src/graph.js` | **novo** | Grafo de estados do turno (LangGraph): `prepare → model → (tools → prepare)* → finalize`, com `overflow` no limite de rodadas |
| `src/agent.js` | alterado | Turno passou a delegar ao grafo. Lógica de gateway, ferramentas, eventos e confirmação foi extraída em primitivas reutilizadas pelo grafo |
| `src/config.js` | alterado | `agent.orchestrator` (`langgraph` \| `legacy`), versão 0.2.0 |
| `.env.example` | alterado | `KIRANA_ORCHESTRATOR=langgraph` documentado |
| `test/orchestrator.test.js` | **novo** | 9 testes: grafo isolado, limite de rodadas, propagação de erro, **paridade langgraph × legacy**, rollback, confirmação de escrita nos dois modos |

**Preservados sem alteração:** `src/gateway.js`, `src/payload.js`, `src/contract.js`, `src/tools/*`,
`src/sessions.js`, `src/memory.js`, `src/prompts.js`, `public/*` (interface), `iniciar.bat`,
`iniciar-demo.bat`, `diagnostico.bat`, `scripts/doctor.mjs`, `scripts/audit-contract.mjs`.

---

## 3. Arquitetura real

```text
Navegador (public/ — UI vanilla da Fase 1, inalterada)
   │  POST /api/chat  (SSE)
   ▼
src/server.js  ── rotas, rate limit, origem, token local
   ▼
src/agent.js   ── primitivas do turno + tratamento de erro/aborto
   ▼
src/graph.js   ── ORQUESTRADOR (LangGraph StateGraph)
   │   prepare ─► model ─► tools ─┐
   │      ▲            └─ overflow ─► finalize ─► END
   │      └───────────────────────┘
   ▼
src/gateway.js ──► payload.js (allowlist) ──► contract.js (validação local) ──► Gateway v0.2.0
```

O grafo **não conhece HTTP nem payload**: recebe primitivas (`prepareRound`, `callModel`,
`handleToolCall`, `persistAssistant`, `persistToolMessage`, `finalize`). O contrato do gateway
continua isolado em `payload.js` + `contract.js` — ponto único, coberto por testes.

Estado do grafo por turno (`Annotation.Root`): `io, rounds, messages, toolSchemas, activeTools,
result, allowWrite, toolCallsTotal, firstTtft, activeModel, fallbackUsed, pendingAnnounced, error,
trace`. Sem checkpointer de propósito: a persistência real é `src/sessions.js`.

### Decisões e por quês

| Decisão | Motivo |
|---|---|
| LangGraph JS in-process (não serviço separado) | mesmo processo, mesma stack Node; zero salto de rede extra; reaproveita gateway e ferramentas |
| Sem `MemorySaver`/checkpoint em disco | a sessão em `data/sessions/*.json` é a fonte de verdade; duplicar estado criaria divergência |
| Flag `KIRANA_ORCHESTRATOR=legacy` mantida | rollback imediato em produção e teste de paridade automatizado |
| Canal `toolSchemas` (não `tools`) | o LangGraph proíbe canal com mesmo nome de nó |
| UI da Fase 1 intocada | decisão sua: CopilotKit entra em widget React separado (Marco 2) |

---

## 4. Comandos e resultados reais

```console
$ node scripts/run-tests.mjs      # após a correção 0.2.1
[testes] 13 arquivo(s)
# tests 124 · pass 124 · fail 0 · duration_ms ≈ 8 700

$ node scripts/run-tests.mjs      # antes da correção 0.2.1
[testes] Node v20.20.2 em linux
[testes] 10 arquivo(s): contract.test.js, gateway.test.js, memory.test.js, orchestrator.test.js,
         payload.test.js, server.test.js, sessions.test.js, sse.test.js, tools.test.js, validation.test.js
# tests 102 · pass 102 · fail 0 · duration_ms ≈ 3515

$ node scripts/audit-contract.mjs
Requisições válidas enviadas ao gateway: 17
Violações de contrato: 0
```

Linha do tempo: 93 (Fase 1) → 102 (+9 LangGraph) → **124** (+22 correção do indicador). Os 93 anteriores passam
**sem nenhuma alteração**, com o grafo como padrão — evidência de paridade comportamental.

Comparação de overhead (gateway simulado, 12 turnos, mediana):

| Orquestrador | Mediana | P95 |
|---|---:|---:|
| legacy | 14,3 ms | 25,6 ms |
| langgraph | 8,9 ms | 15,5 ms |

Diferença dentro do ruído do mock. **Não é medição de modelo real**: o TTFT do seu Windows
(~1,8–1,9 s) é dominado pelo modelo, não pelo orquestrador.

---

## 5. Integração com o gateway (sem segredos)

```env
KIRANA_GATEWAY_URL=http://127.0.0.1:1455
KIRANA_GATEWAY_API_KEY=<chave do .env do gateway>     # só no backend
KIRANA_PRIMARY_MODEL=gpt-6-luna
KIRANA_FALLBACK_MODEL=gpt-6.1-sol
KIRANA_SEND_TEMPERATURE=false                          # v0.2.0 recusa
KIRANA_SEND_MAX_TOKENS=false
KIRANA_SEND_TOOL_CHOICE=false
KIRANA_ORCHESTRATOR=langgraph
```

Regras que continuam valendo: nenhum campo fora da allowlist; validação local antes do envio;
remoção automática com repetição única se o gateway reclamar de algum campo; tokens/credenciais
nunca no frontend; gateway pessoal **não** pode atender visitantes do site público.

---

## 6. Funcionalidades: pronto / parcial / não iniciado

### Pronto e testado
- Conversa com streaming SSE, sessões, histórico, memória com consentimento.
- 7 ferramentas (4 leitura, 3 escrita com confirmação), allowlist, validação e auditoria de contrato.
- Fallback Luna → Sol sem duplicar ações; interrupção/cancelamento; erros compreensíveis.
- **Orquestração LangGraph** com limite de rodadas, estado explícito e rollback.
- Launcher de testes corrigido; contagem honesta (93 → 102 agora).

### Parcial
- Interface: validada em desktop e mobile por CSS, sem teste em dispositivo físico.
- Métricas: TTFT/total/erros/ferramentas existem por turno; `usage` do gateway só quando vier.

### Não iniciado
- **CopilotKit** (Marco 2) — widget React separado, com `CopilotRuntime` + adaptador AG-UI.
- **Capacidades/perfis e cotas** (Marco 3): `opportunity-demo`, `client-default`, admin local.
- **Imagens** (Marco 4): provedor **não definido** — você escolheu "outro provedor" sem nomear.
- **Voz** (Marco 4): nada implementado; não há STT/TTS testado.
- **Widget para opportunity.ia.br** (Marco 5) e adaptador de provedor de produção.
- Validação real no Windows desta versão 0.2.0.

---

## 7. Bugs e limitações reproduzíveis

1. **`node --test test/` infla a contagem** (+1 por `test/helpers.js`). Use `npm test`
   (`scripts/run-tests.mjs`). Não é bug de teste, é regra do runner.
2. **`npm install` obrigatório** após esta versão; sem ele o `require('@langchain/langgraph')` falha
   no boot. `iniciar.bat` ainda **não** checa isso — a corrigir no próximo marco.
3. **Gateway exige reautenticação após reinício** (OAuth em memória). Sintoma: 401 → a interface
   mostra mensagem de chave/autorização.
4. **Ações pendentes** cancelam ao continuar a conversa (comportamento de projeto, não bug).
5. **CSS:** qualquer novo bloco com `display:` que use `hidden` já está protegido pela regra global;
   não remova `[hidden] { display: none !important }` (há teste guardando isso).
5. **`test/helpers.js`** não é teste; não renomear para `*.test.js`.

---

## 8. Próximo passo exato (sem recomeçar)

1. No Windows: `npm install` → `diagnostico.bat` → `iniciar.bat` → **uma conversa real** para
   confirmar que a v0.2.0 (com LangGraph) continua respondendo pelo gateway.
2. Se confirmar, iniciar **Marco 2 (CopilotKit)**:
   - `widget/` com Vite + React 19 + `@copilotkit/react-core@1.79.1` + `@copilotkit/react-ui@1.79.1`;
   - `CopilotRuntime` no backend + adaptador AG-UI chamando o **mesmo** `agent.runTurn`;
   - `useCopilotAction` com `renderAndWaitForResponse` para as 3 ferramentas de escrita;
   - UI vanilla continua em `/`, widget em `/widget`.
3. Antes do Marco 4 (imagens), definir o provedor e a chave: opções avaliadas — OpenAI Images
   (chave própria, custo por imagem), Stability, Replicate, Gemini. Sem provedor, a capacidade
   aparece **indisponível** e a cota de 3 fica implementada mas inerte.
4. Ao final de cada marco: `npm test` + `npm run audit` + ZIP + atualização deste handoff.

---

## 9. Comandos de referência

```bash
npm install                 # obrigatório nesta versão
npm test                    # 102 testes, lista explícita
npm run audit               # sonda de contrato do gateway
npm run doctor              # diagnóstico de ambiente
node src/server.js          # sobe a Kirana (usa .env)
node scripts/mock-gateway.js --port 1455 --key local-mock   # gateway simulado estrito
KIRANA_ORCHESTRATOR=legacy node src/server.js               # rollback do orquestrador
```
