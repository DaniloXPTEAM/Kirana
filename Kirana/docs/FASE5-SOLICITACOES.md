# Kirana Fase 5 — execução de solicitações de serviço

**Versão:** 0.5.1 · **Base:** v0.5.0 (`ead823b`) · **Data:** 26/10/2026
**Objetivo:** a Kirana **executa** uma tarefa dentro do site — não apenas explica.

Este documento descreve o fluxo de 13 passos (item 6 do briefing), os estados do
LangGraph (item 7), a integração com o formulário real (item 9) e o upload
seguro (item 5). O que não existe está na seção 7.

---

## 1. O fluxo realista, passo a passo

Pedido de exemplo: **"Quero colocar uma IA no meu site."**

Cada passo é uma **ferramenta + estado**, não uma frase de efeito no prompt. A
coluna "prova" indica onde o comportamento é verificado.

| # | Passo | Ferramenta / mecanismo | Estado depois | Prova |
| --- | --- | --- | --- | --- |
| 1 | Reconhecer o serviço | `list_services` (catálogo real) | — | `site-tools.test.js` |
| 2 | Explicar o serviço | `explain_service {serviceId}` | — | `site-tools.test.js` |
| 3 | Consultar requisitos | `get_service_requirements` → `requisitosPublicados.disponivel:false` + campos do formulário e do caso | — | `request-tools.test.js` #2 |
| 4 | Pedir o endereço do site | `request_user_input` (progressivo) → `endereco_site` | `collecting_information` | `request-tools.test.js` #5 |
| 5 | Pedir a função do agente | `request_user_input` → `funcao_do_agente` (já filtra o que existe) | `collecting_information` | idem |
| 6 | Demais campos (nome, e-mail, interesse, mensagem, consentimento) | `request_user_input` (mesma lista, sem repetir campo já informado) | `collecting_information` | idem |
| 7 | Arquivos (se houver) | `request_file_upload` → cartão de anexo no navegador → `POST /api/requests/:id/files` | `waiting_for_upload` | `site-v5.mjs` (upload real) |
| 8 | Rascunho registrado | `start_service_request` (cria **ou retoma**) | `draft → collecting_information` | `requests-store.test.js` #2 |
| 9 | Validar | `validate_service_request` → válidos/ausentes/erros/próxima ação | `validating → waiting_for_approval` | `request-tools.test.js` #5 |
| 10 | Resumo para o visitante | `get_request_status` + prompt do site (dados e o que falta) | `waiting_for_approval` | `request-tools.test.js` #16 |
| 11 | Aprovação explícita | `submit_service_request` é `write` → HITL (`confirmation` + `actionId`) | `waiting_for_approval` | `requests-http.test.js` #3 |
| 12 | Executar **só** se autorizado e com destino real | `submit_service_request` → `endpoints.submitRequest` | `submitting → submitted` **ou** permanece rascunho | `request-tools.test.js` #13/#14 |
| 13 | Informar o resultado real | resposta da ferramenta (protocolo do backend, ou `enviado:false` com motivo) | `submitted` / `failed` / rascunho | idem |

**O que a Kirana nunca faz nesse fluxo:** dizer que enviou sem backend, inventar
protocolo, estimar prazo, pedir CPF/dado sensível, prometer preço, ou pedir o
mesmo campo duas vezes.

### 1.1 Preenchimento do formulário

`fill_site_form` não envia nada: devolve `siteAction {type:'fill_form', form,
fields[{field, selector, value}]}`. Os **seletores vêm do `site.json`**
(`forms.contato.fields`), não do modelo; a ponte do navegador aceita apenas
`input`, `select` e `textarea` (nada de `hidden`, `file`, `button`), dispara
`input`/`change` como uma digitação humana e **jamais** chama `submit()`.

Testado no navegador de verdade: o formulário de contato é injetado com os
mesmos `id` do site e o teste confere que `#nome`, `#email`, `#mensagem` e
`#consent` recebem os valores — e que `window.__submitted` continua `false`
(`test/browser/site-v5.mjs`).

### 1.2 Upload seguro

