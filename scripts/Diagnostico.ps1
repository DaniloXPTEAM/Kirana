# Diagnostico.ps1 - relatorio do estado real, com veredicto.
#
# Regra central: compara SEMPRE tres numeros por componente -
#   (a) versao da PASTA (package.json)
#   (b) versao que o SERVICO responde em /health
#   (c) versao que o DISCO diz do processo que ocupa a porta
# Se (a) != (b), o diagnostico FALHA. Foi exatamente essa divergencia que a
# entrega anterior escondeu (pasta 0.4.1, servico 0.4.0).
#
# Nao imprime segredo algum: apenas presenca e comprimento.

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'Comum.ps1')

$Raiz = Get-RaizDistribuicao
$falhas = New-Object System.Collections.Generic.List[string]
$avisos = New-Object System.Collections.Generic.List[string]
$linhas = New-Object System.Collections.Generic.List[object]

function Linha($item, $valor, $situacao) {
    $linhas.Add([pscustomobject]@{ Item = $item; Valor = $valor; Situacao = $situacao })
    $cor = switch ($situacao) {
        'OK' { 'Green' } 'FALHA' { 'Red' } 'AVISO' { 'Yellow' } default { 'Gray' }
        }
    Write-Host ("  [{0,-5}] {1,-34} {2}" -f $situacao, $item, $valor) -ForegroundColor $cor
}

Write-Host ''
Write-Host '  DIAGNOSTICO - Kirana v0.5.5 + Gateway v0.4.1' -ForegroundColor Cyan
Write-Host "  raiz: $Raiz"
Write-Host "  data: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host ''

Write-Passo '1. Versoes no disco'
$vKiranaPasta = Read-IniVersaoPacote (Join-Path $Raiz 'Kirana/package.json')
$vGatewayPasta = Read-IniVersaoPacote (Join-Path $Raiz 'Gateway/package.json')

if ($vKiranaPasta -eq '0.5.5') { Linha 'Kirana/package.json' $vKiranaPasta 'OK' }
else { Linha 'Kirana/package.json' "$vKiranaPasta (esperado 0.5.5)" 'FALHA'; $falhas.Add("Kirana/package.json = $vKiranaPasta") }

if ($vGatewayPasta -eq '0.4.1') { Linha 'Gateway/package.json' $vGatewayPasta 'OK' }
else { Linha 'Gateway/package.json' "$vGatewayPasta (esperado 0.4.1)" 'FALHA'; $falhas.Add("Gateway/package.json = $vGatewayPasta") }

if (Test-Path (Join-Path $Raiz 'Gateway/src/engine.js')) {
    $engine = Get-Content (Join-Path $Raiz 'Gateway/src/engine.js') -Raw
    if ($engine -match 'selectChain' -and $engine -match 'identity_verified|identityVerified') {
        Linha 'Gateway/src/engine.js' 'motor presente (selectChain/catalog)' 'OK'
    } else {
        Linha 'Gateway/src/engine.js' 'arquivo existe, conteudo inesperado' 'FALHA'
        $falhas.Add('Gateway/src/engine.js sem os marcadores do motor')
    }
} else {
    Linha 'Gateway/src/engine.js' 'AUSENTE - nao e v0.4.1' 'FALHA'
    $falhas.Add('Gateway/src/engine.js ausente')
}

$zipAntigo = Join-Path $Raiz 'Kirana/integrations/Kirana-ChatGPT-Gateway-v0.4.1-Windows.zip'
if (Test-Path $zipAntigo) {
    Linha 'Kirana/integrations (zip do Gateway)' 'presente - duplicacao insegura' 'AVISO'
    $avisos.Add('ZIP do Gateway dentro de Kirana/integrations: a pasta Gateway/ e a unica copia executavel.')
} else {
    Linha 'Kirana/integrations' 'sem ZIP duplicado' 'OK'
}

