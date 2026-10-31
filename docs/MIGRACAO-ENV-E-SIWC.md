# Migração de `.env`, estado e SIWC

## 1. Os quatro `.env` do seu ambiente

O levantamento no Windows encontrou quatro arquivos. Eles **não** são equivalentes:

| # | Caminho | Papel | Destino na nova instalação |
|---|---|---|---|
| 1 | `Kirana-ChatGPT-Gateway-v0.4.0-Windows\...\.env` | Gateway **antigo** isolado | variáveis do Gateway, se compatíveis |
| 2 | `kirana-fase1-v0.1.0\kirana\Kirana\.env` | Kirana de distribuição antiga | variáveis da Kirana, se compatíveis |
| 3 | `Kirana-v0.5.3-Completa...\Gateway\.env` | Gateway da instalação atual (0.4.0) | variáveis do Gateway |
| 4 | `Kirana-v0.5.3-Completa...\Kirana\.env` | Kirana atual (0.5.3) | variáveis da Kirana |

`MIGRAR-ENV.cmd` lê os quatro, faz backup **com SHA-256 antes de qualquer escrita**, classifica
**variável por variável** e só grava o que é compatível.

### Classificação usada

| Classe | Exemplo | Ação |
|---|---|---|
| `compativel` | `KIRANA_GATEWAY_URL`, `KIRANA_BRIDGE_TOKEN` | copiada |
| `renomeada` | `GATEWAY_PORT` → `PORT`; `KIRANA_GATEWAY_KEY` → `KIRANA_GATEWAY_API_KEY`; `KIRANA_BRIDGE_ENABLED` → `KIRANA_BRIDGE` | copiada com o nome novo |
| `proibida` | `OPENAI_API_KEY`, `CHATGPT_API_KEY`, `PASSWORD` | **nunca** copiada |
| `desconhecida` | qualquer nome fora das tabelas | não copiada; aparece no relatório para você decidir |
| `outro-componente` | variável de Gateway em `.env` de Kirana | ignorada no destino errado |

Saída sempre mascarada: `(definido, 39 caracteres)`. Nenhum valor é impresso — nem em erro.

### O que **não** se migra

- `.local-state/` não vai para a nova instalação por cópia cega. Ele guarda o `registration.json`
  (hostId + clientId). Copiar isso para outro caminho **não autentica nada**, porque os tokens
  não estão lá (ver §2). O que você preserva é o histórico para diagnóstico, não a autorização.
- `node_modules/` nunca.
- Nada de `Kirana-Arena-Bridge` ou `opportunity-site-pronto`.

## 2. Por que o SIWC "não pegava" — três mecanismos do código

### 2.1 Tokens são memory-only

```js
// Gateway/src/auth.js:25
this.tokens = null; // Access/refresh tokens intentionally remain memory-only.
```

```js
// Gateway/src/auth.js:113
status() { return { authenticated: Boolean(this.tokens), ... } }
```

`authenticated: true` no `/health` significa **"este processo tem token em memória agora"** — não
"a conta está autorizada para sempre". Reiniciou o Gateway → `false`. Autorizar de novo é
necessário, por desenho.

**Consequência prática:** se você autorizar e depois reiniciar (ou se o `INICIAR-TUDO` subir outra
instância), a autorização desaparece. Foi o que produziu a contradição "autorizei três vezes e
continua dizendo que não está autorizado".

### 2.2 `.env` e `.local-state` são relativos ao diretório de trabalho

```js
// Gateway/src/main.js:5
await loadEnv(resolve(process.cwd(), '.env'));
// Gateway/src/main.js:105
const app = createGateway({ ..., stateDir: resolve('.local-state', appId), ... });
```

Iniciar o Gateway de outro diretório:

- lê outro `.env` (ou nenhum);
- cria **outro** `.local-state`, com **outro `hostId`**;
- o consentimento anterior foi emitido para outro `hostId` → deixa de valer, sem aviso.

O launcher desta distribuição fixa o diretório de trabalho na pasta `Gateway/`, e o diagnóstico
confirma onde o `registration.json` foi escrito.

### 2.3 O callback OAuth precisa da mesma porta

```js
// Gateway/src/gateway.js:364
if (address.port !== auth.port) throw new Error(`Configured callback port ...`);
```

