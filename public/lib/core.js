/*
 * game-to-tv: shared browser helpers (TV and phone).
 * ES2019 only: the LG webOS 22 browser engine is Chromium 87 and the phones
 * may run older Safari versions. `npm run check` enforces it.
 */
(function () {
  'use strict';
  var G2T = window.G2T = window.G2T || {};
  var BOOT = window.G2T_BOOT || { games: [], slots: 2, colors: ['#22e6ff', '#ff3df2'] };
  G2T.boot = BOOT;
  G2T.games = BOOT.games || [];

  G2T.qs = function (name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search);
    return m ? decodeURIComponent(m[1]) : null;
  };
  G2T.$ = function (id) { return document.getElementById(id); };
  G2T.now = function () { return (window.performance && performance.now) ? performance.now() : Date.now(); };
  G2T.clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  G2T.lerp = function (a, b, t) { return a + (b - a) * t; };
  G2T.hexA = function (hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  };
  G2T.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  G2T.setText = function (el, s) { s = String(s); if (el.textContent !== s) el.textContent = s; };
  // Shrinks the font until the text fits its box (no overflow)
  G2T.fit = function (el, maxPx, minPx) {
    var size = maxPx;
    el.style.fontSize = size + 'px';
    var guard = 0;
    while (size > minPx && el.scrollWidth > el.clientWidth + 1 && guard < 60) {
      size -= 4;
      el.style.fontSize = size + 'px';
      guard++;
    }
  };
  G2T.raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function (cb) { return setTimeout(cb, 16); };
  G2T.findTouch = function (list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
    return null;
  };
  // "Ana", "Ana y Berto", "Ana, Berto y Carla"
  G2T.joinNames = function (names) {
    if (names.length <= 1) return names.join('');
    return names.slice(0, -1).join(', ') + ' y ' + names[names.length - 1];
  };
  G2T.gameById = function (id) {
    for (var i = 0; i < G2T.games.length; i++) if (G2T.games[i].id === id) return G2T.games[i];
    return null;
  };

  // ---------------------------------------------------------------- storage
  // localStorage/sessionStorage can be missing or throw (private mode): memory fallback
  var mem = {};
  function store(kind) {
    try { var s = window[kind]; s.setItem('__t', '1'); s.removeItem('__t'); return s; } catch (e) { return null; }
  }
  G2T.store = {
    local: store('localStorage'),
    session: store('sessionStorage'),
    get: function (s, k) {
      try { if (s) return s.getItem(k); } catch (e) { /* noop */ }
      return mem[k] == null ? null : mem[k];
    },
    set: function (s, k, v) { mem[k] = v; try { if (s) s.setItem(k, v); } catch (e) { /* noop */ } },
    remove: function (s, k) { delete mem[k]; try { if (s) s.removeItem(k); } catch (e) { /* noop */ } }
  };
  G2T.randomId = function () {
    var out = '';
    try {
      var a = new Uint8Array(12);
      (window.crypto || window.msCrypto).getRandomValues(a);
      for (var i = 0; i < a.length; i++) out += ('0' + a[i].toString(16)).slice(-2);
      return out;
    } catch (e) {
      for (var j = 0; j < 24; j++) out += Math.floor(Math.random() * 16).toString(16);
      return out;
    }
  };

  // ---------------------------------------------------------------- view registry
  // Each game registers its TV view (tv.js) and its phone view (phone.js).
  function registry() {
    var views = {};
    return {
      views: views,
      register: function (view) {
        if (!view || !view.id) throw new Error('G2T: la vista necesita un id');
        views[view.id] = view;
      },
      get: function (id) { return views[id] || null; },
      each: function (fn) { Object.keys(views).forEach(function (k) { fn(views[k]); }); }
    };
  }
  G2T.tv = registry();
  G2T.phone = registry();
})();
