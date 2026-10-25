@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [erro] Node.js nao encontrado. Instale a versao 20 LTS ou superior: https://nodejs.org
  pause
  exit /b 1
)

echo Executando testes automatizados da Kirana...
echo (a lista de arquivos e resolvida pelo proprio Node, sem depender de glob do cmd)
echo.
node scripts\run-tests.mjs %*
set RESULT=%ERRORLEVEL%
echo.

if not "%RESULT%"=="0" (
  echo [falha] alguns testes falharam ^(codigo %RESULT%^).
) else (
  echo [ok] todos os testes passaram.
)
echo Para o diagnostico do ambiente: diagnostico.bat
pause
exit /b %RESULT%
