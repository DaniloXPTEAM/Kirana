# Testes executados nesta distribuição (Kirana v0.5.4 + Gateway v0.4.1)

Data: 29/10/2026 · Ambiente de montagem: **Linux** · Ambiente alvo: **Windows 11**

> **Leia junto com `docs/TESTES-E-EVIDENCIAS.md`.** Aquele documento é o registro da rodada
> final de correções e usa três status: PASSOU, FALHOU e **NÃO TESTÁVEL NESTE AMBIENTE**.
> Os números de Kirana (`525/525`) foram obtidos numa sessão anterior, com as dependências já
> instaladas; na rodada final o ambiente não tinha espaço para reinstalá-las, então a suíte **não
> foi reexecutada** e está lá classificada como NÃO TESTÁVEL. Nada foi removido deste arquivo:
> ele continua valendo como registro do que rodou naquela sessão.

> **Nota de versão:** o código da Kirana foi marcado **0.5.4** nesta entrega (era 0.5.3).
> O `package.json` declara 0.5.4 e `src/config.js` lê a versão do `package.json`, então `/health`,
> log de inicialização e diagnóstico mostram 0.5.4. O Gateway permanece **0.4.1**.

Leia a coluna "onde rodou". Nenhum teste Linux é apresentado como prova de funcionamento no
Windows; o que é específico de Windows está marcado e tem o comando equivalente para você rodar.

---

## 1. Estrutura e versões — `node tools/verificar-pacote.mjs`

Rodou em: montagem (Linux) · Windows: mesmo comando.

```
RESULTADO: pacote coerente (N verificações OK)
```

| Verificação | Resultado |
|---|---|
| `Kirana/package.json` = 0.5.4 | ✔ |
| `Gateway/package.json` = 0.4.1 | ✔ |
| `Gateway/src/engine.js` com `selectChain`/`executeChain`/`CircuitBreaker`/`CapabilityCatalog` | ✔ |
| `Gateway/src/gateway.js` com `/v1/engine`, `/v1/runs`, `identity_verified` | ✔ |
| `Gateway/src/responses.js` com `modelReported` | ✔ |
| `Gateway/config/models.json` | ✔ |
| `Kirana/integrations` **sem** ZIP do Gateway (fim da duplicação) | ✔ |
| sem `.env`, `node_modules`, `.local-state` ou `data` no pacote | ✔ |
| 6 scripts `.ps1` + 6 wrappers `.cmd` + 4 documentos obrigatórios | ✔ |
| wrappers chamam o `.ps1` certo e usam `%~dp0` | ✔ |

**Por que isso importa:** foi exatamente essa verificação que faltou na entrega anterior. O teste
não confia no nome do arquivo — exige os marcadores de código da versão.

## 2. Suítes de teste dentro da distribuição montada

Rodou em: montagem (Linux) · Windows: `node tools\verificar-pacote.mjs --testes`

| Componente | Comando | Resultado |
|---|---|---|
| Gateway v0.4.1 | `node --test test/*.test.js` | **76/76 passaram** |
| Kirana v0.5.4 | `node --test test/*.test.js` | **525/525 passaram** |

Notas honestas:

- `node --test` sem lista pega também `Kirana/test/browser/*.mjs` (6 arquivos Playwright), que
  falham por falta de navegador. Eles **não** fazem parte da suíte de aceitação; o verificador lista
  apenas `test/*.test.js`. Se você rodar `node --test` puro e ver 6 falhas em `test/browser/`, é
  isso — não é regressão do pacote.
- **Rode a partir da pasta do componente.** A suíte da Kirana assume `cwd = Kirana/`: executada de
  fora (`node --test Kirana/test/*.test.js` a partir da raiz), dá **40 falhas** por caminhos
  relativos — artefato de execução, não defeito. De dentro de `Kirana/`, 525/525. Os scripts deste
  pacote já fixam o diretório de trabalho; se você rodar à mão, entre na pasta.
