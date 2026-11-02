# Auditoria de regressão — Gateway, ferramentas e interface (v0.5.1)

**Data:** 26/10/2026 · **Base:** `bf4a915` (v0.5.1, `main`) · **Situação:** correções aplicadas **no workspace**, **nada commitado, nada publicado**.

---

## 1. Resumo em uma página

| # | Sintoma relatado (Windows, Gateway real) | É regressão? | Causa raiz | Situação |
|---|---|---|---|---|
| 1 | Interface mostra `gateway.consultar_servicos · ok`, mas a Kirana diz que a consulta falhou | **Sim** | `unknown_tool` em toda ferramenta (prefixo `gateway.`) **+** a pílula imprimia `ok` sempre que `ok !== false`… e o evento chegava sem falha porque o erro era do transporte lógico, não do stream | **corrigido** |
| 2 | `list_services` / `get_site_context` → `unknown_tool` | **Sim** | mesma causa | **corrigido** |
| 3 | Pesquisa de `https://opportunity.ia.br` falha | **Não é regressão** | **Nunca existiu** busca web: 0 commits em todo o histórico, nenhuma ferramenta registrada, Gateway sem capacidade web | documentado + orientação no prompt |
| 4 | *(descoberto na auditoria)* no widget do site (CopilotKit/AG-UI) as ações de interface não executavam | **Sim**, mesma família | o mapa de ferramentas de frontend era indexado pelo nome declarado; o nome prefixado não casava | **corrigido** |

---

## 2. Quem executa cada ferramenta

| Categoria | Onde está | Quem executa | Quantas |
|---|---|---|---|
| **Core** (catálogo, memória, interesse) | `src/tools/definitions.js` | **Kirana** (servidor) | 7 |
| **Site** (contexto, páginas, soluções, navegação) | `src/site/tools.js` | **Kirana** (servidor); navegação é uma *diretiva* — quem clica é o navegador | 9 |
| **Operacionais de solicitação** (Fase 5) | `src/site/request-tools.js` | **Kirana**; escrita só após HITL | 8 |
| **Frontend** (`navigateToPage`, `fillContactForm`, …) | declaradas pelo site via AG-UI (`site.json` → `siteKit`) | **Navegador**; a Kirana só anuncia a chamada | por site (6 no demo) |
| **Chat do modelo** | Gateway (`/v1/chat/completions`) | **Gateway → ChatGPT**; o Gateway **não executa ferramentas** (README l.43) | — |

**Total na Kirana: 24 ferramentas registradas** (7 + 9 + 8), preservadas nesta correção. `site.json` declara 17.

---

## 3. Rastreio da chamada (antes × depois)

**Antes (`bf4a915`):**

```
modelo (via Gateway) → tool_call name = "gateway.list_services"
   → registry.get("gateway.list_services") = undefined
   → emit tool_result { name:"gateway.list_services", ok:false, errorCode:"unknown_tool" }
   → modelo recebe {"ok":false,"erro":{"codigo":"unknown_tool", …}}   [sem lista de ferramentas]
   → resposta: "não consegui consultar o catálogo"
   → interface: pílula com o texto "· ok"
```

**Depois:**

```
modelo → tool_call name = "gateway.list_services"
   → canonicalToolName() = "list_services"
   → registry.get("list_services") ✔
   → emit tool_result { name:"list_services", ok:true, data:{…} }
   → modelo recebe {"ok":true,"dados":{6 soluções reais}}
   → resposta com dados reais do site
   → interface: pílula "Listar soluções · ok"
```

### Por que `unknown_tool` chegava à resposta final

Porque o registro local comparava nome **exato**. O Gateway local (`src/responses.js` do pacote em `integrations/`) envolve as ferramentas do cliente:

```js
function toNamespacedTools(tools) { … return [{ type: 'namespace', name: 'gateway', … }] }
function displayToolName(namespace, name) { return namespace ? `${namespace}.${name}` : name }
```

e usa `displayToolName` no `delta.tool_calls` e no `message.tool_calls` final. O `splitToolName` só é usado no caminho de volta. Resultado: **toda** ferramenta virava `unknown_tool`, e o modelo recebia um erro sem saber o que mais existia — daí a resposta genérica de falha.

### Por que a interface mostrava `ok`

