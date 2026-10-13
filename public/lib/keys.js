/*
 * TV remote keys. Arrows and OK arrive as normal key events; the LG «Back»
 * button is keyCode 461 (with "disableBackHistoryAPI": true in appinfo.json,
 * otherwise webOS may turn it into history.back(), which captureBack() also
 * catches). Escape/Backspace act as Back on a PC keyboard.
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var K = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13, BACK: 461, ESC: 27, BACKSPACE: 8 };
  G2T.keys = {
    K: K,
    isBack: function (e) {
      return e.keyCode === K.BACK || e.keyCode === K.ESC || e.keyCode === K.BACKSPACE ||
        e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack';
    },
    isOk: function (e) { return e.keyCode === K.OK; },
    // -1 for left/up, +1 for right/down, 0 otherwise
    dir: function (e) {
      var k = e.keyCode;
      if (k === K.LEFT || k === K.UP) return -1;
      if (k === K.RIGHT || k === K.DOWN) return 1;
      return 0;
    },
    // Some webOS versions turn «Back» into history.back(): keep an extra
    // history entry and report it as a Back press.
    captureBack: function (onBack) {
      try {
        history.pushState({ g2t: 1 }, '');
        window.addEventListener('popstate', function () {
          try { history.pushState({ g2t: 1 }, ''); } catch (e) { /* noop */ }
          onBack();
        });
      } catch (e) { /* noop */ }
    }
  };
})();
