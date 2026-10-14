'use strict';
/*
 * «Tanques»: a 1 vs 1 tank duel in a small maze, seen from above. Written
 * from scratch for game-to-tv.
 *
 * Each player drives a tank in their colour. Bullets are fast and bounce off
 * the walls (up to 5 times, or 6 s) and kill ANY tank they touch, their owner
 * too. A round ends when a tank blows up, plus a 1.5 s beat to see it; if
 * both blow up within 0.3 s nobody scores. First to 5 wins. Every round
 * starts with 3-2-1 on another hand-made arena (layouts.js), the tanks
 * swapping corners. Physics in sim.js.
 *
 * Fixed step: the hub ticks at 60 Hz; the state goes to the TV at 30 Hz and
 * the TV interpolates. The phones only send inputs (on change, plus a
 * heartbeat; an input older than 1.5 s counts as released). If a player of
 * the duel drops, everything freezes («Pausa»); when they are back, 3-2-1
 * and on. A player who leaves for good: with someone else in the room a new
 * duel starts with them; otherwise back to the menu (the hub).
 *
 * Messages it receives (phones; the TV only sends k.again):
 *   { t: 'k.in', s: [angle, 0..1] }       stick: drive towards that angle (radians, screen axes)
 *   { t: 'k.in', k: [turn, drive] }       buttons: -1/0/1 each (tank controls)
 *   { t: 'k.fire' }                       shoot
 *   { t: 'k.again' }                      another duel (only at the end)
 * Messages it sends:
 *   { t: 'kmeta', ... }                   public state (TV and phones), see buildMeta
 *   { t: 'k.s', ts, k, b, e }             30 Hz state (TV only):
 *        k: [x, y, angle, alive] per tank, b: [id, x, y, vx, vy, ownerSlot] per bullet,
 *        e: events since the last state [type, x, y, slot] (f fire, b bounce,
 *           x tank blown up, p bullet gone)
 *   { t: 'k.hit', slot, by, self }        a tank blew up (phones vibrate)
 *
 * Arena units: 1920x960 (the TV draws it under a 120 px score bar).
 * Environment (tests): TANQUES_DEBUG_SPEED (1) speeds up the countdowns and
 * the beat; TANQUES_TO_WIN (5) shortens the duel.
 */
const Sim = require('./sim');
const Layouts = require('./layouts');

const SPEED = Math.max(0.1, parseFloat(process.env.TANQUES_DEBUG_SPEED) || 1);
const TO_WIN = Math.max(1, parseInt(process.env.TANQUES_TO_WIN, 10) || 5);   // env: only for tests
const COUNTDOWN_S = 3;
const BEAT_S = 1.5;
const DRAW_S = 0.3;
const FIRE_COOLDOWN_S = 0.25;
const MAX_BULLETS = 4;
const INPUT_TIMEOUT_MS = 1500;

function r1(v) { return Math.round(v * 10) / 10; }
function idle() { return { mode: 's', a: 0, m: 0, turn: 0, drive: 0 }; }

