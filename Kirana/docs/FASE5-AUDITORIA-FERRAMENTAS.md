# Kirana Fase 5 — auditoria das ferramentas (24 registradas)

**Versão:** 0.5.1 · **Base:** v0.5.0 (`ead823b`) · **Data:** 26/10/2026
**Alvo:** `https://opportunity.ia.br` · **Agente:** Kirana

Este documento cumpre os itens 3, 4 e 5 do briefing da Fase 5: **inventário
completo**, **diagnóstico das lacunas** e **o que foi implementado**. Nada aqui
foi presumido: cada linha foi lida no código e conferida nos testes.

Regra que vale para a tabela inteira: **ferramenta registrada não é sinônimo de
funcional**. A coluna *Estado* diz, ferramenta por ferramenta, o que realmente
executa, o que depende de configuração e o que é apenas leitura.

---

## 1. Como o registro central funciona

| Elemento | Onde | O que garante |
| --- | --- | --- |
| Registro | `src/tools/registry.js` | Só executa ferramenta **registrada**; nome desconhecido vira erro `unknown_tool`, nunca improviso |
| Definições core | `src/tools/definitions.js` | 7 ferramentas internas (catálogo, memória, interesse comercial) |
| Ferramentas de site | `src/site/tools.js` | 9 ferramentas da Fase 4 (contexto, navegação, explicação, coleta) |
| Ferramentas operacionais | `src/site/request-tools.js` | **8 ferramentas novas** da Fase 5 (executar a solicitação) |
| Permissões do site | `sites/opportunity-ai/site.json` | `permissions.read/navigation/effects` + `denied`; o servidor só habilita o que está declarado |
| Validação | `registry.validate` + schema `additionalProperties: false` | O **servidor** revalida todo argumento, mesmo que a interface já tenha validado |
| HITL | `src/agent.js` (`createPendingAction`, `resolveConfirmation`) | Toda ferramenta `kind: 'write'` fica pendente com `actionId` até `approve` explícito |
| Resultado estruturado | `runReadTool` / `resolveConfirmation` | Leitura devolve `data` quando `expose: true`; **escrita nunca devolve `data`** (só status) |
| Erros | `mapError`, `errorCode` no evento `tool_result` | Falha é sempre declarada: nada de "sucesso" inventado |
| Identificador de execução | `actionId` (`act_xxxxxxxx`) + `requestId` (`REQ-AAAA-XXXXXX`) | Toda ação sensível e toda solicitação têm identificador rastreável |

**Nenhuma ferramenta é chamada fora do registro.** O grafo
(`src/graph.js`, nó `tools`) só executa o que veio numa `tool_call` do modelo e
existe no registry; nome inventado é recusado antes de qualquer efeito.

---

## 2. Inventário — as 24 ferramentas

Legenda de **Permissão**: `leitura` = nada sai do servidor; `navegação` = diretiva
para o navegador (URL da allowlist); `escrita` = exige HITL. **Estado**:
`funcional` = executa de verdade; `parcial` = executa com condição declarada;
`não implementada` = registrada apenas como limitação explícita.

### 2.1 Ferramentas internas (7) — `src/tools/definitions.js`

| Nome | Finalidade | Handler | Entrada | Saída | Permissão | Estado | Teste | Dependência |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `consultar_servicos` | Consultar catálogo interno | `definitions.consultar_servicos` | `{consulta}` | `{servicos[]}` | leitura | funcional | `tools.test.js` | `data/catalog` |
| `consultar_produtos` | Consultar produtos | idem | `{consulta}` | `{produtos[]}` | leitura | funcional | `tools.test.js` | catálogo |
| `consultar_status_projeto` | Status de projeto | idem | `{projeto}` | `{status}` | leitura | **parcial** (dados de demonstração, não é backend real) | `tools.test.js` | nenhuma |
| `consultar_memoria` | Ler memória do visitante | idem | `{}` | `{itens[]}` | leitura | funcional | `memory.test.js` | `data/memory` |
| `registrar_interesse_comercial` | Registrar interesse | idem | `{nome, canal_tipo, canal_valor, interesse, mensagem, consentimento}` | `{protocolo}` | **escrita** (HITL) | funcional (grava localmente) | `tools.test.js`, `demo-flow.mjs` | `data/interests` |
| `salvar_memoria` | Gravar memória | idem | `{chave, valor}` | `{salvo}` | escrita (HITL) | funcional | `memory.test.js` | `data/memory` |
| `apagar_memoria` | Apagar memória | idem | `{chave}` | `{apagado}` | escrita (HITL) | funcional | `memory.test.js` | `data/memory` |

