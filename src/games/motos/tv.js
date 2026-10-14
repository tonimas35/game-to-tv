/*
 * «Motos de neón»: TV view. Loaded by public/tv.html (ES2019).
 *
 * Cheap on purpose (LG webOS, Fire TV):
 * - One full-window canvas, backing store capped with host.capDpr() (1280 px
 *   wide on webOS).
 * - The dark arena and its subtle grid are drawn ONCE into an offscreen
 *   canvas (bg).
 * - The trails live in a second offscreen canvas (bg + trails). Each server
 *   step only ADDS the new segments to it; the whole set of trails is drawn
 *   again only on a snapshot (new round, a TV that reconnects) or a resize.
 *   Every frame: one drawImage of that canvas + the two heads + particles.
 * - Glow without shadowBlur: a low-alpha cell-wide band under the bright line.
 * - The heads are extrapolated along their direction (at most one cell)
 *   between the server steps, so they glide at 60 FPS.
 * - The score at the top is part of the static layer (redrawn only when it
 *   changes, once per round at most). The countdown and the round messages
 *   are canvas text, like Pong: no DOM over the canvas while playing (DOM
 *   layers over a canvas cost compositing time on the TV).
 * - Pause and the end screen are opaque DOM overlays; the canvas stops then.
 *
 * The trail model (TrailModel) is also used by test/motos.test.js, which runs
 * this file in a sandbox to check that a TV rebuilds the same grid.
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var now = G2T.now, clamp = G2T.clamp, hexA = G2T.hexA;
  var beep = G2T.sound.beep;

  var LW = 1920, LH = 1080;
  var GW = 64, GH = 36, CELL = 26;
  var AX = (LW - GW * CELL) / 2, AY = 116;     // arena in the 1920x1080 stage: 1664 x 936
  var DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
  var LINE = CELL * 0.38, CORE = CELL * 0.12;
  var DEFAULT_COLORS = ['#22e6ff', '#ff3df2'];
  var CAUSE = {
    muro: 'contra el muro',
    propia: 'contra su propia estela',
    rival: 'contra la estela de ',
    frontal: 'de frente'
  };

  // ---------------------------------------------------------------- trail model
  function expandPath(points, w) {
    var out = [];
    for (var i = 0; i < points.length; i++) {
      var c = points[i];
      if (i === 0) { out.push(c); continue; }
      var p = points[i - 1];
      var x = p % w, y = Math.floor(p / w);
      var tx = c % w, ty = Math.floor(c / w);
      var sx = tx > x ? 1 : (tx < x ? -1 : 0), sy = ty > y ? 1 : (ty < y ? -1 : 0);
      var guard = 0;
      while ((x !== tx || y !== ty) && guard < 10000) {
        x += sx;
        y += sy;
        out.push(y * w + x);
        guard++;
      }
    }
    return out;
  }
  function dirBetween(a, b, w) {
    var d = b - a;
    return d === 1 ? 1 : (d === -1 ? 3 : (d === w ? 2 : 0));
  }
  // The grid as the TV knows it: from one msnap and then only the new heads (mt)
  function TrailModel() {
    var m = { r: -1, k: -1, w: GW, h: GH, grid: null, paths: [[], []], dirs: [1, 3], alive: [true, true], pend: [], cps: 12, stepAt: 0, full: true };
    m.snap = function (s) {
      m.r = s.r;
      m.k = s.k;
      m.w = s.w;
      m.h = s.h;
      m.grid = new Uint8Array(s.w * s.h);
      m.paths = [[], []];
      for (var side = 0; side < 2; side++) {
        var pts = (s.tr && s.tr[side]) || [];
        var cells = expandPath(pts, s.w);
        for (var i = 0; i < cells.length; i++) { m.grid[cells[i]] = side + 1; m.paths[side].push(cells[i]); }
        if (s.dr) m.dirs[side] = s.dr[side];
        else if (cells.length >= 2) m.dirs[side] = dirBetween(cells[cells.length - 2], cells[cells.length - 1], s.w);
      }
      m.alive = [!(s.al && s.al[0] === 0), !(s.al && s.al[1] === 0)];
      m.pend = [];
      m.full = true;
      m.stepAt = now();
    };
    // Returns false when this message does not follow what we have (a full state is needed)
    m.tick = function (t) {
      if (!m.grid || t.r !== m.r || t.k !== m.k + 1) return false;
      var h = t.h || [];
      var n = h.length >> 1;
      for (var i = 0; i < n; i++) {
        for (var s = 0; s < 2; s++) {
          var c = h[i * 2 + s];
          if (c < 0) continue;
          var p = m.paths[s];
          var prev = p.length ? p[p.length - 1] : -1;
          m.grid[c] = s + 1;
          p.push(c);
          m.pend.push(s, prev, c);
          if (prev >= 0) m.dirs[s] = dirBetween(prev, c, m.w);
        }
      }
      m.k = t.k + n - 1;
      if (t.s) m.cps = t.s;
      m.stepAt = now();
      return true;
    };
    m.gridString = function () {
      if (!m.grid) return '';
      var out = [];
      for (var i = 0; i < m.grid.length; i++) out.push(m.grid[i]);
      return out.join('');
    };
    return m;
  }
  G2T.motosTrailModel = TrailModel;

  // ---------------------------------------------------------------- view state
  var host = null, view = null, show, setText, fit;
  var cv = null, ctx = null, trailCv = null, tctx = null, bgCv = null, bgKey = '';
  var pv = { scale: 1, ox: 0, oy: 0, dpr: 1 };
  var model = TrailModel();
  var M = null;
  var lastSyncAsk = -10000;
  var particles = [], rings = [];
  var lastCountdown = 0, countAt = 0, goAt = -10000, endFocus = 0;
  var staticDrawn = false;
  var stats = { full: 0, segs: 0, frames: 0 };

  function $(id) { return document.getElementById(id); }
  function colorOfSide(side) {
    var slot = M && M.players ? M.players[side - 1] : side;
    var c = host ? host.colors()[slot - 1] : null;
    return c || DEFAULT_COLORS[side - 1];
  }
  function nameOfSide(side) {
    var slot = M && M.players ? M.players[side - 1] : side;
    return host ? host.playerName(slot - 1) : ('Jugador ' + side);
  }
  // The colour mixed with white: the bright core of the line
  var coreCache = {};
  function coreOf(hex) {
    if (coreCache[hex]) return coreCache[hex];
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    coreCache[hex] = 'rgb(' + Math.round(r + (255 - r) * 0.6) + ',' + Math.round(g + (255 - g) * 0.6) + ',' + Math.round(b + (255 - b) * 0.6) + ')';
    return coreCache[hex];
  }
  function cx(cell) { return AX + (cell % GW + 0.5) * CELL; }
  function cy(cell) { return AY + (Math.floor(cell / GW) + 0.5) * CELL; }
  var FONT = "'LG Smart UI', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
  function setFont(c, size, weight) { c.font = (weight || 'bold') + ' ' + size + 'px ' + FONT; }
  // The biggest size (down to min) at which the text fits maxW; then cut with «…»
  function fitText(c, str, maxW, size, min, weight) {
    setFont(c, size, weight);
    while (size > min && c.measureText(str).width > maxW) { size -= 2; setFont(c, size, weight); }
    var out = str;
    while (out.length > 1 && c.measureText(out).width > maxW) out = out.slice(0, -2) + '…';
    return out;
  }
  function text(c, str, x, y, color, align) {
    c.fillStyle = color;
    c.textAlign = align || 'center';
    c.textBaseline = 'middle';
    c.fillText(str, x, y);
  }
  function roundRect(c, x, y, w, h, r) {
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
  function askSync() {
    var t = now();
    if (!host || t - lastSyncAsk < 500) return;
    lastSyncAsk = t;
    host.send({ t: 'm.sync' });
  }

  // ---------------------------------------------------------------- canvas
  function stageTransform(c) {
    var sc = pv.scale * pv.dpr;
    c.setTransform(sc, 0, 0, sc, pv.ox * pv.dpr, pv.oy * pv.dpr);
  }
  function resize(w, h) {
    var d = host.capDpr(w);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    cv.width = Math.round(w * d);
    cv.height = Math.round(h * d);
    trailCv.width = cv.width;
    trailCv.height = cv.height;
    pv.dpr = d;
    pv.scale = Math.min(w / LW, h / LH);
    pv.ox = (w - LW * pv.scale) / 2;
    pv.oy = (h - LH * pv.scale) / 2;
    bgCv = null;
    bgKey = '';
    model.full = true;
    staticDrawn = false;
  }
  function buildBg() {
    var c = document.createElement('canvas');
    c.width = cv.width;
    c.height = cv.height;
    var g = c.getContext('2d');
    g.fillStyle = '#03040a';
    g.fillRect(0, 0, c.width, c.height);
    stageTransform(g);
    var aw = GW * CELL, ah = GH * CELL;
    g.fillStyle = '#070a1a';
    g.fillRect(AX, AY, aw, ah);
    // The subtle grid: every cell, a bit brighter every 8
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(120,140,255,0.07)';
    g.beginPath();
    var i;
    for (i = 1; i < GW; i++) if (i % 8) { g.moveTo(AX + i * CELL, AY); g.lineTo(AX + i * CELL, AY + ah); }
    for (i = 1; i < GH; i++) if (i % 8) { g.moveTo(AX, AY + i * CELL); g.lineTo(AX + aw, AY + i * CELL); }
    g.stroke();
    g.strokeStyle = 'rgba(140,160,255,0.14)';
    g.beginPath();
    for (i = 8; i < GW; i += 8) { g.moveTo(AX + i * CELL, AY); g.lineTo(AX + i * CELL, AY + ah); }
    for (i = 8; i < GH; i += 8) { g.moveTo(AX, AY + i * CELL); g.lineTo(AX + aw, AY + i * CELL); }
    g.stroke();
    // The wall: a wide low-alpha line under a thin bright one
    g.strokeStyle = 'rgba(170,150,255,0.18)';
    g.lineWidth = 16;
    g.strokeRect(AX - 4, AY - 4, aw + 8, ah + 8);
    g.strokeStyle = '#b9a8ff';
    g.lineWidth = 3;
    g.strokeRect(AX - 3, AY - 3, aw + 6, ah + 6);
    if (M) drawHud(g);
    bgCv = c;
    bgKey = hudKey();
  }
  // The score at the top: dot, name, one pip per round won and the number (player 2 mirrored)
  function hudKey() {
    if (!M) return cv.width + 'x' + cv.height;
    return cv.width + 'x' + cv.height + '|' + M.round + '|' + M.score.join() + '|' + M.toWin + '|' + nameOfSide(1) + '|' + nameOfSide(2) + '|' + colorOfSide(1) + colorOfSide(2);
  }
  function hudTexts() {
    if (!M) return null;
    return { n1: nameOfSide(1), n2: nameOfSide(2), s1: String(M.score[0]), s2: String(M.score[1]), round: 'RONDA ' + M.round, to: 'Gana quien llegue a ' + M.toWin };
  }
  function drawHud(g) {
    var h = hudTexts();
    var y = 58;
    for (var side = 1; side <= 2; side++) {
      var col = colorOfSide(side);
      var left = side === 1;
      var x0 = left ? 128 : 1072;                       // each block is 720 px wide
      var dotX = left ? x0 + 13 : x0 + 707;
      var scoreX = left ? x0 + 677 : x0 + 43;
      var pipsX = left ? x0 + 464 : x0 + 86;           // 5 pips x 34 px = 170
      var nameX = left ? x0 + 48 : x0 + 672;
      g.fillStyle = col;
      g.beginPath();
      g.arc(dotX, y, 13, 0, Math.PI * 2);
      g.fill();
      var nm = fitText(g, side === 1 ? h.n1 : h.n2, 380, 46, 26, '900');
      text(g, nm, nameX, y, col, left ? 'left' : 'right');
      for (var i = 0; i < M.toWin; i++) {
        var px = pipsX + (left ? i : M.toWin - 1 - i) * 34;
        var on = i < M.score[side - 1];
        g.globalAlpha = on ? 1 : 0.55;
        g.fillStyle = col;
        g.fillRect(px, y - 12, 24, 24);
        if (!on) { g.fillStyle = '#03040a'; g.fillRect(px + 3, y - 9, 18, 18); }
        g.globalAlpha = 1;
      }
      setFont(g, 72, '900');
      text(g, side === 1 ? h.s1 : h.s2, scoreX, y + 2, col);
    }
    setFont(g, 36, '900');
    text(g, h.round, LW / 2, 46, '#ffffff');
    setFont(g, 22, 'normal');
    text(g, h.to, LW / 2, 80, 'rgba(255,255,255,0.62)');
  }
  // Adds segments to the trail canvas. list = flat [side, from, to, …] (from -1: a start cell)
  function drawSegments(list) {
    stageTransform(tctx);
    for (var side = 0; side < 2; side++) {
      var color = colorOfSide(side + 1);
      var any = false, i;
      // Glow: a cell-wide, low-alpha band (cells never overlap, so it stays even)
      tctx.globalAlpha = 0.17;
      tctx.fillStyle = color;
      for (i = 0; i < list.length; i += 3) {
        if (list[i] !== side) continue;
        any = true;
        var to = list[i + 2];
        tctx.fillRect(AX + (to % GW) * CELL, AY + Math.floor(to / GW) * CELL, CELL, CELL);
      }
      tctx.globalAlpha = 1;
      if (!any) continue;
      // The bright line, then its light core. Butt caps, each segment stretched
      // forward by half its width: corners are filled and the next segment never
      // paints over the core of the previous one
      for (var pass = 0; pass < 2; pass++) {
        var lw = pass ? CORE : LINE;
        tctx.strokeStyle = pass ? coreOf(color) : color;
        tctx.fillStyle = tctx.strokeStyle;
        tctx.lineWidth = lw;
        tctx.lineCap = 'butt';
        tctx.beginPath();
        for (i = 0; i < list.length; i += 3) {
          if (list[i] !== side) continue;
          var from = list[i + 1], t2 = list[i + 2];
          var x2 = cx(t2), y2 = cy(t2);
          if (from < 0) {
            tctx.fillRect(x2 - lw / 2, y2 - lw / 2, lw, lw);
          } else {
            var x1 = cx(from), y1 = cy(from);
            tctx.moveTo(x1, y1);
            tctx.lineTo(x2 + (x2 > x1 ? lw / 2 : (x2 < x1 ? -lw / 2 : 0)), y2 + (y2 > y1 ? lw / 2 : (y2 < y1 ? -lw / 2 : 0)));
          }
        }
        tctx.stroke();
      }
      stats.segs += list.length / 3;
    }
  }
  function redrawTrails() {
    if (!bgCv) buildBg();
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.drawImage(bgCv, 0, 0);
    var list = [];
    for (var side = 0; side < 2; side++) {
      var p = model.paths[side];
      for (var i = 0; i < p.length; i++) list.push(side, i ? p[i - 1] : -1, p[i]);
    }
    if (list.length) drawSegments(list);
    model.pend = [];
    model.full = false;
    stats.full++;
  }

  function burst(x, y, color) {
    for (var i = 0; i < 22; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = 160 + Math.random() * 520;
      particles.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color: color, size: 5 + Math.random() * 7 });
    }
    if (particles.length > 90) particles.splice(0, particles.length - 90);
    rings.push({ x: x, y: y, t0: now(), color: color });
  }
  function drawEffects(t, dt) {
    var i;
    for (i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.93;
      p.vy *= 0.93;
      p.life -= dt * 1.4;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    for (i = rings.length - 1; i >= 0; i--) {
      var r = rings[i];
      var k = (t - r.t0) / 700;
      if (k >= 1) { rings.splice(i, 1); continue; }
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 8 * (1 - k) + 2;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 14 + 150 * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function drawHeads(t) {
    var playing = M && M.phase === 'playing';
    for (var side = 0; side < 2; side++) {
      var p = model.paths[side];
      if (!p.length) continue;
      var cell = p[p.length - 1];
      var x = cx(cell), y = cy(cell);
      var color = colorOfSide(side + 1);
      var dir = model.dirs[side];
      var alive = model.alive[side];
      if (alive && playing) {
        var frac = clamp((t - model.stepAt) * model.cps / 1000, 0, 1);
        var hx = x + DX[dir] * frac * CELL, hy = y + DY[dir] * frac * CELL;
        if (frac > 0.02) {
          ctx.lineCap = 'butt';
          for (var pass = 0; pass < 2; pass++) {
            ctx.strokeStyle = pass ? coreOf(color) : color;
            ctx.lineWidth = pass ? CORE : LINE;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(hx, hy);
            ctx.stroke();
          }
        }
        x = hx;
        y = hy;
      }
      if (!alive) {
        // Crashed: a dim head with a cross
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(x - CELL * 0.35, y - CELL * 0.35, CELL * 0.7, CELL * 0.7);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x - 9, y - 9); ctx.lineTo(x + 9, y + 9);
        ctx.moveTo(x + 9, y - 9); ctx.lineTo(x - 9, y + 9);
        ctx.stroke();
        continue;
      }
      // The bike: a glow square, a body longer along its direction and a white light in front
      var along = DX[dir] !== 0;
      var bw = along ? CELL * 1.05 : CELL * 0.72, bh = along ? CELL * 0.72 : CELL * 1.05;
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = color;
      ctx.fillRect(x - CELL, y - CELL, CELL * 2, CELL * 2);
      ctx.globalAlpha = 1;
      ctx.fillRect(x - bw / 2, y - bh / 2, bw, bh);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x + DX[dir] * CELL * 0.3 - 5, y + DY[dir] * CELL * 0.3 - 5, 10, 10);
    }
  }
  // Name and an arrow next to each bike during the countdown: who is who
  function drawLabels() {
    ctx.font = 'bold 34px ' + "'LG Smart UI', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var side = 0; side < 2; side++) {
      var p = model.paths[side];
      if (!p.length) continue;
      var cell = p[p.length - 1];
      var x = cx(cell), y = cy(cell);
      var dir = model.dirs[side];
      var ly = dir === 0 ? y + 52 : y - 46;
      var name = nameOfSide(side + 1);
      if (name.length > 12) name = name.slice(0, 12);
      var w = ctx.measureText(name).width + 28;
      ctx.fillStyle = 'rgba(3,4,10,0.75)';
      ctx.fillRect(x - w / 2, ly - 24, w, 48);
      ctx.fillStyle = colorOfSide(side + 1);
      ctx.fillText(name, x, ly);
      // An arrow showing where it will go
      var ax = x + DX[dir] * CELL * 1.9, ay = y + DY[dir] * CELL * 1.9;
      ctx.beginPath();
      ctx.moveTo(ax + DX[dir] * 14, ay + DY[dir] * 14);
      ctx.lineTo(ax - DX[dir] * 6 + DY[dir] * 12, ay - DY[dir] * 6 + DX[dir] * 12);
      ctx.lineTo(ax - DX[dir] * 6 - DY[dir] * 12, ay - DY[dir] * 6 - DX[dir] * 12);
      ctx.closePath();
      ctx.fill();
    }
  }

  function draw(t, dt) {
    if (!M || !cv) return;
    stats.frames++;
    // Opaque DOM screens: nothing to draw (pause: once, under its overlay)
    if (M.phase === 'gameover' || (M.phase === 'paused' && staticDrawn)) return;
    if (!bgCv || hudKey() !== bgKey) { buildBg(); model.full = true; }
    if (model.full) redrawTrails();
    else if (model.pend.length) { drawSegments(model.pend); model.pend = []; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(trailCv, 0, 0);
    stageTransform(ctx);
    drawHeads(t);
    if (M.phase === 'countdown') drawLabels();
    drawEffects(t, dt);
    drawOverlay(t);
    staticDrawn = M.phase === 'paused';
  }

  // Countdown, «¡YA!» and the result of a round: canvas text over the arena
  function countdownTexts() {
    if (!M || M.phase !== 'countdown') return null;
    return { n: String(M.countdown), sub: M.round === 1 && M.score[0] + M.score[1] === 0 ? '¡Preparados! Ronda 1' : 'Ronda ' + M.round + ' · ¡Preparados!' };
  }
  function crashText(c) {
    var who = nameOfSide(c.side);
    if (c.cause === 'rival') return who + ' chocó ' + CAUSE.rival + nameOfSide(3 - c.side);
    return who + ' chocó ' + (CAUSE[c.cause] || '');
  }
  function roundTexts() {
    if (!M || M.phase !== 'roundEnd' || !M.last) return null;
    var w = M.last.winner;
    var cs = M.last.crashes || [];
    var sub = cs.length === 2 && cs[0].cause === 'frontal' ? 'Choque de frente: nadie suma' :
      (cs.length === 2 ? 'Las dos chocaron a la vez: nadie suma' : (cs[0] ? crashText(cs[0]) : ''));
    return { title: w ? '¡Ronda para ' + nameOfSide(w) + '!' : '¡Empate!', sub: sub, color: w ? colorOfSide(w) : '#ffffff' };
  }
  function drawOverlay(t) {
    var c = countdownTexts();
    if (c) {
      var k = clamp((t - countAt) / 400, 0, 1);
      setFont(ctx, Math.round(280 + 60 * (1 - k)), '900');
      text(ctx, c.n, LW / 2, 455, '#ffffff');
      var sub = fitText(ctx, c.sub, 920, 52, 30, 'bold');
      var w = ctx.measureText(sub).width + 80;
      ctx.fillStyle = 'rgba(3,4,10,0.78)';
      roundRect(ctx, LW / 2 - w / 2, 650, w, 84, 42);
      ctx.fill();
      text(ctx, sub, LW / 2, 693, '#ffffff');
      return;
    }
    var since = t - goAt;
    if (M.phase === 'playing' && since >= 0 && since < 700) {
      ctx.globalAlpha = 1 - since / 700;
      setFont(ctx, Math.round(260 + since * 0.15), '900');
      text(ctx, '¡YA!', LW / 2, 455, '#c8ff3e');
      ctx.globalAlpha = 1;
      return;
    }
    var r = roundTexts();
    if (r) {
      ctx.fillStyle = 'rgba(3,4,10,0.86)';
      roundRect(ctx, 360, 390, 1200, 270, 40);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 4;
      ctx.stroke();
      text(ctx, fitText(ctx, r.title, 1100, 92, 40, '900'), LW / 2, 490, r.color);
      text(ctx, fitText(ctx, r.sub, 1100, 40, 24, 'bold'), LW / 2, 590, 'rgba(255,255,255,0.62)');
    }
  }

  // ---------------------------------------------------------------- DOM
  // Only the opaque screens are DOM (the game itself is all canvas)
  var HTML =
    '<div class="ov ovbg center" id="mtPause">' +
    '  <p class="big2">Pausa</p>' +
    '  <div class="mtWait fit" id="mtWait">Esperando…</div>' +
    '  <p class="sub fit" id="mtHold"></p>' +
    '  <p class="sub fit">Vuelve a abrir la página en el móvil para seguir</p>' +
    '  <img class="mtQr" id="mtQr" alt="">' +
    '</div>' +
    '<div class="ov" id="mtEnd">' +
    '  <p class="mtEndK">FIN DE LA PARTIDA</p>' +
    '  <div class="mtEndT fit" id="mtEndT">—</div>' +
    '  <div class="mtEndRow">' +
    '    <span class="mtEndN fit" id="mtEndN1"></span>' +
    '    <span class="mtEndS" id="mtEndS">0 – 0</span>' +
    '    <span class="mtEndN fit" id="mtEndN2"></span>' +
    '  </div>' +
    '  <p class="mtEndSub fit">Rondas ganadas</p>' +
    '  <div class="mtEndBtns">' +
    '    <div class="btn" id="mtAgain">Otra</div>' +
    '    <div class="btn" id="mtMenu">Menú</div>' +
    '    <small>o elegidlo en el móvil</small>' +
    '  </div>' +
    '</div>';

  function render() {
    if (!view || !M) return;
    var ph = M.phase;
    // Pause
    var paused = ph === 'paused';
    show($('mtPause'), paused);
    if (paused) {
      renderPause();
      if (!$('mtQr').getAttribute('src') && host.httpBase !== undefined) $('mtQr').setAttribute('src', host.httpBase + '/qr.svg');
    }
    // The winner
    var over = ph === 'gameover';
    show($('mtEnd'), over);
    if (over) {
      var win = M.winner || 1;
      setText($('mtEndT'), '¡GANA ' + nameOfSide(win).toUpperCase() + '!');
      $('mtEndT').style.color = colorOfSide(win);
      fit($('mtEndT'), 150, 50);
      setText($('mtEndS'), M.score[0] + ' – ' + M.score[1]);
      for (var s2 = 1; s2 <= 2; s2++) {
        setText($('mtEndN' + s2), nameOfSide(s2));
        $('mtEndN' + s2).style.color = colorOfSide(s2);
        fit($('mtEndN' + s2), 56, 28);
      }
      renderFocus();
    }
  }
  function renderPause() {
    var hub = host.hub();
    var ps = (hub && hub.players) || [];
    var away = [], hold = 0;
    (M.players || []).forEach(function (slot) {
      var p = ps[slot - 1];
      if (p && !p.connected) { away.push(p.name); hold = Math.max(hold, p.holdLeft || 0); }
    });
    if (!away.length && M.waiting) away = M.waiting;
    setText($('mtWait'), 'Esperando a ' + (away.length ? G2T.joinNames(away) : 'los jugadores') + '…');
    fit($('mtWait'), 96, 40);
    setText($('mtHold'), hold ? 'Reconexión: ' + hold + ' s' : '');
  }
  function renderFocus() {
    var b = [$('mtAgain'), $('mtMenu')];
    for (var i = 0; i < 2; i++) { if (i === endFocus) b[i].classList.add('focus'); else b[i].classList.remove('focus'); }
  }

  function onMeta(m) {
    var prev = M;
    M = m;
    if (prev && (prev.phase !== m.phase || prev.round !== m.round)) staticDrawn = false;
    if (!prev || prev.match !== m.match) endFocus = 0;
    if (m.phase === 'countdown' && m.countdown !== lastCountdown) { host.sfx.tick(); countAt = now(); }
    lastCountdown = m.phase === 'countdown' ? m.countdown : 0;
    if (prev && JSON.stringify(prev.players) !== JSON.stringify(m.players)) { model.full = true; staticDrawn = false; }
    render();
  }

  function onEvent(e) {
    switch (e.k) {
      case 'go':
        goAt = now();
        host.sfx.go();
        break;
      case 'crash': {
        var side = e.side - 1;
        if (side === 0 || side === 1) model.alive[side] = false;
        if (e.cell >= 0) burst(cx(e.cell), cy(e.cell), colorOfSide(e.side));
        beep(220, 0.45, 'sawtooth', 0.12, 50);
        break;
      }
      case 'round':
        if (e.winner) beep(660, 0.12, 'triangle', 0.14, null, 0.25);
        break;
      case 'win':
        setTimeout(function () { host.sfx.win(); host.confetti(); }, 300);
        break;
    }
  }

  G2T.tv.register({
    id: 'motos',
    mount: function (h) {
      host = h;
      show = h.show;
      setText = h.setText;
      fit = h.fit;
      cv = document.createElement('canvas');
      cv.id = 'mtCanvas';
      cv.style.cssText = 'position:absolute;left:0;top:0;display:none;z-index:0;';
      h.addLayer(cv);
      ctx = cv.getContext('2d', { alpha: false }) || cv.getContext('2d');
      trailCv = document.createElement('canvas');
      tctx = trailCv.getContext('2d');
      view = document.createElement('section');
      view.id = 'vMotos';
      view.className = 'view';
      view.innerHTML = HTML;
      h.addView(view);
    },
    layout: function (w, h) { resize(w, h); },
    enter: function () { cv.style.display = 'block'; show(view, true); staticDrawn = false; },
    leave: function () {
      cv.style.display = 'none';
      show(view, false);
      M = null;
      model = TrailModel();
      particles = [];
      rings = [];
    },
    onHub: function () { if (M) { render(); staticDrawn = false; } },
    onMessage: function (msg) {
      switch (msg.t) {
        case 'mmeta': onMeta(msg); break;
        case 'msnap': model.snap(msg); staticDrawn = false; break;
        case 'mt':
          if (!model.tick(msg)) askSync();
          if (host) host.debug.states++;
          break;
      }
    },
    onEvent: onEvent,
    onKey: function (e, dir, ok) {
      if (!M || M.phase !== 'gameover') return false;
      if (dir) { endFocus = clamp(endFocus + dir, 0, 1); renderFocus(); host.sfx.move(); return true; }
      if (ok) { host.send(endFocus === 0 ? { t: 'm.again' } : { t: 'menu' }); return true; }
      return false;
    },
    frame: function (t, dt) { draw(t, dt); },
    debugInfo: function () { return cv.width + 'x' + cv.height + ' trazos ' + stats.full + '/' + stats.segs; },
    canvas: function () { return cv; },
    // For automated tests
    state: function () {
      return {
        meta: M,
        r: model.r,
        k: model.k,
        grid: model.gridString(),
        heads: model.paths.map(function (p) { return p.length ? p[p.length - 1] : -1; }),
        lens: model.paths.map(function (p) { return p.length; }),
        dirs: model.dirs.slice(),
        alive: model.alive.slice(),
        canvas: cv ? [cv.width, cv.height] : null,
        // What the canvas shows as text (score, countdown, result of the round)
        hud: hudTexts(),
        count: countdownTexts(),
        msg: roundTexts(),
        fullRedraws: stats.full,
        segs: stats.segs,
        frames: stats.frames
      };
    }
  });
})();
