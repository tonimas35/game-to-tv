'use strict';
/*
 * «Sumo»: two heavy balls on a round ring (dohyo) that shrinks. Push the
 * other one out. Best of 5 (first to 3 rounds). Exactly 2 players.
 *
 * Server-authoritative: the phones only send their joystick and the dash
 * button; the physics (physics.js) runs here at the hub's fixed 60 Hz and the
 * TV gets a compact state at 30 Hz, which it interpolates.
 *
 * Phases: countdown (3-2-1) -> playing -> roundover (who won the round, the
 * loser keeps sliding off) -> countdown ... -> end (winner, «Otra» / «Menú»).
 * paused: a wrestler is reconnecting (everything frozen; then a countdown).
 *
 * Messages it receives:
 *   { t: 's.j', x, y }     joystick, -1..1 each (y down), from the phones
 *   { t: 's.d' }           «¡Embestida!» (dash)
 *   { t: 's.again' }       another match (only at the end; also from the TV)
 * Messages it sends:
 *   { t: 'smeta', ... }    the public state (see buildMeta), TV and phones
 *   { t: 's', ts, n, ph, R, w: [x, y, vx, vy, face, flags, ...] }
 *                          30 Hz state, TV only (flags: 1 dashing, 2 out)
 *   { t: 's.cd', ms }      to one phone, after «s.d»: cooldown left in ms, ok = it dashed
 *   { t: 'ev', k: 'hit', p, x, y, big, ts }   a collision (p = strength 0..1)
 *   { t: 'ev', k: 'dash', w }  · { k: 'out', w: [...] } · { k: 'go' } · { k: 'win', w }
 *                          w = wrestler number (1 left, 2 right)
 *
 * Environment (tests): SUMO_DEBUG_SPEED (1) speeds up countdowns and pauses.
 */
const Ph = require('./physics');
const P = Ph.P;

const SPEED = Math.max(0.1, parseFloat(process.env.SUMO_DEBUG_SPEED) || 1);
const WINS = 3;                       // first to 3 rounds (best of 5)
const COUNTDOWN_S = 3;
const ROUNDOVER_S = 2.6;
const HIT_MIN_SPEED = 200;            // px/s: softer touches (shoving) are not events
const HIT_GAP_S = 0.12;               // at most one 'hit' event per 120 ms
const BIG_HIT_SPEED = 700;
const ROUNDOVER_BRAKE = 6;            // 1/s: the winner stops quickly after a round

function r1(v) { return Math.round(v * 10) / 10; }