### 2.2 Ferramentas de site (9) — `src/site/tools.js` (Fase 4, preservadas)

| Nome | Finalidade | Handler | Entrada | Saída | Permissão | Estado | Teste | Dependência |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `get_site_context` | Identidade, página atual, o que não existe | `site.tools` | `{}` | `{site, paginaAtual, uploads, solicitacao, …}` | leitura | funcional | `site-tools.test.js` | `site.json` |
| `list_site_pages` | Listar páginas conhecidas | idem | `{}` | `{paginas[]}` | leitura | funcional | `site-tools.test.js` | `site.json` |
| `explain_current_page` | Explicar a página aberta | idem | `{}` | `{pagina, conhecida}` | leitura | funcional | `site-tools.test.js` | `knowledge/` |
| `list_services` | Listar as 6 soluções | idem | `{}` | `{servicos[]}` | leitura | funcional | `site-tools.test.js` | `knowledge/` |
| `explain_service` | Explicar uma solução | idem | `{serviceId}` | `{resumo, entregaveis, limitacoes}` | leitura | funcional | `site-tools.test.js` | `knowledge/` |
| `request_user_input` | Pedir dados ao visitante | idem | `{motivo, campos[]}` | `{siteAction{request_input}}` | leitura | funcional — **Fase 5**: coleta progressiva (filtra o que já foi informado) | `site-tools.test.js` | `requirements.json` |
| `navigate_to_page` | Navegar por rota da allowlist | idem | `{path}` | `{siteAction{navigate}}` | **navegação** | funcional | `site-flow.mjs` | `routes.allowlist` |
| `open_service_page` | Abrir página de uma solução | idem | `{serviceId}` | `{siteAction{navigate}}` | navegação | funcional | `site-flow.mjs` | `knowledge/` |
| `show_confirmation` | Pedir confirmação (HITL) | idem | `{acao, resumo}` | `{status:'aguardando_confirmacao'}` | leitura (prepara HITL) | funcional | `site-flow.test.js` | `agent.js` |

### 2.3 Ferramentas operacionais (8, novas) — `src/site/request-tools.js`

