'use strict';
/*
 * «2048»: the pure board logic (slides, merge-once, spawning, game over),
 * the best scores on disk, the game with a fake hub API (1 player, a race of
 * 3, the TV keyboard), and the real server with fake phones and a fake TV
 * (1 player, reconnection, records file, a race of 3, the last one leaving).
 */
const fs = require('fs');
const path = require('path');
const H_ = require('./helpers');
const L = require('../src/games/2048/logic');
const Records = require('../src/games/2048/records');
const Game = require('../src/games/2048');
const check = H_.checker('2048');

// Full after one move to the left (with the new 2 in the corner) and nothing to join
const ALMOST = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 0, 8];
function seq(values) { let i = 0; return function () { const v = values[i % values.length]; i++; return v; }; }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ---------------------------------------------------------------- logic
function logic() {
  console.log('\n[Lógica]');
  check(same(L.slideLine([2, 2, 2, 2]).line, [4, 4, 0, 0]) && L.slideLine([2, 2, 2, 2]).gained === 8, '[2,2,2,2] -> [4,4,0,0] (+8)');
  check(same(L.slideLine([2, 2, 4, 0]).line, [4, 4, 0, 0]) && L.slideLine([2, 2, 4, 0]).gained === 4, '[2,2,4,0] -> [4,4,0,0]: el 4 nuevo no se vuelve a juntar');
  check(same(L.slideLine([4, 4, 8, 8]).line, [8, 16, 0, 0]), '[4,4,8,8] -> [8,16,0,0]');
  check(same(L.slideLine([0, 2, 0, 2]).line, [4, 0, 0, 0]), '[0,2,0,2] -> [4,0,0,0] (huecos en medio)');
  check(same(L.slideLine([2, 4, 2, 4]).line, [2, 4, 2, 4]) && L.slideLine([2, 4, 2, 4]).gained === 0, '[2,4,2,4] no cambia');
  check(same(L.slideLine([8, 0, 0, 8]).line, [16, 0, 0, 0]), '[8,0,0,8] -> [16,0,0,0]');
  check(same(L.slideLine([2, 2, 2, 0]).line, [4, 2, 0, 0]), '[2,2,2,0] -> [4,2,0,0] (se juntan los más cercanos a la pared)');

  // The four directions on a board
  const v = [
    2, 2, 2, 2,
    0, 4, 0, 4,
    2, 0, 0, 0,
    2, 0, 0, 0
  ];
  const zero = function () { return 0; };          // spawn: first empty cell, value 2
  const hi = function () { return 0.999; };        // spawn: last empty cell, value 4
  let b = L.fromValues(v);
  let r = L.move(b, 'right', hi);
  check(r.moved && same(L.values(b).slice(0, 8), [0, 0, 4, 4, 0, 0, 0, 8]) && r.gained === 16, 'Derecha: fila 1 -> [_,_,4,4], fila 2 -> [_,_,_,8]');
  check(r.gone.length === 3 && r.gone.every(function (g) { return g.cell >= 0 && g.cell < 16; }), 'Cada ficha que se junta dice adónde va (3)');
  b = L.fromValues(v);
  L.move(b, 'down', hi);
  check(L.values(b)[12] === 4 && L.values(b)[8] === 2 && L.values(b)[13] === 4 && L.values(b)[9] === 2, 'Abajo: columna 1 [2,_,2,2] -> 4 abajo y 2 encima; columna 2 [2,4,_,_] -> 2 y 4 abajo');
  b = L.fromValues(v);
  L.move(b, 'up', hi);
  check(L.values(b)[0] === 4 && L.values(b)[4] === 2, 'Arriba: columna 1 -> 4 arriba y 2 debajo');
  b = L.fromValues(v);
  L.move(b, 'left', hi);
  check(same(L.values(b).slice(0, 4), [4, 4, 0, 0]) && L.values(b)[4] === 8, 'Izquierda: [2,2,2,2] -> [4,4,_,_] y [_,4,_,4] -> [8,…]');

  // Spawn only after a move that changes something
  b = L.fromValues([2, 4, 8, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const before = L.values(b).join();
  const idBefore = b.nextId;
  r = L.move(b, 'up', zero);
  check(!r.moved && !r.spawned && L.values(b).join() === before && b.nextId === idBefore && b.moves === 0, 'Un movimiento que no cambia nada no saca ficha nueva');
  r = L.move(b, 'down', zero);
  const count = L.values(b).filter(Boolean).length;
  check(r.moved && r.spawned && count === 5 && b.moves === 1, 'Un movimiento que cambia algo saca exactamente una ficha nueva');
  // 90 % twos, 10 % fours
  let twos = 0, fours = 0;
  for (let i = 0; i < 1000; i++) {
    const nb = L.emptyBoard();
    const t = L.spawn(nb, seq([0.5, i / 1000]));
    if (t.v === 2) twos++; else if (t.v === 4) fours++;
  }
  check(twos === 900 && fours === 100, 'Fichas nuevas: 2 el 90 % de las veces y 4 el 10 % (' + twos + '/' + fours + ')');
  const nb = L.newBoard(Math.random);
  check(L.values(nb).filter(Boolean).length === 2, 'Un tablero nuevo empieza con 2 fichas');

  // Game over
  const full = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 8];
  b = L.fromValues(full);
  check(b.over && !L.canMove(b), 'Tablero lleno sin parejas: sin movimientos');
  r = L.move(b, 'left', zero);
  check(!r.moved, 'Sin movimientos: ya no se mueve nada');
  b = L.fromValues([2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 4]);
  check(!b.over && L.canMove(b), 'Lleno pero con una pareja: aún se puede');
  b = L.fromValues(ALMOST);
  r = L.move(b, 'left', zero);
  check(r.moved && b.over, 'El movimiento que llena el tablero sin parejas acaba la partida');

  // 2048
  b = L.fromValues([1024, 1024, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  r = L.move(b, 'left', zero);
  check(r.reached && b.won && b.max === 2048 && b.score === 2048, 'Juntar 1024 + 1024: ¡2048! (una sola vez)');
  r = L.move(b, 'right', zero);
  check(r.moved && !r.reached, 'Después se puede seguir jugando');
}

// ---------------------------------------------------------------- records
function records() {
  console.log('\n[Récords]');
  const dir = H_.tmpHome('g2t-2048-rec-');
  const logs = [];
  const st = Records.createStore(path.join(dir, 'sub'), function (s) { logs.push(s); });
  check(st.get('Ana') === 0, 'Sin archivo: récord 0');
  check(st.update('Ana', 1200) && !st.update('ana', 800) && st.update('ANA', 1500), 'Se guarda el mejor por nombre (sin distinguir mayúsculas)');
  check(st.save() && fs.existsSync(path.join(dir, 'sub', Records.FILE)), 'Se escribe ' + Records.FILE + ' (creando la carpeta)');
  const st2 = Records.createStore(path.join(dir, 'sub'));
  check(st2.get('ana') === 1500 && st2.get('Ána') === 1500 && st2.get('Berto') === 0, 'Se lee al volver a arrancar (y «Ána» es «Ana»)');
  // A folder that cannot be written: memory only, no exception
  const blocker = path.join(dir, 'soy-un-archivo');
  fs.writeFileSync(blocker, 'x');
  const st3 = Records.createStore(path.join(blocker, 'dentro'), function (s) { logs.push(s); });
  let threw = false, saved = true;
  try { st3.update('Ana', 300); saved = st3.save(); } catch (e) { threw = true; }
  check(!threw && !saved && st3.get('Ana') === 300 && logs.some(function (l) { return /solo en memoria/.test(l); }), 'Carpeta sin permiso: no falla, el récord queda en memoria y se avisa en el registro');
  const st4 = Records.createStore(null);
  st4.update('Ana', 10);
  check(st4.save() === false && st4.get('Ana') === 10, 'Sin carpeta (tele sin sitio donde escribir): solo en memoria');
  fs.writeFileSync(path.join(dir, 'roto.json'), '{no es json');
  let ok = true;
  try { Records.createStore(dir); fs.renameSync(path.join(dir, 'roto.json'), path.join(dir, Records.FILE)); ok = Records.createStore(dir).get('x') === 0; } catch (e) { ok = false; }
  check(ok, 'Un archivo de récords roto no rompe el juego');
  H_.rmrf(dir);
}

// ---------------------------------------------------------------- game with a fake hub API
function fakeApi(players, names) {
  const sent = [];
  const conn = {};
  players.forEach(function (i) { conn[i] = true; });
  return {
    slots: 6,
    sent: sent,
    conn: conn,
    dataDir: null,
    players: function () { return players.slice(); },
    setPlayers: function (p) { players = p; },
    isConnected: function (i) { return !!conn[i]; },
    allConnected: function () { return players.every(function (i) { return conn[i]; }); },
    name: function (i) { return names[i] || ('J' + (i + 1)); },
    broadcast: function (m) { sent.push(typeof m === 'string' ? JSON.parse(m) : m); },
    sendSlot: function (i, m) { sent.push(Object.assign({ _to: i }, m)); },
    sendWs: function () {},
    log: function () {}
  };
}
function lastMeta(api) { for (let i = api.sent.length - 1; i >= 0; i--) if (api.sent[i].t === 'nmeta') return api.sent[i]; return null; }
function runFor(g, ms) { for (let t = 0; t < ms; t += 1000 / 60) g.tick(1 / 60); g.flush(); }
function prep(b, prevBest) { b.seq = 0; b.gone = []; b.cele = false; b.prevBest = prevBest || 0; return b; }

function unitGame() {
  console.log('\n[Juego: 1 jugador]');
  const store = Records.createStore(null);
  store.update('Ana', 5000);
  const api = fakeApi([0], { 0: 'Ana' });
  const g = Game.create(api, { random: function () { return 0; }, records: store });
  g.start();
  g.flush();
  let m = lastMeta(api);
  check(m && m.mode === 'solo' && m.phase === 'play' && m.players.join() === '1' && m.boards.length === 1, 'Con 1 jugador: modo a solas, en juego desde el principio');
  check(m.boards[0].tiles.length === 8 && m.boards[0].best === 5000 && m.boards[0].score === 0, 'Tablero con 2 fichas y su récord (5000)');
  const S = g._state;
  // The TV keyboard plays for player 1
  S.boards[0] = prep(L.fromValues([2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 5000);
  g.onMessage(-1, { t: 'n.move', dir: 'left' });
  g.flush();
  m = lastMeta(api);
  check(m.boards[0].score === 4 && m.boards[0].seq === 1 && m.boards[0].tiles.length === 8 && m.boards[0].gone.length === 2, 'Flecha de la tele: mueve el tablero de la jugadora 1 (4 puntos, ficha nueva, 1 que se va)');
  g.flush();
  check(g._state.boards[0].gone.length === 0, 'Las fichas que se fueron solo se mandan una vez');
  g.onMessage(-1, { t: 'n.move', dir: 'diagonal' });
  g.onMessage(0, { t: 'n.move', dir: 'left' });
  g.flush();
  check(lastMeta(api).boards[0].seq === 1 || lastMeta(api).boards[0].seq === 2, 'Direcciones raras se ignoran');
  // 2048: «¡Lo conseguiste!» stops until going on
  S.boards[0] = prep(L.fromValues([1024, 1024, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 5000);
  const mark = api.sent.length;
  g.onMessage(0, { t: 'n.move', dir: 'left' });
  g.flush();
  m = lastMeta(api);
  check(api.sent.slice(mark).some(function (x) { return x.t === 'n.win' && x.slot === 1; }) && m.boards[0].cele && m.boards[0].won, '2048: aviso «n.win» y pausa de «¡Lo conseguiste!»');
  const seqCele = m.boards[0].seq;
  g.onMessage(0, { t: 'n.move', dir: 'right' });
  g.flush();
  check(lastMeta(api).boards[0].seq === seqCele, 'Mientras celebra no se mueve');
  g.onMessage(-1, { t: 'n.cont' });
  g.onMessage(0, { t: 'n.move', dir: 'right' });
  g.flush();
  m = lastMeta(api);
  check(!m.boards[0].cele && m.boards[0].seq === seqCele + 1, '«Seguir jugando» (también con OK en la tele) y se sigue');
  // Stuck: «Sin movimientos», then «Otra»
  S.boards[0] = prep(L.fromValues(ALMOST), 5000);
  S.boards[0].score = 6000;
  g.onMessage(0, { t: 'n.move', dir: 'left' });
  g.flush();
  m = lastMeta(api);
  check(m.boards[0].over && m.boards[0].rec && m.boards[0].best === 6000 && store.get('Ana') === 6000, 'Sin movimientos: se marca, ¡nuevo récord! (6000) guardado');
  const match = m.match;
  g.onMessage(0, { t: 'n.new' });
  g.flush();
  m = lastMeta(api);
  check(m.match === match + 1 && !m.boards[0].over && m.boards[0].score === 0 && m.boards[0].best === 6000, '«Otra»: partida nueva con el récord de antes');
  // A second player who arrives watches; «Nueva partida» brings them in (race)
  api.setPlayers([0, 2]);
  api.conn[2] = true;
  g.onPlayerJoined(2);
  g.flush();
  check(lastMeta(api).players.join() === '1', 'Quien llega a mitad mira');
  g.onMessage(2, { t: 'n.move', dir: 'left' });
  g.onMessage(0, { t: 'n.new' });
  g.flush();
  m = lastMeta(api);
  check(m.mode === 'race' && m.phase === 'intro' && m.players.join() === '1,3', 'La siguiente partida ya es una carrera de 2');
  g.stop();
}

function unitRace() {
  console.log('\n[Juego: carrera de 3]');
  const store = Records.createStore(null);
  const api = fakeApi([0, 2, 4], { 0: 'Ana', 2: 'Carla', 4: 'Eva' });
  const g = Game.create(api, { random: function () { return 0; }, records: store, raceMs: 60000 });
  g.start();
  g.flush();
  const S = g._state;
  let m = lastMeta(api);
  check(m.mode === 'race' && m.phase === 'intro' && m.boards.length === 3 && m.clock === 60000, 'Carrera con huecos 1, 3 y 5: presentación y 3 tableros');
  g.onMessage(0, { t: 'n.move', dir: 'left' });
  g.onMessage(0, { t: 'n.move', dir: 'right' });
  check(S.boards[0].moves === 0, 'Durante la cuenta atrás no se mueve');
  runFor(g, Game.INTRO_MS + 50);
  m = lastMeta(api);
  check(m.phase === 'play', 'Tras 3 s, ¡a jugar!');
  // Pause while a racer reconnects
  api.conn[2] = false;
  runFor(g, 2000);
  m = lastMeta(api);
  check(m.paused && m.waiting.join() === 'Carla' && m.clock > 59000, 'Pausa (y reloj parado) mientras Carla reconecta');
  S.boards[0] = prep(L.fromValues([2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  g.onMessage(0, { t: 'n.move', dir: 'left' });
  check(S.boards[0].moves === 0, 'En pausa nadie mueve');
  api.conn[2] = true;
  runFor(g, 100);
  // Moves: the TV is player 1 (Ana)
  g.onMessage(-1, { t: 'n.move', dir: 'left' });
  g.onMessage(4, { t: 'n.move', dir: 'left' });
  g.onMessage(4, { t: 'n.move', dir: 'right' });
  check(S.boards[0].moves === 1 && S.boards[0].score === 4 && S.boards[4].moves >= 1, 'La tele mueve a Ana; Eva mueve su propio tablero');
  // Carla gets stuck: she waits, the others go on
  S.boards[2] = prep(L.fromValues(ALMOST));
  g.onMessage(2, { t: 'n.move', dir: 'left' });
  g.flush();
  m = lastMeta(api);
  check(m.phase === 'play' && m.boards[1].over && !m.boards[0].over, 'Carla sin movimientos: espera; la carrera sigue');
  // Time is up: ranking with medals
  S.boards[0].score = 300; S.boards[2].score = 300; S.boards[4].score = 120;
  S.boards[0].max = 32; S.boards[2].max = 64;
  runFor(g, 61000);
  m = lastMeta(api);
  check(m.phase === 'end' && m.ranking.length === 3, 'Se acaba el tiempo: clasificación');
  check(m.ranking[0].slot === 3 && m.ranking[0].rank === 1 && m.ranking[1].slot === 1 && m.ranking[1].rank === 2 && m.ranking[2].rank === 3, 'A igualdad de puntos, gana la ficha más alta (Carla 1ª, Ana 2ª, Eva 3ª)');
  check(store.get('Carla') === 300 && store.get('Eva') === 120, 'Los récords se guardan al acabar');
  // Another race, everybody stuck -> ends before the clock
  g.onMessage(2, { t: 'n.new' });
  runFor(g, Game.INTRO_MS + 50);
  [0, 2, 4].forEach(function (s) { S.boards[s] = prep(L.fromValues(ALMOST)); });
  g.onMessage(0, { t: 'n.move', dir: 'left' });
  g.onMessage(2, { t: 'n.move', dir: 'left' });
  g.flush();
  check(lastMeta(api).phase === 'play', 'Con uno aún jugando, sigue');
  g.onMessage(4, { t: 'n.move', dir: 'left' });
  g.flush();
  m = lastMeta(api);
  check(m.phase === 'end' && m.clock > 30000, 'Todos sin movimientos: termina antes de tiempo');
  // Somebody leaves for good during a race
  g.onMessage(0, { t: 'n.new' });
  runFor(g, Game.INTRO_MS + 50);
  api.setPlayers([0, 4]);
  check(g.onPlayerLeft(2) !== false, 'Carla se va: la carrera sigue con Ana y Eva');
  g.flush();
  check(lastMeta(api).players.join() === '1,5' && lastMeta(api).boards.length === 2, 'Quedan 2 tableros');
  g.stop();
}

// ---------------------------------------------------------------- the real server
async function integration() {
  console.log('\n[Servidor: 1 jugador, reconexión y récords]');
  const PORT = 3987;
  const WS = 'ws://127.0.0.1:' + PORT + '/ws';
  const HOME = H_.tmpHome('g2t-2048-');
  const env = { GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', SLOT_HOLD_MS: '1500', G2048_RACE_SECONDS: '6', G2048_DEBUG_SPEED: '2' };
  let srv = await H_.startServer(env);
  const clients = [];
  const recFile = path.join(HOME, Records.FILE);
  try {
    const tv = H_.makeClient(WS, 'tele'); clients.push(tv);
    await tv.ready;
    tv.send({ t: 'hello', role: 'tv' });
    await H_.waitUntil(function () { return tv.hub; }, 2000, 'hub');
    const ana = await H_.phone(WS, 'Ana', 'c-ana'); clients.push(ana);
    await H_.waitUntil(function () { return tv.hub.ready; }, 2000, 'ready');
    check(tv.hub.ready === true, 'Con 1 móvil la sala ya está lista (hay un juego de 1)');
    // Dibuja still needs 2
    ana.send({ t: 'pick', game: 'dibuja' });
    const need = await ana.wait(function (m) { return m.t === 'ev' && m.k === 'need2'; }, 1500, 'need2');
    check(!!need && /falta 1 jugador/.test(need.text) && tv.hub.screen === 'menu', 'Los demás juegos siguen pidiendo su mínimo: «' + (need && need.text) + '»');
    const t0 = tv.mark();
    ana.send({ t: 'pick', game: '2048' });
    const h = await tv.wait(function (m) { return m.t === 'hub' && m.screen === '2048'; }, 2000, 'pantalla 2048', t0);
    check(!!h, 'Ana elige «2048» ella sola');
    const m0 = await tv.wait(function (m) { return m.t === 'nmeta' && m.mode === 'solo'; }, 2000, 'nmeta', t0);
    check(!!m0 && m0.boards.length === 1 && m0.boards[0].slot === 1 && m0.boards[0].tiles.length === 8, 'La tele recibe su tablero (2 fichas)');
    // Moves from the phone and from the TV keyboard
    async function moveUntil(client, label) {
      const dirs = ['left', 'up', 'right', 'down'];
      const before = tv.find('nmeta').boards[0].seq;
      for (let k = 0; k < dirs.length; k++) {
        client.send({ t: 'n.move', dir: dirs[k] });
        const got = await tv.wait(function (m) { return m.t === 'nmeta' && m.boards[0] && m.boards[0].seq > before; }, 300, label, tv.msgs.length - 2);
        if (got) return got;
      }
      return null;
    }
    const byPhone = await moveUntil(ana, 'mueve el móvil');
    check(!!byPhone && byPhone.boards[0].tiles.length >= 8, 'El móvil mueve las fichas');
    const byTv = await moveUntil(tv, 'mueve la tele');
    check(!!byTv && byTv.boards[0].seq === byPhone.boards[0].seq + 1, 'Las flechas de la tele mueven el tablero de la jugadora 1');
    for (let k = 0; k < 40; k++) ana.send({ t: 'n.move', dir: ['left', 'down', 'right', 'up'][k % 4] });
    await H_.sleep(300);
    const played = tv.find('nmeta').boards[0];
    check(played.score > 0, 'Tras unas jugadas: ' + played.score + ' puntos');
    // Reconnection: the phone sees its board again
    await ana.close();
    await H_.sleep(200);
    const ana2 = await H_.phone(WS, 'Ana', 'c-ana'); clients.push(ana2);
    const back = await ana2.wait(function (m) { return m.t === 'nmeta'; }, 1500, 'nmeta al volver');
    check(!!ana2.find('joined').reconnect && !!back && back.boards[0].score === tv.find('nmeta').boards[0].score && same(back.boards[0].tiles, tv.find('nmeta').boards[0].tiles), 'Al reconectar, el móvil recibe su mismo tablero (' + (back && back.boards[0].score) + ' puntos)');
    // «Nueva partida»: the score becomes a record on disk
    const score = tv.find('nmeta').boards[0].score;
    const tm = tv.mark();
    ana2.send({ t: 'n.new' });
    const fresh = await tv.wait(function (m) { return m.t === 'nmeta' && m.boards[0] && m.boards[0].score === 0; }, 2000, 'nueva', tm);
    check(!!fresh && fresh.boards[0].best === score, '«Nueva partida»: empieza de cero con «Récord» ' + score);
    await H_.waitUntil(function () { return fs.existsSync(recFile); }, 2000, 'archivo de récords');
    const onDisk = fs.existsSync(recFile) ? JSON.parse(fs.readFileSync(recFile, 'utf8')) : {};
    check(onDisk.records && onDisk.records.ana && onDisk.records.ana.best === score, 'Récord guardado en ' + Records.FILE + ' de la carpeta de configuración');
    // The last player leaves: back to the menu
    const tm2 = tv.mark();
    ana2.send({ t: 'leave' });
    const menuEv = await tv.wait(function (m) { return m.t === 'ev' && m.k === 'menu'; }, 2000, 'menú', tm2);
    check(!!menuEv && /Ana se ha ido y no queda nadie/.test(menuEv.text) && tv.hub.screen === 'menu', 'Se va la última: vuelta al menú («' + (menuEv && menuEv.text) + '»)');
    await srv.stop();

    // A new server reads the record
    srv = await H_.startServer(env);
    console.log('\n[Servidor: el récord sobrevive; carrera de 3]');
    const tv2 = H_.makeClient(WS, 'tele2'); clients.push(tv2);
    await tv2.ready;
    tv2.send({ t: 'hello', role: 'tv' });
    await H_.waitUntil(function () { return tv2.hub; }, 2000, 'hub 2');
    const a = await H_.phone(WS, 'ana', 'r-a'); clients.push(a);
    tv2.send({ t: 'pick', game: '2048' });
    const solo = await tv2.wait(function (m) { return m.t === 'nmeta'; }, 2000, 'nmeta 2');
    check(!!solo && solo.boards[0].best === score, 'Tras reiniciar el servidor, «ana» conserva su récord (' + (solo && solo.boards[0].best) + ')');
    tv2.send({ t: 'menu' });
    await tv2.wait(function (m) { return m.t === 'hub' && m.screen === 'menu'; }, 2000, 'menú 2');
    const b = await H_.phone(WS, 'Berto', 'r-b'); clients.push(b);
    const c = await H_.phone(WS, 'Carla', 'r-c'); clients.push(c);
    const tm3 = tv2.mark();
    c.send({ t: 'pick', game: '2048' });
    const race = await tv2.wait(function (m) { return m.t === 'nmeta' && m.mode === 'race'; }, 2000, 'carrera', tm3);
    check(!!race && race.boards.length === 3 && race.phase === 'intro', 'Con 3: carrera de 3 tableros, con cuenta atrás');
    await tv2.wait(function (m) { return m.t === 'nmeta' && m.phase === 'play'; }, 3000, 'en juego', tm3);
    for (let k = 0; k < 12; k++) [a, b, c].forEach(function (p, i) { p.send({ t: 'n.move', dir: ['left', 'down', 'right', 'up'][(k + i) % 4] }); });
    // A phone drops and comes back during the race
    await b.close();
    const paused = await tv2.wait(function (m) { return m.t === 'nmeta' && m.paused && m.waiting.indexOf('Berto') >= 0; }, 2000, 'pausa', tm3);
    check(!!paused, 'Si un móvil se cae, la carrera se pausa');
    const b2 = await H_.phone(WS, 'Berto', 'r-b'); clients.push(b2);
    const b2meta = await b2.wait(function (m) { return m.t === 'nmeta' && !m.paused; }, 2000, 'vuelve Berto');
    check(!!b2meta && b2meta.boards.some(function (x) { return x.slot === 2; }), 'Berto vuelve y ve su tablero; sigue la carrera');
    const end = await tv2.wait(function (m) { return m.t === 'nmeta' && m.phase === 'end'; }, 8000, 'fin', tm3);
    check(!!end && end.ranking.length === 3 && end.ranking[0].rank === 1 && end.ranking.every(function (r) { return r.score >= 0 && r.max >= 2; }), 'Fin del tiempo: clasificación de 3 (' + (end && end.ranking.map(function (r) { return r.rank + 'º ' + r.score; }).join(', ')) + ')');
    check(!!(await c.wait(function (m) { return m.t === 'nmeta' && m.phase === 'end'; }, 1000, 'fin móvil')), 'Los móviles reciben la clasificación');
    const tm4 = tv2.mark();
    tv2.send({ t: 'n.new' });
    check(!!(await tv2.wait(function (m) { return m.t === 'nmeta' && m.phase === 'intro'; }, 2000, 'otra', tm4)), '«Otra carrera» desde la tele');
    check(!/Error/.test(srv.out), 'Sin errores en el registro del servidor');
  } catch (e) {
    check.fail('Excepción: ' + (e && e.stack || e));
  } finally {
    clients.forEach(function (cl) { try { cl.ws.terminate(); } catch (e) { /* noop */ } });
    await srv.stop();
    H_.rmrf(HOME);
  }
}

(async function () {
  logic();
  records();
  unitGame();
  unitRace();
  await integration();
  check.done();
})();
