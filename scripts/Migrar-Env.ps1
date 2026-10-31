# Migrar-Env.ps1 - traz configuracoes das instalacoes antigas sem copiar lixo.
#
# Por padrao NAO altera nada: mostra o plano. Use -Aplicar para gravar.
#
# Regras:
#  - backup de TODOS os .env encontrados, com SHA-256, antes de qualquer escrita;
#  - compara NOMES de variavel (nunca imprime valores, so comprimento);
#  - classifica cada variavel em: compativel / renomeada / obsoleta / desconhecida;
#  - so grava as compativeis e as renomeadas com equivalente conhecido;
#  - nunca copia .env inteiro de uma instalacao para outra.

param(
    [string[]]$Origens = @(),
    [string]$RaizAntiga = 'C:\CRiando coisa nova\Kirana',
    [switch]$Aplicar
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Comum.ps1')

# Correcao necessaria (encontrada em teste real): ao chamar com -File, o
# PowerShell entrega "-Origens a,b,c" como UMA string. Sem isso, o script
# tentava copiar um arquivo chamado "a,b,c" e falhava.
if ($Origens.Count -eq 1 -and $Origens[0] -match ',') {
    $Origens = $Origens[0] -split ','
}
$Origens = @($Origens | ForEach-Object { $_.Trim().Trim('"').Trim("'") } | Where-Object { $_ })

$Raiz = Get-RaizDistribuicao

# ---------------------------------------------------------------- tabelas ---
# Variaveis que o Gateway v0.4.1 realmente le (src/main.js e adaptadores).
$compatGateway = @(
    'GATEWAY_API_KEY', 'HOST', 'PORT', 'APP_NAME', 'APP_ID',
    'FILE_MAX_BYTES', 'FILE_MAX_TOTAL_BYTES', 'FILE_MAX_COUNT', 'FILE_TTL_SECONDS',
    'KIRANA_ROUTING', 'KIRANA_PRIMARY_MODEL', 'KIRANA_FALLBACK_MODEL', 'KIRANA_COST_POLICY',
    'KIRANA_ENGINE_TIMEOUT_MS', 'KIRANA_ENGINE_ATTEMPTS', 'KIRANA_BREAKER_FAILURES',
    'KIRANA_BREAKER_RESET_MS', 'KIRANA_MODEL_CATALOG', 'KIRANA_SPECIALIZED',
    'KIRANA_IMAGE_ANALYSIS_PROVIDER', 'KIRANA_IMAGE_GENERATION_PROVIDER', 'KIRANA_IMAGE_EDIT_PROVIDER',
    'KIRANA_VIDEO_ANALYSIS_PROVIDER', 'KIRANA_VIDEO_GENERATION_PROVIDER',
    'KIRANA_SPEECH_TO_TEXT_PROVIDER', 'KIRANA_TEXT_TO_SPEECH_PROVIDER',
    'FFMPEG_PATH', 'WHISPER_CPP_PATH', 'WHISPER_MODEL_PATH', 'WHISPER_TIMEOUT_MS',
    'PIPER_PATH', 'PIPER_MODEL_PATH', 'PIPER_VOICE_ID', 'PIPER_TIMEOUT_MS',
    'VIDEO_ANALYSIS_MAX_SECONDS', 'COMFYUI_BASE_URL',
    'COMFYUI_IMAGE_GENERATE_WORKFLOW', 'COMFYUI_IMAGE_EDIT_WORKFLOW', 'COMFYUI_VIDEO_GENERATE_WORKFLOW',
    'COMFYUI_POLL_INTERVAL_MS', 'COMFYUI_MAX_JOB_MS'
)

# Variaveis que a Kirana v0.5.5 realmente le (src/config.js).
$compatKirana = @(
    'KIRANA_ENV', 'KIRANA_HOST', 'KIRANA_PORT', 'KIRANA_ACCESS_TOKEN',
    'KIRANA_GATEWAY_URL', 'KIRANA_GATEWAY_API_KEY', 'KIRANA_REQUEST_TIMEOUT_MS', 'KIRANA_FIRST_TOKEN_TIMEOUT_MS',
    'KIRANA_MODEL_PROBE', 'KIRANA_MODELS_PRIMARY', 'KIRANA_MODELS_FALLBACK',
    'KIRANA_SEND_TEMPERATURE', 'KIRANA_SEND_MAX_TOKENS', 'KIRANA_SEND_TOOL_CHOICE',
    'KIRANA_RATE_LIMIT_MAX', 'KIRANA_RATE_LIMIT_WINDOW_MS', 'KIRANA_AGENT_RATE_MAX',
    'KIRANA_MAX_BODY_BYTES', 'KIRANA_MAX_TOKENS', 'KIRANA_LOG_LEVEL', 'KIRANA_DATA_DIR',
    'KIRANA_TRUST_PROXY', 'KIRANA_ALLOWED_ORIGINS', 'KIRANA_EMBED_ORIGINS', 'KIRANA_ALLOW_EMBED',
    'KIRANA_BRIDGE', 'KIRANA_BRIDGE_TOKEN', 'KIRANA_BRIDGE_TIMEOUT_MS', 'KIRANA_BRIDGE_RATE_MAX',
    'KIRANA_BRIDGE_REQUIRE_HTTPS', 'KIRANA_BRIDGE_TRUST_PROXY'
)

# Nomes antigos/errados -> nome atual. 'PORT' x 'GATEWAY_PORT' e o caso classico.
$renomeacoes = @{
    'GATEWAY_PORT'                = @{ Destino = 'Gateway'; Nome = 'PORT' }
    'GATEWAY_HOST'                = @{ Destino = 'Gateway'; Nome = 'HOST' }
    'OPENAI_API_KEY'              = @{ Destino = 'nenhum'; Nome = $null }
    'CHATGPT_API_KEY'             = @{ Destino = 'nenhum'; Nome = $null }
    'KIRANA_GATEWAY_KEY'          = @{ Destino = 'Kirana'; Nome = 'KIRANA_GATEWAY_API_KEY' }
    'KIRANA_GATEWAY_TOKEN'        = @{ Destino = 'Kirana'; Nome = 'KIRANA_GATEWAY_API_KEY' }
    'KIRANA_PORT_GATEWAY'         = @{ Destino = 'Gateway'; Nome = 'PORT' }
    'KIRANA_BRIDGE_ENABLED'       = @{ Destino = 'Kirana'; Nome = 'KIRANA_BRIDGE' }
}

$proibidas = @('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CHATGPT_API_KEY', 'PASSWORD', 'SECRET')

function Classificar([string]$nome, [string]$destino) {
    $lista = if ($destino -eq 'Gateway') { $compatGateway } else { $compatKirana }
    if ($lista -contains $nome) { return @{ Tipo = 'compativel'; Novo = $nome } }
    if ($renomeacoes.ContainsKey($nome)) {
        $r = $renomeacoes[$nome]
        if ($r.Destino -eq $destino -and $r.Nome) { return @{ Tipo = 'renomeada'; Novo = $r.Nome } }
        if ($r.Destino -eq 'nenhum') { return @{ Tipo = 'proibida'; Novo = $null } }
        return @{ Tipo = 'outro-componente'; Novo = $null }
    }
    if ($proibidas -contains $nome) { return @{ Tipo = 'proibida'; Novo = $null } }
    return @{ Tipo = 'desconhecida'; Novo = $null }
}

# ------------------------------------------------------------- descoberta ---
Write-Host ''
Write-Host '  Migracao de .env - Kirana v0.5.5 + Gateway v0.4.1' -ForegroundColor Cyan
Write-Host "  destino: $Raiz"
Write-Host "  modo   : $(if ($Aplicar) { 'APLICAR (grava)' } else { 'PLANO (nao altera nada)' })"
Write-Host ''

if ($Origens.Count -eq 0) {
    if (Test-Path $RaizAntiga) {
        $Origens = @(Get-ChildItem -Path $RaizAntiga -Recurse -Filter '.env' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notlike "*$($Raiz)*" } |
            Select-Object -ExpandProperty FullName)
    }
}

