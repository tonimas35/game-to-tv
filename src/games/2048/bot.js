'use strict';
/*
 * «2048»: the computer opponent («Rivales bot», see docs/crear-un-juego.md).
 *
 * With bots in the room there are always 2 or more players, so 2048 is the
 * race (index.js: mode 'race' when players > 1): the bot plays its own board
 * for the 3 minutes. It reads that board from the TV state (nmeta, the board
 * whose slot is its own) and plays with the phone's message, n.move. After
 * each move it waits for the TV to show its board again (seq changes) before
 * it chooses the next one, and it never moves faster than its level's rate.
 * It never presses «Otra» (n.new: one player is enough, the person decides).
 *
 * How it chooses (see LEVELS):
 *   random:     a random legal move, preferring the moves that keep the
 *               tiles in the bottom-left corner (down and left);
 *   greedy:     1 move ahead, no thinking about the new tile: the points
 *               merged, the biggest tile kept in a corner and the board
 *               heuristic below (empty cells, merges ready, order);
 *   expectimax: `depth` moves ahead, averaging over where the new tile
 *               appears (a 2 at 90 %, a 4 at 10 %), with the classic
 *               heuristic for each line: empty cells, merges ready
 *               (smoothness), monotonicity (which keeps the biggest tile in
 *               a corner) and a penalty for big tiles in the middle.
 *
 * Cheap: the board is two 32-bit numbers (4 bits per cell, the log2 of the
 * tile), the lines slide through tables filled on demand (only the lines it
 * meets, never a 65536-entry burst), and the search is cut in small tasks
 * (one per new tile after each first move) done a few per tick, with a fixed
 * budget of leaf evaluations per tick. Unlikely branches are skipped (a 4 in
 * a deep chance node) and the depth drops by one while the board is still
 * very empty (any move is good then).
 */
const Kit = require('../bot-kit');

/*
 * movesPerSec: its top speed (moves per second; each wait varies ±jitter)
 * jitter: how much each wait varies (fraction)
 * think: how it chooses: 'random' | 'greedy' | 'expectimax'
 * depth: moves ahead (expectimax)
 * slip: chance of a random legal move instead of the chosen one
 * budget: leaf evaluations per tick (the search is spread over ticks)
 */
const LEVELS = {
  facil: { movesPerSec: 1.5, jitter: 0.35, think: 'random', depth: 0, slip: 0, budget: 0 },
  normal: { movesPerSec: 3, jitter: 0.3, think: 'greedy', depth: 1, slip: 0, budget: 0 },
  dificil: { movesPerSec: 4.5, jitter: 0.25, think: 'expectimax', depth: 2, slip: 0, budget: 800 },
  imposible: { movesPerSec: 6, jitter: 0.2, think: 'expectimax', depth: 3, slip: 0, budget: 1000 }
};

const DIRS = ['up', 'down', 'left', 'right'];
// «Fácil»: how much it likes each move (it keeps the tiles down and to the left)
const RANDOM_WEIGHT = [0.6, 4, 3, 1.4];
// «Normal» (greedy): the heuristic of the board after the move, plus the points
// merged, plus the biggest tile in a corner, plus a little bias (up only if it must)
const GREEDY = { gain: 10, corner: 1000, bias: [-400, 40, 30, -50] };
// Expectimax: chance branches less likely than this are cut (a leaf evaluation instead)
const CPROB_MIN = 0.002;
// Expectimax (3 moves or more): with more empty cells than this it looks one move less ahead
const EASY_EMPTY = 9;

// ---------------------------------------------------------------- line tables (filled on demand)
// A line is 4 cells of 4 bits (log2 of the tile, 0 = empty): cell k at bits 4k..4k+3.
const N = 65536;
const LEFT = new Uint16Array(N);     // the line slid towards cell 0
const RIGHT = new Uint16Array(N);    // the line slid towards cell 3
const GAIN_L = new Uint32Array(N);   // points merged sliding left
const GAIN_R = new Uint32Array(N);
const HEUR = new Float64Array(N);    // heuristic value of the line
const DONE = new Uint8Array(N);      // 1: LEFT/GAIN_L, 2: RIGHT/GAIN_R, 4: HEUR

