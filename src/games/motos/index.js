'use strict';
/*
 * «Motos de neón»: two neon bikes on a 64 x 36 grid, each leaving a solid
 * trail. Crash into a wall, into any trail (yours too) or into the other bike
 * and you lose the round; head-on, or both crashing in the same step, is a
 * draw. First to 5 rounds. Exactly 2 players. Written from scratch for
 * game-to-tv. The grid rules live in logic.js.
 *
 * Server-authoritative: the hub ticks at 60 Hz and the bikes advance one
 * cell per step, 12 cells per second at first and up to 16 in a long round.
 * The phones only send turns.
 *
 * Messages it receives:
 *   { t: 'm.turn', dir }       phone: 'up' | 'right' | 'down' | 'left' (queued, up to 2)
 *   { t: 'm.again' }           phone or TV: new match after the end («Otra»)
 *   { t: 'm.sync' }            TV: send me the whole state again (msnap)
 * Messages it sends:
 *   { t: 'mmeta', ... }        public state (TV and phones; on change and every second)
 *   { t: 'mt', r, k, s, h }    TV only, compact moves: round r, steps k, k+1… at
 *                              s cells/s; h = the new head cell of each bike for
 *                              each step, flat ([b1, b2, b1, b2…], -1 = did not move)
 *   { t: 'msnap', r, k, w, h, tr, al, dr }   TV only, full state: at the start of
 *                              each round, to a TV that (re)connects and on
 *                              m.sync. tr = each trail as its corner cells plus
 *                              the head, al = alive (1/0), dr = directions
 *                              (0 up, 1 right, 2 down, 3 left); k = last step
 *   { t: 'ev', k: 'start' | 'go' | 'crash' | 'round' | 'win', ... }
 *                              crash: { side, slot, cell, cause: muro | propia | rival | frontal }
 *                              round: { winner (side, 0 = draw), slot }, win: { side, slot }
 * Sides are 1 and 2 (players[0] and players[1]); slots start at 1 in messages.
 * A cell is y * w + x.
 *
 * Environment (tests): MOTOS_DEBUG_SPEED (1) speeds up everything.
 */
const L = require('./logic');

const SPEED = Math.max(0.1, parseFloat(process.env.MOTOS_DEBUG_SPEED) || 1);
const TO_WIN = 5;
const COUNTDOWN_S = 3;
const ROUND_END_S = 2.6;
const BASE_CPS = 12;          // cells per second at the start of a round
const MAX_CPS = 16;           // ... and at most
const RAMP_FROM_S = 10;       // the speed starts rising after 10 s of play
const RAMP_TO_S = 40;         // ... and reaches MAX_CPS at 40 s

/** Cells per second after `t` seconds of play in a round */
function cellsPerSecond(t) {
  if (t <= RAMP_FROM_S) return BASE_CPS;
  return Math.min(MAX_CPS, BASE_CPS + (MAX_CPS - BASE_CPS) * (t - RAMP_FROM_S) / (RAMP_TO_S - RAMP_FROM_S));
}

