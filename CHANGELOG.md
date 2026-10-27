# Changelog — Kirana

## 0.5.2 — 26/10/2026 (integração com o Gateway real, rotas e produção)

Versão de **correção e preparação**: conserta o defeito que só aparecia com o
Gateway ChatGPT de verdade, fecha duas rotas que estavam quebradas e prepara a
publicação. Relatório completo em `docs/AUDITORIA-GATEWAY-v0.5.1.md`,
`docs/INTEGRACAO-GATEWAY-REAL.md` e `docs/PRODUCAO.md`.

### Corrigido
- **`unknown_tool` em TODA ferramenta com o Gateway real.** O Gateway v0.4.x
  devolve o nome da chamada como `gateway.<nome>` (`toNamespacedTools` /
  `displayToolName`, em `src/responses.js` do pacote). O registro procurava o
  nome exato. Novo `src/tools/names.js` (`canonicalToolName`) remove **somente**
  o prefixo `gateway.`; `registry.resolveName()` só aceita o resultado quando a
  ferramenta existe de fato — nome desconhecido continua desconhecido.
- **Interface dizia "ok" quando a ferramenta falhava.** `addToolPill` imprimia
  `· ok` sempre que o evento não era `pending`, ignorando `ok: false`. Agora a
  pílula deriva do **resultado** (`public/stream-state.js` → `toolPillView`),
  com motivo por código de erro, estilo `tool-fail` próprio e contador
  "N ferramentas com falha nesta resposta".
- **Ferramentas de frontend (AG-UI) não executavam** com o Gateway real pelo
  mesmo motivo: o mapa era indexado pelo nome declarado. Agora aceita
  `gateway.<nome>` e emite o nome que o navegador conhece.
- **`POST /api/agui` respondia 404.** O transporte AG-UI documentado
  (`npm run build:widget -- --agui`) nunca esteve montado no servidor. Agora está,
  isolado por caminho exato, e o evento `RUN_STARTED` — que saía **sem o campo
  `type`**, porque `AGUI.RUN_STARTED` não existia no mapa de constantes — passou a
  ser emitido corretamente, junto de `RUN_FINISHED` no fechamento do run.
- **Prompt**: a Kirana passa a declarar que **não tem internet nem busca web** e
  a diferenciar falha de ferramenta de falha de transporte.

### Adicionado
- **`scripts/preflight-gateway.mjs`** + `verificar-gateway.bat` — 7 sondas contra
  o Gateway **real** (`/health`, `/auth/status`, `/v1/models`, `/v1/capabilities`,
  rigor de payload, streaming com ferramenta e round-trip de `role:"tool"`).
  Read-only por padrão; `--live` gasta 2 chamadas de modelo. Grava relatório
  **sem chave e sem token**.
- **`scripts/homologar-conversa.mjs`** + `homologar.bat` — homologação de ponta a
  ponta no Windows: doctor, preflight real, suíte, contrato de payload e uma
  conversa real de 4 turnos que reprova `unknown_tool`, "ok" sem dado, falha sem
  código de erro, resposta vazia e promessa de pesquisa web.
- **`POST /api/agui`** (ver acima).
- **`KIRANA_AGENT_RATE_MAX`** (padrão `0` = desligado) — balde de limite para o
  transporte público `/api/copilot` e `/api/agui`, que até então não tinham
  limite nenhum. Desligado por padrão para não alterar comportamento.
- **`deploy/`** — `Dockerfile`, `docker-compose.yml` (Kirana + Caddy, porta da
  Kirana não publicada), `Caddyfile` (SSE sem bufferização) e
  `.env.production.example`.
- **Docs novos**: `docs/INTEGRACAO-GATEWAY-REAL.md`, `docs/PRODUCAO.md`,
  `docs/HOMOLOGACAO-WINDOWS.md`, `docs/AUDITORIA-GATEWAY-v0.5.1.md`.
- **Testes novos**: `test/gateway-namespace.test.js` (8), `test/tool-pill.test.js`
  (5), `test/copilot-routes.test.js` (7), `test/production-config.test.js` (15).
  Total **442 → 464** (medido: `# tests 464 / # pass 464 / # fail 0`) e navegador
  **79/79** (15 + 18 + 8 + 26 + 12) nas duas configurações de gateway.

