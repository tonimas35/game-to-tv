'use strict';
/*
 * Android TV / Google TV / Fire TV driver, through adb over the network.
 *
 * The app «Juegos del Salón» (apps/android-tv/, package io.gametotv.android)
 * carries the game server inside (nodejs-mobile): like LG's «modo tele», the
 * PC is only needed to install it.
 *
 *   pair        adb connect IP:5555 and wait until the TV authorizes this PC
 *   install     adb install -r <APK for the TV's ABI> (--apk FILE|FOLDER|ZIP,
 *               or the newest build from GitHub Actions)
 *   launch      adb shell am start -n io.gametotv.android/.MainActivity [--es path /ambiente]
 *   status      GET http://<tv>:8090/info (the server inside the TV)
 *   info        getprop, app version, memory, screen size
 *   control     adb shell input keyevent (UP, DOWN, ENTER, BACK, HOME…)
 *   screenshot  adb exec-out screencap -p (PNG)
 *   perf        FPS through the WebView's DevTools (adb forward … webview_devtools_remote_<pid>)
 *
 * tv: { name, driver: 'android', ip, adbPort (5555), adbSerial (optional, e.g. a USB serial) }
 */
const fs = require('fs');
const path = require('path');
const adb = require('./adb');
const artifact = require('./artifact');
const cdp = require('../webos/cdp');
const { getJson } = require('../webos');
const config = require('../../config');
const { DriverError } = require('../errors');

const APP_ID = artifact.APP_ID;
const ACTIVITY = APP_ID + '/.MainActivity';
const TELE_PORT = 8090;

const KEYS = {
  UP: 'KEYCODE_DPAD_UP', DOWN: 'KEYCODE_DPAD_DOWN', LEFT: 'KEYCODE_DPAD_LEFT', RIGHT: 'KEYCODE_DPAD_RIGHT',
  ENTER: 'KEYCODE_DPAD_CENTER', OK: 'KEYCODE_DPAD_CENTER', BACK: 'KEYCODE_BACK', HOME: 'KEYCODE_HOME', MENU: 'KEYCODE_MENU',
  PLAY: 'KEYCODE_MEDIA_PLAY_PAUSE', PAUSE: 'KEYCODE_MEDIA_PLAY_PAUSE', STOP: 'KEYCODE_MEDIA_STOP',
  VOLUMEUP: 'KEYCODE_VOLUME_UP', VOLUMEDOWN: 'KEYCODE_VOLUME_DOWN', MUTE: 'KEYCODE_VOLUME_MUTE',
  POWER: 'KEYCODE_POWER', WAKEUP: 'KEYCODE_WAKEUP', SLEEP: 'KEYCODE_SLEEP', ESC: 'KEYCODE_ESCAPE'
};

function serialOf(tv) { return tv.adbSerial || (tv.ip + ':' + (Number(tv.adbPort) || 5555)); }

function authHelp(tv) {
  return [
    'La tele «' + tv.name + '» no ha autorizado todavía a este PC.',
    'Mira la tele: debe salir «¿Permitir la depuración USB?» (o «depuración por red»).',
    'Marca «Permitir siempre desde este ordenador» y pulsa Aceptar; luego repite la orden.',
    'Si no sale el aviso: Ajustes → Opciones para desarrolladores → «Revocar autorizaciones de',
    'depuración USB», y vuelve a probar (más ayuda en docs/tele-android.md).'
  ].join('\n');
}

function connectHelp(tv, text) {
  return [
    'No puedo conectar con «' + tv.name + '» por adb (' + serialOf(tv) + ')' + (text ? ': ' + text : '') + '.',
    '· ¿Está la tele encendida y en la misma red que el PC?',
    '· ¿Tiene activada la depuración (USB y, en Fire TV, «Depuración ADB»/«por red»)? Ver docs/tele-android.md.',
    '· Algunas teles Android solo aceptan adb por red tras activarlo con un cable: adb tcpip 5555.'
  ].join('\n');
}