function create(api) {
  const G = {
    phase: 'paused',      // countdown | playing | roundEnd | paused | gameover
    resume: 'countdown',  // after a pause: 'countdown' (same round) or 'next' (it had ended)
    timer: 0,
    round: 0,
    match: 0,
    score: [0, 0],
    winner: 0,            // side that won the match
    last: null,           // { winner: side | 0, crashes: [{ side, cause }] } of the last round
    slots: [],            // the two players (slot indexes)
    rd: null,             // logic.js round
    k: 0,                 // steps in this round
    acc: 0,               // fraction of a step
    playT: 0,             // seconds of play in this round
    cps: BASE_CPS
  };
  let pending = [];       // heads of the steps not sent yet (flat)
  let pendingK = 0;       // step number of the first one
  let lastMetaStr = '';
  let lastMetaAt = 0;

  function ev(e) { e.t = 'ev'; sendPending(); api.broadcast(e); }
  function sideOf(slot) { return G.slots.indexOf(slot) + 1; }      // 0 = not playing
  function slotOf(side) { return G.slots[side - 1]; }
  function playersConnected() {
    return G.slots.length === 2 && G.slots.every(function (s) { return api.isConnected(s); });
  }

  // ---------------------------------------------------------------- rounds
  function newMatch() {
    G.slots = api.players().slice(0, 2);
    G.match++;
    G.score = [0, 0];
    G.winner = 0;
    G.round = 0;
    api.log('[motos] Partida ' + G.match + ': ' + G.slots.map(api.name).join(' contra '));
    ev({ k: 'start' });
    startRound();
  }

  function startRound() {
    G.round++;
    G.rd = L.newRound((G.round - 1) % 2);
    G.k = 0;
    G.acc = 0;
    G.playT = 0;
    G.cps = BASE_CPS;
    G.last = null;
    pending = [];
    if (playersConnected()) setPhase('countdown', COUNTDOWN_S);
    else { setPhase('paused'); G.resume = 'countdown'; }
    if (api.tvs && api.tvs.size) api.sendTvs(JSON.stringify(buildSnap()));
    broadcastMeta(true);
  }

  function setPhase(ph, timer) {
    G.phase = ph;
    G.timer = timer || 0;
  }

  function doStep() {
    const r = L.step(G.rd);
    G.k++;
    if (!pending.length) pendingK = G.k;
    pending.push(r.heads[0], r.heads[1]);
    if (!r.crashed.length) return;
    r.crashed.forEach(function (c) {
      ev({ k: 'crash', side: c.side, slot: slotOf(c.side) + 1, cell: c.cell, cause: c.cause });
    });
    const w = L.result(G.rd);
    if (w !== null) endRound(w);
  }

  function endRound(w) {
    if (w) G.score[w - 1]++;
    G.last = {
      winner: w,
      crashes: G.rd.bikes.filter(function (b) { return !b.alive; }).map(function (b) { return { side: b.side, cause: b.cause }; })
    };
    setPhase('roundEnd', ROUND_END_S);
    api.log('[motos] Ronda ' + G.round + ': ' + (w ? 'para ' + api.name(slotOf(w)) : 'empate') + ' (' + G.score.join('-') + ')');
    ev({ k: 'round', winner: w, slot: w ? slotOf(w) + 1 : 0 });
    broadcastMeta(true);
  }

  function afterRound() {
    const best = G.score[0] >= TO_WIN ? 1 : (G.score[1] >= TO_WIN ? 2 : 0);
    if (best) {
      G.winner = best;
      setPhase('gameover');
      api.log('[motos] Gana ' + api.name(slotOf(best)) + ' ' + G.score.join('-'));
      ev({ k: 'win', side: best, slot: slotOf(best) + 1 });
      broadcastMeta(true);
    } else {
      startRound();
    }
  }

  function pause() {
    if (G.phase === 'countdown' || G.phase === 'playing') G.resume = 'countdown';
    else if (G.phase === 'roundEnd') G.resume = 'next';
    else return;
    L.clearQueues(G.rd);
    setPhase('paused');
    api.log('[motos] Pausa: falta un jugador');
    broadcastMeta(true);
  }

  function tick(dt) {
    const d = dt * SPEED;
    switch (G.phase) {
      case 'countdown':
        G.timer -= d;
        if (G.timer <= 0) {
          setPhase('playing');
          G.acc = 0;
          ev({ k: 'go' });
        }
        break;
      case 'playing':
        G.playT += d;
        G.cps = cellsPerSecond(G.playT);
        G.acc += d * G.cps;
        while (G.acc >= 1 && G.phase === 'playing') {
          G.acc -= 1;
          doStep();
        }
        break;
      case 'roundEnd':
        G.timer -= d;
        if (G.timer <= 0) afterRound();
        break;
      case 'paused':
        if (playersConnected()) {
          api.log('[motos] Se reanuda');
          if (G.resume === 'next') afterRound();
          else { setPhase('countdown', COUNTDOWN_S); broadcastMeta(true); }
        }
        break;
      case 'gameover':
        break;
    }
  }

  // ---------------------------------------------------------------- messages
  function buildMeta() {
    return {
      t: 'mmeta',
      match: G.match,
      phase: G.phase,
      round: G.round,
      score: G.score.slice(),
      toWin: TO_WIN,
      players: G.slots.map(function (s) { return s + 1; }),
      countdown: G.phase === 'countdown' ? Math.max(1, Math.ceil(G.timer - 1e-6)) : 0,
      winner: G.winner,
      last: G.last,
      waiting: G.slots.filter(function (s) { return !api.isConnected(s); }).map(api.name),
      w: L.W,
      h: L.H,
      speed: SPEED
    };
  }

  function buildSnap() {
    const s = L.snapshot(G.rd);
    return { t: 'msnap', r: G.round, k: G.k, w: G.rd.w, h: G.rd.h, tr: s.tr, al: s.al, dr: s.dr };
  }

  function broadcastMeta(force) {
    sendPending();
    const str = JSON.stringify(buildMeta());
    const now = Date.now();
    if (!force && str === lastMetaStr && now - lastMetaAt < 1000) return;
    lastMetaStr = str;
    lastMetaAt = now;
    api.broadcast(str);
  }

  // The moves go out in order before any event or meta that follows them
  function sendPending() {
    if (!pending.length) return;
    const msg = '{"t":"mt","r":' + G.round + ',"k":' + pendingK + ',"s":' + Math.round(G.cps * SPEED * 10) / 10 + ',"h":[' + pending.join(',') + ']}';
    pending = [];
    if (api.tvs && api.tvs.size) api.sendTvs(msg);
  }

  return {
    id: 'motos',
    start: newMatch,
    stop: function () { /* no timers */ },
    tick: tick,
    flush: function () { sendPending(); broadcastMeta(false); },
    onMessage: function (who, msg, ws) {
      if (who < 0) {
        if (msg.t === 'm.sync') { sendPending(); if (G.rd && ws) api.sendWs(ws, JSON.stringify(buildSnap())); }
        else if (msg.t === 'm.again' && G.phase === 'gameover') newMatch();
        return;
      }
      const side = sideOf(who);
      if (msg.t === 'm.turn') {
        if (!side || (G.phase !== 'playing' && G.phase !== 'countdown')) return;
        L.queueTurn(G.rd.bikes[side - 1], String(msg.dir));
      } else if (msg.t === 'm.again') {
        if (G.phase === 'gameover') {
          api.log('[motos] Otra partida, la pide ' + api.name(who));
          newMatch();
        }
      }
    },
    onPlayerDisconnected: function (i) { if (sideOf(i)) pause(); },
    onPlayerJoined: function (i) { api.sendSlot(i, buildMeta()); },
    // Someone gone for good: a spectator takes the place (a new match), or back to the menu
    onPlayerLeft: function (i) {
      if (!sideOf(i)) return true;
      if (api.players().length < 2) return false;
      newMatch();
      return true;
    },
    syncTv: function (ws) {
      sendPending();
      api.sendWs(ws, JSON.stringify(buildMeta()));
      if (G.rd) api.sendWs(ws, JSON.stringify(buildSnap()));
    },
    // For the tests
    _state: G
  };
}

module.exports = {
  create: create,
  cellsPerSecond: cellsPerSecond,
  TO_WIN: TO_WIN,
  COUNTDOWN_S: COUNTDOWN_S,
  ROUND_END_S: ROUND_END_S,
  BASE_CPS: BASE_CPS,
  MAX_CPS: MAX_CPS
};
