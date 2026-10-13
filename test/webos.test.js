'use strict';
/*
 * LG webOS driver against a FAKE TV: SSAP pairing (prompt -> client-key),
 * launch, toast, buttons, luna alert trick, screenshot download, info; the
 * CLI commands end to end; SSDP parsing and discovery; .ipk contents; the
 * ares-cli command lines (with fake ares-* scripts) and FPS through CDP.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const dgram = require('dgram');
const http = require('http');
const { execFileSync } = require('child_process');
const H_ = require('./helpers');
const { startFakeTv, startFakeCdp, JPEG } = require('./helpers/fake-tv');
const { SsapClient } = require('../src/drivers/webos/ssap');
const webos = require('../src/drivers/webos');
const ssdp = require('../src/drivers/webos/ssdp');
const ipk = require('../src/drivers/webos/ipk');
const launcher = require('../src/drivers/webos/launcher');
const cdp = require('../src/drivers/webos/cdp');
const { MANIFEST } = require('../src/drivers/webos/manifest');

const check = H_.checker('Driver de LG webOS (tele falsa)');
const TMP = H_.tmpHome('g2t-webos-');

function readConfig(home) { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); }
function writeConfig(home, cfg) { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg)); }

async function ssapClientTests() {
  console.log('\n[Cliente SSAP]');
  const tv = await startFakeTv();
  try {
    const c = new SsapClient({ url: tv.url });
    await c.connect();
    let prompted = 0;
    const r1 = await c.register({ onPrompt: function () { prompted++; } });
    check(prompted === 1 && r1.clientKey === tv.key && r1.prompted, 'Sin clave: la tele pide permiso (PROMPT) y devuelve la client-key');
    const reg = tv.registers[0].payload;
    check(reg.pairingType === 'PROMPT' && reg.manifest.permissions.length === MANIFEST.permissions.length && reg.manifest.permissions.indexOf('CONTROL_TV_SCREEN') >= 0 && !reg['client-key'],
      'Registro con manifiesto y ' + reg.manifest.permissions.length + ' permisos');
    c.close();

    const c2 = new SsapClient({ url: tv.url });
    await c2.connect();
    let prompted2 = 0;
    const r2 = await c2.register({ clientKey: tv.key, onPrompt: function () { prompted2++; } });
    check(prompted2 === 0 && r2.clientKey === tv.key && tv.registers[1].payload['client-key'] === tv.key, 'Con la clave guardada: sin aviso en la tele');
    const toast = await c2.request('ssap://system.notifications/createToast', { message: 'Hola' });
    check(toast.toastId === 't1' && tv.requests.some(function (q) { return q.uri.indexOf('createToast') > 0 && q.payload.message === 'Hola'; }), 'createToast');
    let err401 = null;
    try { await c2.request('ssap://com.webos.service.update/getCurrentSWInformation'); } catch (e) { err401 = e; }
    check(err401 && err401.code === 'E401', 'Un 401 de la tele llega como error con código E401');
    let errFalse = null;
    try { await c2.request('ssap://system.launcher/launch', { id: 'no.existe' }); } catch (e) { errFalse = e; }
    check(errFalse && /app not found/.test(errFalse.message), 'returnValue:false se convierte en error («app not found»)');
    await c2.button('down');
    await H_.waitUntil(function () { return tv.buttons.length; }, 1000, 'botón');
    check(tv.buttons[0] === 'type:button\nname:DOWN\n\n', 'Botón del mando por el socket de puntero: «type:button\\nname:DOWN»');
    await c2.luna('luna://com.webos.settingsservice/setSystemSettings', { category: 'sound', settings: { soundMode: 'aiSoundPlus' } });
    const alert = tv.requests.filter(function (q) { return q.uri === 'ssap://system.notifications/createAlert'; })[0];
    const closed = tv.requests.filter(function (q) { return q.uri === 'ssap://system.notifications/closeAlert'; })[0];
    check(alert && alert.payload.buttons[0].onClick === 'luna://com.webos.settingsservice/setSystemSettings' && alert.payload.buttons[0].params.category === 'sound' &&
      closed && closed.payload.alertId === 'alerta-1', 'Llamada luna:// con el truco de la alerta (createAlert + closeAlert)');
    const shot = path.join(TMP, 'captura.jpg');
    const s = await c2.screenshot(shot);
    check(fs.readFileSync(shot).equals(JPEG) && /resources\/shot\.jpg$/.test(s.imageUri), 'Captura: executeOneShot + descarga del JPG');
    const one = tv.requests.filter(function (q) { return q.uri === 'ssap://tv/executeOneShot'; })[0];
    check(one && one.payload.method === 'DISPLAY' && one.payload.format === 'JPG' && one.payload.path === '/tmp/capture.jpg', 'executeOneShot {path:/tmp/capture.jpg, method:DISPLAY, format:JPG}');
    c2.close();

    const bad = new SsapClient({ url: tv.url });
    await bad.connect();
    let prompted3 = 0;
    const r3 = await bad.register({ clientKey: 'clave-vieja', onPrompt: function () { prompted3++; } });
    check(prompted3 === 1 && r3.clientKey === tv.key, 'Con una clave caducada vuelve a pedir permiso y da una clave nueva');
    bad.close();

    tv.denyPairing = true;
    const den = new SsapClient({ url: tv.url });
    await den.connect();
    let denied = null;
    try { await den.register({}); } catch (e) { denied = e; }
    check(denied && denied.code === 'EDENIED' && /rechazado/.test(denied.message), 'Si se rechaza en la tele: error claro en español');
    den.close();

    let noConn = null;
    try { await new SsapClient({ url: 'ws://127.0.0.1:1' }).connect(); } catch (e) { noConn = e; }
    check(noConn && /No se puede conectar con la tele/.test(noConn.message), 'Tele apagada: «No se puede conectar con la tele…»');
  } finally {
    await tv.close();
  }
}

async function tlsTests() {
  console.log('\n[wss:// y https:// con certificado autofirmado]');
  let tls = null;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(TMP, 'k.pem'), '-out', path.join(TMP, 'c.pem'), '-days', '1', '-subj', '/CN=tele-de-prueba'], { stdio: 'ignore' });
    tls = { key: fs.readFileSync(path.join(TMP, 'k.pem')), cert: fs.readFileSync(path.join(TMP, 'c.pem')) };
  } catch (e) {
    console.log('  (openssl no disponible: se omite)');
    return;
  }
  const tv = await startFakeTv({ tls: tls });
  try {
    const c = new SsapClient({ url: tv.url });
    await c.connect();
    await c.register({ clientKey: tv.key });
    const out = path.join(TMP, 'captura-tls.jpg');
    const s = await c.screenshot(out);
    check(/^https:/.test(s.imageUri) && fs.readFileSync(out).equals(JPEG), 'wss:// y descarga https:// aceptan el certificado autofirmado de la tele');
    c.close();
  } finally {
    await tv.close();
  }
}

async function driverAndCliTests() {
  console.log('\n[Driver y CLI]');
  const tv = await startFakeTv();
  const HOME = path.join(TMP, 'home-cli');
  const env = { GAME_TO_TV_HOME: HOME };
  try {
    let r = await H_.runCli(['tv', 'add', 'salon', '127.0.0.1'], env);
    check(r.code === 0 && /guardada/.test(r.out) && /tv pair salon/.test(r.out), 'tv add salon 127.0.0.1 (webos por defecto) y siguientes pasos');
    const cfg = readConfig(HOME);
    cfg.tvs.salon.ssapUrl = tv.url; // tests only: talk to the fake TV
    writeConfig(HOME, cfg);
    if (process.platform !== 'win32') check((fs.statSync(path.join(HOME, 'config.json')).mode & 0o777) <= 0o644, 'config.json no es público para escritura');

    r = await H_.runCli(['tv', 'toast', 'salon', 'hola'], env);
    check(r.code === 1 && /no está emparejada/.test(r.out) && /tv pair salon/.test(r.out), 'Sin emparejar: el CLI explica que hay que hacer «tv pair»');

    r = await H_.runCli(['tv', 'pair', 'salon'], env);
    check(r.code === 0 && /MIRA LA TELE/.test(r.out) && /Emparejada/.test(r.out), 'tv pair: aviso grande en español y «¡Emparejada!»');
    const saved = readConfig(HOME).tvs.salon;
    check(saved.clientKey === tv.key && !!saved.pairedAt, 'La client-key queda guardada en ~/.game-to-tv/config.json');
    check(tv.requests.some(function (q) { return q.uri.indexOf('createToast') > 0; }), 'Tras emparejar se muestra un aviso en la tele');
    if (process.platform !== 'win32') check((fs.statSync(path.join(HOME, 'config.json')).mode & 0o777) === 0o600, 'config.json con permisos 0600 (tiene la clave)');

    const before = tv.registers.length;
    r = await H_.runCli(['tv', 'toast', 'salon', 'Hola', 'desde', 'el', 'PC'], env);
    check(r.code === 0 && tv.requests.some(function (q) { return q.payload && q.payload.message === 'Hola desde el PC'; }), 'tv toast salon "Hola desde el PC"');
    check(tv.registers[before].payload['client-key'] === tv.key, 'Las órdenes usan la clave guardada (sin volver a preguntar)');

    r = await H_.runCli(['tv', 'open', 'salon', '--ruta', '/ambiente'], env);
    const launch = tv.requests.filter(function (q) { return q.uri === 'ssap://system.launcher/launch'; }).pop();
    check(r.code === 0 && launch && launch.payload.id === 'io.gametotv.launcher' && launch.payload.params.path === '/ambiente', 'tv open salon --ruta /ambiente lanza la app con {path}');
    r = await H_.runCli(['tv', 'open', 'salon', '--navegador', '--server-url', 'http://192.168.1.50:3000'], env);
    const open = tv.requests.filter(function (q) { return q.uri === 'ssap://system.launcher/open'; }).pop();
    check(r.code === 0 && open && open.payload.target === 'http://192.168.1.50:3000/', 'tv open --navegador abre la URL en el navegador de la tele');

    const shotFile = path.join(TMP, 'tv-shot.jpg');
    r = await H_.runCli(['tv', 'shot', 'salon', shotFile], env);
    check(r.code === 0 && fs.existsSync(shotFile) && /Captura guardada/.test(r.out), 'tv shot salon archivo.jpg');

    r = await H_.runCli(['tv', 'key', 'salon', 'enter'], env);
    check(r.code === 0 && tv.buttons.indexOf('type:button\nname:ENTER\n\n') >= 0, 'tv key salon enter');

    r = await H_.runCli(['tv', 'info', 'salon'], env);
    let info = null;
    try { info = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch (e) { /* noop */ }
    check(info && info.system.modelName === '43UQ80006LB' && /401/.test(info.software.error) && info.volume.volume === 12, 'tv info: modelo, volumen y el 401 de la versión sin romper');

    r = await H_.runCli(['tv', 'luna', 'salon', 'luna://com.webos.service.tvpower/power/turnOnScreen', '{}'], env);
    check(r.code === 0 && /Llamada enviada/.test(r.out), 'tv luna (avanzado)');

    // Wrong app id
    const cfg2 = readConfig(HOME);
    cfg2.tvs.salon.appId = 'no.instalada';
    writeConfig(HOME, cfg2);
    r = await H_.runCli(['tv', 'open', 'salon'], env);
    check(r.code === 1 && /tv install salon/.test(r.out), 'Si la app no está instalada, tv open explica cómo instalarla');

    // The driver directly, with a stale key: updates the key through onKey
    const tvEntry = { name: 'x', ip: '127.0.0.1', ssapUrl: tv.url, clientKey: 'vieja' };
    let newKey = null;
    tv.denyPairing = false;
    await webos.toast(tvEntry, 'hola', { onKey: function (k) { newKey = k; } });
    check(newKey === tv.key, 'Si la tele da una clave nueva, el driver la devuelve para guardarla');
  } finally {
    await tv.close();
  }
}