if ($Origens.Count -eq 0) {
    Write-Aviso "Nenhum .env encontrado. Informe manualmente com -Origens 'C:\caminho\.env','C:\outro\.env'"
    exit 0
}

Write-Passo "1. Arquivos encontrados ($($Origens.Count))"
$i = 0
foreach ($origem in $Origens) {
    $i++
    Write-Host "  [$i] $origem"
}
if ($Origens.Count -eq 4) { Write-Ok 'Os quatro .env conhecidos do seu relatorio foram localizados.' }

Write-Passo '2. Backup (antes de qualquer escrita)'
$dirBackup = Join-Path $Raiz ("backups\migracao-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $dirBackup | Out-Null
$backups = @()
$i = 0
foreach ($origem in $Origens) {
    $i++
    $destinoBackup = Join-Path $dirBackup ("origem-$i.env.bak")
    Copy-Item -Path $origem -Destination $destinoBackup -Force
    $hash = (Get-FileHash $destinoBackup -Algorithm SHA256).Hash
    if ((Get-FileHash $origem -Algorithm SHA256).Hash -ne $hash) {
        Write-Erro "copia de $origem nao confere! Parando."
        exit 1
    }
    $backups += [pscustomobject]@{ Origem = $origem; Backup = $destinoBackup; Sha256 = $hash }
    Write-Ok "origem-$i → $([System.IO.Path]::GetFileName((Split-Path $origem -Parent)))\.env (sha256 $($hash.Substring(0,16))...)"
}
$backups | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $dirBackup 'MANIFESTO.json') -Encoding UTF8
Write-Ok "manifesto com SHA-256: $dirBackup\MANIFESTO.json"

