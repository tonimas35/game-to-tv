'use strict';
/*
 * «El Infiltrado» (3 to 6 players): unit tests of the rules, and whole
 * matches through the real server with a fake TV and 3, 4 and 6 fake phones.
 *
 * NO SPOILERS, checked in every round:
 *   - the TV never gets a card, and before the reveal no message to the TV
 *     carries the place or a role (outside the public list of places, which
 *     is the same for everybody and marks nothing);
 *   - the spy's phone never gets the place before the reveal;
 *   - each role only reaches its player;
 *   - the spy cannot be told apart: every card has the same keys and the
 *     same size, and apart from the card the TV and every phone get exactly
 *     the same messages until the reveal (or until the final vote catches
 *     the spy);
 *   - accusation votes are anonymous (only who has voted, and the count at
 *     the end; it never ends early on a «No»).
 * Plus: turns (no asking back), one accusation per player and round,
 * unanimity, the spy's guess, time up -> final vote -> plurality / tie ->
 * last guess, scoring of every outcome, rounds and the rotation of who
 * starts, «lugares propios» (never the spy's own), reconnecting (spy,
 * non-spy, TV), pauses, the spy leaving, a player leaving during the final
 * vote, falling below 3 players, and the round length set in the menu.
 *
 *   node test/infiltrado.test.js
 */
const H_ = require('./helpers');
const I = require('../src/games/infiltrado');
const check = H_.checker('El Infiltrado (3 a 6 jugadores)');

const PORT = parseInt(process.env.TEST_PORT, 10) || 3991;
const WS = 'ws://127.0.0.1:' + PORT + '/ws';
const SPEED = 40;            // 4 min -> 6 s, accusation 30 s -> 0.75 s
const HOLD = 1500;           // SLOT_HOLD_MS

// ---------------------------------------------------------------- helpers
function bare(m) { return JSON.stringify(m, function (k, v) { return k === '_at' ? undefined : v; }); }
function nk(s) { return I.normKey(s); }
// Does any string of the message contain `needle` (as whole words)? imeta.places (the public list) is skipped.
function mentions(msg, needle) {
  const w = nk(needle);
  if (!w) return false;
  const re = new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])');
  let found = false;
  (function walk(v, top) {
    if (found || v == null) return;
    if (typeof v === 'string') { if (re.test(nk(v))) found = true; return; }
    if (Array.isArray(v)) { v.forEach(function (x) { walk(x, false); }); return; }
    if (typeof v === 'object') {
      Object.keys(v).forEach(function (k) {
        if (k === '_at' || (top && msg.t === 'imeta' && k === 'places')) return;
        walk(v[k], false);
      });
    }
  })(msg, true);
  return found;
}
function firstIdx(c, pred, from) {
  for (let i = from || 0; i < c.msgs.length; i++) if (pred(c.msgs[i])) return i;
  return -1;
}
function isMeta(G, r, phases) {
  return function (m) { return m.t === 'imeta' && m.match === G.match && m.round === r && (!phases || phases.indexOf(m.phase) >= 0); };
}
function expectedPlaces(customs, used) {
  const byKey = {};
  const list = I.LOCATIONS.map(function (l) { const e = { name: l.name, custom: false, used: false, key: nk(l.name) }; byKey[e.key] = e; return e; });
  customs.forEach(function (n) { const k = nk(n); if (!byKey[k]) { byKey[k] = { name: n, custom: true, used: false, key: k }; list.push(byKey[k]); } });
  list.forEach(function (e) { e.used = used.indexOf(e.key) >= 0; });
  list.sort(function (a, b) { return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0); });
  return list.map(function (e) { return { name: e.name, custom: e.custom, used: e.used }; });
}

async function joinRoom(names, prefix) {
  const bySlot = {};
  for (let i = 0; i < names.length; i++) {
    const p = await H_.phone(WS, names[i], prefix + names[i]);
    bySlot[p.find('joined').slot] = p;
  }
  return bySlot;
}
function namesOf(bySlot) { const o = {}; Object.keys(bySlot).forEach(function (s) { o[s] = bySlot[s].label; }); return o; }

async function pickGame(G, by) {
  const tm = G.tv.mark();
  G.bySlot[by].send({ t: 'pick', game: 'infiltrado' });
  const m = await G.tv.wait(function (x) { return x.t === 'imeta' && x.round === 1; }, 3000, 'primera imeta', tm);
  if (m) { G.match = m.match; G.tvFrom = tm; G.used = []; }
  return m;
}

// Waits for round r to be in play; collects the cards
async function beginRound(G, r) {
  const m = await G.tv.wait(isMeta(G, r, ['play']), 10000, 'ronda ' + r + ' en juego', G.tvFrom);
  if (!m) return null;
  const R = { r: r, play: m, players: m.players.slice(), cards: {}, spy: 0, start: {}, tvStart: firstIdx(G.tv, isMeta(G, r), G.tvFrom), skip: [], gone: [] };
  for (const s of R.players) {
    const c = G.bySlot[s];
    const card = await c.wait(function (x) { return x.t === 'i.card' && x.match === G.match && x.round === r; }, 2000, 'carta ' + r, 0);
    R.cards[s] = card;
    if (card && card.spy) R.spy = s;
    R.start[s] = firstIdx(c, isMeta(G, r), 0);
  }
  R.loc = null;
  R.players.forEach(function (s) { if (R.cards[s] && !R.cards[s].spy) R.loc = R.cards[s].location; });
  R.locIdx = m.places.map(function (p) { return p.name; }).indexOf(R.loc);
  R.others = R.players.filter(function (s) { return s !== R.spy; });
  return R;
}

async function waitReveal(G, R) {
  const rev = await G.tv.wait(isMeta(G, R.r, ['reveal']), 10000, 'revelación ' + R.r, R.tvStart);
  if (rev) {
    R.rev = rev;
    R.result = rev.result;
    G.tvFrom = G.tv.msgs.indexOf(rev);
    if (rev.result) G.used.push(nk(rev.result.location));
  }
  return rev;
}

