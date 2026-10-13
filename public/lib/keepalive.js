/*
 * Screensaver keepalive for webOS.
 *
 * webOS turns the screensaver on when the remote is not used for a few
 * minutes, even if the page is moving. While a game is running we try to
 * avoid it in three harmless ways:
 *  1) ask the system (luna://com.webos.service.tvpower/power,
 *     registerScreenSaverRequest), only if PalmServiceBridge exists (the page
 *     runs inside a webOS web app);
 *  2) a tiny, almost transparent, muted looping <video> (/keepalive.mp4);
 *  3) a minimal DOM change every 20 s (an almost invisible pixel).
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var ka = { on: false, timer: null, bridge: null, video: null, pixel: null };

  function lunaCall(uri, params, cb) {
    try {
      if (typeof window.PalmServiceBridge === 'undefined') return null;
      var b = new window.PalmServiceBridge();
      b.onservicecallback = function (msg) { try { if (cb) cb(JSON.parse(msg)); } catch (e) { /* noop */ } };
      b.call(uri, JSON.stringify(params));
      return b;
    } catch (e) { return null; }
  }

  function ensureElements(container) {
    if (!ka.pixel) {
      ka.pixel = document.createElement('div');
      ka.pixel.id = 'kaPixel';
      ka.pixel.style.cssText = 'position:absolute;right:0;bottom:0;width:2px;height:2px;background:#fff;opacity:0.01;';
      (container || document.body).appendChild(ka.pixel);
    }
    if (!ka.video) {
      var v = document.createElement('video');
      v.id = 'ka';
      v.muted = true;
      v.loop = true;
      v.setAttribute('muted', '');
      v.setAttribute('loop', '');
      v.setAttribute('playsinline', '');
      v.setAttribute('preload', 'none');
      v.style.cssText = 'position:absolute;right:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:0;';
      document.body.appendChild(v);
      ka.video = v;
    }
  }

  G2T.keepAlive = {
    lunaCall: lunaCall,
    // opts: { container, src }
    start: function (opts) {
      opts = opts || {};
      ensureElements(opts.container);
      if (ka.on) return;
      ka.on = true;
      if (!ka.bridge) {
        ka.bridge = lunaCall('luna://com.webos.service.tvpower/power/registerScreenSaverRequest',
          { subscribe: true, clientName: 'gametotv' }, function (r) {
            if (r && r.state === 'Active' && ka.on) {
              // ack:false = «not now, please»
              lunaCall('luna://com.webos.service.tvpower/power/responseScreenSaverRequest',
                { clientName: 'gametotv', ack: false, timestamp: r.timestamp });
            }
          });
      }
      try {
        var v = ka.video;
        if (!v.getAttribute('src') && opts.src) v.setAttribute('src', opts.src);
        v.muted = true;
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
      } catch (e) { /* noop */ }
      clearInterval(ka.timer);
      var flip = false;
      ka.timer = setInterval(function () {
        flip = !flip;
        ka.pixel.style.opacity = flip ? '0.02' : '0.01';
      }, 20000);
    },
    stop: function () {
      ka.on = false;
      clearInterval(ka.timer);
      try { if (ka.video) ka.video.pause(); } catch (e) { /* noop */ }
    }
  };
})();
