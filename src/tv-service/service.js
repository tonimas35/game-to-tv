'use strict';
/*
 * Entry point of the webOS JS service («modo tele»). webOS runs it with the
 * TV's own Node (v12 on webOS 22) and provides `webos-service`: it is NOT
 * bundled in the .ipk (the TV's copy must be used).
 *
 * The service folder that `game-to-tv tv install` builds looks like this:
 *   package.json       { name: <appId>.service, version, main: service.js }
 *   services.json      { id, description, services: [{ name }] }
 *   tv-service.json    { port, idleMinutes, players, appId, serviceId, version }
 *   service.js         require('./src/tv-service/service.js')
 *   src/server, src/games, src/config.js, src/tv-service, public/
 *   node_modules/      ws, qrcode, pngjs (production only)
 * See src/drivers/webos/bundle.js.
 */
const fs = require('fs');
const path = require('path');
const core = require('./core');

const ROOT = path.join(__dirname, '..', '..');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
}

const pkg = readJson(path.join(ROOT, 'package.json'));
const settings = readJson(path.join(ROOT, 'tv-service.json'));
const serviceId = settings.serviceId || pkg.name;

const Service = require('webos-service');

const tvService = core.createTvService({
  Service: Service,
  serviceId: serviceId,
  port: process.env.G2T_PORT || settings.port,
  players: process.env.G2T_JUGADORES || settings.players,
  idleMs: process.env.G2T_IDLE_MIN ? Number(process.env.G2T_IDLE_MIN) * 60000
    : (settings.idleMinutes != null ? Number(settings.idleMinutes) * 60000 : undefined),
  version: settings.version || pkg.version,
  serviceDir: ROOT
});

process.on('uncaughtException', function (e) {
  // Never let a bug in a game take the whole service down
  tvService.log('Error no capturado: ' + (e && e.stack || e));
});

module.exports = tvService;
