'use strict';
/*
 * Experimental «Tanques» opponent: a fast autopilot (drives, aims with
 * bounces, dodges) that a slower brain (Claude) steers through orden.json.
 *
 *   node tools/bot-tanques.js --server ws://IP:PORT/ws [--name Claude] [--dir carpeta] [--pick] [--segundos N]
 *
 * orden.json: { "modo": "atacar" | "flanquear" | "defender" | "quieto", "nivel": 0..1 }
 * estado.json (written every second): round, scores, positions, mode…
 */
const fs = require('fs');
const path = require('path');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.slice(0, 2) === '--') {
    const nx = process.argv[i + 1];
    if (nx && nx.slice(0, 2) !== '--') { args[a.slice(2)] = nx; i++; } else args[a.slice(2)] = true;
  }
}
const REPO = args.repo || path.join(__dirname, '..');
const WebSocket = require(path.join(REPO, 'node_modules', 'ws'));
const Sim = require(path.join(REPO, 'src', 'games', 'tanques', 'sim.js'));
const Layouts = require(path.join(REPO, 'src', 'games', 'tanques', 'layouts.js'));
const C = Sim.C;
const SERVER = args.server || 'ws://127.0.0.1:3000/ws';
const NAME = args.name || 'Claude';
const DIR = args.dir || __dirname;
const ORDER_FILE = path.join(DIR, 'orden.json');
const STATUS_FILE = path.join(DIR, 'estado.json');

let order = { modo: 'atacar', nivel: 0.8 };
function readOrder() {
  try {
    const o = JSON.parse(fs.readFileSync(ORDER_FILE, 'utf8'));
    if (o && typeof o === 'object') order = Object.assign({ modo: 'atacar', nivel: 0.8 }, o);
  } catch (e) { /* keep the last one */ }
}
readOrder();
setInterval(readOrder, 400);

// ---------------------------------------------------------------- world ---
let layoutIdx = -1, world = null, grid = null;
function setLayout(i) {
  if (i === layoutIdx) return;
  layoutIdx = i;
  const lay = Layouts.LIST[i];
  world = Sim.makeWorld(lay, Layouts.W, Layouts.H);
  // Passable cells and links (a tank fits at the centre and can drive to the neighbour)
  const pass = [];
  for (let cy = 0; cy < Layouts.ROWS; cy++) {
    pass.push([]);
    for (let cx = 0; cx < Layouts.COLS; cx++) {
      const p = { x: (cx + 0.5) * Layouts.CELL, y: (cy + 0.5) * Layouts.CELL };
      const q = { x: p.x, y: p.y };
      Sim.pushOutOfWalls(world, q, C.TANK_R + 2);
      pass[cy].push(Math.abs(q.x - p.x) + Math.abs(q.y - p.y) < 1);
    }
  }
  grid = { pass: pass };
}
function cellOf(x, y) {
  return { cx: Math.max(0, Math.min(Layouts.COLS - 1, Math.floor(x / Layouts.CELL))), cy: Math.max(0, Math.min(Layouts.ROWS - 1, Math.floor(y / Layouts.CELL))) };
}
function centre(c) { return { x: (c.cx + 0.5) * Layouts.CELL, y: (c.cy + 0.5) * Layouts.CELL }; }
function link(a, b) {
  const pa = centre(a), pb = centre(b);
  return Sim.lineOfSight(world, pa.x, pa.y, pb.x, pb.y, C.TANK_R + 1);
}
// BFS from a cell; returns { dist, prev } maps
function bfs(start) {
  const key = function (c) { return c.cy * Layouts.COLS + c.cx; };
  const dist = {}, prev = {};
  const q = [start];
  dist[key(start)] = 0;
  while (q.length) {
    const c = q.shift();
    const d = dist[key(c)];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const n = { cx: c.cx + dx, cy: c.cy + dy };
        if (n.cx < 0 || n.cy < 0 || n.cx >= Layouts.COLS || n.cy >= Layouts.ROWS) continue;
        if (!grid.pass[n.cy][n.cx] || dist[key(n)] !== undefined) continue;
        if (!link(c, n)) continue;
        dist[key(n)] = d + (dx && dy ? 1.42 : 1);
        prev[key(n)] = c;
        q.push(n);
      }
    }
  }
  return { dist: dist, prev: prev, key: key };
}
// Next waypoint from `from` towards `goal` (nearest reachable passable cell)
function nextStep(from, goal) {
  const fc = cellOf(from.x, from.y);
  const gc = cellOf(goal.x, goal.y);
  const b = bfs(fc);
  let target = null, bestD = Infinity;
  for (let cy = 0; cy < Layouts.ROWS; cy++) {
    for (let cx = 0; cx < Layouts.COLS; cx++) {
      const k = cy * Layouts.COLS + cx;
      if (b.dist[k] === undefined) continue;
      const d = Math.hypot(cx - gc.cx, cy - gc.cy);
      if (d < bestD) { bestD = d; target = { cx: cx, cy: cy }; }
    }
  }
  if (!target) return goal;
  let c = target, steps = [];
  while (c && !(c.cx === fc.cx && c.cy === fc.cy)) { steps.push(c); c = b.prev[b.key(c)]; }
  steps.reverse();
  // Smooth: furthest waypoint (up to 4 ahead) in straight line
  let wp = steps.length ? centre(steps[0]) : goal;
  for (let i = Math.min(steps.length, 4) - 1; i >= 0; i--) {
    const p = centre(steps[i]);
    if (Sim.lineOfSight(world, from.x, from.y, p.x, p.y, C.TANK_R + 1)) { wp = p; break; }
  }
  return wp;
}

