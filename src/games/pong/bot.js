'use strict';
/*
 * «Pong»: the computer opponent («Rivales bot», see docs/crear-un-juego.md).
 * create(ctx) -> { onTv, onSlot, tick, stop }.
 *
 * It sees what a person sees (pmeta and the 60 Hz `s` state of the TV, a
 * little late: its reaction time) and plays like a phone: { t: 'm', y } with
 * y in 0..1 (the paddle position), rounded to 0.001, only when it changes.
 * It never asks for the rematch (one player is enough: the person decides).
 *
 * Its paddle is the one pmeta.paddles gives its slot: in 2v2 (3-4 players)
 * that is a goal paddle or a forward one («delantera», 540 px out), and it
 * defends its own line: a paddle only stops the ball moving towards its goal.
 *
 * Each tick:
 *   1. Where the ball crosses its paddle line (straight lines folded on the
 *      top and bottom walls: exact, the game reflects like a mirror). The
 *      easy levels see bounces worse (an error that grows with the ball speed
 *      and the bounces, sampled for each ball and shrinking as it comes).
 *   2. Where to hit it on the paddle: the game sends the ball off at up to 55°
 *      the further from the paddle centre it hits. The good levels try a few
 *      hit points and keep the return the rival paddles reach worst (how fast
 *      they would have to move, bounces count extra); the easy ones hit it
 *      roughly in the middle.
 *   3. The paddle goes there at the level's speed (a finger is fast, but not
 *      infinitely); while the ball goes away, back towards the middle.
 *
 * Levels (ctx.level): see LEVELS.
 */
const Pong = require('./index');
const Kit = require('../bot-kit');

const F = Pong.FIELD;
const W = F.w, H = F.h, BR = F.ballR, PW = F.paddleW;
const MAX_ANGLE = 55 * Math.PI / 180;    // index.js MAX_BOUNCE_ANGLE (not exported)
const SPEEDUP = 1.06;                    // index.js BALL_SPEEDUP
const SPEED_MAX = 1900;                  // index.js BALL_SPEED_MAX (PONG_DEBUG_SPEED 1)
const START_SPEED = 780;                 // index.js BALL_SPEED_START
const TICK_MS = 1000 / 60;

/*
 * react: ms it sees late
 * speed: how fast it moves its paddle (u/s; Infinity: as fast as the game lets it)
 * err: how far off (units, deviation) it judges where a ball at the start speed
 *      crosses its line; it grows with the speed (^1.5) and with each wall
 *      bounce (+60 %), and shrinks to `floor` of it as the ball arrives
 * floor: the part of that error it still has when the ball gets there
 * aim: hit points it tries on the paddle (0: always the middle, ± noise)
 * edge: the furthest from the middle it dares to hit (1 = the very edge)
 * spread: noise of its hit point (in paddle halves)
 * idle: while the ball goes away, how much it goes back to the middle (0..1 per second)
 */
const LEVELS = {
  facil: { react: 260, speed: 750, err: 50, floor: 0.6, aim: 0, edge: 0.3, spread: 0.3, idle: 0.6 },
  normal: { react: 150, speed: 1500, err: 26, floor: 0.45, aim: 3, edge: 0.55, spread: 0.18, idle: 1.5 },
  dificil: { react: 90, speed: 2400, err: 16, floor: 0.35, aim: 7, edge: 0.75, spread: 0.08, idle: 3 },
  imposible: { react: 30, speed: Infinity, err: 0, floor: 0, aim: 17, edge: 0.82, spread: 0, idle: 6 }
};

// ---------------------------------------------------------------- geometry (no state)

/** A ball centre y moving freely (no walls) folded into the table, like the game's wall bounces. */
function fold(y) {
  const L = H - 2 * BR;
  let u = (y - BR) % (2 * L);
  if (u < 0) u += 2 * L;
  return BR + (u <= L ? u : 2 * L - u);
}
/** Wall bounces between y0 and the free y1. */
function bounces(y0, y1) {
  const L = H - 2 * BR;
  return Math.abs(Math.floor((y1 - BR) / L) - Math.floor((y0 - BR) / L));
}
/** The ball centre x when its leading edge touches the face of a paddle at x on side (0 left, 1 right). */
function lineX(x, side) { return side === 0 ? x + PW / 2 + BR : x - PW / 2 - BR; }

/**
 * Where the ball (x, y, vx, vy) crosses the line X: { t (s), y, bounces }
 * (into `out` if given) or null if it does not go there.
 */