/** adb connect + check the TV is authorized. Returns the serial. opts: { onPrompt, waitAuthMs } */
async function ensureDevice(tv, opts) {
  opts = opts || {};
  const serial = serialOf(tv);
  const isNet = /:\d+$/.test(serial);
  let st = await adb.state(serial);
  if (st !== 'device' && isNet) {
    const c = await adb.connect(serial);
    if (!c.ok && !c.already && !c.unauthorized) throw new DriverError(connectHelp(tv, c.text), 'EADBCONNECT');
    st = await adb.state(serial);
  }
  if (st === 'unauthorized' && opts.waitAuthMs) {
    if (opts.onPrompt) opts.onPrompt();
    const t0 = Date.now();
    while (st === 'unauthorized' && Date.now() - t0 < opts.waitAuthMs) {
      await new Promise(function (r) { setTimeout(r, 1000); });
      st = await adb.state(serial);
    }
  }
  if (st === 'unauthorized') throw new DriverError(authHelp(tv), 'EADBAUTH');
  if (st !== 'device') throw new DriverError(connectHelp(tv, 'estado «' + st + '»'), 'EADBSTATE');
  return serial;
}

async function abiList(serial) {
  const r = await adb.shell(serial, ['getprop', 'ro.product.cpu.abilist']);
  let list = String(r.stdout || '').trim().split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!list.length) {
    const r2 = await adb.shell(serial, ['getprop', 'ro.product.cpu.abi']);
    list = [String(r2.stdout || '').trim()].filter(Boolean);
  }
  return list;
}

/** --apk can be an .apk, a folder with APKs or the artifact .zip */
function apksFrom(p, workDir) {
  const abs = path.resolve(p);
  let st;
  try { st = fs.statSync(abs); } catch (e) { throw new DriverError('No existe «' + p + '».', 'EARGS'); }
  if (st.isDirectory()) return artifact.findApks(abs);
  if (/\.zip$/i.test(abs)) {
    const dir = path.join(workDir, 'zip-' + path.basename(abs, '.zip') + '-' + st.size);
    fs.mkdirSync(dir, { recursive: true });
    artifact.unzip(abs, dir);
    return artifact.findApks(dir);
  }
  if (/\.apk$/i.test(abs)) return [abs];
  throw new DriverError('--apk debe ser un .apk, una carpeta con APKs o el .zip del artefacto «' + artifact.ARTIFACT + '».', 'EARGS');
}

function installError(tv, text) {
  const t = String(text || '').trim();
  let hint = '';
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(t)) {
    hint = 'La app instalada está firmada con otra clave. Desinstálala primero (se pierden los dibujos guardados en la tele):\n' +
      '  adb -s ' + serialOf(tv) + ' uninstall ' + APP_ID;
  } else if (/INSUFFICIENT_STORAGE/i.test(t)) {
    hint = 'No hay sitio en la tele: borra apps o datos que no uses y vuelve a probar.';
  } else if (/NO_MATCHING_ABIS|CPU_ABI_INCOMPATIBLE/i.test(t)) {
    hint = 'Ese APK no es para el procesador de esta tele: usa el «universal» o el de su ABI (game-to-tv tv info ' + tv.name + ').';
  } else if (/VERSION_DOWNGRADE/i.test(t)) {
    hint = 'La tele tiene una versión más nueva. Para volver atrás: adb -s ' + serialOf(tv) + ' install -r -d APK';
  } else if (/INSTALL_FAILED_USER_RESTRICTED|INSTALL_FAILED_VERIFICATION_FAILURE/i.test(t)) {
    hint = 'La tele ha bloqueado la instalación: acepta el aviso en pantalla o activa «Instalar apps desconocidas» / «Apps de origen desconocido».';
  }
  return new DriverError('adb install ha fallado:\n' + t + (hint ? '\n\n' + hint : ''), 'EADBINSTALL');
}