Write-Passo '3. Analise por variavel (valores nunca sao mostrados)'
$consolidado = @{ Gateway = @{}; Kirana = @{} }
$relatorio = New-Object System.Collections.Generic.List[object]

foreach ($item in $backups) {
    Write-Host ''
    Write-Host "  --- $($item.Origem)" -ForegroundColor DarkCyan
    $mapa = Read-ArquivoEnv $item.Origem
    $pareceGateway = ($mapa.ContainsKey('GATEWAY_API_KEY')) -or ($mapa.ContainsKey('PORT')) -or ($item.Origem -like '*Gateway*')
    $pareceKirana = ($mapa.ContainsKey('KIRANA_GATEWAY_URL')) -or ($mapa.ContainsKey('KIRANA_PORT')) -or ($item.Origem -like '*Kirana*')
    $destino = if ($pareceGateway -and -not $pareceKirana) { 'Gateway' } elseif ($pareceKirana -and -not $pareceGateway) { 'Kirana' } elseif ($pareceGateway -and $pareceKirana) { 'Ambos' } else { 'Indefinido' }
    Write-Host "  destino inferido: $destino" -ForegroundColor DarkGray

    foreach ($nome in ($mapa.Keys | Sort-Object)) {
        $alvos = switch ($destino) { 'Gateway' { @('Gateway') } 'Kirana' { @('Kirana') } 'Ambos' { @('Gateway', 'Kirana') } default { @('Gateway', 'Kirana') } }
        foreach ($alvo in $alvos) {
            $classe = Classificar $nome $alvo
            if ($classe.Tipo -eq 'outro-componente') { continue }
            $marca = switch ($classe.Tipo) {
                'compativel' { 'compativel  ' }
                'renomeada' { 'renomeada   ' }
                'proibida' { 'NAO COPIAR  ' }
                default { 'desconhecida' }
            }
            $cor = switch ($classe.Tipo) { 'compativel' { 'Green' } 'renomeada' { 'Yellow' } 'proibida' { 'Red' } default { 'DarkGray' } }
            $extra = if ($classe.Novo -and $classe.Novo -ne $nome) { " -> $($classe.Novo)" } else { '' }
            Write-Host ("    [{0}] {1,-34} {2}{3}" -f $marca, $nome, (Format-Mascarado $mapa[$nome]), $extra) -ForegroundColor $cor

            $relatorio.Add([pscustomobject]@{
                    Origem  = $item.Origem
                    Componente = $alvo
                    Variavel = $nome
                    Classe  = $classe.Tipo
                    NovoNome = $classe.Novo
                    Tamanho = if ($mapa[$nome]) { $mapa[$nome].Length } else { 0 }
                })

            if ($classe.Tipo -eq 'compativel' -or $classe.Tipo -eq 'renomeada') {
                if (-not $consolidado[$alvo].ContainsKey($classe.Novo)) {
                    $consolidado[$alvo][$classe.Novo] = $mapa[$nome]
                }
            }
        }
    }
}