const tmp = [0, 0, 0, 0];
// Slides 4 exponents (tmp, towards index 0), as logic.js does: each tile merges once
function slideTmp() {
  let out = 0, gain = 0, n = 0, prev = 0, merged = false;
  const res = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const v = tmp[i];
    if (!v) continue;
    if (n && !merged && prev === v) {
      const nv = Math.min(15, v + 1);
      res[n - 1] = nv;
      gain += 1 << (v + 1);
      merged = true;
      prev = -1;
    } else {
      res[n++] = v;
      prev = v;
      merged = false;
    }
  }
  for (let i = 0; i < 4; i++) out |= res[i] << (4 * i);
  return { line: out, gain: gain };
}
function fillLeft(key) {
  for (let i = 0; i < 4; i++) tmp[i] = (key >> (4 * i)) & 15;
  const r = slideTmp();
  LEFT[key] = r.line; GAIN_L[key] = r.gain; DONE[key] |= 1;
}
function fillRight(key) {
  for (let i = 0; i < 4; i++) tmp[i] = (key >> (4 * (3 - i))) & 15;
  const r = slideTmp();
  let out = 0;
  for (let i = 0; i < 4; i++) out |= ((r.line >> (4 * i)) & 15) << (4 * (3 - i));
  RIGHT[key] = out; GAIN_R[key] = r.gain; DONE[key] |= 2;
}
function left(key) { if (!(DONE[key] & 1)) fillLeft(key); return LEFT[key]; }
function right(key) { if (!(DONE[key] & 2)) fillRight(key); return RIGHT[key]; }

// The classic per-line heuristic (empty cells, merges ready, monotonicity, big tiles)
function fillHeur(key) {
  let sum = 0, empty = 0, merges = 0, prev = 0, counter = 0;
  const r = [key & 15, (key >> 4) & 15, (key >> 8) & 15, (key >> 12) & 15];
  for (let i = 0; i < 4; i++) {
    const rank = r[i];
    sum += Math.pow(rank, 3.5);
    if (rank === 0) empty++;
    else {
      if (prev === rank) counter++;
      else if (counter > 0) { merges += 1 + counter; counter = 0; }
      prev = rank;
    }
  }
  if (counter > 0) merges += 1 + counter;
  let monoL = 0, monoR = 0;
  for (let i = 1; i < 4; i++) {
    if (r[i - 1] > r[i]) monoL += Math.pow(r[i - 1], 4) - Math.pow(r[i], 4);
    else monoR += Math.pow(r[i], 4) - Math.pow(r[i - 1], 4);
  }
  HEUR[key] = 200000 + 270 * empty + 700 * merges - 47 * Math.min(monoL, monoR) - 11 * sum;
  DONE[key] |= 4;
}
function heur(key) { if (!(DONE[key] & 4)) fillHeur(key); return HEUR[key]; }

// ---------------------------------------------------------------- the board: two 32-bit numbers
// hi = rows 0 (bits 16-31) and 1 (bits 0-15), lo = rows 2 and 3; cell i = row*4 + col, col k at bits 4k of its row.
let MH = 0, ML = 0, MG = 0;   // the result of move(): the new board and the points merged
let evals = 0;                // leaf evaluations (the search budget)

function col(hi, lo, c) {
  const s = 4 * c;
  return ((hi >>> (16 + s)) & 15) | (((hi >>> s) & 15) << 4) | (((lo >>> (16 + s)) & 15) << 8) | (((lo >>> s) & 15) << 12);
}
function fromCols(c0, c1, c2, c3) {
  // row r of the board: cell r of each column
  let hi = 0, lo = 0;
  const cs = [c0, c1, c2, c3];
  for (let c = 0; c < 4; c++) {
    const k = cs[c], s = 4 * c;
    hi |= ((k & 15) << (16 + s)) | (((k >> 4) & 15) << s);
    lo |= (((k >> 8) & 15) << (16 + s)) | (((k >> 12) & 15) << s);
  }
  MH = hi >>> 0; ML = lo >>> 0;
}

