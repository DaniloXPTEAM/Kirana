@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem ---------------------------------------------------------------------
rem MODO DEMONSTRACAO: sobe um gateway SIMULADO e a Kirana apontando para ele.
rem Nenhum modelo real e chamado. Use para conhecer a interface e testar
rem streaming, ferramentas e confirmacao sem gastar a conta ChatGPT.
rem ---------------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 (
  echo [erro] Node.js nao encontrado. Instale a versao 20 LTS ou superior: https://nodejs.org
  pause
  exit /b 1
)

echo Iniciando gateway simulado em http://127.0.0.1:1455 ...
start "Kirana - gateway simulado" cmd /c "node scripts\mock-gateway.js --port 1455 --key local-mock"

set KIRANA_GATEWAY_URL=http://127.0.0.1:1455
set KIRANA_GATEWAY_API_KEY=local-mock

echo Iniciando a Kirana em http://127.0.0.1:3000 ...
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:3000"
node src\server.js

pause
