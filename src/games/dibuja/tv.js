/*
 * «Dibuja y adivina»: TV view. Loaded by public/tv.html (ES2019).
 * Shows the drawing live, the timer ring, the guesses, the hint pattern,
 * the round overlays and the final gallery.
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var $ = G2T.$, now = G2T.now, clamp = G2T.clamp, esc = G2T.esc;
  var host = null, show, setText, fit, COLORS;
  var beep = G2T.sound.beep;
  var sfx = {
    casi: function () { beep(740, 0.09, 'sine', 0.14); beep(880, 0.12, 'sine', 0.14, null, 0.1); },
    hint: function () { beep(1200, 0.08, 'sine', 0.12); beep(1500, 0.16, 'sine', 0.12, null, 0.08); },
    timeout: function () { beep(392, 0.3, 'sawtooth', 0.08, 370); beep(330, 0.35, 'sawtooth', 0.08, 300, 0.32); beep(262, 0.7, 'sawtooth', 0.08, 180, 0.7); },
    intro: function () { beep(300, 0.25, 'sine', 0.1, 600); },
    clock: function () { beep(1000, 0.05, 'square', 0.06); }
  };

  var HTML =
    '<div class="dtop">' +
    '  <div class="rpill" id="dRound">Ronda 1/8</div>' +
    '  <div class="roles">' +
    '    <div class="role" id="dDrawer"><small>DIBUJA</small><b class="fit">—</b></div>' +
    '    <div class="role" id="dGuesser"><small>ADIVINA</small><b class="fit">—</b></div>' +
    '  </div>' +
    '  <div class="dscore"><small>PUNTOS</small><b id="dScore">0</b></div>' +
    '</div>' +
    '<div class="dleft">' +
    '  <div class="ring" id="dRing">' +
    '    <svg width="320" height="320" viewBox="0 0 320 320" aria-hidden="true">' +
    '      <circle class="trk" cx="160" cy="160" r="140"/>' +
    '      <circle class="bar" id="dRingBar" cx="160" cy="160" r="140" transform="rotate(-90 160 160)"/>' +
    '    </svg>' +
    '    <div class="ringNum" id="dRingNum">80</div>' +
    '    <div class="ringSub">segundos</div>' +
    '  </div>' +
    '  <div class="dphase" id="dPhase">¡A dibujar!</div>' +
    '</div>' +
    '<div class="dframe"><canvas id="dc" width="1040" height="780"></canvas></div>' +
    '<div class="dright"><h3>INTENTOS</h3><ul id="dFeed"></ul></div>' +
    '<div class="dhint" id="dHint"></div>' +
    '<div class="ov ovbg center" id="oIntro">' +
    '  <p class="big1" id="iRound">Ronda 1 de 8</p>' +
    '  <p class="big2">Ahora dibuja</p>' +
    '  <div class="huge fit" id="iName">—</div>' +
    '  <p class="sub fit" id="iSub">y adivina —</p>' +
    '</div>' +
    '<div class="ov ovbg center" id="oChoose">' +
    '  <p class="big2 fit" id="cTitle" style="max-width:1600px">— está eligiendo palabra…</p>' +
    '  <div class="cnum" id="cNum">15</div>' +
    '  <p class="sub fit" id="cSub">Mientras, ¡preparad la vista!</p>' +
    '</div>' +
    '<div class="ov ovsoft center" id="oReveal">' +
    '  <p class="big2" id="rTitle">¡Acertado!</p>' +
    '  <p class="big1" id="rEra">Era:</p>' +
    '  <div class="huge fit" id="rWord">—</div>' +
    '  <p class="pts" id="rPts">+0 puntos</p>' +
    '  <p class="brk fit" id="rBrk"></p>' +
    '</div>' +
    '<div class="ov" id="oEnd">' +
    '  <div class="ghead">' +
    '    <div class="gl"><small>GALERÍA</small><b>¡Fin de la partida!</b></div>' +
    '    <div class="gc"><div class="rt fit" id="gRating">—</div><div class="rs fit" id="gRatingSub"></div></div>' +
    '    <div class="gr"><small>PUNTOS DEL EQUIPO</small><b id="gScore">0</b></div>' +
    '  </div>' +
    '  <div class="ggrid" id="gGrid"></div>' +
    '  <div class="gfoot">' +
    '    <div class="btn" id="gAgain" data-act="again">Jugar otra vez</div>' +
    '    <div class="btn" id="gMenu" data-act="menu">Menú</div>' +
    '    <small>o elegidlo en el móvil</small>' +
    '  </div>' +
    '</div>' +
    '<div class="ov ovbg center" id="oPause">' +
    '  <p class="big2">Pausa</p>' +
    '  <div class="huge fit" id="pWho" style="font-size:96px">Esperando…</div>' +
    '  <p class="sub fit">Volved a abrir la página en el móvil para seguir</p>' +
    '</div>';

  var D = { meta: null, metaAt: 0, strokes: [], byId: {}, feedKey: '', hintKey: '', phase: '', round: 0, lastSec: -1, reveal: null, phaseMsg: '', phaseMsgUntil: 0, scoreShown: -1, galleryKey: '' };
  var view, dc, dctx;
  var dcW = 1040, dcH = 780; // backing store size (recomputed with scale and DPR)
  var galleryIndex = 0;

  function playerName(i) { return host.playerName(i); }

  function resetDibuja() {
    D.meta = null;
    D.phase = '';
    D.round = 0;
    D.reveal = null;
    D.feedKey = '';
    D.hintKey = '';
    D.galleryKey = '';
    D.scoreShown = -1;
    setStrokes([]);
    ['oIntro', 'oChoose', 'oReveal', 'oEnd', 'oPause'].forEach(function (id) { show($(id), false); });
    $('dFeed').innerHTML = '';
    $('dHint').innerHTML = '';
  }

  function resizeDrawCanvas() {
    var css = 1040 * host.stageScale();
    var w = Math.max(320, Math.round(css * host.capDpr(css)));
    var h = Math.round(w * 0.75);
    if (dc.width !== w || dc.height !== h) {
      dc.width = w;
      dc.height = h;
      dcW = w;
      dcH = h;
      redrawAll();
    }
  }

  // --- Strokes: quadratic curves through midpoints (same as the phone and the PNG)
  function strokeStyle(ctx, st, W) {
    ctx.strokeStyle = st.c;
    ctx.fillStyle = st.c;
    ctx.lineWidth = Math.max(1, st.w * W);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }
  function drawStrokeInc(ctx, st, W, H) {
    var p = st.p, n = Math.floor(p.length / 2);
    if (!n) return;
    strokeStyle(ctx, st, W);
    if (st.seg === undefined) {
      st.seg = 1;
      ctx.beginPath();
      ctx.arc(p[0] * W, p[1] * H, Math.max(0.5, st.w * W / 2), 0, Math.PI * 2);
      ctx.fill();
    }
    while (st.seg <= n - 2) {
      var i = st.seg;
      var sx = i === 1 ? p[0] * W : (p[(i - 1) * 2] + p[i * 2]) / 2 * W;
      var sy = i === 1 ? p[1] * H : (p[(i - 1) * 2 + 1] + p[i * 2 + 1]) / 2 * H;
      var ex = (p[i * 2] + p[(i + 1) * 2]) / 2 * W;
      var ey = (p[i * 2 + 1] + p[(i + 1) * 2 + 1]) / 2 * H;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(p[i * 2] * W, p[i * 2 + 1] * H, ex, ey);
      ctx.stroke();
      st.seg++;
    }
    if (n >= 2) {
      var tx = n === 2 ? p[0] * W : (p[(n - 2) * 2] + p[(n - 1) * 2]) / 2 * W;
      var ty = n === 2 ? p[1] * H : (p[(n - 2) * 2 + 1] + p[(n - 1) * 2 + 1]) / 2 * H;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(p[(n - 1) * 2] * W, p[(n - 1) * 2 + 1] * H);
      ctx.stroke();
    }
  }
  function clearCanvas(ctx, W, H) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
  }
  function drawAllStrokes(ctx, strokes, W, H) {
    clearCanvas(ctx, W, H);
    for (var i = 0; i < strokes.length; i++) {
      var st = { c: strokes[i].c, w: strokes[i].w, p: strokes[i].p };
      drawStrokeInc(ctx, st, W, H);
    }
  }
  function redrawAll() {
    clearCanvas(dctx, dcW, dcH);
    for (var i = 0; i < D.strokes.length; i++) {
      D.strokes[i].seg = undefined;
      drawStrokeInc(dctx, D.strokes[i], dcW, dcH);
    }
  }
  function setStrokes(list) {
    D.strokes = [];
    D.byId = {};
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var st = { id: s.id, c: s.c, w: s.w, p: (s.p || []).slice() };
      D.strokes.push(st);
      D.byId[st.id] = st;
    }
    redrawAll();
  }
  function onStrokePart(m) {
    var st = D.byId[m.id];
    if (!st) {
      st = { id: m.id, c: m.c, w: m.w, p: [] };
      D.strokes.push(st);
      D.byId[m.id] = st;
    }
    var p = m.p || [];
    for (var i = 0; i < p.length; i++) st.p.push(p[i]);
    drawStrokeInc(dctx, st, dcW, dcH);
  }
  function removeStroke(id) {
    for (var i = D.strokes.length - 1; i >= 0; i--) {
      if (D.strokes[i].id === id) { D.strokes.splice(i, 1); break; }
    }
    delete D.byId[id];
    redrawAll();
  }

  // --- Round state
  function onDmeta(m) {
    var prevPhase = D.phase, prevRound = D.round;
    D.meta = m;
    D.metaAt = now();
    if (m.phase !== prevPhase || m.round !== prevRound) {
      if (m.phase === 'intro') { sfx.intro(); D.reveal = null; }
      if (m.phase === 'draw') { host.sfx.go(); D.phaseMsg = ''; }
      if (m.phase === 'end') { galleryIndex = 0; renderFocus(); }
      D.phase = m.phase;
      D.round = m.round;
      D.lastSec = -1;
    }
    renderDibuja();
  }

  function timeLeftMs() {
    var m = D.meta;
    if (!m) return 0;
    if (m.paused) return m.left;
    return Math.max(0, m.left - (now() - D.metaAt) * (m.speed || 1));
  }

  function flashPhase(text, ms) {
    D.phaseMsg = text;
    D.phaseMsgUntil = now() + ms;
  }

  function renderRole(el, slot, label) {
    var i = slot - 1;
    var b = el.querySelector('b');
    setText(el.querySelector('small'), label);
    setText(b, playerName(i));
    b.style.color = COLORS()[i];
    el.style.borderColor = COLORS()[i];
    fit(b, 44, 26);
  }

  function renderDibuja() {
    var m = D.meta;
    if (!m || host.screen() !== 'dibuja') return;
    setText($('dRound'), 'Ronda ' + m.round + '/' + m.rounds);
    renderRole($('dDrawer'), m.drawer, 'DIBUJA');
    renderRole($('dGuesser'), m.guesser, 'ADIVINA');
    if (D.scoreShown !== m.score) {
      var sc = $('dScore');
      setText(sc, m.score);
      if (D.scoreShown >= 0 && m.score > D.scoreShown) {
        sc.classList.add('bump');
        setTimeout(function () { sc.classList.remove('bump'); }, 1600);
      }
      D.scoreShown = m.score;
    }
    renderHint(m);
    renderFeed(m);

    show($('oIntro'), m.phase === 'intro');
    show($('oChoose'), m.phase === 'choose');
    show($('oReveal'), m.phase === 'reveal');
    show($('oEnd'), m.phase === 'end');
    show($('oPause'), !!m.paused && m.phase !== 'end');

    if (m.phase === 'intro') {
      setText($('iRound'), 'Ronda ' + m.round + ' de ' + m.rounds);
      var nm = $('iName');
      setText(nm, playerName(m.drawer - 1));
      nm.style.color = COLORS()[m.drawer - 1];
      fit(nm, 170, 60);
      setText($('iSub'), 'y adivina ' + playerName(m.guesser - 1));
    } else if (m.phase === 'choose') {
      var ct = $('cTitle');
      setText(ct, playerName(m.drawer - 1) + ' está eligiendo palabra…');
      fit(ct, 64, 30);
      setText($('cSub'), playerName(m.guesser - 1) + ': ¡atento a la tele!');
    } else if (m.phase === 'reveal') {
      renderReveal(m);
    } else if (m.phase === 'end') {
      renderEnd(m);
    }
    if (m.paused) {
      var pw = $('pWho');
      setText(pw, 'Esperando a ' + (m.waiting && m.waiting.length ? m.waiting.join(' y ') : 'un jugador') + '…');
      fit(pw, 96, 40);
    }
  }

  function renderHint(m) {
    var el = $('dHint');
    var key = m.phase === 'draw' ? (m.hint || '') : '';
    if (key === D.hintKey) return;
    var prev = D.hintKey;
    D.hintKey = key;
    if (!key) { el.innerHTML = ''; return; }
    var chars = Array.from(key);
    var n = chars.length;
    var box = Math.floor(Math.min(78, 1480 / Math.max(1, n)));
    var font = Math.floor(box * 0.86);
    var prevChars = Array.from(prev);
    var html = '';
    for (var i = 0; i < n; i++) {
      var ch = chars[i];
      var cls = 'ch';
      var txt = ch;
      if (ch === ' ') { cls += ' sp'; txt = '&nbsp;'; }
      else if (ch === '-') { cls += ' sp'; }
      else if (ch === '_') { txt = '&nbsp;'; }
      else { cls += ' rv'; txt = esc(ch.toUpperCase()); if (prevChars[i] === '_' && prev.length === key.length) cls += ' pulse'; }
      html += '<span class="' + cls + '" style="width:' + (box - 12) + 'px;font-size:' + font + 'px">' + txt + '</span>';
    }
    html += '<span class="cnt">' + m.letters + ' letras</span>';
    el.innerHTML = html;
  }

  function renderFeed(m) {
    var list = m.guesses || [];
    var key = JSON.stringify(list) + '|' + m.round;
    if (key === D.feedKey) return;
    var oldLen = D.feedKey ? (D.feedKeyLen || 0) : 0;
    D.feedKey = key;
    D.feedKeyLen = list.length;
    var ul = $('dFeed');
    if (!list.length) {
      ul.innerHTML = '<li class="feedEmpty" style="background:none;height:auto">' + esc(playerName(m.guesser - 1)) + ' escribe sus respuestas en el móvil</li>';
      return;
    }
    var html = '';
    for (var i = list.length - 1; i >= 0; i--) {
      var g = list[i];
      var label = g.res === 'ok' ? '¡SÍ!' : (g.res === 'casi' ? '¡CASI!' : 'NO');
      html += '<li class="' + g.res + (i === list.length - 1 && list.length >= oldLen ? ' new' : '') + '"><span class="g fit">' + esc(g.text) + '</span><span class="r">' + label + '</span></li>';
    }
    ul.innerHTML = html;
  }

  function onGuess(g) {
    if (g.res === 'casi') { sfx.casi(); flashPhase('¡Casi! Muy cerca…', 2200); }
    else host.sfx.wrong();
  }

  function onReveal(r) {
    D.reveal = r;
    if (r.ok) {
      host.sfx.correct();
      host.confetti();
    } else {
      sfx.timeout();
    }
  }

  function renderReveal(m) {
    var r = D.reveal || m.last;
    if (!r) return;
    var ok = !!r.ok;
    var t = $('rTitle');
    setText(t, ok ? '¡Acertado!' : '¡Se acabó el tiempo!');
    t.className = 'big2 ' + (ok ? 'okc' : 'badc');
    show($('rEra'), !ok);
    $('rEra').style.display = ok ? 'none' : 'block';
    var w = $('rWord');
    setText(w, String(r.word).toUpperCase());
    fit(w, 170, 60);
    setText($('rPts'), ok ? ('+' + r.points + ' puntos') : '0 puntos esta ronda');
    $('rPts').style.color = ok ? '' : 'rgba(255,255,255,0.5)';
    var brk = ok ? ('100 + 3 × ' + r.secsLeft + ' s' + (r.bonus ? ' + ' + r.bonus + ' por palabra ' + (r.diff === 'dificil' ? 'difícil' : 'media') : '')) : ('Puntos del equipo: ' + m.score);
    setText($('rBrk'), brk);
  }

  function renderEnd(m) {
    var r = m.rating || { title: '', sub: '' };
    var t = $('gRating');
    setText(t, r.title);
    fit(t, 92, 40);
    var s = $('gRatingSub');
    setText(s, r.sub);
    fit(s, 32, 20);
    setText($('gScore'), m.score);
    renderFocus();
  }

  function renderFocus() {
    var gb = [$('gAgain'), $('gMenu')];
    for (var j = 0; j < 2; j++) { if (j === galleryIndex) gb[j].classList.add('focus'); else gb[j].classList.remove('focus'); }
  }

  function buildGallery(items) {
    var key = JSON.stringify(items.map(function (it) { return it.round + it.word; }));
    if (key === D.galleryKey) return;
    D.galleryKey = key;
    var grid = $('gGrid');
    grid.innerHTML = '';
    var n = items.length;
    var cols = Math.min(4, Math.max(1, n));
    var rows = Math.max(1, Math.ceil(n / cols));
    var tw = Math.floor(Math.min(380, (1760 - cols * 30) / cols, ((680 - rows * 70) / rows) / 0.75));
    var th = Math.round(tw * 0.75);
    var scale = host.stageScale();
    for (var i = 0; i < n; i++) {
      var it = items[i];
      var div = document.createElement('div');
      div.className = 'gitem';
      div.style.width = (tw + 8) + 'px';
      var cv = document.createElement('canvas');
      var td = Math.min(host.capDpr(tw * scale), 1);
      var bw = Math.round(tw * scale * td), bh = Math.round(th * scale * td);
      cv.width = Math.max(40, bw);
      cv.height = Math.max(30, bh);
      cv.style.width = tw + 'px';
      cv.style.height = th + 'px';
      if (it.drawer) cv.style.borderColor = COLORS()[it.drawer - 1];
      var cx = cv.getContext('2d');
      drawAllStrokes(cx, it.strokes || [], cv.width, cv.height);
      var cap = document.createElement('div');
      cap.className = 'cap';
      cap.innerHTML = '<span class="w fit">' + it.round + '. ' + esc(it.word) + '</span><span class="p ' + (it.ok ? 'y' : 'n') + '">' + (it.ok ? '+' + it.points : '✗') + '</span>';
      div.appendChild(cv);
      div.appendChild(cap);
      grid.appendChild(div);
    }
  }

  function updateDibujaFrame(t) {
    var m = D.meta;
    if (!m) return;
    var left = timeLeftMs();
    var sec = Math.ceil(left / 1000 - 1e-6);
    var ring = $('dRing');
    var num = $('dRingNum');
    var bar = $('dRingBar');
    var C = 2 * Math.PI * 140;
    var frac = m.phase === 'draw' && m.total ? clamp(left / m.total, 0, 1) : (m.phase === 'choose' || m.phase === 'intro' ? 1 : 0);
    bar.style.strokeDasharray = C.toFixed(1);
    bar.style.strokeDashoffset = (C * (1 - frac)).toFixed(1);
    var warn = m.phase === 'draw' && sec <= 10;
    if (warn) ring.classList.add('warn'); else ring.classList.remove('warn');
    if (warn && !m.paused) num.classList.add('pulse'); else num.classList.remove('pulse');
    setText(num, m.phase === 'draw' ? Math.max(0, sec) : (m.phase === 'choose' ? '…' : (m.phase === 'reveal' ? '0' : String(Math.round(m.total ? m.total / 1000 : 80)))));
    if (m.phase === 'draw' && !m.paused && sec !== D.lastSec) {
      if (D.lastSec !== -1 && sec <= 5 && sec >= 1) sfx.clock();
      D.lastSec = sec;
    }
    if (m.phase === 'choose') setText($('cNum'), Math.max(0, sec));
    // Text under the clock
    var ph = $('dPhase');
    var txt, hl = false;
    if (m.paused) txt = 'Pausa';
    else if (D.phaseMsg && t < D.phaseMsgUntil) { txt = D.phaseMsg; hl = true; }
    else if (m.phase === 'draw') txt = warn ? '¡Últimos segundos!' : '¡A dibujar!';
    else if (m.phase === 'choose') txt = 'Eligiendo palabra…';
    else if (m.phase === 'reveal') txt = m.last && m.last.ok ? '¡Bien hecho!' : 'Otra vez será';
    else txt = '';
    setText(ph, txt);
    if (hl || warn) ph.classList.add('hl'); else ph.classList.remove('hl');
  }

  G2T.tv.register({
    id: 'dibuja',
    mount: function (h) {
      host = h;
      show = h.show;
      setText = h.setText;
      fit = h.fit;
      COLORS = h.colors;
      view = document.createElement('section');
      view.id = 'vDibuja';
      view.className = 'view';
      view.innerHTML = HTML;
      h.addView(view);
      dc = $('dc');
      dctx = dc.getContext('2d');
    },
    layout: function () { resizeDrawCanvas(); },
    enter: function () {
      show(view, true);
      resizeDrawCanvas();
    },
    leave: function () {
      show(view, false);
      resetDibuja();
    },
    onHub: function () { renderDibuja(); },
    onMessage: function (msg) {
      switch (msg.t) {
        case 'dmeta': onDmeta(msg); break;
        case 'd.s': onStrokePart(msg); break;
        case 'd.all': setStrokes(msg.strokes || []); break;
        case 'd.undo': removeStroke(msg.id); break;
        case 'd.clear': setStrokes([]); break;
        case 'd.g': onGuess(msg); break;
        case 'd.hint': sfx.hint(); flashPhase('¡Pista! Una letra más', 2500); break;
        case 'd.skip': flashPhase('¡Palabra nueva!', 2500); break;
        case 'd.reveal': onReveal(msg); break;
        case 'd.gallery': buildGallery(msg.items || []); break;
      }
    },
    // Remote control on the final gallery: ◀ ▶ + OK
    onKey: function (e, dir, ok) {
      if (!(D.meta && D.meta.phase === 'end')) return false;
      if (dir) { galleryIndex = clamp(galleryIndex + dir, 0, 1); renderFocus(); host.sfx.move(); return true; }
      if (ok) { host.send(galleryIndex === 0 ? { t: 'd.again' } : { t: 'menu' }); return true; }
      return false;
    },
    frame: function (t) { updateDibujaFrame(t); },
    // For automated tests
    state: function () { return D; }
  });
})();
