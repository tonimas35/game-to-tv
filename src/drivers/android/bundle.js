'use strict';
/*
 * The Node.js project that goes inside the Android TV app
 * (apps/android-tv/, assets/nodejs-project/): the same run-time files as the
 * webOS «modo tele» service (src/drivers/webos/bundle.js: server, games,
 * public/, production node_modules: ws, qrcode, pngjs) plus:
 *
 *   main.js        require('./src/tv-service/android.js').run(argv)
 *   package.json   { name: 'io.gametotv.android', version, main: 'main.js' }
 *   files.txt      every file of the bundle, one per line (the app copies
 *                  them out of the APK without listing the assets, which is slow)
 *   bundle.json    { version, commit, builtAt, files, bytes }
 *
 * No CLI, drivers, tests or docs. The Gradle build runs it through
 * scripts/android-bundle.js.
 */
const fs = require('fs');
const path = require('path');
const webosBundle = require('../webos/bundle');

const APP_ID = 'io.gametotv.android';

function rmrf(dir) {
  try {
    if (fs.rmSync) fs.rmSync(dir, { recursive: true, force: true });
    else fs.rmdirSync(dir, { recursive: true });
  } catch (e) { /* noop */ }
}

function listFiles(dir, base, out) {
  base = base || '';
  out = out || [];
  fs.readdirSync(path.join(dir, base), { withFileTypes: true }).forEach(function (d) {
    const rel = base ? base + '/' + d.name : d.name;
    if (d.isDirectory()) listFiles(dir, rel, out);
    else if (d.isFile()) out.push(rel);
  });
  return out;
}

/** opts: { outDir (required, emptied first), version, commit } -> { dir, files, bytes, modules } */
function buildAndroidBundle(opts) {
  opts = opts || {};
  if (!opts.outDir) throw new Error('Falta outDir');
  const dir = path.resolve(opts.outDir);
  const version = opts.version || require('../../../package.json').version;
  rmrf(dir);
  fs.mkdirSync(dir, { recursive: true });
  const copied = webosBundle.copyRuntime(dir);
  fs.writeFileSync(path.join(dir, 'main.js'), "'use strict';\n// Juegos del Salón for Android TV (game-to-tv " + version + '). See src/tv-service/android.js.\n' +
    "require('./src/tv-service/android.js').run(process.argv.slice(2));\n");
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: APP_ID, version: version, private: true, main: 'main.js',
    description: 'game-to-tv: servidor de juegos dentro de la tele (Android)'
  }, null, 2) + '\n');
  let files = listFiles(dir).filter(function (f) { return f !== 'files.txt' && f !== 'bundle.json'; });
  const bytes = files.reduce(function (n, f) { return n + fs.statSync(path.join(dir, f)).size; }, 0);
  fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify({
    version: version, commit: opts.commit || null, builtAt: new Date().toISOString(), files: files.length, bytes: bytes
  }, null, 2) + '\n');
  files = files.concat(['bundle.json']).sort();
  fs.writeFileSync(path.join(dir, 'files.txt'), files.join('\n') + '\n');
  return { dir: dir, files: files, bytes: bytes, modules: copied.modules };
}

module.exports = { APP_ID: APP_ID, buildAndroidBundle: buildAndroidBundle, listFiles: listFiles };
