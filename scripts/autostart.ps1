# Cria (ou remove, com -Remove) o atalho do MyCo na pasta Inicializar do Windows. A cada login ele
# sobe o vigia (scripts/myco-daemon.ps1) sem janela: o servidor fica em segundo plano, com log em
# ~/.myco/logs/server.log, e volta sozinho se cair. Não precisa de administrador.
param([switch]$Remove)

$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup 'MyCo.lnk'

if ($Remove) {
  if (Test-Path $link) { Remove-Item $link -Confirm:$false; Write-Output "Atalho removido: $link" }
  else { Write-Output 'Não havia atalho do MyCo na pasta Inicializar.' }
  Write-Output 'Se o MyCo estiver rodando agora, pare com: npm run daily:stop'
  exit 0
}

$daemon = Join-Path $PSScriptRoot 'myco-daemon.ps1'
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($link)
$s.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$s.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$daemon`""
$s.WorkingDirectory = Split-Path $PSScriptRoot -Parent
$s.WindowStyle = 7 # minimizado: o PowerShell some em seguida (-WindowStyle Hidden)
$s.Description = 'MyCo em segundo plano (vigia: religa se cair)'
$s.Save()
Write-Output "Atalho criado: $link"
Write-Output 'O MyCo sobe sozinho no próximo login. Para subir agora: npm run daily:start'
Write-Output 'Endereço: http://myco.localhost:4848  |  Estado e log: npm run daily:status  |  Parar: npm run daily:stop'
Write-Output 'Para tirar do início automático: npm run autostart:remove'
