'use strict';
/*
 * «Modo tele»: the webOS JS service wrapper (src/tv-service/core.js) with a
 * FAKE webos-service, the real hub server and short timers:
 *   start (idempotent, concurrent), status, logs, heartbeat subscription,
 *   stop, idle shutdown (keepAlive activity completed), port already in use,
 *   IP selection on the TV, gallery folder probing, and a «Dibuja y adivina»
 *   match without any writable folder (the end-of-match gallery still works).
 * Runs on Node 12 too (G2T_NODE12=/ruta/node12 node test/tele.test.js does it).
 */
process.env.DIBUJA_DEBUG_SPEED = '40';
process.env.DIBUJA_ROUNDS = '1';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const H_ = require('./helpers');
const FakeService = require('./helpers/fake-webos-service');
const core = require('../src/tv-service/core');
const PKG = require('../package.json');

const check = H_.checker('Servicio de la tele (modo tele) con un webos-service falso');
const TMP = H_.tmpHome('g2t-tvsvc-');
const SVC = 'io.gametotv.launcher.service';
const IP = '192.168.1.77';

function getText(port, p) { return H_.httpGet('http://127.0.0.1:' + port, p); }

function ipTests() {
  console.log('\n[IP de la tele]');
  const v4 = function (address, internal) { return { address: address, family: 'IPv4', internal: !!internal }; };
  check(core.pickTvIp({ lo: [v4('127.0.0.1', true)], wlan0: [v4('192.168.1.30')], eth0: [v4('192.168.1.31')] }) === '192.168.1.31', 'Con cable y Wi-Fi: eth0');
  check(core.pickTvIp({ lo: [v4('127.0.0.1', true)], wlan0: [v4('10.0.0.12'), { address: 'fe80::1', family: 'IPv6', internal: false }] }) === '10.0.0.12', 'Solo Wi-Fi: wlan0 (ignora IPv6 y loopback)');
  check(core.pickTvIp({ p2p0: [v4('192.168.49.1')], wlan0: [v4('10.0.0.12')] }) === '10.0.0.12', 'Wi-Fi Direct (p2p0, 192.168.49.x) nunca gana');
  check(core.pickTvIp({ docker0: [v4('172.17.0.1')], eth1: [v4('169.254.3.3')], wlan0: [v4('192.168.0.9')] }) === '192.168.0.9', 'Sin puentes virtuales ni 169.254');
  check(core.pickTvIp({ lo: [v4('127.0.0.1', true)] }) === null && core.pickTvIp({ p2p0: [v4('192.168.49.1')] }) === null, 'Sin red útil: null (el servicio usa 127.0.0.1)');
  check(core.pickTvIp({ enp3s0: [{ address: '192.168.1.5', family: 4, internal: false }] }) === '192.168.1.5', 'family numérica (Node 18) y nombres en*');
}

function galleryTests() {
  console.log('\n[Carpeta de la galería]');
  const blocker = path.join(TMP, 'soy-un-archivo');
  fs.writeFileSync(blocker, 'x');
  const good = path.join(TMP, 'ok', 'galeria');
  const r = core.probeGalleryDir([path.join(blocker, 'galeria'), null, good]);
  check(r.dir === good && fs.existsSync(good) && r.tried.length === 2 && !r.tried[0].ok && /ENOTDIR|EEXIST/.test(r.tried[0].error) && r.tried[1].ok,
    'Prueba las candidatas en orden y usa la primera en la que se puede escribir');
  check(fs.readdirSync(good).length === 0, 'No deja el archivo de prueba');
  const none = core.probeGalleryDir([path.join(blocker, 'a'), path.join(blocker, 'b')]);
  check(none.dir === null && none.tried.length === 2, 'Si ninguna sirve: null (no se guardan PNG, sin errores)');
  const c = core.galleryCandidates({ HOME: '/home/prisoner' }, '/media/developer/apps/usr/palm/services/' + SVC);
  check(c[0] === '/home/prisoner/.game-to-tv/galeria' && c[1] === '/media/developer/temp/game-to-tv/galeria' &&
    c[2] === '/media/developer/apps/usr/palm/services/' + SVC + '/datos/galeria' && c[3] === path.join(os.tmpdir(), 'game-to-tv', 'galeria'),
  'Candidatas: HOME, /media/developer/temp, la carpeta del servicio y os.tmpdir()');
  check(core.galleryCandidates({ HOME: '/' }, null)[0] === '/media/developer/temp/game-to-tv/galeria' && core.galleryCandidates({ GALERIA_DIR: '/x/g', HOME: '/h' })[0] === '/x/g',
    'HOME=/ se ignora; GALERIA_DIR manda');
}

