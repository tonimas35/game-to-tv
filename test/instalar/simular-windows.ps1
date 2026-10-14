# Runs the PowerShell part of instalar/Juegos-del-Salon-Windows.bat on Linux
# with pwsh, against a local server (see simular.sh). Only the architecture is
# forced; the firewall and the desktop shortcut run for real and must fail
# gracefully (with a friendly «Ojo:» message) because they are Windows-only.
param(
  [Parameter(Mandatory = $true)][string]$LocalAppData,
  [Parameter(Mandatory = $true)][string]$DistUrl,
  [Parameter(Mandatory = $true)][string]$RepoZip,
  [Parameter(Mandatory = $true)][string]$Sha,
  [string]$Mode = ''
)
$env:LOCALAPPDATA = $LocalAppData
New-Item -ItemType Directory -Force -Path $LocalAppData | Out-Null
$env:G2T_SELF = Join-Path $PSScriptRoot '../../instalar/Juegos-del-Salon-Windows.bat'
$env:G2T_ARG = $Mode
$env:G2T_SOLO_FUNCIONES = '1'
$env:G2T_NAVEGADOR = '0'
. ([ScriptBlock]::Create([IO.File]::ReadAllText($env:G2T_SELF, [Text.Encoding]::UTF8)))

$NodeDistUrl = $DistUrl
$RepoZipUrl = $RepoZip
$NodeSha256['win-x64'] = $Sha
function Get-NodeArch { 'win-x64' }

# Same wrapper as the real file
try { Main } catch {
  $msg = $_.Exception.Message
  if (-not $_.Exception.Data['g2t']) { $msg = 'Algo ha fallado: ' + $msg }
  Say $msg 'Red'; Say $PhotoHint 'Yellow'
}
