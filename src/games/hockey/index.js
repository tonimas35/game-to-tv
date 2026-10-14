'use strict';
/*
 * «Hockey de mesa»: air hockey for exactly 2 players, server-authoritative.
 *
 * The table is W x H table units (the TV draws it 1:1 on its 1920x1080
 * stage). The left player (first of api.players()) defends the left goal,
 * the right player the right one. Each one moves a round mallet that cannot
 * leave their own half (it may touch the centre line, never cross it).
 *
 * Phone input is ABSOLUTE: { t: 'h.m', x, y } with x, y in 0..1 over the
 * player's own half, as the phone draws it (landscape, same orientation as
 * the TV: x = 0 is the left edge of that half). The server moves the mallet
 * towards that target at MALLET_MAX at most (no teleport hits) and takes the
 * mallet velocity from that movement, so a fast swing makes a hard shot.
 *
 * Physics (60 Hz, sub-steps so that nothing moves more than PUCK_R / 2 per
 * sub-step: the puck never tunnels through a mallet, a wall or a post):
 *   - low friction, walls and posts with a little energy loss (WALL_E)
 *   - puck vs mallet: the mallet has infinite mass, the bounce uses the
 *     relative velocity (MALLET_E), the puck speed is capped at PUCK_MAX
 *   - a puck squeezed against a wall pushes the mallet back
 *   - goal when the puck is fully past the goal line inside the mouth
 *   - after a goal the puck waits at the centre (GOAL_PAUSE_S) and is served
 *     slowly towards the player who conceded
 *
 * Phases: countdown -> playing -> goal -> playing ... -> end (first to 7).
 * paused while one of the two players is reconnecting (then countdown).
 *
 * Messages it receives:
 *   { t: 'h.m', x, y }   mallet target (phones of the two players)
 *   { t: 'h.again' }     new match after the end (phones or the TV)
 * Messages it sends:
 *   { t: 'hmeta', ... }  phase, score, countdown, players, field (TV and phones)
 *   { t: 'hs', ... }     30 Hz state (TV only): ts, ph, p [x, y, vx, vy],
 *                        m [x0, y0, x1, y1], r (puck reset id)
 *   { t: 'h.you', x, y } your mallet target in 0..1 (to a phone that (re)joins)
 *   { t: 'ev', k }       start, go, hit {side, slot, power}, wall, post,
 *                        goal {side, slot, into}, win {side, slot}
 *                        (side and slot start at 1)
 *
 * Environment (tests): HOCKEY_DEBUG_SPEED (1) speeds up the countdown and the
 * pause after a goal; HOCKEY_POINTS (7) points to win.
 */

const SPEED = Math.max(0.1, parseFloat(process.env.HOCKEY_DEBUG_SPEED) || 1);
const POINTS_TO_WIN = parseInt(process.env.HOCKEY_POINTS, 10) || 7;

const W = 1720;
const H = 860;
const PUCK_R = 28;
const MALLET_R = 46;
const GOAL_W = 260;
const GOAL_Y0 = (H - GOAL_W) / 2;
const GOAL_Y1 = (H + GOAL_W) / 2;
const PUCK_MAX = 2400;          // units/s
const MALLET_MAX = 3000;        // units/s: high but capped (no teleport hits)
const WALL_E = 0.88;            // walls and posts: a little energy loss
const MALLET_E = 0.85;          // puck vs mallet
const FRICTION = 0.22;          // 1/s (exponential): low friction
const STOP_SPEED = 4;
const SERVE_SPEED = 360;
const SERVE_ANGLE = (20 * Math.PI) / 180;
const SUBSTEP_MOVE = PUCK_R * 0.5;
const MAX_SUBSTEPS = 48;
const COUNTDOWN_S = 3 / SPEED;
const GOAL_PAUSE_S = 1.6 / SPEED;
const STATE_EVERY = 2;          // ticks: 60 Hz / 2 = 30 Hz
const HIT_EVERY = 6;            // ticks between two hit events of one mallet
const WALL_EVERY = 4;
const MIN_HIT_POWER = 60;

const FIELD = {
  w: W, h: H, puckR: PUCK_R, malletR: MALLET_R, goalW: GOAL_W, goalY0: GOAL_Y0, goalY1: GOAL_Y1,
  puckMax: PUCK_MAX, malletMax: MALLET_MAX
};

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function round1(v) { return Math.round(v * 10) / 10; }

