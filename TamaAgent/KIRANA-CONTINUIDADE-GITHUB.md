# KIRANA — CONTINUIDADE E ACESSO AO GITHUB

**Data da verificação:** 26/10/2026
**Versão verificada:** 0.5.1 · **Commit local:** `bf4a915` · **Tag:** `v0.5.1`
**Estado do GitHub:** repositório **existe e é público** —
`https://github.com/DaniloXPTEAM/Kirana`, branch `main`, último commit remoto
**`31c8d0e`** (v0.4.1). Leitura confirmada; **escrita (push) indisponível** nesta
sessão por falta de credencial.

> **ERRATA (26/10/2026):** uma versão anterior deste documento afirmava que
> "nunca houve push" e que "não existe repositório remoto". **Isso estava
> errado.** O repositório existe, tem 7 commits publicados e recebeu push até
> `31c8d0e` (v0.4.1). A verificação anterior falhou porque o diretório local não
> tinha `remote` configurado — ausência de remote **não** significa ausência de
> repositório. As seções 6, 7, 12, 15, 16 e 17 foram corrigidas.

> Este documento **não contém segredos**: nenhum token, chave de API, senha ou
> credencial. Ele existe para que o trabalho continue numa sessão autenticada sem
> reconstruir nada.

---

## 1. Objetivo completo do projeto Kirana

A Kirana é o **agente conversacional da Opportunity AI**: um assistente residente
no site `https://opportunity.ia.br` que conversa por texto e voz, conhece o
conteúdo real da empresa, e — desde a v0.5.1 — **executa** uma solicitação de
serviço: escolhe o serviço, consulta requisitos, coleta dados, recebe arquivos,
preenche o formulário real do site, valida, pede confirmação explícita, tenta
enviar (só se houver backend autorizado) e informa o **resultado real**.

Princípios que valem em todo o projeto:
- **não inventar** preço, prazo, plano, requisito, protocolo ou andamento;
- **não simular execução** — ferramenta registrada não é sinônimo de funcional;
- **não afirmar teste real** quando a validação foi simulada;
- **não alterar** o Gateway local (1455), os modelos, a voz, o `.env`, o `data/`;
- **ação sensível exige aprovação humana** (HITL);
- **nada é publicado** sem autorização explícita.

---

## 2. Arquitetura — CopilotKit v2 + LangGraph

```text
Navegador (public/)
  chat vanilla (app.js) · widget v1 (kirana-widget.js) · widget v2 (kirana-v2.js)
  ponte do site (site-agent.js): navigate · fill_form · request_upload
  │  HTTP + SSE · mesma origem · sem chave de API no cliente
  ▼
Backend Kirana (src/server.js)
  identidade · sessões · rate limit · origem · orquestração · ferramentas · HITL
  │  src/graph.js — LangGraph é o ÚNICO orquestrador
  │     prepare → task → model ⇄ tools → overflow? → finalize
  │  src/requests/{store,requirements,files}.js — a tarefa (solicitação)
  ▼
Cliente do gateway (src/gateway.js) — Authorization: Bearer <chave> (só aqui)
  ▼
Kirana-ChatGPT-Gateway v0.2.0 (127.0.0.1:1455) → modelo da conta ChatGPT
```

**Decisões arquiteturais que não devem ser desfeitas:**
- LangGraph é o único orquestrador; **não** criar segundo agente ou segundo grafo.
- O canal de estado da tarefa chama-se **`taskState`** — `task` colide com o nome
  do nó (LangGraph recusa canal com mesmo nome de nó).
- CopilotKit **v2** é opt-in (`public/widget/kirana-v2.js`); a interface residente
  vanilla continua sendo a principal. **Não** criar segunda janela de assistente.
- Um `site.json` por site em `sites/<id>/`; as ferramentas de site só recebem o
  que está declarado ali (`permissions.read/navigation/effects`, `denied`).

---

## 3. Estado da versão v0.5.1 (verificado em 26/10/2026)