| Nome | Finalidade | Handler | Entrada | Saída | Permissão | Estado | Teste | Dependência |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `get_service_requirements` | Requisitos reais do serviço | `request-tools` | `{serviceId}` | `{requisitosPublicados, campos[], upload, aviso}` | leitura | funcional — **declara** que o site não publica requisitos | `request-tools.test.js` | `requirements.json` |
| `start_service_request` | Criar/retomar rascunho | idem | `{serviceId, dados?}` | `{solicitacao, retomada, enviado:false}` | leitura (estado local da sessão) | funcional | `requests-store.test.js`, `requests-http.test.js` | `src/requests/store.js` |
| `fill_site_form` | Preencher o formulário real | idem | `{form, requestId?}` | `{siteAction{fill_form, fields[]}, enviado:false}` | navegação (ação registrada) | funcional — **nunca envia** | `site-v5.mjs` (DOM real) | `site.json.forms.contato` |
| `request_file_upload` | Pedir arquivo ao visitante | idem | `{motivo, requestId?}` | `{siteAction{request_upload, accept, maxMb, maxFiles}}` | navegação | funcional — upload real, **arquivo nunca executado** | `requests-validation.test.js`, `site-v5.mjs` | `site.json.uploads` |
| `validate_service_request` | Validar dados coletados | idem | `{requestId?}` | `{completo, camposValidos, camposAusentes, erros, proximaAcao, proximoCampo, faltando}` | leitura | funcional | `request-tools.test.js` | `requirements.json` |
| `submit_service_request` | Enviar a solicitação | idem | `{requestId}` | `{enviado, protocolo?, estado}` ou `{enviado:false, motivo:'endpoint_nao_configurado'}` | **escrita** (HITL) | **parcial**: sem endpoint autorizado **não envia** e diz por quê | `requests-http.test.js` | `site.json.endpoints.submitRequest` |
| `get_request_status` | Andamento real | idem | `{requestId?}` | `{solicitacao, faltando, proximaAcao, envioDisponivel, historico}` | leitura | funcional — **não estima** prazo nem andamento | `request-tools.test.js` | store |
| `cancel_service_request` | Cancelar e descartar | idem | `{requestId?, motivo?}` | `{cancelada:true, estado, mensagem}` | **escrita** (HITL) | funcional para rascunho; enviada exigiria backend real (não existe) | `request-tools.test.js`, `site-v5.mjs` | store + `fileStore` |

**Total declarado em `site.json.tools`:** 17 (as 9 de site + as 8 operacionais).
As 7 internas vêm do registry core. O modelo recebe exatamente as ferramentas
habilitadas no turno — nem uma a mais.

---

## 3. Diagnóstico de lacunas (o que faltava na v0.5.0)

| Lacuna encontrada | Evidência | O que foi feito na v0.5.1 |
| --- | --- | --- |
| Nenhuma ferramenta criava estado de pedido | `site.json` só tinha ferramentas de leitura/navegação | `start_service_request` + `src/requests/store.js` com máquina de estados |
| Requisitos não existiam em lugar nenhum | busca em `sites/opportunity-ai/` não achava lista de requisitos | `requirements.json` com `requisitosPublicados.disponivel:false` + motivo/fonte |
| Upload estava **negado** | `permissions.denied` incluía upload com justificativa | upload habilitado com política (`5 MB`, 5 arquivos, 30 dias) e validação de assinatura |
| Nada preenchia o formulário do site | ponte só tratava `navigate` e `request_input` | `fill_site_form` + `site-action` `fill_form` na ponte (`data-kirana-field`/seletores do `site.json`) |
| Não havia como enviar nada | nenhum endpoint de envio | `submit_service_request` com `endpoints.submitRequest: null` → **não envia** até existir backend autorizado |
| Nenhum acompanhamento do pedido | sessão guardava conversa, não tarefa | `get_request_status` + `GET /api/requests` e `GET /api/requests/:id` |
| Sem cancelamento | — | `cancel_service_request` (HITL) descarta dados e arquivos |
| Estado da tarefa não sobrevivia à navegação | nada persistia pedido | nó `task` no grafo (`taskState`) + JSON por solicitação em `data/requests` |

**Lacuna que permanece (declarada):** não existe backend de recebimento de
solicitações na Opportunity AI. Sem `endpoints.submitRequest` configurado, a
Kirana **não envia** — mantém o rascunho e informa o canal oficial (`/contato`
ou WhatsApp). Isso está testado (`requests-http.test.js`).

---

## 4. O que **não** foi feito (e por quê)

- **Nada foi publicado no site.** O site é de terceiro; publicar widget ou
  endpoint depende de autorização do responsável.
- **Nenhum preço, prazo, plano ou contrato** foi escrito em ferramenta alguma.
- **Nenhum arquivo do visitante é executado.** Não há `eval`, `spawn`, nem
  leitura de conteúdo para "processar" o arquivo: ele é guardado e listado.
- **Nenhuma segunda janela de assistente** foi criada: as ferramentas novas
  usam a mesma conversa, a mesma ponte `public/site-agent.js` e o mesmo HITL.
