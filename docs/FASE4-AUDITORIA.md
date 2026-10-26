# Kirana Fase 4 — agente residente no site Opportunity AI

**Versão:** 0.5.0 · **Base:** v0.4.4 (`9a371ef`) · **Data:** 26/10/2026
**Alvo:** `https://opportunity.ia.br` · **Agente:** Kirana

Este documento é a entrega escrita da Fase 4 na ordem pedida: **auditoria antes
de mexer**, arquitetura em camadas, o que foi implementado, o que foi testado e
**o que não foi**. A regra que vale em todo o texto: onde não há prova, está
escrito que não há.

---

## 1. Auditoria inicial (feita antes de instalar ou alterar qualquer coisa)

### 1.1 O site real

| Verificação | Resultado (26/10/2026) |
| --- | --- |
| Framework | **HTML estático**. Nenhum marcador de Next/Astro/Nuxt/React/Vue/WordPress/Webflow/Framer no HTML servido |
| JavaScript do site | um único `/assets/site.js` de **5.198 bytes**, vanilla |
| Rotas | **23** no `sitemap.xml`; `robots.txt` libera `/` |
| Conteúdo | 6 soluções (`/solucoes/*`), 4+ labs, sobre, tecnologia, contato, privacidade, termos |
| Preços/prazos/cases | **nenhum** publicado (verificado por busca no texto das 11 páginas capturadas) |
| Contato | formulário (Nome, E-mail, WhatsApp, Empresa, Interesse[8], Mensagem, consentimento LGPD) e WhatsApp (85) 99946-2763 |
| Privacidade | LGPD; sem cookies de publicidade e sem analytics |

**Consequência direta:** qualquer plano baseado em React/Next no site estaria
errado. A camada de site foi feita em **vanilla** (`public/site-agent.js`), e a
interface **não foi reescrita** — a Kirana continua sendo a mesma conversa.

### 1.2 O que a Kirana já tinha (v0.4.4, preservado)

| Peça | Onde | Situação na Fase 4 |
| --- | --- | --- |
| Chat + streaming + HITL | `public/app.js`, `src/agent.js`, `src/sse.js` | preservado (340/340 testes da v0.4.4 passando) |
| Voz (reconhecimento, TTS, barge-in, atalhos) | `public/voice*.js`, `src/voice/*` | preservado — `voice-flow 60/60` |
| Orquestração | `src/graph.js` (**LangGraph** 1.5.2) | reaproveitada, sem segundo orquestrador |
| Runtime CopilotKit / AG-UI | `/api/copilot` (`src/copilot/*`) | preservado; agora com agente `kirana` explícito na v2 |
| Gateway de modelos | `src/gateway.js` (porta 1455 do usuário) | **não tocado** |
| Catálogo/interesses/demo | `src/catalog`, `src/interests.js`, `src/video/demo-contact.js` | preservados |

CopilotKit e LangGraph **já existiam**; o que faltava era: conhecimento do site,
contexto de página, ferramentas de site, diretivas para o navegador e a camada v2.

---

## 2. Arquitetura em camadas (uma Kirana, nenhum agente extra)

```
visitante
  │  (clica, pergunta, escolhe)
  ▼
SITE (HTML estático) ──── public/site-agent.js ──── executa só o que o servidor autorizou
  │            ▲                                          (navigate / request_input)
  │            └──────────── site_action (SSE/AG-UI) ────────────┐
  ▼                                                              │
KIRANA (interface residente: chat + voz + cartões)                │
  │  POST /api/chat  {sessionId, message, siteId, path}            │
  ▼                                                              │
CAMADA DE SITE (src/site/context.js)                              │
  │  valida siteId, normaliza caminho, aplica allowlist,          │
  │  resolve página/serviço, carrega conhecimento (BM25)          │
  ▼                                                              │
FERRAMENTAS (src/site/tools.js) — 9 com handlers reais ───────────┘
  │  leitura · navegação · efeito (HITL)
  ▼
LANGGRAPH (src/graph.js) — planeja, chama ferramenta, decide parar
  ▼
GATEWAY (modelo) — credencial só no servidor
```

- **Não há múltiplos agentes.** O mesmo `createAgent` atende chat e site; o
  LangGraph decide o próximo passo; as ferramentas de site são apenas mais
  ferramentas no mesmo registro.
- **Nenhum token/credencial no navegador.** O cliente fala com `/api/*` da
  própria origem; o Gateway (porta local) nunca é exposto.
- **Aprovações** continuam no fluxo HITL da v0.4.4 (ação pendente → confirmação
  explícita → execução), agora também para ações do site.

