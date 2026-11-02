# Verificar-Tailscale.ps1 — diagnóstico SOMENTE LEITURA do Tailscale no Windows.
#
# Não instala, não autentica, não altera nada. Só responde:
#   • o Tailscale está instalado? qual versão?
#   • está conectado? qual o nome DNS privado (.ts.net)?
#   • o Serve já está configurado? o Funnel está ligado (não deve estar)?
#   • existe algum indício de exposição pública?
#
# Saída em texto, para você me mandar o resultado sem precisar abrir nada.

$ErrorActionPreference = 'Continue'
function Linha($texto) { Write-Host $texto }

Linha '=== 1. Instalação ==='
$caminhos = @(
  "$env:ProgramFiles\Tailscale\tailscale.exe",
  "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe",
  "$env:LOCALAPPDATA\Tailscale\tailscale.exe"
)
$exe = $caminhos | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) {
  $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($cmd) { $exe = $cmd.Source }
}

if ($exe) {
  Linha "OK  instalado: $exe"
  $versao = & $exe version 2>&1 | Select-Object -First 1
  Linha "    versao: $versao"
} else {
  Linha 'NAO instalado (ou fora do PATH).'
  Linha ''
  Linha 'Para instalar (você executa, é a sua máquina):'
  Linha '  winget install --id tailscale.tailscale -e'
  Linha 'ou baixe o instalador oficial em https://tailscale.com/download/windows'
  Linha ''
  Linha 'Depois de instalar, rode este script de novo.'
  exit 1
}

Linha ''
Linha '=== 2. Estado da conexão ==='
$statusJson = & $exe status --json 2>&1
try {
  $s = $statusJson | ConvertFrom-Json
  $backend = $s.BackendState
  Linha "estado: $backend"
  if ($backend -ne 'Running') {
    Linha 'NAO conectado. Abra o app do Tailscale e faça login (você autentica).'
  }
  Linha "conta: $($s.User.'$'.GetType())" -ErrorAction SilentlyContinue | Out-Null
  if ($s.Self) {
    Linha "nome DNS: $($s.Self.DNSName)  (é a base do endereço https://)"
    Linha "IP tailnet: $($s.Self.TailscaleIPs -join ', ')"
    Linha "SO: $($s.Self.OS) · online: $($s.Self.Online)"
  }
  $peers = @($s.Peer.PSObject.Properties)
  Linha "aparelhos no tailnet: $($peers.Count)"
  foreach ($p in $peers) {
    $v = $p.Value
    $marca = if ($v.Online) { 'online' } else { 'offline' }
    Linha ("  - {0} [{1}] {2} ({3})" -f $v.HostName, $v.OS, $marca, ($v.TailscaleIPs -join ', '))
  }
} catch {
  Linha 'Não consegui interpretar o status. Saída bruta abaixo:'
  Linha ($statusJson | Out-String)
}

Linha ''
Linha '=== 3. Serve / Funnel ==='
$serve = & $exe serve status 2>&1 | Out-String
if ($serve -match 'No serve config|no serve config|não há') {
  Linha 'Serve: ainda não configurado (esperado na primeira vez).'
} else {
  Linha 'Serve atual:'
  Linha $serve.Trim()
}
$funnel = & $exe funnel status 2>&1 | Out-String
if ($funnel -match 'No funnel config|no funnel config') {
  Linha 'Funnel: desligado (correto — não usamos Funnel).'
} else {
  Linha 'ATENÇÃO: Funnel com configuração ativa. Não é o que queremos:'
  Linha $funnel.Trim()
  Linha 'Para remover: tailscale funnel reset'
}

Linha ''
Linha '=== 4. Chaves de exposição pública no Windows ==='
$regras = @()
foreach ($perfil in @('Private', 'Public', 'Domain')) {
  $r = Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -ErrorAction SilentlyContinue |
       Where-Object { $_.DisplayName -match 'tailscale' }
  $regras = $r
}
if ($regras) {
  Linha "regras de firewall do Tailscale ativas: $(@($regras).Count) (normal: o Tailscale usa interface própria)"
} else {
  Linha 'nenhuma regra de firewall do Tailscale encontrada (pode ser normal em instalação recente)'
}

Linha ''
Linha '=== 5. Portas locais em escuta ==='
$linhas = netstat -ano | Select-String 'LISTENING' | Select-String ':3000|:1455|:443'
if ($linhas) { $linhas | ForEach-Object { Linha $_.ToString().Trim() } } else { Linha 'nenhuma das portas 3000/1455/443 em escuta' }

Linha ''
Linha 'Fim do diagnóstico. Nada foi alterado.'
