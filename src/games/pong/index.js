'use strict';
/*
 * Pong as a hub game. Same physics and look as the original Pong.
 *
 * 2 players: the classic, one paddle each at its goal line (identical to 0.2).
 * 3-4 players: doubles, two teams. Each side has two paddles at different
 * depths, like the rods of a foosball table: one at the goal line and one
 * further forward. Both cover the whole height and each one belongs to one
 * player. With 3 players the player alone on a side gets a single, taller
 * paddle at the goal line. Team score, to 7.
 *
 *   paddle index: 0 left goal · 1 right goal · 2 left forward · 3 right forward
 *   teams: players [p0, p1, p2, p3] (api.players() order) -> left p0 + p2,
 *          right p1 (+ p3)
 *
 * Collisions: a paddle only stops the ball when it travels towards that
 * paddle's own goal (the ball goes through your own paddles from behind, so
 * the goal paddle can always clear it). Swept test of the ball's leading edge
 * against each face (no tunnelling at any speed), forward paddles first.
 *
 * Messages it receives (from phones):
 *   { t: 'm', y: 0..1 }        paddle position
 *   { t: 'rematch' }           rematch after the end of the match
 * Messages it sends:
 *   { t: 'pmeta', ... }        phase, score, countdown, mode, paddles, teams (TV and phones)
 *   { t: 's', ... }            60 Hz state (TV only): p = every paddle's y, by paddle index
 *   { t: 'p', i, y }           immediate paddle move (TV only, low latency), i = paddle index
 *   { t: 'ev', k: ... }        events: hit {slot, side, paddle}, wall, score {slot = side},
 *                              go, win {slot = side}, start
 *
 * Environment: PONG_DEBUG_SPEED (1), POINTS_TO_WIN (7)
 */

const DEBUG_SPEED = Math.max(0.1, parseFloat(process.env.PONG_DEBUG_SPEED) || 1);
const POINTS_TO_WIN = parseInt(process.env.POINTS_TO_WIN, 10) || 7;

const W = 1920;
const H = 1080;
const PADDLE_H = 180;
const PADDLE_W = 24;
const PADDLE_MARGIN = 70;
const DOUBLES_H = 150;          // 3-4 players: two paddles per side, a bit shorter
const SOLO_H = 230;             // 3 players: the one playing alone, at the goal line
const FORWARD_X = 540;          // forward paddles: 540 px from their own goal edge
const BALL_R = 14;
const BALL_SPEED_START = 780 * DEBUG_SPEED;
const BALL_SPEED_MAX = 1900 * DEBUG_SPEED;
const BALL_SPEEDUP = 1.06;
const MAX_BOUNCE_ANGLE = (55 * Math.PI) / 180;
const SERVE_MAX_ANGLE = (25 * Math.PI) / 180;
const COUNTDOWN_S = 3 / DEBUG_SPEED;
const SCORED_PAUSE_S = 1.3 / DEBUG_SPEED;
const MAX_JUMP = 220; // salto máximo inmediato de la pala al recibir un movimiento

const FIELD = {
  w: W, h: H, paddleH: PADDLE_H, paddleW: PADDLE_W, paddleMargin: PADDLE_MARGIN, ballR: BALL_R,
  doublesH: DOUBLES_H, soloH: SOLO_H, forwardX: FORWARD_X
};

function round1(v) { return Math.round(v * 10) / 10; }

/** The paddles for these players (slot indexes, api.players() order). */
function layoutPaddles(slots) {
  slots = slots.slice(0, 4);
  if (slots.length <= 2) {
    return [
      { slot: slots[0], side: 0, x: PADDLE_MARGIN, h: PADDLE_H, role: 'portería' },
      { slot: slots[1], side: 1, x: W - PADDLE_MARGIN, h: PADDLE_H, role: 'portería' }
    ];
  }
  const out = [
    { slot: slots[0], side: 0, x: PADDLE_MARGIN, h: DOUBLES_H, role: 'portería' },
    { slot: slots[1], side: 1, x: W - PADDLE_MARGIN, h: slots.length === 3 ? SOLO_H : DOUBLES_H, role: slots.length === 3 ? 'solo' : 'portería' },
    { slot: slots[2], side: 0, x: FORWARD_X, h: DOUBLES_H, role: 'delantera' }
  ];
  if (slots.length === 4) out.push({ slot: slots[3], side: 1, x: W - FORWARD_X, h: DOUBLES_H, role: 'delantera' });
  return out;
}

