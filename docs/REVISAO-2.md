# REVISÃO 2 — o que foi corrigido nesta rodada

Data: 29/10/2026
Base: ZIP `2c574878cc8926823cae4bc00781c34c03a5813aedff859e01f6ea217c4e5c44`
(Kirana 0.5.4 + Gateway 0.4.1). O hash do arquivo recebido confere com o do relatório
anterior — é a mesma árvore, agora corrigida nos seis pontos da revisão.

Versões mantidas de propósito: **Kirana 0.5.4** e **Gateway 0.4.1**. Nada foi reconstruído:
as correções da rodada anterior (verificador com dois modos, alinhamento automático da chave,
escolha de modelo no catálogo, parser SSE) continuam no lugar.

---

## Resumo

| # | Defeito da revisão | Arquivo | Antes | Depois |
|---|---|---|---|---|
| 1 | `RandomNumberGenerator::Fill` só existe em .NET moderno | `scripts/Comum.ps1` | instalador morreria no Windows PowerShell 5.1 | instância + `GetBytes(byte[])` + `Dispose()` em `finally` |
| 2 | Reuso de processo por coincidência de versão | `scripts/Iniciar-Tudo.ps1` | serviço com `/health` de mesma versão era aceito sem prova de dono | só reutiliza com três evidências (pid file + dono da porta + linha de comando); senão para com diagnóstico |
| 3 | `PARAR-TUDO` seguia adiante quando a linha de comando era ilegível | `scripts/Parar-Tudo.ps1` | `if ($linha -and ...)` → `$null` passava e matava o PID | fail-closed: sem linha de comando, não encerra |
| 4 | `error.code` do Gateway era descartado | `Kirana/src/gateway.js` | tudo virava `gateway_stream_error` | código real preservado, aliases traduzidos, texto sanitizado |
| 5 | `mapError` duplicado e citando ferramenta inexistente | `Kirana/src/agent.js` | duas entradas `gateway_not_configured`; citava `tools/diagnosticar-modelos.mjs` que não existia | módulo `Kirana/src/errors.js`, sem duplicata, e a ferramenta passou a existir de verdade |
| 6 | Escolha de modelo prometia capacidade não verificada | `Kirana/src/model-choice.js` | regex no nome + "primeiro da lista" | usa capacidade declarada quando existe; sem metadados, diz que é hipótese |
| 7 | `[hashtable]$Padroes` recebendo `[ordered]@{}` | `scripts/Instalar.ps1` | 5.1 não converte `OrderedDictionary` → `Hashtable` | parâmetro virou `[System.Collections.IDictionary]` |

Dois defeitos **extras** apareceram quando o instalador foi executado de verdade neste
ambiente — ambos corrigidos e recompensados nos testes:

| # | O que apareceu | Correção |
|---|---|---|
| 8 | `Start-Process -WindowStyle` não existe fora do Windows: o inicializador morria no meio | `-WindowStyle` só é passado quando `$env:OS` é `Windows_NT` (no Windows nada muda) |
| 9 | O processo era iniciado como `node src/main.js`, então **a pasta não aparecia na linha de comando** — a prova de propriedade dos itens 2 e 3 nunca fecharia, nem no caso legítimo | o inicializador passa o caminho **absoluto** do script; é o que permite provar dono depois |

---

## 1. PowerShell 5.1 — RNG

```powershell
# antes (só .NET Core 3.0+)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)

# depois (5.1 e 7)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { if ($rng) { $rng.Dispose() } }
```

32 bytes de entropia, mesma codificação base64url (43 caracteres). Nada de `Get-Random`
nem GUID. Testes A1–A3 conferem: ausência do `::Fill`, presença de `GetBytes`+`Dispose`,
comprimento, entropia decodificada e 200 tokens distintos.

## 2. Reuso de processo — a regra agora é identidade, não versão

`Get-DecisaoReuso` (em `Comum.ps1`) devolve `iniciar`, `reusar` ou `parar`. Só `reusar`
quando **as três** condições valem:

1. existe `run/<componente>.pid` escrito por esta distribuição;
2. o PID do arquivo é o mesmo PID que possui a porta;
3. a linha de comando cita o arquivo **e** a pasta desta instalação.

`/health` com a mesma versão **não** entra na conta — está escrito no código por quê:
duas cópias da Kirana podem responder `0.5.4` com chaves locais e estados diferentes, e
seguir usando a errada gera 401 e modelos de outra conta.

## 3. Parada segura — fail-closed

`Get-DecisaoParada` devolve `encerrar`, `ignorar` ou `limpar`. `ignorar` (não encerra) se:
pid file ausente, linha de comando ilegível, PID não executa o script esperado, PID não roda
da pasta esperada, ou a porta pertence a outro PID. `-Forcar` **não** fura essas checagens.

