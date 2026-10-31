# Arquitetura da Kirana — Fase 1

## 1. Visão geral

```text
Navegador (public/)
  │  HTTP + SSE  ·  mesma origem  ·  sem chave de API
  ▼
Backend da Kirana (src/server.js)
  │  identidade · sessões · orquestração · ferramentas · permissões · erros
  ▼
Cliente do gateway (src/gateway.js)
  │  Authorization: Bearer <GATEWAY_API_KEY>   (só aqui)
  ▼
Kirana-ChatGPT-Gateway v0.2.0  →  modelo autorizado da conta ChatGPT
```

O gateway **não foi alterado**. A Kirana apenas consome `GET /health`, `GET /v1/models` e
`POST /v1/chat/completions` (formato OpenAI, `stream: true`).

## 1.1 Fase 5 — onde a solicitação vive

```text
Navegador (ponte do site)            Servidor da Kirana                Disco local
  fill_form / request_upload  ──►  src/site/request-tools.js
  uploadFile ───────────────────►  POST /api/requests/:id/files ──►  data/uploads/<REQ>/
                                   src/requests/{store,requirements,files}.js
  GET /api/requests/:id  ◄──────   estado + histórico  ◄──────────   data/requests/<REQ>.json
```

O grafo continua sendo o único orquestrador: `prepare → task → model → tools →
finalize`, com o canal `taskState` carregando a solicitação em andamento entre
turnos e páginas. Ver [`FASE5-SOLICITACOES.md`](FASE5-SOLICITACOES.md) §2.

## 2. Componentes

| Arquivo | Responsabilidade |
|---|---|
| `src/server.js` | Rotas HTTP, SSE de saída, arquivos estáticos, rate limit, origem, token local |
| `src/agent.js` | Ciclo do turno: contexto → modelo → ferramentas → persistência → eventos |
| `src/gateway.js` | Cliente HTTP do gateway, streaming, timeouts, normalização de erros |
| `src/sse.js` | Parser de SSE tolerante a fragmentação (usado no gateway e testado) |
| `src/prompts.js` | Identidade (prompt-base da especificação) + regras operacionais |
| `src/sessions.js` | Sessões em JSON, histórico, reparo de contexto, métricas |
| `src/memory.js` | Memória persistente opcional com consentimento e bloqueio de dados sensíveis |
| `src/interests.js` | Registro local de interesses comerciais (`interests.jsonl`) |
| `src/tools/registry.js` | Registro, validação, separação leitura/escrita, timeout |
| `src/tools/definitions.js` | As 7 ferramentas da Fase 1 |
| `src/catalog/*.json` | Catálogos confirmados (serviços, produtos, projetos, institucional) |
| `src/config.js` | Configuração centralizada, sem dependências, `.env` lido manualmente |
| `src/validation.js` | Validador mínimo de JSON Schema para argumentos de ferramentas |
| `public/*` | Interface: HTML/CSS/JS puro, sem bibliotecas |

## 3. Fluxo de um turno

1. `POST /api/chat { sessionId, message }` → abre SSE.
2. O agente cancela ação pendente anterior (se o usuário seguiu a conversa), grava a mensagem do
   usuário e monta o contexto: identidade + memória autorizada + histórico reparado.
3. Chama o gateway em streaming com o modelo ativo (primário ou fallback), com `tools` no formato
   OpenAI.
4. Modelo responde com texto → cada delta é repassado ao navegador (`delta`).
5. Modelo pede ferramenta:
   - **leitura** → valida argumentos, executa, grava resultado, emite `tool_start`/`tool_result`
     e volta ao modelo (até `KIRANA_MAX_TOOL_ROUNDS`);
   - **escrita** → valida argumentos e cria uma **ação pendente** em vez de executar; grava um
     resultado `aguardando_confirmacao`, emite `confirmation` e continua o turno apenas com
     ferramentas de leitura (evita cascata de ações).
6. Ao final: métricas na sessão e evento `done` (modelo, TTFT, tempo total, rodadas, ação pendente).

### Confirmação de ação

```text
POST /api/chat/confirm { sessionId, actionId, approve }
```

- `approve: false` → a mensagem de ferramenta pendente é reescrita como `recusada_pelo_usuario`;
  nada é gravado; a Kirana responde com uma mensagem local (sem chamar o modelo).
- `approve: true` → executa a ferramenta de escrita, reescreve a mensagem pendente com o resultado
  real (mantendo o histórico válido para a API) e pede ao modelo uma resposta natural — apenas
  com ferramentas de leitura disponíveis.
- Expiração de 15 minutos (valor em `config.agent.confirmationTtlMs`, sem variável de ambiente nesta fase).

## 4. Protocolo SSE (backend → navegador)

| Evento | Conteúdo |
|---|---|
| `session` | `sessionId`, `title` |
| `start` | `model`, `requested`, `fallbackUsed` |
| `status` | `stage` (`retry`, `tool`), `label` |
| `delta` | `text` (fragmento da resposta) |
| `tool_start` | `name`, `title`, `kind` |
| `tool_result` | `name`, `ok`, `cached`, `errorCode`, `executed` |
| `confirmation` | `action { id, tool, title, summary, expiresAt }` |
| `done` | `model`, `ttftMs`, `totalMs`, `rounds`, `toolCalls`, `aborted`, `resolved` |
| `error` | `code`, `message`, `recoverable` |