### Investigado e mantido (com prova)
- **`GET /api/copilot/info` responde 405 e isso está CORRETO.** Cheguei a montar a
  rota devolvendo metadados; o teste de navegador reprovou (6/8) e a investigação
  mostrou por quê: o cliente v2, em `transport: "auto"`, faz `GET <runtimeUrl>/info`
  e — **se essa chamada responder 2xx** — passa a assumir o transporte **REST**,
  mandando requisições que um runtime *single-route* não serve (HTTP 400
  "Missing method field", painel preso em "conectando…"). O runtime info real é
  servido por `POST /api/copilot {"method":"info"}` → `{version, agents:{kirana},
  singleRoute}`. O 405 mantém o cliente no caminho certo. Há teste cobrindo os
  dois lados (`test/copilot-routes.test.js`), e a decisão está comentada em
  `src/server.js`.
- **`src/copilot/http.js` deixou de ser código morto** apenas na parte do
  adaptador AG-UI (`/api/agui`); o trecho que monta o runtime continua sem uso.

### Produção (preparação para hospedagem)
- **CORS com lista fechada** (`src/cors.js`): o preflight `OPTIONS` não devolvia
  `Access-Control-Allow-Origin`, então o widget no site (outra origem) nunca
  conseguiria conversar. Agora a origem é liberada pelo `site.json` +
  `KIRANA_ALLOWED_ORIGINS`, nunca `*`. O runtime do CopilotKit responde `*` por
  padrão e foi contido por `enforceCors` (sem tocar no runtime).
- **`KIRANA_TRUST_PROXY`**: atrás de proxy, `remoteAddress` é o proxy — todos os
  visitantes caíam no mesmo balde e o limite por IP virava limite **global**.
  Com a flag, o IP vem de `X-Forwarded-For` (só quando habilitada; o cabeçalho é
  forjável quando exposto direto).
- **`KIRANA_ENV=production`**: passa a exigir `KIRANA_ACCESS_TOKEN` para subir, e
  as rotas privadas (`GET /api/sessions`, `GET /api/session/:id`, `GET
  /api/memory`) passam a exigir autenticação — antes listavam **todas** as
  conversas e a memória para qualquer um. Em `development` nada muda.
- **`KIRANA_EMBED_ORIGINS`**: `frame-ancestors` por lista de domínios (o
  `KIRANA_ALLOW_EMBED` existente liberava `*`, ou seja, qualquer site).
- **`validateProductionConfig`** + `doctor`: as travas viram verificação no
  START, não texto de documentação.

### Integração com o site
- **`public/widget/kirana-embed.js`** — kit de incorporação em um único
  `<script>`: botão flutuante + painel em iframe da própria Kirana (chamadas
  same-origin; nenhuma credencial no site). Modo alternativo `mode="script"`
  monta o widget v2 direto na página.
- **`/?embed=1`** — modo do painel embutido (esconde a barra lateral do
  operador), sem mudar a interface normal.
- **`test/browser/site-embed.mjs`** — teste de navegador com **duas origens
  reais**: página estática num servidor separado inclui só o script, o iframe
  abre (frame-ancestors autorizou), o visitante conversa, a ferramenta executa e
  o conteúdo do site permanece intacto. 12/12.

### Alterado
- `scripts/mock-gateway.js` ganhou `--namespaced` (imita o Gateway real),
  `--unknown-tool=<nome>`, `/auth/status`, `/v1/capabilities` e
  `authenticated` no `/health`.
- `test/helpers.js`: `startFakeGateway({ namespaced })`.
- `test/browser/site-v2.mjs`: porta padrão corrigida (1456 = gateway → 1455 = Kirana).

### Não alterado (de propósito)
- Gateway ChatGPT, modelos, credenciais, `.env`, `data/`, `sites/`, o site
  público, as 24 ferramentas e o fluxo da Fase 5.

## 0.5.1 — 26/10/2026 (Fase 5: a Kirana executa solicitações de serviço)