async function ssdpTests() {
  console.log('\n[SSDP]');
  const sample = [
    'HTTP/1.1 200 OK',
    'CACHE-CONTROL: max-age=1800',
    'DATE: Tue, 13 Oct 2026 18:00:00 GMT',
    'EXT:',
    'LOCATION: http://192.168.1.50:1912/',
    'SERVER: WebOS/4.1.0 UPnP/1.0',
    'ST: urn:lge-com:service:webos-second-screen:1',
    'USN: uuid:00000000-0000-0000-0000-000000000000::urn:lge-com:service:webos-second-screen:1',
    'DLNADeviceName.lge.com: %5BLG%5D%20webOS%20TV%20UQ80',
    '', ''
  ].join('\r\n');
  const p = ssdp.parseResponse(sample, { address: '192.168.1.99' });
  check(p && p.ip === '192.168.1.50' && p.name === '[LG] webOS TV UQ80' && p.isWebOS && p.location === 'http://192.168.1.50:1912/', 'Respuesta SSDP: IP de LOCATION y nombre de DLNADeviceName (descodificado)');
  check(ssdp.parseResponse('HTTP/1.1 404 Not Found\r\n\r\n') === null && ssdp.parseResponse('basura') === null, 'Respuestas no válidas se ignoran');
  const search = ssdp.buildSearch();
  check(/^M-SEARCH \* HTTP\/1\.1\r\n/.test(search) && /HOST: 239\.255\.255\.250:1900/.test(search) && /ST: urn:lge-com:service:webos-second-screen:1/.test(search) && /MAN: "ssdp:discover"/.test(search), 'M-SEARCH correcto (239.255.255.250:1900, ST de webOS)');

  // Unicast discovery against a fake responder + description XML
  const desc = http.createServer(function (req, res) {
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end('<?xml version="1.0"?><root><device><friendlyName>Tele del salón</friendlyName><manufacturer>LG Electronics</manufacturer><modelName>43UQ80006LB</modelName></device></root>');
  });
  await new Promise(function (r) { desc.listen(0, '127.0.0.1', r); });
  const udp = dgram.createSocket('udp4');
  let gotSearch = '';
  udp.on('message', function (msg, rinfo) {
    gotSearch = msg.toString();
    const answer = sample.replace('http://192.168.1.50:1912/', 'http://127.0.0.1:' + desc.address().port + '/').replace(/DLNADeviceName[^\r]*\r\n/, '');
    udp.send(Buffer.from(answer), rinfo.port, rinfo.address);
  });
  await new Promise(function (r) { udp.bind(0, '127.0.0.1', r); });
  const found = await webos.discover({ timeout: 800, address: '127.0.0.1', port: udp.address().port });
  check(/M-SEARCH/.test(gotSearch), 'discover() envía M-SEARCH');
  check(found.length === 1 && found[0].ip === '127.0.0.1' && found[0].name === 'Tele del salón' && found[0].model === '43UQ80006LB' && found[0].driver === 'webos', 'discover() encuentra la tele, con nombre y modelo de la descripción UPnP');
  udp.close();
  desc.close();
}

