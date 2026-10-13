/*
 * «Reflejos»: TV view. A minimal example of a game view (see
 * docs/crear-un-juego.md): it builds its DOM on mount() and redraws it
 * every time an 'rmeta' message arrives.
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var host = null, view = null;
  var meta = null, lastKey = '';

  function $(id) { return document.getElementById(id); }

  function render() {
    if (!meta) return;
    var colors = host.colors();
    var big = $('rxBig'), sub = $('rxSub');
    var key = meta.phase + '|' + meta.round;
    var changed = key !== lastKey;
    lastKey = key;

    host.setText($('rxTop'), 'Reflejos · Ronda ' + meta.round + ' · gana quien llegue a ' + meta.toWin);
    if (meta.phase === 'go') view.classList.add('go'); else view.classList.remove('go');
    big.style.color = '#fff';
    if (meta.paused) {
      host.setText(big, 'Pausa');
      host.setText(sub, 'Esperando a que vuelvan todos…');
    } else if (meta.phase === 'ready') {
      host.setText(big, 'Preparados…');
      host.setText(sub, 'Toca tu móvil en cuanto salga «¡YA!»');
    } else if (meta.phase === 'go') {
      host.setText(big, '¡YA!');
      host.setText(sub, '¡Toca, toca!');
      if (changed) host.sfx.go();
    } else if (meta.phase === 'point') {
      if (meta.last) {
        host.setText(big, '¡Punto para ' + host.playerName(meta.last.slot - 1) + '!');
        big.style.color = colors[meta.last.slot - 1];
        host.setText(sub, meta.last.ms + ' ms');
        if (changed) host.sfx.correct();
      } else {
        host.setText(big, 'Nadie ha tocado');
        host.setText(sub, 'Ronda nula');
      }
    } else if (meta.phase === 'end') {
      host.setText(big, '¡Gana ' + host.playerName(meta.winner - 1) + '!');
      big.style.color = colors[meta.winner - 1];
      host.setText(sub, 'Pulsad «Otra partida» o «Menú» en el móvil');
      if (changed) { host.sfx.win(); host.confetti(); }
    }
    host.fit(big, 220, 80);

    host.setText($('rxEarly'), meta.phase === 'ready' && meta.early.length
      ? meta.early.map(function (s) { return host.playerName(s - 1); }).join(', ') + ': ¡demasiado pronto! Fuera esta ronda'
      : '');

    var html = '';
    meta.players.forEach(function (s) {
      var pts = meta.scores[s - 1] || 0;
      var dots = '';
      for (var k = 0; k < meta.toWin; k++) dots += k < pts ? '●' : '○';
      html += '<div class="rx-p" style="border-color:' + colors[s - 1] + '"><b class="fit" style="color:' + colors[s - 1] + '">' +
        G2T.esc(host.playerName(s - 1)) + '</b><div class="rx-dots" style="color:' + colors[s - 1] + '">' + dots + '</div></div>';
    });
    $('rxScores').innerHTML = html;
  }

  G2T.tv.register({
    id: 'ejemplo-reflejos',
    mount: function (h) {
      host = h;
      view = document.createElement('section');
      view.id = 'vReflejos';
      view.className = 'view';
      view.innerHTML =
        '<div class="rx-top" id="rxTop">Reflejos</div>' +
        '<div class="rx-main"><div class="rx-big fit" id="rxBig">Preparados…</div><div class="rx-sub fit" id="rxSub"></div></div>' +
        '<div class="rx-early fit" id="rxEarly"></div>' +
        '<div class="rx-scores" id="rxScores"></div>';
      h.addView(view);
    },
    enter: function () { host.show(view, true); },
    leave: function () { host.show(view, false); meta = null; lastKey = ''; },
    onHub: function () { render(); },
    onMessage: function (msg) {
      if (msg.t === 'rmeta') { meta = msg; render(); }
      else if (msg.t === 'r.early') host.sfx.wrong();
    }
  });
})();
