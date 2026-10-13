/*
 * WebSocket client with automatic reconnection (exponential backoff, max 5 s).
 *
 *   var s = G2T.socket({
 *     url: 'ws://host/ws',
 *     minRetry: 500,            // first wait
 *     jitter: 0,                // random extra ms per attempt
 *     staleMs: 0,               // > 0: reconnect if nothing arrives for this long
 *     shouldReconnect: fn,      // optional: return false to stay closed
 *     onopen, onmessage(msg), onclose
 *   });
 *   s.connect(); s.send(obj); s.isOpen(); s.kick() (reconnect now); s.close();
 */
(function () {
  'use strict';
  var G2T = window.G2T;

  G2T.socket = function (o) {
    var ws = null, retryMs = o.minRetry || 500, timer = null, lastMsgAt = 0;
    var api = {};
    function want() { return !o.shouldReconnect || o.shouldReconnect(); }
    function isOpen() { return !!(ws && ws.readyState === 1); }

    function connect() {
      if (!o.url) return;
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
      clearTimeout(timer);
      timer = null;
      var sock;
      try { sock = new WebSocket(o.url); } catch (e) { schedule(); return; }
      ws = sock;
      sock.onopen = function () {
        if (sock !== ws) return;
        retryMs = o.minRetry || 500;
        lastMsgAt = G2T.now();
        if (o.onopen) o.onopen();
      };
      sock.onmessage = function (e) {
        if (sock !== ws) return;
        lastMsgAt = G2T.now();
        var msg;
        try { msg = JSON.parse(e.data); } catch (err) { return; }
        if (!msg) return;
        try { o.onmessage(msg); } catch (err) { if (window.console) console.error(err); }
      };
      sock.onclose = function () {
        if (sock !== ws) return;
        ws = null;
        if (o.onclose) o.onclose();
        if (want()) schedule();
      };
      sock.onerror = function () { try { sock.close(); } catch (err) { /* noop */ } };
    }
    function schedule() {
      if (timer || !want()) return;
      var wait = retryMs + (o.jitter ? Math.floor(Math.random() * o.jitter) : 0);
      retryMs = Math.min(5000, Math.round(retryMs * 1.7));
      timer = setTimeout(function () { timer = null; connect(); }, wait);
    }
    if (o.staleMs) {
      // Half-open sockets (Wi-Fi changes, phone asleep) never fire onclose: watchdog
      setInterval(function () {
        if (want() && isOpen() && G2T.now() - lastMsgAt > o.staleMs) {
          var old = ws;
          ws = null;
          try { old.close(); } catch (e) { /* noop */ }
          if (o.onclose) o.onclose();
          schedule();
        }
      }, 1000);
    }

    api.connect = connect;
    api.isOpen = isOpen;
    api.raw = function () { return ws; };
    api.send = function (obj) {
      if (!isOpen()) return false;
      try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
    };
    api.kick = function () {
      retryMs = o.minRetry || 500;
      clearTimeout(timer);
      timer = null;
      connect();
    };
    api.close = function () {
      var old = ws;
      ws = null;
      clearTimeout(timer);
      timer = null;
      try { if (old) old.close(); } catch (e) { /* noop */ }
    };
    return api;
  };
})();
