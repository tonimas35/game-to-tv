'use strict';
/*
 * «Rivales bot» in the hub: adding and removing bots (names, levels, a full
 * room, only from the menu, only phones), bots counting as players
 * (minPlayers/maxPlayers, «ready»), games without bots disabled, a bot's
 * messages reaching the game as from its phone (next tick, never re-entrant),
 * what the bots see (TV + own phone, ONE JSON.parse per message for all of
 * them, nothing at all without bots), lifecycle (created at start, stopped
 * on the menu, kept in the room between games), bots leaving with the last
 * human, a reconnecting human keeping their slot, the manifest checks and,
 * at the end, the real server: a phone adds a bot and plays «Tanques» with it.
 */
const fs = require('fs');
const path = require('path');
const H_ = require('./helpers');
const { createHub } = require('../src/server/hub');
const Bots = require('../src/server/bots');
const { loadGames, publicManifests, GAMES_DIR } = require('../src/games');
const Kit = require('../src/games/bot-kit');
const check = H_.checker('Rivales bot');

// ---------------------------------------------------------------- fakes
function fakeWs() {
  const ws = { readyState: 1, out: [], handlers: {} };
  ws.on = function (ev, fn) { ws.handlers[ev] = fn; };
  ws.send = function (s) { ws.out.push(JSON.parse(s)); };
  ws.close = function () { ws.readyState = 3; if (ws.handlers.close) ws.handlers.close(); };
  ws.msg = function (o) { ws.handlers.message(Buffer.from(JSON.stringify(o))); };
  ws.last = function (t, k) { for (let i = ws.out.length - 1; i >= 0; i--) if (ws.out[i].t === t && (!k || ws.out[i].k === k)) return ws.out[i]; return null; };
  ws.all = function (t, k) { return ws.out.filter(function (m) { return m.t === t && (!k || m.k === k); }); };
  return ws;
}

// A game that broadcasts a meta at start, sends a TV state every 2 ticks and a
// private message to each player, and keeps what it receives
const created = [];
function fakeGame(id, min, max, opts) {
  opts = opts || {};
  const g = {
    id: id,
    manifest: { id: id, title: opts.title || id, minPlayers: min, maxPlayers: max, bots: !!opts.bot, botLevels: opts.botLevels || Bots.LEVEL_IDS.slice() },
    module: {
      create: function (api) {
        let ticks = 0;
        const G = {
          id: id, got: [], api: api, stopped: false,
          start: function () { api.broadcast({ t: 'fz.meta', game: id }); api.players().forEach(function (i) { api.sendSlot(i, { t: 'fz.you', slot: i + 1 }); }); },
          stop: function () { G.stopped = true; },
          tick: function () { ticks++; if (ticks % 2 === 0 && api.tvs.size) api.sendTvs(JSON.stringify({ t: 'fz.s', n: ticks })); },
          onMessage: function (who, msg) { G.got.push({ who: who, msg: msg, tick: ticks }); },
          onPlayerLeft: function () { return true; }
        };
        created.push(G);
        return G;
      }
    },
    bot: opts.bot || null
  };
  return g;
}
// A bot that keeps what it sees and sends { t: 'fz.in', n } on every tick
const botsMade = [];
const fakeBot = {
  create: function (ctx) {
    const b = { ctx: ctx, tv: [], slot: [], ticks: 0, stopped: false };
    b.onTv = function (m) { b.tv.push(m); };
    b.onSlot = function (m) { b.slot.push(m); };
    b.tick = function (dt) {
      b.ticks++;
      b.dt = dt;
      ctx.send({ t: 'fz.in', n: b.ticks, from: ctx.name });
      if (b.ticks === 1) { ctx.send({ t: 'menu' }); ctx.send({ t: 'pick', game: 'otro' }); ctx.send({ t: 'bot.add', level: 'facil' }); }
    };
    b.stop = function () { b.stopped = true; };
    botsMade.push(b);
    return b;
  }
};

