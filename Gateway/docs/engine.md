# Motor do Gateway — identidade, catálogo e política de execução

**Estado: implementado e provado por teste determinístico (34 testes novos, suíte total 76/76). Nenhum modelo real foi executado nesta sessão; a verificação com conta autorizada (SIWC) é a próxima etapa e exige ação do dono da conta.**

## Por que isto existe

O Gateway v0.4.0 tinha um defeito central: ele **ecoa** o nome do modelo que o cliente pediu e descarta o que o provedor responde. Se o pedido fosse `model: "gpt-5"` e o provedor atendesse com outro modelo, o cliente nunca saberia. Antes desta mudança, `src/responses.js` lia o stream e ignorava `response.model`.

Agora existem cinco coisas separadas, com nomes diferentes de propósito:

| Campo | Significado | Quem informa |
|---|---|---|
| `model_requested` | o que o cliente pediu | cliente |
| `model_selected` | o que a política escolheu executar | Gateway (`selectChain`) |
| `model_used` | o modelo da tentativa que respondeu | Gateway |
| `model_reported` | o modelo que o **provedor declarou** ter usado | provedor (`response.model`) |
| `identity_verified` | `true` **somente** se `model_requested === model_reported` **e** o provedor declarou | Gateway |

`identity_verified: false` não é erro; é a verdade. Acontece quando o provedor atende com outro motor (roteamento interno do plano) ou quando não declara nada. O Gateway não "corrige" isso para ficar bonito.

## Arquivos

- `src/engine.js` — motor: catálogo, circuit breaker, seleção de cadeia, execução, histórico.
- `src/responses.js` — captura `response.model`, `response.id`, `response.status` e `usage`.
- `src/gateway.js` — usa o motor no `POST /v1/chat/completions`; expõe `GET /v1/engine` e `GET /v1/runs`.
- `src/main.js` — lê a configuração do motor do ambiente e valida na inicialização.
- `config/models.json` — catálogo de modelos. **Vazio de propósito.**
- `test/engine.test.js` (22 testes) — política pura.
- `test/engine-gateway.test.js` (12 testes) — integração HTTP com upstream falso.
- `tools/quality-suite.mjs` — bateria de tarefas com critérios objetivos (não é teste da suíte).

## Catálogo: declarado ≠ testado

`config/models.json` começa vazio porque **nada foi testado com modelo real**. Cada entrada tem:

```json
{
  "model": "slug-exato-de-/v1/models",
  "provider": "siwc-responses",
  "cost": "plan",
  "capabilities": { "text.chat": true, "reasoning": true, "images.analyze": false }
}
```

Estados possíveis por capacidade: `declared` (alguém afirmou), `tested` (passou em execução registrada), `unavailable` (reprovou e continua reprovado até novo teste), `unknown` (não há informação).

Regra dura: **capacidade especializada (`images.analyze`, `coding`, `tools`, `json`, `reasoning`) só é usada se estiver `tested`.** Nada entra em produção por inferência ou por folheto de marketing. `text.chat` é a linha de base e não exige entrada no catálogo — senão o Gateway deixaria de funcionar por falta de configuração.

Reprovação vale como informação: o modelo `gpt-5` já foi reprovado em interpretação de imagem na experiência do usuário. Essa reprovação pode ser registrada em `config/models.json` como `"images.analyze": false` e o Gateway **nunca** vai encaminhar imagem para ele.

## Política de execução (`selectChain`)

Ordem de precedência:

1. **Pedido explícito do usuário** (`explicit: true`) vence tudo — respeitar quem escolheu o modelo.
2. **Capacidade especializada aprovada** — se o pedido exige `images.analyze` e o primário não tem, usa o especializado **testado**; se não houver, **recusa** (`capability_unavailable`).
3. **Primário preservado** — não troca de modelo só porque outro está disponível.
4. **Fallback só em falha elegível** — infraestrutura (timeout, conexão, 5xx, limite de uso), nunca erro de conta/pedido.

Garantias:

- A cadeia **nunca repete modelo** (`seen` Set) e respeita `maxFallbackHops` (padrão 1).
- Fallback só acontece **antes do primeiro byte**. Depois que o stream começou, trocar de modelo corromperia a resposta — o Gateway encerra com erro honesto.
- Erro de conta (`authentication_required`) e pedido inválido **não** fazem fallback: trocar de modelo não conserta chave vencida, e mascararia o problema.
- Sem alternativa utilizável, a resposta é `503 no_candidate_available` — a tarefa é preservada com recusa explícita, não com resposta inventada.

