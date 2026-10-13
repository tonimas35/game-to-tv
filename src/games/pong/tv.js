/*
 * Pong: TV view (same look as the original Pong, optimized for the TV).
 * - No shadowBlur by default (very expensive on the TV GPU): the glow is
 *   faked with a wider, semi-transparent shape. ?fx=1 turns real glows on.
 * - Background, grid, centre line and names are drawn ONCE into an offscreen
 *   canvas and each frame only copies it (drawImage).
 * - Paddles use the LATEST received position ('s' and 'p' messages), with no
 *   interpolation delay. The ball is extrapolated with its velocity.
 * - The canvas backing store is capped (see public/lib/canvas.js).
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
  var pongLast = null;            // last 's' state from the server
  var pongBuf = [];               // last states (to interpolate the ball)
  var INTERP_DELAY = 20;          // ms: ~1 server tick
  var paddleY = [540, 540];       // last known position of each paddle
  var clockOffset = null;         // (server clock) - now(), estimated
  var MAX_EXTRAPOLATE_MS = 50;
  var lastCountdown = 0, phaseChangedAt = now(), countdownChangedAt = now(), goAt = -10000;
  var trail = [], trailResetId = -1, particles = [], pongFlashes = [0, 0], scoreFlash = [0, 0], shake = 0;
  var lastBall = { x: LW / 2, y: LH / 2 };
  var bgLayer = null, bgKey = '';
  var lastStaticDraw = 0;

  function playerName(i) { return host.playerName(i); }

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
    paddleY = [540, 540];
    pmeta = { phase: 'countdown', score: [0, 0], countdown: 0, winner: 0, toWin: 7, lastScorer: 0 };
  }
  function onPongState(s) {
    var o = s.ts - now();
    if (clockOffset === null || o > clockOffset) clockOffset = o;
    else clockOffset += (o - clockOffset) * 0.02;
    pongLast = s;
    pongBuf.push(s);
    if (pongBuf.length > 30) pongBuf.shift();
    paddleY[0] = s.p[0];
    paddleY[1] = s.p[1];
    host.debug.states++;
  }
  function onPongPaddle(m) {
    if (m.i === 0 || m.i === 1) paddleY[m.i] = m.y;
  }
  function onPongMeta(m) {
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
  function ensureBg() {
    var key = pc.width + 'x' + pc.height + '|' + playerName(0) + '|' + playerName(1);
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
    for (var i = 0; i < 2; i++) {
      var nx = i === 0 ? LW / 2 - 230 : LW / 2 + 230;
      var ns = fitText(playerName(i), 480, 36, 'bold', g);
      text(playerName(i), nx, 270, ns, hexA(COLORS()[i], 0.75), { weight: 'bold' }, g);
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
      var half = pongField.paddleH / 2 + r;
      var f0 = pongField.paddleMargin + pongField.paddleW / 2 + r;
      var f1 = LW - pongField.paddleMargin - pongField.paddleW / 2 - r;
      if (s.b[2] < 0 && x < f0 && s.b[0] >= f0 && Math.abs(y - paddleY[0]) <= half) x = f0;
      if (s.b[2] > 0 && x > f1 && s.b[0] <= f1 && Math.abs(y - paddleY[1]) <= half) x = f1;
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
      text(String(s[i]), x, 140, 190 + 50 * f, COLORS()[i], { glow: 30 + 40 * f, weight: '900' });
    }
  }
  function drawPaddle(i, cy) {
    var x = i === 0 ? pongField.paddleMargin : LW - pongField.paddleMargin;
    var w = pongField.paddleW, h = pongField.paddleH;
    var f = pongFlashes[i];
    var col = COLORS()[i];
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
    var color = n === 3 ? COLORS()[0] : (n === 2 ? '#ffffff' : COLORS()[1]);
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
    text('¡Punto para ' + playerName(s - 1) + '!', LW / 2, LH / 2 + 160, 56, COLORS()[s - 1], { glow: 25 });
  }
  // Static screens: opaque background (no full-screen semi-transparent layers)
  function drawPaused() {
    text('PAUSA', LW / 2, 350, 150, '#ffffff', { glow: 40, glowColor: '#a080ff', weight: '900' });
    var p = host.hub().players || [];
    var y = 490;
    for (var i = 0; i < 2; i++) {
      if (p[i] && !p[i].connected) {
        text('Esperando a ' + p[i].name + '…', LW / 2, y, 46, COLORS()[i], { glow: 14 });
        text('Reconexión: ' + (p[i].holdLeft || 0) + ' s', LW / 2, y + 60, 36, 'rgba(255,255,255,0.7)', { weight: 'normal' });
        y += 140;
      }
    }
    text('Vuelve a abrir la página en el móvil para seguir', LW / 2, y + 10, 32, 'rgba(255,255,255,0.55)', { weight: 'normal' });
    drawQr(LW / 2 - 110, y + 70, 220);
  }
  function drawGameOver(t) {
    var w = pmeta.winner || 1;
    var c = COLORS()[w - 1];
    var pulse = 1 + 0.04 * Math.sin(t / 220);
    ctx.save();
    ctx.translate(LW / 2, 330);
    ctx.scale(pulse, pulse);
    var name = playerName(w - 1).toUpperCase();
    var size = fitText('¡GANA ' + name + '!', 1600, 150, '900');
    text('¡GANA ' + name + '!', 0, 0, size, c, { glow: 60, weight: '900' });
    ctx.restore();
    var s = pmeta.score || [0, 0];
    text(s[0] + '  –  ' + s[1], LW / 2, 540, 120, '#ffffff', { glow: 20, glowColor: '#a080ff', weight: '900' });
    text(playerName(0), LW / 2 - 380, 540, fitText(playerName(0), 360, 40), COLORS()[0], { weight: 'bold' });
    text(playerName(1), LW / 2 + 380, 540, fitText(playerName(1), 360, 40), COLORS()[1], { weight: 'bold' });
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
    for (var i = 0; i < 2; i++) {
      pongFlashes[i] = Math.max(0, pongFlashes[i] - dt * 5);
      scoreFlash[i] = Math.max(0, scoreFlash[i] - dt * 2);
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
    drawPaddle(0, paddleY[0]);
    drawPaddle(1, paddleY[1]);
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
        case 'hit': sfx.hit(ev.slot); pongFlashes[ev.slot - 1] = 1; burst(lastBall.x, lastBall.y, COLORS()[ev.slot - 1], 14); break;
        case 'wall': sfx.wall(); break;
        case 'score':
          sfx.score();
          scoreFlash[ev.slot - 1] = 1;
          shake = 1;
          burst(ev.slot === 1 ? LW - 10 : 10, lastBall.y, COLORS()[ev.slot - 1], 30);
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
