# Instalação limpa — procedimento para você executar

Este documento é uma **ordem de operações**. Nenhum script deste pacote apaga pastas antigas.
A remoção é o último passo e é decisão sua, com o backup já verificado.

Regra que vale para tudo: **nada é removido antes de a instalação nova passar no diagnóstico.**

---

## Fase A — Inventário (5 minutos, nada muda)

```powershell
# 1. o que está rodando nas portas
Get-NetTCPConnection -LocalPort 1455,3000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalPort, OwningProcess

# 2. de onde vem cada processo
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Select-Object ProcessId, CommandLine

# 3. versões no disco
Get-ChildItem 'C:\CRiando coisa nova\Kirana' -Recurse -Filter package.json -Depth 4 -ErrorAction SilentlyContinue |
  ForEach-Object { "$($_.FullName) = " + (Get-Content $_.FullName -Raw | ConvertFrom-Json).version }
```

Anote: quais PIDs estão nas portas e quais pastas ainda existem. É o seu "antes".

**Projetos que não entram em nada disto** (não apagar, não mover, não reconfigurar):
`Kirana-Arena-Bridge`, `opportunity-site-pronto`, e qualquer repositório Git.

## Fase B — Backup (obrigatório, verificado)

```powershell
# a partir da pasta da distribuição nova
.\BACKUP-ANTES-DE-LIMPAR.cmd -RaizAntiga "C:\CRiando coisa nova\Kirana" -IncluirEstado
```

O script:

- ignora `Kirana-Arena-Bridge` e `opportunity-site-pronto`;
- copia cada `.env` encontrado, confere SHA-256 origem × cópia e aborta se divergir;
- com `-IncluirEstado`, compacta cada `.local-state` e confere o hash;
- grava `MANIFESTO.json` e `SHA256SUMS.txt` e **reconfere tudo no fim**.

Se aparecer `divergencia em ...`, **pare** e não siga para a Fase C.

Guarde o caminho impresso (algo como `backups\pre-limpeza-20261029-143000`). É a sua volta atrás.

## Fase C — Encerrar processos antigos

```powershell
# 1. encerre primeiro o que esta distribuicao iniciou (se for o caso)
.\PARAR-TUDO.cmd

# 2. se ainda houver processo antigo nas portas, confira o caminho ANTES de encerrar
Get-CimInstance Win32_Process -Filter "ProcessId=<PID>" | Select-Object ProcessId, ExecutablePath, CommandLine
Stop-Process -Id <PID>
```

O pacote **não** encerra processo que não iniciou. Se preferir, feche a janela do launcher antigo.

Confirme que as portas ficaram livres:

```powershell
Get-NetTCPConnection -LocalPort 1455,3000 -State Listen -ErrorAction SilentlyContinue
# não deve retornar nada
```

## Fase D — Instalar em pasta vazia

```powershell
# pasta nova, fora da árvore antiga
mkdir C:\Kirana-sistema
# extraia o ZIP de modo que fique:
#   C:\Kirana-sistema\Kirana-v0.5.5-com-Gateway-v0.4.1-Windows\
cd C:\Kirana-sistema\Kirana-v0.5.5-com-Gateway-v0.4.1-Windows
.\INSTALAR-WINDOWS.cmd
```

Não copie `node_modules` nem pastas antigas para dentro. A instalação é nova; o que vem de fora
são **variáveis de configuração**, e isso é a Fase E.

## Fase E — Migrar configurações (controlado)

```powershell
# 1. veja o plano (não grava nada)
.\MIGRAR-ENV.cmd -RaizAntiga "C:\CRiando coisa nova\Kirana"

# 2. leia a classificação: compativel / renomeada / NAO COPIAR / desconhecida
# 3. se concordar, aplique
.\MIGRAR-ENV.cmd -RaizAntiga "C:\CRiando coisa nova\Kirana" -Aplicar
```

A saída mostra nomes e tamanhos, nunca valores. `OPENAI_API_KEY` e afins são recusadas.

Depois, abra `Kirana\.env` e `Gateway\.env` no Bloco de Notas e confira:
`KIRANA_GATEWAY_API_KEY` (na Kirana) deve ser **igual** a `GATEWAY_API_KEY` (no Gateway).

## Fase F — Subir e validar

```powershell
.\INICIAR-TUDO.cmd
.\DIAGNOSTICO.cmd
```

Critério de aceitação da instalação nova:

| Item | Exigido |
|---|---|
| `Kirana/package.json` | `0.5.5` |
| `Gateway/package.json` | `0.4.1` |
| serviço na 1455 | responde `version: 0.4.1` |
| serviço na 3000 | responde `version: 0.5.5` |
| `run\gateway.pid` | PID da 1455 |
| .env | ambos presentes; `KIRANA_GATEWAY_API_KEY` preenchida |
| ponte | `GET /api/gateway/ping` responde (ou 403 esperado com HTTPS obrigatório) |
| veredito | **sem FALHAS** |

Autorize o SIWC e **não reinicie em seguida**:

```
http://127.0.0.1:1455/auth/start
```

Rode o diagnóstico de novo: `authenticated` deve virar `true` e `/v1/models` deve listar modelos.

## Fase G — Teste de persistência (o que muita gente esquece)

Reinicie **o computador** (não só o serviço) e repita:

```powershell
.\INICIAR-TUDO.cmd
.\DIAGNOSTICO.cmd
```

Esperado:

- versões continuam Gateway 0.4.1 / Kirana 0.5.5 (persistência do pacote);
- `.env` intactos (persistência de configuração);
- `authenticated: false` — **isto é o esperado**, não é regressão: tokens são memory-only;
- `registrationConfigured: true` — o registro do cliente persistiu;
- depois de autorizar, conversa funcionando.

Se `registrationConfigured` vier `false` após reiniciar, o `.local-state` está sendo criado em
outro lugar: verifique se o launcher foi o desta distribuição (`run\gateway.pid`).

## Fase H — Só agora, remover as pastas antigas

Confirme que a Fase G passou. Então, uma por uma:

| Pasta | Ação sugerida |
|---|---|
| `Kirana-v0.5.3-Completa-com-Gateway-Windows` | pode remover (backup já feito) |
| `kirana-fase1-v0.1.0` | pode arquivar (mover para `_arquivo/`) em vez de apagar |
| `Kirana-ChatGPT-Gateway-v0.4.0-Windows` | pode remover após confirmar que não é ela que está na 1455 |
| `Kirana-Arena-Bridge` | **NÃO TOCAR** |
| `opportunity-site-pronto` | **NÃO TOCAR** |

Sugestão conservadora: mova para `C:\CRiando coisa nova\_arquivo-2026-10\` por duas semanas.
Se nada quebrar, apague. Isso custa alguns GB e evita uma tarde de arrependimento.

Antes de apagar qualquer coisa, confirme que nenhum processo roda de dentro dela:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine
# se o CommandLine citar a pasta antiga, ela ainda esta em uso
```

## O que uma instalação limpa NÃO resolve

- **Autorização SIWC**: os tokens nunca estiveram em disco. Reinstalar não autentica.
- **Conta/plano sem o escopo `chatgpt.tokens.use.direct`**: nenhuma reinstalação muda concessão.
- **Reinício do Gateway**: continua exigindo nova autorização, por decisão do próprio Gateway.

Se depois da Fase F o `authenticated` não virar `true`, o caminho é `docs/MIGRACAO-ENV-E-SIWC.md` §4,
não outra reinstalação.
