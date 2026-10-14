'use strict';
/*
 * «Tanques»: the hand-made arenas. One rotates in each round.
 *
 * The arena is 1920x960 units, a grid of 24x12 cells of 80. Only the top half
 * (6 rows) is written here: the bottom half is the same turned 180° around
 * the centre, so every arena is point-symmetric and both spawns are exactly
 * as good. The tests check that no spawn sees the other one at the start and
 * that a tank can drive from one to the other.
 *
 *   .  empty               #  full block (80x80)
 *   -  thin horizontal wall (80x20, through the middle of the cell)
 *   |  thin vertical wall   (20x80)
 *   +  both thin walls (a cross)
 *   o  small block (40x40, in the middle of the cell)
 *   A  spawn of the first tank (the second one, B, is its mirror)
 */

const W = 1920;
const H = 960;
const CELL = 80;
const COLS = 24;
const ROWS = 12;
const BAR = 20;

const DEFS = [
  {
    name: 'Cruces',
    top: [
      '........................',
      '.A...|..................',
      '.....|.....o....+....#..',
      '---..|...............#..',
      '.........-----.......#..',
      '....o.......#...........'
    ]
  },
  {
    name: 'Pasillos',
    top: [
      '........................',
      '.A.|.......|............',
      '...|...##..|...-----..|.',
      '...|.......|..........|.',
      '...+----...|....##....|.',
      '..........#.............'
    ]
  },
  {
    name: 'Fortines',
    top: [
      '........................',
      '.A..#...........-----...',
      '....#.....##............',
      '-----.....##...|....o...',
      '...............|........',
      '.......o.....###........'
    ]
  },
  {
    name: 'Laberinto',
    top: [
      '........................',
      '.A....|...----.....|....',
      '......|............|....',
      '..------......+....|..--',
      '..........|.........o...',
      '..........|.#...........'
    ]
  }
];

// Rectangles of one cell ({ x0, y0, x1, y1 } in arena units)
function cellRects(ch, cx, cy) {
  const x = cx * CELL;
  const y = cy * CELL;
  const m = (CELL - BAR) / 2;
  const out = [];
  if (ch === '#') out.push({ x0: x, y0: y, x1: x + CELL, y1: y + CELL });
  if (ch === 'o') out.push({ x0: x + CELL / 4, y0: y + CELL / 4, x1: x + CELL * 3 / 4, y1: y + CELL * 3 / 4 });
  if (ch === '-' || ch === '+') out.push({ x0: x, y0: y + m, x1: x + CELL, y1: y + m + BAR });
  if (ch === '|' || ch === '+') out.push({ x0: x + m, y0: y, x1: x + m + BAR, y1: y + CELL });
  return out;
}

// Joins rectangles that share a whole edge (fewer walls, no seams)
function mergeRects(rects) {
  rects = rects.map(function (r) { return { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 }; });
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < rects.length && !changed; i++) {
      for (let j = i + 1; j < rects.length && !changed; j++) {
        const a = rects[i];
        const b = rects[j];
        let m = null;
        if (a.y0 === b.y0 && a.y1 === b.y1 && (a.x1 === b.x0 || b.x1 === a.x0)) m = { x0: Math.min(a.x0, b.x0), y0: a.y0, x1: Math.max(a.x1, b.x1), y1: a.y1 };
        else if (a.x0 === b.x0 && a.x1 === b.x1 && (a.y1 === b.y0 || b.y1 === a.y0)) m = { x0: a.x0, y0: Math.min(a.y0, b.y0), x1: a.x1, y1: Math.max(a.y1, b.y1) };
        if (m) {
          rects[i] = m;
          rects.splice(j, 1);
          changed = true;
        }
      }
    }
  }
  return rects.sort(function (a, b) { return a.y0 - b.y0 || a.x0 - b.x0; });
}

function snap45(a) { return Math.round(a / (Math.PI / 4)) * (Math.PI / 4); }

/** The whole grid (12 rows) of a definition: the top half plus its 180° turn. */
function fullRows(def) {
  const rows = def.top.slice();
  for (let y = def.top.length - 1; y >= 0; y--) {
    rows.push(def.top[y].split('').reverse().join('').replace(/A/g, 'B'));
  }
  return rows;
}

function build(def, index) {
  const rows = fullRows(def);
  if (rows.length !== ROWS || rows.some(function (r) { return r.length !== COLS; })) {
    throw new Error('Tanques: el mapa «' + def.name + '» debe tener ' + (ROWS / 2) + ' filas de ' + COLS);
  }
  let rects = [];
  const spawns = [null, null];
  rows.forEach(function (row, cy) {
    row.split('').forEach(function (ch, cx) {
      if (ch === 'A' || ch === 'B') {
        const x = (cx + 0.5) * CELL;
        const y = (cy + 0.5) * CELL;
        spawns[ch === 'A' ? 0 : 1] = { x: x, y: y, a: snap45(Math.atan2(H / 2 - y, W / 2 - x)) };
      } else {
        rects = rects.concat(cellRects(ch, cx, cy));
      }
    });
  });
  if (!spawns[0] || !spawns[1]) throw new Error('Tanques: el mapa «' + def.name + '» no tiene salida');
  return { index: index, name: def.name, rows: rows, walls: mergeRects(rects), spawns: spawns };
}

const LIST = DEFS.map(build);

module.exports = { W: W, H: H, CELL: CELL, COLS: COLS, ROWS: ROWS, BAR: BAR, DEFS: DEFS, LIST: LIST, build: build, fullRows: fullRows, mergeRects: mergeRects };
