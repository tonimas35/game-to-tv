'use strict';
/*
 * «Sumo»: the computer opponent («Rivales bot», see docs/crear-un-juego.md).
 * create(ctx) -> { onTv, onSlot, tick, stop }.
 *
 * It sees what the TV sees: the 30 Hz state 's' (both balls: position,
 * velocity, dashing, the ring radius), `smeta` (phase, who is who, the
 * cooldowns) and the events (who dashed). It plays with the phone's
 * messages: the joystick { t: 's.j', x, y } (rounded to 0.01, inside the
 * unit circle, sent only when it changes, at most once a frame like the
 * phone's requestAnimationFrame) and the dash { t: 's.d' } when its
 * cooldown is over (it learns it from 's.cd', as the phone does).
 *
 * How it thinks, several times per second: it tries a set of joystick
 * directions, with and without a dash, and plays each one forward for a
 * short while with the game's own physics (physics.js) against a guess or
 * two of what the rival does (pushes towards it, keeps its input). Each try
 * is scored by how near the edge each ball ends up (with its outward
 * speed); a ring-out is a win or a loss. It keeps the try whose worst guess
 * is best (Difícil), whose average is best (Fácil, Normal) or a mix
 * (Imposible). That is how a sumo player plays: keep the centre, get to the
 * inside of the rival so the push points it outwards, dash when aligned and
 * close, and sidestep a dash coming at it (the rival's speed and «dashing»
 * flag are in the state: the dash is in the simulation).
 *
 * Fácil searches less and late, its hand and mind wander, and it also
 * dashes at random when close, often badly.
 *
 * Levels (ctx.level), see LEVELS.
 */
const Ph = require('./physics');
const Kit = require('../bot-kit');

const P = Ph.P;
const SIM_DT = 1 / 30;

/*
 * react: seconds it sees the rival late (its own ball it knows)
 * think: seconds between decisions (a search each time)
 * dirs: joystick directions it tries (each one also with a dash, if the
 *       rival is close and roughly that way and its cooldown is over)
 * horizon: seconds it plays each try forward
 * models: what it guesses the rival does: chase (pushes towards it), coast
 *         (keeps its current input), centre (heads for the middle), dash
 *         (dashes at it as soon as it can; measured: guessing that makes it
 *         too timid, so no level uses it now)
 * weights: (optional) how much each guess counts in the average
 * careful: 0 = the average of the guesses counts, 1 = the worst one
 * dash: it dashes only if the best try with a dash beats the best without
 *       one by this much (score points; -1 = never by search)
 * noise: its hand is not perfect: radians of error on the joystick (normal)
 * wander: Fácil: its mind wanders: a drift of up to this many radians
 * dashRate / dashErr: Fácil: random dashes per second when close to the
 *       rival, aimed this badly (radians, at most)
 * lead: how much it extrapolates the rival over what it sees late (0..1)
 */
const LEVELS = {
  facil: { react: 0.35, think: 0.2, dirs: 6, horizon: 0.6, models: ['chase'], careful: 0, dash: 40, noise: 0.3, wander: 0.5, dashRate: 0.2, dashErr: 0.6, lead: 0 },
  normal: { react: 0.2, think: 0.12, dirs: 8, horizon: 0.6, models: ['chase'], careful: 0, dash: 25, noise: 0.18, wander: 0, dashRate: 0, dashErr: 0, lead: 0.5 },
  dificil: { react: 0.1, think: 0.07, dirs: 12, horizon: 0.7, models: ['chase', 'coast'], careful: 1, dash: 10, noise: 0.06, wander: 0, dashRate: 0, dashErr: 0, lead: 0.9 },
  imposible: { react: 0.04, think: 0.05, dirs: 16, horizon: 0.6, models: ['chase', 'coast'], careful: 0.5, dash: 5, noise: 0, wander: 0, dashRate: 0, dashErr: 0, lead: 1 }
};

// ---------------------------------------------------------------- the search (no state)

function unit(x, y) {
  const m = Math.sqrt(x * x + y * y);
  return m > 1e-9 ? { x: x / m, y: y / m } : { x: 0, y: 0 };
}

/** The ring radius `t` s ahead, given the play time now (roundT, estimated). */
function radiusAt(roundT, t) { return Ph.ringRadius(roundT + t); }