function makeService(extra) {
  const svc = new FakeService(SVC);
  const t = core.createTvService(Object.assign({
    service: svc, serviceId: SVC, port: 0, hostIp: IP, version: PKG.version, idleMs: 0, heartbeatMs: 100,
    galleryCandidates: [path.join(TMP, 'tele', 'galeria')], console: null
  }, extra || {}));
  return { svc: svc, t: t };
}

async function lifecycleTests() {
  console.log('\n[start / status / heartbeat / logs / stop]');
  const { svc, t } = makeService();
  check(['start', 'status', 'heartbeat', 'stop', 'logs'].every(function (m) { return svc.methods[m]; }), 'Registra start, status, heartbeat, stop y logs');

  // Two concurrent starts: one server
  const p1 = svc.request('start', {});
  const p2 = svc.request('start', {});
  const r1 = await p1, r2 = await p2;
  check(r1.returnValue === true && r1.port > 0 && r1.ip === IP && r1.url === 'http://' + IP + ':' + r1.port + '/' && r1.version === PKG.version,
    'start -> { returnValue, port, ip, url, version } (' + r1.url + ')');
  check(r2.port === r1.port && r2.returnValue, 'Dos start a la vez: un solo servidor');
  const r3 = await svc.request('start', {});
  check(r3.port === r1.port && svc.activityManager.created.length === 1, 'start es idempotente (misma respuesta, una sola actividad keepAlive)');
  await H_.waitUntil(function () { return t._state.keep && !t._state.keep.pending; }, 1000, 'keepAlive');
  check(t._state.keep && t._state.keep.name === 'keepAlive', 'Crea la actividad «keepAlive» (si no, webOS cierra el servicio)');

  const port = r1.port;
  const info = JSON.parse((await getText(port, '/info')).body);
  check(info.app === 'game-to-tv' && info.mode === 'tele' && info.version === PKG.version && info.tele.service === SVC && info.tele.node === process.version,
    '/info: { mode: tele, version, tele.service, tele.node }');
  check(info.actividad && info.actividad.slots === 6 && info.tele.players === 6, 'El servidor de la tele tiene 6 huecos de jugador');
  check(info.movil === 'http://' + IP + ':' + port + '/m' && info.ip === IP, 'El QR apunta a la IP de la tele y su puerto (' + info.movil + ')');
  check((await getText(port, '/qr.svg')).status === 200, '/qr.svg listo (el lanzador lo sondea)');
  const shell = (await getText(port, '/')).body;
  const boot = JSON.parse(/window\.G2T_BOOT = (.*?);<\/script>/.exec(shell)[1]);
  check(boot.mode === 'tele' && boot.tele && boot.tele.service === SVC && boot.version === PKG.version && /\/lib\/tvservice\.js/.test(shell),
    'La página de la tele sabe que va en modo tele (G2T_BOOT.tele.service) y carga /lib/tvservice.js');
  const logsTxt = (await getText(port, '/logs')).body;
  check(/Servidor listo en http:\/\/192\.168\.1\.77:/.test(logsTxt), '/logs (solo en modo tele) da el registro');

  // A fake TV page: the hello reply carries the phones' URL
  const tv = H_.makeClient('ws://127.0.0.1:' + port + '/ws', 'tele');
  await tv.ready;
  tv.send({ t: 'hello', role: 'tv' });
  const hi = await tv.wait(function (m) { return m.t === 'info'; }, 2000, 'info');
  check(hi && hi.url === 'http://' + IP + ':' + port + '/m', 'La pantalla recibe la URL de los móviles con la IP de la tele');

  const st = await svc.request('status', {});
  check(st.returnValue && st.running && st.port === port && st.ip === IP && st.version === PKG.version && st.galleryDir === path.join(TMP, 'tele', 'galeria') && st.gallerySaving === true,
    'status: running, puerto, IP, versión y carpeta de la galería');
  check(st.activity.tvs === 1 && st.activity.players === 0 && st.node === process.version, 'status cuenta pantallas y jugadores');

  // heartbeat subscription
  const hb = svc.call('heartbeat', { subscribe: true });
  check(hb.responses.length === 1 && hb.responses[0].returnValue && hb.responses[0].subscribed && hb.responses[0].running, 'heartbeat responde al momento');
  await H_.sleep(350);
  check(hb.responses.length >= 3 && hb.responses.length <= 5, 'heartbeat con subscribe: respuesta cada N ms (' + hb.responses.length + ' en 350 ms a 100 ms)');
  check((await svc.request('status', {})).activity.subscriptions === 1, 'status cuenta las suscripciones');
  hb.cancel();
  const n = hb.responses.length;
  await H_.sleep(250);
  check(hb.responses.length === n && t._state.subs.length === 0, 'Al cancelar la suscripción se para el temporizador');
  const one = await svc.request('heartbeat', {});
  check(one.returnValue && !one.subscribed && t._state.subs.length === 0, 'heartbeat sin subscribe: una respuesta');

  const lg = await svc.request('logs', { lines: 3 });
  check(lg.returnValue && lg.lines.length === 3 && (await svc.request('logs', {})).lines.some(function (l) { return /Servidor listo/.test(l); }), 'logs: últimas líneas del registro (anillo)');

  // stop
  const hb2 = svc.call('heartbeat', { subscribe: true });
  await tv.close();
  const sp = await svc.request('stop', {});
  check(sp.returnValue && sp.stopped && sp.wasRunning, 'stop');
  check(hb2.responses.some(function (r) { return r.stopped; }) && t._state.subs.length === 0, 'stop avisa a las suscripciones y las cierra');
  await H_.sleep(30);
  check(svc.activityManager.completed.length === 1 && svc.activityManager.active().length === 0, 'stop completa la actividad keepAlive (webOS puede cerrar el proceso)');
  let refused = false;
  try { await getText(port, '/info'); } catch (e) { refused = true; }
  check(refused, 'El puerto queda libre');
  const st2 = await svc.request('status', {});
  check(st2.running === false && st2.url === null && st2.stoppedReason === 'stop', 'status después de stop: running false');

  // start again
  const again = await svc.request('start', {});
  check(again.returnValue && again.port > 0 && svc.activityManager.created.length === 2, 'Se puede volver a arrancar (nueva actividad keepAlive)');
  await svc.request('stop', {});
}