function room(list, slots) {
  const games = { list: list, byId: {} };
  list.forEach(function (g) { games.byId[g.id] = g; });
  const logs = [];
  const hub = createHub({ games: games, log: function (s) { logs.push(s); }, maxPlayers: slots || 6, slotHoldMs: 1000, random: Kit.seeded(3) });
  const tv = fakeWs();
  hub.onConnection(tv);
  tv.msg({ t: 'hello', role: 'tv' });
  return {
    hub: hub, tv: tv, logs: logs,
    join: function (name, cid) { const p = fakeWs(); hub.onConnection(p); p.msg({ t: 'join', name: name, cid: cid || ('c-' + name) }); return p; },
    players: function () { return tv.last('hub').players; },
    bots: function () { return tv.last('hub').players.filter(function (p) { return p && p.bot; }); }
  };
}

// ---------------------------------------------------------------- levels and names
function levelsAndNames() {
  console.log('\n[Niveles y nombres]');
  check(Bots.LEVELS.map(function (l) { return l.id + ':' + l.label + ':' + l.value; }).join(' ') === 'facil:Fácil:0.25 normal:Normal:0.5 dificil:Difícil:0.75 imposible:Imposible:1',
    'Cuatro niveles: Fácil 0,25 · Normal 0,5 · Difícil 0,75 · Imposible 1');
  check(Bots.NAMES.length >= 40 && new Set(Bots.NAMES).size === Bots.NAMES.length && Bots.NAMES.every(function (n) { return n.length <= 12; }),
    Bots.NAMES.length + ' nombres distintos de hasta 12 letras (' + Bots.NAMES.slice(0, 6).join(', ') + '…)');
  const r = Kit.seeded(1);
  let clash = false;
  for (let k = 0; k < 200; k++) {
    const taken = ['paco', 'LOLA', 'Rocio', 'Nacho'];
    const n = Bots.pickName(taken, r);
    if (['paco', 'lola', 'rocío', 'rocio', 'nacho'].indexOf(n.toLowerCase()) >= 0) clash = true;
  }
  check(!clash, 'El nombre nunca coincide con uno de la sala (sin mirar mayúsculas ni tildes: «Rocio» ya cuenta como «Rocío»)');
  check(Bots.pickName(Bots.NAMES.slice(), r) === 'Paco 2', 'Si estuvieran todos cogidos: «Paco 2»');
  check(Bots.nearestLevel('imposible', ['facil', 'normal']) === 'normal' && Bots.nearestLevel('facil', ['dificil', 'imposible']) === 'dificil' && Bots.nearestLevel('dificil', null) === 'dificil',
    'Un juego que no tiene un nivel usa el más cercano (manifiesto "botLevels")');
}