/** Every no-spoiler rule for round R (after its reveal). Returns the problems found. */
function audit(G, R) {
  const bad = [];
  const res = R.result;
  if (!res) return ['sin revelación'];
  const live = R.players.filter(function (s) { return R.gone.indexOf(s) < 0; });
  // 1. Cards: one per player, same keys, same size; the spy's without place or role
  const shapes = new Set(), sizes = new Set();
  R.players.forEach(function (s) {
    const c = R.cards[s];
    if (!c) { bad.push('sin carta: ' + G.names[s]); return; }
    shapes.add(Object.keys(c).filter(function (k) { return k !== '_at'; }).join(','));
    sizes.add(Buffer.byteLength(bare(c)));
    if (s === R.spy) {
      if (c.location !== null || c.role !== null || c.spy !== true) bad.push('carta del infiltrado con datos');
    } else {
      const mine = res.roles.filter(function (x) { return x.slot === s; })[0];
      if (c.spy !== false || c.location !== res.location || (live.indexOf(s) >= 0 && (!mine || mine.role !== c.role))) bad.push('carta de ' + G.names[s] + ' no cuadra');
    }
  });
  if (shapes.size !== 1) bad.push('cartas con campos distintos: ' + Array.from(shapes).join(' / '));
  if (sizes.size !== 1) bad.push('cartas de tamaños distintos: ' + Array.from(sizes).join(', '));
  if (res.how !== 'abandono' && R.spy !== res.spy) bad.push('el infiltrado de la carta no es el de la revelación');
  const roles = R.others.map(function (s) { return R.cards[s] && R.cards[s].role; });
  if (new Set(roles).size !== roles.length) bad.push('papeles repetidos');
  // 2. The TV: no card, and neither the place nor a role before the reveal
  const tvEnd = G.tv.msgs.indexOf(R.rev);
  G.tv.msgs.slice(R.tvStart, tvEnd).forEach(function (m) {
    if (m.t === 'i.card') bad.push('la tele recibe una carta');
    if (mentions(m, res.location)) bad.push('la tele ve el lugar (' + m.t + ')');
    roles.forEach(function (ro) { if (ro && mentions(m, ro)) bad.push('la tele ve el papel «' + ro + '» (' + m.t + ')'); });
    if (m.t === 'imeta' && m.result) bad.push('resultado antes de tiempo');
  });
  // 3. The spy's phone never gets the place; 4. each role only reaches its player
  R.players.forEach(function (s) {
    if (R.gone.indexOf(s) >= 0) return;
    const c = G.bySlot[s];
    const end = firstIdx(c, isMeta(G, R.r, ['reveal']), R.start[s]);
    const before = c.msgs.slice(R.start[s], end < 0 ? c.msgs.length : end);
    before.forEach(function (m) {
      if (s === R.spy && mentions(m, res.location)) bad.push('el móvil del infiltrado ve el lugar (' + m.t + ')');
      R.others.forEach(function (o) {
        if (o === s || !R.cards[o]) return;
        if (m.t === 'i.card' && m.round === R.r && m.role === R.cards[o].role) return; // a reconnect: its own card again
        if (mentions(m, R.cards[o].role)) bad.push(G.names[s] + ' ve el papel de ' + G.names[o] + ' (' + m.t + ')');
      });
    });
  });
  // 5. Nothing tells the spy apart: same messages for the TV and every phone (but the card)
  function stream(c, from) {
    const end = firstIdx(c, isMeta(G, R.r, ['reveal', 'lastguess']), from);
    return c.msgs.slice(from, end < 0 ? c.msgs.length : end)
      .filter(function (m) { return m.t !== 'i.card' && m.t !== 'i.cfg' && m.t !== 'i.places'; }).map(bare);
  }
  const ref = stream(G.tv, R.tvStart);
  let compared = 0;
  R.players.forEach(function (s) {
    if (R.skip.indexOf(s) >= 0 || R.gone.indexOf(s) >= 0) return;
    const st = stream(G.bySlot[s], R.start[s]);
    compared++;
    if (st.length !== ref.length || st.some(function (x, k) { return x !== ref[k]; })) {
      let k = 0;
      while (k < st.length && st[k] === ref[k]) k++;
      bad.push('el móvil de ' + G.names[s] + (s === R.spy ? ' (infiltrado)' : '') + ' recibe otros mensajes que la tele (desde el n.º ' + k + ': ' + (st[k] || 'nada').slice(0, 80) + ' / ' + (ref[k] || 'nada').slice(0, 80) + ')');
    }
  });
  R.compared = compared;
  R.streamLen = ref.length;
  // 6. The list of places is the public one (same for everybody, marks nothing)
  if (bare(R.play.places) !== JSON.stringify(expectedPlaces(G.customs || [], G.used.slice(0, -1)))) bad.push('la lista de lugares no es la esperada');
  return bad;
}

// Expected points of a round, applied to G.expected; checks the reveal
function score(G, R, label) {
  const res = R.result;
  const pts = {};
  if (res.how !== 'abandono') {
    if (res.spyWins) pts[R.spy] = res.how === 'adivina' && res.guessOk ? 4 : 2;
    else {
      R.players.forEach(function (s) { if (s !== R.spy && R.gone.indexOf(s) < 0) pts[s] = 1; });
      if (res.how === 'acusacion') pts[res.accuser] = 2;
    }
  }
  Object.keys(pts).forEach(function (s) { G.expected[s] = (G.expected[s] || 0) + pts[s]; });
  const got = {};
  res.points.forEach(function (p) { got[p.slot] = p.pts; });
  const okPts = JSON.stringify(got) === JSON.stringify(pts);
  const okTot = Object.keys(G.bySlot).every(function (s) { return (res.scores[s - 1] || 0) === (G.expected[s] || 0); });
  check(okPts && okTot, label + ': puntos ' + (Object.keys(pts).map(function (s) { return G.names[s] + ' +' + pts[s]; }).join(', ') || 'ninguno') +
    ' y marcador ' + Object.keys(G.bySlot).map(function (s) { return G.names[s] + ' ' + (res.scores[s - 1] || 0); }).join(' · '));
}

function checkAudit(G, R, label) {
  const bad = audit(G, R);
  check(!bad.length, label + ': sin chivatazos (cartas iguales de forma y tamaño; tele y ' + R.compared + ' móviles con los mismos ' + R.streamLen + ' mensajes; ni lugar ni papeles fuera de su sitio)' +
    (bad.length ? ' FALLO: ' + bad.slice(0, 4).join(' | ') : ''));
}

async function accuse(G, R, by, suspect, votes, label) {
  const tm = G.tv.mark();
  G.bySlot[by].send({ t: 'i.accuse', suspect: suspect });
  const a = await G.tv.wait(function (m) { return m.t === 'imeta' && m.phase === 'accuse' && m.acc && m.acc.by === by; }, 2000, 'acusación ' + label, tm);
  if (!a) return null;
  // votes: { slot: true/false/undefined (does not vote) }; «No» first, to see that it does not end early
  const order = Object.keys(votes).map(Number).filter(function (s) { return s !== by; }).sort(function (x, y) { return (votes[x] === false ? 0 : 1) - (votes[y] === false ? 0 : 1); });
  let earlyEnd = false;
  for (let k = 0; k < order.length; k++) {
    const s = order[k];
    if (votes[s] === undefined) continue;
    const vm = G.tv.mark();
    G.bySlot[s].send({ t: 'i.vote', yes: votes[s] });
    const seen = await G.tv.wait(function (m) { return m.t === 'imeta' && ((m.acc && m.acc.voted.indexOf(s) >= 0) || m.phase !== 'accuse'); }, 1500, 'voto', vm);
    const remaining = order.slice(k + 1).some(function (o) { return votes[o] !== undefined; }) || order.some(function (o) { return votes[o] === undefined; });
    if (seen && seen.phase !== 'accuse' && remaining) earlyEnd = true;
  }
  const end = await G.tv.wait(function (m) { return m.t === 'imeta' && m.match === G.match && m.phase !== 'accuse' && G.tv.msgs.indexOf(m) > G.tv.msgs.indexOf(a); }, 3000, 'fin de la acusación', tm);
  const metas = G.tv.msgs.slice(G.tv.msgs.indexOf(a), end ? G.tv.msgs.indexOf(end) : G.tv.msgs.length).filter(function (m) { return m.t === 'imeta' && m.phase === 'accuse'; });
  const frozen = metas.every(function (m) { return m.clock === a.clock; }) && (!end || end.phase !== 'play' || Math.abs(end.clock - a.clock) <= 1500);
  // Anonymous: the public state has who voted, never what
  const anon = metas.every(function (m) { return Object.keys(m.acc).join() === 'by,suspect,voters,voted'; }) &&
    (!end || !end.accResult || Object.keys(end.accResult).join() === 'seq,by,suspect,yes,no,none');
  return { start: a, end: end, earlyEnd: earlyEnd, frozen: frozen, anon: anon };
}

