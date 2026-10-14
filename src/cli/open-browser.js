'use strict';
/*
 * `game-to-tv start --navegador`: opens the TV page in THIS computer's
 * browser, full screen. Meant for a laptop connected to the TV by HDMI (the
 * one-click installers in instalar/ use it).
 *
 * With Chrome or Edge we open a separate app-mode window (--app) in full
 * screen, with its own profile folder: that way the flags work even if the
 * browser is already open, there are no tabs or address bar, and sounds can
 * play without a first click. We use --start-fullscreen rather than --kiosk
 * on purpose: F11 (or the X that appears at the top) gets you out, which a
 * non-technical person can manage; kiosk mode only closes with Alt+F4.
 * Without Chrome/Edge: the default browser (no automatic full screen).
 *
 * G2T_NAVEGADOR=0 disables it (the tests use it so no window ever opens).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function chromeArgs(url, profile) {
  return [
    '--app=' + url,
    '--start-fullscreen',
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required'
  ];
}

function windowsCandidates(env) {
  const out = [];
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
  roots.forEach(function (r) { out.push({ label: 'Chrome', exe: path.win32.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe') }); });
  [env['ProgramFiles(x86)'], env.ProgramFiles].filter(Boolean).forEach(function (r) {
    out.push({ label: 'Edge', exe: path.win32.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
  });
  return out;
}

function macCandidates(home) {
  return [
    { label: 'Chrome', app: '/Applications/Google Chrome.app' },
    { label: 'Chrome', app: path.posix.join(home, 'Applications', 'Google Chrome.app') },
    { label: 'Edge', app: '/Applications/Microsoft Edge.app' }
  ];
}

/**
 * Pure: which command opens `url`. Tested on any OS with a fake `exists`.
 * o: { platform, env, home, url, exists(path) -> bool }
 * Returns { cmd, args, label, fullscreen }
 */
function browserCommand(o) {
  const env = o.env || {};
  const exists = o.exists || function () { return false; };
  if (o.platform === 'win32') {
    const profile = path.win32.join(env.LOCALAPPDATA || path.win32.join(o.home || 'C:\\', 'AppData', 'Local'), 'game-to-tv', 'navegador');
    const found = windowsCandidates(env).filter(function (c) { return exists(c.exe); })[0];
    if (found) return { cmd: found.exe, args: chromeArgs(o.url, profile), label: found.label, fullscreen: true };
    return { cmd: 'explorer.exe', args: [o.url], label: 'el navegador', fullscreen: false };
  }
  if (o.platform === 'darwin') {
    const profile = path.posix.join(o.home, 'Library', 'Application Support', 'game-to-tv', 'navegador');
    const found = macCandidates(o.home).filter(function (c) { return exists(c.app); })[0];
    if (found) return { cmd: 'open', args: ['-na', found.app, '--args'].concat(chromeArgs(o.url, profile)), label: found.label, fullscreen: true };
    return { cmd: 'open', args: [o.url], label: 'el navegador', fullscreen: false };
  }
  return { cmd: 'xdg-open', args: [o.url], label: 'el navegador', fullscreen: false };
}

/**
 * Opens the URL; never throws. Resolves with { ok, label, fullscreen, skipped, error }.
 */
function openBrowser(url) {
  if (process.env.G2T_NAVEGADOR === '0') return Promise.resolve({ ok: false, skipped: true });
  const c = browserCommand({
    platform: process.platform, env: process.env, home: os.homedir(), url: url,
    exists: function (p) { try { return fs.existsSync(p); } catch (e) { return false; } }
  });
  return new Promise(function (resolve) {
    let done = false;
    function finish(r) { if (!done) { done = true; resolve(Object.assign({ label: c.label, fullscreen: c.fullscreen }, r)); } }
    let child;
    try {
      child = spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', windowsHide: false });
    } catch (e) { return finish({ ok: false, error: e.message }); }
    child.on('error', function (e) { finish({ ok: false, error: e.code === 'ENOENT' ? 'no encuentro «' + c.cmd + '»' : e.message }); });
    child.unref();
    // No 'spawn' event on Node 12: give an ENOENT a moment to show up
    setTimeout(function () { finish({ ok: true }); }, 400);
  });
}

module.exports = { browserCommand: browserCommand, openBrowser: openBrowser };
