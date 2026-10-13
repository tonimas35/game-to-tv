'use strict';
/*
 * Local configuration: ~/.game-to-tv/config.json
 *
 * Holds the configured TVs (driver, IP, pairing key), and optional overrides
 * for the gallery folder, the ambient-mode folder and the timezone.
 * The folder can be moved with the GAME_TO_TV_HOME environment variable
 * (the tests use it to never touch the real one).
 *
 * The file may contain a TV pairing key: it is written with mode 0600 and
 * must never be committed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  version: 1,
  tvs: {},
  galleryDir: null,   // default: <home>/galeria
  ambientDir: null,   // default: <home>/ambiente
  timezone: 'Europe/Madrid',
  port: 3000
};

function homeDir() {
  if (process.env.GAME_TO_TV_HOME) return path.resolve(process.env.GAME_TO_TV_HOME);
  return path.join(os.homedir(), '.game-to-tv');
}

function configPath() { return path.join(homeDir(), 'config.json'); }

function load() {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      const err = new Error('No se puede leer ' + configPath() + ': ' + e.message);
      err.code = 'CONFIG_INVALID';
      throw err;
    }
  }
  const cfg = Object.assign({}, DEFAULTS, data);
  cfg.tvs = Object.assign({}, data.tvs || {});
  return cfg;
}

function save(cfg) {
  const dir = homeDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath();
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (e) { /* Windows */ }
  return file;
}

function galleryDir(cfg) {
  if (process.env.GALERIA_DIR) return path.resolve(process.env.GALERIA_DIR);
  if (cfg && cfg.galleryDir) return path.resolve(cfg.galleryDir);
  return path.join(homeDir(), 'galeria');
}

function ambientDir(cfg) {
  if (process.env.AMBIENTE_DIR) return path.resolve(process.env.AMBIENTE_DIR);
  if (cfg && cfg.ambientDir) return path.resolve(cfg.ambientDir);
  return path.join(homeDir(), 'ambiente');
}

// TV names: short, no spaces, so they work as ares-cli device names too
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
function validTvName(name) { return NAME_RE.test(String(name || '')); }

function validIp(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
  if (!m) return /^[a-z0-9.-]+\.local$/i.test(String(ip || '')); // mDNS host names
  return m.slice(1).every(function (n) { return Number(n) <= 255; });
}

module.exports = {
  DEFAULTS: DEFAULTS,
  homeDir: homeDir,
  configPath: configPath,
  load: load,
  save: save,
  galleryDir: galleryDir,
  ambientDir: ambientDir,
  validTvName: validTvName,
  validIp: validIp
};