/** Moves the board (0 up, 1 down, 2 left, 3 right): MH/ML/MG. Returns whether anything moved. */
function move(hi, lo, d) {
  if (d >= 2) {
    const f = d === 2 ? left : right;
    const g = d === 2 ? GAIN_L : GAIN_R;
    const r0 = hi >>> 16, r1 = hi & 0xffff, r2 = lo >>> 16, r3 = lo & 0xffff;
    const n0 = f(r0), n1 = f(r1), n2 = f(r2), n3 = f(r3);
    MH = ((n0 << 16) | n1) >>> 0;
    ML = ((n2 << 16) | n3) >>> 0;
    MG = g[r0] + g[r1] + g[r2] + g[r3];
  } else {
    const f = d === 0 ? left : right;
    const g = d === 0 ? GAIN_L : GAIN_R;
    const c0 = col(hi, lo, 0), c1 = col(hi, lo, 1), c2 = col(hi, lo, 2), c3 = col(hi, lo, 3);
    fromCols(f(c0), f(c1), f(c2), f(c3));
    MG = g[c0] + g[c1] + g[c2] + g[c3];
  }
  return MH !== hi || ML !== lo;
}

function evalBoard(hi, lo) {
  evals++;
  return heur(hi >>> 16) + heur(hi & 0xffff) + heur(lo >>> 16) + heur(lo & 0xffff) +
    heur(col(hi, lo, 0)) + heur(col(hi, lo, 1)) + heur(col(hi, lo, 2)) + heur(col(hi, lo, 3));
}

function cellOf(hi, lo, i) {
  const r = i >> 2, s = 4 * (i & 3) + (r & 1 ? 0 : 16);
  return ((r < 2 ? hi : lo) >>> s) & 15;
}
function countEmpty(hi, lo) {
  let n = 0;
  for (let i = 0; i < 16; i++) if (!cellOf(hi, lo, i)) n++;
  return n;
}
// The board with exponent v at cell i: MH/ML
function place(hi, lo, i, v) {
  const r = i >> 2, s = 4 * (i & 3) + (r & 1 ? 0 : 16);
  if (r < 2) { MH = (hi | (v << s)) >>> 0; ML = lo; } else { MH = hi; ML = (lo | (v << s)) >>> 0; }
}

// ---------------------------------------------------------------- expectimax
// d: moves left to look at. Max over the moves of the chance node after each.
function maxNode(hi, lo, d, cprob) {
  let best = 0;
  for (let k = 0; k < 4; k++) {
    if (!move(hi, lo, k)) continue;
    const v = chanceNode(MH, ML, d - 1, cprob);
    if (v > best) best = v;
  }
  return best;   // 0: no move, the board is stuck (worse than any heuristic value)
}
// The average over where the new tile appears (a 2 or a 4)
function chanceNode(hi, lo, d, cprob) {
  if (d <= 0 || cprob < CPROB_MIN) return evalBoard(hi, lo);
  const e = countEmpty(hi, lo);
  if (!e) return evalBoard(hi, lo);
  let sum = 0;
  const p2 = cprob * 0.9 / e, p4 = cprob * 0.1 / e;
  for (let i = 0; i < 16; i++) {
    if (cellOf(hi, lo, i)) continue;
    place(hi, lo, i, 1);
    const v2 = maxNode(MH, ML, d, p2);
    if (p4 >= CPROB_MIN) {
      place(hi, lo, i, 2);
      sum += 0.9 * v2 + 0.1 * maxNode(MH, ML, d, p4);
    } else sum += v2;
  }
  return sum / e;
}

/*
 * A search spread over ticks: for each legal first move, one task per new
 * tile that may appear (cell and value), each a maxNode() of depth-1.
 */
