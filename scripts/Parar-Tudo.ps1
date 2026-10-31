# Parar-Tudo.ps1 - encerra SOMENTE processos iniciados por esta distribuicao.
#
# Fail-closed: na duvida, NAO encerra. Tracas verificadas antes de qualquer
# Stop-Process (todas em Get-DecisaoParada, em Comum.ps1):
#   1. o PID veio de run/<componente>.pid (escrito pelo INICIAR-TUDO);
#   2. o processo ainda esta vivo;
#   3. a linha de comando do processo cita o arquivo E a pasta desta distribuicao;
#   4. a porta, se ocupada, pertence ao mesmo PID do pid file.
# Linha de comando ilegivel (CIM indisponivel), pasta diferente, PID reutilizado
# ou porta de outro processo => nada e encerrado, apenas diagnostico.

param([switch]$Forcar)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Comum.ps1')

$Raiz = Get-RaizDistribuicao

Write-Host ''
Write-Host '  Parando componentes iniciados por esta distribuicao' -ForegroundColor Cyan
Write-Host ''

$alvos = @(
    @{ Componente = 'kirana'; Arquivo = 'server.js'; Porta = 3000 },
    @{ Componente = 'gateway'; Arquivo = 'main.js'; Porta = 1455 }
)

foreach ($alvo in $alvos) {
    Write-Passo "$($alvo.Componente) (porta $($alvo.Porta))"
    $dados = Read-PidFile $Raiz $alvo.Componente
    if (-not $dados) {
        Write-Aviso "sem run\$($alvo.Componente).pid - esta distribuicao nao iniciou nada"
        $estado = Get-EstadoPorta $alvo.Porta
        if ($estado.Ocupada) {
            Write-Aviso "porta $($alvo.Porta) ocupada por PID $($estado.Pid) ($($estado.Processo)) - NAO sera encerrado"
            if ($estado.LinhaDeComando) { Write-Host "         comando: $($estado.LinhaDeComando)" }
            Write-Host '         Encerre manualmente se souber que e de uma instalacao antiga.'
        }
        continue
    }

    $procId = 0
    try { $procId = [int]$dados.pid } catch { $procId = 0 }
    $vivo = $false
    if ($procId -gt 0) { $vivo = Test-ProcessoVivo $procId }

    # Linha de comando: se a consulta falhar, fica $null - e $null significa
    # "nao encerre" (fail-closed), nunca "pode encerrar".
    $linha = $null
    if ($vivo) { $linha = Get-LinhaDeComando $procId }

    $estadoPorta = Get-EstadoPorta $alvo.Porta
    $pidDonoPorta = $null
    if ($estadoPorta.Ocupada) { $pidDonoPorta = $estadoPorta.Pid }

    $decisao = Get-DecisaoParada -Dados $dados -ProcessoVivo $vivo -LinhaDeComando $linha `
        -PidDonoPorta $pidDonoPorta -Arquivo $alvo.Arquivo -PastaTrabalho ([string]$dados.pastaTrabalho)

    switch ($decisao.Acao) {
        'limpar' {
            Write-Aviso $decisao.Motivo
            Remove-Item (Join-Path $Raiz "run\$($alvo.Componente).pid") -Force -ErrorAction SilentlyContinue
        }
        'ignorar' {
            Write-Erro "nada foi encerrado: $($decisao.Motivo)"
            if ($linha) { Write-Host "         comando do PID $procId : $linha" }
            Write-Host '         O pid file pode ser antigo. Se o processo nao for desta instalacao, deixe como esta.'
        }
        'encerrar' {
            try {
                Stop-Process -Id $procId -Force:$Forcar -ErrorAction Stop
                Write-Ok "$($alvo.Componente) encerrado (PID $procId) - $($decisao.Motivo)"
                Remove-Item (Join-Path $Raiz "run\$($alvo.Componente).pid") -Force -ErrorAction SilentlyContinue
            } catch {
                Write-Erro "nao foi possivel encerrar PID $procId : $($_.Exception.Message)"
            }
        }
    }
}

Write-Passo 'Verificacao'
Start-Sleep -Seconds 1
foreach ($porta in @(1455, 3000)) {
    $estado = Get-EstadoPorta $porta
    if ($estado.Ocupada) {
        Write-Aviso "porta $porta ainda ocupada (PID $($estado.Pid), $($estado.Processo))"
    } else {
        Write-Ok "porta $porta livre"
    }
}
Write-Host ''