async function ipkTests() {
  console.log('\n[App lanzadora e .ipk]');
  const app = launcher.buildApp({ serverUrl: '192.168.1.50:3000', version: '0.1.0' });
  const info = JSON.parse(fs.readFileSync(path.join(app.dir, 'appinfo.json'), 'utf8'));
  check(app.serverUrl === 'http://192.168.1.50:3000', 'La URL del servidor se normaliza (http://IP:puerto)');
  check(info.id === 'io.gametotv.launcher' && info.type === 'web' && info.main === 'index.html' && info.resolution === '1920x1080' &&
    info.disallowScrollingInMainFrame === true && info.disableBackHistoryAPI === true && Array.isArray(info.requiredACG) && info.bgColor && info.vendor && info.title,
  'appinfo.json con id, type web, main, resolution 1920x1080, disableBackHistoryAPI, requiredACG');
  check(info.icon === 'icon-0.1.0.png' && info.largeIcon === 'largeIcon-0.1.0.png' && fs.existsSync(path.join(app.dir, 'icon-0.1.0.png')),
    'Los iconos llevan la versión en el nombre (la tele cachea el icono)');
  const html = fs.readFileSync(path.join(app.dir, 'index.html'), 'utf8');
  check(html.indexOf("var SERVER = 'http://192.168.1.50:3000';") >= 0 && html.indexOf('@@SERVER_URL@@') < 0, 'index.html lleva la URL del servidor');
  check(/qr\.svg/.test(html) && /location\.replace\(SERVER/.test(html) && /No encuentro el servidor/.test(html), 'El lanzador sondea /qr.svg, avisa «No encuentro el servidor…» y navega al servidor');
  let threw = null;
  try { launcher.normalizeServerUrl('http://'); } catch (e) { threw = e; }
  check(threw && /no válida/.test(threw.message), 'Una URL del servidor inválida da un error claro');
  check(launcher.appVersion('1.2.3-beta.4') === '1.2.3' && launcher.appVersion('x') === '1.0.0', 'Versión de la app en formato x.y.z');

  const built = ipk.buildIpk(app.dir);
  check(built.fileName === 'io.gametotv.launcher_0.1.0_all.ipk', 'Nombre del paquete: <id>_<versión>_all.ipk');
  const members = ipk.parseAr(built.buffer);
  check(members.map(function (m) { return m.name; }).join(',') === 'debian-binary,control.tar.gz,data.tar.gz', 'Archivo ar con debian-binary, control.tar.gz y data.tar.gz (en ese orden)');
  check(members[0].data.toString() === '2.0\n', 'debian-binary = «2.0»');
  const control = ipk.parseTar(zlib.gunzipSync(members[1].data));
  const controlText = control.filter(function (e) { return e.name === './control'; })[0].data.toString();
  check(/^Package: io\.gametotv\.launcher$/m.test(controlText) && /^Version: 0\.1\.0$/m.test(controlText) && /^Architecture: all$/m.test(controlText) && /^Installed-Size: \d+$/m.test(controlText),
    'control: Package, Version, Architecture: all, Installed-Size');
  const data = ipk.parseTar(zlib.gunzipSync(members[2].data));
  const names = data.map(function (e) { return e.name; });
  const root = './usr/palm/applications/io.gametotv.launcher/';
  check(['appinfo.json', 'index.html', 'icon-0.1.0.png', 'largeIcon-0.1.0.png'].every(function (f) { return names.indexOf(root + f) >= 0; }), 'data.tar.gz: la app en ' + root);
  const pinfo = JSON.parse(data.filter(function (e) { return e.name === './usr/palm/packages/io.gametotv.launcher/packageinfo.json'; })[0].data.toString());
  check(pinfo.app === 'io.gametotv.launcher' && pinfo.version === '0.1.0' && pinfo.package_format_version === 2, 'packageinfo.json correcto');
  check(data.concat(control).every(function (e) { return e.checksumOk; }), 'Cabeceras tar con checksum válido');
  const inPkgHtml = data.filter(function (e) { return e.name === root + 'index.html'; })[0].data.toString();
  check(inPkgHtml.indexOf('http://192.168.1.50:3000') >= 0, 'El index.html empaquetado lleva la URL');
  // Cross-check with the system tools when they exist
  const ipkFile = path.join(TMP, built.fileName);
  fs.writeFileSync(ipkFile, built.buffer);
  try {
    const list = execFileSync('ar', ['t', ipkFile]).toString().trim().split('\n');
    const work = fs.mkdtempSync(path.join(TMP, 'ar-'));
    execFileSync('ar', ['x', ipkFile], { cwd: work });
    const tarList = execFileSync('tar', ['tzf', path.join(work, 'data.tar.gz')]).toString();
    check(list.join(',') === 'debian-binary,control.tar.gz,data.tar.gz' && tarList.indexOf(root + 'appinfo.json') >= 0, 'Las herramientas del sistema (ar, tar) leen el .ipk');
  } catch (e) {
    console.log('  (ar/tar no disponibles: se omite la comprobación cruzada)');
  }
  // CLI: tv ipk
  const out = path.join(TMP, 'ipk-out');
  const r = await H_.runCli(['tv', 'ipk', '--server-url', 'http://192.168.1.50:3000', '--salida', out], { GAME_TO_TV_HOME: path.join(TMP, 'home-ipk') });
  check(r.code === 0 && fs.existsSync(path.join(out, 'io.gametotv.launcher_0.1.0_all.ipk')), 'game-to-tv tv ipk --server-url … --salida … crea el .ipk sin tele ni ares-cli');
}

// Fake ares-* commands that log their arguments
function makeFakeAres(dir, opts) {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'ares.log');
  function script(name, body) {
    const f = path.join(dir, name);
    fs.writeFileSync(f, '#!/bin/sh\necho "' + name + ' $*" >> "' + log + '"\n' + body + '\n');
    fs.chmodSync(f, 0o755);
  }
  script('ares-setup-device', 'if [ "$1" = "--list" ]; then\necho "name         deviceinfo                     connection  profile"\necho "------------ ------------------------------ ----------  -------"\necho "emulator     developer@127.0.0.1:6622       ssh         tv"\n' +
    (opts.device ? 'echo "' + opts.device + ' (default) prisoner@192.168.1.50:9922     ssh         tv"\n' : '') + 'fi');
  script('ares-install', 'echo "Installing package $3"\necho "Success"');
  script('ares-package', 'out=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done\necho fake > "$out/io.gametotv.launcher_0.1.0_all.ipk"\necho "Create io.gametotv.launcher_0.1.0_all.ipk to $out"\necho "Success"');
  script('ares-inspect', 'echo "Application Debugging - http://127.0.0.1:' + (opts.cdpPort || 9) + '"\nsleep 30');
  return log;
}