A Kirana deixa de só explicar: ela **conduz uma solicitação de serviço dentro do
site** — escolhe o serviço, consulta requisitos, coleta dados, recebe arquivos,
preenche o formulário, valida, pede confirmação, tenta enviar e informa o
resultado real. Relatórios em `docs/FASE5-*.md`.

### Adicionado
- **8 ferramentas operacionais** (`src/site/request-tools.js`):
  `get_service_requirements`, `start_service_request`, `fill_site_form`,
  `request_file_upload`, `validate_service_request`,
  `submit_service_request` (escrita, HITL), `get_request_status`,
  `cancel_service_request` (escrita, HITL). Total: **24 ferramentas**
  (17 declaradas em `site.json`).
- **`src/requests/store.js`** — máquina de estados
  (`draft → collecting_information → waiting_for_upload → validating →
  waiting_for_approval → submitting → submitted | failed | cancelled`),
  isolamento por sessão, uma solicitação ativa por sessão, anti-duplicidade de
  envio, histórico de 60 entradas, persistência atômica em `data/requests`.
- **`src/requests/files.js`** — upload real com extensão + MIME + **assinatura**,
  bloqueio de 21 extensões perigosas, 5 MB, 5 arquivos, pasta por solicitação,
  `0o600`, contenção de path, remoção e retenção de 30 dias. **Nada é
  executado.**
- **`src/requests/requirements.js`** + `sites/opportunity-ai/requirements.json`
  — requisitos por serviço, separando campo do formulário oficial de campo
  operacional, com `requisitosPublicados.disponivel: false` (o site não publica
  requisitos) e motivo/fonte.
- **Rotas:** `GET /api/requests`, `GET /api/requests/:id`,
  `POST /api/requests/:id/files` (base64), `DELETE /api/requests/:id/files/:fileId`.
- **Grafo:** nó `task` e canal `taskState` para retomar a tarefa em andamento.
- **Ponte do navegador:** `fill_form` (escreve em campo real, **nunca** envia) e
  `request_upload` (abre o seletor do visitante), além de `uploadFile`/`pickFile`.
- **Interface:** cartão de anexo com tipos/limite e status real do servidor;
  pílula de preenchimento; ponte resolvida em tempo de uso.
- **Testes:** 4 suítes novas (`requests-store`, `requests-validation`,
  `request-tools`, `requests-http`) + `test/browser/site-v5.mjs`. Suíte total:
  **429/429**; navegador: **26/26 + 18/18 + 8/8 + 15/15**.

### Alterado
- `request_user_input` virou **coleta progressiva**: filtra os campos que a
  solicitação já tem, em vez de repetir o formulário inteiro.
- `get_site_context` informa a política de upload e se o envio está disponível.
- `permissions.denied` ficou vazio: upload deixou de ser negado e passou a ter
  política explícita.

### Não mudou
- Gateway local (1455), modelos, voz, `.env`, `data/`, configurações e o site
  publicado. Nenhuma dependência nova. Nada foi publicado em
  `https://opportunity.ia.br`.

### Limitações declaradas
- **Não há endpoint real de solicitações:** `submit_service_request` responde
  `enviado: false` com `motivo: endpoint_nao_configurado` e mantém o rascunho.
- Requisitos não publicados pelo site são marcados como operacionais.
- Sem antivírus; retenção de 30 dias; arquivos nunca executados.
- `/api/copilot/info` continua 405; voz real no Windows segue pendente.

## 0.5.0 — 26/10/2026 (Fase 4: agente residente no site Opportunity AI)

A Kirana passa a atender **dentro** do site publicado: reconhece a página, conhece
o conteúdo real, navega por ferramenta autorizada, pede dados e continua como chat
e voz. Relatório completo em `docs/FASE4-AUDITORIA.md`.

### Auditoria antes de mexer
Site verificado em 26/10/2026: **HTML estático** (sem Next/React/Astro), um único
`site.js` de 5.198 B, 23 rotas no sitemap, nenhum preço/prazo/case publicado.
CopilotKit e LangGraph já existiam; faltava a camada de site.

