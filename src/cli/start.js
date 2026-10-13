'use strict';
// `game-to-tv start`: starts the server and prints the URLs and a terminal QR.
const QRCode = require('qrcode');
const { createServer } = require('../server');
const config = require('../config');
const ui = require('./ui');

async function start(flags) {
  const cfg = config.load();
  const port = flags.port != null && flags.port !== true ? parseInt(flags.port, 10) : (parseInt(process.env.PORT, 10) || cfg.port || 3000);
  if (!(port >= 0 && port < 65536)) throw new Error('Puerto no válido: ' + flags.port);
  const srv = createServer({
    config: cfg,
    port: port,
    hostIp: typeof flags['host-ip'] === 'string' ? flags['host-ip'] : undefined,
    maxPlayers: flags.jugadores ? parseInt(flags.jugadores, 10) : undefined,
    galleryDir: typeof flags.galeria === 'string' ? flags.galeria : undefined
  });
  let urls;
  try {
    urls = await srv.listen();
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      throw new Error('El puerto ' + port + ' ya está en uso. ¿Hay otro game-to-tv abierto? Ciérralo o usa --port ' + (port + 1) + '.');
    }
    if (e.code === 'EACCES') throw new Error('No hay permiso para usar el puerto ' + port + '. Prueba con uno mayor de 1024.');
    throw e;
  }

  console.log('');
  console.log('  ' + ui.c.bold('==========  JUEGOS DEL SALÓN · game-to-tv  =========='));
  console.log('  Servidor escuchando en el puerto ' + srv.http.address().port);
  console.log('');
  console.log('  Tele (la app de la tele abre esto):  ' + ui.c.cyan(urls.tv));
  console.log('  Móviles (o escanea el QR):           ' + ui.c.magenta(urls.phone));
  console.log('  QR:                                  ' + urls.qr);
  console.log('  Galería de dibujos:                  ' + urls.gallery + '  (' + srv.galleryDir + ')');
  console.log('  Modo ambiente:                       ' + urls.ambient + '  (' + srv.ambientDir + ')');
  console.log('  Juegos:                              ' + srv.games.list.map(function (g) { return g.manifest.title; }).join(', '));
  const others = srv.otherIps();
  if (others.length && !flags['host-ip'] && !process.env.HOST_IP) {
    console.log('');
    console.log('  Otras IP detectadas (si la de arriba no es la buena, usa --host-ip):');
    others.forEach(function (c) { console.log('    - ' + c.address + '  (' + c.name + ')'); });
  }
  if (!flags['sin-qr']) {
    try {
      const qr = await QRCode.toString(urls.phone, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
      console.log('');
      console.log('  Escanea con el móvil:');
      console.log(qr.split('\n').map(function (l) { return '  ' + l; }).join('\n'));
    } catch (e) { /* noop */ }
  }
  console.log('  Para pararlo, pulsa Ctrl + C.');
  console.log('');

  if (typeof flags.abrir === 'string') {
    const target = cfg.tvs[flags.abrir];
    if (target && target.driver === 'webos' && target.mode === 'tele') {
      ui.warn('La app de «' + flags.abrir + '» está instalada en modo tele: usará el servidor de dentro de la tele, no este.');
      ui.info('Para que use este PC: game-to-tv tv install ' + flags.abrir + ' --modo pc');
    }
    // Opens the game screen on a configured TV
    const tvcmd = require('./tv');
    tvcmd.run(['open', flags.abrir], { 'server-url': urls.base }).catch(function (e) {
      ui.warn('No se pudo abrir en la tele «' + flags.abrir + '»: ' + e.message);
    });
  }

  return new Promise(function (resolve) {
    let closing = false;
    function shutdown() {
      if (closing) return;
      closing = true;
      console.log('\n  Cerrando servidor...');
      srv.close().then(function () { resolve(0); process.exit(0); });
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

module.exports = { start: start };