// ---------------------------------------------------------------- shots ---
// Simulates a bullet fired at angle a from tank `me`. Returns { t, bounces } if it
// reaches `en` before `me` (and before 2.2 s), else null.
function tryShot(me, en, a) {
  const b = {
    x: me.x + Math.cos(a) * 1, y: me.y + Math.sin(a) * 1,
    vx: Math.cos(a) * C.BULLET_SPEED, vy: Math.sin(a) * C.BULLET_SPEED,
    bounces: 0, owner: 'me', safe: true
  };
  // move out of the barrel like the server does (sweep from the centre)
  const muzzle = C.MUZZLE / C.BULLET_SPEED;
  let r = Sim.moveBullet(world, b, muzzle, [], null);
  if (r) return null;
  const tanks = [{ id: 'en', x: en.x, y: en.y, alive: true }, { id: 'me', x: me.x, y: me.y, alive: true }];
  let t = muzzle;
  const dt = 1 / 30;
  let left = true;
  for (let i = 0; i < 66; i++) {
    // the bullet can hit its owner once it has left the owner's circle
    if (b.safe && Math.hypot(b.x - me.x, b.y - me.y) > C.TANK_R + C.BULLET_R + 1) b.safe = false;
    r = Sim.moveBullet(world, b, dt, b.safe ? [tanks[0]] : tanks, null);
    t += dt;
    if (r && r.tank) return r.tank.id === 'en' ? { t: t, bounces: b.bounces } : null;
    if (r && r.gone) return null;
  }
  return null;
}
function bestShot(me, en) {
  let best = null;
  const step = 1.5 * Math.PI / 180;
  for (let i = 0; i < 240; i++) {
    const a = Sim.wrapAngle(me.a + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * step);
    const s = tryShot(me, en, a);
    if (!s) continue;
    const turn = Math.abs(Sim.angleDiff(a, me.a)) / C.TURN_SPEED;   // seconds to turn there
    const cost = turn + s.t * 0.6 + s.bounces * 0.15;
    if (!best || cost < best.cost) best = { a: a, t: s.t, bounces: s.bounces, cost: cost };
  }
  if (best) {
    // Refine: aim at the middle of the window of angles that hit
    const fine = 0.2 * Math.PI / 180;
    let lo = 0, hi = 0;
    while (lo > -12 && tryShot(me, en, best.a + (lo - 1) * fine)) lo--;
    while (hi < 12 && tryShot(me, en, best.a + (hi + 1) * fine)) hi++;
    best.a = Sim.wrapAngle(best.a + (lo + hi) / 2 * fine);
    best.width = (hi - lo + 1) * fine;
  }
  return best;
}

