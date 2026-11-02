# Configura o TamaAgent: cria o .env com a chave do OmniRoute e um token de ponte.
# A chave e digitada aqui (oculta) e vai SO para o arquivo .env desta pasta.
# Nunca e mostrada, nunca vai para o Git, nunca vai para conversa ou Drive.
# Compativel com Windows PowerShell 5.1 (arquivo em ASCII puro).
$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $raiz '.env'
$exemplo = Join-Path $raiz '.env.example'

if (-not (Test-Path $exemplo)) { throw "Nao achei .env.example em $raiz" }

if (Test-Path $envPath) {
    $r = Read-Host "Ja existe um .env aqui. Fazer copia (.env.bak) e refazer? (s/n)"
    if ($r -ne 's') { Write-Host 'Nada foi alterado.'; exit 0 }
    Copy-Item $envPath ($envPath + '.bak') -Force
}

$url = Read-Host "Endereco do OmniRoute (Enter = http://127.0.0.1:20128)"
if ([string]::IsNullOrWhiteSpace($url)) { $url = 'http://127.0.0.1:20128' }

$seg = Read-Host "Cole a chave (API key) do OmniRoute e tecle Enter (nao aparece na tela)" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($seg)
try { $chave = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
if ([string]::IsNullOrWhiteSpace($chave)) { throw 'Chave vazia. Nada foi gravado.' }

# token da ponte: 48 caracteres aleatorios (gerador criptografico)
$bytes = New-Object byte[] 36
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$token = ([Convert]::ToBase64String($bytes)).Replace('+','a').Replace('/','b').Replace('=','')

$linhas = Get-Content $exemplo | ForEach-Object {
    if ($_ -match '^TAMAAGENT_GATEWAY_URL=') { "TAMAAGENT_GATEWAY_URL=$url" }
    elseif ($_ -match '^TAMAAGENT_GATEWAY_API_KEY=') { "TAMAAGENT_GATEWAY_API_KEY=$chave" }
    elseif ($_ -match '^TAMAAGENT_BRIDGE_TOKEN=') { "TAMAAGENT_BRIDGE_TOKEN=$token" }
    else { $_ }
}
[IO.File]::WriteAllLines($envPath, $linhas, (New-Object Text.UTF8Encoding($false)))
$chave = $null

Write-Host ''
Write-Host "Pronto: .env criado em $envPath"
Write-Host "Chave gravada: sim (valor nao mostrado). Token da ponte: gerado ($($token.Length) caracteres)."
Write-Host "O token da ponte e o que o app Tama IA usa. Ele esta no .env, na linha TAMAAGENT_BRIDGE_TOKEN."
Write-Host 'Proximo passo: TESTAR-TAMAAGENT.cmd'