---

## 3. Base de conhecimento (item 7)

`sites/opportunity-ai/knowledge/` — **14 documentos Markdown** com front matter
(`id`, `title`, `source`, `capturedAt`, `serviceId`, `path`, `tags`), 55 trechos,
~18 KB, todos derivados do conteúdo **real** do site:

`empresa`, `servico-agentes-ia`, `servico-atendimento`, `servico-crm-vendas`,
`servico-automacao`, `servico-relatorios`, `servico-voz`, `labs`,
`tecnologia-e-processo`, `contato-e-privacidade`, `limites-e-faq`, `solucoes`,
`privacidade`, `termos`.

**Recuperação:** `src/knowledge/index.js` — indexação estruturada + **BM25**
(`k1=1.4`, `b=0.7`) com tokenizador sem acento, lista de palavras vazias
normalizada e um radical curto de português (`trabalham` → `trabalho`). Sem
dependência nova, sem serviço pago, sem embedding — decisão registrada: base
pequena, resposta precisa ser **rastreável** (`source` + `capturedAt`), e
ausência de dado deve virar "não publicado", não vizinho semântico.

**Atualização:** `refreshIfStale()` recarrega por `mtime` a cada turno (barato) e
`scripts/site-sync.mjs` compara site publicado × `site.json` × conhecimento,
apontando rota nova, rota removida e página sem documento. O script **não
reescreve** a base: `--write-snapshots` salva o texto bruto em `snapshots/` para
revisão humana. Motivo: conhecimento é o que a Kirana pode afirmar; geração
automática criaria "fato" que ninguém revisou.

---

## 4. Configuração por site (item 8)

`sites/opportunity-ai/site.json`:

| Campo | Valor |
| --- | --- |
| `siteId` / `name` | `opportunity-ai` / Opportunity AI |
| `siteUrl` | `https://opportunity.ia.br` |
| `agentName` | Kirana |
| `knowledgeSource` / `knowledgeDir` | `site-config` / `knowledge` |
| `routes.allowlist` | **23 rotas** do sitemap (`source: sitemap.xml, 2026-10-26`) |
| `pages[]` | **19 páginas** com `id`, `path`, `title`, `summary`, `aliases`, `serviceId` |
| `tools[]` | **9 ferramentas** com `category: read / navigation / sensitive` |
| `permissions` | leitura sim; navegação só na allowlist; efeitos exigem confirmação; `request_file_upload` **negado** com justificativa |
| `allowedOrigins` | origem do site |

Regras aplicadas: `siteId` estrito (site desconhecido → 404/nulo, nada de herdar
o site do vizinho), allowlist **obrigatória** (site sem lista não navega),
caminho normalizado (sem `..`, `%2e`, esquema ou query) e nenhuma execução de
código vindo do visitante.

---

## 5. Ferramentas (item 6) — todas com handler real

| Ferramenta | Categoria | O que faz de verdade |
| --- | --- | --- |
| `get_site_context` | leitura | devolve site, página atual, serviço em foco, nº de rotas e o que **não** está disponível |
| `list_site_pages` | leitura | 19 páginas da config (só caminhos internos) |
| `explain_current_page` | leitura | explica a página onde o visitante está; página fora do catálogo → "não tenho catalogada" |
| `list_services` | leitura | 6 soluções reais com caminho publicado |
| `explain_service` | leitura | situação, proposta, entregáveis, limitações + `source` |
| `navigate_to_page` | navegação | valida e devolve `siteAction {type:'navigate'}` — quem executa é o navegador |
| `open_service_page` | navegação | idem, a partir do `serviceId` |
| `request_user_input` | leitura | devolve `siteAction {type:'request_input'}` com campos saneados; **não envia nada** |
| `show_confirmation` | efeito (HITL) | só roda depois do "aprovar"; devolve `confirmation_granted` e `executado:false` |

`request_file_upload` **não é registrada** (o site não tem endpoint seguro de
upload): a ferramenta informa a limitação em vez de simular envio.

---

## 6. Fluxo demonstrável (item 9)

`test/site-flow.test.js` executa o roteiro completo com servidor real e gateway
simulado:

1. "Quais serviços vocês oferecem?" → `list_services` → 6 frentes reais;
2. visitante escolhe o CRM → `open_service_page` → `site_action navigate /solucoes/crm-vendas`;
3. navegador abre a página e informa `/solucoes/crm-vendas` → `explain_current_page` devolve a página real;
4. "O que preciso enviar para começar?" → `request_user_input` com os campos, sem envio;
5. ação com efeito → `show_confirmation` → **HITL**: sem "aprovar", nada acontece.

