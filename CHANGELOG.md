# Changelog — Kirana

## 0.4.1 — 25/10/2026 (correção do sistema de voz)

Correção dos defeitos relatados no teste real de Windows da v0.4.0. Relatório
completo (sintoma, causa comprovada, evidência, correção, testes e limitações) em
`docs/AUDITORIA-VOZ-V0.4.1.md`.

### Corrigido
- **Resposta falada duas vezes.** `endTurn()` aceitava um texto de fallback
  (`|| text`) e o app passava a resposta inteira: o último segmento repetia tudo.
  O fim de turno agora apenas sinaliza; nenhum texto volta pelo caminho de áudio.
- **Autoescuta.** O microfone reabria quando a fila de fala esvaziava — **no meio
  da resposta**. Agora fica fechado durante todo o turno e por 600 ms depois do
  áudio, com token por sessão: evento atrasado de reconhecedor antigo é
  descartado (contado em `history.phantomBlocked`).
- **Palavra "Libra" sem estar no texto.** O glifo `£` (e `♎`) passava pelo filtro
  e o Edge TTS o pronuncia como "libra" (medido: `£` +4 608 bytes de áudio contra
  +4 896 da palavra falada). Filtro trocado por **allowlist** de caracteres
  faláveis, aplicada no JS e de novo no worker Python.
- **Áudio diferente do texto.** Mesma origem + resíduo de seletor de variação
  (`U+FE0F`) que sobrava de `1️⃣`. `analyzeSpeechText()` relata exatamente o que
  foi descartado.
- **Silêncio de segundos entre frases.** A síntese seguinte só era pedida depois
  do fim da anterior. Agora é pedida no `playing` da atual: silêncio entre frases
  **728/703 ms → 5 ms** (áudio de 400 ms, síntese de 300 ms).
- **Travadas em "Falando"/"Ouvindo".** Transições explícitas, `releasePlayback()`
  no fim da fila, `scheduleResume()` único e cão-de-guarda de 20 s que declara
  erro em vez de ficar mudo.

### Adicionado
- **`GET /api/voice/diagnostics?sessionId=`** (autenticada) e
  **`window.kiranaVoiceReport()`**: registro por segmento com `turnId`,
  `segmentId`, `text_sent_to_tts`, o que foi descartado, tempos de síntese e
  reprodução, bytes e desfecho. Em memória (últimos 50), sem credenciais.
- **`turnId`/`segmentId`** no `POST /api/voice/tts` e header `X-Kirana-Segment`.
- **`test/voice-behavior.test.js`** — 22 testes de comportamento cobrindo os
  cenários da auditoria. Rodados contra o `voice.js` da v0.4.0, **11 falham**;
  contra a v0.4.1, todos passam.
- `docs/AUDITORIA-VOZ-V0.4.1.md` — relatório, cenários, medições e roteiro A–E
  para o Windows.

### Alterado
- Suíte: **219 → 241** testes; navegador de voz **34/34**; demo **15/15**.
- Versão 0.4.1 em `package.json` e `src/config.js`.

### Limitações declaradas
- **Não medido no Windows.** Os números são de Linux (sandbox); o teste A–E na
  instalação do usuário continua pendente e é o que valida a correção de fato.
- **Sem microfone físico aqui:** `SpeechRecognition` real não roda em headless; os
  testes de escuta usam dublês. Eco de alto-falante real não foi reproduzido.
- **Barge-in por voz não foi implementado** (só projetado): durante a fala a
  Kirana não ouve. A interrupção disponível é pelo botão/toque.

## 0.4.0 — 25/10/2026 (voz conversacional, Marco 3)

### Adicionado
- **Voz como modalidade da mesma agente**: botão circular no composer da
  interface principal. A fala vira uma mensagem normal em `/api/chat` — mesmas
  sessões, mesmo LangGraph, mesma memória, mesmas ferramentas, mesmo HITL.
- **`POST /api/voice/tts`** → `audio/mpeg` em streaming (motor Microsoft Thalita
  Neural PT-BR via worker Python `edge-tts`), com abort que **mata o processo**,
  limite de 3000 caracteres, exigência de sessão válida e mesmas proteções de
  token/origem do `/api/chat`.
