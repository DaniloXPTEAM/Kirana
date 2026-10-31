# Kirana Fase 5 — relatório de segurança

**Versão:** 0.5.1 · **Data:** 26/10/2026 · **Escopo:** execução de solicitações,
upload de arquivos, novas rotas HTTP e ponte do navegador.

Relatório do que foi **verificado em código e em teste**. Onde não há teste
automatizado, está escrito "revisão manual".

---

## 1. Superfície nova

| Superfície | Risco avaliado | Mitigação implementada | Prova |
| --- | --- | --- | --- |
| `POST /api/requests/:id/files` | arquivo malicioso, escrita fora da pasta, DoS por tamanho | validação de extensão/MIME/assinatura, limite 5 MB, base64 limitado, `0o600`, pasta por solicitação | `requests-http.test.js` #2, `requests-validation.test.js` #8–#10 |
| `DELETE /api/requests/:id/files/:fileId` | apagar arquivo de outra pessoa | `sessionId` obrigatório + `store.removeFile` confere o dono | `requests-http.test.js` #2 |
| `GET /api/requests` | enumeração de solicitações | 400 sem sessão válida; lista filtrada pelo dono | `requests-http.test.js` #1 |
| `GET /api/requests/:id` | leitura por ID sequencial | ids aleatórios (`REQ-AAAA-XXXXXX`) + conferência de dono (404) | `requests-http.test.js` #1 |
| `fill_site_form` (ponte) | injeção via seletor/valor | seletores vêm do `site.json`, filtro de CSS simples, só campos de formulário, sem `submit()` | `site-v5.mjs` (DOM real) |
| `request_file_upload` (ponte) | execução de arquivo | escolha sempre do visitante; arquivo nunca é aberto/executado | `site-v5.mjs` |
| `submit_service_request` | envio sem autorização | `kind:'write'` + HITL + validação de estado + endpoint autorizado | `requests-http.test.js` #3 |

---

## 2. Isolamento por sessão

- `sessionId` no formato `s_<uuid>`; qualquer outro valor é recusado
  (`isSessionId`). Rotas devolvem **400** para sessão inválida e **404** para
  solicitação de outra sessão — não há diferença entre "não existe" e "não é
  sua", então não há oráculo de existência.
- O store nunca aceita `get(id)` sem sessão: a assinatura exige `sessionId`.
- Testes dedicados: `requests-store.test.js` #3 e #11,
  `request-tools.test.js` #4 e #8, `requests-http.test.js` #1 e #2.

## 3. Segredos

- Nenhuma ferramenta devolve token, chave, caminho de disco ou `sessionId`
  (`request-tools.test.js` #19 verifica por regex em todas as saídas expostas).
- O token do endpoint de envio (`KIRANA_REQUEST_TOKEN`) fica **só no servidor**,
  no cabeçalho da requisição de saída; nunca vai para o navegador.
- Logs registram `requestId`, `code` e contagem — nunca conteúdo de formulário
  nem nome de arquivo do visitante nos níveis de aviso.

## 4. Ações sensíveis (HITL)

| Ação | Classificação | Confirmação |
| --- | --- | --- |
| `submit_service_request` | escrita | obrigatória, com resumo (`summarize`) e `actionId` |
| `cancel_service_request` | escrita | obrigatória (descartar dados é irreversível) |
| `start_service_request`, `fill_site_form`, `request_file_upload`, `validate…`, `get_…` | leitura/estado local | não exigem HITL — não saem do servidor |

- Recusar (`approve:false`) **não executa** a ferramenta (`resolved:'declined'`).
- `actionId` desconhecido não executa nada (`requests-http.test.js` #3).
- A confirmação expira (`confirmationTtlMs`) e vale para **uma** execução.
- Voz não contorna o HITL: a confirmação continua sendo um clique/botão na tela.

## 5. Limites e abuso

| Controle | Valor |
| --- | --- |
| Tamanho de corpo | `config.maxBodyBytes`; upload até `5 MB × 2 + 64 KB` (base64) |
| Arquivos por solicitação | 5 |
| Tipos | allowlist de 9 extensões; 21 extensões bloqueadas explicitamente |
| Requisições | `checkRate` geral + `checkRequestRate` nas rotas de solicitação |
| Solicitações ativas por sessão | 1 (`request_already_active`) |
| Retenção de arquivo | 30 dias (`expiresAt` + `purgeExpired`) |
| Histórico | 60 entradas por solicitação |

## 6. Origem e CORS

- `assertSameOrigin` nas rotas que mudam estado (upload/delete/confirmar).
- `allowedOrigins` do `site.json` continua valendo para o contexto do site.
- Nenhuma rota nova aceita `*`.

## 7. Gateway e infraestrutura

- O **Gateway local (1455) não foi alterado nem exposto**. As novas rotas não
  falam com o gateway; só o agente fala, e continua falando com o mesmo
  endereço configurado.
- Nenhuma dependência nova foi instalada e **nenhum serviço pago** foi
  contratado.
- O arquivo do visitante **não é executado** por nenhum processo: não há
  `child_process`, `eval`, `new Function` nem desserialização no caminho do
  upload (revisão manual em `src/requests/files.js` e `public/site-agent.js`).

## 8. Riscos residuais (aceitos e declarados)

1. **Sem antivírus/varredura de conteúdo.** Mitigação: allowlist, assinatura,
   tamanho, retenção curta e não execução. Um PDF malicioso guardado só é
   perigoso se alguém o baixar e abrir fora da Kirana.
2. **Sem backend real de recebimento:** o risco de exposição indevida de dados é
   hoje **menor** (nada sai), mas o serviço também não conclui pedidos.
3. **Formulário do site sem `id` estável em `input.site`:** o mapeamento usa
   `#id`/`[name]`; se o site mudar o HTML, o preenchimento falha de forma
   visível (`not_found`), não em silêncio.
4. **Sandbox de desenvolvimento:** `KIRANA_ACCESS_TOKEN` vazio é aceitável só em
   `127.0.0.1`. Para publicar, é obrigatório definir token, TLS e proxy.