Se você mudar `PORT` no `.env`, o Gateway **não inicia** — proteção contra callback perdido. O
diagnóstico marca **FALHA** quando `PORT ≠ 1455`.

### 2.4 O plano precisa conceder `chatgpt.tokens.use.direct`

```js
// Gateway/src/auth.js:11-12
const SCOPES = ['openid','profile','email','offline_access','resource.invoke','chatgpt.tokens.use.direct'];
const SHARE_SCOPE = 'chatgpt.tokens.use.direct';
```

Sem esse escopo, o login funciona e a sessão cai no primeiro refresh (`sharing_scope_missing`).

## 3. Como diagnosticar o SIWC sem adivinhar

`DIAGNOSTICO.cmd` mostra, sem expor credencial:

```
/health authenticated        true/false        (token em memória AGORA)
/auth/status sharing         true/false
/auth/status tokenStorage    memory-only
/auth/status registrationConfigured   true/false   (clientId já registrado)
escopos concedidos           lista
  └ chatgpt.tokens.use.direct AUSENTE → FALHA
registration.json            hostId + clientId (8 primeiros caracteres)
GET /v1/models               quantos modelos, ou o HTTP que recusou
```

Interpretação:

| Situação | Leitura correta |
|---|---|
| `authenticated: false`, `registrationConfigured: true` | normal após reiniciar: autorize em `/auth/start` |
| `authenticated: true` mas `/v1/models` dá 401 | token expirado/recusado; autorize de novo |
| `registrationConfigured: false` | nenhum `/auth/start` completou nesta pasta/estado |
| escopo de plano ausente | a conta/plano não concedeu `chatgpt.tokens.use.direct` — não é bug da Kirana |
| `registration.json ilegivel` | o Gateway se recusa a iniciar; restaure um backup |

## 4. Se a autorização continuar falhando

Ordem de investigação — cada passo elimina uma hipótese, em vez de tentar de novo às cegas:

1. **Confirme a versão** — `.\DIAGNOSTICO.cmd`. Se `Gateway/package.json` não for 0.4.1, nada
   abaixo importa.
2. **Confirme o estado** — o `registration.json` mostrado é o de `Gateway/.local-state/...`? Se
   não existir, o Gateway em execução está usando outro diretório.
3. **Confirme o processo** — a porta 1455 é do PID iniciado por esta distribuição (`run/gateway.pid`)?
   Se não, há outro Gateway antigo rodando; encerre-o (o pacote não mata processo alheio).
4. **Autorize com o Gateway vivo e não reinicie em seguida** — abra `/auth/start`, conclua e volte
   ao diagnóstico **sem** reiniciar. Se `authenticated: true` aparecer e depois sumir, a causa é
   reinício (item 2.1), não a conta.
5. **Leia os escopos** — se `chatgpt.tokens.use.direct` não estiver na lista, o problema é de
   concessão do plano, e nenhuma reinstalação muda isso.
6. **Só então** cogite reinstalação limpa (`docs/INSTALACAO-LIMPA.md`).

> Reinstalar **não** conserta autorização. Os tokens nunca estiveram em disco para serem migrados.
> O que uma instalação limpa conserta é a divergência de versões e a confusão de pastas.

## 5. Backup e restauração

O backup feito por `BACKUP-ANTES-DE-LIMPAR.cmd`:

```
backups\pre-limpeza-<data>\
├── env-1.env ... env-N.env     cópias literais dos .env encontrados
├── estado-1.zip ...            .local-state (só com -IncluirEstado)
├── MANIFESTO.json              origem, cópia e SHA-256 de cada item
└── SHA256SUMS.txt              para conferência manual
```

Restaurar um `.env`: copie de volta para `Kirana/.env` ou `Gateway/.env`. Restaurar estado: extraia
o zip em `Gateway/.local-state/`. Para conferir integridade:

```powershell
Get-Content backups\pre-limpeza-<data>\SHA256SUMS.txt | ForEach-Object {
  $hash, $arq = $_ -split '\s+', 2
  if ((Get-FileHash (Join-Path 'backups\pre-limpeza-<data>' $arq) -Algorithm SHA256).Hash -ne $hash) { "DIVERGIU: $arq" }
}
```
