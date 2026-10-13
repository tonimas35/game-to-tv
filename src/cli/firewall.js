'use strict';
/*
 * Windows firewall checks for `game-to-tv doctor` (read-only).
 *
 * What we learned on a real setup: the TV could not reach the PC because
 *  1) the Wi-Fi/Ethernet network profile was «Public», which blocks inbound
 *     connections, and
 *  2) Windows had auto-created «Node.js JavaScript Runtime» BLOCK rules for
 *     the Public profile (when someone clicked «Cancel» on the firewall
 *     prompt). Block rules win over Allow rules.
 * The fix: network profile «Private» + one narrow rule (TCP <port>, only
 * from the local subnet). We never change anything: we print the exact
 * PowerShell commands (to run as administrator).
 */
const { execFile } = require('child_process');

// One PowerShell call that returns everything as JSON (read-only cmdlets)
function psScript(port) {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$profiles = @(Get-NetConnectionProfile | Select-Object Name, InterfaceAlias, @{n="NetworkCategory";e={[string]$_.NetworkCategory}})',
    '$rules = @(Get-NetFirewallRule -Direction Inbound -Enabled True | Where-Object { $_.DisplayName -like "*node*" -or $_.DisplayName -like "*game-to-tv*" } | ForEach-Object {',
    '  $pf = $_ | Get-NetFirewallPortFilter; $af = $_ | Get-NetFirewallAddressFilter; $app = $_ | Get-NetFirewallApplicationFilter',
    '  [pscustomobject]@{ Name = $_.Name; DisplayName = $_.DisplayName; Action = [string]$_.Action; Profile = [string]$_.Profile;',
    '    Protocol = [string]$pf.Protocol; LocalPort = [string]($pf.LocalPort -join ","); RemoteAddress = [string]($af.RemoteAddress -join ","); Program = [string]$app.Program } })',
    '$portRules = @(Get-NetFirewallPortFilter -Protocol TCP | Where-Object { $_.LocalPort -eq "' + port + '" } | Get-NetFirewallRule | Where-Object { $_.Enabled -eq "True" -and $_.Direction -eq "Inbound" } | ForEach-Object {',
    '  [pscustomobject]@{ Name = $_.Name; DisplayName = $_.DisplayName; Action = [string]$_.Action; Profile = [string]$_.Profile } })',
    '[pscustomobject]@{ profiles = $profiles; nodeRules = $rules; portRules = $portRules } | ConvertTo-Json -Depth 4 -Compress'
  ].join('\n');
}

function readWindowsFirewall(port) {
  return new Promise(function (resolve) {
    // -EncodedCommand (UTF-16LE base64) avoids any quoting problem
    const encoded = Buffer.from(psScript(port), 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, function (err, stdout) {
      if (err && !stdout) return resolve({ error: err.message });
      try { resolve(JSON.parse(String(stdout).trim() || '{}')); } catch (e) { resolve({ error: 'No se pudo leer la salida de PowerShell' }); }
    });
  });
}

function arr(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }
function hasProfile(rule, name) { return /any|todos/i.test(rule.Profile || '') || new RegExp(name, 'i').test(rule.Profile || ''); }

/**
 * Pure analysis (tested on Linux with sample data).
 * data: { profiles: [{InterfaceAlias, NetworkCategory}], nodeRules: [...], portRules: [...] }
 * Returns { problems: [string], ok: [string], commands: [string] }
 */
function analyzeFirewall(data, port) {
  port = port || 3000;
  const out = { problems: [], ok: [], commands: [] };
  const profiles = arr(data.profiles);
  const nodeRules = arr(data.nodeRules);
  const portRules = arr(data.portRules);

  const publicNets = profiles.filter(function (p) { return /public|p[uú]blic/i.test(p.NetworkCategory || ''); });
  publicNets.forEach(function (p) {
    out.problems.push('La red «' + (p.InterfaceAlias || p.Name) + '» tiene el perfil Pública: Windows bloquea las conexiones entrantes (la tele no podrá llegar al PC).');
    out.commands.push('Set-NetConnectionProfile -InterfaceAlias "' + (p.InterfaceAlias || p.Name) + '" -NetworkCategory Private');
  });
  if (profiles.length && !publicNets.length) out.ok.push('Perfil de red: ' + profiles.map(function (p) { return (p.InterfaceAlias || p.Name) + ' = ' + p.NetworkCategory; }).join(', '));

  const blocks = nodeRules.filter(function (r) { return /block|bloque/i.test(r.Action || ''); });
  if (blocks.length) {
    out.problems.push('Hay ' + blocks.length + ' regla(s) de BLOQUEO para Node.js (' + blocks.map(function (r) { return r.DisplayName + ' [' + r.Profile + ']'; }).join('; ') +
      '). Las reglas de bloqueo ganan a las de permitir.');
    out.commands.push('Get-NetFirewallRule -Direction Inbound | Where-Object { $_.DisplayName -like "*Node.js*" -and $_.Action -eq "Block" } | Remove-NetFirewallRule');
  }

  const allowPort = portRules.filter(function (r) { return /allow|permit/i.test(r.Action || '') && (hasProfile(r, 'private') || hasProfile(r, 'domain')); });
  const allowNode = nodeRules.filter(function (r) { return /allow|permit/i.test(r.Action || '') && hasProfile(r, 'private'); });
  if (allowPort.length) out.ok.push('Regla que permite el puerto ' + port + ': ' + allowPort.map(function (r) { return r.DisplayName; }).join(', '));
  else if (allowNode.length) out.ok.push('Node.js tiene permiso en redes privadas (' + allowNode.length + ' regla(s)).');
  else {
    out.problems.push('No hay ninguna regla que deje entrar al puerto ' + port + ' en redes privadas.');
  }
  if (!allowPort.length) {
    out.commands.push('New-NetFirewallRule -DisplayName "game-to-tv (TCP ' + port + ')" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ' + port + ' -RemoteAddress LocalSubnet -Profile Private');
  }
  return out;
}

module.exports = { psScript: psScript, readWindowsFirewall: readWindowsFirewall, analyzeFirewall: analyzeFirewall };