function create(api) {
  const S = {
    match: 0,
    phase: 'paused',
    timer: 0,          // s left in countdown / roundover
    round: 0,          // round number (draws count too)
    roundId: 0,        // changes at every new round (the TV snaps instead of sliding)
    roundT: 0,         // s of play in this round (the ring shrinks with it)
    order: [],         // the two slots playing: [left, right]
    score: [0, 0],
    draws: 0,
    w: Ph.startPositions(),
    result: null,      // last round: { w: 1 | 2, or 0 = draw }
    winner: 0,         // 1 | 2 at the end
    pausedFrom: '',
    pauseTimer: 0,
    resumed: false,    // the countdown comes after a pause
    lastHitAt: -1
  };
  let dirty = true;
  let lastMetaAt = 0;
  let ticks = 0;
  let lastStateTick = -10;
  let clock = 0;       // s since the game started (for event throttling)

  function ev(e) { e.t = 'ev'; api.broadcast(e); }
  function idxOf(slot) { return S.order.indexOf(slot); }
  function wrestlersConnected() {
    return S.order.length === 2 && S.order.every(function (s) { return api.isConnected(s); });
  }
  function setPhase(ph, t) {
    S.phase = ph;
    S.timer = t || 0;
    dirty = true;
  }

  function newRound() {
    S.round++;
    S.roundId++;
    S.roundT = 0;
    S.result = null;
    S.resumed = false;
    // Inputs survive (a player may already be leaning), the rest is reset
    const old = S.w;
    S.w = Ph.startPositions();
    for (let i = 0; i < 2; i++) { S.w[i].ix = old[i].ix; S.w[i].iy = old[i].iy; }
    if (wrestlersConnected()) setPhase('countdown', COUNTDOWN_S);
    else { S.pausedFrom = 'countdown'; setPhase('paused'); }
  }

  function newMatch() {
    S.match++;
    S.order = api.players().slice().sort(function (a, b) { return a - b; }).slice(0, 2);
    S.score = [0, 0];
    S.draws = 0;
    S.round = 0;
    S.winner = 0;
    S.w = Ph.startPositions();
    newRound();
    api.log('[sumo] Partida ' + S.match + ': ' + S.order.map(api.name).join(' contra '));
  }

  function pause() {
    if (S.phase !== 'countdown' && S.phase !== 'playing' && S.phase !== 'roundover') return;
    S.pausedFrom = S.phase;
    S.pauseTimer = S.timer;
    setPhase('paused');
    api.log('[sumo] Pausa: falta un jugador');
  }
  function resume() {
    if (S.pausedFrom === 'roundover') setPhase('roundover', S.pauseTimer);
    else { setPhase('countdown', COUNTDOWN_S); S.resumed = S.pausedFrom === 'playing'; }
    api.log('[sumo] Se reanuda');
  }

  function endRound(outs) {
    const out0 = outs[0], out1 = outs[1];
    if (out0 && out1) {
      S.result = { w: 0 };
      S.draws++;
      api.log('[sumo] Ronda ' + S.round + ': empate (los dos fuera a la vez)');
    } else {
      const win = out1 ? 0 : 1;
      S.score[win]++;
      S.result = { w: win + 1 };
      api.log('[sumo] Ronda ' + S.round + ' para ' + api.name(S.order[win]) + ' (' + S.score.join('-') + ')');
    }
    ev({ k: 'out', w: [out0 ? 1 : 0, out1 ? 2 : 0].filter(Boolean) });
    for (let i = 0; i < 2; i++) { S.w[i].ix = 0; S.w[i].iy = 0; }
    setPhase('roundover', ROUNDOVER_S);
  }

  function afterRound() {
    const w = S.score[0] >= WINS ? 1 : (S.score[1] >= WINS ? 2 : 0);
    if (w) {
      S.winner = w;
      setPhase('end');
      api.log('[sumo] ¡Gana ' + api.name(S.order[w - 1]) + '! ' + S.score.join('-'));
      ev({ k: 'win', w: w });
    } else {
      newRound();
    }
  }

  function hitEvent(h) {
    if (!h || h.speed < HIT_MIN_SPEED) return;
    if (S.lastHitAt >= 0 && clock - S.lastHitAt < HIT_GAP_S) return;
    S.lastHitAt = clock;
    const dashing = S.w[0].dash > 0 || S.w[1].dash > 0;
    ev({ k: 'hit', p: Math.round(Math.min(1, h.speed / 1400) * 100) / 100, x: Math.round(h.x), y: Math.round(h.y), big: h.speed >= BIG_HIT_SPEED || dashing, ts: Date.now() });
  }

  function tick(dt) {
    ticks++;
    clock += dt;
    const live = S.phase === 'countdown' || S.phase === 'playing' || S.phase === 'roundover';
    if (live && !wrestlersConnected()) { pause(); return; }
    switch (S.phase) {
      case 'paused':
        if (wrestlersConnected()) resume();
        break;
      case 'countdown': {
        Ph.stepWorld(S.w, dt, false);      // only where they look
        const before = Math.ceil(S.timer - 1e-6);
        S.timer -= dt * SPEED;
        if (Math.ceil(S.timer - 1e-6) !== before) dirty = true;
        if (S.timer <= 0) {
          setPhase('playing');
          S.resumed = false;
          ev({ k: 'go' });
        }
        break;
      }
      case 'playing': {
        S.roundT += dt;
        hitEvent(Ph.stepWorld(S.w, dt, true));
        const R = Ph.ringRadius(S.roundT);
        const outs = [Ph.isOut(S.w[0], R), Ph.isOut(S.w[1], R)];
        if (outs[0] || outs[1]) {
          S.w[0].out = outs[0];
          S.w[1].out = outs[1];
          endRound(outs);
        }
        break;
      }
      case 'roundover': {
        // The loser keeps sliding off; the winner digs in its heels
        const brake = Math.exp(-ROUNDOVER_BRAKE * dt);
        S.w.forEach(function (w) { if (!w.out) { w.vx *= brake; w.vy *= brake; } });
        Ph.stepWorld(S.w, dt, true);
        S.timer -= dt * SPEED;
        if (S.timer <= 0) afterRound();
        break;
      }
    }
  }

  function buildMeta() {
    return {
      t: 'smeta',
      match: S.match,
      phase: S.phase,
      round: S.round,
      slots: S.order.map(function (s) { return s + 1; }),
      score: S.score.slice(),
      draws: S.draws,
      toWin: WINS,
      countdown: S.phase === 'countdown' ? Math.max(1, Math.ceil(S.timer - 1e-6)) : 0,
      resumed: S.resumed,
      result: S.result,
      winner: S.winner,
      waiting: S.order.filter(function (s) { return !api.isConnected(s); }).map(api.name),
      cd: S.w.map(function (w) { return Math.round(w.cd * 1000); }),
      cdTotal: P.DASH_COOLDOWN * 1000,
      ring: { cx: P.CX, cy: P.CY, r0: P.R0, ball: P.BALL_R, shrinkAt: P.SHRINK_START },
      speed: SPEED
    };
  }
  function sendMeta() {
    dirty = false;
    lastMetaAt = Date.now();
    api.broadcast(JSON.stringify(buildMeta()));
  }
  function sendState() {
    lastStateTick = ticks;
    const w = [];
    S.w.forEach(function (x) {
      w.push(r1(x.x), r1(x.y), Math.round(x.vx), Math.round(x.vy), Math.round(x.face * 100) / 100, (x.dash > 0 ? 1 : 0) | (x.out ? 2 : 0));
    });
    const R = S.phase === 'playing' || S.phase === 'roundover' || (S.phase === 'paused' && S.pausedFrom !== 'countdown') ? Ph.ringRadius(S.roundT) : P.R0;
    api.sendTvs(JSON.stringify({ t: 's', ts: Date.now(), n: S.roundId, ph: S.phase, R: r1(R), w: w }));
  }

  function onMessage(who, msg) {
    if (msg.t === 's.again') {
      if (S.phase === 'end') { api.log('[sumo] Otra partida (la pide ' + (who >= 0 ? api.name(who) : 'la tele') + ')'); newMatch(); }
      return;
    }
    if (who < 0) return;                 // the TV only asks for another match
    const i = idxOf(who);
    if (i < 0) return;                   // watching: no wrestler
    const w = S.w[i];
    if (msg.t === 's.j') {
      if (S.phase === 'roundover' || S.phase === 'end' || w.out) { w.ix = 0; w.iy = 0; return; }
      Ph.setInput(w, msg.x, msg.y);
    } else if (msg.t === 's.d') {
      const ok = S.phase === 'playing' && Ph.tryDash(w);
      api.sendSlot(who, { t: 's.cd', ms: Math.round(w.cd * 1000), ok: ok });
      if (ok) { ev({ k: 'dash', w: i + 1 }); dirty = true; }
    }
  }

  return {
    id: 'sumo',
    start: newMatch,
    stop: function () { /* nothing to clean up */ },
    tick: tick,
    flush: function () {
      if (api.tvs && api.tvs.size && ticks - lastStateTick >= 2) sendState();
      if (dirty || Date.now() - lastMetaAt >= 1000) sendMeta();
    },
    onMessage: onMessage,
    onPlayerDisconnected: function (i) {
      const k = idxOf(i);
      if (k < 0) return;
      S.w[k].ix = 0;
      S.w[k].iy = 0;
      pause();
      dirty = true;
    },
    onPlayerJoined: function (i) { api.sendSlot(i, buildMeta()); dirty = true; },
    // Gone for good. Only called when 2 people are still in the room: if a
    // wrestler left, whoever was watching takes their place in a new match.
    onPlayerLeft: function (i) {
      if (idxOf(i) < 0) { dirty = true; return true; }
      api.log('[sumo] ' + api.name(i) + ' se ha ido: nueva partida con quien estaba mirando');
      newMatch();
      return true;
    },
    syncTv: function (ws) { api.sendWs(ws, buildMeta()); },
    // For the tests
    _state: S,
    _meta: buildMeta
  };
}

module.exports = { create: create, WINS: WINS, COUNTDOWN_S: COUNTDOWN_S, ROUNDOVER_S: ROUNDOVER_S, physics: Ph };
