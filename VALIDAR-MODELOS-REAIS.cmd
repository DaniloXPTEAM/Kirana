@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Kirana - Validar modelos reais (Gateway)

echo.
echo  ==========================================================
echo   KIRANA - VALIDACAO DE MODELOS REAIS (Gateway v0.4.1)
echo  ==========================================================
echo.
echo  Este verificador NAO contorna a autenticacao.
echo  Se a conta ainda nao estiver autorizada, ele diz isso e para.
echo.
echo  Chamadas de geracao: 2 no fluxo padrao (inferencia + streaming).
echo  Com --com-cancelamento: 3 (a terceira e abortada no primeiro delta).
echo  NAO existe limite de tokens configuravel: o Gateway REJEITA max_tokens.
echo  Limites reais: 180 s por requisicao e 4 MiB de resposta (lado Gateway);
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [X] Node.js nao encontrado no PATH.
  echo      Instale o Node 20+ ^(o INSTALAR-WINDOWS.cmd usa o mesmo Node^).
  echo.
  pause
  exit /b 3
)

if not exist "%~dp0tools\validar-modelos-reais.mjs" (
  echo  [X] Falta tools\validar-modelos-reais.mjs nesta pasta.
  echo      Extraia este pacote de validacao sobre a pasta da Kirana.
  echo.
  pause
  exit /b 3
)

node "%~dp0tools\validar-modelos-reais.mjs" %*
set CODIGO=%ERRORLEVEL%

echo.
if "%CODIGO%"=="0" (
  echo  [OK] Validacao concluida sem falhas.
) else if "%CODIGO%"=="3" (
  echo  [BLOQUEADO] Falta autorizar a conta SIWC.
  echo             Abra http://127.0.0.1:1455/auth/start neste computador,
  echo             conclua o login e rode este mesmo comando de novo.
) else if "%CODIGO%"=="1" (
  echo  [ATENCAO] Algum teste FALHOU. Veja a linha marcada como FAIL acima.
) else (
  echo  [ERRO] Codigo de saida %CODIGO%.
)

echo.
echo  Relatorios gerados em: docs\validacao\
echo.
pause
exit /b %CODIGO%
