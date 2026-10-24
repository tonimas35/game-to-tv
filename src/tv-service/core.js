'use strict';
/*
 * «Modo tele»: the game server running INSIDE the LG TV, as a webOS JS
 * service of the launcher app (<appId>.service).
 *
 * This is the testable core. The entry point that webOS runs is
 * src/tv-service/service.js (it only passes the real `webos-service` module,
 * which the TV provides and must never be bundled).
 *
 * Luna methods (called from the app with PalmServiceBridge):
 *   start      boots the hub server on 0.0.0.0:<port> (8090) with HOST_IP =
 *              the TV's LAN IPv4. Idempotent. -> { returnValue, port, ip, url, version }
 *   status     -> { returnValue, running, port, ip, url, version, node, uptime,
 *                   galleryDir, gallerySaving, idle..., activity }
 *   heartbeat  subscription: answers now and every 5 s ({ subscribe: true })
 *   stop       closes the server and completes the keepAlive activity
 *   logs       -> { returnValue, lines: [...] } (ring buffer, for debugging)
 *
 * Lifetime (measured on a webOS 22 TV): a JS service is killed a few seconds
 * after its last request unless it holds an activity. `start` creates the
 * «keepAlive» activity; with it (plus the app's heartbeat subscription) the
 * server stayed up for more than 6 minutes, also with the app closed.
 * Idle shutdown: when no TV page, no player and no heartbeat subscription
 * has been around for `idleMs` (15 min), the server closes and the activity
 * is completed so webOS can reap the process.
 *
 * Everything here must run on Node 12 (the TV has v12.21.0): no ?. / ??,
 * no class fields, no fs.rm, no fetch... `npm run check` verifies it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 8090;           // 3000/3001 are LG's own SSAP (second screen) service
const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const DEFAULT_PLAYERS = 6;            // player slots (2 to 8), like `game-to-tv start`
const HEARTBEAT_MS = 5000;
const LOG_LINES = 300;

// ---------------------------------------------------------------- IP of the TV
/**
 * The TV's LAN IPv4. Wired first (eth0), then Wi-Fi (wlan0), then other
 * physical-looking interfaces. Never loopback, link-local (169.254), Wi-Fi
 * Direct (p2p*) or virtual bridges. `ifaces` is os.networkInterfaces().
 */
function pickTvIp(ifaces) {
  const list = [];
  Object.keys(ifaces || {}).forEach(function (name) {
    (ifaces[name] || []).forEach(function (a) {
      const fam = a.family === 4 ? 'IPv4' : a.family;
      if (fam !== 'IPv4' || a.internal) return;
      if (/^127\./.test(a.address) || /^169\.254\./.test(a.address)) return;
      list.push({ name: name, address: a.address });
    });
  });
  function score(c) {
    let s = 0;
    if (c.name === 'eth0') s += 300;
    else if (c.name === 'wlan0') s += 250;
    else if (/^(eth|en)\d/.test(c.name)) s += 200;
    else if (/^(wlan|wl)/.test(c.name)) s += 150;
    if (/^(p2p|docker|br-|veth|virbr|tun|tap|usb|rndis|lxc)/.test(c.name)) s -= 500;
    if (/^192\.168\./.test(c.address)) s += 30;
    else if (/^10\./.test(c.address)) s += 20;
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(c.address)) s += 10;
    return s;
  }
  list.sort(function (a, b) { return score(b) - score(a); });
  return list.length && score(list[0]) > -100 ? list[0].address : null;
}

// ---------------------------------------------------------------- gallery folder
/**
 * Where the drawings can be saved on the TV. The writable places of a
 * Developer Mode JS service are not documented, so we probe: the first
 * candidate where we can create a folder and write a file wins.
 * Returns { dir, tried: [{ dir, ok, error }] }; dir is null if none works.
 */
