/*
 * Hub integration test (ported from «Juegos del Salón»): starts the server
 * on a test port with accelerated timings, connects a fake TV and two fake
 * phones over WebSocket and walks through the hub, a full game of
 * «Dibuja y adivina» and Pong.
 *
 *   node test/hub.test.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const H_ = require('./helpers');
const { normalize } = require('../src/games/dibuja/match');

const PORT = parseInt(process.env.TEST_PORT, 10) || 3998;
const BASE = 'http://127.0.0.1:' + PORT;
const WS_URL = 'ws://127.0.0.1:' + PORT + '/ws';
const SPEED = 20; // DIBUJA_DEBUG_SPEED: an 80 s round = 4 real seconds
const HOME = H_.tmpHome('g2t-hub-');
const GALERIA = path.join(HOME, 'galeria');
const H = 1080, PADDLE_H = 180;

const check = H_.checker();
const sleep = H_.sleep;
const waitUntil = H_.waitUntil;
function httpReq(p, headers) { return H_.httpGet(BASE, p, headers); }
function makeClient(label) { return H_.makeClient(WS_URL, label); }
function phone(name, cid) { return H_.phone(WS_URL, name, cid); }

// Busca la palabra (como palabra completa, sin tildes) en cualquier texto del mensaje
function containsWord(msg, word) {
  const w = normalize(word);
  if (!w) return false;
  const re = new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])');
  let found = false;
  (function walk(v) {
    if (found || v == null) return;
    if (typeof v === 'string') { if (re.test(normalize(v))) found = true; return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') Object.keys(v).forEach(function (k) { if (k !== '_at') walk(v[k]); });
  })(msg);
  return found;
}

// Variante con distancia de edición = tolerancia + 1 (debe dar «¡Casi!»)
function casiVariant(word) {
  const base = normalize(word).replace(/\s+/g, '');
  const tol = base.length >= 9 ? 2 : (base.length >= 5 ? 1 : 0);
  const k = tol + 1;
  // Sustituye las k últimas letras por 'q' / 'x' distintas del original
  const arr = base.split('');
  let changed = 0;
  for (let i = arr.length - 1; i >= 0 && changed < k; i--) {
    arr[i] = arr[i] === 'q' ? 'x' : 'q';
    changed++;
  }
  return arr.join('');
}
// Variante con 1 errata (correcta si la palabra tiene >= 5 letras)
function typoVariant(word) {
  const n = normalize(word);
  const i = Math.max(1, Math.floor(n.length / 2));
  return n.slice(0, i) + n.slice(i + 1); // borra una letra
}
// Acentos en mayúsculas + artículo delante
function fancyVariant(word) {
  return 'La ' + word.toUpperCase().replace(/A/g, 'Á').replace(/E/g, 'É') + '  ';
}

// ---------------- The hub with games of 1 player (in process, fake sockets) ----------------
function fakeWs() {
  const ws = { readyState: 1, out: [], handlers: {} };
  ws.on = function (ev, fn) { ws.handlers[ev] = fn; };
  ws.send = function (s) { ws.out.push(JSON.parse(s)); };
  ws.close = function () { ws.readyState = 3; if (ws.handlers.close) ws.handlers.close(); };
  ws.msg = function (o) { ws.handlers.message(Buffer.from(JSON.stringify(o))); };
  ws.last = function (t, k) { for (let i = ws.out.length - 1; i >= 0; i--) if (ws.out[i].t === t && (!k || ws.out[i].k === k)) return ws.out[i]; return null; };
  return ws;
}
function fakeGame(id, min, max) {
  return {
    id: id,
    manifest: { id: id, title: id === 'solo' ? 'Solitario' : 'Parejas', minPlayers: min, maxPlayers: max },
    module: { create: function () { return { start: function () {}, stop: function () {}, tick: function () {}, onPlayerLeft: function () { return true; } }; } }
  };
}
function minPlayersUnit() {
  console.log('\n[Hub: juegos de 1 jugador]');
  const { createHub } = require('../src/server/hub');
  function room(list) {
    const games = { list: list, byId: {} };
    list.forEach(function (g) { games.byId[g.id] = g; });
    const hub = createHub({ games: games, log: function () {} });
    const tv = fakeWs();
    hub.onConnection(tv);
    tv.msg({ t: 'hello', role: 'tv' });
    return { hub: hub, tv: tv, join: function (name) { const p = fakeWs(); hub.onConnection(p); p.msg({ t: 'join', name: name, cid: 'c-' + name }); return p; } };
  }
  // Only games of 2 or more: as before, 1 player is not «ready»
  const r2 = room([fakeGame('pares', 2, 4)]);
  r2.join('Ana');
  check(r2.hub.minAny === 2 && r2.tv.last('hub').ready === false, 'Sin juegos de 1, con 1 jugador la sala no está lista');
  // With a game of 1: ready with one phone, and that game can start
  const r1 = room([fakeGame('pares', 2, 4), fakeGame('solo', 1, 6)]);
  const ana = r1.join('Ana');
  check(r1.hub.minAny === 1 && r1.tv.last('hub').ready === true, 'Con un juego de 1, un solo móvil ya deja la sala lista');
  ana.msg({ t: 'pick', game: 'pares' });
  const need = ana.last('ev', 'need2');
  check(!!need && need.text === '«Parejas» es de 2 a 4 jugadores: falta 1 jugador. Escanead el QR.', 'El juego de 2 sigue pidiendo 2: «' + (need && need.text) + '»');
  r1.tv.msg({ t: 'pick', game: 'solo' });
  check(r1.tv.last('hub').screen === 'solo', 'El juego de 1 empieza con 1 (elegido con el mando)');
  // Somebody else joins and leaves: the game goes on; the last one leaves: menu
  const berto = r1.join('Berto');
  berto.msg({ t: 'leave' });
  check(r1.tv.last('hub').screen === 'solo' && r1.tv.last('ev', 'left').name === 'Berto', 'Se va uno de 2: el juego de 1 sigue');
  ana.msg({ t: 'leave' });
  const back = r1.tv.last('ev', 'menu');
  check(r1.tv.last('hub').screen === 'menu' && !!back && back.text === 'Ana se ha ido y no queda nadie jugando a «Solitario». Volvemos al menú.', 'Se va la última: al menú («' + (back && back.text) + '»)');
  // Nobody in the room: even the game of 1 says what is missing
  r1.tv.msg({ t: 'pick', game: 'solo' });
  const need0 = r1.tv.last('ev', 'need2');
  check(!!need0 && /^«Solitario» es de 1 a 6 jugadores: falta 1 jugador\./.test(need0.text), 'Sala vacía: «' + (need0 && need0.text) + '»');
  r1.hub.stop();
  r2.hub.stop();
}

async function main() {
  minPlayersUnit();
  console.log('Arrancando servidor de pruebas en el puerto ' + PORT + '...');
  const startedAt = Date.now();
  let before = [];
  try { before = fs.readdirSync(GALERIA); } catch (e) { before = []; }
  const srvState = await H_.startServer({
    GAME_TO_TV_HOME: HOME,
    PORT: String(PORT), HOST_IP: '192.168.1.50', SLOT_HOLD_MS: '4000',
    PONG_DEBUG_SPEED: '3', POINTS_TO_WIN: '3', DIBUJA_DEBUG_SPEED: String(SPEED), DIBUJA_ROUNDS: '8'
  }, ['--jugadores', '2']); // the classic room for two (the default is 6: see test/grupo.test.js)
  let srvOut = srvState.out;
  const clients = [];
  let createdPngs = [];
  // Si la salida se corta (p. ej. «| head»), que no se quede el servidor vivo
  process.stdout.on('error', function () { /* EPIPE: se ignora */ });

  try {
    srvOut = srvState.out;
    check(/escuchando/.test(srvOut), 'El servidor arranca e imprime las URLs');
    check(srvOut.indexOf('http://192.168.1.50:' + PORT + '/m') >= 0, 'HOST_IP se usa en la URL del móvil');

    // ---------------- HTTP ----------------
    console.log('\n[HTTP]');
    const rTv = await httpReq('/');
    check(rTv.status === 200 && /text\/html/.test(rTv.type) && /id="stage"/.test(rTv.body), 'GET / -> 200 (página de la tele)');
    const rM = await httpReq('/m');
    check(rM.status === 200 && /text\/html/.test(rM.type) && /id="scrJoin"/.test(rM.body), 'GET /m -> 200 (página del móvil)');
    await sleep(200);
    const qr = await httpReq('/qr.svg');
    check(qr.status === 200 && /image\/svg\+xml/.test(qr.type) && /<svg[\s\S]*<\/svg>/.test(qr.body), 'GET /qr.svg -> 200 SVG');
    const r1 = await httpReq('/tv?lite=1');
    check(r1.status === 302 && r1.headers.location === '/?lite=1', 'GET /tv -> redirección a / (conserva ?lite=1)');
    const r2 = await httpReq('/mando');
    check(r2.status === 302 && r2.headers.location === '/m', 'GET /mando -> redirección a /m');
    const inf = await httpReq('/info');
    check(inf.status === 200 && JSON.parse(inf.body).movil === 'http://192.168.1.50:' + PORT + '/m', 'GET /info apunta a /m');
    const ka = await httpReq('/keepalive.mp4');
    check(ka.status === 200 && /video\/mp4/.test(ka.type) && ka.buf.length > 500, 'GET /keepalive.mp4 -> vídeo');
    const kar = await httpReq('/keepalive.mp4', { Range: 'bytes=0-99' });
    check(kar.status === 206 && kar.buf.length === 100, 'Vídeo con Range -> 206');
    const gal = await httpReq('/galeria');
    check(gal.status === 200 && /Galería/.test(gal.body), 'GET /galeria -> 200');
    check((await httpReq('/no-existe')).status === 404, 'GET /no-existe -> 404');
    check((await httpReq('/galeria/..%2Fserver.js')).status === 404, 'La galería no deja salir de su carpeta');

    // ---------------- Hub: entrada y huecos ----------------
    console.log('\n[Hub: entrada]');
    const tv = makeClient('tele'); clients.push(tv);
    await tv.ready;
    tv.send({ t: 'hello', role: 'tv' });
    await waitUntil(function () { return tv.find('info') && tv.hub; }, 2000, 'info tele');
    check(tv.find('info') && /\/m$/.test(tv.find('info').url), 'La tele recibe la URL del móvil (/m)');
    check(tv.hub && tv.hub.screen === 'menu', 'Pantalla inicial: menú');

    const p1 = await phone('Ana', 'cid-ana'); clients.push(p1);
    check(p1.find('joined') && p1.find('joined').slot === 1 && p1.find('joined').color === '#22e6ff', 'Ana: hueco 1, cian');
    check(p1.find('d.words') && Array.isArray(p1.find('d.words').list), 'Ana recibe su lista de palabras secretas');

    // Con un solo jugador no se puede elegir juego
    p1.send({ t: 'pick', game: 'dibuja' });
    const need2 = await p1.wait(function (m) { return m.t === 'ev' && m.k === 'need2'; }, 1000, 'need2');
    check(!!need2 && tv.hub.screen === 'menu', 'Con 1 jugador no se puede elegir juego');
    const tvNeed = await tv.wait(function (m) { return m.t === 'ev' && m.k === 'need2'; }, 1000, 'need2 tele');
    check(!!tvNeed && /^«Dibuja y adivina» es (para|de) 2 .*jugadores: falta 1 jugador\. Escanead el QR\.$/.test(tvNeed.text) && tvNeed.by === 1,
      'La tele también recibe el motivo, en español: «' + (tvNeed && tvNeed.text) + '»');

    const p2 = await phone('Bernardo_con_nombre_largo', 'cid-berto'); clients.push(p2);
    check(p2.find('joined') && p2.find('joined').slot === 2 && p2.find('joined').color === '#ff3df2', 'El segundo móvil: hueco 2, magenta');
    check(p2.find('joined').name === 'Bernardo_con', 'El nombre se recorta a 12 caracteres');
    const p3 = await phone('Intruso', 'cid-intruso'); clients.push(p3);
    check(!!p3.find('full') && !p3.find('joined'), 'Un tercer móvil recibe «lleno»');
    await p3.close();
    await waitUntil(function () { return tv.hub.ready; }, 1000, 'ready');
    check(tv.hub.ready && tv.hub.players[0].name === 'Ana' && tv.hub.players[1].connected, 'La tele ve a los 2 jugadores listos');

    // Palabras secretas
    const p1Words = ['Xilofonazo', 'gato'];         // para cuando dibuje Berto
    const p2Words = ['Zorrocotroco', 'abuela feliz', 'zorrocotroco', '<b>', 'x']; // para cuando dibuje Ana (dups e inválidas fuera)
    p1.send({ t: 'd.words', list: p1Words });
    p2.send({ t: 'd.words', list: p2Words });
    const w2 = await p2.wait(function (m) { return m.t === 'd.words' && m.list.length === 2; }, 1000, 'words p2');
    check(w2 && w2.list[0] === 'Zorrocotroco' && w2.list[1] === 'abuela feliz', 'Palabras secretas limpiadas (sin duplicados ni basura)');
    p2.send({ t: 'd.words', list: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12'] });
    const w2b = await p2.wait(function (m) { return m.t === 'd.words' && m.list.length === 10; }, 1000, 'words max');
    check(!!w2b, 'Máximo 10 palabras secretas');
    p2.send({ t: 'd.words', list: ['Zorrocotroco', 'abuela feliz'] });
    await p2.wait(function (m) { return m.t === 'd.words' && m.list.length === 2; }, 1000, 'words p2 again', p2.msgs.length - 1);
    await waitUntil(function () { return tv.hub.players[1].badges[0] === '2 palabras secretas'; }, 1000, 'tv words count');
    check(tv.hub.players[1].badges[0] === '2 palabras secretas' && !containsWord(tv.hub, 'Zorrocotroco'), 'La tele ve cuántas palabras hay, pero no cuáles');

    // ---------------- Dibuja y adivina ----------------
    console.log('\n[Menú -> Dibuja y adivina]');
    const tvMark0 = tv.mark();
    p1.send({ t: 'pick', game: 'dibuja' });
    const hubD = await tv.wait(function (m) { return m.t === 'hub' && m.screen === 'dibuja'; }, 2000, 'screen dibuja', tvMark0);
    check(hubD && hubD.pick && hubD.pick.by === 1 && hubD.pick.name === 'Ana', 'Ana elige «Dibuja y adivina» y la tele sabe quién lo eligió');

    const phones = { 1: p1, 2: p2 };
    const customOf = { 1: ['zorrocotroco', 'abuela feliz'], 2: ['xilofonazo', 'gato'] }; // palabras que puede ver cada dibujante
    let prevDrawer = 0;
    let lastScore = 0;
    let alternated = true;
    let customSeenFor = { 1: 0, 2: 0 };
    let customWrong = false;
    const words = [];

    for (let round = 1; round <= 8; round++) {
      console.log('\n[Ronda ' + round + ']');
      const intro = await tv.wait(function (m) { return m.t === 'dmeta' && m.round === round && (m.phase === 'intro' || m.phase === 'choose'); }, 8000, 'ronda ' + round);
      if (!check(!!intro, 'Empieza la ronda ' + round)) break;
      const drawerSlot = intro.drawer;
      const D = phones[drawerSlot];
      const G = phones[3 - drawerSlot];
      if (prevDrawer && prevDrawer === drawerSlot) alternated = false;
      prevDrawer = drawerSlot;
      const gMark = G.msgs.findIndex(function (m) { return m === intro; });
      const gStart = G.msgs.length > 0 ? Math.max(0, G.msgs.length - 3) : 0;
      const tvStart = tv.msgs.indexOf(intro);
      const dStart = D.msgs.length > 0 ? Math.max(0, D.msgs.length - 3) : 0;
      void gMark;

      const optsMsg = await D.wait(function (m) { return m.t === 'd.opts' && m.round === round; }, 3000, 'opciones', dStart);
      if (!check(!!optsMsg && optsMsg.opts.length === 3, 'El que dibuja recibe 3 opciones')) break;
      const diffs = optsMsg.opts.map(function (o) { return o.diff; });
      const customs = optsMsg.opts.filter(function (o) { return o.custom; });
      if (round <= 2) check(diffs[0] === 'facil' && diffs[2] === 'dificil' && (diffs[1] === 'media'), 'Dificultades mezcladas: fácil / media / difícil (' + diffs.join(', ') + ')');
      if (customs.length > 1) customWrong = true;
      customs.forEach(function (o) {
        if (customOf[drawerSlot].indexOf(normalize(o.word)) >= 0) customSeenFor[drawerSlot]++;
        else customWrong = true;
      });

      // Elegir palabra (en la ronda 5 se deja que el tiempo elija)
      let pickIdx = round === 5 ? -1 : (round === 3 ? 2 : (round % 3));
      if (round === 1 && customs.length) pickIdx = optsMsg.opts.indexOf(customs[0]);
      if (pickIdx >= 0) D.send({ t: 'd.pick', i: pickIdx });
      const sec = await D.wait(function (m) { return m.t === 'd.secret' && m.round === round; }, 3000, 'palabra secreta', dStart);
      if (!check(!!sec, 'El que dibuja recibe la palabra secreta' + (pickIdx < 0 ? ' (elegida al azar al agotarse los 15 s)' : ''))) break;
      if (pickIdx < 0) check(optsMsg.opts.some(function (o) { return o.word === sec.word; }), 'La palabra al azar es una de las 3 opciones');
      else check(sec.word === optsMsg.opts[pickIdx].word, 'La palabra secreta es la elegida: «' + sec.word + '»');
      let word = sec.word;
      const drawStart = await tv.wait(function (m) { return m.t === 'dmeta' && m.round === round && m.phase === 'draw'; }, 3000, 'fase draw', tvStart);
      check(!!drawStart && drawStart.hint && drawStart.hint.replace(/[^_]/g, '').length === drawStart.letters, 'Pista inicial: todas las letras ocultas (' + (drawStart && drawStart.hint) + ', ' + (drawStart && drawStart.letters) + ' letras)');

      if (round === 1) {
        // -------- Trazos: relay, undo, clear --------
        const tvM = tv.mark();
        D.send({ t: 'd.s', id: 1, c: '#e53935', w: 0.018, p: [0.1, 0.1, 0.2, 0.15], end: 0 });
        D.send({ t: 'd.s', id: 1, c: '#e53935', w: 0.018, p: [0.3, 0.2, 0.4, 0.3], end: 1 });
        D.send({ t: 'd.s', id: 2, c: '#1e88e5', w: 0.04, p: [0.5, 0.5, 0.6, 0.6, 5, -3], end: 1 });
        const relayed = await tv.wait(function (m) { return m.t === 'd.s' && m.id === 2; }, 1000, 'trazo 2', tvM);
        const parts = tv.since(tvM, 'd.s');
        check(parts.length === 3 && parts[0].id === 1 && parts[0].p.length === 4 && parts[1].p[0] === 0.3, 'La tele recibe los trazos en directo (3 lotes)');
        check(relayed && relayed.p[4] === 1 && relayed.p[5] === 0 && relayed.c === '#1e88e5', 'Puntos normalizados y limitados a 0..1');
        check(G.since(gStart, 'd.s').length === 0, 'El que adivina NO recibe el dibujo');
        D.send({ t: 'd.undo', id: 2 });
        const und = await tv.wait(function (m) { return m.t === 'd.undo'; }, 1000, 'undo', tvM);
        check(und && und.id === 2, 'Deshacer se reenvía a la tele');
        D.send({ t: 'd.clear' });
        const clr = await tv.wait(function (m) { return m.t === 'd.clear'; }, 1000, 'clear', tvM);
        check(!!clr, 'Borrar todo se reenvía a la tele');
        // Dibujo final para el PNG
        const pts = [];
        for (let i = 0; i <= 40; i++) pts.push(0.2 + 0.6 * i / 40, 0.5 + 0.3 * Math.sin(i / 4));
        D.send({ t: 'd.s', id: 3, c: '#43a047', w: 0.018, p: pts, end: 1 });
        D.send({ t: 'd.s', id: 4, c: '#1a1a1a', w: 0.008, p: [0.5, 0.2], end: 1 });
        await tv.wait(function (m) { return m.t === 'd.s' && m.id === 4; }, 1000, 'trazo 4', tvM);

        // Una tele que se reconecta recibe todo el dibujo
        const tv2 = makeClient('tele2'); clients.push(tv2);
        await tv2.ready;
        tv2.send({ t: 'hello', role: 'tv' });
        const all = await tv2.wait(function (m) { return m.t === 'd.all'; }, 1000, 'd.all');
        check(all && all.strokes.length === 2 && all.strokes[0].id === 3 && all.strokes[0].p.length === 82, 'Una tele nueva recibe la lista completa de trazos (tras undo y clear)');
        await tv2.close();

        // -------- Intentos: no, casi, correcto con tildes/artículo/errata --------
        const gM = G.mark();
        G.send({ t: 'd.guess', text: 'qqqqqqqq zzz' });
        const no = await G.wait(function (m) { return m.t === 'd.g'; }, 1000, 'no', gM);
        check(no && no.res === 'no', 'Intento erróneo -> «No»');
        await sleep(200);
        const casi = casiVariant(word);
        G.send({ t: 'd.guess', text: casi });
        const ca = await G.wait(function (m) { return m.t === 'd.g' && m.res !== 'no'; }, 1000, 'casi', gM);
        check(ca && ca.res === 'casi', 'Intento cercano «' + casi + '» -> «¡Casi!»');
        const tvCasi = await tv.wait(function (m) { return m.t === 'dmeta' && m.guesses && m.guesses.some(function (g) { return g.res === 'casi'; }); }, 1000, 'casi en tele');
        check(!!tvCasi && !!D.since(dStart, 'd.g').length, 'La tele y el que dibuja ven los intentos');
        await sleep(200);
        // Palabra secreta personalizada (si se eligió) o normal: con artículo, mayúsculas y tildes
        const fancy = fancyVariant(word);
        G.send({ t: 'd.guess', text: fancy });
      } else if (round === 2) {
        // -------- Pistas al 50 % y al 75 %, y tiempo agotado --------
        const t0 = drawStart._at;
        const h1 = await tv.wait(function (m) { return m.t === 'd.hint' && m.n === 1; }, 5000, 'pista 1', tvStart);
        const m1 = await tv.wait(function (m) { return m.t === 'dmeta' && m.phase === 'draw' && m.round === round && m.hint && m.hint.replace(/[^_]/g, '').length === drawStart.letters - 1; }, 1000, 'meta pista 1', tvStart);
        const h2 = await tv.wait(function (m) { return m.t === 'd.hint' && m.n === 2; }, 5000, 'pista 2', tvStart);
        const total = 80000 / SPEED;
        const f1 = h1 ? (h1._at - t0) / total : -1;
        const f2 = h2 ? (h2._at - t0) / total : -1;
        check(h1 && Math.abs(f1 - 0.5) < 0.1, 'Pista 1 al 50 % del tiempo (' + Math.round(f1 * 100) + ' %)');
        check(h2 && Math.abs(f2 - 0.75) < 0.1, 'Pista 2 al 75 % del tiempo (' + Math.round(f2 * 100) + ' %)');
        check(!!m1, 'La pista desvela una letra en la tele: ' + (m1 && m1.hint));
        const gHint = await G.wait(function (m) { return m.t === 'dmeta' && m.hint && m.hint.replace(/[^_]/g, '').length <= drawStart.letters - 2; }, 1000, 'pista en móvil', gStart);
        check(!!gHint, 'El que adivina ve las letras desveladas: ' + (gHint && gHint.hint));
      } else if (round === 3) {
        // -------- Pasar palabra (1 por ronda) --------
        D.send({ t: 'd.s', id: 1, c: '#1a1a1a', w: 0.018, p: [0.1, 0.1, 0.9, 0.9], end: 1 });
        await sleep(50);
        const dM = D.mark();
        const tvM = tv.mark();
        D.send({ t: 'd.skip' });
        const ns = await D.wait(function (m) { return m.t === 'd.secret'; }, 1000, 'nueva palabra', dM);
        check(ns && ns.word !== word && ns.skipsLeft === 0 && ns.diff === sec.diff, 'Pasar palabra: nueva palabra de la misma dificultad (' + (ns && ns.word) + ')');
        check(!!(await tv.wait(function (m) { return m.t === 'd.clear'; }, 1000, 'clear skip', tvM)), 'Al pasar palabra se limpia el dibujo de la tele');
        words.push({ word: word, skipped: true });
        word = ns.word;
        const dM2 = D.mark();
        D.send({ t: 'd.skip' });
        await sleep(150);
        check(D.since(dM2, 'd.secret').length === 0, 'Solo se puede pasar palabra una vez por ronda');

        // -------- Pausa si se desconecta un jugador --------
        D.send({ t: 'd.s', id: 1, c: '#8e24aa', w: 0.018, p: [0.3, 0.3, 0.6, 0.4], end: 1 });
        await sleep(50);
        await G.close();
        const paused = await tv.wait(function (m) { return m.t === 'dmeta' && m.paused; }, 1000, 'pausa', tvM);
        check(paused && paused.waiting.indexOf(G.label === 'Ana' ? 'Ana' : 'Bernardo_con') >= 0, 'Al desconectarse el que adivina: pausa y «Esperando a ' + (paused && paused.waiting.join(',')) + '»');
        const leftA = paused ? paused.left : 0;
        await sleep(600);
        check(tv.dmeta.paused && Math.abs(tv.dmeta.left - leftA) < 30, 'En pausa el reloj no corre (' + leftA + ' -> ' + tv.dmeta.left + ' ms)');
        const G2 = await phone(G.label, G.label === 'Ana' ? 'cid-ana' : 'cid-berto'); clients.push(G2);
        phones[3 - drawerSlot] = G2;
        check(G2.find('joined') && G2.find('joined').reconnect === true && G2.find('joined').slot === 3 - drawerSlot, 'Reconecta con el mismo hueco');
        const resumed = await tv.wait(function (m) { return m.t === 'dmeta' && !m.paused && m.phase === 'draw'; }, 1000, 'reanuda', tv.msgs.indexOf(paused));
        check(!!resumed, 'Se reanuda al volver');
        check(!!(await G2.wait(function (m) { return m.t === 'dmeta' && m.phase === 'draw'; }, 1000, 'dmeta reconexión')), 'El móvil reconectado recibe el estado de la ronda');
        check(G2.since(0, 'd.secret').length === 0 && G2.since(0, 'd.opts').length === 0, 'El que adivina reconectado no recibe la palabra');
        // El que dibuja también puede reconectar y recupera palabra y dibujo
        await D.close();
        await tv.wait(function (m) { return m.t === 'dmeta' && m.paused; }, 1000, 'pausa 2', tv.msgs.indexOf(resumed));
        const D2 = await phone(D.label, D.label === 'Ana' ? 'cid-ana' : 'cid-berto'); clients.push(D2);
        phones[drawerSlot] = D2;
        const sec2 = await D2.wait(function (m) { return m.t === 'd.secret'; }, 1000, 'secret reconexión');
        const all2 = await D2.wait(function (m) { return m.t === 'd.all'; }, 1000, 'all reconexión');
        check(sec2 && sec2.word === word && all2 && all2.strokes.length === 1, 'El que dibuja reconectado recupera su palabra y su dibujo');
        await tv.wait(function (m) { return m.t === 'dmeta' && !m.paused; }, 1000, 'reanuda 2', tv.msgs.length - 1);
        await sleep(100);
        G2.send({ t: 'd.guess', text: word });
      } else if (round === 4 || round >= 6) {
        // Errata tolerada (o exacta si la palabra es corta)
        const n = normalize(word).replace(/\s+/g, '').length;
        G.send({ t: 'd.guess', text: n >= 5 ? typoVariant(word) : word });
      } else {
        await sleep(100);
        phones[3 - drawerSlot].send({ t: 'd.guess', text: word });
      }

      const Gnow = phones[3 - drawerSlot];
      const rev = await tv.wait(function (m) { return m.t === 'd.reveal' && m.round === round; }, 8000, 'reveal', tvStart);
      if (!check(!!rev, 'Se desvela la palabra')) break;
      if (round === 2) {
        check(rev.ok === false && rev.points === 0 && rev.word === word, 'Tiempo agotado: «Era: ' + rev.word + '» y 0 puntos');
      } else {
        const expected = 100 + 3 * rev.secsLeft + (rev.diff === 'dificil' ? 75 : (rev.diff === 'media' ? 25 : 0));
        check(rev.ok === true && rev.points === expected && rev.points >= 100, 'Acierto: +' + rev.points + ' puntos (100 + 3×' + rev.secsLeft + ' s + bonus ' + rev.diff + ')');
        check(rev.score === lastScore + rev.points, 'La puntuación del equipo sube a ' + rev.score);
      }
      lastScore = rev.score;
      words.push({ word: word, round: round });

      // Ningún mensaje de la tele ni del que adivina contiene la palabra antes de desvelarla
      const tvBefore = tv.msgs.slice(tvStart, tv.msgs.indexOf(rev));
      const gRev = await Gnow.wait(function (m) { return m.t === 'd.reveal' && m.round === round; }, 2000, 'reveal adivina');
      const gList = Gnow.msgs.slice(Gnow === G ? gStart : 0, Gnow.msgs.indexOf(gRev));
      const leakTv = tvBefore.filter(function (m) { return containsWord(m, word); });
      const leakG = gList.filter(function (m) { return containsWord(m, word); });
      const badTypes = tvBefore.concat(gList).filter(function (m) { return m.t === 'd.opts' || m.t === 'd.secret'; });
      check(!leakTv.length && !leakG.length && !badTypes.length,
        'Ni la tele ni el que adivina reciben «' + word + '» antes de desvelarla (' + tvBefore.length + ' + ' + gList.length + ' mensajes revisados)' +
        (leakTv.length || leakG.length ? ' FUGA: ' + JSON.stringify(leakTv.concat(leakG)[0]).slice(0, 200) : ''));
    }

    console.log('\n[Fin de partida]');
    check(alternated, 'El que dibuja se alterna en cada ronda');
    check(customSeenFor[1] + customSeenFor[2] >= 2 && !customWrong, 'Las palabras secretas salen solo al dibujante correcto, máx. 1 por terna (Ana: ' + customSeenFor[1] + ', Berto: ' + customSeenFor[2] + ')');
    const endMeta = await tv.wait(function (m) { return m.t === 'dmeta' && m.phase === 'end'; }, 4000, 'fin');
    const galleryMsg = await tv.wait(function (m) { return m.t === 'd.gallery'; }, 2000, 'galería');
    check(endMeta && endMeta.history.length === 8 && endMeta.score === lastScore, '8 rondas y fin: ' + (endMeta && endMeta.score) + ' puntos');
    const RATINGS = require('../src/games/dibuja').RATINGS.map(function (r) { return r.title; });
    check(endMeta && endMeta.rating && RATINGS.indexOf(endMeta.rating.title) >= 0, 'Título final: «' + (endMeta && endMeta.rating && endMeta.rating.title) + '»');
    check(galleryMsg && galleryMsg.items.length === 8 && galleryMsg.items[0].strokes.length === 2 && galleryMsg.items.every(function (it) { return it.word; }), 'La tele recibe la galería con los 8 dibujos y sus palabras');
    const anyPhoneGallery = p1.find('d.gallery') || p2.find('d.gallery');
    check(!anyPhoneGallery, 'Los móviles no reciben los trazos de la galería');
    const usedWords = words.filter(function (w) { return !w.skipped; }).map(function (w) { return normalize(w.word); });
    check(new Set(usedWords).size === usedWords.length, 'Sin palabras repetidas en la partida');

    // PNG en galeria/
    const pngs = await waitUntil(function () {
      let now = [];
      try { now = fs.readdirSync(GALERIA); } catch (e) { return null; }
      const fresh = now.filter(function (f) { return before.indexOf(f) < 0 && /\.png$/.test(f); });
      return fresh.length >= 8 ? fresh : null;
    }, 8000, 'PNG');
    createdPngs = pngs || [];
    check(pngs && pngs.length === 8, 'Se guardan 8 PNG en la galería (' + GALERIA + ')');
    if (pngs) {
      const okNames = pngs.every(function (f) { return /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_[1-8]_[a-z0-9-]+\.png$/.test(f); });
      check(okNames, 'Nombres AAAA-MM-DD_HH-MM_<ronda>_<palabra>.png (p. ej. ' + pngs.sort()[0] + ')');
      const r1png = pngs.filter(function (f) { return /_1_/.test(f); })[0];
      const headersOk = pngs.every(function (f) {
        const b = fs.readFileSync(path.join(GALERIA, f));
        return b.slice(0, 8).toString('hex') === '89504e470d0a1a0a' && b.readUInt32BE(16) === 800 && b.readUInt32BE(20) === 600;
      });
      check(headersOk, 'Los PNG tienen cabecera válida y miden 800x600');
      if (r1png) {
        const { PNG } = require('pngjs');
        const img = PNG.sync.read(fs.readFileSync(path.join(GALERIA, r1png)));
        let green = 0;
        for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 1] > 120 && img.data[i] < 100 && img.data[i + 2] < 100) green++;
        check(green > 1000, 'El PNG de la ronda 1 contiene el trazo verde (' + green + ' píxeles)');
      }
      const galPage = await httpReq('/galeria');
      check(galPage.body.indexOf(pngs[0]) >= 0, 'La página /galeria lista los dibujos');
    }

    // Jugar otra vez -> Menú
    console.log('\n[Otra vez / Menú]');
    const pa = phones[1], pb = phones[2];
    const tvM2 = tv.mark();
    pa.send({ t: 'd.again' });
    const again = await tv.wait(function (m) { return m.t === 'dmeta' && m.round === 1 && m.phase !== 'end'; }, 2000, 'otra vez', tvM2);
    check(!!again && again.score === 0, '«Jugar otra vez» empieza una partida nueva');
    pb.send({ t: 'menu' });
    const backMenu = await tv.wait(function (m) { return m.t === 'hub' && m.screen === 'menu'; }, 2000, 'menú', tvM2);
    check(!!backMenu, '«Menú» desde un móvil devuelve a todos al menú');
    check(pa.hub.screen === 'menu' && pb.hub.screen === 'menu' && pb.hub.players[0] && pb.hub.players[1], 'Los jugadores siguen dentro tras volver al menú');

    // ---------------- Pong en el hub ----------------
    console.log('\n[Pong]');
    const tvM3 = tv.mark();
    tv.send({ t: 'pick', game: 'pong' });
    const hubP = await tv.wait(function (m) { return m.t === 'hub' && m.screen === 'pong'; }, 2000, 'screen pong', tvM3);
    check(hubP && hubP.pick.by === 0 && hubP.pick.name === 'la tele', 'Pong elegido con el mando de la tele');
    const cd = await tv.wait(function (m) { return m.t === 'pmeta' && m.phase === 'countdown'; }, 2000, 'countdown', tvM3);
    check(!!cd, 'Cuenta atrás');
    const pl = await tv.wait(function (m) { return m.t === 'pmeta' && m.phase === 'playing'; }, 3000, 'playing', tvM3);
    check(!!pl && pa.pmeta && pa.pmeta.phase === 'playing', 'Se juega y los móviles reciben la fase');
    const b0 = tv.state.b.slice();
    await sleep(120);
    check(Math.hypot(tv.state.b[0] - b0[0], tv.state.b[1] - b0[1]) > 5, 'La bola se mueve');
    // Movimiento inmediato de la pala (mensaje 'p')
    const tvM4 = tv.mark();
    const tSend = Date.now();
    pa.send({ t: 'm', y: 0 });
    const pmsg = await tv.wait(function (m) { return m.t === 'p' && m.i === 0; }, 500, 'p', tvM4);
    check(pmsg && pmsg._at - tSend < 50, 'La tele recibe la pala al instante (' + (pmsg ? pmsg._at - tSend : '?') + ' ms)');
    await sleep(120);
    check(Math.abs(tv.state.p[0] - PADDLE_H / 2) < 1, 'Pala 1 arriba con y=0');

    // Bots: Ana sigue la bola, Berto se aparta -> gana Ana
    const bot = setInterval(function () {
      const s = tv.state;
      if (!s) return;
      const y = Math.max(0, Math.min(1, (s.b[1] + s.b[3] * 0.03 - PADDLE_H / 2) / (H - PADDLE_H)));
      try { pa.send({ t: 'm', y: y }); pb.send({ t: 'm', y: s.b[1] < H / 2 ? 1 : 0 }); } catch (e) { /* noop */ }
    }, 16);
    const over = await tv.wait(function (m) { return m.t === 'pmeta' && m.phase === 'gameover'; }, 60000, 'gameover', tvM3);
    clearInterval(bot);
    check(over && over.winner === 1 && over.score[0] === 3, 'El Pong puntúa y termina: ' + (over && over.score.join('-')));
    const rm = tv.mark();
    pb.send({ t: 'rematch' });
    check(!!(await tv.wait(function (m) { return m.t === 'pmeta' && m.phase === 'countdown' && m.score[0] === 0; }, 2000, 'revancha', rm)), '¡Revancha! reinicia el Pong');
    tv.send({ t: 'menu' });
    check(!!(await tv.wait(function (m) { return m.t === 'hub' && m.screen === 'menu'; }, 2000, 'menú desde tele', rm)), 'La tele (Atrás + confirmar) vuelve al menú');

    // ---------------- Caducidad del hueco ----------------
    console.log('\n[Hueco]');
    pa.send({ t: 'pick', game: 'dibuja' });
    await tv.wait(function (m) { return m.t === 'hub' && m.screen === 'dibuja'; }, 2000, 'dibuja 2', rm);
    const hm = tv.mark();
    await pb.close();
    const freed = await tv.wait(function (m) { return m.t === 'hub' && m.players[1] === null; }, 7000, 'hueco liberado', hm);
    check(!!freed && freed.screen === 'menu', 'Si no vuelve en SLOT_HOLD_MS se libera el hueco y se vuelve al menú');
    pa.send({ t: 'leave' });
    check(!!(await tv.wait(function (m) { return m.t === 'hub' && m.players[0] === null; }, 2000, 'leave', hm)), '«Salir» libera el hueco al momento');
    srvOut = srvState.out;
    check(!/Error/.test(srvOut), 'Sin errores en el registro del servidor');
  } catch (e) {
    check.fail('Excepción: ' + (e && e.stack || e));
  } finally {
    clients.forEach(function (c) { try { c.ws.terminate(); } catch (e) { /* noop */ } });
    await srvState.stop();
    void createdPngs;
    H_.rmrf(HOME);
    console.log('\nServidor detenido. (' + Math.round((Date.now() - startedAt) / 1000) + ' s)');
    if (check.counts().failed) console.log('\n--- Registro del servidor ---\n' + srvState.out.split('\n').slice(-40).join('\n'));
  }
  check.done();
}

main();
