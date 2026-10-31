# GATEWAY REV3 — STATUS DO ACESSO PRIVADO

**Data:** 30/10/2026
**Escopo:** Etapa 6 do handoff (acesso privado via Tailscale) — **conferência do que existe**, sem instalar, sem autenticar conta, sem publicar nada.

---

## 1. Veredito curto

| Item | Estado |
|---|---|
| Tailscale instalado/conectado **neste ambiente** | **NOT RUN** — não existe aqui (`tailscale`/`tailscaled` ausentes, sem socket) |
| Tailscale no ambiente do proprietário | **NOT RUN** — depende da sua máquina |
| `tailscale serve` publicado | **NOT RUN** |
| HTTPS `.ts.net` | **NOT RUN** — nenhum hostname/certificado foi inventado |
| Funnel desligado | **NOT RUN** (verificação existe e é somente leitura) |
| Documentação e scripts do pacote | **PASS** (conferidos linha a linha) |
| Procedimento de rollback | **GAP ENCONTRADO** — o pacote não documenta como desfazer o Serve. Ver §5 |
| Gateway continua em loopback | **PASS** (configuração e validação de start) |
| Ponte desligada por padrão | **PASS** (`KIRANA_BRIDGE=off` no `.env` gerado) |

> Não há nenhuma evidência de conectividade remota real. Este documento **não** declara acesso privado concluído.

---

## 2. O que existe no pacote (conferido)

| Artefato | O que faz | Somente leitura? |
|---|---|---|
| `Kirana/docs/ACESSO-REMOTO-TAILSCALE.md` | roteiro completo em 4 etapas (instalar, autenticar, preparar Kirana, autorizar celular) | é doc |
| `Kirana/windows/Verificar-Tailscale.ps1` | diagnostica instalação, conexão, DNS privado, Serve, Funnel e portas em escuta | **sim** — não instala nem altera |
| `Kirana/windows/Preparar-AcessoRemoto.ps1` | faz backup do `.env` (com SHA-256), completa tokens, confere serviços e aplica `tailscale serve --bg 3000` | não — altera `.env` e o Serve |
| `Kirana/tools/testar-remoto.mjs` | testa o caminho remoto **do celular**: alcance, ponte, token, rota fechada, Gateway, catálogo, streaming | sim |
| `Kirana/tools/simular-tailscale-serve.mjs` | simulador do Serve para exercitar a ponte em loopback | sim |

### 2.1 Verificações de segurança já embutidas

Conferidas no código (`Kirana/src/config.js:271–296`), todas **fail-fast no start**:

- `KIRANA_BRIDGE=on` sem `KIRANA_BRIDGE_TOKEN` (32+) → o servidor **não sobe**;
- `KIRANA_BRIDGE_REQUIRE_HTTPS=on` sem `TRUST_PROXY=on` → não sobe (ninguém provaria HTTPS);
- `TRUST_PROXY=on` **sem** `KIRANA_ACCESS_TOKEN` → não sobe (`/api/sessions` e `/api/memory` ficariam abertos no tailnet);
- `KIRANA_HOST` fora do loopback com a ponte ligada e sem `KIRANA_ACCESS_TOKEN` → não sobe.

No atendimento, a ponte ainda: exige token próprio, recusa rota fora da lista, exige HTTPS quando configurado, limita requisições por origem e **não aceita destino escolhido pelo cliente**.

---

## 3. Ordem correta (quando você autorizar, na sua máquina)

