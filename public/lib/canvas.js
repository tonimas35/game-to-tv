/*
 * Canvas size cap for TVs.
 *
 * LG webOS reports devicePixelRatio = 2 with innerWidth 1920: a full-screen
 * canvas would get a 3840x2160 backing store and the TV drops to 8-9 FPS.
 * The backing store width of EVERY canvas is capped (1280 px on webOS by
 * default; ?res=N in the URL to change it). Validated at 60 FPS on a
 * webOS 22 TV (Chromium 87).
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  G2T.isWebOS = /Web0S|webOS/i.test(navigator.userAgent);
  G2T.MAXW = Number(G2T.qs('res')) || (G2T.isWebOS ? 1280 : 3840);
  G2T.capDpr = function (cssWidth) {
    return Math.min(window.devicePixelRatio || 1, 2, G2T.MAXW / Math.max(1, cssWidth));
  };
})();
