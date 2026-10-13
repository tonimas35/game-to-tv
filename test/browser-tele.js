'use strict';
/*
 * Smoke test (headless Chromium, Playwright, optional) of the LG launcher app
 * in «modo tele», loaded from file:// like on the TV, with a FAKE
 * PalmServiceBridge that relays luna:// calls to the real service wrapper
 * (src/tv-service/core.js with a fake webos-service) running here:
 *  - «Arrancando los juegos…» while the service cold-starts
 *  - start -> server on 127.0.0.1:8090 -> polls /qr.svg -> opens the hub page
 *  - the hub page opens its own heartbeat subscription (tvservice.js), and
 *    the QR shows the TV's IP and port 8090
 *  - service failure: error, Developer Mode hint, PC fallback with ▲
 *  - opened in a plain browser (no PalmServiceBridge); pc mode still works;
 *    tvservice.js is a no-op outside webOS
 *
 *   node test/browser-tele.js [carpeta-de-capturas]
 */
const path = require('path');
const os = require('os');
const H_ = require('./helpers');

let pw = null;
const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/npm-tools/node_modules/playwright'].filter(Boolean);
for (const c of candidates) { try { pw = require(c); break; } catch (e) { /* sigue */ } }
if (!pw) { console.log('Playwright no está disponible: se omite la prueba del lanzador en modo tele.'); process.exit(0); }

const FakeService = require('./helpers/fake-webos-service');
const core = require('../src/tv-service/core');
const launcher = require('../src/drivers/webos/launcher');
const { createServer } = require('../src/server');
const PKG = require('../package.json');

const TELE_PORT = parseInt(process.env.TEST_TELE_PORT, 10) || 8090;
const PC_PORT = parseInt(process.env.TEST_PC_PORT, 10) || 3996;
const SVC = 'io.gametotv.launcher.service';
const SHOTS = path.resolve(process.argv[2] || process.env.SHOTS_DIR || path.join(os.tmpdir(), 'g2t-shots'));
const TMP = H_.tmpHome('g2t-btele-');
const check = H_.checker('Lanzador de LG en modo tele (Chromium + PalmServiceBridge falso)');

// Fake PalmServiceBridge: each bridge relays its call to Node (window.__luna) and
// gets the responses back through window.__lunaReply(id, json)
const BRIDGE = function (mode) {
  window.__docId = String(Math.random()).slice(2);
  window.__bridges = {};
  var n = 0;
  if (mode === 'none') return;
  window.PalmServiceBridge = function () {
    this.id = window.__docId + ':' + (++n);
    window.__bridges[this.id] = this;
  };
  window.PalmServiceBridge.prototype.call = function (uri, params) {
    window.__luna(this.id, window.__docId, uri, params);
  };
  window.__lunaReply = function (id, json) {
    var b = window.__bridges[id];
    if (b && b.onservicecallback) b.onservicecallback(json);
  };
};

async function setupPage(browser, opts) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const state = { calls: [], subs: [], errors: [] };
  page.on('pageerror', function (e) { state.errors.push(e.message); });
  await page.exposeFunction('__luna', function (id, docId, uri, params) {
    const m = /^luna:\/\/([^/]+)\/(\w+)$/.exec(uri);
    const call = { id: id, docId: docId, service: m && m[1], method: m && m[2], params: JSON.parse(params || '{}'), at: Date.now() };
    state.calls.push(call);
    function reply(r) { page.evaluate(function (a) { window.__lunaReply(a[0], a[1]); }, [id, JSON.stringify(r)]).catch(function () {}); }
    if (opts.fail) {
      setTimeout(function () { reply({ returnValue: false, errorCode: -1, errorText: 'Service does not exist: ' + call.service + '.' }); }, 100);
      return;
    }
    if (call.service !== SVC || !opts.svc.methods[call.method]) { reply({ returnValue: false, errorText: 'Unknown method' }); return; }
    // A JS service cold start takes ~3 s on the TV: delay the first answer
    setTimeout(function () {
      const msg = opts.svc.call(call.method, call.params, reply);
      if (msg.isSubscription) state.subs.push({ docId: docId, msg: msg, method: call.method });
    }, call.method === 'start' ? (opts.coldMs || 0) : 0);
  });
  await page.addInitScript(BRIDGE, opts.noBridge ? 'none' : 'fake');
  return { ctx: ctx, page: page, state: state };
}

