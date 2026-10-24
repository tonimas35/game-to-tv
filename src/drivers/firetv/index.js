'use strict';
/*
 * Amazon Fire TV: use the «android» driver (src/drivers/android/), which
 * installs the app «Juegos del Salón» with the server inside through adb
 * (Fire TV is Android underneath). This id only stays so that
 * `--driver firetv` explains it.
 */
const driver = {
  id: 'firetv',
  name: 'Amazon Fire TV (usa --driver android)',
  description: 'Las Fire TV usan el driver «android»: game-to-tv tv add NOMBRE IP --driver android.',
  capabilities: { discover: false, pair: false, install: false, launch: false, control: false, screenshot: false, perf: false },
  unsupportedHelp: function () {
    return 'Para Fire TV usa el driver «android» (la app con el servidor dentro, por adb):\n' +
      '  game-to-tv tv add NOMBRE IP --driver android   (guía: docs/tele-android.md)';
  }
};

module.exports = driver;
