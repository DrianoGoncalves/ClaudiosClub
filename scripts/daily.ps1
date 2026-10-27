# MyCo em segundo plano: start (sobe o vigia sem janela), stop (para o vigia e o servidor) e status.
#   npm run daily:start | npm run daily:stop | npm run daily:status
param([ValidateSet('start', 'stop', 'status')][string]$Action = 'status', [int]$Port = 0)

$home_ = if ($env:MYCO_HOME) { $env:MYCO_HOME } else { Join-Path $env:USERPROFILE '.myco' }
$runDir = Join-Path $home_ 'run'
$pidFile = Join-Path $runDir 'daemon.pid'
$stopFile = Join-Path $runDir 'daemon.stop'
$log = Join-Path $home_ 'logs\server.log'
$port = if ($Port -gt 0) { $Port } elseif ($env:MYCO_PORT) { $env:MYCO_PORT } else { 4848 }

function Get-Daemon {
  if (-not (Test-Path $pidFile)) { return $null }
  $id = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($id) { Get-Process -Id $id -ErrorAction SilentlyContinue } else { $null }
}

switch ($Action) {
  'start' {
    if (Get-Daemon) { Write-Output "O MyCo já está rodando em segundo plano: http://myco.localhost:$port"; break }
    $daemon = Join-Path $PSScriptRoot 'myco-daemon.ps1'
    $args_ = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$daemon`"")
    if ($Port -gt 0) { $args_ += @('-Port', "$Port") }
    Start-Process (Join-Path $PSHOME 'powershell.exe') -ArgumentList $args_ -WindowStyle Hidden
    Write-Output "Subindo em segundo plano (o build leva alguns segundos): http://myco.localhost:$port"
    Write-Output "Log: $log"
  }
  'stop' {
    $d = Get-Daemon
    if (-not $d) { Write-Output 'O MyCo não está rodando em segundo plano.'; Remove-Item $pidFile -ErrorAction SilentlyContinue; break }
    New-Item -ItemType File -Force $stopFile | Out-Null
    # Encerra o vigia e tudo o que ele abriu (servidor e conversas), sem deixar processos órfãos.
    taskkill.exe /PID $d.Id /T /F | Out-Null
    Remove-Item $pidFile, $stopFile -ErrorAction SilentlyContinue
    Write-Output 'MyCo parado.'
  }
  'status' {
    $d = Get-Daemon
    $up = $false
    try { $up = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/api/health" -TimeoutSec 3).StatusCode -eq 200 } catch {}
    if ($d) { Write-Output "Vigia rodando (pid $($d.Id)) desde $($d.StartTime.ToString('dd/MM HH:mm'))." } else { Write-Output 'Vigia parado.' }
    Write-Output ($(if ($up) { "Servidor respondendo: http://myco.localhost:$port" } else { "Servidor não responde na porta $port." }))
    if (Test-Path $log) { Write-Output "--- últimas linhas de $log"; Get-Content $log -Tail 8 -Encoding UTF8 }
  }
}
