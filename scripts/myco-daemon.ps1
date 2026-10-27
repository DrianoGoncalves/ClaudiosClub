# Vigia do MyCo: sobe o servidor sem janela, guarda a saída em ~/.myco/logs/server.log e religa
# sozinho se ele cair. Para parar: npm run daily:stop (cria o arquivo de parada e encerra tudo).
# Usado pelo atalho da pasta Inicializar (npm run autostart) e por npm run daily:start.
#   -Port: porta do servidor (padrão 4848, ou MYCO_PORT).
param([int]$Port = 0)

$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
if ($Port -gt 0) { $env:MYCO_PORT = "$Port" }
$port = if ($env:MYCO_PORT) { $env:MYCO_PORT } else { '4848' }
$home_ = if ($env:MYCO_HOME) { $env:MYCO_HOME } else { Join-Path $env:USERPROFILE '.myco' }
$logDir = Join-Path $home_ 'logs'
$runDir = Join-Path $home_ 'run'
New-Item -ItemType Directory -Force $logDir, $runDir | Out-Null
$log = Join-Path $logDir 'server.log'
$pidFile = Join-Path $runDir 'daemon.pid'
$stopFile = Join-Path $runDir 'daemon.stop'

function Write-Log([string]$line) {
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  [IO.File]::AppendAllText($log, "[$stamp] [vigia] $line`n", (New-Object System.Text.UTF8Encoding $false))
}

# Um vigia por vez: se o registrado ainda está vivo, este sai quieto.
if (Test-Path $pidFile) {
  $old = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) { exit 0 }
}
Set-Content -Path $pidFile -Value $PID -Encoding ascii
Remove-Item $stopFile -ErrorAction SilentlyContinue

# Log de até ~5 MB: o anterior vira server.log.1.
if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item -Force $log "$log.1" }

# Variáveis do Claude Code de quem chamou não vazam para o servidor (ele limpa as dos filhos também).
Get-ChildItem env: | Where-Object Name -match '^(CLAUDE|ANTHROPIC)' | ForEach-Object { Remove-Item "env:$($_.Name)" -ErrorAction SilentlyContinue }

Write-Log "iniciando em $root (porta $port)"

# O servidor sabe que tem vigia: o config mostra "Reiniciar" (sair e voltar) além de "Parar".
$env:MYCO_DAEMON = '1'
$delay = 5
while ($true) {
  if (Test-Path $stopFile) { break }
  # O cliente é gerado a cada (re)início: "Reiniciar" no config já traz a tela nova. Só o build
  # (sem a checagem de tipos): um erro de tipo em edição não deixa o MyCo sem tela.
  cmd.exe /d /c "node node_modules\vite\bin\vite.js build >> `"$log`" 2>&1"
  if ($LASTEXITCODE -ne 0) { Write-Log 'o build do cliente falhou (veja acima); o servidor sobe com a última versão do cliente' }
  $started = Get-Date
  Write-Log "subindo o servidor: http://myco.localhost:$port"
  cmd.exe /d /c "node node_modules\tsx\dist\cli.mjs server\index.ts >> `"$log`" 2>&1"
  $code = $LASTEXITCODE
  if (Test-Path $stopFile) { break }
  # Caiu logo de novo (porta ocupada, erro na subida): espera cada vez mais, até 1 min.
  $delay = if (((Get-Date) - $started).TotalSeconds -lt 30) { [Math]::Min($delay * 2, 60) } else { 5 }
  Write-Log "o servidor saiu (código $code); religando em $delay s"
  Start-Sleep -Seconds $delay
}

Write-Log 'parado'
Remove-Item $stopFile, $pidFile -ErrorAction SilentlyContinue
