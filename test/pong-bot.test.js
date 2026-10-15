'use strict';
/*
 * «Pong»: the computer opponent (src/games/pong/bot.js), played in the real
 * hub with a virtual clock (test/helpers/bot-arena.js), seeded:
 *   - where it thinks the ball crosses a paddle line is where the game takes
 *     it (wall bounces included);
 *   - it only plays with phone messages ({ t: 'm', y } in 0..1, 3 decimals,
 *     only when it changes), never asks for the rematch, never touches what
 *     it receives and stops at the menu;
 *   - against a scripted player (it follows the ball with a delay and a
 *     capped speed) «Imposible» wins without conceding and «Fácil» loses but
 *     scores; every level beats the one below, and the better ones hit with
 *     the paddle edge (steeper returns);
 *   - in doubles (3 and 4 players) each bot plays its own paddle (goal,
 *     forward or alone);
 *   - its CPU time per tick (the TV runs it): average well under 0.5 ms.
 */
const H_ = require('./helpers');
const arena = require('./helpers/bot-arena');
const Bot = require('../src/games/pong/bot');
const Pong = require('../src/games/pong');
const Kit = require('../src/games/bot-kit');
const check = H_.checker('Pong: el rival bot');

const F = Pong.FIELD;
const LABEL = { facil: 'Fácil', normal: 'Normal', dificil: 'Difícil', imposible: 'Imposible' };
function sum(a) { return a.reduce(function (s, x) { return s + x; }, 0); }

/** A scripted player: its paddle follows where the ball is (no prediction), `delayMs` late, at `speed` u/s at most. */
function tracker(speed, delayMs) {
  return {
    create: function (ctx) {
      let meta = null, me = -1, hand = F.h / 2, sent = -1;
      const hist = [];
      return {
        onTv: function (m) {
          if (m.t === 's') { hist.push({ t: ctx.now(), b: m.b }); if (hist.length > 40) hist.shift(); }
          if (m.t === 'pmeta') { meta = m; me = -1; m.paddles.forEach(function (p, i) { if (p.slot === ctx.slot) me = i; }); }
        },
        tick: function (dt) {
          if (!meta || me < 0 || !hist.length) return;
          let s = hist[0];
          for (let i = hist.length - 1; i >= 0; i--) if (ctx.now() - hist[i].t >= delayMs) { s = hist[i]; break; }
          const p = meta.paddles[me];
          const coming = p.side === 1 ? s.b[2] < 0 : s.b[2] > 0;
          const want = coming ? s.b[1] : F.h / 2;
          const st = speed * dt, d = want - hand;
          hand = Math.abs(d) <= st ? want : hand + Math.sign(d) * st;
          const v = Math.round(Math.max(0, Math.min(1, (hand - p.h / 2) / (F.h - p.h))) * 1000) / 1000;
          if (v !== sent) { ctx.send({ t: 'm', y: v }); sent = v; }
        }
      };
    }
  };
}
const TRACKER = tracker(1100, 100);

/** A match: bots at `levels` (slots 2…) and `driver` on the human phone (slot 1, left goal). */
function match(levels, driver, drvLevel, seed, maxS) {
  const A = arena.create({ game: 'pong', seed: seed });
  levels.forEach(function (l) { A.addBot(l); });
  A.drive(driver, drvLevel);
  A.pick();
  const secs = A.run(maxS || 600, function () { const m = A.last('pmeta'); return m && m.phase === 'gameover'; });
  const m = A.last('pmeta');
  const hits = {};
  A.events('ev').forEach(function (e) { if (e.k === 'hit') { const k = e.slot + '/' + e.paddle; hits[k] = (hits[k] || 0) + 1; } });
  const out = { left: m.score[0], right: m.score[1], over: m.phase === 'gameover', secs: Math.round(secs), paddles: m.paddles, hits: hits, sent: A.sent.slice(), logs: A.logs.slice() };
  A.close();
  return out;
}

