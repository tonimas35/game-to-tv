'use strict';
/*
 * «Tanques»: the physics, with no hub and no clock (pure functions, tested
 * in test/tanques.test.js).
 *
 * - Tanks are circles. Against the walls: circle vs AABB, pushed out along
 *   the shortest way (a few passes, so corners work). Tank vs tank: pushed
 *   apart half and half.
 * - Bullets are points against the walls grown by the bullet radius. Each
 *   step is a swept segment vs AABB test (slabs): the earliest wall hit is
 *   found, the bullet goes there, the velocity is mirrored on that face (both
 *   axes in a corner) and the rest of the step goes on in the new direction.
 *   A bullet never goes through a wall, however thin or fast.
 * - Bullets vs tanks: swept segment vs circle on every piece of the path,
 *   only if the tank is hit before the next wall.
 * - The arena edges are 4 extra walls just outside (`edge: true`).
 */

const TANK_R = 26;
const BULLET_R = 5;
const C = {
  TANK_R: TANK_R,
  TANK_SPEED: 230,      // units/s forwards
  TANK_BACK: 160,       // backwards (buttons mode)
  TURN_SPEED: 3.4,      // rad/s
  BULLET_R: BULLET_R,
  BULLET_SPEED: 600,
  BULLET_LIFE: 6,       // s
  MAX_BOUNCES: 5,       // the 6th wall it touches removes it
  MUZZLE: TANK_R + BULLET_R + 3   // the bullet starts this far from the centre of its tank
};

const TAU = Math.PI * 2;
function wrapAngle(a) {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}
function angleDiff(to, from) { return wrapAngle(to - from); }

/** A world: the layout walls plus the 4 edges of the arena. */
function makeWorld(layout, w, h) {
  const E = 400;
  const edges = [
    { x0: -E, y0: -E, x1: w + E, y1: 0, edge: true },
    { x0: -E, y0: h, x1: w + E, y1: h + E, edge: true },
    { x0: -E, y0: -E, x1: 0, y1: h + E, edge: true },
    { x0: w, y0: -E, x1: w + E, y1: h + E, edge: true }
  ];
  return { w: w, h: h, walls: layout.walls.concat(edges), layout: layout };
}

/*
 * Swept point (x, y) + t·(dx, dy), t in [0, 1], against box b grown by r.
 * Returns { t, nx, ny } for the first contact (nx/ny: the axis of the face
 * that was hit, both in an exact corner) or null. A point already inside the
 * box (or on its face moving away) gets null.
 */
function sweepBox(x, y, dx, dy, b, r) {
  const x0 = b.x0 - r, y0 = b.y0 - r, x1 = b.x1 + r, y1 = b.y1 + r;
  let tinX = -Infinity, toutX = Infinity, tinY = -Infinity, toutY = Infinity;
  if (dx === 0) {
    if (x <= x0 || x >= x1) return null;
  } else {
    const a = (x0 - x) / dx, c = (x1 - x) / dx;
    tinX = Math.min(a, c);
    toutX = Math.max(a, c);
  }
  if (dy === 0) {
    if (y <= y0 || y >= y1) return null;
  } else {
    const a = (y0 - y) / dy, c = (y1 - y) / dy;
    tinY = Math.min(a, c);
    toutY = Math.max(a, c);
  }
  const tin = Math.max(tinX, tinY);
  const tout = Math.min(toutX, toutY);
  if (tin > tout || tout <= 1e-12 || tin > 1 || tin < -1e-9) return null;
  const EPS = 1e-9;
  const hx = tinX >= tinY - EPS;
  const hy = tinY >= tinX - EPS;
  return { t: Math.max(0, tin), nx: hx ? 1 : 0, ny: hy ? 1 : 0, wall: b };
}

/** First t in [0, 1] where the segment touches the circle (c, rr); 0 if it starts inside. */
function sweepCircle(px, py, dx, dy, cx, cy, rr) {
  const fx = px - cx, fy = py - cy;
  const c = fx * fx + fy * fy - rr * rr;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy;
  if (a === 0) return null;
  const b = fx * dx + fy * dy;
  if (b >= 0) return null;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / a;
  return t <= 1 ? t : null;
}

/**
 * Moves bullet b for dt seconds. tanks: [{ id, x, y, alive }].
 * b: { x, y, vx, vy, bounces, owner, safe } (safe: does not hit its owner yet).
 * onBounce(x, y) is called on every bounce.
 * Returns null (still flying), { tank } (it hit that tank; it stops at the
 * contact point) or { gone: true, x, y } (bounce limit reached on a wall).
 */
