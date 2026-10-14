'use strict';
/*
 * «Tanques»: the computer opponent («Rivales bot», see docs/crear-un-juego.md).
 * Reference bot for the contract: create(ctx) -> { onTv, onSlot, tick, stop }.
 *
 * It sees what a person sees (kmeta and the 30 Hz k.s state of the TV) and
 * plays with the phone messages (k.in stick/buttons, k.fire). The walls are
 * the ones the TV draws (layouts.js) and the physics is sim.js, so its
 * bullet traces are the real ones.
 *
 * Every tick (60 Hz), in this order:
 *   1. Dodge: the bullets on screen are traced (with bounces) for a short
 *      horizon; if one hits the tank as it moves now, it tries 15 manoeuvres
 *      (reverse, forward, turning, the stick in 8 directions, stop) and keeps
 *      the safest one for a moment.
 *   2. Fire: the barrel AS IT IS NOW is traced (analytically: wall to wall,
 *      no stepping), aiming at where the enemy will be; it fires if that
 *      bullet hits the enemy before itself.
 *   3. Aim: an angle search (coarse 2° steps, then 0.2° around the best
 *      window), spread over several ticks with a fixed budget of traces per
 *      tick, finds a direct or bouncing shot; fine aiming uses the stick with
 *      little push (the tank turns exactly to the angle while creeping) in
 *      short pulses.
 *   4. Move: BFS over the arena cells (links precomputed once per round,
 *      a row per tick during the countdown) towards the goal of its mode:
 *      attack (most of the time), flank (sometimes) or retreat (outgunned).
 *
 * Levels (ctx.level): reaction time, thinking rate, aim noise, how many
 * bounces it plans, leading the target, time between shots, how often it
 * dodges and how far ahead it looks. See LEVELS.
 */
const Sim = require('./sim');
const Layouts = require('./layouts');
const Kit = require('../bot-kit');

const C = Sim.C;
const RR = C.TANK_R + C.BULLET_R;
const COARSE = 2 * Math.PI / 180;
const FINE = 0.2 * Math.PI / 180;
// The stick sends angles rounded to 0.01 rad (like a phone): a window of
// angles that hit narrower than this is not a real shot
const MIN_WINDOW = 0.012;
// A planned shot must pass at least this much further from its own tank (it
// keeps moving for a tick or two after it decides, and the state it sees is a
// tick or two old)
const SELF_PAD = 14;

/*
 * react: seconds the bot sees late (the enemy and the bullets; its own tank it knows)
 * think: seconds between strategy decisions (mode, path) and new aim searches
 * noise: its hand is not perfect: the barrel ends up this far (radians,
 *        deviation; a new error for every plan) from where it wants it, and
 *        it does not notice (it fires believing it is on target)
 * verify: it fires only if the trace of the barrel hits (else: when it points where it planned)
 * tol: …and it also hits this much (radians) to each side
 * ammo: bullets of its own it lets fly at once (the game allows 4: it keeps some to spare)
 * bounces: walls a planned shot may bounce on (0 = only straight shots)
 * lead: how much it aims ahead of a moving enemy (0..1)
 * gap: seconds between its shots (the game allows one every 0.25 s)
 * dodge: chance of noticing each bullet that would hit it
 * horizon: seconds ahead it looks for bullets
 * margin: extra distance it keeps from bullets
 * budget: bullet traces per tick for the aim search (CPU: the TV runs this)
 * maxT: the longest shot it plans (seconds of flight)
 * flank / retreat: whether it uses those modes
 */
const LEVELS = {
  facil: { react: 0.32, think: 0.45, noise: 0.07, verify: false, ammo: 2, bounces: 0, lead: 0, gap: 0.9, dodge: 0.15, horizon: 0.45, margin: 0, budget: 6, maxT: 1.2, flank: false, retreat: 0.2, speed: 0.75 },
  normal: { react: 0.16, think: 0.16, noise: 0.015, verify: true, tol: 0.004, ammo: 3, bounces: 2, lead: 0.3, gap: 0.33, dodge: 0.7, horizon: 0.65, margin: 2, budget: 12, maxT: 1.6, flank: true, retreat: 0.6, speed: 0.85 },
  dificil: { react: 0.09, think: 0.1, noise: 0.006, verify: true, tol: 0.004, ammo: 3, bounces: 2, lead: 0.7, gap: 0.28, dodge: 0.9, horizon: 0.8, margin: 4, budget: 18, maxT: 2.6, flank: true, retreat: 0.85, speed: 1 },
  imposible: { react: 0.04, think: 0.06, noise: 0, verify: true, tol: 0.003, ammo: 3, bounces: 3, lead: 1, gap: 0.25, dodge: 1, horizon: 0.95, margin: 6, budget: 24, maxT: 3.5, flank: true, retreat: 1, speed: 1 }
};

