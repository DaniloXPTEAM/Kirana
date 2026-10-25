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

rem --- dependencias (pnpm) ---------------------------------------------------
rem O projeto usa pnpm-lock.yaml como fonte da verdade. Nunca use npm install:
rem o package-lock.json do npm era da v0.2.0 e foi removido na v0.4.0.
if exist "node_modules\@langchain\langgraph\package.json" goto deps_ok

echo [atencao] Dependencias nao instaladas nesta pasta.
echo.
echo           Instale uma unica vez, dentro de "%~dp0", com:
echo.
echo               corepack pnpm install --frozen-lockfile
echo.
echo           O corepack ja vem com o Node 20 LTS. O --frozen-lockfile garante
echo           exatamente as versoes testadas (o pnpm usado esta fixado no
echo           package.json em packageManager).
echo.
echo           Nao use "npm install" nesta versao.
pause
exit /b 1

:deps_ok
rem ---------------------------------------------------------------------------

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