/**
 * How bad being at (x, y) with velocity (vx, vy) is, on a ring of radius R:
 * 0 deep inside, growing fast near the edge (and with speed outwards).
 */
function danger(x, y, vx, vy, R) {
  const dx = x - P.CX, dy = y - P.CY;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  const vr = (vx * dx + vy * dy) / d;            // outward speed
  const m = R - d - Math.max(0, vr) * 0.3;      // margin, minus where its speed takes it
  return 100 * Math.exp(-Math.max(-60, m) / 90);
}

/**
 * Plays one try forward: its joystick (ux, uy) (and a dash at once if `dash`)
 * against the rival model `model`. me / en: as in search().
 * Returns the score (higher is better for it).
 */
function rollout(me, en, ux, uy, dash, model, horizon, roundT) {
  const a = Ph.makeWrestler(me.x, me.y, me.face);
  a.vx = me.vx; a.vy = me.vy; a.dash = me.dash; a.cd = me.cd;
  const b = Ph.makeWrestler(en.x, en.y, en.face);
  b.vx = en.vx; b.vy = en.vy; b.dash = en.dash; b.cd = en.cd;
  Ph.setInput(a, ux, uy);
  if (dash) Ph.tryDash(a);
  // The rival's input
  let bx = 0, by = 0;
  if (model === 'chase' || model === 'dash') { const u = unit(a.x - b.x, a.y - b.y); bx = u.x; by = u.y; }
  else if (model === 'centre') { const u = unit(P.CX - b.x, P.CY - b.y); bx = u.x; by = u.y; }
  else if (model === 'coast') { bx = en.ix || 0; by = en.iy || 0; }
  Ph.setInput(b, bx, by);
  if (model === 'dash') Ph.tryDash(b);
  const ws = [a, b];
  const n = Math.max(1, Math.round(horizon / SIM_DT));
  const switchAt = Math.round(0.35 / SIM_DT);
  for (let s = 1; s <= n; s++) {
    Ph.stepWorld(ws, SIM_DT, true);
    const R = radiusAt(roundT, s * SIM_DT);
    const outA = Ph.isOut(a, R), outB = Ph.isOut(b, R);
    if (outA || outB) {
      const t = s * SIM_DT;
      if (outA && outB) return -150;
      return outA ? -1000 + 200 * t : 1000 - 200 * t;
    }
    // After a moment, it would recover: back towards the centre if it is the
    // one nearer the edge, else on at the rival (so a try is judged by where
    // it leads, not by keeping the stick there for ever)
    if (s === switchAt) {
      const dA = Math.hypot(a.x - P.CX, a.y - P.CY), dB = Math.hypot(b.x - P.CX, b.y - P.CY);
      const u = dA > dB - 30 ? unit(P.CX - a.x, P.CY - a.y) : unit(b.x - a.x, b.y - a.y);
      Ph.setInput(a, u.x, u.y);
      if (model === 'chase' || model === 'dash') { const v = unit(a.x - b.x, a.y - b.y); Ph.setInput(b, v.x, v.y); }
    }
  }
  const R = radiusAt(roundT, n * SIM_DT);
  return danger(b.x, b.y, b.vx, b.vy, R) - danger(a.x, a.y, a.vx, a.vy, R);
}

/**
 * The search: the best joystick direction and whether to dash now.
 * me / en: the balls ({ x, y, vx, vy, face, dash, cd, ix, iy }), roundT: play
 * time (s), L: a LEVELS row, canDash: its cooldown is over.
 * Returns { a (angle), dash, score, noDash (best score without a dash) }.
 */
