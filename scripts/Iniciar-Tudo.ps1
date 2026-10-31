# Iniciar-Tudo.ps1 - sobe Gateway e Kirana, recusando-se a usar processo alheio.
#
# Regras que este script garante:
#  1. WorkingDirectory explicito (o Gateway resolve .env e .local-state pelo cwd).
#  2. Se a porta estiver ocupada, identifica o dono (PID, exe, cmdline) e NAO
#     encerra nada por conta propria.
#  3. Reutiliza um servico ja no ar SOMENTE com propriedade comprovada: run/*.pid
#     desta distribuicao + mesmo PID dono da porta + linha de comando citando a
#     pasta e o arquivo desta instalacao. Versao igual em /health NAO basta -
#     duas instalacoes distintas anunciam a mesma versao com chaves diferentes.
#  4. Cada processo iniciado aqui tem pid file em run/, usado pelo PARAR-TUDO.

param([switch]$SemEspera, [switch]$SemNavegador)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Comum.ps1')

$Raiz = Get-RaizDistribuicao
$lancados = @()

function Mostrar-DonoDaPorta($estado) {
    Write-Erro "Porta $($estado.Porta) ja esta em uso por PID $($estado.Pid) ($($estado.Processo))."
    if ($estado.Executavel) { Write-Host "         executavel: $($estado.Executavel)" }
    if ($estado.LinhaDeComando) { Write-Host "         comando   : $($estado.LinhaDeComando)" }
}

function Tratar-PortaOcupada([int]$Porta, [string]$Componente, [string]$Arquivo, [string]$PastaEsperada, [string]$VersaoEsperada, [string]$ChaveLocal = '') {
    # Objetivo: iniciar quando a porta esta livre; reutilizar SO quando o dono da
    # porta e comprovadamente o processo que ESTA distribuicao iniciou; em
    # qualquer outro caso, parar e explicar - sem encerrar nada.
    #
    # A versao anunciada em /health nao entra na prova de propriedade. Duas
    # copias da Kirana podem responder "0.5.5" com chaves locais e estados
    # diferentes; seguir usando a errada produz 401 e modelos de outra conta.
    $estado = Get-EstadoPorta $Porta
    $versaoAtiva = $null
    try { $versaoAtiva = Get-VersaoServico $Porta } catch { $versaoAtiva = $null }

    # Se algo responde /health, a porta esta ocupada - mesmo quando a ferramenta
    # de listagem de portas nao existe ou falhou. Nao confiar so nela evita subir
    # uma segunda instancia em cima de um servico que ja esta no ar.
    if ($versaoAtiva) {
        if (-not $estado.Ocupada) { $estado.Ocupada = $true }
        if ($null -eq $estado.Pid) {
            # sem PID nao ha prova de propriedade possivel
            $estado.LinhaDeComando = $null
        }
    }

    if (-not $estado.Ocupada) {
        Write-Ok "porta $Porta livre - iniciando $Componente"
        return $true
    }

    $pidFile = Read-PidFile $Raiz $Componente.ToLower()

    $decisao = Get-DecisaoReuso -EstadoPorta $estado -PidFile $pidFile -PastaEsperada $PastaEsperada -Arquivo $Arquivo -VersaoEsperada $VersaoEsperada -VersaoAtiva $versaoAtiva

    if ($decisao.Acao -eq 'reusar') {
        Write-Aviso "$Componente ja esta rodando por esta distribuicao: $($decisao.Motivo). Nada a fazer."
        return $true
    }

    # Gateway ja ativo, iniciado por OUTRA pasta: se ele aceita a chave DESTA instalacao
    # (/auth/status = 200) e a versao confere, e o mesmo Gateway que o proprietario ja
    # autenticou. Reaproveita sem tocar nele (o login SIWC vive so na memoria dele) e o
    # script segue iniciando o resto. Sem essa prova de chave, continua parando.
    # So vale para o Gateway; a Kirana de outra pasta nunca e reaproveitada.
    if ($Componente -eq 'Gateway' -and $ChaveLocal -and $versaoAtiva -eq $VersaoEsperada) {
        $aceita = $false
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:$Porta/auth/status" -Headers @{ Authorization = "Bearer $ChaveLocal" } -TimeoutSec 8 -ErrorAction Stop | Out-Null
            $aceita = $true
        } catch { $aceita = $false }
        if ($aceita) {
            Write-Aviso "Gateway ja esta ativo (PID $($estado.Pid)), iniciado por outra pasta, e aceita a chave desta instalacao: sera REAPROVEITADO."
            if ($estado.LinhaDeComando) { Write-Host "         origem: $($estado.LinhaDeComando)" }
            Write-Host '         Ele nao sera encerrado nem reiniciado; a sessao SIWC dele continua valida.'
            return $true
        }
    }

    # Acao 'parar': qualquer caso em que a propriedade nao foi comprovada.
    Write-Erro "porta $Porta ocupada e NAO foi possivel provar que o processo e desta instalacao."
    Write-Host "         motivo: $($decisao.Motivo)"
    Write-Host "         PID: $($estado.Pid)  processo: $($estado.Processo)"
    if ($estado.Executavel) { Write-Host "         executavel: $($estado.Executavel)" }
    if ($estado.LinhaDeComando) { Write-Host "         comando   : $($estado.LinhaDeComando)" }
    if ($versaoAtiva) { Write-Host "         /health   : v$versaoAtiva (informacao, nao prova de identidade)" }
    Write-Host ''
    Write-Host '         Nada foi encerrado por este script.'
    Write-Host '         ATENCAO: se esse Gateway estiver com o login SIWC ativo, encerra-lo APAGA a sessao'
    Write-Host '         (ela vive so em memoria) e exigira novo login. Se ele ja funciona, NAO o feche:'
    Write-Host '         use a pasta que o iniciou. Para trocar de pasta de proposito:'
    Write-Host "           - confira o caminho e so entao encerre: Stop-Process -Id $($estado.Pid)"
    Write-Host '           - ou rode .\DIAGNOSTICO.cmd para ver o detalhe'
    Write-Host ''
    Write-Host "         Feche esse processo e rode .\INICIAR-TUDO.cmd de novo."
    return $false
}

