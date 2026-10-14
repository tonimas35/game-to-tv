<# : Juegos del Salon (game-to-tv) - instalador y lanzador para Windows 10/11. Haz doble clic.
@echo off
chcp 65001 >nul
title Juegos del Salon
set "G2T_SELF=%~f0"
set "G2T_ARG=%~1"
(
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$s = [IO.File]::ReadAllText($env:G2T_SELF, [Text.Encoding]::UTF8); & ([ScriptBlock]::Create($s))"
  if errorlevel 1 (
    echo.
    echo   Algo ha fallado. Haz una foto de esta pantalla y enviasela a quien te paso el archivo.
    echo.
    pause
  )
  exit /b
)
#>
# -----------------------------------------------------------------------------
# The lines above are for cmd.exe (they must stay pure ASCII, no BOM, CRLF):
# they run THIS same file as PowerShell. Everything below is Windows
# PowerShell 5.1 (Windows 10/11), read as UTF-8. The ( ... ) block is parsed
# in one go, so cmd never reads this part of the file.
#
# What it does (no admin rights needed, except the optional firewall step):
#  1. Node.js 18+ already installed? Use it. Otherwise download the official
#     portable Node.js (pinned version, SHA-256 checked) into
#     %LOCALAPPDATA%\game-to-tv\node.
#  2. Download game-to-tv (GitHub zip of the main branch) into
#     %LOCALAPPDATA%\game-to-tv\app and run `npm install --omit=dev`. On
#     re-runs, update it the same way (the user's ~/.game-to-tv is untouched;
#     the old version stays if anything fails).
#  3. Desktop shortcut «Juegos del Salón» (runs a copy of this file with
#     «jugar»: start without downloading anything).
#  4. Windows firewall: read-only check; if needed, ONE elevation prompt that
#     adds the rule «game-to-tv (TCP 3000)» (only from the local subnet) and,
#     with consent, marks the home network as Private.
#  5. `game-to-tv start --navegador --sencillo`: server + TV page full screen.
#
# Testing: with G2T_SOLO_FUNCIONES=1 it only defines the functions, so
# test/instalar/ can run them with pwsh on Linux (mocked Windows cmdlets).
# -----------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is much slower with the progress bar on PS 5.1
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

# --- Pinned versions: official Node.js LTS, SHA-256 from nodejs.org SHASUMS256.txt ---
$NodeVersion = '22.23.3'
$NodeSha256 = @{
  'win-x64'   = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71'
  'win-arm64' = '33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535'
  'win-x86'   = '1e07ac00e61b41b7ecf242de8e38883d237d5ad3fdcad7c16f2dd3a88670e2b6'
}
$NodeDistUrl = 'https://nodejs.org/dist'
$RepoZipUrl  = 'https://codeload.github.com/tonimas35/game-to-tv/zip/refs/heads/main'
$Port        = 3000
$RuleName    = 'game-to-tv (TCP 3000)'
$PhotoHint   = 'Haz una foto de esta pantalla y envíasela a quien te pasó el archivo.'

$Base           = Join-Path ([string]$env:LOCALAPPDATA) 'game-to-tv'
$NodeDir        = Join-Path $Base 'node'
$AppDir         = Join-Path $Base 'app'
$TmpDir         = Join-Path $Base 'tmp'
$Launcher       = Join-Path $Base 'Juegos-del-Salon.bat'
$FirewallMarker = Join-Path $Base 'cortafuegos-ok.txt'
$Self           = [string]$env:G2T_SELF
$PlayOnly       = ($env:G2T_ARG -eq 'jugar')

# ----------------------------------------------------------------- messages --

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host ('  ' + $Text) -ForegroundColor $Color }
function Step([string]$Text) { Write-Host ''; Write-Host ('  >> ' + $Text) -ForegroundColor Cyan }
function Good([string]$Text) { Write-Host ('     Hecho: ' + $Text) -ForegroundColor Green }
function Warn([string]$Text) { Write-Host ('     Ojo: ' + $Text) -ForegroundColor Yellow }

# A friendly error (plain Spanish), shown by the catch at the end
function Fail([string]$Text) {
  $e = New-Object System.Exception($Text)
  $e.Data['g2t'] = $true
  throw $e
}