async function finalVote(G, R, votes) {
  const v = await G.tv.wait(isMeta(G, R.r, ['vote']), 15000, 'votación final', R.tvStart);
  if (!v) return null;
  const out = { start: v, selfIgnored: null };
  // Voting for yourself is not allowed
  const s0 = Number(Object.keys(votes)[0]);
  const tm = G.tv.mark();
  G.bySlot[s0].send({ t: 'i.final', suspect: s0 });
  await H_.sleep(120);
  out.selfIgnored = !G.tv.since(tm, 'imeta').some(function (m) { return m.vote && m.vote.voted.indexOf(s0) >= 0; });
  for (const s of Object.keys(votes).map(Number)) {
    if (!votes[s]) continue;
    G.bySlot[s].send({ t: 'i.final', suspect: votes[s] });
    await H_.sleep(15);
  }
  out.end = await G.tv.wait(function (m) { return isMeta(G, R.r)(m) && (m.phase === 'lastguess' || m.phase === 'reveal'); }, 4000, 'resultado de la votación', G.tv.msgs.indexOf(v));
  return out;
}

async function leaveAll(G) {
  G.tv.send({ t: 'menu' });
  await G.tv.wait(function (m) { return m.t === 'hub' && m.screen === 'menu'; }, 2000, 'menú');
  Object.keys(G.bySlot).forEach(function (s) { G.bySlot[s].send({ t: 'leave' }); });
  await G.tv.wait(function (m) { return m.t === 'hub' && m.players.every(function (p) { return !p; }); }, 2000, 'sala vacía');
}

// ---------------------------------------------------------------- unit
function fakeApi(list, stores) {
  const sent = { slot: {}, all: [] };
  const api = {
    slots: 6, COLORS: [],
    players: function () { return list.slice(); },
    name: function (i) { return 'J' + (i + 1); },
    isConnected: function () { return true; },
    allConnected: function () { return true; },
    store: function (i) { return stores[i] || (stores[i] = {}); },
    sendSlot: function (i, o) { (sent.slot[i] = sent.slot[i] || []).push(typeof o === 'string' ? o : JSON.stringify(o)); },
    sendTvs: function (o) { sent.all.push(typeof o === 'string' ? o : JSON.stringify(o)); },
    sendPhones: function () {},
    broadcast: function (o) { sent.all.push(typeof o === 'string' ? o : JSON.stringify(o)); },
    sendWs: function () {},
    log: function () {}
  };
  return { api: api, sent: sent };
}

function unit() {
  console.log('\n[Contenido y reglas]');
  const L = I.LOCATIONS;
  check(L.length >= 36 && L.length <= 40, L.length + ' lugares propios del juego (36-40)');
  check(L.every(function (l) { return l.roles.length === 6 && new Set(l.roles.map(nk)).size === 6; }), 'Cada lugar tiene 6 papeles, todos distintos');
  check(new Set(L.map(function (l) { return nk(l.name); })).size === L.length, 'Sin lugares repetidos');
  check(L.every(function (l) { return l.name.length <= 30 && l.roles.every(function (r) { return r.length <= 36; }); }), 'Nombres y papeles cortos (caben en la tele y en el móvil)');
  check(I.GENERIC_ROLES.join() === 'Visitante,Encargado/a,Cliente habitual,Novato/a,Experto/a,Despistado/a', 'Papeles genéricos para los lugares propios');
  check(I.roundMinutes(3, 0) === 6 && I.roundMinutes(4, 0) === 6 && I.roundMinutes(5, 0) === 8 && I.roundMinutes(6, 0) === 8 && I.roundMinutes(3, 10) === 8 + 2 && I.roundMinutes(6, 4) === 4 && I.roundMinutes(4, 7) === 6,
    'Duración: 6 min con 3-4, 8 con 5-6; 4/6/8/10 si se elige en el menú');
  // Scoring of every outcome
  const order = [0, 1, 2, 3];
  const P = function (res) { return JSON.stringify(I.pointsFor(res, order, 2)); };
  check(P({ how: 'votacion', spyWins: true }) === '{"2":2}' && P({ how: 'empate', spyWins: true }) === '{"2":2}' && P({ how: 'sinvotos', spyWins: true }) === '{"2":2}',
    'Puntos: el infiltrado se salva (votación fallida, empate, sin votos) -> +2');
  check(P({ how: 'acusacion', spyWins: true, accuser: 0 }) === '{"2":2}', 'Puntos: prospera una acusación contra un inocente -> infiltrado +2');
  check(P({ how: 'adivina', spyWins: true, guessOk: true }) === '{"2":4}', 'Puntos: «¡Sé el lugar!» y acierta -> infiltrado +4');
  check(P({ how: 'ultima', spyWins: true, guessOk: true }) === '{"2":2}', 'Puntos: pillado en la votación pero adivina el lugar -> infiltrado +2');
  check(P({ how: 'acusacion', spyWins: false, accuser: 1 }) === '{"0":1,"1":2,"3":1}', 'Puntos: pillado por una acusación -> los demás +1 y quien acusó +2');
  check(P({ how: 'ultima', spyWins: false }) === '{"0":1,"1":1,"3":1}' && P({ how: 'adivina', spyWins: false }) === '{"0":1,"1":1,"3":1}',
    'Puntos: pillado en la votación sin adivinar, o falla el lugar -> los demás +1');
  check(P({ how: 'abandono' }) === '{}', 'Puntos: el infiltrado se va -> nadie');
  // Menu: «lugares propios»
  const cp = I.cleanPlaces([{ name: '  El trastero  de casa ', roles: 'Abuela, Nieto, nieto, ,Gato' }, 'Una playa', 'x', 'La azotea', 'el trastero de casa', 'Uno', 'Dos', 'Tres', 'Cuatro']);
  check(cp.length === 5 && cp[0].name === 'El trastero de casa' && cp[0].roles.join() === 'Abuela,Nieto,Gato' && cp[1].name === 'La azotea' && cp[1].roles.length === 0,
    'Lugares propios: máx. 5, sin repetidos ni lugares que ya están en la lista; papeles opcionales y sin repetir');
  check(I.lobby.badge({ places: cp.slice(0, 2) }) === '2 lugares propios' && I.lobby.badge({ places: [] }) === null, 'La tele solo ve cuántos lugares propios tiene cada uno');

  console.log('\n[Muchas partidas simuladas]');
  const stores = {
    0: { places: I.cleanPlaces([{ name: 'El trastero de Ana', roles: ['Ana', 'Caja', 'Araña'] }, 'Una casa encantada']) },
    1: { places: I.cleanPlaces(['La azotea de Berto']) },
    2: { places: I.cleanPlaces(['Una casa encantada', { name: 'El karaoke del barrio', roles: ['Cantante desafinado', 'Dueño', 'Fan', 'Técnico', 'Camarera', 'Vecino'] }]) },
    3: {}
  };
  const authors = { 'trastero de ana': [0], 'casa encantada': [0, 2], 'azotea de berto': [1], 'karaoke del barrio': [2] };
  const F = fakeApi([0, 1, 2, 3], stores);
  const game = I.create(F.api);
  const S = game._state;
  let rounds = 0, customs = 0, ownSpy = 0, repeats = 0, badCards = 0, badRoles = 0, rotOk = true, starts = [];
  for (let match = 0; match < 120; match++) {
    game.start();
    game.tick(6);
    game.flush();
    const seen = new Set();
    const firstAskers = [];
    for (let r = 1; r <= S.starters.length; r++) {
      rounds++;
      firstAskers.push(S.asker);
      if (S.loc.custom) {
        customs++;
        if ((authors[S.loc.key] || []).indexOf(S.spy) >= 0) ownSpy++;
      }
      if (seen.has(S.loc.key)) repeats++;
      seen.add(S.loc.key);
      const cards = [0, 1, 2, 3].map(function (s) { const l = F.sent.slot[s]; return l[l.length - 1]; });
      const objs = cards.map(function (c) { return JSON.parse(c); });
      if (new Set(cards.map(function (c) { return Buffer.byteLength(c); })).size !== 1 || new Set(objs.map(function (o) { return Object.keys(o).join(); })).size !== 1 ||
        objs.filter(function (o) { return o.spy; }).length !== 1 || !objs.every(function (o) { return o.round === r && (o.spy ? o.location === null && o.role === null : o.location === S.loc.name); })) badCards++;
      const roles = objs.filter(function (o) { return !o.spy; }).map(function (o) { return o.role; });
      const pool = S.loc.roles.length >= 3 ? S.loc.roles : S.loc.roles.concat(I.GENERIC_ROLES);
      if (new Set(roles).size !== 3 || !roles.every(function (x) { return pool.indexOf(x) >= 0; })) badRoles++;
      // End the round: the spy guesses wrong, then «Siguiente»
      const wrong = S.pool.indexOf(S.loc) === 0 ? 1 : 0;
      game.onMessage(S.spy, { t: 'i.guess', i: wrong });
      game.flush();
      game.onMessage(-1, { t: 'i.next' });
      game.tick(6);
      game.flush();
    }
    if (S.phase !== 'end' || firstAskers.length !== 4 || new Set(firstAskers).size !== 4) rotOk = false;
    starts.push(firstAskers[0]);
  }
  check(!ownSpy && customs > 50, rounds + ' rondas simuladas: ' + customs + ' en lugares propios y NUNCA con su autor de infiltrado (ni con «Una casa encantada», que escribieron dos)');
  check(!repeats, 'Ningún lugar se repite dentro de una partida');
  check(!badCards, 'Todas las cartas de cada ronda: mismos campos y mismo tamaño en bytes; una sola sin lugar ni papel');
  check(!badRoles, 'Papeles distintos y del lugar (genéricos si el lugar propio no trae bastantes)');
  check(rotOk && new Set(starts).size === 4 && starts.slice(0, 4).join() === '0,1,2,3', 'Rondas = jugadores; cada uno empieza a preguntar una vez y quien abre la partida rota (' + starts.slice(0, 5).join(' ') + '…)');
  check(F.sent.all.every(function (m) { return !/"i\.card"/.test(m); }), 'Las cartas nunca van en un mensaje para todos');
}