Write-Host ''
Write-Host '  Subindo Kirana v0.5.5 + Gateway v0.4.1' -ForegroundColor Cyan
Write-Host "  raiz: $Raiz"
Write-Host ''

Write-Passo '0. Pre-requisitos'
$versaoKirana = Read-IniVersaoPacote (Join-Path $Raiz 'Kirana/package.json')
$versaoGateway = Read-IniVersaoPacote (Join-Path $Raiz 'Gateway/package.json')
if ($versaoKirana -ne '0.5.5' -or $versaoGateway -ne '0.4.1') {
    Write-Erro "Pacote incoerente: Kirana '$versaoKirana' (esperado 0.5.5), Gateway '$versaoGateway' (esperado 0.4.1)."
    exit 1
}
Write-Ok "pastas: Kirana $versaoKirana, Gateway $versaoGateway"
if (-not (Assert-Node)) { exit 1 }
foreach ($pasta in @('Gateway', 'Kirana')) {
    if (-not (Test-Path (Join-Path $Raiz "$pasta/node_modules"))) {
        Write-Erro "$pasta/node_modules ausente. Rode .\INSTALAR-WINDOWS.cmd primeiro."
        exit 1
    }
}
if (-not (Test-Path (Join-Path $Raiz 'Gateway/.env'))) { Write-Erro 'Gateway/.env ausente. Rode .\INSTALAR-WINDOWS.cmd.'; exit 1 }
if (-not (Test-Path (Join-Path $Raiz 'Kirana/.env'))) { Write-Erro 'Kirana/.env ausente. Rode .\INSTALAR-WINDOWS.cmd.'; exit 1 }
Write-Ok '.env do Gateway e da Kirana presentes'

Write-Passo '0. Pre-voo da configuracao (nada foi iniciado ainda)'
& node (Join-Path $Raiz 'tools/checar-config.mjs')
if ($LASTEXITCODE -ne 0) {
    Write-Erro 'Configuracao invalida. NADA foi iniciado. Rode .\INSTALAR-WINDOWS.cmd para corrigir.'
    exit 1
}

Write-Passo '1. Porta 1455 (Gateway)'
$chaveGateway = (Read-ArquivoEnv (Join-Path $Raiz 'Gateway/.env'))['GATEWAY_API_KEY']
if (-not (Tratar-PortaOcupada -Porta 1455 -Componente 'Gateway' -Arquivo 'main.js' -PastaEsperada (Join-Path $Raiz 'Gateway') -VersaoEsperada '0.4.1' -ChaveLocal $chaveGateway)) { exit 1 }

