# REVISÃO 3 — três falhas funcionais, corrigidas

Data: 29/10/2026
Base: `Kirana-v0.5.4-REV2-com-Gateway-v0.4.1-Windows.zip`
SHA-256 `da6d721af8f0899190c32b691e738319cd68fabb505d5fc081e0a39c0870023f` (conferido na extração).

Versões mantidas de propósito: **Kirana 0.5.4** e **Gateway 0.4.1**. Nada foi reconstruído:
instalação idempotente, chave local automática, RNG de PowerShell 5.1, proteção de PID/processos,
tratamento SSE do Gateway, ferramentas, RAG e Tailscale privado continuam como estavam.

---

## Resumo

| # | Defeito | Arquivo | Antes | Depois |
|---|---|---|---|---|
| A | stream cortado entregue como concluído | `Kirana/src/gateway.js` | `if (frame.done) break` e, no fim, `finishReason: 'stop'` inventado | `[DONE]` é rastreado; sem marcador terminal → `stream_interrupted` |
| B | 401/403 sempre como "autorize a conta" | `Kirana/src/gateway.js` | `status === 401 \|\| 403` → `gateway_auth` | classificação por `error.code`: `unauthorized` / `gateway_auth` / `gateway_auth_unknown` |
| C | falha de descoberta presa 5 minutos | `Kirana/src/agent.js` | falha gravada com o mesmo TTL do sucesso | falha com janela de 3 s + reconsulta imediata em erro de autorização |

Arquivos novos: `Kirana/src/model-cache.js` (política de cache), `Kirana/src/model-resolver.js`
(descoberta + cache, testável sem `@langchain`), `tools/teste-revisao3.mjs` (41 testes), este doc.

---

## A. Stream cortado não é resposta concluída

**Causa-raiz.** O laço de leitura fazia `if (frame.done) break` e nada registrava que o
`[DONE]` chegou. No fim, o retorno montava
`finishReason: finishReason || (toolCalls.length ? 'tool_calls' : 'stop')`.
Se a conexão fechasse no meio (texto parcial + EOF), o `||` fabricava `'stop'` — e quem
consumia recebia um recorte de resposta como se estivesse completo.

**Contrato usado.** O Gateway v0.4.1 fecha o stream de sucesso assim
(`Gateway/src/responses.js`, linhas 140–143): chunk com `finish_reason`, depois
`data: [DONE]` e `res.end()`. Ou seja, o marcador terminal **sempre** chega no caminho feliz.

**Correção.**

```js
if (frame.done) { receivedDone = true; break; }
...
if (caminho === 'sse' && !receivedDone) {
  if (signal?.aborted || controller.signal.aborted) throw normalizeAbort(...);  // 'aborted'
  throw new GatewayError(`Stream terminou sem o marcador [DONE] (...) após N caracteres.`, {
    code: 'stream_interrupted',
    retryable: !emittedAnything && !finishReason,
  });
}
```

Detalhes que importam:

- **cancelamento intencional** (`signal` do usuário) continua sendo `aborted`, nunca
  `stream_interrupted` — a checagem precede o erro;
- **retryable** só é verdadeiro se nada foi emitido: depois de texto parcial, a Kirana não
  tenta de novo sozinha (não duplica texto nem repete ferramenta);
- o retorno agora carrega `finishReasonDeclarado` e `terminalMarker` (`'done'` | `'json'`), para
  que "stop deduzido" e "stop declarado" não sejam a mesma coisa;
- caminho **JSON** (sem SSE) não mudou.

`Kirana/src/sse.js` não precisou mudar: ele já devolvia `{done:true}` — o que faltava era
**usar** essa informação.

---

## B. 401/403 pela causa real

**Causa-raiz.** `chatStream()` e `fetchJson()` mapeavam todo 401/403 para `gateway_auth`
("autorize a conta"). Mas o Gateway usa 401 para duas coisas opostas:

| Resposta do Gateway | Significado | Para onde a pessoa deve ir |
|---|---|---|
| `401 { error.code: "invalid_api_key" }` | Bearer **local** errado/ausente | alinhar `.env` (`INSTALAR-WINDOWS.cmd`) |
| `401 { error.code: "authentication_required" }` | Bearer ok, falta **SIWC** | `http://127.0.0.1:1455/auth/start` |

O campo `type` é `authentication_error` nos **dois** casos — não serve para separar.

**Correção.** `classificarErroHttp(status, payload)` (exportada, em `gateway.js`):

| status | `error.code` | código resultante |
|---|---|---|
| 401/403 | `invalid_api_key`, `invalid_bearer`, `missing_api_key`, `unauthorized_key`, `gateway_key_invalid` | `unauthorized` |
| 401/403 | `authentication_required`, `sign_in_required`, `auth_required`, `not_authenticated`, `auth_in_progress`, `sharing_disabled` | `gateway_auth` |
| 401/403 | ausente ou desconhecido | **`gateway_auth_unknown`** (não conclusivo) |
| 429 | qualquer | `rate_limited` |
| 5xx | qualquer | `gateway_http` |
| outros 4xx | — | `gateway_http` |

Aplicada nos **dois** caminhos (`chatStream` e `fetchJson`, então também em `/v1/models`).
Mensagem nova em `errors.js` para o caso não conclusivo:

> "O Gateway recusou a requisição (401/403) e não disse o motivo de forma reconhecível. Isso pode
> ser a chave local … ou a autorização da conta — **não vou adivinhar qual**. Rode
> `node tools\diagnosticar-modelos.mjs`, que separa as duas causas."

O texto cru do upstream continua fora da interface: ele vai para `details`/`detail`
(sanitizado, ≤ 200 caracteres).

