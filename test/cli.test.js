'use strict';
/*
 * CLI, configuration, argument parser, Windows firewall analysis (with
 * sample data, runs on any OS), browser/Fire TV drivers, game registry and
 * the HTTP routes added in game-to-tv (game files, shells, ambient mode).
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const H_ = require('./helpers');
const { parseArgs } = require('../src/cli/args');
const { analyzeFirewall, psScript } = require('../src/cli/firewall');
const { loadGames, validateManifest } = require('../src/games');
const drivers = require('../src/drivers');
const { judge } = require('../src/games/dibuja/match');

const check = H_.checker('CLI, configuración y servidor');
const TMP = H_.tmpHome('g2t-cli-');

async function argsAndHelp() {
  console.log('\n[Argumentos y ayuda]');
  const a = parseArgs(['tv', 'install', 'salon', '--server-url', 'http://x:1', '--solo-ipk', '--port=3001', '-h'], ['solo-ipk']);
  check(a._.join(' ') === 'tv install salon' && a.flags['server-url'] === 'http://x:1' && a.flags['solo-ipk'] === true && a.flags.port === '3001' && a.flags.help === true,
    'parseArgs: posicionales, --clave valor, --clave=valor, booleanos y -h');
  const b = parseArgs(['--sin-qr', 'start']);
  check(b.flags['sin-qr'] === 'start' || b._[0] === 'start', 'parseArgs no se rompe con flags sin valor');
  let r = await H_.runCli(['--help'], { GAME_TO_TV_HOME: TMP });
  check(r.code === 0 && /Uso:/.test(r.out) && /game-to-tv start/.test(r.out) && /tv perf NOMBRE/.test(r.out) && /doctor/.test(r.out), 'Ayuda en español con todos los comandos');
  r = await H_.runCli(['bailar'], { GAME_TO_TV_HOME: TMP });
  check(r.code === 2 && /Comando desconocido/.test(r.out), 'Comando desconocido: código 2 y ayuda');
  r = await H_.runCli(['--version'], { GAME_TO_TV_HOME: TMP });
  check(r.code === 0 && r.out.trim() === require('../package.json').version, '--version');
  r = await H_.runCli(['tv'], { GAME_TO_TV_HOME: TMP });
  check(r.code === 0 && /tv scan/.test(r.out), 'game-to-tv tv muestra la ayuda de teles');
}

async function tvConfig() {
  console.log('\n[Teles en la configuración]');
  const env = { GAME_TO_TV_HOME: path.join(TMP, 'home') };
  let r = await H_.runCli(['tv', 'add', 'Salón Grande', '192.168.1.50'], env);
  check(r.code === 1 && /Nombre no válido/.test(r.out), 'Nombre de tele no válido');
  r = await H_.runCli(['tv', 'add', 'salon', '192.168.1.500'], env);
  check(r.code === 1 && /IP no válida/.test(r.out), 'IP no válida');
  r = await H_.runCli(['tv', 'add', 'proyector', '192.168.1.60', '--driver', 'browser'], env);
  check(r.code === 0 && /nada que instalar|no hay que instalar/.test(r.out), 'tv add con --driver browser');
  r = await H_.runCli(['tv', 'add', 'fire', '192.168.1.61', '--driver', 'firetv'], env);
  check(r.code === 0 && /todavía no está implementado/.test(r.out), 'Fire TV: se guarda, pero avisa de que aún no está implementado');
  r = await H_.runCli(['tv', 'add', 'x', '192.168.1.62', '--driver', 'tizen'], env);
  check(r.code === 1 && /Driver desconocido/.test(r.out), 'Driver desconocido');
  r = await H_.runCli(['tv', 'list'], env);
  check(r.code === 0 && /proyector\s+192\.168\.1\.60\s+\[Navegador\]/.test(r.out) && /fire/.test(r.out), 'tv list');
  r = await H_.runCli(['tv', 'open', 'proyector', '--server-url', 'http://192.168.1.50:3000'], env);
  check(r.code === 0 && /http:\/\/192\.168\.1\.50:3000\//.test(r.out) && /navegador/.test(r.out), 'tv open con el driver browser: muestra la URL (y un QR)');
  r = await H_.runCli(['tv', 'shot', 'proyector'], env);
  check(r.code === 1 && /no sabe hacer capturas/.test(r.out), 'El driver browser explica lo que no sabe hacer');
  r = await H_.runCli(['tv', 'perf', 'fire'], env);
  check(r.code === 1 && /Fire TV todavía no está implementado/.test(r.out), 'El stub de Fire TV da un mensaje útil');
  r = await H_.runCli(['tv', 'toast', 'nadie', 'hola'], env);
  check(r.code === 1 && /No hay ninguna tele llamada «nadie»/.test(r.out), 'Tele inexistente');
  r = await H_.runCli(['tv', 'remove', 'fire'], env);
  const cfg = JSON.parse(fs.readFileSync(path.join(env.GAME_TO_TV_HOME, 'config.json'), 'utf8'));
  check(r.code === 0 && !cfg.tvs.fire && cfg.tvs.proyector.driver === 'browser', 'tv remove');
  check(drivers.list().map(function (d) { return d.id; }).join(',') === 'webos,browser,firetv', 'Drivers registrados: webos, browser, firetv');
  drivers.list().forEach(function (d) {
    const caps = Object.keys(d.capabilities).sort().join(',');
    check(caps === 'control,discover,install,launch,pair,perf,screenshot' && d.name && d.description, 'Driver «' + d.id + '» declara todas sus capacidades');
  });
}

async function firewallTests() {
  console.log('\n[Cortafuegos de Windows (análisis con datos de ejemplo)]');
  const bad = analyzeFirewall({
    profiles: [{ Name: 'MiRed', InterfaceAlias: 'Wi-Fi', NetworkCategory: 'Public' }],
    nodeRules: [
      { DisplayName: 'Node.js JavaScript Runtime', Action: 'Block', Profile: 'Public', Protocol: 'TCP' },
      { DisplayName: 'Node.js JavaScript Runtime', Action: 'Allow', Profile: 'Private', Protocol: 'TCP' }
    ],
    portRules: []
  }, 3000);
  check(bad.problems.some(function (p) { return /perfil Pública/.test(p) && /Wi-Fi/.test(p); }), 'Detecta la red con perfil Público');
  check(bad.problems.some(function (p) { return /BLOQUEO para Node\.js/.test(p); }), 'Detecta las reglas de bloqueo de Node.js');
  check(bad.commands.indexOf('Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private') >= 0, 'Propone: Set-NetConnectionProfile … -NetworkCategory Private');
  check(bad.commands.some(function (c) { return /Remove-NetFirewallRule/.test(c) && /Node\.js/.test(c) && /Block/.test(c); }), 'Propone quitar las reglas de bloqueo');
  check(bad.commands.indexOf('New-NetFirewallRule -DisplayName "game-to-tv (TCP 3000)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -RemoteAddress LocalSubnet -Profile Private') >= 0,
    'Propone una regla estrecha: TCP 3000, RemoteAddress LocalSubnet, perfil Privado');
  const good = analyzeFirewall({
    profiles: { InterfaceAlias: 'Ethernet', NetworkCategory: 'Private' },
    nodeRules: [],
    portRules: { DisplayName: 'game-to-tv (TCP 3000)', Action: 'Allow', Profile: 'Private' }
  }, 3000);
  check(!good.problems.length && !good.commands.length && good.ok.length === 2, 'Con perfil Privado y la regla del puerto: todo bien (acepta objetos sueltos de ConvertTo-Json)');
  // Real Windows PC without admin rights: Get-NetFirewallRule returned 0 rules → "can't read", not "no rule"
  const unknown = analyzeFirewall({ profiles: { InterfaceAlias: 'Ethernet', NetworkCategory: 'Private' }, nodeRules: [], portRules: [], totalInbound: 0 }, 3000);
  check(!unknown.problems.length && unknown.warnings.length === 1 && /administrador/.test(unknown.warnings[0]) && unknown.commands.length === 1,
    'Sin permisos para leer reglas (0 reglas): avisa en vez de dar un falso error');
  const anyProfile = analyzeFirewall({ profiles: { InterfaceAlias: 'Ethernet', NetworkCategory: 'Private' }, nodeRules: [],
    portRules: { DisplayName: 'Regla propia 3000', Action: 'Allow', Profile: 'Any' }, totalInbound: 120 }, 3000);
  check(!anyProfile.problems.length && anyProfile.ok.some(function (o) { return /Regla propia 3000/.test(o); }), 'Una regla del puerto con perfil «Any» también vale');
  const script = psScript(3000);
  check(/Get-NetConnectionProfile/.test(script) && /Get-NetFirewallRule/.test(script) && !/Set-|New-|Remove-/.test(script) && /totalInbound/.test(script), 'El script de PowerShell solo lee (Get-*), nunca cambia nada');
}

async function doctorTest() {
  console.log('\n[doctor]');
  const env = { GAME_TO_TV_HOME: path.join(TMP, 'home'), PATH: '/usr/bin:/bin' };
  // Port busy by something else
  const blocker = net.createServer();
  await new Promise(function (r) { blocker.listen(0, '0.0.0.0', r); });
  const port = blocker.address().port;
  const r = await H_.runCli(['doctor', '--port', String(port)], env);
  blocker.close();
  check(/Node\.js \d+/.test(r.out) && /IP del PC|No hay ninguna red/.test(r.out) && /ares-cli/.test(r.out) && /Galería de dibujos/.test(r.out), 'doctor revisa Node, IP, ares-cli y la galería');
  check(new RegExp('puerto ' + port + ' está ocupado por otro programa').test(r.out) && r.code === 1, 'doctor detecta el puerto ocupado');
  check(/Tele «proyector»/.test(r.out), 'doctor lista las teles configuradas');
}

async function serverRoutes() {
  console.log('\n[Rutas del servidor]');
  const PORT = 3993;
  const BASE = 'http://127.0.0.1:' + PORT;
  const HOME = path.join(TMP, 'home-srv');
  fs.mkdirSync(path.join(HOME, 'ambiente'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'ambiente', 'playa.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(HOME, 'ambiente', 'notas.txt'), 'no');
  const srv = await H_.startServer({ GAME_TO_TV_HOME: HOME, PORT: String(PORT), HOST_IP: '192.168.1.50', TZ_AMBIENTE: 'Atlantic/Canary' });
  try {
    const tv = await H_.httpGet(BASE, '/');
    const ids = (tv.body.match(/window\.G2T_BOOT = (\{.*?\});<\/script>/) || [])[1];
    const boot = ids ? JSON.parse(ids) : { games: [] };
    check(boot.games.map(function (g) { return g.id; }).join(',') === 'dibuja,pong,ejemplo-reflejos', 'La tele recibe la lista de juegos (ordenada por «order»)');
    check(tv.body.indexOf('<script src="/games/pong/tv.js"></script>') > tv.body.indexOf('<script src="/lib/core.js"></script>') &&
      tv.body.indexOf('window.G2T_BOOT') < tv.body.indexOf('/lib/core.js') && /href="\/games\/dibuja\/tv\.css"/.test(tv.body), 'El shell de la tele carga core.js y luego tv.js/tv.css de cada juego');
    const m = await H_.httpGet(BASE, '/m');
    check(/\/games\/ejemplo-reflejos\/phone\.js/.test(m.body) && /\/games\/dibuja\/phone\.css/.test(m.body), 'El shell del móvil carga phone.js/phone.css de cada juego');
    check(boot.games[1].tv && boot.games[1].tv.field && boot.games[1].tv.field.w === 1920, 'Datos extra para la tele (campo del Pong)');
    const js = await H_.httpGet(BASE, '/games/pong/tv.js');
    check(js.status === 200 && /javascript/.test(js.type) && js.headers['cache-control'] === 'no-store', '/games/pong/tv.js se sirve sin caché');
    check((await H_.httpGet(BASE, '/games/pong/index.js')).status === 404 && (await H_.httpGet(BASE, '/games/pong/manifest.json')).status === 404, 'El código del servidor de los juegos no se sirve');
    check((await H_.httpGet(BASE, '/games/nada/tv.js')).status === 404 && (await H_.httpGet(BASE, '/games/pong/..%2F..%2Fconfig.js')).status === 404, 'Rutas de juegos inexistentes o con «..» -> 404');
    check((await H_.httpGet(BASE, '/lib/core.js')).status === 200 && (await H_.httpGet(BASE, '/lib/../tv.html')).status !== 200, '/lib/ solo sirve sus archivos');
    check((await H_.httpGet(BASE, '/games/dibuja/icon.svg')).type.indexOf('image/svg+xml') === 0, 'Iconos de los juegos');
    const info = JSON.parse((await H_.httpGet(BASE, '/info')).body);
    check(info.app === 'game-to-tv' && info.juegos.length === 3 && info.movil === 'http://192.168.1.50:' + PORT + '/m', '/info identifica a game-to-tv');
    const amb = await H_.httpGet(BASE, '/ambiente');
    check(amb.status === 200 && /Modo ambiente/.test(amb.body), '/ambiente');
    const list = JSON.parse((await H_.httpGet(BASE, '/ambiente/lista.json')).body);
    check(list.fotos.length === 1 && list.fotos[0] === '/ambiente/foto/playa.png' && list.zonaHoraria === 'Atlantic/Canary', 'Lista de fotos del modo ambiente (solo imágenes) y zona horaria configurable');
    const foto = await H_.httpGet(BASE, '/ambiente/foto/playa.png');
    check(foto.status === 200 && foto.type === 'image/png', 'Sirve las fotos del modo ambiente');
    check((await H_.httpGet(BASE, '/ambiente/foto/..%2Fconfig.json')).status === 404 && (await H_.httpGet(BASE, '/ambiente/foto/notas.txt')).status === 404, 'El modo ambiente no deja salir de su carpeta ni sirve otros archivos');
    check(/Juegos:\s+Dibuja y adivina, Pong, Reflejos/.test(srv.out), 'start lista los juegos cargados');
    // Port already in use -> clear Spanish error
    const r = await H_.runCli(['start', '--port', String(PORT), '--sin-qr'], { GAME_TO_TV_HOME: HOME });
    check(r.code === 1 && /ya está en uso/.test(r.out), 'start con el puerto ocupado: mensaje claro');
  } finally {
    await srv.stop();
  }
}

function registryTests() {
  console.log('\n[Registro de juegos]');
  const g = loadGames();
  check(g.list.length === 3 && g.byId.dibuja && g.byId.pong && g.byId['ejemplo-reflejos'], 'Se cargan los 3 juegos de src/games');
  check(validateManifest({ id: 'x', title: 'X', description: 'd', minPlayers: 2, maxPlayers: 1 }, 'x').length === 1, 'maxPlayers < minPlayers es un error');
  check(validateManifest({ id: 'Malo', title: 'X', description: 'd', minPlayers: 1, maxPlayers: 2 }, 'otro').length === 2, 'id con mayúsculas o distinto de la carpeta es un error');
  // A broken game folder is skipped with a message, the rest still load
  const dir = path.join(TMP, 'juegos');
  fs.mkdirSync(path.join(dir, 'roto'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'roto', 'manifest.json'), '{"id":"roto"}');
  fs.mkdirSync(path.join(dir, 'mini'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mini', 'manifest.json'), JSON.stringify({ id: 'mini', title: 'Mini', description: 'Prueba', minPlayers: 2, maxPlayers: 2 }));
  fs.writeFileSync(path.join(dir, 'mini', 'index.js'), 'module.exports = { create: function () { return {}; } };');
  const logs = [];
  const g2 = loadGames([dir], function (s) { logs.push(s); });
  check(g2.list.length === 1 && g2.list[0].id === 'mini' && logs.some(function (l) { return /roto/.test(l); }), 'Un juego roto se ignora con un aviso; los demás se cargan');
}

function matchTests() {
  console.log('\n[Comparación de respuestas de «Dibuja y adivina»]');
  check(judge('la piña', 'Piña') === 'ok' && judge('CABALLITO DE MAR', 'caballito de mar') === 'ok', 'Sin importar mayúsculas, tildes ni artículo');
  check(judge('elefnte', 'elefante') === 'ok' && judge('elfnte', 'elefante') === 'casi' && judge('perro', 'gato') === 'no', 'Erratas toleradas y «¡Casi!»');
}

(async function () {
  try {
    await argsAndHelp();
    await tvConfig();
    await firewallTests();
    await doctorTest();
    await serverRoutes();
    registryTests();
    matchTests();
  } catch (e) {
    check.fail('Excepción: ' + (e && e.stack || e));
  } finally {
    H_.rmrf(TMP);
  }
  check.done();
})();