function Wait-Enter([string]$Text = 'Pulsa Enter para cerrar esta ventana') {
  Write-Host ''
  try { [void](Read-Host ('  ' + $Text)) } catch { }
}

function Show-Banner {
  Write-Host ''
  Write-Host '  ╔════════════════════════════════════════════════════╗' -ForegroundColor Magenta
  Write-Host '  ║          JUEGOS DEL SALÓN  ·  game-to-tv           ║' -ForegroundColor Magenta
  Write-Host '  ╚════════════════════════════════════════════════════╝' -ForegroundColor Magenta
  Say 'La tele es la pantalla y los móviles son los mandos.'
  if (-not (Test-Path -LiteralPath $AppDir)) { Say 'La primera vez tarda unos minutos: descarga unos 40 MB de Internet.' }
}

# ------------------------------------------------------------------ helpers --

function Remove-Dir([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  for ($i = 0; $i -lt 3; $i++) {
    try { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop; return } catch { Start-Sleep -Milliseconds 800 }
  }
  if (Test-Path -LiteralPath $Path) {
    Fail ('No puedo borrar la carpeta ' + $Path + '. ¿Hay otra ventana de Juegos del Salón abierta? Ciérrala y vuelve a probar.')
  }
}

function Get-File([string]$Url, [string]$OutFile) {
  $last = $null
  for ($i = 1; $i -le 3; $i++) {
    try {
      if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }
      Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
      return
    } catch { $last = $_; Start-Sleep -Seconds (2 * $i) }
  }
  throw $last
}

function Expand-Zip([string]$Zip, [string]$Dest) {
  try {
    # Much faster than Expand-Archive on Windows PowerShell 5.1
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Dest)
  } catch {
    Remove-Dir $Dest
    Expand-Archive -LiteralPath $Zip -DestinationPath $Dest -Force
  }
}

# Quotes one argument for a Windows command line (paths with spaces/accents: «José Mª»)
function ConvertTo-Arg([string]$A) {
  if ($A -eq '' -or $A -match '[\s"]') { return '"' + ($A -replace '"', '\"') + '"' }
  return $A
}

# Runs node in THIS console window (so the QR and colors show, and closing the window stops it)
function Invoke-Node($Node, [string]$WorkDir, [string[]]$Arguments) {
  $line = ($Arguments | ForEach-Object { ConvertTo-Arg $_ }) -join ' '
  $env:npm_config_update_notifier = 'false'
  $p = Start-Process -FilePath $Node.Exe -ArgumentList $line -WorkingDirectory $WorkDir -NoNewWindow -Wait -PassThru
  return $p.ExitCode
}

function Test-PortOpen([int]$P) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $c.BeginConnect('127.0.0.1', $P, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne(800)) { return $false }
    $c.EndConnect($ar)
    return $true
  } catch { return $false } finally { $c.Close() }
}

