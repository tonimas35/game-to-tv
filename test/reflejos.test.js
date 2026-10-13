'use strict';
/*
 * «Reflejos» (the example game): unit test with a fake hub API, then an
 * integration test through the real server with 3 players (and checks of
 * the min/max player rules and slot compaction for 2-player games).
 */
const H_ = require('./helpers');
const check = H_.checker('Reflejos (juego de ejemplo)');

function fakeApi(slots, players) {
  const sent = [];
  return {
    slots: slots,
    sent: sent,
    tvs: new Set(),
    players: function () { return players.slice(); },
    allConnected: function () { return true; },
    name: function (i) { return 'J' + (i + 1); },
    broadcast: function (m) { sent.push(typeof m === 'string' ? JSON.parse(m) : m); },
    sendSlot: function () {},
    sendWs: function () {},
    log: function () {}
  };
}

function runFor(game, ms) {
  for (let t = 0; t < ms; t += 1000 / 60) game.tick(1 / 60);
  game.flush();
}

async function unit() {
  console.log('\n[Unidad]');
  const Reflejos = require('../src/games/ejemplo-reflejos');
  const api = fakeApi(3, [0, 1, 2]);
  const g = Reflejos.create(api, { random: function () { return 0; } }); // wait = 2 s
  g.start();
  g.flush();
  const S = g._state;
  check(S.phase === 'ready' && S.round === 1 && S.scores.length === 3, 'Empieza en «Preparados…», ronda 1');
  check(api.sent[api.sent.length - 1].t === 'rmeta' && api.sent[api.sent.length - 1].players.join() === '1,2,3', 'Envía rmeta con los 3 jugadores');

  g.onMessage(1, { t: 'r.tap' });
  check(S.early.indexOf(1) >= 0 && api.sent.some(function (m) { return m.t === 'r.early' && m.slot === 2; }), 'Tocar antes de «¡YA!» deja fuera al jugador 2');
  runFor(g, 2100);
  check(S.phase === 'go', 'Tras la espera sale «¡YA!»');
  g.onMessage(1, { t: 'r.tap' });
  check(S.phase === 'go' && S.scores[1] === 0, 'El que se adelantó no puede puntuar en esa ronda');
  g.onMessage(-1, { t: 'r.tap' });
  check(S.phase === 'go', 'La tele no puede tocar');
  g.onMessage(2, { t: 'r.tap' });
  check(S.phase === 'point' && S.scores[2] === 1 && S.last.slot === 2, 'El primero en tocar gana el punto');
  g.onMessage(0, { t: 'r.tap' });
  check(S.scores[0] === 0, 'Un toque tardío no puntúa');
  runFor(g, 2600);
  check(S.phase === 'ready' && S.round === 2 && S.early.length === 0, 'Siguiente ronda limpia');

  // Everybody too soon -> the round restarts (same number)
  [0, 1, 2].forEach(function (i) { g.onMessage(i, { t: 'r.tap' }); });
  check(S.round === 2 && S.early.length === 0 && S.phase === 'ready', 'Si todos se adelantan, la ronda se repite');

  // Nobody taps -> void round
  runFor(g, 2100);
  runFor(g, 5100);
  check(S.phase === 'point' && S.last === null && S.scores[2] === 1, 'Si nadie toca, ronda nula');

  // Player 1 wins 3 rounds -> end (best of 5)
  for (let r = 0; r < 3; r++) {
    runFor(g, 2700);
    if (S.phase === 'point') runFor(g, 2600);
    runFor(g, 2100);
    g.onMessage(0, { t: 'r.tap' });
  }
  check(S.phase === 'end' && S.winner === 0 && S.scores[0] === Reflejos.POINTS_TO_WIN, 'Al mejor de 5: gana quien llega a 3');
  g.onMessage(0, { t: 'r.tap' });
  check(S.scores[0] === 3, 'Tras el final no se puntúa más');
  g.onMessage(1, { t: 'r.again' });
  check(S.phase === 'ready' && S.round === 1 && S.scores.every(function (v) { return v === 0; }), '«Otra partida» reinicia el marcador');
}

