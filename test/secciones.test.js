/*
 * Menu sections (manifest "section": "1vs1"), with FAKE games written to a
 * temporary folder (test/helpers/juegos-falsos.js; no real game folders):
 *   - the manifest check accepts "1vs1" and rejects unknown sections
 *   - loadGames / publicManifests / publicSections carry the field
 *   - the TV and phone pages get it in G2T_BOOT (pc mode and modo tele)
 *   - without section games there is no section at all
 *   - the hub picks a section game like any other: «falta 1 jugador»,
 *     «sois 3» and the game starts with exactly 2
 * Runs on Node 12 too (npm run test:node12).
 *
 *   node test/secciones.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const H_ = require('./helpers');
const { DUELOS, writeFakeGames } = require('./helpers/juegos-falsos');

const TMP = H_.tmpHome('g2t-secciones-');
process.env.GAME_TO_TV_HOME = path.join(TMP, 'home');

const games = require('../src/games');
const { createServer } = require('../src/server');
const core = require('../src/tv-service/core');
const FakeService = require('./helpers/fake-webos-service');

const check = H_.checker('Secciones del menú («1 contra 1») con juegos falsos');
const FAKE_DIR = writeFakeGames(path.join(TMP, 'juegos'));
const DIRS = [games.GAMES_DIR, FAKE_DIR];
const IDS = DUELOS.map(function (g) { return g.id; });
// A folder with one fake game WITHOUT a section (the menu as it was before sections)
const PLAIN_DIR = writeFakeGames(path.join(TMP, 'sin-seccion'), [Object.assign({}, DUELOS[0], { id: 'prueba-normal', title: 'Normal', section: null })]);
// The real games (after the «1 contra 1» games arrive, some of them have a section)
const REAL = games.loadGames([games.GAMES_DIR], function () {});
const quiet = function () {};

function bootOf(html) {
  const m = /window\.G2T_BOOT = (.*?);<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

function manifestTests() {
  console.log('\n[Manifiesto]');
  const base = { id: 'x', title: 'X', description: 'd', minPlayers: 2, maxPlayers: 2 };
  check(games.validateManifest(Object.assign({ section: '1vs1' }, base), 'x').length === 0, '"section": "1vs1" es válido');
  check(games.validateManifest(base, 'x').length === 0, 'Sin "section" también (es opcional)');
  const bad = games.validateManifest(Object.assign({ section: '2vs2' }, base), 'x');
  check(bad.length === 1 && /section desconocida \(«2vs2»\); valores posibles: «1vs1»/.test(bad[0]), 'Una sección desconocida se rechaza: «' + bad[0] + '»');
  check(games.validateManifest(Object.assign({ section: 7 }, base), 'x').length === 1, 'Una sección que no es texto se rechaza');
  check(games.SECTIONS['1vs1'].title === '1 contra 1' && games.SECTIONS['1vs1'].subtitle === 'Duelos rápidos para dos', 'La sección «1 contra 1»: «Duelos rápidos para dos»');

  // A game with a wrong section is not loaded (and says why)
  const badDir = path.join(TMP, 'malos');
  writeFakeGames(badDir, [Object.assign({}, DUELOS[0], { id: 'prueba-mala', section: 'equipos' })]);
  const logs = [];
  const gs = games.loadGames([badDir], function (s) { logs.push(s); });
  check(gs.list.length === 0 && /prueba-mala.*section desconocida \(«equipos»\)/.test(logs.join('\n')), 'El juego con una sección desconocida no se carga y el registro dice por qué');
}

function registryTests() {
  console.log('\n[Registro de juegos]');
  const plain = games.loadGames([PLAIN_DIR], quiet);
  check(plain.list.length === 1 && games.publicSections(plain).length === 0 && games.publicManifests(plain)[0].section === null, 'Sin juegos de sección: ninguna sección y "section": null');
  check(games.publicManifests(REAL).every(function (m) { return (m.section === null || m.section === '1vs1') && typeof m.order === 'number'; }), 'Los juegos reales: section null o "1vs1", y su order');

  const all = games.loadGames(DIRS, quiet);
  const pub = games.publicManifests(all);
  const fake = pub.filter(function (m) { return m.section === '1vs1'; });
  check(fake.length === 4 && fake.map(function (m) { return m.id; }).join() === IDS.join(), 'publicManifests lleva "section" (los 4 duelos, en orden)');
  check(fake[0].icon === '/games/' + IDS[0] + '/icon.svg' && fake[0].order === 50, '…con su icono y su order');
  const secs = games.publicSections(all);
  check(secs.length === 1 && secs[0].id === '1vs1' && secs[0].title === '1 contra 1' && secs[0].games.join() === IDS.join() && typeof secs[0].order === 'number' && /^#/.test(secs[0].accent),
    'publicSections: «1 contra 1» con sus juegos, order y accent');
}

async function serverTests() {
  console.log('\n[Servidor (modo pc): G2T_BOOT y el hub]');
  const srv = createServer({ port: 0, hostIp: '127.0.0.1', galleryDir: null, dataDir: null, gamesDirs: DIRS, maxPlayers: 6, log: quiet, slotHoldMs: 30000 });
  await srv.listen();
  const BASE = 'http://127.0.0.1:' + srv.port();
  const WS = 'ws://127.0.0.1:' + srv.port() + '/ws';
  const clients = [];
  try {
    const tvBoot = bootOf((await H_.httpGet(BASE, '/')).body);
    const mBoot = bootOf((await H_.httpGet(BASE, '/m')).body);
    check(!!tvBoot && tvBoot.sections.length === 1 && tvBoot.sections[0].games.join() === IDS.join(), 'La tele recibe G2T_BOOT.sections con «1 contra 1»');
    check(!!mBoot && JSON.stringify(mBoot.sections) === JSON.stringify(tvBoot.sections) && mBoot.games.filter(function (g) { return g.section === '1vs1'; }).length === 4,
      'El móvil recibe lo mismo, y cada juego su "section"');
    check(tvBoot.games.length === REAL.list.length + 4, 'Los juegos reales siguen en G2T_BOOT.games (' + tvBoot.games.length + ' en total)');
    check((await H_.httpGet(BASE, '/games/' + IDS[0] + '/icon.svg')).status === 200, 'El icono de un juego de sección se sirve como los demás');

    const tv = H_.makeClient(WS, 'tele'); clients.push(tv);
    await tv.ready;
    tv.send({ t: 'hello', role: 'tv' });
    await H_.waitUntil(function () { return tv.hub; }, 2000, 'hub');
    const ana = await H_.phone(WS, 'Ana', 'c-ana'); clients.push(ana);
    let mk = tv.mark();
    ana.send({ t: 'pick', game: IDS[0] });
    const need = await tv.wait(function (m) { return m.t === 'ev' && m.k === 'need2'; }, 2000, 'need2', mk);
    check(!!need && need.text === '«Duelo Alfa» es para 2 jugadores: falta 1 jugador. Escanead el QR.' && need.game === IDS[0], 'Con 1: «' + (need && need.text) + '»');
    const berto = await H_.phone(WS, 'Berto', 'c-berto'); clients.push(berto);
    const carla = await H_.phone(WS, 'Carla', 'c-carla'); clients.push(carla);
    await H_.waitUntil(function () { return tv.hub && tv.hub.ready && tv.hub.players.filter(Boolean).length === 3; }, 2000, '3 listos');
    mk = tv.mark();
    tv.send({ t: 'pick', game: IDS[1] });
    const many = await tv.wait(function (m) { return m.t === 'ev' && m.k === 'toomany'; }, 2000, 'toomany', mk);
    check(!!many && many.text === '«Duelo Beta» es para 2 jugadores y sois 3. Elegid otro juego.' && tv.hub.screen === 'menu', 'Con 3: «' + (many && many.text) + '»');
    carla.send({ t: 'leave' });
    await H_.waitUntil(function () { return tv.hub && tv.hub.players.filter(Boolean).length === 2; }, 2000, '2');
    berto.send({ t: 'pick', game: IDS[2] });
    const started = await tv.wait(function (m) { return m.t === 'falso.start'; }, 2000, 'start');
    await H_.waitUntil(function () { return tv.hub.screen === IDS[2]; }, 2000, 'pantalla');
    check(!!started && tv.hub.screen === IDS[2] && tv.hub.pick.title === 'Duelo Gamma' && tv.hub.pick.name === 'Berto', 'Con 2 empieza el duelo elegido desde un móvil (hub.pick: «' + tv.hub.pick.title + '»)');
    tv.send({ t: 'menu' });
    await H_.waitUntil(function () { return tv.hub.screen === 'menu'; }, 2000, 'menú');
    tv.send({ t: 'pick', game: 'pong' });
    await H_.waitUntil(function () { return tv.hub.screen === 'pong'; }, 2000, 'pong');
    check(tv.hub.screen === 'pong', 'Los juegos sin sección se siguen eligiendo igual (Pong)');
    tv.send({ t: 'menu' });
    await H_.waitUntil(function () { return tv.hub.screen === 'menu'; }, 2000, 'menú');
  } finally {
    for (const c of clients) await c.close();
    await srv.close();
  }

  const plain = createServer({ port: 0, hostIp: '127.0.0.1', galleryDir: null, dataDir: null, gamesDirs: [PLAIN_DIR], log: quiet });
  await plain.listen();
  try {
    const boot = bootOf((await H_.httpGet('http://127.0.0.1:' + plain.port(), '/')).body);
    check(!!boot && Array.isArray(boot.sections) && boot.sections.length === 0 && boot.games.length === 1, 'Sin juegos de sección: G2T_BOOT.sections vacío');
  } finally {
    await plain.close();
  }
}

async function teleTests() {
  console.log('\n[Modo tele: el servicio de la tele]');
  const svc = new FakeService('io.gametotv.launcher.service');
  core.createTvService({
    service: svc, serviceId: 'io.gametotv.launcher.service', port: 0, hostIp: '192.168.1.77', version: '0.0.0', idleMs: 0, heartbeatMs: 100,
    galleryCandidates: [path.join(TMP, 'tele', 'galeria')], console: null, serverOptions: { gamesDirs: DIRS }
  });
  const r = await svc.request('start', {});
  try {
    const boot = bootOf((await H_.httpGet('http://127.0.0.1:' + r.port, '/')).body);
    check(r.returnValue && !!boot && boot.mode === 'tele' && boot.sections.length === 1 && boot.sections[0].id === '1vs1' &&
      boot.games.filter(function (g) { return g.section === '1vs1'; }).length === 4, 'El servidor dentro de la tele también pasa "section" y las secciones');
  } finally {
    await svc.request('stop', {});
  }
  // The TV bundle copies src/games entirely: the sections table goes with it
  const SOURCES = require('../src/drivers/webos/bundle').SOURCES;
  check(['src/games', 'src/server', 'public'].every(function (s) { return SOURCES.indexOf(s) >= 0; }) && /SECTIONS/.test(fs.readFileSync(path.join(games.GAMES_DIR, 'index.js'), 'utf8')),
    'El paquete de la tele lleva src/games (con la tabla de secciones), src/server y public');
}

(async function () {
  try {
    manifestTests();
    registryTests();
    await serverTests();
    await teleTests();
  } catch (e) {
    check.fail('Excepción: ' + (e && e.stack || e));
  }
  H_.rmrf(TMP);
  check.done();
})();
