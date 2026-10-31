# Instalar.ps1 - instalacao de dependencias e .env, sem sobrescrever nada.
#
# Principios:
#  - nunca sobrescreve um .env existente (faz backup e complementa o que falta);
#  - nunca imprime segredo (so o comprimento);
#  - nunca depende do diretorio atual (usa a raiz da distribuicao);
#  - falha com mensagem clara em vez de "seguir meio instalado".

param([switch]$ReinstalarDependencias)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Comum.ps1')

$Raiz = Get-RaizDistribuicao
$Kirana = Join-Path $Raiz 'Kirana'
$Gateway = Join-Path $Raiz 'Gateway'

Write-Host ''
Write-Host '  Kirana v0.5.5 + Gateway v0.4.1 - instalacao' -ForegroundColor Cyan
Write-Host "  raiz: $Raiz"
Write-Host ''

Write-Passo '1. Versoes declaradas no pacote'
$versaoKirana = Read-IniVersaoPacote (Join-Path $Kirana 'package.json')
$versaoGateway = Read-IniVersaoPacote (Join-Path $Gateway 'package.json')
if ($versaoKirana -ne '0.5.5') { Write-Erro "Kirana/package.json = '$versaoKirana', esperado 0.5.5. Pacote incorreto."; exit 1 }
if ($versaoGateway -ne '0.4.1') { Write-Erro "Gateway/package.json = '$versaoGateway', esperado 0.4.1. Pacote incorreto."; exit 1 }
Write-Ok "Kirana $versaoKirana"
Write-Ok "Gateway $versaoGateway"

if (-not (Test-Path (Join-Path $Gateway 'src/engine.js'))) {
    Write-Erro 'Gateway/src/engine.js ausente: este e o codigo que define a v0.4.1. Pacote invalido.'
    exit 1
}
Write-Ok 'Gateway/src/engine.js presente (codigo real da v0.4.1)'

Write-Passo '2. Node.js'
$node = Assert-Node
if (-not $node) { exit 1 }

Write-Passo '3. Verificacao estrutural da instalacao'
# --instalacao: aqui a pasta pode (e deve) conter node_modules, .env, .local-state
# e data de uma execucao anterior. O modo release, que proibe esses caminhos, e
# usado so na conferencia do ZIP de entrega. Sem esta separacao, o instalador se
# bloqueava na segunda execucao na mesma pasta.
& node (Join-Path $Raiz 'tools/verificar-pacote.mjs') --instalacao
if ($LASTEXITCODE -ne 0) {
    Write-Erro 'A verificacao estrutural falhou. Nao continue: o pacote esta incoerente.'
    exit 1
}

Write-Passo '4. Dependencias'
foreach ($par in @(@{ Nome = 'Gateway'; Pasta = $Gateway }, @{ Nome = 'Kirana'; Pasta = $Kirana })) {
    $modulos = Join-Path $par.Pasta 'node_modules'
    if ((Test-Path $modulos) -and -not $ReinstalarDependencias) {
        Write-Ok "$($par.Nome): node_modules ja existe (use -ReinstalarDependencias para refazer)"
        continue
    }
    Write-Host "  instalando $($par.Nome) (pode levar alguns minutos)..."
    Push-Location $par.Pasta
    try {
        & npm install --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install falhou em $($par.Nome)" }
    } finally {
        Pop-Location
    }
    Write-Ok "$($par.Nome): dependencias instaladas"
}

Write-Passo '4b. Instalacao existente (antes de gerar qualquer chave)'
# Um Gateway ativo (com SIWC em memoria) so aceita a chave com a qual foi iniciado.
# Gerar outra aqui causaria HTTP 401 permanente. O detector so le e informa; a chave
# adotada (se houver) fica numa variavel e nunca e impressa.
$chaveAdotada = $null
$saidaDeteccao = @(& node (Join-Path $Raiz 'tools/detectar-instalacao.mjs'))
$codigoDeteccao = $LASTEXITCODE
foreach ($linhaDeteccao in $saidaDeteccao) {
    if ([string]$linhaDeteccao -like 'CHAVE:*') { $chaveAdotada = ([string]$linhaDeteccao).Substring(6) }
    else { Write-Host $linhaDeteccao }
}
if ($codigoDeteccao -ne 0) {
    Write-Erro 'Conflito com um Gateway ja ativo. Nada foi gravado e nenhum processo foi tocado.'
    exit 1
}
$chaveGateway = if ($chaveAdotada) { $chaveAdotada } else { New-TokenAleatorio }

