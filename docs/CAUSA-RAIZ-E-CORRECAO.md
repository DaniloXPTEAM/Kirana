# Causa raiz: por que a distribuição tinha Gateway v0.4.0

Investigação feita **no código e nos artefatos**, não por suposição. Todos os números abaixo
saem de comandos executados no ambiente de montagem.

---

## 1. O que o ZIP "v0.4.1" realmente continha

O arquivo distribuído em `Kirana/integrations/`:

```
Kirana-ChatGPT-Gateway-v0.4.1-Windows.zip
  tamanho: 143321 bytes
  sha256 : e336b3628cbb4aa28223e90bbf09126314cff627ef2592650e78ef95eba9e015
```

Conteúdo real:

| Verificação | Resultado |
|---|---|
| Nome da pasta dentro do ZIP | `Kirana-ChatGPT-Gateway-v0.4.0/` |
| `package.json` → `version` | **`0.4.0`** |
| `src/engine.js` (o motor da v0.4.1) | **não existe** |
| `config/models.json` | **não existe** |
| `test/engine*.test.js` | **não existem** |
| Arquivos no total | **57** |

Comparação direta com a implementação real da v0.4.1:

```
Only in V0.4.1-REAL: config/
Only in V0.4.1-REAL: src/engine.js
Only in V0.4.1-REAL: test/engine.test.js
Only in V0.4.1-REAL: test/engine-gateway.test.js
Only in V0.4.1-REAL: tools/quality-suite.mjs
Only in V0.4.1-REAL: docs/engine.md
Only in V0.4.1-REAL: docs/tama-integration.md
Only in V0.4.1-REAL: windows/Avaliar-Modelo.ps1
Files .../src/gateway.js differ      (v0.4.0: 275 linhas · v0.4.1: 410)
Files .../src/responses.js differ    (v0.4.0: 328 linhas · v0.4.1: 354)
Files .../src/main.js differ         (v0.4.0: 61 linhas  · v0.4.1: 130)
```

**Conclusão:** o ZIP tinha o nome novo e o conteúdo antigo. Não era "versão parecida": era a
v0.4.0 inteira, sem uma linha de motor.

## 2. Como isso se propagou para a pasta `Gateway/`

A montagem da distribuição "completa" preenchia a pasta `Gateway/` **a partir desse ZIP**. Ou
seja, o mesmo conteúdo v0.4.0 era instalado em `Gateway/`, enquanto o ZIP continuava guardado em
`Kirana/integrations/` — aparentando ser a versão nova.

Resultado observado no Windows, e agora explicado:

| O que o usuário viu | O que estava acontecendo |
|---|---|
| `Gateway/package.json` = 0.4.0 | pasta montada do ZIP que, apesar do nome, era 0.4.0 |
| ZIP "v0.4.1" presente em `integrations/` | enganoso: conteúdo 0.4.0, o mesmo da pasta |
| `/health` do serviço = 0.4.0 | consistente com a pasta: **não havia divergência entre pasta e serviço** — ambos eram 0.4.0 |

É importante ser preciso: **não havia duas versões rodando em paralelo**. O que havia era uma
distribuição que se anunciava como 0.4.1 e entregava 0.4.0 de ponta a ponta.

## 3. Por que ninguém detectou

Nenhum passo comparava **nome anunciado** com **conteúdo real**. A verificação típica era:

- "o ZIP existe?" → sim;
- "o serviço responde?" → sim;
- "o package.json diz 0.4.1?" → não, mas ninguém comparou com a expectativa.

O pacote novo resolve isso com três verificações que **falham** em vez de avisar:

1. `tools/verificar-pacote.mjs` — compara `version` com o esperado **e** exige os marcadores de
   código da versão (ex.: `selectChain`/`executeChain` em `src/engine.js`). Nome não basta.
2. `DIAGNOSTICO.cmd` — compara **três** números por componente: pasta, `/health` do serviço e o
   processo que ocupa a porta. `pasta 0.4.1 + serviço 0.4.0` = veredito **FALHA**.