// ---------------------------------------------------------------- danger ---
// Does any bullet hit a tank that moves with velocity (vx, vy) within `horizon` s?
function danger(me, bullets, vx, vy, horizon) {
  const dt = 1 / 30;
  const steps = Math.ceil(horizon / dt);
  const probe = { x: me.x, y: me.y };
  const bs = bullets.map(function (b) { return { x: b[1], y: b[2], vx: b[3], vy: b[4], bounces: 0, owner: b[5], safe: false }; });
  for (let i = 0; i < steps; i++) {
    probe.x += vx * dt; probe.y += vy * dt;
    Sim.pushOutOfWalls(world, probe, C.TANK_R);
    const tk = [{ id: 'me', x: probe.x, y: probe.y, alive: true }];
    for (let k = 0; k < bs.length; k++) {
      if (!bs[k]) continue;
      // inflate a bit: we react late
      const r = Sim.moveBullet(world, bs[k], dt, tk, null);
      if (r && r.tank) return (i + 1) * dt;
      if (r && r.gone) bs[k] = null;
    }
  }
  return 0;
}

// ---------------------------------------------------------------- network ---
let mySlot = 0, meta = null, myIdx = -1;
let lastShotAt = 0, lastSend = 0, lastInput = '';
let aim = null, aimAt = 0, lastPulseAt = 0;
const status = { yo: NAME, modo: order.modo };

const phone = new WebSocket(SERVER);
const eye = new WebSocket(SERVER);   // watches the 30 Hz state like a TV
phone.on('open', function () { phone.send(JSON.stringify({ t: 'join', name: NAME, cid: 'bot-' + NAME.toLowerCase() })); });
eye.on('open', function () { eye.send(JSON.stringify({ t: 'hello', role: 'tv' })); });
phone.on('message', function (d) {
  let m; try { m = JSON.parse(d); } catch (e) { return; }
  if (m.t === 'joined') {
    mySlot = m.slot;
    console.log('Dentro como ' + m.name + ' (hueco ' + m.slot + ')');
    if (args.pick) setTimeout(function () { phone.send(JSON.stringify({ t: 'pick', game: 'tanques' })); }, 800);
  }
  if (m.t === 'kmeta') onMeta(m);
});
eye.on('message', function (d) {
  let m; try { m = JSON.parse(d); } catch (e) { return; }
  if (m.t === 'kmeta') onMeta(m);
  else if (m.t === 'k.s') onState(m);
});
function onMeta(m) {
  meta = m;
  myIdx = m.tanks ? m.tanks.indexOf(mySlot) : -1;
  if (typeof m.layout === 'number') setLayout(m.layout);
}
function send(obj) {
  if (phone.readyState === 1) phone.send(JSON.stringify(obj));
}
function input(obj) {
  const s = JSON.stringify(obj);
  const now = Date.now();
  if (s !== lastInput || now - lastSend > 250) { send(obj); lastInput = s; lastSend = now; }
}

