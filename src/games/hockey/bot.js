'use strict';
/*
 * «Hockey de mesa»: the computer opponent («Rivales bot», see
 * docs/crear-un-juego.md). create(ctx) -> { onTv, onSlot, tick, stop }.
 *
 * It sees what a person sees (hmeta and the 30 Hz `hs` state of the TV, a
 * little late: its reaction time) and plays like a phone: absolute mallet
 * targets { t: 'h.m', x, y } (0..1 over its half, rounded to 0.001, only when
 * they change and at most every 15 ms). The server moves the mallet towards
 * the target at MALLET_MAX at most, so the bot cannot do anything a finger
 * cannot.
 *
 * Everything is reasoned in a mirrored frame where the bot is the LEFT player
 * (its goal at x = 0, the rival goal at x = W): the table is symmetric.
 *
 * Each think (every LEVELS.think ms):
 *   1. Predict the puck path from the state it sees (friction, walls with
 *      their energy loss, the goal mouths), 1/60 s per point, up to a few
 *      wall bounces (fewer for the easy levels: they misjudge banks).
 *   2. Strike: for each future point of that path in its half (earliest
 *      first) and each shot it knows (straight at the goal or at its
 *      corners, banks off the side walls; plain clearances only when no shot
 *      at goal works), ranked by how badly the rival mallet can reach them,
 *      it computes the contact normal that sends the puck that way (the
 *      game's bounce: mallet of infinite mass, restitution MALLET_E, the puck
 *      keeps its tangential speed), the wind-up point behind the puck on that
 *      line and whether its mallet gets there in time (going round the puck
 *      if it is in the way). The first one that works is the plan: wait at
 *      the wind-up point, then swing through the puck (as hard as its level
 *      shoots).
 *   3. If there is no strike: get behind a slow puck in its half; block (put
 *      the mallet on the puck path, the earliest point it reaches in time)
 *      when it comes towards its goal; push a stuck one out of a corner;
 *      else stay home, between the puck and its goal.
 *
 * Levels (ctx.level): see LEVELS.
 */
const Hockey = require('./index');
const Kit = require('../bot-kit');

const F = Hockey.FIELD;
const W = F.w, H = F.h, PR = F.puckR, MR = F.malletR, RR = PR + MR;
const GY0 = F.goalY0, GY1 = F.goalY1;
const MALLET_MAX = F.malletMax, PUCK_MAX = F.puckMax;
const WALL_E = Hockey.physics.WALL_E;
// Not exported by index.js (keep in sync with it; test/hockey-bot.test.js checks the path)
const FRICTION = 0.22;
const MALLET_E = 0.85;
// Its half (mallet centre), mirrored frame
const X0 = MR, X1 = W / 2 - MR, Y0 = MR, Y1 = H - MR;
const DTP = 1 / 60;              // path step (s)
const NMAX = 96;                 // path points (1.6 s)
const TICK_MS = 1000 / 60;
const LAT = 1.5;                 // path steps between thinking and the mallet moving (the message arrives next tick)
const CLEARS = ['K0', 'K1', 'K2'];
const FOLLOW = 70;               // swing follow-through beyond the contact point

/*
 * react: ms it sees late (the puck and the rival; its own mallet it knows)
 * think: ms between plans
 * send: ms between two phone messages at most (a phone: 15)
 * speed: how fast it moves its mallet around (u/s; the server caps at 3000)
 * swing: the fastest it swings through the puck (u/s)
 * shot: the puck speed it shoots at (u/s; the game caps it at 2400): it swings just that hard
 * windT: wind-up length, in seconds of swing (a longer one is easier to time)
 * aimErr: its shots go this far off (radians, deviation; a new error per shot)
 * posErr: it sees the puck this far off (units, deviation; a slow drift)
 * velErr: …and its direction this far off (radians, deviation)
 * bounces: wall bounces it can foresee (beyond that it does not know)
 * horizon: seconds of path it foresees
 * attack: puck speed above which it does not try to strike, only blocks
 * shots: 'center' (only at the middle of the goal), 'direct' (middle or a
 *        corner, the one the rival reaches worst), 'all' (also banks, not
 *        always the best one), 'best' (the one the rival reaches worst)
 * slack: s of margin it wants to be in place before a strike
 * home: distance from its goal where it waits
 */
