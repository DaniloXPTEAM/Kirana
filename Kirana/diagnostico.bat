@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo Verificando ambiente, .env, gateway e modelos...
node scripts\doctor.mjs
pause