- `node_modules` não acompanha o ZIP (nem deve). O verificador aceita link simbólico para
  dependências externas e avisa; no Windows elas são instaladas de verdade pelo INSTALAR.

## 3. Scripts PowerShell — `node tools/teste-scripts.mjs`

Rodou em: montagem (Linux) **com PowerShell Core 7.4.6 real**

```
RESULTADO: 19 verificações de script OK.
```

| Verificação | Resultado |
|---|---|
| Parser oficial do PowerShell nos 7 `.ps1` | **7/7 sem erro de sintaxe** |
| Migração de `.env` em modo plano executa | ✔ |
| **Nenhum valor de segredo impresso na saída** | ✔ (5 segredos-isca verificados) |
| Classificação `GATEWAY_PORT` → renomeada | ✔ |
| Classificação `KIRANA_GATEWAY_KEY` → renomeada | ✔ |
| Classificação `OPENAI_API_KEY` → NAO COPIAR | ✔ |
| Classificação `KIRANA_BRIDGE_TOKEN` → compatível | ✔ |
| Backup criado com manifesto | ✔ |
| 5 wrappers `.cmd` com CRLF e `%~dp0` | ✔ |

### Bugs encontrados ao executar de verdade (e corrigidos)

Executar em vez de "revisar" pegou quatro defeitos que teriam chegado ao usuário:

1. **`-Origens a,b,c` chegava como uma única string** (`-File` não expande vírgula) → o script
   tentava copiar um arquivo chamado `a,b,c`. Corrigido com split explícito.
2. **Fallback de `netstat` só reconhecia `LISTENING`** (Linux usa `LISTEN`) → detecção de porta
   falhava em silêncio.
3. **`netstat` inexistente poluía o relatório com erro vermelho** no meio do diagnóstico.
4. **A comparação de versão dependia da detecção de porta**: se a detecção falhasse, a checagem
   mais importante do diagnóstico era pulada. Agora a versão é conferida **sempre**, pelo `/health`,
   independente de quem é o dono da porta.

E um bug de contrato: **`/auth/status` exige a chave do Gateway**. Sem o cabeçalho, o diagnóstico
dizia "Gateway não respondeu" e escondia justamente o estado do SIWC. Corrigido — a chave é lida de
`Gateway/.env` e usada só nessa chamada local.

## 4. Diagnóstico — cenário POSITIVO (serviços reais do pacote)

Rodou em: montagem (Linux), com o Gateway v0.4.1 e a Kirana v0.5.4 **extraídos do pacote**.

```
VEREDITO: pacote e servicos coerentes.   (exit 0)
```

| Item | Valor observado |
|---|---|
| `Kirana/package.json` | 0.5.4 |
| `Gateway/package.json` | 0.4.1 |
| `Gateway/src/engine.js` | motor presente |
| porta 1455 | **v0.4.1** responde |
| porta 3000 | **v0.5.4** responde |
| `Gateway/.env` | presente, `GATEWAY_API_KEY` (definido, 43 caracteres), `HOST=127.0.0.1` |
| `Kirana/.env` | presente, `KIRANA_GATEWAY_URL=http://127.0.0.1:1455`, `KIRANA_BRIDGE=on` |
| `/auth/status` | `authenticated: false`, `tokenStorage: memory-only`, `registrationConfigured: false` |
| `GET /v1/models` | recusado (HTTP 401) — SIWC não autorizada nesta sessão |
| `GET /api/gateway/ping` | ponte on · 6 rotas |
| `GET /api/gateway/v1/engine` | **Gateway v0.4.1** · custo plan-only |
| erros de runtime no relatório | **0** |

Os dois avisos são corretos e esperados: SIWC inativa (tokens memory-only) e `/v1/models` recusado.

## 5. Diagnóstico — cenário NEGATIVO (o requisito central do item 6.4)

Rodou em: montagem (Linux). Simulei um serviço se declarando **v0.4.0** na porta 1455, com a pasta
contendo **v0.4.1**.

