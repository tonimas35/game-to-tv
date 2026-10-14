/*
 * «Motos de neón»: phone controller (portrait). Loaded by public/m.html (ES2019).
 *
 * - Swipe ANYWHERE below the top bar to turn. The turn is sent as soon as the
 *   finger has moved 18 px (no waiting for the finger to lift), and the swipe
 *   keeps going: «up then left» in one quick gesture sends both turns.
 * - Four big arrow buttons as a D-pad: the turn is sent on touchstart.
 * - Your colour everywhere (border, band «Tu moto: …»), the score, «?» help,
 *   and a vibration (plus a shake of the pad) when your bike crashes.
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var $ = G2T.$, esc = G2T.esc, now = G2T.now;
  var host = null, show, setText;

  var SWIPE = 18;         // px: a swipe this long is a turn
  var COLOR_NAMES = { '#22e6ff': 'cian', '#ff3df2': 'magenta', '#ffd23e': 'amarilla', '#3ee07a': 'verde', '#ff8a3d': 'naranja', '#a98bff': 'violeta', '#ffffff': 'blanca', '#7dffcf': 'menta' };
  var ARROWS = { up: '▲', right: '▶', down: '▼', left: '◀' };
  var CAUSE = { muro: 'contra el muro', propia: 'contra tu propia estela', rival: 'contra la estela de ', frontal: 'de frente' };

  var HTML =
    '<div class="bar">' +
    '  <div class="chip"><span class="dot"></span><span class="meName">Jugador</span></div>' +
    '  <div class="info mpScore" id="mpScore">0 – 0</div>' +
    '  <button class="mini ghost mpHelpBtn" type="button" aria-label="Cómo se juega">?</button>' +
    '  <button class="mini ghost menuBtn" type="button">Menú</button>' +
    '</div>' +
    '<div class="mpPad g2t-ctl" id="mpPad">' +
    '  <div class="mpBand" id="mpBand">Tu moto</div>' +
    '  <div class="mpStatus" id="mpStatus">Preparados…</div>' +
    '  <div class="mpCross" id="mpCross">' +
    '    <button type="button" class="mpArrow mpUp" data-dir="up" aria-label="Arriba">▲</button>' +
    '    <button type="button" class="mpArrow mpLeft" data-dir="left" aria-label="Izquierda">◀</button>' +
    '    <div class="mpMid" id="mpMid"></div>' +
    '    <button type="button" class="mpArrow mpRight" data-dir="right" aria-label="Derecha">▶</button>' +
    '    <button type="button" class="mpArrow mpDown" data-dir="down" aria-label="Abajo">▼</button>' +
    '  </div>' +
    '  <p class="mpHint">Desliza en cualquier parte o toca las flechas</p>' +
    '</div>' +
    '<div class="mpWatch hidden" id="mpWatch">' +
    '  <div class="mpT2">Estás mirando</div>' +
    '  <p class="mpT3">«Motos de neón» es para dos. ¡Mira la tele!</p>' +
    '</div>';

  var OVER_HTML =
    '<div class="t1" id="mpOverT">¡Has ganado!</div>' +
    '<div class="mpOverS" id="mpOverS">5 – 0</div>' +
    '<div class="t2" id="mpOverSub"></div>' +
    '<button type="button" class="bigbtn c" id="mpAgain">Otra</button>' +
    '<button type="button" class="bigbtn ghost menuBtn mpSecond">Menú</button>';
  var PAUSE_HTML = '<div class="t1">Pausa</div><div class="t2 mpPauseWho" id="mpPauseWho">Esperando…</div><div class="t2">La ronda sigue en cuanto vuelva.</div>';
  var HELP_HTML = '<div class="mpHelpBox"><h2>Cómo se juega</h2><ol id="mpHelpList"></ol><button type="button" class="bigbtn c" id="mpHelpOk">Entendido</button></div>';

  var M = null;
  var touches = {};
  var lastTouchAt = 0, mouseRec = null;
  var crashedRound = -1, crashCause = null, crashTimer = null;
  var sent = 0, lastDir = null, flashTimers = {}, shakes = 0;

  function me() { return host.slot(); }
  function isActive() { var h = host.hub(); return !!(h && h.screen === 'motos'); }
  function mySide() { return M && M.players ? M.players.indexOf(me()) + 1 : 0; }
  function sideColor(side) { return host.colors()[M.players[side - 1] - 1] || '#ffffff'; }
  function sideName(side) { return host.nameOf(M.players[side - 1]); }
  function canSteer() {
    return !!(M && mySide() && (M.phase === 'playing' || M.phase === 'countdown') && crashedRound !== M.round);
  }

  // ---------------------------------------------------------------- turning
  function turn(dir) {
    if (!canSteer()) return;
    if (!host.send({ t: 'm.turn', dir: dir })) return;
    sent++;
    lastDir = dir;
    setText($('mpMid'), ARROWS[dir]);
    var b = document.querySelector('#scr-motos .mpArrow[data-dir="' + dir + '"]');
    if (b) {
      b.classList.add('hit');
      clearTimeout(flashTimers[dir]);
      flashTimers[dir] = setTimeout(function () { b.classList.remove('hit'); }, 140);
    }
  }
  function buttonDir(el) {
    while (el && el.getAttribute) {
      if (el.getAttribute('data-dir')) return el.getAttribute('data-dir');
      el = el.parentNode;
    }
    return null;
  }
  function inBar(el) {
    while (el && el.classList) {
      if (el.classList.contains('bar')) return true;
      el = el.parentNode;
    }
    return false;
  }
  // A finger moved: a turn every SWIPE px, starting again from there
  function moved(rec, x, y) {
    var dx = x - rec.x, dy = y - rec.y;
    var ax = Math.abs(dx), ay = Math.abs(dy);
    if (Math.max(ax, ay) < SWIPE) return;
    var dir = ax > ay ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    if (dir !== rec.last) turn(dir);
    rec.last = dir;
    rec.x = x;
    rec.y = y;
  }
  function bindPad(section) {
    section.addEventListener('touchstart', function (e) {
      if (inBar(e.target)) return;           // «?» and «Menú» keep their clicks
      e.preventDefault();
      lastTouchAt = now();
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        var btn = buttonDir(t.target || e.target);
        touches[t.identifier] = { x: t.clientX, y: t.clientY, last: btn };
        if (btn) turn(btn);                   // the buttons: on touchstart, no waiting
      }
    }, { passive: false });
    section.addEventListener('touchmove', function (e) {
      if (inBar(e.target)) return;
      e.preventDefault();
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        var rec = touches[t.identifier];
        if (rec) moved(rec, t.clientX, t.clientY);
      }
    }, { passive: false });
    function end(e) {
      if (!inBar(e.target)) e.preventDefault();   // no click, no double-tap zoom
      lastTouchAt = now();
      for (var i = 0; i < e.changedTouches.length; i++) delete touches[e.changedTouches[i].identifier];
    }
    section.addEventListener('touchend', end, { passive: false });
    section.addEventListener('touchcancel', end, { passive: false });
    // Mouse (a computer, the tests): the same, ignoring the mouse events that follow a touch
    section.addEventListener('mousedown', function (e) {
      if (now() - lastTouchAt < 600 || inBar(e.target)) return;
      e.preventDefault();
      var btn = buttonDir(e.target);
      mouseRec = { x: e.clientX, y: e.clientY, last: btn };
      if (btn) turn(btn);
    });
    window.addEventListener('mousemove', function (e) { if (mouseRec) moved(mouseRec, e.clientX, e.clientY); });
    window.addEventListener('mouseup', function () { mouseRec = null; });
  }

  // ---------------------------------------------------------------- render
  function statusText() {
    var side = mySide();
    var other = sideName(3 - side);
    switch (M.phase) {
      case 'countdown': return 'Ronda ' + M.round + ': empieza en ' + M.countdown + '…';
      case 'playing':
        if (crashedRound === M.round) return 'Has chocado ' + (crashCause === 'rival' ? CAUSE.rival + other : (CAUSE[crashCause] || ''));
        return '¡A correr! Gira antes de chocar';
      case 'roundEnd': {
        var w = M.last ? M.last.winner : 0;
        if (!w) return 'Empate: nadie suma';
        return w === side ? '¡Ronda para ti!' : 'Ronda para ' + other;
      }
      case 'paused': return 'Pausa';
      case 'gameover': return 'Fin de la partida';
    }
    return '';
  }

  function render() {
    if (!M || !isActive()) return;
    var side = mySide();
    show($('mpPad'), !!side);
    show($('mpWatch'), !side);
    var sc = M.score || [0, 0];
    if (side) {
      var mine = sc[side - 1], theirs = sc[2 - side];
      $('mpScore').innerHTML = '<span style="color:' + sideColor(side) + '">' + mine + '</span> – <span style="color:' + sideColor(3 - side) + '">' + theirs + '</span>';
      var cname = COLOR_NAMES[String(host.myColor()).toLowerCase()] || '';
      setText($('mpBand'), 'Tu moto' + (cname ? ': ' + cname : '') + ' · a la ' + (side === 1 ? 'izquierda' : 'derecha'));
      setText($('mpStatus'), statusText());
      $('mpStatus').className = 'mpStatus' + (M.phase === 'roundEnd' && M.last && M.last.winner === side ? ' win' : '') + (crashedRound === M.round && M.phase === 'playing' ? ' bad' : '');
      if (M.phase === 'countdown' && !lastDir) setText($('mpMid'), '');
    } else {
      $('mpScore').innerHTML = sc[0] + ' – ' + sc[1];
    }
    show($('mpPause'), M.phase === 'paused' && !!side);
    if (M.phase === 'paused') setText($('mpPauseWho'), 'Esperando a ' + (M.waiting && M.waiting.length ? G2T.joinNames(M.waiting) : 'tu rival') + '…');
    var over = M.phase === 'gameover' && !!side;
    show($('mpOver'), over);
    if (over) {
      var won = M.winner === side;
      setText($('mpOverT'), won ? '¡Has ganado!' : 'Has perdido');
      $('mpOverT').style.color = won ? host.myColor() : '#ffffff';
      $('mpOverS').innerHTML = '<span style="color:' + sideColor(side) + '">' + sc[side - 1] + '</span> – <span style="color:' + sideColor(3 - side) + '">' + sc[2 - side] + '</span>';
      setText($('mpOverSub'), won ? 'Le has ganado a ' + sideName(3 - side) : 'Gana ' + sideName(3 - side) + '. ¿Otra?');
      if (!$('mpAgain').getAttribute('data-sent')) { $('mpAgain').disabled = false; setText($('mpAgain'), 'Otra'); }
    } else {
      $('mpAgain').removeAttribute('data-sent');
    }
  }

  function onCrash(e) {
    if (!M || e.slot !== me()) return;
    crashedRound = M.round;
    crashCause = e.cause;
    host.vibrate([90, 50, 160]);
    shakes++;
    var pad = $('mpPad');
    pad.classList.remove('crash');
    void pad.offsetWidth;
    pad.classList.add('crash');
    clearTimeout(crashTimer);
    crashTimer = setTimeout(function () { pad.classList.remove('crash'); }, 700);
    render();
  }

  function openHelp() {
    var g = G2T.gameById('motos') || {};
    var lines = g.howTo || [g.description || ''];
    $('mpHelpList').innerHTML = lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('');
    show($('mpHelp'), true);
  }

  // ---------------------------------------------------------------- mount
  G2T.phone.register({
    id: 'motos',
    mount: function (section, h) {
      host = h;
      show = h.show;
      setText = h.setText;
      section.innerHTML = HTML;
      function layer(id, cls, html) {
        var el = document.createElement('div');
        el.id = id;
        el.className = cls;
        el.innerHTML = html;
        h.app.insertBefore(el, $('modal'));
      }
      layer('mpOver', 'over hidden', OVER_HTML);
      layer('mpPause', 'over hidden', PAUSE_HTML);
      layer('mpHelp', 'over scroll hidden', HELP_HTML);
      $('mpHelpOk').addEventListener('click', function () { show($('mpHelp'), false); });
      section.querySelector('.mpHelpBtn').addEventListener('click', openHelp);
      $('mpAgain').addEventListener('click', function () {
        if (host.send({ t: 'm.again' })) {
          $('mpAgain').disabled = true;
          $('mpAgain').setAttribute('data-sent', '1');
          setText($('mpAgain'), '¡Allá vamos!');
        }
      });
      bindPad(section);
    },
    reset: function () { M = null; touches = {}; mouseRec = null; crashedRound = -1; lastDir = null; },
    onHide: function () { show($('mpOver'), false); show($('mpPause'), false); show($('mpHelp'), false); },
    render: function () { render(); },
    onMessage: function (msg) {
      if (msg.t === 'mmeta') {
        var prev = M;
        M = msg;
        if (!prev || prev.round !== msg.round || prev.match !== msg.match) { lastDir = null; if (prev && prev.match !== msg.match) crashedRound = -1; }
        if (prev && prev.phase !== 'roundEnd' && msg.phase === 'roundEnd' && msg.last && msg.last.winner && msg.last.winner === mySide()) host.vibrate(40);
        render();
      } else if (msg.t === 'ev' && msg.k === 'crash') {
        onCrash(msg);
      }
    },
    // For automated tests
    state: function () { return { meta: M, sent: sent, lastDir: lastDir, crashed: crashedRound === (M && M.round), shakes: shakes }; }
  });
})();
