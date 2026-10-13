/*
 * «Dibuja y adivina»: phone view. Loaded by public/m.html (ES2019).
 * - The drawer picks a word and draws on a 4:3 canvas (normalized 0..1
 *   coordinates, sent in small batches every ~40 ms).
 * - The guesser types answers; Enter sends and keeps the keyboard open.
 * - Menu panel: «Palabras secretas para tu pareja».
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var $ = G2T.$, esc = G2T.esc, now = G2T.now, findTouch = G2T.findTouch;
  var host = null, show, setText;
  var DIFF_LABEL = { facil: 'fácil', media: 'media', dificil: 'difícil' };

  var HTML =
    '<div class="bar">' +
    '  <div class="chip"><span class="dot"></span><span id="dWho" class="meName">Jugador</span></div>' +
    '  <div class="info"><span id="dRound">Ronda 1/8</span> · <span id="dScore">0</span> pts</div>' +
    '  <button class="mini ghost menuBtn" type="button">Menú</button>' +
    '</div>' +
    '<div class="pn center hidden" id="pnIntro">' +
    '  <p class="k1" id="iRound">Ronda 1 de 8</p>' +
    '  <div class="k2" id="iTitle">Te toca dibujar</div>' +
    '  <p class="k3" id="iSub"></p>' +
    '</div>' +
    '<div class="pn hidden" id="pnChoose">' +
    '  <div class="chooseHead"><h2>Elige qué vas a dibujar</h2><b id="chTime">15</b></div>' +
    '  <div id="chOpts"></div>' +
    '  <p class="small" style="text-align:center">Si no eliges, saldrá una al azar.</p>' +
    '</div>' +
    '<div class="pn center hidden" id="pnWait">' +
    '  <p class="k1">Mira la tele</p>' +
    '  <div class="k2" id="wtTitle">Eligiendo palabra…</div>' +
    '  <p class="k3" id="wtTime"></p>' +
    '</div>' +
    '<div class="pn hidden" id="pnDraw">' +
    '  <div class="wordbar">' +
    '    <span class="tag facil" id="dwTag">fácil</span>' +
    '    <b class="fit" id="dwWord">…</b>' +
    '    <span class="timer" id="dwTime">80</span>' +
    '  </div>' +
    '  <div class="cwrap" id="cwrap"><canvas id="dcv" width="300" height="225"></canvas></div>' +
    '  <div class="tools">' +
    '    <div class="colors" id="colors"></div>' +
    '    <div class="row2">' +
    '      <button class="tb size" data-s="0" type="button"><i style="width:6px;height:6px"></i></button>' +
    '      <button class="tb size" data-s="1" type="button"><i style="width:12px;height:12px"></i></button>' +
    '      <button class="tb size" data-s="2" type="button"><i style="width:20px;height:20px"></i></button>' +
    '      <button class="tb" id="tEraser" type="button">Goma</button>' +
    '      <button class="tb" id="tUndo" type="button">↶ Deshacer</button>' +
    '      <button class="tb" id="tClear" type="button">Borrar</button>' +
    '    </div>' +
    '  </div>' +
    '  <div class="row3">' +
    '    <span class="lbl fit" id="dwFeedLbl">Intentos</span>' +
    '    <button class="mini ghost" id="tSkip" type="button">Pasar palabra</button>' +
    '  </div>' +
    '  <ul class="feed" id="dwFeed"></ul>' +
    '</div>' +
    '<div class="pn hidden" id="pnGuess">' +
    '  <div class="gtop"><div class="tbar" id="gBarWrap"><i id="gBar"></i></div><span class="timer" id="gTime">80</span></div>' +
    '  <p class="glabel fit" id="gLabel">Adivina lo que dibuja tu pareja</p>' +
    '  <div class="hint" id="gHint">_ _ _</div>' +
    '  <p class="letters" id="gLetters"></p>' +
    '  <form class="gform" id="gForm" autocomplete="off" novalidate>' +
    '    <input id="gInput" type="text" maxlength="40" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" enterkeyhint="send" placeholder="Escribe tu respuesta">' +
    '    <button type="submit" id="gSend">Enviar</button>' +
    '  </form>' +
    '  <div class="fb" id="gFb"></div>' +
    '  <ul class="feed" id="gFeed"></ul>' +
    '</div>' +
    '<div class="pn center hidden" id="pnReveal">' +
    '  <div class="k2" id="rvTitle">¡Acertado!</div>' +
    '  <p class="k1" id="rvEra">Era:</p>' +
    '  <div class="k2 fit" id="rvWord" style="font-size:44px">—</div>' +
    '  <p class="k3" id="rvPts"></p>' +
    '</div>' +
    '<div class="pn center hidden" id="pnEnd">' +
    '  <p class="k1">¡Partida terminada!</p>' +
    '  <div class="k2" id="enScore" style="font-size:56px">0</div>' +
    '  <p class="k1">puntos del equipo</p>' +
    '  <div class="k2" id="enRating" style="margin-top:18px">—</div>' +
    '  <p class="k3" id="enSub"></p>' +
    '  <button class="bigbtn c" id="enAgain" type="button" style="margin-top:18px">Jugar otra vez</button>' +
    '  <button class="bigbtn ghost menuBtn" type="button" style="margin-top:12px;font-size:22px;padding:16px">Menú</button>' +
    '</div>';

  var PAUSE_HTML =
    '<div class="t1">Pausa</div>' +
    '<div class="t2" id="dPauseWho" style="font-size:24px;font-weight:800;color:#fff">Esperando…</div>' +
    '<div class="t2">El tiempo está parado hasta que vuelva.</div>';

  var MENU_HTML =
    '<div class="secret">' +
    '  <h3><span>Palabras secretas para tu pareja</span><span id="wCount">0/10</span></h3>' +
    '  <p class="small" id="wHelp">Saldrán en «Dibuja y adivina» cuando le toque dibujar a tu pareja. Solo las ves tú.</p>' +
    '  <form class="wform" id="wForm" autocomplete="off" novalidate>' +
    '    <input id="wInput" type="text" maxlength="30" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" enterkeyhint="done" placeholder="Ej.: la siesta del domingo">' +
    '    <button type="submit" id="wAdd">Añadir</button>' +
    '  </form>' +
    '  <ul id="wList"></ul>' +
    '</div>';

  var dm = null, dmAt = 0;   // last 'dmeta'
  var opts = null;           // word options (only when I draw)
  var secret = null;         // secret word (only when I draw)
  var myWords = [], maxWords = 10;

  var PALETTE = ['#1a1a1a', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#6d4c41'];
  var SIZES = [0.008, 0.018, 0.04];
  var tool = { color: 0, size: 1, eraser: false };
  var strokes = [], nextId = 1, cur = null, pending = null, flushTimer = null;
  var cv, cctx;
  var cvW = 300, cvH = 225;
  var currentPanel = '';
  var fbTimer = null;

  function slot() { return host.slot(); }
  function myColor() { return host.myColor(); }
  function otherName() { return host.otherName(); }
  function sendMsg(o) { return host.send(o); }
  function isActive() { var h = host.hub(); return !!(h && h.screen === 'dibuja'); }

  function onDmeta(m) {
    var prev = dm;
    dm = m;
    dmAt = now();
    if (!prev || prev.round !== m.round) { opts = null; if (m.drawer !== slot()) secret = null; }
    if (m.phase === 'choose' && opts && opts.round !== m.round) opts = null;
    if (prev && prev.phase !== m.phase && m.phase === 'draw' && m.drawer !== slot()) {
      setTimeout(function () { try { $('gInput').focus(); } catch (e) { /* noop */ } }, 50);
    }
    renderDibuja();
  }

  function timeLeft() {
    if (!dm) return 0;
    if (dm.paused) return dm.left;
    return Math.max(0, dm.left - (now() - dmAt) * (dm.speed || 1));
  }

  function setPanel(id) {
    var ids = ['pnIntro', 'pnChoose', 'pnWait', 'pnDraw', 'pnGuess', 'pnReveal', 'pnEnd'];
    for (var i = 0; i < ids.length; i++) show($(ids[i]), ids[i] === id);
    if (id !== currentPanel) {
      currentPanel = id;
      if (id === 'pnDraw') setTimeout(sizeCanvas, 0);
    }
  }

  function renderDibuja() {
    if (!dm || !isActive()) return;
    var iDraw = dm.drawer === slot();
    setText($('dRound'), 'Ronda ' + dm.round + '/' + dm.rounds);
    setText($('dScore'), dm.score);
    show($('dPause'), !!dm.paused && dm.phase !== 'end');
    if (dm.paused) setText($('dPauseWho'), 'Esperando a ' + (dm.waiting && dm.waiting.length ? dm.waiting.join(' y ') : 'tu pareja') + '…');

    switch (dm.phase) {
      case 'intro':
        setPanel('pnIntro');
        setText($('iRound'), 'Ronda ' + dm.round + ' de ' + dm.rounds);
        setText($('iTitle'), iDraw ? 'Te toca dibujar' : 'Te toca adivinar');
        $('iTitle').style.color = myColor();
        setText($('iSub'), iDraw ? ('Adivina ' + otherName() + ' mirando la tele') : ('Dibuja ' + otherName() + '. ¡Mira la tele!'));
        break;
      case 'choose':
        if (iDraw) { setPanel('pnChoose'); renderOptions(); }
        else { setPanel('pnWait'); setText($('wtTitle'), otherName() + ' está eligiendo palabra…'); }
        break;
      case 'draw':
        if (iDraw) { setPanel('pnDraw'); renderDrawer(); }
        else { setPanel('pnGuess'); renderGuesser(); }
        break;
      case 'reveal':
        setPanel('pnReveal');
        renderReveal();
        break;
      case 'end':
        setPanel('pnEnd');
        setText($('enScore'), dm.score);
        setText($('enRating'), dm.rating ? dm.rating.title : '');
        setText($('enSub'), dm.rating ? dm.rating.sub : '');
        if (!$('enAgain').getAttribute('data-sent')) { $('enAgain').disabled = false; setText($('enAgain'), 'Jugar otra vez'); }
        break;
    }
    if (dm.phase !== 'end') $('enAgain').removeAttribute('data-sent');
    updateTimers();
  }

  function renderOptions() {
    var box = $('chOpts');
    var key = opts ? JSON.stringify(opts.opts) : '';
    if (box.getAttribute('data-key') === key) return;
    box.setAttribute('data-key', key);
    if (!opts) { box.innerHTML = '<p class="k3" style="text-align:center">Cargando palabras…</p>'; return; }
    var html = '';
    for (var i = 0; i < opts.opts.length; i++) {
      var o = opts.opts[i];
      var tag = o.custom ? '<span class="tag secreta">secreta · de ' + esc(otherName()) + '</span>' : '<span class="tag ' + o.diff + '">' + DIFF_LABEL[o.diff] + '</span>';
      html += '<button type="button" class="opt" data-i="' + i + '">' + tag + '<b>' + esc(o.word) + '</b></button>';
    }
    box.innerHTML = html;
  }

  function feedHtml(list) {
    var html = '';
    for (var i = list.length - 1; i >= 0; i--) {
      var g = list[i];
      html += '<li class="' + g.res + '"><span>' + esc(g.text) + '</span><em>' + (g.res === 'ok' ? '¡SÍ!' : (g.res === 'casi' ? '¡CASI!' : 'NO')) + '</em></li>';
    }
    return html;
  }
  function setFeed(el, list) {
    var key = JSON.stringify(list || []);
    if (el.getAttribute('data-key') === key) return;
    el.setAttribute('data-key', key);
    el.innerHTML = feedHtml(list || []);
  }

  function renderDrawer() {
    if (secret) {
      setText($('dwWord'), secret.word);
      var tag = $('dwTag');
      tag.className = 'tag ' + (secret.custom ? 'secreta' : secret.diff);
      setText(tag, secret.custom ? 'secreta' : DIFF_LABEL[secret.diff]);
    }
    var skipBtn = $('tSkip');
    skipBtn.disabled = !(dm.skipsLeft > 0);
    setText(skipBtn, dm.skipsLeft > 0 ? 'Pasar palabra' : 'Ya has pasado');
    setText($('dwFeedLbl'), (dm.guesses && dm.guesses.length) ? ('Intentos de ' + otherName() + ':') : (otherName() + ' aún no ha escrito nada'));
    setFeed($('dwFeed'), dm.guesses);
  }

  function renderGuesser() {
    setText($('gLabel'), 'Adivina lo que dibuja ' + otherName() + ' en la tele');
    var h = dm.hint || '';
    var shown = Array.from(h).map(function (ch) { return ch === ' ' ? '  ' : ch.toUpperCase(); }).join(' ');
    setText($('gHint'), shown);
    var n = Array.from(h).length;
    $('gHint').style.fontSize = (n > 16 ? 22 : (n > 11 ? 26 : 34)) + 'px';
    setText($('gLetters'), dm.letters ? (dm.letters + ' letras') : '');
    setFeed($('gFeed'), dm.guesses);
  }

  function renderReveal() {
    var r = dm.last;
    if (!r) return;
    var t = $('rvTitle');
    setText(t, r.ok ? '¡Acertado!' : '¡Se acabó el tiempo!');
    t.style.color = r.ok ? 'var(--ok)' : 'var(--bad)';
    show($('rvEra'), !r.ok);
    setText($('rvWord'), r.word);
    setText($('rvPts'), r.ok ? ('+' + r.points + ' puntos para el equipo') : 'Sin puntos esta ronda');
  }

  function updateTimers() {
    if (!dm) return;
    var left = timeLeft();
    var sec = Math.max(0, Math.ceil(left / 1000 - 1e-6));
    var warn = dm.phase === 'draw' && sec <= 10;
    if (dm.phase === 'draw') {
      setText($('dwTime'), sec);
      setText($('gTime'), sec);
      if (warn) { $('dwTime').classList.add('warn'); $('gTime').classList.add('warn'); $('gBarWrap').classList.add('warn'); }
      else { $('dwTime').classList.remove('warn'); $('gTime').classList.remove('warn'); $('gBarWrap').classList.remove('warn'); }
      var frac = dm.total ? Math.max(0, Math.min(1, left / dm.total)) : 0;
      var tr = 'scaleX(' + frac.toFixed(3) + ')';
      $('gBar').style.transform = tr;
      $('gBar').style.webkitTransform = tr;
    } else if (dm.phase === 'choose') {
      setText($('chTime'), sec);
      setText($('wtTime'), sec + ' s');
    }
  }

  // ---- Guesses: Enter sends and the keyboard stays open
  function submitGuess() {
    var gInput = $('gInput');
    var v = String(gInput.value || '').replace(/\s+/g, ' ').trim();
    if (!v) return;
    if (sendMsg({ t: 'd.guess', text: v })) gInput.value = '';
    try { gInput.focus(); } catch (e) { /* noop */ }
  }

  function onGuessResult(g) {
    if (!dm) return;
    if (dm.drawer === slot()) {
      host.vibrate(g.res === 'casi' ? 40 : 10);
      return;
    }
    var fb = $('gFb');
    fb.className = 'fb on ' + g.res;
    setText(fb, g.res === 'casi' ? '¡Casi!' : 'No');
    clearTimeout(fbTimer);
    fbTimer = setTimeout(function () { fb.className = 'fb'; }, 1300);
    host.vibrate(g.res === 'casi' ? [20, 30, 20] : 25);
  }

  // ---- Drawer canvas (4:3, normalized 0..1 coordinates)
  function sizeCanvas() {
    var pn = $('pnDraw');
    if (pn.classList.contains('hidden')) return;
    var wrap = $('cwrap');
    var availW = wrap.clientWidth;
    var others = 0;
    var kids = pn.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] !== wrap && kids[i].id !== 'dwFeed') others += kids[i].offsetHeight + 8;
    }
    var availH = pn.clientHeight - others - 64; // leaves room for a few guesses
    var w = availW;
    if (w * 0.75 > availH) w = Math.max(160, availH / 0.75);
    w = Math.floor(w);
    var h = Math.round(w * 0.75);
    var d = Math.min(window.devicePixelRatio || 1, 3);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    cv.width = Math.round(w * d);
    cv.height = Math.round(h * d);
    cvW = cv.width; cvH = cv.height;
    redrawLocal();
  }

  function drawStrokeInc(ctx, st, W, H) {
    var p = st.p, n = Math.floor(p.length / 2);
    if (!n) return;
    ctx.strokeStyle = st.c;
    ctx.fillStyle = st.c;
    ctx.lineWidth = Math.max(1, st.w * W);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
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
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(p[i * 2] * W, p[i * 2 + 1] * H, (p[i * 2] + p[(i + 1) * 2]) / 2 * W, (p[i * 2 + 1] + p[(i + 1) * 2 + 1]) / 2 * H);
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
  function redrawLocal() {
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.fillStyle = '#ffffff';
    cctx.fillRect(0, 0, cvW, cvH);
    for (var i = 0; i < strokes.length; i++) { strokes[i].seg = undefined; drawStrokeInc(cctx, strokes[i], cvW, cvH); }
  }
  function setLocalStrokes(list) {
    strokes = [];
    var max = 0;
    for (var i = 0; i < list.length; i++) {
      strokes.push({ id: list[i].id, c: list[i].c, w: list[i].w, p: (list[i].p || []).slice() });
      if (list[i].id > max) max = list[i].id;
    }
    nextId = max + 1;
    cur = null;
    pending = null;
    redrawLocal();
  }

  // Sent in small batches (every ~40 ms) while drawing
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () { flushTimer = null; flushStroke(); }, 40);
  }
  function flushStroke() {
    if (!pending) return;
    if (!pending.p.length && !pending.end) return;
    sendMsg({ t: 'd.s', id: pending.id, c: pending.c, w: pending.w, p: pending.p, end: pending.end ? 1 : 0 });
    if (pending.end) pending = null;
    else pending.p = [];
  }
  function canDraw() { return dm && dm.phase === 'draw' && dm.drawer === slot() && !dm.paused; }
  function normPoint(clientX, clientY) {
    var r = cv.getBoundingClientRect();
    var x = (clientX - r.left) / Math.max(1, r.width);
    var y = (clientY - r.top) / Math.max(1, r.height);
    return [Math.round(Math.max(0, Math.min(1, x)) * 10000) / 10000, Math.round(Math.max(0, Math.min(1, y)) * 10000) / 10000];
  }
  function startStroke(clientX, clientY) {
    if (!canDraw()) return;
    if (pending) { pending.end = true; flushStroke(); }
    var pt = normPoint(clientX, clientY);
    var w = SIZES[tool.size] * (tool.eraser ? 2.5 : 1);
    cur = { id: nextId++, c: tool.eraser ? '#ffffff' : PALETTE[tool.color], w: w, p: [pt[0], pt[1]] };
    strokes.push(cur);
    pending = { id: cur.id, c: cur.c, w: cur.w, p: [pt[0], pt[1]], end: false };
    drawStrokeInc(cctx, cur, cvW, cvH);
    scheduleFlush();
  }
  function moveStroke(clientX, clientY) {
    if (!cur) return;
    var pt = normPoint(clientX, clientY);
    var n = cur.p.length;
    var dx = pt[0] - cur.p[n - 2], dy = (pt[1] - cur.p[n - 1]) * 0.75;
    if (dx * dx + dy * dy < 0.0025 * 0.0025) return;
    cur.p.push(pt[0], pt[1]);
    if (pending) pending.p.push(pt[0], pt[1]);
    drawStrokeInc(cctx, cur, cvW, cvH);
    scheduleFlush();
  }
  function endStroke() {
    if (!cur) return;
    cur = null;
    if (pending) { pending.end = true; clearTimeout(flushTimer); flushTimer = null; flushStroke(); }
  }

  function renderTools() {
    var sws = $('colors').children;
    for (var i = 0; i < sws.length; i++) {
      if (!tool.eraser && i === tool.color) sws[i].classList.add('on'); else sws[i].classList.remove('on');
    }
    var sz = document.querySelectorAll('.tb.size');
    for (var j = 0; j < sz.length; j++) {
      if (parseInt(sz[j].getAttribute('data-s'), 10) === tool.size) sz[j].classList.add('on'); else sz[j].classList.remove('on');
    }
    if (tool.eraser) $('tEraser').classList.add('on'); else $('tEraser').classList.remove('on');
  }

  function bindEvents() {
    $('chOpts').addEventListener('click', function (e) {
      var b = e.target;
      while (b && b !== this && !(b.classList && b.classList.contains('opt'))) b = b.parentNode;
      if (!b || b === this) return;
      var i = parseInt(b.getAttribute('data-i'), 10);
      sendMsg({ t: 'd.pick', i: i });
    });
    setInterval(function () { if (dm && isActive()) updateTimers(); }, 200);

    $('gForm').addEventListener('submit', function (e) { e.preventDefault(); submitGuess(); });
    // Keeps the field focused when tapping «Enviar» (so the iOS keyboard stays open)
    $('gSend').addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });
    $('gSend').addEventListener('touchend', function (e) { e.preventDefault(); submitGuess(); }, { passive: false });
    $('gSend').addEventListener('mousedown', function (e) { e.preventDefault(); });

    $('enAgain').addEventListener('click', function () {
      if (sendMsg({ t: 'd.again' })) {
        $('enAgain').disabled = true;
        $('enAgain').setAttribute('data-sent', '1');
        setText($('enAgain'), '¡Allá vamos!');
      }
    });

    window.addEventListener('resize', function () { setTimeout(sizeCanvas, 50); });
    window.addEventListener('orientationchange', function () { setTimeout(sizeCanvas, 300); });

    var drawTouch = null;
    cv.addEventListener('touchstart', function (e) {
      e.preventDefault();
      if (drawTouch !== null || !e.changedTouches.length) return;
      var t = e.changedTouches[0];
      drawTouch = t.identifier;
      startStroke(t.clientX, t.clientY);
    }, { passive: false });
    cv.addEventListener('touchmove', function (e) {
      e.preventDefault();
      if (drawTouch === null) return;
      var t = findTouch(e.touches, drawTouch);
      if (t) moveStroke(t.clientX, t.clientY);
    }, { passive: false });
    function endDrawTouch(e) {
      e.preventDefault();
      if (drawTouch !== null && findTouch(e.changedTouches, drawTouch)) { drawTouch = null; endStroke(); }
    }
    cv.addEventListener('touchend', endDrawTouch, { passive: false });
    cv.addEventListener('touchcancel', endDrawTouch, { passive: false });
    var drawMouse = false;
    cv.addEventListener('mousedown', function (e) { drawMouse = true; startStroke(e.clientX, e.clientY); });
    window.addEventListener('mousemove', function (e) { if (drawMouse) moveStroke(e.clientX, e.clientY); });
    window.addEventListener('mouseup', function () { if (drawMouse) { drawMouse = false; endStroke(); } });

    // Tools
    var html = '';
    for (var i = 0; i < PALETTE.length; i++) html += '<button type="button" class="sw" data-c="' + i + '" style="background:' + PALETTE[i] + '" aria-label="Color ' + (i + 1) + '"></button>';
    $('colors').innerHTML = html;
    $('colors').addEventListener('click', function (e) {
      var b = e.target;
      if (!b || !b.getAttribute('data-c')) return;
      tool.color = parseInt(b.getAttribute('data-c'), 10);
      tool.eraser = false;
      renderTools();
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tb.size'), function (b) {
      b.addEventListener('click', function () { tool.size = parseInt(b.getAttribute('data-s'), 10); renderTools(); });
    });
    $('tEraser').addEventListener('click', function () { tool.eraser = !tool.eraser; renderTools(); });
    $('tUndo').addEventListener('click', function () {
      if (!canDraw() || cur || !strokes.length) return;
      var st = strokes.pop();
      redrawLocal();
      sendMsg({ t: 'd.undo', id: st.id });
    });
    $('tClear').addEventListener('click', function () {
      if (!canDraw() || !strokes.length) return;
      host.askConfirm('¿Borrar todo el dibujo?', 'Sí, borrar', function () {
        strokes = [];
        cur = null;
        pending = null;
        redrawLocal();
        sendMsg({ t: 'd.clear' });
      });
    });
    $('tSkip').addEventListener('click', function () {
      if (!canDraw() || !(dm.skipsLeft > 0)) return;
      host.askConfirm('¿Pasar palabra? Te daremos otra (esta no suma puntos). Solo una vez por ronda.', 'Sí, otra', function () {
        sendMsg({ t: 'd.skip' });
      });
    });
    renderTools();
  }

  // ---- Menu panel: «Palabras secretas para tu pareja»
  function renderWords() {
    setText($('wCount'), myWords.length + '/' + maxWords);
    var html = '';
    for (var i = 0; i < myWords.length; i++) {
      html += '<li><span>' + esc(myWords[i]) + '</span><button type="button" data-i="' + i + '" aria-label="Quitar">✕</button></li>';
    }
    $('wList').innerHTML = html;
    var full = myWords.length >= maxWords;
    $('wAdd').disabled = full;
    $('wInput').disabled = full;
    $('wInput').placeholder = full ? 'Máximo ' + maxWords + ' palabras' : 'Ej.: la siesta del domingo';
  }

  var menuPanel = {
    mount: function (el) {
      el.innerHTML = MENU_HTML;
      $('wForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var v = String($('wInput').value || '').replace(/\s+/g, ' ').trim();
        if (!v) return;
        if (myWords.length >= maxWords) { host.toast('Máximo ' + maxWords + ' palabras'); return; }
        var list = myWords.concat([v]);
        if (sendMsg({ t: 'd.words', list: list })) {
          $('wInput').value = '';
          myWords = list;
          renderWords();
        }
      });
      $('wList').addEventListener('click', function (e) {
        var b = e.target;
        if (!b || b.tagName !== 'BUTTON') return;
        var i = parseInt(b.getAttribute('data-i'), 10);
        var list = myWords.slice();
        list.splice(i, 1);
        if (sendMsg({ t: 'd.words', list: list })) { myWords = list; renderWords(); }
      });
    },
    render: function () {
      var o = host.hub() && host.hub().players ? host.hub().players[slot() === 1 ? 1 : 0] : null;
      setText($('wHelp'), 'Saldrán en «Dibuja y adivina» cuando le toque dibujar a ' + (o ? o.name : 'tu pareja') + '. Solo las ves tú.');
      renderWords();
    },
    onMessage: function (msg) {
      if (msg.t !== 'd.words') return false;
      myWords = msg.list || [];
      maxWords = msg.max || 10;
      renderWords();
      return true;
    }
  };

  G2T.phone.register({
    id: 'dibuja',
    menuPanel: menuPanel,
    mount: function (section, h) {
      host = h;
      show = h.show;
      setText = h.setText;
      section.innerHTML = HTML;
      var pause = document.createElement('div');
      pause.id = 'dPause';
      pause.className = 'over hidden';
      pause.innerHTML = PAUSE_HTML;
      h.app.insertBefore(pause, $('modal'));
      cv = $('dcv');
      cctx = cv.getContext('2d');
      bindEvents();
    },
    // Screen changed to something else
    reset: function () { dm = null; opts = null; secret = null; strokes = []; },
    onHide: function () { show($('dPause'), false); },
    render: function () { renderDibuja(); },
    onMessage: function (msg) {
      switch (msg.t) {
        case 'dmeta': onDmeta(msg); break;
        case 'd.opts': opts = msg; renderDibuja(); break;
        case 'd.secret':
          if (!secret || secret.round !== msg.round) { strokes = []; nextId = 1; }
          secret = msg;
          renderDibuja();
          break;
        case 'd.all': setLocalStrokes(msg.strokes || []); break;
        case 'd.g': onGuessResult(msg); break;
        case 'd.skip': if (dm && dm.drawer !== slot()) host.toast('¡Palabra nueva!'); break;
        case 'd.hint': if (dm && dm.drawer !== slot()) host.toast('¡Pista! Una letra más'); break;
        case 'd.reveal': host.vibrate(msg.ok ? [30, 40, 30] : 60); break;
      }
    }
  });
})();