async function aresTests() {
  console.log('\n[ares-cli (comandos falsos) y FPS por CDP]');
  if (process.platform === 'win32') { console.log('  (se omite en Windows)'); return; }
  const cdpServer = await startFakeCdp({ frames: 240, ms: 4001, fps: 60, worstMs: 18, width: 1920, height: 1080, dpr: 2, screen: 'pong', canvas: '1280x720', url: 'http://192.168.1.50:3000/' });
  const HOME = path.join(TMP, 'home-ares');
  writeConfig(HOME, { tvs: { salon: { driver: 'webos', ip: '192.168.1.50', clientKey: 'k' } } });
  try {
    // ares not configured for this TV
    const binNoDev = path.join(TMP, 'ares-nodev');
    makeFakeAres(binNoDev, {});
    const PATH0 = binNoDev + path.delimiter + process.env.PATH;
    let r = await H_.runCli(['tv', 'install', 'salon', '--server-url', 'http://192.168.1.50:3000'], { GAME_TO_TV_HOME: HOME, PATH: PATH0 });
    check(r.code === 1 && /ares-cli no conoce la tele «salon»/.test(r.out) && /ares-setup-device -a salon -i "host=192.168.1.50" -i "port=9922" -i "username=prisoner"/.test(r.out) &&
      /ares-novacom --device salon --getkey/.test(r.out) && /privatekey=salon_webos/.test(r.out), 'Tele sin configurar en ares-cli: pasos exactos (setup-device, novacom --getkey, privatekey)');

    // ares configured: package + install
    const bin = path.join(TMP, 'ares-ok');
    const log = makeFakeAres(bin, { device: 'salon', cdpPort: cdpServer.port });
    const PATH1 = bin + path.delimiter + process.env.PATH;
    r = await H_.runCli(['tv', 'install', 'salon', '--server-url', 'http://192.168.1.50:3000', '--salida', path.join(TMP, 'ipk-ares')], { GAME_TO_TV_HOME: HOME, PATH: PATH1 });
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    const pkgLine = lines.filter(function (l) { return /^ares-package /.test(l); })[0] || '';
    const instLine = lines.filter(function (l) { return /^ares-install /.test(l); })[0] || '';
    check(r.code === 0 && /App instalada/.test(r.out), 'tv install con ares-cli: «App instalada»');
    check(/^ares-package \S+g2t-webos-app-\S+ -o \S+ipk-ares$/.test(pkgLine), 'ares-package <carpeta de la app> -o <salida>  (' + pkgLine.replace(TMP, '…') + ')');
    check(/^ares-install --device salon \S+io\.gametotv\.launcher_0\.1\.0_all\.ipk$/.test(instLine), 'ares-install --device salon <paquete>.ipk');

    r = await H_.runCli(['tv', 'install', 'salon', '--solo-ipk', '--server-url', 'http://192.168.1.50:3000', '--salida', path.join(TMP, 'ipk-solo')], { GAME_TO_TV_HOME: HOME, PATH: PATH1 });
    check(r.code === 0 && /Paquete creado/.test(r.out) && fs.existsSync(path.join(TMP, 'ipk-solo', 'io.gametotv.launcher_0.1.0_all.ipk')), 'tv install --solo-ipk solo crea el paquete (en JavaScript)');

    // perf: ares-inspect -> DevTools URL -> CDP Runtime.evaluate
    r = await H_.runCli(['tv', 'perf', 'salon', '--segundos', '1'], { GAME_TO_TV_HOME: HOME, PATH: PATH1 });
    const inspLine = fs.readFileSync(log, 'utf8').split('\n').filter(function (l) { return /^ares-inspect /.test(l); })[0] || '';
    check(/^ares-inspect --device salon --app io\.gametotv\.launcher$/.test(inspLine), 'tv perf ejecuta ares-inspect --device salon --app io.gametotv.launcher');
    check(r.code === 0 && /60 FPS/.test(r.out) && /canvas 1280x720/.test(r.out), 'tv perf muestra los FPS medidos en la tele (' + (r.out.match(/\d+ FPS[^\n]*/) || [''])[0].trim() + ')');
    const ev = cdpServer.evaluated[0];
    check(ev && ev.method === 'Runtime.evaluate' && ev.params.awaitPromise === true && /requestAnimationFrame/.test(ev.params.expression) && /1000/.test(ev.params.expression) && cdpServer.lastPath === '/devtools/page/1',
      'CDP: Runtime.evaluate con requestAnimationFrame durante N s, en la página (no en el service worker)');
  } finally {
    await cdpServer.close();
  }
  check(cdp.parseInspectOutput('Application Debugging - http://localhost:9998').base === 'http://localhost:9998', 'Lee la URL de DevTools de ares-inspect');
  const withWs = cdp.parseInspectOutput('http://localhost:9998/devtools/inspector.html?ws=localhost:9998/devtools/page/3');
  check(withWs.ws === 'ws://localhost:9998/devtools/page/3', 'También entiende ?ws=… en la URL del inspector');
}

(async function () {
  try {
    await ssapClientTests();
    await tlsTests();
    await driverAndCliTests();
    await ssdpTests();
    await ipkTests();
    await aresTests();
  } catch (e) {
    check.fail('Excepción: ' + (e && e.stack || e));
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  check.done();
})();
