/*
 * «Hockey de mesa»: TV view (canvas, cheap to draw on the TV).
 * - Everything static (the room, the rails, the ice with its lines, air
 *   holes, goal creases and goal slots, the names) is drawn ONCE into an
 *   offscreen canvas; each frame copies it and draws the scores, the two
 *   mallets, the puck with a short trail and a few effects.
 * - No shadowBlur and no filters. The backing store is capped (host.capDpr:
 *   1280 wide on webOS).
 * - The server sends 'hs' states at 30 Hz. The view renders INTERP_MS behind
 *   the server clock and interpolates the puck and the mallets between two
 *   states; when the next state is late it extrapolates the puck with its
 *   velocity (bouncing on the walls) and the mallets a little, so the 30 Hz
 *   steps never show.
 * - Pause and end screens are almost static: redrawn ~10 times per second.
 *   The end screen has «Otra» / «Menú» for the remote (◀ ▶ and OK).
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var now = G2T.now, clamp = G2T.clamp, lerp = G2T.lerp, hexA = G2T.hexA;
  var host = null, COLORS;
  var LW = 1920, LH = 1080;
  var FONT = "'LG Smart UI', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
  var F = { w: 1720, h: 860, puckR: 28, malletR: 46, goalW: 260, goalY0: 300, goalY1: 560 };
  var OX = 100, OY = 180, RAIL = 24;      // the table on the 1920x1080 stage
  var INTERP_MS = 40;                     // render this far behind the server (states every ~33 ms)
  var MAX_EXTRA_MS = 100;
  var TRAIL_MS = 90;
  var ICE = '#e6f1f9', INK = '#0b1030', RED = '#e14a5c';
  var beep = G2T.sound.beep;
  var sfx = {
    hit: function (power) { var k = clamp(power / 2400, 0, 1); beep(330 + 420 * k, 0.06, 'square', 0.07 + 0.08 * k); },
    wall: function () { beep(210, 0.05, 'triangle', 0.09); },
    post: function () { beep(880, 0.08, 'triangle', 0.1); },
    goal: function () { beep(523, 0.16, 'sawtooth', 0.09); beep(784, 0.32, 'sawtooth', 0.09, null, 0.14); }
  };

  var pc, ctx;
  var pv = { scale: 1, ox: 0, oy: 0, dpr: 1 };
  var meta = null;
  var buf = [];                 // last 'hs' states
  var clockOffset = null;       // server clock - now(), estimated (fastest packet)
  var bgLayer = null, bgKey = '';
  var trail = [], trailReset = -1;
  var rings = [];               // hit effects
  var goalFlash = 0, goalSide = 0, scoreFlash = [0, 0];
  var countdownAt = 0, lastCountdown = 0, goAt = -10000, lastStatic = 0;
  var focusIndex = 0;           // end screen: 0 «Otra», 1 «Menú»
  var lastRender = null;        // { puck, mallets } of the last frame (tests, effects)
  var stats = { states: 0, frames: 0, bg: 0, drawMs: 0 };

  function colors() { return COLORS(); }
  function slotOf(side) { return meta && meta.players ? meta.players[side] : side + 1; }
  function sideColor(side) { return colors()[slotOf(side) - 1] || (side === 0 ? '#22e6ff' : '#ff3df2'); }
  function sideName(side) { return host.playerName(slotOf(side) - 1); }

  // ------------------------------------------------------------ canvas
  function resize(w, h) {
    var d = host.capDpr(w);
    pc.style.width = w + 'px';
    pc.style.height = h + 'px';
    pc.width = Math.round(w * d);
    pc.height = Math.round(h * d);
    pv.dpr = d;
    pv.scale = Math.min(w / LW, h / LH);
    pv.ox = (w - LW * pv.scale) / 2;
    pv.oy = (h - LH * pv.scale) / 2;
    bgLayer = null;
    lastStatic = 0;
  }
  function stageTransform(c) {
    var sc = pv.scale * pv.dpr;
    c.setTransform(sc, 0, 0, sc, pv.ox * pv.dpr, pv.oy * pv.dpr);
  }
  function rr(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }
  function text(c, str, x, y, size, color, weight, align) {
    c.font = (weight || 'bold') + ' ' + size + 'px ' + FONT;
    c.textAlign = align || 'center';
    c.textBaseline = 'middle';
    c.fillStyle = color;
    c.fillText(str, x, y);
  }
  function fitSize(c, str, maxW, size, weight) {
    c.font = (weight || 'bold') + ' ' + size + 'px ' + FONT;
    while (size > 18 && c.measureText(str).width > maxW) {
      size -= 3;
      c.font = (weight || 'bold') + ' ' + size + 'px ' + FONT;
    }
    return size;
  }
  function circle(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); }

  // ------------------------------------------------------------ static layer
  function ensureBg() {
    var key = pc.width + 'x' + pc.height + '|' + sideName(0) + '|' + sideName(1) + '|' + sideColor(0) + sideColor(1) + '|' + (meta ? meta.toWin : 7);
    if (bgLayer && key === bgKey) return;
    bgKey = key;
    stats.bg++;
    var c = document.createElement('canvas');
    c.width = pc.width;
    c.height = pc.height;
    var g = c.getContext('2d');
    g.fillStyle = '#070915';
    g.fillRect(0, 0, c.width, c.height);
    stageTransform(g);
    var grad = g.createLinearGradient(0, 0, 0, LH);
    grad.addColorStop(0, '#11163a');
    grad.addColorStop(1, '#070915');
    g.fillStyle = grad;
    g.fillRect(0, 0, LW, LH);
    // Names (scores are drawn every frame)
    for (var s = 0; s < 2; s++) {
      var nm = sideName(s);
      var size = fitSize(g, nm, 520, 50);
      text(g, nm, s === 0 ? 690 : 1230, 84, size, sideColor(s), 'bold', s === 0 ? 'right' : 'left');
    }
    rr(g, LW / 2 - 64, 58, 128, 52, 26);
    g.fillStyle = 'rgba(255,255,255,0.1)';
    g.fill();
    text(g, 'A ' + (meta ? meta.toWin : 7), LW / 2, 85, 32, 'rgba(255,255,255,0.75)', 'bold');
    // Rails
    rr(g, OX - RAIL, OY - RAIL, F.w + 2 * RAIL, F.h + 2 * RAIL, 34);
    g.fillStyle = '#1d2456';
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.lineWidth = 3;
    g.stroke();
    // Goal slots in the rails (dark), with the defender's colour on the lip
    for (s = 0; s < 2; s++) {
      var gx = s === 0 ? OX - RAIL - 2 : OX + F.w;
      g.fillStyle = '#020309';
      g.fillRect(gx, OY + F.goalY0, RAIL + 2, F.goalW);
      g.fillStyle = sideColor(s);
      g.fillRect(s === 0 ? OX - RAIL - 2 : OX + F.w + RAIL - 4, OY + F.goalY0, 6, F.goalW);
    }
    // Ice
    g.save();
    rr(g, OX, OY, F.w, F.h, 12);
    g.clip();
    g.fillStyle = ICE;
    g.fillRect(OX, OY, F.w, F.h);
    var rad = g.createRadialGradient(OX + F.w / 2, OY + F.h / 2, 80, OX + F.w / 2, OY + F.h / 2, F.w * 0.62);
    rad.addColorStop(0, 'rgba(255,255,255,0.75)');
    rad.addColorStop(1, 'rgba(160,195,225,0.35)');
    g.fillStyle = rad;
    g.fillRect(OX, OY, F.w, F.h);
    // Air holes
    g.fillStyle = 'rgba(40,70,110,0.16)';
    for (var hx = OX + 22; hx < OX + F.w; hx += 43) {
      for (var hy = OY + 22; hy < OY + F.h; hy += 43) g.fillRect(hx - 1.5, hy - 1.5, 3, 3);
    }
    // Goal creases in the defender's colour
    for (s = 0; s < 2; s++) {
      var cx = s === 0 ? OX : OX + F.w;
      g.beginPath();
      g.arc(cx, OY + F.h / 2, 190, s === 0 ? -Math.PI / 2 : Math.PI / 2, s === 0 ? Math.PI / 2 : Math.PI * 1.5);
      g.closePath();
      g.fillStyle = hexA(sideColor(s), 0.16);
      g.fill();
      g.strokeStyle = hexA(sideColor(s), 0.85);
      g.lineWidth = 6;
      g.stroke();
      // Goal line
      g.fillStyle = hexA(sideColor(s), 0.9);
      g.fillRect(s === 0 ? OX : OX + F.w - 6, OY + F.goalY0, 6, F.goalW);
    }
    // Centre line and circle
    g.fillStyle = RED;
    g.fillRect(OX + F.w / 2 - 4, OY, 8, F.h);
    g.strokeStyle = hexA(RED, 0.8);
    g.lineWidth = 6;
    circle(g, OX + F.w / 2, OY + F.h / 2, 120);
    g.stroke();
    g.fillStyle = RED;
    circle(g, OX + F.w / 2, OY + F.h / 2, 12);
    g.fill();
    // A soft inner edge (shade near the rails)
    g.strokeStyle = 'rgba(30,50,90,0.18)';
    g.lineWidth = 14;
    g.strokeRect(OX, OY, F.w, F.h);
    g.restore();
    bgLayer = c;
  }

  // ------------------------------------------------------------ states
  function onState(s) {
    var o = s.ts - now();
    if (clockOffset === null || o > clockOffset) clockOffset = o;
    else clockOffset += (o - clockOffset) * 0.02;
    buf.push(s);
    if (buf.length > 24) buf.shift();
    stats.states++;
    host.debug.states++;
  }
  // Puck extrapolation: straight line with the table walls (not the goal mouth)
  function extrapolate(x, y, vx, vy, secs) {
    var r = F.puckR;
    x += vx * secs;
    y += vy * secs;
    if (y < r) y = 2 * r - y; else if (y > F.h - r) y = 2 * (F.h - r) - y;
    var inMouth = y > F.goalY0 && y < F.goalY1;
    if (!inMouth) {
      if (x < r) x = 2 * r - x; else if (x > F.w - r) x = 2 * (F.w - r) - x;
    }
    return { x: clamp(x, -2 * r, F.w + 2 * r), y: clamp(y, r, F.h - r) };
  }
  function sample() {
    if (!buf.length) return null;
    var t = now() + (clockOffset || 0) - INTERP_MS;
    var last = buf[buf.length - 1];
    var puck, m;
    if (t >= last.ts || buf.length < 2) {
      var dt = clamp(t - last.ts, 0, MAX_EXTRA_MS) / 1000;
      puck = last.ph === 'playing' ? extrapolate(last.p[0], last.p[1], last.p[2], last.p[3], dt) : { x: last.p[0], y: last.p[1] };
      m = last.m.slice();
      var prev = buf.length >= 2 ? buf[buf.length - 2] : null;
      if (prev && last.ts > prev.ts) {
        // the mallets a little further (at most one state interval)
        var k = Math.min(dt * 1000, 33) / (last.ts - prev.ts);
        for (var i = 0; i < 4; i++) m[i] = last.m[i] + (last.m[i] - prev.m[i]) * k;
      }
      return { puck: puck, m: m, r: last.r, ph: last.ph };
    }
    var j = buf.length - 2;
    while (j > 0 && buf[j].ts > t) j--;
    var a = buf[j], b = buf[j + 1];
    if (t <= a.ts) return { puck: { x: a.p[0], y: a.p[1] }, m: a.m.slice(), r: a.r, ph: a.ph };
    var f = clamp((t - a.ts) / ((b.ts - a.ts) || 1), 0, 1);
    m = [];
    for (var q = 0; q < 4; q++) m.push(lerp(a.m[q], b.m[q], f));
    if (a.r !== b.r) puck = { x: b.p[0], y: b.p[1] };
    else puck = { x: lerp(a.p[0], b.p[0], f), y: lerp(a.p[1], b.p[1], f) };
    return { puck: puck, m: m, r: b.r, ph: f < 0.5 ? a.ph : b.ph };
  }

  // ------------------------------------------------------------ meta and events
  function onMeta(m) {
    if (m.field) F = m.field;
    var prev = meta;
    if (m.phase === 'countdown' && m.countdown !== lastCountdown && m.countdown > 0) { host.sfx.tick(); countdownAt = now(); }
    lastCountdown = m.phase === 'countdown' ? m.countdown : 0;
    if (!prev || prev.phase !== m.phase || prev.match !== m.match) { lastStatic = 0; if (m.phase === 'end') focusIndex = 0; }
    meta = m;
  }
  function onEvent(e) {
    var last = lastRender;
    switch (e.k) {
      case 'hit': {
        var side = (e.side || 1) - 1;
        sfx.hit(e.power || 0);
        if (last) { rings.push({ x: last.puck.x, y: last.puck.y, c: sideColor(side), life: 1 }); if (rings.length > 6) rings.shift(); }
        break;
      }
      case 'wall': sfx.wall(); break;
      case 'post': sfx.post(); break;
      case 'goal':
        sfx.goal();
        goalSide = (e.side || 1) - 1;
        goalFlash = 1;
        scoreFlash[goalSide] = 1;
        break;
      case 'go': goAt = now(); host.sfx.go(); break;
      case 'win': setTimeout(host.sfx.win, 300); host.confetti(); break;
    }
  }

  // ------------------------------------------------------------ drawing
  function tx(x) { return OX + x; }
  function ty(y) { return OY + y; }
  function drawScores() {
    var sc = (meta && meta.score) || [0, 0];
    for (var s = 0; s < 2; s++) {
      var f = scoreFlash[s];
      text(ctx, String(sc[s]), s === 0 ? 800 : 1120, 84, 118 + 40 * f, sideColor(s), '900');
    }
  }
  function drawMallet(x, y, color) {
    var r = F.malletR;
    ctx.fillStyle = 'rgba(11,16,48,0.18)';
    circle(ctx, tx(x) + 5, ty(y) + 7, r);           // cheap shadow
    ctx.fill();
    ctx.fillStyle = color;
    circle(ctx, tx(x), ty(y), r);
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    circle(ctx, tx(x), ty(y), r * 0.62);
    ctx.stroke();
    ctx.fillStyle = INK;
    circle(ctx, tx(x), ty(y), r * 0.3);
    ctx.fill();
  }
  function drawPuck(x, y) {
    var r = F.puckR;
    // Trail: a few dark, fading circles
    for (var i = 0; i < trail.length; i++) {
      var k = (i + 1) / (trail.length + 1);
      ctx.globalAlpha = 0.22 * k;
      ctx.fillStyle = INK;
      circle(ctx, tx(trail[i].x), ty(trail[i].y), r * (0.45 + 0.5 * k));
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#141a3f';
    circle(ctx, tx(x), ty(y), r);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    circle(ctx, tx(x), ty(y), r * 0.62);
    ctx.stroke();
  }
  function drawRings(dt) {
    for (var i = rings.length - 1; i >= 0; i--) {
      var g = rings[i];
      g.life -= dt * 3;
      if (g.life <= 0) { rings.splice(i, 1); continue; }
      ctx.globalAlpha = g.life;
      ctx.strokeStyle = g.c;
      ctx.lineWidth = 6;
      circle(ctx, tx(g.x), ty(g.y), F.puckR + 10 + (1 - g.life) * 60);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function outlined(str, x, y, size, color) {
    ctx.font = '900 ' + size + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(6, size / 14);
    ctx.strokeStyle = INK;
    ctx.strokeText(str, x, y);
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }
  function drawOverlays(t) {
    var ph = meta ? meta.phase : '';
    var cx = OX + F.w / 2, cy = OY + F.h / 2;
    if (goalFlash > 0) {
      ctx.globalAlpha = 0.45 * goalFlash;
      ctx.fillStyle = sideColor(goalSide);
      ctx.fillRect(OX, OY, F.w, F.h);
      ctx.globalAlpha = 1;
    }
    if (ph === 'countdown' && meta.countdown > 0) {
      var frac = clamp((t - countdownAt) / 1000, 0, 1);
      outlined(String(meta.countdown), cx, cy - 10, 260 + 70 * (1 - frac), '#ffffff');
      var first = (meta.score[0] + meta.score[1]) === 0;
      outlined(first ? '¡Preparados!' : 'Seguimos…', cx, cy + 190, 56, '#ffffff');
    } else if (ph === 'playing') {
      var since = t - goAt;
      if (since >= 0 && since < 700) {
        ctx.globalAlpha = 1 - since / 700;
        outlined('¡YA!', cx, cy, 240 + since * 0.15, '#ffffff');
        ctx.globalAlpha = 1;
      }
    } else if (ph === 'goal' && meta.lastScorer) {
      var s = meta.lastScorer - 1;
      var msg = '¡GOL de ' + sideName(s) + '!';
      ctx.font = '900 120px ' + FONT;
      var size = 120;
      while (size > 50 && ctx.measureText(msg).width > 1500) { size -= 6; ctx.font = '900 ' + size + 'px ' + FONT; }
      outlined(msg, cx, cy - 40, size, sideColor(s));
      outlined(meta.score[0] + ' – ' + meta.score[1], cx, cy + 90, 80, '#ffffff');
    }
  }
  function drawPlay(t, dt) {
    goalFlash = Math.max(0, goalFlash - dt * 1.4);
    scoreFlash[0] = Math.max(0, scoreFlash[0] - dt * 2);
    scoreFlash[1] = Math.max(0, scoreFlash[1] - dt * 2);
    ensureBg();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bgLayer, 0, 0);
    stageTransform(ctx);
    drawScores();
    var st = sample();
    if (st) {
      if (st.r !== trailReset) { trail = []; trailReset = st.r; }
      // Trail: where the puck was in the last TRAIL_MS (by time, so it stays
      // short even when the frame rate drops)
      if (st.ph === 'playing') {
        var lp = trail[trail.length - 1];
        if (!lp || Math.abs(lp.x - st.puck.x) + Math.abs(lp.y - st.puck.y) > 4) trail.push({ x: st.puck.x, y: st.puck.y, t: t });
        while (trail.length && (t - trail[0].t > TRAIL_MS || trail.length > 6)) trail.shift();
      } else if (trail.length) trail.shift();
      drawMallet(st.m[0], st.m[1], sideColor(0));
      drawMallet(st.m[2], st.m[3], sideColor(1));
      drawPuck(st.puck.x, st.puck.y);
      lastRender = { puck: st.puck, m: st.m, t: t };
    }
    drawRings(dt);
    drawOverlays(t);
  }
  function drawQr(x, y, size) {
    rr(ctx, x - 18, y - 18, size + 36, size + 36, 24);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    var img = host.qrImage();
    if (img) {
      ctx.imageSmoothingEnabled = false;
      try { ctx.drawImage(img, x, y, size, size); } catch (e) { /* noop */ }
      ctx.imageSmoothingEnabled = true;
    }
  }
  function drawPaused() {
    text(ctx, 'PAUSA', LW / 2, 330, 150, '#ffffff', '900');
    var p = host.hub().players || [];
    var y = 480;
    for (var s = 0; s < 2; s++) {
      var i = slotOf(s) - 1;
      if (p[i] && !p[i].connected) {
        text(ctx, 'Esperando a ' + p[i].name + '…', LW / 2, y, 48, colors()[i], 'bold');
        text(ctx, 'Reconexión: ' + (p[i].holdLeft || 0) + ' s', LW / 2, y + 60, 36, 'rgba(255,255,255,0.7)', 'normal');
        y += 140;
      }
    }
    text(ctx, 'Vuelve a abrir la página en el móvil para seguir', LW / 2, y + 10, 32, 'rgba(255,255,255,0.55)', 'normal');
    drawQr(LW / 2 - 110, y + 70, 220);
  }
  function drawButton(label, x, y, focused) {
    rr(ctx, x - 170, y - 50, 340, 100, 24);
    ctx.fillStyle = focused ? '#ffffff' : '#1a1f40';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = focused ? '#ffffff' : 'rgba(255,255,255,0.16)';
    ctx.stroke();
    text(ctx, label, x, y + 2, 44, focused ? '#0a0c1f' : '#ffffff', '900');
  }
  function drawEnd(t) {
    var w = (meta.winner || 1) - 1;
    var pulse = 1 + 0.035 * Math.sin(t / 230);
    var title = '¡GANA ' + sideName(w).toUpperCase() + '!';
    ctx.save();
    ctx.translate(LW / 2, 300);
    ctx.scale(pulse, pulse);
    text(ctx, title, 0, 0, fitSize(ctx, title, 1600, 150, '900'), sideColor(w), '900');
    ctx.restore();
    var sc = meta.score || [0, 0];
    text(ctx, sc[0] + '  –  ' + sc[1], LW / 2, 510, 130, '#ffffff', '900');
    text(ctx, sideName(0), LW / 2 - 300, 510, fitSize(ctx, sideName(0), 420, 46), sideColor(0), 'bold', 'right');
    text(ctx, sideName(1), LW / 2 + 300, 510, fitSize(ctx, sideName(1), 420, 46), sideColor(1), 'bold', 'left');
    text(ctx, '¿Otra partida?', LW / 2, 690, 64, '#ffffff', '900');
    drawButton('Otra', LW / 2 - 200, 820, focusIndex === 0);
    drawButton('Menú', LW / 2 + 200, 820, focusIndex === 1);
    text(ctx, '◀ ▶ y OK con el mando · o en el móvil', LW / 2, 940, 32, 'rgba(255,255,255,0.55)', 'normal');
  }
  function draw(t, dt) {
    var t0 = now();
    drawFrame(t, dt);
    stats.drawMs += now() - t0;
  }
  function drawFrame(t, dt) {
    stats.frames++;
    var ph = meta ? meta.phase : 'countdown';
    if (ph === 'paused' || ph === 'end') {
      if (t - lastStatic < 100) return;
      lastStatic = t;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#05060f';
      ctx.fillRect(0, 0, pc.width, pc.height);
      stageTransform(ctx);
      if (ph === 'paused') drawPaused(); else drawEnd(t);
      return;
    }
    drawPlay(t, dt);
  }

  function reset() {
    meta = null;
    buf = [];
    trail = [];
    rings = [];
    goalFlash = 0;
    scoreFlash = [0, 0];
    lastRender = null;
    bgLayer = null;
  }

  G2T.tv.register({
    id: 'hockey',
    mount: function (h, game) {
      host = h;
      COLORS = h.colors;
      if (game && game.tv && game.tv.field) F = game.tv.field;
      pc = document.createElement('canvas');
      pc.id = 'hkCanvas';
      pc.style.cssText = 'position:absolute;left:0;top:0;display:none;z-index:0;';
      h.addLayer(pc);
      ctx = pc.getContext('2d', { alpha: false }) || pc.getContext('2d');
    },
    layout: function (w, h) { resize(w, h); },
    onConnect: function () { buf = []; clockOffset = null; },
    enter: function () { pc.style.display = 'block'; },
    leave: function () { pc.style.display = 'none'; reset(); },
    onHub: function () { lastStatic = 0; },
    onMessage: function (msg) {
      if (msg.t === 'hmeta') onMeta(msg);
      else if (msg.t === 'hs') onState(msg);
    },
    onEvent: onEvent,
    onKey: function (e, dir, ok) {
      if (!meta || meta.phase !== 'end') return false;
      if (dir) { focusIndex = clamp(focusIndex + dir, 0, 1); lastStatic = 0; host.sfx.move(); return true; }
      if (ok) { host.send(focusIndex === 0 ? { t: 'h.again' } : { t: 'menu' }); return true; }
      return false;
    },
    frame: function (t, dt) { draw(t, dt); },
    debugInfo: function () { return pc.width + 'x' + pc.height; },
    canvas: function () { return pc; },
    // For automated tests
    state: function () {
      return { meta: meta, states: stats.states, frames: stats.frames, bgBuilds: stats.bg, drawMs: Math.round(stats.drawMs), buffered: buf.length, render: lastRender, w: pc.width, h: pc.height, focus: focusIndex };
    }
  });
})();
