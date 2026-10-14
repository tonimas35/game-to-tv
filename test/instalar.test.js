'use strict';
/*
 * The one-click installers in instalar/ (Windows .bat and Mac .command).
 * They only run on Windows/macOS, so here we check what would break them on
 * a family computer: line endings (CRLF for cmd.exe, LF + executable bit for
 * bash), the pinned official Node.js (version and SHA-256 in nodejs.org's
 * format), the download URLs, the narrow firewall rule and the messages.
 * With bash/shellcheck/pwsh installed (GitHub's Ubuntu runners have all
 * three) it also lints the Mac script, parses the PowerShell part of the
 * .bat and runs its firewall step with the Windows cmdlets mocked
 * (test/instalar/cortafuegos-windows.ps1).
 * The full rehearsal (download, npm install, start) is manual:
 *   bash test/instalar/simular.sh
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H_ = require('./helpers');

const check = H_.checker('Instaladores de un clic (instalar/)');
const ROOT = H_.ROOT;
const BAT = path.join(ROOT, 'instalar', 'Juegos-del-Salon-Windows.bat');
const MAC = path.join(ROOT, 'instalar', 'Juegos-del-Salon-Mac.command');
const GUIDE = path.join(ROOT, 'docs', 'guia-familia.md');
const PHOTO = 'Haz una foto de esta pantalla y envíasela a quien te pasó el archivo.';
const SHA = /^[0-9a-f]{64}$/;

function has(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return !r.error;
}

function batTests() {
  console.log('\n[Windows: Juegos-del-Salon-Windows.bat]');
  const buf = fs.readFileSync(BAT);
  const text = buf.toString('utf8');
  check(buf[0] !== 0xef && buf.slice(0, 4).toString() === '<# :', 'Empieza por «<# :» y sin BOM (cmd.exe no entiende el BOM)');
  const lone = (text.match(/[^\r]\n/g) || []).length;
  check(lone === 0 && /\r\n$/.test(text), 'Finales de línea CRLF en todas las líneas (' + (text.match(/\r\n/g) || []).length + ')');
  const header = text.slice(0, text.indexOf('\r\n#>'));
  check(header.length > 0 && /^[\x00-\x7f]*$/.test(header), 'La parte de cmd.exe es solo ASCII (con chcp 65001, cmd lee mal las tildes)');
  check(/chcp 65001/.test(header) && /set "G2T_SELF=%~f0"/.test(header) && /-ExecutionPolicy Bypass/.test(header) && /exit \/b\r\n\)/.test(header),
    'cmd.exe: consola UTF-8, ejecuta este mismo archivo como PowerShell y no lee más allá del bloque ( … )');

  const version = (/\$NodeVersion = '([^']+)'/.exec(text) || [])[1];
  check(/^22\.\d+\.\d+$/.test(version || ''), 'Node.js LTS 22 fijado con una versión exacta: ' + version);
  const shas = ['win-x64', 'win-arm64', 'win-x86'].map(function (a) { return (new RegExp("'" + a + "'\\s*=\\s*'([^']*)'").exec(text) || [])[1]; });
  check(shas.every(function (s) { return SHA.test(s || ''); }) && new Set(shas).size === 3, 'SHA-256 de los zip oficiales para x64, ARM64 y x86');
  check(/\$NodeDistUrl = 'https:\/\/nodejs\.org\/dist'/.test(text) &&
    text.indexOf("$name = 'node-v' + $NodeVersion + '-' + $arch") >= 0 &&
    text.indexOf("$url = $NodeDistUrl + '/v' + $NodeVersion + '/' + $name + '.zip'") >= 0,
  'URL de nodejs.org con su formato: https://nodejs.org/dist/v' + version + '/node-v' + version + '-win-x64.zip');
  check(text.indexOf("$RepoZipUrl  = 'https://codeload.github.com/tonimas35/game-to-tv/zip/refs/heads/main'") >= 0, 'Descarga el zip de la rama main desde GitHub');
  check(/\$Base\s+= Join-Path \(\[string\]\$env:LOCALAPPDATA\) 'game-to-tv'/.test(text) && /\$NodeDir\s+= Join-Path \$Base 'node'/.test(text) && /\$AppDir\s+= Join-Path \$Base 'app'/.test(text),
    'Todo en %LOCALAPPDATA%\\game-to-tv (node, app): sin permisos de administrador');
  check(/'install', '--omit=dev'/.test(text) && /npm-cli\.js/.test(text), 'npm install --omit=dev con el npm de ese Node (sin npm.cmd)');
  check(/Get-NetConnectionProfile/.test(text) && /'game-to-tv \(TCP 3000\)'/.test(text) && /-RemoteAddress LocalSubnet -Profile Private,Public/.test(text) &&
    /-Verb RunAs/.test(text) && /-EncodedCommand/.test(text), 'Cortafuegos: lee el perfil y crea una regla estrecha (TCP 3000, LocalSubnet, Privada+Pública) con un solo UAC');
  const elevated = text.slice(text.indexOf("$t = @'"), text.indexOf("'@", text.indexOf("$t = @'")));
  const outside = text.replace(elevated, '');
  check(/Set-NetConnectionProfile/.test(elevated) && !/Set-NetConnectionProfile|New-NetFirewallRule|Remove-NetFirewallRule/.test(outside),
    'Solo el script elevado cambia algo (perfil de red y reglas)');
  check(/Juegos del Salón\.lnk/.test(text) && /'apps', 'webos-launcher', 'largeIcon\.png'/.test(text) && fs.existsSync(path.join(ROOT, 'apps', 'webos-launcher', 'largeIcon.png')),
    'Icono «Juegos del Salón» en el escritorio, con el icono PNG de la app');
  check(/'start', '--navegador', '--sencillo'/.test(text), 'Arranca con start --navegador --sencillo');
  check(text.indexOf(PHOTO) >= 0 && /Haz una foto de esta pantalla y enviasela a quien te paso el archivo/.test(header), 'Si algo falla: «Haz una foto de esta pantalla…» (también en la parte de cmd.exe)');
  return { version: version };
}

function macTests(winVersion) {
  console.log('\n[Mac: Juegos-del-Salon-Mac.command]');
  const buf = fs.readFileSync(MAC);
  const text = buf.toString('utf8');
  check(text.indexOf('\r') < 0 && text.indexOf('#!/bin/bash\n') === 0, 'bash con finales de línea LF');
  if (process.platform !== 'win32') check((fs.statSync(MAC).mode & 0o111) !== 0, 'Es ejecutable (si no, el Mac no lo abre con doble clic)');
  const git = spawnSync('git', ['ls-files', '-s', 'instalar/Juegos-del-Salon-Mac.command'], { cwd: ROOT, encoding: 'utf8' });
  if (!git.error && git.status === 0 && git.stdout) check(/^100755 /.test(git.stdout), 'git lo guarda como ejecutable (100755)');
  const version = (/^NODE_VERSION="([^"]+)"/m.exec(text) || [])[1];
  check(version === winVersion, 'La misma versión de Node.js que en Windows (' + version + ')');
  check(SHA.test((/^NODE_SHA256_DARWIN_ARM64="([^"]*)"/m.exec(text) || [])[1] || '') && SHA.test((/^NODE_SHA256_DARWIN_X64="([^"]*)"/m.exec(text) || [])[1] || ''),
    'SHA-256 de los tar.gz oficiales para Apple Silicon e Intel');
  check(/^NODE_DIST_URL="https:\/\/nodejs\.org\/dist"$/m.test(text) && text.indexOf('local name="node-v$NODE_VERSION-$platform"') >= 0 &&
    text.indexOf('local url="$NODE_DIST_URL/v$NODE_VERSION/$name.tar.gz"') >= 0, 'URL de nodejs.org: https://nodejs.org/dist/v' + version + '/node-v' + version + '-darwin-arm64.tar.gz');
  check(/^REPO_TARBALL_URL="https:\/\/codeload\.github\.com\/tonimas35\/game-to-tv\/tar\.gz\/refs\/heads\/main"$/m.test(text), 'Descarga el tar.gz de la rama main desde GitHub');
  check(/^BASE="\$HOME\/Library\/Application Support\/game-to-tv"$/m.test(text), 'Todo en ~/Library/Application Support/game-to-tv (sin admin ni Homebrew)');
  check(/start --navegador --sencillo/.test(text) && /install --omit=dev/.test(text) && text.indexOf(PHOTO) >= 0, 'npm install, start --navegador --sencillo y «Haz una foto…»');
  check(/clic derecho/.test(text) && /Abrir igualmente/.test(text), 'Explica cómo abrirlo la primera vez (Gatekeeper)');
  if (has('bash')) {
    const r = spawnSync('bash', ['-n', MAC], { encoding: 'utf8' });
    check(r.status === 0, 'bash -n: sin errores de sintaxis' + (r.stderr ? ' ' + r.stderr : ''));
  }
  if (has('shellcheck')) {
    const r = spawnSync('shellcheck', ['-s', 'bash', MAC, path.join(ROOT, 'test', 'instalar', 'simular.sh')], { encoding: 'utf8' });
    check(r.status === 0, 'shellcheck sin avisos' + (r.stdout ? '\n' + r.stdout : ''));
  } else console.log('  (sin shellcheck: no se pasa)');
}

function pwshTests() {
  console.log('\n[PowerShell del .bat, con pwsh]');
  if (!has('pwsh')) { console.log('  (sin pwsh: no se prueba; GitHub Actions sí lo tiene)'); return; }
  const parse = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    '$t = [IO.File]::ReadAllText($env:G2T_BAT, [Text.Encoding]::UTF8); $e = $null; $k = $null; ' +
    '[void][System.Management.Automation.Language.Parser]::ParseInput($t, [ref]$k, [ref]$e); $e.Count'], { encoding: 'utf8', env: Object.assign({}, process.env, { G2T_BAT: BAT }) });
  check(parse.status === 0 && parse.stdout.trim() === '0', 'El PowerShell del .bat no tiene errores de sintaxis');
  const tmp = H_.tmpHome('g2t-fw-');
  try {
    const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', path.join(ROOT, 'test', 'instalar', 'cortafuegos-windows.ps1'), tmp], { encoding: 'utf8', timeout: 120000 });
    const oks = (r.stdout.match(/^ {2}OK {5}/mg) || []).length;
    const fails = (r.stdout.match(/^ {2}FALLO {2}.*$/mg) || []);
    check(r.status === 0 && oks >= 15 && !fails.length, 'Cortafuegos (cmdlets simulados): ' + oks + ' casos OK' + (fails.length ? '\n' + fails.join('\n') : ''));
  } finally {
    H_.rmrf(tmp);
  }
}

function repoTests() {
  console.log('\n[Repositorio y guía]');
  const ga = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
  check(/^\*\.bat -text/m.test(ga) && /^\*\.command text eol=lf/m.test(ga), '.gitattributes: el .bat se guarda tal cual (CRLF) y el .command con LF');
  const guide = fs.readFileSync(GUIDE, 'utf8');
  check(/Más información/.test(guide) && /Ejecutar de todas formas/.test(guide) && /Source/.test(guide) && /Internet/.test(guide) && /El Infiltrado/.test(guide),
    'La guía para la familia explica SmartScreen, HDMI, el navegador de la Samsung y los juegos');
  check(/guia-familia\.md/.test(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')), 'El README enlaza la guía');
  [BAT, MAC, GUIDE].forEach(function (f) {
    check(!/\bToni\b/.test(fs.readFileSync(f, 'utf8')), path.basename(f) + ': sin nombres de personas');
  });
}

(function () {
  try {
    const w = batTests();
    macTests(w.version);
    pwshTests();
    repoTests();
  } catch (e) {
    check.fail('Excepción: ' + (e && e.stack || e));
  }
  check.done();
})();