// ---------------------------------------------------------------- geometry (no state)

/**
 * Traces a bullet fired from (x, y) at angle a, wall to wall (the same
 * sweeps as sim.js, but one per segment instead of one per tick).
 * Returns { t, bounces } if it hits `en` first, { self: true, t } if it comes
 * near `me` first (after its first bounce, with SELF_PAD to spare), or null
 * (it misses within maxT).
 */
function trace(world, x, y, a, en, me, maxBounces, maxT) {
  let vx = Math.cos(a) * C.BULLET_SPEED, vy = Math.sin(a) * C.BULLET_SPEED;
  let t = 0, bounces = 0;
  const walls = world.walls;
  for (let seg = 0; seg <= C.MAX_BOUNCES; seg++) {
    const rem = maxT - t;
    if (rem <= 0) return null;
    const dx = vx * rem, dy = vy * rem;
    let best = null;
    for (let i = 0; i < walls.length; i++) {
      const h = Sim.sweepBox(x, y, dx, dy, walls[i], C.BULLET_R);
      if (h && (!best || h.t < best.t)) best = h;
    }
    const lim = best ? best.t : 1;
    const te = en ? Sim.sweepCircle(x, y, dx, dy, en.x, en.y, RR) : null;
    const ts = seg > 0 && me ? Sim.sweepCircle(x, y, dx, dy, me.x, me.y, RR + SELF_PAD) : null;
    if (te !== null && te <= lim && (ts === null || te <= ts)) return { t: t + te * rem, bounces: bounces };
    if (ts !== null && ts <= lim) return { self: true, t: t + ts * rem };
    if (!best) return null;
    x += dx * best.t;
    y += dy * best.t;
    t += best.t * rem;
    if (bounces >= C.MAX_BOUNCES || bounces >= maxBounces) return null;
    bounces++;
    if (best.nx) vx = -vx;
    if (best.ny) vy = -vy;
  }
  return null;
}

/** A bullet's path for the next `horizon` s: [{ x, y, vx, vy, t0, t1 }] (bounces included). */
function bulletPath(world, x, y, vx, vy, horizon) {
  const out = [];
  let t = 0;
  for (let seg = 0; seg <= C.MAX_BOUNCES && t < horizon; seg++) {
    const rem = horizon - t;
    const dx = vx * rem, dy = vy * rem;
    let best = null;
    for (let i = 0; i < world.walls.length; i++) {
      const h = Sim.sweepBox(x, y, dx, dy, world.walls[i], C.BULLET_R);
      if (h && (!best || h.t < best.t)) best = h;
    }
    const t1 = best ? t + best.t * rem : horizon;
    out.push({ x: x, y: y, vx: vx, vy: vy, t0: t, t1: t1 });
    if (!best) break;
    x += dx * best.t;
    y += dy * best.t;
    t = t1;
    if (best.nx) vx = -vx;
    if (best.ny) vy = -vy;
  }
  return out;
}

/** Walls near a point (a small world for cheap tank kinematics). */
function nearWorld(world, x, y, r) {
  const walls = [];
  for (let i = 0; i < world.walls.length; i++) {
    const w = world.walls[i];
    if (w.x1 >= x - r && w.x0 <= x + r && w.y1 >= y - r && w.y0 <= y + r) walls.push(w);
  }
  return { w: world.w, h: world.h, walls: walls };
}

// ---------------------------------------------------------------- navigation (per layout)

