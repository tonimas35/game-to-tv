'use strict';
/*
 * «El Infiltrado»: social deduction for 3 to 6 players.
 *
 * Every round, everybody but one gets the same secret LOCATION and a ROLE
 * inside it on their phone. The other one is the infiltrado: their card only
 * says «Eres el infiltrado». Players ask each other questions out loud, one
 * at a time (the TV says whose turn it is); the others try to unmask the spy
 * without giving the place away, and the spy tries to guess it.
 *
 * A round:
 *   intro      «Mirad vuestra carta» (the cards are sent right away)
 *   play       the round clock runs (6 min with 3-4 players, 8 with 5-6, or
 *              4/6/8/10 chosen in the menu). The asker picks whom to ask on
 *              their phone (never the one who has just asked them); that
 *              player asks next. Any time:
 *                - a player may ACCUSE someone (once per round): everybody
 *                  but the accused votes Sí/No in 30 s; it passes only with a
 *                  unanimous Sí (not voting = no). The round clock stops
 *                  meanwhile. If it fails, the game goes on and only the
 *                  count is shown («3 a favor, 1 en contra»).
 *                - the spy may say «¡Sé el lugar!» and pick it (also during
 *                  the intro or an accusation): the round ends at once.
 *   accuse     an accusation vote (see above)
 *   vote       time is up: everybody votes for a suspect (45 s, not
 *              themselves). Plurality decides; a tie (or no votes) saves the
 *              spy.
 *   lastguess  the spy was caught by the final vote: 30 s to guess the place
 *   reveal     who was the spy, the place, everybody's role, how it ended and
 *              the points
 *   end        after the last round: ranking with medals
 *
 * Points of a round:
 *   spy not caught (time / final vote misses / tie / innocent accused) or
 *   the spy guesses at the very end                       spy +2
 *   the spy ends the round with a correct «¡Sé el lugar!» spy +4
 *   spy caught by an accusation                           non-spies +1, the accuser +2
 *   spy caught by the final vote and misses the last guess non-spies +1
 *   the spy guesses wrong                                 non-spies +1
 *   the spy leaves for good                               no points
 * Rounds: as many as players, so each one starts the questioning once.
 *
 * NO SPOILERS (test/infiltrado.test.js checks all of it):
 *   - the location and the roles never go to the TV before the reveal, and
 *     the location never goes to the spy's phone;
 *   - each role only goes to its player;
 *   - who is the spy is never sent to anybody before the reveal (or before
 *     the final vote catches them). Every phone gets the SAME message shape
 *     at the same moment, padded to the same size:
 *       { t: 'i.card', round, match, location: 'X', role: 'Y', spy: false, pad }
 *       { t: 'i.card', round, match, location: null, role: null, spy: true, pad }
 *     Everything else (imeta) is one identical message for the TV and every
 *     phone, so the server never treats the spy's phone differently.
 *   - accusation and final votes are anonymous: individual votes are never
 *     sent to anybody (not even back to the voter); only who has voted and,
 *     at the end, the count.
 *   - the server log does not name the spy or the place before the reveal.
 *
 * Messages it receives (slots in messages start at 1):
 *   i.ask {to}           the asker picks whom to ask
 *   i.accuse {suspect}   open an accusation
 *   i.vote {yes}         accusation vote
 *   i.final {suspect}    final vote
 *   i.guess {i}          the spy guesses: index in imeta.places
 *   i.next               reveal -> next round (any phone, or the TV)
 *   i.again              end -> another match (any phone, or the TV)
 *   i.places {list}      (menu) my «lugares propios»: [{ name, roles: [] }] (max 5)
 *   i.cfg {minutes}      (menu) round length: 0 (auto), 4, 6, 8 or 10
 * Messages it sends:
 *   imeta                the public state (identical for the TV and every phone)
 *   i.card               ONLY to each player: their secret card (see above)
 *   i.places {list,max}  (menu) to the player: their own places
 *   i.cfg {minutes,by}   (menu) to every phone: the round length
 *
 * Environment (tests):
 *   INFILTRADO_DEBUG_SPEED  (1)    speeds up every timer
 *   INFILTRADO_PROB_PROPIO  (0.35) chance that a round uses a «lugar propio» (when there is one)
 *   INFILTRADO_RONDAS       (auto) rounds per match
 */
const crypto = require('crypto');
const { LOCATIONS, GENERIC_ROLES } = require('./locations');