function crossing(x, y, vx, vy, X, out) {
  if (Math.abs(vx) < 1e-6) return null;
  const t = (X - x) / vx;
  if (t < 0) return null;
  const yf = y + vy * t;
  out = out || {};
  out.t = t; out.y = fold(yf); out.bounces = bounces(y, yf);
  return out;
}

/**
 * What it saw, `ms` late (its reaction time), without allocating: a ring of
 * `n` reusable states. fill(at) hands the next one to overwrite; get(now) the
 * newest one at least `ms` old (else the oldest).
 */
function seenRing(n, ms, make) {
  const items = [];
  for (let i = 0; i < n; i++) items.push({ at: -Infinity, s: make() });
  let head = -1, count = 0;
  return {
    fill: function (at) { head = (head + 1) % n; if (count < n) count++; items[head].at = at; return items[head].s; },
    get: function (now) {
      if (!count) return null;
      for (let i = 0; i < count; i++) { const it = items[(head - i + n) % n]; if (now - it.at >= ms) return it.s; }
      return items[(head - count + 1 + n) % n].s;
    },
    latest: function () { return count ? items[head].s : null; },
    clear: function () { head = -1; count = 0; }
  };
}

// ---------------------------------------------------------------- the bot

function create(ctx) {
  const P = Kit.byLevel(ctx.level, LEVELS);
  const seen = seenRing(40, P.react, function () { return { ts: 0, ph: '', r: 0, b: [0, 0, 0, 0], p: [0, 0, 0, 0] }; });
  let meta = null;           // { phase, paddles }
  let me = -1;               // my paddle index
  let latest = null;         // newest state (the paddles)
  let stopped = false;
  let hand = H / 2;          // where its finger has the paddle (centre y)
  let desired = H / 2;       // where it wants it
  let sentY = -1;
  let paddleY = H / 2;       // where its paddle is (last seen)
  let hits = 0;              // hits seen (any paddle): each one is a new ball to judge
  // The ball it is playing now: its error and its chosen hit point
  let approach = null;       // { r, sg, hits (which ball), e (its error), rel (its hit point) }
  const cross = {};

  function pad(k) { return meta && meta.paddles[k]; }
  function sideOf(k) { return pad(k).side - 1; }
  function halfOf(k) { return pad(k).h / 2 + BR; }
  function clampPaddle(k, y) { const h = pad(k).h; return Math.max(h / 2, Math.min(H - h / 2, y)); }

  // The rivals' paddles in the order a ball going away from my side meets them
  function rivals() {
    const mySide = sideOf(me);
    const out = [];
    meta.paddles.forEach(function (p, k) { if (p.side - 1 !== mySide) out.push(k); });
    out.sort(function (a, b) { return mySide === 0 ? pad(a).x - pad(b).x : pad(b).x - pad(a).x; });
    return out;
  }

  /** How hard a return from (X, y) hit at `rel` of the paddle is for the rivals (bigger is better). */
  function returnScore(X, y, speed, rel, ys) {
    const ang = rel * MAX_ANGLE;
    const s = Math.min(SPEED_MAX, speed * SPEEDUP);
    const dir = sideOf(me) === 0 ? 1 : -1;
    const vx = dir * Math.cos(ang) * s, vy = Math.sin(ang) * s;
    const rv = rivals();
    let worst = Infinity;
    for (let i = 0; i < rv.length; i++) {
      const k = rv[i];
      const c = crossing(X, y, vx, vy, lineX(pad(k).x, sideOf(k)));
      if (!c) continue;
      const py = ys && ys[k] !== undefined ? ys[k] : H / 2;
      const reach = Math.max(0, Math.abs(c.y - py) - halfOf(k) * 0.5);
      // The speed it needs to get there (with a human-like 0.15 s to react), plus the bounces it must read
      const need = reach / Math.max(0.05, c.t - 0.15) + 220 * c.bounces;
      if (need < worst) worst = need;
    }
    return worst === Infinity ? 0 : worst;
  }

  /** Where to put the paddle for a ball crossing its line at y (it picks the hit point once per ball). */
  function plan(cy, speed, ys) {
    if (!approach.rel) {
      let rel = 0;
      if (P.aim > 0) {
        // A few hit points across the safe part of the paddle; the best return
        let best = -1;
        for (let i = 0; i < P.aim; i++) {
          const r = P.aim === 1 ? 0 : -P.edge + 2 * P.edge * i / (P.aim - 1);
          const sc = returnScore(lineX(pad(me).x, sideOf(me)), cy, speed, r, ys);
          if (sc > best) { best = sc; rel = r; }
        }
      }
      if (P.spread) rel += Kit.gauss(ctx.random) * P.spread;
      approach.rel = { r: Math.max(-0.95, Math.min(0.95, rel)) };
    }
    let py = clampPaddle(me, cy - approach.rel.r * halfOf(me));
    // Against a wall the paddle cannot go further: hit it where it can
    if (Math.abs(cy - py) > halfOf(me) * 0.95) py = clampPaddle(me, cy - Math.sign(cy - py) * halfOf(me) * 0.9);
    return py;
  }

  function think(now, dt) {
    const s = seen.get(now);
    if (!s || !meta || me < 0) return;
    const playing = meta.phase === 'playing' && s.ph === 'playing';
    const mySide = sideOf(me);
    const X = lineX(pad(me).x, mySide);
    const b = s.b;
    const coming = playing && (mySide === 0 ? b[2] < 0 && b[0] > X - 1 : b[2] > 0 && b[0] < X + 1);
    if (coming) {
      const c = crossing(b[0], b[1], b[2], b[3], X, cross);
      if (c) {
        // A new ball for it (a new direction or a new serve): a new misjudgement
        const sg = b[2] < 0 ? -1 : 1;
        const speed = Math.sqrt(b[2] * b[2] + b[3] * b[3]);
        if (!approach || approach.r !== s.r || approach.sg !== sg || approach.hits !== hits) {
          const sd = P.err * Math.pow(speed / START_SPEED, 1.5) * (1 + 0.6 * c.bounces);
          approach = { r: s.r, sg: sg, hits: hits, e: sd ? Kit.gauss(ctx.random) * sd : 0, rel: null };
        }
        const tLeft = Math.max(0, c.t - (now - s.ts) / 1000);
        const f = Math.max(P.floor, Math.min(1, tLeft / 0.6));
        const cy = Math.max(BR, Math.min(H - BR, c.y + approach.e * f));
        const ys = latest ? latest.p : null;
        desired = plan(cy, speed, ys);
        return;
      }
    }
    approach = null;
    // The ball goes away (or is not in play): back towards the middle
    desired = hand + (H / 2 - hand) * Math.min(1, P.idle * dt);
  }

  return {
    onTv: function (m) {
      if (stopped) return;
      if (m.t === 's') {
        const st = seen.fill(ctx.now());
        st.ts = m.ts; st.ph = m.ph; st.r = m.r;
        for (let i = 0; i < 4; i++) { st.b[i] = m.b[i]; st.p[i] = i < m.p.length ? m.p[i] : H / 2; }
        latest = st;
        if (me >= 0 && me < m.p.length) paddleY = m.p[me];
      } else if (m.t === 'pmeta') {
        meta = { phase: m.phase, paddles: (m.paddles || []).map(function (p) { return { slot: p.slot, side: p.side, x: p.x, h: p.h, role: p.role }; }) };
        let k = -1;
        meta.paddles.forEach(function (p, i) { if (p.slot === ctx.slot) k = i; });
        if (k !== me) { me = k; approach = null; }
        if (m.phase !== 'playing') approach = null;
      } else if (m.t === 'ev' && m.k === 'hit') {
        hits++;
      }
    },
    onSlot: function () {},
    tick: function (dt) {
      if (stopped || me < 0 || !meta || !meta.paddles[me]) return;
      const now = ctx.now();
      think(now, dt || 1 / 60);
      // The paddle (its finger) moves at the level's speed
      const st = P.speed === Infinity ? Infinity : P.speed * (dt || 1 / 60);
      const d = desired - hand;
      hand = Math.abs(d) <= st ? desired : hand + Math.sign(d) * st;
      const p = pad(me);
      const v = Math.round(Math.max(0, Math.min(1, (hand - p.h / 2) / (H - p.h))) * 1000) / 1000;
      if (v !== sentY && ctx.send({ t: 'm', y: v })) sentY = v;
    },
    stop: function () { stopped = true; approach = null; seen.clear(); },
    // For tests: what it is doing
    debug: function () { return { me: me, hand: hand, paddleY: paddleY, approach: approach, stopped: stopped }; }
  };
}

module.exports = { create: create, LEVELS: LEVELS, crossing: crossing, fold: fold, lineX: lineX };
