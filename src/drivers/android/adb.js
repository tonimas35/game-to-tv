'use strict';
/*
 * Thin wrapper around Android's `adb` (platform-tools) for the «android»
 * driver (Android TV, Google TV, Fire TV).
 *
 * Where adb comes from, in order:
 *   GAME_TO_TV_ADB (full path), adb in the PATH, $ANDROID_HOME or
 *   $ANDROID_SDK_ROOT/platform-tools, ~/.game-to-tv/platform-tools, and the
 *   usual Android SDK folders (%LOCALAPPDATA%\Android\Sdk, ~/Library/Android/sdk,
 *   ~/Android/Sdk).
 *
 * adb is always spawned directly, NEVER through a shell. And the adb server
 * (daemon) is started first, detached and with no pipes (`adb start-server`):
 * when a normal adb command has to start the daemon itself, the daemon
 * inherits that command's stdout/stderr and whoever waits for them to close
 * waits forever (seen with the owner's PowerShell tool on Windows).
 * For the same reason run() resolves on the process 'exit', not only on
 * 'close'.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'adb.exe' : 'adb';

function isFile(f) { try { return fs.statSync(f).isFile(); } catch (e) { return false; } }

/** Every place where adb may be, in order (some may not exist). */
function candidates(env) {
  env = env || process.env;
  const out = [];
  if (env.GAME_TO_TV_ADB) out.push(path.resolve(env.GAME_TO_TV_ADB));
  String(env.PATH || '').split(path.delimiter).filter(Boolean).forEach(function (d) { out.push(path.join(d, EXE)); });
  ['ANDROID_HOME', 'ANDROID_SDK_ROOT'].forEach(function (k) { if (env[k]) out.push(path.join(env[k], 'platform-tools', EXE)); });
  const home = env.GAME_TO_TV_HOME ? path.resolve(env.GAME_TO_TV_HOME) : path.join(os.homedir(), '.game-to-tv');
  out.push(path.join(home, 'platform-tools', EXE));
  if (IS_WIN && env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', EXE));
  if (process.platform === 'darwin') out.push(path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', EXE));
  if (process.platform === 'linux') out.push(path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', EXE));
  return out;
}

/** Absolute path of adb, or null. */
function find(env) {
  const c = candidates(env);
  for (let i = 0; i < c.length; i++) if (isFile(c[i])) return c[i];
  return null;
}

/** Spanish, step by step: how to get adb. */
function installHelp() {
  const home = process.env.GAME_TO_TV_HOME ? path.resolve(process.env.GAME_TO_TV_HOME) : path.join(os.homedir(), '.game-to-tv');
  return [
    'No encuentro «adb» (Android platform-tools). Para instalarlo:',
    '',
    '  1. Descarga «SDK Platform-Tools» de https://developer.android.com/tools/releases/platform-tools',
    '     (Windows, Mac o Linux; es un zip, no hace falta Android Studio).',
    '  2. Descomprímelo de modo que quede ' + path.join(home, 'platform-tools', EXE),
    '     o añade su carpeta al PATH, o indica la ruta con la variable GAME_TO_TV_ADB.',
    IS_WIN ? '     (También vale: winget install Google.PlatformTools)' : (process.platform === 'darwin' ? '     (También vale: brew install android-platform-tools)' : '     (También vale: sudo apt install adb)'),
    '  3. Comprueba: game-to-tv doctor'
  ].join('\n');
}

let serverReady = null;

/**
 * Starts the adb server detached, with no pipes (see the header). Resolves
 * when `adb start-server` exits (it returns once the daemon answers).
 * Only once per process.
 */
function ensureServer(adb, opts) {
  opts = opts || {};
  if (serverReady && !opts.force) return serverReady;
  serverReady = new Promise(function (resolve) {
    let child;
    try {
      child = spawn(adb, ['start-server'], { stdio: 'ignore', detached: true, windowsHide: true });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    const t = setTimeout(function () { resolve({ ok: false, error: 'adb start-server no termina' }); }, opts.timeout || 20000);
    child.on('error', function (e) { clearTimeout(t); resolve({ ok: false, error: e.message }); });
    child.on('exit', function (code) { clearTimeout(t); resolve({ ok: code === 0, code: code }); });
    child.unref();
  });
  return serverReady;
}

/**
 * Runs adb with args (no shell). Resolves { code, stdout, stderr, out }
 * (stdout is a Buffer with opts.binary). opts: { timeout (ms, default 60 s), adb }
 */
function run(args, opts) {
  opts = opts || {};
  const adb = opts.adb || find();
  if (!adb) return Promise.reject(Object.assign(new Error(installHelp()), { code: 'ENOADB' }));
  return ensureServer(adb).then(function () {
    return new Promise(function (resolve, reject) {
      let child;
      try {
        child = spawn(adb, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (e) { return reject(e); }
      const outChunks = [], errChunks = [];
      let done = false, exitCode = null, timedOut = false;
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(t);
        const stdout = Buffer.concat(outChunks);
        const stderr = Buffer.concat(errChunks).toString('utf8');
        const so = opts.binary ? stdout : stdout.toString('utf8');
        resolve({ code: timedOut ? 'ETIMEDOUT' : exitCode, stdout: so, stderr: stderr, out: (opts.binary ? '' : so) + stderr, timedOut: timedOut });
      }
      child.stdout.on('data', function (d) { outChunks.push(d); });
      child.stderr.on('data', function (d) { errChunks.push(d); });
      const t = setTimeout(function () { timedOut = true; try { child.kill(); } catch (e) { /* noop */ } setTimeout(finish, 500); }, opts.timeout || 60000);
      child.on('error', function (e) { if (done) return; done = true; clearTimeout(t); reject(e); });
      // 'close' waits for the pipes; if something (a daemon) keeps them open, 'exit' is enough
      child.on('exit', function (code) { exitCode = code; setTimeout(finish, 1000); });
      child.on('close', function (code) { if (exitCode === null) exitCode = code; finish(); });
    });
  });
}

/** `adb connect host:port` -> { ok, already, unauthorized, text } */
async function connect(serial, opts) {
  const r = await run(['connect', serial], Object.assign({ timeout: 20000 }, opts));
  const text = (r.out || '').trim();
  return {
    ok: /connected to/i.test(text) && !/unable|failed|cannot/i.test(text),
    already: /already connected/i.test(text),
    unauthorized: /unauthori[sz]ed|failed to authenticate/i.test(text),
    text: text
  };
}

/** `adb -s serial get-state` -> 'device' | 'unauthorized' | 'offline' | 'missing' */
async function state(serial, opts) {
  const r = await run(['-s', serial, 'get-state'], Object.assign({ timeout: 15000 }, opts));
  const s = (r.stdout || '').trim();
  if (r.code === 0 && s) return s.split(/\s+/)[0];
  if (/unauthori[sz]ed/i.test(r.out)) return 'unauthorized';
  if (/offline/i.test(r.out)) return 'offline';
  return 'missing';
}

/** Quotes one argument for the TV's sh (adb joins the shell arguments with spaces). */
function shQuote(a) {
  a = String(a);
  return /^[A-Za-z0-9_\-.,:\/@=+%]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\''") + "'";
}

/** `adb -s serial shell …`: each argument arrives at the TV as one word. */
function shell(serial, args, opts) {
  return run(['-s', serial, 'shell'].concat(args.map(shQuote)), opts);
}

/** Parses `getprop` output: "[key]: [value]" lines. */
function parseGetprop(text) {
  const out = {};
  String(text || '').split(/\r?\n/).forEach(function (l) {
    const m = /^\[([^\]]+)\]:\s*\[(.*)\]\s*$/.exec(l);
    if (m) out[m[1]] = m[2];
  });
  return out;
}

module.exports = {
  IS_WIN: IS_WIN, candidates: candidates, find: find, installHelp: installHelp, ensureServer: ensureServer,
  run: run, connect: connect, state: state, shell: shell, shQuote: shQuote, parseGetprop: parseGetprop,
  _reset: function () { serverReady = null; }
};
