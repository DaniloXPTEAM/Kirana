# Preparar-AcessoRemoto.ps1 — prepara o acesso privado do Tama IA ao Gateway.
#
# Arquitetura (não muda portas, não muda o Gateway):
#   Tama IA Android → Tailscale privado → Tailscale Serve (HTTPS) → Kirana :3000
#                    → ponte /api/gateway/* → Gateway 127.0.0.1:1455
#
# O que este script FAZ:
#   1. faz BACKUP do .env da Kirana (com data) antes de qualquer alteração;
#   2. completa as variáveis da ponte em modo remoto, gerando tokens se faltarem;
#   3. confere se o Gateway e a Kirana estão no ar;
#   4. verifica o Tailscale e mostra o endereço HTTPS privado;
#   5. aplica `tailscale serve --bg 3000` (Serve, NUNCA Funnel).
#
# O que ele NÃO faz: abrir porta no roteador, mexer no firewall público, ligar
# Funnel, alterar modelos, alterar as portas 1455/3000 ou trocar o Gateway.
#
# Onde você participa: no login do Tailscale (se ainda não estiver logado) e na
# autorização do aparelho Xiaomi (etapa separada, em docs/ACESSO-REMOTO-TAILSCALE.md).
#
# Uso:
#   .\windows\Preparar-AcessoRemoto.ps1               # prepara e mostra o que faria
#   .\windows\Preparar-AcessoRemoto.ps1 -AplicarServe  # aplica o tailscale serve
param(
  [string]$KiranaDir = (Split-Path -Parent $PSScriptRoot),
  [switch]$AplicarServe,
  [int]$PortaKirana = 3000
)

