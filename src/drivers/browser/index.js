'use strict';
/*
 * Generic browser driver: any TV, projector, Fire TV (Silk), console or
 * laptop with a web browser. Nothing to install or pair: it only gives you
 * the address to open (and a QR to pass it to another device).
 */
const QRCode = require('qrcode');

const driver = {
  id: 'browser',
  name: 'Navegador',
  description: 'Cualquier tele o proyector con navegador: abre la dirección y listo (nada que instalar).',
  capabilities: { discover: false, pair: false, install: false, launch: true, control: false, screenshot: false, perf: false },

  async launch(tv, opts) {
    const url = (opts.serverUrl || 'http://IP-DEL-PC:3000') + (opts.path || '/');
    let qr = '';
    try { qr = await QRCode.toString(url, { type: 'terminal', small: true }); } catch (e) { /* noop */ }
    return {
      url: url,
      qr: qr,
      message: 'Abre esta dirección en el navegador de «' + tv.name + '»:\n\n    ' + url + '\n\n' +
        'Consejos: pon el navegador a pantalla completa y añade la página a favoritos.\n' +
        'En Fire TV, usa el navegador Silk (o Firefox) e introduce la dirección a mano.'
    };
  },

  unsupportedHelp: function () {
    return 'Con el driver «browser» no hay nada que instalar: abre en la tele la dirección que muestra «game-to-tv start».';
  }
};

module.exports = driver;