function search(me, en, roundT, L, canDash, prevA) {
  const models = L.models;
  let best = null, bestNoDash = -Infinity;
  const toEn = Math.atan2(en.y - me.y, en.x - me.x);
  const dist = Math.hypot(en.x - me.x, en.y - me.y);
  for (let k = 0; k < L.dirs; k++) {
    const ang = toEn + k * 2 * Math.PI / L.dirs;
    const ux = Math.cos(ang), uy = Math.sin(ang);
    // Dash tries: only roughly towards the rival and not too far (where a dash can matter)
    const off = Math.abs(Math.atan2(Math.sin(ang - toEn), Math.cos(ang - toEn)));
    const tryDash = canDash && dist < 420 && off < 0.8;
    for (let dsh = 0; dsh <= (tryDash ? 1 : 0); dsh++) {
      let sum = 0, wsum = 0, worst = Infinity;
      for (let m = 0; m < models.length; m++) {
        // The rival can only dash if its cooldown is over
        if (models[m] === 'dash' && en.cd > 0) continue;
        const v = rollout(me, en, ux, uy, !!dsh, models[m], L.horizon, roundT);
        const wt = L.weights ? L.weights[m] : 1;
        sum += v * wt;
        wsum += wt;
        if (v < worst) worst = v;
      }
      if (!wsum) continue;
      let score = L.careful * worst + (1 - L.careful) * sum / wsum;
      // A little hysteresis: no jitter between two nearly equal directions
      if (prevA !== null && !dsh) score += 2 * Math.cos(ang - prevA);
      if (!dsh && score > bestNoDash) bestNoDash = score;
      if (!best || score > best.score) best = { a: ang, dash: !!dsh, score: score };
    }
  }
  if (!best) best = { a: toEn, dash: false, score: 0 };
  best.noDash = bestNoDash;
  return best;
}

// ---------------------------------------------------------------- the bot