Nada de contrato, pedido, pagamento ou envio automático em nenhum passo.

---

## 7. CopilotKit v2 e LangGraph (item 5)

| Camada | Implementação | Prova |
| --- | --- | --- |
| Interface residente (site estático) | `public/app.js` + `public/site-agent.js` (vanilla, sem reescrever o site) | `test/browser/site-flow.mjs` **18/18** |
| Camada v2 (React, para página que seja React) | `widget/src/main-v2.jsx` → `public/widget/kirana-v2.js` | `test/browser/site-v2.mjs` **8/8** |
| Orquestração | `src/graph.js` (LangGraph) — `orchestrator: "langgraph"` no evento `done` | testes de servidor + navegador |

API v2 usada (nada da v1): `CopilotKitCoreReact` + `CopilotKitContext`
(`/v2/context`), `useAgent`, `useAgentContext`, `useFrontendTool`
(`/v2/headless`). Achados registrados:

- a v2 **não** traz provider pronto — o `CopilotKitCoreReact` é instanciado e
  publicado no contexto (feito em `KiranaProvider`);
- `useAgent({ agentId: 'kirana' })` é obrigatório: sem o id, o hook procura
  `default` e falha;
- `GET /api/copilot/info` responde **405** no runtime 1.79.1; o cliente
  sincroniza e conversa mesmo assim (limitação declarada, ver §10);
- `useFrontendTool('navigate_to_page')` no navegador executa **a mesma**
  ferramenta autorizada no servidor: o navegador só aceita caminho da allowlist
  publicada por `/api/site/info`.

---

## 8. Interface residente (item 11)

- **Uma** interface: chat da Kirana, com texto, voz (quando o navegador permite),
  cartões de ação, confirmação/recusa e continuidade entre páginas.
- Ações do site aparecem na conversa: `navigate` vira pill/execução,
  `request_input` vira cartão com os campos e o aviso "nada é enviado
  automaticamente".
- No modo autônomo (interface aberta sem site embutido) a navegação é **exibida**
  como intenção ("Ação do site: abrir …") em vez de redirecionar — a interface
  não é o site.
- Nada de segunda interface de assistente: o widget v2 é a mesma Kirana, outro
  transporte.

---

## 9. Testes (item 12) — 43 testes novos + 2 suítes de navegador

| Arquivo | Testes | Cobre |
| --- | --- | --- |
| `test/site-knowledge.test.js` | 8 | base real, catálogo, ausência de preço/prazo/CNPJ, recuperação, radição, prompt, recarga por mtime |
| `test/site-context.test.js` | 9 | normalização, config validada, isolamento por site, página atual, alias, allowlist, página padrão, cache |
| `test/site-tools.test.js` | 15 | handlers reais, catálogo real, recusa de rota/URL externa, sanitização de campos, HITL, upload declarado ausente, isolamento por site |
| `test/site-flow.test.js` | 7 | fluxo obrigatório, contexto entre páginas, `/api/site/info` sem credencial, `/api/tools`, voz preservada, HITL, ponte do navegador |
| `test/site-sync.test.js` | 4 | sitemap, extração de texto, divergências do conhecimento |
| `test/browser/site-flow.mjs` | 18 verificações | chat real, catálogo, diretiva de navegação, cartão de dados, ponte com pushState, recusas, contexto no servidor |
| `test/browser/site-v2.mjs` | 8 verificações | widget v2 monta, conecta ao runtime, turno real, normalização de caminho |

**Suíte completa:** `node scripts/run-tests.mjs` → **383/383** (340 da v0.4.4 + 43).
**Navegador:** `site-flow 18/18`, `site-v2 8/8`, `demo-flow 15/15`, `voice-flow 60/60`.

Mocks estão **declarados**: `test/helpers.js` (gateway falso com roteiro) e
`scripts/mock-gateway.js` (gateway simulado para os testes de navegador). Nenhum
modelo real é chamado nos testes; a lógica de servidor, DOM, SSE e AG-UI é real.

---

## 10. Limitações declaradas (não são "pronto")

1. **Upload de arquivo não existe.** `request_file_upload` está fora do registro;
   `get_site_context` responde `uploads.disponivel = false` com o motivo. Enviar
   arquivo exigiria endpoint autenticado, antivírus e política de retenção — não
   foi fingido.
2. **O site continua estático.** Não houve reescrita nem deploy. A integração é
   um `<script>` (`site-agent.js`) + a interface da Kirana.
