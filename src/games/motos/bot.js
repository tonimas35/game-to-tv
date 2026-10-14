'use strict';
/*
 * «Motos de neón»: the computer opponent («Rivales bot», see
 * docs/crear-un-juego.md). create(ctx) -> { onTv, onSlot, tick, stop }.
 *
 * It sees what the TV sees: the trails of one `msnap` (at the start of each
 * round) plus the new head cells of every step (`mt`), the same model as
 * tv.js's TrailModel, and `mmeta` for the phase and which side it is. It
 * plays with the phone's message, { t: 'm.turn', dir }, one turn at a time
 * (the game queues up to 2: the bot never has more than one waiting).
 *
 * It thinks once per step (12-16 steps/s), on the first tick after the
 * step's `mt` arrives; its turn reaches the game before the next step:
 *   - the moves that do not crash at once (straight, left, right);
 *   - «space» levels (Fácil, Normal): the room after each move, by a flood
 *     fill (capped at Fácil, which only sees a couple of cells ahead),
 *     keeping clear of the cells the rival's head can take next;
 *   - «territory» levels (Difícil, Imposible), while both bikes share the
 *     arena: a 1-ply simultaneous minimax (its 3 moves against the rival's
 *     3 replies, the worst reply for each) scored by a Voronoi split: the
 *     cells it reaches first minus those the rival reaches first. That is
 *     what cuts the rival off. Once the bikes are walled apart, it fills its
 *     own region: the move with the most room a step deeper (so it does not
 *     split its region), counted by colours like a chessboard (a path
 *     alternates colours, so the smaller colour bounds it), hugging walls.
 *
 * The grid is kept with a border of walls ((w+2) x (h+2)) so a search needs
 * no bounds checks: a Voronoi split of the 64 x 36 arena takes ~25 µs.
 *
 * Levels (ctx.level), see LEVELS.
 */
const Kit = require('../bot-kit');

const DIR_NAMES = ['up', 'right', 'down', 'left'];
const WALL = 9;
const BIG = 1e6;

/*
 * mode: 'space' (flood fill) or 'territory' (Voronoi minimax, then filling)
 * cap: most cells a flood fill counts (Fácil only sees a few cells ahead)
 * late: chance, at a step where it wants to turn, of turning one step late
 *       (it keeps straight one more step; only if that is not much worse,
 *       except at Fácil, where it only has to not crash at once)
 * blind: chance of not reacting when going straight crashes right now (Fácil:
 *        its slips and late turns may also be bad ones)
 * err: chance per step of a slip: another move that does not crash at once
 *      (and is not much worse, except at Fácil)
 * headAvoid: keeps clear of the cells the rival's head can reach next
 * parity: counts room by chessboard colours (fills its region better)
 * deep: when the bikes are apart, how far ahead it checks it does not split
 *       its own region (1: the room after the move; 2: after the best next move)
 */
const LEVELS = {
  facil: { mode: 'space', cap: 14, late: 0.12, blind: 0.04, err: 0, headAvoid: false, parity: false, deep: 1 },
  normal: { mode: 'space', cap: 4000, late: 0.03, blind: 0, err: 0.01, headAvoid: true, parity: false, deep: 1 },
  dificil: { mode: 'territory', cap: 4000, late: 0, blind: 0, err: 0.03, headAvoid: true, parity: false, deep: 2 },
  imposible: { mode: 'territory', cap: 4000, late: 0, blind: 0, err: 0, headAvoid: true, parity: true, deep: 2 }
};

// ---------------------------------------------------------------- the grid (no state)

/** Every cell of a path given by its corner cells (as logic.js / tv.js). */
function expandPath(points, w) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const c = points[i];
    if (i === 0) { out.push(c); continue; }
    const p = points[i - 1];
    let x = p % w, y = Math.floor(p / w);
    const tx = c % w, ty = Math.floor(c / w);
    const sx = tx > x ? 1 : (tx < x ? -1 : 0), sy = ty > y ? 1 : (ty < y ? -1 : 0);
    let guard = 0;
    while ((x !== tx || y !== ty) && guard < 10000) { x += sx; y += sy; out.push(y * w + x); guard++; }
  }
  return out;
}

/**
 * A w x h arena with a border of walls: grid (Uint8Array, (w+2)*(h+2):
 * 0 free, 1/2 a trail, WALL the border), the cell conversions, and the
 * searches (typed arrays and a stamp: nothing to clear between searches).
 */
