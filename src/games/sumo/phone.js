/*
 * «Sumo»: phone view (portrait). Loaded by public/m.html (ES2019).
 *
 * - A big virtual joystick in the lower part: the base jumps to where the
 *   thumb lands and the knob follows it; the vector (-1..1, y down) goes to
 *   the server at most once per animation frame, and 0,0 on release.
 * - «¡Embestida!»: a big round button with a ring that fills up during the
 *   2 s cooldown (the server confirms with 's.cd').
 * - Vibrates on collisions (if the phone can), the score, «?» (how to play),
 *   «Pausa» while the other one reconnects, and «Otra» / «Menú» at the end.
 * Joystick and button work at the same time (each one follows its own touch).
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var $ = G2T.$, esc = G2T.esc, now = G2T.now, clamp = G2T.clamp, findTouch = G2T.findTouch;
  var host = null, show, setText;

  var RING_LEN = 578;   // 2·π·92 (the SVG ring)

  var HTML =
    '<div class="bar">' +
    '  <div class="chip"><span class="dot"></span><span class="meName">Jugador</span></div>' +
    '  <div class="info spScore" id="spScore">0 – 0</div>' +
    '  <button class="mini ghost spHelpBtn" type="button" aria-label="Cómo se juega">?</button>' +
    '  <button class="mini ghost menuBtn" type="button">Menú</button>' +
    '</div>' +
    '<div class="spStatus fit" id="spStatus">Preparados…</div>' +
    '<div class="spPlay" id="spPlay">' +
    '  <div class="spDashRow g2t-ctl">' +
    '    <button type="button" class="spDash" id="spDash">' +
    '      <svg viewBox="0 0 200 200" aria-hidden="true"><circle class="spRingBg" cx="100" cy="100" r="92"></circle><circle class="spRing" id="spRing" cx="100" cy="100" r="92"></circle></svg>' +
    '      <span class="spDashIn"><b>¡Embestida!</b><small id="spDashSub">¡Lista!</small></span>' +
    '    </button>' +
    '  </div>' +
    '  <div class="spJoy g2t-ctl" id="spJoy">' +
    '    <div class="spBase" id="spBase"><div class="spKnob" id="spKnob"></div></div>' +
    '    <div class="spHint" id="spHint">Arrastra el dedo para empujar</div>' +
    '  </div>' +
    '</div>' +
    '<div class="spWatch center hidden" id="spWatch">' +
    '  <div class="spT2">Estás mirando</div>' +
    '  <p class="spT3">«Sumo» es para 2. Si alguien se va, entras tú. ¡Mira la tele!</p>' +
    '</div>';

  var PAUSE_HTML = '<div class="t1">Pausa</div><div class="t2" id="spPauseWho" style="font-size:24px;font-weight:800;color:#fff">Esperando…</div><div class="t2">Seguimos en cuanto vuelva.</div>';
  var HELP_HTML = '<div class="spHelpBox"><h2>Cómo se juega</h2><ol id="spHelpList"></ol><button type="button" class="bigbtn c" id="spHelpOk">Entendido</button></div>';
  var OVER_HTML =
    '<div class="t1" id="spOverT">¡Has ganado!</div>' +
    '<div id="spOverScore" style="font-size:52px;font-weight:900"></div>' +
    '<div class="t2" id="spOverSub"></div>' +
    '<button class="bigbtn c" id="spAgain" type="button">Otra</button>' +
    '<button class="bigbtn ghost menuBtn" type="button" style="font-size:22px;padding:16px">Menú</button>';

  var M = null, metaAt = 0;
  // Joystick
  var joy, base, knob, joyTouch = null, joyMouse = false;
  var jx = 0, jy = 0, sentX = null, sentY = null, rafQueued = false;
  var baseX = 0, baseY = 0, baseR = 80;
  // Dash
  var cdUntil = 0, cdTotal = 2000, cdRaf = false, pressedAt = -1e9, lastTouchAt = 0, lastVibe = 0;

  function me() { return host.slot(); }
  function isActive() { var h = host.hub(); return !!(h && h.screen === 'sumo'); }
  function myIndex() { return M && M.slots ? M.slots.indexOf(me()) : -1; }
  function colorOf(k) { var s = M && M.slots && M.slots[k]; return host.colors()[(s || (k + 1)) - 1] || '#fff'; }
  function nameOf(k) { var s = M && M.slots && M.slots[k]; return s ? host.nameOf(s) : 'Jugador ' + (k + 1); }

  // ---------------------------------------------------------------- joystick
  function zoneRect() { return joy.getBoundingClientRect(); }
  function placeBase(cx, cy) {
    var r = zoneRect();
    baseR = clamp(Math.min(r.width, r.height) * 0.3, 56, 120);
    var m = baseR + 8;
    baseX = clamp(cx - r.left, m, Math.max(m, r.width - m));
    baseY = clamp(cy - r.top, m, Math.max(m, r.height - m));
    base.style.width = base.style.height = (baseR * 2) + 'px';
    base.style.left = (baseX - baseR) + 'px';
    base.style.top = (baseY - baseR) + 'px';
    var kn = Math.round(baseR * 0.95);
    knob.style.width = knob.style.height = kn + 'px';
    knob.style.marginLeft = knob.style.marginTop = (-kn / 2) + 'px';
  }
  function centreBase() { var r = zoneRect(); placeBase(r.left + r.width / 2, r.top + r.height / 2); placeKnob(0, 0); }
  function placeKnob(x, y) {
    var tr = 'translate3d(' + (x * baseR).toFixed(1) + 'px,' + (y * baseR).toFixed(1) + 'px,0)';
    knob.style.transform = tr;
    knob.style.webkitTransform = tr;
  }
  function moveTo(cx, cy) {
    var r = zoneRect();
    var dx = (cx - r.left - baseX) / baseR, dy = (cy - r.top - baseY) / baseR;
    var m = Math.sqrt(dx * dx + dy * dy);
    if (m > 1) { dx /= m; dy /= m; }
    jx = Math.round(dx * 100) / 100;
    jy = Math.round(dy * 100) / 100;
    placeKnob(jx, jy);
    queueSend();
  }
  function release() {
    joyTouch = null;
    joyMouse = false;
    jx = 0; jy = 0;
    joy.classList.remove('on');
    centreBase();
    flushSend();
  }
  function queueSend() {
    if (rafQueued) return;
    rafQueued = true;
    G2T.raf(function () { rafQueued = false; flushSend(); });
  }
  function flushSend() {
    if (!host.isJoined() || !isActive() || myIndex() < 0) return;
    if (jx === sentX && jy === sentY) return;
    if (host.send({ t: 's.j', x: jx, y: jy })) { sentX = jx; sentY = jy; }
  }
  function bindJoy() {
    joy.addEventListener('touchstart', function (e) {
      e.preventDefault();
      lastTouchAt = now();
      if (joyTouch !== null || !e.changedTouches.length) return;
      var t = e.changedTouches[0];
      joyTouch = t.identifier;
      joy.classList.add('on');
      placeBase(t.clientX, t.clientY);
      moveTo(t.clientX, t.clientY);
    }, { passive: false });
    joy.addEventListener('touchmove', function (e) {
      e.preventDefault();
      var t = joyTouch === null ? null : findTouch(e.touches, joyTouch);
      if (t) moveTo(t.clientX, t.clientY);
    }, { passive: false });
    function end(e) {
      e.preventDefault();
      if (joyTouch !== null && findTouch(e.changedTouches, joyTouch)) release();
    }
    joy.addEventListener('touchend', end, { passive: false });
    joy.addEventListener('touchcancel', end, { passive: false });
    // Mouse (a computer, the tests)
    joy.addEventListener('mousedown', function (e) {
      if (now() - lastTouchAt < 500) return;
      e.preventDefault();
      joyMouse = true;
      joy.classList.add('on');
      placeBase(e.clientX, e.clientY);
      moveTo(e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', function (e) { if (joyMouse) moveTo(e.clientX, e.clientY); });
    window.addEventListener('mouseup', function () { if (joyMouse) release(); });
    window.addEventListener('resize', function () { if (joyTouch === null && !joyMouse) centreBase(); });
  }

  // ---------------------------------------------------------------- dash
  function canDash() { return !!(M && M.phase === 'playing' && myIndex() >= 0); }
  function pressDash() {
    var b = $('spDash');
    b.classList.add('press');
    setTimeout(function () { b.classList.remove('press'); }, 140);
    if (!canDash() || now() < cdUntil) return;
    if (host.send({ t: 's.d' })) {
      pressedAt = now();
      cdUntil = now() + cdTotal;      // at once; 's.cd' corrects it
      host.vibrate(20);
      drawCooldown();
    }
  }
  function drawCooldown() {
    var left = Math.max(0, cdUntil - now());
    var k = 1 - left / cdTotal;
    var ring = $('spRing');
    ring.style.strokeDashoffset = String(Math.round(RING_LEN * (1 - clamp(k, 0, 1))));
    var b = $('spDash');
    var ready = left <= 0 && canDash();
    if (ready) b.classList.add('ready'); else b.classList.remove('ready');
    if (left > 0) b.classList.add('cool'); else b.classList.remove('cool');
    setText($('spDashSub'), left > 0 ? 'Recargando…' : (canDash() ? '¡Lista!' : 'Espera…'));
    if (left > 0 && !cdRaf) {
      cdRaf = true;
      G2T.raf(function () { cdRaf = false; drawCooldown(); });
    }
  }
  function bindDash() {
    var b = $('spDash');
    b.addEventListener('touchstart', function (e) { e.preventDefault(); lastTouchAt = now(); pressDash(); }, { passive: false });
    b.addEventListener('touchend', function (e) { e.preventDefault(); }, { passive: false });
    b.addEventListener('mousedown', function (e) { if (now() - lastTouchAt < 500) return; e.preventDefault(); pressDash(); });
  }

  // ---------------------------------------------------------------- render
  function scoreHtml() {
    var sc = M.score || [0, 0];
    return '<span style="color:' + colorOf(0) + '">' + sc[0] + '</span> – <span style="color:' + colorOf(1) + '">' + sc[1] + '</span>';
  }
  function render() {
    if (!M || !isActive()) return;
    var i = myIndex();
    var watching = i < 0;
    show($('spPlay'), !watching);
    show($('spWatch'), watching);
    var sh = scoreHtml();
    if ($('spScore').innerHTML !== sh) $('spScore').innerHTML = sh;
    var rival = watching ? '' : nameOf(1 - i);
    var st = '';
    switch (M.phase) {
      case 'countdown': st = (M.resumed ? 'Seguimos en ' : (M.round > 1 ? 'Ronda ' + M.round + ' en ' : 'Empieza en ')) + M.countdown + '…'; break;
      case 'playing': st = watching ? '¡Mira la tele!' : '¡Empuja! Saca a ' + rival + ' del círculo'; break;
      case 'roundover':
        if (!M.result || M.result.w === 0) st = '¡Empate! Se repite la ronda';
        else if (watching) st = 'Ronda para ' + nameOf(M.result.w - 1);
        else st = M.result.w - 1 === i ? '¡Ronda para ti!' : 'Ronda para ' + rival;
        break;
      case 'paused': st = 'Pausa'; break;
      case 'end': st = 'Fin del combate'; break;
    }
    setText($('spStatus'), st);
    G2T.fit($('spStatus'), 20, 14);
    show($('spPause'), M.phase === 'paused');
    if (M.phase === 'paused') setText($('spPauseWho'), 'Esperando a ' + (M.waiting && M.waiting.length ? G2T.joinNames(M.waiting) : 'alguien') + '…');
    var over = M.phase === 'end';
    show($('spOver'), over);
    if (over) {
      var won = !watching && M.winner - 1 === i;
      setText($('spOverT'), watching ? '¡Gana ' + nameOf(M.winner - 1) + '!' : (won ? '¡Has ganado!' : 'Has perdido'));
      $('spOverT').style.color = won ? host.myColor() : '#ffffff';
      $('spOverScore').innerHTML = sh;
      setText($('spOverSub'), watching ? '' : (won ? 'Has sacado a ' + rival + ' del círculo' : 'Gana ' + rival + '. ¿Otra?'));
      if (!$('spAgain').getAttribute('data-sent')) { $('spAgain').disabled = false; setText($('spAgain'), 'Otra'); }
    } else {
      $('spAgain').removeAttribute('data-sent');
    }
    if (i >= 0 && M.cd && now() - pressedAt > 500) {
      // The server's cooldown wins if ours is off by a lot (not right after a
      // press: that meta may have left the server before our dash arrived)
      var left = Math.max(0, M.cd[i] - (now() - metaAt));
      if (Math.abs((cdUntil - now()) - left) > 300) cdUntil = now() + left;
    }
    drawCooldown();
  }

  function openHelp() {
    var g = G2T.gameById('sumo') || {};
    var lines = g.howTo || [g.description || ''];
    $('spHelpList').innerHTML = lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('');
    show($('spHelp'), true);
  }

  function onMeta(m) {
    var prev = M;
    M = m;
    metaAt = now();
    if (m.cdTotal) cdTotal = m.cdTotal;
    // A new phase: resend the joystick (the server drops it between rounds)
    if (!prev || prev.phase !== m.phase || prev.match !== m.match) { sentX = null; sentY = null; queueSend(); }
    var i = myIndex();
    if (prev && i >= 0 && prev.phase === 'playing' && m.phase === 'roundover' && m.result) {
      host.vibrate(m.result.w - 1 === i ? [30, 40, 30] : [120, 60, 120]);
    }
    if (prev && i >= 0 && prev.phase !== 'end' && m.phase === 'end') host.vibrate(m.winner - 1 === i ? [60, 40, 60, 40, 140] : 300);
    render();
  }

  G2T.phone.register({
    id: 'sumo',
    mount: function (section, h) {
      host = h;
      show = h.show;
      setText = h.setText;
      section.innerHTML = HTML;
      var pause = document.createElement('div');
      pause.id = 'spPause';
      pause.className = 'over hidden';
      pause.innerHTML = PAUSE_HTML;
      h.app.insertBefore(pause, $('modal'));
      var help = document.createElement('div');
      help.id = 'spHelp';
      help.className = 'over scroll hidden';
      help.innerHTML = HELP_HTML;
      h.app.insertBefore(help, $('modal'));
      var over = document.createElement('div');
      over.id = 'spOver';
      over.className = 'over hidden';
      over.innerHTML = OVER_HTML;
      h.app.insertBefore(over, $('modal'));
      $('spHelpOk').addEventListener('click', function () { show($('spHelp'), false); });
      section.querySelector('.spHelpBtn').addEventListener('click', openHelp);
      $('spAgain').addEventListener('click', function () {
        if (host.send({ t: 's.again' })) {
          $('spAgain').disabled = true;
          $('spAgain').setAttribute('data-sent', '1');
          setText($('spAgain'), '¡Allá vamos!');
        }
      });
      joy = $('spJoy');
      base = $('spBase');
      knob = $('spKnob');
      bindJoy();
      bindDash();
      drawCooldown();
    },
    onJoined: function () { sentX = null; sentY = null; queueSend(); },
    reset: function () { M = null; cdUntil = 0; if (joy) release(); },
    onHide: function () { show($('spPause'), false); show($('spHelp'), false); show($('spOver'), false); },
    render: function () { render(); setTimeout(function () { if (joyTouch === null && !joyMouse) centreBase(); }, 0); },
    onMessage: function (msg) {
      if (msg.t === 'smeta') { onMeta(msg); return; }
      if (msg.t === 's.cd') { cdUntil = now() + (msg.ms || 0); drawCooldown(); return; }
      if (msg.t === 'ev' && msg.k === 'hit' && myIndex() >= 0) {
        var t = now();
        if (t - lastVibe > 150) { lastVibe = t; host.vibrate(msg.big ? 70 : Math.round(15 + 25 * (msg.p || 0))); }
      }
    },
    // For automated tests
    state: function () { return { meta: M, joy: [jx, jy], sent: [sentX, sentY], cdLeft: Math.max(0, cdUntil - now()), base: [baseX, baseY, baseR] }; }
  });
})();