// ---------------------------------------------------------------- the ball path
function fakeApi(players) {
  const sent = [];
  return {
    sent: sent, slots: 6, tvs: new Set([1]),
    players: function () { return players.slice(); },
    isConnected: function () { return true; }, allConnected: function () { return true; },
    name: function (i) { return 'J' + (i + 1); },
    broadcast: function (m) { sent.push(typeof m === 'string' ? JSON.parse(m) : m); },
    sendTvs: function () {}, sendSlot: function () {}, sendWs: function () {}, log: function () {}
  };
}
function physics() {
  console.log('\n[Dónde cruza la pelota: como en el juego]');
  const random = Kit.seeded(23);
  const realRandom = Math.random;
  Math.random = random;
  let worst = 0, n = 0, bounced = 0;
  for (let k = 0; k < 200; k++) {
    const api = fakeApi([0, 1]);
    const g = Pong.create(api);
    g.start();
    const S = g._state;
    // Paddles parked as far as they go from where the ball will be: we want its own crossing
    const side = random() < 0.5 ? 0 : 1;
    const dir = side === 0 ? -1 : 1;
    const ang = (random() * 2 - 1) * 1.1, sp = 600 + random() * 1300;
    S.ball.x = 500 + random() * 920; S.ball.y = 40 + random() * 1000;
    S.ball.vx = dir * Math.abs(Math.cos(ang)) * sp; S.ball.vy = Math.sin(ang) * sp; S.ball.speed = sp;
    S.phase = 'playing';
    const X = Bot.lineX(S.pads[side].x, side);
    const c = Bot.crossing(S.ball.x, S.ball.y, S.ball.vx, S.ball.vy, X);
    // The game, tick by tick, until the ball reaches that line (or a paddle stops it there)
    let px = S.ball.x, py = S.ball.y, y = null;
    for (let i = 0; i < 400 && y === null; i++) {
      const hitsBefore = api.sent.filter(function (m) { return m.k === 'hit'; }).length;
      g.tick(1 / 60);
      const hit = api.sent.filter(function (m) { return m.k === 'hit'; }).length > hitsBefore;
      const b = S.ball;
      if (hit) { y = b.y; break; }
      if ((dir < 0 && b.x <= X) || (dir > 0 && b.x >= X)) { y = py + (b.y - py) * (X - px) / (b.x - px); break; }
      if (S.phase !== 'playing') break;
      px = b.x; py = b.y;
    }
    if (y === null || !c) continue;
    // Linear interpolation across a wall bounce is not the game's: skip the tick with the bounce
    n++;
    if (c.bounces) bounced++;
    worst = Math.max(worst, Math.abs(c.y - y));
  }
  Math.random = realRandom;
  check(n > 150 && worst < 30, 'En ' + n + ' pelotas al azar (' + bounced + ' con rebotes en las paredes) cruza su línea donde dice el bot: error máximo ' + worst.toFixed(1) + ' u (la pala mide ' + F.paddleH + ')');
}

// ---------------------------------------------------------------- how it plays
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); }
  return o;
}
function protocol() {
  console.log('\n[Juega como un móvil]');
  const A = arena.create({ game: 'pong', seed: 5 });
  A.addBot('imposible');
  let threw = null;
  A.drive({
    create: function (ctx) {
      const inner = Bot.create(ctx);
      return {
        onTv: function (m) { try { inner.onTv(deepFreeze(m)); } catch (e) { threw = threw || e; } },
        onSlot: function (m) { try { inner.onSlot(deepFreeze(m)); } catch (e) { threw = threw || e; } },
        tick: function (dt) { try { inner.tick(dt); } catch (e) { threw = threw || e; } },
        stop: inner.stop
      };
    }
  }, 'dificil');
  A.pick();
  A.run(900, function () { return A.last('pmeta').phase === 'gameover'; });
  const m = A.last('pmeta');
  check(!threw, 'No modifica los mensajes que recibe (congelados: ' + (threw ? threw.message : 'ningún error') + ')');
  check(m.phase === 'gameover' && m.winner === 2, '«Imposible» gana a «Difícil» (' + m.score.join('-') + ')');
  const types = {};
  let legal = true, repeated = 0, prev = null;
  A.sent.forEach(function (x) {
    const msg = x.msg;
    types[msg.t] = (types[msg.t] || 0) + 1;
    if (msg.t !== 'm' || Object.keys(msg).length !== 2 || !(msg.y >= 0 && msg.y <= 1) || Math.abs(msg.y * 1000 - Math.round(msg.y * 1000)) > 1e-6) legal = false;
    if (prev !== null && msg.y === prev) repeated++;
    prev = msg.y;
  });
  check(legal && types.m > 50, 'Solo manda { t: \'m\', y } con y entre 0 y 1 y 3 decimales, como el móvil (' + JSON.stringify(types) + ')');
  check(repeated === 0, 'Solo cuando cambia (' + repeated + ' repetidos)');
  check(!types.rematch, 'No pide la revancha: eso lo decide la persona');
  check(!A.logs.some(function (l) { return /Error/.test(l); }), 'Sin errores en el registro');
  // Rematch from the person: it plays again
  A.send({ t: 'rematch' });
  A.run(30);
  check(A.last('pmeta').phase !== 'gameover' && A.events('ev').filter(function (e) { return e.k === 'hit' && e.slot === 2; }).length > 0, '«¡Revancha!» desde el móvil: vuelve a jugar');
  // Back to the menu: it stops and sends nothing more
  A.send({ t: 'menu' });
  const st0 = A.hub.botStats();
  A.run(3);
  const st1 = A.hub.botStats();
  check(A.bots[0]._inner.debug().stopped && st1.running === 0 && st1.fromBots + st1.queued === st0.fromBots + st0.queued, 'Al volver al menú se para y ya no manda nada');
  A.close();
}