## 4. Código do erro de streaming chegando à tela

O Gateway já mandava `{error:{code:'stream_interrupted'}}` no frame SSE; a Kirana
descartava o código. Agora:

- lista fechada de códigos conhecidos (`CODIGOS_DE_ERRO_DO_GATEWAY`);
- `ALIAS_DE_ERRO` traduz o que vem cru do provedor (`invalid_api_key` → recusa de
  autorização da conta, `model_not_found` → modelo, `sign_in_required` → SIWC);
- código desconhecido → `gateway_stream_error` (genérico, nunca otimista);
- mensagem técnica sanitizada (sem controle, sem `<`/`>`, máx. 200 chars) e guardada em
  `detail`; a tela mostra o texto fixo de `errors.js`, nunca texto do upstream.

Consequência prática: quatro situações que apareciam com a mesma frase agora têm quatro
frases diferentes — chave local ≠ SIWC ≠ modelo ≠ resposta parcial.

## 5/6. Modelos — catálogo não é capacidade

`escolherModelo` agora recebe objetos com metadados quando existirem
(`capabilities`, `capabilities_list`, `supported_parameters`) e devolve também:

- `motivo`: `primario_anunciado`, `fallback_anunciado`, `escolhido_do_catalogo`,
  `sem_candidato`, `catalogo_vazio`, `descoberta_falhou` — cada um com mensagem própria;
- `verificado`: `true` **só** quando o catálogo declarou capacidade compatível.

Sem metadados (é o caso do `/v1/models` da v0.4.1, que devolve só
`id/object/created/owned_by`), a escolha é declarada como **hipótese**: “compatibilidade
será confirmada na primeira resposta”. Nunca inventa slug, nunca afirma capacidade, e
`chat:false`/`tools:false` declarados são respeitados (descartados quando a tarefa precisa).

## 7. `Preparar-Env` e o 5.1

`[hashtable]` não aceita `OrderedDictionary` no 5.1 (funciona no 7 — por isso o defeito
passava despercebido em teste com `pwsh`). O parâmetro virou `[System.Collections.IDictionary]`,
que aceita os dois tipos preservando a ordem.

---

## Ferramenta nova: `tools/diagnosticar-modelos.mjs`

Existia só como texto dentro de uma mensagem de erro. Agora existe de verdade:

```
node tools\diagnosticar-modelos.mjs
```

Mostra, nesta ordem: chave local presente e igual nos dois `.env` (tamanho, nunca valor);
Gateway no ar e autorizado; catálogo com capacidades declaradas (ou o aviso de que não
declara); **qual modelo a Kirana escolheria agora e por quê**; e o que fazer quando a
lista vem vazia. `--json` para uso em script. A chave é lida do disco, usada só em
loopback e nunca impressa.

---

## Arquivos alterados nesta rodada

| Arquivo | Natureza |
|---|---|
| `scripts/Comum.ps1` | RNG 5.1; `Get-LinhaDeComando`; `Get-DecisaoReuso`; `Get-DecisaoParada`; `ss`/netstat/CIM; caminho absoluto no `Start-NodeEm`; `-WindowStyle` condicional |
| `scripts/Iniciar-Tudo.ps1` | reuso só com prova de propriedade; `/health` conta como porta ocupada |
| `scripts/Parar-Tudo.ps1` | fail-closed de verdade |
| `scripts/Instalar.ps1` | `Preparar-Env` com `IDictionary` |
| `Kirana/src/gateway.js` | código/alias/sanitização do erro SSE; `modelsDetalhados()` |
| `Kirana/src/errors.js` | **novo** — mensagens por código, sem duplicata |
| `Kirana/src/agent.js` | usa `errors.js`; passa `requerFerramentas`; expõe `modelVerified`/`modelReason` |
| `Kirana/src/model-choice.js` | capacidade declarada × hipótese; motivos distintos |
| `tools/diagnosticar-modelos.mjs` | **novo** |
| `tools/teste-revisao2.mjs` | **novo** — 39 regressões desta revisão |
| `tools/teste-correcoes.mjs` | 1 asserção ajustada ao novo texto de aviso |
| `tools/verificar-pacote.mjs` | exige os docs novos e confere que `tools/x.mjs` citados existem |
| `INSTALAR-WINDOWS.cmd` | cabeçalho dizia `v0.5.3`; agora `v0.5.4` |
| `docs/REVISAO-2.md` | **novo** (este arquivo) |
| `docs/TESTES-E-EVIDENCIAS.md` | atualizado com as contagens e pendências desta rodada |
