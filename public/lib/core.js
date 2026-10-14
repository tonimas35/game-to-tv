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
  // Menu sections that have games (manifest "section"): [{ id, title, subtitle, phoneSubtitle, accent, order, games }]
  G2T.sections = BOOT.sections || [];

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
  // "2 jugadores", "2 a 6 jugadores"
  G2T.playerRange = function (g) {
    return g.minPlayers === g.maxPlayers ? g.minPlayers + ' jugadores' : g.minPlayers + ' a ' + g.maxPlayers + ' jugadores';
  };
  // Players in a 'hub' message: { n, names, away }
  G2T.roomOf = function (hub) {
    var out = { n: 0, names: [], away: [] };
    ((hub && hub.players) || []).forEach(function (p) {
      if (!p) return;
      out.n++;
      out.names.push(p.name);
      if (!p.connected) out.away.push(p.name);
    });
    return out;
  };
  // Why a game cannot be played right now (null = it can): shown on the menu cards
  G2T.whyNot = function (g, hub) {
    var r = G2T.roomOf(hub);
    if (r.n < g.minPlayers) {
      var k = g.minPlayers - r.n;
      return k === 1 ? 'Falta 1 jugador' : 'Faltan ' + k + ' jugadores';
    }
    if (r.n > g.maxPlayers) {
      return (g.minPlayers === g.maxPlayers ? 'Para ' + g.maxPlayers + ' jugadores' : 'De ' + g.minPlayers + ' a ' + g.maxPlayers + ' jugadores') + ' · sois ' + r.n;
    }
    if (r.away.length || !(hub && hub.ready)) return 'Esperando a que vuelva ' + (r.away.length ? G2T.joinNames(r.away) : 'alguien');
    return null;
  };

  // ---------------------------------------------------------------- menu sections
  // A game with "section": "1vs1" in its manifest is not listed on its own in
  // the main menu: the menu shows ONE entry for the section, which opens a
  // list with its games (TV: a second row of cards; phone: a group).
  G2T.sectionById = function (id) {
    for (var i = 0; i < G2T.sections.length; i++) if (G2T.sections[i].id === id) return G2T.sections[i];
    return null;
  };
  // The section a game is shown in (null = the main menu)
  G2T.sectionOf = function (g) { return g && g.section ? G2T.sectionById(g.section) : null; };
  // The games of a section, in menu order
  G2T.sectionGames = function (s) {
    return G2T.games.filter(function (g) { return !!s && g.section === s.id; });
  };
  // Main menu entries, in menu order: { game } or { section, games }. The
  // section goes where its "order" falls among the games' "order" values.
  G2T.menuEntries = function () {
    var out = [];
    var secs = G2T.sections.filter(function (s) { return G2T.sectionGames(s).length > 0; });
    var placed = {};
    function placeUpTo(order) {
      secs.forEach(function (s) {
        if (!placed[s.id] && (order == null || s.order < order)) {
          placed[s.id] = true;
          out.push({ section: s, games: G2T.sectionGames(s) });
        }
      });
    }
    G2T.games.forEach(function (g) {
      placeUpTo(g.order == null ? 100 : g.order);
      if (!G2T.sectionOf(g)) out.push({ game: g });
    });
    placeUpTo(null);
    return out;
  };
  // "2 jugadores" when every game of the section has the same range
  G2T.sectionRange = function (s) {
    var gs = G2T.sectionGames(s);
    if (!gs.length) return '';
    var min = Infinity, max = 0;
    gs.forEach(function (g) { min = Math.min(min, g.minPlayers); max = Math.max(max, g.maxPlayers); });
    return G2T.playerRange({ minPlayers: min, maxPlayers: max });
  };
  // Why no game of the section can be played right now (null = at least one can)
  G2T.sectionWhy = function (s, hub) {
    var gs = G2T.sectionGames(s);
    var first = null;
    for (var i = 0; i < gs.length; i++) {
      var why = G2T.whyNot(gs[i], hub);
      if (!why) return null;
      if (first === null) first = why;
    }
    return first;
  };
  // Our own artwork for each section (inline SVG, no files to download)
  var SECTION_ART = {
    // Two figures face to face with a bolt between them
    '1vs1': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 170" aria-hidden="true" focusable="false">' +
      '<g fill="#22e6ff"><circle cx="66" cy="48" r="23"/><path d="M24 160C24 108 40 82 66 82c22 0 34 12 40 28l24-12 8 16-30 20v26z"/></g>' +
      '<g fill="#ff3df2"><circle cx="234" cy="48" r="23"/><path d="M276 160c0-52-16-78-42-78-22 0-34 12-40 28l-24-12-8 16 30 20v26z"/></g>' +
      '<path fill="#ffd23e" d="M166 8 128 90h22l-14 72 42-90h-24l18-64z"/>' +
      '</svg>'
  };
  G2T.sectionArt = function (id) { return SECTION_ART[id] || ''; };

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