function Get-AppVersion {
  try { return [string]((Get-Content -LiteralPath (Join-Path $AppDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version) } catch { return '?' }
}

# -------------------------------------------------------------------- Node ---

function Get-NodeArch {
  $a = ''
  try { $a = [string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture } catch { }
  if (-not $a) {
    if ($env:PROCESSOR_ARCHITEW6432) { $a = [string]$env:PROCESSOR_ARCHITEW6432 } else { $a = [string]$env:PROCESSOR_ARCHITECTURE }
  }
  if ($a -match 'arm') { return 'win-arm64' }
  if ($a -match '64') { return 'win-x64' }
  return 'win-x86'
}

function Get-NodeVersionString([string]$Exe) {
  if (-not $Exe -or -not (Test-Path -LiteralPath $Exe)) { return '' }
  $ErrorActionPreference = 'Continue'   # native stderr must not stop the script
  try { return ([string](& $Exe -v 2>$null)).Trim() } catch { return '' }
}

function Get-NodeMajor([string]$Exe) {
  $v = Get-NodeVersionString $Exe
  if ($v -match '^v?(\d+)\.') { return [int]$Matches[1] }
  return 0
}

function New-NodeInfo([string]$Exe, [bool]$Portable) {
  return @{ Exe = $Exe; NpmCli = [IO.Path]::Combine((Split-Path -Parent $Exe), 'node_modules', 'npm', 'bin', 'npm-cli.js'); Portable = $Portable }
}

# A Node.js 18+ that is already installed (with its npm next to it)
function Find-SystemNode {
  $cmd = Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmd) { return $null }
  $info = New-NodeInfo ([string]$cmd.Path) $false
  if ((Get-NodeMajor $info.Exe) -ge 18 -and (Test-Path -LiteralPath $info.NpmCli)) { return $info }
  return $null
}

function Test-PortableNode {
  $info = New-NodeInfo (Join-Path $NodeDir 'node.exe') $true
  if ((Get-NodeMajor $info.Exe) -ge 18 -and (Test-Path -LiteralPath $info.NpmCli)) { return $info }
  return $null
}

function Install-PortableNode {
  $have = Test-PortableNode
  if ($have -and ((Get-NodeVersionString $have.Exe) -eq ('v' + $NodeVersion) -or $PlayOnly)) { return $have }
  $arch = Get-NodeArch
  $name = 'node-v' + $NodeVersion + '-' + $arch
  $url = $NodeDistUrl + '/v' + $NodeVersion + '/' + $name + '.zip'
  Step ('Descargando Node.js ' + $NodeVersion + ', el motor de los juegos (unos 30 MB)...')
  New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
  $zip = Join-Path $TmpDir ($name + '.zip')
  try { Get-File $url $zip } catch {
    if ($have) { Warn 'No he podido descargar Node.js (¿sin Internet?). Sigo con el que ya tenías.'; return $have }
    Fail ("No he podido descargar Node.js. ¿Tiene Internet este ordenador?`n  (" + $url + ': ' + $_.Exception.Message + ')')
  }
  $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $NodeSha256[$arch]) {
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    Fail 'El Node.js descargado no es el oficial (la comprobación de seguridad no coincide), así que no lo instalo.'
  }
  Say 'Descomprimiendo...'
  $x = Join-Path $TmpDir 'node-nuevo'
  Remove-Dir $x
  Expand-Zip $zip $x
  $inner = Join-Path $x $name
  if (-not (Test-Path -LiteralPath (Join-Path $inner 'node.exe'))) { Fail 'El archivo de Node.js descargado no tiene lo que esperaba.' }
  Remove-Dir $NodeDir
  Move-Item -LiteralPath $inner -Destination $NodeDir
  Remove-Dir $x
  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  $info = Test-PortableNode
  if (-not $info) { Fail 'Node.js no arranca en este ordenador.' }
  Good ('Node.js ' + $NodeVersion + ' (' + $arch + ') listo.')
  return $info
}

function Get-Node {
  Step 'Comprobando Node.js, el motor de los juegos...'
  $sys = Find-SystemNode
  if ($sys) { Good ('Uso el Node.js que ya tenías instalado (' + (Get-NodeVersionString $sys.Exe) + ').'); return $sys }
  $have = Test-PortableNode
  if ($have -and $PlayOnly) { return $have }
  return Install-PortableNode
}

# --------------------------------------------------------------------- app ---

function Update-App($Node) {
  $hasApp = (Test-Path -LiteralPath ([IO.Path]::Combine($AppDir, 'bin', 'game-to-tv.js'))) -and (Test-Path -LiteralPath ([IO.Path]::Combine($AppDir, 'node_modules', 'ws')))
  if ($PlayOnly -and $hasApp) { return }
  if ($hasApp) { Step 'Buscando la última versión de los juegos...' } else { Step 'Descargando los juegos...' }
  New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
  $zip = Join-Path $TmpDir 'game-to-tv.zip'
  try { Get-File $RepoZipUrl $zip } catch {
    if ($hasApp) { Warn 'No he podido buscar la última versión (¿sin Internet?). Sigo con la que ya tenías.'; return }
    Fail ("No he podido descargar los juegos. ¿Tiene Internet este ordenador?`n  (" + $RepoZipUrl + ': ' + $_.Exception.Message + ')')
  }
  $x = Join-Path $TmpDir 'app-nueva'
  Remove-Dir $x
  Expand-Zip $zip $x
  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  $inner = Get-ChildItem -LiteralPath $x -Directory | Select-Object -First 1
  if (-not $inner -or -not (Test-Path -LiteralPath ([IO.Path]::Combine($inner.FullName, 'bin', 'game-to-tv.js')))) {
    Fail 'Lo descargado no tiene los juegos que esperaba.'
  }
  Say 'Preparando los juegos (npm install)...'
  $code = Invoke-Node $Node $inner.FullName @($Node.NpmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error')
  if ($code -ne 0) {
    Remove-Dir $x
    if ($hasApp) { Warn 'No he podido preparar la versión nueva. Sigo con la que ya tenías.'; return }
    Fail ('No he podido preparar los juegos (npm install ha fallado, código ' + $code + '). ¿Tiene Internet este ordenador?')
  }
  # Swap only now: if anything above failed, the old version is still there
  $old = Join-Path $Base 'app-vieja'
  try { Remove-Dir $old } catch { }
  if (Test-Path -LiteralPath $AppDir) {
    try { Move-Item -LiteralPath $AppDir -Destination $old -ErrorAction Stop } catch {
      Remove-Dir $x
      Warn 'No he podido cambiar a la versión nueva (alguna carpeta está en uso). Sigo con la que ya tenías.'
      return
    }
  }
  Move-Item -LiteralPath $inner.FullName -Destination $AppDir
  try { Remove-Dir $x; Remove-Dir $old } catch { }
  Good ('Juegos listos (versión ' + (Get-AppVersion) + ').')
}

# ---------------------------------------------------------------- shortcut ---

# A .ico that just wraps the app's PNG icon (Windows Vista+ reads PNG icons)
function Write-IcoFromPng([string]$Png, [string]$Ico) {
  $b = [IO.File]::ReadAllBytes($Png)
  $w = [int]$b[16] * 16777216 + [int]$b[17] * 65536 + [int]$b[18] * 256 + [int]$b[19]
  $h = [int]$b[20] * 16777216 + [int]$b[21] * 65536 + [int]$b[22] * 256 + [int]$b[23]
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)   # reserved, type = icon, 1 image
  $bw.Write([byte]($w % 256)); $bw.Write([byte]($h % 256))           # (256 is stored as 0)
  $bw.Write([byte]0); $bw.Write([byte]0)                             # palette, reserved
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)                        # planes, bits per pixel
  $bw.Write([UInt32]$b.Length); $bw.Write([UInt32]22)                # image size, offset
  $bw.Write($b)
  $bw.Flush()
  [IO.File]::WriteAllBytes($Ico, $ms.ToArray())
}