// ---------------------------------------------------------------- 3 players
async function groupOf3(tv) {
  console.log('\n[3 jugadores: turnos, acusaciones, «¡Sé el lugar!» y partida a tiempo]');
  const bySlot = await joinRoom(['Ana', 'Berto', 'Carla'], 'i3-');
  const G = { tv: tv, bySlot: bySlot, names: namesOf(bySlot), expected: {}, customs: [] };
  // Round length in the menu, by any player
  const cm = {};
  [1, 2, 3].forEach(function (s) { cm[s] = bySlot[s].mark(); });
  bySlot[3].send({ t: 'i.cfg', minutes: 7 });
  bySlot[3].send({ t: 'i.cfg', minutes: 10 });
  const cfgs = await Promise.all([1, 2, 3].map(function (s) { return bySlot[s].wait(function (m) { return m.t === 'i.cfg' && m.minutes === 10; }, 1500, 'i.cfg', cm[s]); }));
  check(cfgs.every(function (c) { return c && c.by === 'Carla'; }) && !bySlot[1].since(cm[1], 'i.cfg').some(function (m) { return m.minutes === 7; }),
    'Menú: Carla pone las rondas de 10 min y lo ven todos los móviles (7 min no es una opción)');
  const first = await pickGame(G, 1);
  check(first && first.players.length === 3 && first.rounds === 3 && first.minutes === 10 && first.clockTotal === 600000, '3 jugadores: 3 rondas de 10 min (lo elegido en el menú)');

  // ---- Round 1: turns and accusations
  let R = await beginRound(G, 1);
  if (!check(!!R && !!R.spy && !!R.loc, 'Ronda 1: cada móvil recibe su carta (uno es el infiltrado)')) return G;
  const starters = [R.play.asker];
  const A = R.play.asker;
  const others = R.players.filter(function (s) { return s !== A; });
  let tm = tv.mark();
  bySlot[others[0]].send({ t: 'i.ask', to: others[1] });   // not their turn
  bySlot[A].send({ t: 'i.ask', to: A });                     // themselves
  await H_.sleep(120);
  check(!tv.since(tm, 'imeta').some(function (m) { return m.history.length; }), 'Solo pregunta a quien le toca, y nunca a sí mismo');
  bySlot[A].send({ t: 'i.ask', to: others[0] });
  let m = await tv.wait(function (x) { return x.t === 'imeta' && x.history.length === 1; }, 1500, 'pregunta 1', tm);
  check(m && m.asker === others[0] && m.askedBy === A && m.history[0].from === A && m.history[0].to === others[0],
    'La tele: «' + G.names[A] + ' pregunta a ' + G.names[others[0]] + '» y ahora le toca a ' + G.names[others[0]]);
  tm = tv.mark();
  bySlot[others[0]].send({ t: 'i.ask', to: A });             // asking back: not allowed
  await H_.sleep(120);
  check(!tv.since(tm, 'imeta').some(function (x) { return x.history.length !== 1; }) && tv.find('imeta').asker === others[0], 'No se puede preguntar a quien te acaba de preguntar');
  // 8 questions: the history keeps the last 6
  let asker = others[0], prev = A;
  for (let k = 0; k < 7; k++) {
    const to = R.players.filter(function (s) { return s !== asker && s !== prev; })[0];
    tm = tv.mark();
    bySlot[asker].send({ t: 'i.ask', to: to });
    await tv.wait(function (x) { return x.t === 'imeta' && x.asker === to && x.askedBy === asker; }, 1500, 'pregunta', tm);
    prev = asker; asker = to;
  }
  m = tv.find('imeta');
  check(m.history.length === 6 && m.history[5].to === asker && m.history[5].from === prev, 'Historial en la tele: las 6 últimas preguntas');

  // Accusations: the spy bluffs and accuses an innocent; the other one says No
  const spy = R.spy, [x1, x2] = R.others;
  let acc = await accuse(G, R, spy, x1, { [spy]: true, [x2]: false }, 'farol');
  check(acc && acc.end && acc.end.phase === 'play' && acc.end.accResult && acc.end.accResult.yes === 1 && acc.end.accResult.no === 1 && acc.end.accResult.none === 0,
    'Acusación sin unanimidad: no prospera y la tele dice «1 a favor, 1 en contra» (sin decir quién)');
  check(acc && acc.frozen && acc.anon, 'El reloj de la ronda se para durante la acusación y los votos son anónimos (solo quién ha votado y el recuento)');
  tm = tv.mark();
  bySlot[spy].send({ t: 'i.accuse', suspect: x2 });
  await H_.sleep(150);
  check(!tv.since(tm, 'imeta').some(function (x) { return x.phase === 'accuse'; }) && tv.find('imeta').accUsed.indexOf(spy) >= 0, 'Cada uno acusa una vez por ronda: la segunda no vale');
  // x1 accuses x2; the spy does not vote -> fails when the 30 s run out
  acc = await accuse(G, R, x1, x2, { [x1]: true, [spy]: undefined }, 'sin votar');
  check(acc && acc.end && acc.end.phase === 'play' && acc.end.accResult.yes === 1 && acc.end.accResult.no === 0 && acc.end.accResult.none === 1 && (acc.end._at - acc.start._at) >= 30000 / SPEED - 150,
    'Si alguien no vota en 30 s, no hay unanimidad: no prospera');
  // x2 accuses the spy: unanimous -> caught
  acc = await accuse(G, R, x2, spy, { [x2]: true, [x1]: true }, 'pillado');
  await waitReveal(G, R);
  check(R.result && R.result.how === 'acusacion' && R.result.spyWins === false && R.result.accuser === x2 && R.result.suspect === spy && R.result.yes === 2,
    'Acusación unánime contra el infiltrado: se acaba la ronda y se desvela');
  check(R.result && R.result.location === R.loc && R.result.roles.length === 2 && R.result.spyName === G.names[spy], 'Revelación: quién era, el lugar y el papel de cada uno');
  score(G, R, 'Ronda 1 (pillado por acusación)');
  checkAudit(G, R, 'Ronda 1');

  // ---- Round 2: a non-spy cannot guess; the spy guesses right
  R = await beginRound(G, 2);
  if (!R) return G;
  starters.push(R.play.asker);
  tm = tv.mark();
  bySlot[R.others[0]].send({ t: 'i.guess', i: R.locIdx });
  await H_.sleep(150);
  check(!tv.since(tm, 'imeta').some(function (x) { return x.phase !== 'play'; }), 'Solo el infiltrado puede decir «¡Sé el lugar!»');
  bySlot[R.spy].send({ t: 'i.guess', i: R.locIdx });
  await waitReveal(G, R);
  check(R.result && R.result.how === 'adivina' && R.result.guessOk && R.result.spyWins && R.result.guess === R.loc, 'El infiltrado acierta el lugar: se acaba la ronda al momento');
  score(G, R, 'Ronda 2 (acierta el lugar)');
  checkAudit(G, R, 'Ronda 2');

  // ---- Round 3: the spy guesses wrong
  R = await beginRound(G, 3);
  if (!R) return G;
  starters.push(R.play.asker);
  const wrong = R.play.places.map(function (p, i) { return i; }).filter(function (i) { return i !== R.locIdx && !R.play.places[i].used; })[3];
  bySlot[R.spy].send({ t: 'i.guess', i: wrong });
  await waitReveal(G, R);
  check(R.result && R.result.how === 'adivina' && !R.result.guessOk && !R.result.spyWins && R.result.guess === R.play.places[wrong].name, 'El infiltrado falla el lugar: pierde la ronda');
  check(R.play.places.filter(function (p) { return p.used; }).length === 2, 'La lista marca los lugares que ya han salido en la partida');
  score(G, R, 'Ronda 3 (falla el lugar)');
  checkAudit(G, R, 'Ronda 3');
  check(new Set(starters).size === 3, 'Cada ronda empieza preguntando otro: ' + starters.map(function (s) { return G.names[s]; }).join(', '));

  // ---- End and another match
  const end = await tv.wait(function (x) { return x.t === 'imeta' && x.match === G.match && x.phase === 'end'; }, 3000, 'final', G.tvFrom);
  const rk = end ? end.ranking : [];
  check(end && rk.length === 3 && rk.every(function (r, k) { return r.score === (G.expected[r.slot] || 0) && r.rank === 1 + rk.filter(function (o) { return o.score > r.score; }).length && (k === 0 || rk[k - 1].score >= r.score); }),
    'Final: clasificación ordenada con puestos (empates comparten puesto): ' + rk.map(function (r) { return r.rank + 'º ' + r.name + ' ' + r.score; }).join(', '));
  // The next match: 4 min rounds, time runs out every round
  bySlot[2].send({ t: 'i.cfg', minutes: 4 });
  await bySlot[1].wait(function (x) { return x.t === 'i.cfg' && x.minutes === 4; }, 1500, 'cfg 4');
  const prevMatch = G.match, prevFirst = starters[0];
  tm = tv.mark();
  bySlot[3].send({ t: 'i.again' });
  const again = await tv.wait(function (x) { return x.t === 'imeta' && x.match !== prevMatch && x.round === 1; }, 3000, 'otra partida', tm);
  if (!check(!!again && again.minutes === 4 && again.clockTotal === 240000 && again.scores.every(function (s) { return s === 0; }), '«Jugar otra vez»: marcador a cero y rondas de 4 min')) return G;
  G.match = again.match; G.tvFrom = tm; G.used = []; G.expected = {};
  check(again.asker !== prevFirst, 'En la partida nueva empieza preguntando otro (' + G.names[again.asker] + ')');

  // Round 1: time up, everybody votes the spy, the spy guesses right (steals the round)
  R = await beginRound(G, 1);
  if (!R) return G;
  let fv = await finalVote(G, R, { [R.others[0]]: R.spy, [R.others[1]]: R.spy, [R.spy]: R.others[0] });
  check(fv && fv.start._at - R.play._at >= 240000 / SPEED - 300 && fv.start.vote && fv.start.vote.voters.length === 3, 'Se acaba el tiempo (4 min): votación final de todos');
  check(fv && fv.selfIgnored, 'Nadie puede votarse a sí mismo');
  check(fv && fv.end && fv.end.phase === 'lastguess' && fv.end.caught === R.spy && !fv.end.result, 'La mayoría pilla al infiltrado: última oportunidad de adivinar (y el lugar sigue en secreto)');
  bySlot[R.spy].send({ t: 'i.guess', i: R.locIdx });
  await waitReveal(G, R);
  check(R.result && R.result.how === 'ultima' && R.result.guessOk && R.result.spyWins && R.result.tally[0].slot === R.spy && R.result.tally[0].votes === 2, 'Adivina el lugar en la última oportunidad: se lleva la ronda');
  score(G, R, 'Partida 2, ronda 1 (pillado, pero adivina)');
  checkAudit(G, R, 'Partida 2, ronda 1');
  // Round 2: caught, guesses wrong
  R = await beginRound(G, 2);
  if (!R) return G;
  fv = await finalVote(G, R, { [R.others[0]]: R.spy, [R.others[1]]: R.spy, [R.spy]: R.others[1] });
  check(fv && fv.end && fv.end.phase === 'lastguess', 'Ronda 2: pillado en la votación');
  bySlot[R.spy].send({ t: 'i.guess', i: R.play.places.map(function (p, i) { return i; }).filter(function (i) { return i !== R.locIdx; })[7] });
  await waitReveal(G, R);
  check(R.result && R.result.how === 'ultima' && !R.result.guessOk && !R.result.spyWins, 'Falla en la última oportunidad: ganan los demás');
  score(G, R, 'Partida 2, ronda 2 (pillado y falla)');
  checkAudit(G, R, 'Partida 2, ronda 2');
  // Round 3: a tie (1-1-1) saves the spy
  R = await beginRound(G, 3);
  if (!R) return G;
  fv = await finalVote(G, R, { [R.others[0]]: R.spy, [R.others[1]]: R.others[0], [R.spy]: R.others[1] });
  await waitReveal(G, R);
  check(fv && fv.end && fv.end.phase === 'reveal' && R.result && R.result.how === 'empate' && R.result.spyWins && R.result.tally.length === 3, 'Empate en la votación final: se salva el infiltrado');
  score(G, R, 'Partida 2, ronda 3 (empate)');
  checkAudit(G, R, 'Partida 2, ronda 3');
  await tv.wait(function (x) { return x.t === 'imeta' && x.match === G.match && x.phase === 'end'; }, 3000, 'final 2', G.tvFrom);
  return G;
}