```powershell
# 1. diagnostico, sem alterar nada
.\windows\Verificar-Tailscale.ps1

# 2. se aparecer "NAO instalado" (instalação e login sao seus)
winget install --id tailscale.tailscale -e
# abrir o app Tailscale -> Log in (mesma conta que sera usada no celular)

# 3. no admin console (https://login.tailscale.com/admin):
#    DNS -> MagicDNS ligado
#    DNS -> HTTPS Certificates ligado

# 4. preparar a Kirana (faz backup do .env e imprime o SHA-256)
.\windows\Preparar-AcessoRemoto.ps1
.\windows\Preparar-AcessoRemoto.ps1 -AplicarServe

# 5. conferir o que foi publicado
tailscale serve status
tailscale funnel status     # DEVE estar vazio

# 6. reiniciar a Kirana para pegar as variaveis novas
.\PARAR-TUDO.cmd
.\INICIAR-TUDO.cmd
```

Do celular (mesma conta no app Tailscale):

```bash
node testar-remoto.mjs --url https://SEU-PC.SEU-TAILNET.ts.net --token <KIRANA_BRIDGE_TOKEN>
```

O `testar-remoto.mjs` reporta honestamente: se o Gateway não estiver autorizado (SIWC), ele diz que a
conversa **não** foi validada em vez de fingir sucesso.

---

## 4. Pré-condições que ainda faltam (não são defeito)

1. **SIWC autorizado** — sem isso, a rota funciona mas o modelo responde 401. Ver
   `GATEWAY_REV3_VALIDACAO_MODELOS_REAIS.md`.
2. **Sessão do Gateway é memory-only**: reiniciar o Gateway derruba a autorização. Ordem certa:
   `INICIAR-TUDO.cmd` → `/auth/start` → validar → **só então** o teste remoto.
3. **O computador precisa ficar ligado e conectado** — ele é o host. Nada disso funciona com o PC
   dormindo/suspenso.

---

## 5. GAP encontrado: falta o procedimento de rollback

O handoff pede explicitamente "procedimento de rollback" (§12.3) e o pacote **não o documenta** —
`Preparar-AcessoRemoto.ps1` faz backup do `.env`, mas não há instruções para desfazer o `tailscale serve`.
Registro o gap e o procedimento aqui (sem alterar o produto, para não mudar o hash da REV3):

```powershell
# desfazer o Serve (volta a nao publicar nada no tailnet)
tailscale serve reset

# conferir que nao sobrou nada
tailscale serve status      # deve dizer "No serve config"
tailscale funnel status     # deve dizer "No funnel config"

# desligar a ponte da Kirana (editar .env)
#   KIRANA_BRIDGE=off
#   KIRANA_BRIDGE_REQUIRE_HTTPS=off
#   KIRANA_BRIDGE_TRUST_PROXY=off
.\PARAR-TUDO.cmd
.\INICIAR-TUDO.cmd

# restaurar o .env anterior, se quiser voltar exatamente ao estado de antes
Copy-Item .\Kirana\backups\.env.<data>.bak .\Kirana\.env -Force
```

Desinstalar o Tailscale do PC, se quiser remover de vez: `winget uninstall tailscale.tailscale`.

**Recomendação:** quando o produto for mexido de novo (fora desta etapa), incluir essa seção em
`Kirana/docs/ACESSO-REMOTO-TAILSCALE.md`. Não fiz agora porque o handoff proíbe alterar componentes
sem defeito demonstrado, e o ZIP REV3 deve permanecer com o mesmo SHA-256.

---

## 6. Evidências desta etapa

| Evidência | Onde |
|---|---|
| `tailscale` ausente neste ambiente | `command -v tailscale` → vazio; `/var/run/tailscale` → inexistente |
| Scripts e doc conferidos | leitura de `windows/Verificar-Tailscale.ps1`, `windows/Preparar-AcessoRemoto.ps1`, `docs/ACESSO-REMOTO-TAILSCALE.md` |
| Gateway em loopback | `ss -ltnp` mostrando `127.0.0.1:1455` e recusa de bind não-loopback no `main.js` |
| Ponte desligada por padrão | `.env` gerado pelo instalador: `KIRANA_BRIDGE=off` |
| Nenhuma publicação feita | nada foi instalado, autenticado, publicado ou exposto nesta etapa |