function probeGalleryDir(candidates, fsi) {
  fsi = fsi || fs;
  const tried = [];
  for (let i = 0; i < candidates.length; i++) {
    const dir = candidates[i];
    if (!dir) continue;
    try {
      fsi.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.g2t-probe-' + process.pid + '-' + i);
      fsi.writeFileSync(probe, 'ok');
      fsi.unlinkSync(probe);
      tried.push({ dir: dir, ok: true });
      return { dir: dir, tried: tried };
    } catch (e) {
      tried.push({ dir: dir, ok: false, error: e.code || e.message });
    }
  }
  return { dir: null, tried: tried };
}

/** Candidate gallery folders, most persistent first. */
function galleryCandidates(env, serviceDir) {
  env = env || process.env;
  const out = [];
  if (env.GALERIA_DIR) out.push(path.resolve(env.GALERIA_DIR));
  if (env.HOME && env.HOME !== '/') out.push(path.join(env.HOME, '.game-to-tv', 'galeria'));
  out.push('/media/developer/temp/game-to-tv/galeria');   // survives app updates
  if (serviceDir) out.push(path.join(serviceDir, 'datos', 'galeria'));  // lost when the app is reinstalled
  out.push(path.join(os.tmpdir(), 'game-to-tv', 'galeria'));            // usually RAM: lost on reboot
  return out;
}

// ---------------------------------------------------------------- the service
/**
 * deps:
 *   Service        the webos-service constructor (or `service`: an instance)
 *   serviceId      e.g. 'io.gametotv.launcher.service'
 *   createServer   default: require('../server').createServer
 *   port           default 8090 (G2T_PORT)
 *   players        player slots, default 6 (G2T_JUGADORES), 2 to 8
 *   idleMs         default 15 min (G2T_IDLE_MIN); 0 = never
 *   heartbeatMs    default 5000
 *   idleCheckMs    how often idleness is checked (default min(30 s, idleMs / 4))
 *   hostIp         forced IP (HOST_IP); otherwise pickTvIp()
 *   networkInterfaces, galleryCandidates, fs, env, version, serviceDir,
 *   serverOptions  extra options for createServer (tests: gamesDirs, slotHoldMs…)
 *   console        where log lines are also written (default: console)
 *   keepAlive      false = no webOS keepAlive activity (Android: the app's
 *                  foreground service keeps the process alive instead)
 *   onStop(r)      called after every stop with { reason, wasRunning }
 *                  (Android: the idle shutdown ends the whole process)
 *   extraInfo()    extra fields for `status` and /info `tele` (Android: platform, sdk, abi…)
 */
