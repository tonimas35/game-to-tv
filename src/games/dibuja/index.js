'use strict';
/*
 * «Dibuja y adivina»: Pictionary for 2 to 6 players.
 *
 * Two modes, chosen when the match starts:
 *   2 players     cooperative (as in 0.1/0.2): one draws, the other guesses,
 *                 team score, 8 rounds (DIBUJA_ROUNDS), a final «title».
 *   3-6 players   «todos contra todos»: the drawer rotates and everybody
 *                 else guesses at the same time on their phone.
 *                 Each player draws `vueltas` times: 2 with 3-4 players (6 or
 *                 8 rounds), 1 with 5-6 (5 or 6 rounds), so a match lasts
 *                 about as long as the 8 rounds for two (DIBUJA_VUELTAS forces it).
 *                 Points of each correct guess, in order of arrival (k = 0, 1…):
 *                   guesser  round((100 + 3 × seconds left) × ORDER[k]) + bonus
 *                   drawer   round(200 / guessers of the round) (+ bonus with the first)
 *                 ORDER = 1, 0.8, 0.65, 0.5, 0.4… and bonus = 0 / 25 / 75 by
 *                 difficulty. The round ends when everybody has guessed or
 *                 on timeout. Never sent to guessers or the TV before the
 *                 reveal: the word, the text of a correct guess (only «Ana ha
 *                 acertado»), and «¡Casi!» guesses (private to who wrote them).
 *                 A secret word written by a player can be offered to any
 *                 other drawer; its author sits that round out (they know it).
 *                 If somebody leaves for good (onPlayerLeft) the match goes
 *                 on: a drawer who leaves skips to the next drawer.
 *
 * Phases of each round:
 *   intro   «Ahora dibuja X» (transition screen)
 *   choose  the drawer picks 1 of 3 words (15 s; otherwise random)
 *   draw    80 s to draw and guess (hints at 50 % and 75 %)
 *   reveal  the word is revealed (guessed, or «Era: …»)
 * After the last round:
 *   end     gallery with every drawing, and the score (2: team title;
 *           3-6: ranking with medals)
 *
 * Messages it receives:
 *   d.pick {i}            the drawer picks option i (0..2)
 *   d.skip                «Pasar palabra» (once per round; 3-6: only before anyone guesses)
 *   d.s {id,c,w,p,end}    piece of a stroke: normalized points [x,y,x,y,...] 0..1
 *   d.undo {id?}          undo the last stroke
 *   d.clear               clear everything
 *   d.guess {text}        a guess
 *   d.again               another match (from the end screen)
 *   d.words {list}        (menu) the player's secret words for the others
 * Messages it sends:
 *   dmeta                 public state (never the secret word before the reveal)
 *   d.opts {opts}         ONLY to the drawer: the 3 options (custom ones with `from`)
 *   d.secret {word,...}   ONLY to the drawer: the chosen word
 *   d.s / d.undo / d.clear / d.all {strokes}   strokes (to the TV; d.all also to a reconnecting drawer)
 *   d.g {text,res}        2 players: guess and result ('no' | 'casi'), to everybody
 *   d.g {slot,text,res}   3-6: a wrong guess ('no') to everybody; 'casi' and
 *                         'ok' ({res, points, order}, no text) only to who guessed
 *   d.got {slot,order,points,drawerPoints}   3-6: somebody guessed (no text)
 *   d.hint {n}            a letter has been revealed
 *   d.skip                the word was skipped
 *   d.reveal {word,ok,points,...}   (3-6: mode 'ffa', results, drawer, drawerPoints, scores, reason)
 *   d.gallery {items}     to the TV: the drawings of the whole match
 *   d.words {list,max}    (menu) to the player: their secret words
 * Every finished round is saved as a PNG in the gallery folder
 * (~/.game-to-tv/galeria by default), rendered in a worker thread.
 *
 * Environment:
 *   DIBUJA_DEBUG_SPEED  (1)  speeds up every timer (tests only)
 *   DIBUJA_ROUNDS       (8)  rounds per match with 2 players
 *   DIBUJA_VUELTAS      (auto: 2 with 3-4 players, 1 with 5-6) times each player draws
 */

const fs = require('fs');
const path = require('path');
const { WORDS, DIFFS } = require('./words');
const { judge, normalize, stripAccents } = require('./match');
const { renderPngAsync } = require('./raster');

