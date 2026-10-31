$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path '.env')) { throw 'Missing .env. Run .\windows\Setup.ps1 first.' }
$keyLine = Get-Content '.env' | Where-Object { $_ -match '^GATEWAY_API_KEY=' } | Select-Object -First 1
if (-not $keyLine -or $keyLine -match 'generate-with-npm-run-keygen') { throw 'Set GATEWAY_API_KEY in .env before starting. Do not paste or share it.' }
& npm start
exit $LASTEXITCODE