// ---------------------------------------------------------------- against a scripted player
function vsScripted() {
  console.log('\n[Contra un jugador con guion (sigue la pelota con 0,1 s de retraso, a 1100 u/s)]');
  const imp = [], easy = [];
  for (let seed = 1; seed <= 3; seed++) imp.push(match(['imposible'], TRACKER, null, seed, 600));
  for (let seed = 1; seed <= 3; seed++) easy.push(match(['facil'], TRACKER, null, seed, 600));
  check(imp.every(function (r) { return r.over && r.right === 7; }), '«Imposible» le gana las 3 (' + imp.map(function (r) { return r.right + '-' + r.left; }).join(', ') + ')');
  check(sum(imp.map(function (r) { return r.left; })) === 0, '…sin fallar ni una: 0 puntos en contra');
  check(easy.every(function (r) { return r.over && r.left === 7; }), '«Fácil» pierde las 3 (' + easy.map(function (r) { return r.right + '-' + r.left; }).join(', ') + '): se le puede ganar');
  check(sum(easy.map(function (r) { return r.right; })) >= 2, '…pero también marca: ' + sum(easy.map(function (r) { return r.right; })) + ' puntos');
}

function duels() {
  console.log('\n[Duelos entre niveles (a 7)]');
  let impConceded = 0;
  [['imposible', 'facil'], ['dificil', 'normal'], ['normal', 'facil'], ['imposible', 'dificil']].forEach(function (p) {
    let wins = 0, pa = 0, pb = 0;
    for (let seed = 1; seed <= 3; seed++) {
      const r = match([p[0]], Bot, p[1], seed * 101, 900);
      if (r.over && r.right === 7) wins++;
      pa += r.right; pb += r.left;
      if (p[0] === 'imposible') impConceded += r.left;
    }
    check(wins === 3, '«' + LABEL[p[0]] + '» gana a «' + LABEL[p[1]] + '» los 3 duelos (' + pa + '-' + pb + ' en puntos)');
  });
  check(impConceded === 0, '«Imposible» no falla ninguna en 6 partidas (' + impConceded + ' en contra)');
}

// The ball goes off at up to 55° the further from the paddle centre it hits: the better ones use the edges
function angles() {
  console.log('\n[Ángulos: los buenos le dan con el borde de la pala]');
  const med = {};
  ['facil', 'normal', 'dificil', 'imposible'].forEach(function (lv) {
    const A = arena.create({ game: 'pong', seed: 2 });
    A.addBot(lv);
    A.drive(TRACKER);
    A.pick();
    const out = [];
    let n = 0, wait = -1;
    for (let i = 0; i < 120 * 60; i++) {
      A.step();
      const evs = A.events('ev');
      for (; n < evs.length; n++) if (evs[n].k === 'hit' && evs[n].slot === 2) wait = i;
      if (wait >= 0 && i > wait) {
        const b = A.last('s').b;
        out.push(Math.atan2(Math.abs(b[3]), Math.abs(b[2])) * 180 / Math.PI);
        wait = -1;
      }
    }
    out.sort(function (a, b) { return a - b; });
    med[lv] = out[out.length >> 1];
    A.close();
  });
  check(med.facil < med.normal && med.normal < med.dificil && med.dificil <= med.imposible + 5 && med.imposible > 30,
    'Ángulo mediano de sus devoluciones: ' + Object.keys(med).map(function (lv) { return LABEL[lv] + ' ' + med[lv].toFixed(0) + '°'; }).join(' · '));
}