// «Lugares propios» with the same 3 players
async function customPlaces(G) {
  console.log('\n[Lugares propios]');
  const tv = G.tv, bySlot = G.bySlot;
  await leaveToMenu(G);
  bySlot[1].send({ t: 'i.places', list: [{ name: 'El trastero de Ana', roles: 'Dueña, Caja vieja, Araña' }, 'Una casa encantada', 'Una playa'] });
  bySlot[2].send({ t: 'i.places', list: ['La azotea de Berto'] });
  bySlot[3].send({ t: 'i.places', list: ['una casa encantada', { name: 'El karaoke del barrio', roles: ['Cantante desafinado', 'Dueña', 'Fan', 'Técnico'] }] });
  const back = await bySlot[1].wait(function (m) { return m.t === 'i.places' && m.list.length === 2; }, 1500, 'lugares de Ana');
  check(back && back.max === 5 && back.list[0].roles.length === 3 && !back.list.some(function (p) { return p.name === 'Una playa'; }), 'Ana guarda 2 lugares propios (uno con papeles); «Una playa» ya estaba en la lista');
  const hub = await tv.wait(function (m) { return m.t === 'hub' && m.players[2] && m.players[2].badges.indexOf('2 lugares propios') >= 0 && m.players[1].badges.indexOf('1 lugar propio') >= 0; }, 1500, 'insignias');
  check(!!hub && !JSON.stringify(hub).match(/azotea|trastero|karaoke|encantada/i), 'La tele ve «2 lugares propios» junto al nombre, nunca los lugares');
  G.customs = ['El trastero de Ana', 'Una casa encantada', 'La azotea de Berto', 'El karaoke del barrio'];
  const authors = { 'trastero de ana': [1], 'casa encantada': [1, 3], 'azotea de berto': [2], 'karaoke del barrio': [3] };
  bySlot[1].send({ t: 'i.cfg', minutes: 0 });
  await bySlot[2].wait(function (m) { return m.t === 'i.cfg' && m.minutes === 0; }, 1500, 'auto');
  G.expected = {};
  const first = await pickGame(G, 2);
  check(first && first.minutes === 6 && first.places.length === I.LOCATIONS.length + 4 && first.places.filter(function (p) { return p.custom; }).length === 4,
    'La partida incluye los 4 lugares propios en la lista (sin repetir el de dos autores); duración automática: 6 min con 3');
  let used = 0, own = 0;
  for (let r = 1; r <= 3; r++) {
    const R = await beginRound(G, r);
    if (!R) break;
    bySlot[R.spy].send({ t: 'i.guess', i: R.locIdx === 0 ? 1 : 0 });
    await waitReveal(G, R);
    if (!R.result) break;
    if (R.result.custom) {
      used++;
      if ((authors[nk(R.result.location)] || []).indexOf(R.spy) >= 0) own++;
      if (nk(R.result.location) === 'azotea de berto') check(R.others.every(function (s) { return I.GENERIC_ROLES.indexOf(R.cards[s].role) >= 0; }), 'Un lugar propio sin papeles reparte papeles genéricos');
    }
    checkAudit(G, R, 'Lugares propios, ronda ' + r + ' («' + R.result.location + '», infiltrado ' + G.names[R.spy] + ')');
  }
  check(used >= 1 && !own, 'Salen lugares propios (' + used + ' de 3 rondas) y nunca con su autor de infiltrado');
}

