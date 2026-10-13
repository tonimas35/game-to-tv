/*
 * «El Infiltrado»: TV view. Loaded by public/tv.html (ES2019).
 * DOM and CSS only (no canvas): whose turn it is, the round clock, the last
 * questions, the grid of possible places, the scoreboard, and overlays for
 * the accusations, the final vote, the spy's last chance, the reveal (a card
 * that flips) and the final ranking. The TV only ever gets the public state
 * (imeta): it never knows the place, the roles or the spy before the reveal.
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var $ = G2T.$, now = G2T.now, clamp = G2T.clamp, esc = G2T.esc;
  var host = null, view = null, show, setText, fit;
  var beep = G2T.sound.beep;
  var sfx = {
    accuse: function () { beep(330, 0.18, 'sawtooth', 0.07, 250); beep(330, 0.25, 'sawtooth', 0.07, 200, 0.22); },
    vote: function () { beep(520, 0.15, 'triangle', 0.12); beep(780, 0.2, 'triangle', 0.12, null, 0.14); },
    reveal: function () { beep(300, 0.3, 'sine', 0.1, 600); beep(600, 0.4, 'sine', 0.1, 900, 0.28); },
    fail: function () { beep(392, 0.25, 'sawtooth', 0.06, 330); beep(294, 0.4, 'sawtooth', 0.06, 220, 0.24); },
    clock: function () { beep(1000, 0.05, 'square', 0.05); }
  };

  var HOW = {
    acusacion: function (r) { return r.spyWins ? '¡Han acusado a un inocente!' : '¡Pillado en una acusación!'; },
    votacion: function () { return 'La votación señala a un inocente'; },
    empate: function () { return 'Empate en la votación'; },
    sinvotos: function () { return 'Se acabó el tiempo y nadie votó'; },
    adivina: function (r) { return r.guessOk ? '¡El infiltrado sabía el lugar!' : 'El infiltrado se la jugó… y falló'; },
    ultima: function (r) { return r.guessOk ? '¡Pillado, pero adivinó el lugar!' : (r.guess ? 'Pillado en la votación, y falló el lugar' : 'Pillado en la votación, y sin respuesta'); },
    abandono: function () { return 'El infiltrado ha abandonado'; }
  };

  var HTML =
    '<div class="inTop">' +
    '  <div class="inBrand">EL INFILTRADO</div>' +
    '  <div class="inRound" id="inRound">Ronda 1 de 4</div>' +
    '  <div class="inMins fit" id="inMins">Rondas de 6 min</div>' +
    '</div>' +
    '<div class="inLeft">' +
    '  <div class="inTurn" id="inTurn">' +
    '    <div class="l1 fit" id="inT1">Le toca preguntar a</div>' +
    '    <div class="l2 fit" id="inT2">—</div>' +
    '    <div class="l3 fit" id="inT3">Elige en el móvil a quién preguntar</div>' +
    '  </div>' +
    '  <div class="inClock" id="inClock">' +
    '    <small>TIEMPO DE LA RONDA</small>' +
    '    <b id="inClockNum">6:00</b>' +
    '    <div class="inBar"><i id="inBar"></i></div>' +
    '  </div>' +
    '  <div class="inHist"><small>ÚLTIMAS PREGUNTAS</small><ol id="inHist"></ol></div>' +
    '</div>' +
    '<div class="inRight">' +
    '  <div class="inGridHead"><small>LUGARES POSIBLES</small><span class="fit" id="inGridNote">Infiltrado: ¿cuál será?</span></div>' +
    '  <div class="inGrid" id="inGrid"></div>' +
    '</div>' +
    '<div class="inPlayers" id="inPlayers"></div>' +
    '<div class="inBanner fit" id="inBanner"></div>' +
    // ---- overlays
    '<div class="ov inOv center" id="inIntro">' +
    '  <p class="big1" id="inIRound">Ronda 1 de 4</p>' +
    '  <p class="big2">Mirad vuestra carta…</p>' +
    '  <div class="huge fit inSecret">¡en secreto!</div>' +
    '  <p class="sub fit" id="inIFirst">Empieza preguntando —</p>' +
    '</div>' +
    '<div class="ov inOv center" id="inAcc">' +
    '  <p class="big1 inWarn">¡ACUSACIÓN!</p>' +
    '  <div class="big2 inAccWho fit" id="inAccWho">— acusa a —</div>' +
    '  <p class="sub fit" id="inAccSub">¿Es el infiltrado? Votad Sí o No en el móvil: hace falta que todos digan Sí</p>' +
    '  <div class="inVoters" id="inAccVoters"></div>' +
    '  <div class="inCount" id="inAccNum">30</div>' +
    '</div>' +
    '<div class="ov inOv center" id="inVote">' +
    '  <p class="big1 inWarn">¡SE ACABÓ EL TIEMPO!</p>' +
    '  <div class="big2 fit">¿Quién es el infiltrado?</div>' +
    '  <p class="sub fit">Votad todos a la vez en el móvil (a uno mismo no se puede)</p>' +
    '  <div class="inVoters" id="inVoteVoters"></div>' +
    '  <div class="inCount" id="inVoteNum">45</div>' +
    '</div>' +
    '<div class="ov inOv center" id="inLast">' +
    '  <p class="big1 inWarn">¡PILLADO!</p>' +
    '  <div class="huge fit" id="inLastWho" style="height:230px;line-height:230px">—</div>' +
    '  <p class="big2 fit">era el infiltrado</p>' +
    '  <p class="sub fit">Última oportunidad: si adivina el lugar en 30 s, se lleva la ronda</p>' +
    '  <div class="inCount" id="inLastNum">30</div>' +
    '</div>' +
    '<div class="ov" id="inReveal">' +
    '  <div class="inRvTop fit" id="inRvTop">Ronda 1 de 4</div>' +
    '  <div class="inFlip" id="inFlip">' +
    '    <div class="inFlipIn">' +
    '      <div class="inFace inFront"><div class="inTab">EXPEDIENTE</div><div class="inStamp">CONFIDENCIAL</div><div class="inFq">?</div></div>' +
    '      <div class="inFace inBack">' +
    '        <small>EL INFILTRADO ERA</small><div class="inWho fit" id="inRvSpy">—</div>' +
    '        <small>EL LUGAR</small><div class="inLoc" id="inRvLoc">—</div>' +
    '        <div class="inOwn" id="inRvOwn">Lugar propio</div>' +
    '      </div>' +
    '    </div>' +
    '  </div>' +
    '  <div class="inRvRight">' +
    '    <div class="inHow fit" id="inRvHow">—</div>' +
    '    <div class="inDet fit" id="inRvDet"></div>' +
    '    <ul class="inRoles" id="inRvRoles"></ul>' +
    '    <div class="inPts" id="inRvPts"></div>' +
    '  </div>' +
    '  <div class="inRvFoot fit" id="inRvFoot">Siguiente ronda en 15 s · OK para seguir</div>' +
    '</div>' +
    '<div class="ov" id="inEnd">' +
    '  <p class="inEndK">¡FIN DE LA PARTIDA!</p>' +
    '  <div class="inEndT fit" id="inEndT">—</div>' +
    '  <ol class="inRank" id="inRank"></ol>' +
    '  <div class="inEndBtns">' +
    '    <div class="btn" id="inAgain">Jugar otra vez</div>' +
    '    <div class="btn" id="inMenu">Menú</div>' +
    '    <small>o elegidlo en el móvil</small>' +
    '  </div>' +
    '</div>' +
    '<div class="ov inOv center" id="inPause">' +
    '  <p class="big2">Pausa</p>' +
    '  <div class="huge fit" id="inPauseWho" style="font-size:96px">Esperando…</div>' +
    '  <p class="sub fit">Volved a abrir la página en el móvil para seguir</p>' +
    '</div>';

  var M = null, metaAt = 0;
  var keys = { grid: '', players: '', hist: '', turn: '', reveal: '', rank: '', voters: '' };
  var lastPhase = '', lastRound = 0, lastMatch = '', lastSec = -1, accSeq = 0, bannerUntil = 0, endIndex = 0, clockText = '';

  function colorOf(slot) { return host.colors()[slot - 1] || '#ffffff'; }
  function nameOf(slot) { return host.playerName(slot - 1); }
  function nameHtml(slot) { return '<b style="color:' + colorOf(slot) + '">' + esc(nameOf(slot)) + '</b>'; }
  function mmss(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000 - 1e-6));
    var m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  function phaseLeft() {
    if (!M) return 0;
    if (M.paused) return M.left;
    return Math.max(0, M.left - (now() - metaAt) * (M.speed || 1));
  }
  function clockLeft() {
    if (!M) return 0;
    if (M.paused || M.phase !== 'play') return M.clock;
    return Math.max(0, M.clock - (now() - metaAt) * (M.speed || 1));
  }

  function reset() {
    M = null;
    Object.keys(keys).forEach(function (k) { keys[k] = ''; });
    lastPhase = ''; lastRound = 0; lastMatch = ''; lastSec = -1; accSeq = 0; bannerUntil = 0; clockText = '';
    ['inIntro', 'inAcc', 'inVote', 'inLast', 'inReveal', 'inEnd', 'inPause'].forEach(function (id) { show($(id), false); });
    $('inFlip').classList.remove('on');
    $('inGrid').innerHTML = '';
    $('inBanner').classList.remove('on');
  }

  function onMeta(m) {
    var prev = M;
    M = m;
    metaAt = now();
    var newRound = !prev || prev.match !== m.match || prev.round !== m.round;
    if (m.match !== lastMatch) { lastMatch = m.match; accSeq = m.accResult ? m.accResult.seq : 0; }
    if (m.phase !== lastPhase || newRound) {
      onPhase(m, lastPhase);
      lastPhase = m.phase;
      lastRound = m.round;
    }
    if (m.accResult && m.accResult.seq !== accSeq) {
      accSeq = m.accResult.seq;
      var a = m.accResult;
      showBanner('La acusación de ' + nameOf(a.by) + ' contra ' + nameOf(a.suspect) + ' no prospera: ' + a.yes + ' a favor, ' + (a.no + a.none) + ' en contra', 7000);
      sfx.fail();
    }
    render();
  }

  function onPhase(m) {
    if (m.phase !== 'play') { bannerUntil = 0; $('inBanner').classList.remove('on'); }
    switch (m.phase) {
      case 'intro': host.sfx.pick(); break;
      case 'accuse': sfx.accuse(); break;
      case 'vote': sfx.vote(); break;
      case 'lastguess': sfx.accuse(); break;
      case 'reveal':
        sfx.reveal();
        $('inFlip').classList.remove('on');
        // The card flips a moment after the overlay appears
        setTimeout(function () { if (M && M.phase === 'reveal') $('inFlip').classList.add('on'); }, 450);
        break;
      case 'end':
        endIndex = 0;
        host.sfx.win();
        host.confetti();
        break;
    }
  }

  function showBanner(text, ms) {
    var b = $('inBanner');
    setText(b, text);
    b.classList.add('on');
    fit(b, 34, 20);
    bannerUntil = now() + (ms || 6000);
  }

  // ---------------------------------------------------------------- render
  function render() {
    if (!M) return;
    var m = M;
    setText($('inRound'), m.phase === 'end' ? 'Fin de la partida' : 'Ronda ' + m.round + ' de ' + m.rounds);
    setText($('inMins'), 'Rondas de ' + m.minutes + ' min · ' + m.players.length + ' jugadores');
    fit($('inMins'), 28, 18);
    renderTurn(m);
    renderHist(m);
    renderGrid(m);
    renderPlayers(m);
    renderOverlays(m);
    updateClock();
  }

  function renderTurn(m) {
    var last = m.history.length ? m.history[m.history.length - 1] : null;
    var key = m.asker + '|' + m.askedBy + '|' + (last ? last.from + '>' + last.to : '') + '|' + nameOf(m.asker) + '|' + m.phase;
    if (key === keys.turn) return;
    keys.turn = key;
    var t1 = $('inT1'), t2 = $('inT2'), t3 = $('inT3');
    if (last && last.to === m.asker) {
      t1.innerHTML = nameHtml(last.from) + ' pregunta a';
      setText(t2, nameOf(last.to));
      t2.style.color = colorOf(last.to);
      setText(t3, 'Luego pregunta ' + nameOf(last.to) + ' (a ' + nameOf(last.from) + ' no puede)');
    } else {
      setText(t1, 'Le toca preguntar a');
      setText(t2, nameOf(m.asker));
      t2.style.color = colorOf(m.asker);
      setText(t3, 'Elige en el móvil a quién preguntar');
    }
    fit(t1, 40, 24);
    fit(t2, 104, 44);
    fit(t3, 26, 18);
  }

  function renderHist(m) {
    var key = JSON.stringify(m.history) + m.players.map(nameOf).join();
    if (key === keys.hist) return;
    keys.hist = key;
    var html = '';
    for (var i = m.history.length - 1; i >= 0; i--) {
      var h = m.history[i];
      html += '<li class="' + (i === m.history.length - 1 ? 'new' : '') + '"><span class="fit">' + nameHtml(h.from) + ' <i>→</i> ' + nameHtml(h.to) + '</span></li>';
    }
    if (!html) html = '<li class="empty">Aún no ha preguntado nadie</li>';
    $('inHist').innerHTML = html;
    var spans = $('inHist').querySelectorAll('span');
    for (var k = 0; k < spans.length; k++) fit(spans[k], 30, 18);
  }

  // The grid of places: built once per round (5 to 7 columns, 1 or 2 lines per name)
  function renderGrid(m) {
    var key = m.match + '|' + m.round + '|' + JSON.stringify(m.places);
    if (key === keys.grid) return;
    keys.grid = key;
    var n = m.places.length;
    // 5 columns while rows stay tall enough for 2 lines; then 6 or 7
    var cols = n <= 60 ? 5 : (n <= 72 ? 6 : 7);
    var rows = Math.ceil(n / cols);
    var gap = rows > 10 ? 8 : 10;
    var rowH = Math.floor((770 - (rows - 1) * gap) / rows);
    var grid = $('inGrid');
    grid.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
    grid.style.gridAutoRows = rowH + 'px';
    grid.style.gridGap = gap + 'px';
    grid.style.gap = gap + 'px';
    var html = '';
    m.places.forEach(function (p) {
      html += '<div class="pl' + (p.custom ? ' own' : '') + (p.used ? ' used' : '') + '"><span>' + esc(p.name) + '</span>' + (p.custom ? '<i></i>' : '') + '</div>';
    });
    grid.innerHTML = html;
    // One font size for the whole grid: the biggest one with which every name fits in 2 lines
    var spans = grid.querySelectorAll('span');
    var font = Math.max(14, Math.min(26, Math.floor(rowH * 0.36)));
    for (var guard = 0; guard < 14; guard++) {
      grid.style.fontSize = font + 'px';
      var bad = false;
      for (var i = 0; i < spans.length && !bad; i++) {
        if (spans[i].scrollHeight > spans[i].clientHeight + 1 || spans[i].scrollWidth > spans[i].clientWidth + 1) bad = true;
      }
      if (!bad || font <= 14) break;
      font -= 1;
    }
    var used = m.places.filter(function (p) { return p.used; }).length;
    var own = m.places.filter(function (p) { return p.custom; }).length;
    setText($('inGridNote'), n + ' lugares' + (own ? ' · en dorado, los propios' : '') + (used ? ' · tachados, los que ya han salido' : '') + ' · ¡uno es el bueno!');
    fit($('inGridNote'), 24, 16);
  }

  function renderPlayers(m) {
    var key = JSON.stringify([m.players, m.scores, m.accUsed, m.asker, m.waiting]) + m.players.map(nameOf).join();
    if (key === keys.players) return;
    keys.players = key;
    var html = '';
    m.players.forEach(function (s) {
      var away = m.waiting.indexOf(nameOf(s)) >= 0;
      html += '<div class="pc' + (s === m.asker && m.phase === 'play' ? ' ask' : '') + (away ? ' away' : '') + '" style="border-color:' + colorOf(s) + '">' +
        '<span class="dot" style="background:' + colorOf(s) + '"></span><span class="tx"><span class="n fit" style="color:' + colorOf(s) + '">' + esc(nameOf(s)) + '</span>' +
        (m.accUsed.indexOf(s) >= 0 ? '<em>ya acusó</em>' : '') + '</span><b>' + (m.scores[s - 1] || 0) + '</b></div>';
    });
    var box = $('inPlayers');
    box.className = 'inPlayers n' + m.players.length;
    box.innerHTML = html;
    var ns = box.querySelectorAll('.n');
    for (var i = 0; i < ns.length; i++) fit(ns[i], 30, 16);
  }

  function votersHtml(voters, voted, label) {
    return voters.map(function (s) {
      var ok = voted.indexOf(s) >= 0;
      return '<span class="' + (ok ? 'ok' : '') + '" style="border-color:' + colorOf(s) + '"><i style="background:' + colorOf(s) + '"></i><b class="fit">' + esc(nameOf(s)) + '</b><em>' + (ok ? label : '…') + '</em></span>';
    }).join('');
  }

  function renderOverlays(m) {
    var ph = m.phase;
    show($('inPause'), !!m.paused && ph !== 'end');
    if (m.paused) { setText($('inPauseWho'), 'Esperando a ' + (m.waiting.length ? G2T.joinNames(m.waiting) : 'alguien') + '…'); fit($('inPauseWho'), 96, 40); }
    show($('inIntro'), ph === 'intro');
    show($('inAcc'), ph === 'accuse' && !!m.acc);
    show($('inVote'), ph === 'vote' && !!m.vote);
    show($('inLast'), ph === 'lastguess');
    show($('inReveal'), ph === 'reveal' && !!m.result);
    show($('inEnd'), ph === 'end');
    if (ph === 'intro') {
      setText($('inIRound'), 'Ronda ' + m.round + ' de ' + m.rounds);
      $('inIFirst').innerHTML = 'Empieza preguntando ' + nameHtml(m.asker);
      fit($('inIFirst'), 40, 24);
    }
    if (ph === 'accuse' && m.acc) {
      $('inAccWho').innerHTML = nameHtml(m.acc.by) + ' acusa a ' + nameHtml(m.acc.suspect);
      fit($('inAccWho'), 64, 32);
      var k1 = 'a' + JSON.stringify(m.acc) + m.players.map(nameOf).join();
      if (k1 !== keys.voters) { keys.voters = k1; $('inAccVoters').innerHTML = votersHtml(m.acc.voters, m.acc.voted, 'ha votado'); fitVoters('inAccVoters'); }
    }
    if (ph === 'vote' && m.vote) {
      var k2 = 'v' + JSON.stringify(m.vote) + m.players.map(nameOf).join();
      if (k2 !== keys.voters) { keys.voters = k2; $('inVoteVoters').innerHTML = votersHtml(m.vote.voters, m.vote.voted, 'ha votado'); fitVoters('inVoteVoters'); }
    }
    if (ph === 'lastguess') {
      var lw = $('inLastWho');
      setText(lw, nameOf(m.caught));
      lw.style.color = colorOf(m.caught);
      fit(lw, 170, 60);
    }
    if (ph === 'reveal' && m.result) renderReveal(m);
    if (ph === 'end') renderEnd(m);
  }
  function fitVoters(id) {
    var bs = $(id).querySelectorAll('b');
    for (var i = 0; i < bs.length; i++) fit(bs[i], 30, 18);
  }

  function renderReveal(m) {
    var r = m.result;
    var key = m.match + m.round + JSON.stringify(r);
    if (key === keys.reveal) return;
    keys.reveal = key;
    setText($('inRvTop'), 'Ronda ' + m.round + ' de ' + m.rounds + ' · ¡Se desvela todo!');
    var spy = $('inRvSpy');
    setText(spy, r.spyName);
    spy.style.color = colorOf(r.spy);
    fit(spy, 84, 36);
    var loc = $('inRvLoc');
    setText(loc, r.location);
    loc.style.fontSize = (r.location.length > 22 ? 46 : 58) + 'px';
    $('inRvOwn').style.display = r.custom ? 'inline-block' : 'none';
    var how = $('inRvHow');
    setText(how, (HOW[r.how] || HOW.votacion)(r));
    how.style.color = r.spyWins === null ? '#ffffff' : (r.spyWins ? 'var(--bad)' : 'var(--ok)');
    fit(how, 60, 30);
    var det = '';
    if (r.how === 'acusacion') det = nameOf(r.accuser) + ' acusó a ' + nameOf(r.suspect) + ' y todos dijeron que sí';
    else if (r.how === 'votacion' || r.how === 'empate') det = 'Votos: ' + (r.tally || []).map(function (t) { return nameOf(t.slot) + ' ' + t.votes; }).join(' · ');
    else if (r.how === 'ultima') det = r.guess ? 'Dijo «' + r.guess + '»' : 'No contestó a tiempo';
    else if (r.how === 'adivina') det = 'Dijo «' + r.guess + '»';
    else if (r.how === 'sinvotos') det = 'Sin votos, el infiltrado se salva';
    else if (r.how === 'abandono') det = 'Ronda sin puntos';
    setText($('inRvDet'), det);
    fit($('inRvDet'), 32, 20);
    var pts = {};
    r.points.forEach(function (p) { pts[p.slot] = p.pts; });
    var k = 0;
    function row(slot, name, role, cls) {
      var p = pts[slot];
      var badge = p ? '<span class="inP pop" style="animation-delay:' + (1.1 + (k++) * 0.15).toFixed(2) + 's">+' + p + '</span>' : '<span class="inP zero">—</span>';
      return '<li class="' + cls + '"><span class="dot" style="background:' + colorOf(slot) + '"></span><b class="fit" style="color:' + colorOf(slot) + '">' + esc(name) + '</b><em class="fit">' + esc(role) + '</em>' + badge + '</li>';
    }
    var html = row(r.spy, r.spyName, 'Infiltrado', 'spy');
    r.roles.forEach(function (x) { html += row(x.slot, x.name, x.role, ''); });
    $('inRvRoles').innerHTML = html;
    var fs = $('inRvRoles').querySelectorAll('.fit');
    for (var i = 0; i < fs.length; i++) fit(fs[i], 32, 18);
    // Scoreboard after the round
    var sb = '<small>' + (r.points.length ? 'MARCADOR' : 'NADIE SUMA PUNTOS · MARCADOR') + '</small><div>';
    m.players.forEach(function (s2) {
      sb += '<span style="border-color:' + colorOf(s2) + '"><i class="fit" style="color:' + colorOf(s2) + '">' + esc(nameOf(s2)) + '</i><b>' + (r.scores[s2 - 1] || 0) + '</b></span>';
    });
    $('inRvPts').innerHTML = sb + '</div>';
    var is = $('inRvPts').querySelectorAll('i');
    for (var j = 0; j < is.length; j++) fit(is[j], 26, 16);
  }

  function renderEnd(m) {
    var rk = m.ranking || [];
    var winners = rk.filter(function (r) { return r.rank === 1; });
    var t = $('inEndT');
    if (winners.length > 2) setText(t, '¡Empate entre ' + winners.length + '!');
    else setText(t, winners.length > 1 ? '¡Empate! ' + G2T.joinNames(winners.map(function (w) { return nameOf(w.slot); })) : '¡Gana ' + (winners[0] ? nameOf(winners[0].slot) : '') + '!');
    fit(t, 100, 36);
    var key = JSON.stringify(rk) + rk.map(function (r) { return nameOf(r.slot); }).join();
    if (key !== keys.rank) {
      keys.rank = key;
      var html = '';
      rk.forEach(function (r) {
        html += '<li><span class="medal m' + Math.min(r.rank, 4) + '">' + r.rank + '</span><span class="n fit" style="color:' + colorOf(r.slot) + '">' + esc(nameOf(r.slot)) + '</span><span class="sc">' + r.score + '</span></li>';
      });
      $('inRank').innerHTML = html;
      var ns = $('inRank').querySelectorAll('.n');
      for (var i = 0; i < ns.length; i++) fit(ns[i], 44, 24);
    }
    renderFocus();
  }
  function renderFocus() {
    var b = [$('inAgain'), $('inMenu')];
    for (var i = 0; i < 2; i++) { if (i === endIndex) b[i].classList.add('focus'); else b[i].classList.remove('focus'); }
  }

  // Every frame: only text that changes once a second
  function updateClock() {
    if (!M) return;
    var c = clockLeft();
    var txt = M.paused ? 'Pausa' : mmss(c);
    if (txt !== clockText) {
      clockText = txt;
      setText($('inClockNum'), txt);
      var warn = !M.paused && c <= 30000 && (M.phase === 'play' || M.phase === 'accuse');
      if (warn) $('inClock').classList.add('warn'); else $('inClock').classList.remove('warn');
      var frac = M.clockTotal ? clamp(c / M.clockTotal, 0, 1) : 0;
      var tr = 'scaleX(' + frac.toFixed(3) + ')';
      $('inBar').style.transform = tr;
      $('inBar').style.webkitTransform = tr;
      var sec = Math.ceil(c / 1000);
      if (M.phase === 'play' && !M.paused && sec <= 10 && sec > 0 && sec !== lastSec) sfx.clock();
      lastSec = sec;
    }
    var left = phaseLeft();
    var s = String(Math.max(0, Math.ceil(left / 1000 - 1e-6)));
    if (M.phase === 'accuse') setText($('inAccNum'), s);
    else if (M.phase === 'vote') setText($('inVoteNum'), s);
    else if (M.phase === 'lastguess') setText($('inLastNum'), s);
    else if (M.phase === 'reveal') setText($('inRvFoot'), M.round >= M.rounds ? 'Clasificación final en ' + s + ' s · OK para verla' : 'Siguiente ronda en ' + s + ' s · OK para seguir');
    if (bannerUntil && now() > bannerUntil) { bannerUntil = 0; $('inBanner').classList.remove('on'); }
  }

  G2T.tv.register({
    id: 'infiltrado',
    mount: function (h) {
      host = h;
      show = h.show;
      setText = h.setText;
      fit = h.fit;
      view = document.createElement('section');
      view.id = 'vInfiltrado';
      view.className = 'view';
      view.innerHTML = HTML;
      h.addView(view);
    },
    enter: function () { show(view, true); },
    leave: function () { show(view, false); reset(); },
    onHub: function () { keys.players = ''; keys.hist = ''; keys.turn = ''; render(); },
    onMessage: function (msg) { if (msg.t === 'imeta') onMeta(msg); },
    onKey: function (e, dir, ok) {
      if (!M) return false;
      if (M.phase === 'reveal' && ok) { host.send({ t: 'i.next' }); return true; }
      if (M.phase !== 'end') return false;
      if (dir) { endIndex = clamp(endIndex + dir, 0, 1); renderFocus(); host.sfx.move(); return true; }
      if (ok) { host.send(endIndex === 0 ? { t: 'i.again' } : { t: 'menu' }); return true; }
      return false;
    },
    frame: function () { updateClock(); },
    // For automated tests
    state: function () { return { meta: M }; }
  });
})();
