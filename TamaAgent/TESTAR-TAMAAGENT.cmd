@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js nao encontrado. Instale o Node 20.6 ou mais novo. & pause & exit /b 1)
if not exist node_modules (echo Instalando dependencias, so na primeira vez... & call npm ci --no-audit --no-fund)
node scripts\diagnostico-omniroute.mjs
echo.
echo Codigo de saida: %errorlevel%  (0 tudo certo, 1 falha, 3 bloqueado)
pause