async function leaveToMenu(G) {
  G.tv.send({ t: 'menu' });
  await G.tv.wait(function (m) { return m.t === 'hub' && m.screen === 'menu'; }, 2000, 'menú');
}

// ---------------------------------------------------------------- 4 players
async function groupOf4(tv) {
  console.log('\n[4 jugadores: reconexiones, votación final y salidas]');
  const bySlot = await joinRoom(['Dani', 'Eva', 'Fran', 'Gala'], 'i4-');
  const G = { tv: tv, bySlot: bySlot, names: namesOf(bySlot), expected: {}, customs: [] };
  bySlot[4].send({ t: 'i.cfg', minutes: 0 });
  await bySlot[1].wait(function (m) { return m.t === 'i.cfg' && m.minutes === 0; }, 1500, 'auto');
  const first = await pickGame(G, 2);
  check(first && first.rounds === 4 && first.minutes === 6 && first.clockTotal === 360000, '4 jugadores: 4 rondas; automático = 6 min');
  let R = await beginRound(G, 1);
  if (!R) return;
  const x = R.others[0], spy = R.spy;
  // A non-spy drops: pause; comes back with the same card
  let tm = tv.mark();
  const oldCard = bare(R.cards[x]);
  await bySlot[x].close();
  const paused = await tv.wait(function (m) { return m.t === 'imeta' && m.paused; }, 1500, 'pausa', tm);
  await H_.sleep(400);
  const later = tv.find('imeta');
  check(paused && later.paused && later.clock === paused.clock && paused.waiting[0] === G.names[x], 'Si se desconecta ' + G.names[x] + ': pausa con su nombre y el reloj parado');
  // Settings change during the round: only from the next round on
  bySlot[spy].send({ t: 'i.cfg', minutes: 4 });
  const x2 = await H_.phone(WS, G.names[x], 'i4-' + G.names[x]);
  bySlot[x] = x2;
  const card2 = await x2.wait(function (m) { return m.t === 'i.card' && m.match === G.match && m.round === 1; }, 1500, 'carta otra vez');
  const meta2 = await x2.wait(function (m) { return m.t === 'imeta' && m.match === G.match; }, 1500, 'estado');
  check(card2 && bare(card2) === oldCard && meta2 && meta2.asker === R.play.asker && meta2.phase === 'play', 'Al reconectar, ' + G.names[x] + ' recibe la MISMA carta y el turno actual');
  check(!!(await tv.wait(function (m) { return m.t === 'imeta' && !m.paused; }, 1500, 'reanuda', tv.msgs.indexOf(later))), 'Vuelve y se reanuda');
  // The spy drops and comes back
  const spyCard = bare(R.cards[spy]);
  tm = tv.mark();
  await bySlot[spy].close();
  await tv.wait(function (m) { return m.t === 'imeta' && m.paused; }, 1500, 'pausa 2', tm);
  const s2 = await H_.phone(WS, G.names[spy], 'i4-' + G.names[spy]);
  bySlot[spy] = s2;
  const sc = await s2.wait(function (m) { return m.t === 'i.card' && m.match === G.match && m.round === 1; }, 1500, 'carta del infiltrado');
  const sm = await s2.wait(function (m) { return m.t === 'imeta' && m.match === G.match; }, 1500, 'estado infiltrado');
  check(sc && bare(sc) === spyCard && sc.location === null && sm && !mentions(sm, R.loc), 'El infiltrado reconecta: su misma carta (sin lugar) y el estado público');
  check(Buffer.byteLength(bare(sc)) === Buffer.byteLength(bare(card2)) && Object.keys(sc).join() === Object.keys(card2).join(), 'Su carta al reconectar es igual de forma y tamaño que la de los demás');
  R.skip = [x, spy];
  R.start[x] = 0;      // their new connections are audited from the start
  R.start[spy] = 0;
  // A TV that connects in the middle: public state only
  const tv2 = H_.makeClient(WS, 'tele2');
  await tv2.ready;
  tv2.send({ t: 'hello', role: 'tv' });
  const tvm = await tv2.wait(function (m) { return m.t === 'imeta'; }, 1500, 'tele2 imeta');
  await H_.sleep(100);
  check(tvm && !tv2.find('i.card') && !tv2.msgs.some(function (m) { return mentions(m, R.loc); }) && !tvm.result && tvm.places.length === I.LOCATIONS.length,
    'Una tele que se conecta a mitad recibe solo el estado público');
  tv2.ws.terminate();
  // Time up (6 min): the majority votes an innocent
  await H_.waitUntil(function () { return tv.find('imeta').paused === false; }, 1500, 'sin pausa');
  const victim = R.others[1];
  const fv = await finalVote(G, R, { [R.others[0]]: victim, [R.others[2]]: victim, [spy]: victim, [victim]: R.others[0] });
  await waitReveal(G, R);
  check(fv && R.result && R.result.how === 'votacion' && R.result.spyWins && R.result.suspect === victim && R.result.tally[0].votes === 3,
    'La votación final señala a un inocente (' + G.names[victim] + '): gana el infiltrado');
  check(R.rev.clockTotal === 360000, 'El cambio de duración no afecta a la ronda en juego');
  score(G, R, 'Ronda 1 (votan a un inocente)');
  checkAudit(G, R, 'Ronda 1 con reconexiones');

  // Round 2: 4 min; caught by the final vote and the last 30 s run out
  R = await beginRound(G, 2);
  if (!R) return;
  check(R.play.minutes === 4 && R.play.clockTotal === 240000, 'Ronda 2: ya con los 4 min que eligió ' + G.names[spy]);
  const votes = {};
  R.players.forEach(function (s) { votes[s] = s === R.spy ? R.others[0] : R.spy; });
  await finalVote(G, R, votes);
  const lg = await tv.wait(isMeta(G, 2, ['lastguess']), 2000, 'última', R.tvStart);
  await waitReveal(G, R);
  check(lg && R.result && R.result.how === 'ultima' && !R.result.guess && !R.result.spyWins && (R.rev._at - lg._at) >= 30000 / SPEED - 150, 'Pillado y sin responder en 30 s: ganan los demás');
  score(G, R, 'Ronda 2 (pillado, no adivina)');
  checkAudit(G, R, 'Ronda 2');

  // Round 3: an accusation against an innocent passes -> the spy wins
  R = await beginRound(G, 3);
  if (!R) return;
  const [a, b, c] = R.others;
  const acc = await accuse(G, R, a, b, { [a]: true, [c]: true, [R.spy]: true }, 'inocente');
  await waitReveal(G, R);
  check(acc && R.result && R.result.how === 'acusacion' && R.result.spyWins && R.result.suspect === b, 'Prospera una acusación contra un inocente: gana el infiltrado');
  score(G, R, 'Ronda 3 (acusan a un inocente)');
  checkAudit(G, R, 'Ronda 3');

  // Round 4: during the final vote somebody leaves for good; their votes and the votes for them go away
  R = await beginRound(G, 4);
  if (!R) return;
  const gone = R.others[0], rest = R.others.slice(1);
  const v = await tv.wait(isMeta(G, 4, ['vote']), 10000, 'votación 4', R.tvStart);
  bySlot[rest[0]].send({ t: 'i.final', suspect: gone });
  bySlot[gone].send({ t: 'i.final', suspect: R.spy });
  await tv.wait(function (m) { return m.t === 'imeta' && m.vote && m.vote.voted.length === 2; }, 1500, '2 votos', tv.msgs.indexOf(v));
  tm = tv.mark();
  await bySlot[gone].close();
  R.gone.push(gone);
  const leftEv = await tv.wait(function (m) { return m.t === 'ev' && m.k === 'left'; }, HOLD + 3000, 'se va', tm);
  const after = await tv.wait(function (m) { return m.t === 'imeta' && !m.paused && m.players.indexOf(gone) < 0; }, 2000, 'sin él', tm);
  check(leftEv && leftEv.name === G.names[gone] && after && after.phase === 'vote' && after.vote.voters.length === 3 && after.vote.voted.length === 0,
    G.names[gone] + ' se va del todo: sale de la votación y el voto por él no cuenta (hay que repetirlo)');
  bySlot[rest[0]].send({ t: 'i.final', suspect: R.spy });
  bySlot[rest[1]].send({ t: 'i.final', suspect: R.spy });
  bySlot[R.spy].send({ t: 'i.final', suspect: rest[0] });
  await tv.wait(isMeta(G, 4, ['lastguess']), 2000, 'última 4', tm);
  bySlot[R.spy].send({ t: 'i.guess', i: R.locIdx });
  await waitReveal(G, R);
  check(R.result && R.result.how === 'ultima' && R.result.spyWins && R.result.roles.length === 2, 'La partida sigue con 3 y el infiltrado se salva adivinando');
  score(G, R, 'Ronda 4');
  delete bySlot[gone];
  const end = await tv.wait(function (m) { return m.t === 'imeta' && m.match === G.match && m.phase === 'end'; }, 3000, 'fin', G.tvFrom);
  check(end && end.ranking.length === 3, 'Final con los 3 que quedan');
  // Falling below 3 players: back to the menu, with the reason
  tm = tv.mark();
  bySlot[rest[0]].send({ t: 'leave' });
  const menu = await tv.wait(function (m) { return m.t === 'ev' && m.k === 'menu'; }, 2000, 'menú', tm);
  const phoneMenu = await bySlot[R.spy].wait(function (m) { return m.t === 'ev' && m.k === 'menu'; }, 2000, 'menú móvil');
  check(menu && /necesita al menos 3 jugadores/.test(menu.text) && phoneMenu && phoneMenu.text === menu.text && tv.hub.screen === 'menu', 'Si quedan menos de 3: al menú con el motivo («' + (menu && menu.text) + '»)');
  Object.keys(bySlot).forEach(function (s) { bySlot[s].send({ t: 'leave' }); });
  await tv.wait(function (m) { return m.t === 'hub' && m.players.every(function (p) { return !p; }); }, 2000, 'sala vacía');
}

