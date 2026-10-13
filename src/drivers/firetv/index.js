'use strict';
/*
 * Amazon Fire TV driver: NOT implemented yet (see README.md in this folder
 * for the plan: adb over the network, a small Android WebView launcher APK,
 * adb screencap and adb keyevents). Meanwhile, use the «browser» driver
 * with the Silk browser.
 */
const driver = {
  id: 'firetv',
  name: 'Amazon Fire TV (pendiente)',
  description: 'Aún no está hecho: de momento usa el driver «browser» con el navegador Silk.',
  capabilities: { discover: false, pair: false, install: false, launch: false, control: false, screenshot: false, perf: false },
  unsupportedHelp: function () {
    return 'El driver de Fire TV todavía no está implementado (ver src/drivers/firetv/README.md).\n' +
      'Mientras tanto: game-to-tv tv add NOMBRE IP --driver browser, y abre la dirección en el navegador Silk.';
  }
};

module.exports = driver;
