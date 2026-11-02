# Acesso remoto privado do Tama IA ao Gateway Kirana (Tailscale Serve)

**Estado: preparado e testado até onde este ambiente permite. O acesso remoto NÃO foi validado no celular — essa é a última etapa e depende do seu Xiaomi.**

## Arquitetura

```
Tama IA (Xiaomi)
      │  rede móvel ou qualquer Wi-Fi
      ▼
Tailscale  (WireGuard, privado, criptografado)
      │
      ▼
tailscale serve  ──  HTTPS com certificado *.ts.net, SÓ dentro do tailnet
      │  entrega em 127.0.0.1
      ▼
Kirana :3000  ──  ponte /api/gateway/*  (token próprio, lista fechada de rotas)
      │  loopback
      ▼
Gateway 127.0.0.1:1455  ──  modelos, SIWC, motor
```

O que **não** muda: modelos, autenticação do Gateway, portas 1455 e 3000, o código do Gateway.
O que **não** existe: porta aberta no roteador, Funnel, exposição pública, `0.0.0.0`.

Por que Serve e não Funnel: `serve` só responde a aparelhos do seu tailnet. `funnel` publica na
internet aberta — exatamente o que não queremos. O script de verificação denuncia Funnel ligado.

---

## Etapa 1 — Descobrir se o Tailscale já está no Windows

Na pasta da Kirana, no PowerShell:

```powershell
.\windows\Verificar-Tailscale.ps1
```

O script é **somente leitura**: não instala, não autentica, não altera nada. Ele responde:

- está instalado? qual versão?
- está conectado? qual o nome DNS privado (`algo.tailnet-xyz.ts.net`)?
- quantos aparelhos estão no tailnet e quais estão online?
- o Serve já está configurado? o **Funnel** está ligado (não deve estar)?
- portas 3000/1455/443 em escuta?

Se aparecer `NAO instalado`:

```powershell
winget install --id tailscale.tailscale -e
# ou: https://tailscale.com/download/windows
```

Você instala e faz login — eu não tenho acesso à sua máquina, e o login é seu.

---

## Etapa 2 — Autenticar (sua participação)

1. Abra o app **Tailscale** no Windows → **Log in**.
2. Entre com Google/Microsoft/GitHub ou e-mail. Qualquer provedor serve, desde que seja **a mesma
   conta** que você usará no celular.
3. No **admin console** (`https://login.tailscale.com/admin`):
   - **DNS** → habilite **MagicDNS**;
   - **DNS** → habilite **HTTPS Certificates** (o Serve precisa emitir o certificado `.ts.net`).
   - (Recomendado) **Settings** → desative a expiração de chaves para este PC, para o acesso não
     cair sozinho a cada 180 dias.

Esses dois interruptores do admin console são permissões da sua conta: só você pode ligar.

---

## Etapa 3 — Preparar a Kirana (eu já deixei pronto; o script aplica)

```powershell
.\windows\Preparar-AcessoRemoto.ps1               # mostra o que vai fazer e faz backup do .env
.\windows\Preparar-AcessoRemoto.ps1 -AplicarServe # aplica o `tailscale serve`
```

O script:

1. faz **backup do `.env`** em `backups/.env.<data>.bak` e imprime o SHA-256;
2. completa as variáveis da ponte (gerando tokens de 32 bytes se faltarem);
3. confere Gateway e Kirana no ar;
4. verifica o Tailscale e imprime o endereço HTTPS privado;
5. aplica `tailscale serve --bg 3000` (Serve, nunca Funnel).

Variáveis que ficam no `.env` da Kirana:

| Variável | Valor | Por quê |
|---|---|---|
| `KIRANA_HOST` | `127.0.0.1` | o Serve entrega em loopback; não precisa abrir na rede |
| `KIRANA_ACCESS_TOKEN` | 32+ chars | **obrigatório**: atrás do Serve, a Kirana fica alcançável do tailnet |
| `KIRANA_BRIDGE` | `on` | liga a ponte |
| `KIRANA_BRIDGE_TOKEN` | 32+ chars | token que o Tama IA apresenta (separado do token da Kirana) |
| `KIRANA_BRIDGE_REQUIRE_HTTPS` | `on` | recusa pedido sem HTTPS |
| `KIRANA_BRIDGE_TRUST_PROXY` | `on` | aceita `X-Forwarded-Proto`/`Tailscale-User-Login` do Serve |
| `KIRANA_BRIDGE_RATE_MAX` | `30` | pedidos/min **por identidade do tailnet** |