// ---------------------------------------------------------------- 6 players
async function groupOf6(tv) {
  console.log('\n[6 jugadores: alguien se va, el infiltrado se va]');
  const bySlot = await joinRoom(['Hugo', 'Inés', 'Juan', 'Lara', 'Mario', 'Nora'], 'i6-');
  const G = { tv: tv, bySlot: bySlot, names: namesOf(bySlot), expected: {}, customs: [] };
  bySlot[5].send({ t: 'i.cfg', minutes: 0 });
  await bySlot[6].wait(function (m) { return m.t === 'i.cfg' && m.minutes === 0 && m.by === 'Mario'; }, 1500, 'auto');
  const first = await pickGame(G, 6);
  check(first && first.players.length === 6 && first.rounds === 6 && first.minutes === 8, '6 jugadores: 6 rondas; automático = 8 min');
  let R = await beginRound(G, 1);
  if (!R) return;
  check(R.others.length === 5 && new Set(R.others.map(function (s) { return R.cards[s].role; })).size === 5, 'Con 6: 5 papeles distintos y un infiltrado');
  // The asker (not the spy) leaves for good: the turn passes on
  let asker = R.play.asker;
  if (asker === R.spy) {
    const to = R.others[0];
    bySlot[asker].send({ t: 'i.ask', to: to });
    await tv.wait(function (m) { return m.t === 'imeta' && m.asker === to; }, 1500, 'turno');
    asker = to;
  }
  const leaver = asker;
  const order = R.players.slice();
  const nextUp = order[(order.indexOf(leaver) + 1) % order.length];
  let tm = tv.mark();
  bySlot[leaver].send({ t: 'leave' });
  R.gone.push(leaver);
  const after = await tv.wait(function (m) { return m.t === 'imeta' && m.players.indexOf(leaver) < 0; }, 2000, 'sin él', tm);
  check(after && after.players.length === 5 && after.asker === nextUp && after.askedBy === 0 && after.phase === 'play' && after.rounds <= 6,
    G.names[leaver] + ' (le tocaba preguntar) se va: pregunta ' + G.names[nextUp] + ' y la ronda sigue con 5 (' + (after && after.rounds) + ' rondas)');
  delete bySlot[leaver];
  // A failed accusation with 5: the «No» arrives first, it ends only when everybody has voted
  const inn = R.others.filter(function (s) { return s !== leaver; });
  const fv = { [inn[0]]: true, [inn[2]]: false, [inn[3]]: true, [R.spy]: true };
  const failAcc = await accuse(G, R, inn[0], inn[1], fv, 'con un No');
  check(failAcc && failAcc.end && failAcc.end.phase === 'play' && !failAcc.earlyEnd && failAcc.end.accResult.yes === 3 && failAcc.end.accResult.no === 1,
    'Con 5: un «No» entre cuatro votos no acaba la votación antes de tiempo (no se sabe quién fue): «3 a favor, 1 en contra»');
  // Accusation with 5: the spy is caught by the 4 others
  const voters = {};
  inn.forEach(function (s) { voters[s] = true; });
  const by = inn[1];
  const acc = await accuse(G, R, by, R.spy, voters, 'con 5');
  await waitReveal(G, R);
  check(acc && R.result && R.result.how === 'acusacion' && !R.result.spyWins && R.result.yes === 4, 'Acusación unánime de 4 contra el infiltrado');
  score(G, R, 'Ronda 1 con 6 (uno se va)');
  checkAudit(G, R, 'Ronda 1 con 6');
  // Round 2: the spy leaves for good -> no points, next round
  R = await beginRound(G, 2);
  if (!R) return;
  const before = R.play.scores.slice();
  tm = tv.mark();
  await bySlot[R.spy].close();
  R.gone.push(R.spy);
  await waitReveal(G, R);
  check(R.result && R.result.how === 'abandono' && R.result.spyWins === null && R.result.points.length === 0 && R.result.scores.join() === before.join() && R.result.spyName === G.names[R.spy] && (R.rev._at - tv.msgs[tm]._at) >= HOLD - 300,
    'El infiltrado (' + G.names[R.spy] + ') no vuelve: «El infiltrado ha abandonado», sin puntos');
  delete bySlot[R.spy];
  score(G, R, 'Ronda 2 (abandona el infiltrado)');
  checkAudit(G, R, 'Ronda 2 con 6');
  R = await beginRound(G, 3);
  check(R && R.players.length === 4 && !!R.spy && R.others.every(function (s) { return R.cards[s].location === R.loc; }), 'Ronda 3 con los 4 que quedan: cartas nuevas y un infiltrado nuevo');
  if (!R) return;
  let rounds = R.play.rounds, r = 3;
  // The rest: the spy guesses (right in round 3, wrong after)
  while (R) {
    bySlot[R.spy].send({ t: 'i.guess', i: r === 3 ? R.locIdx : (R.locIdx === 0 ? 1 : 0) });
    await waitReveal(G, R);
    if (!R.result) break;
    score(G, R, 'Ronda ' + r);
    const bad = audit(G, R);
    if (bad.length) check.fail('Ronda ' + r + ' con 4: ' + bad.join(' | '));
    if (r >= rounds) break;
    r++;
    R = await beginRound(G, r);
  }
  const end = await tv.wait(function (m) { return m.t === 'imeta' && m.match === G.match && m.phase === 'end'; }, 3000, 'fin', G.tvFrom);
  check(end && end.ranking.length === 4 && r === rounds, 'Final con 4 tras ' + rounds + ' rondas (las de quien se fue ya no se juegan)');
  await leaveAll(G);
}