/** Cells where a tank fits and the links between them, built a few rows per call. */
function makeNav(layoutIndex) {
  const lay = Layouts.LIST[layoutIndex];
  const world = Sim.makeWorld(lay, Layouts.W, Layouts.H);
  const COLS = Layouts.COLS, ROWS = Layouts.ROWS, CELL = Layouts.CELL;
  const N = COLS * ROWS;
  const pass = new Uint8Array(N);
  const links = [];           // per cell: [neighbour index, cost, …]
  let row = 0, linkRow = 0;
  function centre(k) { return { x: (k % COLS + 0.5) * CELL, y: (Math.floor(k / COLS) + 0.5) * CELL }; }
  const nav = {
    layout: layoutIndex, world: world, ready: false, pass: pass, links: links, COLS: COLS, ROWS: ROWS, CELL: CELL, centre: centre,
    // Builds `rows` rows (passable cells first, then links); true when done
    build: function (rows) {
      for (let n = 0; n < rows && !nav.ready; n++) {
        if (row < ROWS) {
          for (let cx = 0; cx < COLS; cx++) {
            const p = centre(row * COLS + cx);
            const q = { x: p.x, y: p.y };
            Sim.pushOutOfWalls(world, q, C.TANK_R + 2);
            pass[row * COLS + cx] = Math.abs(q.x - p.x) + Math.abs(q.y - p.y) < 1 ? 1 : 0;
          }
          row++;
        } else if (linkRow < ROWS) {
          for (let cx = 0; cx < COLS; cx++) {
            const k = linkRow * COLS + cx;
            const out = [];
            if (pass[k]) {
              const a = centre(k);
              for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                  if (!dx && !dy) continue;
                  const nx = cx + dx, ny = linkRow + dy;
                  if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
                  const j = ny * COLS + nx;
                  if (!pass[j]) continue;
                  const b = centre(j);
                  if (Sim.lineOfSight(world, a.x, a.y, b.x, b.y, C.TANK_R + 1)) out.push(j, dx && dy ? 1.42 : 1);
                }
              }
            }
            links[k] = out;
          }
          linkRow++;
          if (linkRow >= ROWS) nav.ready = true;
        }
      }
      return nav.ready;
    },
    cellOf: function (x, y) {
      const cx = Math.max(0, Math.min(COLS - 1, Math.floor(x / CELL)));
      const cy = Math.max(0, Math.min(ROWS - 1, Math.floor(y / CELL)));
      return cy * COLS + cx;
    },
    // The passable cell nearest to a point (rings around its cell)
    nearestPass: function (x, y) {
      const c = nav.cellOf(x, y);
      if (pass[c]) return c;
      const cx = c % COLS, cy = Math.floor(c / COLS);
      for (let r = 1; r < Math.max(COLS, ROWS); r++) {
        let best = -1, bd = Infinity;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
            const j = ny * COLS + nx;
            if (!pass[j]) continue;
            const p = centre(j);
            const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
            if (d < bd) { bd = d; best = j; }
          }
        }
        if (best >= 0) return best;
      }
      return c;
    },
    // Distances from a goal cell to every cell (Dijkstra-ish with a plain queue: good enough on a grid)
    field: function (goal) {
      const dist = new Float32Array(N).fill(Infinity);
      const q = [goal];
      dist[goal] = 0;
      for (let h = 0; h < q.length; h++) {
        const c = q[h];
        const l = links[c] || [];
        for (let i = 0; i < l.length; i += 2) {
          const j = l[i], d = dist[c] + l[i + 1];
          if (d < dist[j] - 1e-6) { dist[j] = d; q.push(j); }
        }
      }
      return dist;
    }
  };
  return nav;
}

// ---------------------------------------------------------------- the bot