3. `INICIAR-TUDO.cmd` — antes de subir, se a porta estiver ocupada, identifica o dono (PID,
   executável, linha de comando, versão) e **recusa** prosseguir em caso de versão incompatível.
   Nunca encerra processo alheio.

## 4. O problema do SIWC não é (só) de versão

Autorizar três vezes e continuar sem autorização tem explicação no próprio código do Gateway,
e não é a mesma causa do item 1. Três mecanismos:

### 4.1 Tokens são **memory-only**

`src/auth.js:25` — `this.tokens = null; // Access/refresh tokens intentionally remain memory-only.`

`status()` (`src/auth.js:113`) devolve `authenticated: Boolean(this.tokens)`.

Ou seja: **`authenticated: true` significa "este processo tem token em memória agora"**. Ao
reiniciar o Gateway, vira `false` — sempre. Autorizar não "gruda" entre execuções, por decisão de
segurança do projeto.

> Foi exatamente por isso que o diagnóstico anterior viu `authenticated: true` em um momento e
> "SIWC não reconhecida" em outro: eram momentos (ou processos) diferentes.

### 4.2 `.env` e `.local-state` dependem do **diretório de trabalho**

`src/main.js:5` — `await loadEnv(resolve(process.cwd(), '.env'));`
`src/main.js:105` — `stateDir: resolve('.local-state', appId)`

Nenhum dos dois é relativo à pasta do script. Se o Gateway for iniciado de outro diretório:

- lê **outro** `.env` (ou nenhum) → pode falhar por `GATEWAY_API_KEY` ausente;
- cria **outro** `.local-state` → `registration.json` novo, com **outro `hostId`**.

O consentimento anterior foi dado a um `hostId`. Trocar de `hostId` faz a autorização antiga
deixar de valer, e não há aviso — o Gateway simplesmente pede login de novo.

**Evidência compatível com isso na sua máquina:** o processo na porta 1455 foi iniciado como
`node --env-file=.env src\main.js`. Esse não é o comando de nenhum launcher deste pacote (aqui
usamos `node src/main.js` com diretório de trabalho fixado). Isso indica que o Gateway em execução
foi iniciado por **outro caminho** — possivelmente de outra pasta, o que cria outro estado.

### 4.3 O callback precisa estar na mesma porta do serviço

`src/gateway.js:364` — se a porta de callback do OAuth diferir da porta em escuta, o Gateway
**aborta na inicialização**. Isso protege contra callback perdido, mas significa que mudar `PORT`
no `.env` (por exemplo, 1456) quebra o fluxo de autorização sem mensagem óbvia no navegador.

### 4.4 O plano precisa conceder o escopo certo

`src/auth.js:11-12` — o escopo `chatgpt.tokens.use.direct` precisa ser concedido. Se a conta não o
concede, o `refresh` derruba a sessão (`sharing_scope_missing`) mesmo com login bem-sucedido.

Por isso o `DIAGNOSTICO.cmd` passou a mostrar `grantedScopes` e a marcar **FALHA** quando o escopo
de plano está ausente — em vez de dizer genericamente "não autorizado".

## 5. O que foi corrigido nesta entrega

| Correção | Onde |
|---|---|
| `Gateway/` agora é a v0.4.1 **real** (76 arquivos, `src/engine.js`, `/v1/engine`, `/v1/runs`) | pasta `Gateway/` |
| ZIP enganoso removido de `Kirana/integrations/` (acaba a duplicação) | `Kirana/` |
| Verificação por **conteúdo**, não por nome | `tools/verificar-pacote.mjs` |
| Launcher fixa o **diretório de trabalho** (`.env` e `.local-state` corretos) | `scripts/Iniciar-Tudo.ps1` |
| Recusa subir sobre processo de versão incompatível, sem matar nada | `scripts/Iniciar-Tudo.ps1` |
| Diagnóstico compara pasta × serviço × processo e **falha** na divergência | `scripts/Diagnostico.ps1` |
| Estado SIWC exposto sem credenciais (escopos, `registrationConfigured`, `/v1/models`) | `scripts/Diagnostico.ps1` |
| Migração de `.env` com backup + SHA-256 + classificação por variável | `scripts/Migrar-Env.ps1` |
| Parada apenas do que a distribuição iniciou (pid file + verificação de comando) | `scripts/Parar-Tudo.ps1` |

