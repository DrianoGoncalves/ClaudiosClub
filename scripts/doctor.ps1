# Checklist do Claudio's Club: confere o que falta para o projeto rodar (Node 22+, Git, Claude Code, login,
# dependencias, build e botao Iniciar) e grava scripts/status.js, que a pagina scripts/start.html le.
# So leitura e sem administrador: nao instala nada, nao le arquivo de credencial nem valor de variavel.
#   npm run doctor
# Este arquivo e so ASCII (PS 5.1 le sem BOM como ANSI): os acentos vem de [char].

$ok_ = [char]0x2713   # check
$no_ = [char]0x2717   # x
$a_ = [char]0xE3      # a com til
$c_ = [char]0xE7      # c cedilha
$e_ = [char]0xEA      # e circunflexo

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$checks = New-Object System.Collections.ArrayList

function Add-Check([string]$id, [bool]$ok, [string]$detail) {
  [void]$checks.Add([pscustomobject]@{ id = $id; ok = $ok; detail = $detail })
}

# Roda um programa se ele existe no PATH; devolve a primeira linha da saida, ou vazio.
function Get-FirstLine([string]$exe, [string[]]$argv) {
  if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { return '' }
  try {
    $out = & $exe @argv 2>$null
    return [string]($out | Select-Object -First 1)
  } catch { return '' }
}

# Um check que falhar por excecao vira "erro ao verificar" em vez de derrubar o script.
function Invoke-Check([string]$id, [scriptblock]$block) {
  try { & $block } catch { Add-Check $id $false 'erro ao verificar' }
}

Invoke-Check 'node' {
  $v = (Get-FirstLine 'node' @('-v')).Trim()
  $major = 0
  if ($v -match '^v(\d+)\.') { $major = [int]$Matches[1] }
  if (-not $v) { Add-Check 'node' $false "n${a_}o encontrado" }
  elseif ($major -ge 22) { Add-Check 'node' $true $v }
  else { Add-Check 'node' $false "$v (precisa 22+)" }
}

Invoke-Check 'git' {
  $v = (Get-FirstLine 'git' @('--version')).Trim()
  if ($v) { Add-Check 'git' $true $v } else { Add-Check 'git' $false "n${a_}o encontrado" }
}

Invoke-Check 'claude' {
  $v = (Get-FirstLine 'claude' @('--version')).Trim()
  if ($v) { Add-Check 'claude' $true $v } else { Add-Check 'claude' $false "n${a_}o encontrado" }
}

Invoke-Check 'login' {
  $cred = Join-Path $env:USERPROFILE '.claude\.credentials.json'
  if (Test-Path $cred) { Add-Check 'login' $true 'credencial do Claude Code presente' }
  elseif (-not [string]::IsNullOrEmpty($env:ANTHROPIC_API_KEY)) { Add-Check 'login' $true 'ANTHROPIC_API_KEY definida' }
  else { Add-Check 'login' $false "fa${c_}a login: rode claude" }
}

Invoke-Check 'deps' {
  if (Test-Path (Join-Path $root 'node_modules\.package-lock.json')) { Add-Check 'deps' $true 'node_modules instalado' }
  else { Add-Check 'deps' $false 'node_modules ausente' }
}

Invoke-Check 'build' {
  if (Test-Path (Join-Path $root 'dist\client\index.html')) { Add-Check 'build' $true 'dist\client\index.html' }
  else { Add-Check 'build' $false 'build ausente' }
}

Invoke-Check 'launcher' {
  if (Test-Path 'HKCU:\Software\Classes\myco\shell\open\command') { Add-Check 'launcher' $true 'myco:// registrado' }
  else { Add-Check 'launcher' $false "registro n${a_}o encontrado" }
}

# status.js: window.claudioStatus = { at, checks }. UTF-8 sem BOM.
$statusFile = Join-Path $PSScriptRoot 'status.js'
$payload = [pscustomobject]@{ at = (Get-Date).ToString('o'); checks = @($checks) }
$json = $payload | ConvertTo-Json -Depth 3 -Compress
[IO.File]::WriteAllText($statusFile, "window.claudioStatus = $json;", (New-Object System.Text.UTF8Encoding($false)))

$labels = @{
  node     = 'Node 22 ou mais novo'
  git      = 'Git'
  claude   = 'Claude Code instalado'
  login    = 'Login no Claude Code'
  deps     = "Depend$($e_)ncias"
  build    = 'Build do app'
  launcher = "Bot$($a_)o Iniciar registrado"
}

foreach ($c in $checks) {
  $mark = $no_
  if ($c.ok) { $mark = $ok_ }
  Write-Output ("{0} {1,-26} {2}" -f $mark, $labels[$c.id], $c.detail)
}
$okCount = @($checks | Where-Object { $_.ok }).Count
Write-Output "$okCount de $($checks.Count) ok. Gravado em $statusFile"