### Adicionado
- `sites/opportunity-ai/site.json`: identidade, `siteUrl`, `agentName`, 19 páginas,
  allowlist de 23 rotas do sitemap, 9 ferramentas com categoria, `permissions`
  (upload negado com justificativa).
- `sites/opportunity-ai/knowledge/`: 14 documentos Markdown com `source` e
  `capturedAt`, derivados do conteúdo real do site.
- `src/knowledge/index.js`: recuperação estruturada + **BM25** (sem dependência
  nova, sem serviço pago), radical curto de português, prompt enxuto e
  rastreável. Palavras vazias normalizadas (bug de acento corrigido).
- `src/site/context.js`: normalização de caminho (recusa `..`/esquema/query),
  allowlist obrigatória, resolução de página por id/alias/título/caminho,
  conhecimento em cache com `refreshIfStale()` (gancho da atualização automática).
- `src/site/tools.js`: **9 ferramentas com handlers reais** (`get_site_context`,
  `list_site_pages`, `explain_current_page`, `list_services`, `explain_service`,
  `request_user_input`, `navigate_to_page`, `open_service_page`,
  `show_confirmation`) + guarda de isolamento por site.
- `public/site-agent.js`: ponte do navegador (executa `navigate` com caminho
  validado, apresenta `request_input`, ignora ação desconhecida — sem `eval`).
- `public/app.js`: contexto de página em cada turno, cartão de pedido de dados,
  aviso de navegação no modo autônomo.
- `widget/src/main-v2.jsx` → `public/widget/kirana-v2.js` (**CopilotKit v2**:
  `CopilotKitCoreReact`/`CopilotKitContext`, `useAgent`, `useAgentContext`,
  `useFrontendTool`), build com `node scripts/build-widget.mjs --v2`.
- `scripts/site-sync.mjs`: compara site publicado × config × conhecimento
  (`--check` falha em divergência; `--write-snapshots` salva texto para revisão).
- Endpoints: `POST /api/site/context`, `GET /api/site/knowledge`; `/api/site/info`
  passa a expor páginas, rotas, permissões e o estado do conhecimento.
- Contrato: evento `site_action` (`navigate`, `request_input`,
  `confirmation_granted`) no SSE, também no caminho de confirmação HITL.

### Corrigido no caminho (achado por teste)
- `normalizePath` mantinha query/hash no caminho.
- `samePath` tratava caminho inválido como igual à home (`/..` navegava para `/`).
- `explain_service`/`open_service_page` recusavam apelido de parâmetro aceito pelo
  modelo (`servico`) e devolviam "solução não existe".
- Cartão de pedido de dados lia `label/name` e ignorava `rotulo/nome` da ferramenta.

### Preservado
Gateway, reconhecimento de voz, TTS, atalhos, configurações e `data/` intocados.
Suíte: **383/383** (340 da v0.4.4 + 43 novos). Navegador: `site-flow 18/18`,
`site-v2 8/8`, `demo-flow 15/15`, `voice-flow 60/60`.

### Limitações declaradas
Upload de arquivo não existe (`request_file_upload` fora do registro); site não foi
reescrito nem publicado; `GET /api/copilot/info` responde 405 no runtime 1.79.1;
navegação no site publicado não foi exercitada neste ambiente; pendências de voz
(microfone real no Windows) seguem fora do escopo.

## 0.4.4 — 25/10/2026 (barge-in por voz: "Kirana, pare")

Auditoria e correção do defeito em que a Kirana ignorava a ordem de parar.
Relatório completo em `docs/AUDITORIA-VOZ-V0.4.4.md`.

### Causa comprovada (não presumida)
O controlador era **meia-duplex por projeto**: ao enviar o turno, `finishUtterance()`
chamava `suspendMic('turn_started')` e abortava o reconhecedor; `onresult`
descartava qualquer resultado durante a resposta **antes de analisar o texto**; e
não existia nenhum vocabulário de comando no projeto. O `interrupt()` funcionava,
mas só era alcançável pelo botão. Reproduzido em teste: durante a fala,
`isRecognizerLive() === false` e a ordem virava `result_from_stale_session`.

