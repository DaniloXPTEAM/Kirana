$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

try { $nodeText = (& node -p "process.versions.node").Trim() } catch { throw 'Node.js is missing. Install Node.js 20.20+ from the official Node.js website, then reopen PowerShell.' }
try { $nodeVersion = [version]$nodeText } catch { throw "Could not read Node.js version: $nodeText" }
if ($nodeVersion -lt [version]'20.20.0') { throw "Node.js 20.20+ is required; found $nodeText." }
if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
  Write-Host 'Created .env from the sample. Set GATEWAY_API_KEY before starting; the setup script does not generate or display credentials.'
} else {
  Write-Host 'Existing .env found and preserved.'
}
& npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
& npm run check
if ($LASTEXITCODE -ne 0) { throw 'Syntax checks failed.' }
& npm test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
Write-Host 'Setup checks completed. Edit .env if needed, then run .\windows\Start.ps1. No engines or model weights were installed.'