const SPEED = Math.max(0.1, parseFloat(process.env.INFILTRADO_DEBUG_SPEED) || 1);
const CUSTOM_PROB = (function () {
  const v = parseFloat(process.env.INFILTRADO_PROB_PROPIO);
  return isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.35;
})();
const FORCED_ROUNDS = Math.max(0, Math.min(20, parseInt(process.env.INFILTRADO_RONDAS, 10) || 0));
const TIMES = { intro: 5000, accuse: 30000, vote: 45000, lastguess: 30000, reveal: 15000 }; // ms
const MINUTES = [4, 6, 8, 10];
const MAX_PLAYERS = 6;
const MAX_CUSTOM = 5;
const MAX_HISTORY = 6;
const POINTS = { spy: 2, spyGuess: 4, team: 1, accuser: 2 };
const IN_ROUND = ['intro', 'play', 'accuse', 'vote', 'lastguess'];

// ---------------------------------------------------------------- helpers
function stripAccents(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, ''); }
/** Comparison/sort key: «Una playa» -> «playa». */
function normKey(s) {
  let t = stripAccents(String(s == null ? '' : s).toLowerCase());
  t = t.replace(/[^a-z0-9ñ]+/g, ' ').trim();
  t = t.replace(/^(el|la|los|las|un|una|unos|unas)\s+/, '');
  return t;
}
function cleanText(raw, max) {
  const s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, max).join('').trim();
}
/** Round length: the menu choice, or 6 min with 3-4 players and 8 with 5-6. */
function roundMinutes(n, chosen) {
  if (MINUTES.indexOf(chosen) >= 0) return chosen;
  return n >= 5 ? 8 : 6;
}
/**
 * Points of a finished round, by slot. res: { how, spyWins, guessOk, accuser }
 */
function pointsFor(res, order, spy) {
  const pts = {};
  if (res.how === 'abandono') return pts;
  if (res.spyWins) {
    pts[spy] = res.how === 'adivina' && res.guessOk ? POINTS.spyGuess : POINTS.spy;
    return pts;
  }
  order.forEach(function (s) { if (s !== spy) pts[s] = POINTS.team; });
  if (res.how === 'acusacion' && res.accuser >= 0 && res.accuser !== spy) pts[res.accuser] = POINTS.accuser;
  return pts;
}

// Settings of the room (one per hub): the round length chosen in the menu
const rooms = new WeakMap();
function roomOf(api) {
  let r = rooms.get(api);
  if (!r) { r = { minutes: 0, by: '', matches: 0 }; rooms.set(api, r); }
  return r;
}