const SPEED = Math.max(0.1, parseFloat(process.env.DIBUJA_DEBUG_SPEED) || 1);
const ROUNDS = Math.max(1, Math.min(20, parseInt(process.env.DIBUJA_ROUNDS, 10) || 8));
const FORCED_VUELTAS = Math.max(0, Math.min(5, parseInt(process.env.DIBUJA_VUELTAS, 10) || 0));
const TIMES = { intro: 3500, choose: 15000, draw: 80000, reveal: 6500 }; // ms «lógicos»
const HINTS_AT = [0.5, 0.75];
const BONUS = { facil: 0, media: 25, dificil: 75 };
// 3-6 players: share of «100 + 3 × seconds left» for the 1st, 2nd… correct guess
const ORDER_FACTOR = [1, 0.8, 0.65, 0.5, 0.4];
// 3-6 players: what the drawer can earn in a round if everybody guesses (split per guesser)
const DRAWER_POOL = 200;
const MAX_STROKES = 4000;
const MAX_ROUND_POINTS = 200000; // pares x,y por ronda
const MAX_PTS_PER_MSG = 1500;

const RATINGS = [
  { min: 260, title: 'Telepatía total', sub: 'Os leéis la mente. Da hasta un poco de miedo.' },
  { min: 200, title: 'Almas gemelas', sub: 'Un garabato y ya sabéis lo que es.' },
  { min: 140, title: 'Hay química', sub: 'Se nota que os conocéis bien.' },
  { min: 90, title: 'Vamos bien', sub: 'Con un poco más de práctica, imparables.' },
  { min: 40, title: 'Artistas incomprendidos', sub: 'Lo importante es participar… ¿no?' },
  { min: 0, title: '¿Os conocéis?', sub: 'Igual toca una cena para hablar de vuestras cosas.' }
];

function rating(score, rounds) {
  const avg = score / Math.max(1, rounds);
  for (let i = 0; i < RATINGS.length; i++) if (avg >= RATINGS[i].min) return { title: RATINGS[i].title, sub: RATINGS[i].sub };
  return RATINGS[RATINGS.length - 1];
}

/** Times each player draws in a match of n players (3-6). */
function vueltasFor(n) {
  if (FORCED_VUELTAS) return FORCED_VUELTAS;
  return n >= 5 ? 1 : 2;
}
/** Points of the k-th correct guess (k = 0 first) with secs seconds left. */
function guessPoints(k, secs, diff) {
  const f = ORDER_FACTOR[Math.min(k, ORDER_FACTOR.length - 1)];
  return Math.round((100 + 3 * secs) * f) + (BONUS[diff] || 0);
}
/** Points the drawer gets for one correct guess (bonus only with the first). */
function drawerPoints(k, guessers, diff) {
  return Math.round(DRAWER_POOL / Math.max(1, guessers)) + (k === 0 ? (BONUS[diff] || 0) : 0);
}

function wkey(w) { return normalize(w).replace(/\s+/g, ' '); }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function stampOf(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + '_' + pad2(d.getHours()) + '-' + pad2(d.getMinutes());
}
function slug(w) {
  const s = stripAccents(String(w).toLowerCase()).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'dibujo';
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}
function isLetter(ch) { return /[0-9a-zA-ZÀ-ÿ]/.test(ch); }
// A wrong guess that still gives part of the answer away («mi abuela» for
// «abuela feliz», «abuel»): in 3-6 it is kept private, like «¡Casi!».
function givesAway(guessText, word) {
  const g = normalize(guessText), t = normalize(word);
  if (!g || !t) return false;
  const gc = g.replace(/\s+/g, ''), tc = t.replace(/\s+/g, '');
  if (gc.indexOf(tc) >= 0) return true;
  if (gc.length >= 4 && tc.indexOf(gc) >= 0) return true;
  const gTok = g.split(' ');
  return t.split(' ').some(function (w) { return w.length >= 3 && gTok.indexOf(w) >= 0; });
}

let firstDrawerToggle = Math.random() < 0.5 ? 0 : 1;
let ffaStart = 0;

