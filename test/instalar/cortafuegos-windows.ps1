# The firewall step of instalar/Juegos-del-Salon-Windows.bat, on any OS with
# pwsh: the Windows cmdlets (Get-NetConnectionProfile, Get-NetFirewallRule…),
# Read-Host and the elevation (Start-Process -Verb RunAs) are mocked, and the
# script that would run elevated is decoded and parsed.
# Run by test/instalar.test.js when pwsh is installed (GitHub's Ubuntu runners have it):
#   pwsh -NoProfile -File test/instalar/cortafuegos-windows.ps1 <carpeta-temporal>
param([Parameter(Mandatory = $true)][string]$Tmp)
$env:LOCALAPPDATA = Join-Path $Tmp "Users/O'Brien José Mª/AppData/Local"
New-Item -ItemType Directory -Force -Path (Join-Path $env:LOCALAPPDATA 'game-to-tv') | Out-Null
$env:G2T_SELF = Join-Path $PSScriptRoot '../../instalar/Juegos-del-Salon-Windows.bat'
$env:G2T_SOLO_FUNCIONES = '1'
. ([ScriptBlock]::Create([IO.File]::ReadAllText($env:G2T_SELF, [Text.Encoding]::UTF8)))

$fails = 0
function T([bool]$c, [string]$label) { if ($c) { Write-Host "  OK     $label" } else { Write-Host "  FALLO  $label"; $script:fails++ } }

$nodeExe = "C:\Users\O'Brien José Mª\AppData\Local\game-to-tv\node\node.exe"
$node = @{ Exe = $nodeExe }

# ---- mocks (functions win over cmdlets) ----
$script:profiles = @()
$script:rules = @()        # objects: DisplayName, Enabled, Action, Program
$script:answer = ''
$script:elevations = @()
$script:uacDeclines = $false
function Get-NetConnectionProfile { $script:profiles }
function Get-NetFirewallRule {
  param([string]$Direction, [string]$DisplayName, [string]$Action, [string]$ErrorAction)
  $r = $script:rules
  if ($DisplayName) { $r = @($r | Where-Object { $_.DisplayName -eq $DisplayName }) }
  if ($Action) { $r = @($r | Where-Object { $_.Action -eq $Action }) }
  $r
}
function Get-NetFirewallApplicationFilter { param($AssociatedNetFirewallRule, $ErrorAction) [pscustomobject]@{ Program = $AssociatedNetFirewallRule.Program } }
function Read-Host { param($Prompt) Write-Host ("  [Read-Host] " + $Prompt); $script:answer }
function Start-Process {
  param($FilePath, $Verb, $WindowStyle, [switch]$Wait, [switch]$PassThru, $ArgumentList)
  if ($script:uacDeclines) { throw 'The operation was canceled by the user.' }
  $script:elevations += , @{ File = $FilePath; Verb = $Verb; Args = $ArgumentList }
  [pscustomobject]@{ ExitCode = 0 }
}
function Rule($name, $action, $program) { [pscustomobject]@{ DisplayName = $name; Enabled = 'True'; Action = $action; Program = $program } }
function Net($name, $alias, $cat, $idx, $conn) { [pscustomobject]@{ Name = $name; InterfaceAlias = $alias; NetworkCategory = $cat; InterfaceIndex = $idx; IPv4Connectivity = $conn } }
function Decode($a) { $b64 = ($a -split ' ')[-1]; [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($b64)) }

$someRules = @(1..50 | ForEach-Object { Rule "Otra $_" 'Allow' 'Any' })