function New-DesktopShortcut {
  try {
    New-Item -ItemType Directory -Force -Path $Base | Out-Null
    if ($Self -and (Test-Path -LiteralPath $Self) -and ([IO.Path]::GetFullPath($Self) -ne [IO.Path]::GetFullPath($Launcher))) {
      # A fresh copy (bytes only): no «downloaded from the Internet» mark, so no warning next time
      [IO.File]::WriteAllBytes($Launcher, [IO.File]::ReadAllBytes($Self))
    }
    if (-not (Test-Path -LiteralPath $Launcher)) { return }
    $ico = Join-Path $Base 'juegos.ico'
    $png = [IO.Path]::Combine($AppDir, 'apps', 'webos-launcher', 'largeIcon.png')
    if (Test-Path -LiteralPath $png) { try { Write-IcoFromPng $png $ico } catch { } }
    $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Juegos del Salón.lnk'
    $sh = New-Object -ComObject WScript.Shell
    $s = $sh.CreateShortcut($lnk)
    $s.TargetPath = $Launcher
    $s.Arguments = 'jugar'
    $s.WorkingDirectory = $Base
    $s.Description = 'Juegos del Salón: la tele es la pantalla y los móviles, los mandos'
    if (Test-Path -LiteralPath $ico) { $s.IconLocation = $ico + ',0' }
    $s.Save()
    Good 'Icono «Juegos del Salón» en el escritorio: la próxima vez, ábrelo desde ahí.'
  } catch {
    Warn ('No he podido crear el icono del escritorio (' + $_.Exception.Message + '). La próxima vez, abre este mismo archivo.')
  }
}

# ---------------------------------------------------------------- firewall ---

# The home network(s): the ones with Internet (not WSL/Hyper-V/VPN adapters)
function Get-HomeNetworks {
  $all = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue)
  $net = @($all | Where-Object { [string]$_.IPv4Connectivity -eq 'Internet' })
  if ($net.Count -eq 0) {
    $net = @($all | Where-Object { [string]$_.InterfaceAlias -notmatch 'vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|Tailscale|ZeroTier|VPN' })
  }
  return $net
}

