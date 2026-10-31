@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1
set "RAIZ=%~dp0"
if "%RAIZ:~-1%"=="\" set "RAIZ=%RAIZ:~0,-1%"

echo.
echo   === BACKUP de .env e estado antes de apagar pastas antigas ===
echo.

if not exist "%RAIZ%\scripts\Backup-AntesDeLimpar.ps1" (
  echo   ERRO: nao encontrei "%RAIZ%\scripts\Backup-AntesDeLimpar.ps1"
  echo   Extraia o ZIP completo antes de executar este arquivo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%RAIZ%\scripts\Backup-AntesDeLimpar.ps1" %*
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