| Regra | Implementação |
| --- | --- |
| Tipo permitido | `pdf, png, jpg, jpeg, webp, txt, csv, docx, xlsx` (`site.json.uploads.allowed`) |
| Bloqueio duro | `exe, bat, cmd, msi, sh, js, php, py, jar, apk, dll, html, svg…` → erro `blocked_type` |
| Tamanho | 5 MB por arquivo (`file_too_large`) |
| Quantidade | 5 por solicitação (`too_many_files`) |
| Assinatura | magic bytes conferidos (`%PDF`, `\x89PNG`, `\xFF\xD8\xFF`, `RIFF`, `PK\x03\x04`) → `content_mismatch` |
| MIME x extensão | `content_type_mismatch` quando o declarado não corresponde |
| Isolamento | pasta por solicitação `<dataDir>/uploads/REQ-AAAA-XXXXXX/`, arquivo `f_xxxxxxxxxxxx.pdf` |
| Permissão de arquivo | `0o600` — só o dono do processo lê |
| Path traversal | id e extensão são reconstruídos/saneados; `resolve()` valida a raiz |
| Remoção | `DELETE /api/requests/:id/files/:fileId` e, no cancelamento, `removeAll` |
| Retenção | `expiresAt` por arquivo (`+30 dias`); `purgeExpired()` apaga os vencidos |
| Execução | **nenhuma** — o arquivo nunca é aberto, interpretado ou executado |

---

## 2. Estados (LangGraph como único orquestrador)

O grafo continua sendo o mesmo da v0.5.0 (`src/graph.js`), com **um nó novo**:

```
prepare → task → model → (tools ⇄ model) → overflow? → finalize
```

| Estado (`REQUEST_STATES`) | Quando entra | Pode sair para |
| --- | --- | --- |
| `draft` | rascunho criado e nada informado | `collecting_information`, `waiting_for_upload`, `validating`, `cancelled` |
| `collecting_information` | dados sendo coletados | `waiting_for_upload`, `validating`, `cancelled` |
| `waiting_for_upload` | arquivo pedido ou recebido | `collecting_information`, `validating`, `cancelled` |
| `validating` | validação em curso / formulário preenchido com dados completos | `waiting_for_approval`, `collecting_information`, `cancelled` |
| `waiting_for_approval` | dados completos, aguardando o visitante | `submitting`, `collecting_information`, `cancelled` |
| `submitting` | envio autorizado em andamento (exclusivo) | `submitted`, `failed` |
| `submitted` | backend confirmou | `cancelled` (só com operação real) |
| `failed` | backend falhou/timeout | `waiting_for_approval`, `submitting`, `validating`, `collecting_information`, `cancelled` |
| `cancelled` | visitante cancelou | final |

