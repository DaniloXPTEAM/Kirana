# Comum.ps1 - funcoes compartilhadas pelos scripts da distribuicao.
# Compatível com PowerShell 5.1 (Windows 11) e PowerShell 7.
# Regra de ouro deste arquivo: NUNCA imprimir valor de segredo; NUNCA matar
# processo que a distribuicao nao iniciou; NUNCA depender do diretorio atual.

$script:Utf8SemBom = New-Object System.Text.UTF8Encoding($false)

function Write-Ok($texto) { Write-Host "  OK   $texto" -ForegroundColor Green }
function Write-Aviso($texto) { Write-Host "  !    $texto" -ForegroundColor Yellow }
function Write-Erro($texto) { Write-Host "  X    $texto" -ForegroundColor Red }
function Write-Passo($texto) { Write-Host ""; Write-Host "=== $texto ===" -ForegroundColor Cyan }

function Get-RaizDistribuicao {
    # A raiz e sempre o pai da pasta 'scripts'. Nada de Get-Location.
    return (Split-Path -Parent $PSScriptRoot)
}

function Read-IniVersaoPacote([string]$CaminhoPacoteJson) {
    if (-not (Test-Path $CaminhoPacoteJson)) { return $null }
    try {
        $json = Get-Content -Path $CaminhoPacoteJson -Raw -Encoding UTF8 | ConvertFrom-Json
        return [string]$json.version
    } catch { return $null }
}

function Read-ArquivoEnv([string]$Caminho) {
    # Devolve um dicionario nome->valor. O valor NUNCA e impresso por quem chama
    # sem mascarar. Linhas comentadas e vazias sao ignoradas.
    $mapa = @{}
    if (-not (Test-Path $Caminho)) { return $mapa }
    foreach ($linha in Get-Content -Path $Caminho -Encoding UTF8) {
        if ($linha -match '^\s*#' -or $linha -notmatch '=') { continue }
        $partes = $linha -split '=', 2
        $nome = $partes[0].Trim()
        $valor = $partes[1].Trim()
        if ($nome) { $mapa[$nome] = $valor }
    }
    return $mapa
}

function Format-Mascarado([string]$Valor) {
    if ([string]::IsNullOrEmpty($Valor)) { return '(vazio)' }
    return "(definido, $($Valor.Length) caracteres)"
}

