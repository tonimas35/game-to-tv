'use strict';
/*
 * «Dibuja y adivina» for 3 to 6 players («todos contra todos») through the
 * real server with fake phones: whole matches with 3, 4 and 6.
 * Checks: points by order of arrival and for the drawer, nothing that gives
 * the word away before the reveal (neither the word nor the text of a correct
 * guess, «¡Casi!» private), the «¡Acertaste!» lock, the drawer rotation, the
 * number of «vueltas», secret words of other players, pauses, a drawer who
 * leaves for good, and the final ranking and gallery.
 *
 *   node test/dibuja-grupo.test.js
 */
const H_ = require('./helpers');
const Dibuja = require('../src/games/dibuja');
const { normalize } = require('../src/games/dibuja/match');
const check = H_.checker('Dibuja y adivina de 3 a 6 jugadores');

const PORT = parseInt(process.env.TEST_PORT, 10) || 3992;
const WS = 'ws://127.0.0.1:' + PORT + '/ws';
const SPEED = 20;            // an 80 s round lasts 4 real seconds
const HOLD = 1500;           // SLOT_HOLD_MS

// ---------------------------------------------------------------- helpers
function containsText(msg, text) {
  const w = normalize(text);
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
function casiVariant(word) {
  const base = normalize(word).replace(/\s+/g, '');
  const tol = base.length >= 9 ? 2 : (base.length >= 5 ? 1 : 0);
  const arr = base.split('');
  let changed = 0;
  for (let i = arr.length - 1; i >= 0 && changed < tol + 1; i--) { arr[i] = arr[i] === 'q' ? 'x' : 'q'; changed++; }
  return arr.join('');
}
// A correct guess that is NOT the word itself (typo / article / capitals), when possible
function okVariant(word, k) {
  const n = normalize(word);
  if (n.replace(/\s+/g, '').length >= 5 && k % 2 === 0) { const i = Math.max(1, Math.floor(n.length / 2)); return n.slice(0, i) + n.slice(i + 1); }
  return 'La ' + word.toUpperCase() + ' ';
}

function marksOf(bySlot) {
  const out = {};
  Object.keys(bySlot).forEach(function (s) { out[s] = bySlot[s].msgs.length; });
  return out;
}

async function joinRoom(names, prefix) {
  const bySlot = {};
  for (let i = 0; i < names.length; i++) {
    const p = await H_.phone(WS, names[i], prefix + names[i]);
    bySlot[p.find('joined').slot] = p;
  }
  return bySlot;
}

/*
 * Plays one round. plan: {
 *   guessers: [slot...] who guess right, in this order (the rest only guess wrong),
 *   wrong: slot that sends a wrong guess, casi: slot that sends a «¡Casi!» guess,
 *   pickCustom: true -> the drawer picks the secret word if offered,
 *   timeout: true -> wait for the end of the time
 * }
 */
async function playRound(ctx, r, plan) {
  const tv = ctx.tv;
  const intro = await tv.wait(function (m) { return m.t === 'dmeta' && m.round === r && (m.phase === 'intro' || m.phase === 'choose'); }, 10000, 'ronda ' + r, ctx.tvFrom);
  if (!intro) return null;
  const drawer = intro.drawer;
  const D = ctx.bySlot[drawer];
  // Every phone is checked from the end of the previous round (or the pick)
  const start = {};
  Object.keys(ctx.bySlot).forEach(function (s) { start[s] = ctx.phoneFrom && ctx.phoneFrom[s] != null ? ctx.phoneFrom[s] : 0; });
  const tvStart = tv.msgs.indexOf(intro);
  const opts = await D.wait(function (m) { return m.t === 'd.opts' && m.round === r; }, 4000, 'opciones', start[drawer]);
  if (!opts) return null;
  const customs = opts.opts.filter(function (o) { return o.custom; });
  ctx.customsOffered.push({ drawer: drawer, customs: customs });
  let idx = 0;
  if (plan.pickCustom && customs.length) idx = opts.opts.indexOf(customs[0]);
  D.send({ t: 'd.pick', i: idx });
  const sec = await D.wait(function (m) { return m.t === 'd.secret' && m.round === r; }, 3000, 'secreta', start[drawer]);
  if (!sec) return null;
  const word = sec.word;
  const draw = await tv.wait(function (m) { return m.t === 'dmeta' && m.round === r && m.phase === 'draw'; }, 3000, 'draw', tvStart);
  if (!draw) return null;
  const author = draw.author || 0; // public: «su palabra» (never the word)
  D.send({ t: 'd.s', id: 1, c: '#1e88e5', w: 0.02, p: [0.2, 0.2, 0.5 + r * 0.03, 0.6, 0.8, 0.3], end: 1 });
  const sent = { casi: null, ok: [], wrong: null };
  const res = { r: r, drawer: drawer, word: word, diff: sec.diff, author: author, guessersMeta: draw.guessers.slice(), lockOk: null, casiPrivate: null, wrongPublic: null, authorIgnored: null };

  if (plan.wrong) {
    const w = ctx.bySlot[plan.wrong];
    const tvM = tv.mark();
    w.send({ t: 'd.guess', text: 'zzzz qqqq' });
    sent.wrong = 'zzzz qqqq';
    const g = await tv.wait(function (m) { return m.t === 'd.g' && m.res === 'no' && m.slot === plan.wrong; }, 1500, 'intento erróneo', tvM);
    const fm = await tv.wait(function (m) { return m.t === 'dmeta' && m.guesses && m.guesses.some(function (x) { return x.slot === plan.wrong && x.text === 'zzzz qqqq'; }); }, 1500, 'feed', tvM);
    res.wrongPublic = !!g && !!fm;
  }
  if (plan.casi) {
    const c = ctx.bySlot[plan.casi];
    const cm = c.mark();
    sent.casi = casiVariant(word);
    c.send({ t: 'd.guess', text: sent.casi });
    const g = await c.wait(function (m) { return m.t === 'd.g' && m.res === 'casi'; }, 1500, 'casi', cm);
    res.casiPrivate = !!g && g.mine === true;
  }
  if (author) {
    const a = ctx.bySlot[author];
    const am = a.mark();
    a.send({ t: 'd.guess', text: word });
    await H_.sleep(250);
    res.authorIgnored = !a.since(am, 'd.g').length && !a.since(am, 'd.got').length && draw.guessers.indexOf(author) < 0;
  }
  const okList = (plan.guessers || []).filter(function (s) { return s !== author; });
  for (let k = 0; k < okList.length; k++) {
    const s = okList[k];
    const g = ctx.bySlot[s];
    const gm = g.mark();
    const text = okVariant(word, k + r);
    sent.ok.push({ slot: s, text: text });
    await H_.sleep(170); // the server ignores guesses less than 150 ms apart from the same phone
    g.send({ t: 'd.guess', text: text });
    const mine = await g.wait(function (m) { return m.t === 'd.g' && m.res === 'ok' && m.mine; }, 1500, 'acierto ' + s, gm);
    if (k === 0 && mine) {
      // «¡Acertaste!» lock: further guesses are ignored
      const lm = g.mark();
      const tvL = tv.mark();
      g.send({ t: 'd.guess', text: 'otra cosa' });
      await H_.sleep(200);
      g.send({ t: 'd.guess', text: word });
      await H_.sleep(200);
      res.lockOk = !g.since(lm, 'd.g').length && !tv.since(tvL, 'd.g').length && !tv.since(tvL, 'd.got').length;
    }
  }
  const rev = await tv.wait(function (m) { return m.t === 'd.reveal' && m.round === r; }, plan.timeout ? 9000 : 4000, 'reveal ' + r, tvStart);
  if (!rev) return null;
  res.rev = rev;
  // ---- No spoilers before the reveal: the TV and every phone but the drawer
  const leaks = [];
  const tvBefore = tv.msgs.slice(tvStart, tv.msgs.indexOf(rev));
  tvBefore.forEach(function (m) { if (containsText(m, word)) leaks.push('tele: ' + m.t); });
  Object.keys(ctx.bySlot).forEach(function (s) {
    s = Number(s);
    if (s === drawer) return;
    const p = ctx.bySlot[s];
    const pr = p.msgs.indexOf(p.find('d.reveal') && p.find('d.reveal').round === r ? p.find('d.reveal') : null);
    const before = p.msgs.slice(start[s], pr >= 0 ? pr : p.msgs.length);
    before.forEach(function (m) { if (containsText(m, word) || m.t === 'd.secret' || m.t === 'd.opts') leaks.push(ctx.names[s] + ': ' + m.t); });
    // The text of a correct guess never reaches anybody else (nor comes back)
    sent.ok.forEach(function (o) {
      if (normalize(o.text) === normalize(word)) return; // same as the word: covered above
      before.forEach(function (m) { if (containsText(m, o.text)) leaks.push(ctx.names[s] + ' ve el acierto de ' + ctx.names[o.slot] + ' (' + m.t + ')'); });
    });
    if (sent.casi && s !== plan.casi) before.forEach(function (m) { if (containsText(m, sent.casi)) leaks.push(ctx.names[s] + ' ve el «casi» (' + m.t + ')'); });
  });
  sent.ok.forEach(function (o) {
    if (normalize(o.text) === normalize(word)) return;
    tv.msgs.slice(tvStart).forEach(function (m) { if (containsText(m, o.text)) leaks.push('tele ve el acierto de ' + ctx.names[o.slot] + ' (' + m.t + ')'); });
  });
  if (sent.casi) tvBefore.forEach(function (m) { if (containsText(m, sent.casi)) leaks.push('tele ve el «casi» (' + m.t + ')'); });
  res.leaks = leaks;
  res.checked = tvBefore.length;
  ctx.tvFrom = tv.msgs.indexOf(rev);
  ctx.phoneFrom = {};
  Object.keys(ctx.bySlot).forEach(function (s) { ctx.phoneFrom[s] = ctx.bySlot[s].msgs.length; });
  return res;
}

function checkScoring(ctx, res) {
  const rev = res.rev;
  const n = res.guessersMeta.length;
  let ok = rev.mode === 'ffa' && rev.guessers === n;
  let dp = 0;
  rev.results.forEach(function (x, k) {
    if (x.order !== k + 1) ok = false;
    if (x.points !== Dibuja.guessPoints(k, x.secs, rev.diff)) ok = false;
    if (k > 0 && x.points >= rev.results[k - 1].points) ok = false;
    dp += Dibuja.drawerPoints(k, n, rev.diff);
    ctx.expected[x.slot] = (ctx.expected[x.slot] || 0) + x.points;
  });
  if (rev.drawerPoints !== dp) ok = false;
  ctx.expected[res.drawer] = (ctx.expected[res.drawer] || 0) + dp;
  Object.keys(ctx.bySlot).forEach(function (s) { if ((rev.scores[s - 1] || 0) !== (ctx.expected[s] || 0)) ok = false; });
  return ok;
}

async function finishMatch(ctx, label, rounds) {
  const tv = ctx.tv;
  const end = await tv.wait(function (m) { return m.t === 'dmeta' && m.phase === 'end'; }, 8000, 'fin', ctx.tvFrom);
  const gal = await tv.wait(function (m) { return m.t === 'd.gallery'; }, 2000, 'galería', ctx.tvFrom);
  if (!check(!!end, label + ': fin de la partida')) return null;
  const rk = end.ranking || [];
  let sorted = true;
  for (let i = 1; i < rk.length; i++) if (rk[i].score > rk[i - 1].score) sorted = false;
  const ranksOk = rk.every(function (r) { return r.rank === 1 + rk.filter(function (o) { return o.score > r.score; }).length; });
  const sumsOk = rk.every(function (r) { return r.score === (ctx.expected[r.slot] || 0); });
  check(rk.length === end.players.length && sorted && ranksOk && sumsOk,
    label + ': clasificación ordenada con puestos (empates comparten puesto) y puntos que cuadran: ' + rk.map(function (r) { return r.rank + 'º ' + r.name + ' ' + r.score; }).join(', '));
  check(gal && gal.items.length === rounds && gal.items.every(function (it) { return it.drawerName && Array.isArray(it.strokes) && it.guessers > 0; }),
    label + ': la tele recibe la galería con los ' + rounds + ' dibujos y quién dibujó cada uno');
  const phoneEnd = await Promise.all(Object.keys(ctx.bySlot).map(function (s) { return ctx.bySlot[s].wait(function (m) { return m.t === 'dmeta' && m.phase === 'end' && m.ranking; }, 2000, 'fin móvil'); }));
  check(phoneEnd.every(Boolean) && !Object.keys(ctx.bySlot).some(function (s) { return ctx.bySlot[s].find('d.gallery'); }), label + ': los móviles reciben la clasificación (y no los trazos)');
  return end;
}

function rotationOk(drawers, players, vueltas) {
  const n = players.length;
  if (drawers.length !== n * vueltas) return false;
  const first = drawers.slice(0, n);
  if (new Set(first).size !== n) return false;
  for (let i = 0; i < drawers.length; i++) if (drawers[i] !== first[i % n]) return false;
  return true;
}

// ---------------------------------------------------------------- unit
function unit() {
  console.log('\n[Fórmulas]');
  check(Dibuja.vueltasFor(3) === 2 && Dibuja.vueltasFor(4) === 2 && Dibuja.vueltasFor(5) === 1 && Dibuja.vueltasFor(6) === 1, 'Vueltas: 2 con 3-4 jugadores, 1 con 5-6');
  check(Dibuja.guessPoints(0, 60, 'facil') === 280 && Dibuja.guessPoints(1, 50, 'facil') === 200 && Dibuja.guessPoints(2, 40, 'dificil') === Math.round(220 * 0.65) + 75 && Dibuja.guessPoints(7, 0, 'media') === 40 + 25,
    'Acertante: (100 + 3×s) × 1 / 0,8 / 0,65 / 0,5 / 0,4 + bonus de dificultad');
  check(Dibuja.drawerPoints(0, 5, 'dificil') === 40 + 75 && Dibuja.drawerPoints(1, 5, 'dificil') === 40 && Dibuja.drawerPoints(0, 2, 'facil') === 100,
    'Dibujante: 200 / acertantes posibles por cada acierto (+ bonus con el primero)');
  check(Dibuja.givesAway('mi abuela', 'abuela feliz') && Dibuja.givesAway('abuel', 'abuela feliz') && Dibuja.givesAway('elefantes rosas', 'elefante') && !Dibuja.givesAway('perro', 'gato'),
    'Un intento que da parte de la respuesta se trata como «casi» (privado)');
}

// ---------------------------------------------------------------- matches
async function matchOf3(tv, clients) {
  console.log('\n[3 jugadores: todos contra todos, 2 vueltas]');
  const names = { 1: 'Ana', 2: 'Berto', 3: 'Carla' };
  const bySlot = await joinRoom(['Ana', 'Berto', 'Carla'], 'd3-');
  Object.keys(bySlot).forEach(function (s) { clients.push(bySlot[s]); });
  // Secret words: Ana's can only be drawn by Berto or Carla, and so on
  bySlot[1].send({ t: 'd.words', list: ['Xilofonazo'] });
  bySlot[2].send({ t: 'd.words', list: ['Zorrocotroco'] });
  bySlot[3].send({ t: 'd.words', list: ['Pantuflazo'] });
  await bySlot[3].wait(function (m) { return m.t === 'd.words' && m.list.length === 1; }, 1000, 'palabras');
  const wordsOf = { 1: 'xilofonazo', 2: 'zorrocotroco', 3: 'pantuflazo' };
  const tm = tv.mark();
  const marks3 = marksOf(bySlot);
  bySlot[1].send({ t: 'pick', game: 'dibuja' });
  const first = await tv.wait(function (m) { return m.t === 'dmeta' && m.round === 1; }, 3000, 'dmeta', tm);
  check(first && first.mode === 'ffa' && first.vueltas === 2 && first.rounds === 6 && first.players.join() === '1,2,3', '3 jugadores: modo todos contra todos, 2 vueltas = 6 rondas');
  const ctx = { tv: tv, bySlot: bySlot, names: names, tvFrom: tm, expected: {}, customsOffered: [], phoneFrom: marks3 };
  const drawers = [];
  const all = [];
  for (let r = 1; r <= 6; r++) {
    const ds = await (async function () {
      const intro = await tv.wait(function (m) { return m.t === 'dmeta' && m.round === r; }, 10000, 'r', ctx.tvFrom);
      return intro ? intro.drawer : 0;
    })();
    const others = [1, 2, 3].filter(function (s) { return s !== ds; });
    const plan = r === 1 ? { guessers: others, wrong: others[1], casi: others[0] }
      : (r === 3 ? { guessers: [others[1]], timeout: true } : { guessers: r % 2 ? others : others.slice().reverse(), pickCustom: r >= 4 });
    const res = await playRound(ctx, r, plan);
    if (!check(!!res, 'Ronda ' + r + ' completa')) break;
    drawers.push(res.drawer);
    all.push(res);
    if (r === 1) {
      check(res.wrongPublic, 'Un intento erróneo sale en la tele con el nombre de quien lo escribió');
      check(res.casiPrivate, '«¡Casi!» solo le llega a quien lo escribió');
      check(res.lockOk, '«¡Acertaste!»: después de acertar no se puede volver a intentar');
      check(res.rev.reason === 'all' && res.rev.results.length === 2, 'La ronda acaba en cuanto aciertan todos');
    }
    if (r === 3) check(res.rev.reason === 'time' && res.rev.results.length === 1 && res.rev.ok, 'Ronda 3: acierta solo uno y se acaba el tiempo');
    if (res.author) {
      check(res.authorIgnored && res.rev.guessers === 1, 'Ronda ' + r + ': la palabra secreta de ' + names[res.author] + ' la dibuja ' + names[res.drawer] + '; ' + names[res.author] + ' no adivina esa ronda');
      ctx.authorRound = true;
    }
    check(checkScoring(ctx, res), 'Ronda ' + r + ' (dibuja ' + names[res.drawer] + ', «' + res.word + '»): puntos por orden ' +
      res.rev.results.map(function (x) { return x.order + 'º ' + names[x.slot] + ' +' + x.points + ' (' + x.secs + ' s)'; }).join(', ') + '; dibujante +' + res.rev.drawerPoints);
    check(!res.leaks.length, 'Ronda ' + r + ': nada desvela la palabra ni el texto de los aciertos antes de tiempo (' + res.checked + ' mensajes de la tele revisados)' + (res.leaks.length ? ' FUGA: ' + res.leaks.slice(0, 3).join(' | ') : ''));
  }
  check(rotationOk(drawers, [1, 2, 3], 2), 'Rotación: cada uno dibuja 2 veces, siempre en el mismo orden (' + drawers.join(' ') + ')');
  const offered = ctx.customsOffered.filter(function (c) { return c.customs.length; });
  check(offered.length >= 2 && ctx.customsOffered.every(function (c) {
    return c.customs.length <= 1 && c.customs.every(function (o) { return o.from !== c.drawer && wordsOf[o.from] === normalize(o.word); });
  }), 'Palabras secretas de los demás (máx. 1 por terna, nunca las propias): ' + offered.length + ' veces');
  check(!!ctx.authorRound, 'Se ha dibujado al menos una palabra secreta de otro jugador');
  await finishMatch(ctx, '3 jugadores', 6);
  return bySlot;
}

async function matchOf4(tv, clients, bySlot3) {
  console.log('\n[4 jugadores: pausa y quien dibuja se va]');
  const d = await H_.phone(WS, 'Dani', 'd3-Dani'); clients.push(d);
  const bySlot = Object.assign({}, bySlot3, { 4: d });
  const names = { 1: 'Ana', 2: 'Berto', 3: 'Carla', 4: 'Dani' };
  const tm = tv.mark();
  const marks4 = marksOf(bySlot);
  bySlot[2].send({ t: 'd.again' });
  const first = await tv.wait(function (m) { return m.t === 'dmeta' && m.round === 1 && m.phase !== 'end'; }, 3000, 'otra', tm);
  check(first && first.vueltas === 2 && first.rounds === 8 && first.players.length === 4, '«Jugar otra vez» con 4 (Dani entró al final): 2 vueltas = 8 rondas');
  const ctx = { tv: tv, bySlot: bySlot, names: names, tvFrom: tm, expected: {}, customsOffered: [], phoneFrom: marks4 };
  // Round 1, normal
  let res = await playRound(ctx, 1, { guessers: [1, 2, 3, 4].filter(function (s) { return s !== first.drawer; }) });
  check(res && checkScoring(ctx, res) && !res.leaks.length && res.rev.results.length === 3, 'Ronda 1 con 4: aciertan los 3, puntos por orden y sin fugas');
  // Round 2: a guesser loses the connection -> pause; then the drawer leaves for good
  const intro = await tv.wait(function (m) { return m.t === 'dmeta' && m.round === 2; }, 8000, 'r2', ctx.tvFrom);
  const drawer = intro.drawer;
  const D = bySlot[drawer];
  const others = [1, 2, 3, 4].filter(function (s) { return s !== drawer; });
  const opts = await D.wait(function (m) { return m.t === 'd.opts' && m.round === 2; }, 3000, 'opts2');
  D.send({ t: 'd.pick', i: 0 });
  await tv.wait(function (m) { return m.t === 'dmeta' && m.round === 2 && m.phase === 'draw'; }, 3000, 'draw2', ctx.tvFrom);
  void opts;
  const g = bySlot[others[0]];
  await g.close();
  const paused = await tv.wait(function (m) { return m.t === 'dmeta' && m.paused; }, 1500, 'pausa', ctx.tvFrom);
  const leftA = paused ? paused.left : 0;
  await H_.sleep(500);
  check(paused && tv.dmeta.paused && Math.abs(tv.dmeta.left - leftA) < 30 && paused.waiting[0] === names[others[0]],
    'Si se desconecta ' + names[others[0]] + ': pausa con «Esperando a…» y el reloj parado');
  const g2 = await H_.phone(WS, names[others[0]], 'd3-' + names[others[0]]); clients.push(g2);
  bySlot[others[0]] = g2;
  check(!!(await tv.wait(function (m) { return m.t === 'dmeta' && !m.paused && m.phase === 'draw'; }, 1500, 'reanuda', tv.msgs.indexOf(paused))), 'Vuelve y se reanuda');
  // One guesses, then the drawer goes away for good
  g2.send({ t: 'd.guess', text: (await D.wait(function (m) { return m.t === 'd.secret' && m.round === 2; }, 1000, 'sec')).word });
  await tv.wait(function (m) { return m.t === 'd.got'; }, 1500, 'got', ctx.tvFrom);
  const tvM = tv.mark();
  await D.close();
  const p2 = await tv.wait(function (m) { return m.t === 'dmeta' && m.paused; }, 1500, 'pausa dibujante', tvM);
  const rev = await tv.wait(function (m) { return m.t === 'd.reveal' && m.round === 2; }, HOLD + 3000, 'reveal por abandono', tvM);
  const leftEv = await tv.wait(function (m) { return m.t === 'ev' && m.k === 'left'; }, 500, 'ev left', tvM);
  check(!!p2 && rev && rev.reason === 'left' && rev.results.length === 1 && leftEv && leftEv.name === names[drawer] && (rev._at - p2._at) >= HOLD - 200,
    'Si quien dibuja (' + names[drawer] + ') no vuelve en SLOT_HOLD_MS: se desvela la palabra y sigue la partida');
  const next = await tv.wait(function (m) { return m.t === 'dmeta' && m.round === 3; }, 3000, 'r3', tvM);
  check(next && next.drawer !== drawer && next.rounds === 7 && next.players.indexOf(drawer) < 0 && !next.paused,
    'Siguiente dibujante (' + (next && names[next.drawer]) + '); su segundo turno desaparece: 7 rondas');
  delete bySlot[drawer];
  ctx.tvFrom = tv.msgs.indexOf(rev);
  ctx.phoneFrom = marksOf(bySlot);
  // The rest of the match, everybody guesses
  ctx.expected = {};
  rev.scores.forEach(function (v, i) { if (v) ctx.expected[i + 1] = v; });
  const drawers = [];
  for (let r = 3; r <= 7; r++) {
    const it = await tv.wait(function (m) { return m.t === 'dmeta' && m.round === r; }, 8000, 'r' + r, ctx.tvFrom);
    if (!it) break;
    drawers.push(it.drawer);
    res = await playRound(ctx, r, { guessers: Object.keys(bySlot).map(Number).filter(function (s) { return s !== it.drawer; }) });
    if (!res || !checkScoring(ctx, res) || res.leaks.length) { check.fail('Ronda ' + r + ' con 3 tras el abandono'); break; }
  }
  check(drawers.length === 5 && drawers.indexOf(drawer) < 0 && drawers.every(function (s, i) { return i === 0 || s !== drawers[i - 1]; }),
    'Rondas 3 a 7 sin ' + names[drawer] + ' y sin repetir dibujante seguido (' + drawers.map(function (s) { return names[s]; }).join(', ') + ')');
  ctx.bySlot = bySlot;
  await finishMatch(ctx, '4 jugadores (uno se va)', 7);
  tv.send({ t: 'menu' });
  await tv.wait(function (m) { return m.t === 'hub' && m.screen === 'menu'; }, 2000, 'menú');
  Object.keys(bySlot).forEach(function (s) { bySlot[s].send({ t: 'leave' }); });
  await tv.wait(function (m) { return m.t === 'hub' && m.players.every(function (p) { return !p; }); }, 2000, 'sala vacía');
}

async function matchOf6(tv, clients) {
  console.log('\n[6 jugadores: 1 vuelta]');
  const list = ['Ana', 'Berto', 'Carla', 'Dani', 'Eva', 'Fran'];
  const bySlot = await joinRoom(list, 'd6-');
  Object.keys(bySlot).forEach(function (s) { clients.push(bySlot[s]); });
  const names = {};
  Object.keys(bySlot).forEach(function (s) { names[s] = bySlot[s].label; });
  const tm = tv.mark();
  const marks6 = marksOf(bySlot);
  bySlot[6].send({ t: 'pick', game: 'dibuja' });
  const first = await tv.wait(function (m) { return m.t === 'dmeta' && m.round === 1; }, 3000, 'dmeta', tm);
  check(first && first.mode === 'ffa' && first.vueltas === 1 && first.rounds === 6 && first.players.length === 6, '6 jugadores: 1 vuelta = 6 rondas (cada uno dibuja una vez)');
  const ctx = { tv: tv, bySlot: bySlot, names: names, tvFrom: tm, expected: {}, customsOffered: [], phoneFrom: marks6 };
  const drawers = [];
  let allOk = true, noLeaks = true, locks = 0, details = [];
  for (let r = 1; r <= 6; r++) {
    const it = await tv.wait(function (m) { return m.t === 'dmeta' && m.round === r; }, 8000, 'r' + r, ctx.tvFrom);
    if (!it) { allOk = false; break; }
    const others = [1, 2, 3, 4, 5, 6].filter(function (s) { return s !== it.drawer; });
    // Order of guessers rotates; in round 4 only 3 of 5 guess (timeout)
    const order = others.slice(r % 5).concat(others.slice(0, r % 5));
    const plan = r === 4 ? { guessers: order.slice(0, 3), wrong: order[4], timeout: true } : { guessers: order, wrong: r === 2 ? order[0] : 0, casi: r === 2 ? order[1] : 0 };
    const res = await playRound(ctx, r, plan);
    if (!res) { allOk = false; break; }
    drawers.push(res.drawer);
    if (!checkScoring(ctx, res)) allOk = false;
    if (res.leaks.length) { noLeaks = false; details.push('r' + r + ': ' + res.leaks.slice(0, 2).join(' | ')); }
    if (res.lockOk) locks++;
    if (r === 4) check(res.rev.reason === 'time' && res.rev.results.length === 3 && res.rev.guessers === 5, 'Ronda 4: aciertan 3 de 5 y se acaba el tiempo');
    if (r === 2) check(res.casiPrivate && res.wrongPublic, 'Con 6: «casi» privado y los errores, públicos con nombre');
    if (r === 1) check(res.rev.results.length === 5 && res.rev.drawerPoints === 5 * 40 + Dibuja.BONUS[res.diff], 'Ronda 1: aciertan los 5; el dibujante gana 5 × 40 + bonus = ' + res.rev.drawerPoints);
  }
  check(allOk, '6 rondas con 6: puntos por orden de acierto y del dibujante correctos en todas');
  check(noLeaks, 'Con 6: ni la tele ni ningún móvil que adivina recibe la palabra o el texto de un acierto antes de desvelarla' + (details.length ? ' FUGA: ' + details.join(' / ') : ''));
  check(locks === 6, '«¡Acertaste!» bloquea nuevos intentos (6/6 rondas)');
  check(rotationOk(drawers, [1, 2, 3, 4, 5, 6], 1), 'Rotación con 6: dibujan todos una vez (' + drawers.join(' ') + ')');
  const end = await finishMatch(ctx, '6 jugadores', 6);
  if (end) check(end.ranking[0].rank === 1 && end.ranking.length === 6, 'Clasificación de 6 con medallas para los 3 primeros puestos');
}

(async function () {
  unit();
  const HOME = H_.tmpHome('g2t-dib-');
  const srv = await H_.startServer({
    GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', SLOT_HOLD_MS: String(HOLD), DIBUJA_DEBUG_SPEED: String(SPEED)
  });
  const clients = [];
  try {
    const tv = H_.makeClient(WS, 'tele'); clients.push(tv);
    await tv.ready;
    tv.send({ t: 'hello', role: 'tv' });
    await H_.waitUntil(function () { return tv.hub; }, 2000, 'hub');
    const by3 = await matchOf3(tv, clients);
    await matchOf4(tv, clients, by3);
    await matchOf6(tv, clients);
    check(!/Error/.test(srv.out), 'Sin errores en el registro del servidor');
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