// ---------------------------------------------------------------- the game
function create(api, opts) {
  const random = (opts && opts.random) || Math.random;
  const S = {
    match: '',
    order: [],          // slots playing this match (a phone that joins later watches)
    names: {},          // slot -> name (kept for the reveal if they leave)
    starters: [],       // first asker of each round
    round: 0,
    phase: 'intro',
    left: 0,            // ms left in the current phase (intro, accuse, vote, lastguess, reveal)
    total: 0,
    clock: 0,           // ms left in the round (runs only in 'play')
    clockTotal: 0,
    minutes: 6,
    paused: false,
    scores: [],
    used: new Set(),    // keys of the places already played this match
    pool: [],           // this round's places: { name, key, roles, custom, authors, used }
    loc: null,          // the secret place (an entry of pool)
    spy: -1,
    roles: {},          // slot -> role
    cards: {},          // slot -> JSON string of their card (all the same size)
    asker: -1,
    askedBy: -1,
    history: [],
    accUsed: new Set(),
    acc: null,          // { by, suspect, voters, votes: { slot: bool } }
    accResult: null,    // last failed accusation: { seq, by, suspect, yes, no, none }
    accSeq: 0,
    vote: null,         // { voters, votes: { slot: suspect } }
    tally: null,
    caught: -1,
    result: null,
    ranking: null
  };
  let dirty = true;
  let lastMetaAt = 0;
  let stopped = false;

  function rnd(n) { return Math.floor(random() * n) % n; }
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function inOrder(s) { return S.order.indexOf(s) >= 0; }
  function nameOf(s) { return S.names[s] || api.name(s); }
  function setPhase(ph, ms) {
    S.phase = ph;
    S.total = ms || 0;
    S.left = ms || 0;
    dirty = true;
  }

  // ---------------------------------------------------------------- match
  function startMatch() {
    S.order = api.players().slice(0, MAX_PLAYERS);
    S.names = {};
    S.order.forEach(function (s) { S.names[s] = api.name(s); });
    S.match = crypto.randomBytes(6).toString('hex');
    S.scores = new Array(api.slots).fill(0);
    S.used = new Set();
    S.round = 0;
    S.ranking = null;
    const n = S.order.length;
    const rounds = FORCED_ROUNDS || n;
    const room = roomOf(api);
    const offset = room.matches++ % Math.max(1, n);
    S.starters = [];
    for (let r = 0; r < rounds; r++) S.starters.push(S.order[(r + offset) % n]);
    api.log('[infiltrado] Nueva partida: ' + n + ' jugadores, ' + rounds + ' rondas');
    nextRound();
  }

  // Built-in places plus the «lugares propios» of the players of the match,
  // sorted by their main word («Una boda» under B). Same list for everybody.
  function buildPool() {
    const byKey = {};
    const pool = LOCATIONS.map(function (l) {
      const e = { name: l.name, key: normKey(l.name), roles: l.roles.slice(), custom: false, authors: [] };
      byKey[e.key] = e;
      return e;
    });
    S.order.forEach(function (s) {
      (api.store(s).places || []).forEach(function (p) {
        const key = normKey(p.name);
        if (!key) return;
        const had = byKey[key];
        if (had) {
          if (had.custom && had.authors.indexOf(s) < 0) had.authors.push(s);
          return;
        }
        const e = { name: p.name, key: key, roles: (p.roles || []).slice(), custom: true, authors: [s] };
        byKey[key] = e;
        pool.push(e);
      });
    });
    pool.forEach(function (e) { e.used = S.used.has(e.key); });
    pool.sort(function (a, b) { return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0); });
    return pool;
  }

  // Never a place the spy wrote (they would know it), never one already played
  function pickLocation(spy) {
    const notMine = S.pool.filter(function (e) { return e.authors.indexOf(spy) < 0; });
    let cand = notMine.filter(function (e) { return !e.used; });
    if (!cand.length) cand = notMine;
    const customs = cand.filter(function (e) { return e.custom; });
    const builtin = cand.filter(function (e) { return !e.custom; });
    if (customs.length && (random() < CUSTOM_PROB || !builtin.length)) cand = customs;
    else if (builtin.length) cand = builtin;
    return cand[rnd(cand.length)];
  }

  // k different roles of the place (generic ones fill a short custom list)
  function rolesFor(e, k) {
    const seen = new Set();
    function distinct(list) {
      return list.filter(function (r) {
        const key = normKey(r);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    const own = shuffle(distinct(e.roles));
    if (own.length >= k) return own.slice(0, k);
    return shuffle(own.concat(distinct(GENERIC_ROLES).slice(0, k - own.length)));
  }

  function nextRound() {
    S.round++;
    S.order.forEach(function (s) { S.names[s] = api.name(s); });
    S.pool = buildPool();
    S.spy = S.order[rnd(S.order.length)];
    S.loc = pickLocation(S.spy);
    const nonSpies = S.order.filter(function (s) { return s !== S.spy; });
    const roles = rolesFor(S.loc, nonSpies.length);
    S.roles = {};
    nonSpies.forEach(function (s, k) { S.roles[s] = roles[k]; });
    S.asker = S.starters[S.round - 1];
    if (!inOrder(S.asker)) S.asker = S.order[(S.round - 1) % S.order.length];
    S.askedBy = -1;
    S.history = [];
    S.accUsed = new Set();
    S.acc = null;
    S.accResult = null;
    S.vote = null;
    S.tally = null;
    S.caught = -1;
    S.result = null;
    S.minutes = roundMinutes(S.order.length, roomOf(api).minutes);
    S.clockTotal = S.clock = S.minutes * 60000;
    makeCards();
    setPhase('intro', TIMES.intro);
    // Every card in the same tick, all of the same size
    S.order.forEach(function (s) { api.sendSlot(s, S.cards[s]); });
    // (no spy or place in the log before the reveal: /logs can be opened on the TV server)
    api.log('[infiltrado] Ronda ' + S.round + ' de ' + S.starters.length + ': empieza preguntando ' + nameOf(S.asker));
  }

  function makeCards() {
    const raw = {};
    let max = 0;
    S.order.forEach(function (s) {
      const spy = s === S.spy;
      const c = { t: 'i.card', round: S.round, match: S.match, location: spy ? null : S.loc.name, role: spy ? null : S.roles[s], spy: spy, pad: '' };
      raw[s] = c;
      max = Math.max(max, Buffer.byteLength(JSON.stringify(c)));
    });
    S.cards = {};
    S.order.forEach(function (s) {
      const c = raw[s];
      c.pad = new Array(max - Buffer.byteLength(JSON.stringify(c)) + 1).join(' ');
      S.cards[s] = JSON.stringify(c);
    });
  }

  function advance() {
    if (S.round >= S.starters.length) enterEnd();
    else nextRound();
  }

  function ranking() {
    const list = S.order.map(function (s) { return { slot: s + 1, name: nameOf(s), score: S.scores[s] || 0 }; });
    list.sort(function (a, b) { return b.score - a.score || a.slot - b.slot; });
    list.forEach(function (r) { r.rank = 1 + list.filter(function (o) { return o.score > r.score; }).length; });
    return list;
  }

  function enterEnd() {
    S.ranking = ranking();
    S.cards = {};
    setPhase('end', 0);
    api.log('[infiltrado] Fin de partida: ' + S.ranking.map(function (r) { return r.rank + 'º ' + r.name + ' ' + r.score; }).join(', '));
  }

  // ---------------------------------------------------------------- end of a round
  // res: { how, spyWins, guess, guessOk, accuser, suspect, yes, no, none }
  function finishRound(res) {
    const pts = pointsFor(res, S.order, S.spy);
    Object.keys(pts).forEach(function (s) { S.scores[s] = (S.scores[s] || 0) + pts[s]; });
    S.used.add(S.loc.key);
    S.acc = null;
    S.vote = null;
    S.result = {
      how: res.how,
      spy: S.spy + 1,
      spyName: nameOf(S.spy),
      spyWins: res.how === 'abandono' ? null : !!res.spyWins,
      location: S.loc.name,
      custom: S.loc.custom,
      roles: S.order.filter(function (s) { return s !== S.spy && S.roles[s]; }).map(function (s) { return { slot: s + 1, name: nameOf(s), role: S.roles[s] }; }),
      accuser: res.accuser >= 0 ? res.accuser + 1 : 0,
      suspect: res.suspect >= 0 ? res.suspect + 1 : 0,
      yes: res.yes || 0,
      no: res.no || 0,
      none: res.none || 0,
      tally: S.tally,
      guess: res.guess || null,
      guessOk: !!res.guessOk,
      points: Object.keys(pts).map(function (s) { return { slot: Number(s) + 1, pts: pts[s] }; }),
      scores: S.scores.slice()
    };
    setPhase('reveal', TIMES.reveal);
    api.log('[infiltrado] Ronda ' + S.round + ': ' + res.how + '; ' + nameOf(S.spy) + ' era el infiltrado en «' + S.loc.name + '» (' +
      (res.how === 'abandono' ? 'sin puntos' : (res.spyWins ? 'gana el infiltrado' : 'gana el resto')) + ')');
  }

  // ---------------------------------------------------------------- turns
  function ask(who, to) {
    if (S.phase !== 'play' || who !== S.asker) return;
    if (!inOrder(to) || to === who || to === S.askedBy) return;
    S.history.push({ from: who + 1, to: to + 1 });
    if (S.history.length > MAX_HISTORY) S.history.shift();
    S.askedBy = who;
    S.asker = to;
    dirty = true;
  }

  // ---------------------------------------------------------------- accusations
  function accuse(who, suspect) {
    if (S.phase !== 'play' || !inOrder(who) || S.accUsed.has(who)) return;
    if (!inOrder(suspect) || suspect === who) return;
    S.accUsed.add(who);
    const voters = S.order.filter(function (s) { return s !== suspect; });
    S.acc = { by: who, suspect: suspect, voters: voters, votes: {} };
    S.acc.votes[who] = true; // whoever accuses votes Sí
    setPhase('accuse', TIMES.accuse);
    api.log('[infiltrado] ' + nameOf(who) + ' acusa a ' + nameOf(suspect));
    if (accDone()) resolveAccusation();
  }
  function accDone() { return S.acc.voters.every(function (s) { return S.acc.votes[s] !== undefined; }); }
  function accVote(who, yes) {
    if (S.phase !== 'accuse' || !S.acc || S.acc.voters.indexOf(who) < 0 || S.acc.votes[who] !== undefined) return;
    S.acc.votes[who] = !!yes;
    dirty = true;
    // It never ends early on a «No»: the moment it ends must not tell who voted what
    if (accDone()) resolveAccusation();
  }
  function resolveAccusation() {
    const a = S.acc;
    let yes = 0, no = 0;
    a.voters.forEach(function (s) { if (a.votes[s] === true) yes++; else if (a.votes[s] === false) no++; });
    const none = a.voters.length - yes - no;
    if (yes === a.voters.length) {
      finishRound({ how: 'acusacion', spyWins: a.suspect !== S.spy, accuser: a.by, suspect: a.suspect, yes: yes, no: no, none: none });
      return;
    }
    S.accSeq++;
    S.accResult = { seq: S.accSeq, by: a.by + 1, suspect: a.suspect + 1, yes: yes, no: no, none: none };
    S.acc = null;
    setPhase('play', 0);
    api.log('[infiltrado] La acusación no prospera: ' + yes + ' a favor, ' + (no + none) + ' en contra');
  }

  // ---------------------------------------------------------------- final vote
  function enterVote() {
    S.clock = 0;
    S.vote = { voters: S.order.slice(), votes: {} };
    setPhase('vote', TIMES.vote);
    api.log('[infiltrado] Ronda ' + S.round + ': se acaba el tiempo, votación final');
  }
  function voteDone() { return S.vote.voters.every(function (s) { return S.vote.votes[s] !== undefined; }); }
  function finalVote(who, suspect) {
    if (S.phase !== 'vote' || !S.vote || S.vote.voters.indexOf(who) < 0 || S.vote.votes[who] !== undefined) return;
    if (!inOrder(suspect) || suspect === who) return;
    S.vote.votes[who] = suspect;
    dirty = true;
    if (voteDone()) resolveVote();
  }
  function resolveVote() {
    const count = {};
    Object.keys(S.vote.votes).forEach(function (v) { const s = S.vote.votes[v]; count[s] = (count[s] || 0) + 1; });
    S.tally = S.order.map(function (s) { return { slot: s + 1, votes: count[s] || 0 }; }).filter(function (t) { return t.votes > 0; });
    S.tally.sort(function (a, b) { return b.votes - a.votes || a.slot - b.slot; });
    const max = S.tally.length ? S.tally[0].votes : 0;
    const top = S.tally.filter(function (t) { return t.votes === max; });
    if (!max) { finishRound({ how: 'sinvotos', spyWins: true }); return; }
    if (top.length > 1) { finishRound({ how: 'empate', spyWins: true }); return; }
    const accused = top[0].slot - 1;
    if (accused !== S.spy) { finishRound({ how: 'votacion', spyWins: true, suspect: accused }); return; }
    // Caught: the spy has one last chance (the place is still secret)
    S.caught = S.spy;
    S.vote = null;
    setPhase('lastguess', TIMES.lastguess);
    api.log('[infiltrado] La votación pilla al infiltrado: última oportunidad');
  }

  // ---------------------------------------------------------------- the spy guesses
  function guess(who, i) {
    if (who !== S.spy) return; // only the spy (the others have no such button)
    const e = S.pool[i];
    if (!e) return;
    const ok = e === S.loc;
    if (S.phase === 'intro' || S.phase === 'play' || S.phase === 'accuse') {
      finishRound({ how: 'adivina', spyWins: ok, guess: e.name, guessOk: ok });
    } else if (S.phase === 'lastguess') {
      finishRound({ how: 'ultima', spyWins: ok, guess: e.name, guessOk: ok, suspect: S.spy });
    }
  }

  // ---------------------------------------------------------------- public state
  function buildMeta() {
    const m = {
      t: 'imeta',
      match: S.match,
      phase: S.phase,
      round: S.round,
      rounds: S.starters.length,
      players: S.order.map(function (s) { return s + 1; }),
      scores: S.scores.slice(),
      paused: S.paused,
      waiting: [],
      speed: SPEED,
      left: Math.max(0, Math.round(S.left)),
      total: S.total,
      clock: Math.max(0, Math.round(S.clock)),
      clockTotal: S.clockTotal,
      minutes: S.minutes,
      asker: S.asker + 1,
      askedBy: S.askedBy + 1,
      history: S.history.slice(),
      places: S.pool.map(function (e) { return { name: e.name, custom: e.custom, used: e.used }; }),
      accUsed: S.order.filter(function (s) { return S.accUsed.has(s); }).map(function (s) { return s + 1; }),
      acc: null,
      accResult: S.accResult,
      vote: null,
      caught: 0,
      result: null,
      ranking: null
    };
    S.order.forEach(function (s) { if (!api.isConnected(s)) m.waiting.push(api.name(s)); });
    if (S.acc) {
      m.acc = {
        by: S.acc.by + 1, suspect: S.acc.suspect + 1,
        voters: S.acc.voters.map(function (s) { return s + 1; }),
        voted: S.acc.voters.filter(function (s) { return S.acc.votes[s] !== undefined; }).map(function (s) { return s + 1; })
      };
    }
    if (S.vote) {
      m.vote = {
        voters: S.vote.voters.map(function (s) { return s + 1; }),
        voted: S.vote.voters.filter(function (s) { return S.vote.votes[s] !== undefined; }).map(function (s) { return s + 1; })
      };
    }
    if (S.phase === 'lastguess') m.caught = S.caught + 1;
    if (S.phase === 'reveal' || S.phase === 'end') m.result = S.result;
    if (S.phase === 'end') m.ranking = S.ranking;
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

  function tick(dt) {
    if (stopped) return;
    const paused = !everybodyHere();
    if (paused !== S.paused) {
      S.paused = paused;
      dirty = true;
      api.log('[infiltrado] ' + (paused ? 'Pausa: falta un jugador' : 'Se reanuda'));
    }
    if (paused || S.phase === 'end') return;
    const d = dt * 1000 * SPEED;
    if (S.phase === 'play') {
      S.clock -= d;
      if (S.clock <= 0) enterVote();
      return;
    }
    S.left -= d;
    if (S.left > 0) return;
    switch (S.phase) {
      case 'intro': setPhase('play', 0); break;
      case 'accuse': resolveAccusation(); break;
      case 'vote': resolveVote(); break;
      case 'lastguess': finishRound({ how: 'ultima', spyWins: false, guess: null, guessOk: false, suspect: S.spy }); break;
      case 'reveal': advance(); break;
    }
  }

  // ---------------------------------------------------------------- somebody leaves for good
  function playerLeft(i) {
    const idx = S.order.indexOf(i);
    if (idx < 0) return true; // was only watching
    const nextAsker = S.order[(idx + 1) % S.order.length];
    S.order.splice(idx, 1);
    if (S.order.length < 3) return false; // back to the menu (the hub explains why)
    dirty = true;
    S.starters = S.starters.filter(function (s, k) { return k < S.round || s !== i; });
    if (S.phase === 'end') { S.ranking = ranking(); return true; }
    if (IN_ROUND.indexOf(S.phase) >= 0 && i === S.spy) {
      finishRound({ how: 'abandono' });
      return true;
    }
    delete S.cards[i];
    delete S.roles[i];
    S.accUsed.delete(i);
    if (S.asker === i) { S.asker = nextAsker; S.askedBy = -1; }
    if (S.askedBy === i) S.askedBy = -1;
    if (S.acc) {
      if (S.acc.suspect === i) {
        // Nobody to accuse any more: the accusation is cancelled and given back
        S.accUsed.delete(S.acc.by);
        S.acc = null;
        setPhase('play', 0);
      } else {
        S.acc.voters = S.acc.voters.filter(function (s) { return s !== i; });
        delete S.acc.votes[i];
        if (accDone()) resolveAccusation();
      }
    }
    if (S.vote) {
      S.vote.voters = S.vote.voters.filter(function (s) { return s !== i; });
      delete S.vote.votes[i];
      // Votes for them do not count: those players vote again
      Object.keys(S.vote.votes).forEach(function (v) { if (S.vote.votes[v] === i) delete S.vote.votes[v]; });
      if (voteDone()) resolveVote();
    }
    return true;
  }

  function slotOf(v) {
    const n = Number(v);
    return isFinite(n) && Math.floor(n) === n ? n - 1 : -9;
  }

  return {
    id: 'infiltrado',
    start: startMatch,
    stop: function () { stopped = true; },
    tick: tick,
    flush: function () { if (dirty || Date.now() - lastMetaAt >= 1000) sendMeta(); },
    onMessage: function (who, msg) {
      if (stopped) return;
      if (msg.t === 'i.next') { if (S.phase === 'reveal') advance(); return; }
      if (msg.t === 'i.again') { if (S.phase === 'end') startMatch(); return; }
      if (who < 0 || !inOrder(who) || S.paused) return;
      switch (msg.t) {
        case 'i.ask': ask(who, slotOf(msg.to)); break;
        case 'i.accuse': accuse(who, slotOf(msg.suspect)); break;
        case 'i.vote': accVote(who, msg.yes === true); break;
        case 'i.final': finalVote(who, slotOf(msg.suspect)); break;
        case 'i.guess': {
          const n = Number(msg.i);
          if (isFinite(n) && Math.floor(n) === n) guess(who, n);
          break;
        }
      }
    },
    onPlayerDisconnected: function () { /* the tick pauses */ },
    // Also on reconnect: the public state and, for a player, THEIR card again
    onPlayerJoined: function (i) {
      api.sendSlot(i, buildMeta());
      if (S.cards[i] && S.phase !== 'end') api.sendSlot(i, S.cards[i]);
      dirty = true;
    },
    onPlayerLeft: playerLeft,
    syncTv: function (ws) { api.sendWs(ws, buildMeta()); },
    _state: S
  };
}

// ---------------------------------------------------------------- menu (lobby)
// «Lugares propios»: up to 5 per player, with or without roles. They join the
// pool of every round of the session (kept in memory, per player).
function cleanPlaces(list) {
  const out = [];
  const seen = new Set();
  const builtin = new Set(LOCATIONS.map(function (l) { return normKey(l.name); }));
  (Array.isArray(list) ? list : []).forEach(function (raw) {
    if (out.length >= MAX_CUSTOM) return;
    const item = typeof raw === 'string' ? { name: raw } : (raw && typeof raw === 'object' ? raw : {});
    const name = cleanText(item.name, 30);
    const key = normKey(name);
    if (key.replace(/[^a-z0-9ñ]/g, '').length < 2 || seen.has(key) || builtin.has(key)) return;
    seen.add(key);
    let roles = item.roles;
    if (typeof roles === 'string') roles = roles.split(/[,;\n]/);
    const rseen = new Set();
    const cleanRoles = [];
    (Array.isArray(roles) ? roles : []).forEach(function (r) {
      const t = cleanText(r, 24);
      const k = normKey(t);
      if (!k || rseen.has(k) || cleanRoles.length >= 6) return;
      rseen.add(k);
      cleanRoles.push(t);
    });
    out.push({ name: name, roles: cleanRoles });
  });
  return out;
}

function cfgMsg(api) {
  const r = roomOf(api);
  return { t: 'i.cfg', minutes: r.minutes, by: r.by, options: MINUTES };
}

const lobby = {
  messages: ['i.places', 'i.cfg'],
  onJoin: function (api, slot, store) {
    if (!store.places) store.places = [];
    api.sendSlot(slot, { t: 'i.places', list: store.places, max: MAX_CUSTOM });
    api.sendSlot(slot, cfgMsg(api));
  },
  onMessage: function (api, slot, msg, store) {
    if (msg.t === 'i.places') {
      store.places = cleanPlaces(msg.list);
      api.sendSlot(slot, { t: 'i.places', list: store.places, max: MAX_CUSTOM });
      return;
    }
    if (msg.t === 'i.cfg') {
      const m = Number(msg.minutes);
      if (m === 0 || MINUTES.indexOf(m) >= 0) {
        const r = roomOf(api);
        r.minutes = m;
        r.by = api.name(slot);
        api.log('[infiltrado] ' + r.by + ' pone las rondas ' + (m ? 'de ' + m + ' min' : 'en automático'));
        api.sendPhones(cfgMsg(api));
      } else {
        api.sendSlot(slot, cfgMsg(api));
      }
    }
  },
  // Shown on the TV next to the player's name (never the places themselves)
  badge: function (store) {
    const n = (store.places || []).length;
    return n ? n + (n === 1 ? ' lugar propio' : ' lugares propios') : null;
  }
};

module.exports = {
  create: create, lobby: lobby, cleanPlaces: cleanPlaces, normKey: normKey, roundMinutes: roundMinutes, pointsFor: pointsFor,
  TIMES: TIMES, MINUTES: MINUTES, POINTS: POINTS, MAX_CUSTOM: MAX_CUSTOM, LOCATIONS: LOCATIONS, GENERIC_ROLES: GENERIC_ROLES
};