O servidor **não sobe** em combinações perigosas (falha no start, não em produção):

- `KIRANA_BRIDGE=on` sem `KIRANA_BRIDGE_TOKEN` → sem token a ponte não atenderia ninguém;
- `KIRANA_BRIDGE_REQUIRE_HTTPS=on` sem `TRUST_PROXY=on` → ninguém conseguiria provar HTTPS;
- `KIRANA_BRIDGE_TRUST_PROXY=on` **sem `KIRANA_ACCESS_TOKEN`** → atrás do Serve, `/api/sessions` e
  `/api/memory` ficariam legíveis por qualquer aparelho do tailnet.

Depois de aplicar, reinicie a Kirana (`node src/server.js`) e confira:

```powershell
tailscale serve status
# https://seu-pc.seu-tailnet.ts.net
#   |-- / proxy http://127.0.0.1:3000
```

---

## Etapa 4 — Instalar e autorizar o Xiaomi (sua participação)

1. Play Store → **Tailscale** → instalar.
2. Abrir → **Log in** → **a mesma conta** do PC.
3. O aparelho aparece no admin console como pendente → **autorize** (você aprova; é a permissão).
4. No app, confirme **Connected** e que o PC aparece online na lista.
5. **Teste pela rede móvel**: desligue o Wi-Fi e mantenha os dados móveis ligados. O Tailscale
   funciona sobre 4G/5G — não precisa do mesmo Wi-Fi, nem de USB, nem de cabo.

---

## Etapa 5 — Validar no celular (a prova real)

No celular, com o Tailscale conectado **e o Wi-Fi desligado**:

```bash
# Termux (ou qualquer shell Android):
curl -H "Authorization: Bearer SEU_KIRANA_BRIDGE_TOKEN" \
     https://seu-pc.seu-tailnet.ts.net/api/gateway/ping
```

Resposta esperada (trecho):

```json
{ "bridge": "on", "requireHttps": true,
  "request": { "https": true, "viaTailscale": true },
  "routes": ["GET /health", "GET /v1/models", "..." ] }
```

`viaTailscale: true` significa que o pedido passou pelo Serve — é a diferença entre "chegou por
algum lugar" e "chegou pelo caminho que planejamos".

Para o teste completo, com streaming e resposta real:

```bash
node testar-remoto.mjs --url https://seu-pc.seu-tailnet.ts.net --token SEU_TOKEN
```

O script verifica 7 etapas e termina com um dos três veredictos:

| Código | Significado |
|---|---|
| `0` | caminho remoto validado **incluindo resposta real do modelo** |
| `3` | transporte privado, autenticação e recusas OK, mas **sem SIWC** → resposta real não validada |
| `1` | alguma etapa falhou (a mensagem diz qual) |
| `4` | rodou contra o simulador em loopback (`--permitir-http-local`), só para exercitar o verificador |

O código `3` é o resultado mais provável na primeira execução, e ele **não** afirma que o acesso
remoto completo foi validado. Para chegar ao `0`, autorize o provedor na máquina da Kirana:
`http://127.0.0.1:1455/auth/start`.

---

## Segurança — o que protege o quê

| Camada | Protege contra | Como |
|---|---|---|
| Tailscale (WireGuard) | qualquer um fora do seu tailnet | chave por aparelho, sem porta aberta |
| Tailscale Serve (TLS) | interceptação no caminho | certificado real `*.ts.net`; a ponte recusa HTTP claro |
| Token da ponte | aparelho do tailnet sem permissão | 32+ caracteres, comparação em tempo constante |
| Lista fechada de rotas | uso da ponte como proxy | 6 rotas + `/ping`; resto dá 404 |
| Token da Kirana | leitura de conversas e memória | `/api/sessions` e `/api/memory` exigem `KIRANA_ACCESS_TOKEN` |
| Chave do Gateway | vazamento para o celular | fica só no backend; nunca sai na resposta |
| Limite por identidade | laço de gasto | 30/min por login do tailnet |
| Fail-closed | configuração errada passar batido | o servidor não sobe em combinação perigosa |