async function integration() {
  console.log('\n[Integración con 3 jugadores]');
  const PORT = 3994;
  const WS = 'ws://127.0.0.1:' + PORT + '/ws';
  const HOME = H_.tmpHome('g2t-rx-');
  const srv = await H_.startServer({ GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', REFLEJOS_DEBUG_SPEED: '8', SLOT_HOLD_MS: '3000' }, ['--jugadores', '3']);
  const clients = [];
  try {
    const tv = H_.makeClient(WS, 'tele'); clients.push(tv);
    await tv.ready;
    tv.send({ t: 'hello', role: 'tv' });
    await H_.waitUntil(function () { return tv.hub; }, 2000, 'hub');
    check(tv.hub.players.length === 3 && tv.find('info').slots === 3, 'La sala tiene 3 huecos (--jugadores 3)');
    const a = await H_.phone(WS, 'Ana', 'c-a'); clients.push(a);
    const b = await H_.phone(WS, 'Berto', 'c-b'); clients.push(b);
    const c = await H_.phone(WS, 'Carla', 'c-c'); clients.push(c);
    check(c.find('joined').slot === 3 && c.find('joined').color === '#ffd23e', 'La tercera jugadora entra en el hueco 3 (amarillo)');
    const d = await H_.phone(WS, 'Dani', 'c-d'); clients.push(d);
    check(!!d.find('full') && d.find('full').slots === 3, 'Un cuarto móvil recibe «lleno»');

    // Pong is for 2 players
    const m0 = a.mark();
    a.send({ t: 'pick', game: 'pong' });
    const tooMany = await a.wait(function (m) { return m.t === 'ev' && m.k === 'toomany'; }, 1000, 'toomany', m0);
    check(!!tooMany && tooMany.max === 2 && tv.hub.screen === 'menu', 'Con 3 jugadores no se puede elegir el Pong (máx. 2)');

    // Reflejos with 3
    const tm = tv.mark();
    b.send({ t: 'pick', game: 'ejemplo-reflejos' });
    const hubR = await tv.wait(function (m) { return m.t === 'hub' && m.screen === 'ejemplo-reflejos'; }, 2000, 'screen reflejos', tm);
    check(!!hubR && hubR.pick.name === 'Berto', 'Berto elige «Reflejos»');
    let points = 0;
    let lastRound = 0;
    for (let r = 0; r < 3; r++) {
      const go = await c.wait(function (m) { return m.t === 'rmeta' && m.phase === 'go' && m.round > lastRound; }, 6000, 'go ' + r);
      if (!go) break;
      lastRound = go.round;
      c.send({ t: 'r.tap' });
      const pt = await tv.wait(function (m) { return m.t === 'rmeta' && m.round === go.round && (m.phase === 'point' || m.phase === 'end') && m.last && m.last.slot === 3; }, 2000, 'punto ' + r);
      if (pt) points++;
    }
    check(points === 3, 'Carla gana 3 rondas tocando la primera');
    const end = await tv.wait(function (m) { return m.t === 'rmeta' && m.phase === 'end'; }, 2000, 'fin');
    check(!!end && end.winner === 3 && end.scores[2] === 3, 'Fin de partida: gana Carla');
    check(!!a.find('rmeta') && a.find('rmeta').phase === 'end', 'Los móviles reciben el estado final');

    // Back to the menu; Berto leaves -> Ana (slot 1) and Carla (slot 3) remain
    tv.send({ t: 'menu' });
    await tv.wait(function (m) { return m.t === 'hub' && m.screen === 'menu'; }, 2000, 'menu');
    b.send({ t: 'leave' });
    await tv.wait(function (m) { return m.t === 'hub' && m.players[1] === null; }, 2000, 'berto sale');
    const cm = c.mark();
    a.send({ t: 'pick', game: 'pong' });
    const moved = await c.wait(function (m) { return m.t === 'joined' && m.slot === 2; }, 2000, 'compactar', cm);
    check(!!moved && moved.reconnect === true, 'Para el Pong, Carla pasa del hueco 3 al 2 (los huecos se compactan)');
    const pongHub = await tv.wait(function (m) { return m.t === 'hub' && m.screen === 'pong'; }, 2000, 'pong');
    check(!!pongHub && pongHub.players[1] && pongHub.players[1].name === 'Carla' && pongHub.players[2] === null, 'El Pong empieza con Ana y Carla');
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
  await unit();
  await integration();
  check.done();
})();
