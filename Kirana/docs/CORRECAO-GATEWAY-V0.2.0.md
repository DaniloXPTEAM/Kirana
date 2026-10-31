# Correção: incompatibilidade de payload com o Gateway v0.2.0

**Versão:** Kirana 0.1.0 → **0.1.1**
**Data:** 24/10/2026
**Origem:** falha reproduzida no Windows do proprietário
**Gateway:** Kirana ChatGPT Gateway v0.2.0 — **não foi alterado**

---

## 1. Sintoma

A Kirana autenticava e consultava `/health` e `/v1/models` normalmente, mas toda mensagem
falhava ao enviar para `/v1/chat/completions`:

```text
Kirana:  Unsupported request field: temperature.
         This gateway only forwards validated ChatGPT-plan-compatible fields.
Gateway: unsupported_parameter · HTTP 400
```

## 2. Causa raiz

O corpo da requisição era montado **inline** em `src/gateway.js`:

```js
const body = {
  model,
  messages,
  stream: true,
  temperature: temperature ?? config.agent.temperature,   // ← campo recusado
};
if (effectiveMax > 0) body.max_tokens = effectiveMax;     // ← também fora do contrato
if (tools?.length) {
  body.tools = tools;
  body.tool_choice = toolChoice;                          // ← também fora do contrato
  body.parallel_tool_calls = false;                       // ← também fora do contrato
}
```

O Gateway v0.2.0 valida o payload contra um subconjunto **"ChatGPT-plan-compatible"** e rejeita
qualquer campo fora dele. Os quatro campos acima estavam fora do contrato — `temperature` apenas
foi o primeiro a ser reclamado, porque era o primeiro na validação.

Além disso, havia um problema secundário: as mensagens eram enviadas com **chaves internas da
Kirana** (`id`, `at`, `model`, `ttftMs`, `aborted`, `usage`, `toolCalls` em camelCase) e com
`content: null` em mensagens que só continham chamada de ferramenta. Nada disso faz parte do
formato OpenAI e aumenta o risco de rejeição.

## 3. Correção aplicada

### 3.1 Novo módulo `src/payload.js` (único ponto de montagem)

- **Allowlist explícita:** `model`, `messages`, `stream`, `tools`, `tool_choice`, `temperature`,
  `max_tokens`. Nada mais pode entrar.
- **Sempre enviado:** `model`, `messages`, `stream: true`.
- **Condicional:** `tools` (só quando a rodada tem ferramentas).
- **Nunca enviado por padrão:** `temperature`, `max_tokens`, `tool_choice`.
- **Nunca enviado em nenhuma hipótese:** `parallel_tool_calls`, `top_p`, `presence_penalty`,
  `frequency_penalty`, `seed`, `stop`, `response_format`, `n`, `logprobs`…
- `assertAllowedFields()` falha **no backend** se algum campo fora da allowlist escapar — erro
  local, não no gateway do usuário.
- `sanitizeMessage()` normaliza cada mensagem: remove chaves internas, garante `content` string
  (nunca `null`), converte `toolCalls` interno → `tool_calls` OpenAI e `toolCallId` →
  `tool_call_id`, sem recodificar argumentos já serializados.

### 3.2 `src/gateway.js`

- Passa a usar `buildChatPayload()`; não monta mais payload inline.
- **Recuperação automática:** se o gateway responder 400 `unsupported_parameter`, o cliente
  identifica o campo reclamado (`extractUnsupportedField`, que entende o texto do v0.2.0 e o
  formato estruturado), **remove o campo e repete a requisição uma única vez** — sempre antes de
  qualquer token, portanto sem risco de duplicar texto, ferramentas ou ações.
- Limite de 2 remoções por requisição; fora disso, erro claro `unsupported_parameter`.
- Expõe `payloadFields` e `strippedFields` no resultado (observabilidade).

### 3.3 `src/config.js` e `.env.example`

Novos campos opt-in, **todos `false` por padrão**:

```env
KIRANA_SEND_TEMPERATURE=false
KIRANA_SEND_MAX_TOKENS=false
KIRANA_SEND_TOOL_CHOICE=false
```

`KIRANA_TEMPERATURE` e `KIRANA_MAX_TOKENS` continuam existindo, mas só têm efeito se o campo
correspondente for habilitado.

### 3.4 `scripts/mock-gateway.js` (modo demonstração)

Passou a **rejeitar campos fora do contrato exatamente como o gateway real**, com a mesma
mensagem e o mesmo HTTP 400. Assim a regressão aparece no modo demonstração, sem precisar do
Windows. Pode ser desativado com `--strict=false`.

### 3.5 Mensagem de erro para o usuário (`src/agent.js`)

`unsupported_parameter` agora tem tradução própria: explica que o gateway recusou um campo, que o
backend já tentou remover automaticamente e que, se persistir, é caso de rodar `diagnostico.bat`.

