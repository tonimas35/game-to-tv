/*
 * Pong: phone view. The touch pad maps the finger's absolute position to the
 * paddle (0 top, 1 bottom). Low latency: sent immediately on touchstart and,
 * while moving, at most once per animation frame.
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var $ = G2T.$, findTouch = G2T.findTouch;
  var host = null, show, setText;

  var HTML =
    '<div class="bar">' +
    '  <div class="chip"><span class="dot"></span><span id="pWho" class="meName">Jugador</span></div>' +
    '  <div id="pScore"><span style="color:#22e6ff">0</span> – <span style="color:#ff3df2">0</span></div>' +
    '  <button class="mini ghost menuBtn" type="button">Menú</button>' +
    '</div>' +
    '<div id="pStatus">Preparados…</div>' +
    '<div id="pad">' +
    '  <div id="thumb"></div>' +
    '  <div class="padhint">Desliza el dedo arriba y abajo</div>' +
    '</div>';

  var OVER_HTML =
    '<div class="t1" id="poTitle">¡Has ganado!</div>' +
    '<div id="poScore" style="font-size:52px;font-weight:900"></div>' +
    '<div class="t2" id="poSub"></div>' +
    '<button class="bigbtn c" id="rematch" type="button">¡Revancha!</button>' +
    '<button class="bigbtn ghost menuBtn" type="button" style="font-size:22px;padding:16px">Menú</button>';

  var pmeta = null;
  var pad, thumb;
  var targetY = 0.5, lastSentY = -1, rafQueued = false, activeTouch = null;
  var flashTimer = null;

  function slot() { return host.slot(); }
  function isActive() { var h = host.hub(); return !!(h && h.screen === 'pong'); }

  function scoreHtml(sc) {
    var c = host.colors();
    return '<span style="color:' + c[0] + '">' + sc[0] + '</span> – <span style="color:' + c[1] + '">' + sc[1] + '</span>';
  }

  function renderPong() {
    if (!pmeta || !isActive()) return;
    var sc = pmeta.score || [0, 0];
    $('pScore').innerHTML = scoreHtml(sc);
    var on = host.otherName();
    var st = '';
    switch (pmeta.phase) {
      case 'countdown': st = ((sc[0] + sc[1]) > 0 ? 'Seguimos en ' : 'Empieza en ') + pmeta.countdown + '…'; break;
      case 'playing': st = '¡A jugar! Juegas a la ' + (slot() === 1 ? 'izquierda' : 'derecha'); break;
      case 'scored': st = pmeta.lastScorer === slot() ? '¡Punto para ti!' : 'Punto para ' + on; break;
      case 'paused': st = 'Pausa: esperando a ' + on + '…'; break;
      case 'gameover': st = 'Fin de la partida'; break;
    }
    setText($('pStatus'), st);
    var over = pmeta.phase === 'gameover';
    show($('pongOver'), over);
    if (over) {
      var won = pmeta.winner === slot();
      setText($('poTitle'), won ? '¡Has ganado!' : 'Has perdido');
      $('poTitle').style.color = won ? host.myColor() : '#ffffff';
      $('poScore').innerHTML = scoreHtml(sc);
      setText($('poSub'), won ? ('Le has ganado a ' + on) : ('Gana ' + on + '. ¿Otra?'));
      if (!$('rematch').getAttribute('data-sent')) { $('rematch').disabled = false; setText($('rematch'), '¡Revancha!'); }
    } else {
      $('rematch').removeAttribute('data-sent');
    }
  }

  function flashPad() {
    pad.classList.add('flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { pad.classList.remove('flash'); }, 120);
    host.vibrate(15);
  }

  function placeThumb() {
    var h = pad.clientHeight;
    var m = h * 0.06;
    var y = m + targetY * (h - 2 * m);
    thumb.style.transform = 'translate3d(0,' + y.toFixed(1) + 'px,0)';
    thumb.style.webkitTransform = thumb.style.transform;
  }
  function yFromClient(clientY) {
    var r = pad.getBoundingClientRect();
    var m = r.height * 0.06;
    var v = (clientY - r.top - m) / Math.max(1, r.height - 2 * m);
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }
  function setTarget(v, immediate) {
    v = Math.round(v * 1000) / 1000;
    if (v === targetY && !immediate) return;
    targetY = v;
    placeThumb();
    if (immediate) flushSend(); else queueSend();
  }
  function queueSend() {
    if (rafQueued) return;
    rafQueued = true;
    G2T.raf(function () { rafQueued = false; flushSend(); });
  }
  function flushSend() {
    if (!host.isJoined() || !isActive()) return;
    if (targetY === lastSentY) return;
    if (host.send({ t: 'm', y: targetY })) lastSentY = targetY;
  }

  function bindPad() {
    pad.addEventListener('touchstart', function (e) {
      e.preventDefault();
      if (activeTouch === null && e.changedTouches.length) {
        var t = e.changedTouches[0];
        activeTouch = t.identifier;
        setTarget(yFromClient(t.clientY), true);
      }
    }, { passive: false });
    pad.addEventListener('touchmove', function (e) {
      e.preventDefault();
      var t = activeTouch === null ? e.touches[0] : findTouch(e.touches, activeTouch);
      if (t) setTarget(yFromClient(t.clientY), false);
    }, { passive: false });
    function endPadTouch(e) {
      e.preventDefault();
      if (activeTouch !== null && findTouch(e.changedTouches, activeTouch)) {
        activeTouch = null;
        if (e.touches.length) { activeTouch = e.touches[0].identifier; setTarget(yFromClient(e.touches[0].clientY), true); }
      }
    }
    pad.addEventListener('touchend', endPadTouch, { passive: false });
    pad.addEventListener('touchcancel', endPadTouch, { passive: false });
    var padMouse = false;
    pad.addEventListener('mousedown', function (e) { padMouse = true; setTarget(yFromClient(e.clientY), true); });
    window.addEventListener('mousemove', function (e) { if (padMouse) setTarget(yFromClient(e.clientY), false); });
    window.addEventListener('mouseup', function () { padMouse = false; });
    window.addEventListener('resize', placeThumb);
    window.addEventListener('orientationchange', function () { setTimeout(placeThumb, 300); });
  }

  G2T.phone.register({
    id: 'pong',
    mount: function (section, h) {
      host = h;
      show = h.show;
      setText = h.setText;
      section.innerHTML = HTML;
      var over = document.createElement('div');
      over.id = 'pongOver';
      over.className = 'over hidden';
      over.innerHTML = OVER_HTML;
      h.app.insertBefore(over, $('modal'));
      pad = $('pad');
      thumb = $('thumb');
      $('rematch').addEventListener('click', function () {
        if (host.send({ t: 'rematch' })) {
          $('rematch').disabled = true;
          $('rematch').setAttribute('data-sent', '1');
          setText($('rematch'), '¡Allá vamos!');
        }
      });
      bindPad();
      placeThumb();
    },
    onJoined: function () { lastSentY = -1; queueSend(); },
    reset: function () { pmeta = null; },
    onHide: function () { show($('pongOver'), false); },
    render: function () { renderPong(); setTimeout(placeThumb, 0); },
    onMessage: function (msg) {
      if (msg.t === 'pmeta') { pmeta = msg; renderPong(); return; }
      if (msg.t === 'ev' && (msg.k === 'hit' || msg.k === 'score') && msg.slot === slot()) flashPad();
    }
  });
})();