function New-TokenAleatorio {
    # RNG criptografico de 32 bytes, compativel com Windows PowerShell 5.1.
    #
    # NAO usar [RandomNumberGenerator]::Fill($bytes): esse metodo estatico recebe
    # Span<byte> e so existe no .NET moderno (Core 3.0+). No .NET Framework do
    # Windows PowerShell 5.1 ele nao existe e o instalador quebrava em tempo de
    # execucao (o parser aceitar a sintaxe nao prova nada).
    # Forma suportada nos dois: instancia + GetBytes(byte[]) + Dispose no finally.
    $bytes = New-Object byte[] 32
    $rng = $null
    try {
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $rng.GetBytes($bytes)
    } finally {
        if ($null -ne $rng) { $rng.Dispose() }
    }
    return ([Convert]::ToBase64String($bytes)).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function Get-LinhaDeComando([int]$ProcessoId) {
    # Le a linha de comando do processo sem depender de um unico sistema.
    #   Windows  -> CIM (Win32_Process.CommandLine)
    #   Linux    -> /proc/<pid>/cmdline
    #   resto    -> ps -o args=
    # Devolve $null quando NADA funcionou - e $null significa "nao encerre" e
    # "nao reutilize" nos chamadores. Nunca inventa identidade.
    if ($ProcessoId -le 0) { return $null }
    try {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessoId" -ErrorAction Stop
        if ($proc -and $proc.CommandLine) { return [string]$proc.CommandLine }
    } catch { }
    try {
        $caminho = "/proc/$ProcessoId/cmdline"
        if (Test-Path $caminho) {
            $bruto = [System.IO.File]::ReadAllText($caminho)
            $limpo = ($bruto -replace "`0", ' ').Trim()
            if ($limpo) { return $limpo }
        }
    } catch { }
    try {
        if (Get-Command ps -ErrorAction SilentlyContinue) {
            $saida = & ps -o args= -p $ProcessoId 2>$null
            if ($saida) { return ([string]$saida).Trim() }
        }
    } catch { }
    return $null
}

function Get-EstadoPorta([int]$Porta) {
    # Identifica quem ocupa a porta: PID, executavel, linha de comando e - quando
    # der - a versao do componente naquele diretorio. Usado para NUNCA conectar
    # silenciosamente a um Gateway antigo.
    $estado = [ordered]@{
        Porta          = $Porta
        Ocupada        = $false
        Pid            = $null
        Processo       = $null
        Executavel     = $null
        LinhaDeComando = $null
        VersaoPasta    = $null
    }
    $conexao = $null
    try {
        $conexao = Get-NetTCPConnection -LocalPort $Porta -State Listen -ErrorAction Stop | Select-Object -First 1
    } catch {
        # Fallback para sistemas sem o modulo NetTCPIP.
        # Linux/macOS usam "LISTEN"; Windows usa "LISTENING". E o netstat pode
        # nao existir: sem este try/catch o diagnostico imprimia erro vermelho
        # no meio do relatorio (visto em teste real).
        try {
            # Linux moderno: 'ss' costuma ser o unico disponivel (netstat removido
            # de varias distribuicoes). Sem isto a porta parecia livre e o
            # inicializador subia uma segunda instancia.
            if (Get-Command ss -ErrorAction SilentlyContinue) {
                $saidaSs = @(& ss -ltnp 2>$null | Select-String "[:.]$Porta\s")
                if ($saidaSs.Count -gt 0) {
                    $estado.Ocupada = $true
                    # A mesma porta pode aparecer em mais de uma linha (interfaces
                    # diferentes, uma delas sem informacao de dono). Nao usar a
                    # primeira cegamente: procurar a que traz 'pid='. Antes, pegar a
                    # linha sem PID fazia a prova de propriedade falhar e a segunda
                    # execucao do INICIAR-TUDO recusava o proprio servico.
                    foreach ($l in $saidaSs) {
                        $m = [regex]::Match($l.ToString(), 'pid=(\d+)')
                        if ($m.Success) {
                            $estado.Pid = [int]$m.Groups[1].Value
                            break
                        }
                    }
                    if ($null -ne $estado.Pid) { $estado.LinhaDeComando = Get-LinhaDeComando $estado.Pid }
                    return $estado
                }
            }
            if (Get-Command netstat -ErrorAction SilentlyContinue) {
                $linhasNetstat = @(& netstat -an 2>$null | Select-String "LISTEN(ING)?" | Select-String "[:.]$Porta\s")
                if ($linhasNetstat.Count -gt 0) {
                    $estado.Ocupada = $true
                    # Mesmo criterio do ss: vale a linha cujo ultimo campo e um PID.
                    foreach ($l in $linhasNetstat) {
                        $partes = ($l.ToString() -split '\s+') | Where-Object { $_ }
                        $ultimo = $partes[-1]
                        if ($ultimo -match '^(\d+)$') {
                            $estado.Pid = [int]$Matches[1]
                            $estado.LinhaDeComando = Get-LinhaDeComando $estado.Pid
                            break
                        }
                    }
                }
            }
        } catch { }
        return $estado
    }
    if (-not $conexao) { return $estado }

    $estado.Ocupada = $true
    $estado.Pid = [int]$conexao.OwningProcess
    try {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($estado.Pid)" -ErrorAction Stop
        if ($proc) {
            $estado.Processo = $proc.Name
            $estado.Executavel = $proc.ExecutablePath
        }
    } catch { }
    $estado.LinhaDeComando = Get-LinhaDeComando $estado.Pid
    return $estado
}

function Get-DiretorioProvavelDoProcesso($EstadoPorta, [string]$PastaEsperada) {
    # Nao existe API direta de "working directory" no Windows. Inferimos assim:
    #   1) se a linha de comando citar a pasta esperada, e ela;
    #   2) se o processo foi iniciado por esta distribuicao (pid file), e a esperada;
    #   3) senao, comparamos a versao em /health com a versao da pasta esperada.
    if ($EstadoPorta.LinhaDeComando -and $EstadoPorta.LinhaDeComando -like "*$PastaEsperada*") {
        return $PastaEsperada
    }
    return $null
}

function Invoke-JsonLocal([string]$Url, [int]$TimeoutSegundos = 5) {
    try {
        return Invoke-RestMethod -Uri $Url -TimeoutSec $TimeoutSegundos -ErrorAction Stop
    } catch {
        return $null
    }
}

function Get-VersaoServico([int]$Porta) {
    $saude = Invoke-JsonLocal "http://127.0.0.1:$Porta/health"
    if ($null -eq $saude) { return $null }
    return [string]$saude.version
}

function Read-PidFile([string]$Raiz, [string]$Componente) {
    $caminho = Join-Path (Join-Path $Raiz 'run') "$Componente.pid"
    if (-not (Test-Path $caminho)) { return $null }
    try {
        $conteudo = Get-Content -Path $caminho -Raw -Encoding UTF8 | ConvertFrom-Json
        return $conteudo
    } catch { return $null }
}

function Save-PidFile([string]$Raiz, [string]$Componente, [int]$ProcessoId, [string]$PastaTrabalho, [string]$Porta) {
    $dir = Join-Path $Raiz 'run'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $dados = [ordered]@{
        componente     = $Componente
        pid            = $ProcessoId
        pastaTrabalho  = $PastaTrabalho
        porta          = $Porta
        iniciadoEm     = (Get-Date).ToString('o')
        raiz           = $Raiz
    }
    $caminho = Join-Path $dir "$Componente.pid"
    [System.IO.File]::WriteAllText($caminho, ($dados | ConvertTo-Json), $script:Utf8SemBom)
}

function Test-ProcessoVivo([int]$ProcessoId) {
    try { return [bool](Get-Process -Id $ProcessoId -ErrorAction Stop) } catch { return $false }
}

function Test-CaminhoNaLinhaDeComando([string]$LinhaDeComando, [string]$Trecho) {
    # Comparacao literal (sem curinga) e sem diferenciar maiusculas: caminho do
    # Windows nao e case-sensitive e um '[' no caminho nao pode virar wildcard.
    if ([string]::IsNullOrEmpty($LinhaDeComando) -or [string]::IsNullOrEmpty($Trecho)) { return $false }
    return $LinhaDeComando.IndexOf($Trecho, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-DecisaoReuso {
    # Decide o que fazer quando a porta pode estar ocupada: iniciar, reutilizar
    # ou parar com diagnostico.
    #
    # Regra dura: reutilizar SO com propriedade comprovada, isto e, quando as
    # tres evidencias batem:
    #   (a) existe run/<componente>.pid escrito por ESTA distribuicao;
    #   (b) o PID do arquivo e o mesmo PID que realmente possui a porta;
    #   (c) a linha de comando do processo cita a pasta e o arquivo esperados.
    # Versao igual em /health NAO entra nessa conta: duas distribuicoes podem
    # anunciar 0.5.4/0.4.1 com chaves e estados diferentes, e reutilizar a errada
    # gera 401 e modelos de outra conta. /health informa, nao identifica.
    param(
        $EstadoPorta,
        $PidFile,
        [string]$PastaEsperada,
        [string]$Arquivo,
        [string]$VersaoEsperada,
        [string]$VersaoAtiva
    )
    if ($null -eq $EstadoPorta -or -not $EstadoPorta.Ocupada) {
        return [ordered]@{ Acao = 'iniciar'; Motivo = 'porta livre' }
    }
    if ($null -eq $PidFile) {
        return [ordered]@{ Acao = 'parar'; Motivo = 'porta ocupada por um processo que esta distribuicao nao iniciou (sem run/<componente>.pid)' }
    }
    $pidArquivo = 0
    try { $pidArquivo = [int]$PidFile.pid } catch { $pidArquivo = 0 }
    if ($pidArquivo -le 0) {
        return [ordered]@{ Acao = 'parar'; Motivo = 'run/<componente>.pid ilegivel ou sem PID valido' }
    }
    if ($pidArquivo -ne [int]$EstadoPorta.Pid) {
        return [ordered]@{ Acao = 'parar'; Motivo = "o run/<componente>.pid diz PID $pidArquivo, mas a porta pertence ao PID $($EstadoPorta.Pid) - PID pode ter sido reutilizado" }
    }
    if ([string]::IsNullOrEmpty($EstadoPorta.LinhaDeComando)) {
        return [ordered]@{ Acao = 'parar'; Motivo = 'nao foi possivel ler a linha de comando do processo; propriedade nao comprovada' }
    }
    if (-not (Test-CaminhoNaLinhaDeComando $EstadoPorta.LinhaDeComando $Arquivo)) {
        return [ordered]@{ Acao = 'parar'; Motivo = "a linha de comando nao cita $Arquivo" }
    }
    if ($PastaEsperada -and -not (Test-CaminhoNaLinhaDeComando $EstadoPorta.LinhaDeComando $PastaEsperada)) {
        return [ordered]@{ Acao = 'parar'; Motivo = "a linha de comando nao cita a pasta desta distribuicao ($PastaEsperada)" }
    }
    if ($PidFile.pastaTrabalho -and $PastaEsperada -and -not (Test-CaminhoNaLinhaDeComando ([string]$PidFile.pastaTrabalho) $PastaEsperada)) {
        return [ordered]@{ Acao = 'parar'; Motivo = 'o run/<componente>.pid foi escrito para outra pasta' }
    }
    if ($VersaoAtiva -ne $VersaoEsperada) {
        return [ordered]@{ Acao = 'parar'; Motivo = "o processo desta distribuicao responde v$VersaoAtiva, mas a pasta declara v$VersaoEsperada" }
    }
    return [ordered]@{ Acao = 'reusar'; Motivo = "processo desta distribuicao, com propriedade comprovada (PID $pidArquivo, v$VersaoAtiva)" }
}

function Get-DecisaoParada {
    # Decide se um PID pode ser encerrado. Fail-closed: na duvida, NAO encerra.
    #
    # Por que isso existe: run/<componente>.pid pode estar velho e o Windows pode
    # ter reutilizado o PID para um processo sem relacao nenhuma. "Nao consegui
    # ler a linha de comando" e motivo para parar, nao para seguir.
    param(
        $Dados,
        [bool]$ProcessoVivo,
        [string]$LinhaDeComando,
        $PidDonoPorta,
        [string]$Arquivo,
        [string]$PastaTrabalho
    )
    if ($null -eq $Dados) {
        return [ordered]@{ Acao = 'ignorar'; Motivo = 'sem run/<componente>.pid: esta distribuicao nao iniciou nada' }
    }
    if (-not $ProcessoVivo) {
        return [ordered]@{ Acao = 'limpar'; Motivo = 'o PID do arquivo ja nao esta rodando; removendo o pid file' }
    }
    $pidArquivo = 0
    try { $pidArquivo = [int]$Dados.pid } catch { $pidArquivo = 0 }
    if ($pidArquivo -le 0) {
        return [ordered]@{ Acao = 'ignorar'; Motivo = 'run/<componente>.pid sem PID valido' }
    }
    if ([string]::IsNullOrEmpty($LinhaDeComando)) {
        return [ordered]@{ Acao = 'ignorar'; Motivo = 'linha de comando indisponivel (consulta CIM falhou); por seguranca nada e encerrado' }
    }
    if (-not (Test-CaminhoNaLinhaDeComando $LinhaDeComando $Arquivo)) {
        return [ordered]@{ Acao = 'ignorar'; Motivo = "o PID $pidArquivo nao executa $Arquivo; nada e encerrado" }
    }
    if ($PastaTrabalho -and -not (Test-CaminhoNaLinhaDeComando $LinhaDeComando $PastaTrabalho)) {
        return [ordered]@{ Acao = 'ignorar'; Motivo = "o PID $pidArquivo nao roda a partir de $PastaTrabalho; nada e encerrado" }
    }
    if ($null -ne $PidDonoPorta -and [int]$PidDonoPorta -ne $pidArquivo) {
        return [ordered]@{ Acao = 'ignorar'; Motivo = "a porta pertence ao PID $PidDonoPorta, nao ao $pidArquivo do pid file; nada e encerrado" }
    }
    return [ordered]@{ Acao = 'encerrar'; Motivo = "processo desta distribuicao confirmado (PID $pidArquivo)" }
}

function Assert-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Erro 'Node.js nao encontrado no PATH. Instale Node 20 LTS (https://nodejs.org) e reabra o terminal.'
        return $null
    }
    $versao = (& node --version).Trim()
    $maior = [int](($versao -replace '^v', '') -split '\.')[0]
    if ($maior -lt 20) {
        Write-Erro "Node $versao e antigo demais. A Kirana exige Node >= 20.6 e o Gateway >= 20.20."
        return $null
    }
    Write-Ok "Node $versao"
    return $versao
}

function Start-NodeEm([string]$Pasta, [string]$Arquivo, [string]$Componente, [string]$Raiz, [int]$Porta) {
    # Sobe o processo com WorkingDirectory EXPLICITO.
    #
    # Por que isso importa: o Gateway carrega `.env` de process.cwd() e cria o
    # estado em `.local-state` relativo ao cwd (src/main.js, linhas 5 e 105).
    # Iniciar de outra pasta = ler outro .env e criar OUTRO registration.json,
    # com outro hostId - e a autorizacao SIWC feita antes deixa de valer.
    # Sem --env-file: cada aplicacao carrega o proprio .env (Gateway em
    # main.js/loadEnv e Kirana em config.js/loadEnvFile). Usar um segundo
    # carregador criaria duas interpretacoes do mesmo arquivo.
    # Caminho ABSOLUTO do script, entre aspas (suporta "C:\Program Files\...").
    # Nao e detalhe estetico: e o que permite PROVAR propriedade depois. Com
    # caminho relativo ("src/main.js"), a linha de comando do processo nao cita a
    # pasta da distribuicao, e tanto o reuso quanto a parada segura seriam
    # recusados justamente no caso legitimo.
    $scriptAbsoluto = Join-Path (Join-Path $Pasta 'src') $Arquivo
    $argumentos = @('"' + $scriptAbsoluto + '"')
    $logDir = Join-Path $Raiz 'run'
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    $log = Join-Path $logDir "$Componente.log"

    # -WindowStyle existe no Windows (5.1 e 7) e NAO existe no PowerShell de
    # Linux/macOS. Sem esta guarda o script morria com "parameter not supported
    # for the cmdlet" em qualquer ambiente que nao fosse Windows - inclusive nos
    # testes automatizados. No Windows nada muda: a janela segue oculta.
    $parametros = @{
        FilePath               = 'node'
        ArgumentList           = $argumentos
        WorkingDirectory       = $Pasta
        RedirectStandardOutput = $log
        RedirectStandardError  = (Join-Path $logDir "$Componente.err.log")
        PassThru               = $true
    }
    if ($env:OS -eq 'Windows_NT') { $parametros['WindowStyle'] = 'Hidden' }
    $proc = Start-Process @parametros

    Save-PidFile -Raiz $Raiz -Componente $Componente -ProcessoId $proc.Id -PastaTrabalho $Pasta -Porta $Porta
    return $proc
}

function Wait-Servico([int]$Porta, [int]$Tentativas = 40) {
    for ($i = 0; $i -lt $Tentativas; $i++) {
        Start-Sleep -Milliseconds 500
        $saude = Invoke-JsonLocal "http://127.0.0.1:$Porta/health" 2
        if ($null -ne $saude) { return $saude }
    }
    return $null
}
