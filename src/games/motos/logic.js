'use strict';
/*
 * «Motos de neón»: the pure grid logic (no timers, no network), tested on its
 * own in test/motos.test.js. Node 12 compatible (it runs inside the TV).
 *
 * The arena is a W x H grid of cells (64 x 36). A cell is an index
 * y * W + x. grid[cell] is 0 when free, or the side (1 or 2) whose trail
 * fills it. Each bike's own cell (its head) is part of its trail.
 *
 * Every step (one cell per bike):
 *   1. each bike takes its next queued turn (if any);
 *   2. every bike's next cell is judged against the grid as it was BEFORE
 *      the step, so the order of the bikes never matters;
 *   3. out of the arena -> 'muro'; a cell of its own trail -> 'propia'; of
 *      the other trail (or the other bike's head) -> 'rival'; both bikes
 *      into the same cell, or swapping cells -> 'frontal' (head-on);
 *   4. the survivors move and fill their new cell.
 * The round is over when at most one bike is alive: the last one alive
 * wins it; nobody alive (head-on, or both crashed in the same step) = draw.
 *
 * Turns: up to MAX_QUEUE turns are queued per bike and one is used per step,
 * so a quick «up then left» between two steps gives two turns. A turn equal
 * to the direction it would follow, or its reverse (a U-turn into its own
 * trail), is ignored.
 */
const W = 64;
const H = 36;
const MAX_QUEUE = 2;
const DIRS = { up: 0, right: 1, down: 2, left: 3 };
const DIR_NAMES = ['up', 'right', 'down', 'left'];
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

/*
 * Start positions, symmetric so that nobody has an advantage:
 *   0: facing each other (point symmetry: the arena turned 180 degrees)
 *   1: both facing up from opposite sides (mirror symmetry)
 */
function startLayout(kind, w, h) {
  w = w || W;
  h = h || H;
  if (kind === 1) {
    const x = Math.round(w / 4);
    const y = h - 6;
    return [{ x: x, y: y, dir: DIRS.up }, { x: w - 1 - x, y: y, dir: DIRS.up }];
  }
  const x0 = Math.round(w * 3 / 16);
  const y0 = Math.floor(h / 2) - 1;
  return [{ x: x0, y: y0, dir: DIRS.right }, { x: w - 1 - x0, y: h - 1 - y0, dir: DIRS.left }];
}

/** A new round. `starts` (optional, for the tests): [{ x, y, dir }, { x, y, dir }] */
function newRound(kind, w, h, starts) {
  w = w || W;
  h = h || H;
  const grid = new Uint8Array(w * h);
  const bikes = (starts || startLayout(kind, w, h)).map(function (p, i) {
    const cell = p.y * w + p.x;
    grid[cell] = i + 1;
    return {
      side: i + 1,
      x: p.x,
      y: p.y,
      dir: typeof p.dir === 'string' ? DIRS[p.dir] : p.dir,
      alive: true,
      queue: [],
      corners: [cell],   // cells where the path starts or turns (the head is not included)
      cause: null,       // why it crashed
      crashCell: -1
    };
  });
  return { w: w, h: h, grid: grid, bikes: bikes, steps: 0 };
}

function cellOf(rd, b) { return b.y * rd.w + b.x; }

function dirIndex(dir) {
  const d = typeof dir === 'string' ? DIRS[dir] : dir;
  return d === 0 || d === 1 || d === 2 || d === 3 ? d : -1;
}

/** Queues a turn. Returns true if it was accepted. */
function queueTurn(bike, dir) {
  const d = dirIndex(dir);
  if (d < 0 || !bike || !bike.alive) return false;
  const last = bike.queue.length ? bike.queue[bike.queue.length - 1] : bike.dir;
  if (d === last || d === (last + 2) % 4) return false;   // same way, or a U-turn
  if (bike.queue.length >= MAX_QUEUE) return false;
  bike.queue.push(d);
  return true;
}

function clearQueues(rd) { rd.bikes.forEach(function (b) { b.queue = []; }); }