`addToolPill` (`public/app.js`) imprimia o sufixo `· ok` sempre que o evento **não** era `pending`, ignorando `ok === false`. Ou seja: o **fim do transporte** (o SSE chegou ao fim) era exibido como **sucesso da ferramenta**. O código dizia literalmente `` : `${label} · ok` ``.

### Por que as suítes não pegaram

O `test/helpers.js` e o `scripts/mock-gateway.js` devolviam o nome **cru**. 429/429 e 67/67 verdes conviviam com o defeito. Correção de teste: opção `namespaced: true` no helper e `--namespaced` no mock.

---

## 4. Pesquisa externa — ausência comprovada

| Verificação | Resultado |
|---|---|
| `git log --all -S` para `web_search`, `search_web`, `pesquisar_na_web`, `fetch_url`, `browse_web`, `navegar_web`, `consultar_site` | **0 commits** em todo o histórico |
| `grep` em `src/`, `public/`, `scripts/` | nenhum vestígio |
| `KNOWN_CAPABILITIES` do Gateway (`src/capabilities.js`) | `text.chat`, `files.*`, `images.*`, `video.*`, `audio.*` — **nada de web** |
| README do Gateway | o Gateway **não executa** ferramentas |

**Conclusão: não houve regressão de busca web. A capacidade nunca existiu.** Não foi implementada integração Google (ou qualquer provedor) — não há base comprovada nem autorização. O que foi feito: o prompt passa a declarar a limitação e a oferecer o caminho real (conhecimento do site + contato oficial), e `unknown_tool` devolve `disponiveis` + `orientacao` para o modelo não inventar equivalência.

---

## 5. Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `src/tools/names.js` **(novo)** | `canonicalToolName()` remove **somente** `gateway.`; `gatewayx.foo` fica intacto; `isNamespaced()` |
| `src/tools/registry.js` | `resolveName()` (só devolve nome registrado; nunca "chuta") e `names()` |
| `src/agent.js` | despacho resolve nome cru → canônico; ferramentas de frontend também aceitam o nome prefixado e saem com o nome do site; `unknown_tool` com `disponiveis` + `orientacao`; nome exibido nunca tem prefixo |
| `public/stream-state.js` | `toolPillView()` — pílula derivada do **resultado** (`ok` / `fail` / `warn`), com motivo por código de erro |
| `public/app.js` | usa `toolPillView`; conta falhas do turno e mostra “N ferramentas com falha nesta resposta” |
| `public/styles.css` | `.pill.tool-fail` (vermelho) distinto de `tool-warn` (âmbar) |
| `src/prompts.js` | regra explícita: **sem internet/busca web**; diferencie falha de ferramenta × transporte |
| `scripts/mock-gateway.js` | `--namespaced` (imita o Gateway real) e `--unknown-tool=<nome>` (reproduz `unknown_tool`) |
| `test/helpers.js` | `startFakeGateway({ namespaced })` |
| `test/gateway-namespace.test.js` **(novo)** | 8 testes de integração |
| `test/tool-pill.test.js` **(novo)** | 5 testes da pílula |
| `test/browser/site-v2.mjs` | padrão de porta corrigido (1456 → 1455: era o mock, não a Kirana) |

---

## 6. Testes

### Provas de regressão (o teste falha se a correção for removida)

- Correção de `registry.resolveName` **desativada**: `gateway-namespace.test.js` → **4 falhas** (testes 2, 3, 4, 5).
- Correção do mapa de frontend **desativada**: **1 falha** (teste 8).

### Suíte Node (gateway simulado)

```
441 → 442 testes · 442 pass · 0 fail (334 s)
```

### Navegador (Playwright/Chromium headless)

| Cenário | Gateway simulado (1455) | Gateway **real-like** `--namespaced` (3100) |
|---|---|---|
| `demo-flow` | 15/15 | **15/15** |
| `site-flow` | 18/18 | **18/18** |
| `site-v2` | 8/8 | **8/8** |
| `site-v5` | 26/26 | **26/26** |
| **Total** | **67/67** | **67/67** |

`voice-flow`: 52/60 — as 8 falhas são **de ambiente** (`edge-tts` ausente no sandbox; `/api/voice/status` → `available:false`, `voice_provider_failed`), não de regressão. Microfone/áudio reais **não** foram validados.

> ⚠️ **Limite declarado:** todos os testes acima usam **Gateway simulado** (com e sem namespace). O **Gateway real do Windows** não foi chamado nesta auditoria — o que se comprovou é que o formato de nome que ele produz (`gateway.<nome>`) agora é executado de ponta a ponta.

