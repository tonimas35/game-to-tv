/*
 * Tiny synthesized sounds (WebAudio). Never breaks anything if audio is
 * blocked or missing. Games add their own effects with G2T.sound.beep().
 */
(function () {
  'use strict';
  var G2T = window.G2T;
  var actx = null, audioFailed = false;

  function getAudio() {
    if (actx || audioFailed) return actx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { audioFailed = true; return null; }
      actx = new AC();
    } catch (e) { audioFailed = true; actx = null; }
    return actx;
  }
  function unlock() {
    try {
      var a = getAudio();
      if (a && a.state === 'suspended') { var p = a.resume(); if (p && p.catch) p.catch(function () {}); }
    } catch (e) { /* noop */ }
  }
  function beep(freq, dur, type, vol, slideTo, delay) {
    try {
      var a = getAudio();
      if (!a) return;
      if (a.state === 'suspended') unlock();
      if (a.state !== 'running') return;
      var t0 = a.currentTime + (delay || 0);
      var o = a.createOscillator();
      var g = a.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(freq, t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.12, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g);
      g.connect(a.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    } catch (e) { /* audio blocked */ }
  }
  // Common effects (menu, countdowns, wins)
  var sfx = {
    tick: function () { beep(600, 0.12, 'sine', 0.16); },
    go: function () { beep(900, 0.25, 'sine', 0.18); },
    join: function () { beep(500, 0.08, 'triangle', 0.14); beep(750, 0.12, 'triangle', 0.14, null, 0.09); },
    move: function () { beep(420, 0.05, 'triangle', 0.08); },
    pick: function () { beep(660, 0.09, 'triangle', 0.14); beep(990, 0.14, 'triangle', 0.14, null, 0.08); },
    win: function () {
      var notes = [523, 659, 784, 1047];
      for (var i = 0; i < notes.length; i++) beep(notes[i], 0.22, 'triangle', 0.16, null, i * 0.14);
    },
    correct: function () {
      var notes = [523, 659, 784, 1047, 1319];
      for (var i = 0; i < notes.length; i++) beep(notes[i], 0.2, 'triangle', 0.17, null, i * 0.09);
      beep(1568, 0.5, 'sine', 0.12, null, 0.5);
    },
    wrong: function () { beep(200, 0.12, 'square', 0.06); }
  };
  ['keydown', 'click', 'mousedown', 'touchstart', 'pointerdown'].forEach(function (ev) {
    window.addEventListener(ev, unlock, true);
  });
  G2T.sound = { beep: beep, unlock: unlock, sfx: sfx };
})();
