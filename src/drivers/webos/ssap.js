'use strict';
/*
 * SSAP client: the WebSocket protocol LG webOS TVs speak on
 * wss://<tv>:3001 (self-signed certificate) or ws://<tv>:3000.
 *
 *   const c = new SsapClient({ ip: '192.168.1.50' });
 *   await c.connect();
 *   const key = await c.register({ clientKey, onPrompt });   // PROMPT pairing
 *   await c.request('ssap://system.notifications/createToast', { message: 'Hola' });
 *   c.close();
 *
 * Pairing: the first time, the TV shows an «accept this device?» prompt and
 * answers with a client-key that must be saved and sent next time.
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const { MANIFEST } = require('./manifest');

class SsapError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

class SsapClient {
  /**
   * opts: { ip, url (overrides ip; tests), secure (default: try wss:3001 then ws:3000), timeout }
   */
  constructor(opts) {
    this.opts = opts || {};
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.timeout = this.opts.timeout || 10000;
    this.url = null;
  }

  candidates() {
    if (this.opts.url) return [this.opts.url];
    const ip = this.opts.ip;
    if (this.opts.secure === true) return ['wss://' + ip + ':3001'];
    if (this.opts.secure === false) return ['ws://' + ip + ':3000'];
    return ['wss://' + ip + ':3001', 'ws://' + ip + ':3000'];
  }

  connect() {
    const self = this;
    const urls = this.candidates();
    let lastErr = null;
    function attempt(i) {
      if (i >= urls.length) {
        return Promise.reject(new SsapError('No se puede conectar con la tele (' + urls.join(', ') + '): ' + (lastErr ? lastErr.message : '?') +
          '. ¿Está encendida y en la misma red?', 'ECONNECT'));
      }
      return self.open(urls[i]).catch(function (e) { lastErr = e; return attempt(i + 1); });
    }
    return attempt(0);
  }

  open(url) {
    const self = this;
    return new Promise(function (resolve, reject) {
      const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 5000, perMessageDeflate: false });
      const t = setTimeout(function () { try { ws.terminate(); } catch (e) { /* noop */ } reject(new Error('tiempo agotado')); }, 6000);
      ws.once('open', function () {
        clearTimeout(t);
        self.ws = ws;
        self.url = url;
        ws.on('message', function (d) { self.onMessage(d); });
        ws.on('close', function () {
          self.pending.forEach(function (p) { p.reject(new SsapError('La tele ha cerrado la conexión', 'ECLOSED')); });
          self.pending.clear();
        });
        resolve(url);
      });
      ws.once('error', function (e) { clearTimeout(t); reject(e); });
    });
  }

  onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (p.onMessage) { p.onMessage(msg); return; }
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.type === 'error') {
      p.reject(new SsapError(String(msg.error || 'error de la tele'), /^401/.test(String(msg.error)) ? 'E401' : 'ETV'));
    } else if (msg.payload && msg.payload.returnValue === false) {
      p.reject(new SsapError(String(msg.payload.errorText || msg.payload.errorCode || 'la tele ha respondido con un error'), 'ETV'));
    } else {
      p.resolve(msg.payload || {});
    }
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new SsapError('No hay conexión con la tele', 'ECLOSED');
    this.ws.send(JSON.stringify(obj));
  }

  /** Sends a request and resolves with the payload of the answer. */
  request(uri, payload, timeout) {
    const self = this;
    const id = 'req_' + (this.nextId++);
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        self.pending.delete(id);
        reject(new SsapError('La tele no responde a ' + uri, 'ETIMEOUT'));
      }, timeout || self.timeout);
      self.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      try {
        self.send({ type: 'request', id: id, uri: uri, payload: payload || {} });
      } catch (e) {
        clearTimeout(timer);
        self.pending.delete(id);
        reject(e);
      }
    });
  }

  /**
   * Registers this client. With a valid clientKey it is silent; otherwise the
   * TV shows a prompt (onPrompt is called) and we wait up to promptTimeout.
   * Resolves with the client-key to save.
   */
  register(opts) {
    opts = opts || {};
    const self = this;
    const id = 'register_' + (this.nextId++);
    const payload = { forcePairing: false, pairingType: 'PROMPT', manifest: opts.manifest || MANIFEST };
    if (opts.clientKey) payload['client-key'] = opts.clientKey;
    return new Promise(function (resolve, reject) {
      let prompted = false;
      const timer = setTimeout(function () {
        self.pending.delete(id);
        reject(new SsapError(prompted ? 'Nadie ha aceptado el aviso en la tele a tiempo.' : 'La tele no responde al registro.', 'ETIMEOUT'));
      }, opts.promptTimeout || 60000);
      self.pending.set(id, {
        timer: timer,
        onMessage: function (msg) {
          if (msg.type === 'response' && msg.payload && msg.payload.pairingType === 'PROMPT') {
            prompted = true;
            if (opts.onPrompt) opts.onPrompt();
            return;
          }
          self.pending.delete(id);
          clearTimeout(timer);
          if (msg.type === 'registered') {
            const key = msg.payload && msg.payload['client-key'];
            if (!key) return reject(new SsapError('La tele no ha devuelto la clave (client-key).', 'ETV'));
            return resolve({ clientKey: key, prompted: prompted });
          }
          reject(new SsapError(msg.type === 'error'
            ? 'La tele ha rechazado el emparejamiento: ' + (msg.error || '?')
            : 'Respuesta inesperada de la tele: ' + JSON.stringify(msg).slice(0, 200), 'EDENIED'));
        }
      });
      try {
        self.send({ type: 'register', id: id, payload: payload });
      } catch (e) {
        clearTimeout(timer);
        self.pending.delete(id);
        reject(e);
      }
    });
  }

  /**
   * Presses a remote button (UP, DOWN, LEFT, RIGHT, ENTER, BACK, HOME, ...)
   * through the pointer input socket.
   */
  async button(name) {
    const r = await this.request('ssap://com.webos.service.networkinput/getPointerInputSocket');
    if (!r.socketPath) throw new SsapError('La tele no ha dado el socket del mando.', 'ETV');
    await new Promise(function (resolve, reject) {
      const ws = new WebSocket(r.socketPath, { rejectUnauthorized: false, handshakeTimeout: 5000 });
      ws.once('open', function () {
        ws.send('type:button\nname:' + String(name).toUpperCase() + '\n\n');
        setTimeout(function () { try { ws.close(); } catch (e) { /* noop */ } resolve(); }, 150);
      });
      ws.once('error', reject);
    });
  }

  /**
   * Calls a luna:// service through the «alert trick»: an alert whose button
   * (and close action) runs the luna call, closed right away. Fire-and-forget:
   * the result of the luna call is not available.
   */
  async luna(uri, params) {
    const alert = await this.request('ssap://system.notifications/createAlert', {
      message: ' ',
      buttons: [{ label: 'OK', focus: true, buttonType: 'ok', onClick: uri, params: params || {} }],
      onclose: { uri: uri, params: params || {} },
      onfail: { uri: uri, params: params || {} }
    });
    if (alert.alertId) await this.request('ssap://system.notifications/closeAlert', { alertId: alert.alertId });
    return alert;
  }

  /** Screenshot: the TV writes a JPG and gives us its URL. DRM apps come out black. */
  async screenshot(outFile) {
    const r = await this.request('ssap://tv/executeOneShot', { path: '/tmp/capture.jpg', method: 'DISPLAY', format: 'JPG' }, 15000);
    if (!r.imageUri) throw new SsapError('La tele no ha devuelto la captura.', 'ETV');
    await download(r.imageUri, outFile);
    return { file: outFile, imageUri: r.imageUri };
  }

  close() {
    if (this.ws) { try { this.ws.close(); } catch (e) { /* noop */ } }
    this.ws = null;
  }
}

// Downloads a URL to a file (https with the TV's self-signed certificate)
function download(url, outFile) {
  return new Promise(function (resolve, reject) {
    const mod = /^https:/i.test(url) ? https : http;
    const req = mod.get(url, { rejectUnauthorized: false, timeout: 15000 }, function (res) {
      if (res.statusCode !== 200) { res.resume(); return reject(new SsapError('No se pudo descargar la captura (HTTP ' + res.statusCode + ')', 'EHTTP')); }
      const out = fs.createWriteStream(outFile);
      res.pipe(out);
      out.on('finish', function () { out.close(function () { resolve(outFile); }); });
      out.on('error', reject);
    });
    req.on('timeout', function () { req.destroy(new Error('tiempo agotado descargando la captura')); });
    req.on('error', reject);
  });
}

module.exports = { SsapClient: SsapClient, SsapError: SsapError, download: download };