Write-Passo '2. Processos e portas'
foreach ($servico in @(
    @{ Nome = 'Gateway'; Porta = 1455; VersaoEsperada = '0.4.1' },
    @{ Nome = 'Kirana'; Porta = 3000; VersaoEsperada = '0.5.5' }
)) {
    $estado = Get-EstadoPorta $servico.Porta
    # A comparacao de versao NAO depende de identificar o dono da porta. Antes,
    # se a deteccao falhasse (sistema sem Get-NetTCPConnection/netstat, permissao
    # negada), a checagem mais importante do diagnostico era pulada em silencio.
    $saude = Invoke-JsonLocal "http://127.0.0.1:$($servico.Porta)/health"
    $versaoAtiva = if ($saude) { [string]$saude.version } else { $null }

    if (-not $estado.Ocupada) {
        if ($versaoAtiva) {
            $situacaoOrfa = if ($versaoAtiva -eq $servico.VersaoEsperada) { 'OK' } else { 'FALHA' }
            Linha "porta $($servico.Porta) ($($servico.Nome))" "v$versaoAtiva responde (dono da porta nao identificado neste sistema)" $situacaoOrfa
            if ($situacaoOrfa -eq 'FALHA') {
                $falhas.Add("$($servico.Nome): servico ativo e v$versaoAtiva, pasta declara v$($servico.VersaoEsperada)")
            }
            continue
        }
        Linha "porta $($servico.Porta) ($($servico.Nome))" 'livre - servico parado' 'AVISO'
        $avisos.Add("$($servico.Nome) nao esta rodando (porta $($servico.Porta) livre)")
        continue
    }
    $dono = "PID $($estado.Pid) $($estado.Processo)"
    if ($versaoAtiva) {
        $situacao = if ($versaoAtiva -eq $servico.VersaoEsperada) { 'OK' } else { 'FALHA' }
        Linha "porta $($servico.Porta) ($($servico.Nome))" "v$versaoAtiva responde; $dono" $situacao
        if ($situacao -eq 'FALHA') {
            $falhas.Add("$($servico.Nome): servico ativo e v$versaoAtiva, pasta declara v$($servico.VersaoEsperada)")
        }
    } else {
        Linha "porta $($servico.Porta) ($($servico.Nome))" "ocupada por $dono, sem /health" 'FALHA'
        $falhas.Add("$($servico.Nome): porta $($servico.Porta) ocupada por processo sem /health ($dono)")
    }
    if ($estado.Executavel) { Write-Host "          executavel: $($estado.Executavel)" }
    if ($estado.LinhaDeComando) { Write-Host "          comando   : $($estado.LinhaDeComando)" }

    # Processo iniciado por esta distribuicao?
    $pidSalvo = Read-PidFile $Raiz $servico.Nome.ToLower()
    if ($pidSalvo) {
        if ([int]$pidSalvo.pid -eq $estado.Pid) {
            Linha "  origem do PID $($estado.Pid)" "iniciado por esta distribuicao" 'OK'
        } else {
            Linha "  origem do PID $($estado.Pid)" "NAO foi esta distribuicao (pid file aponta $($pidSalvo.pid))" 'AVISO'
            $avisos.Add("$($servico.Nome): processo na porta nao foi iniciado por esta distribuicao.")
        }
    } else {
        Linha "  origem do PID $($estado.Pid)" 'sem registro em run/ (iniciado por outro caminho)' 'AVISO'
    }
}

Write-Passo '3. Arquivos .env'
foreach ($par in @(@{ Nome = 'Gateway'; Pasta = (Join-Path $Raiz 'Gateway') }, @{ Nome = 'Kirana'; Pasta = (Join-Path $Raiz 'Kirana') })) {
    $caminho = Join-Path $par.Pasta '.env'
    if (-not (Test-Path $caminho)) {
        Linha "$($par.Nome)/.env" 'AUSENTE' 'FALHA'
        $falhas.Add("$($par.Nome)/.env ausente")
        continue
    }
    $mapa = Read-ArquivoEnv $caminho
    Linha "$($par.Nome)/.env" "presente ($($mapa.Count) variaveis)" 'OK'
    $chaves = $mapa.Keys | Sort-Object
    Write-Host "          variaveis: $($chaves -join ', ')"
    if ($par.Nome -eq 'Gateway') {
        $chave = $mapa['GATEWAY_API_KEY']
        if ($chave -and $chave.Length -ge 32) { Linha '  GATEWAY_API_KEY' (Format-Mascarado $chave) 'OK' }
        else { Linha '  GATEWAY_API_KEY' 'ausente ou curta (minimo 32)' 'FALHA'; $falhas.Add('GATEWAY_API_KEY invalida') }
        if ($mapa['HOST'] -and $mapa['HOST'] -ne '127.0.0.1') {
            Linha '  HOST' "$($mapa['HOST']) - fora do loopback" 'FALHA'
            $falhas.Add('Gateway/HOST nao e 127.0.0.1')
        } else { Linha '  HOST' '127.0.0.1 (loopback)' 'OK' }
        if ($mapa['PORT'] -and $mapa['PORT'] -ne '1455') {
            Linha '  PORT' "$($mapa['PORT']) - esperado 1455" 'FALHA'
            $falhas.Add('Gateway/PORT diferente de 1455')
        }
    }
    if ($par.Nome -eq 'Kirana') {
        $gwKey = $mapa['KIRANA_GATEWAY_API_KEY']
        $gwUrl = $mapa['KIRANA_GATEWAY_URL']
        if ($gwKey) { Linha '  KIRANA_GATEWAY_API_KEY' (Format-Mascarado $gwKey) 'OK' }
        else { Linha '  KIRANA_GATEWAY_API_KEY' 'ausente - Kirana nao falara com o Gateway' 'FALHA'; $falhas.Add('Kirana sem KIRANA_GATEWAY_API_KEY') }
        if ($gwUrl -match '1455') { Linha '  KIRANA_GATEWAY_URL' $gwUrl 'OK' } else { Linha '  KIRANA_GATEWAY_URL' "$gwUrl (esperado ...:1455)" 'AVISO'; $avisos.Add('KIRANA_GATEWAY_URL sem 1455') }
        if ($mapa['KIRANA_BRIDGE'] -ne 'on') { Linha '  KIRANA_BRIDGE' "$($mapa['KIRANA_BRIDGE']) - ponte do celular desligada" 'AVISO'; $avisos.Add('KIRANA_BRIDGE nao esta on') }
        else { Linha '  KIRANA_BRIDGE' 'on' 'OK' }
    }
}

