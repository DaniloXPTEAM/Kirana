# CHANGELOG DA CORREÇÃO — Kirana v0.5.4 + Gateway v0.4.1

Esta entrega **corrige** a distribuição anterior; não é uma reconstrução do produto.
Versões mantidas de propósito: **Kirana 0.5.4** e **Gateway 0.4.1**. O que mudou é
comportamento de scripts e quatro pontos de código, todos listados abaixo com causa-raiz.

Data: 29/10/2026.

---

## Resumo

| # | Defeito | Onde | Antes | Depois |
|---|---|---|---|---|
| 1 | Instalador se bloqueava na segunda execução | `scripts/Instalar.ps1`, `tools/verificar-pacote.mjs` | abortava ao ver `node_modules`, `.env`, `.local-state`, `data` | verificador tem dois modos; a instalação em uso passa |
| 2 | Chave local não era alinhada | `scripts/Instalar.ps1` | pedia copiar a chave à mão entre os dois `.env` | `tools/configurar.mjs` gera/preserva, grava e confere |
| 3 | Modelo inexistente mantido para sempre | `Kirana/src/agent.js` | primário fora do catálogo era mantido → `model_not_found` em todo turno | escolha determinística a partir do catálogo real |
| 4 | Acento corrompido e frame final perdido | `Gateway/src/responses.js` | decodificador criado por chunk; resto do buffer descartado | um decodificador por stream; cauda passa pelo mesmo parser |
| 5 | Erro genérico para causas diferentes | `Kirana/src/agent.js` | quase tudo virava "streaming falhou" | mensagens distintas por código |
| 6 | Timeout da Kirana menor que o do Gateway | `.env` gerado | 120 s na Kirana × 180 s por tentativa no Gateway | alinhado automaticamente para 200 s |
| 7 | `INICIAR-TUDO` abortava se o serviço já estivesse no ar | `scripts/Iniciar-Tudo.ps1` | "porta ocupada" → `exit 1` | mesma versão já no ar → segue sem duplicar |
| 8 | Comentários do `.env` perdidos ao alinhar a chave | `tools/configurar.mjs` | arquivo reescrito do zero | edição cirúrgica: só a linha da chave muda; comentários, ordem e CRLF preservados |
| 9 | `configurar.mjs` exigia `.env` já criado | `tools/configurar.mjs` | mensagem "rode o instalador para criá-lo" | cria do `.env.example` quando falta (e corrige a barra duplicada na mensagem) |

---

## 1. Instalador se bloqueava (defeito comprovado)

**Causa-raiz.** `Instalar.ps1` etapa 3 executava `node tools/verificar-pacote.mjs` sem
distinguir dois contextos incompatíveis:

- **ZIP de entrega**: `node_modules`, `.env`, `.local-state` e `data` são proibidos —
  são dependência, segredo e dado do usuário;
- **instalação já usada**: exatamente esses quatro caminhos são legítimos.

Como o verificador só conhecia a primeira regra, a segunda execução na mesma pasta
reprovava com seis itens (os do log do usuário) e abortava antes da etapa 4, que é onde
a reutilização de `node_modules` acontece. `-Force` não resolvia porque o parâmetro
existente é `-ReinstalarDependencias`.

**Correção.**

- `tools/verificar-pacote.mjs` ganhou dois modos explícitos:
  - `--release` (padrão) — mantém a reprovação dos seis caminhos;
  - `--instalacao` — aceita os caminhos e passa a **validá-los** (`node_modules`
    não vazio, chaves presentes e coerentes), sem apagar nada.
- `scripts/Instalar.ps1` chama `--instalacao`.
- Os testes de versão (0.5.4 / 0.4.1), `Gateway/src/engine.js`, marcadores reais do
  código, arquivos e scripts obrigatórios **continuam obrigatórios** nos dois modos.

**Idempotência.** Rodar `INSTALAR-WINDOWS.cmd` duas vezes na mesma pasta agora passa nas
duas. `node_modules` existente é reaproveitado, chave existente é preservada,
`Kirana/data` e `Gateway/.local-state` não são tocados (validado por teste).

---

## 2. Chave local não era alinhada (defeito comprovado)

**Causa-raiz.** Kirana e Gateway são processos separados. O fallback de
`Kirana/src/config.js` (`KIRANA_GATEWAY_API_KEY || GATEWAY_API_KEY`) só ajudaria se a
variável estivesse no ambiente **do processo da Kirana** — o que não acontece ao ler
`Gateway/.env`. Sem `KIRANA_GATEWAY_API_KEY`, a Kirana falha com
`gateway_not_configured`; com valor diferente, o Gateway responde 401.