Comentários `: ping` a cada 15 s mantêm conexões vivas atrás de proxies.

## 5. Modelos e fallback

- Modelo ativo resolvido por `KIRANA_PRIMARY_MODEL`; se `KIRANA_MODEL_PROBE=true`, o backend
  confere em `GET /v1/models` (cache de 5 min) e cai para o fallback quando o primário não existe.
- Fallback em tempo de execução **apenas** se a falha ocorreu antes de qualquer token ou chamada
  de ferramenta e o erro é marcado como recuperável (`gateway_unreachable`, `gateway_http` 5xx,
  `model_unavailable`, timeouts). Assim não há risco de duplicar texto, ferramentas ou ações.
- `aborted`, `gateway_auth` e erros de validação nunca acionam fallback.

## 5.1 Payload enviado ao gateway

Montado exclusivamente em `src/payload.js` (allowlist):

| Campo | Quando é enviado |
|---|---|
| `model` | sempre |
| `messages` | sempre (saneadas: sem chaves internas, `content` string) |
| `stream` | sempre (`true`) |
| `tools` | quando a rodada tem ferramentas |
| `temperature` | só com `KIRANA_SEND_TEMPERATURE=true` (**padrão: não**) |
| `max_tokens` | só com `KIRANA_SEND_MAX_TOKENS=true` (**padrão: não**) |
| `tool_choice` | só com `KIRANA_SEND_TOOL_CHOICE=true` (**padrão: não**) |
| `parallel_tool_calls`, `top_p`, penalidades, `seed`, `stop`… | nunca |

`assertAllowedFields()` derruba a requisição no backend se algo fora da allowlist escapar, e
`extractUnsupportedField()` + remoção com repetição única tratam o HTTP 400
`unsupported_parameter` do Gateway v0.2.0.

## 5.2 Orquestração (LangGraph)

O turno é um `StateGraph` (`src/graph.js`):

```text
START → prepare → model ──► finalize → END
            ▲        ├─ tool_calls e rounds ≤ limite ─► tools ─┘
            └────────┘
                     └─ rounds > limite ─► overflow ─► finalize
```

- **prepare**: monta mensagens + ferramentas da rodada (respeita `allowWrite`).
- **model**: chama `callModel` (gateway + fallback) e emite `start`/`delta`.
- **tools**: leitura executa; escrita cria ação pendente (nunca executa).
- **overflow**: limite de rodadas — responde **todas** as chamadas e encerra.
- **finalize**: métricas da sessão + evento `done` (inclui `orchestrator`).

O grafo não monta payload nem fala HTTP: recebe primitivas de `src/agent.js`. Contrato do gateway
continua isolado em `payload.js` + `contract.js`. `KIRANA_ORCHESTRATOR=legacy` volta ao loop
anterior; `test/orchestrator.test.js` compara os dois modos e exige fluxo idêntico.

Estado por turno (sem checkpointer — a sessão em disco é a fonte de verdade):
`io, rounds, messages, toolSchemas, activeTools, result, allowWrite, toolCallsTotal, firstTtft,
activeModel, fallbackUsed, pendingAnnounced, error, trace`.

## 6. Persistência local

```text
data/
├─ sessions/<id>.json      # mensagens, título, ação pendente, métricas
├─ memory.json             # itens autorizados pelo usuário
└─ interests.jsonl         # interesses comerciais (uma linha por registro)
```

Escrita atômica (`tmp` + `rename`) nos arquivos JSON. I/O síncrono: arquivos pequenos, uso local,
sem concorrência relevante.

## 7. Decisões de projeto

- **Zero dependências até a v0.1.2** — desde a v0.2.0 o projeto usa pacotes exatos
  (`@langchain/*`, `@ag-ui/*`, `@copilotkit/*`, `react`), instalados com `pnpm` a partir do
  `pnpm-lock.yaml` versionado (`corepack pnpm install --frozen-lockfile`).
- **ESM puro** (`"type": "module"`) — sem transpilação.
- **Ferramentas no servidor** — o modelo só escolhe *qual* ferramenta e *com quais argumentos*;
  validade, permissão e execução são do backend.
- **Escrita = ação pendente** — a arquitetura impede que o modelo grave dados por conta própria.
- **`consultar_status_projeto` marcado como simulado** — nos dados e na descrição da ferramenta,
  para que a Kirana avise o usuário.
- **Mensagens de ferramenta permanecem no histórico** — mantêm o contexto válido para a API
  OpenAI; a interface as filtra e mostra apenas pílulas de atividade.

## 8. O que deliberadamente não existe nesta fase

- Hospedagem pública, multiusuário e autenticação de contas.
- Envio real de leads (e-mail/CRM/WhatsApp).
- Integração com WhatsApp/Telegram/voz.
- Componente incorporável publicado no site.
- Reescrever ou substituir o gateway.