function makeBoard(w, h) {
  const W2 = w + 2, n = W2 * (h + 2);
  const grid = new Uint8Array(n);
  const mark = new Int32Array(n);       // stamp of the search that reached the cell
  const owner = new Uint8Array(n);      // 1 / 2 who got there first, 3 = both at once
  const dist = new Int16Array(n);
  const queue = new Int32Array(n);
  const OFF = [-W2, 1, W2, -1];         // up, right, down, left
  let stamp = 0;
  const out = { a: 0, b: 0, shared: false, even: 0, odd: 0 };

  function clear() {
    grid.fill(0);
    for (let x = 0; x < W2; x++) { grid[x] = WALL; grid[n - 1 - x] = WALL; }
    for (let y = 0; y < h + 2; y++) { grid[y * W2] = WALL; grid[y * W2 + W2 - 1] = WALL; }
  }
  clear();
  /** Game cell (y * w + x) -> board cell, and back. */
  function toB(c) { return (Math.floor(c / w) + 1) * W2 + c % w + 1; }
  function fromB(p) { return (Math.floor(p / W2) - 1) * w + p % W2 - 1; }
  function parity(p) { return (p % W2 + Math.floor(p / W2)) & 1; }

  /**
   * Free cells reachable from `start` (start not counted), at most `cap`.
   * Also out.even / out.odd: how many of them have start's colour (even) or not.
   */
  function flood(start, cap) {
    stamp++;
    let qh = 0, qt = 0, count = 0, even = 0;
    const p0 = parity(start);
    mark[start] = stamp;
    queue[qt++] = start;
    while (qh < qt) {
      const c = queue[qh++];
      for (let k = 0; k < 4; k++) {
        const m = c + OFF[k];
        if (grid[m] || mark[m] === stamp) continue;
        mark[m] = stamp;
        count++;
        if (parity(m) === p0) even++;
        if (count >= cap) { out.even = even; out.odd = count - even; return count; }
        queue[qt++] = m;
      }
    }
    out.even = even;
    out.odd = count - even;
    return count;
  }
  /**
   * Voronoi split from two heads (both on the grid): out.a: free cells head A
   * reaches strictly first, out.b: those B does, out.shared: whether any free
   * cell is reachable by both (the bikes are not walled apart).
   */
  function voronoi(ha, hb) {
    stamp++;
    let qh = 0, qt = 0, a = 0, b = 0, shared = false;
    mark[ha] = stamp; owner[ha] = 1; dist[ha] = 0; queue[qt++] = ha;
    mark[hb] = stamp; owner[hb] = 2; dist[hb] = 0; queue[qt++] = hb;
    while (qh < qt) {
      const c = queue[qh++];
      const o = owner[c];
      const dc = dist[c] + 1;
      for (let k = 0; k < 4; k++) {
        const m = c + OFF[k];
        if (grid[m]) continue;
        if (mark[m] === stamp) {
          const om = owner[m];
          if (om !== o && om !== 3 && o !== 3) {
            shared = true;
            // Reached at the same distance by the other one: a tie (nobody's)
            if (dist[m] === dc) { if (om === 1) a--; else b--; owner[m] = 3; }
          }
          continue;
        }
        mark[m] = stamp;
        owner[m] = o;
        dist[m] = dc;
        if (o === 1) a++; else if (o === 2) b++;
        queue[qt++] = m;
      }
    }
    out.a = a; out.b = b; out.shared = shared;
    return out;
  }
  /** Free neighbours of p (how open a cell is: fewer = hugging a wall). */
  function freeAround(p) {
    let k = 0;
    for (let d = 0; d < 4; d++) if (!grid[p + OFF[d]]) k++;
    return k;
  }
  function manhattan(p, q) { return Math.abs(p % W2 - q % W2) + Math.abs(Math.floor(p / W2) - Math.floor(q / W2)); }
  return { w: w, h: h, W2: W2, grid: grid, OFF: OFF, out: out, clear: clear, toB: toB, fromB: fromB, flood: flood, voronoi: voronoi, freeAround: freeAround, manhattan: manhattan };
}

// ---------------------------------------------------------------- choosing a move (no state)

/** Score after both bikes move (me -> a, rival -> b), both cells free before: Voronoi difference. */
function judge(B, me, a, b) {
  if (a === b) return 0;                    // head-on: a draw
  const g = B.grid;
  g[a] = me; g[b] = 3 - me;
  const v = B.voronoi(a, b);
  g[a] = 0; g[b] = 0;
  return v.a - v.b;
}

/** Its move to cell `a` against the rival's worst reply (one step, simultaneous). */
function minimax1(B, me, a, opHead, opDir) {
  let worst = BIG, any = false;
  for (let k = 0; k < 3; k++) {
    const d = k === 0 ? opDir : (opDir + (k === 1 ? 3 : 1)) % 4;
    const b = opHead + B.OFF[d];
    if (B.grid[b]) continue;
    any = true;
    const v = judge(B, me, a, b);
    if (v < worst) worst = v;
  }
  return any ? worst : BIG;               // the rival crashes whatever it does: a win
}

