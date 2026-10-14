/*
 * «Tanques»: TV view. Loaded by public/tv.html (ES2019).
 *
 * - One canvas layer (like Pong) for the arena, capped with host.capDpr()
 *   (1280 px wide on webOS). The floor, the grid and the bevelled walls are
 *   drawn ONCE per arena into an offscreen canvas; each frame copies it.
 * - Tanks are sprites pre-rendered per colour (and per scale), drawn rotated.
 *   Bullets: a halo, a white dot and a short trail (one path per colour).
 *   Explosions: a few square particles and a ring. No shadowBlur, no filters.
 * - The server sends the state at 30 Hz; the view draws it 50 ms late and
 *   interpolates (positions, angles, bullets by id). Events (shots, bounces,
 *   explosions) play when the drawn time reaches them.
 * - Score bar, 3-2-1, round result, «Pausa» and the winner screen are DOM
 *   (they change a few times per round).
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var $ = G2T.$, now = G2T.now, clamp = G2T.clamp, lerp = G2T.lerp;
  var host = null, view = null, show, setText, fit;
  var beep = G2T.sound.beep;

  var LW = 1920, LH = 1080, TOP = 120;
  var INTERP_MS = 50;
  var INFO = { w: 1920, h: 960, tankR: 22, bulletR: 5, layouts: [] };

  var HTML =
    '<div class="kHud">' +
    '  <div class="kSide kL"><div class="kWho"><div class="kName fit" id="kN1">—</div><div class="kPips" id="kPips1"></div></div><div class="kPts" id="kP1">0</div></div>' +
    '  <div class="kMid"><div class="kTitle">TANQUES</div><div class="kSub fit" id="kSub">A 5 puntos</div></div>' +
    '  <div class="kSide kR"><div class="kPts" id="kP2">0</div><div class="kWho"><div class="kName fit" id="kN2">—</div><div class="kPips" id="kPips2"></div></div></div>' +
    '</div>' +
    '<div class="kCount" id="kCount"><b id="kCountN">3</b><p class="fit" id="kCountS">¡Preparados!</p></div>' +
    '<div class="kBanner" id="kBanner"><b class="fit" id="kBanT"></b><small class="fit" id="kBanS"></small></div>' +
    '<div class="ov ovbg center" id="kPause">' +
    '  <p class="big2">Pausa</p>' +
    '  <div class="huge fit" id="kPauseWho" style="font-size:96px">Esperando…</div>' +
    '  <p class="sub fit" id="kPauseSub">Volved a abrir la página en el móvil para seguir</p>' +
    '</div>' +
    '<div class="ov" id="kEnd">' +
    '  <p class="kEndK">¡FIN DEL DUELO!</p>' +
    '  <div class="kEndT fit" id="kEndT">—</div>' +
    '  <div class="kEndS"><span class="kEndN fit" id="kEndN1"></span><b id="kEndScore">0 – 0</b><span class="kEndN fit" id="kEndN2"></span></div>' +
    '  <div class="kEndBtns">' +
    '    <div class="btn" id="kAgain">Otra</div>' +
    '    <div class="btn" id="kMenu">Menú</div>' +
    '    <small>o elegidlo en el móvil</small>' +
    '  </div>' +
    '</div>';

  var cv, ctx;
  var pv = { scale: 1, ox: 0, oy: 0, dpr: 1 };
  var M = null;                    // last kmeta
  var buf = [];                    // last states (k.s)
  var clockOffset = null;
  var pending = [];                // events waiting for the drawn time: { ts, e }
  var bg = null, bgKey = '';
  var sprites = {};
  var trails = {};                 // bullet id -> [x, y, x, y, …]
  var parts = [], rings = [];
  var lastStill = 0, goUntil = 0, popFlip = false, lastCount = -1;
  var focusIndex = 0;
  var lastBounceSfx = 0;
  var lastSig = '', hadFx = false;
  var drawn = { tanks: [], bullets: 0, frames: 0 };

  function colorOf(slot) { return host.colors()[slot - 1] || '#ffffff'; }
  function nameOf(slot) { return host.playerName(slot - 1); }
  function tankSlot(k) { return M && M.tanks[k] ? M.tanks[k] : k + 1; }

  // ---------------------------------------------------------------- canvas size
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
    bg = null;
    sprites = {};
    lastStill = 0;
    lastSig = '';
  }

  // ---------------------------------------------------------------- static layer
  function bevelBox(g, w) {
    var x0 = w.x0, y0 = w.y0 + TOP, x1 = w.x1, y1 = w.y1 + TOP;
    var b = Math.min(6, Math.min(x1 - x0, y1 - y0) / 4);
    g.fillStyle = '#323a72';
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    g.fillStyle = '#6170c2';               // light from the top left
    g.beginPath();
    g.moveTo(x0, y0); g.lineTo(x1, y0); g.lineTo(x1 - b, y0 + b); g.lineTo(x0 + b, y0 + b); g.lineTo(x0 + b, y1 - b); g.lineTo(x0, y1);
    g.closePath();
    g.fill();
    g.fillStyle = '#151933';
    g.beginPath();
    g.moveTo(x1, y1); g.lineTo(x0, y1); g.lineTo(x0 + b, y1 - b); g.lineTo(x1 - b, y1 - b); g.lineTo(x1 - b, y0 + b); g.lineTo(x1, y0);
    g.closePath();
    g.fill();
    g.fillStyle = '#414b8e';
    g.fillRect(x0 + b, y0 + b, x1 - x0 - 2 * b, y1 - y0 - 2 * b);
  }
  function ensureBg() {
    var li = M ? M.layout : 0;
    var key = cv.width + 'x' + cv.height + '|' + li;
    if (bg && key === bgKey) return;
    bgKey = key;
    var c = document.createElement('canvas');
    c.width = cv.width;
    c.height = cv.height;
    var g = c.getContext('2d');
    g.fillStyle = '#05060f';
    g.fillRect(0, 0, c.width, c.height);
    var sc = pv.scale * pv.dpr;
    g.setTransform(sc, 0, 0, sc, pv.ox * pv.dpr, pv.oy * pv.dpr);
    g.fillStyle = '#0a0c1f';
    g.fillRect(0, 0, LW, TOP);
    var grad = g.createRadialGradient(LW / 2, TOP + INFO.h / 2, 120, LW / 2, TOP + INFO.h / 2, LW * 0.62);
    grad.addColorStop(0, '#141a38');
    grad.addColorStop(1, '#0a0d1e');
    g.fillStyle = grad;
    g.fillRect(0, TOP, INFO.w, INFO.h);
    g.strokeStyle = 'rgba(130,150,255,0.06)';
    g.lineWidth = 2;
    g.beginPath();
    for (var x = 80; x < INFO.w; x += 80) { g.moveTo(x, TOP); g.lineTo(x, TOP + INFO.h); }
    for (var y = 80; y < INFO.h; y += 80) { g.moveTo(0, TOP + y); g.lineTo(INFO.w, TOP + y); }
    g.stroke();
    var lay = INFO.layouts[li] || { walls: [] };
    // Shadows on the floor first, then the blocks
    g.fillStyle = 'rgba(0,0,0,0.38)';
    lay.walls.forEach(function (w) { g.fillRect(w.x0 + 7, w.y0 + TOP + 7, w.x1 - w.x0, w.y1 - w.y0); });
    lay.walls.forEach(function (w) { bevelBox(g, w); });
    g.fillStyle = '#2f3870';
    g.fillRect(0, TOP, INFO.w, 4);
    g.fillRect(0, TOP + INFO.h - 4, INFO.w, 4);
    g.fillRect(0, TOP, 4, INFO.h);
    g.fillRect(INFO.w - 4, TOP, 4, INFO.h);
    bg = c;
  }

  // ---------------------------------------------------------------- sprites
  function rr(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }
  function mix(hex, k) {             // k > 0 towards white, k < 0 towards black
    var n = parseInt(hex.slice(1), 16);
    var c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) { return Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k)); });
    return 'rgb(' + c.join(',') + ')';
  }
  // Sprites are drawn for a tank of radius 22 and scaled to the real one
  function spriteK() { return (INFO.tankR || 22) / 22; }
  // A tank facing right, 64x64 units around its centre
  function sprite(color, wreck) {
    var sc = pv.scale * pv.dpr;
    var key = color + (wreck ? 'w' : '') + '|' + sc.toFixed(3);
    if (sprites[key]) return sprites[key];
    var px = Math.max(8, Math.ceil(64 * sc * spriteK()));
    var c = document.createElement('canvas');
    c.width = px;
    c.height = px;
    var g = c.getContext('2d');
    g.setTransform(px / 64, 0, 0, px / 64, px / 2, px / 2);
    var body = wreck ? '#3b4058' : color;
    g.fillStyle = wreck ? '#1a1c26' : '#161a2c';
    rr(g, -25, -23, 50, 11, 4); g.fill();
    rr(g, -25, 12, 50, 11, 4); g.fill();
    g.fillStyle = wreck ? '#2a2d3a' : '#2e3456';
    for (var x = -21; x < 24; x += 7) { g.fillRect(x, -22, 3, 9); g.fillRect(x, 13, 3, 9); }
    rr(g, -19, -15, 38, 30, 7);
    g.fillStyle = body;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = wreck ? '#22252f' : mix(color, -0.55);
    g.stroke();
    g.fillStyle = 'rgba(0,0,0,0.16)';
    rr(g, -13, -9, 22, 18, 4); g.fill();
    if (!wreck) {
      g.fillStyle = color;
      g.fillRect(3, -4.5, 29, 9);
      g.strokeRect(3, -4.5, 29, 9);
      g.fillStyle = mix(color, 0.5);
      g.fillRect(27, -4.5, 5, 9);
    } else {
      g.fillStyle = '#2b2f40';
      g.fillRect(3, -4, 15, 8);
    }
    g.beginPath();
    g.arc(0, 0, 10.5, 0, Math.PI * 2);
    g.fillStyle = wreck ? '#4a4f68' : mix(color, 0.38);
    g.fill();
    g.stroke();
    sprites[key] = c;
    return c;
  }

  // ---------------------------------------------------------------- state and interpolation
  function onState(s) {
    var o = s.ts - now();
    if (clockOffset === null || o > clockOffset) clockOffset = o;
    else clockOffset += (o - clockOffset) * 0.02;
    s.bm = {};
    for (var i = 0; i < s.b.length; i += 6) s.bm[s.b[i]] = i;
    buf.push(s);
    if (buf.length > 20) buf.shift();
    if (s.e && s.e.length) pending.push({ ts: s.ts, e: s.e });
    host.debug.states++;
  }
  function angLerp(a, b, k) {
    var d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * k;
  }
  // { tanks: [[x, y, a, alive]], bullets: [[x, y, slot, id]] } at the drawn time
  function sample(rt) {
    if (!buf.length) return null;
    var a = buf[0], b = buf[0], k = 0;
    if (rt >= buf[buf.length - 1].ts) { a = b = buf[buf.length - 1]; }
    else if (rt > buf[0].ts) {
      for (var i = buf.length - 2; i >= 0; i--) {
        if (buf[i].ts <= rt) { a = buf[i]; b = buf[i + 1]; k = clamp((rt - a.ts) / ((b.ts - a.ts) || 1), 0, 1); break; }
      }
    }
    var out = { tanks: [], bullets: [], ph: b.ph };
    for (var t = 0; t + 3 < b.k.length; t += 4) {
      var ax = a.k.length > t ? a.k : b.k;
      out.tanks.push([lerp(ax[t], b.k[t], k), lerp(ax[t + 1], b.k[t + 1], k), angLerp(ax[t + 2], b.k[t + 2], k), k < 0.5 && a.k.length > t ? ax[t + 3] : b.k[t + 3]]);
    }
    for (var j = 0; j < b.b.length; j += 6) {
      var id = b.b[j], ia = a.bm[id];
      if (ia !== undefined && a !== b) out.bullets.push([lerp(a.b[ia + 1], b.b[j + 1], k), lerp(a.b[ia + 2], b.b[j + 2], k), b.b[j + 5], id]);
      else out.bullets.push([b.b[j + 1], b.b[j + 2], b.b[j + 5], id]);
    }
    return out;
  }

  // ---------------------------------------------------------------- effects
  var sfx = {
    fire: function () { beep(320, 0.09, 'square', 0.07, 150); },
    bounce: function () { var t = now(); if (t - lastBounceSfx < 70) return; lastBounceSfx = t; beep(1100, 0.03, 'triangle', 0.045); },
    boom: function () { beep(150, 0.5, 'sawtooth', 0.14, 40); beep(80, 0.55, 'square', 0.08, 30, 0.03); },
    fizz: function () { beep(500, 0.05, 'triangle', 0.03, 250); }
  };
  function burst(x, y, colors, n, speed, life, size) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = speed * (0.3 + Math.random() * 0.7);
      parts.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: life * (0.6 + Math.random() * 0.4), max: life, c: colors[i % colors.length], s: size * (0.6 + Math.random() * 0.6) });
    }
    if (parts.length > 160) parts.splice(0, parts.length - 160);
  }
  function playEvent(e) {
    var type = e[0], x = e[1], y = e[2], col = colorOf(e[3]);
    if (type === 'f') { sfx.fire(); burst(x, y, ['#ffffff', col], 4, 140, 0.18, 5); }
    else if (type === 'b') { sfx.bounce(); burst(x, y, ['#ffffff'], 2, 120, 0.15, 4); }
    else if (type === 'p') { sfx.fizz(); burst(x, y, ['#ffffff', col], 5, 110, 0.3, 4); }
    else if (type === 'x') {
      sfx.boom();
      burst(x, y, [col, '#ffd23e', '#ff8a3d', '#ffffff'], host.FX ? 40 : 24, 420, 0.9, 9);
      rings.push({ x: x, y: y, t: 0, c: col });
    }
  }
  function runEvents(rt) {
    while (pending.length && pending[0].ts <= rt) {
      var p = pending.shift();
      for (var i = 0; i < p.e.length; i++) playEvent(p.e[i]);
    }
    if (pending.length > 30) pending.splice(0, pending.length - 30);
  }
  function stepFx(dt) {
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.93; p.vy *= 0.93;
      p.life -= dt;
      if (p.life <= 0) parts.splice(i, 1);
    }
    for (var j = rings.length - 1; j >= 0; j--) { rings[j].t += dt; if (rings[j].t > 0.45) rings.splice(j, 1); }
  }

  // ---------------------------------------------------------------- drawing
  function drawArena(t, dt) {
    var still = !M || M.paused || M.phase === 'end';
    if (still) {                           // behind an overlay: ~10 frames/s are enough
      if (t - lastStill < 100) return;
      lastStill = t;
    }
    stepFx(still ? 0.1 : dt);
    ensureBg();
    var rt = now() + (clockOffset || 0) - INTERP_MS;
    if (M && !still) runEvents(rt);
    var st = M ? sample(rt) : null;
    // Nothing moves (tanks parked, no bullets, no effects): keep the last frame
    var sig = bgKey + '|' + (st ? st.tanks.map(function (x) { return x.map(function (v) { return Math.round(v * 100); }).join(','); }).join(';') + '|' + st.bullets.length : '-');
    var fx = parts.length > 0 || rings.length > 0;
    if (sig === lastSig && !fx && !hadFx && !(st && st.bullets.length)) return;
    lastSig = sig;
    hadFx = fx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bg, 0, 0);
    if (!st) return;
    var sc = pv.scale * pv.dpr;
    ctx.setTransform(sc, 0, 0, sc, pv.ox * pv.dpr, (pv.oy + TOP * pv.scale) * pv.dpr);
    drawn.frames++;
    // Wrecks under everything, live tanks over the bullets' trails
    var k, tk;
    for (k = 0; k < st.tanks.length; k++) {
      tk = st.tanks[k];
      if (tk[3]) continue;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath(); ctx.arc(tk[0], tk[1], 34 * spriteK(), 0, Math.PI * 2); ctx.fill();
      drawTank(tk, colorOf(tankSlot(k)), true);
    }
    drawBullets(st.bullets);
    for (k = 0; k < st.tanks.length; k++) { tk = st.tanks[k]; if (tk[3]) drawTank(tk, colorOf(tankSlot(k)), false); }
    drawFx();
    drawn.tanks = st.tanks;
    drawn.bullets = st.bullets.length;
  }
  function drawTank(tk, color, wreck) {
    var c = ctx;
    var cs = Math.cos(tk[2]), sn = Math.sin(tk[2]);
    var sc = pv.scale * pv.dpr;
    c.setTransform(sc * cs, sc * sn, -sc * sn, sc * cs, pv.ox * pv.dpr + tk[0] * sc, (pv.oy + TOP * pv.scale) * pv.dpr + tk[1] * sc);
    var k = spriteK();
    c.drawImage(sprite(color, wreck), -32 * k, -32 * k, 64 * k, 64 * k);
    c.setTransform(sc, 0, 0, sc, pv.ox * pv.dpr, (pv.oy + TOP * pv.scale) * pv.dpr);
  }
  function drawBullets(list) {
    var seen = {}, i, b, byColor = {};
    for (i = 0; i < list.length; i++) {
      b = list[i];
      seen[b[3]] = true;
      var tr = trails[b[3]] || (trails[b[3]] = []);
      tr.push(b[0], b[1]);
      if (tr.length > 12) tr.splice(0, tr.length - 12);
      (byColor[b[2]] || (byColor[b[2]] = [])).push(b);
    }
    Object.keys(trails).forEach(function (id) { if (!seen[id]) delete trails[id]; });
    var r = INFO.bulletR;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    Object.keys(byColor).forEach(function (slot) {
      var col = colorOf(+slot), arr = byColor[slot], j, p;
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = col;
      ctx.lineWidth = r * 1.4;
      ctx.beginPath();
      for (j = 0; j < arr.length; j++) {
        p = trails[arr[j][3]];
        if (p.length < 4) continue;
        ctx.moveTo(p[0], p[1]);
        for (var q = 2; q < p.length; q += 2) ctx.lineTo(p[q], p[q + 1]);
      }
      ctx.stroke();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = col;
      ctx.beginPath();
      for (j = 0; j < arr.length; j++) { ctx.moveTo(arr[j][0] + r * 2, arr[j][1]); ctx.arc(arr[j][0], arr[j][1], r * 2, 0, Math.PI * 2); }
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    for (i = 0; i < list.length; i++) { b = list[i]; ctx.moveTo(b[0] + r, b[1]); ctx.arc(b[0], b[1], r, 0, Math.PI * 2); }
    ctx.fill();
  }
  function drawFx() {
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
      ctx.fillStyle = p.c;
      ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
    }
    for (var j = 0; j < rings.length; j++) {
      var g = rings[j], k = g.t / 0.45;
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = g.c;
      ctx.lineWidth = 8 * (1 - k) + 2;
      ctx.beginPath();
      ctx.arc(g.x, g.y, 14 + 70 * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- DOM
  function pipsHtml(n, total, color) {
    var h = '';
    for (var i = 0; i < total; i++) h += '<i style="border-color:' + color + (i < n ? ';background:' + color : '') + '"></i>';
    return h;
  }
  function renderHud() {
    for (var k = 0; k < 2; k++) {
      var slot = tankSlot(k), col = colorOf(slot), n = $('kN' + (k + 1));
      setText(n, nameOf(slot));
      n.style.color = col;
      fit(n, 52, 26);
      var p = $('kP' + (k + 1));
      var sc = String(M.scores[k] || 0);
      if (p.textContent !== sc) {
        setText(p, sc);
        p.classList.remove(popFlip ? 'kPopB' : 'kPopA');
        p.classList.add(popFlip ? 'kPopA' : 'kPopB');
      }
      p.style.color = col;
      var ph = pipsHtml(M.scores[k] || 0, M.toWin, col);
      if ($('kPips' + (k + 1)).innerHTML !== ph) $('kPips' + (k + 1)).innerHTML = ph;
    }
    setText($('kSub'), 'Ronda ' + M.round + ' · a ' + M.toWin);
    fit($('kSub'), 30, 20);
  }
  function renderCount() {
    var on = M.phase === 'countdown' && !M.paused;
    var go = !on && now() < goUntil;
    var box = $('kCount');
    if (on || go) box.classList.add('on'); else box.classList.remove('on');
    if (on) {
      setText($('kCountS'), M.resumed ? 'Seguimos…' : (M.round === 1 ? '¡Preparados!' : 'Ronda ' + M.round) + ' · mapa «' + M.layoutName + '»');
      fit($('kCountS'), 44, 24);
      if (M.count !== lastCount) {
        lastCount = M.count;
        setText($('kCountN'), String(M.count));
        popFlip = !popFlip;
        $('kCountN').className = popFlip ? 'kPopA' : 'kPopB';
        host.sfx.tick();
      }
    } else if (go) {
      setText($('kCountN'), '¡YA!');
      $('kCountN').className = 'go';
      setText($('kCountS'), '');
    }
    if (!on) lastCount = -1;
  }
  function renderBanner() {
    var on = M.phase === 'over' && !!M.last && !M.paused;
    show($('kBanner'), on);
    if (!on) return;
    var w = M.last.winner;
    var t = $('kBanT'), s = $('kBanS');
    if (w) {
      var loser = M.tanks[0] === w ? M.tanks[1] : M.tanks[0];
      setText(t, '¡Punto para ' + nameOf(w) + '!');
      t.style.color = colorOf(w);
      setText(s, M.last.self ? nameOf(loser) + ' se ha dado con su propia bala' : M.scores[0] + ' – ' + M.scores[1]);
    } else {
      setText(t, '¡Empate!');
      t.style.color = '#ffffff';
      setText(s, 'Los dos a la vez: nadie puntúa');
    }
    fit(t, 64, 30);
    fit(s, 34, 20);
  }
  function renderPause() {
    var on = !!M.paused;
    show($('kPause'), on);
    if (!on) return;
    var hub = host.hub() || {};
    var who = M.waiting.length ? M.waiting : ['alguien'];
    setText($('kPauseWho'), 'Esperando a ' + G2T.joinNames(who) + '…');
    fit($('kPauseWho'), 96, 40);
    var hold = 0;
    (hub.players || []).forEach(function (p) { if (p && !p.connected && M.waiting.indexOf(p.name) >= 0) hold = Math.max(hold, p.holdLeft || 0); });
    setText($('kPauseSub'), (hold ? 'Le guardamos el sitio ' + hold + ' s · ' : '') + 'Vuelve a abrir la página en el móvil para seguir');
    fit($('kPauseSub'), 40, 22);
  }
  function renderFocus() {
    var b = [$('kAgain'), $('kMenu')];
    for (var i = 0; i < 2; i++) { if (i === focusIndex) b[i].classList.add('focus'); else b[i].classList.remove('focus'); }
  }
  function renderEnd() {
    var on = M.phase === 'end';
    show($('kEnd'), on);
    if (!on) return;
    var w = M.winner;
    setText($('kEndT'), '¡Gana ' + nameOf(w) + '!');
    $('kEndT').style.color = colorOf(w);
    fit($('kEndT'), 130, 50);
    setText($('kEndScore'), M.scores[0] + ' – ' + M.scores[1]);
    for (var k = 0; k < 2; k++) {
      var n = $('kEndN' + (k + 1));
      setText(n, nameOf(tankSlot(k)));
      n.style.color = colorOf(tankSlot(k));
      fit(n, 56, 26);
    }
    renderFocus();
  }
  function render() {
    if (!M) return;
    renderHud();
    renderCount();
    renderBanner();
    renderPause();
    renderEnd();
  }

  function onMeta(m) {
    var prev = M;
    M = m;
    if (!prev || prev.match !== m.match) { focusIndex = 0; buf = []; pending = []; trails = {}; }
    if (prev && prev.round !== m.round) { buf = []; pending = []; trails = {}; parts = []; rings = []; }
    if (prev && prev.phase === 'countdown' && m.phase === 'play') { goUntil = now() + 700; host.sfx.go(); }
    if (prev && !prev.last && m.last && m.last.winner) beep(660, 0.12, 'triangle', 0.12, null, 0.05);
    if (prev && prev.phase !== 'end' && m.phase === 'end') { setTimeout(host.sfx.win, 200); host.confetti(); }
    render();
  }

  G2T.tv.register({
    id: 'tanques',
    mount: function (h, game) {
      host = h;
      show = h.show;
      setText = h.setText;
      fit = h.fit;
      if (game && game.tv && game.tv.layouts) INFO = game.tv;
      cv = document.createElement('canvas');
      cv.id = 'kCanvas';
      cv.style.cssText = 'position:absolute;left:0;top:0;display:none;z-index:0;';
      h.addLayer(cv);
      ctx = cv.getContext('2d', { alpha: false }) || cv.getContext('2d');
      view = document.createElement('section');
      view.id = 'vTanques';
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
      M = null; buf = []; pending = []; trails = {}; parts = []; rings = []; bg = null; lastCount = -1; lastSig = '';
    },
    onHub: function () { render(); },
    onMessage: function (msg) {
      if (msg.t === 'kmeta') onMeta(msg);
      else if (msg.t === 'k.s') onState(msg);
    },
    onKey: function (e, dir, ok) {
      if (!M || M.phase !== 'end') return false;
      if (dir) { focusIndex = clamp(focusIndex + dir, 0, 1); renderFocus(); host.sfx.move(); return true; }
      if (ok) { host.send(focusIndex === 0 ? { t: 'k.again' } : { t: 'menu' }); return true; }
      return false;
    },
    frame: function (t, dt) {
      drawArena(t, dt);
      if (M && goUntil && t >= goUntil) { goUntil = 0; renderCount(); }
    },
    debugInfo: function () { return cv.width + 'x' + cv.height; },
    canvas: function () { return cv; },
    // For automated tests
    state: function () { return { meta: M, states: buf.length, drawn: drawn, canvas: [cv.width, cv.height] }; }
  });
})();