- **`GET /api/voice/status`** — disponibilidade do motor, voz e velocidade.
- **`src/voice/tts-text.js`** — limpeza do texto **apenas para fala** (emoji,
  markdown, URL, blocos de código). O histórico e a tela continuam intactos.
- **`public/voice.js`** — máquina de estados explícita (inativo →
  pedindo-microfone → ouvindo → fala-detectada → processando → falando →
  ouvindo, com `interrompido` e `erro`), fim de enunciado por silêncio,
  anti-duplicata, anti-eco e interrupção pelo botão.
- **Fala progressiva**: a resposta é dividida em frases; a próxima síntese é
  pedida enquanto a frase atual toca (sem silêncio entre frases).
- **Velocidade ajustável** (`KIRANA_TTS_RATE`, padrão `+8%`): a voz natural mede
  146 ppm, abaixo da faixa desejada; com `+8%` mede 157 ppm.
- **`npm run voice:bench`** — mede latência real, ppm e tempo de interrupção.
- **`docs/VOZ.md`** — instalação Windows, privacidade, limitações e medições.
- Testes: **+38** (9 limpeza de texto, 16 máquina de estados, 13 rotas HTTP) e
  **34 verificações de navegador** com áudio real (`test/browser/voice-flow.mjs`).

### Dependências e instalação (padronizado em pnpm)
- **`package-lock.json` removido**: era da v0.2.0, não tinha o CopilotKit nem o AG-UI e
  induzia uma instalação errada para quem seguia o `npm install` do README.
- **`pnpm-lock.yaml` é a única fonte da verdade** da árvore de dependências; conferido
  pacote a pacote contra o `package.json` da v0.4.0 (12 dependências, nenhuma extra).
- **`packageManager: pnpm@9.15.9`** fixado no `package.json`: sem isso o `corepack` puxa
  o pnpm 12.x, cuja política de `minimumReleaseAge` rejeita o lockfile gerado pelo 9.x.
- Instalação padrão documentada: `corepack pnpm install --frozen-lockfile` (falha se o
  lockfile divergir do `package.json`, em vez de gerar uma árvore diferente da testada).
- `iniciar.bat`, `testar.bat` e `iniciar-demo.bat` agora **detectam dependências
  ausentes** e mostram o comando correto (antes o boot falhava em
  `@langchain/langgraph` sem explicação — bug registrado no handoff do Marco 2).
- `.gitattributes`: `*.bat text eol=crlf`, para os rótulos (`goto`) funcionarem no
  cmd.exe independentemente do `core.autocrlf`.
- README, `docs/ARQUITETURA.md` e `docs/HANDOFF-KIRANA-FASE2.md` sem instruções de
  `npm install`.

### Corrigido (defeitos reais encontrados durante a implementação)
- **`Permissions-Policy: microphone=()` bloqueava o microfone** em toda a
  interface. Agora é `microphone=(self)`; câmera e geolocalização seguem bloqueadas.
- **CSP sem `media-src`** impedia o `<audio>` de tocar o MP3 (`blob:`).
- Frases curtas travavam a divisão em pedaços (`"Oi!"` nunca era falado).
- Depois de interromper, **texto atrasado do turno cancelado ainda era falado**
  (agora `muted`/`epoch` invalidam a resposta fantasma).
- Interromper deixava o controlador preso em `falando` (o áudio pausado nunca
  emite `ended`); agora a reprodução é liberada explicitamente.
- Motor de voz repetindo o mesmo trecho final duplicava a fala (`"preçopreço"`).
- Erro de TTS era sobrescrito pelo rótulo genérico do estado na tela.

### Preservado
- Marco 2 inteiro: **219 testes** (181 anteriores + 38 novos), navegador do demo
  **15/15**, `npm run audit` com 0 violações de contrato do gateway.
- `/api/copilot`, widget React, `stream-state.js`, interface vanilla, `iniciar.bat`,
  `diagnostico.bat`, `data/`, catálogo, memória, interesses e as 7 ferramentas.
