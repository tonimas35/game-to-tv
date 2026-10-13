'use strict';
/*
 * «Modo tele» end to end, without a TV:
 *  - the .ipk with the app AND the JS service (pure-JS packager): layout of
 *    data.tar.gz (applications/, services/, packages/…/packageinfo.json),
 *    control, debian-binary; production node_modules only, no dev stuff
 *  - the packaged service, extracted OUTSIDE the project, boots with a fake
 *    webos-service and its own node_modules (and on Node 12 if G2T_NODE12
 *    points to a Node 12 binary)
 *  - pc mode still builds the old launcher (no service)
 *  - CLI: tv ipk, tv install (fake ares-cli), tv status, tv open, doctor
 *  - the Node 12 static check (scripts/check-node12.js) and that it catches problems
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');
const H_ = require('./helpers');
const { startFakeTv } = require('./helpers/fake-tv');
const webos = require('../src/drivers/webos');
const ipk = require('../src/drivers/webos/ipk');
const node12check = require('../scripts/check-node12');
const { createServer } = require('../src/server');
const PKG = require('../package.json');

const check = H_.checker('Modo tele: paquete con servicio, arranque empaquetado y CLI');
const TMP = H_.tmpHome('g2t-tele-');
const APP = 'io.gametotv.launcher';
const SVC = APP + '.service';
const V = PKG.version;

function readConfig(home) { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); }
function writeConfig(home, cfg) { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg)); }

function readIpk(file) {
  const members = ipk.parseAr(fs.readFileSync(file));
  return {
    members: members,
    control: ipk.parseTar(zlib.gunzipSync(members[1].data)),
    data: ipk.parseTar(zlib.gunzipSync(members[2].data))
  };
}

function extract(entries, dest) {
  entries.forEach(function (e) {
    const p = path.join(dest, e.name);
    if (e.type === '5') fs.mkdirSync(p, { recursive: true });
    else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, e.data); }
  });
}

function bootPackaged(nodeBin, svcDir, port, home) {
  return new Promise(function (resolve) {
    const p = spawn(nodeBin, [path.join(__dirname, 'helpers', 'boot-service.js'), svcDir], {
      env: Object.assign({}, process.env, {
        NODE_PATH: path.join(__dirname, 'helpers', 'fake-modules'),
        G2T_PORT: String(port), HOST_IP: '192.168.1.77', HOME: home
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    p.stdout.on('data', function (d) { out += d; });
    p.stderr.on('data', function (d) { out += d; });
    const t = setTimeout(function () { try { p.kill('SIGKILL'); } catch (e) { /* noop */ } }, 30000);
    p.on('exit', function (code) {
      clearTimeout(t);
      const m = /RESULT (.*)/.exec(out);
      let r = null;
      try { r = m ? JSON.parse(m[1]) : null; } catch (e) { /* noop */ }
      resolve({ code: code, out: out, r: r });
    });
  });
}