| Verificação | Resultado |
| --- | --- |
| Versão em `package.json` | **0.5.1** |
| Commit HEAD | **`bf4a9157a5a59618a21be4c50668b3f20092dfae`** |
| Tag | `v0.5.1` (anotada, aponta para `bf4a915`) |
| Branch | `main` (única); upstream **`origin/main`** configurado nesta verificação |
| Alterações locais | **0** (árvore limpa) |
| Remotos configurados | **nenhum** |
| Stash | vazio |
| `git fsck` | sem erro |
| Arquivos rastreados | 170 |
| ZIP de entrega | `/home/user/kirana-v0.5.1.zip` · sha256 `eb0a1e07e03dc85075044d705a0d62e5b83ca5cd0aac096703b058cc50cf4b0f` · 195 arquivos |
| Patch | `/home/user/kirana-v0.5.1.patch` (diff contra `ead823b`) |

### 3.1 Testes executados nesta verificação

| Suíte | Resultado |
| --- | --- |
| `node scripts/run-tests.mjs` | **429/429** (0 falhas), ~188 s |
| `test/browser/site-v5.mjs` | **26/26** |
| `test/browser/site-flow.mjs` | **18/18** |
| `test/browser/site-v2.mjs` | **8/8** |
| `test/browser/demo-flow.mjs` | **15/15** (ver observação 4.3) |
| Total navegador | **67/67** |

### 3.2 Sintaxe e build

- `node --check` em **todos** os `.js`/`.mjs` versionados: **0 falhas**.
- Os 7 arquivos `.jsx` de `widget/src/` compilam com esbuild (`loader: jsx`): **ok**.
- Build reproduzível: `node scripts/build-widget.mjs --lite` regenera
  `public/widget/kirana-widget.js` com exatamente **203.306 bytes** (igual ao
  commitado). `--v2` regenera `kirana-v2.js` com tamanho equivalente
  (962 KB agora vs 984 KB commitado — diferença de minificação/versão do
  esbuild, não de código; ambos carregam e montam no navegador).

### 3.3 Diagnóstico do ambiente (`node scripts/doctor.mjs`)

```text
✗ Arquivo .env             não encontrado — copie .env.example para .env
✓ Node.js                  v20.20.2 (necessário >= 20.6)
✗ Chave do gateway         KIRANA_GATEWAY_API_KEY vazia
✓ Diretório de dados       .../data
✓ Porta da Kirana          127.0.0.1:3000 livre
! Voz (TTS)                indisponível: voice_provider_failed
! Gateway                  checagens de rede ignoradas sem chave
! Token de acesso local    KIRANA_ACCESS_TOKEN vazio — apenas uso local
```

Todas as ocorrências são **esperadas no sandbox** (não há `.env`, não há gateway
real na 1455, não há rede para o provedor de voz). Isso **não** é defeito de
código.

### 3.4 Interface em ambiente de teste (servidor real, gateway simulado)

Servidor em `127.0.0.1:3100` com gateway **simulado** (`scripts/mock-gateway.js`,
porta 1457) e `KIRANA_DATA_DIR` temporário:

| Item | Resultado |
| --- | --- |
| Página abre | ✅ `Kirana · Opportunity AI`, chat e composer presentes |
| Erros de JS no console | ✅ nenhum |
| `/api/status` | ✅ gateway `ok` (mode: mock), modelo ativo `gpt-6-luna`, fallback `gpt-6.1-sol` |
| `/api/tools` | ✅ **24 ferramentas** (7 core + 9 de site + 8 operacionais) |
| `/api/requests?sessionId=<válida>` | ✅ `{"solicitacoes":[]}` |
| `/api/requests?sessionId=abc` | ✅ **400** (sessão inválida recusada) |
| Chat, ferramentas, formulário, upload, navegação, estados | ✅ cobertos por `site-v5` 26/26 e `site-flow` 18/18 |
| Evidência visual | `/home/user/evidencia-interface-v051.png` |

### 3.5 Voz (declaração honesta)

- `/api/voice/status` responde: `available:false`, `provider:"edge-tts"`,
  `reason:"voice_provider_failed"`, `note:"Provedor externo não oficial: pode
  estar temporariamente fora do ar."`