function Get-RuleProgram($Rule) {
  try { return [Environment]::ExpandEnvironmentVariables([string](Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $Rule -ErrorAction Stop).Program) } catch { return '' }
}

# Read-only. Without admin rights some Windows return NO rules at all: then
# «Readable» is false and we trust the marker left by a previous elevation.
function Get-FirewallState([string]$NodeExe) {
  $st = @{ Readable = $false; RuleOk = $false; Blocks = 0 }
  try {
    $st.Readable = (@(Get-NetFirewallRule -Direction Inbound -ErrorAction SilentlyContinue).Count -gt 0)
    if ($st.Readable) {
      foreach ($r in @(Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue)) {
        if ([string]$r.Enabled -ne 'True' -or [string]$r.Action -ne 'Allow') { continue }
        $prog = Get-RuleProgram $r
        if ($prog -eq 'Any' -or $prog -ieq $NodeExe) { $st.RuleOk = $true }
      }
      # «Node.js JavaScript Runtime» BLOCK rules for this node.exe (someone pressed «Cancelar» once): they win over Allow rules
      $st.Blocks = @(Get-NetFirewallRule -Direction Inbound -Action Block -ErrorAction SilentlyContinue |
        Where-Object { [string]$_.Enabled -eq 'True' -and $_.DisplayName -like '*Node.js*' -and (Get-RuleProgram $_) -ieq $NodeExe }).Count
    }
  } catch { }
  return $st
}

function ConvertTo-PsLiteral([string]$S) { return "'" + ($S -replace '[''‘’‚‛]', '$0$0') + "'" }

# The script that runs elevated (one UAC prompt). Values are embedded as literals.
function New-ElevatedScript([string]$NodeExe, [int[]]$PrivateIndexes) {
  $t = @'
$ok = $true
$rule = __RULE__
$node = __NODE__
try { Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue } catch { }
try {
  New-NetFirewallRule -DisplayName $rule -Description 'Juegos del Salón (game-to-tv): solo el puerto __PORT__ y solo desde la red de casa' -Direction Inbound -Action Allow -Protocol TCP -LocalPort __PORT__ -RemoteAddress LocalSubnet -Profile Private,Public -Program $node -ErrorAction Stop | Out-Null
} catch { $ok = $false }
try {
  Get-NetFirewallRule -Direction Inbound -Action Block -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like '*Node.js*' -and [Environment]::ExpandEnvironmentVariables([string]($_ | Get-NetFirewallApplicationFilter).Program) -ieq $node } |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
} catch { }
foreach ($i in @(__INDEXES__)) {
  try { Set-NetConnectionProfile -InterfaceIndex $i -NetworkCategory Private -ErrorAction Stop } catch { $ok = $false }
}
if ($ok) { try { Set-Content -LiteralPath __MARKER__ -Value (Get-Date -Format s) -ErrorAction Stop } catch { } ; exit 0 }
exit 1
'@
  $t = $t.Replace('__RULE__', (ConvertTo-PsLiteral $RuleName)).Replace('__NODE__', (ConvertTo-PsLiteral $NodeExe))
  $t = $t.Replace('__MARKER__', (ConvertTo-PsLiteral $FirewallMarker)).Replace('__PORT__', [string]$Port)
  $t = $t.Replace('__INDEXES__', (($PrivateIndexes | ForEach-Object { [string][int]$_ }) -join ','))
  return $t
}

