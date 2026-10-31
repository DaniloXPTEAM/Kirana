# Avaliar-Modelo.ps1 — prova o motor com a SUA conta (SIWC), com o seu consentimento.
#
# O que este script faz, em ordem, e nada além disso:
#   1. lê GATEWAY_API_KEY do .env (não imprime, não envia para fora);
#   2. verifica se o Gateway está no ar em 127.0.0.1:1455;
#   3. se não houver autorização do provedor, abre a página de consentimento no
#      SEU navegador e espera você concluir (é você que autoriza, na sua conta);
#   4. descobre o slug real do modelo com GET /v1/models;
#   5. roda a bateria de tarefas e grava resultados-qualidade.json.
#
# Ele NÃO instala nada, NÃO baixa modelo, NÃO liga roteamento, NÃO muda portas e
# NÃO publica resultado. Se o provedor não responder, ele diz "não executada" —
# nunca inventa nota.
#
# Uso:   .\windows\Avaliar-Modelo.ps1
#        .\windows\Avaliar-Modelo.ps1 -BaseUrl http://127.0.0.1:1455
param(
  [string]$BaseUrl = 'http://127.0.0.1:1455',
  [int]$EsperaSegundos = 300
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Test-Path '.env')) { throw 'Missing .env. Run .\windows\Setup.ps1 first.' }
$keyLine = Get-Content '.env' | Where-Object { $_ -match '^GATEWAY_API_KEY=' } | Select-Object -First 1
if (-not $keyLine) { throw 'GATEWAY_API_KEY ausente no .env. Rode: npm run keygen' }
$key = ($keyLine -split '=', 2)[1].Trim()
if ($key -match 'generate-with-npm-run-keygen' -or $key.Length -lt 32) {
  throw 'GATEWAY_API_KEY inválida no .env. Rode: npm run keygen'
}
$headers = @{ Authorization = "Bearer $key" }

# 1) Gateway no ar?
try {
  $saude = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 5
} catch {
  throw "Gateway não respondeu em $BaseUrl. Abra outro terminal e rode .\windows\Start.ps1 ."
}
Write-Host "Gateway: $($saude.gateway) v$($saude.version) · autenticado: $($saude.authenticated)" -ForegroundColor Cyan

# 2) Consentimento — só você pode dar, na sua conta, no seu navegador.
if (-not $saude.authenticated) {
  Write-Host ''
  Write-Host 'O Gateway ainda não tem autorização do provedor (SIWC).' -ForegroundColor Yellow
  Write-Host 'Vou abrir a página de consentimento no seu navegador. Você decide e autoriza lá.'
  Start-Process "$BaseUrl/auth/start"
  $limite = (Get-Date).AddSeconds($EsperaSegundos)
  $autenticado = $false
  while ((Get-Date) -lt $limite) {
    Start-Sleep -Seconds 3
    try { if ((Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 5).authenticated) { $autenticado = $true; break } } catch { }
  }
  if (-not $autenticado) {
    Write-Host 'Sem autorização. A bateria NÃO foi executada e nenhum resultado foi gerado.' -ForegroundColor Red
    exit 2
  }
  Write-Host 'Autorização confirmada.' -ForegroundColor Green
}

# 3) Slug real — sem inventar nome de modelo.
$modelos = Invoke-RestMethod -Uri "$BaseUrl/v1/models" -Headers $headers -TimeoutSec 15
if (-not $modelos.data -or $modelos.data.Count -eq 0) {
  Write-Host 'Nenhum modelo visível na conta. Bateria NÃO executada.' -ForegroundColor Red
  exit 2
}
Write-Host "Modelos visíveis: $($modelos.data.Count)" -ForegroundColor Cyan
$modelos.data | ForEach-Object { Write-Host "  - $($_.id)" }

# 4) Bateria. Auto-descobre o modelo; --model explícito é opcional.
Write-Host ''
Write-Host 'Rodando a bateria de qualidade (uma tarefa por vez, sem pressa)...' -ForegroundColor Cyan
& node tools/quality-suite.mjs --url $BaseUrl --out resultados-qualidade.json
$codigo = $LASTEXITCODE

Write-Host ''
if (Test-Path 'resultados-qualidade.json') {
  Write-Host 'Relatório gravado em resultados-qualidade.json' -ForegroundColor Cyan
  Write-Host 'Esse arquivo traz o modelo PEDIDO, o USADO e o DECLARADO pelo provedor, além de latência e tokens.'
}
if ($codigo -eq 2) { Write-Host 'Bateria não executada (sem provedor autorizado ou Gateway fora).' -ForegroundColor Yellow }
elseif ($codigo -eq 1) { Write-Host 'Bateria executada: há tarefas reprovadas/falhas. Veja a tabela acima.' -ForegroundColor Yellow }
elseif ($codigo -eq 0) { Write-Host 'Bateria executada: nenhuma reprovação objetiva.' -ForegroundColor Green }
exit $codigo
