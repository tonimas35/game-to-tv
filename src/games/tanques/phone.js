/*
 * «Tanques»: phone view. Loaded by public/m.html (ES2019).
 *
 * Best held sideways (in portrait a hint asks to turn the phone, but it can
 * be played too). Left: a floating stick (the base appears where the thumb
 * lands); the tank turns towards the direction of the stick, in screen
 * axes, and drives while it is pushed. «Botones» switches to ◀ ▶ (turn)
 * ▲ ▼ (drive, reverse), remembered on this phone. Right: a big «¡Fuego!».
 *
 * Inputs go out when they change (at most once per animation frame) plus a
 * heartbeat every 500 ms; the server forgets an input older than 1.5 s.
 * The phone vibrates when its tank is hit (navigator.vibrate; iOS ignores it).
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var $ = G2T.$, esc = G2T.esc, now = G2T.now;
  var ST = G2T.store;
  var host = null, show, setText;

  var DEAD = 0.15;            // stick dead zone (fraction of its radius)
  var HEARTBEAT_MS = 500;

  var HTML =
    '<div class="bar">' +
    '  <div class="chip"><span class="dot"></span><span class="meName">Jugador</span></div>' +
    '  <div class="kpScore" id="kpScore">0 – 0</div>' +
    '  <button class="mini ghost kpMode" id="kpMode" type="button">Botones</button>' +
    '  <button class="mini ghost kpHelpBtn" type="button" aria-label="Cómo se juega">?</button>' +
    '  <button class="mini ghost menuBtn" type="button">Menú</button>' +
    '</div>' +
    '<div class="kpRotate" id="kpRotate">Gira el móvil: se juega mejor en horizontal</div>' +
    '<div class="kpStatus" id="kpStatus">Preparados…</div>' +
    '<div class="kpMain" id="kpMain">' +
    '  <div class="kpLeft">' +
    '    <div class="kpStick" id="kpStick">' +
    '      <div class="kpBase" id="kpBase"><div class="kpKnob" id="kpKnob"></div></div>' +
    '      <p class="kpHint">Arrastra el dedo: el tanque va hacia allí</p>' +
    '    </div>' +
    '    <div class="kpKeys hidden" id="kpKeys">' +
    '      <button type="button" class="kpKey kpUp" data-k="up" aria-label="Avanzar">▲</button>' +
    '      <button type="button" class="kpKey kpLeftK" data-k="left" aria-label="Girar a la izquierda">◀</button>' +
    '      <button type="button" class="kpKey kpRightK" data-k="right" aria-label="Girar a la derecha">▶</button>' +
    '      <button type="button" class="kpKey kpDown" data-k="down" aria-label="Retroceder">▼</button>' +
    '    </div>' +
    '  </div>' +
    '  <div class="kpRight"><button type="button" class="kpFire" id="kpFire">¡Fuego!</button></div>' +
    '</div>' +
    '<div class="pn kpPanel hidden" id="kpWatch">' +
    '  <div class="kpT2">Estás mirando</div>' +
    '  <p class="kpT3" id="kpWatchTxt">Es un duelo de 2. ¡Mira la tele!</p>' +
    '</div>' +
    '<div class="pn kpPanel hidden" id="kpEnd">' +
    '  <div class="kpT1" id="kpEndT">¡Has ganado!</div>' +
    '  <div class="kpBig" id="kpEndScore">5 – 0</div>' +
    '  <p class="kpT3" id="kpEndSub"></p>' +
    '  <div class="kpEndBtns">' +
    '    <button type="button" class="bigbtn c" id="kpAgain">Otra</button>' +
    '    <button type="button" class="bigbtn ghost menuBtn">Menú</button>' +
    '  </div>' +
    '</div>';

  var PAUSE_HTML = '<div class="t1">Pausa</div><div class="t2" id="kpPauseWho" style="font-size:24px;font-weight:800;color:#fff">Esperando…</div><div class="t2">Todo está parado hasta que vuelva.</div>';
  var HELP_HTML = '<div class="kpHelpBox"><h2>Cómo se juega</h2><ol id="kpHelpList"></ol><button type="button" class="bigbtn c" id="kpHelpOk">Entendido</button></div>';

  var M = null;
  var mode = 'stick';                           // stick | keys
  var stick = { id: null, mouse: false, ox: 0, oy: 0, a: 0, m: 0 };
  var keys = { up: false, down: false, left: false, right: false };
  var keyTouches = {};                          // touch id -> key
  var lastSent = '', rafQueued = false, lastTouchAt = 0, hitTimer = null;

  function me() { return host.slot(); }
  function isActive() { var h = host.hub(); return !!(h && h.screen === 'tanques'); }
  function myIndex() { return M ? M.tanks.indexOf(me()) : -1; }
  function rivalSlot() { var k = myIndex(); return k < 0 || !M ? 0 : M.tanks[1 - k]; }
  function rivalName() { var r = rivalSlot(); return r ? host.nameOf(r) : host.otherName(); }
  function playing() { return !!(M && myIndex() >= 0 && M.phase !== 'end'); }

  // ---------------------------------------------------------------- sending
  function inputMsg() {
    if (mode === 'keys') {
      return { t: 'k.in', k: [(keys.right ? 1 : 0) - (keys.left ? 1 : 0), (keys.up ? 1 : 0) - (keys.down ? 1 : 0)] };
    }
    return { t: 'k.in', s: [stick.m > 0 ? Math.round(stick.a * 100) / 100 : 0, stick.m] };
  }
  function flushSend(force) {
    if (!host.isJoined() || !isActive() || !playing()) return;
    var msg = inputMsg();
    var key = JSON.stringify(msg);
    if (!force && key === lastSent) return;
    if (host.send(msg)) lastSent = key;
  }
  function queueSend() {
    if (rafQueued) return;
    rafQueued = true;
    G2T.raf(function () { rafQueued = false; flushSend(false); });
  }

  // ---------------------------------------------------------------- stick
  function stickRect() { return $('kpStick').getBoundingClientRect(); }
  function baseRadius() { return $('kpBase').offsetWidth / 2 || 60; }
  function placeBase(x, y) {
    var b = $('kpBase');
    b.style.left = x + 'px';
    b.style.top = y + 'px';
  }
  function centerBase() {
    var r = stickRect();
    placeBase(r.width / 2, r.height / 2);
    placeKnob(0, 0);
  }
  function placeKnob(dx, dy) {
    var tr = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
    var k = $('kpKnob');
    k.style.transform = tr;
    k.style.webkitTransform = tr;
  }
  function stickStart(cx, cy) {
    var r = stickRect();
    var rad = baseRadius();
    // The base appears under the thumb (kept inside the area)
    var x = Math.max(rad, Math.min(r.width - rad, cx - r.left));
    var y = Math.max(rad, Math.min(r.height - rad, cy - r.top));
    stick.ox = x + r.left;
    stick.oy = y + r.top;
    placeBase(x, y);
    $('kpStick').classList.add('on');
    stickMove(cx, cy);
  }
  function stickMove(cx, cy) {
    var rad = baseRadius();
    var dx = cx - stick.ox, dy = cy - stick.oy;
    var d = Math.sqrt(dx * dx + dy * dy);
    var k = d > rad ? rad / d : 1;
    placeKnob(dx * k, dy * k);
    var mag = Math.min(1, d / rad);
    if (mag < DEAD) { stick.m = 0; }
    else {
      stick.a = Math.atan2(dy, dx);
      stick.m = Math.round(Math.max(0.3, Math.min(1, (mag - DEAD) / 0.6)) * 20) / 20;
    }
    queueSend();
  }
  function stickEnd() {
    stick.id = null;
    stick.mouse = false;
    stick.m = 0;
    $('kpStick').classList.remove('on');
    centerBase();
    flushSend(false);
  }
  function bindStick() {
    var el = $('kpStick');
    el.addEventListener('touchstart', function (e) {
      e.preventDefault();
      lastTouchAt = now();
      if (stick.id !== null) return;
      var t = e.changedTouches[0];
      stick.id = t.identifier;
      stickStart(t.clientX, t.clientY);
    }, { passive: false });
    el.addEventListener('touchmove', function (e) {
      e.preventDefault();
      var t = stick.id === null ? null : G2T.findTouch(e.changedTouches, stick.id);
      if (t) stickMove(t.clientX, t.clientY);
    }, { passive: false });
    function end(e) {
      e.preventDefault();
      lastTouchAt = now();
      if (stick.id !== null && G2T.findTouch(e.changedTouches, stick.id)) stickEnd();
    }
    el.addEventListener('touchend', end, { passive: false });
    el.addEventListener('touchcancel', end, { passive: false });
    // Mouse (a computer, the tests)
    el.addEventListener('mousedown', function (e) {
      if (now() - lastTouchAt < 600) return;
      e.preventDefault();
      stick.mouse = true;
      stickStart(e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', function (e) { if (stick.mouse) stickMove(e.clientX, e.clientY); });
    window.addEventListener('mouseup', function () { if (stick.mouse) stickEnd(); });
  }

  // ---------------------------------------------------------------- buttons mode
  function keyOf(el) {
    while (el && el !== document.body) {
      if (el.getAttribute && el.getAttribute('data-k')) return el;
      el = el.parentNode;
    }
    return null;
  }
  function setKey(k, on) {
    if (keys[k] === on) return;
    keys[k] = on;
    var b = document.querySelector('#kpKeys [data-k="' + k + '"]');
    if (b) { if (on) b.classList.add('on'); else b.classList.remove('on'); }
    queueSend();
  }
  function bindKeys() {
    var pad = $('kpKeys');
    pad.addEventListener('touchstart', function (e) {
      e.preventDefault();
      lastTouchAt = now();
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        var b = keyOf(t.target);
        if (!b) continue;
        keyTouches[t.identifier] = b.getAttribute('data-k');
        setKey(keyTouches[t.identifier], true);
      }
    }, { passive: false });
    function end(e) {
      e.preventDefault();
      lastTouchAt = now();
      for (var i = 0; i < e.changedTouches.length; i++) {
        var id = e.changedTouches[i].identifier;
        var k = keyTouches[id];
        if (!k) continue;
        delete keyTouches[id];
        var still = false;
        Object.keys(keyTouches).forEach(function (o) { if (keyTouches[o] === k) still = true; });
        if (!still) setKey(k, false);
      }
    }
    pad.addEventListener('touchend', end, { passive: false });
    pad.addEventListener('touchcancel', end, { passive: false });
    pad.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    var mouseKey = null;
    pad.addEventListener('mousedown', function (e) {
      if (now() - lastTouchAt < 600) return;
      var b = keyOf(e.target);
      if (!b) return;
      e.preventDefault();
      mouseKey = b.getAttribute('data-k');
      setKey(mouseKey, true);
    });
    window.addEventListener('mouseup', function () { if (mouseKey) { setKey(mouseKey, false); mouseKey = null; } });
  }

  function setMode(m) {
    mode = m === 'keys' ? 'keys' : 'stick';
    ST.set(ST.local, 'tanques.mode', mode);
    show($('kpStick'), mode === 'stick');
    show($('kpKeys'), mode === 'keys');
    setText($('kpMode'), mode === 'stick' ? 'Botones' : 'Palanca');
    stick.m = 0; stick.id = null; stick.mouse = false;
    keys = { up: false, down: false, left: false, right: false };
    keyTouches = {};
    var bs = document.querySelectorAll('#kpKeys .kpKey');
    for (var i = 0; i < bs.length; i++) bs[i].classList.remove('on');
    if (mode === 'stick') setTimeout(centerBase, 0);
    flushSend(true);
  }

  // ---------------------------------------------------------------- fire
  function fire() {
    if (!playing() || M.phase !== 'play') return;
    if (host.send({ t: 'k.fire' })) host.vibrate(12);
  }
  function bindFire() {
    var b = $('kpFire');
    b.addEventListener('touchstart', function (e) {
      e.preventDefault();
      lastTouchAt = now();
      b.classList.add('on');
      fire();
    }, { passive: false });
    function end(e) { e.preventDefault(); lastTouchAt = now(); if (!e.targetTouches || !e.targetTouches.length) b.classList.remove('on'); }
    b.addEventListener('touchend', end, { passive: false });
    b.addEventListener('touchcancel', end, { passive: false });
    b.addEventListener('mousedown', function (e) {
      if (now() - lastTouchAt < 600) return;
      e.preventDefault();
      b.classList.add('on');
      fire();
    });
    window.addEventListener('mouseup', function () { b.classList.remove('on'); });
  }

  // ---------------------------------------------------------------- render
  function statusText() {
    var k = myIndex();
    var rival = rivalName();
    if (M.paused) return 'Pausa: esperando a ' + (M.waiting.length ? G2T.joinNames(M.waiting) : 'alguien') + '…';
    switch (M.phase) {
      case 'countdown':
        return (M.resumed ? 'Seguimos en ' : 'Ronda ' + M.round + ': empieza en ') + M.count + '…';
      case 'play':
        return M.alive[k] ? '¡A por ' + rival + '!' : 'Te han dado…';
      case 'over':
        if (!M.last) return M.alive[k] ? '¡Le has dado!' : 'Te han dado…';
        if (!M.last.winner) return '¡Empate! Nadie puntúa';
        return M.last.winner === me() ? '¡Punto para ti!' : (M.last.self ? 'Te has dado con tu propia bala' : 'Punto para ' + rival);
    }
    return '';
  }
  function render() {
    if (!M || !isActive()) return;
    var k = myIndex();
    var watching = k < 0;
    var end = !watching && M.phase === 'end';
    show($('kpMain'), !watching && !end);
    show($('kpStatus'), !watching && !end);
    show($('kpWatch'), watching);
    show($('kpEnd'), end);
    show($('kpMode'), !watching && !end);
    show($('kpPause'), !!M.paused && !watching);
    if (M.paused) setText($('kpPauseWho'), 'Esperando a ' + (M.waiting.length ? G2T.joinNames(M.waiting) : 'alguien') + '…');
    var colors = host.colors();
    var sc = M.scores || [0, 0];
    if (!watching) {
      var mine = sc[k], theirs = sc[1 - k];
      $('kpScore').innerHTML = '<span style="color:' + host.myColor() + '">' + mine + '</span> – <span style="color:' + (colors[rivalSlot() - 1] || '#fff') + '">' + theirs + '</span>';
      setText($('kpStatus'), statusText());
      var canFire = M.phase === 'play' && !M.paused && M.alive[k];
      if (canFire) $('kpFire').classList.remove('off'); else $('kpFire').classList.add('off');
    } else {
      $('kpScore').innerHTML = '<span style="color:' + (colors[M.tanks[0] - 1] || '#fff') + '">' + sc[0] + '</span> – <span style="color:' + (colors[M.tanks[1] - 1] || '#fff') + '">' + sc[1] + '</span>';
      setText($('kpWatchTxt'), 'Es un duelo de 2: ' + G2T.joinNames(M.tanks.map(function (s) { return host.nameOf(s); })) + '. ¡Mira la tele!');
    }
    if (end) {
      var won = M.winner === me();
      setText($('kpEndT'), won ? '¡Has ganado!' : 'Has perdido');
      $('kpEndT').style.color = won ? host.myColor() : '#ffffff';
      $('kpEndScore').innerHTML = '<span style="color:' + host.myColor() + '">' + sc[k] + '</span> – <span style="color:' + (colors[rivalSlot() - 1] || '#fff') + '">' + sc[1 - k] + '</span>';
      setText($('kpEndSub'), won ? 'Le has ganado a ' + rivalName() : 'Gana ' + rivalName() + '. ¿Otra?');
    }
  }

  function openHelp() {
    var g = G2T.gameById('tanques') || {};
    var lines = g.howTo || [g.description || ''];
    $('kpHelpList').innerHTML = lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('');
    show($('kpHelp'), true);
  }

  function onHit(msg) {
    if (msg.slot === me()) {
      host.vibrate([120, 60, 220]);
      var main = $('kpMain');
      main.classList.add('hit');
      clearTimeout(hitTimer);
      hitTimer = setTimeout(function () { main.classList.remove('hit'); }, 450);
    } else if (msg.by === me()) host.vibrate(40);
  }

  // ---------------------------------------------------------------- mount
  G2T.phone.register({
    id: 'tanques',
    mount: function (section, h) {
      host = h;
      show = h.show;
      setText = h.setText;
      section.innerHTML = HTML;
      var pause = document.createElement('div');
      pause.id = 'kpPause';
      pause.className = 'over hidden';
      pause.innerHTML = PAUSE_HTML;
      h.app.insertBefore(pause, $('modal'));
      var help = document.createElement('div');
      help.id = 'kpHelp';
      help.className = 'over scroll hidden';
      help.innerHTML = HELP_HTML;
      h.app.insertBefore(help, $('modal'));
      $('kpHelpOk').addEventListener('click', function () { show($('kpHelp'), false); });
      section.querySelector('.kpHelpBtn').addEventListener('click', openHelp);
      $('kpMode').addEventListener('click', function () { setMode(mode === 'stick' ? 'keys' : 'stick'); });
      $('kpAgain').addEventListener('click', function () { host.send({ t: 'k.again' }); });
      bindStick();
      bindKeys();
      bindFire();
      setMode(ST.get(ST.local, 'tanques.mode') === 'keys' ? 'keys' : 'stick');
      window.addEventListener('resize', function () { if (stick.id === null && !stick.mouse) centerBase(); });
      window.addEventListener('orientationchange', function () { setTimeout(centerBase, 300); });
      // Heartbeat: the current input again, so the server never keeps a stale one
      setInterval(function () { flushSend(true); }, HEARTBEAT_MS);
    },
    onJoined: function () { lastSent = ''; queueSend(); },
    reset: function () { M = null; lastSent = ''; },
    onHide: function () { show($('kpPause'), false); show($('kpHelp'), false); },
    render: function () { render(); setTimeout(centerBase, 0); },
    onMessage: function (msg) {
      if (msg.t === 'kmeta') {
        var prev = M;
        M = msg;
        if (!prev || prev.round !== msg.round || prev.match !== msg.match) lastSent = '';
        render();
      } else if (msg.t === 'k.hit') onHit(msg);
    },
    // For automated tests
    state: function () { return { meta: M, mode: mode, stick: { a: stick.a, m: stick.m }, keys: keys, lastSent: lastSent }; }
  });
})();
