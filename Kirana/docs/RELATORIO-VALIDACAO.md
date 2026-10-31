# Relatório do que foi efetivamente validado

**Projeto:** Kirana — Fase 1 (execução local)
**Data:** 24/10/2026
**Ambiente de desenvolvimento:** contêiner Linux, Node.js v20.20.2, sem acesso à máquina Windows
onde está o gateway real.

> Este relatório separa três coisas que não devem ser confundidas:
> **testado com gateway simulado**, **implementado mas não validado** e **não realizado**.

---

## 1. O que foi testado de verdade

### 1.1 Suíte automatizada

```text
node --test test/
# tests 67 · pass 67 · fail 0 · duration_ms ~930
```

| Arquivo | Foco | Testes |
|---|---|---|
| `test/sse.test.js` | Parser de SSE: fragmentos em qualquer posição, CRLF, múltiplos eventos, `[DONE]`, linhas de comentário | 7 |
| `test/validation.test.js` | JSON Schema: tipos, obrigatórios, enum, limites, itens, campos extras, pattern | 9 |
| `test/memory.test.js` | Consentimento obrigatório, upsert por chave, bloqueio de dados sensíveis, limite, persistência, orçamento de prompt, limpeza | 6 |
| `test/sessions.test.js` | Criação/listagem/exclusão, título automático, id inválido, ação pendente persistida, reparo de contexto (chamada sem resultado, resultado órfão, início com usuário), métricas | 9 |
| `test/tools.test.js` | Registro e schemas, leitura x escrita, busca no catálogo, produto inexistente, projeto simulado, validação de e-mail/consentimento, gravação local de interesse, memória, argumentos inválidos, ferramenta desconhecida | 12 |
| `test/gateway.test.js` | `/health`, `/v1/models`, streaming de texto, tool calls fragmentadas, 401, gateway inacessível, chave ausente, 5xx, 404 de modelo, abort | 9 |
| `test/server.test.js` | Integração HTTP completa (abaixo) | 15 |

### 1.2 Integração HTTP (gateway falso + servidor real, SSE real)

Validado com requisições HTTP de verdade, servidor escutando em porta efêmera:

- `GET /health` responde `ok`;
- interface servida com `Content-Security-Policy`, sem qualquer chave no HTML ou em `/api/config`;
- conversa em dois turnos: streaming recebido, e o **segundo turno enviou o histórico do primeiro**
  ao modelo (verificado na requisição que chegou ao gateway);
- **ciclo completo de ferramenta de leitura**: modelo pede `consultar_servicos` → evento
  `tool_start`/`tool_result` → resultado real do catálogo chega ao modelo no round seguinte →
  resposta final em texto; `toolCalls` registrado nas métricas da sessão;
- **ciclo completo de ferramenta de escrita com confirmação**:
  - evento `confirmation` emitido;
  - **nenhum registro criado** antes da confirmação (`data/interests.jsonl` inexistente);
  - após `approve: true`, a ferramenta executa, `tool_result.executed = true`, e o arquivo contém
    exatamente 1 registro com `envio_externo: false` e protocolo `INT-...`;
  - após `approve: false`, nada é gravado;
  - ação expirada é recusada com `action_expired` e nada é gravado;
- **fallback de modelo**: primário retorna 500 → segunda chamada usa `gpt-6.1-sol`, texto chega
  ao usuário, evento `status: retry` e `done.fallbackUsed = true`;
- erro 401 do gateway vira mensagem compreensível (`gateway_auth`), a sessão continua utilizável;
- validações de entrada: `missing_session` (400), sessão inexistente (404), mensagem vazia (400),
  JSON inválido (400), sessão desconhecida (404);
- rate limiting: com `KIRANA_RATE_LIMIT_MAX=1`, a segunda mensagem recebe **429** `rate_limited`;
- `KIRANA_ACCESS_TOKEN` configurado: sem cabeçalho → **401**; com `X-Kirana-Token` → resposta normal;
- origem diferente (`Origin` de outro host) → **403**;
- memória via API: sem consentimento → 400; com consentimento → 201; exclusão → 200;
- `/api/tools` lista as 7 ferramentas com tipo; `/api/status` mostra gateway alcançável e modelo
  ativo, **sem expor a chave**.

### 1.3 Execução manual ponta a ponta (gateway simulado)

Com `scripts/mock-gateway.js` na porta 1455 e a Kirana na 3300 (execução real por `curl`):

```text
Turno 1 (texto):      deltas SSE recebidos em sequência, evento done com model gpt-6-luna
Turno 2 (ferramenta): tool_start consultar_servicos → tool_result ok:true
                      done: rounds=2, toolCalls=1, ttftMs=29, totalMs=1479
Turno 3 (escrita):    confirmation com resumo legível da ação
Confirmação:          tool_result executed:true → resposta em streaming
Registro gravado:     {"protocolo":"INT-2026-4F3914","status":"registrado_localmente_pendente_de_envio","envio_externo":false,...}
```

**Atenção:** esses tempos (29 ms / 1 479 ms) vêm do gateway simulado, que responde por script.
**Não são medições de modelo real e não dizem nada sobre a meta de 2 segundos.**

