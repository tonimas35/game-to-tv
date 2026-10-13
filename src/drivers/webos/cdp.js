'use strict';
/*
 * Real FPS on the TV through the Chrome DevTools Protocol.
 * `ares-inspect --device <tv> --app <id>` opens a DevTools endpoint for the
 * running web app; we list its targets (/json), connect to the page and run
 * Runtime.evaluate with a requestAnimationFrame counter for a few seconds.
 */
const http = require('http');
const WebSocket = require('ws');

// Counts frames for SECONDS and reports fps, worst frame and canvas size
function fpsExpression(seconds) {
  return '(function () { return new Promise(function (res) {' +
    'var n = 0, t0 = performance.now(), last = t0, worst = 0;' +
    'function f(t) { n++; var d = t - last; if (d > worst) worst = d; last = t;' +
    ' if (t - t0 < ' + Math.round(seconds * 1000) + ') requestAnimationFrame(f);' +
    ' else { var c = document.getElementById("pc");' +
    ' res({ frames: n, ms: Math.round(t - t0), fps: Math.round(n * 10000 / (t - t0)) / 10, worstMs: Math.round(worst),' +
    ' width: innerWidth, height: innerHeight, dpr: devicePixelRatio, url: location.href,' +
    ' screen: (window.__tv && window.__tv.screen) ? window.__tv.screen() : "", canvas: c ? c.width + "x" + c.height : "" }); } }' +
    'requestAnimationFrame(f); }); })()';
}

/** Finds the DevTools HTTP base (http://host:port) and an optional ws URL in ares-inspect output. */
function parseInspectOutput(text) {
  const s = String(text || '');
  const ws = /[?&]ws=([^\s&]+)/.exec(s);
  const m = /(https?:\/\/[^\s/"']+(?::\d+)?)/.exec(s);
  if (!m && !ws) return null;
  return { base: m ? m[1].replace(/^https/, 'http') : null, ws: ws ? 'ws://' + decodeURIComponent(ws[1]) : null };
}

function getJson(url, timeout) {
  return new Promise(function (resolve, reject) {
    const req = http.get(url, { timeout: timeout || 5000 }, function (res) {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function (d) { body += d; });
      res.on('end', function () { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Respuesta no válida de ' + url)); } });
    });
    req.on('timeout', function () { req.destroy(new Error('tiempo agotado: ' + url)); });
    req.on('error', reject);
  });
}

function pickTarget(targets) {
  const pages = (targets || []).filter(function (t) { return t.webSocketDebuggerUrl && (!t.type || t.type === 'page'); });
  // Prefer our pages (the server's TV page) over anything else
  pages.sort(function (a, b) {
    const sa = /:\d+\/(\?|$)|__tv|Juegos/.test((a.url || '') + (a.title || '')) ? 0 : 1;
    const sb = /:\d+\/(\?|$)|__tv|Juegos/.test((b.url || '') + (b.title || '')) ? 0 : 1;
    return sa - sb;
  });
  return pages[0] || null;
}

/** Runs Runtime.evaluate (awaiting promises) and returns the value. */
function evaluate(wsUrl, expression, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    const t = setTimeout(function () { try { ws.terminate(); } catch (e) { /* noop */ } reject(new Error('tiempo agotado midiendo en la tele')); }, timeoutMs || 20000);
    ws.once('open', function () {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expression, awaitPromise: true, returnByValue: true } }));
    });
    ws.on('message', function (d) {
      let msg;
      try { msg = JSON.parse(d.toString()); } catch (e) { return; }
      if (msg.id !== 1) return;
      clearTimeout(t);
      try { ws.close(); } catch (e) { /* noop */ }
      if (msg.error) return reject(new Error('CDP: ' + (msg.error.message || JSON.stringify(msg.error))));
      const r = msg.result || {};
      if (r.exceptionDetails) return reject(new Error('Error en la página: ' + (r.exceptionDetails.text || '?')));
      resolve(r.result ? r.result.value : undefined);
    });
    ws.once('error', function (e) { clearTimeout(t); reject(e); });
  });
}

/** endpoint: { base, ws } from parseInspectOutput (or { base: 'http://ip:port' }) */
async function measureFps(endpoint, seconds) {
  seconds = seconds || 4;
  let wsUrl = endpoint.ws;
  if (!wsUrl) {
    let targets;
    try { targets = await getJson(endpoint.base + '/json'); } catch (e) { targets = await getJson(endpoint.base + '/json/list'); }
    const t = pickTarget(targets);
    if (!t) throw new Error('No hay ninguna página que inspeccionar en ' + endpoint.base + '. ¿Está la app abierta en la tele?');
    wsUrl = t.webSocketDebuggerUrl;
  }
  return evaluate(wsUrl, fpsExpression(seconds), seconds * 1000 + 15000);
}

module.exports = { fpsExpression: fpsExpression, parseInspectOutput: parseInspectOutput, pickTarget: pickTarget, evaluate: evaluate, measureFps: measureFps, getJson: getJson };