/**
 * One step. Returns { heads: [cell | -1, ...] (the new cell of every bike,
 * -1 if it did not move), crashed: [{ side, cause, cell }] }.
 */
function step(rd) {
  const w = rd.w, h = rd.h, grid = rd.grid;
  const plan = rd.bikes.map(function (b) {
    if (!b.alive) return null;
    if (b.queue.length) {
      const nd = b.queue.shift();
      if (nd !== b.dir) {
        const here = cellOf(rd, b);
        if (b.corners[b.corners.length - 1] !== here) b.corners.push(here);
        b.dir = nd;
      }
    }
    const nx = b.x + DX[b.dir], ny = b.y + DY[b.dir];
    const out = nx < 0 || ny < 0 || nx >= w || ny >= h;
    const target = out ? -1 : ny * w + nx;
    let cause = null;
    if (out) cause = 'muro';
    else if (grid[target]) cause = grid[target] === b.side ? 'propia' : 'rival';
    return { b: b, nx: nx, ny: ny, target: target, cause: cause };
  });
  // Head-on: into the same cell, or swapping cells
  for (let i = 0; i < plan.length; i++) {
    for (let j = i + 1; j < plan.length; j++) {
      const a = plan[i], c = plan[j];
      if (!a || !c || a.target < 0 || c.target < 0) continue;
      const same = a.target === c.target;
      const swap = a.target === cellOf(rd, c.b) && c.target === cellOf(rd, a.b);
      if (same || swap) { a.cause = 'frontal'; c.cause = 'frontal'; }
    }
  }
  const heads = [];
  const crashed = [];
  plan.forEach(function (p, i) {
    if (!p) { heads[i] = -1; return; }
    const b = p.b;
    if (p.cause) {
      b.alive = false;
      b.queue = [];
      b.cause = p.cause;
      // Where to show the crash: the cell it went into (or its own, against a wall)
      b.crashCell = p.target >= 0 ? p.target : cellOf(rd, b);
      heads[i] = -1;
      crashed.push({ side: b.side, cause: p.cause, cell: b.crashCell });
      return;
    }
    b.x = p.nx;
    b.y = p.ny;
    grid[p.target] = b.side;
    heads[i] = p.target;
  });
  rd.steps++;
  return { heads: heads, crashed: crashed };
}

/** null while 2 or more are alive; otherwise the winning side (1, 2) or 0 for a draw */
function result(rd) {
  const alive = rd.bikes.filter(function (b) { return b.alive; });
  if (alive.length >= 2) return null;
  return alive.length === 1 ? alive[0].side : 0;
}

/** Compact full state: every trail as its corner cells plus the head (in path order) */
function snapshot(rd) {
  return {
    tr: rd.bikes.map(function (b) {
      const head = cellOf(rd, b);
      return b.corners[b.corners.length - 1] === head ? b.corners.slice() : b.corners.concat([head]);
    }),
    al: rd.bikes.map(function (b) { return b.alive ? 1 : 0; }),
    dr: rd.bikes.map(function (b) { return b.dir; })
  };
}

/** Every cell of a path given by its corners (straight lines between them), in order */
function expandPath(points, w) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const c = points[i];
    if (i === 0) { out.push(c); continue; }
    const p = points[i - 1];
    let x = p % w, y = Math.floor(p / w);
    const tx = c % w, ty = Math.floor(c / w);
    const sx = Math.sign(tx - x), sy = Math.sign(ty - y);
    if (sx && sy) throw new Error('Tramo en diagonal');
    while (x !== tx || y !== ty) {
      x += sx;
      y += sy;
      out.push(y * w + x);
    }
  }
  return out;
}

module.exports = {
  W: W, H: H, MAX_QUEUE: MAX_QUEUE, DIRS: DIRS, DIR_NAMES: DIR_NAMES, DX: DX, DY: DY,
  startLayout: startLayout, newRound: newRound, queueTurn: queueTurn, clearQueues: clearQueues,
  step: step, result: result, snapshot: snapshot, expandPath: expandPath, cellOf: cellOf, dirIndex: dirIndex
};
