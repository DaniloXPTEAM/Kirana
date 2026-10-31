# Integração Gateway ↔ Tama IA (Kirana)

Este documento descreve como um cliente (o agente Tama IA, ou qualquer aplicativo)
usa o Gateway como motor, e — igualmente importante — **o que ainda não está
provado** e depende de autorização do dono da conta.

## Situação em uma frase

O Gateway já sabe **pedir, executar, registrar e recusar** de forma honesta, e
sabe **dizer qual modelo o provedor declarou ter usado**. Ele ainda **não foi
exercitado contra a conta real** nesta linha de trabalho, porque o SIWC exige
consentimento do dono da conta no navegador. Nenhum resultado de modelo real é
afirmado aqui.

## Como o cliente conversa com o Gateway

Base: `http://127.0.0.1:1455` (loopback). Autenticação: `Authorization: Bearer <GATEWAY_API_KEY>`.
A chave é gerada localmente (`npm run keygen`); ela não é a credencial do provedor.

1. **Descobrir o que existe de verdade**
   `GET /v1/models` — lista apenas modelos visíveis na conta autenticada.
   Não existe lista fixa de modelos no código. Nome de modelo é dado, não suposição.

2. **Conversar**
   `POST /v1/chat/completions` com `stream: true`, formato compatível com OpenAI.
   O nome ecoado ao cliente continua sendo o pedido — compatibilidade preservada.

3. **Saber o que aconteceu de verdade**
   `GET /v1/engine` — política vigente + última identidade observada.
   `GET /v1/runs?limit=20` — histórico com modelo pedido/selecionado/usado/declarado,
   decisão, tentativas, latência, tokens e chamadas de ferramenta.
   `GET /v1/runs/run_000001` — uma execução específica.

Sem esses dois endpoints, "qual modelo respondeu?" é opinião. Com eles, é registro.

## Leitura dos campos de identidade

```
model_requested    o que eu pedi
model_selected     o que a política escolheu
model_used         o modelo da tentativa que respondeu
model_reported     o que o PROVEDOR declarou ter usado
identity_verified  true só quando requested == reported e o provedor declarou
```

Se `identity_verified` for `false`, **não presuma falha**: pode ser roteamento
interno do plano. Presuma que você não sabe — e é exatamente isso que o campo diz.

## Erros que o cliente deve tratar

| Situação | HTTP | `error.code` | O que fazer |
|---|---|---|---|
| Sem chave / chave errada | 401 | `authentication_required` / `unauthorized` | corrigir a chave; **não** tentar outro modelo |
| Modelo de custo pago bloqueado | 402 | `cost_blocked` | avisar o usuário; liberar exige política explícita |
| Capacidade não disponível | 503 | `no_candidate_available` | dizer que a capacidade não está disponível |
| Capacidade especial sem modelo aprovado | 503 | `capability_unavailable` | explicar o que falta aprovar no catálogo |
| Provedor fora / timeout | 502 | `upstream_*` / `engine_timeout` | o Gateway já tentou o fallback; informar indisponibilidade |
| Pedido inválido | 400 | `invalid_*` | corrigir o pedido; nunca repetir igual |

Regra de ouro para o cliente: **nunca** transformar `cost_blocked`,
`capability_unavailable` ou `authentication_required` em "o modelo não quis
responder". São coisas diferentes e o usuário tem direito à diferença.

## Roteamento: o que muda para o Tama IA

Com `KIRANA_ROUTING` desligado (padrão), nada muda: o Gateway executa o modelo
pedido, sem fallback. É o modo de compatibilidade.

Com `KIRANA_ROUTING=on`:

- o primário (`KIRANA_PRIMARY_MODEL`) é preservado; não há troca por preferência;
- fallback (`KIRANA_FALLBACK_MODEL`) só entra em falha de infraestrutura, uma vez;
- capacidade especializada só é usada se estiver **aprovada por teste** no catálogo;
- modelo pago é bloqueado por padrão;
- toda decisão fica registrada em `/v1/runs`.

## Prova com modelo real (pendente, e o que ela exige)

A bateria pronta é `tools/quality-suite.mjs`. Ela mede, por tarefa, o que é
verificável por código: resposta em pt-BR com tamanho plausível, cálculo exato,
passos numerados, função pedida com agregação, chamada de ferramenta correta,
JSON com as chaves exigidas. Qualidade subjetiva do texto fica explicitamente
como `nao_avaliada` — quem julga isso é uma pessoa lendo a saída.

```bash
# 1) Gateway no ar e autenticado (SIWC consentido no navegador)
npm start

# 2) descobre o slug real
curl -s -H "Authorization: Bearer $GATEWAY_API_KEY" http://127.0.0.1:1455/v1/models

# 3) roda a bateria contra o modelo real
GATEWAY_API_KEY=... node tools/quality-suite.mjs \
    --url http://127.0.0.1:1455 --model <slug> --out resultados-qualidade.json
```

Sem SIWC, a bateria termina com código 2 e escreve "Suíte NÃO executada".
Ela **nunca** produz nota sem resposta do provedor. Para conferir que o próprio
harness funciona (sem provedor), existe `--mock`, que marca o relatório como
`modo: "mock"` — prova o instrumento, não o modelo.

Interpretação de imagem fica `nao_aplicavel` enquanto nenhum modelo tiver
`images.analyze: "tested"` no catálogo. Isso é intencional: o `gpt-5` já foi
reprovado nessa capacidade na experiência do usuário.

## Pendências que dependem de decisão humana

1. **Acesso a partir do Android.** Hoje o Gateway escuta apenas em `127.0.0.1` e
   `src/main.js` recusa host não-loopback. Para o celular usar o Gateway, a
   proposta é manter o Gateway em loopback e criar a ponte `/api/gateway/*` na
   Kirana (que já escuta em `:3000`), **sem** expor o Gateway à rede. As portas
   1455 e 3000 não mudam. Aguarda aprovação; nada foi alterado.
2. **Prova com modelo real** (acima): exige consentimento SIWC.
3. **Google Drive**: a integração não tem credencial verificada nesta linha de
   trabalho; qualquer afirmação de "Drive funcionando" sem isso seria simulação.