/** Room it will have after moving to `a` (the bikes apart, or a «space» level). */
function room(B, me, a, dirIn, P) {
  const g = B.grid;
  g[a] = me;
  let best = 0;
  if (P.deep >= 2) {
    // A step deeper: the best next move (a move that splits the region counts only its side)
    for (let d = 0; d < 4; d++) {
      if (d === (dirIn + 2) % 4) continue;
      const c2 = a + B.OFF[d];
      if (g[c2]) continue;
      g[c2] = me;
      const r = 1 + count(B, c2, P);
      g[c2] = 0;
      if (r > best) best = r;
    }
  } else {
    best = count(B, a, P);
  }
  g[a] = 0;
  return best;
}
function count(B, p, P) {
  const n = B.flood(p, P.cap);
  if (!P.parity) return n;
  // A path from p alternates colours, starting with the other colour: at most
  // 2 * min + 1 cells (the cells of the other colour come first)
  const o = B.out.odd, e = B.out.even;
  return o > e ? 2 * e + 1 : 2 * o;
}

/**
 * The moves of side `me` (1 or 2) that do not crash at once, best first:
 * { moves: [{ d, c, v }], apart }. Heads hd[side-1] (board cells),
 * directions dr[side-1]; opAlive: whether the rival is still riding.
 * v: the Voronoi difference after the rival's worst reply while the bikes
 * share the arena (territory levels), else the room (x10) after the move.
 */
function choose(B, me, hd, dr, opAlive, P) {
  const g = B.grid;
  const op = 3 - me;
  const myHead = hd[me - 1], opHead = hd[op - 1];
  const cur = dr[me - 1];
  const moves = [];
  for (let k = 0; k < 3; k++) {
    const d = k === 0 ? cur : (cur + (k === 1 ? 3 : 1)) % 4;
    const c = myHead + B.OFF[d];
    if (!g[c]) moves.push({ d: d, c: c, v: 0 });
  }
  let apart = true;
  if (moves.length < 2) return { moves: moves, apart: apart };
  if (opAlive && P.mode === 'territory') apart = !B.voronoi(myHead, opHead).shared;

  if (!apart) {
    const od = dr[op - 1];
    for (let i = 0; i < moves.length; i++) moves[i].v = minimax1(B, me, moves[i].c, opHead, od);
  } else {
    // The cells the rival can move into next (a head-on there is a draw at best)
    const opNext = [];
    if (opAlive && P.headAvoid) {
      const od = dr[op - 1];
      for (let k = 0; k < 3; k++) {
        const c = opHead + B.OFF[k === 0 ? od : (od + (k === 1 ? 3 : 1)) % 4];
        if (!g[c]) opNext.push(c);
      }
    }
    for (let i = 0; i < moves.length; i++) {
      const mv = moves[i];
      const r = room(B, me, mv.c, mv.d, P);
      mv.v = r * 10 - B.freeAround(mv.c);   // hug the walls, a little
      if (opNext.indexOf(mv.c) >= 0 && r >= 6) mv.v -= BIG / 2;
    }
  }
  // Keep going straight when it is as good (fewer needless turns)
  for (let i = 0; i < moves.length; i++) if (moves[i].d === cur) moves[i].v += 0.5;
  moves.sort(function (x, y) { return y.v - x.v; });
  return { moves: moves, apart: apart };
}

/** Whether taking `alt` instead of `best` is a mistake it can live with (not a sure crash). */
function bearable(alt, best, apart) {
  if (!alt) return false;
  if (apart) return alt.v >= best.v * 0.6 && alt.v > 60;
  return alt.v >= best.v - 40;
}

// ---------------------------------------------------------------- the bot

