'use strict';
/*
 * Builds the folder of the webOS JS service for «modo tele»: the game server
 * that runs inside the TV (see src/tv-service/).
 *
 * Only what the server needs at run time is copied:
 *   src/server, src/games, src/config.js, src/tv-service, public/
 *   node_modules/ with the production dependencies (ws, qrcode, pngjs and what
 *   they need), without docs, tests, type definitions or browser bundles
 * Never: tests, docs, the CLI, the drivers, apps/, scripts/ or webos-service
 * (the TV provides its own copy and it must not be bundled).
 *
 * Plus the generated files:
 *   package.json      { name: <serviceId>, version, main: 'service.js' }
 *   services.json     { id, description, services: [{ name }] }
 *   tv-service.json   { serviceId, appId, port, idleMinutes, version }
 *   service.js        require('./src/tv-service/service.js')
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');

// Copied from the project (relative to ROOT). Directories are copied whole, minus EXCLUDE.
const SOURCES = ['src/server', 'src/games', 'src/config.js', 'src/tv-service', 'public'];
// Never bundled: the TV has webos-service; yargs is only qrcode's command line tool
const SKIP_MODULES = ['webos-service', 'yargs'];
// Files and folders left out of node_modules packages (and of the sources)
const EXCLUDE_DIRS = /^(test|tests|__tests__|spec|example|examples|docs?|\.github|bench|benchmarks?|coverage|\.nyc_output|\.vscode)$/i;
const EXCLUDE_FILES = /(\.md|\.markdown|\.d\.ts|\.map|\.ts|\.tsbuildinfo)$|^\.|^Thumbs\.db$/i;
// Per package, at its root: browser-only bundles and command line tools (not used by the server)
const EXCLUDE_PER_PACKAGE = { pngjs: ['browser.js'], qrcode: ['bin'] };

function copyTree(src, dst, opts, stats) {
  opts = opts || {};
  const st = fs.statSync(src);
  if (st.isFile()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    stats.files++;
    stats.bytes += st.size;
    return;
  }
  fs.mkdirSync(dst, { recursive: true });
  fs.readdirSync(src, { withFileTypes: true }).forEach(function (d) {
    if (opts.skipRoot && opts.skipRoot.indexOf(d.name) >= 0) return;
    if (d.isDirectory()) {
      if (EXCLUDE_DIRS.test(d.name) || d.name === 'node_modules') return;
      copyTree(path.join(src, d.name), path.join(dst, d.name), { skipRoot: null }, stats);
    } else if (d.isFile()) {
      if (EXCLUDE_FILES.test(d.name)) return;
      copyTree(path.join(src, d.name), path.join(dst, d.name), null, stats);
    }
  });
}

/**
 * Production dependency closure, resolved like Node does (nested
 * node_modules first, then the parents). Returns [{ name, version, dir, rel }]
 * where rel is the folder relative to ROOT (e.g. node_modules/qrcode/node_modules/pngjs).
 */
function productionModules(root) {
  root = root || ROOT;
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const out = [];
  const seen = {};
  function resolve(name, fromDir) {
    let dir = fromDir;
    for (;;) {
      const cand = path.join(dir, 'node_modules', name);
      if (fs.existsSync(path.join(cand, 'package.json'))) return cand;
      if (path.resolve(dir) === path.resolve(root)) return null;
      const up = path.dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  }
  function visit(name, fromDir) {
    if (SKIP_MODULES.indexOf(name) >= 0) return;
    const dir = resolve(name, fromDir);
    if (!dir) throw new Error('Falta la dependencia «' + name + '» (¿has ejecutado npm install?)');
    if (seen[dir]) return;
    seen[dir] = true;
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    out.push({ name: name, version: p.version, dir: dir, rel: path.relative(root, dir).split(path.sep).join('/') });
    Object.keys(p.dependencies || {}).forEach(function (d) { visit(d, dir); });
  }
  Object.keys(pkg.dependencies || {}).forEach(function (d) { visit(d, root); });
  return out;
}

/**
 * opts: { appId, serviceId, version, port, idleMinutes, outDir, description }
 * Returns { dir, serviceId, modules, stats }
 */
function buildService(opts) {
  opts = opts || {};
  const appId = opts.appId || 'io.gametotv.launcher';
  const serviceId = opts.serviceId || appId + '.service';
  if (serviceId.indexOf(appId + '.') !== 0) throw new Error('El id del servicio debe empezar por el de la app (' + appId + '.)');
  const version = opts.version || require('../../../package.json').version;
  const dir = opts.outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'g2t-webos-svc-'));
  fs.mkdirSync(dir, { recursive: true });
  const stats = { files: 0, bytes: 0 };

  SOURCES.forEach(function (rel) {
    copyTree(path.join(ROOT, rel), path.join(dir, rel), null, stats);
  });
  const modules = productionModules(ROOT);
  modules.forEach(function (m) {
    copyTree(m.dir, path.join(dir, m.rel), { skipRoot: EXCLUDE_PER_PACKAGE[m.name] || null }, stats);
  });

  function write(name, text) {
    fs.writeFileSync(path.join(dir, name), text);
    stats.files++;
    stats.bytes += Buffer.byteLength(text);
  }
  write('package.json', JSON.stringify({
    name: serviceId,
    version: version,
    description: 'game-to-tv: servidor de juegos dentro de la tele',
    main: 'service.js',
    private: true,
    engines: { node: '>=12' }
  }, null, 2) + '\n');
  write('services.json', JSON.stringify({
    id: serviceId,
    description: opts.description || 'Juegos del Salón: servidor de juegos en la tele',
    services: [{ name: serviceId }]
  }, null, 2) + '\n');
  write('tv-service.json', JSON.stringify({
    serviceId: serviceId,
    appId: appId,
    port: opts.port || 8090,
    idleMinutes: opts.idleMinutes != null ? opts.idleMinutes : 15,
    players: Math.max(2, Math.min(8, Number(opts.players) || 6)),
    version: version
  }, null, 2) + '\n');
  write('service.js', "'use strict';\n// webOS JS service of «Juegos del Salón» (game-to-tv " + version + '). See src/tv-service/.\n' +
    "require('./src/tv-service/service.js');\n");

  return { dir: dir, serviceId: serviceId, modules: modules, stats: stats };
}

module.exports = { ROOT: ROOT, SOURCES: SOURCES, SKIP_MODULES: SKIP_MODULES, buildService: buildService, productionModules: productionModules };