const driver = {
  id: 'android',
  name: 'Android TV / Google TV / Fire TV',
  description: 'Teles y aparatos con Android TV, Google TV o Fire TV: app con el servidor dentro, instalada con adb.',
  capabilities: { discover: false, pair: true, install: true, launch: true, control: true, screenshot: true, perf: true },
  APP_ID: APP_ID,
  TELE_PORT: TELE_PORT,
  serialOf: serialOf,

  async pair(tv, opts) {
    opts = opts || {};
    const serial = await ensureDevice(tv, {
      waitAuthMs: opts.promptTimeout || 60000,
      onPrompt: function () { if (opts.onPrompt) opts.onPrompt(); }
    });
    return { clientKey: null, adb: serial, message: 'Este PC ya puede controlar la tele por adb (la clave la guarda el propio adb en ~/.android/adbkey).' };
  },

  /** opts: { apk, log, workDir, token } */
  async install(tv, opts) {
    opts = opts || {};
    const log = opts.log || function () {};
    if (!adb.find()) throw new DriverError(adb.installHelp(), 'ENOADB');
    const workDir = opts.workDir || path.join(config.homeDir(), 'apk');
    fs.mkdirSync(workDir, { recursive: true });
    let apks, source;
    if (opts.apk) {
      apks = apksFrom(opts.apk, workDir);
      source = path.resolve(opts.apk);
    } else {
      let dl;
      try {
        dl = await artifact.downloadLatest({ destRoot: workDir, log: log, token: opts.token, tvName: tv.name });
      } catch (e) {
        if (e instanceof DriverError) throw e;
        throw new DriverError(e.message + (e.code === 'ENOTOKEN' ? '' : '\n\n' + artifact.manualSteps(tv.name)), e.code || 'EGITHUB');
      }
      apks = dl.apks;
      source = 'GitHub Actions, artefacto ' + dl.artifact.id + ' (' + String(dl.artifact.created_at).slice(0, 10) + ', rama ' + dl.artifact.branch + ')';
    }
    if (!apks.length) throw new DriverError('No hay ningún .apk en ' + source + '.', 'ENOAPK');
    const serial = await ensureDevice(tv);
    const abis = await abiList(serial);
    const pick = artifact.pickApk(apks, abis);
    log('Tele: ' + (abis.join(', ') || 'ABI desconocida') + ' → ' + path.basename(pick.apk) + '  (' + Math.round(fs.statSync(pick.apk).size / 1048576) + ' MB)');
    log('Instalando con adb install -r (puede tardar un minuto)…');
    const r = await adb.run(['-s', serial, 'install', '-r', pick.apk], { timeout: 10 * 60000 });
    if (r.code !== 0 || !/Success/.test(r.out)) throw installError(tv, r.out);
    return { installed: true, apk: pick.apk, abi: pick.abi, abis: abis, source: source, appinfo: { id: APP_ID, version: artifact.versionOf(pick.apk) } };
  },

  /** opts: { path ('/ambiente') } */
  async launch(tv, opts) {
    opts = opts || {};
    const serial = await ensureDevice(tv);
    await adb.shell(serial, ['input', 'keyevent', 'KEYCODE_WAKEUP']).catch(function () {});
    const args = ['am', 'start', '-n', ACTIVITY];
    if (opts.path) args.push('--es', 'path', opts.path);
    const r = await adb.shell(serial, args);
    if (r.code !== 0 || /Error|does not exist|not found/i.test(r.out)) {
      throw new DriverError('No se pudo abrir la app (' + r.out.trim() + ').\n¿Está instalada? game-to-tv tv install ' + tv.name, 'ELAUNCH');
    }
    return { opened: APP_ID, mode: 'tele' };
  },

  /** The server inside the TV: GET http://<tv>:8090/info. opts: { port, timeout, logs } */
  async status(tv, opts) {
    opts = opts || {};
    const port = Number(opts.port) || TELE_PORT;
    try {
      const info = await getJson(tv.ip, port, '/info', opts.timeout || 3000);
      const r = { reachable: true, url: 'http://' + tv.ip + ':' + port + '/', info: info };
      if (opts.logs) { try { r.logs = String(await getJson(tv.ip, port, '/logs', opts.timeout || 3000)); } catch (e) { r.logs = '(no se pudieron leer: ' + e.message + ')'; } }
      return r;
    } catch (e) {
      return { reachable: false, url: 'http://' + tv.ip + ':' + port + '/', error: e.code || e.message };
    }
  },

  async sendKey(tv, button) {
    const serial = await ensureDevice(tv);
    const b = String(button).toUpperCase();
    const code = KEYS[b] || (/^KEYCODE_[A-Z0-9_]+$/.test(b) ? b : 'KEYCODE_' + b);
    const r = await adb.shell(serial, ['input', 'keyevent', code]);
    if (r.code !== 0) throw new DriverError('adb input keyevent ' + code + ' ha fallado: ' + r.out.trim(), 'EADB');
    return { key: code };
  },

  async screenshot(tv, outFile) {
    const serial = await ensureDevice(tv);
    const r = await adb.run(['-s', serial, 'exec-out', 'screencap', '-p'], { binary: true, timeout: 30000 });
    const png = r.stdout;
    if (r.code !== 0 || !png || png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) {
      throw new DriverError('La tele no ha devuelto la captura (' + (r.stderr || 'sin datos').trim() + ').', 'EADBSHOT');
    }
    // screencap gives PNG: keep the name the user chose, with the right extension
    const file = /\.png$/i.test(outFile) ? outFile : outFile.replace(/\.(jpe?g|[a-z0-9]+)$/i, '') + '.png';
    fs.writeFileSync(file, png);
    return { file: file };
  },

  async info(tv) {
    const serial = await ensureDevice(tv);
    const props = adb.parseGetprop((await adb.shell(serial, ['getprop'])).stdout);
    const pkg = (await adb.shell(serial, ['dumpsys', 'package', APP_ID])).stdout || '';
    const mem = (await adb.shell(serial, ['cat', '/proc/meminfo'])).stdout || '';
    const size = ((await adb.shell(serial, ['wm', 'size'])).stdout || '').trim();
    const density = ((await adb.shell(serial, ['wm', 'density'])).stdout || '').trim();
    const pid = ((await adb.shell(serial, ['pidof', APP_ID + ':node'])).stdout || '').trim();
    function kb(name) { const m = new RegExp('^' + name + ':\\s+(\\d+)', 'm').exec(mem); return m ? Math.round(Number(m[1]) / 1024) + ' MB' : null; }
    const vn = /versionName=(\S+)/.exec(pkg);
    const lu = /lastUpdateTime=([^\n]+)/.exec(pkg);
    return {
      adb: serial,
      device: { manufacturer: props['ro.product.manufacturer'] || null, model: props['ro.product.model'] || null, brand: props['ro.product.brand'] || null },
      android: { release: props['ro.build.version.release'] || null, sdk: props['ro.build.version.sdk'] ? Number(props['ro.build.version.sdk']) : null, fireos: props['ro.build.version.name'] || null },
      abis: (props['ro.product.cpu.abilist'] || props['ro.product.cpu.abi'] || '').split(',').filter(Boolean),
      memory: { total: kb('MemTotal'), available: kb('MemAvailable') },
      screen: { size: size.replace(/^Physical size:\s*/m, '') || null, density: density.replace(/^Physical density:\s*/m, '') || null },
      app: vn ? { id: APP_ID, version: vn[1], updated: lu ? lu[1].trim() : null, serverProcess: pid ? 'en marcha (pid ' + pid + ')' : 'parado' } : { id: APP_ID, installed: false }
    };
  },

  /** FPS of the TV page through the WebView's DevTools socket. opts: { seconds } */
  async perf(tv, opts) {
    opts = opts || {};
    const seconds = opts.seconds || 4;
    if (opts.endpoint) return cdp.measureFps({ base: opts.endpoint }, seconds);
    const serial = await ensureDevice(tv);
    const pid = ((await adb.shell(serial, ['pidof', APP_ID])).stdout || '').trim().split(/\s+/)[0];
    if (!pid) throw new DriverError('La app no está abierta en la tele. Ábrela con: game-to-tv tv open ' + tv.name, 'ENOTRUNNING');
    const fw = await adb.run(['-s', serial, 'forward', 'tcp:0', 'localabstract:webview_devtools_remote_' + pid]);
    const port = parseInt(String(fw.stdout || '').trim(), 10);
    if (fw.code !== 0 || !(port > 0)) throw new DriverError('adb forward ha fallado: ' + fw.out.trim(), 'EADB');
    try {
      return await cdp.measureFps({ base: 'http://127.0.0.1:' + port }, seconds);
    } finally {
      await adb.run(['-s', serial, 'forward', '--remove', 'tcp:' + port]).catch(function () {});
    }
  },

  unsupportedHelp: function (cap) {
    if (cap === 'discover') return 'Añade la tele con su IP: game-to-tv tv add salon 192.168.1.60 --driver android (la IP está en Ajustes → Red).';
    return 'Mira docs/tele-android.md.';
  }
};

module.exports = driver;
