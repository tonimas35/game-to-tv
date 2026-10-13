'use strict';
/*
 * A fake LG webOS TV for the tests: speaks SSAP over ws:// (or wss:// with a
 * test certificate), serves the screenshot over http(s) and a pointer input
 * socket for remote buttons. Records everything it receives.
 */
const http = require('http');
const https = require('https');
const WebSocket = require('ws');

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

function startFakeTv(opts) {
  opts = opts || {};
  const state = { requests: [], registers: [], buttons: [], key: opts.key || 'clave-de-prueba-123', denyPairing: !!opts.denyPairing };
  const server = opts.tls ? https.createServer({ key: opts.tls.key, cert: opts.tls.cert }) : http.createServer();
  const scheme = opts.tls ? 'https' : 'http';
  const wsScheme = opts.tls ? 'wss' : 'ws';

  server.on('request', function (req, res) {
    if (req.url.indexOf('/resources/shot.jpg') === 0) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      return res.end(JPEG);
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocket.Server({ noServer: true });
  server.on('upgrade', function (req, socket, head) {
    wss.handleUpgrade(req, socket, head, function (ws) { wss.emit('connection', ws, req); });
  });

  wss.on('connection', function (ws, req) {
    if (req.url.indexOf('/pointer') === 0) {
      ws.on('message', function (d) { state.buttons.push(d.toString()); });
      return;
    }
    ws.on('message', function (d) {
      const msg = JSON.parse(d.toString());
      const base = function () { return state.url.replace(/^wss?/, scheme); };
      if (msg.type === 'register') {
        state.registers.push(msg);
        const key = msg.payload && msg.payload['client-key'];
        if (key && key === state.key) {
          return ws.send(JSON.stringify({ type: 'registered', id: msg.id, payload: { 'client-key': state.key } }));
        }
        ws.send(JSON.stringify({ type: 'response', id: msg.id, payload: { pairingType: 'PROMPT', returnValue: true } }));
        setTimeout(function () {
          if (state.denyPairing) return ws.send(JSON.stringify({ type: 'error', id: msg.id, error: '403 User denied access' }));
          ws.send(JSON.stringify({ type: 'registered', id: msg.id, payload: { 'client-key': state.key } }));
        }, 150);
        return;
      }
      if (msg.type !== 'request') return;
      state.requests.push({ uri: msg.uri, payload: msg.payload });
      const reply = function (payload) { ws.send(JSON.stringify({ type: 'response', id: msg.id, payload: Object.assign({ returnValue: true }, payload) })); };
      switch (msg.uri) {
        case 'ssap://system.launcher/launch':
          if (msg.payload.id !== 'io.gametotv.launcher' && msg.payload.id !== 'com.example.otra') return reply({ returnValue: false, errorText: 'app not found' });
          return reply({ id: msg.payload.id, sessionId: 's1' });
        case 'ssap://system.launcher/open': return reply({ id: 'com.webos.app.browser' });
        case 'ssap://system.notifications/createToast': return reply({ toastId: 't1' });
        case 'ssap://system.notifications/createAlert': return reply({ alertId: 'alerta-1' });
        case 'ssap://system.notifications/closeAlert': return reply({});
        case 'ssap://tv/executeOneShot': return reply({ imageUri: base() + '/resources/shot.jpg' });
        case 'ssap://com.webos.service.networkinput/getPointerInputSocket': return reply({ socketPath: state.url + '/pointer' });
        case 'ssap://system/getSystemInfo': return reply({ modelName: '43UQ80006LB', serialNumber: '999TESTSERIAL', features: { '3d': false } });
        case 'ssap://com.webos.applicationManager/getForegroundAppInfo': return reply({ appId: 'io.gametotv.launcher' });
        case 'ssap://audio/getVolume': return reply({ volume: 12, muted: false });
        case 'ssap://com.webos.service.update/getCurrentSWInformation':
          return ws.send(JSON.stringify({ type: 'error', id: msg.id, error: '401 insufficient permissions', payload: {} }));
        default:
          return ws.send(JSON.stringify({ type: 'error', id: msg.id, error: '404 no such service or method', payload: {} }));
      }
    });
  });

  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      state.port = server.address().port;
      state.url = wsScheme + '://127.0.0.1:' + state.port;
      state.close = function () {
        return new Promise(function (r) {
          wss.clients.forEach(function (c) { try { c.terminate(); } catch (e) { /* noop */ } });
          server.close(function () { r(); });
          setTimeout(r, 500);
        });
      };
      resolve(state);
    });
  });
}

/** Fake Chrome DevTools endpoint: /json + a page that answers Runtime.evaluate */
function startFakeCdp(result) {
  const state = { evaluated: [] };
  const server = http.createServer(function (req, res) {
    if (req.url === '/json' || req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([
        { type: 'service_worker', url: 'x', webSocketDebuggerUrl: 'ws://127.0.0.1:' + state.port + '/devtools/page/sw' },
        { type: 'page', title: 'Juegos del Salón · Tele', url: 'http://192.168.1.50:3000/', webSocketDebuggerUrl: 'ws://127.0.0.1:' + state.port + '/devtools/page/1' }
      ]));
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocket.Server({ server: server });
  wss.on('connection', function (ws, req) {
    state.lastPath = req.url;
    ws.on('message', function (d) {
      const msg = JSON.parse(d.toString());
      state.evaluated.push(msg);
      ws.send(JSON.stringify({ id: msg.id, result: { result: { type: 'object', value: result } } }));
    });
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      state.port = server.address().port;
      state.close = function () { return new Promise(function (r) { wss.clients.forEach(function (c) { c.terminate(); }); server.close(function () { r(); }); setTimeout(r, 500); }); };
      resolve(state);
    });
  });
}

module.exports = { startFakeTv: startFakeTv, startFakeCdp: startFakeCdp, JPEG: JPEG };