## 4. O que foi preservado

- Streaming SSE e decodificação de fragmentos.
- Ferramentas: 4 de leitura + 3 de escrita com confirmação obrigatória.
- Contexto, sessões, histórico e reparo de contexto.
- Memória persistente com consentimento.
- Fallback Luna → Sol (continua proibido após emissão de token/ferramenta).
- Segurança: chave só no backend, redação de logs, mesma origem, CSP, rate limit.
- O gateway original não foi tocado: a correção é 100% no cliente da Kirana.

## 5. Testes

```text
node --test test/
# tests 84 · pass 84 · fail 0 · duration_ms ≈ 917
```

Antes: 67 testes. Agora: **84** (+17).

### Novos testes que travam o defeito

| Teste | Garante |
|---|---|
| `payload padrão NÃO contém temperature` | regressão exata do HTTP 400 |
| `payload padrão contém apenas model, messages e stream` | contrato mínimo |
| `payload padrão não envia max_tokens, tool_choice nem parallel_tool_calls` | os outros três campos fora do contrato |
| `todos os campos do payload pertencem à allowlist` | nenhuma chave desconhecida escapa |
| `assertAllowedFields barra campo fora do contrato` | falha local antes do gateway |
| `sanitizeMessage remove chaves internas e nunca envia content null` | formato OpenAI limpo |
| `sanitizeMessage converte mensagem de ferramenta` | `tool_call_id` correto |
| `extractUnsupportedField reconhece o erro real do v0.2.0` | parsing da mensagem literal |
| `recuperação automática: gateway rejeita campo, cliente remove e repete` | 2 requisições: 1ª com `temperature`, 2ª sem |
| `nenhum payload enviado contém temperature` (integração) | verificado **no gateway** que recebeu a requisição |
| `campos internos da sessão não vazam` (integração) | só `role`/`content` chegam |

Além disso, o teste de contexto passou a verificar o payload **inteiro** em todas as requisições:
apenas `model`, `messages`, `stream` e `tools` podem aparecer.

### Dois defeitos encontrados pelos próprios testes novos

1. `sanitizeMessage` não reconhecia `toolCalls` (camelCase interno) — corrigido para aceitar os
   dois formatos.
2. Argumentos de ferramenta já serializados eram **codificados duas vezes**
   (`"\"{\\\"consulta\\\":...}\""`). Corrigido com resolução única de `rawArgs`. Esse bug afetaria
   a leitura de argumentos em produção.

## 6. Reprodução do erro e da correção (evidência local)

Com o gateway simulado em modo estrito (mesmo contrato do v0.2.0):

```console
# 1. Requisição COM temperature — reproduz o erro do usuário
$ curl -X POST http://127.0.0.1:1455/v1/chat/completions ... -d '{... "temperature":0.6}'
{"error":{"code":"unsupported_parameter","message":"Unsupported request field: temperature. This gateway only forwards validated ChatGPT-plan-compatible fields."}}
HTTP 400

# 2. Mesma requisição sem temperature
HTTP 200

# 3. Kirana com o payload corrigido, pelo gateway estrito
tool_start consultar_servicos → tool_result ok:true
done {"model":"gpt-6-luna","fallbackUsed":false,"ttftMs":29,"totalMs":1569,"rounds":2,"toolCalls":1}

# 4. Cenário de recuperação (KIRANA_SEND_TEMPERATURE=true de propósito)
[gateway] Gateway rejeitou campo; removendo e repetindo {"field":"temperature","attempt":1}
done {"model":"gpt-6-luna","totalMs":1236}
```

> Os tempos vêm do gateway **simulado**. Não são medições de modelo real.

## 7. O que ainda NÃO está aprovado

**A integração real continua não validada.** Esta correção foi feita e testada em ambiente Linux
com gateway simulado que imita o contrato do v0.2.0. A confirmação final exige uma mensagem real
no seu Windows. Critério de aprovação: **resposta real do modelo, sem HTTP 400**.

## 8. Como validar no Windows

```bat
:: 1. gateway ligado, como sempre
curl http://127.0.0.1:1455/health

:: 2. na pasta da Kirana
diagnostico.bat          :: confere Node, .env, /health, /v1/models e modelos
iniciar.bat              :: abre http://127.0.0.1:3000
```

Na interface, envie **"Oi, quem é você?"**. Esperado:

- a resposta aparece progressivamente (streaming);
- nenhum erro vermelho, nenhum HTTP 400;
- `/api/status` mostra `gateway.reachable: true` e modelo ativo.

Se ainda aparecer 400:

1. Veja a mensagem do campo reclamado no cartão de erro;
2. Rode `diagnostico.bat` e copie a saída (sem a chave);
3. Verifique se algum `KIRANA_SEND_*` está `true` no `.env`;
4. Se o campo reclamado não for `temperature`, ele está fora da allowlist — basta reportar o nome
   do campo, que a recuperação automática já deve ter resolvido a requisição.

