'use strict';
/*
 * «Modo tele» on Android TV / Google TV / Fire TV: the game server running
 * INSIDE the TV, in the app «Juegos del Salón» (apps/android-tv/).
 *
 * The app embeds Node.js (nodejs-mobile, Node 18) and runs this file in a
 * foreground service of its own process (`:node`). Node can only be started
 * once per process, so the process lives exactly as long as the server:
 *
 *   app opens  -> NodeService starts Node with this file (if not running yet)
 *   running    -> same server as webOS «modo tele» (core.js): port 8090,
 *                 mode 'tele', gallery and records in the app's files dir,
 *                 QR with the TV's IP as Java sees it (ConnectivityManager)
 *   idle       -> no TV page and no players for 15 min (the app unloads its
 *                 WebView when it leaves the foreground, so the TV page
 *                 counts only while the app is visible): the server closes
 *                 and this process kills itself (SIGKILL, like Android's
 *                 Process.killProcess). The next launch starts a new one.
 *
 * Arguments (from NodeService.java):
 *   --host-ip IP        the TV's LAN IPv4 (os.networkInterfaces() is not
 *                       reliable on Android, so Java passes it)
 *   --data-dir DIR      writable folder (app files dir): galeria/, records,
 *                       ambiente/ and estado.json
 *   --tmp-dir DIR       the app's cache dir (os.tmpdir() has no /tmp on Android)
 *   --port 8090  --idle-min 15  --players 6
 *   --app-version V  --app-code N (the APK's versionName / versionCode)
 *   --sdk N  --abi ABI  --device "Philips …"  --net ethernet|wifi
 *   --bundle-source apk|descargado  where this game bundle comes from: the
 *                       APK's own assets or an automatic update (BundleStore.java)
 *
 * The bundle's own bundle.json (next to main.js, src/drivers/android/bundle.js)
 * gives the game version: /info.version is its package version and
 * /info.tele.bundle { version, build, commit, source } says which bundle runs
 * (the app checks it to accept an update, docs/tele-android.md).
 *
 * estado.json (in --data-dir) says { state: 'starting' | 'running' | 'error'
 * | 'stopped', error, pid, url } so the app can show why the server did not
 * start.
 *
 * It also runs on a PC for testing:
 *   node src/tv-service/android.js --host-ip 192.168.1.77 --data-dir /tmp/g2t-android
 * Like the rest of src/tv-service/ it stays Node 12 compatible (`npm run check`).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('./core');

const SERVICE_ID = 'io.gametotv.android';
// Root of the game bundle (assets/nodejs-project or files/bundles/<version>)
const BUNDLE_DIR = path.join(__dirname, '..', '..');
const SOURCES = ['apk', 'descargado'];

/** The bundle's bundle.json, or null (e.g. running from the repository). */
function readBundleMeta(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir || BUNDLE_DIR, 'bundle.json'), 'utf8'));
    return m && typeof m === 'object' && typeof m.version === 'string' ? m : null;
  } catch (e) {
    return null;
  }
}

/** Minimal --flag value parser (also accepts --flag=value). */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a.indexOf('--') !== 0) continue;
    const eq = a.indexOf('=');
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && String(next).indexOf('--') !== 0) { out[a.slice(2)] = String(next); i++; } else out[a.slice(2)] = true;
  }
  return out;
}

function validIp(s) {
  return typeof s === 'string' && /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) &&
    s.split('.').every(function (n) { return Number(n) <= 255; });
}

/** /info.tele.bundle: { version, build, commit, source } or null. */
function bundleInfo(meta, source) {
  if (!meta) return null;
  return {
    version: meta.version,
    build: typeof meta.build === 'number' ? meta.build : null,
    commit: typeof meta.commit === 'string' ? meta.commit.slice(0, 12) : null,
    source: SOURCES.indexOf(source) >= 0 ? source : null
  };
}

/**
 * Starts the server. deps (tests): { createServer, exit(), console, serverOptions, version, bundle }
 * Returns { tvService, ready: Promise<startResponse>, opts }.
 */