Write-Passo '4. Consolidado (o que seria gravado)'
foreach ($alvo in @('Gateway', 'Kirana')) {
    $chaves = $consolidado[$alvo].Keys | Sort-Object
    Write-Host "  $alvo : $($chaves.Count) variavel(is) compativel(is)"
    if ($chaves.Count) { Write-Host "    $($chaves -join ', ')" -ForegroundColor DarkGray }
}

$dirRelatorio = Join-Path $Raiz ("backups\" + (Split-Path $dirBackup -Leaf))
$relatorio | Export-Csv -Path (Join-Path $dirRelatorio 'analise-variaveis.csv') -NoTypeInformation -Encoding UTF8
Write-Ok "analise detalhada (so nomes e tamanhos): $dirRelatorio\analise-variaveis.csv"

Write-Passo '5. Gravacao'
if (-not $Aplicar) {
    Write-Aviso 'Modo PLANO: nada foi gravado no .env de destino.'
    Write-Host '         Para aplicar: .\scripts\Migrar-Env.ps1 -Aplicar'
    Write-Host '         Recomendacao: rode .\INSTALAR-WINDOWS.cmd antes, para o .env de destino existir.'
    exit 0
}

foreach ($alvo in @('Gateway', 'Kirana')) {
    $caminho = Join-Path (Join-Path $Raiz $alvo) '.env'
    if (-not (Test-Path $caminho)) {
        Copy-Item $caminho (Join-Path $dirRelatorio "$alvo.env.antes.bak") -ErrorAction SilentlyContinue
        Write-Aviso "$alvo/.env nao existia; rode o INSTALAR primeiro. Pulando gravacao."
        continue
    }
    Copy-Item $caminho (Join-Path $dirRelatorio "$alvo.env.antes.bak") -Force
    $linhas = @(Get-Content $caminho -Encoding UTF8)
    $gravadas = 0
    foreach ($nome in ($consolidado[$alvo].Keys | Sort-Object)) {
        $valor = $consolidado[$alvo][$nome]
        $achou = $false
        for ($k = 0; $k -lt $linhas.Count; $k++) {
            if ($linhas[$k] -match "^\s*$([regex]::Escape($nome))=") {
                if ($linhas[$k] -match '=\s*$') { $linhas[$k] = "$nome=$valor"; $gravadas++ }
                $achou = $true
                break
            }
        }
        if (-not $achou) { $linhas += "$nome=$valor"; $gravadas++ }
    }
    [System.IO.File]::WriteAllLines($caminho, $linhas, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok "$alvo/.env atualizado ($gravadas variavel(is)); backup anterior em $dirRelatorio"
}

Write-Passo '6. Conferencia'
Write-Host '  Rode agora:'
Write-Host '    .\INICIAR-TUDO.cmd'
Write-Host '    .\DIAGNOSTICO.cmd'
Write-Host ''
Write-Host '  Se o diagnostico apontar SIWC inativa: autorize em http://127.0.0.1:1455/auth/start' -ForegroundColor Yellow
Write-Host '  (tokens sao memory-only; migrar .env NAO traz autorizacao antiga).' -ForegroundColor Yellow
Write-Host ''