async function packageTests() {
  console.log('\n[.ipk en modo tele (empaquetador en JavaScript)]');
  const out = path.join(TMP, 'ipk-tele');
  const built = await webos.build({ name: 'salon' }, { mode: 'tele', outDir: out, packager: 'js', idleMinutes: 20 });
  check(built.mode === 'tele' && built.serviceId === SVC && built.port === 8090 && path.basename(built.ipk) === APP + '_' + V + '_all.ipk', 'build() en modo tele: app + servicio ' + SVC + ' (puerto 8090)');
  const size = fs.statSync(built.ipk).size;
  console.log('    tamaño del .ipk en modo tele: ' + Math.round(size / 1024) + ' KB (' + size + ' bytes)');
  check(size > 100 * 1024 && size < 2 * 1024 * 1024, 'Tamaño razonable (' + Math.round(size / 1024) + ' KB)');

  const pk = readIpk(built.ipk);
  check(pk.members.map(function (m) { return m.name; }).join(',') === 'debian-binary,control.tar.gz,data.tar.gz' && pk.members[0].data.toString() === '2.0\n', 'ar: debian-binary (2.0), control.tar.gz, data.tar.gz');
  const control = pk.control.filter(function (e) { return e.name === './control'; })[0].data.toString();
  check(new RegExp('^Package: ' + APP.replace(/\./g, '\\.') + '$', 'm').test(control) && new RegExp('^Version: ' + V.replace(/\./g, '\\.') + '$', 'm').test(control) &&
    /^Architecture: all$/m.test(control) && /^Installed-Size: \d+$/m.test(control), 'control: Package, Version, Architecture: all, Installed-Size');
  check(pk.data.every(function (e) { return e.checksumOk; }), 'Cabeceras tar con checksum correcto (' + pk.data.length + ' entradas)');

  const names = pk.data.map(function (e) { return e.name; });
  const A = './usr/palm/applications/' + APP + '/';
  const S = './usr/palm/services/' + SVC + '/';
  function has(n) { return names.indexOf(n) >= 0; }
  function file(n) { return pk.data.filter(function (e) { return e.name === n; })[0]; }
  check(has(A + 'appinfo.json') && has(A + 'index.html') && has(A + 'icon-' + V + '.png') && has(A + 'largeIcon-' + V + '.png'), 'La app: appinfo.json, index.html e iconos con la versión');
  const html = file(A + 'index.html').data.toString();
  check(/var MODE = 'tele';/.test(html) && /var PORT = '8090';/.test(html) && html.indexOf("var SERVICE = '" + SVC + "';") >= 0 && /var SERVER = '';/.test(html), 'index.html en modo tele: servicio, puerto 8090 y sin servidor de reserva');
  check(['package.json', 'services.json', 'service.js', 'tv-service.json', 'src/server/index.js', 'src/server/hub.js', 'src/config.js', 'src/tv-service/core.js', 'src/tv-service/service.js',
    'src/games/dibuja/index.js', 'src/games/dibuja/raster.js', 'src/games/dibuja/words.js', 'src/games/pong/tv.js', 'src/games/ejemplo-reflejos/manifest.json',
    'public/tv.html', 'public/m.html', 'public/lib/tvservice.js', 'public/keepalive.mp4'].every(function (f) { return has(S + f); }),
  'El servicio: código del servidor, juegos, páginas y archivos generados');
  check(['ws/index.js', 'ws/lib/websocket-server.js', 'qrcode/lib/index.js', 'qrcode/node_modules/pngjs/lib/png.js', 'pngjs/lib/png.js', 'dijkstrajs/dijkstra.js'].every(function (f) { return has(S + 'node_modules/' + f); }),
    'node_modules de producción: ws, qrcode (con su pngjs 5), pngjs 7, dijkstrajs');
  const bad = names.filter(function (n) {
    return /\/node_modules\/(acorn|yargs|webos-service)\//.test(n) || /\/(test|tests|docs|bin|scripts|apps)\//.test(n) || /\/src\/(cli|drivers)\//.test(n) ||
      /\.(md|ts|map)$/.test(n) || /\/\.[^/]+$/.test(n) || /\/browser\.js$/.test(n) && /pngjs/.test(n) || /fake-|\.test\.js$/.test(n);
  });
  check(bad.length === 0, 'Nada de desarrollo: sin tests, docs, CLI, drivers, acorn, yargs, webos-service ni *.md' + (bad.length ? ' -> ' + bad.slice(0, 5).join(', ') : ''));
  const spkg = JSON.parse(file(S + 'package.json').data.toString());
  const sjson = JSON.parse(file(S + 'services.json').data.toString());
  const tvs = JSON.parse(file(S + 'tv-service.json').data.toString());
  check(spkg.name === SVC && spkg.main === 'service.js' && spkg.version === V && !spkg.dependencies, 'package.json del servicio: name = id del servicio, main = service.js');
  check(sjson.id === SVC && sjson.services.length === 1 && sjson.services[0].name === SVC && sjson.description, 'services.json: { id, description, services: [{ name }] }');
  check(tvs.port === 8090 && tvs.idleMinutes === 20 && tvs.serviceId === SVC && tvs.version === V, 'tv-service.json: puerto y minutos de inactividad configurables');
  const pinfo = JSON.parse(file('./usr/palm/packages/' + APP + '/packageinfo.json').data.toString());
  check(pinfo.app === APP && pinfo.id === APP && pinfo.version === V && JSON.stringify(pinfo.services) === JSON.stringify([SVC]), 'packageinfo.json: { app, id, version, services: [' + SVC + '] }');
  check(has('./usr/palm/services/') && has('./usr/palm/services/' + SVC + '/') && has(S + 'node_modules/qrcode/node_modules/pngjs/lib/'), 'Entradas de carpeta usr/palm/services/<id>/… en el tar');

  if (process.platform !== 'win32') {
    try {
      const work = path.join(TMP, 'ar-x');
      fs.mkdirSync(work, { recursive: true });
      execFileSync('ar', ['x', built.ipk], { cwd: work });
      const list = execFileSync('tar', ['tzf', path.join(work, 'data.tar.gz')], { maxBuffer: 1 << 24 }).toString();
      check(list.indexOf(S + 'node_modules/qrcode/node_modules/pngjs/lib/filter-parse-async.js') >= 0, 'ar y tar del sistema leen el paquete (rutas largas con prefijo ustar)');
    } catch (e) { console.log('    (ar/tar no disponibles: ' + e.message.split('\n')[0] + ')'); }
  }

  // Boot the packaged service outside the project (only its own node_modules)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g2t-tele-boot-'));
  extract(pk.data, root);
  const svcDir = path.join(root, 'usr', 'palm', 'services', SVC);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const nodes = [{ bin: process.execPath, label: 'Node ' + process.versions.node }];
  if (process.env.G2T_NODE12) {
    try {
      const v = execFileSync(process.env.G2T_NODE12, ['--version']).toString().trim();
      nodes.push({ bin: process.env.G2T_NODE12, label: 'Node ' + v.replace(/^v/, '') + ' (G2T_NODE12)' });
    } catch (e) { check.fail('G2T_NODE12 no es un Node que funcione: ' + process.env.G2T_NODE12); }
  } else {
    console.log('    (para probar también con Node 12, como la tele: G2T_NODE12=/ruta/a/node12 npm test)');
  }
  for (let k = 0; k < nodes.length; k++) {
    const port = 18190 + k;
    const b = await bootPackaged(nodes[k].bin, svcDir, port, home);
    const r = b.r || {};
    if (!b.r || b.code !== 0) console.log(b.out.split('\n').slice(-15).join('\n'));
    check(b.code === 0 && r.start && r.start.returnValue && r.start.port === port && r.start.url === 'http://192.168.1.77:' + port + '/' && r.busId === SVC,
      nodes[k].label + ': el servicio empaquetado arranca (start -> ' + (r.start && r.start.url) + ')');
    check(r.info && r.info.mode === 'tele' && r.info.version === V && r.info.movil === 'http://192.168.1.77:' + port + '/m' && r.qr === 200 && r.qrSvg && r.shell && r.helper === 200,
      nodes[k].label + ': /info (modo tele, versión), QR con la IP de la tele, la pantalla y /lib/tvservice.js');
    check(r.status && r.status.gallerySaving && r.status.galleryDir === path.join(home, '.game-to-tv', 'galeria') && r.png === true,
      nodes[k].label + ': galería en $HOME/.game-to-tv/galeria y PNG con el pngjs empaquetado (worker_thread)');
    check(r.stop && r.stop.stopped, nodes[k].label + ': stop');
  }
  H_.rmrf(root);
}