function Search() {
  const MAXT = 4 * 16 * 2;
  this.thi = new Float64Array(MAXT);
  this.tlo = new Float64Array(MAXT);
  this.tp = new Float64Array(MAXT);
  this.tm = new Uint8Array(MAXT);
  this.t4 = new Uint8Array(MAXT);
  this.n = 0;
  this.next = 0;
  this.depth = 0;
  this.val = [0, 0, 0, 0];
  this.legal = [false, false, false, false];
  this.active = false;
}
Search.prototype.start = function (hi, lo, depth) {
  this.n = 0; this.next = 0; this.depth = depth; this.active = true;
  for (let m = 0; m < 4; m++) {
    this.val[m] = 0;
    this.legal[m] = move(hi, lo, m);
    if (!this.legal[m]) continue;
    const ah = MH, al = ML;
    if (depth <= 1) { this.val[m] = evalBoard(ah, al); continue; }
    const e = countEmpty(ah, al);
    for (let i = 0; i < 16; i++) {
      if (cellOf(ah, al, i)) continue;
      for (let v = 1; v <= 2; v++) {
        place(ah, al, i, v);
        const k = this.n++;
        this.thi[k] = MH; this.tlo[k] = ML; this.tm[k] = m; this.t4[k] = v === 2 ? 1 : 0;
        this.tp[k] = (v === 1 ? 0.9 : 0.1) / e;
      }
    }
  }
};
/** Works until `budget` leaf evaluations are spent (at least one task). Returns true when done. */
Search.prototype.work = function (budget) {
  if (!this.active) return true;
  const stopAt = evals + budget;
  while (this.next < this.n) {
    const k = this.next++;
    // A new 4 (10 %) looks one move less ahead: half the work, nearly the same choice
    const d = this.t4[k] && this.depth > 2 ? this.depth - 2 : this.depth - 1;
    this.val[this.tm[k]] += this.tp[k] * maxNode(this.thi[k], this.tlo[k], d, this.tp[k]);
    if (evals >= stopAt) break;
  }
  return this.next >= this.n;
};
/** The best legal move (0..3), or -1. */
Search.prototype.best = function () {
  let best = -1;
  for (let m = 0; m < 4; m++) if (this.legal[m] && (best < 0 || this.val[m] > this.val[best])) best = m;
  this.active = false;
  return best;
};

// ---------------------------------------------------------------- the simple levels
function legalMoves(hi, lo) {
  const out = [];
  for (let m = 0; m < 4; m++) if (move(hi, lo, m)) out.push(m);
  return out;
}
function randomMove(hi, lo, random) {
  const ms = legalMoves(hi, lo);
  let total = 0;
  ms.forEach(function (m) { total += RANDOM_WEIGHT[m]; });
  let x = random() * total;
  for (let k = 0; k < ms.length; k++) { x -= RANDOM_WEIGHT[ms[k]]; if (x < 0) return ms[k]; }
  return ms.length ? ms[ms.length - 1] : -1;
}
function maxCell(hi, lo) {
  let best = 0, at = 0;
  for (let i = 0; i < 16; i++) { const v = cellOf(hi, lo, i); if (v > best) { best = v; at = i; } }
  return { v: best, at: at };
}
// 1 move ahead: the heuristic after the move, points merged, the biggest tile in a corner
function greedyMove(hi, lo) {
  let best = -1, bestV = -Infinity;
  for (let m = 0; m < 4; m++) {
    if (!move(hi, lo, m)) continue;
    const ah = MH, al = ML, gain = MG;
    const mx = maxCell(ah, al);
    const corner = mx.at === 0 || mx.at === 3 || mx.at === 12 || mx.at === 15;
    const v = evalBoard(ah, al) + GREEDY.gain * gain + (corner ? GREEDY.corner : 0) + GREEDY.bias[m];
    if (v > bestV) { bestV = v; best = m; }
  }
  return best;
}

