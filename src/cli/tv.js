'use strict';
// `game-to-tv tv ...`: add, pair, install and control TVs.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const drivers = require('../drivers');
const { detectLanIp } = require('../server/net');
const ui = require('./ui');

const TV_HELP = [
  '',
  '  game-to-tv tv scan [--tiempo 3]',
  '  game-to-tv tv add NOMBRE IP [--driver webos|browser|firetv] [--app-id ID]',
  '  game-to-tv tv list',
  '  game-to-tv tv remove NOMBRE',
  '  game-to-tv tv pair NOMBRE',
  '  game-to-tv tv install NOMBRE [--server-url URL] [--solo-ipk] [--salida CARPETA] [--empaquetador js|ares]',
  '  game-to-tv tv ipk [--server-url URL] [--salida CARPETA]',
  '  game-to-tv tv open NOMBRE [--ruta /ambiente] [--navegador]',
  '  game-to-tv tv shot NOMBRE [archivo.jpg]',
  '  game-to-tv tv perf NOMBRE [--segundos 4] [--cdp http://IP:PUERTO]',
  '  game-to-tv tv toast NOMBRE "mensaje"',
  '  game-to-tv tv key NOMBRE BOTON        (UP, DOWN, LEFT, RIGHT, ENTER, BACK, HOME…)',
  '  game-to-tv tv info NOMBRE',
  '  game-to-tv tv luna NOMBRE luna://servicio/metodo \'{"json":1}\'   (avanzado, sin respuesta)',
  ''
].join('\n');

function defaultServerUrl(flags) {
  if (typeof flags['server-url'] === 'string') return require('../drivers/webos/launcher').normalizeServerUrl(flags['server-url']);
  const cfg = config.load();
  const port = typeof flags.port === 'string' ? flags.port : (process.env.PORT || cfg.port || 3000);
  return 'http://' + detectLanIp(typeof flags['host-ip'] === 'string' ? flags['host-ip'] : undefined) + ':' + port;
}

function getTv(name) {
  if (!name) throw new drivers.DriverError('Falta el nombre de la tele. Mira las configuradas con: game-to-tv tv list', 'EARGS');
  const cfg = config.load();
  const tv = cfg.tvs[name];
  if (!tv) {
    const names = Object.keys(cfg.tvs);
    throw new drivers.DriverError('No hay ninguna tele llamada «' + name + '».' +
      (names.length ? ' Configuradas: ' + names.join(', ') : ' Añádela con: game-to-tv tv add ' + name + ' 192.168.1.50'), 'ENOTV');
  }
  return Object.assign({ name: name }, tv);
}

function saveTv(tv) {
  const cfg = config.load();
  const copy = Object.assign({}, tv);
  delete copy.name;
  cfg.tvs[tv.name] = copy;
  config.save(cfg);
}

// Options for drivers that talk to the TV: prompt message and key updates
function sessionOpts(tv) {
  return {
    onPrompt: function () {
      ui.box([
        'MIRA LA TELE «' + tv.name + '»',
        '',
        'Acepta con el mando el aviso de conexión',
        '(«game-to-tv» quiere controlar la tele).',
        'Tienes 60 segundos.'
      ]);
    },
    onKey: function (key) {
      tv.clientKey = key;
      saveTv(tv);
      ui.info(ui.c.dim('(clave de emparejamiento actualizada)'));
    }
  };
}