**Consequência em dois testes existentes.** `test/gateway.test.js` e `test/server.test.js`
esperavam `gateway_auth` para um 401 **sem** `code`. Com a regra nova esse caso é
`gateway_auth_unknown` (exatamente o que a revisão pediu: não adivinhar). As duas asserções foram
atualizadas — os dois casos **com** código estão cobertos em `tools/teste-revisao3.mjs` (B10–B17).

---

## C. Falha de descoberta não fica presa no cache

**Causa-raiz.** `resolveActiveModel()`:

```js
if (modelCache.value && Date.now() - modelCache.at < 5 * 60_000) return modelCache.value;
...
} catch (error) { ... modelCache = { at: Date.now(), value }; }
```

A falha entrava no **mesmo** cache de 5 minutos do sucesso. Sequência real: abrir a Kirana sem
SIWC → descoberta falha → autorizar no navegador → as próximas mensagens continuam até 5 minutos
usando o resultado da falha, tentando o modelo primário antigo.

**Correção.** A política saiu para `Kirana/src/model-cache.js` e a descoberta para
`Kirana/src/model-resolver.js` (módulo sem `@langchain`, portanto testável de verdade):

| Situação | Janela | Por quê |
|---|---|---|
| catálogo obtido | 5 min | catálogo não muda a cada turno; evita consulta por turno |
| descoberta falhou | **3 s** | freio contra rajada, não cache |
| turno terminou com erro de autorização | **0 s** (reconsulta imediata) | quem sabe que a autorização mudou é o erro, não o relógio |

```js
function notarErroDeTurno(code) {
  if (!ehErroDeAutorizacao(code)) return false;
  forcarReconsulta = true;   // gateway_auth, unauthorized, gateway_auth_unknown, ...
}
```

O `callModel` chama `notarErroDeTurno(error.code)` no `catch`. Logs novos: quando o cache expira
(`Cache de modelos expirado…`), quando a falha é descartada por erro de autorização
(`… reconsultando agora`) e quando a descoberta volta a funcionar
(`Catálogo obtido depois de uma falha: cache de modelos restabelecido`).

`invalidateModelCache()` continua existindo (agora com motivo e sem apagar cache válido à toa).

---

## Testes

Novo: `node tools\teste-revisao3.mjs` — **41 testes**, um bloco por defeito.

| Bloco | Casos |
|---|---|
| A (12) | texto parcial+EOF · texto+finish_reason+EOF · stream vazio · completo com `[DONE]` · `[DONE]` sem `finish_reason` · ferramenta+`[DONE]` · ferramenta sem `[DONE]` · erro SSE antes do fim · cancelamento do usuário · sem duplicação de texto · caminho JSON · conexão liberada após `[DONE]` |
| B (17) | matriz status×código · `type` não decide · chat 401 local · chat 401 SIWC · chat 403 sem código · chat 429 · chat 503 · `/v1/models` 401 local · `/v1/models` 401 SIWC · três textos distintos |
| C (12) | TTLs · freio de rajada · catálogo em cache · reconsulta por erro de autorização · só erros de autorização disparam · sequência falha→autorização→catálogo real · expiração curta sem gatilho · cache válido não é reconsultado · invalidação · `probe=false` · ligação verificada no código |

Contagens completas desta rodada estão em `docs/TESTES-E-EVIDENCIAS.md`.

---

## Teste de integração (ponta a ponta, com servidor real)

Além dos testes de unidade, entrou `Kirana/test/revisao3-integracao.test.js` — **6 testes** que
sobem a Kirana de verdade (`test/helpers.js`) contra um Gateway falso em `127.0.0.1` que responde
SSE e HTTP exatamente como o v0.4.1:

| Teste | O que prova |
|---|---|
| 1 | stream cortado → evento `error` com `code: "stream_interrupted"` e **nenhum** evento de conclusão |
| 2 | texto + `finish_reason` + `[DONE]` → conclui normalmente |
| 3 | 401 com `invalid_api_key` → `unauthorized` (não manda autorizar a conta) |
| 4 | 401 com `authentication_required` → `gateway_auth` (manda abrir `/auth/start`) |
| 5 | 403 sem `code` → `gateway_auth_unknown`, sem vazar texto do upstream |
| 6 | descoberta falha → autorização → **próxima mensagem** já reconsulta e usa modelo do catálogo |

O teste 6 confere o modelo **efetivamente pedido** ao Gateway (não o `/health`): antes de autorizar
a Kirana pede o configurado `gpt-6-luna`; depois de autorizar passa a pedir `gpt-5`, anunciado pelo
catálogo falso. É a sequência exata que antes ficava 5 minutos no cache de falha.

## Defeito extra encontrado na validação (fora da lista A/B/C)

Rodando `INICIAR-TUDO.cmd` duas vezes na pasta extraída, a segunda execução **recusou** o próprio
processo: "porta 3000 ocupada e NAO foi possivel provar que o processo e desta instalacao".

Causa: `Get-EstadoPorta` (`scripts/Comum.ps1`) usava a **primeira** linha do `ss -ltnp` da porta —
e a mesma porta aparece em mais de uma interface, uma delas **sem** `pid=`. Sem PID, a prova de
propriedade falha e o serviço legítimo é recusado.

Correção: percorrer todas as linhas (no `ss` e no `netstat`) e usar a que traz o PID. O
comportamento **fail-closed continua idêntico** — se nenhuma linha identifica o dono, nada é
encerrado nem reaproveitado. Depois do patch, execuções seguidas dizem
"propriedade comprovada (PID …). Nada a fazer." e continuam exatamente 2 processos.

Isso é regressão direta do escopo (subir/parar duas vezes é o uso normal da entrega), por isso
entrou; nada mais em `scripts/` foi tocado.