## Custo

`cost_policy=plan-only` por padrão. Qualquer modelo marcado `cost: "paid"` é bloqueado **antes** de tocar o provedor:

```
HTTP 402 { "error": { "code": "cost_blocked", "message": "... plan-only ..." } }
```

`KIRANA_COST_POLICY=allow-paid` libera, e isso é uma decisão consciente de quem paga a conta — nunca um padrão.

## Circuit breaker

Após N falhas de infraestrutura consecutivas (`KIRANA_BREAKER_FAILURES`, padrão 3) o modelo fica `open` por `KIRANA_BREAKER_RESET_MS` (padrão 60 s). Passada a janela, entra em meio-aberto: **uma** sondagem é permitida; sucesso fecha, falha reabre. Modelo bloqueado é pulado sem chamada — o que evita gastar tempo e cota em provedor que já está fora.

## Timeout

Timeout é por tentativa (`KIRANA_ENGINE_TIMEOUT_MS`, padrão 120 s) e vale **mesmo se o chamador ignorar o `AbortSignal`** — a corrida é explícita (`Promise.race`). Esse detalhe foi descoberto por teste: a primeira versão só abortava, e um `call` que ignorava o sinal travava a cadeia.

## Endpoints

### `GET /v1/engine`

Retrato atual: política, última identidade observada, catálogo e estado dos breakers.

```json
{
  "gateway": { "provider": "siwc-responses" },
  "policy": { "routing_enabled": true, "primary_model": "...", "fallback_model": "...", "cost_policy": "plan-only", "max_fallback_hops": 1 },
  "identity": { "model_requested": "...", "model_used": "...", "model_reported": "...", "identity_verified": true, "fallback_used": false, "at": "..." },
  "models": [ { "model": "...", "capabilities": { "text.chat": "tested" } } ],
  "breakers": [ { "model": "...", "state": "closed" } ]
}
```

### `GET /v1/runs` e `GET /v1/runs/:id`

Histórico em memória (ring buffer de 200), **só metadados** — nunca conteúdo de mensagem. Cada execução:

```json
{
  "id": "run_000001", "kind": "text.chat", "status": "completed|blocked|failed",
  "model_requested": "...", "model_selected": "...", "model_used": "...", "model_reported": "...",
  "identity_verified": true, "provider": "siwc-responses", "upstream_id": "...",
  "fallback_used": false,
  "decision": { "reason": "...", "fallback_available": true, "skipped": [] },
  "attempts": [ { "model": "...", "outcome": "ok|failed|skipped", "code": null, "duration_ms": 812 } ],
  "latency": { "first_useful_ms": 640, "total_ms": 1903 },
  "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 },
  "tool_calls": 0
}
```

## Configuração

| Variável | Padrão | Efeito |
|---|---|---|
| `KIRANA_ROUTING` | `off` | `on` liga a política de seleção. Desligado, o comportamento é idêntico ao v0.4.0. |
| `KIRANA_PRIMARY_MODEL` | — | obrigatório com `routing=on` |
| `KIRANA_FALLBACK_MODEL` | — | opcional; precisa ser diferente do primário |
| `KIRANA_COST_POLICY` | `plan-only` | `allow-paid` libera modelo pago |
| `KIRANA_ENGINE_TIMEOUT_MS` | `120000` | timeout por tentativa |
| `KIRANA_ENGINE_ATTEMPTS` | `1` | tentativas por modelo (nunca vira laço) |
| `KIRANA_BREAKER_FAILURES` / `_RESET_MS` | `3` / `60000` | circuit breaker |
| `KIRANA_MODEL_CATALOG` | `config/models.json` | catálogo alternativo |
| `KIRANA_SPECIALIZED` | vazio | mapa `capacidade=modelo`, separado por vírgula (ex.: `images.analyze=modelo-visao`) |

## O que os testes provam — e o que não provam

Provam (76/76): a política escolhe o modelo certo em cada situação; o fallback não vira laço; erro de conta não é mascarado; custo pago é bloqueado; breaker abre/fecha/sonda; timeout vale mesmo com chamador teimoso; o histórico registra o que aconteceu; a identidade reportada tem prioridade sobre o nome pedido; sem roteamento, o comportamento antigo permanece.

**Não provam**: que qualquer modelo real exista, responda, seja rápido ou cobre o que está escrito. Isso só se prova com a conta autorizada — ver `docs/tama-integration.md` e `tools/quality-suite.mjs`.