O que **não** está coberto e você deve saber:

- Quem entrar na sua conta Tailscale (ou autorizar um aparelho) contorna tudo isso. A conta é o
  perímetro. Use 2FA no provedor de login do Tailscale.
- O token da ponte, se colado em chat/e-mail, vale como senha. Ele está no `.env`; para trocar,
  gere outro e reinicie a Kirana.
- APK com token embutido é token público. Guarde em `EncryptedSharedPreferences`
  (ver `examples/android/TamaGatewayClient.kt`).
- O Gateway continua sem TLS próprio e sem bind na rede — de propósito. Não é para expor.

---

## O que foi verificado neste ambiente (e o que não foi)

| Verificação | Resultado |
|---|---|
| Suíte da Kirana | **518 → 525/525** (19 testes da ponte, incluindo o modo remoto) |
| `KIRANA_BRIDGE_REQUIRE_HTTPS=on` + pedido em HTTP claro | **403 `bridge_https_required`**, nada repassado |
| Cabeçalhos do Serve (`X-Forwarded-Proto`, `X-Forwarded-For`, `Tailscale-User-Login`) | aceitos como identidade; `ping` responde `https: true`, `viaTailscale: true` |
| Token da ponte ausente | **401** mesmo com cabeçalhos do tailnet |
| Rota fora da lista via Serve | **404 `bridge_route_not_exposed`** |
| Limite por identidade do tailnet | aparelho A estoura (429), aparelho B continua (200) |
| `/api/gateway/v1/engine` através do Serve simulado | retrato real do Gateway v0.4.1 |
| `/api/gateway/v1/chat/completions` sem SIWC | **401 `authentication_required`** repassado |
| `validateBridgeConfig` | falha no start nas três combinações perigosas |

**Não verificado, porque depende da sua máquina e do seu aparelho:**

- que o Tailscale está instalado no **seu** Windows (o script da Etapa 1 responde);
- que o Serve está emitindo certificado para o **seu** domínio `.ts.net`;
- que o **seu** Xiaomi alcança o PC pela rede móvel;
- resposta real de modelo (depende do SIWC);
- os scripts `.ps1` — escritos e revisados, mas **não executados** aqui (não há PowerShell nem
  Windows neste ambiente). Se der erro de sintaxe, me diga a linha e eu corrijo.

Enquanto a Etapa 5 não rodar no seu celular, a frase correta é: **"o caminho remoto está preparado
e testado em partes; a validação no aparelho está pendente"**.

---

## Se algo falhar

| Sintoma no celular | Causa provável | O que fazer |
|---|---|---|
| não resolve o domínio `.ts.net` | Tailscale desligado no celular | abrir o app e conectar |
| `403 bridge_https_required` | está usando `http://` ou um proxy claro | use o endereço `https://…ts.net` |
| `401 bridge_unauthorized` | token da ponte errado/ausente | copie `KIRANA_BRIDGE_TOKEN` do `.env` |
| `401 authentication_required` | Gateway sem SIWC | autorize em `127.0.0.1:1455/auth/start` na máquina |
| `404 bridge_route_not_exposed` | chamou rota fora da lista | use as 6 rotas documentadas |
| `429 bridge_rate_limited` | passou de 30/min | espere 1 minuto ou aumente `KIRANA_BRIDGE_RATE_MAX` |
| `502 gateway_unreachable` | Gateway caiu no PC | `.\windows\Start.ps1` |
| `504 gateway_timeout` | modelo demorou mais que o limite | tente de novo; veja `/api/gateway/v1/runs` |
| Serve responde 502 | Kirana caiu | `node src/server.js` na pasta da Kirana |
| certificado inválido | HTTPS Certificates desabilitado no admin | ligue em DNS → HTTPS Certificates |