- Nenhuma dependência Node nova. Python/`edge-tts` é opcional: sem ele a Kirana
  funciona por texto e o diagnóstico informa o que instalar.

### Limitações declaradas
- O provedor é **externo e não oficial** (endpoint do Edge). Não é offline e pode
  parar sem aviso; não há equivalência com a voz do ChatGPT.
- A meta de primeiro áudio ≤ 800 ms é atingida na maioria das execuções
  (mediana ~700 ms), **não em todas**; 500 ms não é garantido.
- O `SpeechRecognition` é do navegador (Chrome/Edge) e depende de serviço
  externo de transcrição; Firefox não tem.
- Testes de navegador usam dublê de `SpeechRecognition` (não há microfone no
  ambiente de desenvolvimento); microfone físico precisa ser validado na máquina
  do usuário.

## 0.3.0 — 25/10/2026 (CopilotKit integrado, Marco 2)

### Adicionado
- **Runtime oficial do CopilotKit** em `POST /api/copilot` (`CopilotRuntime` +
  `copilotRuntimeNodeHttpEndpoint`), montado no servidor Node existente. Envelope
  `{method:"agent/run", params:{agentId}, body}` validado ponta a ponta.
- **Agente Kirana como `BuiltInAgent` modo `custom`**: o CopilotKit orquestra o run; a Kirana
  continua dona de LangGraph, gateway e ferramentas. Nenhum agente ou gateway duplicado.
- **Tradutor Kirana → AG-UI** (`src/copilot/agui-events.js`): texto, tool calls, confirmações,
  erros e o par `STEP_STARTED`/`STEP_FINISHED`.
- **Kit por site** (`sites/<id>/site.json` + `src/copilot/site-kit.js`): ações permitidas,
  chaves de estado, componentes de UI generativa, origens autorizadas e isolamento por sessão.
- **Ferramentas de frontend reais** (`navigateToPage`, `openContactForm`, `selectService`,
  `showPricing`, `fillContactForm`, `submitContactRequest`) com validação de JSON Schema.
- **HITL com autorização de uso único** (`src/demo-contact.js`): token ligado ao hash dos
  dados; reutilizar, trocar dados ou expirar exige nova confirmação.
- **Site de demonstração local** (`/demo/index.html`) + widget React (`public/widget/kirana-widget.js`).
- **Segundo site** (`sites/demo-parceiro/`) provando o isolamento entre clientes.
- `GET /api/site/info` — metadados públicos do site (sem segredos).
- Testes: `test/copilot-*.test.js` (40 testes) + `test/browser/demo-flow.mjs` (15 verificações
  em Chromium real).

### Corrigido (defeitos reais encontrados pelos testes)
- `STEP_STARTED` sem `STEP_FINISHED` fazia o runtime responder `RUN_ERROR / INCOMPLETE_STREAM`.
- **Vazamento entre sites**: `siteId` desconhecido caía no site padrão e compartilhava sessão.
  Agora é recusado com `unknown_site` e a resolução é estrita.
- `BuiltInAgent` é importado de `@copilotkit/runtime/v2` (o entry raiz não o exporta).
- `copilotRuntimeNodeHttpEndpoint` usa `baseUrl` (não `basePath`).
- Sessão determinística por site+thread deixou de ser recriada a cada run (histórico persistia
  no teste, mas não em produção).
- `sessions.create` aceita `id` explícito (sem alterar o comportamento de sessões aleatórias).

### Preservado
- LangGraph (`src/graph.js`), gateway SIWC, autenticação, SSE, `stream-state.js`, correção CSS
  do indicador, interface vanilla, catálogo, memória, interesses e todas as 7 ferramentas.
- Testes das versões anteriores: 124 → todos verdes.

### Limitação declarada
- `@copilotkit/react-core` não compila neste ambiente (memória do sandbox). O widget usa o
  protocolo do runtime oficial, sem os hooks React do CopilotKit. Ver
  `docs/COMPATIBILIDADE-COPILOTKIT.md`.

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

