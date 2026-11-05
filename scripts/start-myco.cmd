@echo off
rem MyCo para o dia a dia: gera o cliente e sobe o servidor sem "watch" (npm run daily). Assim, salvar um arquivo do
rem próprio MyCo (você ou um funcionário) não reinicia o servidor nem deixa conversas órfãs.
rem O navegador abre já pareado (http://claudio.localhost:4848) quando o servidor responde. Para desenvolver o MyCo,
rem use "npm run dev" (claudio.localhost:5173) e "npm run pair:dev".
rem Para iniciar com o Windows: npm run autostart (cria um atalho na pasta Inicializar).
chcp 65001 >nul
title MyCo
cd /d "%~dp0.."
call npm run daily
if errorlevel 1 (
  echo.
  echo Falhou; veja o erro acima. Aperte uma tecla para fechar.
  pause >nul
  exit /b 1
)
