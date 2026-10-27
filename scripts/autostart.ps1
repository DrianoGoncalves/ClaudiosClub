# Cria (ou remove, com -Remove) o atalho do MyCo na pasta Inicializar do Windows, para ele subir
# junto com o sistema em modo dia a dia (scripts/start-myco.cmd), minimizado.
param([switch]$Remove)

$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup 'MyCo.lnk'

if ($Remove) {
  if (Test-Path $link) { Remove-Item $link -Confirm:$false; Write-Output "Atalho removido: $link" }
  else { Write-Output 'Não havia atalho do MyCo na pasta Inicializar.' }
  exit 0
}

$target = Join-Path $PSScriptRoot 'start-myco.cmd'
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($link)
$s.TargetPath = $target
$s.WorkingDirectory = Split-Path $PSScriptRoot -Parent
$s.WindowStyle = 7 # minimizado
$s.Description = 'MyCo (dia a dia, sem watch)'
$s.Save()
Write-Output "Atalho criado: $link"
Write-Output 'Para tirar: npm run autostart:remove'