function moveBullet(world, b, dt, tanks, onBounce) {
  let rem = 1;
  const rr = C.TANK_R + C.BULLET_R;
  for (let iter = 0; iter < 10 && rem > 1e-9; iter++) {
    const dx = b.vx * dt * rem;
    const dy = b.vy * dt * rem;
    let best = null;
    for (let i = 0; i < world.walls.length; i++) {
      const h = sweepBox(b.x, b.y, dx, dy, world.walls[i], C.BULLET_R);
      if (h && (!best || h.t < best.t)) best = h;
    }
    const limit = best ? best.t : 1;
    let hitTank = null, hitT = Infinity;
    for (let k = 0; k < tanks.length; k++) {
      const tk = tanks[k];
      if (!tk.alive || (b.safe && tk.id === b.owner)) continue;
      const t = sweepCircle(b.x, b.y, dx, dy, tk.x, tk.y, rr);
      if (t !== null && t <= limit && t < hitT) { hitT = t; hitTank = tk; }
    }
    if (hitTank) {
      b.x += dx * hitT;
      b.y += dy * hitT;
      return { tank: hitTank };
    }
    if (!best) {
      b.x += dx;
      b.y += dy;
      return null;
    }
    b.x += dx * best.t;
    b.y += dy * best.t;
    if (b.bounces >= C.MAX_BOUNCES) return { gone: true, x: b.x, y: b.y };
    b.bounces++;
    if (best.nx) b.vx = -b.vx;
    if (best.ny) b.vy = -b.vy;
    if (onBounce) onBounce(b.x, b.y);
    rem *= (1 - best.t);
  }
  return null;
}

/** Pushes a circle out of every wall (a few passes for corners). */
function pushOutOfWalls(world, t, r) {
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let i = 0; i < world.walls.length; i++) {
      const w = world.walls[i];
      const qx = Math.max(w.x0, Math.min(t.x, w.x1));
      const qy = Math.max(w.y0, Math.min(t.y, w.y1));
      const dx = t.x - qx, dy = t.y - qy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2);
        t.x += dx / d * (r - d);
        t.y += dy / d * (r - d);
      } else {
        // Centre inside the box: out through the nearest face
        const l = t.x - w.x0, rt = w.x1 - t.x, tp = t.y - w.y0, bt = w.y1 - t.y;
        const m = Math.min(l, rt, tp, bt);
        if (m === l) t.x = w.x0 - r;
        else if (m === rt) t.x = w.x1 + r;
        else if (m === tp) t.y = w.y0 - r;
        else t.y = w.y1 + r;
      }
      moved = true;
    }
    if (!moved) break;
  }
}

/**
 * Drives a tank for dt with its input:
 *   { mode: 's', a, m }          stick: turn towards angle a, drive while pushed (m 0..1)
 *   { mode: 'k', turn, drive }   buttons: turn -1/0/1, drive -1/0/1 (tank controls)
 */
function driveTank(world, t, inp, dt) {
  let speed = 0;
  if (inp && inp.mode === 's' && inp.m > 0) {
    const maxTurn = C.TURN_SPEED * dt;
    const diff = angleDiff(inp.a, t.a);
    t.a = wrapAngle(t.a + Math.max(-maxTurn, Math.min(maxTurn, diff)));
    const left = angleDiff(inp.a, t.a);
    // Facing more or less that way: drive (slower while still turning)
    if (Math.abs(left) < Math.PI / 2) speed = C.TANK_SPEED * inp.m * Math.cos(left);
  } else if (inp && inp.mode === 'k') {
    t.a = wrapAngle(t.a + inp.turn * C.TURN_SPEED * dt);
    speed = inp.drive > 0 ? C.TANK_SPEED : (inp.drive < 0 ? -C.TANK_BACK : 0);
  }
  if (speed !== 0) {
    t.x += Math.cos(t.a) * speed * dt;
    t.y += Math.sin(t.a) * speed * dt;
  }
  pushOutOfWalls(world, t, C.TANK_R);
}

/** Two tanks never overlap: each one moves back half the overlap. */
function separateTanks(world, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  const min = C.TANK_R * 2;
  if (d2 >= min * min) return false;
  const d = Math.sqrt(d2) || 1e-6;
  const push = (min - d) / 2;
  const ux = d2 ? dx / d : 1, uy = d2 ? dy / d : 0;
  a.x -= ux * push; a.y -= uy * push;
  b.x += ux * push; b.y += uy * push;
  pushOutOfWalls(world, a, C.TANK_R);
  pushOutOfWalls(world, b, C.TANK_R);
  return true;
}

/** Is there a straight, clear line (as wide as a bullet) between two points? */
function lineOfSight(world, ax, ay, bx, by, r) {
  r = r == null ? C.BULLET_R : r;
  for (let i = 0; i < world.walls.length; i++) {
    if (sweepBox(ax, ay, bx - ax, by - ay, world.walls[i], r)) return false;
  }
  return true;
}

module.exports = {
  C: C, wrapAngle: wrapAngle, angleDiff: angleDiff, makeWorld: makeWorld,
  sweepBox: sweepBox, sweepCircle: sweepCircle, moveBullet: moveBullet,
  pushOutOfWalls: pushOutOfWalls, driveTank: driveTank, separateTanks: separateTanks,
  lineOfSight: lineOfSight
};