---

## 7. Critérios de conclusão

| Critério | Situação |
|---|---|
| `consultar_servicos` retorna dados válidos **ou** erro rastreável | ✅ executa (teste 2); é ferramenta registrada, não catálogo legado |
| `list_services` e `get_site_context` executadas pelo componente correto | ✅ Kirana (servidor), teste 3 |
| Nenhum `unknown_tool` para ferramenta registrada/autorizada | ✅ 0 nos dois cenários de navegador e na suíte |
| Interface diferencia transporte × resultado | ✅ `toolPillView` + `tool-fail` + contador (5 testes + evidência visual) |
| Kirana responde com dados reais do site | ✅ 6 frentes reais (`list_services`) |
| Disponibilidade/ausência de pesquisa externa comprovada | ✅ histórico + código do Gateway (0 commits) |
| 24 ferramentas e fluxo da Fase 5 preservados | ✅ 7 + 9 + 8; suítes de solicitação verdes |
| Gateway simulado × real identificados separadamente | ✅ seções 6 e 7 |

---

## 8. Pendências

1. **Teste no Windows com o Gateway real** — só ele fecha o critério "sem mocks". Roteiro: `iniciar.bat`, perguntar “quais serviços vocês oferecem?” (esperado: pílula `Listar soluções · ok` + 6 frentes) e “pesquise em opportunity.ia.br” (esperado: pílula vermelha `pesquisar_na_web · ferramenta não encontrada`, resposta dizendo que não há busca web).
2. **`consultar_servicos` × `list_services`** — os dois coexistem (core e site) e ambos funcionam; se a intenção era um só nome no prompt, é decisão de produto, não bug.
3. **Commit/push pendentes** — 5 commits anteriores + este trabalho, **aguardando autorização**.
4. `public/demo/demo.js:144` ainda mostra “Falha ao enviar.” genérico (correção proposta, não aplicada).

---

## 9. Verificação final de erros (26/10/2026, após as correções)

| Verificação | Resultado |
|---|---|
| `git diff --check` (espaços/quebras) | limpo |
| Sintaxe: 97 arquivos `.js`/`.mjs` + 3 novos + 2 bundles | **0 erros** |
| `node scripts/run-tests.mjs` | **442/442** (3 rodadas) |
| Navegador — simulado / real-like | **67/67** e **67/67** |
| `node scripts/audit-contract.mjs` | 17 requisições válidas, **0 violações** |
| `node scripts/site-sync.mjs --check` | 23 rotas, 19 páginas, 14 documentos — em dia |
| Logs dos servidores durante as suítes | só o WARN esperado de `KIRANA_ACCESS_TOKEN` vazio (uso local) |
| Varredura de segredos nos arquivos alterados/novos | nada encontrado |
| `data/` (30 arquivos), `.bat`, `sites/`, `.env.example` | intactos |
| `/api/tools` | **24 ferramentas** |

**Achados que NÃO são erros de código desta auditoria (pré-existentes, não corrigidos):**

1. **`GET /api/copilot/info` → 405 — RESOLVIDO NA v0.5.2 como "comportamento correto".** A investigação de 26/10/2026 provou que o 405 é **necessário**: o cliente v2, em `transport:"auto"`, faz `GET <runtimeUrl>/info` e, se receber 2xx, assume o transporte REST — que o runtime *single-route* não serve (HTTP 400 "Missing method field", painel preso em "conectando…"). O runtime info real vem de `POST /api/copilot {"method":"info"}`. Montar a rota quebrava o widget (medido: site-v2 caiu de 8/8 para 6/8); com o 405 ele volta a 8/8. Decisão comentada em `src/server.js` e coberta por `test/copilot-routes.test.js`.
2. **`/api/agui` → 404 — CORRIGIDO NA v0.5.2.** A rota está montada (isolada por caminho exato) e o `RUN_STARTED` passou a sair com o campo `type`, que faltava porque `AGUI.RUN_STARTED` não existia no mapa de constantes.
3. **`doctor`: `.env` ausente e `KIRANA_GATEWAY_API_KEY` vazia** — são o ambiente do sandbox, não o do Windows. O `.env` do usuário não existe aqui e não foi tocado.
4. **`voice-flow` 52/60** — 8 falhas por `edge-tts` indisponível (`available:false`, `voice_provider_failed`). Nenhuma tem relação com esta auditoria.