### Adicionado
- `public/voice-commands.js`: reconhecimento **local** de comandos de parada, sem
  chamar o modelo. Absorve acento, caixa, pontuação e erro fonético
  (Quirana, Kimara, Kirara), trata "para" ambíguo e recusa perguntas e negações
  ("por que o WhatsApp para de funcionar?", "não pare").
- Barge-in de ponta a ponta: microfone **aberto** durante a resposta, comando
  detectado em resultado final **ou interino**, cancelamento de áudio dos dois
  motores, fila e requisições, e volta ao estado de escuta.
- Continuação depois do comando: "Kirana, pare — e o CRM?" é transcrito.
- Diagnóstico: `kiranaVoice.bargeIns` com latência medida, evento
  `kirana:voice-bargein`, tabela nova no `kiranaVoiceReport()`.

### Corrigido no caminho
- Botão de interromper deixava o estado preso em "interrompido" (com a sessão de
  reconhecimento persistente não havia `onstart` para reabrir) — novo
  `resumeListeningAfter()`.
- `drainQueue` sem geração: um `await` antigo podia liberar `speaking` da execução
  nova e sobrepor dois áudios depois de interrupções rápidas.
- Comando repetido (interino + final) gerava três interrupções e três avisos.
- Áudio de resposta atrasada agora é recusado na entrada de `playResponse` e de
  `playBrowserSegment`.
- Histórico de estados passa a gravar o motivo de cada transição.

### Testes
- `node scripts/run-tests.mjs`: **298 → 340** (22 de vocabulário + 19 de integração
  + 1 novo cenário no comportamento; 2 reescritos para o contrato novo).
- Navegador de voz: **48 → 60** (12 verificações reais de barge-in).
- Demo: 15/15.

### Não validado aqui (declarado)
Microfone e alto-falante reais no Windows; latência percebida; se o reconhecedor
do Edge ouve a própria voz. Roteiro A–G na seção 5 do relatório.

## 0.4.3 — 25/10/2026 (P1 markdown na fala, P2 interface, P3 transcrição)

Correções dos três problemas do teste real de Windows da v0.4.2. Relatório
completo em `docs/AUDITORIA-VOZ-V0.4.3.md`.

### Corrigido
- **P1 — a voz lia asteriscos de markdown.** Causa: a limpeza de texto só existia
  no servidor; com o motor do navegador (padrão desde a 0.4.2) o texto cru ia
  para `speechSynthesis.speak()`. A limpeza virou `public/speech-text.js`,
  **uma implementação usada pelos dois motores** (cliente, servidor e worker
  Python alinhado). O texto exibido continua intacto: `**Modelo utilizado:**`
  aparece na tela e é falado como "Modelo utilizado:".
- **P2 — sensação de dois agentes sobrepostos.** Três causas reproduzidas:
  (a) a palavra "Você" no avatar de 34 px transbordava e aparecia por cima da
  bolha — o "selo flutuante" na tela; (b) o cartão de boas-vindas só saía no fim
  da primeira resposta, ficando empilhado acima da conversa; (c) o painel de voz
  era um bloco de 181 px (317 px no celular) que empurrava o chat. Agora: avatar
  do usuário é ícone, o da Kirana é a mesma face do cabeçalho, `.msg-avatar` tem
  `overflow: hidden`, o cartão sai no primeiro sinal de conversa e o painel é um
  popover que fecha com Esc/clique fora e não altera a altura do chat.
- **P3 — transcrição com palavras repetidas.** O merge somava todo resultado
  final ao acumulado e só evitava o caso "termina com o mesmo texto"; interino e
  final se somavam. Agora `mergeRecognition()` usa sobreposição por palavras
  (comparando sem pontuação), o interino é sempre substituído e repetições
  imediatas são colapsadas.
- **Defeito colateral do P3, encontrado no caminho:** um interino que nunca
  recebia `isFinal` rearmava o silêncio para sempre e a fala **nunca era
  enviada**. Novo `interimGraceMs` (1.200 ms) aceita o interino parado.