function create(api) {
  const S = {
    mode: 'coop',          // 'coop' (2 players) | 'ffa' (3-6, todos contra todos)
    order: [],             // slots playing this match (a phone that joins mid-match watches)
    turns: [],             // drawer of each round (slot)
    vueltas: 1,
    phase: 'intro',
    round: 0,
    drawer: 0,
    left: 0,
    total: 0,
    paused: false,
    score: 0,              // coop: team score
    scores: [],            // ffa: points by slot
    used: new Set(),
    customOffered: new Set(),
    options: [],
    word: null,
    revealed: new Set(),
    hintsGiven: 0,
    skipsLeft: 1,
    guesses: [],           // the feed (ffa: wrong guesses with text, correct ones without)
    eligible: [],          // ffa: who can guess this round
    guessersAtStart: 0,    // ffa: how many could guess when the word was chosen
    correct: [],           // ffa: [{ slot, order, points, secs, drawer }]
    author: -1,            // ffa: author of the secret word being drawn (sits the round out)
    drawerPts: 0,          // ffa: drawer's points this round
    strokes: [],
    strokeMap: new Map(),
    roundPoints: 0,
    history: [],
    last: null,
    stamp: stampOf(new Date()),
    lastGuessAt: {}
  };
  let dirty = true;
  let lastMetaAt = 0;
  let stopped = false;

  function ffa() { return S.mode === 'ffa'; }
  // coop: the other player
  function guesser() {
    for (let k = 0; k < S.order.length; k++) if (S.order[k] !== S.drawer) return S.order[k];
    return S.drawer;
  }
  function rounds() { return S.turns.length; }

  // ---------------------------------------------------------------- palabras
  function randomWord(diff, avoidCats) {
    let pool = WORDS.filter(function (w) { return w.diff === diff && !S.used.has(wkey(w.word)); });
    if (!pool.length) pool = WORDS.filter(function (w) { return w.diff === diff; });
    const pref = pool.filter(function (w) { return avoidCats.indexOf(w.cat) < 0; });
    const src = pref.length ? pref : pool;
    const w = src[Math.floor(Math.random() * src.length)];
    return { word: w.word, diff: w.diff, cat: w.cat, custom: false };
  }

  // Secret words written by the OTHER players of the match (with 2: the partner)
  function customFor(drawerIdx) {
    const pool = [];
    S.order.forEach(function (s) {
      if (s === drawerIdx) return;
      (api.store(s).words || []).forEach(function (w) { pool.push({ word: w, from: s }); });
    });
    const fresh = pool.filter(function (c) { return !S.used.has(wkey(c.word)); });
    if (!fresh.length) return null;
    const notOffered = fresh.filter(function (c) { return !S.customOffered.has(wkey(c.word)); });
    const src = notOffered.length ? notOffered : fresh;
    return src[Math.floor(Math.random() * src.length)];
  }

  function pickOptions() {
    const cats = [];
    const opts = DIFFS.map(function (diff) {
      const w = randomWord(diff, cats);
      cats.push(w.cat);
      return w;
    });
    const cw = customFor(S.drawer);
    if (cw) {
      S.customOffered.add(wkey(cw.word));
      opts[1] = { word: cw.word, diff: 'media', cat: 'secreta', custom: true, from: cw.from };
    }
    // Las palabras normales ofrecidas no se vuelven a ofrecer en la partida
    opts.forEach(function (o) { if (!o.custom) S.used.add(wkey(o.word)); });
    return opts;
  }
  function publicOpts() {
    return S.options.map(function (o) {
      const p = { word: o.word, diff: o.diff, cat: o.cat, custom: o.custom };
      if (o.custom) p.from = o.from + 1;
      return p;
    });
  }

  // ---------------------------------------------------------------- pistas
  function hintPattern() {
    if (!S.word) return null;
    const chars = Array.from(S.word.word);
    return chars.map(function (ch, i) {
      if (!isLetter(ch)) return ch;
      return S.revealed.has(i) ? ch : '_';
    }).join('');
  }
  function letterCount() {
    if (!S.word) return 0;
    return Array.from(S.word.word).filter(isLetter).length;
  }
  function revealOne() {
    const chars = Array.from(S.word.word);
    const hidden = [];
    chars.forEach(function (ch, i) { if (isLetter(ch) && !S.revealed.has(i)) hidden.push(i); });
    // Nunca se desvela la palabra entera: siempre queda al menos una letra oculta
    if (hidden.length < 2) return false;
    S.revealed.add(hidden[Math.floor(Math.random() * hidden.length)]);
    return true;
  }

  // ---------------------------------------------------------------- fases
  function setPhase(ph, ms) {
    S.phase = ph;
    S.total = ms || 0;
    S.left = ms || 0;
    dirty = true;
  }

  function sendDrawer(obj) { api.sendSlot(S.drawer, obj); }

  function startMatch() {
    S.order = api.players().slice(0, 6);
    S.mode = S.order.length >= 3 ? 'ffa' : 'coop';
    S.round = 0;
    S.score = 0;
    S.scores = new Array(api.slots).fill(0);
    S.used = new Set();
    S.customOffered = new Set();
    S.history = [];
    S.stamp = stampOf(new Date());
    S.turns = [];
    if (!ffa()) {
      // Two players: they take turns, and the one who starts alternates between matches
      firstDrawerToggle = 1 - firstDrawerToggle;
      S.firstDrawer = firstDrawerToggle;
      const a = S.order[S.firstDrawer % S.order.length], b = S.order[(S.firstDrawer + 1) % S.order.length];
      for (let r = 0; r < ROUNDS; r++) S.turns.push(r % 2 === 0 ? a : b);
      S.vueltas = ROUNDS / 2;
    } else {
      // Everybody draws `vueltas` times, in turn; who starts rotates between matches
      const n = S.order.length;
      const start = ffaStart++ % n;
      const rot = S.order.slice(start).concat(S.order.slice(0, start));
      S.vueltas = vueltasFor(n);
      for (let v = 0; v < S.vueltas; v++) rot.forEach(function (s) { S.turns.push(s); });
    }
    api.log('[dibuja] Nueva partida (' + (ffa() ? S.order.length + ' jugadores, todos contra todos, ' + S.vueltas + (S.vueltas === 1 ? ' vuelta' : ' vueltas') + ', ' : 'en equipo, ') + rounds() + ' rondas)');
    nextRound();
  }

  function resetRoundDrawing() {
    S.strokes = [];
    S.strokeMap = new Map();
    S.roundPoints = 0;
  }

  function nextRound() {
    S.round++;
    S.drawer = S.turns[S.round - 1];
    S.word = null;
    S.options = [];
    S.revealed = new Set();
    S.hintsGiven = 0;
    S.skipsLeft = 1;
    S.guesses = [];
    S.last = null;
    S.correct = [];
    S.author = -1;
    S.drawerPts = 0;
    S.eligible = S.order.filter(function (s) { return s !== S.drawer; });
    S.guessersAtStart = S.eligible.length;
    resetRoundDrawing();
    api.sendTvs({ t: 'd.all', strokes: [] });
    setPhase('intro', TIMES.intro);
  }

  // After a round (or a skipped turn): the next one, or the end
  function advance() {
    if (S.round >= rounds()) enterEnd();
    else nextRound();
  }

  function enterChoose() {
    S.options = pickOptions();
    setPhase('choose', TIMES.choose);
    sendDrawer({ t: 'd.opts', round: S.round, opts: publicOpts() });
  }

  function chooseWord(i) {
    const o = S.options[i];
    if (!o) return;
    S.word = o;
    S.used.add(wkey(o.word));
    S.options = [];
    S.revealed = new Set();
    if (ffa() && o.custom && S.order.indexOf(o.from) >= 0) {
      // The author knows the word: they sit this round out
      S.author = o.from;
      S.eligible = S.eligible.filter(function (s) { return s !== o.from; });
    }
    S.guessersAtStart = S.eligible.length;
    setPhase('draw', TIMES.draw);
    sendDrawer(secretMsg());
    api.log('[dibuja] Ronda ' + S.round + ': dibuja ' + api.name(S.drawer));
  }

  function secretMsg() {
    return { t: 'd.secret', round: S.round, word: S.word.word, diff: S.word.diff, cat: S.word.cat, custom: !!S.word.custom, skipsLeft: S.skipsLeft };
  }

  function skipWord() {
    if (S.phase !== 'draw' || S.skipsLeft <= 0 || !S.word) return;
    if (ffa() && S.correct.length) return; // somebody already guessed this one
    let nw;
    if (S.word.custom) {
      nw = randomWord('media', [S.word.cat]);
    } else {
      nw = randomWord(S.word.diff, [S.word.cat]);
    }
    S.used.add(wkey(nw.word));
    S.skipsLeft--;
    S.word = nw;
    if (S.author >= 0) {
      // Not their word any more: the author guesses again
      if (S.order.indexOf(S.author) >= 0) S.eligible.push(S.author);
      S.author = -1;
      S.guessersAtStart = S.eligible.length;
    }
    S.revealed = new Set();
    for (let k = 0; k < S.hintsGiven; k++) revealOne();
    resetRoundDrawing();
    api.sendTvs({ t: 'd.clear' });
    sendDrawer(secretMsg());
    sendDrawer({ t: 'd.all', strokes: [] });
    api.broadcast({ t: 'd.skip' });
    dirty = true;
  }

  function endRound(ok, guessText) {
    const secsLeft = ok ? Math.max(0, Math.ceil(S.left / 1000)) : 0;
    const bonus = BONUS[S.word.diff] || 0;
    const points = ok ? 100 + 3 * secsLeft + bonus : 0;
    S.score += points;
    if (ok) S.guesses.push({ text: guessText, res: 'ok' });
    S.last = { word: S.word.word, diff: S.word.diff, custom: !!S.word.custom, ok: ok, points: points, secsLeft: secsLeft, bonus: ok ? bonus : 0 };
    const entry = {
      round: S.round, word: S.word.word, diff: S.word.diff, cat: S.word.cat, custom: !!S.word.custom,
      ok: ok, points: points, drawer: S.drawer + 1, drawerName: api.name(S.drawer), strokes: S.strokes, file: null
    };
    S.history.push(entry);
    savePng(entry);
    setPhase('reveal', TIMES.reveal);
    api.broadcast({ t: 'd.reveal', round: S.round, word: S.word.word, diff: S.word.diff, ok: ok, points: points, secsLeft: secsLeft, bonus: ok ? bonus : 0, score: S.score });
    api.log('[dibuja] Ronda ' + S.round + ' ' + (ok ? 'acertada (+' + points + ')' : 'sin acertar') + ': ' + S.word.word);
  }

  // 3-6 players: everybody guessed ('all'), time is up ('time') or the drawer left ('left')
  function endRoundFfa(reason) {
    const ok = S.correct.length > 0;
    const results = S.correct.map(function (c) { return { slot: c.slot + 1, order: c.order, points: c.points, secs: c.secs }; });
    S.last = {
      mode: 'ffa', word: S.word.word, diff: S.word.diff, custom: !!S.word.custom, ok: ok, reason: reason,
      results: results, drawer: S.drawer + 1, drawerPoints: S.drawerPts, guessers: S.guessersAtStart,
      author: S.author + 1, bonus: BONUS[S.word.diff] || 0
    };
    const entry = {
      round: S.round, word: S.word.word, diff: S.word.diff, cat: S.word.cat, custom: !!S.word.custom,
      ok: ok, points: S.drawerPts, guessed: S.correct.length, guessers: S.guessersAtStart,
      drawer: S.drawer + 1, drawerName: api.name(S.drawer), strokes: S.strokes, file: null
    };
    S.history.push(entry);
    savePng(entry);
    setPhase('reveal', TIMES.reveal);
    api.broadcast({
      t: 'd.reveal', mode: 'ffa', round: S.round, word: S.word.word, diff: S.word.diff, ok: ok, reason: reason,
      results: results, drawer: S.drawer + 1, drawerPoints: S.drawerPts, guessers: S.guessersAtStart,
      bonus: S.last.bonus, scores: S.scores.slice()
    });
    api.log('[dibuja] Ronda ' + S.round + ': ' + S.correct.length + ' de ' + S.guessersAtStart + ' aciertan «' + S.word.word + '»' + (reason === 'left' ? ' (se ha ido quien dibujaba)' : ''));
  }

  function ranking() {
    const list = S.order.map(function (s) { return { slot: s + 1, name: api.name(s), score: S.scores[s] || 0 }; });
    list.sort(function (a, b) { return b.score - a.score || a.slot - b.slot; });
    list.forEach(function (r) { r.rank = 1 + list.filter(function (o) { return o.score > r.score; }).length; });
    return list;
  }

  function enterEnd() {
    setPhase('end', 0);
    if (ffa()) {
      S.ranking = ranking();
      api.log('[dibuja] Fin de partida: ' + S.ranking.map(function (r) { return r.rank + 'º ' + r.name + ' ' + r.score; }).join(', '));
    } else {
      S.rating = rating(S.score, rounds());
      api.log('[dibuja] Fin de partida: ' + S.score + ' puntos (' + S.rating.title + ')');
    }
    api.sendTvs(galleryMsg());
  }

  function galleryMsg() {
    return {
      t: 'd.gallery',
      items: S.history.map(function (h) {
        return { round: h.round, word: h.word, diff: h.diff, ok: h.ok, points: h.points, drawer: h.drawer, drawerName: h.drawerName, guessed: h.guessed, guessers: h.guessers, strokes: h.strokes };
      })
    };
  }

  function onTimeout() {
    switch (S.phase) {
      case 'intro': enterChoose(); break;
      case 'choose': chooseWord(Math.floor(Math.random() * S.options.length)); break;
      case 'draw': if (ffa()) endRoundFfa('time'); else endRound(false); break;
      case 'reveal': advance(); break;
    }
  }

  function checkHints() {
    const frac = 1 - S.left / S.total;
    while (S.hintsGiven < HINTS_AT.length && frac >= HINTS_AT[S.hintsGiven]) {
      S.hintsGiven++;
      revealOne();
      api.broadcast({ t: 'd.hint', n: S.hintsGiven });
      dirty = true;
    }
  }

  // ---------------------------------------------------------------- PNG
  function savePng(entry) {
    const dir = api.GALERIA_DIR;
    // No folder (tele mode on a TV without a writable place): the drawings
    // are still shown in the end-of-match gallery, they are just not saved.
    if (!dir) return;
    const strokes = entry.strokes.slice();
    // Se dibuja en un worker_thread: el bucle del juego nunca se bloquea.
    // Cualquier fallo se registra y ya está: guardar nunca rompe la partida.
    let p;
    try { p = renderPngAsync(strokes, 800, 600); } catch (e) { p = Promise.reject(e); }
    p.then(function (buf) {
      const base = S.stamp + '_' + entry.round + '_' + slug(entry.word);
      function attempt(n) {
        const name = base + (n > 1 ? '_' + n : '') + '.png';
        fs.writeFile(path.join(dir, name), buf, { flag: 'wx' }, function (err) {
          if (err && err.code === 'EEXIST' && n < 50) return attempt(n + 1);
          if (err) { api.log('[galeria] No se pudo guardar ' + name + ': ' + err.message); return; }
          entry.file = name;
          api.log('[galeria] Guardado ' + name);
        });
      }
      fs.mkdir(dir, { recursive: true }, function (err) {
        if (err) { api.log('[galeria] No se pudo crear la carpeta: ' + err.message); return; }
        attempt(1);
      });
    }).catch(function (e) {
      api.log('[galeria] No se pudo dibujar la ronda ' + entry.round + ': ' + (e && e.message));
    });
  }

  // ---------------------------------------------------------------- trazos
  function addStrokePart(msg) {
    const id = Number(msg.id);
    if (!(id >= 0 && id < 1e9) || Math.floor(id) !== id) return;
    const raw = Array.isArray(msg.p) ? msg.p.slice(0, MAX_PTS_PER_MSG * 2) : [];
    const pts = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const x = Number(raw[i]), y = Number(raw[i + 1]);
      if (!isFinite(x) || !isFinite(y)) continue;
      pts.push(Math.round(Math.max(0, Math.min(1, x)) * 10000) / 10000, Math.round(Math.max(0, Math.min(1, y)) * 10000) / 10000);
    }
    let st = S.strokeMap.get(id);
    if (!st) {
      if (S.strokes.length >= MAX_STROKES) return;
      const c = /^#[0-9a-fA-F]{6}$/.test(String(msg.c)) ? String(msg.c).toLowerCase() : '#1a1a1a';
      let w = Number(msg.w);
      if (!isFinite(w)) w = 0.015;
      w = Math.max(0.002, Math.min(0.15, w));
      st = { id: id, c: c, w: w, p: [] };
      S.strokes.push(st);
      S.strokeMap.set(id, st);
    }
    if (S.roundPoints + pts.length / 2 > MAX_ROUND_POINTS) return;
    S.roundPoints += pts.length / 2;
    for (let i = 0; i < pts.length; i++) st.p.push(pts[i]);
    api.sendTvs({ t: 'd.s', id: id, c: st.c, w: st.w, p: pts, end: msg.end ? 1 : 0 });
  }

  function undo(msg) {
    if (!S.strokes.length) return;
    let idx = S.strokes.length - 1;
    if (msg && msg.id != null) {
      const id = Number(msg.id);
      for (let i = S.strokes.length - 1; i >= 0; i--) if (S.strokes[i].id === id) { idx = i; break; }
    }
    const st = S.strokes.splice(idx, 1)[0];
    S.strokeMap.delete(st.id);
    api.sendTvs({ t: 'd.undo', id: st.id });
  }

  function clearAll() {
    resetRoundDrawing();
    api.sendTvs({ t: 'd.clear' });
  }

  // ---------------------------------------------------------------- intentos
  function cleanGuess(raw) {
    let s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
    return Array.from(s).slice(0, 40).join('');
  }

  function tooFast(who) {
    const now = Date.now();
    if (now - (S.lastGuessAt[who] || 0) < 150) return true;
    S.lastGuessAt[who] = now;
    return false;
  }

  // 2 players (coop)
  function guess(who, text) {
    if (tooFast(who)) return;
    const t = cleanGuess(text);
    if (!t) return;
    const res = judge(t, S.word.word);
    if (res === 'ok') { endRound(true, t); return; }
    S.guesses.push({ text: t, res: res });
    if (S.guesses.length > 30) S.guesses.shift();
    api.broadcast({ t: 'd.g', text: t, res: res });
    dirty = true;
  }

  // 3-6 players: everybody guesses at once
  function guessFfa(who, text) {
    if (S.eligible.indexOf(who) < 0) return;
    if (S.correct.some(function (c) { return c.slot === who; })) return; // «¡Acertaste!»: no more guesses
    if (tooFast(who)) return;
    const t = cleanGuess(text);
    if (!t) return;
    let res = judge(t, S.word.word);
    if (res === 'ok') { scoreCorrect(who); return; }
    if (res === 'no' && givesAway(t, S.word.word)) res = 'casi';
    if (res === 'casi') {
      // Private: it would give the word away to everybody else
      api.sendSlot(who, { t: 'd.g', slot: who + 1, text: t, res: 'casi', mine: true });
      return;
    }
    S.guesses.push({ slot: who + 1, text: t, res: 'no' });
    if (S.guesses.length > 30) S.guesses.shift();
    api.broadcast({ t: 'd.g', slot: who + 1, text: t, res: 'no' });
    dirty = true;
  }

  function scoreCorrect(who) {
    const k = S.correct.length;
    const secs = Math.max(0, Math.ceil(S.left / 1000));
    const pts = guessPoints(k, secs, S.word.diff);
    const dp = drawerPoints(k, S.guessersAtStart, S.word.diff);
    S.scores[who] = (S.scores[who] || 0) + pts;
    S.scores[S.drawer] = (S.scores[S.drawer] || 0) + dp;
    S.drawerPts += dp;
    S.correct.push({ slot: who, order: k + 1, points: pts, secs: secs, drawer: dp });
    S.guesses.push({ slot: who + 1, res: 'ok', order: k + 1 });
    if (S.guesses.length > 30) S.guesses.shift();
    // The text of a correct guess is never sent to anybody (not even back)
    api.sendSlot(who, { t: 'd.g', slot: who + 1, res: 'ok', points: pts, order: k + 1, mine: true });
    api.broadcast({ t: 'd.got', slot: who + 1, order: k + 1, points: pts, drawerPoints: dp });
    api.log('[dibuja] ' + api.name(who) + ' acierta (' + (k + 1) + 'º, +' + pts + '; ' + api.name(S.drawer) + ' +' + dp + ')');
    dirty = true;
    if (S.correct.length >= S.eligible.length) endRoundFfa('all');
  }

  // ---------------------------------------------------------------- estado público
  function buildMeta() {
    const m = {
      t: 'dmeta',
      mode: S.mode,
      phase: S.phase,
      round: S.round,
      rounds: rounds(),
      vueltas: S.vueltas,
      players: S.order.map(function (s) { return s + 1; }),
      drawer: S.drawer + 1,
      guesser: ffa() ? 0 : guesser() + 1,
      left: Math.max(0, Math.round(S.left)),
      total: S.total,
      speed: SPEED,
      paused: S.paused,
      waiting: [],
      score: S.score,
      hint: null,
      letters: 0,
      skipsLeft: S.skipsLeft,
      guesses: [],
      last: null
    };
    S.order.forEach(function (s) { if (!api.isConnected(s)) m.waiting.push(api.name(s)); });
    if (ffa()) {
      m.scores = S.scores.slice();
      m.guessers = S.eligible.map(function (s) { return s + 1; });
      m.correct = S.correct.map(function (c) { return { slot: c.slot + 1, order: c.order, points: c.points }; });
      m.author = S.author + 1;
    }
    if (S.phase === 'draw') {
      m.hint = hintPattern();
      m.letters = letterCount();
      m.guesses = S.guesses.slice(ffa() ? -6 : -5);
    }
    if (S.phase === 'reveal' || S.phase === 'end') {
      m.last = S.last;
      if (S.phase === 'reveal') m.guesses = S.guesses.slice(ffa() ? -6 : -5);
    }
    if (S.phase === 'end') {
      if (ffa()) m.ranking = S.ranking;
      else m.rating = S.rating;
      m.maxRound = 100 + 3 * Math.ceil(TIMES.draw / 1000) + BONUS.dificil;
      m.history = S.history.map(function (h) {
        return { round: h.round, word: h.word, diff: h.diff, ok: h.ok, points: h.points, drawer: h.drawer, drawerName: h.drawerName, custom: h.custom, guessed: h.guessed, guessers: h.guessers };
      });
    }
    return m;
  }

  function sendMeta() {
    lastMetaAt = Date.now();
    dirty = false;
    api.broadcast(JSON.stringify(buildMeta()));
  }

  function everybodyHere() {
    return S.order.length > 0 && S.order.every(function (s) { return api.isConnected(s); });
  }

  // ---------------------------------------------------------------- interfaz del módulo
  return {
    id: 'dibuja',
    start: startMatch,
    stop: function () { stopped = true; },
    tick: function (dt) {
      if (stopped) return;
      const paused = !everybodyHere();
      if (paused !== S.paused) {
        S.paused = paused;
        dirty = true;
        api.log('[dibuja] ' + (paused ? 'Pausa: falta un jugador' : 'Se reanuda'));
      }
      if (paused || S.phase === 'end') return;
      S.left -= dt * 1000 * SPEED;
      if (S.phase === 'draw') checkHints();
      if (S.left <= 0) onTimeout();
    },
    flush: function () {
      if (dirty || Date.now() - lastMetaAt >= 1000) sendMeta();
    },
    onMessage: function (who, msg) {
      const isDrawer = who === S.drawer && S.order.indexOf(who) >= 0;
      switch (msg.t) {
        case 'd.pick':
          if (isDrawer && S.phase === 'choose') {
            const i = Number(msg.i);
            if (i >= 0 && i < S.options.length && Math.floor(i) === i) chooseWord(i);
          }
          break;
        case 'd.skip':
          if (isDrawer && !S.paused) skipWord();
          break;
        case 'd.s':
          if (isDrawer && S.phase === 'draw') addStrokePart(msg);
          break;
        case 'd.undo':
          if (isDrawer && S.phase === 'draw') undo(msg);
          break;
        case 'd.clear':
          if (isDrawer && S.phase === 'draw') clearAll();
          break;
        case 'd.guess':
          if (S.phase !== 'draw' || S.paused || who < 0) break;
          if (ffa()) guessFfa(who, msg.text);
          else if (who === guesser() && who !== S.drawer) guess(who, msg.text);
          break;
        case 'd.again':
          if (S.phase === 'end') startMatch();
          break;
      }
    },
    onPlayerDisconnected: function () { /* el tick detecta la pausa */ },
    onPlayerJoined: function (i) {
      api.sendSlot(i, buildMeta());
      if (i === S.drawer && S.order.indexOf(i) >= 0) {
        if (S.phase === 'choose') api.sendSlot(i, { t: 'd.opts', round: S.round, opts: publicOpts() });
        if (S.phase === 'draw') {
          api.sendSlot(i, secretMsg());
          api.sendSlot(i, { t: 'd.all', strokes: S.strokes });
        }
      }
      dirty = true;
    },
    // Somebody left for good (did not come back in time, or «Salir»).
    // 2 players: back to the menu. 3-6: the match goes on without them.
    onPlayerLeft: function (i) {
      if (!ffa()) return false;
      const idx = S.order.indexOf(i);
      if (idx < 0) return true; // was only watching
      S.order.splice(idx, 1);
      if (S.order.length < 2) return false;
      // Their future turns are dropped (the rounds already played stay)
      S.turns = S.turns.filter(function (s, k) { return k < S.round || s !== i; });
      S.eligible = S.eligible.filter(function (s) { return s !== i; });
      if (S.author === i) S.author = -1;
      dirty = true;
      if (S.phase === 'end') { S.ranking = ranking(); return true; }
      if (i === S.drawer) {
        if (S.phase === 'draw') endRoundFfa('left');
        else if (S.phase === 'intro' || S.phase === 'choose') {
          // The turn had not really started: straight to the next drawer
          S.turns.splice(S.round - 1, 1);
          S.round--;
          advance();
        }
      } else if (S.phase === 'draw' && S.correct.length >= S.eligible.length) {
        endRoundFfa('all');
      }
      return true;
    },
    syncTv: function (ws) {
      api.sendWs(ws, buildMeta());
      if (S.phase === 'draw' || S.phase === 'reveal' || S.phase === 'choose' || S.phase === 'intro') {
        api.sendWs(ws, { t: 'd.all', strokes: S.strokes });
      }
      if (S.phase === 'end') api.sendWs(ws, galleryMsg());
    },
    _state: S
  };
}