## 6. O que **não** foi corrigido — e por que

- **Persistir tokens do SIWC em disco**: não fiz. Isso mudaria a política de segurança do Gateway
  (tokens em memória é decisão explícita do autor, `src/auth.js:25`) e criaria um arquivo de
  credencial em disco. Consequência prática, dita sem rodeio: **depois de reiniciar o Gateway,
  autorize de novo em `http://127.0.0.1:1455/auth/start`**. Se você quiser persistência, é uma
  decisão separada, com implicação de segurança — me diga e discutimos antes.
- **Corrigir a dependência de `cwd` dentro do Gateway**: exigiria alterar `src/main.js` e mudaria a
  versão entregue. Contornado no launcher (que fixa o diretório) e **exposto** no diagnóstico.
- **Declarar a SIWC funcionando**: não posso. A validação real depende de você autorizar e de eu
  ver o `grantedScopes`/`/v1/models` respondendo.

---

## 6. Segundo defeito, encontrado nesta rodada: o Gateway não subia pela segunda vez

Este não é o defeito original (0.4.0 × 0.4.1); é outro, encontrado ao testar a reinicialização com
o pacote já montado. Fica registrado porque **quebra exatamente o fluxo de quem está tentando
autorizar o SIWC**: sobe, para, e não sobe de novo.

**Sintoma.** Primeira execução do `INICIAR-TUDO.cmd`: Gateway sobe normalmente e cria
`Gateway/.local-state/kirana-personal-gateway/registration.json` com

```json
{ "version": 1, "hostId": "urn:uuid:...", "clientId": null }
```

Segunda execução, sem ter concluído o consentimento no navegador:

```
Error: Local registration state is invalid; remove or restore registration.json.
    at SiwcAuth.initialize (src/auth.js:41)
```

**Causa.** `src/auth.js` grava `clientId: null` antes do primeiro consentimento, mas na leitura
exigia `typeof raw.clientId === 'string'` — ou seja, **o código recusava o arquivo que ele próprio
acabou de escrever**. A mensagem ainda sugeria apagar o registro, que é a pior saída possível: o
`hostId` muda, e o consentimento SIWC já dado deixa de valer (é a mesma mecânica do `cwd`/
`.local-state` descrita em `docs/MIGRACAO-ENV-E-SIWC.md`).

**Correção (uma linha, em `Gateway/src/auth.js`).**

```js
// antes
if (raw.version !== 1 || typeof raw.hostId !== 'string' || typeof raw.clientId !== 'string') throw new Error('bad state');
// depois
if (raw.version !== 1 || typeof raw.hostId !== 'string' || (raw.clientId !== null && typeof raw.clientId !== 'string')) throw new Error('bad state');
```

`null` passa a ser aceito (é o estado legítimo "ainda não consentiu") e valores inválidos continuam
recusados. **A versão do Gateway permanece 0.4.1**: é correção de defeito, sem mudança de API, de
rota ou de formato de dados — e `verificar-pacote.mjs` continua exigindo os marcadores da 0.4.1.

**O que foi testado depois da correção.**

| Teste | Resultado |
|---|---|
| primeira partida em pasta limpa | sobe, cria `registration.json` |
| segunda e terceira partidas | sobem, **mesmo `hostId`** preservado |
| `clientId` numérico no arquivo | continua recusando |
| `hostId` ausente | continua recusando |
| `registration.json` com JSON quebrado | continua recusando |
| suíte do Gateway (76 testes) | **76/76** |
| suíte da Kirana (525 testes) | **525/525** — a árvore da Kirana não foi tocada |

**Consequência prática para você:** se a sua instalação antiga já passou por isso, o
`registration.json` dela pode estar num estado que a versão antiga recusava. **Não apague a pasta
`.local-state`** — ela contém o `hostId` do seu consentimento. Com o Gateway desta entrega, o arquivo
existente passa a ser lido normalmente.
