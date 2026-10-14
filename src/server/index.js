'use strict';
/*
 * game-to-tv server: HTTP + WebSocket on ONE port (3000 by default).
 *
 *   /                 TV shell (menu + games)          public/tv.html
 *   /m                phone shell (QR target)          public/m.html
 *   /qr.svg           QR pointing at http://<LAN IP>:<port>/m
 *   /info             JSON with the URLs, mode ('pc' | 'tele') and version (debugging,
 *                     `game-to-tv tv status`, `doctor`; the webOS launcher polls /qr.svg)
 *   /logs             (tele mode only) last lines of the server log, as text
 *   /lib/*            shared browser helpers           public/lib/
 *   /games/<id>/*     client views of each game        src/games/<id>/{tv,phone}.{js,css}, icon.*
 *   /galeria          saved drawings (PNG)
 *   /ambiente         ambient mode (slideshow + clock)
 *   /ws               WebSocket
 *   /tv, /mando       old addresses, redirect to / and /m
 *
 * Every page and script is read from disk on each request (Cache-Control:
 * no-store), so editing public/ or a game's tv.js only needs a reload.
 *
 * Two modes, same code:
 *   pc    `game-to-tv start` on a PC (the default)
 *   tele  inside the LG TV, started by the webOS JS service (src/tv-service/).
 *         This file and everything it requires must run on Node 12: see
 *         scripts/check-node12.js (`npm run check`).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const { detectLanIp, listIPv4 } = require('./net');
const { createHub, DEFAULT_SLOTS } = require('./hub');
const { loadGames, publicManifests, CLIENT_FILES } = require('../games');
const ambient = require('./ambient');
const config = require('../config');

const ROOT = path.join(__dirname, '..', '..');
// In the TV bundle this is the service's own package.json (same version)
const VERSION = (function () { try { return require('../../package.json').version; } catch (e) { return '0.0.0'; } })();
const PUBLIC_DIR = path.join(ROOT, 'public');
const PAGES = { '/': 'tv.html', '/index.html': 'tv.html', '/m': 'm.html', '/m/': 'm.html', '/m.html': 'm.html' };
const REDIRECTS = { '/tv': '/', '/tv/': '/', '/tv.html': '/', '/mando': '/m', '/mando/': '/m', '/mando.html': '/m' };
const TYPES = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8', '.png': 'image/png', '.html': 'text/html; charset=utf-8' };

function send(res, status, type, body, extra) {
  const h = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
  res.writeHead(status, h);
  res.end(body);
}
function notFound(res) { send(res, 404, 'text/plain; charset=utf-8', 'No encontrado'); }

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
// JSON safe to embed inside <script>
function jsonForScript(obj) { return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }

function serveVideo(req, res, file) {
  fs.stat(file, function (err, st) {
    if (err) return notFound(res);
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'max-age=3600' };
    if (range) {
      let start = range[1] === '' ? 0 : parseInt(range[1], 10);
      let end = range[2] === '' ? st.size - 1 : Math.min(parseInt(range[2], 10), st.size - 1);
      if (range[1] === '' && range[2] !== '') { start = Math.max(0, st.size - parseInt(range[2], 10)); end = st.size - 1; }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
        return res.end();
      }
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { start: start, end: end }).pipe(res);
    } else {
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    }
  });
}

function serveGallery(res, pathname, dir) {
  if (pathname === '/galeria' || pathname === '/galeria/') {
    if (!dir) {
      // tele mode without any writable folder: drawings are only shown at the end of each match
      return send(res, 200, 'text/html; charset=utf-8',
        '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Galería · Juegos del Salón</title><style>body{margin:0;padding:16px;background:#0b0d1f;color:#fff;font-family:system-ui,sans-serif}</style></head><body>' +
        '<h1>Galería de dibujos</h1><p>Este servidor no tiene dónde guardar los dibujos. Se ven al final de cada partida en la tele.</p></body></html>');
    }
    fs.readdir(dir, function (err, files) {
      const pngs = (err ? [] : files).filter(function (f) { return /\.png$/i.test(f); }).sort().reverse();
      const items = pngs.map(function (f) {
        const u = '/galeria/' + encodeURIComponent(f);
        return '<figure><a href="' + u + '"><img loading="lazy" src="' + u + '" alt=""></a><figcaption>' + escHtml(f) + '</figcaption></figure>';
      }).join('');
      send(res, 200, 'text/html; charset=utf-8',
        '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Galería · Juegos del Salón</title><style>body{margin:0;padding:16px;background:#0b0d1f;color:#fff;font-family:system-ui,sans-serif}' +
        'h1{font-size:24px}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}' +
        'figure{margin:0;background:#161a35;border-radius:12px;padding:8px}img{width:100%;display:block;border-radius:8px;background:#fff}' +
        'figcaption{font-size:12px;opacity:.7;margin-top:6px;word-break:break-all}</style></head><body>' +
        '<h1>Galería de dibujos (' + pngs.length + ')</h1><main>' + (items || '<p>Aún no hay dibujos.</p>') + '</main></body></html>');
    });
    return;
  }
  if (!dir) return notFound(res);
  let name = '';
  try { name = decodeURIComponent(pathname.slice('/galeria/'.length)); } catch (e) { return notFound(res); }
  if (!/^[A-Za-z0-9_.-]+\.png$/.test(name) || name.indexOf('..') >= 0) return notFound(res);
  fs.readFile(path.join(dir, name), function (err, data) {
    if (err) return notFound(res);
    send(res, 200, 'image/png', data);
  });
}

/**
 * Creates (but does not start) the server.
 * options: port, hostIp, galleryDir (null in tele mode = do not save PNGs),
 *          dataDir (small persistent data such as the «2048» records; default
 *          ~/.game-to-tv, null = memory only), ambientDir, timezone, slotHoldMs, maxPlayers, gamesDirs, log,
 *          config, mode ('pc' | 'tele'), version,
 *          tele: { service, info() -> extra /info data, logs() -> text }
 */