// A navigation kills the old page's PalmServiceBridge subscriptions (as on webOS)
async function dropStaleSubscriptions(page, state) {
  const doc = await page.evaluate(function () { return window.__docId; });
  state.subs.forEach(function (s) { if (s.docId !== doc) s.msg.cancel(); });
  state.subs = state.subs.filter(function (s) { return s.docId === doc; });
}

(async function () {
  const svc = new FakeService(SVC);
  const tele = core.createTvService({
    service: svc, serviceId: SVC, port: TELE_PORT, hostIp: '192.168.1.77', version: PKG.version, idleMs: 0,
    galleryCandidates: [path.join(TMP, 'galeria')], console: null
  });
  const pc = createServer({ mode: 'pc', port: PC_PORT, hostIp: '192.168.1.40', galleryDir: path.join(TMP, 'pc-galeria'), log: function () {}, config: { tvs: {} } });
  let browser = null;
  try {
    await pc.listen();
    browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files'] });

    // ------------------------------------------------------------ 1) tele: success
    console.log('\n[Modo tele: arranque correcto]');
    const app = launcher.buildApp({ mode: 'tele', port: TELE_PORT, outDir: path.join(TMP, 'app-tele') });
    const a = await setupPage(browser, { svc: svc, coldMs: 1500 });
    await a.page.goto('file://' + path.join(app.dir, 'index.html'));
    await H_.sleep(400);
    const title0 = await a.page.textContent('#title');
    check(/Arrancando los juegos/.test(title0), 'Pantalla «Arrancando los juegos…» mientras arranca el servicio');
    await a.page.screenshot({ path: path.join(SHOTS, 'lanzador-tele-arrancando.png') }).catch(function () {});
    check(a.state.calls.length >= 1 && a.state.calls[0].method === 'start' && a.state.calls[0].service === SVC, 'Llama a luna://' + SVC + '/start con PalmServiceBridge');
    await a.page.waitForURL('http://127.0.0.1:' + TELE_PORT + '/', { timeout: 15000 });
    check(true, 'Tras start, sondea http://127.0.0.1:' + TELE_PORT + '/qr.svg y abre http://127.0.0.1:' + TELE_PORT + '/');
    const launcherHb = a.state.calls.filter(function (c) { return c.method === 'heartbeat' && c.params.subscribe; });
    check(launcherHb.length >= 1, 'El lanzador abre la suscripción heartbeat antes de navegar');
    await dropStaleSubscriptions(a.page, a.state);
    const beats = await H_.waitUntil(function () { return a.page.evaluate(function () { return window.G2T_TELE && window.G2T_TELE.beats; }); }, 5000, 'heartbeat de la página');
    const hubHb = a.state.calls.filter(function (c) { return c.method === 'heartbeat' && c.docId !== launcherHb[0].docId; });
    check(beats >= 1 && hubHb.length === 1 && hubHb[0].params.subscribe === true, 'La página de la tele vuelve a suscribirse a heartbeat (tvservice.js)');
    const st = tele.status();
    check(st.activity.subscriptions === 1 && st.running, 'El servicio ve 1 suscripción (la de la página nueva; la del lanzador murió al navegar)');
    const qr = await H_.waitUntil(function () { return a.page.textContent('#qrUrl').then(function (t) { return /8090|\d+\/m/.test(t) ? t : null; }); }, 5000, 'URL del QR');
    check(qr === '192.168.1.77:' + TELE_PORT + '/m', 'La tele muestra la dirección de los móviles con la IP de la tele y el puerto ' + TELE_PORT + ' (' + qr + ')');
    await H_.waitUntil(function () { return a.page.evaluate(function () { var i = document.getElementById('qrImg'); return i && i.naturalWidth > 0; }); }, 5000, 'imagen del QR');
    await a.page.screenshot({ path: path.join(SHOTS, 'lanzador-tele-menu.png') }).catch(function () {});
    check(tele.status().activity.tvs === 1, 'La página de la tele está conectada al hub de la tele');
    check(a.state.errors.length === 0, 'Sin errores de JavaScript' + (a.state.errors.length ? ': ' + a.state.errors.join(' | ') : ''));
    await a.ctx.close();

    // ------------------------------------------------------------ 2) tele: the service fails, PC fallback
    console.log('\n[Modo tele: el servicio falla]');
    const app2 = launcher.buildApp({ mode: 'tele', port: TELE_PORT, serverUrl: 'http://127.0.0.1:' + PC_PORT, outDir: path.join(TMP, 'app-fb') });
    const b = await setupPage(browser, { svc: svc, fail: true });
    await b.page.goto('file://' + path.join(app2.dir, 'index.html'));
    await H_.waitUntil(function () { return b.page.evaluate(function () { return window.__launcher.failed(); }); }, 12000, 'error del lanzador');
    const t2 = await b.page.textContent('#title');
    const sub2 = await b.page.textContent('#sub');
    const tips2 = await b.page.textContent('#tips');
    check(/No se pudo arrancar/.test(t2) && /Service does not exist/.test(sub2), 'Muestra el error del servicio (' + sub2.trim() + ')');
    check(b.state.calls.filter(function (c) { return c.method === 'start'; }).length === 3, 'Reintenta start 3 veces antes de rendirse');
    check(/Developer Mode/.test(tips2) && /Extend/.test(tips2) && /tv install/.test(tips2), 'Pista: la sesión de Developer Mode puede haber caducado (Extend y reinstalar)');
    const fbText = await b.page.textContent('#fallback');
    check(/servidor del PC/.test(fbText) && fbText.indexOf('127.0.0.1:' + PC_PORT) >= 0 && await b.page.isVisible('#fallback'), 'Ofrece el servidor del PC de reserva (' + fbText.trim() + ')');
    await b.page.screenshot({ path: path.join(SHOTS, 'lanzador-tele-error.png') }).catch(function () {});
    await b.page.keyboard.press('ArrowUp');
    await b.page.waitForURL('http://127.0.0.1:' + PC_PORT + '/', { timeout: 10000 });
    check(true, '▲ cambia al servidor del PC y lo abre');
    const pcInfo = await b.page.evaluate(function () { return window.G2T_BOOT && window.G2T_BOOT.mode; });
    await H_.sleep(300);
    check(pcInfo === 'pc' && !b.state.calls.some(function (c) { return c.method === 'heartbeat' && c.at > 0 && c.docId !== b.state.calls[0].docId; }),
      'En el servidor del PC, tvservice.js no llama a ningún servicio (G2T_BOOT.mode = pc)');
    check(b.state.errors.length === 0, 'Sin errores de JavaScript' + (b.state.errors.length ? ': ' + b.state.errors.join(' | ') : ''));
    await b.ctx.close();

    // ------------------------------------------------------------ 3) no PalmServiceBridge
    console.log('\n[Sin PalmServiceBridge / modo pc / navegador normal]');
    const c = await setupPage(browser, { svc: svc, noBridge: true });
    await c.page.goto('file://' + path.join(app.dir, 'index.html'));
    await H_.sleep(300);
    check(/necesita una tele LG/.test(await c.page.textContent('#title')), 'Abierto en un navegador normal: «Esta app necesita una tele LG»');
    await c.page.goto('http://127.0.0.1:' + TELE_PORT + '/');
    await H_.sleep(500);
    check(await c.page.evaluate(function () { return typeof window.G2T_TELE === 'undefined'; }), 'tvservice.js no hace nada fuera de webOS');
    check(c.state.errors.length === 0, 'Sin errores de JavaScript');
    await c.ctx.close();

    const appPc = launcher.buildApp({ mode: 'pc', serverUrl: 'http://127.0.0.1:' + PC_PORT, outDir: path.join(TMP, 'app-pc') });
    const d = await setupPage(browser, { svc: svc });
    await d.page.goto('file://' + path.join(appPc.dir, 'index.html'));
    await d.page.waitForURL('http://127.0.0.1:' + PC_PORT + '/', { timeout: 10000 });
    check(d.state.calls.length === 0, 'Modo pc: abre el servidor del PC sin llamar al servicio');
    await d.ctx.close();
  } catch (e) {
    check.fail('Excepción: ' + (e && e.stack || e));
  } finally {
    if (browser) await browser.close();
    await tele.stop();
    await pc.close();
    H_.rmrf(TMP);
  }
  check.done();
})();
