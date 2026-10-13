'use strict';
/*
 * game-to-tv command line. All user-facing text is in Spanish.
 *
 *   game-to-tv start [--port 3000] [--host-ip IP] [--jugadores N] [--galeria DIR] [--abrir TELE] [--sin-qr]
 *   game-to-tv doctor
 *   game-to-tv tv <subcomando> ...      (see src/cli/tv.js)
 */
const { parseArgs } = require('./args');
const pkg = require('../../package.json');

const BOOLEANS = ['help', 'sin-qr', 'solo-ipk', 'json', 'version', 'forzar', 'ares', 'js', 'logs', 'navegador'];

const HELP = [
  '',
  '  game-to-tv ' + pkg.version + ' · juegos para el salón: la tele es la pantalla y los móviles, los mandos',
  '',
  '  Uso:',
  '    game-to-tv start [opciones]          Arranca el servidor (por defecto en el puerto 3000)',
  '        --port N                         Puerto HTTP y WebSocket (o la variable PORT)',
  '        --host-ip IP                     IP del PC que sale en el QR (o la variable HOST_IP)',
  '        --jugadores N                    Huecos de jugador, de 2 a 8 (por defecto 2)',
  '        --galeria CARPETA                Dónde guardar los dibujos (por defecto ~/.game-to-tv/galeria)',
  '        --abrir TELE                     Abre los juegos en esa tele al arrancar',
  '        --sin-qr                         No dibujar el QR en la terminal',
  '',
  '    game-to-tv doctor                    Revisa Node, el puerto, la IP, el cortafuegos de Windows,',
  '                                         ares-cli y las teles configuradas (no cambia nada)',
  '',
  '    game-to-tv tv scan                   Busca teles en la red (LG webOS por SSDP)',
  '    game-to-tv tv add NOMBRE IP [--driver webos|browser|firetv]',
  '    game-to-tv tv list                   Teles configuradas',
  '    game-to-tv tv remove NOMBRE',
  '    game-to-tv tv pair NOMBRE            Empareja con la tele (acepta el aviso en la pantalla)',
  '    game-to-tv tv install NOMBRE [--modo tele|pc] [--server-url URL] [--solo-ipk] [--salida CARPETA]',
  '                                         Crea la app y la instala. LG: por defecto en modo tele (el',
  '                                         servidor va dentro de la tele, sin PC); --modo pc abre el del PC',
  '    game-to-tv tv ipk [--modo tele|pc] [--server-url URL] [--salida CARPETA]',
  '                                         Solo crea el .ipk de la app para LG (sin tele)',
  '    game-to-tv tv open NOMBRE [--ruta /ambiente]   Abre los juegos en la tele',
  '    game-to-tv tv status NOMBRE [--logs]           ¿Responde el servidor de dentro de la tele? (modo tele)',
  '    game-to-tv tv shot NOMBRE [archivo.jpg]        Captura de pantalla de la tele',
  '    game-to-tv tv perf NOMBRE [--segundos 4]       Mide los FPS reales en la tele (ares-inspect + CDP)',
  '    game-to-tv tv toast NOMBRE "mensaje"           Muestra un aviso en la tele',
  '    game-to-tv tv key NOMBRE BOTON                 Pulsa un botón del mando (UP, DOWN, ENTER, BACK…)',
  '    game-to-tv tv info NOMBRE                      Modelo, versión y app en primer plano',
  '',
  '  Configuración: ~/.game-to-tv/config.json (o la variable GAME_TO_TV_HOME)',
  '  Documentación: carpeta docs/ del proyecto (README.md para empezar)',
  ''
].join('\n');

async function main(argv) {
  const args = parseArgs(argv, BOOLEANS);
  const cmd = args._[0];
  if (args.flags.version || cmd === 'version' || cmd === '--version') {
    console.log(pkg.version);
    return 0;
  }
  if (!cmd || cmd === 'help' || cmd === 'ayuda' || (args.flags.help && cmd !== 'tv')) {
    console.log(HELP);
    return 0;
  }
  switch (cmd) {
    case 'start':
    case 'iniciar':
      return require('./start').start(args.flags);
    case 'doctor':
      return require('./doctor').doctor(args.flags);
    case 'tv':
    case 'tele':
      return require('./tv').run(args._.slice(1), args.flags);
    default:
      console.log('\n  Comando desconocido: «' + cmd + '».');
      console.log(HELP);
      return 2;
  }
}

module.exports = { main: main, HELP: HELP };