- **Não houve teste de microfone real.** Captura de áudio, barge-in e latência
  não foram medidas aqui (headless sem microfone e sem o provedor).
- Os 44 testes automatizados de voz (texto, transcrição, comandos, motor,
  controller, barge-in) passam, mas são **unidade/integração**, não áudio real.
- **Pendência herdada:** validar voz no Windows com microfone físico.

---

## 4. Defeitos e observações registrados (nenhuma alteração feita)

Nesta etapa **nada foi corrigido** — só registrado, conforme instruído.

### 4.1 Observação (não é defeito de código) — rate limit de 20 req/min por IP

`KIRANA_RATE_LIMIT_MAX=20` por padrão em `src/config.js`/`.env.example`, com
janela de 60 s. Rodar as 4 suítes de navegador em sequência na **mesma** porta
esgota o limite e aparece **HTTP 429** em `/api/site/context` e
`/api/demo/contact/*`.

- **Comportamento observado:** em 3 rodadas sequenciais, `site-flow`, `site-v2` e
  `demo-flow` apresentaram falhas intermitentes (`9/16`, `24/26`, `13/15`).
- **Causa comprovada:** corpo real do 429 →
  `{"error":{"code":"rate_limited","message":"Muitas requisições em pouco tempo. Aguarde e tente novamente.","retryAfterMs":…}}`
  (formato **correto** e esperado) e a falha desaparece após a janela.
- **Conclusão:** é o **controle de taxa funcionando**, não regressão. Roteiro
  correto: reiniciar o servidor (ou usar `KIRANA_RATE_LIMIT_MAX` mais alto em
  ambiente de teste) antes de cada arquivo de navegador. Com servidor recém-
  iniciado: **26/26, 18/18, 8/8, 15/15**.

### 4.2 Observação menor — mensagem de erro genérica no demo

`public/demo/demo.js` (linha ~144) mostra `payload.message || 'Falha ao enviar.'`.
Quando a resposta vem no formato envelope (`{error:{code,message}}`), a mensagem
real fica em `payload.error.message` e a tela mostra o texto genérico. **Não é
regressão da v0.5.1** (arquivo intocado), não afeta a Kirana residente nem a
Fase 5. Correção sugerida (quando autorizado): ler também `payload.error?.message`.

### 4.3 Nenhum erro real de produto encontrado

Fora os dois pontos acima, **nenhum erro real**: suíte 429/429, navegador 67/67,
build reproduzível, árvore limpa, nenhuma credencial exposta.

---

## 5. Histórico dos checkpoints

| Versão | Commit | Data | Entrega |
| --- | --- | --- | --- |
| — | `24b6619` … `ea34388` | 24/10 | commits iniciais |
| v0.4.0 | `15bb060` | 25/10 | voz conversacional (Marco 3) |
| — | `e16eb5c` | 25/10 | padroniza pnpm |
| v0.4.1 | `31c8d0e` | 25/10 | correção do sistema de voz |
| v0.4.2 | `d1acdf4` | 25/10 | motor do navegador, escolha de voz |
| v0.4.3 | `87cd75c` | 25/10 | fala sem markdown, identidade única, transcrição |
| v0.4.4 | `9a371ef` | 26/10 | barge-in ("Kirana, pare") |
| v0.5.0 | `ead823b` | 26/10 | **Fase 4** — agente residente no site |
| v0.5.1 | **`bf4a915`** | 26/10 | **Fase 5** — execução de solicitações |

> `43fa5a2` está **superado** por `ead823b` — não voltar a ele.

---

## 6. Repositório e branch local