const LEVELS = {
  facil: { react: 240, think: 110, send: 16, speed: 950, swing: 700, shot: 950, windT: 0.09, aimErr: 0.2, posErr: 26, velErr: 0.09, bounces: 0, horizon: 0.55, attack: 420, shots: 'center', slack: 0.08, home: 150 },
  normal: { react: 150, think: 66, send: 16, speed: 1500, swing: 1100, shot: 1500, windT: 0.08, aimErr: 0.1, posErr: 12, velErr: 0.04, bounces: 1, horizon: 0.85, attack: 1400, shots: 'direct', slack: 0.05, home: 170 },
  dificil: { react: 60, think: 33, send: 16, speed: 2600, swing: 2000, shot: 2300, windT: 0.07, aimErr: 0.025, posErr: 2, velErr: 0.008, bounces: 2, horizon: 1.2, attack: 1800, shots: 'all', slack: 0.035, home: 200 },
  imposible: { react: 25, think: 16, send: 15, speed: 3000, swing: 2700, shot: 9999, windT: 0.06, aimErr: 0, posErr: 0, velErr: 0, bounces: 4, horizon: 1.6, attack: 9999, shots: 'best', slack: 0.02, home: 220 }
};

// ---------------------------------------------------------------- geometry (no state)

/**
 * The puck path from (x, y, vx, vy) (mirrored frame), DTP apart, into the
 * arrays of `out` (x, y, vx, vy), at most n points and maxBounces wall bounces.
 * out.n: points; out.goal: 0 (into its own goal), 1 (the rival's) or -1; out.goalK.
 */
function predict(out, x, y, vx, vy, n, maxBounces) {
  const fr = Math.exp(-FRICTION * DTP);
  let b = 0;
  out.goal = -1; out.goalK = -1;
  let k = 0;
  for (; k < n; k++) {
    out.x[k] = x; out.y[k] = y; out.vx[k] = vx; out.vy[k] = vy;
    if (vx === 0 && vy === 0) continue;
    x += vx * DTP; y += vy * DTP; vx *= fr; vy *= fr;
    if (vx * vx + vy * vy < 16) { vx = 0; vy = 0; }
    if (y < PR) { y = PR + (PR - y) * WALL_E; vy = -vy * WALL_E; b++; }
    else if (y > H - PR) { y = H - PR - (y - H + PR) * WALL_E; vy = -vy * WALL_E; b++; }
    if (x < PR || x > W - PR) {
      const left = x < PR;
      if (y > GY0 && y < GY1) {
        if (left ? x < 0 : x > W) { out.goal = left ? 0 : 1; out.goalK = k + 1; k++; out.x[k] = x; out.y[k] = y; out.vx[k] = vx; out.vy[k] = vy; k++; break; }
      } else {
        x = left ? PR + (PR - x) * WALL_E : W - PR - (x - W + PR) * WALL_E;
        vx = -vx * WALL_E; b++;
      }
    }
    if (b > maxBounces) { k++; break; }
  }
  out.n = Math.min(k, n);
  return out;
}

/**
 * The contact normal (unit, from mallet to puck) that sends a puck arriving
 * with (vx, vy) along (ax, ay) when the mallet swings along that normal at
 * speed V (the game's bounce: infinite mass, restitution MALLET_E). Writes
 * res.nx, res.ny, res.speed (the puck speed out); false if it cannot.
 */
function shotNormal(res, vx, vy, ax, ay, V) {
  let nx = ax, ny = ay;
  for (let it = 0; it < 4; it++) {
    const vn = vx * nx + vy * ny;
    const s = (1 + MALLET_E) * V - MALLET_E * vn;
    if (s < 60) return false;
    const ox = vx - vn * nx + s * nx, oy = vy - vn * ny + s * ny;
    const err = Math.atan2(ax * oy - ay * ox, ax * ox + ay * oy);
    if (Math.abs(err) < 0.004) { res.nx = nx; res.ny = ny; res.speed = Math.min(PUCK_MAX, Math.sqrt(ox * ox + oy * oy)); return true; }
    if (Math.abs(err) > 1.2) return false;
    const c = Math.cos(-err), sn = Math.sin(-err);
    const tx = nx * c - ny * sn;
    ny = nx * sn + ny * c; nx = tx;
  }
  const vn = vx * nx + vy * ny;
  const s = (1 + MALLET_E) * V - MALLET_E * vn;
  const ox = vx - vn * nx + s * nx, oy = vy - vn * ny + s * ny;
  if (s < 60 || Math.abs(Math.atan2(ax * oy - ay * ox, ax * ox + ay * oy)) > 0.03) return false;
  res.nx = nx; res.ny = ny; res.speed = Math.min(PUCK_MAX, Math.sqrt(ox * ox + oy * oy));
  return true;
}

