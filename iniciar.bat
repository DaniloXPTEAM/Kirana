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

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo [atencao] Arquivo .env criado a partir do .env.example.
  echo          Abra o .env e preencha KIRANA_GATEWAY_API_KEY com a chave do gateway.
  echo          Depois rode este arquivo novamente.
  pause
  exit /b 1
)

echo Iniciando a Kirana em http://127.0.0.1:3000 ...
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:3000"
node src\server.js
pause
