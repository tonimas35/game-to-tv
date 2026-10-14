'use strict';
/*
 * «Rivales bot» in tests: the REAL hub, in this process (no network, no
 * timers) with a virtual clock, so a whole duel takes a second or two.
 *
 *   const arena = require('./helpers/bot-arena');
 *   const A = arena.create({ game: 'tanques', seed: 7 });
 *   A.addBot('dificil');                 // through { t: 'bot.add' } from the human phone, as in the app
 *   A.drive(require('../src/games/tanques/bot'), 'facil');   // the human phone plays with a bot module…
 *   A.drive({ create: function (ctx) { return { onTv: …, tick: … }; } });  // …or with a script (same contract)
 *   A.pick();                            // { t: 'pick', game } from the human phone
 *   A.run(30, function () { return A.last('kmeta').phase === 'end'; });     // virtual seconds, stop condition
 *   A.last('kmeta') · A.events('k.hit') · A.sent (what the hub's bots sent) · A.hub.botStats() · A.timing() · A.close()
 *
 * The human phone is slot 1 (it joins first): bots go after it. Date.now and
 * Math.random are replaced while the arena is open (seeded: the same seed
 * plays the same duel); close() puts them back.
 */
const path = require('path');
const { createHub } = require('../../src/server/hub');
const { loadGames } = require('../../src/games');
const Kit = require('../../src/games/bot-kit');

const DT_MS = 1000 / 60;

function fakeWs(onText) {
  const ws = { readyState: 1, handlers: {} };
  ws.on = function (ev, fn) { ws.handlers[ev] = fn; };
  ws.send = function (s) { onText(s); };
  ws.close = function () { ws.readyState = 3; if (ws.handlers.close) ws.handlers.close(); };
  ws.terminate = ws.close;
  ws.ping = function () {};
  ws.msg = function (o) { ws.handlers.message(Buffer.from(JSON.stringify(o))); };
  return ws;
}

