'use strict';
/*
 * «2048»: the pure board logic (no timers, no network). Written from scratch
 * for game-to-tv, inspired by the classic 2048.
 *
 * A board is 4x4 = 16 cells, index = row * 4 + col. Each cell holds a tile
 * { id, v } or null. Tiles keep their id while they slide, so the views can
 * animate them; when two tiles merge, the first one (closest to the wall)
 * keeps its id and doubles, and the other one goes away into it (`gone`).
 */

const SIZE = 4;
const CELLS = SIZE * SIZE;
const GOAL = 2048;
const DIRS = ['up', 'down', 'left', 'right'];

function emptyBoard() {
  return { cells: new Array(CELLS).fill(null), nextId: 1, score: 0, max: 0, moves: 0, won: false, over: false };
}

/**
 * Slides one line towards index 0. `line` is an array of tiles (or null).
 * Each tile merges at most once per move: [2,2,2,2] -> [4,4,_,_], [4,2,2,_] -> [4,4,_,_].
 * Returns { line, gained, gone: [{ id, into }] } (new tile objects; merged ones carry m: true).
 */
function slideTiles(line) {
  const out = [];
  const gone = [];
  let gained = 0;
  for (let i = 0; i < line.length; i++) {
    const t = line[i];
    if (!t) continue;
    const prev = out.length ? out[out.length - 1] : null;
    if (prev && !prev.m && prev.v === t.v) {
      prev.v *= 2;
      prev.m = true;
      gained += prev.v;
      gone.push({ id: t.id, into: out.length - 1 });
    } else {
      out.push({ id: t.id, v: t.v, m: false });
    }
  }
  while (out.length < line.length) out.push(null);
  return { line: out, gained: gained, gone: gone };
}

/** Same with plain numbers (0 = empty): slideLine([2,2,4,0]) -> { line: [4,4,0,0], gained: 4 } */
function slideLine(values) {
  let id = 1;
  const r = slideTiles(values.map(function (v) { return v ? { id: id++, v: v } : null; }));
  return { line: r.line.map(function (t) { return t ? t.v : 0; }), gained: r.gained };
}

// Cell index of position k (0 = nearest to the wall we move towards) in line n
function cellOf(dir, n, k) {
  switch (dir) {
    case 'left': return n * SIZE + k;
    case 'right': return n * SIZE + (SIZE - 1 - k);
    case 'up': return k * SIZE + n;
    default: return (SIZE - 1 - k) * SIZE + n; // down
  }
}

function emptyCells(b) {
  const out = [];
  for (let i = 0; i < CELLS; i++) if (!b.cells[i]) out.push(i);
  return out;
}

/** Puts a 2 (90 %) or a 4 (10 %) on a random empty cell. Returns the tile or null. */
function spawn(b, random) {
  random = random || Math.random;
  const free = emptyCells(b);
  if (!free.length) return null;
  const cell = free[Math.min(free.length - 1, Math.floor(random() * free.length))];
  const t = { id: b.nextId++, v: random() < 0.9 ? 2 : 4, n: true };
  b.cells[cell] = t;
  if (t.v > b.max) b.max = t.v;
  return t;
}

function canMove(b) {
  for (let i = 0; i < CELLS; i++) {
    const t = b.cells[i];
    if (!t) return true;
    const r = Math.floor(i / SIZE), c = i % SIZE;
    if (c < SIZE - 1 && b.cells[i + 1] && b.cells[i + 1].v === t.v) return true;
    if (r < SIZE - 1 && b.cells[i + SIZE] && b.cells[i + SIZE].v === t.v) return true;
  }
  return false;
}

/** A new board with two tiles. */
function newBoard(random) {
  const b = emptyBoard();
  spawn(b, random);
  spawn(b, random);
  return b;
}

/**
 * One move. Mutates the board. A new tile appears only if something moved.
 * Returns { moved, gained, gone: [{ id, cell }], spawned, reached }
 * (reached: this move made the first 2048 of the board).
 */
function move(b, dir, random) {
  const res = { moved: false, gained: 0, gone: [], spawned: null, reached: false };
  if (DIRS.indexOf(dir) < 0 || b.over) return res;
  const next = new Array(CELLS).fill(null);
  for (let n = 0; n < SIZE; n++) {
    const line = [];
    for (let k = 0; k < SIZE; k++) line.push(b.cells[cellOf(dir, n, k)]);
    const r = slideTiles(line);
    for (let k = 0; k < SIZE; k++) {
      const t = r.line[k];
      next[cellOf(dir, n, k)] = t;
      const before = line[k];
      if ((t ? t.id : 0) !== (before ? before.id : 0) || (t && t.m)) res.moved = true;
    }
    r.gone.forEach(function (g) { res.gone.push({ id: g.id, cell: cellOf(dir, n, g.into) }); });
    res.gained += r.gained;
  }
  if (!res.moved) return res;
  b.cells = next;
  b.score += res.gained;
  b.moves++;
  for (let i = 0; i < CELLS; i++) {
    const t = b.cells[i];
    if (!t) continue;
    t.n = false;
    if (t.v > b.max) b.max = t.v;
  }
  if (!b.won && b.max >= GOAL) { b.won = true; res.reached = true; }
  res.spawned = spawn(b, random);
  b.over = !canMove(b);
  return res;
}

/** Board from plain numbers (tests): fromValues([2,2,0,0, ...]) */
function fromValues(values) {
  const b = emptyBoard();
  values.forEach(function (v, i) {
    if (!v) return;
    b.cells[i] = { id: b.nextId++, v: v };
    if (v > b.max) b.max = v;
  });
  b.won = b.max >= GOAL;
  b.over = !canMove(b);
  return b;
}
function values(b) { return b.cells.map(function (t) { return t ? t.v : 0; }); }

module.exports = {
  SIZE: SIZE, CELLS: CELLS, GOAL: GOAL, DIRS: DIRS,
  slideTiles: slideTiles, slideLine: slideLine, newBoard: newBoard, emptyBoard: emptyBoard,
  spawn: spawn, move: move, canMove: canMove, fromValues: fromValues, values: values
};