(async function () {
  unit();
  const HOME = H_.tmpHome('g2t-inf-');
  const srv = await H_.startServer({
    GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', SLOT_HOLD_MS: String(HOLD),
    INFILTRADO_DEBUG_SPEED: String(SPEED), INFILTRADO_PROB_PROPIO: '1'
  });
  const clients = [];
  try {
    const tv = H_.makeClient(WS, 'tele'); clients.push(tv);
    await tv.ready;
    tv.send({ t: 'hello', role: 'tv' });
    await H_.waitUntil(function () { return tv.hub; }, 2000, 'hub');
    const G3 = await groupOf3(tv);
    Object.keys(G3.bySlot).forEach(function (s) { clients.push(G3.bySlot[s]); });
    await customPlaces(G3);
    await leaveAll(G3);
    await groupOf4(tv);
    await groupOf6(tv);
    check(!/Error/.test(srv.out), 'Sin errores en el registro del servidor');
    check(!/infiltrado\] Ronda \d+ de \d+:.*(era el infiltrado|«)/.test(srv.out), 'El registro no dice quién es el infiltrado ni el lugar antes de la revelación');
  } catch (e) {
    check.fail('Excepción: ' + (e && e.stack || e));
  } finally {
    clients.forEach(function (c) { try { c.ws.terminate(); } catch (e) { /* noop */ } });
    await srv.stop();
    H_.rmrf(HOME);
    if (check.counts().failed) console.log('\n--- Registro del servidor ---\n' + srv.out.split('\n').slice(-60).join('\n'));
  }
  check.done();
})();