async function idleTests() {
  console.log('\n[Apagado por inactividad]');
  const { svc, t } = makeService({ idleMs: 400, idleCheckMs: 40, serverOptions: { slotHoldMs: 200 } });
  const r = await svc.request('start', {});
  const port = r.port;
  const tv = H_.makeClient('ws://127.0.0.1:' + port + '/ws', 'tele');
  await tv.ready;
  tv.send({ t: 'hello', role: 'tv' });
  await tv.wait(function (m) { return m.t === 'info'; }, 2000, 'info');
  await H_.sleep(700);
  check(t._state.srv !== null, 'Con una pantalla conectada no se apaga (700 ms con un límite de 400 ms)');
  const ph = await H_.phone('ws://127.0.0.1:' + port + '/ws', 'Ana', 'cid-ana');
  await tv.close();
  await H_.sleep(600);
  check(t._state.srv !== null, 'Con un jugador conectado (sin pantalla) tampoco');
  const hb = svc.call('heartbeat', { subscribe: true });
  await ph.close();
  await H_.sleep(800);
  check(t._state.srv !== null, 'Con una suscripción heartbeat (una página de la tele abierta) tampoco');
  hb.cancel();
  const t0 = Date.now();
  const stopped = await H_.waitUntil(function () { return t._state.srv === null; }, 3000, 'apagado');
  const ms = Date.now() - t0;
  check(stopped && ms >= 300, 'Sin pantallas, jugadores ni suscripciones: se apaga tras el límite (' + ms + ' ms, límite 400 ms + hueco del jugador)');
  await H_.sleep(30);
  check(svc.activityManager.completed.length === 1 && svc.activityManager.active().length === 0, 'Al apagarse por inactividad completa la actividad keepAlive');
  const st = await svc.request('status', {});
  check(!st.running && st.stoppedReason === 'inactividad' && t.logs().some(function (l) { return /Sin tele ni jugadores/.test(l); }), 'status y logs explican el apagado');
  const again = await svc.request('start', {});
  check(again.returnValue && t._state.srv, 'Al reabrir la app, start lo vuelve a arrancar');
  await svc.request('stop', {});
}

