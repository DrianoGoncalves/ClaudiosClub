# Atalho "Claudio’s Club" no Menu Iniciar e o link myco://start, que o botão "Iniciar" da página de início
# (scripts/start.html) usa para subir o Claudio’s Club em segundo plano. Só no seu usuário, sem administrador.
# O link não recebe nada de fora: qualquer página que o chame só consegue ligar o Claudio’s Club, e o
# navegador pergunta antes. Para desfazer: -Remove.
# Strings com o apóstrofo do nome vão entre aspas duplas: no PowerShell, ’ também fecha aspas simples.
param([switch]$Remove)

$key = 'HKCU:\Software\Classes\myco'
$programs = [Environment]::GetFolderPath('Programs')
$link = Join-Path $programs "Claudio’s Club.lnk"
# Atalho com o nome antigo (MyCo), de antes da troca de nome.
$old = Join-Path $programs 'MyCo.lnk'
if (Test-Path $old) { Remove-Item $old -Force }

if ($Remove) {
  if (Test-Path $key) { Remove-Item $key -Recurse -Force; Write-Output 'Link myco:// removido.' }
  if (Test-Path $link) { Remove-Item $link -Force; Write-Output "Atalho removido: $link" }
  exit 0
}

$ps = Join-Path $PSHOME 'powershell.exe'
$daily = Join-Path $PSScriptRoot 'daily.ps1'
New-Item -Path "$key\shell\open\command" -Force | Out-Null
Set-Item -Path $key -Value "URL:Claudio’s Club"
New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
Set-Item -Path "$key\shell\open\command" -Value "`"$ps`" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$daily`" start"
Write-Output 'Link myco://start registrado.'

$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($link)
$s.TargetPath = Join-Path $PSScriptRoot 'start.html'
$s.Description = "Claudio’s Club: abre o escritório (ou o botão para iniciar, se estiver parado)"
$s.Save()
Write-Output "Atalho criado no Menu Iniciar: $link"
Write-Output "Abra o Claudio’s Club pelo Menu Iniciar: se estiver no ar, entra direto; se estiver parado, mostra o botão Iniciar."