// ---------------------------------------------------------------- the bot
function create(ctx) {
  const P = Kit.byLevel(ctx.level, LEVELS);
  const interval = 1000 / P.movesPerSec;
  const search = new Search();
  let match = -1;
  let board = null;      // { hi, lo, seq, over }
  let phase = '', paused = false;
  let sentSeq = -1, sentAt = -Infinity;   // waiting for the TV to show this board's next seq
  let nextAt = 0;        // not before this time (its speed)
  let planSeq = -1, plan = -1;            // the move chosen for this seq (-1: none yet)
  let stopped = false;

  function wait() { return interval * (1 - P.jitter + 2 * P.jitter * ctx.random()); }

  function readBoard(b) {
    let hi = 0, lo = 0;
    const t = b.tiles;
    for (let k = 0; k + 3 < t.length; k += 4) {
      const v = t[k + 1], cell = t[k + 2];
      if (!(v > 0) || !(cell >= 0 && cell < 16)) continue;
      const e = Math.min(15, 31 - Math.clz32(v));
      const r = cell >> 2, s = 4 * (cell & 3) + (r & 1 ? 0 : 16);
      if (r < 2) hi |= e << s; else lo |= e << s;
    }
    return { hi: hi >>> 0, lo: lo >>> 0, seq: b.seq, over: !!b.over };
  }

  function startThinking() {
    plan = -1;
    planSeq = board.seq;
    if (board.over) { search.active = false; return; }
    if (P.think === 'random') plan = randomMove(board.hi, board.lo, ctx.random);
    else if (P.think === 'greedy') plan = greedyMove(board.hi, board.lo);
    else {
      const depth = P.depth > 2 && countEmpty(board.hi, board.lo) > EASY_EMPTY ? P.depth - 1 : P.depth;
      search.start(board.hi, board.lo, depth);
    }
  }

  return {
    onTv: function (m) {
      if (stopped || m.t !== 'nmeta') return;
      if (m.match !== match) {
        match = m.match; board = null; sentSeq = -1; planSeq = -1; plan = -1; search.active = false;
        nextAt = ctx.now() + wait();
      }
      phase = m.phase;
      paused = !!m.paused;
      let mine = null;
      for (let k = 0; k < m.boards.length; k++) if (m.boards[k].slot === ctx.slot) { mine = m.boards[k]; break; }
      if (!mine) { board = null; return; }
      if (board && board.seq === mine.seq && board.over === !!mine.over) return;
      board = readBoard(mine);
      startThinking();
    },
    tick: function () {
      if (stopped || !board || board.over) return;
      // Think (a bit per tick), also during the countdown
      if (search.active && planSeq === board.seq) {
        if (search.work(P.budget)) plan = search.best();
      }
      if (phase !== 'play' || paused) return;
      const now = ctx.now();
      // Wait for the TV to show the board after its last move (if it never does: think again)
      if (sentSeq === board.seq) {
        if (now - sentAt < 1500) return;
        sentSeq = -1;
        startThinking();
        return;
      }
      if (plan < 0 || now < nextAt) return;
      let dir = plan;
      if (P.slip > 0 && ctx.random() < P.slip) {
        const ms = legalMoves(board.hi, board.lo);
        if (ms.length) dir = ms[Math.floor(ctx.random() * ms.length) % ms.length];
      }
      if (ctx.send({ t: 'n.move', dir: DIRS[dir] })) {
        sentSeq = board.seq;
        sentAt = now;
        nextAt = now + wait();
        plan = -1;
        search.active = false;
      }
    },
    stop: function () { stopped = true; search.active = false; }
  };
}

module.exports = {
  create: create, LEVELS: LEVELS,
  // For the tests
  _board: function (values) {
    let hi = 0, lo = 0;
    values.forEach(function (v, cell) {
      if (!v) return;
      const e = 31 - Math.clz32(v), r = cell >> 2, s = 4 * (cell & 3) + (r & 1 ? 0 : 16);
      if (r < 2) hi |= e << s; else lo |= e << s;
    });
    return { hi: hi >>> 0, lo: lo >>> 0 };
  },
  _move: function (hi, lo, d) { const moved = move(hi, lo, d); return { moved: moved, hi: MH, lo: ML, gain: MG }; },
  _values: function (hi, lo) { const out = []; for (let i = 0; i < 16; i++) { const e = cellOf(hi, lo, i); out.push(e ? 1 << e : 0); } return out; },
  DIRS: DIRS,
  _evals: function () { return evals; }
};
