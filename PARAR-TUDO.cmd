@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1
set "RAIZ=%~dp0"
if "%RAIZ:~-1%"=="\" set "RAIZ=%RAIZ:~0,-1%"

echo.
echo   === PARAR - somente processos desta distribuicao ===
echo.

if not exist "%RAIZ%\scripts\Parar-Tudo.ps1" (
  echo   ERRO: nao encontrei "%RAIZ%\scripts\Parar-Tudo.ps1"
  echo   Extraia o ZIP completo antes de executar este arquivo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%RAIZ%\scripts\Parar-Tudo.ps1" %*
set "CODIGO=%ERRORLEVEL%"

echo.
if "%CODIGO%"=="0" (
  echo   Concluido sem erros.
) else (
  echo   ATENCAO: terminou com codigo %CODIGO%. Leia as mensagens acima.
)
echo.
pause
exit /b %CODIGO%
