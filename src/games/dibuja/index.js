'use strict';
/*
 * «Dibuja y adivina»: cooperative Pictionary for 2 players.
 *
 * Phases of each round:
 *   intro   «Ahora dibuja X» (transition screen)
 *   choose  the drawer picks 1 of 3 words (15 s; otherwise random)
 *   draw    80 s to draw and guess (hints at 50 % and 75 %)
 *   reveal  the word is revealed (guessed, or «Era: …»)
 * After the last round:
 *   end     gallery with the 8 drawings, final score and title
 *
 * Messages it receives:
 *   d.pick {i}            the drawer picks option i (0..2)
 *   d.skip                «Pasar palabra» (once per round)
 *   d.s {id,c,w,p,end}    piece of a stroke: normalized points [x,y,x,y,...] 0..1
 *   d.undo {id?}          undo the last stroke
 *   d.clear               clear everything
 *   d.guess {text}        a guess
 *   d.again               another match (from the end screen)
 *   d.words {list}        (menu) the player's secret words for the partner
 * Messages it sends:
 *   dmeta                 public state (never the secret word before the reveal)
 *   d.opts {opts}         ONLY to the drawer: the 3 options
 *   d.secret {word,...}   ONLY to the drawer: the chosen word
 *   d.s / d.undo / d.clear / d.all {strokes}   strokes (to the TV; d.all also to a reconnecting drawer)
 *   d.g {text,res}        guess and result ('no' | 'casi')
 *   d.hint {n}            a letter has been revealed
 *   d.skip                the word was skipped
 *   d.reveal {word,ok,points,...}
 *   d.gallery {items}     to the TV: the drawings of the whole match
 *   d.words {list,max}    (menu) to the player: their secret words
 * Every finished round is saved as a PNG in the gallery folder
 * (~/.game-to-tv/galeria by default), rendered in a worker thread.
 *
 * Environment:
 *   DIBUJA_DEBUG_SPEED  (1)  speeds up every timer (tests only)
 *   DIBUJA_ROUNDS       (8)  rounds per match
 */

const fs = require('fs');
const path = require('path');
const { WORDS, DIFFS } = require('./words');
const { judge, normalize, stripAccents } = require('./match');
const { renderPngAsync } = require('./raster');

const SPEED = Math.max(0.1, parseFloat(process.env.DIBUJA_DEBUG_SPEED) || 1);
const ROUNDS = Math.max(1, Math.min(20, parseInt(process.env.DIBUJA_ROUNDS, 10) || 8));
const TIMES = { intro: 3500, choose: 15000, draw: 80000, reveal: 6500 }; // ms «lógicos»
const HINTS_AT = [0.5, 0.75];
const BONUS = { facil: 0, media: 25, dificil: 75 };
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

let firstDrawerToggle = Math.random() < 0.5 ? 0 : 1;

