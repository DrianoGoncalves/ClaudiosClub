# Vigia do Claudio’s Club: sobe o servidor sem janela, guarda a saída em ~/.myco/logs/server.log e religa
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

# Um vigia por vez: se o registrado ainda está vivo, este sai quieto. O Windows reaproveita PIDs
# (depois de reiniciar, o número guardado pode ser de outro processo), então confere que é um vigia.
if (Test-Path $pidFile) {
  $old = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1) -as [int]
  $p = if ($old) { Get-CimInstance Win32_Process -Filter "ProcessId=$old" -ErrorAction SilentlyContinue }
  if ($p -and $p.CommandLine -like '*myco-daemon.ps1*') { exit 0 }
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
$built = Join-Path $root 'dist\client\index.html'

# O cliente mudou desde o último build? (código, dependências ou config do Vite)
function Test-ClientChanged {
  if (-not (Test-Path $built)) { return $true }
  $since = (Get-Item $built).LastWriteTime
  $sources = @(Get-ChildItem client, shared -Recurse -File) + @(Get-Item vite.config.ts, package-lock.json)
  return [bool]($sources | Where-Object { $_.LastWriteTime -gt $since } | Select-Object -First 1)
}

while ($true) {
  if (Test-Path $stopFile) { break }
  # O cliente é gerado no (re)início quando mudou: "Reiniciar" no config já traz a tela nova, e sem
  # mudança o servidor sobe em segundos (o botão "Rodar" da tela de parado espera por ele). Só o
  # build (sem a checagem de tipos): um erro de tipo em edição não deixa o Claudio’s Club sem tela.
  if (Test-ClientChanged) {
    cmd.exe /d /c "node node_modules\vite\bin\vite.js build >> `"$log`" 2>&1"
    if ($LASTEXITCODE -ne 0) { Write-Log 'o build do cliente falhou (veja acima); o servidor sobe com a última versão do cliente' }
  }
  $started = Get-Date
  Write-Log "subindo o servidor: http://claudio.localhost:$port"
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