/** Shot direction (unit) from (x, y) for a kind of shot; false if it makes no sense from there. */
function shotDir(res, kind, x, y) {
  let dx, dy;
  if (kind === 'C' || kind === 'U' || kind === 'D') {
    const gy = kind === 'C' ? H / 2 : (kind === 'U' ? GY0 + 48 : GY1 - 48);
    dx = W + 20 - x; dy = gy - y;
  } else if (kind === 'BT' || kind === 'BB') {
    // A bank off a side wall to the middle of the goal: the wall keeps WALL_E of the across speed
    const a = kind === 'BT' ? y - PR : H - PR - y;
    const b = H / 2 - PR;
    if (a < 30) return false;
    dx = (W - x) / (a + b / WALL_E); dy = kind === 'BT' ? -1 : 1;
  } else {
    // Clearances: forward, a bit up or down
    const ang = kind === 'K0' ? 0 : (kind === 'K1' ? -0.7 : 0.7);
    dx = Math.cos(ang); dy = Math.sin(ang);
  }
  const d = Math.sqrt(dx * dx + dy * dy);
  res.ax = dx / d; res.ay = dy / d;
  return true;
}

/** Distance from (px, py) to the segment (ax, ay)-(bx, by). */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const ex = ax + dx * t - px, ey = ay + dy * t - py;
  return Math.sqrt(ex * ex + ey * ey);
}

/**
 * How safe a shot of `kind` from (x, y) at speed S is from the rival mallet at
 * (ox, oy): along the puck path in the rival half, the smallest gap between
 * the puck and where that mallet could be by then (DEF_SPEED after DEF_REACT s).
 * Positive: it cannot get there in time. Bigger is better.
 */
const DEF_SPEED = 2600, DEF_REACT = 0.1;
function shotMargin(kind, x, y, ox, oy, S) {
  const r = {};
  if (!shotDir(r, kind, x, y)) return -Infinity;
  // The path: one or two segments, to the goal line
  let x1, y1, x2 = -1, y2 = 0;
  if (kind === 'BT' || kind === 'BB') {
    const wy = kind === 'BT' ? PR : H - PR;
    x1 = x + r.ax * (wy - y) / r.ay; y1 = wy;
    x2 = W; y2 = H / 2;
  } else {
    x1 = W; y1 = y + r.ay * (W - x) / r.ax;
  }
  let best = Infinity, dist = 0;
  const segs = x2 < 0 ? 1 : 2;
  for (let sg = 0; sg < segs; sg++) {
    const sx = sg === 0 ? x : x1, sy = sg === 0 ? y : y1;
    const ex = sg === 0 ? x1 : x2, ey = sg === 0 ? y1 : y2;
    const L = Math.sqrt((ex - sx) * (ex - sx) + (ey - sy) * (ey - sy));
    const n = Math.max(1, Math.ceil(L / 60));
    for (let i = 0; i <= n; i++) {
      const px = sx + (ex - sx) * i / n, py = sy + (ey - sy) * i / n;
      const d = dist + L * i / n;
      if (px < W / 2 - PR) continue;           // the rival cannot reach there
      const t = d / S;
      const gap = Math.sqrt((px - ox) * (px - ox) + (py - oy) * (py - oy)) - RR - DEF_SPEED * Math.max(0, t - DEF_REACT);
      if (gap < best) best = gap;
    }
    dist += L;
  }
  return best - (segs === 2 ? 40 : 0);         // banks are a little less sure
}

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

