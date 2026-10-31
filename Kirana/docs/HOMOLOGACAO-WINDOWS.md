# Homologação no Windows — roteiro e critérios

**Objetivo:** provar, com o **Gateway real** e o seu modelo, que a integração
funciona de ponta a ponta. É o único teste que fecha o critério "sem mocks".

> **Por que eu não posso rodar isto por você:** a Arena não acessa o seu Windows
> (`C:`, `P:`), a conta ChatGPT é sua e o fluxo de autorização do Gateway é
> loopback do **seu** navegador. Tudo o que dá para preparar está aqui — os
> scripts medem e gravam; eu leio os arquivos e digo o veredito.

---

## 0. Antes de começar (5 minutos)

1. **Gateway ligado**, na janela dele, com a conta autorizada:
   `http://127.0.0.1:1455/health` deve mostrar `"authenticated": true`.
   Se estiver `false`, abra `http://127.0.0.1:1455/auth/start` e conclua o
   consentimento. Os tokens ficam em memória: **cada reinício do Gateway exige
   reautorizar**.
2. **`.env` da Kirana** com `KIRANA_GATEWAY_API_KEY` = a `GATEWAY_API_KEY` do
   `.env` do Gateway (mesma string, nome diferente).
3. **Dependências instaladas** na pasta da Kirana:
   `corepack pnpm install --frozen-lockfile`.
4. **Nada disso muda o Gateway** — os scripts só fazem GET/POST de leitura no
   contrato dele, e o `homologar.bat` não reinicia nem reconfigura nada.

---

## 1. Passo a passo

```bat
cd C:\caminho\da\kirana

rem (1) contrato do Gateway real — read-only, não gasta uso da conta
verificar-gateway.bat

rem (2) homologação completa (doctor + preflight com 2 chamadas + suíte + contrato + conversa real)
homologar.bat

rem (3) o mesmo, incluindo as 4 suítes de navegador (Playwright)
homologar.bat --full
```

Tudo é gravado em `C:\caminho\da\kirana\homologacao\`.
**Nesses arquivos não há chave do Gateway, token de acesso nem credencial OAuth**
— pode enviar sem medo. (O preflight imprime só "chave: presente (N caracteres)".)

---

## 2. O que cada etapa prova

| Etapa | Arquivo gerado | Prova |
|---|---|---|
| 1 | `etapa1-doctor.txt` | Node, `.env`, chave, porta, estado da voz |
| 2 | `etapa2-preflight.txt` + `.json` | `/health`, `/auth/status`, `/v1/models`, `/v1/capabilities`, rigor de payload, **streaming com ferramenta (`gateway.<nome>`)** e round-trip `role:"tool"` |
| 3 | `etapa3-testes.txt` | 449 testes automatizados (gateway simulado) |
| 4 | `etapa4-contrato.txt` | nenhum campo fora do contrato enviado ao Gateway |
| 5 | `etapa5-conversa.txt` + `conversa-*.json` | conversa real de 4 turnos |
| 6 | `etapa6-navegador.txt` | 67 verificações de navegador (instância temporária na porta 3055) |
| — | `homologacao-*.txt` | relatório consolidado |

### Os 4 turnos da conversa real (etapa 5)

| Turno | Pergunta | Precisa acontecer |
|---|---|---|
| `catalogo` | "Quais serviços a Opportunity AI oferece?" | `list_services` executa **ok**, com os serviços reais; **nenhum `unknown_tool`** |
| `contexto` | "Em que página eu estou e o que ela explica?" | `explain_current_page` executa com o estado do site |
| `requisitos` | "O que eu preciso enviar para solicitar o atendimento digital?" | usa as ferramentas da Fase 5, sem inventar exigência |
| `busca-web` | "Pesquise na internet… me traga notícias" | **não** promete pesquisa; explica a limitação e oferece o caminho real |

O script reprova automaticamente: `unknown_tool` em ferramenta registrada,
ferramenta dizendo `ok` sem dado, falha sem código de erro, resposta vazia e
promessa de pesquisa web.

---

## 3. Critérios de aprovação (todos obrigatórios)

- [ ] `verificar-gateway.bat` termina com **RESULTADO: APROVADO**.
- [ ] Etapa 5 termina com **RESULTADO: APROVADO** (4 turnos, 0 falhas).
- [ ] Etapa 3: `# fail 0` e `# pass 449`.
- [ ] Etapa 4: **0 violações** de contrato.
- [ ] Etapa 6 (`--full`): 15/15 + 18/18 + 8/8 + 26/26.
- [ ] Na tela, ao perguntar os serviços: a pílula mostra **`Listar soluções · ok`**
      (verde) e **não** aparece `gateway.` em lugar nenhum.
- [ ] Ao pedir pesquisa web: pílula **vermelha** com motivo, e o texto explica a
      limitação.

## 4. Se algo falhar (o que cada erro significa)

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `[XX] GET /health não respondeu` | Gateway desligado ou `KIRANA_GATEWAY_URL` errado | abrir a janela do Gateway; conferir a porta |
| `authenticated=false` | sessão OAuth caiu (reinício do Gateway) | `/auth/start` de novo |
| `401 invalid_api_key` | `KIRANA_GATEWAY_API_KEY` ≠ `GATEWAY_API_KEY` | copiar de novo, sem espaços |
| `O modelo primário "X" não está nesta conta` | slug mudou | usar um dos slugs listados pelo próprio preflight em `KIRANA_PRIMARY_MODEL` |
| `429 rate_limit` | plano/limite do ChatGPT | esperar; o preflight diz que o Gateway preservou o 429 |
| `unknown_tool` na conversa | regressão da normalização | me envie `conversa-*.json`: o nome exato da ferramenta está lá |
| pílula verde com resposta de falha | regressão da interface | me envie um print + o `.json` da etapa 5 |
| navegador 0/1 | porta ocupada (3055) ou Playwright sem navegador | fechar a janela do Node da etapa 6; `npx playwright install chromium` |

## 5. Depois de rodar

Envie de volta:

1. `homologacao\homologacao-*.txt` (relatório consolidado);
2. `homologacao\etapa2-preflight.json`;
3. `homologacao\conversa-*.json`;
4. um print da tela com a resposta dos serviços (mostra a pílula).

Com isso eu digo, com evidência, se a integração está concluída — e só então
faz sentido falar de push, tag `v0.5.2` e publicação no site.

> **Nota honesta:** a suíte completa (455 testes) e as 67 verificações de
> navegador foram executadas aqui contra o gateway **simulado** — inclusive na
> variante `--namespaced`, que imita o nome `gateway.<nome>` do Gateway real. Isso
> prova a correção do código; **não** prova o seu Gateway, a sua conta e o seu
> modelo. Essa parte é a homologação acima.
