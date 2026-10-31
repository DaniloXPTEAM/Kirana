# TESTES E EVIDÊNCIAS — revisões 3, 4 e 4.1

Data: 29/10/2026 · Kirana **0.5.4** · Gateway **0.4.1**
Base: `Kirana-v0.5.4-REV2-…zip` (SHA-256 `da6d721a…023f`, conferido na extração)
Ambiente onde os testes rodaram: **Linux, Node v20.20.2, PowerShell 7.4.6 (pwsh)**
Ambiente alvo: **Windows 11 com Windows PowerShell 5.1**

Legenda: **PASSOU** · **FALHOU** · **NÃO TESTÁVEL NESTE AMBIENTE**

> Regra desta lista: nada é marcado PASSOU sem execução real. Windows PowerShell 5.1,
> SIWC, catálogo do plano, conversa completa, Tailscale e Android **não** rodaram aqui —
> estão na seção 7 com o comando exato para você fechar cada um.

---

## 1. Placar

| # | Bateria | Comando | Status | Números |
|---|---|---|---|---|
| 1 | Regressões da revisão 3 | `node tools\teste-revisao3.mjs` | **PASSOU** | 41/41 |
| 2 | Regressões da revisão 2 | `node tools\teste-revisao2.mjs` | **PASSOU** | 42/42 |
| 3 | Regressões da revisão 1 | `node tools\teste-correcoes.mjs` | **PASSOU** | 18/18 |
| 4 | Verificador, modo release | `node tools\verificar-pacote.mjs` | **PASSOU** | 41/41 (REV4 exige o verificador de modelos) |
| 5 | Verificador, modo instalação | `node tools\verificar-pacote.mjs --instalacao` | **PASSOU** | 44/44 |
| 6 | Wrappers `.cmd` | `node tools\teste-scripts.mjs` | **PASSOU** | 19/19 |
| 7 | Parser oficial do PowerShell | `[Parser]::ParseFile` nos 8 `.ps1` | **PASSOU** | 8/8, 0 erro |
| 8b | Testes do verificador (REV4.1) | `node tools\teste-verificador.mjs` | **PASSOU** | 14/14 |
| 8 | Suíte do Gateway | `cd Gateway && node --test test/*.test.js` | **PASSOU** | 76/76 |
| 9 | **Suíte da Kirana** | `cd Kirana && node --test test/*.test.js` | **PASSOU** | **531/531** (525 + 6 de integração desta revisão) |
| 10 | Instalação limpa | `scripts/Instalar.ps1` | **PASSOU** | etapas 1→8, sem `[X]` |
| 11 | Instalação repetida | `scripts/Instalar.ps1` (2ª vez) | **PASSOU** | chave, tokens, `hostId`, `data/` e backups preservados |
| 12 | Subir 2× na mesma pasta | `scripts/Iniciar-Tudo.ps1` | **PASSOU** | "propriedade comprovada … Nada a fazer" nas duas |
| 13 | Parar | `scripts/Parar-Tudo.ps1` | **PASSOU** | encerrou os 2 processos próprios, portas livres |
| 14 | Diagnóstico contra Gateway real | `node tools\diagnosticar-modelos.mjs` | **PASSOU** | separa "conta não autorizada" de "chave local" |

Total de asserções: **41 + 42 + 18 + 41 + 44 + 19 + 76 + 531 = 812**, mais 6 execuções reais de script.

### 1.1 Novidades da REV4 (consolidação)

| Item | Resultado |
|---|---|
| Verificador de modelos incorporado ao pacote (`tools/validar-modelos-reais.mjs`) | **PASSOU** — exigido por `verificar-pacote` (41/41) |
| Verificador contra dublê autorizado | **PASSOU** — 11/11, incluindo identidade via `/v1/runs` |
| Verificador contra Gateway real | **BLOQUEADO** — 5 PASS, 2 BLOQUEADO (`authentication_required`) |
| Correção da promessa falsa de `max_tokens` | **PASSOU** — documentada; Gateway não repassa o campo (conferido em `responses.js`) |
| Correção da prova de identidade do modelo | **PASSOU** — passou a usar `identityVerified` de `/v1/runs`, não o `model` ecoado |

### 1.2 REV4.1 — prova do defeito e da correção

| Teste | Resultado | Evidência |
|---|---|---|
| Corpo **com** `max_tokens` no Gateway real | **400 `unsupported_parameter`** | `evidencias/prova-defeito.log` |
| Mesmo corpo **sem** `max_tokens` | **401 `authentication_required`** (chegou ao contrato) | idem |
| Verificador REV4.1 contra Gateway real | **5 PASS · 2 BLOQUEADO_AUTENTICACAO · 0 FALHA** | `evidencias/verificador-gateway-real.log` |
| Verificador REV4.1 contra dublê estrito | **12 PASS · 0 FALHA · veredito APROVADO · 2 chamadas** | `evidencias/verificador-duble.log` |
| `tools/teste-verificador.mjs` | **14/14 PASS** (inclui teste que barra `max_tokens`) | execução direta |