/** The longest wind-up (≤ want) from (cx, cy) backwards along -n that stays in its half. */
function windupFit(cx, cy, nx, ny, want) {
  let d = want;
  if (nx > 1e-6) d = Math.min(d, (cx - X0) / nx); else if (nx < -1e-6) d = Math.min(d, (cx - X1) / nx);
  if (ny > 1e-6) d = Math.min(d, (cy - Y0) / ny); else if (ny < -1e-6) d = Math.min(d, (cy - Y1) / ny);
  return d;
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
  const seen = seenRing(24, P.react, function () { return { ts: 0, ph: '', r: 0, p: [0, 0, 0, 0], m: [0, 0, 0, 0] }; });
  const think = Kit.every(ctx, P.think);
  const path = { x: new Float64Array(NMAX + 2), y: new Float64Array(NMAX + 2), vx: new Float64Array(NMAX + 2), vy: new Float64Array(NMAX + 2), n: 0, goal: -1, goalK: -1 };
  const nPath = Math.min(NMAX, Math.round(P.horizon / DTP));
  const dirRes = {}, nRes = {};
  let meta = null;
  let side = -1;                   // 0 left, 1 right
  let latest = null;               // newest hs (its own mallet)
  let stopped = false;
  // What it sends: the hand (target, mirrored frame) and what went out
  const hand = { x: 0.12 * W, y: H / 2, set: false };
  let sentX = -1, sentY = -1, sentAt = -Infinity;
  // Plan
  let mode = 'home';
  let plan = null;                 // { tC (contact, ms), px, py (puck), cx, cy (mallet), bx, by (wind-up), nx, ny, V, swingT, wp, kind }
  let swing = null;                // { bx, by, nx, ny, V, t0, len, until }
  let desired = { x: hand.x, y: hand.y, rate: P.speed };
  let lastReset = -1;
  let lastShot = null;
  // Errors: the puck seen a bit off (slow drift), the aim of the next shot
  let ex = 0, ey = 0, ea = 0;
  let aimNoise = P.aimErr ? Kit.gauss(ctx.random) * P.aimErr : 0;

  function mx(x) { return side === 1 ? W - x : x; }
  function mvx(vx) { return side === 1 ? -vx : vx; }

  // Its mallet now (mirrored): the last state it saw, moved towards its hand
  function myMallet() {
    if (!latest) return { x: hand.x, y: hand.y };
    let x = mx(latest.m[side * 2]), y = latest.m[side * 2 + 1];
    const age = Math.max(0, (ctx.now() - latest.ts) / 1000) + TICK_MS / 1000;
    const dx = hand.x - x, dy = hand.y - y, d = Math.sqrt(dx * dx + dy * dy);
    const step = MALLET_MAX * age;
    if (d <= step) { x = hand.x; y = hand.y; } else { x += dx / d * step; y += dy / d * step; }
    return { x: x, y: y };
  }

  function homePoint(px, py) {
    // Between the puck and the middle of its goal, P.home from the goal line
    let dx = px - 0, dy = py - H / 2;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= d; dy /= d;
    return { x: clamp(dx * P.home, X0 + 20, X1), y: clamp(H / 2 + dy * P.home, GY0 - 40, GY1 + 40) };
  }

  // A waypoint round the puck at (qx, qy) if it is in the way from m to (tx, ty)
  function detour(m, tx, ty, qx, qy) {
    const sd = segDist(qx, qy, m.x, m.y, tx, ty);
    if (sd >= RR + 8) return null;
    // Only if the puck really is between (not right at the target: that is the contact)
    const dTarget = Math.sqrt((tx - qx) * (tx - qx) + (ty - qy) * (ty - qy));
    if (dTarget < RR + 4) return null;
    const lx = tx - m.x, ly = ty - m.y;
    const L = Math.sqrt(lx * lx + ly * ly) || 1;
    // Go round on the side the mallet is on (the perpendicular through the puck), a bit goal-side
    let px = -ly / L, py = lx / L;
    if ((m.x - qx) * px + (m.y - qy) * py < 0) { px = -px; py = -py; }
    let wx = qx + px * (RR + 34) - 30, wy = qy + py * (RR + 34);
    if (wy < Y0 || wy > Y1) { wx = qx - (RR + 34); wy = clamp(qy, Y0, Y1); }
    return { x: clamp(wx, X0, X1), y: clamp(wy, Y0, Y1) };
  }

  function shotOrder(px, py, ox, oy) {
    let kinds;
    if (P.shots === 'center') kinds = ['C'];
    else if (P.shots === 'direct') kinds = ['C', 'U', 'D'];
    else kinds = ['C', 'U', 'D', 'BT', 'BB'];
    if (P.shots !== 'center') {
      const sc = {};
      kinds.forEach(function (k) { sc[k] = shotMargin(k, px, py, ox, oy, Math.min(PUCK_MAX, P.shot)) + (P.shots === 'all' ? Kit.gauss(ctx.random) * 70 : 0); });
      kinds.sort(function (a, b) { return sc[b] - sc[a]; });
      if (P.shots === 'direct') kinds = kinds.slice(0, 1);   // the best of its three
    }
    return kinds;
  }

  // The first path step (from kFrom to kTo) at which the puck touches the mallet going
  // straight from m to (bx, by) at `speed` and waiting there; -1 if none
  function firstClash(m, bx, by, speed, kFrom, kTo) {
    const dx = bx - m.x, dy = by - m.y;
    const L = Math.sqrt(dx * dx + dy * dy) || 1;
    const j0 = Math.max(0, Math.ceil(kFrom)), j1 = Math.min(path.n - 1, Math.floor(kTo));
    for (let j = j0; j <= j1; j += 2) {
      const f = Math.min(1, (j - kFrom) * DTP * speed / L);
      const ex = m.x + dx * f - path.x[j], ey = m.y + dy * f - path.y[j];
      if (ex * ex + ey * ey < (RR + 6) * (RR + 6)) return j;
    }
    return -1;
  }

  function planStrike(now, k0, m, speed, ox, oy) {
    const n = path.n;
    const k0i = Math.max(0, Math.min(Math.round(k0), n - 1));
    const kStart = Math.max(0, Math.ceil(k0 + LAT));
    // At the goal first (any time it can), else a clearance (the earliest)
    const passes = [shotOrder(path.x[k0i], path.y[k0i], ox, oy), CLEARS];
    for (let pass = 0; pass < 2; pass++) {
    const kinds = passes[pass];
    for (let k = kStart; k < n; k++) {
      const px = path.x[k], py = path.y[k];
      if (px > X1 + RR || px < PR) continue;
      if (path.goal === 0 && k >= path.goalK - 1) break;
      const tAvail = (k - k0 - LAT) * DTP;
      // Even straight there, not in time
      const dm = Math.sqrt((px - m.x) * (px - m.x) + (py - m.y) * (py - m.y)) - RR;
      if (dm / speed > tAvail + 0.05) continue;
      for (let c = 0; c < kinds.length; c++) {
        const kind = kinds[c];
        const clear = kind.charAt(0) === 'K';
        if (!shotDir(dirRes, kind, px, py)) continue;
        let ax = dirRes.ax, ay = dirRes.ay;
        if (aimNoise && !clear) { const cs = Math.cos(aimNoise), sn = Math.sin(aimNoise); const t = ax * cs - ay * sn; ay = ax * sn + ay * cs; ax = t; }
        const pvx = path.vx[k], pvy = path.vy[k];
        if (!shotNormal(nRes, pvx, pvy, ax, ay, P.swing)) continue;
        // As hard as its level shoots: the swing speed that sends the puck out at P.shot
        // (an incoming puck comes back fast with a slow swing)
        const vn = pvx * nRes.nx + pvy * nRes.ny;
        const V = clamp((P.shot + MALLET_E * vn) / (1 + MALLET_E), 200, P.swing);
        if (V < P.swing && !shotNormal(nRes, pvx, pvy, ax, ay, V)) continue;
        const nx = nRes.nx, ny = nRes.ny;
        const cx = px - nx * RR, cy = py - ny * RR;
        if (cx < X0 - 1 || cx > X1 + 1 || cy < Y0 - 1 || cy > Y1 + 1) continue;
        // Room to swing on through the puck (at the centre line or a wall the mallet stops: a dead, crooked shot)
        if (windupFit(cx, cy, -nx, -ny, 999) < (clear ? 20 : V / 60 * 1.3 + 10)) continue;
        const wind = windupFit(cx, cy, nx, ny, Math.max(36, V * P.windT));
        if (wind < (clear ? 12 : 30)) continue;
        const bx = cx - nx * wind, by = cy - ny * wind;
        const swingT = wind / V;
        let dist = Math.sqrt((bx - m.x) * (bx - m.x) + (by - m.y) * (by - m.y));
        if (dist / speed + swingT + P.slack > tAvail) continue;
        // On its way to the wind-up point (and waiting there) the puck must not run into the
        // mallet: else round it, if there is time
        let wp = null;
        const j = firstClash(m, bx, by, speed, k0 + LAT, k - swingT / DTP - 1);
        if (j >= 0) {
          wp = detour(m, bx, by, path.x[j], path.y[j]);
          if (!wp) continue;
          dist = Math.sqrt((wp.x - m.x) * (wp.x - m.x) + (wp.y - m.y) * (wp.y - m.y)) + Math.sqrt((bx - wp.x) * (bx - wp.x) + (by - wp.y) * (by - wp.y));
          if (dist / speed + swingT + P.slack > tAvail) continue;
        }
        // It plans: contact at path time k (absolute ms)
        const tC = path.t0 + k * DTP * 1000;
        return { tC: tC, px: px, py: py, cx: cx, cy: cy, bx: bx, by: by, nx: nx, ny: ny, V: V, swingT: swingT, wp: wp, kind: kind, ax: ax, ay: ay };
      }
    }
    }
    return null;
  }

  function planBlock(k0, m, speed) {
    const n = path.n;
    const kStart = Math.max(0, Math.ceil(k0 + LAT));
    for (let k = kStart; k < n; k++) {
      const px = path.x[k], py = path.y[k];
      if (px > X1 + 10) continue;
      const tAvail = (k - k0 - LAT) * DTP;
      const tx = clamp(px - 6, X0, X1), ty = clamp(py, Y0, Y1);
      const d = Math.sqrt((tx - m.x) * (tx - m.x) + (ty - m.y) * (ty - m.y));
      if (d - 20 <= speed * tAvail) return { x: tx, y: ty };
    }
    // Too late for that: guard the mouth where the path gets there
    if (path.goal === 0) {
      const gy = path.y[Math.max(0, path.goalK - 1)];
      return { x: X0 + 6, y: clamp(gy, GY0, GY1) };
    }
    return null;
  }

  function decide(now) {
    const s = seen.get(now);
    if (!s || side < 0) return;
    const playing = s.ph === 'playing' && meta && meta.phase === 'playing';
    if (s.r !== lastReset) { lastReset = s.r; plan = null; swing = null; }
    // The puck as it sees it (mirrored), with its error
    if (P.posErr) {
      ex = ex * 0.7 + Kit.gauss(ctx.random) * P.posErr * 0.55;
      ey = ey * 0.7 + Kit.gauss(ctx.random) * P.posErr * 0.55;
      ea = ea * 0.7 + Kit.gauss(ctx.random) * P.velErr * 0.55;
    }
    let px = mx(s.p[0]) + ex, py = s.p[1] + ey;
    let vx = mvx(s.p[2]), vy = s.p[3];
    if (ea) { const c = Math.cos(ea), sn = Math.sin(ea); const t = vx * c - vy * sn; vy = vx * sn + vy * c; vx = t; }
    px = clamp(px, -PR, W + PR); py = clamp(py, PR, H - PR);
    const m = myMallet();
    const ox = mx(s.m[(1 - side) * 2]), oy = s.m[(1 - side) * 2 + 1];
    if (!playing) {
      // Waiting (countdown, after a goal): home, facing the middle
      plan = null; swing = null; mode = 'home';
      const hp = homePoint(W / 2, H / 2);
      desired = { x: hp.x, y: hp.y, rate: P.speed };
      return;
    }
    predict(path, px, py, vx, vy, nPath, P.bounces);
    path.t0 = s.ts;
    const k0 = (now - s.ts) / 1000 / DTP;     // where «now» is on the path
    const speedNow = Math.sqrt(vx * vx + vy * vy);
    // 1. Strike: keep the plan while the puck goes where it planned (else it never swings: a
    // new plan is always a little later), or make a new one
    if (plan && mode === 'strike') {
      const kc = (plan.tC - path.t0) / 1000 / DTP;
      const kk = Math.round(kc);
      const ok = kk >= 0 && kk < path.n && now < plan.tC - plan.swingT * 1000 &&
        Math.abs(path.x[kk] - plan.px) + Math.abs(path.y[kk] - plan.py) < 14 + P.posErr;
      if (!ok) plan = null;
    } else plan = null;
    if (!plan && (speedNow <= P.attack || (vx > 0 && px < W / 2))) plan = planStrike(now, k0, m, P.speed, ox, oy);
    if (plan) {
      mode = 'strike';
      const wp = plan.wp;
      desired = wp ? { x: wp.x, y: wp.y, rate: P.speed } : { x: plan.bx, y: plan.by, rate: P.speed };
      return;
    }
    // 2. In its half, slow enough and no goal coming soon: get behind it, on the line to the
    // rival goal (a strike will be possible from there)
    const soon = path.goal === 0 && (path.goalK - k0) * DTP < 0.7;
    if (!soon && px < X1 + RR && speedNow <= P.attack) {
      const kq = Math.min(path.n - 1, Math.max(0, Math.round(k0 + LAT + 8)));
      const qx = path.x[kq], qy = path.y[kq];
      let ax = W - qx, ay = H / 2 - qy;
      const ad = Math.sqrt(ax * ax + ay * ay) || 1;
      ax /= ad; ay /= ad;
      const back = RR + Math.max(36, P.swing * P.windT) * 0.8;
      const tx = clamp(qx - ax * back, X0, X1), ty = clamp(qy - ay * back, Y0, Y1);
      if (qx - tx > 20) {
        mode = 'approach';
        const wp = detour(m, tx, ty, px, py);
        desired = wp ? { x: wp.x, y: wp.y, rate: P.speed } : { x: tx, y: ty, rate: P.speed };
        return;
      }
    }
    // 3. Block, if it comes
    if (vx < -30 || path.goal === 0) {
      const b = planBlock(k0, m, P.speed);
      if (b) {
        mode = 'block';
        // Do not push it into its own goal from the front: go round
        const wp = detour(m, b.x, b.y, px, py);
        desired = wp && m.x > px ? { x: wp.x, y: wp.y, rate: P.speed } : { x: b.x, y: b.y, rate: P.speed };
        return;
      }
    }
    // 4. A slow puck in its half it cannot plan (a corner, against the boards): through it, never towards its goal
    if (speedNow < 160 && px < W / 2 + 10) {
      mode = 'push';
      let dx = px - m.x, dy = py - m.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      dx /= d; dy /= d;
      if (dx < 0 && py > GY0 - 80 && py < GY1 + 80) {
        // It is in front of the puck and the goal is behind: round first
        const wp = { x: clamp(px - RR - 30, X0, X1), y: clamp(py + (m.y < py ? -1 : 1) * (RR + 30), Y0, Y1) };
        desired = { x: wp.x, y: wp.y, rate: P.speed };
      } else desired = { x: clamp(px + dx * 120, X0, X1), y: clamp(py + dy * 120, Y0, Y1), rate: Math.min(P.speed, P.swing) };
      return;
    }
    // 5. Home
    mode = 'home';
    const hp = homePoint(px, py);
    desired = { x: hp.x, y: hp.y, rate: P.speed };
  }

  function send(now) {
    if (now - sentAt < P.send - 0.5) return;
    let ux = hand.x / (W / 2), uy = hand.y / H;
    if (side === 1) ux = (W - hand.x - W / 2) / (W / 2);
    ux = Math.round(clamp(ux, 0, 1) * 1000) / 1000;
    uy = Math.round(clamp(uy, 0, 1) * 1000) / 1000;
    if (ux === sentX && uy === sentY) return;
    if (ctx.send({ t: 'h.m', x: ux, y: uy })) { sentX = ux; sentY = uy; sentAt = now; }
  }

  function moveHand(tx, ty, rate) {
    const dx = tx - hand.x, dy = ty - hand.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const st = rate * TICK_MS / 1000;
    if (d <= st || rate >= MALLET_MAX) { hand.x = tx; hand.y = ty; } else { hand.x += dx / d * st; hand.y += dy / d * st; }
  }

  return {
    onTv: function (m) {
      if (stopped) return;
      if (m.t === 'hs') {
        // Copy what it needs (messages are read-only and shared)
        const st = seen.fill(ctx.now());
        st.ts = m.ts; st.ph = m.ph; st.r = m.r;
        for (let i = 0; i < 4; i++) { st.p[i] = m.p[i]; st.m[i] = m.m[i]; }
        latest = st;
        if (side >= 0 && !hand.set) { hand.x = mx(st.m[side * 2]); hand.y = st.m[side * 2 + 1]; hand.set = true; }
      } else if (m.t === 'hmeta') {
        meta = { phase: m.phase, players: m.players ? m.players.slice() : [], match: m.match };
        const s = meta.players.indexOf(ctx.slot);
        if (s !== side) { side = s; hand.set = false; plan = null; swing = null; }
        if (m.phase !== 'playing') { plan = null; swing = null; }
      } else if (m.t === 'ev' && m.k === 'hit' && m.side === side + 1) {
        // Its shot is gone: a new aim error for the next one
        if (P.aimErr) aimNoise = Kit.gauss(ctx.random) * P.aimErr;
      }
    },
    onSlot: function (m) {
      if (stopped) return;
      if (m.t === 'h.you' && side >= 0 && !hand.set) {
        const x = side === 0 ? m.x * W / 2 : W - (W / 2 + m.x * W / 2);
        hand.x = x; hand.y = m.y * H; hand.set = true;
      }
    },
    tick: function () {
      if (stopped || side < 0 || !meta) return;
      const now = ctx.now();
      if (swing) {
        // Through the puck at the swing speed: where the mallet must be when this message lands (a tick later)
        const d = Math.min(swing.len, swing.V * (now + TICK_MS - swing.t0) / 1000);
        hand.x = clamp(swing.bx + swing.nx * d, X0, X1);
        hand.y = clamp(swing.by + swing.ny * d, Y0, Y1);
        if (d >= swing.len && now >= swing.until) { swing = null; think.reset(); }
        send(now);
        return;
      }
      if (think.due()) decide(now);
      if (mode === 'strike' && plan) {
        // Time to swing? (from the nearest tick)
        const tSwing = plan.tC - plan.swingT * 1000;
        if (now >= tSwing - TICK_MS / 2) {
          const m = myMallet();
          const atB = Math.abs(m.x - plan.bx) + Math.abs(m.y - plan.by) < 40;
          // Late to the wind-up point: the swing starts where the mallet is
          const bx = atB ? plan.bx : m.x, by = atB ? plan.by : m.y;
          const len = Math.max(0, (plan.cx - bx) * plan.nx + (plan.cy - by) * plan.ny) + FOLLOW;
          swing = { bx: bx, by: by, nx: plan.nx, ny: plan.ny, V: plan.V, t0: atB ? tSwing : now, len: len, until: plan.tC + 120 };
          lastShot = { at: now, tC: plan.tC, kind: plan.kind, px: plan.px, py: plan.py, nx: plan.nx, ny: plan.ny, ax: plan.ax, ay: plan.ay, atB: atB, side: side };
          plan = null; mode = 'home';
          const d = Math.min(swing.len, swing.V * (now + TICK_MS - swing.t0) / 1000);
          hand.x = clamp(bx + swing.nx * d, X0, X1);
          hand.y = clamp(by + swing.ny * d, Y0, Y1);
          send(now);
          return;
        }
        // Waypoint reached: straight to the wind-up point
        if (plan.wp) {
          const m = myMallet();
          if (Math.abs(m.x - plan.wp.x) + Math.abs(m.y - plan.wp.y) < 30) { plan.wp = null; desired = { x: plan.bx, y: plan.by, rate: P.speed }; }
        }
      }
      moveHand(desired.x, desired.y, desired.rate);
      send(now);
    },
    stop: function () { stopped = true; plan = null; swing = null; seen.clear(); },
    // For tests: what it is doing
    debug: function () { return { mode: mode, plan: plan, swing: swing, lastShot: lastShot, side: side, stopped: stopped }; }
  };
}

module.exports = { create: create, LEVELS: LEVELS, predict: predict, shotNormal: shotNormal, NMAX: NMAX, DTP: DTP };
