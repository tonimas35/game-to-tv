/*
 * «Sumo»: TV view. Loaded by public/tv.html (ES2019).
 *
 * Two layers:
 * - A full-window canvas (below the stage) with the arena. Everything that
 *   does not move is pre-rendered once into offscreen canvases: the floor
 *   and the clay platform (bgLayer), the ring with its straw rope (ringImg:
 *   when the ring shrinks the cached image is drawn scaled, never redrawn),
 *   one shaded ball per colour (sprites) and the name labels. Floor + ring
 *   are merged into one more canvas (arena), rebuilt only when the ring
 *   shrinks, so a frame is ONE full-screen copy plus a handful of small
 *   drawImage calls and the eyes. No shadowBlur, no filters; the backing
 *   store is capped with host.capDpr (1280 wide on webOS).
 * - A transparent DOM view on the 1920x1080 stage for the score at the top,
 *   the countdown, the round result, and the opaque «Pausa» and winner screens.
 *
 * The server sends the state at 30 Hz ('s'); the wrestlers are drawn
 * INTERP ms in the past, interpolated between two states (extrapolated with
 * their velocity for a moment if a state is late). Collision events carry the
 * server time, so the dust puffs appear when the balls touch on screen.
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var $ = G2T.$, now = G2T.now, clamp = G2T.clamp, lerp = G2T.lerp, hexA = G2T.hexA;
  var host = null, view = null, show, setText, fit;
  var beep = G2T.sound.beep;

  var LW = 1920, LH = 1080;
  var RING = { cx: 960, cy: 612, r0: 420, ball: 60, shrinkAt: 10 };
  var ROPE = 15;                   // half the rope thickness
  var INTERP = 50;                 // ms in the past
  var MAX_EXTRA = 80;              // ms of extrapolation at most
  var FONT = "'LG Smart UI', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

  var HTML =
    '<div class="suSide suL" id="suSide1">' +
    '  <div class="suWho"><span class="suDot"></span><span class="suName fit" id="suN1">—</span></div>' +
    '  <div class="suPips" id="suP1"><i></i><i></i><i></i></div>' +
    '  <div class="suPts" id="suS1">0</div>' +
    '</div>' +
    '<div class="suMid">' +
    '  <div class="suRound fit" id="suRound">Ronda 1</div>' +
    '  <div class="suBest fit" id="suBest">Al mejor de 5 · gana quien llegue a 3</div>' +
    '</div>' +
    '<div class="suSide suR" id="suSide2">' +
    '  <div class="suWho"><span class="suName fit" id="suN2">—</span><span class="suDot"></span></div>' +
    '  <div class="suPips" id="suP2"><i></i><i></i><i></i></div>' +
    '  <div class="suPts" id="suS2">0</div>' +
    '</div>' +
    '<div class="suShrink" id="suShrink">¡El círculo encoge!</div>' +
    '<div class="suBig" id="suBig"></div>' +
    '<div class="suSub fit" id="suSub"></div>' +
    '<div class="suBanner fit" id="suBanner"></div>' +
    '<div class="suKeys">Atrás: volver al menú</div>' +
    '<div class="ov center suOpaque" id="suPause">' +
    '  <p class="suPauseT">Pausa</p>' +
    '  <div class="suPauseWho fit" id="suPauseWho">Esperando…</div>' +
    '  <p class="suPauseHold" id="suPauseHold"></p>' +
    '  <p class="sub">Volved a abrir la página en el móvil para seguir</p>' +
    '</div>' +
    '<div class="ov suOpaque" id="suEnd">' +
    '  <p class="suEndK">¡FIN DEL COMBATE!</p>' +
    '  <div class="suEndBall" id="suEndBall"><i></i><i></i></div>' +
    '  <div class="suEndT fit" id="suEndT">—</div>' +
    '  <div class="suEndScore">' +
    '    <span class="suEndN fit" id="suEndN1">—</span>' +
    '    <b id="suEndS">0 – 0</b>' +
    '    <span class="suEndN fit" id="suEndN2">—</span>' +
    '  </div>' +
    '  <div class="suEndBtns">' +
    '    <div class="btn" id="suAgain">Otra</div>' +
    '    <div class="btn" id="suMenu">Menú</div>' +
    '  </div>' +
    '  <p class="suEndK2">◀ ▶ y OK · o en el móvil</p>' +
    '</div>';

  // ---------------------------------------------------------------- state
  var M = null;                    // last 'smeta'
  var buf = [];                    // last 's' states
  var clockOffset = null;          // server clock - now()
  var pendingHits = [];            // collision events waiting for their moment
  var parts = [];                  // dust puffs
  var shake = 0;
  var outAt = [0, 0], outRound = -1;
  var focusIndex = 0;
  var bigKey = '', bannerKey = '', lastCountdown = 0, flip = false;
  var lastShrink = false;

  // ---------------------------------------------------------------- canvas
  var cv = null, ctx = null;
  var pv = { scale: 1, ox: 0, oy: 0, dpr: 1 };
  var bgLayer = null, ringImg = null, puffImg = null, arena = null, arenaR = -1;
  var sprites = {}, labels = {};

  function colorOfWrestler(k) {
    var slot = M && M.slots && M.slots[k];
    return host.colors()[(slot || (k + 1)) - 1] || '#ffffff';
  }
  function nameOfWrestler(k) {
    var slot = M && M.slots && M.slots[k];
    return host.playerName((slot || (k + 1)) - 1);
  }

  function resize(w, h) {
    var d = host.capDpr(w);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    cv.width = Math.round(w * d);
    cv.height = Math.round(h * d);
    pv.dpr = d;
    pv.scale = Math.min(w / LW, h / LH);
    pv.ox = (w - LW * pv.scale) / 2;
    pv.oy = (h - LH * pv.scale) / 2;
    bgLayer = null;
    ringImg = null;
    puffImg = null;
    arena = null;
    arenaR = -1;
    sprites = {};
    labels = {};
  }
  function devScale() { return pv.scale * pv.dpr; }
  // An offscreen canvas for `size` world px, drawn with world coordinates centred on it
  function offscreen(wWorld, hWorld) {
    var sc = devScale();
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(wWorld * sc));
    c.height = Math.max(1, Math.ceil(hWorld * sc));
    var g = c.getContext('2d');
    g.setTransform(c.width / wWorld, 0, 0, c.height / hWorld, 0, 0);
    return { c: c, g: g, w: wWorld, h: hWorld };
  }
  function shade(hex, k) {         // k > 0 lighter (towards white), k < 0 darker
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (k >= 0) { r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k; } else { r *= 1 + k; g *= 1 + k; b *= 1 + k; }
    return 'rgb(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ')';
  }

  // Floor and clay platform: once per canvas size
  function ensureBg() {
    if (bgLayer) return;
    var c = document.createElement('canvas');
    c.width = cv.width;
    c.height = cv.height;
    var g = c.getContext('2d');
    g.fillStyle = '#1a0f0a';
    g.fillRect(0, 0, c.width, c.height);
    var sc = devScale();
    g.setTransform(sc, 0, 0, sc, pv.ox * pv.dpr, pv.oy * pv.dpr);
    var grad = g.createRadialGradient(RING.cx, RING.cy, 200, RING.cx, RING.cy, 1150);
    grad.addColorStop(0, '#4a2c1b');
    grad.addColorStop(1, '#1a0f0a');
    g.fillStyle = grad;
    g.fillRect(0, 0, LW, LH);
    // Wooden planks of the hall floor
    g.strokeStyle = 'rgba(0,0,0,0.18)';
    g.lineWidth = 3;
    g.beginPath();
    for (var y = 60; y < LH; y += 120) { g.moveTo(0, y); g.lineTo(LW, y); }
    g.stroke();
    // The clay platform (a raised square), with its darker side
    var half = 490, top = RING.cy - half;
    g.fillStyle = '#6e4224';
    g.fillRect(RING.cx - half, top + 18, half * 2, half * 2);
    var pg = g.createLinearGradient(0, top, 0, top + half * 2);
    pg.addColorStop(0, '#c08a57');
    pg.addColorStop(1, '#a8743f');
    g.fillStyle = pg;
    g.fillRect(RING.cx - half, top, half * 2, half * 2);
    g.fillStyle = 'rgba(255,230,190,0.18)';
    g.fillRect(RING.cx - half, top, half * 2, 6);
    bgLayer = c;
  }

  // The ring at its full size: sand, shikiri lines and the straw rope
  function ensureRing() {
    if (ringImg) return;
    var pad = ROPE + 10;
    var size = 2 * (RING.r0 + pad);
    var o = offscreen(size, size);
    var g = o.g;
    var cx = size / 2, cy = size / 2, R = RING.r0;
    var sg = g.createRadialGradient(cx - R * 0.25, cy - R * 0.3, 20, cx, cy, R);
    sg.addColorStop(0, '#f6e4b8');
    sg.addColorStop(1, '#dcb97c');
    g.fillStyle = sg;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fill();
    // A little texture in the sand (once)
    var seed = 7;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    g.fillStyle = 'rgba(140,100,50,0.13)';
    for (var i = 0; i < 260; i++) {
      var a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * (R - 20);
      g.fillRect(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 3, 3);
    }
    g.strokeStyle = 'rgba(150,110,60,0.18)';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(cx, cy, R * 0.86, 0, Math.PI * 2);
    g.stroke();
    // Shikiri-sen: the two white start lines
    g.fillStyle = 'rgba(255,255,255,0.9)';
    var lx = R * 0.5 - RING.ball - 16;
    g.fillRect(cx - lx - 6, cy - 48, 12, 96);
    g.fillRect(cx + lx - 6, cy - 48, 12, 96);
    // The straw rope (tawara), centred on the edge
    g.lineWidth = ROPE * 2;
    g.strokeStyle = '#cfa955';
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 5;
    g.strokeStyle = 'rgba(255,236,170,0.75)';
    g.beginPath();
    g.arc(cx, cy, R - ROPE * 0.35, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 3;
    g.strokeStyle = '#8c6a26';
    g.beginPath();
    g.arc(cx, cy, R - ROPE, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, R + ROPE, 0, Math.PI * 2);
    g.stroke();
    // Bales tied every few degrees
    g.strokeStyle = 'rgba(120,88,30,0.75)';
    g.lineWidth = 3;
    g.beginPath();
    for (var k = 0; k < 64; k++) {
      var an = k / 64 * Math.PI * 2;
      g.moveTo(cx + Math.cos(an) * (R - ROPE + 2), cy + Math.sin(an) * (R - ROPE + 2));
      g.lineTo(cx + Math.cos(an) * (R + ROPE - 2), cy + Math.sin(an) * (R + ROPE - 2));
    }
    g.stroke();
    ringImg = o;
  }

  // One shaded ball per colour (with its shadow)
  function spriteFor(color) {
    var s = sprites[color];
    if (s) return s;
    var r = RING.ball;
    var size = 2 * r + 40;
    var o = offscreen(size, size);
    var g = o.g;
    var c = size / 2;
    g.fillStyle = 'rgba(40,18,6,0.35)';
    g.beginPath();
    g.ellipse(c + 7, c + 13, r * 1.02, r * 0.96, 0, 0, Math.PI * 2);
    g.fill();
    var bg = g.createRadialGradient(c - r * 0.38, c - r * 0.42, r * 0.08, c, c, r);
    bg.addColorStop(0, shade(color, 0.6));
    bg.addColorStop(0.45, color);
    bg.addColorStop(1, shade(color, -0.42));
    g.fillStyle = bg;
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = shade(color, -0.6);
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.beginPath();
    g.ellipse(c - r * 0.36, c - r * 0.46, r * 0.22, r * 0.13, -0.6, 0, Math.PI * 2);
    g.fill();
    sprites[color] = o;
    return o;
  }

  function labelFor(name, color) {
    var key = name + '|' + color;
    var l = labels[key];
    if (l) return l;
    var probe = document.createElement('canvas').getContext('2d');
    probe.font = 'bold 30px ' + FONT;
    var w = Math.min(320, Math.ceil(probe.measureText(name).width) + 16);
    var o = offscreen(w, 44);
    var g = o.g;
    g.font = 'bold 30px ' + FONT;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 7;
    g.strokeStyle = 'rgba(30,14,6,0.85)';
    g.strokeText(name, w / 2, 23, w - 12);
    g.fillStyle = color;
    g.fillText(name, w / 2, 23, w - 12);
    labels[key] = o;
    return o;
  }

  function ensurePuff() {
    if (puffImg) return;
    var o = offscreen(64, 64);
    var g = o.g;
    var pg = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    pg.addColorStop(0, 'rgba(245,226,182,0.95)');
    pg.addColorStop(0.6, 'rgba(232,206,150,0.55)');
    pg.addColorStop(1, 'rgba(232,206,150,0)');
    g.fillStyle = pg;
    g.fillRect(0, 0, 64, 64);
    puffImg = o;
  }

  // The ring at radius R, scaled from its cached image (g has the world transform)
  function drawRing(g, R) {
    var k = R / RING.r0;
    if (k <= 0.002) return;
    var rw = ringImg.w * k;
    g.drawImage(ringImg.c, RING.cx - rw / 2, RING.cy - rw / 2, rw, rw);
  }
  // Floor + ring in one canvas: rebuilt when the radius changes by 3 px or more
  // (every ~9 frames while it shrinks)
  function ensureArena(R) {
    var q = Math.round(R / 3) * 3;
    if (arena && arena.width === cv.width && arena.height === cv.height && q === arenaR) return;
    if (!arena || arena.width !== cv.width || arena.height !== cv.height) {
      arena = document.createElement('canvas');
      arena.width = cv.width;
      arena.height = cv.height;
    }
    arenaR = q;
    var g = arena.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(bgLayer, 0, 0);
    var sc = devScale();
    g.setTransform(sc, 0, 0, sc, pv.ox * pv.dpr, pv.oy * pv.dpr);
    drawRing(g, q);
    host.debug.arena = (host.debug.arena || 0) + 1;
  }

  // ---------------------------------------------------------------- state from the server
  function serverNow() { return now() + (clockOffset || 0); }
  function onState(s) {
    var o = s.ts - now();
    if (clockOffset === null || o > clockOffset) clockOffset = o;
    else clockOffset += (o - clockOffset) * 0.02;
    buf.push(s);
    if (buf.length > 24) buf.shift();
    host.debug.states++;
  }
  function unpack(s, i) {
    var w = s.w, k = i * 6;
    return { x: w[k], y: w[k + 1], vx: w[k + 2], vy: w[k + 3], f: w[k + 4], flags: w[k + 5] };
  }
  function lerpAngle(a, b, t) {
    var d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }
  function sample() {
    if (!buf.length) return null;
    var rt = serverNow() - INTERP;
    var last = buf[buf.length - 1];
    var i, out = { n: last.n, ph: last.ph, R: last.R, w: [] };
    if (rt >= last.ts || buf.length < 2) {
      var moving = last.ph === 'playing' || last.ph === 'roundover';
      var dt = moving ? clamp(rt - last.ts, 0, MAX_EXTRA) / 1000 : 0;
      for (i = 0; i < 2; i++) {
        var a0 = unpack(last, i);
        a0.x += a0.vx * dt;
        a0.y += a0.vy * dt;
        out.w.push(a0);
      }
      return out;
    }
    var j = buf.length - 2;
    while (j > 0 && buf[j].ts > rt) j--;
    var A = buf[j], B = buf[j + 1];
    if (rt <= A.ts || A.n !== B.n) {
      var Q = rt <= A.ts ? A : B;
      for (i = 0; i < 2; i++) out.w.push(unpack(Q, i));
      out.n = Q.n; out.ph = Q.ph; out.R = Q.R;
      return out;
    }
    var t = clamp((rt - A.ts) / ((B.ts - A.ts) || 1), 0, 1);
    for (i = 0; i < 2; i++) {
      var a = unpack(A, i), b = unpack(B, i);
      out.w.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), vx: b.vx, vy: b.vy, f: lerpAngle(a.f, b.f, t), flags: t < 0.5 ? a.flags : b.flags });
    }
    out.n = B.n; out.ph = B.ph; out.R = lerp(A.R, B.R, t);
    return out;
  }

  // ---------------------------------------------------------------- effects
  function puff(x, y, n, power) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = (60 + Math.random() * 220) * (0.6 + power);
      parts.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.8, life: 0.55 + Math.random() * 0.4, max: 0, size: 26 + Math.random() * 26 * (0.5 + power) });
      parts[parts.length - 1].max = parts[parts.length - 1].life;
    }
    if (parts.length > 50) parts.splice(0, parts.length - 50);
  }
  function updateEffects(dt) {
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.9; p.vy *= 0.9;
      p.size += 40 * dt;
      p.life -= dt;
      if (p.life <= 0) parts.splice(i, 1);
    }
    shake = Math.max(0, shake - dt * 4);
    // Collisions whose moment has come (the balls touch on screen now)
    var rt = serverNow() - INTERP;
    for (var k = pendingHits.length - 1; k >= 0; k--) {
      var h = pendingHits[k];
      if (clockOffset === null || rt >= h.ts || now() - h.got > 400) {
        pendingHits.splice(k, 1);
        puff(h.x, h.y, 2 + Math.round(h.p * 8), h.p);
        if (h.big) shake = Math.min(1, shake + 0.5 + h.p * 0.5);
        if (h.p >= 0.2) beep(70 + 90 * h.p, 0.13, 'square', 0.05 + 0.1 * h.p, 45);
      }
    }
  }

  // ---------------------------------------------------------------- drawing
  function drawWrestler(k, st, t) {
    var r = RING.ball;
    var color = colorOfWrestler(k);
    var spr = spriteFor(color);
    var s = 1, alpha = 1;
    if (st.flags & 2) {
      if (outRound !== curRound) { outRound = curRound; outAt = [0, 0]; }
      if (!outAt[k]) outAt[k] = t;
      var f = clamp((t - outAt[k]) / 900, 0, 1);
      s = 1 - 0.35 * f;
      alpha = 1 - 0.45 * f;
    }
    // Dash: two ghosts behind and a white ring (heavy!)
    if (st.flags & 1) {
      for (var gk = 2; gk >= 1; gk--) {
        ctx.globalAlpha = 0.16 * (3 - gk);
        ctx.drawImage(spr.c, st.x - st.vx * 0.035 * gk - spr.w / 2, st.y - st.vy * 0.035 * gk - spr.h / 2, spr.w, spr.h);
      }
    }
    ctx.globalAlpha = alpha;
    var sw = spr.w * s;
    ctx.drawImage(spr.c, st.x - sw / 2, st.y - sw / 2, sw, sw);
    var rr = r * s;
    if (st.flags & 1) {
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath();
      ctx.arc(st.x, st.y, rr + 7, 0, Math.PI * 2);
      ctx.stroke();
    }
    var fa = st.f, cf = Math.cos(fa), sf = Math.sin(fa);
    function px(d, a) { return st.x + Math.cos(fa + a) * d * rr; }
    function py(d, a) { return st.y + Math.sin(fa + a) * d * rr; }
    // Topknot (behind), cheeks, eyes looking where it goes
    // Topknot: a little dark bun on top, a bit towards the back
    var kx = px(0.24, Math.PI), ky = py(0.24, Math.PI);
    ctx.fillStyle = '#2b1a12';
    ctx.beginPath();
    ctx.arc(kx, ky, rr * 0.17, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.arc(kx - rr * 0.05, ky - rr * 0.05, rr * 0.05, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,110,130,0.42)';
    ctx.beginPath();
    ctx.arc(px(0.66, 1.0), py(0.66, 1.0), rr * 0.13, 0, Math.PI * 2);
    ctx.arc(px(0.66, -1.0), py(0.66, -1.0), rr * 0.13, 0, Math.PI * 2);
    ctx.fill();
    var out = (st.flags & 2) !== 0;
    for (var e = -1; e <= 1; e += 2) {
      var ex = px(0.5, 0.45 * e), ey = py(0.5, 0.45 * e);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ex, ey, rr * 0.19, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(40,20,10,0.7)';
      ctx.stroke();
      ctx.fillStyle = '#1c120c';
      if (out) {            // dizzy: little crosses
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#1c120c';
        ctx.beginPath();
        ctx.moveTo(ex - rr * 0.08, ey - rr * 0.08); ctx.lineTo(ex + rr * 0.08, ey + rr * 0.08);
        ctx.moveTo(ex + rr * 0.08, ey - rr * 0.08); ctx.lineTo(ex - rr * 0.08, ey + rr * 0.08);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(ex + cf * rr * 0.07, ey + sf * rr * 0.07, rr * 0.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (!out) {
      var lb = labelFor(nameOfWrestler(k), color);
      ctx.drawImage(lb.c, st.x - lb.w / 2, st.y - rr - 52, lb.w, lb.h);
    }
    ctx.globalAlpha = 1;
  }

  var curRound = -1;
  var lastStatic = 0;
  function draw(t, dt) {
    if (!cv || !M) return;
    var ph = M.phase;
    updateEffects(dt);
    // Behind an opaque screen: a few frames per second are enough (letterbox only)
    if (ph === 'paused' || ph === 'end') {
      if (t - lastStatic < 250) return;
      lastStatic = t;
    }
    ensureBg();
    ensureRing();
    ensurePuff();
    var st = sample();
    var sc = devScale();
    var sx = 0, sy = 0;
    var R = st ? st.R : RING.r0;
    // One copy of the floor + ring (rebuilt only when the ring shrinks). A shake
    // just moves that copy a few pixels: the uncovered strip at the border keeps
    // the floor of the previous frame, the same dark colour.
    if (shake > 0.02) {
      sx = Math.round((Math.random() - 0.5) * 18 * shake);
      sy = Math.round((Math.random() - 0.5) * 18 * shake);
    }
    ensureArena(R);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(arena, Math.round(sx * sc), Math.round(sy * sc));
    ctx.setTransform(sc, 0, 0, sc, (pv.ox + sx * pv.scale) * pv.dpr, (pv.oy + sy * pv.scale) * pv.dpr);
    if (st) {
      curRound = st.n;
      // The one that is out goes below
      var order = (st.w[1].flags & 2) && !(st.w[0].flags & 2) ? [1, 0] : [0, 1];
      drawWrestler(order[0], st.w[order[0]], t);
      drawWrestler(order[1], st.w[order[1]], t);
      var shrinking = st.ph === 'playing' && R < RING.r0 - 0.5;
      if (shrinking !== lastShrink) { lastShrink = shrinking; show($('suShrink'), shrinking); }
    }
    if (parts.length) {
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        ctx.globalAlpha = clamp(p.life / p.max, 0, 1) * 0.85;
        ctx.drawImage(puffImg.c, p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
      ctx.globalAlpha = 1;
    }
  }

  // ---------------------------------------------------------------- DOM: score, countdown, screens
  function pips(el, n, color) {
    var is = el.children;
    for (var i = 0; i < is.length; i++) {
      var on = i < n;
      is[i].style.background = on ? color : '';
      is[i].style.borderColor = color;
    }
  }
  // Two classes with the same animation: switching restarts it without a reflow
  function restartAnim(el, variant, cls) {
    flip = !flip;
    el.className = 'suBig ' + variant + ' ' + cls + (flip ? 'A' : 'B');
  }
  function render() {
    if (!M) return;
    var c1 = colorOfWrestler(0), c2 = colorOfWrestler(1);
    var n1 = nameOfWrestler(0), n2 = nameOfWrestler(1);
    view.querySelector('.suL .suDot').style.background = c1;
    view.querySelector('.suR .suDot').style.background = c2;
    setText($('suN1'), n1); $('suN1').style.color = c1; fit($('suN1'), 44, 24);
    setText($('suN2'), n2); $('suN2').style.color = c2; fit($('suN2'), 44, 24);
    setText($('suS1'), M.score[0]); $('suS1').style.color = c1;
    setText($('suS2'), M.score[1]); $('suS2').style.color = c2;
    pips($('suP1'), M.score[0], c1);
    pips($('suP2'), M.score[1], c2);
    setText($('suRound'), M.phase === 'end' ? 'Final' : 'Ronda ' + Math.max(1, M.round));
    fit($('suRound'), 52, 30);
    // Countdown, «¡YA!», round result
    var big = '', sub = '', banner = '', bcolor = '#ffffff';
    if (M.phase === 'countdown') {
      big = String(M.countdown);
      sub = M.resumed ? 'Seguimos…' : (M.round === 1 && M.score[0] + M.score[1] === 0 ? '¡Preparados!' : 'Ronda ' + M.round);
    } else if (M.phase === 'playing') {
      big = '¡YA!';
    } else if (M.phase === 'roundover' && M.result) {
      if (M.result.w === 0) { banner = '¡Empate! Se repite la ronda'; bcolor = '#ffffff'; }
      else { banner = '¡Ronda para ' + nameOfWrestler(M.result.w - 1) + '!'; bcolor = colorOfWrestler(M.result.w - 1); }
    }
    var bk = M.phase + '|' + big;
    if (bk !== bigKey) {
      bigKey = bk;
      setText($('suBig'), big);
      if (!big) $('suBig').className = 'suBig';
      else if (M.phase === 'playing') restartAnim($('suBig'), 'suYa', 'suGo');
      else restartAnim($('suBig'), 'suNum', 'suPop');
    }
    setText($('suSub'), sub);
    show($('suSub'), !!sub);
    if (sub) fit($('suSub'), 44, 26);
    var nk = banner + bcolor;
    if (nk !== bannerKey) {
      bannerKey = nk;
      setText($('suBanner'), banner);
      $('suBanner').style.color = bcolor;
      show($('suBanner'), !!banner);
      if (banner) fit($('suBanner'), 64, 32);
    }
    // Pause
    show($('suPause'), M.phase === 'paused');
    if (M.phase === 'paused') {
      var waiting = M.waiting && M.waiting.length ? G2T.joinNames(M.waiting) : 'alguien';
      setText($('suPauseWho'), 'Esperando a ' + waiting + '…');
      fit($('suPauseWho'), 96, 40);
      var hp = (host.hub() && host.hub().players) || [];
      var hold = 0;
      (M.slots || []).forEach(function (s) { var p = hp[s - 1]; if (p && !p.connected) hold = Math.max(hold, p.holdLeft || 0); });
      setText($('suPauseHold'), hold ? 'Reconexión: ' + hold + ' s' : '');
    }
    // The end
    show($('suEnd'), M.phase === 'end');
    if (M.phase === 'end') renderEnd();
  }
  function renderEnd() {
    var w = M.winner || 1;
    var col = colorOfWrestler(w - 1);
    setText($('suEndT'), '¡Gana ' + nameOfWrestler(w - 1) + '!');
    $('suEndT').style.color = col;
    fit($('suEndT'), 120, 48);
    $('suEndBall').style.background = col;
    setText($('suEndS'), M.score[0] + ' – ' + M.score[1]);
    setText($('suEndN1'), nameOfWrestler(0)); $('suEndN1').style.color = colorOfWrestler(0);
    setText($('suEndN2'), nameOfWrestler(1)); $('suEndN2').style.color = colorOfWrestler(1);
    fit($('suEndN1'), 48, 24);
    fit($('suEndN2'), 48, 24);
    renderFocus();
  }
  function renderFocus() {
    var b = [$('suAgain'), $('suMenu')];
    for (var i = 0; i < 2; i++) { if (i === focusIndex) b[i].classList.add('focus'); else b[i].classList.remove('focus'); }
  }

  function onMeta(m) {
    var prev = M;
    M = m;
    if (!prev || prev.match !== m.match) { focusIndex = 0; bigKey = ''; bannerKey = ''; }
    if (m.phase === 'countdown' && m.countdown !== lastCountdown) host.sfx.tick();
    lastCountdown = m.phase === 'countdown' ? m.countdown : 0;
    if (prev && prev.phase === 'playing' && m.phase === 'roundover' && m.result) {
      if (m.result.w) host.sfx.correct(); else host.sfx.wrong();
    }
    render();
  }

  G2T.tv.register({
    id: 'sumo',
    mount: function (h) {
      host = h;
      show = h.show;
      setText = h.setText;
      fit = h.fit;
      cv = document.createElement('canvas');
      cv.id = 'suCanvas';
      cv.style.cssText = 'position:absolute;left:0;top:0;display:none;z-index:0;';
      h.addLayer(cv);
      ctx = cv.getContext('2d', { alpha: false }) || cv.getContext('2d');
      view = document.createElement('section');
      view.id = 'vSumo';
      view.className = 'view';
      view.innerHTML = HTML;
      h.addView(view);
    },
    layout: function (w, h) { resize(w, h); },
    onConnect: function () { buf = []; clockOffset = null; },
    enter: function () { cv.style.display = 'block'; show(view, true); },
    leave: function () {
      cv.style.display = 'none';
      show(view, false);
      M = null; buf = []; parts = []; pendingHits = []; shake = 0;
      bigKey = ''; bannerKey = ''; lastCountdown = 0; lastShrink = false;
      show($('suShrink'), false);
    },
    onHub: function () { render(); },
    onMessage: function (msg) {
      if (msg.t === 'smeta') onMeta(msg);
      else if (msg.t === 's') onState(msg);
    },
    onEvent: function (ev) {
      switch (ev.k) {
        case 'hit': pendingHits.push({ ts: ev.ts || 0, got: now(), x: ev.x, y: ev.y, p: ev.p || 0, big: !!ev.big }); break;
        case 'dash': beep(260, 0.2, 'sawtooth', 0.06, 760); break;
        case 'out': beep(420, 0.5, 'triangle', 0.13, 110); break;
        case 'go': host.sfx.go(); break;
        case 'win': setTimeout(host.sfx.win, 300); host.confetti(); break;
      }
    },
    onKey: function (e, dir, ok) {
      if (!M || M.phase !== 'end') return false;
      if (dir) { focusIndex = clamp(focusIndex + dir, 0, 1); renderFocus(); host.sfx.move(); return true; }
      if (ok) { host.send(focusIndex === 0 ? { t: 's.again' } : { t: 'menu' }); return true; }
      return false;
    },
    frame: function (t, dt) { draw(t, dt); },
    debugInfo: function () { return cv ? cv.width + 'x' + cv.height : ''; },
    // For automated tests
    state: function () {
      var s = sample();
      return { meta: M, states: buf.length, sample: s, canvas: cv ? [cv.width, cv.height] : null, parts: parts.length, shake: shake };
    }
  });
})();
