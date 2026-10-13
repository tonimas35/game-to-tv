'use strict';
// Shared helpers for the plain-node test scripts (no framework needed).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'game-to-tv.js');

function checker(title) {
  let passed = 0, failed = 0;
  if (title) console.log('\n=== ' + title + ' ===');
  function check(cond, label) {
    if (cond) { passed++; console.log('  OK     ' + label); }
    else { failed++; console.log('  FALLO  ' + label); }
    return cond;
  }
  check.fail = function (label) { return check(false, label); };
  check.done = function () {
    console.log('\nResultado: ' + passed + ' OK, ' + failed + ' fallos');
    process.exit(failed ? 1 : 0);
  };
  check.counts = function () { return { passed: passed, failed: failed }; };
  return check;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function waitUntil(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { /* keep trying */ }
    await sleep(5);
  }
  console.log('    (tiempo agotado esperando: ' + label + ')');
  return null;
}

// fs.rmSync does not exist on Node 12 (the tests also run there: see test/tele.test.js)
function rmrf(dir) {
  try {
    if (fs.rmSync) fs.rmSync(dir, { recursive: true, force: true });
    else fs.rmdirSync(dir, { recursive: true });
  } catch (e) { /* noop */ }
}

function tmpHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'g2t-test-'));
}

// Runs the CLI and resolves with { code, out }
function runCli(args, env, opts) {
  return new Promise(function (resolve) {
    const p = spawn(process.execPath, [BIN].concat(args), {
      env: Object.assign({}, process.env, { NO_COLOR: '1' }, env || {}),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    p.stdout.on('data', function (d) { out += d; });
    p.stderr.on('data', function (d) { out += d; });
    const t = setTimeout(function () { try { p.kill('SIGKILL'); } catch (e) { /* noop */ } }, (opts && opts.timeout) || 20000);
    p.on('exit', function (code) { clearTimeout(t); resolve({ code: code, out: out }); });
  });
}

// Starts `game-to-tv start` in a child process and waits until it listens
async function startServer(env, extraArgs) {
  const srv = spawn(process.execPath, [BIN, 'start', '--sin-qr'].concat(extraArgs || []), {
    env: Object.assign({}, process.env, { NO_COLOR: '1' }, env),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const state = { proc: srv, out: '' };
  srv.stdout.on('data', function (d) { state.out += d; });
  srv.stderr.on('data', function (d) { state.out += d; });
  process.on('exit', function () { try { srv.kill('SIGKILL'); } catch (e) { /* noop */ } });
  await waitUntil(function () { return /escuchando/.test(state.out); }, 8000, 'arranque del servidor');
  state.stop = function () {
    return new Promise(function (r) {
      srv.once('exit', r);
      try { srv.kill('SIGTERM'); } catch (e) { r(); }
      setTimeout(r, 2000);
    });
  };
  return state;
}

function httpGet(base, p, headers) {
  return new Promise(function (resolve, reject) {
    http.get(base + p, { headers: headers || {} }, function (res) {
      const chunks = [];
      res.on('data', function (d) { chunks.push(d); });
      res.on('end', function () {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, type: res.headers['content-type'] || '', body: buf.toString('utf8'), buf: buf });
      });
    }).on('error', reject);
  });
}

// A fake TV or phone speaking the hub protocol
function makeClient(wsUrl, label) {
  const c = { label: label, ws: new WebSocket(wsUrl), msgs: [], hub: null, dmeta: null, pmeta: null, rmeta: null, state: null, open: false, closed: false };
  c.ready = new Promise(function (resolve, reject) {
    c.ws.on('open', function () { c.open = true; resolve(); });
    c.ws.on('error', reject);
  });
  c.ws.on('message', function (d) {
    const m = JSON.parse(d.toString());
    m._at = Date.now();
    if (m.t === 's') { c.state = m; return; }
    if (m.t === 'hub') c.hub = m;
    if (m.t === 'dmeta') c.dmeta = m;
    if (m.t === 'pmeta') c.pmeta = m;
    if (m.t === 'rmeta') c.rmeta = m;
    c.msgs.push(m);
  });
  c.ws.on('close', function () { c.closed = true; });
  c.send = function (o) { c.ws.send(JSON.stringify(o)); };
  c.find = function (t) { for (let i = c.msgs.length - 1; i >= 0; i--) if (c.msgs[i].t === t) return c.msgs[i]; return null; };
  c.mark = function () { return c.msgs.length; };
  c.since = function (idx, t) { return c.msgs.slice(idx).filter(function (m) { return !t || m.t === t; }); };
  c.wait = function (pred, timeout, what, from) {
    return waitUntil(function () {
      for (let i = from || 0; i < c.msgs.length; i++) if (pred(c.msgs[i])) return c.msgs[i];
      return null;
    }, timeout || 3000, c.label + ': ' + what);
  };
  c.close = function () { return new Promise(function (r) { if (c.closed) return r(); c.ws.once('close', r); c.ws.close(); }); };
  return c;
}

async function phone(wsUrl, name, cid) {
  const c = makeClient(wsUrl, name);
  await c.ready;
  c.send({ t: 'join', name: name, cid: cid });
  await waitUntil(function () { return c.find('joined') || c.find('full'); }, 2000, name + ' joined/full');
  return c;
}

module.exports = {
  ROOT: ROOT, BIN: BIN, checker: checker, sleep: sleep, waitUntil: waitUntil, tmpHome: tmpHome, rmrf: rmrf,
  runCli: runCli, startServer: startServer, httpGet: httpGet, makeClient: makeClient, phone: phone
};