// ---------------------------------------------------------------- adding and removing
function addRemove() {
  console.log('\n[Añadir y quitar]');
  const duel = fakeGame('duelo', 2, 2, { bot: fakeBot, title: 'Duelo' });
  const R = room([duel], 4);
  const ana = R.join('Paco', 'c-ana');            // a human called Paco: no bot may be «Paco»
  ana.msg({ t: 'bot.add', level: 'dificil' });
  const ev = ana.last('ev', 'bot');
  let ps = R.players();
  const b = ps[1];
  check(!!b && b.bot === true && b.level === 'dificil' && b.levelName === 'Difícil' && b.connected === true && b.color === R.hub.COLORS[1] && b.name !== 'Paco' && Bots.NAMES.indexOf(b.name) >= 0,
    'Ana pide un rival «Difícil»: hueco 2, con su color, nombre de la lista («' + (b && b.name) + '»), siempre conectado');
  check(!!ev && ev.add && ev.slot === 2 && ev.by === 1 && ev.text === b.name + ' (Difícil) se une como rival' && !!R.tv.last('ev', 'bot'),
    'Todos reciben el aviso: «' + (ev && ev.text) + '»');
  ana.msg({ t: 'bot.add', level: 'trampas' });
  ps = R.players();
  check(ps[2] && ps[2].bot && ps[2].level === 'normal', 'Un nivel desconocido: «Normal»');
  check(ps[1].name !== ps[2].name, 'Dos rivales, dos nombres distintos (' + ps[1].name + ' y ' + ps[2].name + ')');
  R.tv.msg({ t: 'bot.add', level: 'facil' });
  check(R.bots().length === 2, 'La tele no puede añadir rivales (solo los móviles)');
  ana.msg({ t: 'bot.remove', slot: 3 });
  const rm = ana.last('ev', 'bot');
  check(!R.players()[2] && rm && rm.add === false && rm.slot === 3 && /ya no juega$/.test(rm.text), '«Quitar» (×): el hueco 3 queda libre («' + (rm && rm.text) + '»)');
  ana.msg({ t: 'bot.remove', slot: 1 });
  check(R.players()[0] && R.players()[0].name === 'Paco', 'Quitar un hueco que no es un bot no hace nada');
  // Full room
  ana.msg({ t: 'bot.add', level: 'facil' });
  ana.msg({ t: 'bot.add', level: 'facil' });
  const n0 = R.bots().length;
  ana.msg({ t: 'bot.add', level: 'facil' });
  const full = ana.last('ev', 'nobot');
  check(n0 === 3 && R.bots().length === 3 && !!full && full.why === 'full' && full.text === 'La sala está llena: no cabe otro rival.' && !!R.tv.last('ev', 'nobot'),
    'Sala llena (4 huecos): «' + (full && full.text) + '»');
  const carla = R.join('Carla');
  check(!!carla.last('full'), 'Con la sala llena de rivales, un móvil nuevo recibe «lleno» (los bots ocupan huecos de verdad)');
  R.hub.stop();
}

// ---------------------------------------------------------------- counting as players, games without bots
function counting() {
  console.log('\n[Los bots cuentan como jugadores]');
  const duel = fakeGame('duelo', 2, 2, { bot: fakeBot, title: 'Duelo' });
  const trio = fakeGame('trio', 3, 6, { bot: fakeBot, title: 'Trío' });
  const plain = fakeGame('dibujos', 2, 6, { title: 'Dibujos' });
  const R = room([duel, trio, plain]);
  const ana = R.join('Ana');
  check(R.tv.last('hub').ready === false, 'Ana sola: la sala no está lista (el juego más pequeño es de 2)');
  ana.msg({ t: 'bot.add', level: 'normal' });
  check(R.tv.last('hub').ready === true, 'Ana + 1 bot: lista (el bot cuenta y está conectado)');
  ana.msg({ t: 'pick', game: 'trio' });
  const need = ana.last('ev', 'need2');
  check(!!need && need.n === 2 && /falta 1 jugador/.test(need.text), 'Un juego de 3 con Ana + 1 bot: «' + (need && need.text) + '»');
  ana.msg({ t: 'pick', game: 'dibujos' });
  const nob = ana.last('ev', 'nobots');
  check(!!nob && nob.text === '«Dibujos» no admite rivales: quita los bots.' && R.tv.last('hub').screen === 'menu' && !!R.tv.last('ev', 'nobots'),
    'Un juego sin bots no empieza mientras haya bots: «' + (nob && nob.text) + '»');
  const pub = publicManifests({ list: [duel, plain] });
  check(pub[0].bots === true && pub[0].botLevels.length === 4 && pub[1].bots === false && pub[1].botLevels.length === 0, 'La tele y los móviles saben qué juegos admiten bots (bots, botLevels)');
  ana.msg({ t: 'bot.add', level: 'normal' });
  ana.msg({ t: 'pick', game: 'duelo' });
  const many = ana.last('ev', 'toomany');
  check(!!many && many.n === 3 && /sois 3/.test(many.text), 'Ana + 2 bots en un duelo: «' + (many && many.text) + '»');
  ana.msg({ t: 'bot.remove', slot: 3 });
  ana.msg({ t: 'pick', game: 'duelo' });
  check(R.tv.last('hub').screen === 'duelo', 'Ana + 1 bot: el duelo (2 jugadores) empieza');
  R.hub.stop();
}