| Item | Valor |
| --- | --- |
| Caminho local | `/home/user/repo-push` (workspace da sessão) |
| Branch | `main` (local) |
| **Repositório remoto** | **`https://github.com/DaniloXPTEAM/Kirana`** |
| Visibilidade | **pública** (`private: false`) |
| Branch remota | **`main`** (branch padrão; é a única) |
| `origin` no clone local | configurado nesta verificação: `origin → …/DaniloXPTEAM/Kirana.git` |
| Último commit remoto | **`31c8d0e`** — `Corrige o sistema de voz da v0.4.0…` (v0.4.1) |
| `pushed_at` (API) | **2026-10-25T14:09:36Z** |
| Tags remotas | **nenhuma** (`v0.5.1` existe só localmente) |
| Outras branches remotas | **nenhuma** |
| GitHub Pages | **desligado** (`has_pages: false`) |
| Autor do último commit remoto | `Arena Agent <agent@arena.ai>` |
| Autor histórico | `DaniloXPTEAM <xpteamagain@gmail.com>` |
| Conector GitHub do Arena | indisponível nesta sessão (`list_connector_tools` → `unsupported`) |
| Credencial de escrita | **ausente** (sem `~/.git-credentials`, `~/.netrc`, `gh` CLI, token no ambiente) |

**Leitura:** confirmada por três caminhos independentes — `git ls-remote`
anônimo, `GET /repos/DaniloXPTEAM/Kirana` (HTTP 200) e `git fetch` completo.
**Escrita:** indisponível; `git push --dry-run` responde
`fatal: could not read Username for 'https://github.com'`. Nenhum push foi (nem
pôde ser) executado.

---

## 7. Commits e tags conhecidos

- **12 commits** no total no local; **7 publicados**, **5 pendentes**.
- **1 branch** (`main`, local e remoto), **1 tag** (`v0.5.1`, apenas local).
- Tags anteriores (`v0.4.x`, `v0.5.0`) **não** existem como tags Git em lugar
  algum; as versões foram registradas no `CHANGELOG.md` e nas mensagens de
  commit. Só `v0.5.1` foi criada como tag — e ainda não foi enviada.

### 7.1 Mapa remoto × local

| Commit | Data | Descrição | Onde está |
| --- | --- | --- | --- |
| `24b6619` | 24/10 | Initial commit | remoto + local |
| `43779a2` | 24/10 | FAz | remoto + local |
| `cfa4e13` | 24/10 | 2v1 | remoto + local |
| `ea34388` | 24/10 | v3 | remoto + local |
| `15bb060` | 25/10 | v0.4.0 — voz conversacional | remoto + local |
| `e16eb5c` | 25/10 | padroniza pnpm | remoto + local |
| **`31c8d0e`** | 25/10 | v0.4.1 — correção do sistema de voz | **remoto (HEAD) + local** |
| `d1acdf4` | 25/10 | v0.4.2 — motor do navegador | **apenas local** |
| `87cd75c` | 25/10 | v0.4.3 — fala sem markdown | **apenas local** |
| `9a371ef` | 26/10 | v0.4.4 — barge-in | **apenas local** |
| `ead823b` | 26/10 | v0.5.0 — Fase 4 (agente residente) | **apenas local** |
| **`bf4a915`** | 26/10 | v0.5.1 — Fase 5 (solicitações) | **apenas local (HEAD)** |

### 7.2 Compatibilidade da história (verificada)

| Verificação | Resultado |
| --- | --- |
| `git merge-base --is-ancestor origin/main main` | ✅ verdadeiro — `31c8d0e` é ancestral de `bf4a915` |
| Commits locais à frente | **5** (`d1acdf4`, `87cd75c`, `9a371ef`, `ead823b`, `bf4a915`) |
| Commits remotos ausentes no local | **0** |
| Divergência de história (commits reescritos no remoto) | **nenhuma** |
| Simulação de merge (`merge-tree`) | **sem conflito** |
| Conteúdo divergente | apenas aditivo: `git diff origin/main main` = 85 arquivos, +14.299 / −307 |
| Integridade dos objetos | `git fsck` sem erro (local e remoto) |

**Conclusão: o push, quando autorizado e com credencial, é um fast-forward
simples.** Não há rebase, merge nem force necessário. Nada foi enviado.

---

## 8. Resultados dos testes atuais

