/*
 * «Reflejos»: phone view. A big pad: tap it as soon as the TV says «¡YA!».
 * Uses touchstart (not click) for the lowest latency.
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var host = null;
  var meta = null;
  var tappedRound = -1;

  function $(id) { return document.getElementById(id); }

  function render() {
    if (!meta) return;
    var me = host.slot();
    var pad = $('rxPad');
    var early = meta.early.indexOf(me) >= 0;
    pad.className = meta.phase === 'go' && !early ? 'go' : (early ? 'early' : '');
    var msg = '', info = '';
    if (meta.paused) { msg = 'Pausa'; info = 'Esperando a que vuelvan todos…'; }
    else if (meta.phase === 'ready') {
      msg = early ? '¡Demasiado pronto!' : 'Espera…';
      info = early ? 'Fuera esta ronda' : 'Toca en cuanto la tele diga «¡YA!»';
    } else if (meta.phase === 'go') {
      msg = early ? 'Fuera esta ronda' : (tappedRound === meta.round ? '¡Tocado!' : '¡TOCA!');
    } else if (meta.phase === 'point') {
      if (!meta.last) msg = 'Nadie ha tocado';
      else if (meta.last.slot === me) { msg = '¡Punto para ti!'; info = meta.last.ms + ' ms'; }
      else msg = 'Punto para ' + host.nameOf(meta.last.slot);
    } else if (meta.phase === 'end') {
      msg = meta.winner === me ? '¡Has ganado!' : 'Gana ' + host.nameOf(meta.winner);
    }
    host.setText($('rxMsg'), msg);
    host.setText($('rxInfo'), info);
    host.show($('rxEnd'), meta.phase === 'end');
    host.setText($('rxScore'), 'Tú: ' + (meta.scores[me - 1] || 0) + ' / ' + meta.toWin);
  }

  function tap(e) {
    if (e) e.preventDefault();
    if (!meta || meta.phase === 'end' || meta.phase === 'point') return;
    if (meta.phase === 'go') tappedRound = meta.round;
    host.send({ t: 'r.tap' });
    host.vibrate(20);
    render();
  }

  G2T.phone.register({
    id: 'ejemplo-reflejos',
    mount: function (section, h) {
      host = h;
      section.innerHTML =
        '<div class="bar">' +
        '  <div class="chip"><span class="dot"></span><span class="meName">Jugador</span></div>' +
        '  <span id="rxScore"></span>' +
        '  <button class="mini ghost menuBtn" type="button">Menú</button>' +
        '</div>' +
        '<div id="rxPad"><div id="rxMsg">Espera…</div><div id="rxInfo"></div>' +
        '  <div id="rxEnd" class="hidden"><button class="bigbtn c" id="rxAgain" type="button">Otra partida</button></div>' +
        '</div>';
      $('rxPad').addEventListener('touchstart', function (e) {
        if (e.target && e.target.tagName === 'BUTTON') return;
        tap(e);
      }, { passive: false });
      $('rxPad').addEventListener('mousedown', function (e) {
        if (e.target && e.target.tagName === 'BUTTON') return;
        tap(e);
      });
      $('rxAgain').addEventListener('click', function () { host.send({ t: 'r.again' }); });
    },
    reset: function () { meta = null; tappedRound = -1; },
    render: render,
    onMessage: function (msg) {
      if (msg.t === 'rmeta') { meta = msg; render(); }
    }
  });
})();