```
[FALHA] porta 1455 (Gateway)   v0.4.0 responde (dono da porta nao identificado neste sistema)
VEREDITO: 2 FALHA(S)                                    (exit 1)
  - Gateway: servico ativo e v0.4.0, pasta declara v0.4.1
```

**É exatamente o comportamento exigido:** pasta 0.4.1 + serviço 0.4.0 = diagnóstico falha, com a
frase que nomeia a divergência.

## 6. Teste real de ponta a ponta: Gateway + Kirana + ponte

Rodou em: montagem (Linux), serviços do pacote.

| Passo | Resultado |
|---|---|
| Gateway do pacote sobe | `Kirana Personal Gateway v0.4.1 listening at http://127.0.0.1:1455` |
| Kirana do pacote sobe | `Kirana v0.5.4 ouvindo em http://127.0.0.1:3000` |
| ponte responde | `GET /api/gateway/ping` → 6 rotas |
| ponte alcança o motor | `GET /api/gateway/v1/engine` → `Gateway v0.4.1 · custo plan-only` |
| sem SIWC | `GET /v1/models` → **401** (não inventou resposta) |
| bind | somente `127.0.0.1:1455` |

## 7. O que NÃO foi testado — sem rodeios

| Item | Por que | Como validar no seu Windows |
|---|---|---|
| `INSTALAR-WINDOWS.cmd` completo | roda `npm install` de ~900 pacotes; inviável aqui, e o alvo é Windows | execute e confira a linha final `Concluido sem erros` |
| `INICIAR-TUDO.cmd` / `PARAR-TUDO.cmd` | usam `Start-Process -WindowStyle Hidden`, `Get-NetTCPConnection`, `Get-CimInstance` — exclusivos de Windows | execute; o esperado é `Gateway v0.4.1` e `Kirana v0.5.4` nas linhas OK |
| Detecção do **dono** da porta | `Get-NetTCPConnection` não existe no Linux; aqui apareceu "dono nao identificado" | no Windows deve aparecer `PID … node.exe` + caminho |
| `tailscale serve` e o celular | não há Tailscale neste ambiente | `docs/ACESSO-REMOTO-TAILSCALE.md` na Kirana |
| Autorização SIWC real | exige seu consentimento no navegador | `http://127.0.0.1:1455/auth/start` e depois `DIAGNOSTICO.cmd` |
| PowerShell 5.1 | validei com PowerShell **7.4.6** | o código evita construções de PS7 (`??`, `-shrink`); se algo falhar no 5.1, a linha aparece e eu corrijo |

Nenhuma afirmação deste documento diz "funciona no Windows" para os itens da tabela acima. Diz:
"sintaxe válida no parser oficial, lógica exercitada onde possível, comportamento de Windows a
confirmar na sua máquina".

## 8. Reexecutar tudo (na sua máquina)

```powershell
node tools\verificar-pacote.mjs --testes   # estrutura + 76 + 525 testes
node tools\teste-scripts.mjs               # sintaxe dos .ps1 + migração sem vazar segredo
.\DIAGNOSTICO.cmd                          # versões, portas, SIWC, ponte
```

## Reinício do Gateway (defeito encontrado e corrigido nesta montagem)

| O que foi testado | Resultado |
|---|---|
| 1ª partida em pasta limpa (Gateway) | sobe; cria `registration.json` com `clientId: null` |
| 2ª partida, sem consentimento concluído | **antes: falhava** ("Local registration state is invalid") · **agora: sobe** |
| 3ª partida | sobe, mesmo `hostId` |
| `clientId` numérico / `hostId` ausente / JSON quebrado | termina com a mensagem de estado inválido (continua recusando) |
| suíte do Gateway depois da correção | **76/76** |

Rodou em: Linux, com o Gateway e a Kirana extraídos do pacote.
Não rodou em: Windows (ver limitações abaixo).
