'use strict';
/*
 * Small helpers for the «Rivales bot» (src/games/<id>/bot.js). Nothing here
 * is required: a bot only needs create(ctx) -> { onTv, onSlot, tick, stop }
 * (docs/crear-un-juego.md, «Rivales bot»). Runs on the server, also inside
 * the TV (Node 12): keep it cheap.
 *
 *   const Kit = require('../bot-kit');
 *   const P = Kit.byLevel(ctx.level, { facil: {...}, normal: {...}, dificil: {...}, imposible: {...} });
 *   const input = Kit.inputSender(ctx);          // sends only changes, plus a heartbeat
 *   const seen = Kit.delayLine(P.reactMs);       // what the bot «sees», a bit late
 */

/** The value of a table for a level: { facil, normal, dificil, imposible } (missing: the closest one). */
function byLevel(level, table) {
  const order = ['facil', 'normal', 'dificil', 'imposible'];
  if (table[level] !== undefined) return table[level];
  let k = order.indexOf(level);
  if (k < 0) k = 1;
  for (let d = 1; d < order.length; d++) {
    if (k - d >= 0 && table[order[k - d]] !== undefined) return table[order[k - d]];
    if (k + d < order.length && table[order[k + d]] !== undefined) return table[order[k + d]];
  }
  return undefined;
}

/** Linear between `easy` (levelValue 0.25, «Fácil») and `hard` (1, «Imposible»). */
function lerpLevel(levelValue, easy, hard) {
  const t = Math.max(0, Math.min(1, (levelValue - 0.25) / 0.75));
  return easy + (hard - easy) * t;
}

/**
 * Sends a phone input like a phone does: only when it changes, plus the same
 * input again every `heartbeatMs` (games forget an input after ~1.5 s).
 *   const input = inputSender(ctx); input.set({ t: 'k.in', s: [a, 1] }); … input.tick();
 */
function inputSender(ctx, heartbeatMs) {
  heartbeatMs = heartbeatMs || 500;
  let last = '', lastAt = -Infinity, cur = null;
  function flush(force) {
    if (!cur) return;
    const key = JSON.stringify(cur);
    const now = ctx.now();
    if (!force && key === last && now - lastAt < heartbeatMs) return;
    if (ctx.send(cur)) { last = key; lastAt = now; }
  }
  return {
    set: function (msg) { cur = msg; flush(false); },
    tick: function () { flush(false); },
    resend: function () { flush(true); },
    current: function () { return cur; },
    reset: function () { last = ''; lastAt = -Infinity; cur = null; }
  };
}

/**
 * Reaction time: push what arrives, get what was there `ms` ago (the newest
 * item at least that old; the oldest one if none is). Keeps at most `max` items.
 */
function delayLine(ms, max) {
  max = max || 40;
  const items = [];
  return {
    push: function (t, v) { items.push({ t: t, v: v }); if (items.length > max) items.shift(); },
    get: function (now) {
      for (let i = items.length - 1; i >= 0; i--) if (now - items[i].t >= ms) return items[i].v;
      return items.length ? items[0].v : null;
    },
    getPair: function (now, gapMs) {   // the delayed item and one about gapMs older (for speeds)
      let a = -1;
      for (let i = items.length - 1; i >= 0; i--) if (now - items[i].t >= ms) { a = i; break; }
      if (a < 0) a = items.length ? 0 : -1;
      if (a < 0) return null;
      let b = a;
      while (b > 0 && items[a].t - items[b].t < gapMs) b--;
      return { now: items[a].v, nowT: items[a].t, before: items[b].v, beforeT: items[b].t };
    },
    latest: function () { return items.length ? items[items.length - 1].v : null; },
    clear: function () { items.length = 0; }
  };
}

/** Normal noise (mean 0, deviation 1) from a 0..1 random function. */
function gauss(random) {
  let u = 0;
  while (u <= 1e-12) u = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** A seeded random function (mulberry32): the same numbers for the same seed (tests). */
function seeded(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs fn at most every `ms` (by ctx.now()): if (think.due()) { … } */
function every(ctx, ms) {
  let at = -Infinity;
  return {
    due: function () { const n = ctx.now(); if (n - at >= ms) { at = n; return true; } return false; },
    reset: function () { at = -Infinity; },
    setMs: function (v) { ms = v; }
  };
}

module.exports = { byLevel: byLevel, lerpLevel: lerpLevel, inputSender: inputSender, delayLine: delayLine, gauss: gauss, seeded: seeded, every: every };
