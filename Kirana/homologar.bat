@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

rem ===========================================================================
rem  HOMOLOGACAO REAL — Kirana + Gateway ChatGPT local (a rodar no Windows)
rem
rem  Este arquivo NAO inventa resultado: ele MEDE. Cada etapa grava a sua saida
rem  em homologacao\ e o resumo final diz o que passou e o que falhou.
rem
rem  Pre-requisitos, na ordem:
rem    1. o Gateway ja esta rodando (janela dele aberta, /auth/start concluido)
rem    2. .env da Kirana com KIRANA_GATEWAY_API_KEY preenchida
rem    3. dependencias instaladas (corepack pnpm install --frozen-lockfile)
rem
rem  Uso:
rem    homologar.bat            -> tudo, menos o teste de navegador
rem    homologar.bat --full     -> inclui as suites de navegador (Playwright)
rem    homologar.bat --no-live  -> nao gasta chamadas de modelo no preflight
rem ===========================================================================

set "FULL=0"
set "LIVE=--live"
for %%A in (%*) do (
  if /i "%%A"=="--full" set "FULL=1"
  if /i "%%A"=="--no-live" set "LIVE="
)

if not exist "homologacao" mkdir "homologacao"
for /f "tokens=1-4 delims=/:. " %%a in ("%DATE% %TIME%") do set "STAMP=%%d%%b%%c-%%a"
set "REL=homologacao\homologacao-%STAMP%.txt"

echo ===========================================================================
echo  HOMOLOGACAO DA KIRANA - %DATE% %TIME%
echo  Relatorio: %REL%
echo ===========================================================================
echo. > "%REL%"

where node >nul 2>nul
if errorlevel 1 (
  echo [erro] Node.js nao encontrado. Instale Node 20 LTS ou superior.
  pause
  exit /b 1
)

if not exist ".env" (
  echo [erro] Arquivo .env ausente. Copie .env.example para .env e preencha
  echo        KIRANA_GATEWAY_API_KEY com a GATEWAY_API_KEY do Gateway.
  pause
  exit /b 1
)

set "FAILS=0"
set "ETAPA=0"

rem ------------------------- 1. ambiente e configuracao ---------------------
set /a ETAPA+=1
echo.
echo [%ETAPA%/6] Ambiente, .env e gateway (scripts\doctor.mjs)
node scripts\doctor.mjs > "homologacao\etapa%ETAPA%-doctor.txt" 2>&1
type "homologacao\etapa%ETAPA%-doctor.txt"
echo [%ETAPA%] doctor >> "%REL%"
type "homologacao\etapa%ETAPA%-doctor.txt" >> "%REL%"
echo. >> "%REL%"

rem ------------------------- 2. contrato do Gateway REAL --------------------
set /a ETAPA+=1
echo.
echo [%ETAPA%/6] Contrato do Gateway REAL (scripts\preflight-gateway.mjs %LIVE%)
node scripts\preflight-gateway.mjs %LIVE% --out "homologacao\etapa%ETAPA%-preflight.json" > "homologacao\etapa%ETAPA%-preflight.txt" 2>&1
set "PREFLIGHT=%ERRORLEVEL%"
type "homologacao\etapa%ETAPA%-preflight.txt"
if not "%PREFLIGHT%"=="0" (
  set /a FAILS+=1
  echo [falha] preflight do gateway reprovado ^(codigo %PREFLIGHT%^).
)
echo [%ETAPA%] preflight do gateway >> "%REL%"
type "homologacao\etapa%ETAPA%-preflight.txt" >> "%REL%"
echo. >> "%REL%"

rem ------------------------- 3. suite automatizada --------------------------
set /a ETAPA+=1
echo.
echo [%ETAPA%/6] Suite automatizada (node scripts\run-tests.mjs)
node scripts\run-tests.mjs > "homologacao\etapa%ETAPA%-testes.txt" 2>&1
set "TESTS=%ERRORLEVEL%"
type "homologacao\etapa%ETAPA%-testes.txt" | findstr /R /C:"^# tests" /C:"^# pass" /C:"^# fail" /C:"^not ok"
if not "%TESTS%"=="0" (
  set /a FAILS+=1
  echo [falha] suite automatizada com falhas ^(codigo %TESTS%^). Detalhes no arquivo da etapa.
)
echo [%ETAPA%] suite automatizada >> "%REL%"
type "homologacao\etapa%ETAPA%-testes.txt" >> "%REL%"
echo. >> "%REL%"

