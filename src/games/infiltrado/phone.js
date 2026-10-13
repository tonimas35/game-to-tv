/*
 * «El Infiltrado»: phone view. Loaded by public/m.html (ES2019).
 * - The secret card is a dossier that stays COVERED: press and hold (or tap
 *   «Ver») to look at it; it hides again on release or after 3 s, and with
 *   «Ocultar». While covered it looks exactly the same for everybody (the
 *   secret is not even in the page), so a glance from the sofa tells nothing.
 *   The spy's «¡Sé el lugar!» button lives inside the uncovered card.
 * - Turns: the asker picks whom to ask («Pregunto a…»).
 * - «Acusar» (once per round), the Sí/No vote, the final vote, the spy's
 *   last chance, the reveal and the final ranking.
 * - «Lugares»: the list of places, to cross them out privately as notes.
 * - «?»: how to play (from the manifest).
 * - Menu panel: round length (any player) and «Lugares propios» (max 5).
 * Votes are never sent back by the server: this phone remembers its own.
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var $ = G2T.$, esc = G2T.esc, now = G2T.now;
  var host = null, show, setText;
  var ST = G2T.store;

  var HTML =
    '<div class="bar">' +
    '  <div class="chip"><span class="dot"></span><span class="meName">Jugador</span></div>' +
    '  <div class="info" id="ipInfo">Ronda 1/4</div>' +
    '  <button class="mini ghost ipHelpBtn" type="button" aria-label="Cómo se juega">?</button>' +
    '  <button class="mini ghost menuBtn" type="button">Menú</button>' +
    '</div>' +
    // Watching (joined in the middle of a match)
    '<div class="pn center hidden" id="ipWatch"><p class="k1">El Infiltrado</p><div class="k2">Estás mirando</div><p class="k3">Entrarás en la próxima partida. ¡Mira la tele!</p></div>' +
    // Main: the card, the turn and the actions
    '<div class="pn scroll hidden" id="ipMain">' +
    '  <div class="ipStatus hidden" id="ipStatus"></div>' +
    '  <div class="ipCard" id="ipCard">' +
    '    <div class="ipTab">EXPEDIENTE</div>' +
    '    <div class="ipCover" id="ipCover"><div class="ipStamp">CONFIDENCIAL</div><p>Mantén pulsado para ver tu carta</p><small>Que no la vea nadie</small></div>' +
    '    <div class="ipPaper hidden" id="ipPaper"></div>' +
    '  </div>' +
    '  <div class="ipRow"><button type="button" class="ghost" id="ipSee">Ver</button><button type="button" class="ghost" id="ipHide">Ocultar</button></div>' +
    '  <div class="ipTurn" id="ipTurn"></div>' +
    '  <div class="ipRow ipAct"><button type="button" class="ghost" id="ipPlacesBtn">Lugares</button><button type="button" class="ipAccBtn" id="ipAccBtn">Acusar</button></div>' +
    '</div>' +
    // Lists: places (notes / the spy's guess) and players (accuse / final vote)
    '<div class="pn hidden" id="ipList">' +
    '  <div class="ipListHead"><div><b id="ipListT">Lugares</b><small id="ipListS"></small></div><button type="button" class="mini ghost" id="ipListBack">Volver</button></div>' +
    '  <div class="ipListBody scroll" id="ipListBody"></div>' +
    '</div>' +
    // Accusation vote
    '<div class="pn center hidden" id="ipVote">' +
    '  <p class="k1 ipWarn">¡ACUSACIÓN!</p>' +
    '  <div class="k2" id="ipVoteWho">— acusa a —</div>' +
    '  <p class="k3">¿Es el infiltrado? Hace falta que todos digáis Sí.</p>' +
    '  <div class="ipYesNo"><button type="button" id="ipYes">Sí</button><button type="button" class="ghost" id="ipNo">No</button></div>' +
    '  <p class="k1" id="ipVoteTime">30 s</p>' +
    '</div>' +
    // Reveal and end
    '<div class="pn center scroll hidden" id="ipReveal">' +
    '  <p class="k1" id="ipRvHow">—</p>' +
    '  <div class="k2" id="ipRvTitle">—</div>' +
    '  <div class="ipRvBox"><small>EL LUGAR ERA</small><b id="ipRvLoc">—</b><small id="ipRvRoleL">TU PAPEL</small><b id="ipRvRole">—</b></div>' +
    '  <p class="k3" id="ipRvPts"></p>' +
    '  <button type="button" class="bigbtn c" id="ipNext">Siguiente ronda</button>' +
    '</div>' +
    '<div class="pn center scroll hidden" id="ipEnd">' +
    '  <p class="k1">¡Partida terminada!</p>' +
    '  <div class="k2" id="ipEndPos">—</div>' +
    '  <p class="k3" id="ipEndSub"></p>' +
    '  <ol class="ipRank" id="ipRank"></ol>' +
    '  <button class="bigbtn c" id="ipAgain" type="button">Jugar otra vez</button>' +
    '  <button class="bigbtn ghost menuBtn" type="button" style="margin-top:12px;font-size:22px;padding:16px">Menú</button>' +
    '</div>';

  var PAUSE_HTML = '<div class="t1">Pausa</div><div class="t2" id="ipPauseWho" style="font-size:24px;font-weight:800;color:#fff">Esperando…</div><div class="t2">El tiempo está parado hasta que vuelva.</div>';
  var HELP_HTML = '<div class="ipHelpBox"><h2>Cómo se juega</h2><ol id="ipHelpList"></ol><button type="button" class="bigbtn c" id="ipHelpOk">Entendido</button></div>';

  var MENU_HTML =
    '<div class="ipMenu">' +
    '  <h3><span>El Infiltrado</span><small>3 a 6 jugadores</small></h3>' +
    '  <p class="small">Duración de cada ronda (cualquiera puede cambiarla):</p>' +
    '  <div class="ipMins" id="ipMins"></div>' +
    '  <p class="small" id="ipMinsNote">Automático: 6 min con 3 o 4 jugadores, 8 con 5 o 6.</p>' +
    '  <h4><span>Lugares propios</span><span id="ipOwnCount">0/5</span></h4>' +
    '  <p class="small">Se suman a la lista en esta sesión. Si eres el infiltrado, nunca te saldrá uno tuyo.</p>' +
    '  <form class="ipOwnForm" id="ipOwnForm" autocomplete="off" novalidate>' +
    '    <input id="ipOwnName" type="text" maxlength="30" autocomplete="off" autocorrect="off" autocapitalize="sentences" spellcheck="false" enterkeyhint="next" placeholder="Lugar. Ej.: El pueblo de la abuela">' +
    '    <input id="ipOwnRoles" type="text" maxlength="160" autocomplete="off" autocorrect="off" autocapitalize="sentences" spellcheck="false" enterkeyhint="done" placeholder="Papeles, separados por comas (opcional)">' +
    '    <button type="submit" id="ipOwnAdd">Añadir lugar</button>' +
    '  </form>' +
    '  <ul id="ipOwnList"></ul>' +
    '</div>';

  var M = null, metaAt = 0;
  var card = null;                 // my secret card for this round (or null)
  var panel = 'main';              // main | places | accuse | guess | final | last
  var revealed = false, revealTimer = null, pressAt = 0;
  var myAcc = {}, myFinal = {};    // what I voted (key: match|round|seq)
  var myPlaces = [], maxPlaces = 5, cfg = { minutes: 0, by: '', options: [4, 6, 8, 10] };
  var lastKey = '';

  function me() { return host.slot(); }
  function inMatch() { return !!(M && M.players.indexOf(me()) >= 0); }
  function colorOf(s) { return host.colors()[s - 1] || '#ffffff'; }
  function nameOf(s) { return host.nameOf(s); }
  function nameHtml(s) { return '<b style="color:' + colorOf(s) + '">' + esc(nameOf(s)) + '</b>'; }
  function isActive() { var h = host.hub(); return !!(h && h.screen === 'infiltrado'); }
  function roundKey() { return M ? M.match + '|' + M.round : ''; }
  function myCard() { return card && M && card.match === M.match && card.round === M.round ? card : null; }
  // The spy can say «¡Sé el lugar!» during the intro, the round and an accusation
  function canGuess() { return !!(M && (M.phase === 'intro' || M.phase === 'play' || M.phase === 'accuse')); }
  function amSpy() { var c = myCard(); return !!(c && c.spy); }
  function left() { if (!M) return 0; return M.paused ? M.left : Math.max(0, M.left - (now() - metaAt) * (M.speed || 1)); }
  function clock() { if (!M) return 0; return M.paused || M.phase !== 'play' ? M.clock : Math.max(0, M.clock - (now() - metaAt) * (M.speed || 1)); }
  function secs(ms) { return Math.max(0, Math.ceil(ms / 1000 - 1e-6)); }
  function mmss(ms) { var s = secs(ms); return Math.floor(s / 60) + ':' + ((s % 60) < 10 ? '0' : '') + (s % 60); }

  // ---------------------------------------------------------------- notes (crossed out places)
  function notesKey() { return 'inf.notes.' + roundKey(); }
  function notes() {
    try { return JSON.parse(ST.get(ST.session, notesKey()) || '[]'); } catch (e) { return []; }
  }
  function toggleNote(i) {
    var n = notes();
    var k = n.indexOf(i);
    if (k >= 0) n.splice(k, 1); else n.push(i);
    ST.set(ST.session, notesKey(), JSON.stringify(n));
  }

  // ---------------------------------------------------------------- the card
  function paperHtml() {
    var c = myCard();
    if (!c) return '<div class="ipPaperIn"><p class="ipLbl">Esperando tu carta…</p></div>';
    if (c.spy) {
      return '<div class="ipPaperIn spy"><p class="ipLbl">TU CARTA</p><div class="ipSpy">ERES EL INFILTRADO</div>' +
        '<p class="ipSpySub">No sabes el lugar. Escucha, disimula y adivínalo.</p>' +
        (canGuess() ? '<button type="button" class="ipKnow" id="ipKnow">¡Sé el lugar!</button>' : '') + '</div>';
    }
    return '<div class="ipPaperIn"><p class="ipLbl">EL LUGAR</p><div class="ipLoc">' + esc(c.location) + '</div>' +
      '<p class="ipLbl">TU PAPEL</p><div class="ipRole">' + esc(c.role) + '</div></div>';
  }
  function reveal(ms) {
    if (!myCard()) return;
    if (!revealed) {
      // The secret goes into the page only while it is uncovered
      $('ipPaper').innerHTML = paperHtml();
      show($('ipPaper'), true);
      show($('ipCover'), false);
      $('ipCard').classList.add('open');
      revealed = true;
    }
    clearTimeout(revealTimer);
    if (ms) revealTimer = setTimeout(cover, ms);
  }
  function cover() {
    clearTimeout(revealTimer);
    revealTimer = null;
    if (!revealed) return;
    revealed = false;
    $('ipPaper').innerHTML = '';
    show($('ipPaper'), false);
    show($('ipCover'), true);
    $('ipCard').classList.remove('open');
  }

  function bindCard() {
    var cardEl = $('ipCard');
    function down(e) {
      if (e.target && e.target.id === 'ipKnow') return;
      if (e.cancelable) e.preventDefault();
      pressAt = now();
      reveal(0);
    }
    function up(e) {
      if (e && e.target && e.target.id === 'ipKnow') return;
      if (!pressAt) return;
      var held = now() - pressAt;
      pressAt = 0;
      // Held: hides on release. A quick tap: stays open up to 3 s
      if (held >= 350) cover(); else reveal(3000);
    }
    cardEl.addEventListener('touchstart', down, { passive: false });
    cardEl.addEventListener('touchend', up, { passive: false });
    cardEl.addEventListener('touchcancel', function () { pressAt = 0; cover(); });
    cardEl.addEventListener('mousedown', down);
    window.addEventListener('mouseup', function (e) { if (pressAt) up(e); });
    cardEl.addEventListener('click', function (e) {
      if (e.target && e.target.id === 'ipKnow') {
        cover();
        openList('guess');
      }
    });
    $('ipSee').addEventListener('click', function () { if (revealed) cover(); else reveal(3000); });
    $('ipHide').addEventListener('click', cover);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState !== 'visible') cover(); });
  }

  // ---------------------------------------------------------------- lists
  function openList(kind) { cover(); panel = kind; render(); }
  function closeList() { panel = 'main'; render(); }

  function renderList() {
    var body = $('ipListBody');
    var t = $('ipListT'), s = $('ipListS');
    show($('ipListBack'), panel !== 'final' && panel !== 'last');
    var html = '', key;
    if (panel === 'places' || panel === 'guess' || panel === 'last') {
      var n = notes();
      if (panel === 'places') { setText(t, 'Lugares posibles'); setText(s, 'Toca para tachar (solo lo ves tú)'); }
      else if (panel === 'guess') { setText(t, '¡Sé el lugar!'); setText(s, 'Si fallas, pierdes la ronda'); }
      else { setText(t, '¡Te han pillado!'); setText(s, 'Última oportunidad: ¿dónde estáis? · ' + secs(left()) + ' s'); }
      key = panel + roundKey() + JSON.stringify(n) + JSON.stringify(M.places);
      if (body.getAttribute('data-key') === key) return;
      M.places.forEach(function (p, i) {
        html += '<button type="button" class="ipPl' + (n.indexOf(i) >= 0 ? ' x' : '') + (p.used ? ' used' : '') + '" data-i="' + i + '"' + (p.used && panel !== 'places' ? ' disabled' : '') + '>' +
          '<span>' + esc(p.name) + '</span>' + (p.used ? '<em>ya salió</em>' : (p.custom ? '<em>propio</em>' : '')) + '</button>';
      });
      body.className = 'ipListBody scroll ' + (panel === 'places' ? 'notes' : 'pick');
    } else {
      var who = M.players.filter(function (x) { return x !== me(); });
      if (panel === 'accuse') { setText(t, '¿A quién acusas?'); setText(s, 'Solo una acusación por ronda'); }
      else { setText(t, '¿Quién es el infiltrado?'); setText(s, 'Votación final · ' + secs(left()) + ' s'); }
      key = panel + roundKey() + who.map(nameOf).join();
      if (body.getAttribute('data-key') === key) return;
      who.forEach(function (x) {
        html += '<button type="button" class="ipWho" data-s="' + x + '" style="border-color:' + colorOf(x) + '"><i style="background:' + colorOf(x) + '"></i><span style="color:' + colorOf(x) + '">' + esc(nameOf(x)) + '</span></button>';
      });
      body.className = 'ipListBody scroll who';
    }
    body.setAttribute('data-key', key);
    body.innerHTML = html;
  }

  function onListTap(e) {
    var b = e.target;
    while (b && b !== this && !(b.getAttribute && (b.getAttribute('data-i') || b.getAttribute('data-s')))) b = b.parentNode;
    if (!b || b === this || b.disabled) return;
    if (b.getAttribute('data-i')) {
      var i = parseInt(b.getAttribute('data-i'), 10);
      var p = M.places[i];
      if (panel === 'places') { toggleNote(i); renderList(); return; }
      host.askConfirm('¿Seguro que es «' + p.name + '»? ' + (panel === 'last' ? 'Es tu última oportunidad.' : 'Si fallas, pierdes la ronda.'), 'Sí, es ese', function () {
        host.send({ t: 'i.guess', i: i });
        host.vibrate(30);
      });
      return;
    }
    var s = parseInt(b.getAttribute('data-s'), 10);
    if (panel === 'accuse') {
      host.askConfirm('¿Acusar a ' + nameOf(s) + '? Solo puedes acusar una vez por ronda.', 'Sí, acusar', function () {
        host.send({ t: 'i.accuse', suspect: s });
        panel = 'main';
        render();
      });
    } else if (panel === 'final') {
      host.askConfirm('¿Votar a ' + nameOf(s) + '?', 'Sí, votar', function () {
        if (host.send({ t: 'i.final', suspect: s })) { myFinal[roundKey()] = s; host.vibrate(20); }
        render();
      });
    }
  }

  // ---------------------------------------------------------------- render
  function setPanel(id) {
    ['ipWatch', 'ipMain', 'ipList', 'ipVote', 'ipReveal', 'ipEnd'].forEach(function (x) { show($(x), x === id); });
    if (id !== 'ipMain') cover();
  }

  function render() {
    if (!M || !isActive()) return;
    var m = M;
    show($('ipPause'), !!m.paused && m.phase !== 'end');
    if (m.paused) setText($('ipPauseWho'), 'Esperando a ' + (m.waiting.length ? G2T.joinNames(m.waiting) : 'alguien') + '…');
    updateInfo();
    if (!inMatch()) { setPanel('ipWatch'); return; }
    var k = roundKey();
    if (k !== lastKey) { lastKey = k; panel = 'main'; cover(); }
    var ph = m.phase;
    if (ph === 'end') { setPanel('ipEnd'); renderEnd(); return; }
    if (ph === 'reveal') { setPanel('ipReveal'); renderReveal(); return; }
    if (ph === 'lastguess') {
      if (amSpy()) { panel = 'last'; setPanel('ipList'); renderList(); return; }
      panel = 'main';
    } else if (panel === 'last') panel = 'main';
    if (ph === 'vote') {
      var voted = m.vote && m.vote.voted.indexOf(me()) >= 0;
      if (!voted) { panel = 'final'; setPanel('ipList'); renderList(); return; }
      panel = 'main';
    } else if (panel === 'final') panel = 'main';
    if (ph === 'accuse' && m.acc && m.acc.voters.indexOf(me()) >= 0 && m.acc.voted.indexOf(me()) < 0) {
      setPanel('ipVote');
      $('ipVoteWho').innerHTML = nameHtml(m.acc.by) + ' acusa a ' + nameHtml(m.acc.suspect);
      return;
    }
    if (ph !== 'play' && (panel === 'accuse')) panel = 'main';
    if (!canGuess() && panel === 'guess') panel = 'main';
    if (panel !== 'main') { setPanel('ipList'); renderList(); return; }
    setPanel('ipMain');
    renderMain();
  }

  function renderMain() {
    var m = M;
    var st = $('ipStatus');
    var txt = '';
    if (m.phase === 'intro') txt = '¡Ronda ' + m.round + '! Mira tu carta en secreto';
    else if (m.phase === 'accuse' && m.acc) {
      if (m.acc.suspect === me()) txt = '¡Te acusa ' + esc(nameOf(m.acc.by)) + '! Los demás votan… (' + m.acc.voted.length + '/' + m.acc.voters.length + ')';
      else {
        var mv = myAcc[roundKey() + '|' + m.acc.by];
        txt = (mv === undefined ? (m.acc.by === me() ? 'Has acusado' : 'Has votado') : 'Has votado «' + (mv ? 'Sí' : 'No') + '»') + '. Esperando a los demás (' + m.acc.voted.length + '/' + m.acc.voters.length + ')';
      }
    } else if (m.phase === 'vote' && m.vote) {
      var v = myFinal[roundKey()];
      txt = (v ? 'Has votado a ' + esc(nameOf(v)) : 'Has votado') + '. Esperando (' + m.vote.voted.length + '/' + m.vote.voters.length + ')';
    } else if (m.phase === 'lastguess') txt = '¡' + esc(nameOf(m.caught)) + ' era el infiltrado! Ahora intenta adivinar el lugar…';
    st.innerHTML = txt;
    show(st, !!txt);
    // Turn
    var turn = $('ipTurn');
    var key = [m.phase, m.asker, m.askedBy, JSON.stringify(m.history.slice(-1)), m.players.map(nameOf).join()].join('|');
    if (turn.getAttribute('data-key') !== key) {
      turn.setAttribute('data-key', key);
      var last = m.history.length ? m.history[m.history.length - 1] : null;
      var html = '';
      if (m.phase === 'play' && m.asker === me()) {
        html = '<p class="ipTurnT">Te toca preguntar. <b>Pregunto a…</b></p><div class="ipAsk">';
        m.players.forEach(function (s) {
          if (s === me()) return;
          var no = s === m.askedBy;
          html += '<button type="button" data-s="' + s + '"' + (no ? ' disabled' : '') + ' style="border-color:' + colorOf(s) + '"><span style="color:' + colorOf(s) + '">' + esc(nameOf(s)) + '</span>' + (no ? '<small>te acaba de preguntar</small>' : '') + '</button>';
        });
        html += '</div>';
        host.vibrate(25);
      } else if (last && last.to === m.asker) {
        html = '<p class="ipTurnT">' + nameHtml(last.from) + ' pregunta a ' + (last.to === me() ? '<b>ti</b>: ¡responde en voz alta!' : nameHtml(last.to)) + '</p>';
      } else {
        html = '<p class="ipTurnT">Le toca preguntar a ' + nameHtml(m.asker) + '</p>';
      }
      turn.innerHTML = html;
    }
    var used = m.accUsed.indexOf(me()) >= 0;
    var ab = $('ipAccBtn');
    ab.disabled = used || m.phase !== 'play';
    setText(ab, used ? 'Ya has acusado' : 'Acusar');
  }

  function renderReveal() {
    var r = M.result;
    if (!r) return;
    var mine = r.spy === me();
    var how = {
      acusacion: r.spyWins ? 'Acusaron a un inocente' : 'Pillado en una acusación',
      votacion: 'La votación señaló a un inocente',
      empate: 'Empate en la votación',
      sinvotos: 'Nadie votó a tiempo',
      adivina: r.guessOk ? 'El infiltrado sabía el lugar' : 'El infiltrado falló el lugar',
      ultima: r.guessOk ? 'Pillado, pero adivinó el lugar' : 'Pillado y sin acertar el lugar',
      abandono: 'El infiltrado ha abandonado'
    }[r.how] || '';
    setText($('ipRvHow'), how);
    var t = $('ipRvTitle');
    if (r.how === 'abandono') { setText(t, 'Ronda sin puntos'); t.style.color = ''; }
    else if (mine) { setText(t, r.spyWins ? '¡Te has salido con la tuya!' : '¡Te han pillado!'); t.style.color = r.spyWins ? 'var(--ok)' : 'var(--bad)'; }
    else { setText(t, (r.spyWins ? '¡Se os ha escapado ' : '¡Pillado! Era ') + r.spyName + (r.spyWins ? '!' : '')); t.style.color = r.spyWins ? 'var(--bad)' : 'var(--ok)'; }
    setText($('ipRvLoc'), r.location);
    var role = null;
    r.roles.forEach(function (x) { if (x.slot === me()) role = x.role; });
    setText($('ipRvRoleL'), mine ? 'TÚ ERAS' : 'TU PAPEL');
    setText($('ipRvRole'), mine ? 'El infiltrado' : (role || '—'));
    var pts = 0;
    r.points.forEach(function (p) { if (p.slot === me()) pts = p.pts; });
    setText($('ipRvPts'), pts ? '+' + pts + (pts === 1 ? ' punto' : ' puntos') + ' para ti · llevas ' + (r.scores[me() - 1] || 0) : 'Sin puntos para ti esta ronda · llevas ' + (r.scores[me() - 1] || 0));
    setText($('ipNext'), M.round >= M.rounds ? 'Ver la clasificación' : 'Siguiente ronda');
  }

  function renderEnd() {
    var rk = M.ranking || [];
    var mine = null;
    rk.forEach(function (r) { if (r.slot === me()) mine = r; });
    var winners = rk.filter(function (r) { return r.rank === 1; });
    var pos = $('ipEndPos');
    setText(pos, mine && mine.rank === 1 ? (winners.length > 1 ? '¡Empate en cabeza!' : '¡Has ganado!') : (mine ? mine.rank + 'º puesto' : 'Fin'));
    pos.style.color = mine && mine.rank === 1 ? 'var(--ok)' : '';
    setText($('ipEndSub'), mine ? mine.score + ' puntos' : '');
    var html = '';
    rk.forEach(function (r) {
      html += '<li class="' + (r.slot === me() ? 'me' : '') + '"><span class="md m' + Math.min(r.rank, 4) + '">' + r.rank + '</span><b style="color:' + colorOf(r.slot) + '">' + esc(nameOf(r.slot)) + '</b><i>' + r.score + '</i></li>';
    });
    $('ipRank').innerHTML = html;
    if (!$('ipAgain').getAttribute('data-sent')) { $('ipAgain').disabled = false; setText($('ipAgain'), 'Jugar otra vez'); }
  }

  function updateInfo() {
    if (!M) return;
    var txt;
    if (M.phase === 'end') txt = 'Final';
    else if (M.phase === 'play' || M.phase === 'intro') txt = 'Ronda ' + M.round + '/' + M.rounds + ' · ' + mmss(clock());
    else if (M.phase === 'reveal') txt = 'Ronda ' + M.round + '/' + M.rounds;
    else txt = 'Ronda ' + M.round + '/' + M.rounds + ' · ' + secs(left()) + ' s';
    setText($('ipInfo'), txt);
    if (M.phase === 'play' && clock() <= 30000) $('ipInfo').classList.add('warn'); else $('ipInfo').classList.remove('warn');
    if (M.phase === 'accuse') setText($('ipVoteTime'), secs(left()) + ' s');
    if ((panel === 'final' || panel === 'last') && !$('ipList').classList.contains('hidden')) {
      setText($('ipListS'), (panel === 'final' ? 'Votación final · ' : 'Última oportunidad: ¿dónde estáis? · ') + secs(left()) + ' s');
    }
  }

  // ---------------------------------------------------------------- help
  function openHelp() {
    var g = G2T.gameById('infiltrado') || {};
    var lines = g.howTo || [g.description || ''];
    $('ipHelpList').innerHTML = lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('');
    cover();
    show($('ipHelp'), true);
  }

  // ---------------------------------------------------------------- menu panel
  function renderMenuPanel() {
    var opts = [0].concat(cfg.options || [4, 6, 8, 10]);
    var html = '';
    opts.forEach(function (o) {
      html += '<button type="button" class="' + (o === cfg.minutes ? 'on' : '') + '" data-m="' + o + '">' + (o ? o + ' min' : 'Auto') + '</button>';
    });
    if ($('ipMins').innerHTML !== html) $('ipMins').innerHTML = html;
    setText($('ipMinsNote'), (cfg.minutes ? 'Rondas de ' + cfg.minutes + ' min' : 'Automático: 6 min con 3 o 4 jugadores, 8 con 5 o 6') + (cfg.by ? ' · lo ha puesto ' + cfg.by : '') + '.');
    setText($('ipOwnCount'), myPlaces.length + '/' + maxPlaces);
    var list = '';
    myPlaces.forEach(function (p, i) {
      list += '<li><div><b>' + esc(p.name) + '</b><small>' + (p.roles.length ? esc(p.roles.join(', ')) : 'Papeles genéricos') + '</small></div><button type="button" data-i="' + i + '" aria-label="Quitar">✕</button></li>';
    });
    $('ipOwnList').innerHTML = list;
    var full = myPlaces.length >= maxPlaces;
    $('ipOwnAdd').disabled = full;
    $('ipOwnName').disabled = full;
    $('ipOwnRoles').disabled = full;
    $('ipOwnName').placeholder = full ? 'Máximo ' + maxPlaces + ' lugares' : 'Lugar. Ej.: El pueblo de la abuela';
  }
  function sendPlaces(list) { return host.send({ t: 'i.places', list: list }); }

  var menuPanel = {
    mount: function (el) {
      el.innerHTML = MENU_HTML;
      $('ipMins').addEventListener('click', function (e) {
        var b = e.target;
        if (!b || !b.getAttribute || b.getAttribute('data-m') === null) return;
        host.send({ t: 'i.cfg', minutes: parseInt(b.getAttribute('data-m'), 10) });
      });
      $('ipOwnForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var name = String($('ipOwnName').value || '').replace(/\s+/g, ' ').trim();
        if (!name) { host.toast('Escribe el nombre del lugar'); return; }
        if (myPlaces.length >= maxPlaces) { host.toast('Máximo ' + maxPlaces + ' lugares'); return; }
        var roles = String($('ipOwnRoles').value || '').split(',').map(function (r) { return r.trim(); }).filter(Boolean);
        var list = myPlaces.concat([{ name: name, roles: roles }]);
        if (sendPlaces(list)) {
          menuPanel.pending = name;
          $('ipOwnName').value = '';
          $('ipOwnRoles').value = '';
        }
      });
      $('ipOwnList').addEventListener('click', function (e) {
        var b = e.target;
        if (!b || b.tagName !== 'BUTTON') return;
        var list = myPlaces.slice();
        list.splice(parseInt(b.getAttribute('data-i'), 10), 1);
        sendPlaces(list);
      });
    },
    render: renderMenuPanel,
    onMessage: function (msg) {
      if (msg.t === 'i.places') {
        var before = myPlaces.length;
        myPlaces = msg.list || [];
        maxPlaces = msg.max || 5;
        if (menuPanel.pending && myPlaces.length <= before) host.toast('«' + menuPanel.pending + '» ya está en la lista o no vale');
        menuPanel.pending = null;
        renderMenuPanel();
        return true;
      }
      if (msg.t === 'i.cfg') {
        var changed = cfg.minutes !== msg.minutes;
        cfg = msg;
        if (changed && msg.by && msg.by !== host.myName()) host.toast(msg.by + ' pone las rondas ' + (msg.minutes ? 'de ' + msg.minutes + ' min' : 'en automático'));
        renderMenuPanel();
        return true;
      }
      return false;
    }
  };

  // ---------------------------------------------------------------- mount
  G2T.phone.register({
    id: 'infiltrado',
    menuPanel: menuPanel,
    mount: function (section, h) {
      host = h;
      show = h.show;
      setText = h.setText;
      section.innerHTML = HTML;
      var pause = document.createElement('div');
      pause.id = 'ipPause';
      pause.className = 'over hidden';
      pause.innerHTML = PAUSE_HTML;
      h.app.insertBefore(pause, $('modal'));
      var help = document.createElement('div');
      help.id = 'ipHelp';
      help.className = 'over hidden';
      help.innerHTML = HELP_HTML;
      h.app.insertBefore(help, $('modal'));
      $('ipHelpOk').addEventListener('click', function () { show($('ipHelp'), false); });
      Array.prototype.forEach.call(section.querySelectorAll('.ipHelpBtn'), function (b) { b.addEventListener('click', openHelp); });
      bindCard();
      $('ipTurn').addEventListener('click', function (e) {
        var b = e.target;
        while (b && b !== this && !(b.getAttribute && b.getAttribute('data-s'))) b = b.parentNode;
        if (!b || b === this || b.disabled) return;
        host.send({ t: 'i.ask', to: parseInt(b.getAttribute('data-s'), 10) });
        host.vibrate(15);
      });
      $('ipPlacesBtn').addEventListener('click', function () { openList('places'); });
      $('ipAccBtn').addEventListener('click', function () { if (M && M.phase === 'play') openList('accuse'); });
      $('ipListBack').addEventListener('click', closeList);
      $('ipListBody').addEventListener('click', onListTap);
      function vote(yes) {
        if (!M || !M.acc) return;
        if (host.send({ t: 'i.vote', yes: yes })) { myAcc[roundKey() + '|' + M.acc.by] = yes; host.vibrate(20); }
      }
      $('ipYes').addEventListener('click', function () { vote(true); });
      $('ipNo').addEventListener('click', function () { vote(false); });
      $('ipNext').addEventListener('click', function () { host.send({ t: 'i.next' }); });
      $('ipAgain').addEventListener('click', function () {
        if (host.send({ t: 'i.again' })) {
          $('ipAgain').disabled = true;
          $('ipAgain').setAttribute('data-sent', '1');
          setText($('ipAgain'), '¡Allá vamos!');
        }
      });
      setInterval(function () { if (M && isActive()) updateInfo(); }, 250);
    },
    reset: function () { M = null; card = null; panel = 'main'; lastKey = ''; cover(); },
    onHide: function () { show($('ipPause'), false); show($('ipHelp'), false); cover(); },
    render: function () { render(); },
    onMessage: function (msg) {
      if (msg.t === 'imeta') {
        var prev = M;
        M = msg;
        metaAt = now();
        if (msg.phase !== 'end') $('ipAgain').removeAttribute('data-sent');
        if (prev && prev.phase !== msg.phase && (msg.phase === 'accuse' || msg.phase === 'vote' || msg.phase === 'lastguess')) host.vibrate([30, 40, 30]);
        render();
      } else if (msg.t === 'i.card') {
        var fresh = !card || card.match !== msg.match || card.round !== msg.round;
        card = msg;
        if (fresh) { cover(); host.vibrate(40); }
        render();
      }
    },
    // For automated tests
    state: function () { return { meta: M, panel: panel, revealed: revealed }; }
  });
})();