// ---------------------------------------------------------------- geometry
function halfBounds(side) {
  return side === 0
    ? { x0: MALLET_R, x1: W / 2 - MALLET_R, y0: MALLET_R, y1: H - MALLET_R }
    : { x0: W / 2 + MALLET_R, x1: W - MALLET_R, y0: MALLET_R, y1: H - MALLET_R };
}
function clampToHalf(side, x, y) {
  const b = halfBounds(side);
  return { x: clamp(x, b.x0, b.x1), y: clamp(y, b.y0, b.y1) };
}
/** Phone input (0..1 over the player's half, TV orientation) -> table point */
function targetFromInput(side, u, v) {
  u = clamp(u, 0, 1);
  v = clamp(v, 0, 1);
  return clampToHalf(side, (side === 0 ? 0 : W / 2) + u * (W / 2), v * H);
}
/** Table point -> phone input (inverse of targetFromInput) */
function inputFromPos(side, x, y) {
  return { x: (x - (side === 0 ? 0 : W / 2)) / (W / 2), y: y / H };
}

function newMallet(side) {
  const x = side === 0 ? W * 0.12 : W * 0.88;
  return { side: side, x: x, y: H / 2, tx: x, ty: H / 2, vx: 0, vy: 0 };
}
function newWorld() {
  return { puck: { x: W / 2, y: H / 2, vx: 0, vy: 0 }, mallets: [newMallet(0), newMallet(1)] };
}

function capSpeed(p) {
  const s = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
  if (s > PUCK_MAX) { p.vx *= PUCK_MAX / s; p.vy *= PUCK_MAX / s; }
}

// Puck vs mallet (the mallet does not move: infinite mass). Returns the
// impact speed (0 if they do not touch or are already separating).
function hitMallet(p, m) {
  const R = PUCK_R + MALLET_R;
  let dx = p.x - m.x;
  let dy = p.y - m.y;
  const d2 = dx * dx + dy * dy;
  if (d2 >= R * R) return 0;
  const d = Math.sqrt(d2);
  let nx, ny;
  if (d < 1e-6) { nx = m.side === 0 ? 1 : -1; ny = 0; } else { nx = dx / d; ny = dy / d; }
  p.x = m.x + nx * R;
  p.y = m.y + ny * R;
  const vn = (p.vx - m.vx) * nx + (p.vy - m.vy) * ny;
  if (vn >= 0) return 0;
  p.vx -= (1 + MALLET_E) * vn * nx;
  p.vy -= (1 + MALLET_E) * vn * ny;
  capSpeed(p);
  return -vn;
}

// The puck cannot be inside a mallet: if it still is (squeezed against a
// wall, or frozen before a serve), the MALLET moves back.
function unpin(p, m) {
  const R = PUCK_R + MALLET_R;
  const dx = m.x - p.x;
  const dy = m.y - p.y;
  const d2 = dx * dx + dy * dy;
  if (d2 >= R * R - 0.01) return false;
  const d = Math.sqrt(d2);
  let nx, ny;
  if (d < 1e-6) { nx = m.side === 0 ? -1 : 1; ny = 0; } else { nx = dx / d; ny = dy / d; }
  const c = clampToHalf(m.side, p.x + nx * R, p.y + ny * R);
  m.x = c.x;
  m.y = c.y;
  return true;
}

// One end of the table (side 0: x = 0, side 1: x = W), in local coordinates
// where the end is at x = 0 and the table is at x > 0. The mouth is open
// between GOAL_Y0 and GOAL_Y1; its corners are the posts.
function endWall(p, side) {
  const s = side === 0 ? 1 : -1;
  let x = side === 0 ? p.x : W - p.x;
  if (x >= PUCK_R) return false;
  let y = p.y;
  let vx = p.vx * s;
  let vy = p.vy;
  let hit = false;
  if (y > GOAL_Y0 && y < GOAL_Y1) {
    if (x >= 0) {
      // In front of the mouth: the posts
      for (let k = 0; k < 2; k++) {
        const cy = k === 0 ? GOAL_Y0 : GOAL_Y1;
        const dx = x;
        const dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 >= PUCK_R * PUCK_R) continue;
        const d = Math.sqrt(d2) || 1e-6;
        const nx = dx / d;
        const ny = dy / d;
        x = nx * PUCK_R;
        y = cy + ny * PUCK_R;
        const vn = vx * nx + vy * ny;
        if (vn < 0) { vx -= (1 + WALL_E) * vn * nx; vy -= (1 + WALL_E) * vn * ny; hit = 'post'; }
      }
    } else {
      // Inside the goal: its sides
      if (y < GOAL_Y0 + PUCK_R) { y = GOAL_Y0 + PUCK_R; if (vy < 0) { vy = -vy * WALL_E; hit = 'post'; } }
      else if (y > GOAL_Y1 - PUCK_R) { y = GOAL_Y1 - PUCK_R; if (vy > 0) { vy = -vy * WALL_E; hit = 'post'; } }
    }
  } else {
    x = PUCK_R;
    if (vx < 0) { vx = -vx * WALL_E; hit = 'wall'; }
  }
  p.x = side === 0 ? x : W - x;
  p.y = y;
  p.vx = vx * s;
  p.vy = vy;
  return hit;
}

