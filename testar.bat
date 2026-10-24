@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo Executando testes automatizados...
node --test test/
echo.
echo Para o diagnostico do ambiente: diagnostico.bat
pause
