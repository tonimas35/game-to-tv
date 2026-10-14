/*
 * «2048»: TV view. Loaded by public/tv.html (ES2019).
 * DOM + CSS only: every tile is a div moved with a CSS transform (it slides
 * with a transition and pops with a keyframe animation on its inner box), so
 * the TV GPU only composites. No shadows, no filters. At most 6 boards x 16 tiles.
 *
 * 1 player: one big board in the middle, score and «Récord» at the sides.
 * 2 to 6: one board per player in a grid (2 side by side, 3-4 in 2x2,
 * 5-6 in 3x2), each in the player's colour, plus the race clock.
 * The keyboard / remote arrows move player 1's board (the server decides).
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var $ = G2T.$, now = G2T.now, clamp = G2T.clamp, esc = G2T.esc;
  var host = null, view = null, show, setText, fit;
  var beep = G2T.sound.beep;

  var LW = 1920;
  var TOP = 118;                     // top bar height
  var KEY_DIRS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };

  var HTML =
    '<div class="nTop">' +
    '  <div class="nBrand">2048</div>' +
    '  <div class="nClock" id="nClock"></div>' +
    '  <div class="nHint fit" id="nHint"></div>' +
    '</div>' +
    '<div class="nArea" id="nArea"></div>' +
    '<div class="nSide nSideL" id="nSideL">' +
    '  <div class="nWho fit" id="nWho">—</div>' +
    '  <div class="nBox"><small>PUNTOS</small><b id="nScore">0</b></div>' +
    '  <div class="nBox"><small>RÉCORD</small><b id="nBest">0</b></div>' +
    '  <div class="nRec" id="nRec">¡Nuevo récord!</div>' +
    '</div>' +
    '<div class="nSide nSideR" id="nSideR">' +
    '  <div class="nHelp">' +
    '    <small>CÓMO SE JUEGA</small>' +
    '    <p>Junta números iguales para sumar y llega a <b>2048</b>.</p>' +
    '    <p><span class="nKeys">← ↑ → ↓</span> en el teclado o el mando, o desliza en el móvil.</p>' +
    '    <p class="nDim">Atrás o Esc: volver al menú</p>' +
    '  </div>' +
    '</div>' +
    '<div class="ov ovbg center" id="nIntro">' +
    '  <p class="big1">¡Carrera de 2048!</p>' +
    '  <div class="huge" id="nIntroNum">3</div>' +
    '  <p class="sub fit" id="nIntroSub">Gana quien más puntos tenga</p>' +
    '</div>' +
    '<div class="ov" id="nEnd">' +
    '  <p class="nEndK">¡FIN DE LA CARRERA!</p>' +
    '  <div class="nEndT fit" id="nEndT">—</div>' +
    '  <ol class="nRank" id="nRank"></ol>' +
    '  <div class="nEndBtns">' +
    '    <div class="btn" id="nEndAgain">Otra carrera</div>' +
    '    <div class="btn" id="nEndMenu">Menú</div>' +
    '    <small>o elegidlo en el móvil</small>' +
    '  </div>' +
    '</div>' +
    '<div class="ov ovbg center" id="nPause">' +
    '  <p class="big2">Pausa</p>' +
    '  <div class="huge fit" id="nPauseWho" style="font-size:96px">Esperando…</div>' +
    '  <p class="sub fit">Volved a abrir la página en el móvil para seguir</p>' +
    '</div>';

  var M = null, metaAt = 0;
  var boards = {};                 // slot -> { el, boardEl, tilesEl, tiles: {id: el}, seq, size, cell, gap, ... }
  var layoutKey = '';
  var focusIndex = 0;              // buttons of «Sin movimientos» (solo) and of the ranking
  var lastClock = '';
  var endKey = '';
  var popFlip = false;

  function colorOf(s) { return host.colors()[s - 1] || '#ffffff'; }
  function nameOf(s) { return host.playerName(s - 1); }
  function mmss(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000 - 1e-6));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function clockLeft() {
    if (!M) return 0;
    if (M.paused || M.phase !== 'play') return M.clock;
    return Math.max(0, M.clock - (now() - metaAt) * (M.speed || 1));
  }
  function introLeft() {
    if (!M) return 0;
    return M.paused ? M.left : Math.max(0, M.left - (now() - metaAt) * (M.speed || 1));
  }
  function boardOf(slot) {
    if (!M) return null;
    for (var i = 0; i < M.boards.length; i++) if (M.boards[i].slot === slot) return M.boards[i];
    return null;
  }
  function mySolo() { return M && M.mode === 'solo' ? M.boards[0] : null; }

  // ---------------------------------------------------------------- layout
  // Rectangles of the cards in the 1920x1080 stage
  function rectsFor(n) {
    var out = [], i;
    if (n <= 1) return [{ x: 540, y: 150, w: 840, h: 840, o: 'solo' }];
    if (n === 2) {
      for (i = 0; i < 2; i++) out.push({ x: 50 + i * 930, y: TOP + 12, w: 890, h: 930, o: 'v' });
      return out;
    }
    var cols = n <= 4 ? 2 : 3;
    var w = cols === 2 ? 900 : 600, h = 456, gx = cols === 2 ? 30 : 24;
    for (i = 0; i < n; i++) {
      var row = i < cols ? 0 : 1;
      var inRow = row === 0 ? Math.min(cols, n) : n - cols;
      var k = row === 0 ? i : i - cols;
      var rowW = inRow * w + (inRow - 1) * gx;
      out.push({ x: Math.round((LW - rowW) / 2 + k * (w + gx)), y: TOP + 10 + row * (h + 20), w: w, h: h, o: cols === 2 ? 'h' : 'v' });
    }
    return out;
  }

  function buildBoards() {
    var area = $('nArea');
    area.innerHTML = '';
    boards = {};
    var n = M.boards.length;
    var rects = rectsFor(n);
    M.boards.forEach(function (bm, i) {
      var r = rects[i];
      var card = document.createElement('div');
      card.className = 'nCard ' + r.o;
      card.style.left = r.x + 'px';
      card.style.top = r.y + 'px';
      card.style.width = r.w + 'px';
      card.style.height = r.h + 'px';
      var size;
      var head = '';
      if (r.o === 'solo') size = r.w;
      else if (r.o === 'v') size = Math.min(r.w - 40, r.h - (n === 2 ? 110 : 76));
      else size = r.h - 32;
      if (r.o === 'v') {
        head = '<div class="nHead" style="height:' + (r.h - size - 20) + 'px"><span class="nName fit"></span><span class="nPts"></span></div>';
      } else if (r.o === 'h') {
        head = '<div class="nInfo" style="left:' + (size + 40) + 'px"><div class="nName fit"></div><small>PUNTOS</small><div class="nPts"></div><div class="nBestL fit"></div></div>';
      }
      card.innerHTML = head +
        '<div class="nBoard" style="width:' + size + 'px;height:' + size + 'px;' +
        (r.o === 'v' ? 'left:' + Math.round((r.w - size) / 2) + 'px;bottom:16px' : (r.o === 'h' ? 'left:16px;top:16px' : 'left:0;top:0')) + '">' +
        '<div class="nTiles"></div>' +
        '<div class="nOver"><div class="nOverIn">' +
        '  <div class="nOverT fit">Sin movimientos</div>' +
        '  <div class="nOverS fit"></div>' +
        (r.o === 'solo' ? '<div class="nOverB"><div class="btn" data-b="0">Otra</div><div class="btn" data-b="1">Menú</div></div><div class="nOverK">◀ ▶ y OK · o en el móvil</div>' : '') +
        '</div></div>' +
        (r.o === 'solo' ? '<div class="nCele"><div class="nCeleIn"><div class="nCeleT">¡Lo conseguiste!</div><div class="nCeleS">Has llegado a 2048</div><div class="btn focus">Seguir jugando</div><div class="nOverK">OK o una flecha para seguir</div></div></div>' : '') +
        '</div>';
      area.appendChild(card);
      var b = {
        slot: bm.slot, el: card, o: r.o, size: size,
        boardEl: card.querySelector('.nBoard'), tilesEl: card.querySelector('.nTiles'),
        tiles: {}, seq: -1, match: -1
      };
      b.gap = Math.round(size * 0.03);
      b.cell = (size - 5 * b.gap) / 4;
      b.radius = Math.max(6, Math.round(b.cell * 0.1));
      var bg = '';
      for (var c = 0; c < 16; c++) bg += '<i style="' + tileBox(b, c) + '"></i>';
      b.tilesEl.insertAdjacentHTML('beforebegin', '<div class="nCells">' + bg + '</div>');
      boards[bm.slot] = b;
    });
  }
  function tilePos(b, cell) {
    var col = cell % 4, row = Math.floor(cell / 4);
    return { x: Math.round(b.gap + col * (b.cell + b.gap)), y: Math.round(b.gap + row * (b.cell + b.gap)) };
  }
  function tileBox(b, cell) {
    var p = tilePos(b, cell);
    return 'left:' + p.x + 'px;top:' + p.y + 'px;width:' + Math.round(b.cell) + 'px;height:' + Math.round(b.cell) + 'px;border-radius:' + b.radius + 'px';
  }
  function place(el, b, cell) {
    var p = tilePos(b, cell);
    var tr = 'translate(' + p.x + 'px,' + p.y + 'px)';
    el.style.transform = tr;
    el.style.webkitTransform = tr;
  }
  function fontFor(b, v) {
    var d = String(v).length;
    var k = d <= 2 ? 0.5 : (d === 3 ? 0.42 : (d === 4 ? 0.33 : 0.26));
    return Math.round(b.cell * k);
  }
  function setValue(el, b, v) {
    if (el._v === v) return;
    el._v = v;
    var inner = el.firstChild;
    inner.className = 'nIn v' + (v <= 2048 ? v : 'big');
    inner.textContent = v;
    inner.style.fontSize = fontFor(b, v) + 'px';
  }

  // ---------------------------------------------------------------- render
  function renderTiles(b, bm) {
    var animate = b.match === M.match && bm.seq !== b.seq;
    var fresh = b.match !== M.match;
    if (!animate && !fresh && bm.seq === b.seq) return;
    if (fresh) { b.tilesEl.innerHTML = ''; b.tiles = {}; }
    b.match = M.match;
    b.seq = bm.seq;
    popFlip = !popFlip;
    var seen = {};
    var t = bm.tiles;
    for (var i = 0; i < t.length; i += 4) {
      var id = t[i], v = t[i + 1], cell = t[i + 2], f = t[i + 3];
      seen[id] = true;
      var el = b.tiles[id];
      if (!el) {
        el = document.createElement('div');
        el.className = 'nT';
        el.style.width = el.style.height = Math.round(b.cell) + 'px';
        el.innerHTML = '<div class="nIn" style="border-radius:' + b.radius + 'px"></div>';
        place(el, b, cell);
        setValue(el, b, v);
        if (animate && f === 1) el.firstChild.classList.add('nNew');
        b.tilesEl.appendChild(el);
        b.tiles[id] = el;
        continue;
      }
      el._gone = false;
      place(el, b, cell);
      var merged = el._v !== v;
      setValue(el, b, v);
      var inner = el.firstChild;
      inner.classList.remove('nNew');
      if (animate && (f === 2 || merged)) {
        // Two classes with the same animation: switching restarts it without a reflow
        inner.classList.remove(popFlip ? 'nPopB' : 'nPopA');
        inner.classList.add(popFlip ? 'nPopA' : 'nPopB');
      } else {
        inner.classList.remove('nPopA');
        inner.classList.remove('nPopB');
      }
    }
    // Tiles that went into another one: slide there, then go away
    var g = bm.gone || [];
    for (var j = 0; j < g.length; j += 2) {
      var ge = b.tiles[g[j]];
      if (!ge || seen[g[j]]) continue;
      if (animate) {
        place(ge, b, g[j + 1]);
        ge.style.zIndex = '0';
        ge._gone = true;
        (function (e2) { setTimeout(function () { if (e2._gone && e2.parentNode) e2.parentNode.removeChild(e2); }, 140); })(ge);
      } else if (ge.parentNode) ge.parentNode.removeChild(ge);
      delete b.tiles[g[j]];
      seen[g[j]] = true;
    }
    Object.keys(b.tiles).forEach(function (k) {
      if (!seen[k]) {
        var e3 = b.tiles[k];
        if (e3.parentNode) e3.parentNode.removeChild(e3);
        delete b.tiles[k];
      }
    });
  }

  function renderBoard(b, bm) {
    renderTiles(b, bm);
    var color = colorOf(bm.slot);
    var c = b.el;
    if (b.o !== 'solo') {
      c.style.borderColor = color;
      var nm = c.querySelector('.nName');
      setText(nm, nameOf(bm.slot) + (bm.won ? ' ★' : ''));
      nm.style.color = color;
      setText(c.querySelector('.nPts'), bm.score);
      if (b.o === 'h') {
        fit(nm, 52, 28);
        setText(c.querySelector('.nBestL'), 'Récord: ' + bm.best + (bm.rec ? ' · ¡nuevo!' : ''));
      } else fit(nm, M.boards.length === 2 ? 48 : 34, 22);
    }
    if (bm.over) c.classList.add('over'); else c.classList.remove('over');
    if (bm.cele) c.classList.add('cele'); else c.classList.remove('cele');
    var away = M.waiting.indexOf(nameOf(bm.slot)) >= 0;
    if (away) c.classList.add('away'); else c.classList.remove('away');
    if (bm.over) {
      setText(c.querySelector('.nOverS'), bm.score + ' puntos' + (M.mode === 'race' && M.phase === 'play' ? ' · espera a los demás' : ''));
      fit(c.querySelector('.nOverS'), b.o === 'solo' ? 60 : 30, 18);
      fit(c.querySelector('.nOverT'), b.o === 'solo' ? 90 : (M.boards.length > 4 ? 40 : 52), 22);
    }
  }

  function renderSolo(bm) {
    setText($('nWho'), nameOf(bm.slot));
    $('nWho').style.color = colorOf(bm.slot);
    fit($('nWho'), 60, 30);
    setText($('nScore'), bm.score);
    setText($('nBest'), bm.best);
    show($('nRec'), !!bm.rec);
    renderFocus();
  }

  function renderFocus() {
    var bs = view.querySelectorAll('.nCard.solo.over .nOverB .btn');
    for (var i = 0; i < bs.length; i++) { if (i === focusIndex) bs[i].classList.add('focus'); else bs[i].classList.remove('focus'); }
    var eb = [$('nEndAgain'), $('nEndMenu')];
    for (var j = 0; j < 2; j++) { if (j === focusIndex) eb[j].classList.add('focus'); else eb[j].classList.remove('focus'); }
  }

  function renderEnd() {
    var rk = M.ranking || [];
    var winners = rk.filter(function (r) { return r.rank === 1; });
    var t = $('nEndT');
    if (winners.length > 2) setText(t, '¡Empate entre ' + winners.length + '!');
    else setText(t, winners.length > 1 ? '¡Empate! ' + G2T.joinNames(winners.map(function (w) { return nameOf(w.slot); })) : '¡Gana ' + (winners[0] ? nameOf(winners[0].slot) : '') + '!');
    fit(t, 100, 36);
    var key = JSON.stringify(rk) + rk.map(function (r) { return nameOf(r.slot); }).join();
    if (key === endKey) return;
    endKey = key;
    var html = '';
    rk.forEach(function (r) {
      html += '<li><span class="medal m' + Math.min(r.rank, 4) + '">' + r.rank + '</span><span class="n fit" style="color:' + colorOf(r.slot) + '">' + esc(nameOf(r.slot)) + '</span>' +
        '<span class="mx">máx. ' + r.max + '</span><span class="sc">' + r.score + '</span></li>';
    });
    $('nRank').innerHTML = html;
    var ns = $('nRank').querySelectorAll('.n');
    for (var i = 0; i < ns.length; i++) fit(ns[i], 44, 24);
  }

  function render() {
    if (!M) return;
    var solo = M.mode === 'solo';
    view.className = 'view on ' + (solo ? 'nSolo' : 'nRace');
    var key = M.match + '|' + M.players.join(',');
    if (key !== layoutKey) { layoutKey = key; buildBoards(); focusIndex = 0; }
    M.boards.forEach(function (bm) { var b = boards[bm.slot]; if (b) renderBoard(b, bm); });
    show($('nSideL'), solo);
    show($('nSideR'), solo);
    if (solo && M.boards[0]) renderSolo(M.boards[0]);
    setText($('nHint'), solo ? 'Junta números iguales y llega a 2048' : 'Carrera · gana quien más puntos tenga');
    fit($('nHint'), 34, 20);
    show($('nIntro'), M.phase === 'intro' && !M.paused);
    show($('nPause'), !!M.paused && M.phase !== 'end');
    if (M.paused) { setText($('nPauseWho'), 'Esperando a ' + (M.waiting.length ? G2T.joinNames(M.waiting) : 'alguien') + '…'); fit($('nPauseWho'), 96, 40); }
    show($('nEnd'), M.phase === 'end');
    if (M.phase === 'end') { renderEnd(); renderFocus(); }
    updateClock();
  }

  function updateClock() {
    if (!M) return;
    var txt = M.mode === 'race' && M.phase !== 'end' ? mmss(clockLeft()) : '';
    if (txt !== lastClock) {
      lastClock = txt;
      setText($('nClock'), txt);
      var c = clockLeft();
      if (M.mode === 'race' && M.phase === 'play' && c <= 15000) $('nClock').classList.add('warn'); else $('nClock').classList.remove('warn');
      if (M.mode === 'race' && M.phase === 'play' && !M.paused && c <= 10000 && c > 0) beep(1000, 0.05, 'square', 0.05);
    }
    if (M.phase === 'intro') setText($('nIntroNum'), String(Math.max(1, Math.ceil(introLeft() / 1000 - 1e-6))));
  }

  function onMeta(m) {
    var prev = M;
    M = m;
    metaAt = now();
    if (!prev || prev.match !== m.match) { endKey = ''; focusIndex = 0; }
    // Sounds: a board gets stuck, the race ends
    if (prev && prev.match === m.match) {
      m.boards.forEach(function (bm) { var pb = null; prev.boards.forEach(function (x) { if (x.slot === bm.slot) pb = x; }); if (pb && !pb.over && bm.over) host.sfx.wrong(); });
      if (prev.phase !== 'end' && m.phase === 'end') { host.sfx.win(); host.confetti(); }
      if (prev.phase === 'intro' && m.phase === 'play') host.sfx.go();
    }
    render();
  }

  G2T.tv.register({
    id: '2048',
    mount: function (h) {
      host = h;
      show = h.show;
      setText = h.setText;
      fit = h.fit;
      view = document.createElement('section');
      view.id = 'v2048';
      view.className = 'view';
      view.innerHTML = HTML;
      h.addView(view);
    },
    enter: function () { show(view, true); },
    leave: function () {
      show(view, false);
      M = null; layoutKey = ''; endKey = ''; lastClock = ''; boards = {};
      $('nArea').innerHTML = '';
    },
    onHub: function () { endKey = ''; render(); },
    onMessage: function (msg) {
      if (msg.t === 'nmeta') onMeta(msg);
      else if (msg.t === 'n.win') {
        host.sfx.win();
        host.confetti();
        if (M && M.mode === 'race') host.toast('¡' + nameOf(msg.slot) + ' ha llegado a 2048!');
      }
    },
    onKey: function (e, dir, ok) {
      if (!M) return false;
      var arrow = KEY_DIRS[e.keyCode];
      var me = M.boards[0];
      if (M.phase === 'end' || (M.mode === 'solo' && me && me.over)) {
        if (dir) { focusIndex = clamp(focusIndex + dir, 0, 1); renderFocus(); host.sfx.move(); return true; }
        if (ok) { host.send(focusIndex === 0 ? { t: 'n.new' } : { t: 'menu' }); return true; }
        return false;
      }
      if (me && me.cele) {
        if (ok || arrow) { host.send({ t: 'n.cont' }); return true; }
        return false;
      }
      if (arrow && M.phase === 'play') { host.send({ t: 'n.move', dir: arrow }); return true; }
      return false;
    },
    frame: function () { updateClock(); },
    // For automated tests
    state: function () { return { meta: M, tiles: Object.keys(boards).map(function (s) { return Object.keys(boards[s].tiles).length; }) }; }
  });
})();
