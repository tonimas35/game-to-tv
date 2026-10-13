'use strict';
/*
 * Wrapper around LG's ares-cli (npm i -g @webos-tools/cli): ares-setup-device,
 * ares-novacom, ares-package, ares-install, ares-launch, ares-inspect.
 * game-to-tv only shells out to them when they are installed; otherwise it
 * prints the exact steps.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';

/** Absolute path of an ares command in PATH, or null. */
function which(cmd) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = IS_WIN ? String(process.env.PATHEXT || '.CMD;.EXE;.BAT').split(';').concat(['']) : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, cmd + e.toLowerCase());
      const P = path.join(d, cmd + e);
      for (const f of [p, P]) {
        try { if (fs.statSync(f).isFile()) return f; } catch (err) { /* next */ }
      }
    }
  }
  return null;
}

function available() { return !!which('ares-install') && !!which('ares-setup-device'); }

function quoteWin(a) {
  a = String(a);
  return /[\s"&|<>^]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a;
}

/**
 * Runs an ares command. Resolves { code, stdout, stderr }.
 * On Windows the .cmd shims need a shell (Node refuses to spawn .cmd directly).
 */
function run(cmd, args, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    const exe = which(cmd);
    if (!exe) return reject(Object.assign(new Error('No encuentro «' + cmd + '». Instala ares-cli: npm install -g @webos-tools/cli'), { code: 'ENOARES' }));
    const child = IS_WIN
      ? spawn(quoteWin(exe), args.map(quoteWin), { shell: true, windowsHide: true })
      : spawn(exe, args, { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', function (d) { stdout += d; if (opts.onStdout) opts.onStdout(String(d), child); });
    child.stderr.on('data', function (d) { stderr += d; });
    const t = opts.timeout ? setTimeout(function () { try { child.kill(); } catch (e) { /* noop */ } }, opts.timeout) : null;
    child.on('error', function (e) { if (t) clearTimeout(t); reject(e); });
    child.on('exit', function (code) { if (t) clearTimeout(t); resolve({ code: code, stdout: stdout, stderr: stderr }); });
    if (opts.onSpawn) opts.onSpawn(child);
  });
}

/** Device names configured in ares-setup-device. */
async function listDevices() {
  const r = await run('ares-setup-device', ['--list']);
  const names = [];
  r.stdout.split(/\r?\n/).forEach(function (l) {
    const m = /^\s*([A-Za-z0-9_.-]+)(?:\s+\(default\))?\s+\S+@[\d.:]+/.exec(l);
    if (m && m[1] !== 'name') names.push(m[1]);
  });
  return names;
}

/** Step-by-step setup text (Spanish), with the exact commands. */
function setupSteps(tv) {
  const dev = tv.aresDevice || tv.name;
  const ip = tv.ip || '192.168.1.50';
  return [
    'Para instalar apps en una tele LG hace falta el «Modo desarrollador» (gratis):',
    '',
    '  1. En el PC: npm install -g @webos-tools/cli',
    '  2. En la tele: instala la app «Developer Mode» desde LG Content Store e inicia sesión',
    '     con una cuenta de desarrollador de LG (https://webostv.developer.lge.com, gratis).',
    '  3. En la app Developer Mode: activa «Dev Mode Status» (la tele se reinicia) y luego',
    '     «Key Server». Apunta la passphrase que aparece (6 caracteres).',
    '  4. En el PC, registra la tele en ares-cli:',
    '       ares-setup-device -a ' + dev + ' -i "host=' + ip + '" -i "port=9922" -i "username=prisoner"',
    '  5. Descarga la clave (escribe la passphrase cuando la pida):',
    '       ares-novacom --device ' + dev + ' --getkey',
    '  6. Indica la clave privada y la passphrase al dispositivo (si no, ares-install falla):',
    '       ares-setup-device -m ' + dev + ' -i "privatekey=' + dev + '_webos" -i "passphrase=TU-PASSPHRASE"',
    '  7. Comprueba: ares-device --device ' + dev + ' --system-info',
    '',
    'La sesión de desarrollador dura 50 h (999 h al renovarla): ábrela de vez en cuando',
    'en la app Developer Mode y pulsa «Extend». Más detalles en docs/tele-lg.md.'
  ].join('\n');
}

module.exports = { which: which, available: available, run: run, listDevices: listDevices, setupSteps: setupSteps };
