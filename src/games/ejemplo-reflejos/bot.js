'use strict';
/*
 * «Reflejos»: the computer opponent («Rivales bot», see docs/crear-un-juego.md).
 *
 * It watches what the TV shows (rmeta): when the phase turns to «go» (the
 * TV says «¡YA!») it taps (r.tap, the phone's only game message) after a
 * reaction time drawn for that round from its level: a normal distribution
 * around `reactMs` with deviation `sdMs`, never below `minMs`.
 *
 * Tapping before «¡YA!» puts you out for the round (index.js), so the easier
 * levels sometimes jump the gun: in a fraction `falseStart` of the rounds they
 * «anticipate» and tap at a random moment while the TV still says
 * «Preparados…» (if «¡YA!» comes first, they just react as usual).
 *
 * It never presses «Otra partida» (one player is enough: the person decides).
 */
const Kit = require('../bot-kit');

/*
 * reactMs: mean reaction time after the TV shows «¡YA!» (ms)
 * sdMs: its deviation (ms)
 * minMs: the fastest it ever reacts (ms)
 * falseStart: chance per round of tapping too soon (during «Preparados…»)
 * earlyMs: when it jumps the gun: that many ms after «Preparados…» shows
 *          (the game waits 2-5 s before «¡YA!»)
 */
const LEVELS = {
  facil: { reactMs: 450, sdMs: 120, minMs: 220, falseStart: 0.12, earlyMs: [1200, 4500] },
  normal: { reactMs: 320, sdMs: 80, minMs: 170, falseStart: 0.03, earlyMs: [1500, 4500] },
  dificil: { reactMs: 240, sdMs: 50, minMs: 150, falseStart: 0, earlyMs: [0, 0] },
  imposible: { reactMs: 170, sdMs: 25, minMs: 120, falseStart: 0, earlyMs: [0, 0] }
};

function create(ctx) {
  const P = Kit.byLevel(ctx.level, LEVELS);
  let key = '';        // phase|round of the last rmeta seen
  let wasOut = false;  // it was out (tapped too soon) in the last rmeta
  let tapAt = 0;       // when it will tap (0: no tap planned)
  let tapped = false;  // already tapped in this phase
  let paused = false;
  let stopped = false;

  function reaction() {
    return Math.max(P.minMs, P.reactMs + P.sdMs * Kit.gauss(ctx.random));
  }

  // A new «Preparados…»: maybe it will jump the gun this time
  function newReady() {
    tapped = false;
    tapAt = 0;
    if (P.falseStart > 0 && ctx.random() < P.falseStart) {
      tapAt = ctx.now() + P.earlyMs[0] + ctx.random() * (P.earlyMs[1] - P.earlyMs[0]);
    }
  }

  return {
    onTv: function (m) {
      if (stopped || m.t !== 'rmeta') return;
      const out = m.early.indexOf(ctx.slot) >= 0;
      const k = m.phase + '|' + m.round;
      const changed = k !== key;
      // Everybody jumped the gun: the same round starts again (same key, out list emptied)
      const restarted = !changed && m.phase === 'ready' && wasOut && !out;
      key = k;
      wasOut = out;
      const resumed = paused && !m.paused;
      paused = !!m.paused;
      if (paused || m.players.indexOf(ctx.slot) < 0) { tapAt = 0; return; }
      if (resumed && !changed && m.phase === 'go' && !tapped && !out) tapAt = ctx.now() + reaction();
      if (changed || restarted) {
        if (m.phase === 'ready') newReady();
        else if (m.phase === 'go') { tapped = false; tapAt = out ? 0 : ctx.now() + reaction(); }
        else { tapAt = 0; tapped = true; }
      }
      if (out) tapAt = 0;
    },
    tick: function () {
      if (stopped || !tapAt || tapped || ctx.now() < tapAt) return;
      tapped = true;
      tapAt = 0;
      ctx.send({ t: 'r.tap' });
    },
    stop: function () { stopped = true; tapAt = 0; }
  };
}

module.exports = { create: create, LEVELS: LEVELS };