// ---------------------------------------------------------------- doubles
function doubles() {
  console.log('\n[Dobles: cada bot juega su pala]');
  // 4: slot 1 (the phone) left goal, 2 right goal, 3 left forward, 4 right forward
  const r = match(['imposible', 'facil', 'imposible'], Bot, 'facil', 3, 600);
  const roles = r.paddles.map(function (p) { return p.slot + ':' + p.role; }).join(' ');
  let own = true;
  Object.keys(r.hits).forEach(function (k) {
    const sp = k.split('/');
    if (r.paddles[+sp[1]].slot !== +sp[0]) own = false;
  });
  check(roles === '1:portería 2:portería 3:delantera 4:delantera', 'Con 4: palas ' + roles);
  check(own && (r.hits['3/2'] || 0) >= 5 && (r.hits['4/3'] || 0) >= 5,
    'Cada uno da con su pala (golpes por hueco/pala: ' + JSON.stringify(r.hits) + '): las delanteras paran casi todo; la portería, lo que pasa');
  check(r.over && r.right === 7 && r.left <= 1, 'Pareja «Imposible» contra pareja «Fácil»: ' + r.right + '-' + r.left);
  const sentBy = {};
  r.sent.forEach(function (x) { sentBy[x.slot] = (sentBy[x.slot] || 0) + 1; });
  check(sentBy[2] > 0 && sentBy[3] > 0 && sentBy[4] > 0, 'Los tres bots mueven su pala (mensajes: ' + JSON.stringify(sentBy) + ')');
  // 3: slot 2 alone on the right with the long paddle
  const t = match(['imposible', 'facil'], Bot, 'facil', 4, 600);
  const roles3 = t.paddles.map(function (p) { return p.slot + ':' + p.role; }).join(' ');
  check(roles3 === '1:portería 2:solo 3:delantera' && (t.hits['2/1'] || 0) >= 5 && (t.hits['3/2'] || 0) >= 5 && t.over && t.right === 7,
    'Con 3: ' + roles3 + '; «Imposible» solo gana ' + t.right + '-' + t.left + ' a la pareja (golpes ' + JSON.stringify(t.hits) + ')');
}

// ---------------------------------------------------------------- CPU
function cpu() {
  console.log('\n[Coste por tick (la tele lo ejecuta)]');
  const A = arena.create({ game: 'pong', seed: 5 });
  A.addBot('imposible');
  A.addBot('dificil');
  A.addBot('normal');
  A.drive(Bot, 'dificil');
  A.pick();
  A.run(15);
  A.resetTiming();
  let matches = 0;
  for (let k = 0; k < 150; k++) {
    A.run(1);
    if (A.last('pmeta').phase === 'gameover') { A.send({ t: 'rematch' }); matches++; }
  }
  const T = A.timing();
  const perBot = T.avgTickMs / 3;
  console.log('    (dobles con 3 bots del hub; ' + matches + ' partidas terminadas; ' + T.calls + ' llamadas; la más lenta ' + T.worst.toFixed(2) + ' ms)');
  check(perBot < 0.5, '150 s de dobles: ' + perBot.toFixed(4) + ' ms por bot y tick de media (límite 0,5 ms; peor tick con los 3 ' + T.stepWorst.toFixed(2) + ' ms, ' + T.over1 + ' de ' + T.steps + ' por encima de 1 ms)');
  check(T.over1 / T.steps < 0.01, 'Menos del 1 % de los ticks pasa de 1 ms (los que pasan suelen ser pausas del recolector de basura o de la máquina)');
  A.close();
}

physics();
protocol();
vsScripted();
duels();
angles();
doubles();
cpu();
check.done();