function createServer(options) {
  options = options || {};
  const cfg = options.config || safeLoadConfig();
  const mode = options.mode === 'tele' ? 'tele' : 'pc';
  const tele = mode === 'tele' ? (options.tele || {}) : null;
  const version = options.version || VERSION;
  const port = options.port != null ? Number(options.port) : (parseInt(process.env.PORT, 10) || cfg.port || 3000);
  const hostIp = detectLanIp(options.hostIp);
  const galleryDir = options.galleryDir === null ? null : (options.galleryDir || config.galleryDir(cfg));
  const ambientDir = options.ambientDir || config.ambientDir(cfg);
  const dataDir = options.dataDir === null ? null : (options.dataDir || config.homeDir());
  const timezone = options.timezone || process.env.TZ_AMBIENTE || cfg.timezone || 'Europe/Madrid';
  const log = options.log || function (s) { console.log(s); };
  const games = loadGames(options.gamesDirs, log);

  const urls = {};
  function setUrls(p) {
    urls.base = 'http://' + hostIp + ':' + p;
    urls.tv = urls.base + '/';
    urls.phone = urls.base + '/m';
    urls.qr = urls.base + '/qr.svg';
    urls.gallery = urls.base + '/galeria';
    urls.ambient = urls.base + '/ambiente';
  }
  setUrls(port);

  let qrSvg = null;
  function makeQr() {
    qrSvg = null;
    return QRCode.toString(urls.phone, {
      type: 'svg', margin: 2, width: 600, errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' }
    }).then(function (svg) { qrSvg = svg; }).catch(function (e) { log('No se pudo generar el QR: ' + e.message); });
  }

  const manifests = publicManifests(games);
  const hub = createHub({
    games: games,
    maxPlayers: options.maxPlayers || parseInt(process.env.MAX_PLAYERS, 10) || DEFAULT_SLOTS,
    slotHoldMs: options.slotHoldMs || parseInt(process.env.SLOT_HOLD_MS, 10) || 30000,
    galleryDir: galleryDir,
    dataDir: dataDir,
    log: log,
    infoForTv: function () { return { url: urls.phone, tvUrl: urls.tv, qr: '/qr.svg' }; }
  });

  // The shells get the game list where <!--@boot--> is (before public/lib/core.js)
  // and the game scripts/styles where <!--@games--> is
  function renderShell(file, kind, cb) {
    fs.readFile(path.join(PUBLIC_DIR, file), 'utf8', function (err, html) {
      if (err) return cb(err);
      const boot = { games: manifests, slots: hub.slots, colors: hub.COLORS, mode: mode, version: version };
      if (tele && tele.service) boot.tele = { service: tele.service };
      let tags = '';
      games.list.forEach(function (g) {
        if (g.client[kind + 'Css']) tags += '<link rel="stylesheet" href="/games/' + g.id + '/' + kind + '.css">\n';
        if (g.client[kind + 'Js']) tags += '<script src="/games/' + g.id + '/' + kind + '.js"></script>\n';
      });
      cb(null, html
        .replace('<!--@boot-->', '<script>window.G2T_BOOT = ' + jsonForScript(boot) + ';</script>')
        .replace('<!--@games-->', tags));
    });
  }

  function serveFile(res, file) {
    fs.readFile(file, function (err, data) {
      if (err) return notFound(res);
      send(res, 200, TYPES[path.extname(file)] || 'application/octet-stream', data);
    });
  }

  const server = http.createServer(function (req, res) {
    let pathname = '/';
    let search = '';
    try {
      const u = new URL(req.url, 'http://x');
      pathname = u.pathname;
      search = u.search;
    } catch (e) { /* noop */ }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'text/plain; charset=utf-8', 'Método no permitido');
    }
    if (PAGES[pathname]) {
      return renderShell(PAGES[pathname], PAGES[pathname] === 'tv.html' ? 'tv' : 'phone', function (err, html) {
        if (err) return send(res, 500, 'text/plain; charset=utf-8', 'Error leyendo ' + PAGES[pathname]);
        send(res, 200, 'text/html; charset=utf-8', html);
      });
    }
    if (REDIRECTS[pathname]) {
      return send(res, 302, 'text/plain; charset=utf-8', 'Redirigiendo…', { Location: REDIRECTS[pathname] + search });
    }
    if (pathname === '/qr.svg') {
      if (!qrSvg) return send(res, 503, 'text/plain; charset=utf-8', 'QR aún no listo');
      return send(res, 200, 'image/svg+xml; charset=utf-8', qrSvg);
    }
    if (pathname === '/keepalive.mp4') return serveVideo(req, res, path.join(PUBLIC_DIR, 'keepalive.mp4'));
    if (pathname === '/info') {
      const info = {
        app: 'game-to-tv', mode: mode, version: version, ip: hostIp, port: server.address() ? server.address().port : port,
        tv: urls.tv, movil: urls.phone, qr: urls.qr, galeria: galleryDir, ambiente: urls.ambient,
        juegos: games.list.map(function (g) { return g.id; }),
        actividad: hub.counts()
      };
      if (tele) {
        let extra = {};
        try { extra = tele.info ? tele.info() : {}; } catch (e) { extra = { error: e.message }; }
        info.tele = Object.assign({ service: tele.service || null }, extra);
      }
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(info));
    }
    if (pathname === '/logs' && tele && tele.logs) {
      return send(res, 200, 'text/plain; charset=utf-8', String(tele.logs()));
    }
    let m = /^\/lib\/([a-z0-9-]+\.(?:js|css))$/.exec(pathname);
    if (m) return serveFile(res, path.join(PUBLIC_DIR, 'lib', m[1]));
    m = /^\/games\/([a-z0-9-]+)\/([a-z0-9.-]+)$/.exec(pathname);
    if (m) {
      const g = games.byId[m[1]];
      if (!g || !CLIENT_FILES.test(m[2])) return notFound(res);
      return serveFile(res, path.join(g.dir, m[2]));
    }
    if (pathname === '/galeria' || pathname.indexOf('/galeria/') === 0) return serveGallery(res, pathname, galleryDir);
    if (pathname === '/ambiente' || pathname.indexOf('/ambiente/') === 0) {
      return ambient.handle(req, res, pathname, { dir: ambientDir, timezone: timezone, publicDir: PUBLIC_DIR, send: send, notFound: notFound });
    }
    if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    notFound(res);
  });

  // perMessageDeflate off: compression adds latency and CPU (on the TV and the PC).
  // ws already enables TCP_NODELAY on every socket.
  const wss = new WebSocketServer({ server: server, path: '/ws', maxPayload: 256 * 1024, perMessageDeflate: false });
  wss.on('connection', hub.onConnection);
  wss.on('error', function () { /* the http server's errors (e.g. EADDRINUSE) are handled in listen() */ });

  const heartbeat = setInterval(function () {
    wss.clients.forEach(function (ws) {
      if (!ws._alive) { try { ws.terminate(); } catch (e) { /* noop */ } return; }
      ws._alive = false;
      try { ws.ping(); } catch (e) { /* noop */ }
    });
  }, 5000);
  heartbeat.unref();

  return {
    mode: mode,
    version: version,
    port: function () { return server.address() ? server.address().port : port; },
    activity: function () { return hub.counts(); },
    urls: urls,
    hostIp: hostIp,
    galleryDir: galleryDir,
    dataDir: dataDir,
    ambientDir: ambientDir,
    games: games,
    hub: hub,
    http: server,
    listen: function () {
      return new Promise(function (resolve, reject) {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', function () {
          server.removeListener('error', reject);
          setUrls(server.address().port);
          makeQr().then(function () {
            hub.start();
            resolve(urls);
          });
        });
      });
    },
    close: function () {
      return new Promise(function (resolve) {
        clearInterval(heartbeat);
        hub.stop();
        wss.clients.forEach(function (ws) { try { ws.terminate(); } catch (e) { /* noop */ } });
        server.close(function () { resolve(); });
        setTimeout(resolve, 1000).unref();
      });
    },
    otherIps: function () {
      return listIPv4().filter(function (c) { return c.address !== hostIp; });
    }
  };
}

function safeLoadConfig() {
  try { return config.load(); } catch (e) { return Object.assign({}, config.DEFAULTS); }
}

module.exports = { createServer: createServer, VERSION: VERSION };