// Walls of the table. Returns false, 'wall' or 'post'.
function walls(p) {
  let hit = false;
  if (p.y < PUCK_R) { p.y = PUCK_R; if (p.vy < 0) { p.vy = -p.vy * WALL_E; hit = 'wall'; } }
  else if (p.y > H - PUCK_R) { p.y = H - PUCK_R; if (p.vy > 0) { p.vy = -p.vy * WALL_E; hit = 'wall'; } }
  const a = endWall(p, 0);
  const b = endWall(p, 1);
  return a || b || hit;
}

/** The goal the puck is fully inside: 0 left, 1 right, -1 none */
function goalOf(p) {
  if (p.x + PUCK_R < 0) return 0;
  if (p.x - PUCK_R > W) return 1;
  return -1;
}

/**
 * One fixed step: the mallets move towards their targets (capped speed) and,
 * if `live`, the puck moves and collides, in sub-steps.
 * Returns { goal: -1 | 0 | 1, hits: [{ side, power }], wall: false | 'wall' | 'post', substeps }
 */
function step(w, dt, live) {
  const out = { goal: -1, hits: [], wall: false, substeps: 1 };
  const p = w.puck;
  const ms = w.mallets;
  const from = [];
  const to = [];
  const stuck = [false, false];
  let mMove = 0;
  for (let k = 0; k < ms.length; k++) {
    const m = ms[k];
    let dx = m.tx - m.x;
    let dy = m.ty - m.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const maxD = MALLET_MAX * dt;
    if (d > maxD) { dx *= maxD / d; dy *= maxD / d; }
    const c = clampToHalf(m.side, m.x + dx, m.y + dy);
    from.push({ x: m.x, y: m.y });
    to.push(c);
    m.vx = (c.x - m.x) / dt;
    m.vy = (c.y - m.y) / dt;
    mMove = Math.max(mMove, Math.sqrt((c.x - m.x) * (c.x - m.x) + (c.y - m.y) * (c.y - m.y)));
  }
  const pMove = live ? Math.sqrt(p.vx * p.vx + p.vy * p.vy) * dt : 0;
  const n = clamp(Math.ceil((pMove + mMove) / SUBSTEP_MOVE), 1, MAX_SUBSTEPS);
  out.substeps = n;
  const h = dt / n;
  const fr = Math.exp(-FRICTION * h);
  for (let s = 1; s <= n; s++) {
    const f = s / n;
    for (let k = 0; k < ms.length; k++) {
      if (stuck[k]) continue;
      ms[k].x = from[k].x + (to[k].x - from[k].x) * f;
      ms[k].y = from[k].y + (to[k].y - from[k].y) * f;
    }
    if (live) {
      p.x += p.vx * h;
      p.y += p.vy * h;
      p.vx *= fr;
      p.vy *= fr;
      for (let k = 0; k < ms.length; k++) {
        const imp = hitMallet(p, ms[k]);
        if (imp > 0) out.hits.push({ side: k, power: imp });
      }
      const wh = walls(p);
      if (wh && out.wall !== 'post') out.wall = wh;
    }
    for (let k = 0; k < ms.length; k++) if (unpin(p, ms[k])) stuck[k] = true;
    if (live) {
      const g = goalOf(p);
      if (g >= 0) { out.goal = g; break; }
    }
  }
  for (let k = 0; k < ms.length; k++) {
    if (stuck[k]) { ms[k].vx = (ms[k].x - from[k].x) / dt; ms[k].vy = (ms[k].y - from[k].y) / dt; }
  }
  if (live && p.vx * p.vx + p.vy * p.vy < STOP_SPEED * STOP_SPEED) { p.vx = 0; p.vy = 0; }
  return out;
}

