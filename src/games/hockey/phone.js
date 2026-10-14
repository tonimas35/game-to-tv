/*
 * «Hockey de mesa»: phone view (LANDSCAPE). Loaded by public/m.html (ES2019).
 * The phone shows a mini version of YOUR half of the table, in the same
 * orientation as the TV (the left player sees their goal on the left, the
 * right player on the right). Drag a finger anywhere on the pad: the mallet
 * target is the finger position over that half (absolute). The mallet is
 * drawn where the finger is (optimistic); the server moves the real one there
 * at a high, capped speed. The puck is not shown: look at the TV.
 * Inputs go out at most ~60 times per second and only when they change.
 * In portrait a «Gira el móvil» hint replaces the pad.
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var $ = G2T.$, esc = G2T.esc, now = G2T.now, clamp = G2T.clamp, findTouch = G2T.findTouch;
  var host = null, show, setText;
  var F = { w: 1720, h: 860, puckR: 28, malletR: 46, goalW: 260, goalY0: 300, goalY1: 560 };
  var MIN_SEND_MS = 15;

  var HTML =
    '<div class="hkWrap" id="hkWrap">' +
    '  <div class="hkSide">' +
    '    <div class="chip"><span class="dot"></span><span class="meName">Jugador</span></div>' +
    '    <div class="hkScore"><b id="hkMe">0</b><i>–</i><b id="hkRiv">0</b></div>' +
    '    <div class="hkVs fit" id="hkVs">contra…</div>' +
    '    <div class="hkStatus" id="hkStatus">Preparados…</div>' +
    '    <div class="hkBtns"><button class="mini ghost hkHelpBtn" type="button" aria-label="Cómo se juega">?</button>' +
    '    <button class="mini ghost menuBtn" type="button">Menú</button></div>' +
    '  </div>' +
    '  <div class="hkPad" id="hkPad"><canvas id="hkCv"></canvas></div>' +
    '  <div class="hkWatch hidden" id="hkWatch"><b>Estás mirando</b><span>Juegan dos. Entrarás si alguien deja su sitio. ¡Mira la tele!</span></div>' +
    '</div>' +
    '<div class="hkRotate" id="hkRotate">' +
    '  <div class="hkPhone"><i></i></div>' +
    '  <b>Gira el móvil</b>' +
    '  <span>Se juega en horizontal: verás tu mitad de la mesa.</span>' +
    '  <span class="hkRotSt" id="hkRotSt"></span>' +
    '  <button class="mini ghost menuBtn" type="button">Menú</button>' +
    '</div>';

  var OVER_HTML =
    '<div class="t1" id="hkOverT">¡Has ganado!</div>' +
    '<div class="hkOverS" id="hkOverS"></div>' +
    '<div class="t2" id="hkOverSub"></div>' +
    '<div class="hkOverB"><button class="bigbtn c" id="hkAgain" type="button">Otra</button>' +
    '<button class="bigbtn ghost menuBtn" type="button">Menú</button></div>';
  var PAUSE_HTML = '<div class="t1">Pausa</div><div class="t2" id="hkPauseWho" style="font-size:22px;font-weight:800;color:#fff">Esperando…</div><div class="t2">El disco está parado hasta que vuelva.</div>';
  var HELP_HTML = '<div class="hkHelpBox"><h2>Cómo se juega</h2><ol id="hkHelpList"></ol><button type="button" class="bigbtn c" id="hkHelpOk">Entendido</button></div>';

  var M = null;
  var pad, cv, cx2;
  var box = { x: 0, y: 0, w: 1, h: 1, cssW: 1, cssH: 1, dpr: 1 };
  var pos = { x: 0.24, y: 0.5 };          // my mallet over my half (0..1), optimistic
  var touchId = null, mouseDown = false, touching = false;
  var sent = { x: -1, y: -1, at: 0, n: 0 }, sendQueued = false, sendTimer = null;
  var drawQueued = false;

  function me() { return host.slot(); }
  function isActive() { var h = host.hub(); return !!(h && h.screen === 'hockey'); }
  // 0 left, 1 right, -1 watching
  function mySide() { return M && M.players ? M.players.indexOf(me()) : -1; }
  function rivalSide() { return 1 - Math.max(0, mySide()); }
  function rivalName() { return M && M.players ? host.nameOf(M.players[rivalSide()]) : host.otherName(); }
  function lim() {
    var hw = F.w / 2;
    return { x0: F.malletR / hw, x1: 1 - F.malletR / hw, y0: F.malletR / F.h, y1: 1 - F.malletR / F.h };
  }
  function setPos(u, v) {
    var l = lim();
    pos.x = clamp(u, l.x0, l.x1);
    pos.y = clamp(v, l.y0, l.y1);
  }

  // ------------------------------------------------------------ input
  function flushSend() {
    sendQueued = false;
    if (!host.isJoined() || !isActive() || mySide() < 0) return;
    var x = Math.round(pos.x * 1000) / 1000, y = Math.round(pos.y * 1000) / 1000;
    if (x === sent.x && y === sent.y) return;
    var wait = MIN_SEND_MS - (now() - sent.at);
    if (wait > 0) {
      // at most ~60 per second: try again a bit later
      if (!sendTimer) sendTimer = setTimeout(function () { sendTimer = null; flushSend(); }, wait);
      return;
    }
    if (host.send({ t: 'h.m', x: x, y: y })) { sent.x = x; sent.y = y; sent.at = now(); sent.n++; }
  }
  function queueSend() {
    if (sendQueued) return;
    sendQueued = true;
    G2T.raf(flushSend);
  }
  function fromClient(cx, cy, immediate) {
    var r = pad.getBoundingClientRect();
    setPos((cx - r.left - box.x) / box.w, (cy - r.top - box.y) / box.h);
    queueDraw();
    if (immediate) flushSend(); else queueSend();
  }
  function bindPad() {
    pad.addEventListener('touchstart', function (e) {
      e.preventDefault();
      if (touchId === null && e.changedTouches.length) {
        var t = e.changedTouches[0];
        touchId = t.identifier;
        touching = true;
        fromClient(t.clientX, t.clientY, true);
      }
    }, { passive: false });
    pad.addEventListener('touchmove', function (e) {
      e.preventDefault();
      var t = touchId === null ? e.touches[0] : findTouch(e.touches, touchId);
      if (t) fromClient(t.clientX, t.clientY, false);
    }, { passive: false });
    function end(e) {
      e.preventDefault();
      if (touchId !== null && findTouch(e.changedTouches, touchId)) {
        touchId = null;
        if (e.touches.length) { touchId = e.touches[0].identifier; fromClient(e.touches[0].clientX, e.touches[0].clientY, true); }
        else { touching = false; queueDraw(); }
      }
    }
    pad.addEventListener('touchend', end, { passive: false });
    pad.addEventListener('touchcancel', end, { passive: false });
    // Mouse (a computer, the tests)
    pad.addEventListener('mousedown', function (e) { mouseDown = true; touching = true; fromClient(e.clientX, e.clientY, true); });
    window.addEventListener('mousemove', function (e) { if (mouseDown) fromClient(e.clientX, e.clientY, false); });
    window.addEventListener('mouseup', function () { if (mouseDown) { mouseDown = false; touching = false; queueDraw(); } });
    window.addEventListener('resize', layoutPad);
    window.addEventListener('orientationchange', function () { setTimeout(layoutPad, 300); });
  }

  // ------------------------------------------------------------ the mini table
  function layoutPad() {
    if (!pad || !isActive()) return;
    var r = pad.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    box.cssW = r.width;
    box.cssH = r.height;
    box.dpr = dpr;
    cv.style.width = r.width + 'px';
    cv.style.height = r.height + 'px';
    cv.width = Math.round(r.width * dpr);
    cv.height = Math.round(r.height * dpr);
    var aspect = (F.w / 2) / F.h;
    var m = 10;
    var w = Math.min(r.width - 2 * m, (r.height - 2 * m) * aspect);
    box.w = Math.max(10, w);
    box.h = box.w / aspect;
    box.x = (r.width - box.w) / 2;
    box.y = (r.height - box.h) / 2;
    draw();
  }
  function queueDraw() {
    if (drawQueued) return;
    drawQueued = true;
    G2T.raf(function () { drawQueued = false; draw(); });
  }
  function rr(c, x, y, w, h, r) {
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
  function draw() {
    if (!cx2 || !isActive()) return;
    var c = cx2, side = Math.max(0, mySide());
    var col = host.myColor() || '#22e6ff';
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    c.setTransform(box.dpr, 0, 0, box.dpr, 0, 0);
    var x = box.x, y = box.y, w = box.w, h = box.h;
    var k = w / (F.w / 2);                     // table units -> css px
    // Rail and ice
    rr(c, x - 8, y - 8, w + 16, h + 16, 14);
    c.fillStyle = '#1d2456';
    c.fill();
    c.fillStyle = '#e6f1f9';
    c.fillRect(x, y, w, h);
    var goalX = side === 0 ? x : x + w;        // my goal: the outer edge
    var midX = side === 0 ? x + w : x;         // the centre line: the inner edge
    // Goal mouth and crease
    c.fillStyle = '#020309';
    c.fillRect(side === 0 ? x - 8 : x + w, y + F.goalY0 * k, 8, F.goalW * k);
    c.beginPath();
    c.arc(goalX, y + h / 2, 190 * k, side === 0 ? -Math.PI / 2 : Math.PI / 2, side === 0 ? Math.PI / 2 : Math.PI * 1.5);
    c.closePath();
    c.fillStyle = G2T.hexA(col, 0.18);
    c.fill();
    c.lineWidth = 3;
    c.strokeStyle = col;
    c.stroke();
    // Centre line and half circle
    c.fillStyle = '#e14a5c';
    c.fillRect(midX - 2, y, 4, h);
    c.beginPath();
    c.arc(midX, y + h / 2, 120 * k, side === 0 ? Math.PI / 2 : -Math.PI / 2, side === 0 ? Math.PI * 1.5 : Math.PI / 2);
    c.lineWidth = 3;
    c.strokeStyle = 'rgba(225,74,92,0.8)';
    c.stroke();
    // My mallet
    var mx = x + pos.x * w, my = y + pos.y * h, r = F.malletR * k;
    if (touching) {
      c.beginPath();
      c.arc(mx, my, r * 1.7, 0, Math.PI * 2);
      c.fillStyle = G2T.hexA(col, 0.18);
      c.fill();
    }
    c.beginPath();
    c.arc(mx, my, r, 0, Math.PI * 2);
    c.fillStyle = col;
    c.fill();
    c.lineWidth = 3;
    c.strokeStyle = '#0b1030';
    c.stroke();
    c.beginPath();
    c.arc(mx, my, r * 0.3, 0, Math.PI * 2);
    c.fillStyle = '#0b1030';
    c.fill();
  }

  // ------------------------------------------------------------ render
  function render() {
    if (!M || !isActive()) return;
    if (M.field) F = M.field;
    var side = mySide();
    var watching = side < 0;
    var wrap = $('hkWrap');
    wrap.className = 'hkWrap' + (side === 1 ? ' right' : '');
    show($('hkPad'), !watching);
    show($('hkWatch'), watching);
    var sc = M.score || [0, 0];
    var c = host.colors();
    if (!watching) {
      setText($('hkMe'), sc[side]);
      setText($('hkRiv'), sc[1 - side]);
      $('hkMe').style.color = c[M.players[side] - 1] || '#fff';
      $('hkRiv').style.color = c[M.players[1 - side] - 1] || '#fff';
      setText($('hkVs'), 'contra ' + rivalName());
    } else {
      setText($('hkMe'), sc[0]);
      setText($('hkRiv'), sc[1]);
      $('hkMe').style.color = c[M.players[0] - 1] || '#fff';
      $('hkRiv').style.color = c[M.players[1] - 1] || '#fff';
      setText($('hkVs'), host.nameOf(M.players[0]) + ' – ' + host.nameOf(M.players[1]));
    }
    var st = '';
    switch (M.phase) {
      case 'countdown': st = ((sc[0] + sc[1]) > 0 ? 'Seguimos en ' : 'Empieza en ') + M.countdown + '…'; break;
      case 'playing': st = watching ? '¡A jugar!' : '¡A jugar! Tu portería, a la ' + (side === 0 ? 'izquierda' : 'derecha'); break;
      case 'goal':
        if (watching) st = 'Gol de ' + host.nameOf(M.players[M.lastScorer - 1]);
        else st = M.lastScorer === side + 1 ? '¡Gol tuyo!' : 'Gol de ' + rivalName();
        break;
      case 'paused': st = 'Pausa'; break;
      case 'end': st = 'Fin de la partida'; break;
    }
    setText($('hkStatus'), st);
    setText($('hkRotSt'), (watching ? '' : sc[side] + ' – ' + sc[1 - side] + ' · ') + st);
    show($('hkPause'), M.phase === 'paused');
    if (M.phase === 'paused') setText($('hkPauseWho'), 'Esperando a ' + (M.waiting && M.waiting.length ? G2T.joinNames(M.waiting) : rivalName()) + '…');
    var over = M.phase === 'end';
    show($('hkOver'), over);
    if (over) {
      var won = !watching && M.winner === side + 1;
      var wName = host.nameOf(M.players[M.winner - 1]);
      setText($('hkOverT'), watching ? '¡Gana ' + wName + '!' : (won ? '¡Has ganado!' : 'Has perdido'));
      $('hkOverT').style.color = won ? host.myColor() : '#ffffff';
      $('hkOverS').innerHTML = '<span style="color:' + (c[M.players[0] - 1] || '#fff') + '">' + sc[0] + '</span> – <span style="color:' + (c[M.players[1] - 1] || '#fff') + '">' + sc[1] + '</span>';
      setText($('hkOverSub'), watching ? '' : (won ? 'Le has ganado a ' + rivalName() : 'Gana ' + rivalName() + '. ¿Otra?'));
      if (!$('hkAgain').getAttribute('data-sent')) { $('hkAgain').disabled = false; setText($('hkAgain'), 'Otra'); }
    } else {
      $('hkAgain').removeAttribute('data-sent');
    }
    layoutPad();
  }

  function openHelp() {
    var g = G2T.gameById('hockey') || {};
    var lines = g.howTo || [g.description || ''];
    $('hkHelpList').innerHTML = lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('');
    show($('hkHelp'), true);
  }

  G2T.phone.register({
    id: 'hockey',
    mount: function (section, h, game) {
      host = h;
      show = h.show;
      setText = h.setText;
      if (game && game.tv && game.tv.field) F = game.tv.field;
      section.innerHTML = HTML;
      function layer(id, cls, html) {
        var el = document.createElement('div');
        el.id = id;
        el.className = cls;
        el.innerHTML = html;
        h.app.insertBefore(el, $('modal'));
        return el;
      }
      layer('hkOver', 'over hidden', OVER_HTML);
      layer('hkPause', 'over hidden', PAUSE_HTML);
      layer('hkHelp', 'over scroll hidden', HELP_HTML);
      pad = $('hkPad');
      cv = $('hkCv');
      cx2 = cv.getContext('2d');
      $('hkAgain').addEventListener('click', function () {
        if (host.send({ t: 'h.again' })) {
          $('hkAgain').disabled = true;
          $('hkAgain').setAttribute('data-sent', '1');
          setText($('hkAgain'), '¡Allá vamos!');
        }
      });
      section.querySelector('.hkHelpBtn').addEventListener('click', openHelp);
      $('hkHelpOk').addEventListener('click', function () { show($('hkHelp'), false); });
      bindPad();
    },
    onJoined: function () { sent.x = -1; sent.y = -1; },
    reset: function () { M = null; touchId = null; touching = false; mouseDown = false; },
    onHide: function () { show($('hkOver'), false); show($('hkPause'), false); show($('hkHelp'), false); },
    render: function () { render(); setTimeout(layoutPad, 0); },
    onMessage: function (msg) {
      if (msg.t === 'hmeta') {
        var prev = M;
        M = msg;
        if (!prev || prev.match !== M.match) { sent.x = -1; sent.y = -1; }
        render();
        return;
      }
      if (msg.t === 'h.you') {
        // Where the server has my mallet (after a reconnection): only if I am not touching
        if (!touching) { setPos(Number(msg.x) || 0, Number(msg.y) || 0); sent.x = Math.round(pos.x * 1000) / 1000; sent.y = Math.round(pos.y * 1000) / 1000; queueDraw(); }
        return;
      }
      if (msg.t === 'ev' && M) {
        var side = mySide();
        if (msg.k === 'hit' && msg.side === side + 1) host.vibrate(12);
        if (msg.k === 'goal') host.vibrate(msg.side === side + 1 ? [30, 40, 30] : 60);
      }
    },
    // For automated tests
    state: function () {
      return { meta: M, side: mySide(), pos: { x: pos.x, y: pos.y }, sent: sent.n, box: { x: box.x, y: box.y, w: box.w, h: box.h } };
    }
  });
})();