function createTvService(deps) {
  deps = deps || {};
  const env = deps.env || process.env;
  const service = deps.service || new deps.Service(deps.serviceId);
  const serviceId = deps.serviceId || (service && service.busId) || 'io.gametotv.launcher.service';
  const port = deps.port != null && deps.port !== '' ? Number(deps.port) : Number(env.G2T_PORT || DEFAULT_PORT);
  const idleMs = deps.idleMs != null ? Number(deps.idleMs)
    : (env.G2T_IDLE_MIN != null && env.G2T_IDLE_MIN !== '' ? Number(env.G2T_IDLE_MIN) * 60000 : DEFAULT_IDLE_MS);
  const rawPlayers = deps.players != null && deps.players !== '' ? deps.players : env.G2T_JUGADORES;
  const players = Math.max(2, Math.min(8, parseInt(rawPlayers, 10) || DEFAULT_PLAYERS));
  const heartbeatMs = deps.heartbeatMs || HEARTBEAT_MS;
  const idleCheckMs = deps.idleCheckMs || Math.max(50, Math.min(30000, Math.floor((idleMs || 60000) / 4)));
  const netIfaces = deps.networkInterfaces || function () { return os.networkInterfaces(); };
  const version = deps.version || '0.0.0';
  const out = deps.console === undefined ? console : deps.console;
  const startedAt = Date.now();

  // ------------------------------------------------------------ logs (ring buffer)
  const lines = [];
  function log(s) {
    const line = new Date().toISOString().slice(11, 19) + ' ' + String(s);
    lines.push(line);
    if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES);
    if (out && out.log) { try { out.log('[g2t] ' + s); } catch (e) { /* noop */ } }
  }

  // ------------------------------------------------------------ state
  const st = {
    srv: null,            // createServer() result while running
    starting: null,       // Promise while starting
    ip: null,
    keep: null,           // keepAlive activity
    lastActive: Date.now(),
    idleTimer: null,
    gallery: null,        // { dir, tried }
    subs: [],             // heartbeat subscriptions: { msg, timer }
    stoppedReason: null,
    lastError: null
  };

  function detectIp() {
    const forced = deps.hostIp || env.HOST_IP;
    if (forced) return String(forced).trim();
    let ifs = {};
    try { ifs = netIfaces(); } catch (e) { log('No se pudieron leer las interfaces de red: ' + e.message); }
    return pickTvIp(ifs) || '127.0.0.1';
  }

  function chooseGallery() {
    if (st.gallery) return st.gallery;
    const cands = deps.galleryCandidates || galleryCandidates(env, deps.serviceDir);
    st.gallery = probeGalleryDir(cands, deps.fs);
    if (st.gallery.dir) log('Galería de dibujos en ' + st.gallery.dir);
    else log('Ninguna carpeta con permiso de escritura: los dibujos no se guardarán (' + st.gallery.tried.map(function (t) { return t.dir + ': ' + t.error; }).join('; ') + ')');
    return st.gallery;
  }

  function url() { return st.srv ? 'http://' + st.ip + ':' + st.srv.port() + '/' : null; }

  function activity() {
    const a = st.srv ? st.srv.activity() : { tvs: 0, players: 0, connected: 0 };
    return { tvs: a.tvs, players: a.players, connected: a.connected, subscriptions: st.subs.length };
  }
  function isActive(a) { return a.tvs > 0 || a.players > 0 || a.subscriptions > 0; }

  // ------------------------------------------------------------ keepAlive activity
  function acquireKeepAlive() {
    if (st.keep || deps.keepAlive === false) return;
    const am = service.activityManager;
    if (!am || typeof am.create !== 'function') { log('Sin activityManager: webOS podría cerrar el servicio por inactividad'); return; }
    st.keep = { pending: true };
    try {
      am.create('keepAlive', function (activity) {
        if (st.keep && st.keep.pending) { st.keep = activity || { fake: true }; log('Actividad keepAlive creada'); }
        else releaseActivity(activity);  // stopped before it arrived
      });
    } catch (e) {
      st.keep = null;
      log('No se pudo crear la actividad keepAlive: ' + e.message);
    }
  }
  function releaseActivity(activity) {
    const am = service.activityManager;
    if (!activity || activity.pending || !am || typeof am.complete !== 'function') return;
    try { am.complete(activity, function () { log('Actividad keepAlive completada'); }); } catch (e) { log('No se pudo completar keepAlive: ' + e.message); }
  }
  function releaseKeepAlive() {
    const k = st.keep;
    st.keep = null;
    if (k && !k.pending) releaseActivity(k);
  }

  // ------------------------------------------------------------ idle shutdown
  function armIdle() {
    clearInterval(st.idleTimer);
    st.idleTimer = null;
    st.lastActive = Date.now();
    if (!(idleMs > 0)) return;
    st.idleTimer = setInterval(function () {
      if (!st.srv) return;
      const a = activity();
      if (isActive(a)) { st.lastActive = Date.now(); return; }
      if (Date.now() - st.lastActive >= idleMs) {
        log('Sin tele ni jugadores durante ' + Math.round(idleMs / 60000 * 10) / 10 + ' min: se apaga el servidor');
        stop('inactividad');
      }
    }, idleCheckMs);
  }

  // ------------------------------------------------------------ start / stop
  function startServer() {
    const ip = detectIp();
    const gallery = chooseGallery();
    const createServer = deps.createServer || require('../server').createServer;
    const opts = Object.assign({
      mode: 'tele',
      version: version,
      port: port,
      hostIp: ip,
      maxPlayers: players,
      galleryDir: gallery.dir ? gallery.dir : null,
      // Next to the gallery (…/game-to-tv): small data such as the «2048» records.
      // Without a writable folder they live in memory only
      dataDir: gallery.dir ? path.dirname(gallery.dir) : null,
      // Next to the gallery (…/game-to-tv/ambiente): photos can be copied there by hand
      ambientDir: path.join(gallery.dir ? path.dirname(gallery.dir) : path.join(os.tmpdir(), 'game-to-tv'), 'ambiente'),
      config: { version: 1, tvs: {}, timezone: env.TZ_AMBIENTE || 'Europe/Madrid', port: port },
      log: log,
      tele: { service: serviceId, info: teleInfo, logs: function () { return lines.join('\n') + '\n'; } }
    }, deps.serverOptions || {});
    const srv = createServer(opts);
    return srv.listen().then(function () {
      st.srv = srv;
      st.ip = ip;
      st.stoppedReason = null;
      st.lastError = null;
      log('Servidor listo en ' + url() + ' (Node ' + process.version + ', game-to-tv ' + version + ')');
      armIdle();
      return srv;
    }, function (e) {
      try { srv.close(); } catch (err) { /* noop */ }
      throw e;
    });
  }

  function errorText(e) {
    if (e && e.code === 'EADDRINUSE') return 'El puerto ' + port + ' de la tele está ocupado por otra app.';
    if (e && e.code === 'EACCES') return 'La tele no deja usar el puerto ' + port + '.';
    return 'No se pudo arrancar el servidor: ' + (e && e.message || e);
  }

  /** Idempotent. Resolves with the start response (returnValue false on error). */
  function start() {
    acquireKeepAlive();
    if (st.starting) return st.starting;
    if (st.srv) {
      // The TV may have a new address (DHCP) since the server started: the QR must follow it
      const ip = detectIp();
      if (ip === st.ip || ip === '127.0.0.1') { st.lastActive = Date.now(); return Promise.resolve(startResponse()); }
      log('La IP de la tele ha cambiado (' + st.ip + ' -> ' + ip + '): reiniciando el servidor');
      st.starting = closeServer().then(doStart);
      return st.starting;
    }
    st.starting = doStart();
    return st.starting;
  }
  function doStart() {
    return startServer().then(function () {
      st.starting = null;
      return startResponse();
    }, function (e) {
      st.starting = null;
      st.lastError = errorText(e);
      log(st.lastError);
      releaseKeepAlive();
      return { returnValue: false, errorCode: e && e.code || 'ESTART', errorText: st.lastError, port: port, version: version };
    });
  }
  function startResponse() {
    return { returnValue: true, running: true, port: st.srv.port(), ip: st.ip, url: url(), version: version, gallerySaving: !!(st.gallery && st.gallery.dir) };
  }

  function closeServer() {
    clearInterval(st.idleTimer);
    st.idleTimer = null;
    const srv = st.srv;
    st.srv = null;
    return srv ? srv.close() : Promise.resolve();
  }

  /** Closes the server, ends the subscriptions and lets webOS reap the process. */
  function stop(reason) {
    st.stoppedReason = reason || 'stop';
    const wasRunning = !!st.srv;
    return closeServer().then(function () {
      st.subs.slice().forEach(function (s) {
        clearInterval(s.timer);
        try { s.msg.respond({ returnValue: true, running: false, stopped: true, reason: st.stoppedReason }); } catch (e) { /* noop */ }
      });
      st.subs = [];
      releaseKeepAlive();
      if (wasRunning) log('Servidor parado (' + st.stoppedReason + ')');
      const r = { returnValue: true, stopped: true, wasRunning: wasRunning, reason: st.stoppedReason };
      if (deps.onStop) { try { deps.onStop(r); } catch (e) { log('onStop: ' + e.message); } }
      return r;
    });
  }

  function teleInfo() {
    const g = st.gallery || { dir: null, tried: [] };
    const a = activity();
    let extra = {};
    if (deps.extraInfo) { try { extra = deps.extraInfo() || {}; } catch (e) { extra = { extraError: e.message }; } }
    return Object.assign({
      node: process.version,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      galleryDir: g.dir,
      gallerySaving: !!g.dir,
      galleryTried: g.tried,
      idleMinutes: idleMs / 60000,
      players: players,
      idleFor: isActive(a) ? 0 : Math.round((Date.now() - st.lastActive) / 1000),
      subscriptions: st.subs.length,
      keepAlive: !!st.keep
    }, extra);
  }

  function status() {
    const r = Object.assign({
      returnValue: true,
      running: !!st.srv,
      starting: !!st.starting,
      port: st.srv ? st.srv.port() : port,
      ip: st.ip || detectIp(),
      url: url(),
      version: version,
      service: serviceId,
      activity: activity(),
      stoppedReason: st.stoppedReason,
      lastError: st.lastError
    }, teleInfo());
    return r;
  }

  function beat() {
    const a = activity();
    return { returnValue: true, running: !!st.srv, alive: Math.round((Date.now() - startedAt) / 1000), port: st.srv ? st.srv.port() : port, ip: st.ip, tvs: a.tvs, players: a.players };
  }

  // ------------------------------------------------------------ luna registration
  function safeRespond(msg, payload) {
    try { msg.respond(payload); } catch (e) { log('No se pudo responder: ' + e.message); }
  }

  service.register('start', function (msg) {
    start().then(function (r) { safeRespond(msg, r); });
  });
  service.register('status', function (msg) { safeRespond(msg, status()); });
  service.register('logs', function (msg) {
    const n = msg.payload && msg.payload.lines > 0 ? Math.min(LOG_LINES, Number(msg.payload.lines)) : LOG_LINES;
    safeRespond(msg, { returnValue: true, lines: lines.slice(-n) });
  });
  service.register('stop', function (msg) {
    stop('stop').then(function (r) { safeRespond(msg, r); });
  });
  service.register('heartbeat', function (msg) {
    safeRespond(msg, Object.assign(beat(), { subscribed: !!msg.isSubscription }));
    if (!msg.isSubscription) return;
    const sub = { msg: msg, timer: null };
    sub.timer = setInterval(function () {
      try { msg.respond(beat()); } catch (e) { removeSub(msg); }
    }, heartbeatMs);
    st.subs.push(sub);
    st.lastActive = Date.now();
  }, function (msg) {
    removeSub(msg);
  });
  function removeSub(msg) {
    st.subs = st.subs.filter(function (s) {
      const same = s.msg === msg || (msg && s.msg.uniqueToken && s.msg.uniqueToken === msg.uniqueToken);
      if (same) clearInterval(s.timer);
      return !same;
    });
    st.lastActive = Date.now();
  }

  log((deps.keepAlive === false ? 'Servidor ' : 'Servicio ') + serviceId + ' cargado (Node ' + process.version + ', puerto ' + port + ', apagado tras ' + (idleMs > 0 ? idleMs / 60000 + ' min' : 'nunca') + ' sin uso)');

  return {
    service: service,
    start: start,
    stop: stop,
    status: status,
    logs: function () { return lines.slice(); },
    log: log,
    detectIp: detectIp,
    _state: st
  };
}

module.exports = {
  DEFAULT_PORT: DEFAULT_PORT,
  DEFAULT_IDLE_MS: DEFAULT_IDLE_MS,
  DEFAULT_PLAYERS: DEFAULT_PLAYERS,
  createTvService: createTvService,
  pickTvIp: pickTvIp,
  probeGalleryDir: probeGalleryDir,
  galleryCandidates: galleryCandidates
};