**Correção.** `tools/configurar.mjs`, portado do `tools/configurar.mjs` da v0.5.3 com
três mudanças deliberadas:

1. **preserva o `.env`**: edita só as linhas necessárias, mantendo comentários, ordem,
   variáveis desconhecidas e CRLF (a versão antiga reescrevia o arquivo e perdia
   comentários);
2. **não procura `.env` de pastas vizinhas** (a versão antiga subia diretórios e podia
   pegar credencial de outro projeto — proibido pela regra de não varrer o disco);
3. **faz backup verificado por releitura** antes de qualquer escrita.

Regra da chave: `Gateway/.env` é a autoridade; se `GATEWAY_API_KEY` não existir é gerada
pelo keygen do próprio Gateway (32 bytes aleatórios); se existir com 32+ caracteres é
preservada; `Kirana/.env` sempre recebe o mesmo valor em `KIRANA_GATEWAY_API_KEY`.
O valor nunca é impresso — os relatórios mostram apenas "definida" e o tamanho.

Depois de escrever, o script **relê os dois arquivos do disco** e falha se não houver
igualdade. `tools/checar-config.mjs` repete a conferência como pré-voo antes de subir
qualquer serviço.

**Critério atendido:** a mensagem "copie o valor de `Gateway/GATEWAY_API_KEY` para
`Kirana/KIRANA_GATEWAY_API_KEY`" não existe mais no instalador.

---

## 3. Modelo inexistente mantido (defeito comprovado por teste)

**Causa-raiz.** Em `Kirana/src/agent.js`, `resolveActiveModel()` fazia:

```js
const active = hasPrimary ? primary : hasFallback ? fallback : primary;  // ← mantém o primário
```

Se o catálogo do Gateway não tivesse **nem** o primário **nem** o fallback (caso dos
valores padrão `gpt-6-luna` / `gpt-6.1-sol`, que vieram do `.env.example` e não são
evidência de disponibilidade em nenhuma conta), a Kirana insistia no primário inexistente
e **todo turno** falhava.

**Correção.** A regra saiu para `Kirana/src/model-choice.js` (módulo próprio,
testável). Ordem determinística:

1. primário, se estiver no catálogo;
2. fallback, se estiver no catálogo;
3. senão, um modelo **do próprio catálogo**, escolhido por ordem estável, descartando
   o que claramente não é chat (`embedding`, `whisper`, `tts`, `dall-e`, `moderation`…);
4. catálogo vazio → mantém o configurado e registra aviso (sem catálogo não há como
   decidir, e inventar slug é proibido).

A escolha é registrada no log e exposta na nota do modelo ativo. Seleção manual
(`KIRANA_MODEL_PROBE=false`) e o mecanismo de fallback continuam funcionando.

---

## 4. Parser SSE do Gateway (dois defeitos de código)

**4a. Decodificador por chunk.** `parseSse` criava `new TextDecoder()` a cada pedaço recebido:

```js
buffer = (buffer + new TextDecoder().decode(value, { stream: true })).replace(/\r\n/g, '\n');
```

Um decodificador novo não tem estado, então `{ stream: true }` não protege nada: caractere
multi-byte partido entre dois chunks vira `U+FFFD`. Em português isso atinge `ç`, `ã`, `é`
— texto chegando corrompido no meio da resposta. Agora há **um decodificador por stream**,
com `decode()` final no fim.

**4b. Resto do buffer descartado.** Ao terminar o stream, o que sobrava era tratado por um
caminho separado que pegava só a **primeira** linha `data:` e não herdava o nome do evento.
Um frame terminal que chega sem a linha em branco final podia ser perdido — e então
`if (!completed) throw ... 'Responses stream ended without response.completed'` disparava
**depois de o texto já ter sido entregue**. É exatamente a assinatura do sintoma relatado
("resposta chegou, 1.197 caracteres, e então o streaming falhou"). Agora a cauda passa pelo
**mesmo** parser de blocos.

A mensagem de interrupção também passou a informar quantos caracteres chegaram, o que
distingue "provedor cortou" de "parser perdeu o frame" no log e em `GET /v1/runs`.

> **Limite honesto:** a causa **exata** que fez o stream do seu plano terminar sem
> `response.completed` não pode ser provada do meu ambiente — depende do serviço externo.
> O que esta entrega garante é: (a) o parser não perde mais o frame terminal; (b) se o
> provedor cortar de fato, o motivo aparece com código próprio e com o contador de
> caracteres, em vez de "streaming falhou" genérico. Ver `TESTES-E-EVIDENCIAS.md` §7.

