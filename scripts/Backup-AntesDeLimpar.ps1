# Backup-AntesDeLimpar.ps1 - copia .env e estado das instalacoes ANTIGAS.
#
# Este script NAO apaga nada. Ele so copia, calcula SHA-256 e produz um
# manifesto para voce conferir depois. A limpeza e uma etapa separada,
# documentada em docs/INSTALACAO-LIMPA.md, e nao e feita por script.
#
# Por que nao apagar automaticamente: as pastas contem .local-state (registro
# do cliente SIWC), sessoes e memoria da Kirana. Apagar sem backup verificado
# inviabiliza voltar atras.

param(
    [string]$RaizAntiga = 'C:\CRiando coisa nova\Kirana',
    [string]$Destino = '',
    [switch]$IncluirEstado
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Comum.ps1')

$Raiz = Get-RaizDistribuicao
if (-not $Destino) { $Destino = Join-Path $Raiz ("backups\pre-limpeza-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }

Write-Host ''
Write-Host '  Backup antes de limpar instalacoes antigas' -ForegroundColor Cyan
Write-Host "  origem : $RaizAntiga"
Write-Host "  destino: $Destino"
Write-Host "  estado : $(if ($IncluirEstado) { 'INCLUIR .local-state e data/' } else { 'somente .env (use -IncluirEstado para tambem copiar dados)' })"
Write-Host ''

if (-not (Test-Path $RaizAntiga)) {
    Write-Erro "Pasta nao encontrada: $RaizAntiga"
    Write-Host '  Informe o caminho real com: .\scripts\Backup-AntesDeLimpar.ps1 -RaizAntiga "C:\..."'
    exit 1
}

New-Item -ItemType Directory -Force -Path $Destino | Out-Null

Write-Passo '1. Projetos PROTEGIDOS (serao ignorados)'
$protegidos = @('Kirana-Arena-Bridge', 'opportunity-site-pronto')
foreach ($p in $protegidos) {
    if (Test-Path (Join-Path $RaizAntiga $p)) { Write-Ok "$p - intocado (fora do backup)" }
}

Write-Passo '2. Arquivos .env encontrados'
$arquivosEnv = @(Get-ChildItem -Path $RaizAntiga -Recurse -Filter '.env' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notlike "*$($Raiz)*" -and $_.FullName -notmatch 'Kirana-Arena-Bridge|opportunity-site-pronto|node_modules' })
if ($arquivosEnv.Count -eq 0) {
    Write-Aviso 'Nenhum .env encontrado fora dos projetos protegidos.'
} else {
    foreach ($arq in $arquivosEnv) { Write-Host "  - $($arq.FullName)  ($($arq.Length) bytes)" }
}

Write-Passo '3. Estados (.local-state) encontrados'
$estados = @(Get-ChildItem -Path $RaizAntiga -Recurse -Directory -Filter '.local-state' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch 'Kirana-Arena-Bridge|opportunity-site-pronto|node_modules' })
foreach ($e in $estados) {
    $tamanho = (Get-ChildItem $e.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    Write-Host "  - $($e.FullName)  ($([math]::Round($tamanho/1KB,1)) KB)"
    $reg = Join-Path $e.FullName 'kirana-personal-gateway/registration.json'
    if (Test-Path $reg) {
        try {
            $r = Get-Content $reg -Raw | ConvertFrom-Json
            $cid = if ($r.clientId) { $r.clientId.Substring(0, [Math]::Min(8, $r.clientId.Length)) + '...' } else { '(sem clientId)' }
            Write-Host "      registration.json: hostId $($r.hostId) · clientId $cid" -ForegroundColor DarkGray
        } catch { Write-Host '      registration.json ilegivel' -ForegroundColor DarkGray }
    }
}

Write-Passo '4. Copiando'
$manifesto = New-Object System.Collections.Generic.List[object]
$indice = 0
foreach ($arq in $arquivosEnv) {
    $indice++
    $rotulo = "env-$indice"
    $destinoArq = Join-Path $Destino "$rotulo.env"
    Copy-Item $arq.FullName $destinoArq -Force
    $hashOrigem = (Get-FileHash $arq.FullName -Algorithm SHA256).Hash
    $hashCopia = (Get-FileHash $destinoArq -Algorithm SHA256).Hash
    if ($hashOrigem -ne $hashCopia) { Write-Erro "copia de $($arq.FullName) nao confere"; exit 1 }
    Write-Ok "$rotulo ← $($arq.FullName)  (sha256 $($hashOrigem.Substring(0,16))...)"
    $manifesto.Add([pscustomobject]@{ Tipo = 'env'; Origem = $arq.FullName; Copia = $destinoArq; Sha256 = $hashOrigem })
}

if ($IncluirEstado) {
    $indice = 0
    foreach ($e in $estados) {
        $indice++
        $rotulo = "estado-$indice.zip"
        $destinoZip = Join-Path $Destino $rotulo
        Compress-Archive -Path (Join-Path $e.FullName '*') -DestinationPath $destinoZip -Force -ErrorAction SilentlyContinue
        if (Test-Path $destinoZip) {
            $hash = (Get-FileHash $destinoZip -Algorithm SHA256).Hash
            Write-Ok "$rotulo ← $($e.FullName)  (sha256 $($hash.Substring(0,16))...)"
            $manifesto.Add([pscustomobject]@{ Tipo = 'estado'; Origem = $e.FullName; Copia = $destinoZip; Sha256 = $hash })
        } else {
            Write-Aviso "nao foi possivel compactar $($e.FullName)"
        }
    }
} else {
    if ($estados.Count -gt 0) {
        Write-Aviso "Estados NAO copiados ($($estados.Count) encontrados). Use -IncluirEstado para incluir .local-state."
        Write-Host '         Sem isso, a autorizacao SIWC antiga e a memoria da Kirana ficam so no lugar original.'
    }
}

Write-Passo '5. Integridade do backup'
$manifesto | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $Destino 'MANIFESTO.json') -Encoding UTF8
$linhas = foreach ($m in $manifesto) { "$($m.Sha256)  $(Split-Path $m.Copia -Leaf)" }
$arquivoSums = Join-Path $Destino 'SHA256SUMS.txt'
$linhas | Set-Content $arquivoSums -Encoding UTF8
Write-Ok "manifesto: $(Join-Path $Destino 'MANIFESTO.json')"
Write-Ok "hashes   : $arquivoSums"

$reconferidos = 0
$divergentes = 0
foreach ($m in $manifesto) {
    $atual = (Get-FileHash $m.Copia -Algorithm SHA256).Hash
    if ($atual -eq $m.Sha256) { $reconferidos++ } else { $divergentes++; Write-Erro "divergencia em $($m.Copia)" }
}
Write-Ok "$reconferidos arquivo(s) reconferidos apos a copia; $divergentes divergencia(s)"

Write-Passo '6. Proximo passo'
Write-Host '  O backup esta pronto. A limpeza NAO foi feita e nao sera feita por script.'
Write-Host '  Leia docs\INSTALACAO-LIMPA.md e siga a ordem: encerrar processos -> instalar em pasta vazia'
Write-Host '  -> migrar .env -> validar -> so entao remover as pastas antigas.'
Write-Host ''
if ($divergentes -gt 0) { exit 1 }
exit 0