rem ------------------------- 4. contrato de payload -------------------------
set /a ETAPA+=1
echo.
echo [%ETAPA%/6] Contrato de payload com o gateway (scripts\audit-contract.mjs)
node scripts\audit-contract.mjs > "homologacao\etapa%ETAPA%-contrato.txt" 2>&1
set "CONTRACT=%ERRORLEVEL%"
type "homologacao\etapa%ETAPA%-contrato.txt" | findstr /R /C:"Violacoes" /C:"Viola" /C:"viola" /C:"REPROVADO" /C:"APROVADO" /C:"requisicoes"
if not "%CONTRACT%"=="0" (
  set /a FAILS+=1
  echo [falha] auditoria de contrato reprovada ^(codigo %CONTRACT%^).
)
echo [%ETAPA%] auditoria de contrato >> "%REL%"
type "homologacao\etapa%ETAPA%-contrato.txt" >> "%REL%"
echo. >> "%REL%"

rem ------------------------- 5. conversa real de ponta a ponta --------------
set /a ETAPA+=1
echo.
echo [%ETAPA%/6] Conversa REAL com a Kirana (scripts\homologar-conversa.mjs)
node scripts\homologar-conversa.mjs --live > "homologacao\etapa%ETAPA%-conversa.txt" 2>&1
set "TALK=%ERRORLEVEL%"
type "homologacao\etapa%ETAPA%-conversa.txt"
if not "%TALK%"=="0" (
  set /a FAILS+=1
  echo [falha] conversa de homologacao reprovada ^(codigo %TALK%^).
)
echo [%ETAPA%] conversa real >> "%REL%"
type "homologacao\etapa%ETAPA%-conversa.txt" >> "%REL%"
echo. >> "%REL%"

rem ------------------------- 6. navegador (opcional) ------------------------
set /a ETAPA+=1
echo.
echo [%ETAPA%/6] Testes de navegador (Playwright)
if "%FULL%"=="0" (
  echo [--] ignorado. Use homologar.bat --full para executar.
  echo [%ETAPA%] navegador: ignorado ^(--full nao informado^) >> "%REL%"
) else (
  rem Os testes de navegador precisam de uma Kirana rodando. Sobe uma instancia
  rem temporaria numa porta propria, aponta para o gateway do .env e derruba no fim.
  echo       Subindo instancia temporaria da Kirana na porta 3055...
  start "" /b cmd /c "set KIRANA_PORT=3055&& set KIRANA_HOST=127.0.0.1&& node src\server.js > homologacao\servidor-homologacao.log 2>&1"
  timeout /t 6 /nobreak >nul
  set "BROWSER_FAILS=0"
  for %%F in (demo-flow site-flow site-v2 site-v5) do (
    echo       -- %%F
    set KIRANA_BASE_URL=http://127.0.0.1:3055
    node test\browser\%%F.mjs >> "homologacao\etapa%ETAPA%-navegador.txt" 2>&1
    if !ERRORLEVEL! NEQ 0 set /a BROWSER_FAILS+=1
  )
  taskkill /f /im node.exe /fi "WINDOWTITLE eq *3055*" >nul 2>nul
  findstr /R /C:"verificações" /C:"verificacoes" /C:"FALHAS" "homologacao\etapa%ETAPA%-navegador.txt"
  if not "!BROWSER_FAILS!"=="0" (
    set /a FAILS+=1
    echo [falha] !BROWSER_FAILS! suite(s) de navegador com falha.
    echo [atencao] A instancia temporaria pode continuar ativa: feche a janela do Node
    echo           aberta por este script antes de dar a homologacao por encerrada.
  )
  echo [%ETAPA%] navegador >> "%REL%"
  type "homologacao\etapa%ETAPA%-navegador.txt" >> "%REL%"
  echo. >> "%REL%"
)

rem ------------------------------- resumo ----------------------------------
echo.
echo ===========================================================================
if "%FAILS%"=="0" (
  echo  RESULTADO: ETAPAS APROVADAS
) else (
  echo  RESULTADO: %FAILS% ETAPA^(S^) COM FALHA
)
echo ===========================================================================
echo  Arquivos gerados em "%~dp0homologacao\".
echo  Envie o arquivo do relatorio ^(e os JSONs^) para a proxima sessao.
echo  IMPORTANTE: os arquivos NAO contem chave do gateway nem token de acesso.
echo.
echo RESULTADO FINAL: %FAILS% falha^(s^) >> "%REL%"
pause
exit /b %FAILS%
