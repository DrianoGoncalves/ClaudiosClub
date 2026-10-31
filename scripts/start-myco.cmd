@echo off
rem MyCo para o dia a dia: gera o cliente e sobe o servidor sem "watch". Assim, salvar um arquivo do
rem próprio MyCo (você ou um funcionário) não reinicia o servidor nem deixa conversas órfãs.
rem Abre em http://myco.localhost:4848. Para desenvolver o MyCo, use "npm run dev" (myco.localhost:5173).
rem Para iniciar com o Windows: npm run autostart (cria um atalho na pasta Inicializar).
chcp 65001 >nul
title MyCo
cd /d "%~dp0.."
call npm run build
if errorlevel 1 (
  echo.
  echo O build falhou; veja o erro acima. Aperte uma tecla para fechar.
  pause >nul
  exit /b 1
)
start "" http://myco.localhost:4848
call npm start