// ---------------------------------------------------------------- the game
function create(api, opts) {
  opts = opts || {};
  const random = opts.random || Math.random;
  const toWin = opts.pointsToWin || POINTS_TO_WIN;
  const S = {
    phase: 'paused',
    timer: 0,
    match: 0,
    score: [0, 0],
    winner: 0,          // 1 left, 2 right
    lastScorer: 0,
    sides: [-1, -1],    // slot of the left and right player
    serveDir: 0,        // side the next serve goes to (0 left, 1 right)
    world: newWorld(),
    resetId: 0,
    ticks: 0,
    sinceState: STATE_EVERY,
    lastHit: [-100, -100],
    lastWall: -100,
    inputs: 0
  };
  let lastMetaStr = '';
  let lastMetaAt = 0;

  function ev(e) { e.t = 'ev'; api.broadcast(e); }
  function sideOf(slot) { return slot >= 0 ? S.sides.indexOf(slot) : -1; }
  function playersConnected() {
    return S.sides[0] >= 0 && S.sides[1] >= 0 && api.isConnected(S.sides[0]) && api.isConnected(S.sides[1]);
  }
  function setPhase(ph, t) { S.phase = ph; S.timer = t || 0; }

  function centerPuck() {
    const p = S.world.puck;
    p.x = W / 2; p.y = H / 2; p.vx = 0; p.vy = 0;
    S.resetId++;
    S.sinceState = STATE_EVERY; // the TV sees the reset at once
  }
  function serve() {
    const p = S.world.puck;
    const a = (random() * 2 - 1) * SERVE_ANGLE;
    const dir = S.serveDir === 0 ? -1 : 1;
    p.vx = Math.cos(a) * SERVE_SPEED * dir;
    p.vy = Math.sin(a) * SERVE_SPEED;
  }

  function newMatch() {
    const ps = api.players();
    S.sides = [ps.length > 0 ? ps[0] : -1, ps.length > 1 ? ps[1] : -1];
    S.match++;
    S.score = [0, 0];
    S.winner = 0;
    S.lastScorer = 0;
    S.serveDir = random() < 0.5 ? 0 : 1;
    centerPuck();
    if (playersConnected()) { setPhase('countdown', COUNTDOWN_S); ev({ k: 'start' }); }
    else setPhase('paused');
    api.log('[hockey] Partida ' + S.match + ': ' + api.name(S.sides[0]) + ' (izquierda) contra ' + api.name(S.sides[1]) + ' (derecha)');
    sendMeta(true);
    // Each phone draws its mallet where the server has it
    S.sides.forEach(function (slot, side) { if (slot >= 0) api.sendSlot(slot, youMsg(side)); });
  }

  function goal(into) {
    const scorer = 1 - into;
    S.score[scorer]++;
    S.lastScorer = scorer + 1;
    S.serveDir = into; // towards the one who conceded
    centerPuck();
    ev({ k: 'goal', side: scorer + 1, slot: S.sides[scorer] + 1, into: into + 1 });
    if (S.score[scorer] >= toWin) {
      S.winner = scorer + 1;
      setPhase('end');
      api.log('[hockey] Gana ' + api.name(S.sides[scorer]) + ' ' + S.score[0] + '-' + S.score[1]);
      ev({ k: 'win', side: scorer + 1, slot: S.sides[scorer] + 1 });
    } else {
      setPhase('goal', GOAL_PAUSE_S);
    }
    sendMeta(true);
  }

  function tick(dt) {
    S.ticks++;
    S.sinceState++;
    if (S.phase === 'paused') {
      if (playersConnected()) { setPhase('countdown', COUNTDOWN_S); sendMeta(true); }
      return;
    }
    const live = S.phase === 'playing';
    const r = step(S.world, dt, live);
    if (live) {
      r.hits.forEach(function (h) {
        if (h.power < MIN_HIT_POWER || S.ticks - S.lastHit[h.side] < HIT_EVERY) return;
        S.lastHit[h.side] = S.ticks;
        ev({ k: 'hit', side: h.side + 1, slot: S.sides[h.side] + 1, power: Math.round(Math.min(h.power, PUCK_MAX)) });
      });
      if (r.wall && S.ticks - S.lastWall >= WALL_EVERY) {
        S.lastWall = S.ticks;
        ev({ k: r.wall });
      }
      if (r.goal >= 0) goal(r.goal);
      return;
    }
    if (S.phase === 'countdown' || S.phase === 'goal') {
      S.timer -= dt;
      if (S.timer <= 0) {
        const p = S.world.puck;
        const wasCountdown = S.phase === 'countdown';
        if (p.vx === 0 && p.vy === 0) serve();
        setPhase('playing');
        if (wasCountdown) ev({ k: 'go' });
        sendMeta(true);
      }
    }
  }

  function buildMeta() {
    return {
      t: 'hmeta',
      match: S.match,
      phase: S.phase,
      score: S.score.slice(),
      toWin: toWin,
      winner: S.winner,
      lastScorer: S.lastScorer,
      countdown: S.phase === 'countdown' ? Math.max(1, Math.ceil(S.timer * SPEED - 1e-6)) : 0,
      serve: S.serveDir + 1,
      players: S.sides.map(function (s) { return s + 1; }),   // [left, right], slots from 1
      waiting: S.sides.filter(function (s) { return s >= 0 && !api.isConnected(s); }).map(function (s) { return api.name(s); }),
      field: FIELD
    };
  }
  function sendMeta(force) {
    const str = JSON.stringify(buildMeta());
    const now = Date.now();
    if (!force && str === lastMetaStr && now - lastMetaAt < 1000) return;
    lastMetaStr = str;
    lastMetaAt = now;
    api.broadcast(str);
  }
  function stateMsg() {
    const p = S.world.puck;
    const m = S.world.mallets;
    return JSON.stringify({
      t: 'hs',
      ts: Date.now(),
      ph: S.phase,
      p: [round1(p.x), round1(p.y), Math.round(p.vx), Math.round(p.vy)],
      m: [round1(m[0].x), round1(m[0].y), round1(m[1].x), round1(m[1].y)],
      r: S.resetId
    });
  }
  function youMsg(side) {
    const m = S.world.mallets[side];
    const u = inputFromPos(side, m.tx, m.ty);
    return { t: 'h.you', x: Math.round(u.x * 1000) / 1000, y: Math.round(u.y * 1000) / 1000 };
  }

  return {
    id: 'hockey',
    field: FIELD,
    start: newMatch,
    stop: function () { /* nothing to clean up */ },
    tick: tick,
    flush: function () {
      if (S.sinceState >= STATE_EVERY) {
        S.sinceState = 0;
        if (api.tvs && api.tvs.size) api.sendTvs(stateMsg());
      }
      sendMeta(false);
    },
    onMessage: function (who, msg) {
      if (msg.t === 'h.m') {
        const side = sideOf(who);
        if (side < 0) return;            // the TV or someone who is only watching
        const u = Number(msg.x);
        const v = Number(msg.y);
        if (!isFinite(u) || !isFinite(v)) return;
        const t = targetFromInput(side, u, v);
        S.world.mallets[side].tx = t.x;
        S.world.mallets[side].ty = t.y;
        S.inputs++;
      } else if (msg.t === 'h.again') {
        if (S.phase === 'end') {
          api.log('[hockey] Otra partida (la pide ' + (who >= 0 ? api.name(who) : 'la tele') + ')');
          newMatch();
        }
      }
    },
    onPlayerDisconnected: function (i) {
      if (sideOf(i) < 0) return;
      if (S.phase === 'countdown' || S.phase === 'playing' || S.phase === 'goal') {
        setPhase('paused');
        api.log('[hockey] Pausa: falta ' + api.name(i));
      }
      sendMeta(true);
    },
    onPlayerJoined: function (i) {
      api.sendSlot(i, buildMeta());
      const side = sideOf(i);
      if (side >= 0) api.sendSlot(i, youMsg(side));
      sendMeta(true);
    },
    // Someone who was only watching can go; without one of the two players, back to the menu
    onPlayerLeft: function (i) { return sideOf(i) < 0; },
    syncTv: function (ws) { api.sendWs(ws, buildMeta()); api.sendWs(ws, stateMsg()); },
    // For tests
    _state: S
  };
}

module.exports = {
  create: create,
  FIELD: FIELD,
  POINTS_TO_WIN: POINTS_TO_WIN,
  physics: {
    newWorld: newWorld, step: step, walls: walls, goalOf: goalOf, hitMallet: hitMallet,
    clampToHalf: clampToHalf, targetFromInput: targetFromInput, inputFromPos: inputFromPos, halfBounds: halfBounds,
    PUCK_MAX: PUCK_MAX, MALLET_MAX: MALLET_MAX, WALL_E: WALL_E, SERVE_SPEED: SERVE_SPEED,
    COUNTDOWN_S: COUNTDOWN_S, GOAL_PAUSE_S: GOAL_PAUSE_S, STATE_EVERY: STATE_EVERY
  },
  // Sent to the TV and phone pages with the game list (G2T.gameById('hockey').tv)
  tvInfo: { field: FIELD }
};