async function pcModeTests() {
  console.log('\n[.ipk en modo pc]');
  const built = await webos.build({ name: 'salon' }, { mode: 'pc', serverUrl: '192.168.1.40:3000', outDir: path.join(TMP, 'ipk-pc'), packager: 'js' });
  const pk = readIpk(built.ipk);
  const names = pk.data.map(function (e) { return e.name; });
  const pinfo = JSON.parse(pk.data.filter(function (e) { return /packageinfo\.json$/.test(e.name); })[0].data.toString());
  check(built.mode === 'pc' && !built.serviceId && !names.some(function (n) { return /usr\/palm\/services/.test(n); }) && !pinfo.services, 'Modo pc: solo la app, sin servicio (como en 0.1)');
  const html = pk.data.filter(function (e) { return /index\.html$/.test(e.name); })[0].data.toString();
  check(/var MODE = 'pc';/.test(html) && /var SERVER = 'http:\/\/192\.168\.1\.40:3000';/.test(html), 'index.html en modo pc con la URL del PC');
  const fb = await webos.build({ name: 'salon' }, { mode: 'tele', serverUrl: '192.168.1.40:3000', outDir: path.join(TMP, 'ipk-fb'), packager: 'js' });
  const html2 = readIpk(fb.ipk).data.filter(function (e) { return /applications\/.*index\.html$/.test(e.name); })[0].data.toString();
  check(/var MODE = 'tele';/.test(html2) && /var SERVER = 'http:\/\/192\.168\.1\.40:3000';/.test(html2), 'Modo tele con --server-url: el PC queda como servidor de reserva');
  let threw = null;
  try { await webos.build({ name: 'salon' }, { mode: 'tele', port: 3001, outDir: path.join(TMP, 'x'), packager: 'js' }); } catch (e) { threw = e; }
  check(threw && /3000 y 3001/.test(threw.message), 'Los puertos 3000/3001 (SSAP de LG) se rechazan');
}