Write-Passo '4. Autorizacao SIWC (estado real, sem credenciais)'
$saudeGw = Invoke-JsonLocal 'http://127.0.0.1:1455/health'
# /auth/status e /v1/models exigem a chave do Gateway (401 sem ela). Sem passar
# o cabecalho, o diagnostico dizia "nao respondeu" e escondia justamente o
# estado do SIWC que ele deveria investigar.
$envGatewayParaAuth = Read-ArquivoEnv (Join-Path $Raiz 'Gateway/.env')
$chaveGateway = $envGatewayParaAuth['GATEWAY_API_KEY']
$cabecalhoGateway = @{}
if ($chaveGateway) { $cabecalhoGateway['Authorization'] = "Bearer $chaveGateway" }

function Invoke-JsonAutorizado([string]$Url, [hashtable]$Cabecalhos, [int]$TimeoutSegundos = 10) {
    try { return Invoke-RestMethod -Uri $Url -Headers $Cabecalhos -TimeoutSec $TimeoutSegundos -ErrorAction Stop }
    catch { return $null }
}
$manual = Join-Path $Raiz 'Gateway/.local-state/kirana-personal-gateway/registration.json'
if (Test-Path $manual) {
    try {
        $reg = Get-Content $manual -Raw | ConvertFrom-Json
        $cid = if ($reg.clientId) { $reg.clientId.Substring(0, [Math]::Min(8, $reg.clientId.Length)) + '...' } else { '(nenhum)' }
        Linha 'registration.json' "presente · clientId $cid" 'OK'
        Write-Host "          hostId: $($reg.hostId)"
    } catch {
        Linha 'registration.json' 'ilegivel/invalido' 'FALHA'
        $falhas.Add('registration.json invalido (o Gateway se recusa a iniciar nesse estado)')
    }
} else {
    Linha 'registration.json' 'ausente (sera criado no 1o /auth/start)' 'AVISO'
}

$statusAuth = Invoke-JsonAutorizado 'http://127.0.0.1:1455/auth/status' $cabecalhoGateway
if ($statusAuth) {
    Linha '/auth/status authenticated' "$($statusAuth.authenticated)" $(if ($statusAuth.authenticated) { 'OK' } else { 'AVISO' })
    Linha '/auth/status sharing' "$($statusAuth.sharing)" $(if ($statusAuth.sharing) { 'OK' } else { 'AVISO' })
    Linha '/auth/status tokenStorage' "$($statusAuth.tokenStorage)" 'OK'
    Linha '/auth/status registrationConfigured' "$($statusAuth.registrationConfigured)" 'OK'
    if ($statusAuth.grantedScopes -and $statusAuth.grantedScopes.Count -gt 0) {
        Linha 'escopos concedidos' ($statusAuth.grantedScopes -join ', ') 'OK'
        if (-not ($statusAuth.grantedScopes -contains 'chatgpt.tokens.use.direct')) {
            Linha 'escopo de plano' 'chatgpt.tokens.use.direct AUSENTE' 'FALHA'
            $falhas.Add('Autorizacao sem o escopo chatgpt.tokens.use.direct')
        }
    }
    if (-not $statusAuth.authenticated) {
        $avisos.Add('SIWC inativa. Os tokens sao memory-only: reiniciar o Gateway exige autorizar de novo em /auth/start.')
    }
} else {
    if ($saudeGw) {
        Linha '/auth/status' 'o Gateway ativo RECUSOU a chave desta pasta (conflito de instalacao: ele foi iniciado por outra pasta/chave)' 'FALHA'
        $falhas.Add('Conflito de instalacao: o Gateway na porta 1455 nao aceita a chave desta pasta. Compare run/gateway.pid (pastaTrabalho) e rode o instalador/MIGRAR-ENV.cmd; NAO feche o Gateway se o SIWC estiver ativo.')
    } else {
        Linha '/auth/status' 'Gateway nao esta no ar' 'AVISO'
    }
}