Transição fora da tabela é **recusada** com `invalid_transition`
(`requests-store.test.js` #6). As ferramentas não pulam etapas à mão: pedem o
destino e o helper `advance()` percorre o caminho permitido.

### 2.1 Garantias de execução

| Requisito do briefing | Como está implementado |
| --- | --- |
| Uma atividade principal por vez | `store.create` recusa segunda solicitação ativa; `start_service_request` **retoma** em vez de duplicar |
| Retomada após navegação | estado em `data/requests/<REQ>.json`; a sessão só aponta o `sessionId` |
| Anti-duplicidade de envio | `beginSubmit` reserva `submitting`; segundo envio → `submit_in_progress`; `submitted` é final |
| Anti-duplicidade de turno | cache de ferramentas do grafo (`toolCache`) + `alreadyCalledTool` no gateway simulado |
| Falhas | `failSubmit` grava `lastError`, estado `failed`, permite nova tentativa |
| Cancelamento seguro | bloqueado em `submitting`/`submitted`; descarta dados e arquivos |
| Persistência mínima | JSON por solicitação, escrita atômica (`rename`), histórico limitado a 60 entradas, sem conteúdo sensível no log |

---

## 3. Rotas novas (servidor)

| Rota | Método | O que faz |
| --- | --- | --- |
| `/api/requests?sessionId=` | GET | Lista as solicitações da sessão (400 sem sessão válida) |
| `/api/requests/:id?sessionId=` | GET | Estado, dados, arquivos e histórico (404 para outra sessão) |
| `/api/requests/:id/files` | POST | Recebe `{filename, contentType, dataBase64, sessionId}` → valida e grava |
| `/api/requests/:id/files/:fileId` | DELETE | Remove o arquivo do disco e da solicitação |

Todas passam por `assertAuth`, `assertSameOrigin`, limite de corpo
(`fileStore.maxBytes * 2 + 64 KB` para o base64) e limite de requisições
(`checkRequestRate`).

---

## 4. Ponte do navegador (CopilotKit v2 e vanilla)

`public/site-agent.js` passou a executar `fill_form` e `request_upload` e a
expor `uploadFile`/`pickFile`, sem `eval` e sem JS arbitrário:

| Ação | O que a ponte faz | O que ela **não** faz |
| --- | --- | --- |
| `navigate` | `pushState` para rota da allowlist | abrir URL externa (`unsafe_path`) |
| `fill_form` | escreve em `input`/`select`/`textarea` mapeados | submeter, clicar, executar script |
| `request_upload` | abre o seletor nativo do visitante | ler arquivo sem escolha, executar arquivo |
| `request_input` | mostra os campos pedidos | enviar dados sozinha |
| desconhecida | registra e ignora (`unknown_action`) | `eval`/`Function` |

O painel resolve a ponte em tempo de uso (`window.KiranaSite.bridge`), então um
site pode anexar a ponte depois do carregamento — é o caminho usado pelo widget.

---

## 5. Testes (item 12 do briefing)

| # | Requisito de teste | Onde |
| --- | --- | --- |
| 1 | Auditoria do registro | `request-tools.test.js` #1 (schema, `kind`, HITL, `summarize`) |
| 2 | Criar rascunho | `requests-store.test.js` #1, `request-tools.test.js` #3 |
| 3 | Coleta progressiva | `request-tools.test.js` #5 |
| 4 | Validação | `requests-validation.test.js` #4/#5 |
| 5 | Correção de dado | `request-tools.test.js` #5, `requests-store.test.js` #5 |
| 6 | Upload válido | `requests-validation.test.js` #7, `requests-http.test.js` #2, `site-v5.mjs` |
| 7 | Upload inválido | `requests-validation.test.js` #8, `requests-http.test.js` #2 |
| 8 | Isolamento de sessões | `requests-store.test.js` #3, `request-tools.test.js` #8, `requests-http.test.js` #1 |
| 9 | Preencher formulário | `request-tools.test.js` #9, `site-v5.mjs` (DOM real) |
| 10 | Aprovação HITL | `requests-http.test.js` #3 |
| 11 | Recusa HITL | `requests-http.test.js` #3 (`resolved:'declined'`) |
| 12 | Envio duplicado | `requests-store.test.js` #7, `request-tools.test.js` #13 |
| 13 | Falha de backend | `request-tools.test.js` #14/#15 |
| 14 | Recuperação de tarefa | `requests-store.test.js` #10, `site-v5.mjs` (reload) |
| 15 | Cancelamento | `requests-store.test.js` #9, `request-tools.test.js` #17 |
| 16 | Navegação entre páginas | `request-tools.test.js` #18 |
| 17 | Continuidade de contexto | `request-tools.test.js` #18, `site-v5.mjs` |
| 18 | Bloqueio de ação não autorizada | `request-tools.test.js` #10/#11/#12 (submit sem endpoint/estado) |
| 19 | Não vazamento de segredos | `request-tools.test.js` #19 |
| 20 | Regressão v0.5.0 | suíte completa **429/429** + `site-flow.mjs` 18/18 + `site-v2.mjs` 8/8 + `demo-flow.mjs` 15/15 |

Mocks: só o **gateway simulado** (`scripts/mock-gateway.js`) e o
`startFakeGateway` dos testes — ambos declarados. Nenhum mock substitui
validação real de upload, store ou servidor: esses são exercitados de verdade,
com disco temporário.

---

## 6. Integração com o site real

| Item | Situação (26/10/2026) |
| --- | --- |
| Framework | HTML estático (confirmado na Fase 4; nada mudou) |
| Formulário | `/contato` — 7 campos, `input.site` **sem `id`**, sem `action`/`method` |
| Mapeamento | `site.json → forms.contato.fields` por `#id`/`[name]`; `submit: manual` |
| Backend de solicitações | **não existe** → `endpoints.submitRequest: null` |
| Publicação do widget/ponte | **pendente de autorização** do responsável pelo site |
| Adaptador | desacoplado: `site.json` + ponte + rotas; trocar o backend é configurar `endpoints.submitRequest` |

O envio pelo formulário continua sendo do visitante. A Kirana preenche, valida,
resume e — se houver backend real autorizado — envia por `submit_service_request`
com aprovação explícita.

---

## 7. Limitações declaradas

1. **Sem endpoint real de solicitações:** `submit_service_request` responde
   `enviado:false, motivo:'endpoint_nao_configurado'` e mantém o rascunho.
2. **Nada foi publicado no site** — código pronto, publicação dependente de
   autorização.
3. **Requisitos não são publicados pelo site:** os campos marcados
   `origem:'operacional'` são o que a operação precisa saber; a Kirana diz isso
   com todas as letras (`aviso`).
4. **Arquivos ficam só no servidor local** (`data/uploads`), com 30 dias de
   retenção; não há varredura antivírus — a mitigação é tipo/tamanho/assinatura
   e a **não execução**.
5. **`/api/copilot/info` continua 405** (limitação da v0.5.0 preservada).
6. **Voz:** teste real de microfone no Windows segue pendente; não bloqueia esta
   fase.
7. **Conhecimento capturado em 26/10/2026** — se o site mudar, `site-sync`
   acusa divergência.