Write-Host "`n[1] Red Pública, sin regla: un solo UAC con la regla y la red Privada"
$script:profiles = @((Net 'MiFibra-1234' 'Wi-Fi' 'Public' 7 'Internet'), (Net 'Red sin identificar' 'vEthernet (WSL)' 'Public' 31 'NoTraffic'))
$script:rules = $someRules
$script:elevations = @()
Invoke-FirewallStep $node
T ($script:elevations.Count -eq 1) 'Pide permiso de administrador UNA vez'
$e = $script:elevations[0]
T ($e.Verb -eq 'RunAs' -and $e.File -eq 'powershell.exe' -and $e.Args -match '-EncodedCommand ') 'Start-Process powershell.exe -Verb RunAs -EncodedCommand'
$code = Decode $e.Args
$tok = $null; $err = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($code, [ref]$tok, [ref]$err)
T ($err.Count -eq 0) 'El script elevado es PowerShell válido'
T ($code -match 'New-NetFirewallRule -DisplayName \$rule .*-Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -RemoteAddress LocalSubnet -Profile Private,Public -Program \$node') 'Regla estrecha: TCP 3000, LocalSubnet, Private+Public, solo ese node.exe'
$strings = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] }, $true) | ForEach-Object { $_.Value })
T ($strings -contains 'game-to-tv (TCP 3000)') 'Nombre de la regla: «game-to-tv (TCP 3000)»'
T ($strings -contains $nodeExe) "La ruta de node.exe llega intacta (apóstrofo, espacios y tildes): $nodeExe"
T ($strings -contains $FirewallMarker) 'La marca de «cortafuegos listo» va a la carpeta del usuario'
T ($code -match 'foreach \(\$i in @\(7\)\)') 'Solo pasa a Privada la red de casa (índice 7), no la de WSL'
T (($code -split "`n" | Where-Object { $_ -match 'Set-NetConnectionProfile' }).Count -eq 1) 'Set-NetConnectionProfile solo dentro del script elevado'
T ($e.Args.Length -lt 30000) ('La línea de órdenes cabe en Windows (' + $e.Args.Length + ' caracteres)')

Write-Host "`n[2] Red Pública, dice que NO a Privada, sin regla: UAC solo para la regla"
$script:answer = 'n'
$script:elevations = @()
Invoke-FirewallStep $node
$code = Decode $script:elevations[0].Args
T ($script:elevations.Count -eq 1 -and $code -match 'foreach \(\$i in @\(\)\)') 'No toca el perfil de red si dice que no'
$script:answer = ''

Write-Host "`n[3] Red Privada y regla ya creada: no pregunta nada"
$script:profiles = @((Net 'MiFibra-1234' 'Wi-Fi' 'Private' 7 'Internet'))
$script:rules = $someRules + @(Rule 'game-to-tv (TCP 3000)' 'Allow' $nodeExe)
$script:elevations = @()
Invoke-FirewallStep $node
T ($script:elevations.Count -eq 0) 'Sin UAC'

Write-Host "`n[4] Regla creada pero hay un bloqueo de «Node.js JavaScript Runtime» para este node.exe"
$script:rules = $someRules + @((Rule 'game-to-tv (TCP 3000)' 'Allow' $nodeExe), (Rule 'Node.js JavaScript Runtime' 'Block' $nodeExe))
$script:elevations = @()
Invoke-FirewallStep $node
T ($script:elevations.Count -eq 1 -and (Decode $script:elevations[0].Args) -match "Remove-NetFirewallRule") 'Pide permiso para quitar el bloqueo'

Write-Host "`n[5] Regla de otro node.exe (p. ej. antes había otro Node): se rehace"
$script:rules = $someRules + @(Rule 'game-to-tv (TCP 3000)' 'Allow' 'C:\Program Files\nodejs\node.exe')
$script:elevations = @()
Invoke-FirewallStep $node
T ($script:elevations.Count -eq 1) 'Pide permiso para rehacer la regla'

Write-Host "`n[6] Sin permisos, Windows no deja leer las reglas (0 reglas)"
$script:rules = @()
Remove-Item -LiteralPath $FirewallMarker -ErrorAction SilentlyContinue
$script:elevations = @()
Invoke-FirewallStep $node
T ($script:elevations.Count -eq 1) 'Sin la marca: pide permiso'
Set-Content -LiteralPath $FirewallMarker -Value 'x'
$script:elevations = @()
Invoke-FirewallStep $node
T ($script:elevations.Count -eq 0) 'Con la marca de una vez anterior: no vuelve a preguntar'

Write-Host "`n[7] Dice que NO en el aviso de Windows (UAC)"
$script:rules = $someRules
$script:profiles = @((Net 'MiFibra-1234' 'Wi-Fi' 'Public' 7 'Internet'))
$script:uacDeclines = $true
$out = Invoke-FirewallStep $node 6>&1 | Out-String
T ($out -match 'lo más probable es que los móviles NO puedan conectarse') 'Sigue y explica qué no funcionará'

Write-Host "`n[8] Otros"
T ((ConvertTo-Arg 'C:\Users\José Mª\x.js') -eq '"C:\Users\José Mª\x.js"' -and (ConvertTo-Arg '--omit=dev') -eq '--omit=dev') 'Argumentos con espacios entre comillas'
T ((ConvertTo-PsLiteral "a'b’c") -eq "'a''b’’c'") 'Literales de PowerShell: apóstrofos rectos y tipográficos'
Write-Host "`nFallos: $fails"
exit $fails