function create(api) {
  const S = {
    phase: 'intro',
    round: 0,
    drawer: 0,
    left: 0,
    total: 0,
    paused: false,
    score: 0,
    used: new Set(),
    customOffered: new Set(),
    options: [],
    word: null,
    revealed: new Set(),
    hintsGiven: 0,
    skipsLeft: 1,
    guesses: [],
    strokes: [],
    strokeMap: new Map(),
    roundPoints: 0,
    history: [],
    last: null,
    stamp: stampOf(new Date()),
    lastGuessAt: 0
  };
  let dirty = true;
  let lastMetaAt = 0;
  let stopped = false;

  function guesser() { return 1 - S.drawer; }

  // ---------------------------------------------------------------- palabras
  function randomWord(diff, avoidCats) {
    let pool = WORDS.filter(function (w) { return w.diff === diff && !S.used.has(wkey(w.word)); });
    if (!pool.length) pool = WORDS.filter(function (w) { return w.diff === diff; });
    const pref = pool.filter(function (w) { return avoidCats.indexOf(w.cat) < 0; });
    const src = pref.length ? pref : pool;
    const w = src[Math.floor(Math.random() * src.length)];
    return { word: w.word, diff: w.diff, cat: w.cat, custom: false };
  }

  function customFor(drawerIdx) {
    // Palabras secretas que ha escrito la PAREJA del que dibuja
    const list = api.store(1 - drawerIdx).words || [];
    const fresh = list.filter(function (w) { return !S.used.has(wkey(w)); });
    if (!fresh.length) return null;
    const notOffered = fresh.filter(function (w) { return !S.customOffered.has(wkey(w)); });
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
      S.customOffered.add(wkey(cw));
      opts[1] = { word: cw, diff: 'media', cat: 'secreta', custom: true };
    }
    // Las palabras normales ofrecidas no se vuelven a ofrecer en la partida
    opts.forEach(function (o) { if (!o.custom) S.used.add(wkey(o.word)); });
    return opts;
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
    S.round = 0;
    S.score = 0;
    S.used = new Set();
    S.customOffered = new Set();
    S.history = [];
    S.stamp = stampOf(new Date());
    firstDrawerToggle = 1 - firstDrawerToggle;
    S.firstDrawer = firstDrawerToggle;
    api.log('[dibuja] Nueva partida (' + ROUNDS + ' rondas)');
    nextRound();
  }

  function resetRoundDrawing() {
    S.strokes = [];
    S.strokeMap = new Map();
    S.roundPoints = 0;
  }

  function nextRound() {
    S.round++;
    S.drawer = (S.firstDrawer + S.round - 1) % 2;
    S.word = null;
    S.options = [];
    S.revealed = new Set();
    S.hintsGiven = 0;
    S.skipsLeft = 1;
    S.guesses = [];
    S.last = null;
    resetRoundDrawing();
    api.sendTvs({ t: 'd.all', strokes: [] });
    setPhase('intro', TIMES.intro);
  }

  function enterChoose() {
    S.options = pickOptions();
    setPhase('choose', TIMES.choose);
    sendDrawer({ t: 'd.opts', round: S.round, opts: S.options });
  }

  function chooseWord(i) {
    const o = S.options[i];
    if (!o) return;
    S.word = o;
    S.used.add(wkey(o.word));
    S.options = [];
    S.revealed = new Set();
    setPhase('draw', TIMES.draw);
    sendDrawer(secretMsg());
    api.log('[dibuja] Ronda ' + S.round + ': dibuja ' + api.name(S.drawer));
  }

  function secretMsg() {
    return { t: 'd.secret', round: S.round, word: S.word.word, diff: S.word.diff, cat: S.word.cat, custom: !!S.word.custom, skipsLeft: S.skipsLeft };
  }

  function skipWord() {
    if (S.phase !== 'draw' || S.skipsLeft <= 0 || !S.word) return;
    let nw;
    if (S.word.custom) {
      nw = randomWord('media', [S.word.cat]);
    } else {
      nw = randomWord(S.word.diff, [S.word.cat]);
    }
    S.used.add(wkey(nw.word));
    S.skipsLeft--;
    S.word = nw;
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
      ok: ok, points: points, drawer: S.drawer + 1, strokes: S.strokes, file: null
    };
    S.history.push(entry);
    savePng(entry);
    setPhase('reveal', TIMES.reveal);
    api.broadcast({ t: 'd.reveal', round: S.round, word: S.word.word, diff: S.word.diff, ok: ok, points: points, secsLeft: secsLeft, bonus: ok ? bonus : 0, score: S.score });
    api.log('[dibuja] Ronda ' + S.round + ' ' + (ok ? 'acertada (+' + points + ')' : 'sin acertar') + ': ' + S.word.word);
  }

  function enterEnd() {
    setPhase('end', 0);
    S.rating = rating(S.score, ROUNDS);
    api.sendTvs(galleryMsg());
    api.log('[dibuja] Fin de partida: ' + S.score + ' puntos (' + S.rating.title + ')');
  }

  function galleryMsg() {
    return {
      t: 'd.gallery',
      items: S.history.map(function (h) {
        return { round: h.round, word: h.word, diff: h.diff, ok: h.ok, points: h.points, drawer: h.drawer, strokes: h.strokes };
      })
    };
  }

  function onTimeout() {
    switch (S.phase) {
      case 'intro': enterChoose(); break;
      case 'choose': chooseWord(Math.floor(Math.random() * S.options.length)); break;
      case 'draw': endRound(false); break;
      case 'reveal':
        if (S.round >= ROUNDS) enterEnd();
        else nextRound();
        break;
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

  function guess(text) {
    const now = Date.now();
    if (now - S.lastGuessAt < 150) return;
    S.lastGuessAt = now;
    const t = cleanGuess(text);
    if (!t) return;
    const res = judge(t, S.word.word);
    if (res === 'ok') { endRound(true, t); return; }
    S.guesses.push({ text: t, res: res });
    if (S.guesses.length > 30) S.guesses.shift();
    api.broadcast({ t: 'd.g', text: t, res: res });
    dirty = true;
  }

  // ---------------------------------------------------------------- estado público
  function buildMeta() {
    const m = {
      t: 'dmeta',
      phase: S.phase,
      round: S.round,
      rounds: ROUNDS,
      drawer: S.drawer + 1,
      guesser: guesser() + 1,
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
    for (let i = 0; i < 2; i++) if (!api.isConnected(i)) m.waiting.push(api.name(i));
    if (S.phase === 'draw') {
      m.hint = hintPattern();
      m.letters = letterCount();
      m.guesses = S.guesses.slice(-5);
    }
    if (S.phase === 'reveal' || S.phase === 'end') {
      m.last = S.last;
      if (S.phase === 'reveal') m.guesses = S.guesses.slice(-5);
    }
    if (S.phase === 'end') {
      m.rating = S.rating;
      m.maxRound = 100 + 3 * Math.ceil(TIMES.draw / 1000) + BONUS.dificil;
      m.history = S.history.map(function (h) {
        return { round: h.round, word: h.word, diff: h.diff, ok: h.ok, points: h.points, drawer: h.drawer, custom: h.custom };
      });
    }
    return m;
  }

  function sendMeta() {
    lastMetaAt = Date.now();
    dirty = false;
    api.broadcast(JSON.stringify(buildMeta()));
  }

  // ---------------------------------------------------------------- interfaz del módulo
  return {
    id: 'dibuja',
    start: startMatch,
    stop: function () { stopped = true; },
    tick: function (dt) {
      if (stopped) return;
      const paused = !api.bothConnected();
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
      const isDrawer = who === S.drawer;
      const isGuesser = who === guesser();
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
          if (isGuesser && S.phase === 'draw' && !S.paused) guess(msg.text);
          break;
        case 'd.again':
          if (S.phase === 'end') startMatch();
          break;
      }
    },
    onPlayerDisconnected: function () { /* el tick detecta la pausa */ },
    onPlayerJoined: function (i) {
      api.sendSlot(i, buildMeta());
      if (i === S.drawer) {
        if (S.phase === 'choose') api.sendSlot(i, { t: 'd.opts', round: S.round, opts: S.options });
        if (S.phase === 'draw') {
          api.sendSlot(i, secretMsg());
          api.sendSlot(i, { t: 'd.all', strokes: S.strokes });
        }
      }
      dirty = true;
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
// «Palabras secretas para tu pareja»: each player can type up to 10 words in
// the phone menu. They are kept in memory only (per player, in the hub).
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

module.exports = { create: create, lobby: lobby, cleanWords: cleanWords, TIMES: TIMES, ROUNDS: ROUNDS, RATINGS: RATINGS, MAX_CUSTOM_WORDS: MAX_CUSTOM_WORDS };
