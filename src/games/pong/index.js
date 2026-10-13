'use strict';
/*
 * Pong as a hub game. Same physics and look as the original Pong.
 *
 * Messages it receives (from phones):
 *   { t: 'm', y: 0..1 }        paddle position
 *   { t: 'rematch' }           rematch after the end of the match
 * Messages it sends:
 *   { t: 'pmeta', ... }        phase, score, countdown (TV and phones)
 *   { t: 's', ... }            60 Hz state (TV only)
 *   { t: 'p', i, y }           immediate paddle move (TV only, low latency)
 *   { t: 'ev', k: ... }        events (hit, wall, score, go, win, start)
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
const BALL_R = 14;
const BALL_SPEED_START = 780 * DEBUG_SPEED;
const BALL_SPEED_MAX = 1900 * DEBUG_SPEED;
const BALL_SPEEDUP = 1.06;
const MAX_BOUNCE_ANGLE = (55 * Math.PI) / 180;
const SERVE_MAX_ANGLE = (25 * Math.PI) / 180;
const COUNTDOWN_S = 3 / DEBUG_SPEED;
const SCORED_PAUSE_S = 1.3 / DEBUG_SPEED;
const MAX_JUMP = 220; // salto máximo inmediato de la pala al recibir un movimiento

const FIELD = { w: W, h: H, paddleH: PADDLE_H, paddleW: PADDLE_W, paddleMargin: PADDLE_MARGIN, ballR: BALL_R };

function round1(v) { return Math.round(v * 10) / 10; }

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
    paddles: [H / 2, H / 2],
    targets: [0.5, 0.5]
  };
  let lastMetaStr = '';
  let lastMetaSentAt = 0;

  function ev(e) { e.t = 'ev'; api.broadcast(e); }

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
    game.score = [0, 0];
    game.winner = 0;
    game.lastScorer = 0;
    game.hits = 0;
    game.serveDir = Math.random() < 0.5 ? -1 : 1;
    centerBall();
    if (api.bothConnected()) {
      setPhase('countdown', COUNTDOWN_S);
      ev({ k: 'start' });
    } else {
      setPhase('paused');
    }
    broadcastMeta(true);
  }

  function targetToPaddleY(t) { return PADDLE_H / 2 + t * (H - PADDLE_H); }

  function paddleCollision(slot, prevX, prevY) {
    const b = game.ball;
    const dir = slot === 0 ? -1 : 1;
    if (Math.sign(b.vx) !== dir) return false;
    const px = slot === 0 ? PADDLE_MARGIN : W - PADDLE_MARGIN;
    const face = px - dir * PADDLE_W / 2;
    const prevEdge = prevX + dir * BALL_R;
    const edge = b.x + dir * BALL_R;
    const crossed = dir < 0 ? (prevEdge >= face && edge <= face) : (prevEdge <= face && edge >= face);
    if (!crossed) return false;
    const t = (face - prevEdge) / ((edge - prevEdge) || 1e-9);
    const yAt = prevY + (b.y - prevY) * t;
    const py = game.paddles[slot];
    const half = PADDLE_H / 2 + BALL_R;
    if (yAt < py - half || yAt > py + half) return false;
    const rel = Math.max(-1, Math.min(1, (yAt - py) / half));
    const ang = rel * MAX_BOUNCE_ANGLE;
    b.speed = Math.min(BALL_SPEED_MAX, b.speed * BALL_SPEEDUP);
    b.vx = -dir * Math.cos(ang) * b.speed;
    b.vy = Math.sin(ang) * b.speed;
    b.x = face - dir * (BALL_R + 0.5);
    b.y = yAt;
    game.hits++;
    ev({ k: 'hit', slot: slot + 1 });
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
    if (!paddleCollision(0, prevX, prevY)) paddleCollision(1, prevX, prevY);
    if (b.x + BALL_R < 0) scorePoint(2);
    else if (b.x - BALL_R > W) scorePoint(1);
  }

  function scorePoint(slot) {
    game.score[slot - 1]++;
    game.lastScorer = slot;
    game.serveDir = slot === 1 ? 1 : -1;
    centerBall();
    ev({ k: 'score', slot: slot });
    if (game.score[slot - 1] >= POINTS_TO_WIN) {
      game.winner = slot;
      setPhase('gameover');
      ev({ k: 'win', slot: slot });
    } else {
      setPhase('scored', SCORED_PAUSE_S);
    }
  }

  function tick(dt) {
    for (let i = 0; i < 2; i++) {
      const target = targetToPaddleY(game.targets[i]);
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
        if (api.bothConnected()) setPhase('countdown', COUNTDOWN_S);
        break;
      case 'gameover':
        break;
    }
  }

  function buildMeta() {
    return {
      t: 'pmeta',
      phase: game.phase,
      score: game.score.slice(),
      toWin: POINTS_TO_WIN,
      winner: game.winner,
      lastScorer: game.lastScorer,
      countdown: game.phase === 'countdown' ? Math.ceil(game.phaseTimer * DEBUG_SPEED - 1e-6) : 0
    };
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
      p: [round1(game.paddles[0]), round1(game.paddles[1])],
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
      if (msg.t === 'm') {
        const y = Number(msg.y);
        if (!isFinite(y)) return;
        game.targets[who] = Math.max(0, Math.min(1, y));
        // Baja latencia: la pala se mueve YA (hasta MAX_JUMP; el resto lo hace
        // el tick a 6000 u/s) y la tele lo recibe sin esperar al siguiente tick.
        const target = targetToPaddleY(game.targets[who]);
        const d = target - game.paddles[who];
        game.paddles[who] += Math.max(-MAX_JUMP, Math.min(MAX_JUMP, d));
        if (api.tvs.size) api.sendTvs('{"t":"p","i":' + who + ',"y":' + round1(game.paddles[who]) + '}');
      } else if (msg.t === 'rematch') {
        if (game.phase === 'gameover') {
          api.log('[pong] Revancha pedida por ' + api.name(who));
          newMatch();
        }
      }
    },
    onPlayerDisconnected: function () {
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
  // Sent to the TV page with the game list (public/tv.html -> games[].tv)
  tvInfo: { field: FIELD }
};