---

## 5. Mensagens de erro diferenciadas

`errorMessage()` em `agent.js` ganhou códigos próprios: `stream_interrupted`,
`response_incomplete`, `invalid_upstream_event`, `model_not_available`, `unauthorized`,
`gateway_not_configured`. Falta de chave local, chave divergente, SIWC sem escopo, modelo
inexistente e queda de conexão passam a produzir textos diferentes — e cada um aponta a
ação certa, em vez de "Gateway não concluiu" para tudo.

---

## 6. Timeout da Kirana menor que o do Gateway

`KIRANA_REQUEST_TIMEOUT_MS=120000` no `.env` contra `KIRANA_ENGINE_TIMEOUT_MS=180000`
(por tentativa) no Gateway. A Kirana desistia antes de o Gateway terminar — e uma resposta
longa ou com ferramentas era cortada no meio. `tools/configurar.mjs` agora ajusta para
`timeout do Gateway + 20 s` quando o valor da Kirana for menor, avisando; valor maior é
preservado.

---

## 7. `INICIAR-TUDO` abortava com o serviço já no ar

`Tratar-PortaOcupada` retornava `false` quando a porta estava ocupada por outra origem,
mesmo com a **mesma versão** respondendo. Resultado: quem já tinha o Gateway autorizado
não conseguia subir a Kirana pelo comando de iniciar. Agora, quando a versão responde
conforme o esperado, ele **segue sem duplicar** e diz que o serviço já está no ar.
Processo de versão diferente continua bloqueando, e nada é encerrado automaticamente.

---

## Preservado sem alteração

- `Kirana/src/gateway-bridge.js`, `Kirana/windows/Verificar-Tailscale.ps1`,
  `Kirana/docs/ACESSO-REMOTO-TAILSCALE.md`, `Kirana/tools/simular-tailscale-serve.mjs`;
- ferramentas, RAG, catálogo, sessões, memória, voz, barge-in, interface e kit de
  incorporação;
- política de tokens SIWC **memory-only** (`Gateway/src/auth.js`) — não foi alterada;
- `scripts/Parar-Tudo.ps1` (só encerra o que a distribuição iniciou) e
  `scripts/Diagnostico.ps1` (sem mudanças de critério);
- `Kirana/data`, `Gateway/.local-state`, `hostId` e `registration.json`.

## Arquivos alterados nesta correção

| Arquivo | Natureza |
|---|---|
| `scripts/Instalar.ps1` | chama `--instalacao`, `configurar.mjs` e `checar-config.mjs`; sem cópia manual de chave |
| `scripts/Iniciar-Tudo.ps1` | pré-voo antes de iniciar; idempotente; abre a interface |
| `tools/verificar-pacote.mjs` | modos `--release` e `--instalacao` |
| `tools/configurar.mjs` | **novo** (portado da v0.5.3 e reescrito) |
| `tools/checar-config.mjs` | **novo** (portado da v0.5.3 e ampliado) |
| `tools/teste-correcoes.mjs` | **novo** — 18 testes de regressão |
| `Kirana/src/agent.js` | usa `model-choice.js`; mensagens de erro por código |
| `Kirana/src/model-choice.js` | **novo** — escolha determinística pelo catálogo |
| `Gateway/src/responses.js` | decodificador único, cauda pelo mesmo parser, diagnóstico de interrupção, `parseSse` exportado para teste |
| `docs/CHANGELOG-CORRECAO.md`, `docs/TESTES-E-EVIDENCIAS.md`, `docs/MIGRACAO-E-ROLLBACK.md` | **novos** |
| `SHA256SUMS.txt` | **novo** |


---

## Verificações automatizadas desta correção

| Bateria | Resultado |
|---|---|
| `node tools/verificar-pacote.mjs` (release) | 30/30 |
| `node tools/verificar-pacote.mjs --instalacao` | 33/33 |
| `node tools/teste-correcoes.mjs` | 18/18 |
| `node tools/teste-scripts.mjs` | 19/19 |
| `cd Gateway && node --test test/*.test.js` | 76/76 |
| `scripts/Instalar.ps1` duas vezes na mesma pasta | PASSOU (estado preservado) |
| `cd Kirana && node --test test/*.test.js` | NÃO TESTÁVEL NESTE AMBIENTE (sem espaço para `node_modules`) |

Detalhe de cada um, com o que não foi testado e por quê: `docs/TESTES-E-EVIDENCIAS.md`.