function Invoke-FirewallStep($Node) {
  Step 'Comprobando el cortafuegos de Windows (para que los móviles puedan conectarse)...'
  $nets = @()
  try { $nets = @(Get-HomeNetworks) } catch {
    Warn 'No he podido comprobar la red. Si los móviles no se conectan, avisa a quien te pasó el archivo.'
    return
  }
  $public = @($nets | Where-Object { [string]$_.NetworkCategory -eq 'Public' })
  $fw = Get-FirewallState $Node.Exe
  if ($fw.Readable) { $needRule = (-not $fw.RuleOk) -or ($fw.Blocks -gt 0) }
  else { $needRule = -not (Test-Path -LiteralPath $FirewallMarker) }

  $makePrivate = @()
  if ($public.Count -gt 0) {
    $names = ($public | ForEach-Object { if ($_.Name) { '«' + $_.Name + '»' } else { '«' + $_.InterfaceAlias + '»' } }) -join ', '
    Write-Host ''
    Say ('Tu red de casa ' + $names + ' está marcada como «Pública».') 'Yellow'
    Say 'Así, Windows no deja que los móviles se conecten a este ordenador.' 'Yellow'
    Say 'En casa lo normal es marcarla como «Privada» (una red de confianza).'
    $ans = ''
    try { $ans = Read-Host '  ¿La marco como Privada? Pulsa Enter para decir que SÍ (o escribe N y Enter para que no)' } catch { }
    if ($ans -notmatch '^\s*[nN]') { $makePrivate = @($public) }
  }
  if (-not $needRule -and $makePrivate.Count -eq 0) { Good 'El cortafuegos ya deja pasar a los móviles.'; return }

  Write-Host ''
  Say 'Ahora Windows te preguntará: «¿Quieres permitir que esta aplicación haga cambios en el dispositivo?»' 'White'
  Say 'Pulsa «Sí». Solo sirve para esto:' 'White'
  if ($needRule) { Say '  - dejar que los móviles y la tele de casa se conecten a los juegos (solo el puerto 3000);' }
  if ($makePrivate.Count -gt 0) { Say '  - marcar tu red de casa como Privada.' }

  $script = New-ElevatedScript $Node.Exe ([int[]]@($makePrivate | ForEach-Object { $_.InterfaceIndex }))
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  $declined = $false
  $ok = $false
  try {
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $enc)
    $ok = ($p.ExitCode -eq 0)
  } catch { $declined = $true }

  if ($ok) { Good 'Cortafuegos listo: los móviles ya pueden conectarse.' }
  elseif ($declined) {
    Warn 'Sin ese permiso, lo más probable es que los móviles NO puedan conectarse (ni el navegador de la tele).'
    Warn 'Los juegos se verán igualmente en este ordenador. La próxima vez que lo abras te lo volveré a preguntar.'
  } else {
    Warn 'No se ha podido cambiar todo. Si los móviles no se conectan, haz una foto de esta pantalla y envíasela a quien te pasó el archivo.'
  }
}

# -------------------------------------------------------------------- main ---

function Main {
  Show-Banner
  if ($PSVersionTable.PSVersion.Major -lt 5) { Fail 'Este Windows es demasiado antiguo: hace falta Windows 10 u 11.' }
  if (-not $env:LOCALAPPDATA) { Fail 'No encuentro la carpeta de datos de Windows (LOCALAPPDATA).' }
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
  New-Item -ItemType Directory -Force -Path $Base | Out-Null

  $node = $null
  if (Test-PortOpen $Port) {
    # Already running in another window: do not touch the files it is using
    Say 'Parece que Juegos del Salón ya está en marcha en otra ventana.'
    $node = Find-SystemNode
    if (-not $node) { $node = Test-PortableNode }
    if (-not $node -or -not (Test-Path -LiteralPath (Join-Path $AppDir 'bin'))) {
      Start-Process ('http://localhost:' + $Port + '/')
      Wait-Enter
      return
    }
  } else {
    $node = Get-Node
    Update-App $node
    if (-not $PlayOnly) { New-DesktopShortcut }
    Invoke-FirewallStep $node
  }

  Step 'Arrancando los juegos...'
  $code = Invoke-Node $node $AppDir @(([IO.Path]::Combine($AppDir, 'bin', 'game-to-tv.js')), 'start', '--navegador', '--sencillo')
  if ($code -ne 0) {
    Write-Host ''
    Say ('Los juegos se han parado (código ' + $code + ').') 'Red'
    Say $PhotoHint 'Yellow'
  }
  Wait-Enter
}

if ($env:G2T_SOLO_FUNCIONES -ne '1') {
  try {
    Main
    exit 0
  } catch {
    $msg = $_.Exception.Message
    if (-not $_.Exception.Data['g2t']) { $msg = 'Algo ha fallado: ' + $msg }
    Write-Host ''
    Say $msg 'Red'
    Write-Host ''
    Say $PhotoHint 'Yellow'
    Wait-Enter
    exit 0
  }
}