$gatewayRodando = (Get-VersaoServico 1455) -ne $null
if (-not $gatewayRodando) {
    $proc = Start-NodeEm -Pasta (Join-Path $Raiz 'Gateway') -Arquivo 'main.js' -Componente 'gateway' -Raiz $Raiz -Porta 1455
    $lancados += "gateway:$($proc.Id)"
    $saude = Wait-Servico 1455
    if ($null -eq $saude) {
        Write-Erro 'Gateway nao respondeu em 1455. Veja run\gateway.err.log'
        exit 1
    }
    if ($saude.version -ne '0.4.1') {
        Write-Erro "Gateway respondeu v$($saude.version), esperado 0.4.1. Abortando."
        exit 1
    }
    Write-Ok "Gateway v$($saude.version) em http://127.0.0.1:1455 (PID $($proc.Id))"
    if (-not $saude.authenticated) {
        Write-Aviso 'Gateway sem autorizacao SIWC nesta sessao (tokens sao em memoria).'
        Write-Host '         Autorize em http://127.0.0.1:1455/auth/start'
    } else {
        Write-Ok 'Gateway com autorizacao SIWC ativa nesta sessao'
    }
}

Write-Passo '2. Porta 3000 (Kirana)'
if (-not (Tratar-PortaOcupada -Porta 3000 -Componente 'Kirana' -Arquivo 'server.js' -PastaEsperada (Join-Path $Raiz 'Kirana') -VersaoEsperada '0.5.5')) { exit 1 }

$kiranaRodando = (Get-VersaoServico 3000) -ne $null
if (-not $kiranaRodando) {
    $proc = Start-NodeEm -Pasta (Join-Path $Raiz 'Kirana') -Arquivo 'server.js' -Componente 'kirana' -Raiz $Raiz -Porta 3000
    $lancados += "kirana:$($proc.Id)"
    $saude = Wait-Servico 3000
    if ($null -eq $saude) {
        Write-Erro 'Kirana nao respondeu em 3000. Veja run\kirana.err.log'
        exit 1
    }
    if ($saude.version -ne '0.5.5') {
        Write-Erro "Kirana respondeu v$($saude.version), esperado 0.5.5. Abortando."
        exit 1
    }
    Write-Ok "Kirana v$($saude.version) em http://127.0.0.1:3000 (PID $($proc.Id))"
}

Write-Passo '3. Comunicacao Kirana -> Gateway'
$envKirana = Read-ArquivoEnv (Join-Path $Raiz 'Kirana/.env')
$token = $envKirana['KIRANA_BRIDGE_TOKEN']
if ($token) {
    $ping = $null
    try {
        $ping = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/gateway/ping' -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 8 -ErrorAction Stop
        Write-Ok "ponte ativa (HTTPS obrigatorio: $($ping.requireHttps))"
    } catch {
        Write-Aviso 'ponte nao respondeu ao ping. Se KIRANA_BRIDGE_REQUIRE_HTTPS=on, isso e esperado em HTTP direto (use o endereco https do Tailscale).'
    }
} else {
    Write-Aviso 'KIRANA_BRIDGE_TOKEN ausente: a ponte recusaria o celular.'
}

Write-Passo 'Pronto'
Write-Host '  Kirana : http://127.0.0.1:3000'
Write-Host '  Gateway: http://127.0.0.1:1455'
Write-Host '  Autorizar SIWC: http://127.0.0.1:1455/auth/start'
Write-Host '  Parar tudo    : .\PARAR-TUDO.cmd'
Write-Host '  Conferir      : .\DIAGNOSTICO.cmd'
Write-Host ''
if (-not $SemNavegador) {
    Write-Passo '4. Interface'
    try {
        Start-Process 'http://127.0.0.1:3000'
        Write-Ok 'navegador aberto em http://127.0.0.1:3000'
    } catch {
        Write-Aviso 'nao consegui abrir o navegador. Abra manualmente: http://127.0.0.1:3000'
    }
    # Consulta fresca: $saude pode não ter sido atribuído (Gateway já estava no ar).
    $saudeGw = Invoke-JsonLocal 'http://127.0.0.1:1455/health' 3
    if ($saudeGw -and -not $saudeGw.authenticated) {
        Write-Host ''
        Write-Host '  Se a conversa falhar, autorize a conta uma vez:' -ForegroundColor Yellow
        Write-Host '    http://127.0.0.1:1455/auth/start' -ForegroundColor Yellow
        Write-Host '  (a autorizacao vive na memoria do Gateway; fechar o Gateway apaga)' -ForegroundColor Yellow
    }
}

Write-Host '  Deixe esta janela aberta; os processos rodam em segundo plano.' -ForegroundColor Yellow
Write-Host ''
