'use strict';
/*
 * «2048»: slide the tiles, join equal numbers and reach 2048. Written from
 * scratch for game-to-tv (inspired by the classic 2048).
 *
 * 1 player («solo»): one big board on the TV, score and best score
 * («Récord», kept per name in <dataDir>/records-2048.json). The phone is the
 * pad (swipes and arrow buttons); the TV keyboard / LG remote arrows move
 * player 1's board too, so a laptop alone works once one phone has joined.
 * Reaching 2048 stops for a «¡Lo conseguiste!» until the player goes on.
 * A stuck board shows «Sin movimientos» with «Otra» / «Menú».
 *
 * 2 to 6 players («carrera»): one board each, side by side, against the
 * clock (3 min) or until every board is stuck; then a ranking with medals.
 * The clock stops while a player is reconnecting.
 *
 * All the logic lives here (logic.js): the phones and the TV only send moves.
 *
 * Messages it receives:
 *   { t: 'n.move', dir }   'up' | 'down' | 'left' | 'right' (from the TV: player 1's board)
 *   { t: 'n.cont' }        go on after «¡Lo conseguiste!»
 *   { t: 'n.new' }         new match (solo: «Nueva partida»; race: only at the end)
 * Messages it sends:
 *   { t: 'nmeta', ... }    the whole public state (see buildMeta)
 *   { t: 'n.win', slot }   a board just reached 2048
 *
 * Environment (tests): G2048_DEBUG_SPEED (1) speeds up the clocks,
 * G2048_RACE_SECONDS (180) sets the length of a race.
 */
const L = require('./logic');
const Records = require('./records');

const SPEED = Math.max(0.1, parseFloat(process.env.G2048_DEBUG_SPEED) || 1);
const RACE_MS = Math.max(5, parseFloat(process.env.G2048_RACE_SECONDS) || 180) * 1000;
const INTRO_MS = 3000;
const SAVE_EVERY_MS = 5000;

