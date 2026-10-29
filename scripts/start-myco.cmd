@echo off
rem Claudio's Club para o dia a dia: gera o cliente e sobe o servidor sem "watch". Assim, salvar um arquivo do
rem próprio Claudio's Club (você ou um funcionário) não reinicia o servidor nem deixa conversas órfãs.
rem Abre em http://claudio.localhost:4848. Para desenvolver o Claudio's Club, use "npm run dev" (claudio.localhost:5173).
rem Em segundo plano, sem janela e religando se cair: npm run daily:start (ou npm run autostart).
chcp 65001 >nul
title Claudio's Club
cd /d "%~dp0.."
call npm run build
if errorlevel 1 (
  echo.
  echo O build falhou; veja o erro acima. Aperte uma tecla para fechar.
  pause >nul
  exit /b 1
)
start "" http://claudio.localhost:4848
call npm start