| Suíte | Arquivos | Verificações |
| --- | --- | --- |
| `node scripts/run-tests.mjs` | 38 arquivos `test/*.test.js` | **442/442** |
| Navegador (Playwright/Chromium) | 4 arquivos `test/browser/*.mjs` | **67/67** |
| `node scripts/site-sync.mjs --check` | — | sem divergência (23 rotas, 19 páginas, 14 documentos) |

Suítes da Fase 5: `requests-store` (12), `requests-validation` (11),
`request-tools` (19), `requests-http` (3), `test/browser/site-v5.mjs` (26).

**Auditoria de regressão do Gateway (26/10/2026):** +13 testes —
`gateway-namespace` (8) e `tool-pill` (5). Navegador reexecutado em **duas**
configurações: gateway simulado **67/67** e gateway **real-like**
(`mock-gateway --namespaced`) **67/67**. Detalhes em
`docs/AUDITORIA-GATEWAY-v0.5.1.md`. **Alterações não commitadas.**

---

## 9. Ferramentas existentes (24 registradas)

**Core (7)** — `src/tools/definitions.js`:
`consultar_servicos`, `consultar_produtos`, `consultar_status_projeto`
(**dados de demonstração**), `consultar_memoria`,
`registrar_interesse_comercial` (escrita/HITL), `salvar_memoria` (escrita/HITL),
`apagar_memoria` (escrita/HITL).

**Site (9)** — `src/site/tools.js`:
`get_site_context`, `list_site_pages`, `explain_current_page`, `list_services`,
`explain_service`, `request_user_input` (coleta progressiva), `navigate_to_page`,
`open_service_page`, `show_confirmation`.

**Operacionais (8)** — `src/site/request-tools.js`:
`get_service_requirements`, `start_service_request`, `fill_site_form`,
`request_file_upload`, `validate_service_request`,
`submit_service_request` (escrita/HITL), `get_request_status`,
`cancel_service_request` (escrita/HITL).

Inventário detalhado (handler, entrada, saída, permissão, estado, teste,
dependência): `docs/FASE5-AUDITORIA-FERRAMENTAS.md`.

---

## 10. Estado do Gateway, voz, modelos e RAG

| Componente | Estado | Observação |
| --- | --- | --- |
| **Gateway local (1455)** | **não alterado, nunca exposto** | `integrations/Kirana-ChatGPT-Gateway-v0.4.1-Windows.zip` versionado só como referência; o código do gateway não é modificado pela Kirana |
| Cliente do gateway | `src/gateway.js` | Bearer só no servidor; payload allowlist em `src/payload.js` (v0.2.0 compatível) |
| **Modelos** | `gpt-6-luna` (ativo), `gpt-6.1-sol` (fallback) | inalterados; nenhuma troca de modelo nas fases 4/5 |
| **Voz** | `edge-tts`, voz `pt-BR-ThalitaMultilingualNeural`, `+8%` | **indisponível no sandbox** (`voice_provider_failed`); motor do navegador como alternativa |
| **RAG / conhecimento** | 14 documentos em `sites/opportunity-ai/knowledge/`, 55 chunks, BM25 próprio sem dependência | capturado em 26/10/2026 |
| Configurações | `.env.example` versionado; `.env` real **não** existe no sandbox | nunca sobrescrito |
| Dados | `data/` (30 arquivos: sessões + `interests.jsonl`) **não versionado**, preservado | `.gitignore` cobre `data/`, `.env`, `node_modules/` |

---

## 11. Arquivos e caminhos necessários

**Projeto:** `/home/user/repo-push/`