async function run(args, flags) {
  const sub = args[0];
  const name = args[1];
  if (!sub || flags.help || sub === 'help' || sub === 'ayuda') { console.log(TV_HELP); return 0; }

  switch (sub) {
    case 'scan':
    case 'buscar': {
      const timeout = Math.round((parseFloat(flags.tiempo) || 3) * 1000);
      console.log('\n  Buscando teles en la red (' + timeout / 1000 + ' s)…\n');
      let found = [];
      for (const d of drivers.list()) {
        if (!d.capabilities.discover) continue;
        try { found = found.concat(await d.discover({ timeout: timeout })); } catch (e) { ui.warn(d.name + ': ' + e.message); }
      }
      if (!found.length) {
        ui.warn('No he encontrado ninguna tele LG.');
        ui.info('¿Está encendida y en la misma red que el PC? (también puede bloquearlo el cortafuegos)');
        ui.info('Puedes añadirla a mano con su IP: game-to-tv tv add salon 192.168.1.50');
        ui.info('Otras teles o proyectores con navegador: game-to-tv tv add proyector 192.168.1.60 --driver browser');
        console.log('');
        return 1;
      }
      const cfg = config.load();
      found.forEach(function (t) {
        const known = Object.keys(cfg.tvs).filter(function (k) { return cfg.tvs[k].ip === t.ip; })[0];
        ui.ok(ui.c.bold(t.name) + '  ' + t.ip + (t.model ? '  (' + t.model + ')' : '') + '  [' + t.driver + ']' +
          (known ? ui.c.dim('  → ya configurada como «' + known + '»') : ''));
      });
      const first = found[0];
      console.log('\n  Para añadirla:  game-to-tv tv add salon ' + first.ip + ' --driver ' + first.driver + '\n');
      return 0;
    }

    case 'add':
    case 'anadir': {
      const ip = args[2];
      const driverId = typeof flags.driver === 'string' ? flags.driver : 'webos';
      if (!config.validTvName(name)) throw new drivers.DriverError('Nombre no válido: usa minúsculas, números, «-» o «_» (p. ej. «salon»).', 'EARGS');
      if (!config.validIp(ip)) throw new drivers.DriverError('IP no válida: «' + (ip || '') + '» (p. ej. 192.168.1.50).', 'EARGS');
      const d = drivers.get(driverId);
      const cfg = config.load();
      const prev = cfg.tvs[name];
      cfg.tvs[name] = { driver: driverId, ip: ip, addedAt: new Date().toISOString() };
      if (typeof flags['app-id'] === 'string') cfg.tvs[name].appId = flags['app-id'];
      if (typeof flags['ares-device'] === 'string') cfg.tvs[name].aresDevice = flags['ares-device'];
      if (prev && prev.ip === ip && prev.driver === driverId && prev.clientKey) cfg.tvs[name].clientKey = prev.clientKey;
      const file = config.save(cfg);
      ui.ok('Tele «' + name + '» (' + d.name + ', ' + ip + ') guardada en ' + file);
      console.log('');
      if (driverId === 'webos') {
        ui.info('Siguientes pasos:');
        ui.info('  1. game-to-tv tv pair ' + name + '      (acepta el aviso en la tele)');
        ui.info('  2. game-to-tv tv install ' + name + '   (necesita el modo desarrollador: docs/tele-lg.md)');
        ui.info('  3. game-to-tv start --abrir ' + name);
      } else if (driverId === 'browser') {
        ui.info('Con el driver «browser» no hay que instalar nada: arranca el servidor y abre en la tele');
        ui.info('la dirección que aparece (game-to-tv tv open ' + name + ' te la recuerda).');
      } else if (d.unsupportedHelp) {
        ui.warn(d.unsupportedHelp());
      }
      console.log('');
      return 0;
    }

    case 'list':
    case 'lista': {
      const cfg = config.load();
      const names = Object.keys(cfg.tvs);
      console.log('');
      if (!names.length) {
        ui.info('No hay teles configuradas. Búscalas con «game-to-tv tv scan» o añade una con');
        ui.info('«game-to-tv tv add salon 192.168.1.50».');
      }
      names.forEach(function (n) {
        const t = cfg.tvs[n];
        let d = null;
        try { d = drivers.get(t.driver); } catch (e) { /* unknown driver */ }
        const paired = d && d.capabilities.pair ? (t.clientKey ? ui.c.green('emparejada') : ui.c.yellow('sin emparejar')) : '';
        ui.info(ui.c.bold(n) + '  ' + t.ip + '  [' + (d ? d.name : t.driver + '?') + ']  ' + paired);
      });
      console.log('\n  Configuración: ' + config.configPath() + '\n');
      return 0;
    }

    case 'remove':
    case 'borrar': {
      const cfg = config.load();
      if (!cfg.tvs[name]) throw new drivers.DriverError('No hay ninguna tele llamada «' + (name || '') + '».', 'ENOTV');
      delete cfg.tvs[name];
      config.save(cfg);
      ui.ok('Tele «' + name + '» eliminada de la configuración.');
      return 0;
    }

    case 'pair':
    case 'emparejar': {
      const tv = getTv(name);
      const d = drivers.get(tv.driver);
      drivers.requireCapability(d, 'pair');
      ui.info('Conectando con «' + tv.name + '» (' + tv.ip + ')…');
      const r = await d.pair(tv, sessionOpts(tv));
      tv.clientKey = r.clientKey;
      tv.pairedAt = new Date().toISOString();
      saveTv(tv);
      ui.ok('¡Emparejada! La clave se ha guardado en ' + config.configPath() + ' (no la compartas).');
      try { await d.toast(tv, 'game-to-tv conectado ✔'); } catch (e) { /* optional */ }
      return 0;
    }

    case 'install':
    case 'instalar': {
      const tv = getTv(name);
      const d = drivers.get(tv.driver);
      drivers.requireCapability(d, 'install');
      const serverUrl = defaultServerUrl(flags);
      const outDir = typeof flags.salida === 'string' ? flags.salida : path.join(config.homeDir(), 'ipk');
      ui.info('Servidor que abrirá la app: ' + ui.c.cyan(serverUrl) + ui.c.dim('  (cámbialo con --server-url)'));
      const r = await d.install(tv, {
        serverUrl: serverUrl, outDir: outDir, ipkOnly: !!flags['solo-ipk'],
        packager: typeof flags.empaquetador === 'string' ? flags.empaquetador : undefined,
        log: function (s) { ui.info(s); }
      });
      if (r.installed) {
        ui.ok('App instalada en «' + tv.name + '». Ábrela con: game-to-tv tv open ' + tv.name);
        ui.info(ui.c.dim('(si ya estaba instalada y no ves el icono nuevo, reinicia la tele)'));
      } else {
        ui.ok('Paquete creado: ' + r.ipk);
        ui.info('Instálalo con: ares-install --device ' + (tv.aresDevice || tv.name) + ' "' + r.ipk + '"');
      }
      return 0;
    }

    case 'ipk': {
      const webos = drivers.get('webos');
      const serverUrl = defaultServerUrl(flags);
      const outDir = typeof flags.salida === 'string' ? flags.salida : process.cwd();
      const r = await webos.build({ name: 'tele', appId: typeof flags['app-id'] === 'string' ? flags['app-id'] : undefined }, { serverUrl: serverUrl, outDir: outDir, packager: 'js' });
      ui.ok('Paquete creado: ' + r.ipk + '  (abre ' + r.serverUrl + ')');
      return 0;
    }

    case 'open':
    case 'abrir': {
      const tv = getTv(name);
      const d = drivers.get(tv.driver);
      drivers.requireCapability(d, 'launch');
      const r = await d.launch(tv, Object.assign(sessionOpts(tv), {
        serverUrl: defaultServerUrl(flags),
        path: typeof flags.ruta === 'string' ? flags.ruta : undefined,
        browser: !!flags.navegador
      }));
      if (r && r.message) {
        console.log('\n  ' + r.message.split('\n').join('\n  '));
        if (r.qr) console.log(r.qr.split('\n').map(function (l) { return '  ' + l; }).join('\n'));
      } else {
        ui.ok('Abierto en «' + tv.name + '».');
      }
      return 0;
    }

    case 'shot':
    case 'captura': {
      const tv = getTv(name);
      const d = drivers.get(tv.driver);
      drivers.requireCapability(d, 'screenshot');
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const out = path.resolve(args[2] || ('captura-' + tv.name + '-' + stamp + '.jpg'));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await d.screenshot(tv, out, sessionOpts(tv));
      ui.ok('Captura guardada en ' + out + ui.c.dim('  (las apps con DRM salen en negro)'));
      return 0;
    }

    case 'perf': {
      const tv = getTv(name);
      const d = drivers.get(tv.driver);
      drivers.requireCapability(d, 'perf');
      const seconds = parseFloat(flags.segundos) || 4;
      ui.info('Midiendo ' + seconds + ' s en «' + tv.name + '» (requestAnimationFrame por DevTools)…');
      const r = await d.perf(tv, { seconds: seconds, endpoint: typeof flags.cdp === 'string' ? flags.cdp : undefined });
      if (flags.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
      const verdict = r.fps >= 55 ? ui.c.green('fluido') : (r.fps >= 30 ? ui.c.yellow('aceptable') : ui.c.red('a tirones'));
      ui.ok(ui.c.bold(r.fps + ' FPS') + ' (' + verdict + ')  · peor fotograma ' + r.worstMs + ' ms · ' + r.frames + ' fotogramas');
      ui.info('Pantalla: ' + (r.screen || '?') + ' · ventana ' + r.width + 'x' + r.height + ' · devicePixelRatio ' + r.dpr + (r.canvas ? ' · canvas ' + r.canvas : ''));
      if (r.fps < 50) ui.info('Pista: prueba con menos resolución (?res=960) o revisa docs/solucion-problemas.md');
      return 0;
    }

    case 'toast':
    case 'aviso': {
      const tv = getTv(name);
      const d = drivers.get(tv.driver);
      drivers.requireCapability(d, 'control', 'toast');
      const msg = args.slice(2).join(' ').trim();
      if (!msg) throw new drivers.DriverError('Falta el mensaje: game-to-tv tv toast ' + tv.name + ' "Hola"', 'EARGS');
      await d.toast(tv, msg, sessionOpts(tv));
      ui.ok('Aviso enviado.');
      return 0;
    }

    case 'key':
    case 'boton': {
      const tv = getTv(name);
      const d = drivers.get(tv.driver);
      drivers.requireCapability(d, 'control', 'sendKey');
      const button = String(args[2] || '').toUpperCase();
      if (!/^[A-Z0-9_]{1,24}$/.test(button)) throw new drivers.DriverError('Botón no válido. Ejemplos: UP, DOWN, LEFT, RIGHT, ENTER, BACK, HOME', 'EARGS');
      await d.sendKey(tv, button, sessionOpts(tv));
      ui.ok('Botón ' + button + ' pulsado.');
      return 0;
    }

    case 'info': {
      const tv = getTv(name);
      const d = drivers.get(tv.driver);
      if (typeof d.info !== 'function') { drivers.requireCapability(d, 'control', 'info'); }
      const r = await d.info(tv, sessionOpts(tv));
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }

    case 'luna': {
      const tv = getTv(name);
      const d = drivers.get(tv.driver);
      drivers.requireCapability(d, 'control', 'luna');
      const uri = args[2];
      if (!/^luna:\/\//.test(uri || '')) throw new drivers.DriverError('Falta la URI luna://…', 'EARGS');
      let params = {};
      try { params = args[3] ? JSON.parse(args[3]) : {}; } catch (e) { throw new drivers.DriverError('Los parámetros deben ser JSON válido.', 'EARGS'); }
      await d.luna(tv, uri, params, sessionOpts(tv));
      ui.ok('Llamada enviada (la tele no devuelve el resultado con este método).');
      return 0;
    }

    default:
      console.log('\n  Subcomando desconocido: «' + sub + '».');
      console.log(TV_HELP);
      return 2;
  }
}

module.exports = { run: run, TV_HELP: TV_HELP, defaultServerUrl: defaultServerUrl };