// ---------------------------------------------------------------- running: what they see, what they send
function running() {
  console.log('\n[En juego: lo que ven y lo que mandan]');
  botsMade.length = 0;
  created.length = 0;
  const party = fakeGame('fiesta', 2, 6, { bot: fakeBot, title: 'Fiesta', botLevels: ['facil', 'normal'] });
  const other = fakeGame('otro', 2, 6, { bot: fakeBot, title: 'Otro' });
  const R = room([party, other]);
  const ana = R.join('Ana');
  ana.msg({ t: 'bot.add', level: 'imposible' });
  ana.msg({ t: 'bot.add', level: 'facil' });
  const parses0 = R.hub.botStats().parses;
  for (let k = 0; k < 30; k++) R.hub.stepForTests(1);
  check(R.hub.botStats().parses === parses0 && R.hub.botStats().running === 0 && botsMade.length === 0, 'En el menú, con bots en la sala: nada de bots en marcha y ningún JSON.parse para ellos');
  ana.msg({ t: 'pick', game: 'fiesta' });
  const G = created[created.length - 1];
  const [b2, b3] = botsMade;
  check(botsMade.length === 2 && b2.ctx.slot === 2 && b3.ctx.slot === 3, 'Al empezar se crea un bot por rival (ctx.slot desde 1, como en los mensajes)');
  check(b2.ctx.level === 'normal' && b2.ctx.levelValue === 0.5 && b3.ctx.level === 'facil' && b3.ctx.levelValue === 0.25 && b2.ctx.name === R.players()[1].name && b2.ctx.gameId === 'fiesta',
    '«Imposible» en un juego que llega a «Normal» juega en «Normal» (ctx.level, ctx.levelValue, ctx.name)');
  check(typeof b2.ctx.random() === 'number' && Math.abs(b2.ctx.now() - Date.now()) < 50 && typeof b2.ctx.send === 'function', 'ctx.random(), ctx.now() y ctx.send()');
  check(b2.tv.some(function (m) { return m.t === 'fz.meta'; }) && b2.slot.some(function (m) { return m.t === 'fz.meta'; }) && b2.slot.some(function (m) { return m.t === 'fz.you' && m.slot === 2; }) && !b2.slot.some(function (m) { return m.t === 'fz.you' && m.slot === 3; }),
    'Cada bot ve lo de la tele (onTv) y lo de SU móvil (onSlot: su mensaje privado, no el del otro)');
  check(b2.tv.some(function (m) { return m.t === 'hub' && m.screen === 'fiesta'; }), 'También ve el estado del hub, como una persona');
  // One parse per message for all bots; the same object for everybody
  const st0 = R.hub.botStats();
  G.api.broadcast(JSON.stringify({ t: 'fz.big', list: [1, 2, 3] }));
  const st1 = R.hub.botStats();
  const seenTv2 = b2.tv[b2.tv.length - 1], seenTv3 = b3.tv[b3.tv.length - 1], seenSlot2 = b2.slot[b2.slot.length - 1];
  check(st1.parses - st0.parses === 1 && st1.toBots - st0.toBots === 4, 'Un mensaje para la tele y todos los móviles con 2 bots: 1 JSON.parse y 4 entregas (onTv ×2, onSlot ×2)');
  check(seenTv2 === seenTv3 && seenTv2 === seenSlot2 && seenTv2.t === 'fz.big', '…y todos reciben el mismo objeto (de solo lectura)');
  G.api.sendTvs({ t: 'fz.obj', a: 1 });
  check(R.hub.botStats().parses - st1.parses === 1 && b3.tv[b3.tv.length - 1].a === 1, 'Un objeto (no texto) también llega, convertido una sola vez');
  // No TV page: the game still sends its TV state (the bots watch it)
  check(G.api.tvs.size === 2, 'api.tvs.size cuenta a los bots como una tele más (los juegos mandan su estado aunque no haya tele)');
  // What the bots send: next tick, as from their phone
  const before = G.got.length;
  R.hub.stepForTests(1);
  const first = G.got.slice(before);
  check(first.length === 0, 'Lo que un bot manda en su tick no llega al juego en ese mismo tick (sin reentradas)');
  R.hub.stepForTests(1);
  const got = G.got.slice(before);
  check(got.length === 2 && got.some(function (x) { return x.who === 1 && x.msg.t === 'fz.in' && x.msg.n === 1; }) && got.some(function (x) { return x.who === 2 && x.msg.t === 'fz.in'; }),
    'En el tick siguiente llega a onMessage(hueco, msg) como si viniera de su móvil (who = 1 y 2)');
  check(R.tv.last('hub').screen === 'fiesta' && R.bots().length === 2 && !G.got.some(function (x) { return x.msg.t === 'menu' || x.msg.t === 'pick' || x.msg.t === 'bot.add'; }),
    'Un bot no puede mandar mensajes del hub («menu», «pick», «bot.add»): se ignoran');
  check(Math.abs(b2.dt - 1 / 60) < 1e-9 && b2.ticks === 2, 'tick(dt) en cada tick del hub, con dt = 1/60');
  // Only from the menu
  ana.msg({ t: 'bot.add', level: 'facil' });
  ana.msg({ t: 'bot.remove', slot: 2 });
  const nm = ana.all('ev', 'nobot');
  check(R.bots().length === 2 && nm.length === 2 && nm[0].why === 'menu' && nm[0].text === 'Los rivales se añaden desde el menú.' && nm[1].text === 'Los rivales se quitan desde el menú.',
    'Durante una partida no se añaden ni se quitan rivales');
  // Lifecycle: menu stops them, they stay in the room, a new game makes new ones
  ana.msg({ t: 'menu' });
  check(b2.stopped && b3.stopped && R.hub.botStats().running === 0 && R.bots().length === 2, 'Vuelta al menú: los bots se paran (stop) y siguen en la sala');
  const parsesMenu = R.hub.botStats().parses;
  for (let k = 0; k < 10; k++) R.hub.stepForTests(1);
  check(R.hub.botStats().parses === parsesMenu, 'Parados: ya no se les entrega nada');
  ana.msg({ t: 'pick', game: 'otro' });
  check(botsMade.length === 4 && !botsMade[2].stopped && botsMade[2].ctx.gameId === 'otro' && botsMade[2].ctx.level === 'imposible' && botsMade[2].ctx.name === b2.ctx.name,
    'En otro juego vuelven a jugar los mismos rivales (mismo nombre y nivel), con un bot nuevo');
  ana.msg({ t: 'menu' });
  R.hub.stop();
}