function main(argv, deps) {
  deps = deps || {};
  const a = parseArgs(argv || []);
  const dataDir = path.resolve(typeof a['data-dir'] === 'string' ? a['data-dir'] : path.join(os.tmpdir(), 'game-to-tv-android'));
  if (typeof a['tmp-dir'] === 'string') process.env.TMPDIR = a['tmp-dir'];
  // Nothing here should read ~/.game-to-tv, but if anything does, it lands in the app's folder
  if (!process.env.HOME || process.env.HOME === '/') process.env.HOME = dataDir;
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { /* reported by the gallery probe */ }

  const hostIp = validIp(a['host-ip']) ? a['host-ip'] : null;
  const meta = deps.bundle !== undefined ? deps.bundle : readBundleMeta(BUNDLE_DIR);
  const bundle = bundleInfo(meta, a['bundle-source']);
  const appVersion = typeof a['app-version'] === 'string' ? a['app-version'] : null;
  // The games' version is the bundle's (an automatic update may be newer than the APK)
  const version = deps.version || (meta && typeof meta.pkg === 'string' ? meta.pkg : null) || appVersion ||
    (function () { try { return require('../../package.json').version; } catch (e) { return '0.0.0'; } })();
  const statusFile = path.join(dataDir, 'estado.json');
  const out = deps.console === undefined ? console : deps.console;

  function writeStatus(obj) {
    try { fs.writeFileSync(statusFile, JSON.stringify(Object.assign({ pid: process.pid, at: new Date().toISOString() }, obj)) + '\n'); } catch (e) { /* read-only: never mind */ }
  }

  const exit = deps.exit || function () {
    // A plain exit() would run C++ static destructors inside an app process
    // full of ART threads; SIGKILL is what Process.killProcess() does.
    setTimeout(function () { process.kill(process.pid, 'SIGKILL'); }, 300);
  };

  writeStatus({ state: 'starting' });
  const tvService = core.createTvService({
    service: { busId: SERVICE_ID, register: function () {} },   // no luna bus on Android
    serviceId: SERVICE_ID,
    keepAlive: false,
    port: a.port,
    players: a.players,
    idleMs: a['idle-min'] != null && a['idle-min'] !== true ? Number(a['idle-min']) * 60000 : undefined,
    hostIp: hostIp || undefined,
    // Without an IP from Java (no network?) core falls back to os.networkInterfaces()
    version: version,
    serviceDir: dataDir,
    galleryCandidates: [path.join(dataDir, 'galeria'), path.join(os.tmpdir(), 'game-to-tv', 'galeria')],
    createServer: deps.createServer,
    serverOptions: deps.serverOptions,
    console: out,
    extraInfo: function () {
      return {
        platform: 'android',
        sdk: a.sdk ? Number(a.sdk) : null,
        abi: typeof a.abi === 'string' ? a.abi : process.arch,
        device: typeof a.device === 'string' ? a.device : null,
        net: typeof a.net === 'string' ? a.net : null,
        app: appVersion ? { version: appVersion, code: a['app-code'] ? Number(a['app-code']) : null } : null,
        bundle: bundle,
        pid: process.pid,
        rssMB: Math.round(process.memoryUsage().rss / 1048576)
      };
    },
    onStop: function (r) {
      writeStatus({ state: 'stopped', reason: r.reason });
      if (r.reason === 'inactividad') {
        tvService.log('Fin del proceso :node (se arranca otro al abrir la app)');
        exit();
      }
    }
  });
  if (bundle) tvService.log('Juegos ' + bundle.version + (bundle.source ? ' (' + bundle.source + ')' : '') + (appVersion ? ', app ' + appVersion : ''));
  if (!hostIp) tvService.log('Sin --host-ip válida (' + (a['host-ip'] || 'ninguna') + '): se busca la IP con os.networkInterfaces()');

  const ready = tvService.start().then(function (r) {
    if (r && r.returnValue !== false) writeStatus({ state: 'running', url: r.url, ip: r.ip, port: r.port, version: r.version, bundle: bundle ? bundle.version : null });
    else writeStatus({ state: 'error', error: r && r.errorText, code: r && r.errorCode });
    return r;
  });
  return { tvService: tvService, ready: ready, opts: a, dataDir: dataDir, statusFile: statusFile };
}

/** Entry point of the app (main.js of the bundle) and of `node android.js …`. */
function run(argv) {
  const app = main(argv);
  process.on('uncaughtException', function (e) {
    // Never let a bug in a game take the whole server down
    app.tvService.log('Error no capturado: ' + (e && e.stack || e));
  });
  app.ready.then(function (r) {
    if (!r || r.returnValue === false) {
      // The error stays in estado.json and in the log, and the app shows it.
      // The process stays (Node only starts once per process): the app kills
      // it and starts a new one on the next launch.
      app.tvService.log('No arrancó: ' + (r && r.errorText));
    }
  });
  return app;
}

module.exports = { main: main, run: run, parseArgs: parseArgs, validIp: validIp, readBundleMeta: readBundleMeta, bundleInfo: bundleInfo, SERVICE_ID: SERVICE_ID };

if (require.main === module) run(process.argv.slice(2));
