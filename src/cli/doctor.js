'use strict';
/*
 * `game-to-tv doctor`: read-only checks with explanations in Spanish.
 *  - Node version
 *  - the port is free (or already used by game-to-tv)
 *  - LAN IP (and suspicious adapters)
 *  - Windows firewall (network profile, Node.js block rules, port rule)
 *  - ares-cli (needed to install the LG app)
 *  - configured TVs (reachable?)
 */
const fs = require('fs');
const net = require('net');
const http = require('http');
const config = require('../config');
const { rankedIPv4, scoreIface } = require('../server/net');
const drivers = require('../drivers');
const ares = require('../drivers/webos/ares');
const firewall = require('./firewall');
const ui = require('./ui');

function portFree(port) {
  return new Promise(function (resolve) {
    const srv = net.createServer();
    srv.once('error', function (e) { resolve(e.code || 'ERROR'); });
    srv.listen(port, '0.0.0.0', function () { srv.close(function () { resolve(true); }); });
  });
}

function whoIsOnPort(port) {
  return new Promise(function (resolve) {
    const req = http.get({ host: '127.0.0.1', port: port, path: '/info', timeout: 1500 }, function (res) {
      let body = '';
      res.on('data', function (d) { body += d; });
      res.on('end', function () { try { resolve(JSON.parse(body).app === 'game-to-tv' ? 'game-to-tv' : 'otro'); } catch (e) { resolve('otro'); } });
    });
    req.on('timeout', function () { req.destroy(); resolve('otro'); });
    req.on('error', function () { resolve('otro'); });
  });
}

function tcpReachable(host, port, timeout) {
  return new Promise(function (resolve) {
    const s = net.connect({ host: host, port: port });
    const t = setTimeout(function () { s.destroy(); resolve(false); }, timeout || 1500);
    s.once('connect', function () { clearTimeout(t); s.destroy(); resolve(true); });
    s.once('error', function () { clearTimeout(t); resolve(false); });
  });
}

async function doctor(flags) {
  let problems = 0;
  const cfg = config.load();
  const port = parseInt(flags.port, 10) || parseInt(process.env.PORT, 10) || cfg.port || 3000;
  console.log('\n  ' + ui.c.bold('game-to-tv doctor') + ' · revisión (no cambia nada)\n');

  // Node
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 18) ui.ok('Node.js ' + process.versions.node);
  else { problems++; ui.fail('Node.js ' + process.versions.node + ': hace falta la versión 18 o superior (https://nodejs.org).'); }

  // Port
  const free = await portFree(port);
  if (free === true) ui.ok('El puerto ' + port + ' está libre.');
  else if (free === 'EADDRINUSE') {
    const who = await whoIsOnPort(port);
    if (who === 'game-to-tv') ui.ok('El puerto ' + port + ' ya lo usa game-to-tv (el servidor está arrancado).');
    else { problems++; ui.fail('El puerto ' + port + ' está ocupado por otro programa. Usa otro: game-to-tv start --port ' + (port + 1)); }
  } else { problems++; ui.fail('No se puede usar el puerto ' + port + ' (' + free + ').'); }

  // IP
  const ips = rankedIPv4();
  if (!ips.length) { problems++; ui.fail('No hay ninguna red activa: conecta el PC al Wi‑Fi o al cable de casa.'); }
  else {
    const best = ips[0];
    if (/^169\.254\./.test(best.address)) { problems++; ui.fail('La IP ' + best.address + ' es automática (sin router): revisa la conexión.'); }
    else ui.ok('IP del PC en la red de casa: ' + ui.c.bold(best.address) + ' (' + best.name + ')' + (process.env.HOST_IP ? ' · HOST_IP=' + process.env.HOST_IP : ''));
    const others = ips.slice(1).filter(function (c) { return scoreIface(c) > 0; });
    if (others.length) ui.warn('Otras redes: ' + others.map(function (c) { return c.address + ' (' + c.name + ')'; }).join(', ') + '. Si el QR no funciona, arranca con --host-ip.');
  }

  // Firewall
  if (process.platform === 'win32') {
    const data = await firewall.readWindowsFirewall(port);
    if (data.error) ui.warn('No se pudo leer el cortafuegos de Windows: ' + data.error);
    else {
      const r = firewall.analyzeFirewall(data, port);
      r.ok.forEach(function (s) { ui.ok(s); });
      r.problems.forEach(function (s) { problems++; ui.fail(s); });
      if (r.commands.length) {
        console.log('\n  Para arreglarlo, abre PowerShell ' + ui.c.bold('como administrador') + ' y ejecuta:\n');
        r.commands.forEach(function (c) { console.log('    ' + ui.c.cyan(c)); });
        console.log('\n  (Perfil Privado + una regla solo para el puerto ' + port + ' y solo desde tu red local.)\n');
      }
    }
  } else if (process.platform === 'linux') {
    ui.info(ui.c.dim('Linux: si usas ufw/firewalld, permite el puerto ' + port + '/tcp desde tu red local (p. ej. sudo ufw allow from 192.168.1.0/24 to any port ' + port + ' proto tcp).'));
  } else if (process.platform === 'darwin') {
    ui.info(ui.c.dim('macOS: si el cortafuegos está activo, permite las conexiones entrantes a «node» cuando lo pregunte.'));
  }

  // ares-cli
  if (ares.available()) {
    ui.ok('ares-cli instalado (' + ares.which('ares-install') + ')');
    const devs = await ares.listDevices().catch(function () { return []; });
    if (devs.length) ui.ok('Teles en ares-cli: ' + devs.join(', '));
  } else {
    ui.warn('ares-cli no está instalado: solo hace falta para instalar la app en teles LG (npm install -g @webos-tools/cli).');
  }

  // Gallery folder
  const gdir = config.galleryDir(cfg);
  try { fs.mkdirSync(gdir, { recursive: true }); fs.accessSync(gdir, fs.constants.W_OK); ui.ok('Galería de dibujos: ' + gdir); }
  catch (e) { problems++; ui.fail('No se puede escribir en la galería ' + gdir + ': ' + e.message); }

  // TVs
  const names = Object.keys(cfg.tvs);
  if (!names.length) ui.warn('No hay teles configuradas (game-to-tv tv scan / tv add).');
  for (const n of names) {
    const t = cfg.tvs[n];
    let d = null;
    try { d = drivers.get(t.driver); } catch (e) { problems++; ui.fail('Tele «' + n + '»: driver desconocido «' + t.driver + '».'); continue; }
    if (t.driver === 'webos') {
      const ssap = await tcpReachable(t.ip, 3001) || await tcpReachable(t.ip, 3000);
      const dev = await tcpReachable(t.ip, 9922);
      const parts = [ssap ? 'responde' : 'no responde (¿apagada o en otra red?)', t.clientKey ? 'emparejada' : 'sin emparejar', dev ? 'modo desarrollador activo' : 'modo desarrollador no detectado'];
      if (ssap) ui.ok('Tele «' + n + '» (' + d.name + ', ' + t.ip + '): ' + parts.join(' · '));
      else { problems++; ui.fail('Tele «' + n + '» (' + d.name + ', ' + t.ip + '): ' + parts.join(' · ')); }
    } else {
      ui.ok('Tele «' + n + '» (' + d.name + ', ' + t.ip + ')');
    }
  }

  console.log('');
  if (problems) ui.warn(problems + ' cosa(s) que revisar. Más ayuda en docs/solucion-problemas.md\n');
  else ui.ok('Todo bien. Arranca con: game-to-tv start\n');
  return problems ? 1 : 0;
}

module.exports = { doctor: doctor };