function create(opts) {
  opts = opts || {};
  const realNow = Date.now, realRandom = Math.random;
  let vt = opts.startMs || 1700000000000;
  const random = Kit.seeded(opts.seed || 1);
  Date.now = function () { return Math.floor(vt); };
  Math.random = random;

  const all = loadGames(opts.gamesDirs || [path.join(__dirname, '..', '..', 'src', 'games')], function () {});
  const g = all.byId[opts.game];
  if (!g) throw new Error('bot-arena: no existe el juego ' + opts.game);
  // Times what the hub's bots do (ms per call), without touching the bot module
  // worst: the slowest single call; stepWorst: the most bot time in one step; over1: steps above 1 ms
  const timing = { calls: 0, ms: 0, worst: 0, ticks: 0, cur: 0, steps: 0, stepWorst: 0, over1: 0 };
  const entry = Object.assign({}, g);
  if (g.bot) {
    entry.bot = {
      create: function (ctx) {
        // What the bot sends (the last 2000 messages, for tests): A.sent
        const send = ctx.send;
        ctx.send = function (msg) { A.sent.push({ slot: ctx.slot, msg: JSON.parse(JSON.stringify(msg)) }); if (A.sent.length > 2000) A.sent.shift(); return send(msg); };
        const inst = g.bot.create(ctx) || {};
        const wrapped = {};
        ['onTv', 'onSlot', 'tick', 'stop'].forEach(function (k) {
          if (typeof inst[k] !== 'function') return;
          wrapped[k] = function (a) {
            const t0 = process.hrtime();
            try { return inst[k](a); } finally {
              const d = process.hrtime(t0);
              const ms = d[0] * 1e3 + d[1] / 1e6;
              timing.calls++; timing.ms += ms; timing.cur += ms; if (ms > timing.worst) timing.worst = ms;
              if (k === 'tick') timing.ticks++;
            }
          };
        });
        wrapped._inner = inst;
        A.bots.push(wrapped);
        return wrapped;
      }
    };
  }
  const games = { list: [entry], byId: {} };
  games.byId[entry.id] = entry;
  const logs = [];
  const hub = createHub({ games: games, log: function (s) { logs.push(s); }, random: random, maxPlayers: opts.slots || 6 });

  const last = {};
  const evs = [];
  const A = {
    hub: hub, game: g, logs: logs, bots: [], sent: [], random: random,
    tvLast: last,
    now: function () { return vt; }
  };

  // The TV: keeps the last message of each type and the events
  let driver = null, driverCtx = null;
  const tv = fakeWs(function (s) {
    const m = JSON.parse(s);
    last[m.t] = m;
    if (m.t === 'ev' || m.t === 'k.hit' || /\.hit$|^m\.ev$/.test(m.t)) evs.push(m);
    if (driver && driver.onTv) driver.onTv(m);
  });
  hub.onConnection(tv);
  tv.msg({ t: 'hello', role: 'tv' });

  // The human phone (slot 1)
  const phoneLast = {};
  const queue = [];
  const phone = fakeWs(function (s) {
    const m = JSON.parse(s);
    phoneLast[m.t] = m;
    if (driver && driver.onSlot) driver.onSlot(m);
  });
  hub.onConnection(phone);
  phone.msg({ t: 'join', name: opts.humanName || 'Humano', cid: 'arena-humano' });
  A.phone = phone;
  A.phoneLast = phoneLast;
  A.slot = phoneLast.joined ? phoneLast.joined.slot : 1;

  A.send = function (msg) { phone.msg(msg); };
  A.addBot = function (level) {
    phone.msg({ t: 'bot.add', level: level });
    const h = last.hub;
    let slot = -1;
    if (h) h.players.forEach(function (p) { if (p && p.bot) slot = p.slot; });
    return slot;
  };
  /** The human phone plays with a bot module (or a script with the same contract). */
  A.drive = function (mod, level) {
    level = level || 'normal';
    const values = { facil: 0.25, normal: 0.5, dificil: 0.75, imposible: 1 };
    driverCtx = {
      slot: A.slot, level: level, levelValue: values[level] || 0.5, name: 'Humano', gameId: g.id,
      send: function (msg) { queue.push(JSON.stringify(msg)); return true; },
      random: random, now: function () { return Date.now(); }, log: function () {}
    };
    driver = mod.create(driverCtx) || {};
    return driver;
  };
  A.pick = function () { phone.msg({ t: 'pick', game: g.id }); };
  A.step = function () {
    vt += DT_MS;
    // What the human phone sent goes in before the tick, like a real message
    while (queue.length) phone.handlers.message(Buffer.from(queue.shift()));
    // The driver thinks with what it has seen so far, like the hub's bots
    // (they tick after the game and before its new state goes out): a fair duel
    if (driver && driver.tick) driver.tick(1 / 60);
    timing.cur = 0;
    hub.stepForTests(1);
    timing.steps++;
    if (timing.cur > timing.stepWorst) timing.stepWorst = timing.cur;
    if (timing.cur > 1) timing.over1++;
  };
  /** Runs up to `secs` virtual seconds; stops early when until() is true. Returns the virtual seconds run. */
  A.run = function (secs, until) {
    const n = Math.round(secs * 60);
    for (let i = 0; i < n; i++) {
      A.step();
      if (until && until()) return (i + 1) / 60;
    }
    return secs;
  };
  A.last = function (t) { return last[t] || null; };
  A.events = function (t) { return evs.filter(function (e) { return !t || e.t === t; }); };
  A.timing = function () { return Object.assign({ avgTickMs: timing.ticks ? timing.ms / timing.ticks : 0 }, timing); };
  A.resetTiming = function () { Object.keys(timing).forEach(function (k) { timing[k] = 0; }); };
  A.close = function () {
    try { hub.stop(); } catch (e) { /* noop */ }
    if (driver && driver.stop) driver.stop();
    Date.now = realNow;
    Math.random = realRandom;
  };
  return A;
}

module.exports = { create: create };