3. **`GET /api/copilot/info` → 405** no runtime CopilotKit 1.79.1 (metadados v2
   não servidos por essa versão). O turno v2 funciona; fica registrado.
4. **Navegação real no site publicado não foi exercitada** — o ambiente do agente
   não tem o site em execução local. O que está provado: a ponte navega de fato
   no navegador (pushState verificado), a allowlist recusa o resto, e o servidor
   valida o caminho.
5. **Voz**: nada mudou na v0.4.4. Seguem pendentes (fora do escopo desta fase): o
   teste real de microfone no Windows e o teste "voice client serves only the
   local UI…" (43/44). **A Fase 4 não foi bloqueada por isso.**
6. **Nada foi publicado em produção.** Sem deploy, sem push. O Gateway local
   nunca foi exposto.
7. **Conhecimento é o que o site publica hoje** (capturado em 26/10/2026). Se o
   site mudar, rode `scripts/site-sync.mjs` e revise antes de atualizar a base.

---

## 11. Como integrar no site publicado (instruções)

### 11.1 Site estático (o caso do opportunity.ia.br)

1. Suba a Kirana com TLS na mesma origem do site (reverso-proxy recomendado):
   ```
   /kirana/*        → Kirana (node src/server.js)
   /api/*           → Kirana
   ```
   Alternativa: subdomínio `kirana.opportunity.ia.br` e `allowedOrigins` no
   `site.json` (já configurado) + CORS explícito.
2. Defina as variáveis do servidor (nunca no HTML): `KIRANA_GATEWAY_URL`,
   `KIRANA_GATEWAY_API_KEY`, `KIRANA_SITE_ID=opportunity-ai`,
   `KIRANA_SITE_URL=https://opportunity.ia.br`, `KIRANA_ACCESS_TOKEN` (se quiser
   exigir token da própria página).
3. Inclua a ponte **antes** do fechamento do `<body>`:
   ```html
   <script type="module" src="/kirana/site-agent.js"></script>
   <script type="module">
     const bridge = window.KiranaSite.bridge;
     await bridge.announce(location.pathname);           // informa a página
     window.addEventListener('popstate', () => bridge.announce());
   </script>
   ```
   Com `data-kirana-spa="true"` no `<html>`, a navegação usa `pushState` (SPA);
   sem o atributo, recarrega a página (site multipágina).
4. Abra a interface residente (a mesma da Kirana) num iframe/painel do site, ou
   incorpore o widget v2 se a página for React (§11.2).
5. `site.json → allowedOrigins` precisa conter a origem do site; qualquer outra
   origem é recusada.

### 11.2 Página React (quando existir)

```jsx
import { mountKiranaV2 } from '/kirana/widget/kirana-v2.js';

useEffect(() => {
  const info = await fetch('/kirana/api/site/info?site=opportunity-ai').then((r) => r.json());
  const host = mountKiranaV2({
    runtimeUrl: '/kirana/api/copilot',
    siteId: 'opportunity-ai',
    allowlist: info.routes,
    initialPath: location.pathname,
  });
  return () => host.remove();
}, []);
```

### 11.3 Checklist antes de publicar

- [ ] `node scripts/doctor.mjs` sem erro
- [ ] `node scripts/run-tests.mjs` 383/383
- [ ] `node scripts/site-sync.mjs --check` sem divergência
- [ ] `KIRANA_ACCESS_TOKEN` definido se a página for pública
- [ ] Gateway acessível **apenas** pelo servidor da Kirana (nunca pelo navegador)
- [ ] `data/` e `.local-state/` fora do versionamento, com backup

---

## 12. Critério de conclusão (item 14)

| Critério | Situação |
| --- | --- |
| Reconhece o site | ✅ `get_site_context` devolve id, nome, URL, agente |
| Conhece páginas e serviços | ✅ 19 páginas, 6 soluções, do conteúdo real |
| Explica informações reais | ✅ com `source`/`capturedAt`; sem preço inventado |
| Navega por ferramenta | ✅ `navigate`/`open_service_page` → diretiva → navegador |
| Pede dados | ✅ `request_user_input` com aviso de que nada é enviado |
| Mantém contexto entre páginas | ✅ `session.siteState` + `/api/site/context` |
| Executa só ações autorizadas | ✅ allowlist obrigatória + HITL para efeitos |
| Continua como chat + voz | ✅ 340/340 da v0.4.4 e `voice-flow 60/60` |

**Pendências que não são desta fase:** microfone real no Windows, teste 43/44,
`/api/copilot/info` 405 e upload de arquivos.
