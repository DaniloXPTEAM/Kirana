# TAMA — T03/B0 — BLOQUEIO SIWC

**Data:** 30/10/2026 · **Pacote:** REV3, SHA-256 `3081caf4a5c1c86c1743240f8159a1eeb2b34b19fe1837a24d72041b43d97882`
**Tarefa:** T03/B0 — descobrir e validar capacidades reais dos modelos
**Veredito desta etapa:** **BLOQUEADO** — a dependência é única e não é técnica do produto: **falta o consentimento SIWC da conta, que só o proprietário pode dar no Windows dele.**

Este documento **não** repete a inspeção da REV3. Ele traz o estado medido agora, a ação mínima no Windows,
como reconhecer sucesso ou falha, e o que já está pronto para rodar no segundo em que a conta autorizar.

---

## 1. Estado atual (medido, não presumido)

Execução de hoje contra o Gateway real em `127.0.0.1:1455`:

```
PASS      0.1  /health ................................ HTTP 200 · 60 ms
PASS      0.2  /v1/engine ......... version=0.4.1 · authenticated=false · catálogo=0 · routing=false · primário=null
PASS      0.4  /auth/status ....... authenticated=false · armazenamento=memory-only · escopos=(nenhum)
PASS      0.5  /v1/capabilities ... 11 declaradas · prontas: files.create, files.upload, files.download
                                    não prontas: text.chat, images.*, video.*, audio.*
BLOQUEADO 0.3  conta autorizada (SIWC) — authenticated=false
BLOQUEADO 1.1  catálogo real — 401 authentication_required · 4 ms
PASS      6.1  nenhum segredo nos logs — 4 arquivos · 0 ocorrências
```

Isso localiza o bloqueio com precisão: **o Gateway está inteiro; o que não está pronto é `text.chat`**, e a
própria API declara isso (`ready:false` + `requires_authentication:true`). Não é defeito de rota, de chave
local nem de rede.

| Pergunta | Resposta de hoje |
|---|---|
| Gateway instalado e respondendo? | **sim** (`/health` 200, sem precisar de reinstall) |
| Chave local válida? | **sim** (as rotas autenticadas respondem — só o SIWC barra) |
| Serviços no ar? | **sim** |
| Sessão SIWC ativa? | **não** (`authenticated:false`, escopos vazios) |
| Ação mínima necessária | **um login** em `http://127.0.0.1:1455/auth/start` |

## 2. Ação específica no Windows (Claude Code ou proprietário)

> Regra: **não reinstalar** se já existe. O objetivo é uma única coisa — autorizar a conta.

```powershell
# 1) O Gateway já está instalado? (não instale se responder 200)
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:1455/health

# 2) Se NÃO responder, suba a instalação existente (não use INSTALAR de novo):
.\INICIAR-TUDO.cmd

# 3) Ver o estado SEM abrir navegador e SEM imprimir a chave:
#    (usa a chave do Gateway/.env apenas localmente)
$k = (Select-String -Path .\Gateway\.env -Pattern '^GATEWAY_API_KEY=(.+)$').Matches[0].Groups[1].Value
curl.exe -s -H "Authorization: Bearer $k" http://127.0.0.1:1455/auth/status
#    esperado hoje: {"authenticated":false, ...}

# 4) AUTORIZAR (passo humano: o login é seu, na sua conta)
start http://127.0.0.1:1455/auth/start
#    -> clicar em "Continue with ChatGPT"
#    -> concluir o login na janela do provedor
#    -> a página final diz "ChatGPT connected"

# 5) Confirmar o mesmo endpoint de novo — deve virar true:
curl.exe -s -H "Authorization: Bearer $k" http://127.0.0.1:1455/auth/status
#    esperado: {"authenticated":true, "grantedScopes":[...], "tokenStorage":"memory-only"}
```

**Nada além disso.** Não copiar sessão de outro perfil, não reaproveitar token de máquina diferente, não
pedir senha a ninguém: o Gateway nunca vê senha, só o consentimento OAuth.

### 2.1 Teste único de "está autenticado?" (sem segredo nenhum)

```
curl.exe -s http://127.0.0.1:1455/health
```

`/health` é público e já informa `authenticated`. Hoje: `{"status":"ok","authenticated":false,...}`.
Depois do login: `authenticated:true`. **Esse é o sinal de sucesso mais simples e não expõe chave.**

## 3. Procedimento seguro (regras que o executor deve seguir)

1. Rodar **na máquina do proprietário**, com a pasta da Kirana extraída.
2. **Não** rodar `INSTALAR-WINDOWS.cmd` de novo se `/health` já responde — evita reescrita de `.env` e backup desnecessário.
3. **Não** colar a chave em chat, issue, print ou log. Os comandos acima a mantêm em variável de sessão.
4. **Não** abrir porta, Funnel, ngrok ou qualquer exposição. O Gateway fica em `127.0.0.1:1455`.
5. **Não** habilitar fallback nem modelo pago. O `.env` de fábrica vem com **roteamento desligado** (`routing_enabled:false`) e política `plan-only` — manter assim até haver decisão de custo.
6. **Importante:** a sessão é **memory-only**. Se o Gateway reiniciar, `authenticated` volta a `false` e é preciso logar outra vez. Ordem correta: subir → autorizar → validar → só então qualquer outra coisa.

## 4. Evidência esperada após autenticar

Rodar **um** comando (já disponível, sem dependências):

```powershell
VALIDAR-MODELOS-REAIS.cmd
```

Ele executa V00 e, se a conta estiver autorizada, segue automaticamente para V01/V03 e escreve:

| Arquivo | Conteúdo |
|---|---|
| `docs\validacao\GATEWAY_REV3_VALIDACAO_MODELOS_REAIS.md` | catálogo real, inferência, streaming, cancelamento, erros, latência, tokens, pendências |
| `docs\validacao\GATEWAY_REV3_MATRIZ_MODELOS_E_STREAMING.md` | um modelo por linha, com veredito |

Exemplo do que deve aparecer (formato real, preenchido pelo próprio script — não escrito à mão):

```
PASS   0.3  conta autorizada (SIWC) — authenticated=true
PASS   1.1  catálogo real obtido — N modelo(s): <ids reais>
PASS   2.1  inferência real (<modelo>) — HTTP 200 · <ms> · finish=stop · tokens=<p>/<c>/<t> · resposta="..."
PASS   3.1  streaming SSE real — ct=text/event-stream · 1º byte <ms> · último <ms> · N deltas · [DONE]=true
PASS   4.1  cancelamento não derruba o Gateway
PASS   5.1  erros diferenciados (não um 500 genérico)
PASS   6.1  nenhum segredo nos logs
```

Com esse arquivo em mãos, T03/B0 fecha: catálogo, identidade do modelo, resposta real, streaming real,
latência, tokens e erros ficam todos comprovados por execução — sem eu precisar de acesso à sua máquina.

## 5. Como reconhecer sucesso e como reconhecer falha

| Sinal | Significado | O que fazer |
|---|---|---|
| `/health` → `authenticated:true` | login concluído | rodar `VALIDAR-MODELOS-REAIS.cmd` |
| `/health` → `authenticated:false` | login não concluído ou Gateway reiniciado | refazer o passo 4 |
| `/v1/models` → `401 authentication_required` | chave local **ok**, SIWC ausente | autorizar (não é defeito) |
| `/v1/models` → `401 invalid_api_key` | chave local divergente entre os dois `.env` | `INSTALAR-WINDOWS.cmd` (ele realinha) |
| `/v1/models` → 200 com lista | catálogo real disponível | seguir para inferência |
| `/v1/models` → 200 com lista **vazia** | conta autorizada, mas sem catálogo declarado | registrar; **não** inventar modelo |
| `/auth/status` → `grantedScopes` vazio após login | consentimento incompleto | refazer o login e aceitar as permissões |
| `VALIDAR-MODELOS-REAIS.cmd` sai com **3** | BLOQUEADO — ainda sem SIWC | repetir o passo 4 |
| sai com **1** | algum FAIL real | guardar a saída; é defeito, não bloqueio |
| sai com **0** | T03/B0 validado | enviar os dois `.md` |

## 6. Como evitar vazamento de segredos

- **Não** imprimir `GATEWAY_API_KEY`, `KIRANA_ACCESS_TOKEN` nem `KIRANA_BRIDGE_TOKEN` em relatório, print ou chat. O verificador lê a chave do `.env` e **nunca** a escreve.
- O script tem uma checagem própria: varre `run\*.log` e `Gateway\run\*.log` procurando a chave e os tokens; hoje: **0 ocorrências em 4 arquivos**.
- Ao compartilhar a saída de `curl`, use só `/health` (público). Para os demais endpoints, mande o arquivo gerado pelo verificador — ele já é sanitizado.
- Se precisar mostrar a chave para conferir alinhamento, compare só o **tamanho** e os 3 primeiros caracteres, nunca o valor.
- Nada de `set` ou `env` em print (mostra tudo). Se usar `$k`, não faça `echo $k`.
- Prompt de teste é fixo e sintético: `Responda apenas com a palavra: ok` — **nenhum dado pessoal** vai ao provedor.

## 7. Custo desta validação

- Máximo **2 requisições** de inferência por execução (uma `stream:false`, uma `stream:true`), `max_tokens=16`.
- Nenhum laço, nenhuma bateria extensa, nenhum modelo pago.
- `--catalogo` lista os modelos e **não gasta token** — use primeiro se quiser só descobrir o catálogo.
- Fallback permanece **desligado**; nada aqui ativa cobrança.

## 8. O que fica bloqueado até o login (e o que já está provado)

| Item | Estado |
|---|---|
| V00 — `/health`, `/v1/engine`, `/auth/status`, `/v1/capabilities` | **PASS** (executado hoje) |
| V00 — `/v1/models` (catálogo real) | **BLOQUEADO** (SIWC) |
| V01 — inferência real | **BLOQUEADO** |
| V03 — streaming real com modelo | **BLOQUEADO** (o SSE da **ponte** com gateway simulado está PASS e **não** conta como este) |
| V06/V07/V08/V10/V11/V30 — plano, ferramentas, recuperação, consolidação, erros, identidade | **BLOQUEADO** (dependem de um modelo autorizado) |
| Mapa papel→modelo, fallback, custos reais | **BLOQUEADO** |
| Transporte HTTP, ponte, autenticação local, rotas fechadas, segredos em log | **PASS** (etapas anteriores) |

## 9. Próxima ação recomendada (uma só)

No Windows, com a pasta da Kirana: **abrir `http://127.0.0.1:1455/auth/start`, concluir o login e rodar
`VALIDAR-MODELOS-REAIS.cmd`**. O `.md` gerado é a entrega de T03/B0.

Se o login não for possível na máquina (ex.: bloqueio de política da conta), me diga **qual mensagem** aparece
na tela de retorno — a partir dela eu digo se é escopo, expiração ou registro do cliente OAuth, sem precisar
de nenhum segredo seu.