| Caminho | Conteúdo |
| --- | --- |
| `src/server.js` | rotas HTTP/SSE, rate limit, origem, estáticos, rotas de solicitação |
| `src/agent.js` | turno do agente, ferramentas, HITL, bloco do site no prompt |
| `src/graph.js` | grafo LangGraph (`prepare → task → model ⇄ tools → finalize`), canal `taskState` |
| `src/requests/{store,requirements,files}.js` | estado da solicitação, validação de requisitos, upload |
| `src/site/{tools,request-tools,context}.js` | 9 ferramentas de site + 8 operacionais + contexto |
| `src/copilot/site-kit.js` | leitura e validação do `site.json` (inclui `forms`, `uploads`, `endpoints`, `requests`) |
| `src/tools/{registry,definitions}.js` | registro central e 7 ferramentas core |
| `public/app.js` | interface vanilla (chat, cartões de confirmação, anexo) |
| `public/site-agent.js` | ponte do site: `navigate`, `fill_form`, `request_upload`, `uploadFile` |
| `public/widget/kirana-widget.js` · `kirana-v2.js` | widgets v1 (vanilla/lite) e v2 (CopilotKit) |
| `widget/src/*.jsx` | fontes dos widgets (7 arquivos) |
| `scripts/build-widget.mjs` | build esbuild (`--lite`, `--agui`, `--v2`) |
| `scripts/mock-gateway.js` | gateway SIMULADO para testes (não é o real) |
| `scripts/run-tests.mjs` · `doctor.mjs` · `site-sync.mjs` | suíte, diagnóstico, sincronização com o site |
| `sites/opportunity-ai/site.json` | 17 ferramentas declaradas, 23 rotas, 19 páginas, `forms.contato`, `uploads`, `endpoints.submitRequest: null` |
| `sites/opportunity-ai/requirements.json` | requisitos por serviço (`requisitosPublicados.disponivel:false`) |
| `sites/opportunity-ai/knowledge/` | 14 documentos reais do site |
| `test/*.test.js` (36) · `test/browser/*.mjs` (4) | suíte automatizada e navegador |
| `docs/` (22) | inclui `FASE4-AUDITORIA.md` e os 4 `FASE5-*.md` |
| `iniciar.bat`, `diagnostico.bat`, `iniciar-demo.bat`, `testar.bat` | scripts Windows preservados |

**Artefatos de entrega (fora do repo):**
`/home/user/kirana-v0.5.1.zip`, `kirana-v0.5.1.patch`,
`kirana-v0.5.1-LEIA-ME.md`, `evidencia-interface-v051.png`.

---

## 12. Pendências

| # | Pendência | Bloqueia? |
| --- | --- | --- |
| 1 | **Credencial de escrita no GitHub** (o repositório já existe e é público; falta apenas autenticação para o push) | bloqueia só a publicação |
| 2 | Endpoint real de recebimento de solicitações (`endpoints.submitRequest`) | não — a Kirana diz `enviado:false` |
| 3 | Publicação do widget/ponte no site (depende do responsável pelo site) | não |
| 4 | Validação de voz com microfone real no Windows | não |
| 5 | Meta de 100–300 ms de latência de voz medida no Windows | não |
| 6 | Receber o ZIP do novo site Opportunity AI (Etapa posterior) | sim, para a próxima fase |
| 7 | `/api/copilot/info` responde 405 | não (limitação conhecida) |
| 8 | Mensagem de erro genérica em `public/demo/demo.js` (§4.2) | não |
| 9 | Antivírus/varredura de conteúdo nos uploads | não (mitigado por tipo/assinatura/retenção/não execução) |
| 10 | Tags Git de versões antigas (v0.4.x, v0.5.0) inexistentes | não |
| 11 | **Confirmar no Windows com o Gateway real** as correções da auditoria (namespace `gateway.`) | não — mas é o único teste que fecha "sem mocks" |
| 12 | Busca/pesquisa web **não existe** e nunca existiu (0 commits no histórico; Gateway sem capacidade web) — decidir se será implementada | não |
| 13 | `src/copilot/http.js` é **código morto** (não importado): por isso `/api/copilot/info` dá 405 e `/api/agui` dá 404 — `server.js:330` desvia todo `/api/copilot*` para o runtime | não (o fluxo real `/api/copilot` funciona e é testado) |

---

## 13. Plano aprovado para o novo site Opportunity AI

Sequência já acordada — **nada disto foi executado ainda**:

1. **Receber o ZIP da nova versão** do site Opportunity AI.
2. **Comparar** as integrações da Kirana (ponte, `forms`, rotas, páginas) com as
   páginas e serviços do site novo — campo por campo, rota por rota.
3. **Corrigir e atualizar o layout** da integração (seletores, mapeamento do
   formulário, allowlist de rotas, páginas do `site.json`).