$ErrorActionPreference = 'Stop'
function Passo($t) { Write-Host ''; Write-Host "=== $t ===" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  OK   $t" -ForegroundColor Green }
function Aviso($t) { Write-Host "  !    $t" -ForegroundColor Yellow }
function Falha($t) { Write-Host "  X    $t" -ForegroundColor Red }

function NovoToken {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

Passo '0. Localizando a Kirana'
$envPath = Join-Path $KiranaDir '.env'
if (-not (Test-Path $envPath)) { throw "Não achei $envPath . Rode a partir da pasta da Kirana." }
Ok "Kirana em $KiranaDir"

Passo '1. Backup do .env'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path (Join-Path $KiranaDir 'backups') ".env.$stamp.bak"
New-Item -ItemType Directory -Force -Path (Split-Path $backup) | Out-Null
Copy-Item $envPath $backup
$hash = (Get-FileHash $backup -Algorithm SHA256).Hash
Ok "backup: $backup"
Ok "sha256: $hash"

Passo '2. Lendo e completando a configuração'
$linhas = Get-Content $envPath
$mapa = @{}
foreach ($l in $linhas) {
  if ($l -match '^\s*#' -or $l -notmatch '=') { continue }
  $k, $v = $l -split '=', 2
  $mapa[$k.Trim()] = $v.Trim()
}

function ValorOuGera($nome, $gerar) {
  if ($mapa[$nome] -and $mapa[$nome].Length -ge 32) { return $mapa[$nome] }
  if ($gerar) { return NovoToken }
  return $mapa[$nome]
}

$bridgeToken = ValorOuGera 'KIRANA_BRIDGE_TOKEN' $true
$accessToken = ValorOuGera 'KIRANA_ACCESS_TOKEN' $true

$desejado = [ordered]@{
  'KIRANA_HOST'                  = '127.0.0.1'   # Serve entrega em loopback: não precisa abrir na rede
  'KIRANA_ACCESS_TOKEN'          = $accessToken
  'KIRANA_BRIDGE'                = 'on'
  'KIRANA_BRIDGE_TOKEN'          = $bridgeToken
  'KIRANA_BRIDGE_REQUIRE_HTTPS'  = 'on'
  'KIRANA_BRIDGE_TRUST_PROXY'    = 'on'
  'KIRANA_BRIDGE_RATE_MAX'       = '30'
}

$saida = New-Object System.Collections.Generic.List[string]
$aplicadas = @{}
foreach ($l in $linhas) {
  if ($l -match '^\s*#' -or $l -notmatch '=') { $saida.Add($l); continue }
  $k = ($l -split '=', 2)[0].Trim()
  if ($desejado.Contains($k)) {
    $saida.Add("$k=$($desejado[$k])")
    $aplicadas[$k] = $true
  } else {
    $saida.Add($l)
  }
}
foreach ($k in $desejado.Keys) {
  if (-not $aplicadas.ContainsKey($k)) { $saida.Add("$k=$($desejado[$k])") }
}
Set-Content -Path $envPath -Value $saida -Encoding UTF8

foreach ($k in $desejado.Keys) {
  if ($k -match 'TOKEN') { Ok "$k definido (${($desejado[$k]).Length} caracteres)" } else { Ok "$k=$($desejado[$k])" }
}
Aviso 'Os tokens ficaram no .env da Kirana. Não os coloque em chat, e-mail ou repositório.'

Passo '3. Gateway e Kirana estão no ar?'
try {
  $h = Invoke-RestMethod -Uri 'http://127.0.0.1:1455/health' -TimeoutSec 5
  Ok "Gateway: v$($h.version) · autenticado no provedor: $($h.authenticated)"
  if (-not $h.authenticated) {
    Aviso 'Gateway sem autorização do provedor (SIWC). A ponte funciona, mas conversas darão 401 até você autorizar em http://127.0.0.1:1455/auth/start'
  }
} catch {
  Falha 'Gateway não respondeu em 127.0.0.1:1455. Suba com .\windows\Start.ps1 (pasta do Gateway).'
}
try {
  $k = Invoke-RestMethod -Uri "http://127.0.0.1:$PortaKirana/health" -TimeoutSec 5
  Ok "Kirana: $($k.status) v$($k.version)"
} catch {
  Aviso "Kirana não respondeu em 127.0.0.1:$PortaKirana (reinicie após este script: node src/server.js)"
}

Passo '4. Tailscale'
$exe = @(
  "$env:ProgramFiles\Tailscale\tailscale.exe",
  "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { $c = Get-Command tailscale -ErrorAction SilentlyContinue; if ($c) { $exe = $c.Source } }
if (-not $exe) {
  Falha 'Tailscale não instalado. Rode .\windows\Verificar-Tailscale.ps1 para as instruções.'
  exit 1
}
$s = (& $exe status --json 2>&1) | ConvertFrom-Json
if ($s.BackendState -ne 'Running') {
  Falha 'Tailscale instalado mas não conectado. Abra o app e faça login (você autentica).'
  exit 1
}
$dns = $s.Self.DNSName
$url = "https://$($dns.TrimEnd('.'))"
Ok "conta conectada · aparelho: $dns"
Ok "endereço HTTPS privado (Serve): $url"

Passo '5. Tailscale Serve (não Funnel)'
$alvo = "http://127.0.0.1:$PortaKirana"
Write-Host "  comando: $exe serve --bg $PortaKirana"
Write-Host "  efeito : $url  →  $alvo   (somente dentro do seu tailnet, TLS do Tailscale)"
if ($AplicarServe) {
  & $exe serve --bg $PortaKirana
  if ($LASTEXITCODE -ne 0) { Falha "serve falhou (código $LASTEXITCODE). Se pedir HTTPS/MagicDNS, habilite no admin console do Tailscale."; exit 1 }
  Ok 'serve aplicado'
  & $exe serve status
} else {
  Aviso 'Não apliquei (rode com -AplicarServe para aplicar).'
}

Write-Host ''
Write-Host 'Próximo passo (celular):' -ForegroundColor Cyan
Write-Host "  1. instale o Tailscale no Xiaomi e entre com a MESMA conta;"
Write-Host "  2. autorize o aparelho no admin console (você aprova);"
Write-Host "  3. teste no celular (rede móvel, Wi-Fi desligado):"
Write-Host "     curl -H `"Authorization: Bearer <KIRANA_BRIDGE_TOKEN>`" $url/api/gateway/ping"
Write-Host ''
Write-Host 'Guia completo: docs/ACESSO-REMOTO-TAILSCALE.md'
Write-Host 'Nada foi publicado na internet: o Serve só responde dentro do tailnet.'