async function errorTests() {
  console.log('\n[Errores]');
  const busy = net.createServer();
  await new Promise(function (r) { busy.listen(0, '0.0.0.0', r); });
  const { svc, t } = makeService({ port: busy.address().port });
  const r = await svc.request('start', {});
  check(r.returnValue === false && r.errorCode === 'EADDRINUSE' && /ocupado/.test(r.errorText), 'Puerto ocupado: returnValue false y un texto claro');
  await H_.sleep(30);
  check(!t._state.keep && svc.activityManager.active().length === 0, 'Si no arranca, no se queda con la actividad keepAlive');
  check((await svc.request('status', {})).lastError === r.errorText, 'status muestra el último error');
  busy.close();
  const env = core.createTvService({ service: new FakeService(SVC), serviceId: SVC, console: null, env: { G2T_PORT: '9123', G2T_IDLE_MIN: '2', G2T_JUGADORES: '4' } });
  const s = env.status();
  check(s.port === 9123 && s.idleMinutes === 2 && s.players === 4, 'Puerto, inactividad y jugadores configurables (G2T_PORT, G2T_IDLE_MIN, G2T_JUGADORES)');
  const def = core.createTvService({ service: new FakeService(SVC), serviceId: SVC, console: null, env: {} }).status();
  check(def.port === 8090 && def.idleMinutes === 15 && def.players === 6, 'Por defecto: puerto 8090 (3000/3001 son de LG), 15 min y 6 jugadores');
}

async function noGalleryMatch() {
  console.log('\n[Sin carpeta para la galería: partida de «Dibuja y adivina»]');
  const blocker = path.join(TMP, 'bloqueo');
  fs.writeFileSync(blocker, 'x');
  const { svc, t } = makeService({ galleryCandidates: [path.join(blocker, 'g')] });
  const r = await svc.request('start', {});
  const port = r.port;
  const st = await svc.request('status', {});
  check(st.galleryDir === null && st.gallerySaving === false && st.galleryTried.length === 1, 'status: galleryDir null, gallerySaving false');
  const gal = await getText(port, '/galeria');
  check(gal.status === 200 && /no tiene dónde guardar/.test(gal.body), '/galeria explica que no se guardan dibujos');
  const ws = 'ws://127.0.0.1:' + port + '/ws';
  const tv = H_.makeClient(ws, 'tele');
  await tv.ready;
  tv.send({ t: 'hello', role: 'tv' });
  const a = await H_.phone(ws, 'Ana', 'c-ana');
  const b = await H_.phone(ws, 'Bea', 'c-bea');
  a.send({ t: 'pick', game: 'dibuja' });
  const g = await tv.wait(function (m) { return m.t === 'd.gallery'; }, 8000, 'galería final');
  check(g && g.items.length === 1 && g.items[0].round === 1, 'La galería del final de la partida llega a la tele igualmente (en memoria)');
  await H_.sleep(100);
  const all = t.logs().join('\n');
  check(/Fin de partida/.test(all) && !/\[galeria\]/.test(all) && !/Error/.test(all), 'Sin intentos de guardar PNG ni errores en el registro del servicio');
  await a.close(); await b.close(); await tv.close();
  await svc.request('stop', {});
}

(async function () {
  try {
    ipTests();
    galleryTests();
    await lifecycleTests();
    await idleTests();
    await errorTests();
    await noGalleryMatch();
  } catch (e) {
    check.fail('Excepción: ' + (e && e.stack || e));
  } finally {
    H_.rmrf(TMP);
  }
  check.done();
})();