4. **Criar o fluxo reutilizável** de conexão da Kirana a um site qualquer
   (adaptador genérico: `site.json` + ponte + rotas), sem duplicar interface.
5. **Definir backend público, RAG, armazenamento e gateway** (com autorização
   explícita antes de contratar qualquer serviço pago).
6. **Integrar e testar** (unidade + navegador + `site-sync`).
7. **Só então** solicitar autorização para push e publicação no GitHub Pages.

**O site original permanece inalterado** em todas as etapas.

---

## 14. Separação entre GitHub Pages e backend

Regra que precisa ser respeitada no novo site:

```text
GitHub Pages (estático, público)          Backend da Kirana (privado)
  HTML/CSS/JS do site                       /api/chat, /api/chat/confirm
  widget kirana-widget.js / kirana-v2.js    /api/site/*, /api/requests/*
  ponte site-agent.js                       /api/voice/*, /api/memory
  window.KIRANA_WIDGET_CONFIG { runtimeUrl }  ── chama ──►  backend
```

- **Pages não executa backend.** Nada de segredo, chave de gateway ou token no
  repositório publicado — a chave do gateway vive só no servidor da Kirana.
- O widget recebe apenas `runtimeUrl` (URL pública do backend) e `siteId`.
- CORS: `allowedOrigins` no `site.json` deve listar o domínio do Pages.
- Uploads e solicitações **não** podem ir para o Pages: exigem backend com
  armazenamento, limite de corpo e retenção.
- O backend **não pode** expor o Gateway local (1455); ele fala com o gateway
  pelo lado do servidor, e o navegador fala apenas com o backend.

---

## 15. Procedimento para retomar na nova sessão

```bash
# 1. Conferir o estado
cd /home/user/repo-push
git log --oneline -1          # deve ser bf4a915
git status --short            # deve estar vazio

# 2. Restaurar dependências (não persistem entre sessões)
corepack pnpm install --frozen-lockfile

# 3. Suíte completa (≈190 s) — esperado 429/429
node scripts/run-tests.mjs

# 4. Navegador (a instalação do Chromium também não persiste)
npx playwright install chromium
node scripts/mock-gateway.js --port 1457 --key local-mock &      # terminal 1
KIRANA_PORT=3100 KIRANA_GATEWAY_URL=http://127.0.0.1:1457 \
KIRANA_GATEWAY_API_KEY=local-mock KIRANA_DATA_DIR=/tmp/kirana-check \
node src/server.js &                                             # terminal 2

# reiniciar o servidor entre arquivos de navegador (evita 429 — §4.1)
KIRANA_BASE_URL=http://127.0.0.1:3100 node test/browser/site-v5.mjs
KIRANA_BASE_URL=http://127.0.0.1:3100 node test/browser/site-flow.mjs
KIRANA_BASE_URL=http://127.0.0.1:3100 node test/browser/site-v2.mjs
KIRANA_BASE_URL=http://127.0.0.1:3100 node test/browser/demo-flow.mjs

# 5. Integridade do site
node scripts/site-sync.mjs --check
```

**O `origin` já está configurado** neste clone (aponta para
`https://github.com/DaniloXPTEAM/Kirana.git`). O que falta é **credencial de
escrita**. Para habilitar (ação do responsável, fora desta sessão):

- conectar a conta GitHub ao Arena (conector `github`), **ou**
- fornecer um token/SSH com permissão de escrita no repositório
  `DaniloXPTEAM/Kirana`.

Com autenticação, a sessão seguinte poderá (somente após autorização explícita):

```bash
cd /home/user/repo-push
git fetch origin                        # confirmar que origin/main ainda é 31c8d0e
git merge-base --is-ancestor origin/main main && echo "fast-forward seguro"
git push origin main                    # SOMENTE após autorização explícita
git push origin v0.5.1                  # tag da versão
```

Se `origin/main` tiver avançado nesse meio-tempo, **parar e reavaliar** antes de
qualquer push (não usar `--force`).

