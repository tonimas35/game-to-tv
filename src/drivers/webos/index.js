'use strict';
/*
 * LG webOS driver.
 *   discover    SSDP (urn:lge-com:service:webos-second-screen:1)
 *   pair        SSAP register with PROMPT pairing -> client-key (saved in the config)
 *   install     builds the launcher app with the server URL and installs it
 *               with ares-cli (Developer Mode); can also just build the .ipk
 *   launch      ssap://system.launcher/launch {id}
 *   control     toasts, remote buttons, luna calls (alert trick)
 *   screenshot  ssap://tv/executeOneShot (DRM apps come out black)
 *   perf        FPS via ares-inspect + Chrome DevTools Protocol
 */
const fs = require('fs');
const path = require('path');
const { SsapClient } = require('./ssap');
const ssdp = require('./ssdp');
const launcher = require('./launcher');
const ipk = require('./ipk');
const ares = require('./ares');
const cdp = require('./cdp');
const { DriverError } = require('../errors');

function appIdOf(tv) { return tv.appId || launcher.DEFAULT_APP_ID; }
function aresDevice(tv) { return tv.aresDevice || tv.name; }

/**
 * Opens an SSAP session (connect + register with the saved key) and runs fn.
 * opts: { onPrompt, onKey(newKey), url (tests) }
 */
async function withSession(tv, opts, fn) {
  opts = opts || {};
  if (!tv.clientKey && !opts.allowPrompt) {
    throw new DriverError('La tele «' + tv.name + '» no está emparejada. Ejecuta: game-to-tv tv pair ' + tv.name, 'ENOTPAIRED');
  }
  const c = new SsapClient({ ip: tv.ip, url: opts.url || tv.ssapUrl, timeout: opts.timeout });
  await c.connect();
  try {
    const r = await c.register({ clientKey: tv.clientKey, onPrompt: opts.onPrompt, promptTimeout: opts.promptTimeout });
    if (r.clientKey && r.clientKey !== tv.clientKey && opts.onKey) opts.onKey(r.clientKey);
    return await fn(c, r);
  } finally {
    c.close();
  }
}