// ---------------------------------------------------------------- menu (lobby)
// «Palabras secretas»: each player can type up to 10 words in the phone menu,
// for the others to draw (with 2 players, for the partner). They are kept in
// memory only (per player, in the hub).
const MAX_CUSTOM_WORDS = 10;

function cleanWords(list) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach(function (raw) {
    if (out.length >= MAX_CUSTOM_WORDS) return;
    let s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
    s = Array.from(s).slice(0, 30).join('').trim();
    const k = normalize(s);
    if (k.replace(/[^a-z0-9]/g, '').length < 2 || seen.has(k)) return;
    seen.add(k);
    out.push(s);
  });
  return out;
}

const lobby = {
  messages: ['d.words'],
  onJoin: function (api, slot, store) {
    if (!store.words) store.words = [];
    api.sendSlot(slot, { t: 'd.words', list: store.words, max: MAX_CUSTOM_WORDS });
  },
  onMessage: function (api, slot, msg, store) {
    store.words = cleanWords(msg.list);
    api.sendSlot(slot, { t: 'd.words', list: store.words, max: MAX_CUSTOM_WORDS });
  },
  // Shown on the TV next to the player's name (never the words themselves)
  badge: function (store) {
    const n = (store.words || []).length;
    return n ? n + (n === 1 ? ' palabra secreta' : ' palabras secretas') : null;
  }
};

module.exports = {
  create: create, lobby: lobby, cleanWords: cleanWords, TIMES: TIMES, ROUNDS: ROUNDS, RATINGS: RATINGS, MAX_CUSTOM_WORDS: MAX_CUSTOM_WORDS,
  BONUS: BONUS, ORDER_FACTOR: ORDER_FACTOR, DRAWER_POOL: DRAWER_POOL,
  vueltasFor: vueltasFor, guessPoints: guessPoints, drawerPoints: drawerPoints, givesAway: givesAway
};