### 1.4 Interface

- HTML/CSS/JS sem dependências externas; a página é servida com CSP `script-src 'self'`.
- Sintaxe de `public/app.js` verificada (`node --check`), assim como todos os arquivos de `src/`
  e `scripts/`.
- Layout responsivo implementado (breakpoint 900 px, menu lateral em gaveta, `100dvh`,
  `safe-area-inset-bottom`).
- Prévia estática gerada em `docs/preview-interface.html` para revisão de design.

---

## 2. Critérios de aceite da especificação (seção 11)

| Critério | Estado | Evidência |
|---|---|---|
| Abrir uma interface local | ✅ | `npm start` → `http://127.0.0.1:3000`; teste de `/` servindo HTML |
| Conectar-se ao gateway existente | ⚠️ implementado, validado só com gateway simulado | `test/gateway.test.js`, `test/server.test.js` |
| Enviar e receber mensagens reais | ⏳ pendente | depende do gateway real na sua máquina |
| Exibir streaming progressivo | ✅ | eventos `delta` testados ponta a ponta |
| Preservar contexto entre mensagens | ✅ | teste de integração verifica histórico no 2º turno |
| Utilizar o prompt de identidade Kirana | ✅ | `src/prompts.js`; teste confere mensagem de sistema |
| Consultar catálogo local de serviços | ✅ | ferramenta + testes de busca |
| Executar ciclo completo de ferramenta simulada | ✅ | leitura e escrita com confirmação |
| Proteger as credenciais no backend | ✅ | chave ausente em `/api/config`, `/api/status`, HTML; redação em logs |
| Apresentar erros sem travar | ✅ | 401/500/timeout → evento `error` com mensagem clara; sessão segue usável |
| Funcionar em layout mobile | ⚠️ implementado, não testado em dispositivo real | CSS responsivo + `docs/preview-interface.html` |
| Testes automatizados e documentação | ✅ | 67 testes + 5 documentos |
| Comparar desempenho dos modelos | ⚠️ ferramenta pronta (`scripts/benchmark.mjs`), medição pendente | requer gateway real |

---

## 3. O que NÃO foi validado (e por quê)

| Item | Motivo |
|---|---|
| Conversa com o gateway ChatGPT real | O gateway roda em `127.0.0.1` na sua máquina Windows; o ambiente de desenvolvimento não tem acesso a ele |
| Tempo real até o primeiro token e meta de 2 s | Depende de modelo real, rede e conta |
| Comparação Luna x Sol | Depende de chamadas reais ao gateway |
| Scripts `.bat` no Windows | Ambiente Linux; os comandos equivalentes foram executados, os `.bat` foram apenas revisados |
| Teste em celular físico | Sem dispositivo disponível; só verificação de CSS e prévia estática |
| Envio efetivo de interesse para CRM/e-mail/WhatsApp | Deliberadamente fora do escopo da Fase 1 |
| Publicação no site | Deliberadamente bloqueada pela especificação (Fase F) |

---

## 4. Problemas encontrados e correções feitas durante o desenvolvimento

1. **`runRead` não validava argumentos** — uma chamada de leitura com argumentos inválidos era
   executada. Corrigido: `runRead` passou a validar contra o schema antes de executar (teste
   `argumentos inválidos do modelo viram erro estruturado`).
2. **Rate limit consumido ao criar sessão** — criar sessão gastava a cota do chat. Corrigido:
   o limite agora se aplica apenas às rotas de conversa (`/api/chat`, `/api/chat/confirm`, memória).
3. **Evento `session` duplicado no SSE** — emitido pelo servidor e pelo agente. Removido do agente.
4. **Contexto podia começar com mensagem de assistente** — histórico aparado agora garante que o
   contexto comece com usuário e descarta pares de ferramenta incompletos.
5. **Prévia estática gerada com `String.raw`** produzia barras invertidas no JS embutido.
   Corrigido lendo o script de demonstração de um arquivo separado.

---

## 5. Pendências prioritárias

1. Rodar `diagnostico.bat` e validar uma conversa real com `gpt-6-luna`.
2. Executar `node scripts/benchmark.mjs --models gpt-6-luna,gpt-6.1-sol --n 10 --context`.
3. Comparar os tempos reais com a meta de 2 s e decidir o modelo padrão com base em dados.
4. Revisar o prompt com perguntas reais da Opportunity AI.
5. Testar em um celular real e ajustar detalhes de layout se necessário.

---

## 6. Como reproduzir tudo o que está aqui

```bash
# 1. testes automatizados (não precisam de gateway nem de .env)
node --test test/

# 2. demonstração ponta a ponta com gateway simulado
node scripts/mock-gateway.js --port 1455 --key local-mock &
KIRANA_GATEWAY_URL=http://127.0.0.1:1455 KIRANA_GATEWAY_API_KEY=local-mock node src/server.js

# 3. diagnóstico e benchmark contra o gateway real (na sua máquina)
node scripts/doctor.mjs
node scripts/benchmark.mjs --models gpt-6-luna,gpt-6.1-sol --n 10 --context
```