function onState(st) {
  if (!meta || myIdx < 0 || !world || meta.phase !== 'play' || meta.paused) { input({ t: 'k.in', k: [0, 0] }); return; }
  // flat arrays: k = [x, y, a, alive] per tank, b = [id, x, y, vx, vy, owner] per bullet
  const K = st.k || [];
  const mk = K.slice(myIdx * 4, myIdx * 4 + 4), ek = K.slice((1 - myIdx) * 4, (1 - myIdx) * 4 + 4);
  if (mk.length < 4 || ek.length < 4 || !mk[3]) { input({ t: 'k.in', k: [0, 0] }); return; }
  const me = { x: mk[0], y: mk[1], a: mk[2] };
  const en = { x: ek[0], y: ek[1], a: ek[2] };
  const lvl = Math.max(0, Math.min(1, Number(order.nivel) || 0.8));
  const now = Date.now();
  const bullets = [];
  const BF = st.b || [];
  for (let i = 0; i + 5 < BF.length; i += 6) bullets.push(BF.slice(i, i + 6));
  const mine = bullets.filter(function (b) { return b[5] === mySlot; }).length;
  status.modo = order.modo;

  // 1) Dodge if a bullet is coming (better levels look further ahead)
  const horizon = 0.35 + 0.5 * lvl;
  if (order.modo === 'quieto') { input({ t: 'k.in', k: [0, 0] }); status.accion = 'quieto'; return; }
  if (bullets.length && danger(me, bullets, 0, 0, horizon)) {
    let bestDir = null, bestScore = -Infinity;
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6;
      const vx = Math.cos(a) * C.TANK_SPEED * 0.8, vy = Math.sin(a) * C.TANK_SPEED * 0.8;
      const hit = danger(me, bullets, vx, vy, horizon);
      // prefer directions we already face (the tank must turn first)
      const sc = (hit ? -10 + hit : 0) - Math.abs(Sim.angleDiff(a, me.a)) * 0.6;
      if (sc > bestScore) { bestScore = sc; bestDir = a; }
    }
    if (bestDir !== null && Math.random() < 0.5 + 0.5 * lvl) {
      status.accion = 'esquivar';
      input({ t: 'k.in', s: [bestDir, 1] });
      return;
    }
  }

  // 2) Aim (a few times per second): a direct or bouncing shot
  if (now - aimAt > 160 - 80 * lvl) { aim = bestShot(me, en); aimAt = now; }
  if (order.modo !== 'quieto' && aim && Math.abs(Sim.angleDiff(aim.a, me.a)) < Math.PI / 3 && aim.t < 1.5 && aim.bounces <= 2) {
    const diff = Sim.angleDiff(aim.a, me.a);
    // Fire only if the barrel, as it is NOW, really hits (better levels are pickier)
    const cur = tryShot(me, en, me.a);
    if (cur && cur.t < 1.6 && mine < 4 && now - lastShotAt > 330 - 150 * lvl) {
      send({ t: 'k.fire' });
      lastShotAt = now;
      aim = null; aimAt = 0;
      status.disparos = (status.disparos || 0) + 1;
      if (args.debug) console.log('FIRE', me.x.toFixed(0), me.y.toFixed(0), me.a.toFixed(3), 't', cur.t.toFixed(2), 'b', cur.bounces, 'en', en.x.toFixed(0), en.y.toFixed(0));
      input({ t: 'k.in', k: [0, 0] });
    } else if (now - lastPulseAt < 110) {
      input({ t: 'k.in', k: [0, 0] });   // let the last pulse show up in the state
    } else if (Math.abs(diff) < 0.12) {
      lastPulseAt = now;
      // fine aim: a short pulse of turning, then stop
      const ms = Math.max(4, Math.abs(diff) / C.TURN_SPEED * 1000);
      send({ t: 'k.in', k: [Math.sign(diff), 0] });
      lastInput = '';
      setTimeout(function () { send({ t: 'k.in', k: [0, 0] }); lastInput = JSON.stringify({ t: 'k.in', k: [0, 0] }); }, ms);
    } else {
      input({ t: 'k.in', k: [Math.sign(diff), 0] });
    }
    status.accion = 'apuntar';
    return;
  }

  // 3) Move according to the order
  let goal = en;
  if (order.modo === 'defender') {
    // the reachable cell furthest from the enemy with no line of sight to it
    goal = { x: Layouts.W - en.x, y: Layouts.H - en.y };
  } else if (order.modo === 'flanquear') {
    const ang = Math.atan2(me.y - en.y, me.x - en.x) + Math.PI / 2;
    goal = { x: en.x + Math.cos(ang) * 320, y: en.y + Math.sin(ang) * 320 };
  } else if (order.modo === 'quieto') {
    input({ t: 'k.in', k: [0, 0] });
    status.accion = 'quieto';
    return;
  }
  goal.x = Math.max(40, Math.min(Layouts.W - 40, goal.x));
  goal.y = Math.max(40, Math.min(Layouts.H - 40, goal.y));
  const wp = nextStep(me, goal);
  const close = Math.hypot(en.x - me.x, en.y - me.y) < 180 && order.modo === 'atacar';
  input({ t: 'k.in', s: [Math.atan2(wp.y - me.y, wp.x - me.x), close ? 0.3 : 1] });
  status.accion = 'moverse';
}

setInterval(function () {
  const s = Object.assign({}, status, {
    fase: meta && meta.phase, ronda: meta && meta.round, mapa: meta && meta.layoutName,
    marcador: meta && meta.scores, yoSoy: myIdx, nivel: order.nivel, hora: new Date().toISOString()
  });
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(s)); } catch (e) { /* noop */ }
}, 1000);

function bye(code) { try { phone.close(); eye.close(); } catch (e) { /* noop */ } setTimeout(function () { process.exit(code); }, 300); }
phone.on('close', function () { console.log('Desconectado'); bye(0); });
phone.on('error', function (e) { console.log('Error: ' + e.message); bye(1); });
eye.on('error', function () {});
if (args.segundos) setTimeout(function () { bye(0); }, Number(args.segundos) * 1000);
