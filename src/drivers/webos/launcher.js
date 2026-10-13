'use strict';
/*
 * Builds the webOS launcher app from apps/webos-launcher/, ready to package
 * as an .ipk, in one of two modes:
 *   tele  (default) the app starts its own JS service (<appId>.service), which
 *         runs the game server inside the TV on port 8090, and opens
 *         http://127.0.0.1:8090/. An optional PC server URL is offered as a
 *         fallback if the service fails.
 *   pc    the app waits for the server on a PC (URL baked in) and opens it.
 *
 * Lessons from a real LG webOS 22 TV encoded here:
 *  - The launcher only polls the server and then navigates to it (the
 *    built-in browser got stuck on pages that failed to load).
 *  - When an installed app is updated, the TV launcher keeps the cached icon:
 *    the icon file names carry the version (icon-0.1.0.png) so a new version
 *    shows the new icon.
 *  - appinfo.json: disableBackHistoryAPI so «Back» (keyCode 461) reaches the
 *    page; requiredACG: [] because ACG becomes mandatory with webOS TV 27.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEMPLATE_DIR = path.join(__dirname, '..', '..', '..', 'apps', 'webos-launcher');
const DEFAULT_APP_ID = 'io.gametotv.launcher';
const DEFAULT_TELE_PORT = 8090;      // 3000/3001 belong to LG's SSAP service

function serviceIdOf(appId) { return (appId || DEFAULT_APP_ID) + '.service'; }

function validPort(p) {
  const n = Number(p);
  if (!(n >= 1024 && n < 65536) || Math.floor(n) !== n) throw new Error('Puerto no válido para la tele: «' + p + '» (usa uno entre 1024 y 65535, distinto de 3000 y 3001)');
  if (n === 3000 || n === 3001) throw new Error('Los puertos 3000 y 3001 de la tele los usa LG (SSAP): elige otro, p. ej. 8090');
  return n;
}

function normalizeServerUrl(u) {
  let s = String(u || '').trim();
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  let parsed;
  try { parsed = new URL(s); } catch (e) { throw new Error('URL del servidor no válida: «' + u + '»'); }
  if (!parsed.hostname) throw new Error('URL del servidor no válida: «' + u + '»');
  return parsed.protocol + '//' + parsed.host;
}

// webOS wants x.y.z with numbers only
function appVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? m[1] + '.' + m[2] + '.' + m[3] : '1.0.0';
}

// A single-quoted JS string literal
function jsString(s) { return "'" + JSON.stringify(String(s)).slice(1, -1).replace(/'/g, "\\'").replace(/</g, '\\u003c') + "'"; }

/**
 * opts: { mode ('tele' | 'pc'), serverUrl (pc: required; tele: optional fallback),
 *         port (tele, 8090), version, appId, title, outDir }
 * Returns { dir, appinfo, serverUrl, mode, port, serviceId }
 */
function buildApp(opts) {
  const mode = opts.mode === 'pc' ? 'pc' : 'tele';
  const serverUrl = mode === 'pc' || opts.serverUrl ? normalizeServerUrl(opts.serverUrl) : '';
  const port = mode === 'tele' ? validPort(opts.port || DEFAULT_TELE_PORT) : null;
  const version = appVersion(opts.version || require('../../../package.json').version);
  const dir = opts.outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'g2t-webos-app-'));
  fs.mkdirSync(dir, { recursive: true });

  const appinfo = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'appinfo.json'), 'utf8'));
  appinfo.id = opts.appId || appinfo.id || DEFAULT_APP_ID;
  appinfo.version = version;
  if (opts.title) appinfo.title = opts.title;
  appinfo.icon = 'icon-' + version + '.png';
  appinfo.largeIcon = 'largeIcon-' + version + '.png';
  if (!Array.isArray(appinfo.requiredACG)) appinfo.requiredACG = [];
  appinfo.disableBackHistoryAPI = true;
  fs.writeFileSync(path.join(dir, 'appinfo.json'), JSON.stringify(appinfo, null, 2) + '\n');

  const serviceId = serviceIdOf(appinfo.id);
  const html = fs.readFileSync(path.join(TEMPLATE_DIR, 'index.html'), 'utf8')
    .split("'@@MODE@@'").join(jsString(mode))
    .split("'@@SERVER_URL@@'").join(jsString(serverUrl))
    .split("'@@SERVICE_ID@@'").join(jsString(serviceId))
    .split("'@@PORT@@'").join(jsString(port || ''));
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  fs.copyFileSync(path.join(TEMPLATE_DIR, 'icon.png'), path.join(dir, appinfo.icon));
  fs.copyFileSync(path.join(TEMPLATE_DIR, 'largeIcon.png'), path.join(dir, appinfo.largeIcon));
  return { dir: dir, appinfo: appinfo, serverUrl: serverUrl, mode: mode, port: port, serviceId: serviceId };
}

module.exports = {
  TEMPLATE_DIR: TEMPLATE_DIR, DEFAULT_APP_ID: DEFAULT_APP_ID, DEFAULT_TELE_PORT: DEFAULT_TELE_PORT,
  buildApp: buildApp, normalizeServerUrl: normalizeServerUrl, appVersion: appVersion, serviceIdOf: serviceIdOf, validPort: validPort
};