function create(api, opts) {
  opts = opts || {};
  const random = opts.random || Math.random;
  const clock = opts.now || Date.now;
  const toWin = opts.toWin || TO_WIN;
  const layouts = opts.layouts || Layouts.LIST;
  const S = {
    match: 0,
    phase: 'countdown',   // countdown -> play -> over (the beat) -> countdown… -> end
    left: 0,              // countdown seconds left
    resumed: false,       // the countdown comes after a pause (same round)
    paused: false,
    round: 0,
    layoutBase: 0,
    layout: 0,
    world: null,
    tanks: [],            // { slot, x, y, a, alive, cool, input, inputAt }
    bullets: [],          // { id, owner (slot), x, y, vx, vy, age, bounces, safe }
    scores: [0, 0],
    last: null,           // result of the round being shown: { winner (slot+1, 0 = draw), self }
    winner: 0,            // slot+1 of the winner of the duel (end)
    overT: 0,
    decided: false,
    events: [],
    nextId: 1
  };
  let dirty = true;
  let lastMetaAt = 0;
  let lastCount = -1;
  let lastStateAt = 0;
  let stopped = false;

  function log(s) { api.log('[tanques] ' + s); }
  function nameOfTank(k) { return api.name(S.tanks[k].slot); }
  function tankIndex(slot) {
    for (let k = 0; k < S.tanks.length; k++) if (S.tanks[k].slot === slot) return k;
    return -1;
  }
  function playersConnected() {
    return S.tanks.length > 0 && S.tanks.every(function (t) { return api.isConnected(t.slot); });
  }
  function event(type, x, y, slot) { S.events.push([type, Math.round(x), Math.round(y), slot]); }

  function newMatch() {
    S.match++;
    const order = api.players().slice().sort(function (a, b) { return a - b; }).slice(0, 2);
    S.tanks = order.map(function (slot) {
      return { slot: slot, x: 0, y: 0, a: 0, alive: true, cool: 0, input: idle(), inputAt: 0 };
    });
    S.scores = [0, 0];
    S.winner = 0;
    S.round = 0;
    S.layoutBase = Math.floor(random() * layouts.length) % layouts.length;
    log('Duelo ' + S.match + ': ' + order.map(api.name).join(' contra '));
    startRound();
  }

  function startRound() {
    S.round++;
    S.layout = (S.layoutBase + S.round - 1) % layouts.length;
    S.world = Sim.makeWorld(layouts[S.layout], Layouts.W, Layouts.H);
    // The tanks swap corners every round
    const swap = S.round % 2 === 0;
    S.tanks.forEach(function (t, k) {
      const sp = layouts[S.layout].spawns[swap ? 1 - k : k];
      t.x = sp.x; t.y = sp.y; t.a = sp.a;
      t.alive = true;
      t.selfKill = false;
      t.cool = 0;
      t.input = idle();
    });
    S.bullets = [];
    S.last = null;
    S.decided = false;
    S.overT = 0;
    S.resumed = false;
    S.phase = 'countdown';
    S.left = COUNTDOWN_S;
    dirty = true;
  }

  // ---------------------------------------------------------------- inputs
  function setInput(k, msg) {
    const t = S.tanks[k];
    if (Array.isArray(msg.s)) {
      const a = Number(msg.s[0]), m = Number(msg.s[1]);
      if (!isFinite(a) || !isFinite(m)) return;
      t.input = { mode: 's', a: Sim.wrapAngle(a), m: Math.max(0, Math.min(1, m)), turn: 0, drive: 0 };
    } else if (Array.isArray(msg.k)) {
      const tr = Number(msg.k[0]), dr = Number(msg.k[1]);
      if (!isFinite(tr) || !isFinite(dr)) return;
      t.input = { mode: 'k', a: 0, m: 0, turn: Math.sign(tr), drive: Math.sign(dr) };
    } else return;
    t.inputAt = clock();
  }

  function fire(k) {
    const t = S.tanks[k];
    if (S.phase !== 'play' || S.paused || !t.alive || t.cool > 0) return false;
    let mine = 0;
    S.bullets.forEach(function (b) { if (b.owner === t.slot) mine++; });
    if (mine >= MAX_BULLETS) return false;
    const b = {
      id: S.nextId++, owner: t.slot, x: t.x, y: t.y,
      vx: Math.cos(t.a) * Sim.C.BULLET_SPEED, vy: Math.sin(t.a) * Sim.C.BULLET_SPEED,
      age: 0, bounces: 0, safe: true
    };
    t.cool = FIRE_COOLDOWN_S;
    // From the centre to the muzzle with the same sweep: a barrel against a
    // wall bounces the bullet right there
    const r = Sim.moveBullet(S.world, b, Sim.C.MUZZLE / Sim.C.BULLET_SPEED, tankTargets(), function (x, y) { event('b', x, y, t.slot + 1); });
    event('f', t.x + Math.cos(t.a) * Sim.C.MUZZLE, t.y + Math.sin(t.a) * Sim.C.MUZZLE, t.slot + 1);
    if (r && r.tank) { hit(r.tank, b); return true; }
    S.bullets.push(b);
    return true;
  }

  // ---------------------------------------------------------------- simulation
  function tankTargets() {
    return S.tanks.map(function (t) { return { id: t.slot, x: t.x, y: t.y, alive: t.alive }; });
  }

  function hit(target, b) {
    const k = tankIndex(target.id);
    const t = S.tanks[k];
    // The round is already decided: the survivor is safe (the bullet just fizzles)
    if (S.decided || !t.alive) { event('p', b.x, b.y, b.owner + 1); return; }
    event('x', t.x, t.y, t.slot + 1);
    t.alive = false;
    t.input = idle();
    const self = b.owner === t.slot;
    t.selfKill = self;
    api.broadcast({ t: 'k.hit', slot: t.slot + 1, by: b.owner + 1, self: self });
    log(nameOfTank(k) + (self ? ' se da con su propia bala' : ' recibe una bala de ' + api.name(b.owner)));
    if (S.phase === 'play') { S.phase = 'over'; S.overT = 0; }
    dirty = true;
  }

  function stepWorld(dt) {
    const now = clock();
    S.tanks.forEach(function (t) {
      if (t.inputAt && now - t.inputAt > INPUT_TIMEOUT_MS) { t.input = idle(); t.inputAt = 0; }
      t.cool = Math.max(0, t.cool - dt);
      if (t.alive) Sim.driveTank(S.world, t, t.input, dt);
    });
    if (S.tanks.length === 2 && S.tanks[0].alive && S.tanks[1].alive) Sim.separateTanks(S.world, S.tanks[0], S.tanks[1]);
    const targets = tankTargets();
    const keep = [];
    for (let i = 0; i < S.bullets.length; i++) {
      const b = S.bullets[i];
      b.age += dt;
      if (b.age >= Sim.C.BULLET_LIFE) { event('p', b.x, b.y, b.owner + 1); continue; }
      const r = Sim.moveBullet(S.world, b, dt, targets, function (x, y) { event('b', x, y, b.owner + 1); });
      if (r && r.tank) {
        hit(r.tank, b);
        targets.forEach(function (tg) { tg.alive = S.tanks[tankIndex(tg.id)].alive; });
        continue;
      }
      if (r && r.gone) { event('p', r.x, r.y, b.owner + 1); continue; }
      if (b.safe) {
        const o = S.tanks[tankIndex(b.owner)];
        if (!o || Math.hypot(b.x - o.x, b.y - o.y) > Sim.C.TANK_R + Sim.C.BULLET_R + 0.5) b.safe = false;
      }
      keep.push(b);
    }
    S.bullets = keep;
  }

  function decide() {
    S.decided = true;
    const alive = [];
    S.tanks.forEach(function (t, k) { if (t.alive) alive.push(k); });
    if (alive.length === 1) {
      const k = alive[0];
      S.scores[k]++;
      const loser = S.tanks[1 - k];
      S.last = { winner: S.tanks[k].slot + 1, self: !!(loser && loser.selfKill) };
      log('Punto para ' + nameOfTank(k) + ' (' + S.scores.join('-') + ')');
    } else {
      S.last = { winner: 0, self: false };
      log('Empate: los dos a la vez, nadie puntúa');
    }
    dirty = true;
  }

  function afterBeat() {
    let best = -1;
    S.scores.forEach(function (s, k) { if (s >= toWin) best = k; });
    if (best >= 0) {
      S.phase = 'end';
      S.winner = S.tanks[best].slot + 1;
      S.bullets = [];
      log('¡' + nameOfTank(best) + ' gana el duelo ' + S.scores.join('-') + '!');
      dirty = true;
    } else {
      startRound();
    }
  }

  function tick(dt) {
    if (stopped || !S.tanks.length) return;
    if (S.phase !== 'end') {
      const ok = playersConnected();
      if (!ok) {
        if (!S.paused) { S.paused = true; dirty = true; log('Pausa: falta un jugador'); }
        return;
      }
      if (S.paused) {
        S.paused = false;
        S.tanks.forEach(function (t) { t.input = idle(); t.inputAt = 0; });
        if (S.phase === 'play') { S.phase = 'countdown'; S.resumed = true; }
        if (S.phase === 'countdown') S.left = COUNTDOWN_S;
        dirty = true;
        log('Se reanuda');
      }
    }
    switch (S.phase) {
      case 'countdown':
        S.left -= dt * SPEED;
        if (S.left <= 0) { S.left = 0; S.phase = 'play'; S.resumed = false; dirty = true; }
        else if (Math.ceil(S.left - 1e-6) !== lastCount) dirty = true;
        break;
      case 'play':
        stepWorld(dt);
        break;
      case 'over':
        stepWorld(dt);
        S.overT += dt;
        if (!S.decided && S.overT >= DRAW_S - 1e-9) decide();
        if (S.overT >= Math.max(DRAW_S, BEAT_S / SPEED) - 1e-9) afterBeat();
        break;
    }
  }

  // ---------------------------------------------------------------- messages
  function buildMeta() {
    const lay = layouts[S.layout];
    return {
      t: 'kmeta',
      match: S.match,
      phase: S.phase,
      round: S.round,
      count: S.phase === 'countdown' ? Math.max(1, Math.ceil(S.left - 1e-6)) : 0,
      resumed: S.resumed,
      paused: S.paused,
      waiting: S.tanks.filter(function (t) { return !api.isConnected(t.slot); }).map(function (t) { return api.name(t.slot); }),
      toWin: toWin,
      layout: S.layout,
      layoutName: lay ? lay.name : '',
      tanks: S.tanks.map(function (t) { return t.slot + 1; }),
      alive: S.tanks.map(function (t) { return t.alive; }),
      scores: S.scores.slice(),
      last: S.last,
      winner: S.winner,
      speed: SPEED
    };
  }

  function sendMeta() {
    dirty = false;
    lastMetaAt = Date.now();
    lastCount = S.phase === 'countdown' ? Math.ceil(S.left - 1e-6) : -1;
    api.broadcast(JSON.stringify(buildMeta()));
  }

  function buildState() {
    const k = [];
    S.tanks.forEach(function (t) { k.push(r1(t.x), r1(t.y), Math.round(t.a * 1000) / 1000, t.alive ? 1 : 0); });
    const b = [];
    S.bullets.forEach(function (x) { b.push(x.id, r1(x.x), r1(x.y), Math.round(x.vx), Math.round(x.vy), x.owner + 1); });
    return { t: 'k.s', ts: Date.now(), ph: S.phase, k: k, b: b, e: S.events };
  }

  function sendState() {
    if (api.tvs && api.tvs.size) api.sendTvs(JSON.stringify(buildState()));
    S.events = [];
  }

  function playerLeft(i) {
    if (tankIndex(i) < 0) { dirty = true; return true; }  // was only watching
    const rest = api.players();
    if (rest.length >= 2) {
      log(api.name(i) + ' se va: nuevo duelo con los que quedan');
      newMatch();
      return true;
    }
    return false;
  }

  return {
    id: 'tanques',
    start: newMatch,
    stop: function () { stopped = true; },
    tick: tick,
    flush: function () {
      if (dirty || Date.now() - lastMetaAt >= 1000) sendMeta();
      // ~30 Hz, by the clock (the hub may call flush less often when the machine is busy)
      const now = Date.now();
      if (now - lastStateAt >= (S.phase === 'end' ? 1000 : 31)) { lastStateAt = now; sendState(); }
    },
    onMessage: function (who, msg) {
      if (stopped || !msg) return;
      if (msg.t === 'k.again') { if (S.phase === 'end') newMatch(); return; }
      if (who < 0) return;
      const k = tankIndex(who);
      if (k < 0) return;                     // watching: entered mid-duel
      if (msg.t === 'k.in') setInput(k, msg);
      else if (msg.t === 'k.fire') fire(k);
    },
    onPlayerDisconnected: function () { dirty = true; },
    onPlayerJoined: function (i) { api.sendSlot(i, buildMeta()); dirty = true; },
    onPlayerLeft: playerLeft,
    syncTv: function (ws) { api.sendWs(ws, buildMeta()); api.sendWs(ws, buildState()); },
    // For tests
    _state: S,
    _meta: buildMeta,
    _stateMsg: buildState
  };
}

// Sent to the TV page with the game list (G2T.gameById('tanques').tv)
const tvInfo = {
  w: Layouts.W,
  h: Layouts.H,
  tankR: Sim.C.TANK_R,
  bulletR: Sim.C.BULLET_R,
  layouts: Layouts.LIST.map(function (l) { return { name: l.name, walls: l.walls }; })
};

module.exports = {
  create: create,
  tvInfo: tvInfo,
  TO_WIN: TO_WIN, COUNTDOWN_S: COUNTDOWN_S, BEAT_S: BEAT_S, DRAW_S: DRAW_S,
  FIRE_COOLDOWN_S: FIRE_COOLDOWN_S, MAX_BULLETS: MAX_BULLETS, INPUT_TIMEOUT_MS: INPUT_TIMEOUT_MS
};
