'use strict';
/*
 * «Reflejos»: the example game of docs/crear-un-juego.md.
 *
 * The TV shows «Preparados…», and after a random delay «¡YA!». The first
 * phone to tap wins the point. Tapping before «¡YA!» disqualifies you for
 * that round. Best of 5: the first to 3 points wins.
 *
 * Messages it receives (from phones):
 *   { t: 'r.tap' }       tap
 *   { t: 'r.again' }     another match (from the end screen)
 * Messages it sends (to the TV and the phones):
 *   { t: 'rmeta', ... }  the whole public state (see buildMeta)
 *
 * Environment: REFLEJOS_DEBUG_SPEED (1) speeds up every wait (tests only).
 */

const SPEED = Math.max(0.1, parseFloat(process.env.REFLEJOS_DEBUG_SPEED) || 1);
const POINTS_TO_WIN = 3;                       // best of 5
const TIMES = { wait: [2000, 5000], go: 5000, point: 2500 }; // ms

function create(api, opts) {
  const random = (opts && opts.random) || Math.random;
  const S = {
    phase: 'ready',   // ready -> go -> point -> ... -> end
    round: 0,
    left: 0,          // ms left in this phase
    scores: [],       // points per slot
    early: [],        // slots that tapped too soon this round
    last: null,       // { slot, ms } winner of the last round (null: nobody)
    winner: -1,
    goAt: 0,
    paused: false
  };
  let dirty = true;
  let lastMetaAt = 0;

  function setPhase(phase, ms) {
    S.phase = phase;
    S.left = ms || 0;
    dirty = true;
  }

  function nextRound() {
    S.round++;
    S.early = [];
    const w = TIMES.wait;
    setPhase('ready', w[0] + random() * (w[1] - w[0]));
  }

  function newMatch() {
    S.round = 0;
    S.scores = new Array(api.slots).fill(0);
    S.winner = -1;
    S.last = null;
    api.log('[reflejos] Nueva partida');
    nextRound();
  }

  function tap(slot) {
    if (S.paused) return;
    if (S.phase === 'ready') {
      // Too soon: out for this round
      if (S.early.indexOf(slot) >= 0) return;
      S.early.push(slot);
      api.broadcast({ t: 'r.early', slot: slot + 1 });
      // If everybody jumped the gun, the round starts again
      if (api.players().every(function (i) { return S.early.indexOf(i) >= 0; })) {
        S.round--;
        nextRound();
      }
      dirty = true;
    } else if (S.phase === 'go') {
      if (S.early.indexOf(slot) >= 0) return;
      S.scores[slot]++;
      S.last = { slot: slot, ms: Date.now() - S.goAt };
      if (S.scores[slot] >= POINTS_TO_WIN) {
        S.winner = slot;
        setPhase('end');
        api.log('[reflejos] Gana ' + api.name(slot));
      } else {
        setPhase('point', TIMES.point);
      }
    }
  }

  function tick(dt) {
    const paused = !api.allConnected();
    if (paused !== S.paused) { S.paused = paused; dirty = true; }
    if (paused || S.phase === 'end') return;
    S.left -= dt * 1000 * SPEED;
    if (S.left > 0) return;
    if (S.phase === 'ready') {
      S.goAt = Date.now();
      setPhase('go', TIMES.go);
    } else if (S.phase === 'go') {
      S.last = null;              // nobody tapped
      setPhase('point', TIMES.point);
    } else if (S.phase === 'point') {
      nextRound();
    }
  }

  function buildMeta() {
    return {
      t: 'rmeta',
      phase: S.phase,
      round: S.round,
      toWin: POINTS_TO_WIN,
      players: api.players().map(function (i) { return i + 1; }),
      scores: S.scores.slice(),
      early: S.early.map(function (i) { return i + 1; }),
      last: S.last ? { slot: S.last.slot + 1, ms: S.last.ms } : null,
      winner: S.winner + 1,
      paused: S.paused
    };
  }

  function sendMeta() {
    dirty = false;
    lastMetaAt = Date.now();
    api.broadcast(buildMeta());
  }

  return {
    id: 'ejemplo-reflejos',
    start: newMatch,
    stop: function () { /* nothing to clean up */ },
    tick: tick,
    flush: function () { if (dirty || Date.now() - lastMetaAt >= 1000) sendMeta(); },
    onMessage: function (who, msg) {
      if (who < 0) return;                 // the TV sends nothing
      if (msg.t === 'r.tap') tap(who);
      else if (msg.t === 'r.again' && S.phase === 'end') newMatch();
    },
    onPlayerJoined: function (i) { api.sendSlot(i, buildMeta()); },
    syncTv: function (ws) { api.sendWs(ws, buildMeta()); },
    _state: S
  };
}

module.exports = { create: create, POINTS_TO_WIN: POINTS_TO_WIN, TIMES: TIMES };