---

## 2. Defeito A — stream cortado não é resposta concluída

Unidade (`tools/teste-revisao3.mjs`, bloco A — 12 casos):

```
A1. texto parcial + EOF (sem finish_reason e sem [DONE]) ......... ok
A2. texto + finish_reason + EOF (sem [DONE]) ..................... ok
A3. stream vazio + EOF ........................................... ok
A4. texto + finish_reason + [DONE] conclui normalmente ............ ok
A5. [DONE] sem finish_reason: não inventa, registra .............. ok
A6. ferramenta + [DONE] conclui com tool_calls .................... ok
A7. ferramenta sem [DONE] é interrupção ........................... ok
A8. erro SSE explícito antes do término mantém o código ........... ok
A9. cancelamento intencional continua "aborted" ................... ok
A10. texto não é duplicado quando o stream é cortado .............. ok
A11. JSON completo (sem SSE) continua concluindo .................. ok
A12. conexão liberada após [DONE] (sem socket vazado) ............. ok
```

Ponta a ponta pela API (`Kirana/test/revisao3-integracao.test.js`), com a Kirana real contra um
Gateway falso que corta o SSE:

```
ok 1 - A: stream cortado chega à tela como interrupção, não como conclusão
ok 2 - A: texto + finish_reason + [DONE] conclui normalmente
```

No caso 1: existe evento `error` com `code: "stream_interrupted"` e **nenhum** evento de
conclusão — o oposto do comportamento anterior, que devolvia `{finishReason:"stop"}`.

## 3. Defeito B — 401/403 pela causa real

Unidade (bloco B — 17 casos). Matriz direta da função de classificação:

| status | `error.code` | resultado |
|---|---|---|
| 401 | `invalid_api_key` | `unauthorized` (chave local) |
| 401 | `authentication_required` | `gateway_auth` (SIWC) |
| 401 | ausente | `gateway_auth_unknown` |
| 403 | desconhecido | `gateway_auth_unknown` |
| 403 | `sign_in_required` | `gateway_auth` |
| 429 | — | `rate_limited` (recuperável) |
| 500 | — | `gateway_http` (recuperável) |

Mensagens conferidas (o que a pessoa lê):
- chave local → contém **"chave LOCAL"**, não manda abrir `/auth/start`;
- SIWC → contém **`/auth/start`**, não manda mexer nos `.env`;
- sem código → **"não vou adivinhar"** e aponta `diagnosticar-modelos.mjs`;
- nenhuma delas exibe o texto cru do upstream (`Missing or invalid…`, `Run the local…`).

Mesma matriz em `/v1/models` (B15/B16) e ponta a ponta pela API (3 casos, incluindo 403 sem código).

## 4. Defeito C — cache de falha

Unidade (bloco C — 12 casos):

```
C1. TTL falha ≤ 5 s e sucesso = 5 min ................. ok
C2. freio de rajada 500 ms, expira em segundos ......... ok
C3. catálogo válido em cache por 5 min ................. ok
C4. erro de autorização força reconsulta imediata ...... ok
C5. só erros de autorização disparam ................... ok
C6. falha → autorização → catálogo real (sem esperar) .. ok
C7. expira em segundos sem gatilho explícito ........... ok
C8. 5 turnos = 1 consulta ao gateway ................... ok
C9. erro não-autorização não derruba o cache ........... ok
C10. invalidar descarta na hora ........................ ok
C11. probe=false não consulta .......................... ok
C12. ligação com o agent.js verificada no código ....... ok
```

Ponta a ponta (teste 6): Kirana real, `KIRANA_MODEL_PROBE=true`, Gateway falso sem autorização.
Primeira mensagem → erro `gateway_auth`; autoriza; **segunda mensagem** → nova consulta a
`/v1/models` e o modelo pedido passa de `gpt-6-luna` (configurado, inexistente) para `gpt-5`
(anunciado). Isso é exatamente a sequência que antes ficava presa 5 minutos.

---

## 5. O que precisou ser ajustado em testes existentes