// ---------------------------------------------------------------- humans leaving and coming back
function leaving() {
  console.log('\n[Cuando se van las personas]');
  const party = fakeGame('fiesta', 2, 6, { bot: fakeBot, title: 'Fiesta' });
  let R = room([party]);
  const ana = R.join('Ana');
  const berto = R.join('Berto');
  ana.msg({ t: 'bot.add', level: 'normal' });
  ana.msg({ t: 'leave' });
  check(R.bots().length === 1, 'Se va Ana pero queda Berto: el rival se queda');
  berto.msg({ t: 'leave' });
  check(R.bots().length === 0 && R.players().every(function (p) { return !p; }), 'Se va la última persona: los rivales se van con ella');
  R.hub.stop();
  // In a game: back to the menu, with the reason
  R = room([party]);
  const eva = R.join('Eva');
  eva.msg({ t: 'bot.add', level: 'facil' });
  eva.msg({ t: 'bot.add', level: 'facil' });
  eva.msg({ t: 'pick', game: 'fiesta' });
  eva.msg({ t: 'leave' });
  const back = R.tv.last('ev', 'menu');
  check(R.tv.last('hub').screen === 'menu' && R.bots().length === 0 && R.hub.botStats().running === 0 && !!back && /no queda nadie/.test(back.text),
    'Eva sale en plena partida con 2 bots: vuelta al menú y fuera los bots («' + (back && back.text) + '»)');
  R.hub.stop();
  // A disconnected human keeps their slot: a bot never takes it
  R = room([party], 3);
  const ana2 = R.join('Ana', 'c-ana');
  const berto2 = R.join('Berto', 'c-berto');
  berto2.close();
  check(R.players()[1] && R.players()[1].connected === false, 'Berto pierde la conexión: su hueco (2) se le guarda');
  ana2.msg({ t: 'bot.add', level: 'dificil' });
  check(R.players()[1].name === 'Berto' && R.players()[2] && R.players()[2].bot, 'Un rival nuevo va al hueco libre (3), no al de Berto');
  ana2.msg({ t: 'bot.add', level: 'dificil' });
  check(ana2.last('ev', 'nobot').why === 'full' && R.players()[1].name === 'Berto', 'Con el hueco de Berto guardado la sala está llena: no cabe otro rival');
  const berto3 = R.join('Berto', 'c-berto');
  check(berto3.last('joined').slot === 2 && berto3.last('joined').reconnect === true, 'Berto vuelve con su cid: recupera el hueco 2');
  const thief = R.join('Ladrón', R.players()[2] && 'bot:x');
  check(!!thief.last('full') && R.players()[2].bot, 'Nadie puede quedarse el hueco de un bot con un cid raro');
  // A disconnected human whose time runs out, alone with bots: the bots go too
  R.hub.stop();
  R = room([party], 3);
  const solo = R.join('Sol');
  solo.msg({ t: 'bot.add', level: 'normal' });
  solo.close();
  check(R.bots().length === 1, 'Sol pierde la conexión: el rival espera con ella');
  const realNow = Date.now;
  Date.now = function () { return realNow() + 5000; };
  try { R.hub.stepForTests(1); } finally { Date.now = realNow; }
  check(R.bots().length === 0 && R.players().every(function (p) { return !p; }), 'Sol no vuelve a tiempo: se libera su hueco y se van los rivales');
  R.hub.stop();
}