function create(ctx) {
  const L = Kit.byLevel(ctx.level, LEVELS) || LEVELS.normal;
  const random = ctx.random;
  const seen = Kit.delayLine(L.react * 1000, 30);    // 's' states, seen late
  let stopped = false;
  let meta = null, me = -1;
  let latest = null, latestAt = 0;
  let roundId = -1, goAt = 0;
  let cdUntil = 0;              // its dash cooldown (from 's.cd', like the phone)
  const enCdUntil = [0, 0];     // each ball's dash cooldown, from the 'dash' events
  let thinkAt = -1e9, sendAt = -1e9;
  let aim = null;               // { x, y } joystick it wants
  let sent = null;              // the last joystick it sent ("x,y")
  let prevA = null;
  let wander = { a: 0, until: 0 };
  let lastPhase = '';
  const stats = { thinks: 0, dashes: 0, joys: 0 };

  function now() { return ctx.now(); }

  function onMeta(m) {
    meta = m;
    me = m.slots ? m.slots.indexOf(ctx.slot) : -1;
    if (m.cd && me >= 0) {
      // The cooldowns in the meta (sent when something changes)
      for (let i = 0; i < 2; i++) if (m.cd[i] > 0) enCdUntil[i] = Math.max(enCdUntil[i], now() + m.cd[i]);
    }
    if (m.phase !== lastPhase) {
      // A new phase: the server forgets the joystick between rounds (resend it, as the phone does)
      lastPhase = m.phase;
      sent = null;
      if (m.phase === 'playing' && !goAt) goAt = now();
    }
  }

  function ball(st, i) {
    const w = st.w, k = i * 6;
    return { x: w[k], y: w[k + 1], vx: w[k + 2], vy: w[k + 3], face: w[k + 4], dash: (w[k + 5] & 1) ? 0.2 : 0, out: !!(w[k + 5] & 2) };
  }

  function playTime() {
    // From the ring radius once it shrinks (exact), else from the «go» (approximate)
    if (latest && latest.R < P.R0 - 0.5) return P.SHRINK_START + (P.R0 - latest.R) / P.SHRINK_RATE;
    return goAt ? Math.min(P.SHRINK_START, (now() - goAt) / 1000) : 0;
  }

  function setJoy(x, y) {
    let m = Math.sqrt(x * x + y * y);
    if (m > 1) { x /= m; y /= m; m = 1; }
    aim = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
    // The phone rounds to 0.01 and may land a hair outside the circle: keep it inside
    if (aim.x * aim.x + aim.y * aim.y > 1) { aim.x = Math.trunc(x * 100) / 100; aim.y = Math.trunc(y * 100) / 100; }
  }

  function flushJoy() {
    if (!aim) return;
    const key = aim.x + ',' + aim.y;
    if (key === sent) return;
    if (now() - sendAt < 1000 / 60 - 0.5) return;  // one per frame at most, like requestAnimationFrame
    if (ctx.send({ t: 's.j', x: aim.x, y: aim.y })) { sent = key; sendAt = now(); stats.joys++; }
  }

  function dash() {
    if (now() < cdUntil) return false;
    if (!ctx.send({ t: 's.d' })) return false;
    cdUntil = now() + P.DASH_COOLDOWN * 1000;      // at once; 's.cd' corrects it
    stats.dashes++;
    return true;
  }

  function thinkSearch(my, en) {
    stats.thinks++;
    const canDash = now() >= cdUntil;
    const res = search(my, en, playTime(), L, canDash, prevA);
    prevA = res.a;
    let a = res.a + (L.noise ? Kit.gauss(random) * L.noise : 0);
    // Fácil: its mind wanders (a drift that changes every second or so)
    if (L.wander) {
      if (now() >= wander.until) wander = { a: (random() * 2 - 1) * L.wander, until: now() + 600 + random() * 900 };
      a += wander.a;
    }
    setJoy(Math.cos(a), Math.sin(a));
    if (L.dash >= 0 && res.dash && res.score - res.noDash >= L.dash) {
      flushJoy();
      dash();
      return;
    }
    // Fácil: a random dash now and then when close, roughly towards the rival (often badly aimed)
    const dist = Math.hypot(en.x - my.x, en.y - my.y);
    if (L.dashRate && dist < 380 && canDash && random() < L.dashRate * L.think) {
      const da = Math.atan2(en.y - my.y, en.x - my.x) + (random() * 2 - 1) * L.dashErr;
      setJoy(Math.cos(da), Math.sin(da));
      flushJoy();
      dash();
    }
  }

  function think() {
    const my0 = ball(latest, me);
    if (my0.out) return;
    const pair = seen.getPair(now(), 60);
    if (!pair) return;
    const en0 = ball(pair.now, 1 - me);
    // Where the rival is now, for what it knows (it saw it L.react ago)
    const age = Math.max(0, (now() - pair.nowT) / 1000) * L.lead;
    const enCd = Math.max(0, (enCdUntil[1 - me] - now()) / 1000);
    const en = { x: en0.x + en0.vx * age, y: en0.y + en0.vy * age, vx: en0.vx, vy: en0.vy, face: en0.face, dash: en0.dash, cd: enCd, ix: 0, iy: 0 };
    // Its input, roughly: where it is accelerating (from two states)
    const b0 = ball(pair.before, 1 - me);
    const dt = (pair.nowT - pair.beforeT) / 1000;
    if (dt > 0.02 && !en0.dash) {
      const u = unit(en0.vx - b0.vx * Math.exp(-P.DRAG * dt), en0.vy - b0.vy * Math.exp(-P.DRAG * dt));
      en.ix = u.x; en.iy = u.y;
    }
    const my = { x: my0.x, y: my0.y, vx: my0.vx, vy: my0.vy, face: my0.face, dash: my0.dash, cd: Math.max(0, (cdUntil - now()) / 1000), ix: 0, iy: 0 };
    thinkSearch(my, en);
  }

  return {
    onTv: function (m) {
      if (stopped || !m) return;
      if (m.t === 's') {
        if (m.n !== roundId) { roundId = m.n; seen.clear(); goAt = 0; prevA = null; }
        latest = m;
        latestAt = now();
        seen.push(now(), m);
      } else if (m.t === 'smeta') onMeta(m);
      else if (m.t === 'ev') {
        if (m.k === 'dash' && (m.w === 1 || m.w === 2)) enCdUntil[m.w - 1] = now() + P.DASH_COOLDOWN * 1000;
        else if (m.k === 'go') goAt = now();
      }
    },
    onSlot: function (m) {
      if (stopped || !m) return;
      if (m.t === 'smeta') onMeta(m);
      else if (m.t === 's.cd') cdUntil = now() + (m.ms || 0);
    },
    tick: function () {
      if (stopped || !meta || me < 0 || !latest || now() - latestAt > 1000) return;
      const ph = meta.phase;
      if (ph === 'playing' || ph === 'countdown') {
        if (now() - thinkAt >= L.think * 1000) {
          thinkAt = now();
          if (ph === 'playing') think();
          else {
            // During the countdown: lean towards the rival (the phone may do it too)
            const my = ball(latest, me), en = ball(latest, 1 - me);
            setJoy((en.x - my.x) / 300, (en.y - my.y) / 300);
          }
        }
        flushJoy();
      } else if (ph === 'roundover' || ph === 'end') {
        aim = null;
      }
    },
    stop: function () { stopped = true; },
    // For tests
    _debug: function () { return { me: me, aim: aim, stats: stats, level: ctx.level, cdUntil: cdUntil }; }
  };
}

module.exports = { create: create, LEVELS: LEVELS, search: search, rollout: rollout, danger: danger };
