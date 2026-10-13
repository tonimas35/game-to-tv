/*
 * Pong: phone view. The touch pad maps the finger's absolute position to the
 * paddle (0 top, 1 bottom). Low latency: sent immediately on touchstart and,
 * while moving, at most once per animation frame.
 * Doubles (3-4 players): a small field above the pad shows every paddle in
 * its player's colour and marks yours («Tu pala: delantera, a la izquierda»).
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
    '<div id="pMine" class="hidden"><div id="pField"></div><div id="pMineTxt"></div></div>' +
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

  // Paddles from pmeta: { slot, side, x, h, role } (slot and side start at 1)
  function pads() { return (pmeta && pmeta.paddles) || []; }
  function myPad() {
    var ps = pads();
    for (var i = 0; i < ps.length; i++) if (ps[i].slot === slot()) return ps[i];
    return null;
  }
  // Side 1 (left) or 2 (right) of this player; in the classic game, by slot
  function mySide() { var p = myPad(); return p ? p.side : (slot() === 1 ? 1 : 2); }
  function teamColor(side) {
    var c = host.colors();
    var ps = pads().filter(function (p) { return p.side === side; });
    return ps.length ? c[ps[0].slot - 1] : c[side - 1];
  }
  function teamNames(side, exceptMe) {
    var ps = pads().filter(function (p) { return p.side === side && !(exceptMe && p.slot === slot()); });
    return G2T.joinNames(ps.map(function (p) { return host.nameOf(p.slot); }));
  }
  function doubles() { return pads().length > 2; }

  function scoreHtml(sc) {
    return '<span style="color:' + teamColor(1) + '">' + sc[0] + '</span> – <span style="color:' + teamColor(2) + '">' + sc[1] + '</span>';
  }

  // The little field: every paddle at its place, mine bigger and outlined
  function renderField() {
    var box = $('pMine');
    var me = myPad();
    show(box, doubles() || !me);
    if (!doubles() && me) return;
    var ps = pads();
    var key = JSON.stringify(ps) + slot();
    if (box.getAttribute('data-key') !== key) {
      box.setAttribute('data-key', key);
      var html = '<i class="mid"></i>';
      ps.forEach(function (p) {
        var c = host.colors()[p.slot - 1];
        html += '<b class="' + (p.slot === slot() ? 'me' : '') + '" style="left:' + (p.x / 1920 * 100).toFixed(1) + '%;height:' + Math.round(p.h / 1080 * 100) + '%;background:' + c + '"></b>';
      });
      $('pField').innerHTML = html;
    }
    var txt;
    if (!me) txt = 'Estás mirando: entrarás en la próxima partida';
    else {
      var where = me.side === 1 ? 'a la izquierda' : 'a la derecha';
      var mate = teamNames(me.side, true);
      txt = 'Tu pala: ' + (me.role === 'delantera' ? 'la delantera' : (me.role === 'solo' ? 'la de portería (más larga: juegas solo)' : 'la de portería')) + ', ' + where + (mate ? ' · con ' + mate : '');
    }
    setText($('pMineTxt'), txt);
  }

  function renderPong() {
    if (!pmeta || !isActive()) return;
    var sc = pmeta.score || [0, 0];
    $('pScore').innerHTML = scoreHtml(sc);
    renderField();
    var side = mySide();
    var rivals = pads().length ? teamNames(3 - side) : host.otherName();
    var waiting = pads().filter(function (p) { var hp = host.hub() && host.hub().players[p.slot - 1]; return hp && !hp.connected; })
      .map(function (p) { return host.nameOf(p.slot); });
    var st = '';
    switch (pmeta.phase) {
      case 'countdown': st = ((sc[0] + sc[1]) > 0 ? 'Seguimos en ' : 'Empieza en ') + pmeta.countdown + '…'; break;
      case 'playing': st = doubles() ? '¡A jugar! Vais ' + (side === 1 ? 'a la izquierda' : 'a la derecha') : '¡A jugar! Juegas a la ' + (side === 1 ? 'izquierda' : 'derecha'); break;
      case 'scored':
        if (doubles()) st = pmeta.lastScorer === side ? '¡Punto para vosotros!' : 'Punto para ' + rivals;
        else st = pmeta.lastScorer === side ? '¡Punto para ti!' : 'Punto para ' + rivals;
        break;
      case 'paused': st = 'Pausa: esperando a ' + (waiting.length ? G2T.joinNames(waiting) : rivals) + '…'; break;
      case 'gameover': st = 'Fin de la partida'; break;
    }
    setText($('pStatus'), st);
    var over = pmeta.phase === 'gameover';
    show($('pongOver'), over);
    if (over) {
      var won = pmeta.winner === side;
      if (doubles()) {
        setText($('poTitle'), won ? '¡Habéis ganado!' : 'Habéis perdido');
        setText($('poSub'), won ? ('Contra ' + rivals) : ('Ganan ' + rivals + '. ¿Otra?'));
      } else {
        setText($('poTitle'), won ? '¡Has ganado!' : 'Has perdido');
        setText($('poSub'), won ? ('Le has ganado a ' + rivals) : ('Gana ' + rivals + '. ¿Otra?'));
      }
      $('poTitle').style.color = won ? host.myColor() : '#ffffff';
      $('poScore').innerHTML = scoreHtml(sc);
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
      if (msg.t === 'ev' && msg.k === 'hit' && msg.slot === slot()) flashPad();
      if (msg.t === 'ev' && msg.k === 'score' && (msg.side || msg.slot) === mySide()) flashPad();
    }
  });
})();