function create(ctx) {
  const P = Kit.byLevel(ctx.level, LEVELS) || LEVELS.normal;
  const random = ctx.random;
  let stopped = false;
  let meta = null, mySide = 0;
  // What the TV knows (board cells)
  let B = null;
  const M = { r: -1, k: -1, head: [-1, -1], dir: [1, 3], alive: [true, true], ok: false };
  let dirty = false;           // a new step (or round) to think about
  let pending = -1;            // a turn it sent that the game has not used yet
  let pendingK = -1;           // ...sent after seeing this step
  let lateOnce = false;        // it just turned late (not twice in a row)
  const stats = { thinks: 0, turns: 0 };

  function onMeta(m) {
    meta = m;
    mySide = m.players ? m.players.indexOf(ctx.slot) + 1 : 0;
  }

  function snap(s) {
    if (!B || B.w !== s.w || B.h !== s.h) B = makeBoard(s.w, s.h);
    else B.clear();
    M.r = s.r; M.k = s.k;
    for (let side = 0; side < 2; side++) {
      const cells = expandPath((s.tr && s.tr[side]) || [], s.w);
      for (let i = 0; i < cells.length; i++) B.grid[B.toB(cells[i])] = side + 1;
      M.head[side] = cells.length ? B.toB(cells[cells.length - 1]) : -1;
      if (s.dr) M.dir[side] = s.dr[side];
      M.alive[side] = !(s.al && s.al[side] === 0) && M.head[side] >= 0;
    }
    M.ok = true;
    pending = -1;
    lateOnce = false;
    dirty = true;
  }

  function moves(t) {
    if (!M.ok || t.r !== M.r || t.k !== M.k + 1) { M.ok = false; return; }
    const h = t.h || [];
    const n = h.length >> 1;
    for (let i = 0; i < n; i++) {
      for (let s = 0; s < 2; s++) {
        const c = h[i * 2 + s];
        if (c < 0) { M.alive[s] = false; continue; }
        const p = B.toB(c);
        const prev = M.head[s];
        B.grid[p] = s + 1;
        if (prev >= 0) {
          const d = p - prev;
          M.dir[s] = d === 1 ? 1 : (d === -1 ? 3 : (d > 0 ? 2 : 0));
        }
        M.head[s] = p;
        // Its own move: was the turn it queued used?
        if (s === mySide - 1 && M.dir[s] === pending) pending = -1;
      }
    }
    M.k = t.k + n - 1;
    // A turn the game never used (late, or dropped): forget it after 2 steps
    if (pending >= 0 && M.k - pendingK >= 2) pending = -1;
    dirty = true;
  }

  function think() {
    dirty = false;
    if (!meta || !mySide || !M.ok) return;
    if (meta.phase !== 'playing' && meta.phase !== 'countdown') return;
    const me = mySide - 1;
    if (!M.alive[me]) return;
    if (pending >= 0) return;          // one turn waiting is enough: think again after it is used
    stats.thinks++;
    const cur = M.dir[me];
    const ch = choose(B, mySide, M.head, M.dir, M.alive[1 - me], P);
    const mv = ch.moves;
    if (!mv.length) return;            // nowhere to go
    let pick = mv[0];
    // A slip: another move that does not crash at once (and is not hopeless)
    if (P.err && mv.length > 1 && random() < P.err) {
      const alt = mv[1 + Math.floor(random() * (mv.length - 1))];
      if (P.blind || bearable(alt, mv[0], ch.apart)) pick = alt;
    }
    const d = pick.d;
    if (d === cur) { lateOnce = false; return; }
    // Reaction: sometimes a step late
    let straight = null;
    for (let i = 0; i < mv.length; i++) if (mv[i].d === cur) straight = mv[i];
    if (!lateOnce && P.late && random() < P.late && (P.blind ? !!straight : bearable(straight, pick, ch.apart))) { lateOnce = true; return; }
    // Fácil: sometimes it does not react at all, straight into the wall
    if (!straight && P.blind && random() < P.blind) return;
    lateOnce = false;
    ctx.send({ t: 'm.turn', dir: DIR_NAMES[d] });
    stats.turns++;
    pending = d;
    pendingK = M.k;
  }

  return {
    onTv: function (m) {
      if (stopped || !m) return;
      if (m.t === 'mt') moves(m);
      else if (m.t === 'msnap') snap(m);
      else if (m.t === 'mmeta') onMeta(m);
    },
    onSlot: function (m) {
      if (stopped || !m) return;
      if (m.t === 'mmeta') onMeta(m);
    },
    tick: function () {
      if (stopped || !dirty) return;
      think();
    },
    stop: function () { stopped = true; },
    // For tests: what it knows (the grid in game cells, 0 free / 1 / 2)
    _debug: function () {
      const grid = B ? new Uint8Array(B.w * B.h) : null;
      if (B) for (let c = 0; c < grid.length; c++) grid[c] = B.grid[B.toB(c)];
      return {
        side: mySide, k: M.k, ok: M.ok, pending: pending, level: ctx.level, stats: stats,
        head: M.head.map(function (p) { return p >= 0 && B ? B.fromB(p) : -1; }), dir: M.dir.slice(), alive: M.alive.slice(), grid: grid
      };
    }
  };
}

module.exports = { create: create, LEVELS: LEVELS, choose: choose, makeBoard: makeBoard, expandPath: expandPath };
