'use strict';
/*
 * Builds the webOS launcher app from apps/webos-launcher/ with the server URL
 * baked in, ready to package as an .ipk.
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

/**
 * opts: { serverUrl, version, appId, title, outDir }
 * Returns { dir, appinfo, serverUrl }
 */
function buildApp(opts) {
  const serverUrl = normalizeServerUrl(opts.serverUrl);
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

  const html = fs.readFileSync(path.join(TEMPLATE_DIR, 'index.html'), 'utf8')
    .split("'@@SERVER_URL@@'").join(JSON.stringify(serverUrl).replace(/^"|"$/g, "'"));
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  fs.copyFileSync(path.join(TEMPLATE_DIR, 'icon.png'), path.join(dir, appinfo.icon));
  fs.copyFileSync(path.join(TEMPLATE_DIR, 'largeIcon.png'), path.join(dir, appinfo.largeIcon));
  return { dir: dir, appinfo: appinfo, serverUrl: serverUrl };
}

module.exports = { TEMPLATE_DIR: TEMPLATE_DIR, DEFAULT_APP_ID: DEFAULT_APP_ID, buildApp: buildApp, normalizeServerUrl: normalizeServerUrl, appVersion: appVersion };