---

# Anexo — auditoria de erros similares (mesma sessão de trabalho)

Depois da correção do `temperature`, foi feita uma varredura procurando **outros defeitos da mesma
família** (campo/formato fora do contrato do gateway). Resultado: dois novos problemas reais e um
de observabilidade.

## A.1 Varredura realizada

| Verificação | Método | Resultado |
|---|---|---|
| Pontos que enviam HTTP para fora do backend | `grep` em `src/` e `scripts/` | só `src/gateway.js` (2 chamadas: `/v1/models` e `/v1/chat/completions`) |
| Campos fora do contrato (`parallel_tool_calls`, `top_p`, penalidades, `seed`, `stop`, `response_format`, `logprobs`) | `grep` em todo o projeto | nenhum fora de `src/payload.js` |
| `temperature`/`max_tokens` no caminho de envio | leitura de `agent.js` → `payload.js` | só entram com `KIRANA_SEND_*` ligado |
| Formato de mensagens enviadas | validador de contrato + sonda | 2 defeitos (abaixo) |
| Caminhos de erro do agente (interrupção, ferramenta desconhecida, limite de rodadas, fallback) | sonda com 17 requisições reais | 1 defeito (abaixo) |

## A.2 Defeito 2 — `content: null` em mensagens com `tool_calls`

`toApiMessage()` montava `content: null` para o turno do assistente que só tinha chamada de
ferramenta (formato aceito pela OpenAI, mas recusado por gateways estritos).

- **Impacto:** qualquer segundo turno depois de uma ferramenta poderia receber HTTP 400.
- **Correção:** `content` passou a ser sempre string (`''`), tanto em `src/agent.js` quanto no
  saneamento de `src/payload.js`.
- **Cobertura:** `test/contract.test.js` — “validador recusa content null em mensagem com
  tool_calls” e o teste de fluxo completo.

## A.3 Defeito 3 — chamada de ferramenta sem resposta no limite de rodadas

Ao atingir `KIRANA_MAX_TOOL_ROUNDS`, o agente respondia **apenas a primeira** chamada de
ferramenta do último turno. As demais ficavam pendentes, deixando o histórico inválido para a API
(toda `tool_call` precisa de uma mensagem `tool` correspondente).

- **Impacto:** histórico corrompido → 400 no turno seguinte (o reparo de contexto mascarava,
  descartando o turno inteiro — perdendo contexto em silêncio).
- **Correção:** o turno de limite agora responde **todas** as chamadas, com `too_many_rounds`.
- **Cobertura:** `test/contract.test.js` — “limite de rodadas de ferramenta não deixa chamada sem
  resposta”.

## A.4 Defeito 4 (observabilidade) — ferramenta desconhecida sem aviso na interface

Quando o modelo pedia uma ferramenta inexistente, o backend registrava o erro no histórico mas não
emitia `tool_result`; a interface ficava apenas “pensando”.

- **Correção:** passou a emitir `tool_result` com `errorCode: "unknown_tool"`.
- **Cobertura:** `test/contract.test.js` (fluxo completo).

## A.5 Nova barreira permanente

`src/contract.js` valida o payload **antes do envio**, no nível de detalhe que o gateway usa
(campos de topo, chaves por papel de mensagem, `content` nulo/vazio, `tool_call_id`, argumentos
JSON, schema das ferramentas). Violação vira erro local `gateway_contract_error`, com o caminho do
problema — em vez de HTTP 400 genérico vindo da rede.

Reutilizado em três pontos: `src/gateway.js` (bloqueio), `scripts/audit-contract.mjs` (sonda) e
`test/contract.test.js` (regressão).

## A.6 Evidência

```console
$ npm run audit
  ✓ turno: Oi · ✓ turno: Quais serviços? · ✓ turno: E sobre WhatsApp?
  ✓ turno: Continuando o assunto · ✓ turno: Mais uma pergunta
  ✓ escrita: pede confirmação · ✓ escrita: confirmação executada
  ✓ memória: turno com memória no prompt · ✓ ferramenta desconhecida recusada
  ✓ fallback acionado (modelo final gpt-6.1-sol) · ✓ retomada após interrupção
  ✓ mensagem longa/acentuada

Requisições válidas enviadas ao gateway: 17
Violações de contrato: 0

$ node --test test/
# tests 94 · pass 94 · fail 0
```

## A.7 O que continua pendente

A validação no Windows com o gateway real continua sendo a única prova definitiva. A sonda e os
testes rodam contra um gateway **que imita o contrato do v0.2.0** — não contra o gateway real.
Se o gateway recusar algo que o contrato aqui não prevê, a recuperação automática (remoção do campo
+ repetição única) ainda cobre o caso e registra o campo no log.
