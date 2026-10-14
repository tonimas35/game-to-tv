'use strict';
/*
 * «Sumo»: the physics, as plain functions (server side, Node 12).
 *
 * Coordinates are the TV stage (1920x1080). The ring (dohyo) is a circle
 * centred at (CX, CY) whose radius starts at R0 and, after SHRINK_START
 * seconds of play, shrinks by SHRINK_RATE px/s (420 -> 0 at 31 s), so a
 * round rarely lasts more than 20-30 s.
 *
 * A wrestler is a heavy ball: the joystick gives an acceleration, and two
 * kinds of friction slow it down: a drag proportional to the speed (top speed
 * about 560 px/s) and a constant one that stops it completely. Collisions
 * between the two balls are elastic impulses with masses, so momentum goes
 * from one to the other. The «embestida» (dash) is a burst of speed and, for
 * DASH_TIME seconds, a much higher mass: the other one flies.
 *
 * A wrestler is out of the ring when its centre goes past the edge.
 */

const P = {
  CX: 960,
  CY: 612,
  R0: 420,               // ring radius at the start of a round
  BALL_R: 60,
  ACCEL: 1500,           // px/s² with the joystick at full tilt
  DRAG: 2.4,             // 1/s (speed-proportional friction)
  FRICTION: 160,         // px/s² (constant friction: the ball really stops)
  DEADZONE: 0.12,
  MASS: 1,
  DASH_MASS: 2.5,        // mass while dashing
  DASH_SPEED: 850,       // px/s added in the dash direction
  DASH_TIME: 0.35,       // s with the extra mass (and less drag)
  DASH_DRAG: 0.8,
  DASH_COOLDOWN: 2,      // s
  RESTITUTION: 0.9,
  SHRINK_START: 10,      // s of play before the ring starts to shrink
  SHRINK_RATE: 20        // px/s: 420 -> 0 at 31 s
};

/** The ring radius after `t` seconds of play. */
function ringRadius(t) {
  if (t <= P.SHRINK_START) return P.R0;
  return Math.max(0, P.R0 - (t - P.SHRINK_START) * P.SHRINK_RATE);
}

function makeWrestler(x, y, face) {
  return { x: x, y: y, vx: 0, vy: 0, ix: 0, iy: 0, face: face || 0, dash: 0, cd: 0, out: false };
}

/** The two wrestlers at the start of a round: on opposite sides, facing each other. */
function startPositions() {
  const d = P.R0 * 0.5;
  return [makeWrestler(P.CX - d, P.CY, 0), makeWrestler(P.CX + d, P.CY, Math.PI)];
}

/** Joystick input: clamped to the unit circle, with a small dead zone. */
function setInput(w, x, y) {
  x = Number(x); y = Number(y);
  if (!isFinite(x) || !isFinite(y)) { x = 0; y = 0; }
  const m = Math.sqrt(x * x + y * y);
  if (m < P.DEADZONE) { w.ix = 0; w.iy = 0; return; }
  if (m > 1) { x /= m; y /= m; }
  w.ix = x;
  w.iy = y;
}

function massOf(w) { return w.dash > 0 ? P.DASH_MASS : P.MASS; }

/** Dash in the joystick direction (or where it is looking). false while cooling down. */
function tryDash(w) {
  if (w.cd > 0 || w.out) return false;
  const m = Math.sqrt(w.ix * w.ix + w.iy * w.iy);
  let dx, dy;
  if (m > 0.2) { dx = w.ix / m; dy = w.iy / m; } else { dx = Math.cos(w.face); dy = Math.sin(w.face); }
  w.vx = w.vx * 0.35 + dx * P.DASH_SPEED;
  w.vy = w.vy * 0.35 + dy * P.DASH_SPEED;
  w.face = Math.atan2(dy, dx);
  w.dash = P.DASH_TIME;
  w.cd = P.DASH_COOLDOWN;
  return true;
}

/** Timers, looking direction, and (when `move`) acceleration, friction and position. */
function stepWrestler(w, dt, move) {
  if (w.dash > 0) w.dash = Math.max(0, w.dash - dt);
  if (w.cd > 0) w.cd = Math.max(0, w.cd - dt);
  const im = Math.sqrt(w.ix * w.ix + w.iy * w.iy);
  if (!move) {
    if (im > 0.2 && !w.out) w.face = Math.atan2(w.iy, w.ix);
    return;
  }
  if (!w.out) {
    w.vx += w.ix * P.ACCEL * dt;
    w.vy += w.iy * P.ACCEL * dt;
  }
  const k = Math.exp(-(w.dash > 0 ? P.DASH_DRAG : P.DRAG) * dt);
  w.vx *= k;
  w.vy *= k;
  let sp = Math.sqrt(w.vx * w.vx + w.vy * w.vy);
  const dec = P.FRICTION * dt;
  if (sp <= dec) { w.vx = 0; w.vy = 0; sp = 0; } else { w.vx *= (sp - dec) / sp; w.vy *= (sp - dec) / sp; sp -= dec; }
  w.x += w.vx * dt;
  w.y += w.vy * dt;
  if (!w.out) {
    if (im > 0.2) w.face = Math.atan2(w.iy, w.ix);
    else if (sp > 40) w.face = Math.atan2(w.vy, w.vx);
  }
}

/**
 * Ball against ball. Separates them (by inverse mass) and, if they move
 * towards each other, applies the elastic impulse. Returns null if they do
 * not touch, otherwise { speed (closing speed), j (impulse), x, y (contact) }.
 */
function collide(a, b) {
  let dx = b.x - a.x, dy = b.y - a.y;
  let d = Math.sqrt(dx * dx + dy * dy);
  const minD = 2 * P.BALL_R;
  if (d >= minD) return null;
  if (d < 1e-6) { dx = 1; dy = 0; d = 1; }
  const nx = dx / d, ny = dy / d;
  const ia = 1 / massOf(a), ib = 1 / massOf(b);
  const overlap = minD - d;
  a.x -= nx * overlap * ia / (ia + ib);
  a.y -= ny * overlap * ia / (ia + ib);
  b.x += nx * overlap * ib / (ia + ib);
  b.y += ny * overlap * ib / (ia + ib);
  const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  const hit = { speed: 0, j: 0, x: a.x + nx * P.BALL_R, y: a.y + ny * P.BALL_R };
  if (rel >= 0) return hit;
  const j = -(1 + P.RESTITUTION) * rel / (ia + ib);
  a.vx -= j * ia * nx;
  a.vy -= j * ia * ny;
  b.vx += j * ib * nx;
  b.vy += j * ib * ny;
  hit.speed = -rel;
  hit.j = j;
  return hit;
}

function isOut(w, radius) {
  const dx = w.x - P.CX, dy = w.y - P.CY;
  return dx * dx + dy * dy > radius * radius;
}

/**
 * One fixed step of the world: both wrestlers, then the collision.
 * Returns the collision (or null).
 */
function stepWorld(ws, dt, move) {
  for (let i = 0; i < ws.length; i++) stepWrestler(ws[i], dt, move);
  if (!move || ws.length < 2) return null;
  return collide(ws[0], ws[1]);
}

module.exports = {
  P: P,
  ringRadius: ringRadius,
  makeWrestler: makeWrestler,
  startPositions: startPositions,
  setInput: setInput,
  massOf: massOf,
  tryDash: tryDash,
  stepWrestler: stepWrestler,
  collide: collide,
  isOut: isOut,
  stepWorld: stepWorld
};
