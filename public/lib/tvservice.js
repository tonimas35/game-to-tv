/*
 * «Modo tele» heartbeat: keeps the game server that runs inside an LG TV
 * (a webOS JS service) company while this page is open.
 *
 * The launcher app opens a heartbeat subscription to the service before it
 * navigates here, but a PalmServiceBridge subscription dies with the page
 * that created it. So every TV page served by the TV-hosted server opens its
 * own one. It is a no-op everywhere else: browsers, phones, and LG TVs that
 * use a server on a PC (no `tele` data in /info).
 *
 * Standalone (no G2T needed), ES2019. Exposes window.G2T_TELE for debugging.
 */
(function () {
  'use strict';
  if (typeof window.PalmServiceBridge === 'undefined') return;   // not inside a webOS app
  var state = { service: null, bridge: null, beats: 0, last: null, errors: 0, retry: null };
  window.G2T_TELE = state;

  function subscribe() {
    clearTimeout(state.retry);
    var b;
    try { b = new window.PalmServiceBridge(); } catch (e) { return; }
    state.bridge = b;           // keep it referenced: the subscription lives as long as the object
    b.onservicecallback = function (raw) {
      var r = null;
      try { r = JSON.parse(raw); } catch (e) { /* noop */ }
      if (r && r.returnValue !== false && !r.stopped) {
        state.beats++;
        state.last = r;
        return;
      }
      // Service gone or stopped: try again in a while (the page reconnects its WebSocket on its own)
      state.errors++;
      state.last = r;
      state.retry = setTimeout(subscribe, Math.min(60000, 5000 * state.errors));
    };
    try { b.call('luna://' + state.service + '/heartbeat', JSON.stringify({ subscribe: true })); } catch (e) { /* noop */ }
  }

  function boot(service) {
    if (!service || state.service) return;
    state.service = service;
    subscribe();
  }

  // The TV shell has it in G2T_BOOT; any other page asks /info (same origin)
  var b = window.G2T_BOOT;
  if (b && b.tele && b.tele.service) { boot(b.tele.service); return; }
  if (b && b.mode === 'pc') return;
  try {
    var x = new XMLHttpRequest();
    x.open('GET', '/info', true);
    x.onload = function () {
      try {
        var info = JSON.parse(x.responseText);
        if (info && info.mode === 'tele' && info.tele && info.tele.service) boot(info.tele.service);
      } catch (e) { /* noop */ }
    };
    x.send();
  } catch (e) { /* noop */ }
})();