const driver = {
  id: 'webos',
  name: 'LG webOS',
  description: 'Teles LG con webOS (probado en webOS 22). Instala una app lanzadora con el modo desarrollador.',
  capabilities: { discover: true, pair: true, install: true, launch: true, control: true, screenshot: true, perf: true },

  async discover(opts) {
    const list = await ssdp.discover(opts);
    return list.map(function (r) {
      return { ip: r.ip, name: r.name || 'Tele LG', model: r.model || null, driver: 'webos', server: r.server };
    });
  },

  async pair(tv, opts) {
    opts = opts || {};
    return withSession(tv, Object.assign({}, opts, { allowPrompt: true, promptTimeout: opts.promptTimeout || 60000 }), function (c, r) {
      return { clientKey: r.clientKey, prompted: r.prompted, url: c.url };
    });
  },

  /** Builds the launcher folder and the .ipk. opts: { serverUrl, outDir, packager: 'js'|'ares' } */
  async build(tv, opts) {
    const app = launcher.buildApp({ serverUrl: opts.serverUrl, appId: appIdOf(tv), version: opts.version });
    const outDir = path.resolve(opts.outDir || process.cwd());
    fs.mkdirSync(outDir, { recursive: true });
    let file;
    if (opts.packager === 'ares') {
      const r = await ares.run('ares-package', [app.dir, '-o', outDir]);
      if (r.code !== 0) throw new DriverError('ares-package ha fallado:\n' + (r.stderr || r.stdout), 'EARES');
      const name = (/([\w.-]+\.ipk)/.exec(r.stdout) || [])[1] || (app.appinfo.id + '_' + app.appinfo.version + '_all.ipk');
      file = path.join(outDir, name);
    } else {
      const pkg = ipk.buildIpk(app.dir);
      file = path.join(outDir, pkg.fileName);
      fs.writeFileSync(file, pkg.buffer);
    }
    return { ipk: file, appDir: app.dir, appinfo: app.appinfo, serverUrl: app.serverUrl };
  },

  /** opts: { serverUrl, outDir, ipkOnly, log } */
  async install(tv, opts) {
    const log = opts.log || function () {};
    const hasAres = ares.available();
    const built = await this.build(tv, { serverUrl: opts.serverUrl, outDir: opts.outDir, packager: hasAres && opts.packager !== 'js' && !opts.ipkOnly ? 'ares' : 'js' });
    log('App creada: ' + built.ipk + '  (servidor: ' + built.serverUrl + ')');
    if (opts.ipkOnly) return Object.assign({ installed: false }, built);
    if (!hasAres) {
      throw new DriverError('No encuentro ares-cli, así que no puedo instalar la app.\n' +
        'El paquete ya está listo: ' + built.ipk + '\n\n' + ares.setupSteps(tv), 'ENOARES');
    }
    const dev = aresDevice(tv);
    const devices = await ares.listDevices().catch(function () { return []; });
    if (devices.indexOf(dev) < 0) {
      throw new DriverError('ares-cli no conoce la tele «' + dev + '».\nEl paquete ya está listo: ' + built.ipk + '\n\n' + ares.setupSteps(tv), 'ENODEVICE');
    }
    log('Instalando en la tele con ares-install (--device ' + dev + ')…');
    const r = await ares.run('ares-install', ['--device', dev, built.ipk], { timeout: 180000 });
    if (r.code !== 0) {
      throw new DriverError('ares-install ha fallado:\n' + (r.stderr || r.stdout).trim() + '\n\n' +
        '¿Está la tele encendida con el modo desarrollador activo (Dev Mode Status ON y sesión sin caducar)?\n' +
        'Pista: ares-device --device ' + dev + ' --system-info', 'EARES');
    }
    return Object.assign({ installed: true }, built);
  },

  /** opts: { path ('/ambiente'), browser (use the built-in browser), serverUrl } */
  async launch(tv, opts) {
    opts = opts || {};
    return withSession(tv, opts, async function (c) {
      if (opts.browser) {
        await c.request('ssap://system.launcher/open', { target: opts.serverUrl + (opts.path || '/') });
        return { opened: 'browser' };
      }
      try {
        await c.request('ssap://system.launcher/launch', { id: appIdOf(tv), params: opts.path ? { path: opts.path } : {} });
      } catch (e) {
        throw new DriverError('No se pudo abrir la app «' + appIdOf(tv) + '» (' + e.message + ').\n¿Está instalada? game-to-tv tv install ' + tv.name, 'ELAUNCH');
      }
      return { opened: appIdOf(tv) };
    });
  },

  async toast(tv, message, opts) {
    return withSession(tv, opts, function (c) {
      return c.request('ssap://system.notifications/createToast', { message: String(message).slice(0, 200) });
    });
  },

  async sendKey(tv, button, opts) {
    return withSession(tv, opts, function (c) { return c.button(button); });
  },

  async screenshot(tv, outFile, opts) {
    return withSession(tv, opts, function (c) { return c.screenshot(outFile); });
  },

  async luna(tv, uri, params, opts) {
    return withSession(tv, opts, function (c) { return c.luna(uri, params); });
  },

  async info(tv, opts) {
    return withSession(tv, opts, async function (c) {
      async function safe(uri) {
        try { return await c.request(uri); } catch (e) { return { error: e.message }; }
      }
      return {
        system: await safe('ssap://system/getSystemInfo'),
        software: await safe('ssap://com.webos.service.update/getCurrentSWInformation'),
        foreground: await safe('ssap://com.webos.applicationManager/getForegroundAppInfo'),
        volume: await safe('ssap://audio/getVolume')
      };
    });
  },

  /**
   * FPS on the TV. opts: { seconds, endpoint (skip ares-inspect: 'http://ip:port') }
   * Runs `ares-inspect --device <tv> --app <id>`, reads the DevTools URL and
   * measures with requestAnimationFrame through CDP.
   */
  async perf(tv, opts) {
    opts = opts || {};
    const seconds = opts.seconds || 4;
    if (opts.endpoint) return cdp.measureFps(cdp.parseInspectOutput(opts.endpoint) || { base: opts.endpoint }, seconds);
    if (!ares.which('ares-inspect')) {
      throw new DriverError('Para medir los FPS hace falta ares-inspect (ares-cli).\n\n' + ares.setupSteps(tv), 'ENOARES');
    }
    let child = null;
    let endpoint = null;
    let buffer = '';
    const runP = ares.run('ares-inspect', ['--device', aresDevice(tv), '--app', appIdOf(tv)], {
      timeout: (seconds + 60) * 1000,
      onSpawn: function (ch) { child = ch; },
      onStdout: function (text) { buffer += text; if (!endpoint) endpoint = cdp.parseInspectOutput(buffer); }
    });
    try {
      const t0 = Date.now();
      while (!endpoint && Date.now() - t0 < 30000) {
        await new Promise(function (r) { setTimeout(r, 100); });
        if (child && child.exitCode !== null) break;
      }
      if (!endpoint) throw new DriverError('ares-inspect no ha dado la dirección de DevTools. ¿Está la app abierta? (game-to-tv tv open ' + tv.name + ')\n' + buffer.trim(), 'EINSPECT');
      return await cdp.measureFps(endpoint, seconds);
    } finally {
      // ares-inspect keeps running (it is a proxy): stop it and its pipes
      if (child) {
        try { child.stdout.destroy(); child.stderr.destroy(); } catch (e) { /* noop */ }
        try { child.kill(); } catch (e) { /* noop */ }
      }
      await runP.catch(function () {});
    }
  }
};

driver.withSession = withSession;
module.exports = driver;
