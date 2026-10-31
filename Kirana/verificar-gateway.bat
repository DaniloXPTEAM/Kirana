@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem Verifica o contrato do Gateway REAL (somente leitura por padrao).
rem   verificar-gateway.bat           -> sem gasto de uso da conta
rem   verificar-gateway.bat --live    -> inclui 2 chamadas de modelo
rem O Gateway precisa estar rodando e o .env da Kirana precisa ter
rem KIRANA_GATEWAY_API_KEY preenchida. Este script NAO altera o Gateway.

where node >nul 2>nul
if errorlevel 1 (
  echo [erro] Node.js nao encontrado.
  pause
  exit /b 1
)

if not exist ".env" (
  echo [erro] .env ausente. Copie .env.example para .env e preencha
  echo        KIRANA_GATEWAY_API_KEY com a GATEWAY_API_KEY do Gateway.
  pause
  exit /b 1
)

echo Verificando o Gateway real (nenhuma chave e exibida)...
echo.
node scripts\preflight-gateway.mjs %*
set RESULT=%ERRORLEVEL%
echo.
if not "%RESULT%"=="0" (
  echo [falha] o preflight reprovou. Leia as linhas [XX] acima.
  echo         Detalhes completos em homologacao\.
) else (
  echo [ok] contrato do gateway verificado.
)
echo Para a homologacao completa: homologar.bat --full
pause
exit /b %RESULT%