Dois testes esperavam `gateway_auth` para um **401 sem `code`**. Com a regra nova esse caso é
`gateway_auth_unknown` — é o que a revisão pediu ("se o código estiver ausente ou desconhecido,
mostrar erro não conclusivo"). Ajustados, com o motivo escrito no próprio teste:

| Arquivo | Antes | Depois |
|---|---|---|
| `Kirana/test/gateway.test.js` | `code === 'gateway_auth'` | `code === 'gateway_auth_unknown'` |
| `Kirana/test/server.test.js` | `code === 'gateway_auth'` | `code === 'gateway_auth_unknown'` + mensagem cita o diagnóstico |

Os dois casos **com** código (`invalid_api_key`, `authentication_required`) estão cobertos em
`tools/teste-revisao3.mjs` (B10–B17) e na integração.

## 6. Defeito extra encontrado nesta rodada (não estava na lista)

Ao rodar `INICIAR-TUDO` duas vezes na pasta extraída, a Kirana foi **recusada** na segunda vez:
`porta 3000 ocupada e NAO foi possivel provar que o processo e desta instalacao`.

Causa: a leitura de portas pegava a **primeira** linha de `ss -ltnp` referente à porta — e a mesma
porta pode aparecer em mais de uma interface, uma delas **sem** `pid=`. Sem PID, a prova de
propriedade falha (corretamente) e o serviço legítimo é recusado.

Correção em `scripts/Comum.ps1` (`Get-EstadoPorta`): percorrer todas as linhas e usar a que traz
`pid=`; o mesmo critério no `netstat` (último campo numérico). **O fail-closed continua igual** —
quando nenhuma linha identifica o dono, nada é encerrado nem reutilizado.

Depois da correção, três execuções seguidas: `propriedade comprovada (PID …). Nada a fazer.` nas
duas portas, sem duplicar processo.

---

## 7. NÃO TESTÁVEL NESTE AMBIENTE

### 7.1 Windows PowerShell 5.1

Aqui só existe PowerShell **7.4.6 sobre Linux**. A compatibilidade com 5.1 é verificada por
análise (RNG com `GetBytes`+`Dispose`, `IDictionary` no lugar de `[hashtable]`, sem `??`/`?.`/
ternário/`-AsHashtable`/`-WindowStyle` fora do Windows) e pela execução dos mesmos scripts no
pwsh — **não é execução em 5.1**. Para fechar:

```powershell
powershell -NoProfile -Command "$PSVersionTable.PSVersion; . '.\scripts\Comum.ps1'; (New-TokenAleatorio).Length"
```

Esperado: `5.1.x` e `43`. O `INSTALAR-WINDOWS.cmd` usa `powershell`, então rodar o instalador como
sempre já exercita esse caminho.

### 7.2 SIWC, catálogo real e conversa completa

Sem conta autorizada, o `/v1/models` responde `authentication_required`. Portanto: a lista de
modelos do **seu** plano não foi vista por mim, `authenticated: true` nunca foi observado aqui e
**nenhuma conversa completa foi concluída** (não há modelo disponível neste ambiente). O que está
provado é o comportamento do código nos dois lados da autorização — com Gateway falso.

### 7.3 Cmdlets exclusivos do Windows

`Get-NetTCPConnection`, `Get-CimInstance Win32_Process`, `Start-Process -WindowStyle`,
`Get-FileHash`. Substituídos por equivalentes portáveis para permitir teste (`ss`/`netstat`/
`/proc`); no Windows o caminho original continua sendo o primeiro tentado.

### 7.4 Tailscale e Android

`tailscale serve` privado, HTTPS do tailnet e acesso pelo celular exigem a sua máquina e o seu
dispositivo. Nada foi alterado nessa parte; **Funnel continua fora**.

---

## 8. Bateria curta no seu Windows

```powershell
cd "C:\caminho\Kirana-v0.5.4-REV3-com-Gateway-v0.4.1-Windows"
.\INSTALAR-WINDOWS.cmd          # 1) instala/repara; sem cópia manual de chave
.\INSTALAR-WINDOWS.cmd          # 2) de novo: não perde estado
.\INICIAR-TUDO.cmd              # 3) sobe Gateway :1455 e Kirana :3000
node tools\diagnosticar-modelos.mjs   # 4) catálogo real (não mostra a chave)
.\PARAR-TUDO.cmd                # 5) para só o que esta pasta iniciou
```

Se a conversa falhar, o código do erro na tela agora diz **onde** olhar:

| Código | O que significa | O que fazer |
|---|---|---|
| `unauthorized` | chave local diferente entre os dois `.env` | `INSTALAR-WINDOWS.cmd` |
| `gateway_auth` | falta autorizar a conta | `http://127.0.0.1:1455/auth/start` |
| `gateway_auth_unknown` | 401 sem motivo reconhecível | `node tools\diagnosticar-modelos.mjs` |
| `stream_interrupted` | a resposta foi cortada no meio | tentar de novo; ver `run\gateway.log` |
| `model_not_available` | modelo do `.env` não existe no plano | `diagnosticar-modelos.mjs` e ajustar |

Logs úteis (sem segredo): `run\gateway.log`, `run\kirana.log`, `run\kirana.err.log`.