# Prova de uso real (nao inventa): tenta listar modelos.
$envGw = $envGatewayParaAuth
if ($envGw['GATEWAY_API_KEY'] -and $saudeGw) {
    try {
        $modelos = Invoke-RestMethod -Uri 'http://127.0.0.1:1455/v1/models' -Headers @{ Authorization = "Bearer $($envGw['GATEWAY_API_KEY'])" } -TimeoutSec 15 -ErrorAction Stop
        $qtd = @($modelos.data).Count
        Linha 'GET /v1/models' "$qtd modelo(s) visiveis" 'OK'
    } catch {
        $codigo = $null
        try { $codigo = $_.Exception.Response.StatusCode.value__ } catch { }
        Linha 'GET /v1/models' "recusado (HTTP $codigo) - SIWC nao autorizada nesta sessao" 'AVISO'
        $avisos.Add("Listagem de modelos recusada (HTTP $codigo). Prova de SIWC real continua pendente.")
    }
}

Write-Passo '5. Ponte Kirana -> Gateway'
$envKirana = Read-ArquivoEnv (Join-Path $Raiz 'Kirana/.env')
$tokenPonte = $envKirana['KIRANA_BRIDGE_TOKEN']
if (-not $tokenPonte) {
    Linha 'KIRANA_BRIDGE_TOKEN' 'ausente' 'FALHA'
    $falhas.Add('Sem KIRANA_BRIDGE_TOKEN: a ponte recusaria o celular')
} else {
    try {
        $ping = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/gateway/ping' -Headers @{ Authorization = "Bearer $tokenPonte" } -TimeoutSec 10 -ErrorAction Stop
        Linha 'GET /api/gateway/ping' "ponte on · $($ping.routes.Count) rotas · requireHttps=$($ping.requireHttps)" 'OK'
        $engine = $null
        try {
            $engine = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/gateway/v1/engine' -Headers @{ Authorization = "Bearer $tokenPonte" } -TimeoutSec 10 -ErrorAction Stop
            Linha 'GET /api/gateway/v1/engine' "Gateway v$($engine.gateway.version) · custo $($engine.policy.cost_policy)" 'OK'
        } catch {
            Linha 'GET /api/gateway/v1/engine' 'nao respondeu pela ponte' 'AVISO'
        }
    } catch {
        $codigo = $null
        try { $codigo = $_.Exception.Response.StatusCode.value__ } catch { }
        if ($codigo -eq 403) {
            Linha 'GET /api/gateway/ping' 'HTTP 403 - HTTP claro recusado (esperado com REQUIRE_HTTPS=on)' 'OK'
        } elseif ($codigo -eq 404) {
            Linha 'GET /api/gateway/ping' 'HTTP 404 - ponte desligada no processo ativo (KIRANA_BRIDGE=off ou processo de outra pasta)' 'AVISO'
            $avisos.Add('Ponte do celular desligada no processo ativo. Nao e falha da conversa Kirana -> Gateway.')
        } else {
            Linha 'GET /api/gateway/ping' "falhou (HTTP $codigo)" 'FALHA'
            $falhas.Add("Ponte nao respondeu (HTTP $codigo)")
        }
    }
}

Write-Passo '6. Resumo'
if ($falhas.Count -eq 0) {
    Write-Host ''
    Write-Host '  VEREDITO: pacote e servicos coerentes.' -ForegroundColor Green
} else {
    Write-Host ''
    Write-Host "  VEREDITO: $($falhas.Count) FALHA(S)" -ForegroundColor Red
    foreach ($f in $falhas) { Write-Host "    - $f" -ForegroundColor Red }
}
if ($avisos.Count -gt 0) {
    Write-Host ''
    Write-Host "  Avisos ($($avisos.Count)):" -ForegroundColor Yellow
    foreach ($a in $avisos) { Write-Host "    - $a" -ForegroundColor Yellow }
}
Write-Host ''
Write-Host '  Relatorio salvo em run\diagnostico.txt'
$dirRun = Join-Path $Raiz 'run'
if (-not (Test-Path $dirRun)) { New-Item -ItemType Directory -Force -Path $dirRun | Out-Null }
$linhas | Format-Table -AutoSize | Out-String | Set-Content -Path (Join-Path $dirRun 'diagnostico.txt') -Encoding UTF8
Write-Host ''

if ($falhas.Count -gt 0) { exit 1 }
exit 0
