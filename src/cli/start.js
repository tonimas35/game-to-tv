'use strict';
/*
 * `game-to-tv start`: starts the server and prints the URLs and a terminal QR.
 * Works on a fresh computer (no ~/.game-to-tv, no TV registered): modo pc on
 * port 3000, nothing to answer.
 *   --navegador  also opens the TV page in this computer's browser, full
 *                screen (laptop connected to the TV by HDMI)
 *   --sencillo   short, plain-Spanish instructions instead of the technical
 *                list (used by the one-click installers in instalar/)
 */
const http = require('http');
const QRCode = require('qrcode');
const { createServer } = require('../server');
const config = require('../config');
const ui = require('./ui');
const { openBrowser } = require('./open-browser');

// Is game-to-tv already answering on this port? (e.g. the shortcut was double-clicked twice)
function gameToTvOnPort(port) {
  return new Promise(function (resolve) {
    const req = http.get({ host: '127.0.0.1', port: port, path: '/info', timeout: 1500 }, function (res) {
      let body = '';
      res.on('data', function (d) { body += d; });
      res.on('end', function () { try { resolve(JSON.parse(body).app === 'game-to-tv'); } catch (e) { resolve(false); } });
    });
    req.on('timeout', function () { req.destroy(); resolve(false); });
    req.on('error', function () { resolve(false); });
  });
}

function localTvUrl(port) { return 'http://localhost:' + port + '/'; }

async function openTvPage(port, simple) {
  const r = await openBrowser(localTvUrl(port));
  if (r.skipped) {
    ui.info(ui.c.dim('(No abro el navegador: G2T_NAVEGADOR=0. Pantalla de juegos: ' + localTvUrl(port) + ')'));
  } else if (!r.ok) {
    ui.warn('No he podido abrir el navegador (' + r.error + '). Ábrelo tú y escribe: ' + localTvUrl(port));
  } else if (!r.fullscreen && simple) {
    ui.info('Abierta la pantalla de juegos en ' + r.label + '. Para verla a pantalla completa, pulsa F11' +
      (process.platform === 'darwin' ? ' (en Mac: Control + Cmd + F).' : '.'));
  } else if (!simple) {
    ui.ok('Pantalla de juegos abierta en ' + r.label + (r.fullscreen ? ' a pantalla completa (F11 para salir).' : '.'));
  }
}

function simpleBanner(urls, others, browser) {
  const line = '  ' + '='.repeat(64);
  console.log('');
  console.log(ui.c.bold(line));
  console.log(ui.c.bold('     JUEGOS DEL SALÓN ESTÁ EN MARCHA'));
  console.log(ui.c.bold(line));
  console.log('');
  console.log('  ' + ui.c.bold(ui.c.yellow('>>  Deja esta ventana abierta mientras jugáis.')));
  console.log(ui.c.dim('      (Deixa aquesta finestra oberta mentre jugueu.)'));
  console.log('');
  if (browser) {
    console.log('  >>  La pantalla de juegos se abre en este ordenador. Conéctalo a la tele');
    console.log('      con un cable HDMI y elige esa entrada con el botón «Source» del mando.');
    console.log('');
    console.log('  >>  O, en la tele Samsung, abre la app «Internet» y escribe esta dirección:');
  } else {
    console.log('  >>  En la tele, abre el navegador (en Samsung, la app «Internet») y escribe:');
  }
  console.log('');
  console.log('          ' + ui.c.bold(ui.c.cyan(urls.tv)));
  console.log('');
  if (others.length) {
    console.log(ui.c.dim('      (Si no funciona, prueba con: ' + others.map(function (c) { return 'http://' + c.address + ':' + urls.port + '/'; }).join('  o  ') + ')'));
    console.log('');
  }
  console.log('  >>  Móviles: conectaos al mismo Wi-Fi y escanead el QR que sale en la tele.');
  console.log('');
  console.log('  ' + ui.c.bold(ui.c.yellow('>>  Para salir, cierra esta ventana.')));
  console.log(ui.c.dim('      (Per sortir, tanca aquesta finestra.)'));
  console.log(ui.c.bold(line));
}

async function start(flags) {
  const simple = !!flags.sencillo;
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
      if ((flags.navegador || simple) && await gameToTvOnPort(port)) {
        console.log('');
        ui.ok('Juegos del Salón ya estaba en marcha (en otra ventana). No hace falta abrirlo dos veces.');
        if (flags.navegador) await openTvPage(port, simple);
        console.log('');
        return 0;
      }
      throw new Error('El puerto ' + port + ' ya está en uso. ¿Hay otro game-to-tv abierto? Ciérralo o usa --port ' + (port + 1) + '.');
    }
    if (e.code === 'EACCES') throw new Error('No hay permiso para usar el puerto ' + port + '. Prueba con uno mayor de 1024.');
    throw e;
  }

  const others = srv.otherIps();
  const showOthers = others.length && !flags['host-ip'] && !process.env.HOST_IP;
  if (simple) {
    simpleBanner(Object.assign({ port: srv.http.address().port }, urls), showOthers ? others : [], !!flags.navegador);
  } else {
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
    if (showOthers) {
      console.log('');
      console.log('  Otras IP detectadas (si la de arriba no es la buena, usa --host-ip):');
      others.forEach(function (c) { console.log('    - ' + c.address + '  (' + c.name + ')'); });
    }
  }
  if (!flags['sin-qr']) {
    try {
      const qr = await QRCode.toString(urls.phone, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
      console.log('');
      console.log('  ' + (simple ? 'También podéis escanear este QR con el móvil:' : 'Escanea con el móvil:'));
      console.log(qr.split('\n').map(function (l) { return '  ' + l; }).join('\n'));
    } catch (e) { /* noop */ }
  }
  if (simple) console.log('  (Servidor escuchando en el puerto ' + srv.http.address().port + ' · móviles: ' + urls.phone + ')');
  else console.log('  Para pararlo, pulsa Ctrl + C.');
  console.log('');

  if (flags.navegador) await openTvPage(srv.http.address().port, simple);

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