function create(api) {
  /*
   * Fases: countdown, playing, scored, paused (falta un jugador), gameover
   */
  const game = {
    phase: 'paused',
    phaseTimer: 0,
    score: [0, 0],
    winner: 0,
    lastScorer: 0,
    ball: { x: W / 2, y: H / 2, vx: 0, vy: 0, speed: BALL_SPEED_START },
    serveDir: Math.random() < 0.5 ? -1 : 1,
    resetId: 0,
    hits: 0,
    pads: [],          // layoutPaddles(): { slot, side, x, h, role }
    paddleOf: {},      // slot -> paddle index
    order: [[], []],   // paddle indexes in the order the ball meets them, moving left / right
    paddles: [H / 2, H / 2],
    targets: [0.5, 0.5]
  };
  let lastMetaStr = '';
  let lastMetaSentAt = 0;

  function ev(e) { e.t = 'ev'; api.broadcast(e); }

  function setupPaddles() {
    game.pads = layoutPaddles(api.players());
    game.paddleOf = {};
    game.paddles = [];
    game.targets = [];
    game.pads.forEach(function (p, k) {
      game.paddleOf[p.slot] = k;
      game.paddles.push(H / 2);
      game.targets.push(0.5);
    });
    // Moving left the ball meets the left paddles from right to left (forward first)
    const idx = game.pads.map(function (p, k) { return k; });
    game.order[0] = idx.filter(function (k) { return game.pads[k].side === 0; }).sort(function (a, b) { return game.pads[b].x - game.pads[a].x; });
    game.order[1] = idx.filter(function (k) { return game.pads[k].side === 1; }).sort(function (a, b) { return game.pads[a].x - game.pads[b].x; });
  }
  function doubles() { return game.pads.length > 2; }
  // Only the players with a paddle count (a phone that joins mid-match just watches)
  function playersConnected() {
    return game.pads.length > 0 && game.pads.every(function (p) { return api.isConnected(p.slot); });
  }

  function centerBall() {
    game.ball.x = W / 2;
    game.ball.y = H / 2;
    game.ball.vx = 0;
    game.ball.vy = 0;
    game.ball.speed = BALL_SPEED_START;
    game.resetId++;
  }

  function launchBall() {
    const ang = (Math.random() * 2 - 1) * SERVE_MAX_ANGLE;
    game.ball.speed = BALL_SPEED_START;
    game.ball.vx = Math.cos(ang) * game.ball.speed * game.serveDir;
    game.ball.vy = Math.sin(ang) * game.ball.speed;
  }

  function setPhase(ph, timer) {
    game.phase = ph;
    game.phaseTimer = timer || 0;
  }

  function newMatch() {
    setupPaddles();
    game.score = [0, 0];
    game.winner = 0;
    game.lastScorer = 0;
    game.hits = 0;
    game.serveDir = Math.random() < 0.5 ? -1 : 1;
    centerBall();
    if (playersConnected()) {
      setPhase('countdown', COUNTDOWN_S);
      ev({ k: 'start' });
    } else {
      setPhase('paused');
    }
    if (doubles()) api.log('[pong] Dobles: ' + teamNames(0) + ' contra ' + teamNames(1));
    broadcastMeta(true);
  }

  function teamNames(side) {
    return game.pads.filter(function (p) { return p.side === side; }).map(function (p) { return api.name(p.slot); }).join(' y ');
  }

  function targetToPaddleY(t, h) { return h / 2 + t * (H - h); }

  // Swept test: did the ball's leading edge cross this paddle's face during the step?
  function paddleCollision(k, prevX, prevY) {
    const b = game.ball;
    const pad = game.pads[k];
    const dir = pad.side === 0 ? -1 : 1;
    if (Math.sign(b.vx) !== dir) return false;
    const face = pad.x - dir * PADDLE_W / 2;
    const prevEdge = prevX + dir * BALL_R;
    const edge = b.x + dir * BALL_R;
    const crossed = dir < 0 ? (prevEdge >= face && edge <= face) : (prevEdge <= face && edge >= face);
    if (!crossed) return false;
    const t = (face - prevEdge) / ((edge - prevEdge) || 1e-9);
    const yAt = prevY + (b.y - prevY) * t;
    const py = game.paddles[k];
    const half = pad.h / 2 + BALL_R;
    if (yAt < py - half || yAt > py + half) return false;
    const rel = Math.max(-1, Math.min(1, (yAt - py) / half));
    const ang = rel * MAX_BOUNCE_ANGLE;
    b.speed = Math.min(BALL_SPEED_MAX, b.speed * BALL_SPEEDUP);
    b.vx = -dir * Math.cos(ang) * b.speed;
    b.vy = Math.sin(ang) * b.speed;
    b.x = face - dir * (BALL_R + 0.5);
    b.y = yAt;
    game.hits++;
    ev({ k: 'hit', slot: pad.slot + 1, side: pad.side + 1, paddle: k });
    return true;
  }

  function stepPhysics(dt) {
    const b = game.ball;
    const prevX = b.x;
    const prevY = b.y;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.y - BALL_R < 0) {
      b.y = BALL_R + (BALL_R - b.y);
      b.vy = Math.abs(b.vy);
      ev({ k: 'wall' });
    } else if (b.y + BALL_R > H) {
      b.y = H - BALL_R - (b.y + BALL_R - H);
      b.vy = -Math.abs(b.vy);
      ev({ k: 'wall' });
    }
    const order = b.vx < 0 ? game.order[0] : game.order[1];
    for (let n = 0; n < order.length; n++) if (paddleCollision(order[n], prevX, prevY)) break;
    if (b.x + BALL_R < 0) scorePoint(2);
    else if (b.x - BALL_R > W) scorePoint(1);
  }

  function scorePoint(side) {
    game.score[side - 1]++;
    game.lastScorer = side;
    game.serveDir = side === 1 ? 1 : -1;
    centerBall();
    ev({ k: 'score', slot: side, side: side });
    if (game.score[side - 1] >= POINTS_TO_WIN) {
      game.winner = side;
      setPhase('gameover');
      ev({ k: 'win', slot: side, side: side });
    } else {
      setPhase('scored', SCORED_PAUSE_S);
    }
  }

  function tick(dt) {
    for (let i = 0; i < game.pads.length; i++) {
      const target = targetToPaddleY(game.targets[i], game.pads[i].h);
      const maxStep = 6000 * dt;
      const d = target - game.paddles[i];
      game.paddles[i] += Math.max(-maxStep, Math.min(maxStep, d));
    }
    switch (game.phase) {
      case 'countdown':
        game.phaseTimer -= dt;
        if (game.phaseTimer <= 0) {
          if (game.ball.vx === 0 && game.ball.vy === 0) launchBall();
          setPhase('playing');
          ev({ k: 'go' });
        }
        break;
      case 'scored':
        game.phaseTimer -= dt;
        if (game.phaseTimer <= 0) {
          launchBall();
          setPhase('playing');
        }
        break;
      case 'playing':
        stepPhysics(dt);
        break;
      case 'paused':
        if (playersConnected()) setPhase('countdown', COUNTDOWN_S);
        break;
      case 'gameover':
        break;
    }
  }

  function buildMeta() {
    const m = {
      t: 'pmeta',
      phase: game.phase,
      score: game.score.slice(),
      toWin: POINTS_TO_WIN,
      winner: game.winner,
      lastScorer: game.lastScorer,
      countdown: game.phase === 'countdown' ? Math.ceil(game.phaseTimer * DEBUG_SPEED - 1e-6) : 0,
      mode: doubles() ? 'dobles' : 'clasico',
      // slot and side start at 1, like everywhere else in the messages
      paddles: game.pads.map(function (p) { return { slot: p.slot + 1, side: p.side + 1, x: p.x, h: p.h, role: p.role }; }),
      teams: [0, 1].map(function (side) {
        return game.pads.filter(function (p) { return p.side === side; }).map(function (p) { return p.slot + 1; });
      })
    };
    return m;
  }

  function broadcastMeta(force) {
    const str = JSON.stringify(buildMeta());
    const now = Date.now();
    if (!force && str === lastMetaStr && now - lastMetaSentAt < 1000) return;
    lastMetaStr = str;
    lastMetaSentAt = now;
    api.broadcast(str);
  }

  function broadcastState() {
    if (!api.tvs.size) return;
    const b = game.ball;
    api.sendTvs(JSON.stringify({
      t: 's',
      ts: Date.now(),
      ph: game.phase,
      b: [round1(b.x), round1(b.y), round1(b.vx), round1(b.vy)],
      p: game.paddles.map(round1),
      r: game.resetId,
      sp: Math.round((b.speed / BALL_SPEED_START) * 100) / 100
    }));
  }

  return {
    id: 'pong',
    field: FIELD,
    start: function () { newMatch(); },
    stop: function () { /* nada que limpiar */ },
    tick: tick,
    flush: function () { broadcastState(); broadcastMeta(false); },
    onMessage: function (who, msg) {
      if (who < 0) return; // la tele no manda nada en el Pong
      const k = game.paddleOf[who];
      if (msg.t === 'm') {
        if (k === undefined) return; // sin pala (ha entrado a mitad de partida): solo mira
        const y = Number(msg.y);
        if (!isFinite(y)) return;
        game.targets[k] = Math.max(0, Math.min(1, y));
        // Baja latencia: la pala se mueve YA (hasta MAX_JUMP; el resto lo hace
        // el tick a 6000 u/s) y la tele lo recibe sin esperar al siguiente tick.
        const target = targetToPaddleY(game.targets[k], game.pads[k].h);
        const d = target - game.paddles[k];
        game.paddles[k] += Math.max(-MAX_JUMP, Math.min(MAX_JUMP, d));
        if (api.tvs.size) api.sendTvs('{"t":"p","i":' + k + ',"y":' + round1(game.paddles[k]) + '}');
      } else if (msg.t === 'rematch') {
        if (game.phase === 'gameover') {
          api.log('[pong] Revancha pedida por ' + api.name(who));
          newMatch();
        }
      }
    },
    onPlayerDisconnected: function (i) {
      if (game.paddleOf[i] === undefined) return;
      if (game.phase === 'countdown' || game.phase === 'playing' || game.phase === 'scored') {
        setPhase('paused');
        broadcastMeta(true);
      }
    },
    onPlayerJoined: function (i) { api.sendSlot(i, buildMeta()); },
    syncTv: function (ws) { api.sendWs(ws, buildMeta()); },
    // Solo para pruebas / depuración
    _state: game
  };
}

module.exports = {
  create: create,
  FIELD: FIELD,
  layoutPaddles: layoutPaddles,
  // Sent to the TV page with the game list (public/tv.html -> games[].tv)
  tvInfo: { field: FIELD }
};