function makeFakeAres(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'ares.log');
  function script(name, body) {
    const f = path.join(dir, name);
    fs.writeFileSync(f, '#!/bin/sh\necho "' + name + ' $*" >> "' + log + '"\n' + body + '\n');
    fs.chmodSync(f, 0o755);
  }
  script('ares-setup-device', 'if [ "$1" = "--list" ]; then\necho "salon (default) prisoner@192.168.1.50:9922     ssh         tv"\nfi');
  script('ares-install', 'echo "Success"');
  script('ares-package', 'out=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done\necho fake > "$out/' + APP + '_' + V + '_all.ipk"\necho "Create ' + APP + '_' + V + '_all.ipk to $out"\necho "Success"');
  return log;
}

async function cliTests() {
  console.log('\n[CLI]');
  const HOME = path.join(TMP, 'home-cli');
  const env = { GAME_TO_TV_HOME: HOME };

  let r = await H_.runCli(['tv', 'ipk', '--salida', path.join(TMP, 'cli-ipk')], env);
  const f = path.join(TMP, 'cli-ipk', APP + '_' + V + '_all.ipk');
  check(r.code === 0 && fs.existsSync(f) && /modo tele/.test(r.out) && /KB/.test(r.out) && readIpk(f).data.some(function (e) { return e.name.indexOf('./usr/palm/services/' + SVC + '/') === 0; }),
    'tv ipk: por defecto en modo tele (con el servicio)');

  writeConfig(HOME, { tvs: { salon: { driver: 'webos', ip: '127.0.0.1', clientKey: 'k' } } });
  r = await H_.runCli(['tv', 'install', 'salon', '--solo-ipk', '--salida', path.join(TMP, 'cli-solo')], env);
  check(r.code === 0 && /Modo tele/.test(r.out) && /dentro de la tele/.test(r.out) && fs.existsSync(path.join(TMP, 'cli-solo', APP + '_' + V + '_all.ipk')) && !readConfig(HOME).tvs.salon.mode,
    'tv install --solo-ipk: modo tele por defecto (y no cambia la configuración)');

  if (process.platform !== 'win32') {
    const bin = path.join(TMP, 'ares');
    const log = makeFakeAres(bin);
    r = await H_.runCli(['tv', 'install', 'salon', '--puerto', '8091', '--salida', path.join(TMP, 'cli-ares')], { GAME_TO_TV_HOME: HOME, PATH: bin + path.delimiter + process.env.PATH });
    const lines = fs.readFileSync(log, 'utf8').split('\n');
    const pkgLine = lines.filter(function (l) { return /^ares-package /.test(l); })[0] || '';
    check(r.code === 0 && /App instalada/.test(r.out) && /tv status salon/.test(r.out), 'tv install con ares-cli en modo tele: «App instalada» y cómo comprobarlo');
    check(/^ares-package \S+g2t-webos-app-\S+ \S+g2t-webos-svc-\S+ --no-minify -o \S+cli-ares$/.test(pkgLine), 'ares-package <app> <servicio> --no-minify -o <salida>  (' + pkgLine.replace(new RegExp(os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '…') + ')');
    const saved = readConfig(HOME).tvs.salon;
    check(saved.mode === 'tele' && saved.telePort === 8091 && saved.installedVersion === V, 'La configuración guarda el modo, el puerto de la tele y la versión instalada');
  }

  // tv status / doctor against a tele-mode server on this machine
  const srv = createServer({ mode: 'tele', port: 0, hostIp: '127.0.0.1', galleryDir: null, log: function () {}, config: { tvs: {} },
    tele: { service: SVC, info: function () { return { node: 'v12.21.0', uptime: 600, idleMinutes: 15, gallerySaving: false, galleryDir: null }; }, logs: function () { return 'línea 1\nServidor listo\n'; } } });
  await srv.listen();
  const port = srv.port();
  try {
    const cfg = readConfig(HOME);
    cfg.tvs.salon.telePort = port;
    writeConfig(HOME, cfg);
    r = await H_.runCli(['tv', 'status', 'salon', '--logs'], env);
    check(r.code === 0 && /respondiendo en http:\/\/127\.0\.0\.1:\d+\//.test(r.out) && /modo tele/.test(r.out) && new RegExp('versión ' + V.replace(/\./g, '\\.')).test(r.out) &&
      /Node v12\.21\.0/.test(r.out) && /no se guardan dibujos/.test(r.out) && /Servidor listo/.test(r.out), 'tv status salon --logs: GET :puerto/info y /logs de la tele');
    r = await H_.runCli(['tv', 'status', 'salon', '--json'], env);
    let j = null;
    try { j = JSON.parse(r.out); } catch (e) { /* noop */ }
    check(j && j.reachable && j.info.mode === 'tele' && j.info.tele.service === SVC, 'tv status --json');
    r = await H_.runCli(['doctor', '--port', '1'], env);
    check(new RegExp('Servidor dentro de «salon» respondiendo en http://127\\.0\\.0\\.1:' + port + '/ \\(modo tele, versión ' + V.replace(/\./g, '\\.') + '\\)').test(r.out), 'doctor: el servidor de dentro de la tele responde');
  } finally {
    await srv.close();
  }
  r = await H_.runCli(['tv', 'status', 'salon'], env);
  check(r.code === 1 && /no responde/.test(r.out) && /tv open salon/.test(r.out) && /Developer Mode/.test(r.out), 'tv status sin servidor: código 1 y pistas (abrir la app, modo desarrollador)');
  r = await H_.runCli(['doctor', '--port', '1'], env);
  check(/Servidor dentro de «salon»: no responde/.test(r.out) && /normal si la app no está abierta/.test(r.out), 'doctor: «no responde (normal si la app no está abierta)»');

  // tv open in tele mode: just launches the app
  const tv = await startFakeTv();
  try {
    const cfg = readConfig(HOME);
    cfg.tvs.salon.ssapUrl = tv.url;
    cfg.tvs.salon.clientKey = tv.key;
    writeConfig(HOME, cfg);
    r = await H_.runCli(['tv', 'open', 'salon'], env);
    const launch = tv.requests.filter(function (q) { return q.uri === 'ssap://system.launcher/launch'; }).pop();
    check(r.code === 0 && launch && launch.payload.id === APP && /arranca su propio servidor/.test(r.out), 'tv open en modo tele: solo abre la app');
    r = await H_.runCli(['tv', 'open', 'salon', '--navegador'], env);
    const open = tv.requests.filter(function (q) { return q.uri === 'ssap://system.launcher/open'; }).pop();
    check(r.code === 0 && open && open.payload.target === 'http://127.0.0.1:' + readConfig(HOME).tvs.salon.telePort + '/', 'tv open --navegador en modo tele: el navegador de la tele abre su propio servidor');
  } finally {
    await tv.close();
  }
}

function node12Tests() {
  console.log('\n[Compatibilidad con Node 12 (análisis estático)]');
  const r = require('child_process').spawnSync(process.execPath, [path.join(H_.ROOT, 'scripts', 'check-node12.js')], { encoding: 'utf8' });
  check(r.status === 0 && /compatible con Node 12/.test(r.stdout), 'scripts/check-node12.js sobre el servicio que se empaqueta: sin problemas');
  const dir = path.join(TMP, 'malo');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'nuevo'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'webos-service'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), "'use strict';\nconst x = a?.b;\n");
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), "'use strict';\n// fetch() en un comentario no cuenta\nfs.rmSync('x');\nfetch('http://x');\nconst u = crypto.randomUUID();\nconst l = [1].at(-1);\n");
  fs.writeFileSync(path.join(dir, 'src', 'c.js'), "'use strict';\nclass A { x = 1; }\n");
  fs.writeFileSync(path.join(dir, 'node_modules', 'nuevo', 'package.json'), JSON.stringify({ name: 'nuevo', engines: { node: '>=16' } }));
  fs.writeFileSync(path.join(dir, 'node_modules', 'webos-service', 'index.js'), '');
  fs.writeFileSync(path.join(dir, 'public.js'), '');
  const c = node12check.check(dir);
  const all = c.problems.join('\n');
  check(/a\.js: no es ES2019/.test(all) && /c\.js: no es ES2019/.test(all), 'Detecta sintaxis nueva (?. y campos de clase)');
  check(/fs\.rm/.test(all) && /fetch/.test(all) && /randomUUID/.test(all) && /\.at/.test(all) && !/línea 2: fetch/.test(all), 'Detecta APIs que Node 12 no tiene (y no los comentarios)');
  check(/nuevo pide Node >=16/.test(all) && /webos-service no debe ir/.test(all), 'Detecta dependencias que piden un Node nuevo y webos-service empaquetado');
  check(node12check.needsNewerNode('>=14.19.0') && !node12check.needsNewerNode('>=10.0.0') && !node12check.needsNewerNode('>= 12'), 'Lee los rangos de engines');
}

(async function () {
  try {
    await packageTests();
    await pcModeTests();
    await cliTests();
    node12Tests();
  } catch (e) {
    check.fail('Excepción: ' + (e && e.stack || e));
  } finally {
    H_.rmrf(TMP);
  }
  check.done();
})();