function create(ctx) {
  const P = Kit.byLevel(ctx.level, LEVELS) || LEVELS.normal;
  const random = ctx.random || Math.random;
  const input = Kit.inputSender(ctx, 400);
  const seen = Kit.delayLine(P.react * 1000, 40);   // k.s states, seen late

  let meta = null, myIdx = -1, enIdx = -1;
  let nav = null;
  let latest = null, latestAt = 0, fresh = false;  // the newest k.s (its own tank) and whether it is new
  let lastShotAt = -1e9, lastShot = null;
  let mode = 'attack', modeUntil = 0;
  let thinkAt = -1e9;
  let goalCell = -1, field = null, waypoint = null;
  let aim = null;            // planned shot: { a, t, bounces, at }
  let aimErr = 0;            // its hand error for this plan (see LEVELS.noise)
  let job = null;            // aim search in progress
  let dodge = null;          // { msg, until }
  let pulseUntil = 0, pulseRest = 0;
  const rolled = {};         // bullet id -> noticed? (rolled once per bullet)
  const stuck = { x: 0, y: 0, at: 0, until: 0, last: -1, turn: 1 };
  let stopped = false;
  let round = -1;

  function now() { return ctx.now(); }
  function secs() { return now() / 1000; }

  function onMeta(m) {
    meta = m;
    myIdx = m.tanks ? m.tanks.indexOf(ctx.slot) : -1;
    enIdx = myIdx < 0 ? -1 : 1 - myIdx;
    if (typeof m.layout === 'number' && (!nav || nav.layout !== m.layout) && Layouts.LIST[m.layout]) nav = makeNav(m.layout);
    if (m.round !== round || m.phase !== 'play') {
      if (m.round !== round) {
        round = m.round;
        seen.clear();
        aim = null; job = null; dodge = null; field = null; goalCell = -1; waypoint = null; mode = 'attack'; modeUntil = 0;
        Object.keys(rolled).forEach(function (k) { delete rolled[k]; });
      }
    }
  }

  function tankOf(st, k) {
    if (!st || !st.k || k < 0 || st.k.length < k * 4 + 4) return null;
    return { x: st.k[k * 4], y: st.k[k * 4 + 1], a: st.k[k * 4 + 2], alive: !!st.k[k * 4 + 3] };
  }

  // What it sees now: its own tank (latest), the enemy and the bullets (late)
  function view() {
    const me = tankOf(latest, myIdx);
    const pair = seen.getPair(now(), 100);
    if (!me || !pair) return null;
    const en = tankOf(pair.now, enIdx);
    const enB = tankOf(pair.before, enIdx);
    if (!en) return null;
    const dt = (pair.nowT - pair.beforeT) / 1000;
    const v = dt > 0.03 && enB ? { x: (en.x - enB.x) / dt, y: (en.y - enB.y) / dt } : { x: 0, y: 0 };
    // Where the enemy is now, for what it knows (it saw it P.react ago)
    const age = Math.max(0, (now() - pair.nowT) / 1000);
    const enNow = { x: en.x + v.x * age * P.lead, y: en.y + v.y * age * P.lead, a: en.a, alive: en.alive };
    const bullets = [];
    const B = pair.now.b || [];
    for (let i = 0; i + 5 < B.length; i += 6) bullets.push({ id: B[i], x: B[i + 1], y: B[i + 2], vx: B[i + 3], vy: B[i + 4], owner: B[i + 5], age: age });
    let mine = 0;
    const LB = latest.b || [];
    for (let i = 0; i + 5 < LB.length; i += 6) if (LB[i + 5] === ctx.slot) mine++;
    return { me: me, en: enNow, v: v, bullets: bullets, mine: mine };
  }

  // ------------------------------------------------------------ 1. dodge
  // Tank positions for a manoeuvre (dt 1/30), with the walls near it
  function motion(me, msg, horizon, small) {
    const t = { x: me.x, y: me.y, a: me.a };
    const inp = msg.s ? { mode: 's', a: msg.s[0], m: msg.s[1] } : { mode: 'k', turn: msg.k[0], drive: msg.k[1] };
    const pts = [];
    const dt = 1 / 30;
    for (let s = 0; s < Math.ceil(horizon / dt); s++) {
      Sim.driveTank(small, t, inp, dt);
      pts.push(t.x, t.y);
    }
    return pts;
  }
  // First time (s from now) a bullet path comes within RR + margin of the positions, or 0.
  // paths: [{ age, segs }]: segment times count from when the bullet was seen (age s ago)
  function hitTime(pts, paths) {
    const dt = 1 / 30;
    const lim = (RR + P.margin) * (RR + P.margin);
    for (let s = 0; s < pts.length / 2; s++) {
      const tt = (s + 1) * dt;
      const px = pts[s * 2], py = pts[s * 2 + 1];
      for (let k = 0; k < paths.length; k++) {
        const segs = paths[k].segs;
        const tau = tt + paths[k].age;
        for (let j = 0; j < segs.length; j++) {
          const g = segs[j];
          if (tau < g.t0 || tau > g.t1) continue;
          const bx = g.x + g.vx * (tau - g.t0), by = g.y + g.vy * (tau - g.t0);
          if ((bx - px) * (bx - px) + (by - py) * (by - py) < lim) return tt;
        }
      }
    }
    return 0;
  }
  const DODGES = [
    { t: 'k.in', k: [0, -1] }, { t: 'k.in', k: [0, 1] }, { t: 'k.in', k: [-1, 1] }, { t: 'k.in', k: [1, 1] },
    { t: 'k.in', k: [-1, -1] }, { t: 'k.in', k: [1, -1] }, { t: 'k.in', k: [0, 0] }
  ];
  function checkDanger(V) {
    if (!V.bullets.length) { dodge = null; return false; }
    const paths = [];
    V.bullets.forEach(function (b) {
      // Each bullet is noticed (or not) once, by level
      if (rolled[b.id] === undefined) rolled[b.id] = random() < P.dodge;
      if (!rolled[b.id]) return;
      // Its path from where it was seen (b.age s ago) to the horizon
      paths.push({ age: b.age, segs: bulletPath(nav.world, b.x, b.y, b.vx, b.vy, P.horizon + b.age) });
    });
    if (!paths.length) { dodge = null; return false; }
    const small = nearWorld(nav.world, V.me.x, V.me.y, 340);
    const cur = input.current() || { t: 'k.in', k: [0, 0] };
    // Is what it is doing now (or the dodge it is doing) safe?
    const keep = dodge && now() < dodge.until ? dodge.msg : cur;
    if (!hitTime(motion(V.me, keep, P.horizon, small), paths)) {
      if (dodge && now() >= dodge.until) dodge = null;
      return !!dodge;
    }
    // Look for the safest manoeuvre (no hit at all, or the latest hit)
    const cands = DODGES.slice();
    for (let i = 0; i < 8; i++) cands.push({ t: 'k.in', s: [Math.round(Sim.wrapAngle(i * Math.PI / 4) * 100) / 100, 1] });
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < cands.length; i++) {
      const pts = motion(V.me, cands[i], P.horizon, small);
      const h = hitTime(pts, paths);
      // Safe ones first; among them, the ones that end further from the enemy's line of fire are not
      // needed: prefer little change (reverse/forward keep the barrel where it is)
      const score = h ? h * 10 - 100 : 50 - i * 0.5;
      if (score > bestScore) { bestScore = score; best = cands[i]; }
    }
    dodge = { msg: best, until: now() + 250 };
    return true;
  }

  // ------------------------------------------------------------ 2. fire
  // Its own tank when the shot will really leave: the state it has is a tick
  // or two old and the tank goes on with the current input until then
  function predictMe(V) {
    const me = { x: V.me.x, y: V.me.y, a: V.me.a };
    const msg = input.current();
    const n = Math.max(0, Math.min(4, Math.round((now() - latestAt) / (1000 / 60))));
    if (!msg || !n) return me;
    const inp = msg.s ? { mode: 's', a: msg.s[0], m: msg.s[1] } : { mode: 'k', turn: msg.k[0], drive: msg.k[1] };
    const small = nearWorld(nav.world, me.x, me.y, 120);
    for (let i = 0; i < n; i++) Sim.driveTank(small, me, inp, 1 / 60);
    return me;
  }
  function tryFire(V) {
    const t = secs();
    if (t - lastShotAt < P.gap || V.mine >= P.ammo || !V.en.alive) return false;
    const me = predictMe(V);
    // The same shot again (same place, same angle) while the last one is still on its way: no
    if (lastShot && t < lastShot.until && Math.abs(Sim.angleDiff(me.a, lastShot.a)) < 0.04 && Math.hypot(me.x - lastShot.x, me.y - lastShot.y) < 80) return false;
    let ok = false, flight = 0;
    if (P.verify) {
      // Where the enemy will be when the bullet gets there, with the barrel
      // where it believes it is (off by its hand error)
      const believed = me.a - aimErr;
      let target = V.en;
      let r = trace(nav.world, me.x, me.y, believed, target, me, P.bounces, P.maxT);
      if (r && !r.self && P.lead > 0 && (V.v.x || V.v.y)) {
        target = { x: V.en.x + V.v.x * r.t * P.lead, y: V.en.y + V.v.y * r.t * P.lead };
        r = trace(nav.world, me.x, me.y, believed, target, me, P.bounces, P.maxT);
      }
      // A shot that only hits by a hair is not taken: a little to each side must hit too
      if (r && !r.self) {
        const r1 = trace(nav.world, me.x, me.y, believed - P.tol, target, me, P.bounces, P.maxT);
        const r2 = r1 && !r1.self ? trace(nav.world, me.x, me.y, believed + P.tol, target, me, P.bounces, P.maxT) : null;
        if (!r2 || r2.self) r = null;
      }
      // …but its own bullet must never come back at it (that it does see)
      if (r && !r.self && aimErr) {
        const real = trace(nav.world, me.x, me.y, me.a, null, me, P.bounces + 1, Math.min(1.2, P.maxT));
        if (real && real.self) r = null;
      }
      ok = !!(r && !r.self);
      flight = r ? r.t : 0;
    } else if (aim) {
      // It fires when the barrel points where it planned (unless that shot comes back to it)
      ok = Math.abs(Sim.angleDiff(aim.a + aimErr, me.a)) < 0.035;
      if (ok) {
        const r = trace(nav.world, me.x, me.y, me.a, null, me, 3, 2);
        if (r && r.self) ok = false;
      }
    }
    if (!ok) return false;
    ctx.send({ t: 'k.fire' });
    lastShotAt = t;
    lastShot = { x: me.x, y: me.y, a: me.a, until: t + Math.min(1.5, flight || 0.8) };
    aim = null;
    job = null;
    return true;
  }

  // ------------------------------------------------------------ 3. aim (a search spread over ticks)
  function startJob(V) {
    const lead = P.lead * 0.25;
    const target = { x: V.en.x + V.v.x * lead, y: V.en.y + V.v.y * lead };
    job = { x: V.me.x, y: V.me.y, a: V.me.a, en: target, i: 0, n: Math.round(2 * Math.PI / COARSE), best: null, fine: null, at: now() };
    // A straight shot is the first thing to try (and the only one with 0 bounces)
    if (Sim.lineOfSight(nav.world, V.me.x, V.me.y, target.x, target.y, C.BULLET_R)) {
      const a = Math.atan2(target.y - V.me.y, target.x - V.me.x);
      const r = trace(nav.world, V.me.x, V.me.y, a, target, V.me, 0, P.maxT);
      if (r && !r.self) job.best = { a: a, t: r.t, bounces: 0, cost: cost(a, r) };
    }
    if (P.bounces === 0) finishJob();
  }
  function cost(a, r) {
    return Math.abs(Sim.angleDiff(a, job.a)) / C.TURN_SPEED + r.t * 0.6 + r.bounces * 0.15;
  }
  function stepJob() {
    let budget = P.budget;
    while (job && budget > 0) {
      if (!job.fine) {
        if (job.i >= job.n) { startFine(); continue; }
        const i = job.i++;
        const off = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * COARSE;
        // Turning further than the best plan costs more than it: stop here
        if (job.best && Math.abs(off) / C.TURN_SPEED > job.best.cost) { job.i = job.n; continue; }
        const a = Sim.wrapAngle(job.a + off);
        const r = trace(nav.world, job.x, job.y, a, job.en, job, P.bounces, P.maxT);
        budget--;
        if (!r || r.self) continue;
        const c = cost(a, r);
        if (!job.best || c < job.best.cost) job.best = { a: a, t: r.t, bounces: r.bounces, cost: c };
      } else {
        // Fine: the edges of the window of angles that hit, then aim at its middle
        const f = job.fine;
        const side = f.lo > -12 && !f.loDone ? -1 : (f.hi < 12 && !f.hiDone ? 1 : 0);
        if (!side) { finishJob(); break; }
        const k = side < 0 ? f.lo - 1 : f.hi + 1;
        const r = trace(nav.world, job.x, job.y, job.best.a + k * FINE, job.en, job, P.bounces, P.maxT);
        budget--;
        if (r && !r.self) { if (side < 0) f.lo = k; else f.hi = k; } else if (side < 0) f.loDone = true; else f.hiDone = true;
      }
    }
  }
  function startFine() {
    if (!job.best) { finishJob(); return; }
    job.fine = { lo: 0, hi: 0, loDone: false, hiDone: false };
  }
  function finishJob() {
    const f = job && job.fine;
    // Too narrow to hit with a stick: no shot from here (it keeps moving)
    if (f && (f.hi - f.lo + 1) * FINE < MIN_WINDOW) job.best = null;
    if (job && job.best) {
      let a = job.best.a + (f ? (f.lo + f.hi) / 2 * FINE : 0);
      aimErr = P.noise ? Kit.gauss(random) * P.noise : 0;
      aim = { a: Sim.wrapAngle(a), t: job.best.t, bounces: job.best.bounces, at: now() };
    } else aim = null;
    job = null;
  }

  // ------------------------------------------------------------ 4. move
  function chooseMode(V) {
    const t = secs();
    let enemyBullets = 0;
    V.bullets.forEach(function (b) { if (b.owner !== ctx.slot) enemyBullets++; });
    // Outgunned: all its bullets are out, or the enemy has several flying and it has no shot
    const outgunned = V.mine >= P.ammo || (enemyBullets >= 2 && enemyBullets > V.mine && !aim);
    if (mode !== 'retreat' && outgunned && random() < P.retreat) {
      mode = 'retreat'; modeUntil = t + 0.8 + random() * 0.8;
    } else if (t >= modeUntil) {
      if (P.flank && random() < 0.22) { mode = 'flank'; modeUntil = t + 2 + random() * 1.5; }
      else { mode = 'attack'; modeUntil = t + 2 + random() * 2; }
    }
  }
  function goalOf(V) {
    let g;
    if (mode === 'retreat') g = { x: Layouts.W - V.en.x, y: Layouts.H - V.en.y };
    else if (mode === 'flank') {
      const ang = Math.atan2(V.me.y - V.en.y, V.me.x - V.en.x) + Math.PI / 2;
      g = { x: V.en.x + Math.cos(ang) * 320, y: V.en.y + Math.sin(ang) * 320 };
    } else g = { x: V.en.x, y: V.en.y };
    g.x = Math.max(40, Math.min(Layouts.W - 40, g.x));
    g.y = Math.max(40, Math.min(Layouts.H - 40, g.y));
    return g;
  }
  function plan(V) {
    chooseMode(V);
    const goal = goalOf(V);
    const gc = nav.nearestPass(goal.x, goal.y);
    if (gc !== goalCell || !field) { goalCell = gc; field = nav.field(gc); }
    // Next cell downhill from where it is, then the furthest one (up to 4) in a straight line
    let c = nav.cellOf(V.me.x, V.me.y);
    if (!(field[c] < Infinity)) {
      // Not on a linked cell (against a wall): the best neighbour it can drive to
      let best = -1, bd = Infinity;
      const cx = c % nav.COLS, cy = Math.floor(c / nav.COLS);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= nav.COLS || ny >= nav.ROWS) continue;
        const j = ny * nav.COLS + nx;
        if (!(field[j] < bd)) continue;
        const p = nav.centre(j);
        if (Sim.lineOfSight(nav.world, V.me.x, V.me.y, p.x, p.y, C.TANK_R - 2)) { bd = field[j]; best = j; }
      }
      waypoint = best >= 0 ? nav.centre(best) : goal;
      return;
    }
    const steps = [];
    for (let s = 0; s < 4; s++) {
      const l = nav.links[c] || [];
      let next = -1, nd = field[c];
      for (let i = 0; i < l.length; i += 2) if (field[l[i]] < nd) { nd = field[l[i]]; next = l[i]; }
      if (next < 0) break;
      steps.push(next);
      c = next;
    }
    if (!steps.length) { waypoint = goal; return; }
    waypoint = nav.centre(steps[0]);
    for (let i = steps.length - 1; i > 0; i--) {
      const p = nav.centre(steps[i]);
      if (Sim.lineOfSight(nav.world, V.me.x, V.me.y, p.x, p.y, C.TANK_R + 1)) { waypoint = p; break; }
    }
  }

  function stickTo(a, m) { return { t: 'k.in', s: [Math.round(Sim.wrapAngle(a) * 100) / 100, Math.round(m * 20) / 20] }; }
  const IDLE = { t: 'k.in', k: [0, 0] };

  function play(dt) {
    const V = view();
    if (!V || !V.me.alive) { input.set(IDLE); return; }
    const t = secs();
    if (fresh) {
      fresh = false;
      if (checkDanger(V)) { input.set(dodge.msg); return; }
    } else if (dodge && now() < dodge.until) { input.set(dodge.msg); return; }

    if (tryFire(V)) { input.set(IDLE); return; }

    // Strategy and a new aim search every P.think seconds (the search goes on over the next ticks)
    if (t - thinkAt >= P.think) {
      thinkAt = t;
      plan(V);
      if (!job) startJob(V);
    }
    if (job) stepJob();

    // Aim: turn to the planned angle if it is not far (pulses of stick with little push)
    if (aim && t - aim.at / 1000 < 0.6 && aim.t <= P.maxT) {
      const want = aim.a + aimErr;
      const diff = Sim.angleDiff(want, V.me.a);
      if (Math.abs(diff) < Math.PI / 3) {
        if (Math.abs(diff) < 0.006) {
          // Pointing where it planned: wait still for the shot (or for a better plan)
          input.set(IDLE);
          if (P.verify) aim.at = Math.min(aim.at, now() - 300);   // the plan was not good enough: re-plan soon
          return;
        }
        if (t < pulseUntil) { input.set(stickTo(want, 0.3)); return; }
        if (t < pulseRest) { input.set(IDLE); return; }
        // A pulse long enough to get there (the tank turns exactly to the angle and stops turning)
        const turn = Math.abs(diff) / C.TURN_SPEED;
        pulseUntil = t + Math.max(1 / 60, Math.min(0.25, turn + 1 / 60));
        pulseRest = pulseUntil + (Math.abs(diff) < 0.12 ? 0.05 : 0);
        input.set(stickTo(want, 0.3));
        return;
      }
    }

    // Move
    if (!waypoint) plan(V);
    // Stuck against something while driving: back up a little
    if (t - stuck.last > 0.1) { stuck.x = V.me.x; stuck.y = V.me.y; stuck.at = t; }   // it was doing something else
    stuck.last = t;
    if (t >= stuck.until) {
      if (Math.hypot(V.me.x - stuck.x, V.me.y - stuck.y) > 12) { stuck.x = V.me.x; stuck.y = V.me.y; stuck.at = t; }
      else if (t - stuck.at > 1.2) { stuck.until = t + 0.35; stuck.at = t + 0.35; stuck.turn = random() < 0.5 ? -1 : 1; }
    }
    if (t < stuck.until) { input.set({ t: 'k.in', k: [stuck.turn, -1] }); return; }
    const dist = Math.hypot(V.en.x - V.me.x, V.en.y - V.me.y);
    const close = mode === 'attack' && dist < 200;
    const a = Math.atan2(waypoint.y - V.me.y, waypoint.x - V.me.x);
    if (Math.hypot(waypoint.x - V.me.x, waypoint.y - V.me.y) < 14) { waypoint = null; input.set(IDLE); return; }
    input.set(stickTo(a, close ? 0.3 : P.speed));
    void dt;
  }

  return {
    onTv: function (m) {
      if (stopped || !m) return;
      if (m.t === 'k.s') {
        seen.push(now(), m);
        latest = m;
        latestAt = now();
        fresh = true;
      } else if (m.t === 'kmeta') onMeta(m);
    },
    onSlot: function (m) {
      if (stopped || !m) return;
      if (m.t === 'kmeta') onMeta(m);
    },
    tick: function (dt) {
      if (stopped || !meta) return;
      // The arena's cells and links: a row per tick until done (the countdown is enough)
      if (nav && !nav.ready) nav.build(1);
      const playing = meta.phase === 'play' && !meta.paused && myIdx >= 0 && nav && nav.ready && latest && now() - latestAt < 1000;
      if (!playing) {
        if (myIdx >= 0 && meta.phase !== 'end') input.set(IDLE);
        aim = null; job = null; dodge = null;
        return;
      }
      play(dt);
      input.tick();
    },
    stop: function () { stopped = true; },
    // For tests
    _debug: function () { return { mode: mode, aim: aim, job: !!job, dodge: !!dodge, waypoint: waypoint, level: ctx.level }; }
  };
}

module.exports = { create: create, LEVELS: LEVELS, trace: trace, bulletPath: bulletPath, makeNav: makeNav };
