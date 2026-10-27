# Atalho "MyCo" no Menu Iniciar e o link myco://start, que o botão "Iniciar" da página de início
# (scripts/start.html) usa para subir o MyCo em segundo plano. Só no seu usuário, sem administrador.
# O link não recebe nada de fora: qualquer página que o chame só consegue ligar o MyCo, e o
# navegador pergunta antes. Para desfazer: -Remove.
param([switch]$Remove)

$key = 'HKCU:\Software\Classes\myco'
$link = Join-Path ([Environment]::GetFolderPath('Programs')) 'MyCo.lnk'

if ($Remove) {
  if (Test-Path $key) { Remove-Item $key -Recurse -Force; Write-Output 'Link myco:// removido.' }
  if (Test-Path $link) { Remove-Item $link -Force; Write-Output "Atalho removido: $link" }
  exit 0
}

$ps = Join-Path $PSHOME 'powershell.exe'
$daily = Join-Path $PSScriptRoot 'daily.ps1'
New-Item -Path "$key\shell\open\command" -Force | Out-Null
Set-Item -Path $key -Value 'URL:MyCo'
New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
Set-Item -Path "$key\shell\open\command" -Value "`"$ps`" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$daily`" start"
Write-Output 'Link myco://start registrado.'

$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($link)
$s.TargetPath = Join-Path $PSScriptRoot 'start.html'
$s.Description = 'MyCo: abre o escritório (ou o botão para iniciar, se estiver parado)'
$s.Save()
Write-Output "Atalho criado no Menu Iniciar: $link"
Write-Output 'Abra "MyCo" pelo Menu Iniciar: se estiver no ar, entra direto; se estiver parado, mostra o botão Iniciar.'
