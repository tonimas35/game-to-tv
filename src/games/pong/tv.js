/*
 * Pong: TV view (same look as the original Pong, optimized for the TV).
 * - No shadowBlur by default (very expensive on the TV GPU): the glow is
 *   faked with a wider, semi-transparent shape. ?fx=1 turns real glows on.
 * - Background, grid, centre line and names are drawn ONCE into an offscreen
 *   canvas and each frame only copies it (drawImage).
 * - Paddles use the LATEST received position ('s' and 'p' messages), with no
 *   interpolation delay. The ball is extrapolated with its velocity.
 * - The canvas backing store is capped (see public/lib/canvas.js).
 * - 2 players: the classic. 3-4: doubles (pmeta.paddles): each paddle in its
 *   player's colour, scores in the team colour (its goal player's colour),
 *   team names and a label under every paddle, all in the static layer.
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var now = G2T.now, clamp = G2T.clamp, lerp = G2T.lerp, hexA = G2T.hexA;
  var host = null, FX = false, COLORS;
  var LW = 1920, LH = 1080;
  var FONT = "'LG Smart UI', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
  var beep = G2T.sound.beep;
  var sfx = {
    hit: function (slot) { beep(slot === 1 ? 520 : 440, 0.07, 'square', 0.12); },
    wall: function () { beep(260, 0.05, 'square', 0.08); },
    score: function () { beep(660, 0.35, 'sawtooth', 0.10, 140); }
  };

  var pc, pctx, ctx;
  var pview = { scale: 1, ox: 0, oy: 0, dpr: 1 };
  var pongField = { w: 1920, h: 1080, paddleH: 180, paddleW: 24, paddleMargin: 70, ballR: 14 };
  var pmeta = { phase: 'countdown', score: [0, 0], countdown: 0, winner: 0, toWin: 7, lastScorer: 0 };
  // Paddles (from pmeta): { slot (1..), side (1|2), x, h, role }. Before the first pmeta: the classic two
  function classicPads() {
    return [
      { slot: 1, side: 1, x: pongField.paddleMargin, h: pongField.paddleH, role: 'portería' },
      { slot: 2, side: 2, x: LW - pongField.paddleMargin, h: pongField.paddleH, role: 'portería' }
    ];
  }
  var pads = classicPads();
  var pongLast = null;            // last 's' state from the server
  var pongBuf = [];               // last states (to interpolate the ball)
  var INTERP_DELAY = 20;          // ms: ~1 server tick
  var paddleY = [540, 540, 540, 540]; // last known position of each paddle (by paddle index)
  var clockOffset = null;         // (server clock) - now(), estimated
  var MAX_EXTRAPOLATE_MS = 50;
  var lastCountdown = 0, phaseChangedAt = now(), countdownChangedAt = now(), goAt = -10000;
  var trail = [], trailResetId = -1, particles = [], pongFlashes = [0, 0, 0, 0], scoreFlash = [0, 0], shake = 0;
  var lastBall = { x: LW / 2, y: LH / 2 };
  var bgLayer = null, bgKey = '';
  var lastStaticDraw = 0;

  function playerName(i) { return host.playerName(i); }
  function padColor(k) { var p = pads[k]; return COLORS()[(p ? p.slot : k + 1) - 1] || '#ffffff'; }
  function doubles() { return pads.length > 2; }
  // Team = side 1 (left) or 2 (right). Its colour is its goal player's colour
  function sidePads(side) { return pads.filter(function (p) { return p.side === side; }); }
  function teamColor(side) { var p = sidePads(side)[0]; return p ? COLORS()[p.slot - 1] : COLORS()[side - 1]; }
  function teamName(side) {
    var ps = sidePads(side);
    if (!ps.length) return playerName(side - 1);
    return G2T.joinNames(ps.map(function (p) { return playerName(p.slot - 1); }));
  }

  function resizePong(w, h) {
    var d = host.capDpr(w);
    pc.style.width = w + 'px';
    pc.style.height = h + 'px';
    pc.width = Math.round(w * d);
    pc.height = Math.round(h * d);
    pview.dpr = d;
    pview.scale = Math.min(w / LW, h / LH);
    pview.ox = (w - LW * pview.scale) / 2;
    pview.oy = (h - LH * pview.scale) / 2;
    bgLayer = null;
    lastStaticDraw = 0;
  }
  function resetPong() {
    pongLast = null;
    pongBuf = [];
    trail = [];
    particles = [];
    paddleY = [540, 540, 540, 540];
    pmeta = { phase: 'countdown', score: [0, 0], countdown: 0, winner: 0, toWin: 7, lastScorer: 0 };
    pads = classicPads();
    bgLayer = null;
  }
  function onPongState(s) {
    var o = s.ts - now();
    if (clockOffset === null || o > clockOffset) clockOffset = o;
    else clockOffset += (o - clockOffset) * 0.02;
    pongLast = s;
    pongBuf.push(s);
    if (pongBuf.length > 30) pongBuf.shift();
    for (var i = 0; i < s.p.length && i < 4; i++) paddleY[i] = s.p[i];
    host.debug.states++;
  }
  function onPongPaddle(m) {
    if (m.i >= 0 && m.i < 4) paddleY[m.i] = m.y;
  }
  function onPongMeta(m) {
    if (m.paddles && m.paddles.length && JSON.stringify(m.paddles) !== JSON.stringify(pads)) {
      pads = m.paddles;
      bgLayer = null;
    }
    if (m.phase !== pmeta.phase) {
      phaseChangedAt = now();
      lastStaticDraw = 0;
      if (pmeta.phase === 'countdown' && m.phase === 'playing') goAt = now();
    }
    if (m.phase === 'countdown' && m.countdown !== lastCountdown && m.countdown > 0) {
      host.sfx.tick();
      countdownChangedAt = now();
    }
    lastCountdown = m.phase === 'countdown' ? m.countdown : 0;
    if (String(m.score) !== String(pmeta.score) || m.winner !== pmeta.winner) lastStaticDraw = 0;
    pmeta = m;
  }

  function roundRect(x, y, w, h, r, c) {
    c = c || ctx;
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
  function glow(color, blur) {
    if (!FX) return;
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
  }
  function noGlow() { if (FX) { ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; } }
  function text(str, x, y, size, color, opts, c) {
    c = c || ctx;
    opts = opts || {};
    c.font = (opts.weight || 'bold') + ' ' + size + 'px ' + (opts.font || FONT);
    c.textAlign = opts.align || 'center';
    c.textBaseline = opts.baseline || 'middle';
    c.fillStyle = color;
    var g = opts.glow && FX && c === ctx;
    if (g) glow(opts.glowColor || color, opts.glow);
    c.fillText(str, x, y);
    if (g) noGlow();
  }
  function fitText(str, maxW, size, weight, c) {
    c = c || ctx;
    c.font = (weight || 'bold') + ' ' + size + 'px ' + FONT;
    while (size > 18 && c.measureText(str).width > maxW) {
      size -= 4;
      c.font = (weight || 'bold') + ' ' + size + 'px ' + FONT;
    }
    return size;
  }

  // Static layer: rebuilt only when the size or the names change
  // Text made of coloured pieces, centred on x: [[text, colour], ...]
  function textParts(g, parts, x, y, size) {
    g.font = 'bold ' + size + 'px ' + FONT;
    var total = 0, i;
    for (i = 0; i < parts.length; i++) total += g.measureText(parts[i][0]).width;
    var cx = x - total / 2;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    for (i = 0; i < parts.length; i++) {
      g.fillStyle = parts[i][1];
      g.fillText(parts[i][0], cx, y);
      cx += g.measureText(parts[i][0]).width;
    }
  }
  function teamParts(side, alpha) {
    var ps = sidePads(side), out = [];
    ps.forEach(function (p, n) {
      if (n > 0) out.push([' y ', 'rgba(255,255,255,' + (alpha * 0.8) + ')']);
      out.push([playerName(p.slot - 1), hexA(COLORS()[p.slot - 1], alpha)]);
    });
    return out;
  }
  function ensureBg() {
    var key = pc.width + 'x' + pc.height + '|' + JSON.stringify(pads) + '|' + pads.map(function (p) { return playerName(p.slot - 1); }).join('|');
    if (bgLayer && key === bgKey) return;
    bgKey = key;
    var c = document.createElement('canvas');
    c.width = pc.width;
    c.height = pc.height;
    var g = c.getContext('2d');
    g.fillStyle = '#03040b';
    g.fillRect(0, 0, c.width, c.height);
    var sc = pview.scale * pview.dpr;
    g.setTransform(sc, 0, 0, sc, pview.ox * pview.dpr, pview.oy * pview.dpr);
    var grad = g.createRadialGradient(LW / 2, LH / 2, 100, LW / 2, LH / 2, LW * 0.7);
    grad.addColorStop(0, '#0d1030');
    grad.addColorStop(1, '#03040b');
    g.fillStyle = grad;
    g.fillRect(0, 0, LW, LH);
    g.strokeStyle = 'rgba(120,140,255,0.045)';
    g.lineWidth = 1;
    g.beginPath();
    for (var x = 0; x <= LW; x += 80) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, LH); }
    for (var y = 0; y <= LH; y += 80) { g.moveTo(0, y + 0.5); g.lineTo(LW, y + 0.5); }
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.22)';
    for (var yy = 20; yy < LH; yy += 54) g.fillRect(LW / 2 - 4, yy, 8, 30);
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(0, 0, LW, 4);
    g.fillRect(0, LH - 4, LW, 4);
    if (!doubles()) {
      for (var i = 0; i < 2; i++) {
        var nx = i === 0 ? LW / 2 - 230 : LW / 2 + 230;
        var nm = playerName(pads[i] ? pads[i].slot - 1 : i);
        var ns = fitText(nm, 480, 36, 'bold', g);
        text(nm, nx, 270, ns, hexA(padColor(i), 0.75), { weight: 'bold' }, g);
      }
    } else {
      // Team names (each name in its player's colour) and the forward «rods»
      for (var side = 1; side <= 2; side++) {
        var tx = side === 1 ? LW / 2 - 230 : LW / 2 + 230;
        var tn = teamName(side);
        textParts(g, teamParts(side, 0.8), tx, 270, fitText(tn, 600, 36, 'bold', g));
      }
      g.fillStyle = 'rgba(255,255,255,0.06)';
      pads.forEach(function (p) { if (p.role === 'delantera') g.fillRect(p.x - 2, 0, 4, LH); });
      // Who is who: a name under every paddle
      pads.forEach(function (p) {
        var label = playerName(p.slot - 1);
        var size = fitText(label, 300, 26, 'bold', g);
        var align = p.x < 200 ? 'left' : (p.x > LW - 200 ? 'right' : 'center');
        var lx = align === 'left' ? 16 : (align === 'right' ? LW - 16 : p.x);
        text(label, lx, LH - 30, size, hexA(COLORS()[p.slot - 1], 0.85), { weight: 'bold', align: align }, g);
      });
    }
    bgLayer = c;
  }

  // Ball: interpolation with only INTERP_DELAY (20 ms) of delay; past the last
  // state, extrapolation with the velocity (max 50 ms).
  function sampleBall() {
    var s = pongLast;
    if (!s) return null;
    var r = pongField.ballR;
    var renderTs = now() + (clockOffset || 0) - INTERP_DELAY;
    if (renderTs < s.ts && pongBuf.length >= 2) {
      var i = pongBuf.length - 2;
      while (i > 0 && pongBuf[i].ts > renderTs) i--;
      var a = pongBuf[i], b = pongBuf[i + 1];
      if (renderTs <= a.ts) return { bx: a.b[0], by: a.b[1], r: a.r, ph: a.ph };
      var k = clamp((renderTs - a.ts) / ((b.ts - a.ts) || 1), 0, 1);
      if (a.r !== b.r) { var q = k < 0.5 ? a : b; return { bx: q.b[0], by: q.b[1], r: q.r, ph: q.ph }; }
      return { bx: lerp(a.b[0], b.b[0], k), by: lerp(a.b[1], b.b[1], k), r: b.r, ph: b.ph };
    }
    var x = s.b[0], y = s.b[1];
    if (s.ph === 'playing') {
      var dt = clamp(renderTs - s.ts, 0, MAX_EXTRAPOLATE_MS) / 1000;
      x += s.b[2] * dt;
      y += s.b[3] * dt;
      if (y < r) y = r + (r - y);
      else if (y > LH - r) y = (LH - r) - (y - (LH - r));
      // Do not let the extrapolation go through a paddle that will return it
      // (only paddles that defend in the direction the ball travels)
      for (var k = 0; k < pads.length; k++) {
        var pd = pads[k];
        var half = pd.h / 2 + r;
        if (Math.abs(y - paddleY[k]) > half) continue;
        if (pd.side === 1 && s.b[2] < 0) {
          var f0 = pd.x + pongField.paddleW / 2 + r;
          if (x < f0 && s.b[0] >= f0) x = f0;
        } else if (pd.side === 2 && s.b[2] > 0) {
          var f1 = pd.x - pongField.paddleW / 2 - r;
          if (x > f1 && s.b[0] <= f1) x = f1;
        }
      }
    }
    return { bx: clamp(x, -50, LW + 50), by: clamp(y, r, LH - r), r: s.r, ph: s.ph };
  }
  function burst(x, y, color, n) {
    if (!FX) n = Math.ceil(n / 3);
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 150 + Math.random() * 450;
      particles.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color: color, size: 3 + Math.random() * 4 });
    }
    if (particles.length > 120) particles.splice(0, particles.length - 120);
  }
  function updateParticles(dt) {
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.94; p.vy *= 0.94;
      p.life -= dt * 1.6;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }
  function drawParticles() {
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }
  function drawQr(x, y, size) {
    roundRect(x - 18, y - 18, size + 36, size + 36, 24);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    var img = host.qrImage();
    if (img) {
      ctx.imageSmoothingEnabled = false;
      try { ctx.drawImage(img, x, y, size, size); } catch (e) { /* noop */ }
      ctx.imageSmoothingEnabled = true;
    }
  }
  function drawScores() {
    var s = pmeta.score || [0, 0];
    for (var i = 0; i < 2; i++) {
      var x = i === 0 ? LW / 2 - 230 : LW / 2 + 230;
      var f = scoreFlash[i];
      text(String(s[i]), x, 140, 190 + 50 * f, teamColor(i + 1), { glow: 30 + 40 * f, weight: '900' });
    }
  }
  function drawPaddle(i, cy) {
    var pd = pads[i];
    var x = pd.x;
    var w = pongField.paddleW, h = pd.h;
    var f = pongFlashes[i];
    var col = padColor(i);
    if (!FX) {
      // «Cheap» glow: a wider, semi-transparent shape behind
      ctx.globalAlpha = 0.18 + 0.25 * f;
      roundRect(x - w / 2 - 9, cy - h / 2 - 9, w + 18, h + 18, (w + 18) / 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    roundRect(x - w / 2, cy - h / 2, w, h, w / 2);
    ctx.fillStyle = f > 0.05 ? '#ffffff' : col;
    glow(col, 30 + 40 * f);
    ctx.fill();
    noGlow();
    if (f > 0.05) {
      ctx.globalAlpha = 1 - f;
      roundRect(x - w / 2, cy - h / 2, w, h, w / 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  function drawBall(st) {
    var r = pongField.ballR;
    ctx.fillStyle = '#bfe9ff';
    for (var i = 0; i < trail.length; i++) {
      var k = (i + 1) / trail.length;
      ctx.globalAlpha = 0.28 * k;
      ctx.beginPath();
      ctx.arc(trail[i].x, trail[i].y, r * (0.35 + 0.6 * k), 0, Math.PI * 2);
      ctx.fill();
    }
    if (!FX) {
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = '#9fe8ff';
      ctx.beginPath();
      ctx.arc(st.bx, st.by, r * 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(st.bx, st.by, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    glow('#9fe8ff', 35);
    ctx.fill();
    noGlow();
  }
  function drawCountdown(t) {
    var n = pmeta.countdown || 0;
    if (n <= 0) return;
    var frac = clamp((t - countdownChangedAt) / 1000, 0, 1);
    var color = n === 3 ? teamColor(1) : (n === 2 ? '#ffffff' : teamColor(2));
    text(String(n), LW / 2, LH / 2 + 20, 300 + 80 * (1 - frac), color, { glow: 60, weight: '900' });
    var sub = (pmeta.score[0] + pmeta.score[1] === 0) ? '¡Preparados!' : 'Seguimos…';
    text(sub, LW / 2, LH / 2 + 230, 48, 'rgba(255,255,255,0.8)', { weight: 'normal' });
  }
  function drawGo(t) {
    var since = t - goAt;
    if (since < 0 || since > 700) return;
    ctx.globalAlpha = 1 - since / 700;
    text('¡YA!', LW / 2, LH / 2 + 20, 260 + since * 0.2, '#ffffff', { glow: 60, glowColor: '#a080ff', weight: '900' });
    ctx.globalAlpha = 1;
  }
  function drawScored() {
    var s = pmeta.lastScorer;
    if (!s) return;
    var msg = '¡Punto para ' + teamName(s) + '!';
    text(msg, LW / 2, LH / 2 + 160, fitText(msg, 1500, 56), teamColor(s), { glow: 25 });
  }
  // Static screens: opaque background (no full-screen semi-transparent layers)
  function drawPaused() {
    text('PAUSA', LW / 2, 350, 150, '#ffffff', { glow: 40, glowColor: '#a080ff', weight: '900' });
    var p = host.hub().players || [];
    var y = 490;
    var shown = 0;
    for (var k = 0; k < pads.length; k++) {
      var i = pads[k].slot - 1;
      if (p[i] && !p[i].connected && shown < 2) {
        text('Esperando a ' + p[i].name + '…', LW / 2, y, 46, COLORS()[i], { glow: 14 });
        text('Reconexión: ' + (p[i].holdLeft || 0) + ' s', LW / 2, y + 60, 36, 'rgba(255,255,255,0.7)', { weight: 'normal' });
        y += 140;
        shown++;
      }
    }
    text('Vuelve a abrir la página en el móvil para seguir', LW / 2, y + 10, 32, 'rgba(255,255,255,0.55)', { weight: 'normal' });
    drawQr(LW / 2 - 110, y + 70, 220);
  }
  function drawGameOver(t) {
    var w = pmeta.winner || 1;
    var c = teamColor(w);
    var pulse = 1 + 0.04 * Math.sin(t / 220);
    ctx.save();
    ctx.translate(LW / 2, 330);
    ctx.scale(pulse, pulse);
    var name = teamName(w).toUpperCase();
    var title = (sidePads(w).length > 1 ? '¡GANAN ' : '¡GANA ') + name + '!';
    var size = fitText(title, 1600, 150, '900');
    text(title, 0, 0, size, c, { glow: 60, weight: '900' });
    ctx.restore();
    var s = pmeta.score || [0, 0];
    text(s[0] + '  –  ' + s[1], LW / 2, 540, 120, '#ffffff', { glow: 20, glowColor: '#a080ff', weight: '900' });
    if (!doubles()) {
      text(teamName(1), LW / 2 - 380, 540, fitText(teamName(1), 360, 40), teamColor(1), { weight: 'bold' });
      text(teamName(2), LW / 2 + 380, 540, fitText(teamName(2), 360, 40), teamColor(2), { weight: 'bold' });
    } else {
      text(teamName(1), LW / 2 - 330, 540, fitText(teamName(1), 460, 40), teamColor(1), { weight: 'bold', align: 'right' });
      text(teamName(2), LW / 2 + 330, 540, fitText(teamName(2), 460, 40), teamColor(2), { weight: 'bold', align: 'left' });
    }
    text('¿Revancha?', LW / 2, 730, 90, '#ffffff', { glow: 30, glowColor: '#a080ff', weight: '900' });
    text('Pulsad «¡Revancha!» o «Menú» en el móvil', LW / 2, 830, 38, 'rgba(255,255,255,0.7)', { weight: 'normal' });
  }
  function drawPong(t, dt) {
    var ph = pmeta.phase;
    var sc = pview.scale * pview.dpr;
    if (ph === 'paused' || ph === 'gameover') {
      // Almost static: ~10 frames/s are enough
      if (t - lastStaticDraw < 100) return;
      lastStaticDraw = t;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#05060f';
      ctx.fillRect(0, 0, pc.width, pc.height);
      ctx.setTransform(sc, 0, 0, sc, pview.ox * pview.dpr, pview.oy * pview.dpr);
      if (ph === 'paused') drawPaused(); else drawGameOver(t);
      return;
    }
    for (var i = 0; i < 4; i++) {
      pongFlashes[i] = Math.max(0, pongFlashes[i] - dt * 5);
      if (i < 2) scoreFlash[i] = Math.max(0, scoreFlash[i] - dt * 2);
    }
    shake = Math.max(0, shake - dt * 3);
    updateParticles(dt);
    ensureBg();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bgLayer, 0, 0); // replaces clearing the screen
    var sx = 0, sy = 0;
    if (shake > 0 && FX) { sx = (Math.random() - 0.5) * 18 * shake; sy = (Math.random() - 0.5) * 18 * shake; }
    ctx.setTransform(sc, 0, 0, sc, (pview.ox + sx) * pview.dpr, (pview.oy + sy) * pview.dpr);
    drawScores();
    var st = sampleBall();
    for (var k = 0; k < pads.length; k++) drawPaddle(k, paddleY[k]);
    if (st) {
      lastBall.x = st.bx;
      lastBall.y = st.by;
      if (st.r !== trailResetId) { trail = []; trailResetId = st.r; }
      if (st.ph === 'playing') { trail.push({ x: st.bx, y: st.by }); if (trail.length > (FX ? 14 : 8)) trail.shift(); }
      else if (trail.length) trail.shift();
      if (!(ph === 'scored' && t - phaseChangedAt < 250)) drawBall(st);
    }
    drawParticles();
    if (ph === 'countdown') drawCountdown(t);
    else if (ph === 'playing') drawGo(t);
    else if (ph === 'scored') drawScored();
  }

  G2T.tv.register({
    id: 'pong',
    mount: function (h, game) {
      host = h;
      FX = h.FX;
      COLORS = h.colors;
      if (game.tv && game.tv.field) pongField = game.tv.field;
      pc = document.createElement('canvas');
      pc.id = 'pc';
      pc.style.cssText = 'position:absolute;left:0;top:0;display:none;z-index:0;';
      h.addLayer(pc);
      pctx = pc.getContext('2d', { alpha: false }) || pc.getContext('2d');
      ctx = pctx;
    },
    layout: function (w, h) { resizePong(w, h); },
    onConnect: function () { pongLast = null; clockOffset = null; },
    enter: function () { pc.style.display = 'block'; },
    leave: function () { pc.style.display = 'none'; resetPong(); },
    onMessage: function (msg) {
      switch (msg.t) {
        case 'pmeta': onPongMeta(msg); break;
        case 's': onPongState(msg); break;
        case 'p': onPongPaddle(msg); break;
      }
    },
    onEvent: function (ev) {
      switch (ev.k) {
        case 'hit': {
          var k = ev.paddle != null ? ev.paddle : ev.slot - 1;
          sfx.hit(ev.side || ev.slot);
          pongFlashes[k] = 1;
          burst(lastBall.x, lastBall.y, padColor(k), 14);
          break;
        }
        case 'wall': sfx.wall(); break;
        case 'score':
          sfx.score();
          scoreFlash[ev.slot - 1] = 1;
          shake = 1;
          burst(ev.slot === 1 ? LW - 10 : 10, lastBall.y, teamColor(ev.slot), 30);
          break;
        case 'go': host.sfx.go(); break;
        case 'win': setTimeout(host.sfx.win, 300); break;
      }
    },
    frame: function (t, dt) { drawPong(t, dt); },
    debugInfo: function () { return Math.round(pc.width) + 'x' + Math.round(pc.height); },
    canvas: function () { return pc; }
  });
})();
