# Ponte do Gateway — usar o motor pelo celular sem expor o Gateway

**Estado: implementado e provado (12 testes novos; suíte da Kirana 518/518). Também verificado de ponta a ponta com o Gateway v0.4.1 real em loopback. Nenhum modelo real foi executado — falta o consentimento SIWC.**

## O problema

O Gateway escuta **só** em `127.0.0.1` e recusa bind não-loopback de propósito: ele guarda a sessão do
ChatGPT na memória do processo. O celular, no mesmo Wi-Fi, não alcança `127.0.0.1` do PC.

A solução errada seria abrir o Gateway na rede — ele passaria a aceitar pedidos de qualquer aparelho
na rede (ou de quem entrasse nela), gastando o plano de quem paga a conta.

## A solução

```
celular ──HTTP──► Kirana :3000 ──HTTP loopback──► Gateway :1455
                  /api/gateway/*                  (inalcançável pela rede)
```

O Gateway **não muda**: continua em loopback, na porta 1455. A Kirana (porta 3000, que já serve a
interface) faz o repasse. Portas 1455 e 3000 inalteradas.

## Rotas expostas (lista fechada)

| Método | Rota | Para quê |
|---|---|---|
| GET | `/api/gateway/health` | saber se o Gateway está no ar |
| GET | `/api/gateway/v1/models` | descobrir o slug real do modelo |
| GET | `/api/gateway/v1/engine` | política do motor + identidade observada |
| GET | `/api/gateway/v1/runs` | histórico de execuções (metadados) |
| GET | `/api/gateway/v1/runs/:id` | uma execução |
| POST | `/api/gateway/v1/chat/completions` | conversar (SSE passa direto, sem buffer) |
| GET | `/api/gateway/ping` | diagnóstico da própria ponte |

Qualquer outra coisa responde `404 bridge_route_not_exposed` — a ponte **não** é proxy genérico.
`/v1/files`, `/auth/*` e `/v1/images/*` ficam de fora.

## Como ligar

```bash
# .env da Kirana
KIRANA_HOST=0.0.0.0                      # para o celular alcançar o PC
KIRANA_ACCESS_TOKEN=<32+ caracteres>     # obrigatório fora do loopback
KIRANA_BRIDGE=on
KIRANA_BRIDGE_TOKEN=<32+ caracteres>     # token SÓ da ponte
KIRANA_GATEWAY_API_KEY=<chave do Gateway>
```

Gerar os tokens:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Chamar do celular (ou de qualquer cliente):

```bash
curl -H "Authorization: Bearer $KIRANA_BRIDGE_TOKEN" \
     http://192.168.0.10:3000/api/gateway/v1/models
```

```bash
curl -N -H "Authorization: Bearer $KIRANA_BRIDGE_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"model":"<slug real>","stream":true,"messages":[{"role":"user","content":"Oi"}]}' \
     http://192.168.0.10:3000/api/gateway/v1/chat/completions
```

## Segurança

- **Desligada por padrão.** Só existe com `KIRANA_BRIDGE=on`.
- **Sem token, não atende ninguém** (`403 bridge_not_configured`). Não existe "modo aberto".
- **Token próprio**, comparado em tempo constante e separado do token da Kirana: um aparelho pode
  receber só acesso ao motor, sem acesso a `/api/sessions` e `/api/memory`.
- **O servidor não sobe** se `KIRANA_HOST` sair do loopback com a ponte ligada e sem
  `KIRANA_ACCESS_TOKEN`. Sem isso, abrir a rede exporia as conversas de todo mundo.
- **A chave do Gateway nunca sai do backend**: o cliente autentica na ponte, a ponte autentica no
  Gateway. Ela não aparece em corpo, cabeçalho ou log (o logger já a redige).
- **Limite por origem** (`KIRANA_BRIDGE_RATE_MAX`, padrão 30/min): celular não vira laço de gasto.
- Se o celular fechar a conexão, o pedido ao Gateway é abortado — o PC para de gerar tokens.
- Se o Gateway cair, a resposta é `502 gateway_unreachable`; se demorar demais,
  `504 gateway_timeout`. Nunca uma resposta inventada.

## O que continua fora do alcance disto

- **Firewall/roteador**: pode ser preciso liberar a porta 3000 no Windows e no roteador. Isso é
  ambiente, não código — não foi tocado.
- **Wi-Fi público**: com `KIRANA_HOST=0.0.0.0`, qualquer aparelho na mesma rede vê a porta 3000.
  O token protege a API, mas a recomendação é usar em rede doméstica confiável.
- **Uso pela internet**: exigiria TLS e proxy reverso. Fora de escopo.
- **Modelo real**: a ponte só repassa. Se o Gateway não estiver autorizado (SIWC), ela responde
  `401 authentication_required` — e isso é a verdade, não um defeito da ponte.

## Verificação executada

| Verificação | Resultado |
|---|---|
| `node --test test/gateway-bridge.test.js` | **12/12** |
| Suíte completa da Kirana | **518/518** (506 anteriores + 12) |
| Ponta a ponta com Gateway v0.4.1 real | `GET /api/gateway/v1/engine` devolveu o retrato real (v0.4.1, `timeout_ms: 180000`, `plan-only`) |
| `GET /api/gateway/v1/models` sem SIWC | **401 `authentication_required`** — recusou, não inventou |
| Rota fora da lista | **404 `bridge_route_not_exposed`** |
| Sem token da ponte | **401** |
| Bind do Gateway | `127.0.0.1:1455` apenas |