function create(api, opts) {
  opts = opts || {};
  const random = opts.random || Math.random;
  const raceMs = opts.raceMs || RACE_MS;
  const records = opts.records || Records.storeFor(api.dataDir || null, api.log);
  const S = {
    match: 0,
    mode: 'solo',     // solo | race
    phase: 'play',    // (race: intro ->) play -> end
    order: [],        // slots that play this match
    boards: {},       // slot -> board (logic.js) + seq, gone, prevBest, cele
    left: 0,          // intro ms left
    clock: 0,         // race ms left
    paused: false,
    ranking: null
  };
  let dirty = true;
  let lastMetaAt = 0;
  let lastSaveAt = Date.now();
  let stopped = false;

  function makeBoard(slot) {
    const b = L.newBoard(random);
    b.seq = 0;
    b.gone = [];
    b.cele = false;
    b.prevBest = records.get(api.name(slot));
    return b;
  }

  function startMatch() {
    // Scores of the old match first
    S.order.forEach(keepRecord);
    records.save();
    S.match++;
    S.order = api.players().slice().sort(function (a, b) { return a - b; });
    S.mode = S.order.length > 1 ? 'race' : 'solo';
    S.boards = {};
    S.order.forEach(function (s) { S.boards[s] = makeBoard(s); });
    S.ranking = null;
    S.clock = raceMs;
    if (S.mode === 'race') { S.phase = 'intro'; S.left = INTRO_MS; } else { S.phase = 'play'; S.left = 0; }
    S.paused = false;
    dirty = true;
    api.log('[2048] Partida ' + S.match + ' (' + (S.mode === 'race' ? 'carrera de ' + S.order.length : 'en solitario') + '): ' + S.order.map(api.name).join(', '));
  }

  function keepRecord(slot) {
    const b = S.boards[slot];
    if (b && b.score > 0) records.update(api.name(slot), b.score);
  }

  function inMatch(slot) { return S.order.indexOf(slot) >= 0; }

  function doMove(slot, dir) {
    if (S.phase !== 'play' || (S.mode === 'race' && S.paused)) return false;
    const b = S.boards[slot];
    if (!b || b.over || b.cele) return false;
    const r = L.move(b, dir, random);
    if (!r.moved) return false;
    b.seq++;
    r.gone.forEach(function (g) { b.gone.push(g.id, g.cell); });
    if (b.score > b.prevBest) records.update(api.name(slot), b.score);
    if (r.reached) {
      if (S.mode === 'solo') b.cele = true;
      api.log('[2048] ¡' + api.name(slot) + ' llega a 2048!');
      api.broadcast({ t: 'n.win', slot: slot + 1 });
    }
    if (b.over) boardOver(slot);
    dirty = true;
    return true;
  }

  function boardOver(slot) {
    const b = S.boards[slot];
    api.log('[2048] ' + api.name(slot) + ': sin movimientos con ' + b.score + ' puntos');
    keepRecord(slot);
    records.save();
    lastSaveAt = Date.now();
    if (S.mode === 'race' && S.order.every(function (s) { return S.boards[s].over; })) endRace();
  }

  function ranking() {
    const list = S.order.map(function (s) { return { slot: s + 1, score: S.boards[s].score, max: S.boards[s].max }; });
    function better(a, b) { return a.score > b.score || (a.score === b.score && a.max > b.max); }
    list.forEach(function (r) { r.rank = 1 + list.filter(function (o) { return better(o, r); }).length; });
    list.sort(function (a, b) { return a.rank - b.rank || a.slot - b.slot; });
    return list;
  }

  function endRace() {
    S.phase = 'end';
    S.ranking = ranking();
    S.order.forEach(keepRecord);
    records.save();
    lastSaveAt = Date.now();
    dirty = true;
    api.log('[2048] Fin de la carrera: ' + S.ranking.map(function (r) { return r.rank + 'º ' + api.name(r.slot - 1) + ' ' + r.score; }).join(', '));
  }

  function tick(dt) {
    if (stopped) return;
    if (records.isDirty() && Date.now() - lastSaveAt >= SAVE_EVERY_MS) { records.save(); lastSaveAt = Date.now(); }
    // Pause (race only) while a player of the match is reconnecting
    const paused = S.mode === 'race' && S.phase !== 'end' && !S.order.every(function (s) { return api.isConnected(s); });
    if (paused !== S.paused) {
      S.paused = paused;
      dirty = true;
      api.log('[2048] ' + (paused ? 'Pausa: falta un jugador' : 'Se reanuda'));
    }
    if (paused || S.mode !== 'race') return;
    const d = dt * 1000 * SPEED;
    if (S.phase === 'intro') {
      S.left -= d;
      if (S.left <= 0) { S.phase = 'play'; S.left = 0; dirty = true; }
    } else if (S.phase === 'play') {
      S.clock -= d;
      if (S.clock <= 0) { S.clock = 0; endRace(); }
    }
  }

  function boardMeta(s) {
    const b = S.boards[s];
    const tiles = [];
    b.cells.forEach(function (t, cell) { if (t) tiles.push(t.id, t.v, cell, t.n ? 1 : (t.m ? 2 : 0)); });
    return {
      slot: s + 1,
      score: b.score,
      best: Math.max(b.prevBest, b.score),
      rec: b.prevBest > 0 && b.score > b.prevBest,
      max: b.max,
      over: b.over,
      won: b.won,
      cele: b.cele,
      seq: b.seq,
      tiles: tiles,     // flat: id, value, cell (0-15), flag (1 new, 2 merged in the last move)
      gone: b.gone.slice() // flat: id, cell it went into (merged in the last move)
    };
  }

  function buildMeta() {
    return {
      t: 'nmeta',
      match: S.match,
      mode: S.mode,
      phase: S.phase,
      players: S.order.map(function (s) { return s + 1; }),
      paused: S.paused,
      waiting: S.order.filter(function (s) { return !api.isConnected(s); }).map(api.name),
      left: Math.max(0, Math.round(S.left)),
      clock: Math.max(0, Math.round(S.clock)),
      clockTotal: raceMs,
      speed: SPEED,
      boards: S.order.map(boardMeta),
      ranking: S.ranking
    };
  }

  function sendMeta() {
    dirty = false;
    lastMetaAt = Date.now();
    api.broadcast(JSON.stringify(buildMeta()));
    S.order.forEach(function (s) { S.boards[s].gone = []; });
  }

  function playerLeft(i) {
    keepRecord(i);
    records.save();
    const idx = S.order.indexOf(i);
    if (idx < 0) return true;          // was only watching
    S.order.splice(idx, 1);
    delete S.boards[i];
    dirty = true;
    if (!S.order.length) { startMatch(); return true; } // only people watching remain: a new match for them
    if (S.phase === 'end') S.ranking = ranking();
    else if (S.mode === 'race' && S.order.every(function (s) { return S.boards[s].over; })) endRace();
    return true;
  }

  return {
    id: '2048',
    start: startMatch,
    stop: function () {
      stopped = true;
      S.order.forEach(keepRecord);
      records.save();
    },
    tick: tick,
    flush: function () { if (dirty || Date.now() - lastMetaAt >= 1000) sendMeta(); },
    onMessage: function (who, msg) {
      if (stopped) return;
      // The TV keyboard / remote plays for player 1 (the first board)
      const slot = who >= 0 ? who : (S.order.length ? S.order[0] : -1);
      if (slot < 0 || !inMatch(slot)) return;
      const b = S.boards[slot];
      if (msg.t === 'n.move') doMove(slot, String(msg.dir));
      else if (msg.t === 'n.cont') { if (b.cele) { b.cele = false; dirty = true; } }
      else if (msg.t === 'n.new') { if (S.mode === 'solo' || S.phase === 'end') startMatch(); }
    },
    onPlayerDisconnected: function () { dirty = true; },
    onPlayerJoined: function (i) { api.sendSlot(i, buildMeta()); dirty = true; },
    onPlayerLeft: playerLeft,
    syncTv: function (ws) { api.sendWs(ws, buildMeta()); },
    _state: S
  };
}

module.exports = { create: create, RACE_MS: RACE_MS, INTRO_MS: INTRO_MS };