// ---------------------------------------------------------------- manifests
function manifests() {
  console.log('\n[Manifiestos]');
  const dir = H_.tmpHome('g2t-bots-games-');
  function write(id, manifest, files) {
    const d = path.join(dir, id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(Object.assign({ id: id, title: id, description: 'Prueba', minPlayers: 2, maxPlayers: 2 }, manifest)));
    fs.writeFileSync(path.join(d, 'index.js'), "module.exports = { create: function () { return { start: function () {}, stop: function () {}, tick: function () {} }; } };");
    Object.keys(files || {}).forEach(function (f) { fs.writeFileSync(path.join(d, f), files[f]); });
  }
  write('con-bot', { bots: true, botLevels: ['facil', 'normal'] }, { 'bot.js': 'module.exports = { create: function () { return {}; } };' });
  write('sin-botjs', { bots: true });
  write('niveles-malos', { bots: true, botLevels: ['experto'] }, { 'bot.js': 'module.exports = { create: function () { return {}; } };' });
  write('bot-roto', { bots: true }, { 'bot.js': 'module.exports = {};' });
  const errs = [];
  const games = loadGames([dir], function (s) { errs.push(s); });
  check(!!games.byId['con-bot'] && typeof games.byId['con-bot'].bot.create === 'function' && games.byId['con-bot'].manifest.botLevels.join() === 'facil,normal', '"bots": true con bot.js: se carga con su bot');
  check(!games.byId['sin-botjs'] && errs.some(function (e) { return /sin-botjs.*falta bot\.js/.test(e); }), '"bots": true sin bot.js: no se carga y el registro dice por qué');
  check(!games.byId['niveles-malos'] && errs.some(function (e) { return /botLevels/.test(e); }), '"botLevels" con un nivel que no existe: error');
  check(!games.byId['bot-roto'] && errs.some(function (e) { return /bot\.js debe exportar create/.test(e); }), 'bot.js sin create(ctx): error');
  H_.rmrf(dir);
  const real = loadGames([GAMES_DIR], function () {});
  const withBots = real.list.filter(function (g) { return g.manifest.bots; }).map(function (g) { return g.id; });
  check(withBots.indexOf('tanques') >= 0 && !real.byId.dibuja.manifest.bots && !real.byId.infiltrado.manifest.bots, 'Juegos con rivales: ' + withBots.join(', ') + ' (Dibuja y El Infiltrado no)');
}

