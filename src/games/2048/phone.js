/*
 * «2048»: phone view. Loaded by public/m.html (ES2019).
 * A big swipe area with 4 large arrow buttons around a small copy of the
 * board (handy when the TV is far, and after a reconnection), the score and
 * the «Récord», «Nueva partida» (1 player, with confirmation) and «?».
 * Tiny swipes are ignored; the page never scrolls or zooms while playing.
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var $ = G2T.$, esc = G2T.esc, now = G2T.now;
  var host = null, show, setText;

  var SWIPE_MIN = 30;    // px: shorter swipes are ignored (unless it is a tap on an arrow)
  var TAP_MAX = 14;      // px: a tap may wobble this much

  var HTML =
    '<div class="bar">' +
    '  <div class="chip"><span class="dot"></span><span class="meName">Jugador</span></div>' +
    '  <div class="info" id="npInfo">2048</div>' +
    '  <button class="mini ghost npHelpBtn" type="button" aria-label="Cómo se juega">?</button>' +
    '  <button class="mini ghost menuBtn" type="button">Menú</button>' +
    '</div>' +
    '<div class="npScores">' +
    '  <div class="npBox"><small>PUNTOS</small><b id="npScore">0</b></div>' +
    '  <div class="npBox"><small id="npBestL">RÉCORD</small><b id="npBest">0</b></div>' +
    '</div>' +
    // Main: the pad
    '<div class="npMain" id="npMain">' +
    '  <div class="npPad" id="npPad">' +
    '    <button type="button" class="npArrow npUp" data-dir="up" aria-label="Arriba">▲</button>' +
    '    <button type="button" class="npArrow npLeft" data-dir="left" aria-label="Izquierda">◀</button>' +
    '    <div class="npBoard" id="npBoard"></div>' +
    '    <button type="button" class="npArrow npRight" data-dir="right" aria-label="Derecha">▶</button>' +
    '    <button type="button" class="npArrow npDown" data-dir="down" aria-label="Abajo">▼</button>' +
    '  </div>' +
    '  <p class="npHint" id="npHint">Desliza el dedo o toca las flechas</p>' +
    '  <button type="button" class="ghost npNew" id="npNew">Nueva partida</button>' +
    '</div>' +
    // Panels
    '<div class="pn npPanel center hidden" id="npOver">' +
    '  <div class="npT1">Sin movimientos</div>' +
    '  <div class="npT2" id="npOverPts">0 puntos</div>' +
    '  <p class="npT3" id="npOverSub"></p>' +
    '  <button type="button" class="bigbtn c" id="npAgain">Otra</button>' +
    '  <button type="button" class="bigbtn ghost menuBtn npSecond">Menú</button>' +
    '</div>' +
    '<div class="pn npPanel center hidden" id="npCele">' +
    '  <div class="npT1 npGold">¡Lo conseguiste!</div>' +
    '  <div class="npT2">Has llegado a 2048</div>' +
    '  <p class="npT3">Puedes seguir jugando para sumar más puntos.</p>' +
    '  <button type="button" class="bigbtn c" id="npCont">Seguir jugando</button>' +
    '</div>' +
    '<div class="pn npPanel center hidden" id="npIntro">' +
    '  <div class="npT2">¡Carrera de 2048!</div>' +
    '  <div class="npCount" id="npIntroNum">3</div>' +
    '  <p class="npT3">Gana quien más puntos tenga</p>' +
    '</div>' +
    '<div class="pn npPanel center hidden" id="npWatch">' +
    '  <div class="npT2">Estás mirando</div>' +
    '  <p class="npT3">Entrarás en la próxima partida. ¡Mira la tele!</p>' +
    '</div>' +
    '<div class="pn npPanel center scroll hidden" id="npEnd">' +
    '  <p class="npT3">¡Fin de la carrera!</p>' +
    '  <div class="npT1" id="npEndPos">—</div>' +
    '  <ol class="npRank" id="npRank"></ol>' +
    '  <button type="button" class="bigbtn c" id="npEndAgain">Otra carrera</button>' +
    '  <button type="button" class="bigbtn ghost menuBtn npSecond">Menú</button>' +
    '</div>';

  var PAUSE_HTML = '<div class="t1">Pausa</div><div class="t2" id="npPauseWho" style="font-size:24px;font-weight:800;color:#fff">Esperando…</div><div class="t2">El reloj está parado hasta que vuelva.</div>';
  var HELP_HTML = '<div class="npHelpBox"><h2>Cómo se juega</h2><ol id="npHelpList"></ol><button type="button" class="bigbtn c" id="npHelpOk">Entendido</button></div>';

  var M = null, metaAt = 0;
  var touch = null, lastTouchAt = 0, mouse = null;

  function me() { return host.slot(); }
  function myBoard() {
    if (!M) return null;
    for (var i = 0; i < M.boards.length; i++) if (M.boards[i].slot === me()) return M.boards[i];
    return null;
  }
  function isActive() { var h = host.hub(); return !!(h && h.screen === '2048'); }
  function clockLeft() {
    if (!M) return 0;
    if (M.paused || M.phase !== 'play') return M.clock;
    return Math.max(0, M.clock - (now() - metaAt) * (M.speed || 1));
  }
  function mmss(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000 - 1e-6));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  // ---------------------------------------------------------------- moves
  function canPlay() {
    var b = myBoard();
    return !!(M && b && M.phase === 'play' && !b.over && !b.cele && !(M.mode === 'race' && M.paused));
  }
  function send(dir) {
    if (!canPlay()) return;
    if (host.send({ t: 'n.move', dir: dir })) host.vibrate(12);
  }
  function dirOf(dx, dy) {
    var ax = Math.abs(dx), ay = Math.abs(dy);
    if (Math.max(ax, ay) < SWIPE_MIN) return null;
    if (ax > ay * 1.2) return dx > 0 ? 'right' : 'left';
    if (ay > ax * 1.2) return dy > 0 ? 'down' : 'up';
    return null;                       // a diagonal: we cannot tell
  }
  function buttonDir(el) {
    while (el && el !== document.body) {
      if (el.getAttribute && el.getAttribute('data-dir')) return el.getAttribute('data-dir');
      el = el.parentNode;
    }
    return null;
  }
  function finish(x, y) {
    if (!touch) return;
    var dx = x - touch.x, dy = y - touch.y;
    var d = dirOf(dx, dy);
    if (d) send(d);
    else if (touch.btn && Math.abs(dx) <= TAP_MAX && Math.abs(dy) <= TAP_MAX) send(touch.btn);
    touch = null;
  }
  function bindPad() {
    var pad = $('npPad');
    pad.addEventListener('touchstart', function (e) {
      e.preventDefault();
      lastTouchAt = now();
      if (e.touches.length > 1) { touch = null; return; }   // two fingers: nothing (and no zoom)
      var t = e.changedTouches[0];
      touch = { id: t.identifier, x: t.clientX, y: t.clientY, btn: buttonDir(e.target) };
    }, { passive: false });
    pad.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    pad.addEventListener('touchend', function (e) {
      e.preventDefault();               // no click, no double-tap zoom
      lastTouchAt = now();
      if (!touch) return;
      var t = G2T.findTouch(e.changedTouches, touch.id);
      if (t) finish(t.clientX, t.clientY);
    }, { passive: false });
    pad.addEventListener('touchcancel', function () { touch = null; });
    // Mouse (a computer, the tests): the same, ignoring the mouse events that follow a touch
    pad.addEventListener('mousedown', function (e) {
      if (now() - lastTouchAt < 500) return;
      e.preventDefault();
      mouse = true;
      touch = { x: e.clientX, y: e.clientY, btn: buttonDir(e.target) };
    });
    window.addEventListener('mouseup', function (e) {
      if (!mouse) return;
      mouse = false;
      finish(e.clientX, e.clientY);
    });
  }

  // ---------------------------------------------------------------- render
  function renderBoard(b) {
    var cells = new Array(16);
    var t = b ? b.tiles : [];
    for (var i = 0; i < t.length; i += 4) cells[t[i + 2]] = t[i + 1];
    var html = '';
    for (var c = 0; c < 16; c++) {
      var v = cells[c];
      html += v ? '<i class="v' + (v <= 2048 ? v : 'big') + (String(v).length > 3 ? ' l4' : (String(v).length === 3 ? ' l3' : '')) + '">' + v + '</i>' : '<i></i>';
    }
    var el = $('npBoard');
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  function panelOf() {
    var b = myBoard();
    if (!b) return 'watch';
    if (M.phase === 'end') return 'end';
    if (M.phase === 'intro') return 'intro';
    if (b.cele) return 'cele';
    if (b.over) return 'over';
    return 'main';
  }

  function renderEnd() {
    var rk = M.ranking || [];
    var mine = null;
    rk.forEach(function (r) { if (r.slot === me()) mine = r; });
    var winners = rk.filter(function (r) { return r.rank === 1; });
    var pos = $('npEndPos');
    setText(pos, mine && mine.rank === 1 ? (winners.length > 1 ? '¡Empate en cabeza!' : '¡Has ganado!') : (mine ? mine.rank + 'º puesto' : 'Fin'));
    pos.style.color = mine && mine.rank === 1 ? 'var(--ok)' : '';
    var html = '';
    rk.forEach(function (r) {
      var col = host.colors()[r.slot - 1] || '#fff';
      html += '<li class="' + (r.slot === me() ? 'me' : '') + '"><span class="md m' + Math.min(r.rank, 4) + '">' + r.rank + '</span><b style="color:' + col + '">' + esc(host.nameOf(r.slot)) + '</b><i>' + r.score + '</i></li>';
    });
    if ($('npRank').innerHTML !== html) $('npRank').innerHTML = html;
  }

  function render() {
    if (!M || !isActive()) return;
    var b = myBoard();
    var p = panelOf();
    show($('npMain'), p === 'main');
    show($('npOver'), p === 'over');
    show($('npCele'), p === 'cele');
    show($('npIntro'), p === 'intro');
    show($('npWatch'), p === 'watch');
    show($('npEnd'), p === 'end');
    show(document.querySelector('#scr-2048 .npScores'), !!b && p !== 'end');
    show($('npNew'), M.mode === 'solo');
    show($('npPause'), !!M.paused && M.phase !== 'end');
    if (M.paused) setText($('npPauseWho'), 'Esperando a ' + (M.waiting.length ? G2T.joinNames(M.waiting) : 'alguien') + '…');
    if (b) {
      setText($('npScore'), b.score);
      setText($('npBest'), b.best);
      setText($('npBestL'), b.rec ? '¡NUEVO RÉCORD!' : 'RÉCORD');
      renderBoard(b);
      setText($('npOverPts'), b.score + ' puntos');
      if (M.mode === 'solo') {
        setText($('npOverSub'), b.rec ? '¡Nuevo récord!' : 'Tu récord: ' + b.best);
        show($('npAgain'), true);
        show(document.querySelector('#npOver .npSecond'), true);
      } else {
        setText($('npOverSub'), 'Espera a que terminen los demás. ¡Mira la tele!');
        show($('npAgain'), false);
        show(document.querySelector('#npOver .npSecond'), false);
      }
    }
    if (p === 'end') renderEnd();
    updateInfo();
  }

  function updateInfo() {
    if (!M) return;
    var txt = M.mode === 'race' ? (M.phase === 'end' ? 'Final' : mmss(clockLeft())) : 'A solas';
    setText($('npInfo'), txt);
    if (M.phase === 'intro') {
      var l = M.paused ? M.left : Math.max(0, M.left - (now() - metaAt) * (M.speed || 1));
      setText($('npIntroNum'), String(Math.max(1, Math.ceil(l / 1000 - 1e-6))));
    }
  }

  function openHelp() {
    var g = G2T.gameById('2048') || {};
    var lines = g.howTo || [g.description || ''];
    $('npHelpList').innerHTML = lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('');
    show($('npHelp'), true);
  }

  // ---------------------------------------------------------------- mount
  G2T.phone.register({
    id: '2048',
    mount: function (section, h) {
      host = h;
      show = h.show;
      setText = h.setText;
      section.innerHTML = HTML;
      var pause = document.createElement('div');
      pause.id = 'npPause';
      pause.className = 'over hidden';
      pause.innerHTML = PAUSE_HTML;
      h.app.insertBefore(pause, $('modal'));
      var help = document.createElement('div');
      help.id = 'npHelp';
      help.className = 'over scroll hidden';
      help.innerHTML = HELP_HTML;
      h.app.insertBefore(help, $('modal'));
      $('npHelpOk').addEventListener('click', function () { show($('npHelp'), false); });
      section.querySelector('.npHelpBtn').addEventListener('click', openHelp);
      bindPad();
      $('npNew').addEventListener('click', function () {
        host.askConfirm('¿Empezar una partida nueva? Se perderá esta (el récord se guarda).', 'Sí, nueva', function () { host.send({ t: 'n.new' }); });
      });
      $('npAgain').addEventListener('click', function () { host.send({ t: 'n.new' }); });
      $('npEndAgain').addEventListener('click', function () { host.send({ t: 'n.new' }); });
      $('npCont').addEventListener('click', function () { host.send({ t: 'n.cont' }); });
      setInterval(function () { if (M && isActive()) updateInfo(); }, 250);
    },
    reset: function () { M = null; touch = null; },
    onHide: function () { show($('npPause'), false); show($('npHelp'), false); },
    render: function () { render(); },
    onMessage: function (msg) {
      if (msg.t === 'nmeta') {
        var prev = myBoard();
        M = msg;
        metaAt = now();
        var b = myBoard();
        if (prev && b && !prev.over && b.over) host.vibrate([40, 60, 40]);
        render();
      } else if (msg.t === 'n.win') {
        if (msg.slot === me()) host.vibrate([60, 40, 60, 40, 120]);
        else if (M && M.mode === 'race') host.toast('¡' + host.nameOf(msg.slot) + ' ha llegado a 2048!');
      }
    },
    // For automated tests
    state: function () { return { meta: M, panel: M ? panelOf() : '' }; }
  });
})();