### Testes
- `node scripts/run-tests.mjs`: **267 → 298** (19 de P1, 12 de P3).
- Navegador de voz: **40 → 48** (8 de P2, incluindo layout e sobreposição).
- Demo: 15/15.
- Corrigida uma verificação **instável** (não o produto): a checagem de
  interrupção esperava o estado transitório `interrompido` e falhava conforme a
  carga da máquina. Passou a usar o histórico de estados; 48/48 em duas
  execuções seguidas no diretório extraído.

### Limitações declaradas
- Nada foi ouvido no Windows: o áudio do `speechSynthesis` e o microfone real
  dependem do seu teste (roteiro na seção 4 do relatório).
- Um termo foneticamente errado ("Smiles") é limitação do reconhecedor do
  navegador; a 0.4.3 impede a multiplicação e permite correção posterior.

## 0.4.2 — 25/10/2026 (voz: pronúncia, motor do navegador, vozes)

Correção pedida depois do teste real de Windows da v0.4.1. Relatório completo em
`docs/AUDITORIA-VOZ-V0.4.2.md`.

### Corrigido
- **Pronúncia errada (acentos).** O texto era enviado ao Python como JSON UTF-8
  cru; num pipe do Windows o Python decodifica com a página ANSI (cp1252) e o
  worker recebia `eleiÃ§Ãµes` — e mandava isso ao motor. Medido com edge-tts real:
  mesma frase, **20 736 bytes corretos vs 25 344 corrompidos** (+28% de áudio na
  comparação direta). Agora: JSON só ASCII (`toAsciiJson`), `PYTHONUTF8=1` /
  `PYTHONIOENCODING=utf-8` no filho e `stdin.reconfigure("utf-8")` no worker.
- **Palavras partidas em dois áudios.** O corte por tamanho podia cair no meio de
  uma palavra quando não havia espaço antes do limite. Agora o corte é sempre em
  espaço; só um token absurdo (URL gigante) é partido.

### Adicionado
- **Motor de fala do navegador** (`public/voice-engine.js`): `speechSynthesis`
  do sistema — sem processo Python e sem rede. É o caminho que o laboratório Voice
  usava para a Francisca e o que explica a diferença de velocidade percebida.
  O motor do servidor (edge-tts) continua, como alternativa e como queda.
- **Escolha de motor, voz e velocidade** no painel ao lado do microfone, com
  **Ouvir prévia** (frase curta, não entra no histórico, não chama o modelo),
  preferência salva em `localStorage` e troca sem tocar no código.
- **Catálogo de vozes pt-BR**: `GET /api/voice/voices` (17 vozes aceitas, entre
  elas `pt-BR-FranciscaNeural` e as Thalita) + vozes do navegador, unificadas na
  interface. Preferência: Francisca → Thalita → outras pt-BR.
- **`POST /api/voice/tts` aceita `voice`** (lista fechada, validada no serviço).
- **`--self-check` no worker** + linha no `doctor`: "Voz: acentuação até o motor".
- **Balde próprio de limite para a voz** (6x o do chat): uma resposta falada gera
  um pedido de síntese por frase — com o balde do chat a fala pararia no meio.
- Métricas por segmento agora incluem `engine` e `voice`.

### Testes
- `node scripts/run-tests.mjs`: **241 → 267**.
- Navegador de voz: **34 → 40** (painel de voz, catálogo, troca de motor,
  persistência).
- Demo: 15/15. `npm run voice:bench`: primeiro byte 642–667 ms, 157 ppm.

### Limitações declaradas
- **O áudio do `speechSynthesis` não foi medido aqui**: o Chromium headless não
  expõe voz nenhuma (medido, `getVoices() = []`). O caminho do navegador está
  provado por teste de comportamento; o som precisa do Teste F na sua máquina.
- A soletração de "eleições" tem **dois mecanismos reproduzidos** (texto
  corrompido e texto fragmentado), ambos eliminados, mas a causa exata na sua
  máquina só o `doctor`/`kiranaVoiceReport()` confirma.
- Barge-in por voz continua só projetado (interrupção é pelo botão/toque).

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