// ---------------------------------------------------------------- the real server
async function integration() {
  console.log('\n[Servidor de verdad: un móvil juega a «Tanques» contra un bot]');
  const PORT = parseInt(process.env.TEST_PORT, 10) || 3961;
  const WS = 'ws://127.0.0.1:' + PORT + '/ws';
  const HOME = H_.tmpHome('g2t-bots-');
  const srv = await H_.startServer({ GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', TANQUES_DEBUG_SPEED: '4' });
  const clients = [];
  try {
    const page = await H_.httpGet('http://127.0.0.1:' + PORT, '/m');
    const boot = JSON.parse(/window\.G2T_BOOT = (.*?);<\/script>/.exec(page.body)[1]);
    const tq = boot.games.filter(function (g) { return g.id === 'tanques'; })[0];
    check(boot.botLevels.length === 4 && boot.botLevels[3].label === 'Imposible' && tq.bots === true, 'La página del móvil trae los niveles y qué juegos admiten bots');
    const tv = H_.makeClient(WS, 'tele'); clients.push(tv);
    await tv.ready;
    tv.send({ t: 'hello', role: 'tv' });
    const ana = await H_.phone(WS, 'Ana', 'b-ana'); clients.push(ana);
    ana.send({ t: 'bot.add', level: 'dificil' });
    const h = await tv.wait(function (m) { return m.t === 'hub' && m.players[1] && m.players[1].bot; }, 2000, 'bot en el hub');
    check(!!h && h.players[1].levelName === 'Difícil' && h.ready, 'Ana añade un rival «Difícil»: la tele lo ve en el hueco 2 y la sala está lista');
    const t0 = tv.mark();
    ana.send({ t: 'pick', game: 'tanques' });
    const m0 = await tv.wait(function (m) { return m.t === 'kmeta' && m.phase === 'play'; }, 4000, 'en juego', t0);
    check(!!m0 && m0.tanks.join() === '1,2', 'Ana contra el bot: empieza el duelo');
    // The bot drives and shoots (slot 2)
    const s0 = await tv.wait(function (m) { return m.t === 'k.s'; }, 1000, 'estado', tv.msgs.indexOf(m0));
    const shot = await tv.wait(function (m) { return m.t === 'k.s' && m.e.some(function (e) { return e[0] === 'f' && e[3] === 2; }); }, 20000, 'disparo del bot', tv.msgs.indexOf(m0));
    const s1 = tv.find('k.s');
    const moved = s0 && s1 && Math.hypot(s1.k[4] - s0.k[4], s1.k[5] - s0.k[5]);
    check(moved > 50, 'El tanque del bot se mueve (' + Math.round(moved) + ' u)');
    check(!!shot, 'El bot dispara');
    const hit = await tv.wait(function (m) { return m.t === 'k.hit'; }, 30000, 'impacto', tv.msgs.indexOf(m0));
    check(!!hit, 'Y alguien cae (' + (hit && (hit.slot === 1 ? 'Ana' : 'el bot') + (hit.self ? ', con su propia bala' : '')) + ')');
    ana.send({ t: 'menu' });
    await tv.wait(function (m) { return m.t === 'hub' && m.screen === 'menu'; }, 2000, 'menú');
    check(tv.hub.players[1] && tv.hub.players[1].bot, 'Al volver al menú el rival sigue en la sala');
    const info = JSON.parse((await H_.httpGet('http://127.0.0.1:' + PORT, '/info')).body);
    check(info.actividad.players === 1 && info.actividad.bots === 1, '/info: 1 persona y 1 bot (el apagado por inactividad de la tele solo mira a las personas)');
    check(!/Error/.test(srv.out), 'Sin errores en el registro del servidor');
  } catch (e) {
    check.fail('Excepción: ' + (e && e.stack || e));
  } finally {
    clients.forEach(function (c) { try { c.ws.terminate(); } catch (e) { /* noop */ } });
    await srv.stop();
    H_.rmrf(HOME);
  }
}

(async function () {
  levelsAndNames();
  addRemove();
  counting();
  running();
  leaving();
  manifests();
  await integration();
  check.done();
})();