Write-Passo '5. Arquivos .env'
$envBackup = Join-Path $Raiz ("backups\env-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $envBackup | Out-Null

function Preparar-Env([string]$Pasta, [string]$Nome, [System.Collections.IDictionary]$Padroes) {
    # IDictionary, nao [hashtable]: o chamador passa [ordered]@{} (OrderedDictionary)
    # e o Windows PowerShell 5.1 nao converte OrderedDictionary para Hashtable -
    # a instalacao morreria antes de gravar qualquer chave. IDictionary aceita os
    # dois tipos, mantendo a ordem de insercao.
    $destino = Join-Path $Pasta '.env'
    $exemplo = Join-Path $Pasta '.env.example'
    if (Test-Path $destino) {
        Copy-Item $destino (Join-Path $envBackup "$Nome.env.bak")
        $hash = (Get-FileHash (Join-Path $envBackup "$Nome.env.bak") -Algorithm SHA256).Hash
        Write-Aviso "$Nome/.env ja existia - preservado. Backup: backups\env-...\$Nome.env.bak (sha256 $($hash.Substring(0,16))...)"
    } elseif (Test-Path $exemplo) {
        Copy-Item $exemplo $destino
        Write-Ok "$Nome/.env criado a partir de .env.example"
    } else {
        New-Item -ItemType File -Path $destino | Out-Null
        Write-Aviso "$Nome/.env criado vazio (sem .env.example)"
    }

    $mapa = Read-ArquivoEnv $destino
    $linhas = @(Get-Content $destino -Encoding UTF8)

    foreach ($chave in $Padroes.Keys) {
        $valorAtual = $mapa[$chave]
        $novo = $null
        if ([string]::IsNullOrEmpty($valorAtual) -or $valorAtual -eq 'generate-with-npm-run-keygen') {
            $novo = $Padroes[$chave]
        }
        if ($null -eq $novo) { continue }
        $encontrou = $false
        for ($i = 0; $i -lt $linhas.Count; $i++) {
            if ($linhas[$i] -match "^\s*$([regex]::Escape($chave))=") {
                $linhas[$i] = "$chave=$novo"
                $encontrou = $true
                break
            }
        }
        if (-not $encontrou) { $linhas += "$chave=$novo" }
        if ($chave -match 'KEY|TOKEN') { Write-Ok "$Nome/.env: $chave gerado $(Format-Mascarado $novo)" }
        else { Write-Ok "$Nome/.env: $chave=$novo" }
    }
    [System.IO.File]::WriteAllLines($destino, $linhas, (New-Object System.Text.UTF8Encoding($false)))
}

$tokenPonte = New-TokenAleatorio
Preparar-Env -Pasta $Gateway -Nome 'Gateway' -Padroes ([ordered]@{ 'GATEWAY_API_KEY' = $chaveGateway; 'HOST' = '127.0.0.1'; 'PORT' = '1455' })
Preparar-Env -Pasta $Kirana -Nome 'Kirana' -Padroes ([ordered]@{
    'KIRANA_HOST' = '127.0.0.1'
    'KIRANA_PORT' = '3000'
    'KIRANA_GATEWAY_URL' = 'http://127.0.0.1:1455'
    'KIRANA_BRIDGE' = 'on'
    'KIRANA_BRIDGE_TOKEN' = $tokenPonte
})

Write-Passo '6. Chave local: gerar, alinhar e conferir (automatico)'
# Gateway/.env e a autoridade da chave Bearer local. Se nao existir, o keygen do
# proprio Gateway gera; se existir, e preservada. O valor correspondente vai para
# Kirana/.env como KIRANA_GATEWAY_API_KEY. Nenhum valor e impresso.
& node (Join-Path $Raiz 'tools/configurar.mjs')
if ($LASTEXITCODE -ne 0) {
    Write-Erro 'Nao foi possivel alinhar a chave local. Nada deve ser iniciado.'
    exit 1
}

Write-Passo '7. Pre-voo (antes de qualquer inicio)'
& node (Join-Path $Raiz 'tools/checar-config.mjs')
if ($LASTEXITCODE -ne 0) {
    Write-Erro 'A configuracao nao passou no pre-voo. Nada foi iniciado.'
    exit 1
}

$envKirana = Read-ArquivoEnv (Join-Path $Kirana '.env')
Write-Host "  Kirana/KIRANA_BRIDGE_TOKEN: $(Format-Mascarado $envKirana['KIRANA_BRIDGE_TOKEN'])"
Write-Host '  As chaves nao foram impressas. Elas ja estao iguais nos dois .env.'

Write-Passo '8. Proximo passo'
Write-Host '  1) .\INICIAR-TUDO.cmd      - sobe Gateway (1455) e Kirana (3000) e abre a interface'
Write-Host '  2) abra http://127.0.0.1:1455/auth/start no navegador e autorize o SIWC'
Write-Host '  3) .\DIAGNOSTICO.cmd       - confere versoes, portas, SIWC e ponte'
Write-Host ''
Write-Host '  Autorizacao SIWC fica em MEMORIA: depois de reiniciar o Gateway, autorize de novo.' -ForegroundColor Yellow
Write-Host ''
