@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js nao encontrado. Instale o Node 20.6 ou mais novo. & pause & exit /b 1)
if not exist .env (echo Falta o .env. Rode CONFIGURAR-TAMAAGENT.cmd primeiro. & pause & exit /b 1)
if not exist node_modules (echo Instalando dependencias, so na primeira vez... & call npm ci --no-audit --no-fund)
echo TamaAgent em http://127.0.0.1:3000  (feche esta janela para parar)
start "" http://127.0.0.1:3000
node src\server.js
pause