Nenhum push, merge, pull destrutivo, rebase, criação de repositório ou
publicação foi executado nesta etapa. **O repositório existente foi preservado**
— apenas leitura (`ls-remote`, `fetch`) e a configuração local de `origin`.

---

## 16. Próximo comando ou ação recomendada

**Recomendado:** conceder **credencial de escrita** para o repositório já
existente `DaniloXPTEAM/Kirana` (conector `github` do Arena ou token/SSH). Não é
necessário criar repositório algum — e **não se deve** criar outro: o existente é
a fonte pública do projeto. Com a credencial, o envio é um fast-forward de 5
commits (`d1acdf4 → bf4a915`) mais a tag `v0.5.1`, mediante autorização
explícita.

Em paralelo, o trabalho de produto pode começar sem o GitHub: **enviar o ZIP do
novo site Opportunity AI** para iniciar a Etapa 1 do plano (§13, item 1).

**Comando imediato para retomar a verificação:**

```bash
cd /home/user/repo-push && git log --oneline -1 && node scripts/run-tests.mjs
```

---

## 17. Resumo executivo da verificação

| Pergunta | Resposta |
| --- | --- |
| A Kirana está funcionando? | **Sim** — sobe, responde, executa o fluxo de solicitação |
| Quais testes passaram? | **429/429** automatizados + **67/67** de navegador |
| Quais dependem de validação manual? | Voz real (microfone/áudio/latência no Windows), envio real para backend inexistente, publicação no site |
| Existe algum erro real? | **Não.** Só duas observações não bloqueantes (§4.1 rate limit ao rodar suítes em sequência; §4.2 texto genérico no demo) |
| O GitHub está acessível? | **Sim, para leitura** — repositório público `DaniloXPTEAM/Kirana`. **Escrita indisponível** (sem credencial) |
| Último commit remoto | **`31c8d0e`** (v0.4.1, 25/10/2026, `pushed_at` 14:09:36Z) |
| Commits locais não enviados | **5**: `d1acdf4`, `87cd75c`, `9a371ef`, `ead823b`, `bf4a915` |
| Tags não enviadas | **1**: `v0.5.1` |
| História compatível? | **Sim** — fast-forward puro; 0 commits remotos fora do local; sem conflito |
| Existe divergência? | **Nenhuma.** Só adição local (+14.299 / −307 em 85 arquivos) |
| Precisa criar repositório? | **Não.** O existente deve ser preservado |
| Podemos continuar nesta sessão? | **Sim** para desenvolvimento local, testes e o novo site; **não** para push até haver credencial |

---

## 18. Registro da verificação remota (26/10/2026)

Comandos executados — **todos de leitura**, nenhum altera o remoto:

| Comando | Resultado |
| --- | --- |
| `git ls-remote https://github.com/DaniloXPTEAM/Kirana.git` | `31c8d0e… refs/heads/main` (HEAD igual) |
| `git ls-remote --tags …` | vazio — nenhuma tag publicada |
| `curl -s https://api.github.com/repos/DaniloXPTEAM/Kirana` | HTTP 200 · `private:false` · `default_branch:"main"` · `pushed_at:"2026-10-25T14:09:36Z"` · `has_pages:false` · `size:703 KB` |
| `GET /repos/…/branches` | `main @ 31c8d0e` (única) |
| `GET /repos/…/tags` | `[]` |
| `git remote add origin …` | configurado localmente (não afeta o remoto) |
| `git fetch origin` | `e16eb5c..31c8d0e main -> origin/main` |
| `git rev-list --count origin/main..main` | **5** |
| `git rev-list --count main..origin/main` | **0** |
| `git merge-base --is-ancestor origin/main main` | ✅ fast-forward possível |
| `git merge-tree --write-tree origin/main main` | sem conflito |
| `git diff --stat origin/main main` | 85 arquivos, +14.299 / −307 |
| `git push --dry-run origin main` | **falhou por falta de credencial** (`could not read Username`) |

Os três pushes que você confirmou (`15bb060`, `e16eb5c`, `31c8d0e`) batem
exatamente com o histórico observado em `origin/main`.
