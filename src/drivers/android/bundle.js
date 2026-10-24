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
 *   bundle.json    { version, pkg, build, minApp, commit, builtAt, files, bytes }
 *
 * The bundle «version» is package.json's version plus the build number, the
 * UTC time of the commit as YYYYMMDDHHMMSS (0.8.0+20261024153012): later
 * commits give bigger builds, and the app compares builds to decide whether a
 * downloaded bundle is newer than the one inside its APK (automatic updates,
 * docs/tele-android.md). minApp comes from apps/android-tv/bundle-contract.json.
 *
 * The same folder, zipped, is what CI publishes for the automatic updates
 * (packOta: bundle.zip + bundle.json on the «apk» branch).
 *
 * No CLI, drivers, tests or docs. The Gradle build runs it through
 * scripts/android-bundle.js.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const webosBundle = require('../webos/bundle');
const zip = require('./zip');

const APP_ID = 'io.gametotv.android';
const ROOT = path.join(__dirname, '..', '..', '..');
const CONTRACT_FILE = path.join(ROOT, 'apps', 'android-tv', 'bundle-contract.json');

function rmrf(dir) {
  try {
    if (fs.rmSync) fs.rmSync(dir, { recursive: true, force: true });
    else fs.rmdirSync(dir, { recursive: true });
  } catch (e) { /* noop */ }
}

const listFiles = zip.listFiles;

/** minApp of the Node <-> Java contract (apps/android-tv/bundle-contract.json). */
function contract() {
  try {
    const c = JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8'));
    return { minApp: Number(c.minApp) || 0 };
  } catch (e) {
    return { minApp: 0 };
  }
}

/** Date -> YYYYMMDDHHMMSS (UTC) as a number. */
function buildNumber(date) {
  const s = new Date(date).toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  return Number(s);
}

/** { build, commit } of the checkout's HEAD (commit time, UTC), or nulls without git. */
function gitBuild(cwd) {
  try {
    const out = execFileSync('git', ['show', '-s', '--format=%ct %H', 'HEAD'], { cwd: cwd || ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(' ');
    const ct = Number(out[0]);
    return { build: ct > 0 ? buildNumber(ct * 1000) : null, commit: out[1] || null };
  } catch (e) {
    return { build: null, commit: null };
  }
}

/**
 * opts: { outDir (required, emptied first), version, commit, build, minApp }
 * -> { dir, files, bytes, modules, meta }
 */
function buildAndroidBundle(opts) {
  opts = opts || {};
  if (!opts.outDir) throw new Error('Falta outDir');
  const dir = path.resolve(opts.outDir);
  const version = opts.version || require('../../../package.json').version;
  const git = (opts.build == null || opts.commit === undefined) ? gitBuild() : {};
  const build = opts.build != null ? Number(opts.build) : (git.build || 0);
  const commit = opts.commit !== undefined ? opts.commit : (git.commit || null);
  const minApp = opts.minApp != null ? Number(opts.minApp) : contract().minApp;
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
  const meta = {
    version: version + '+' + build, pkg: version, build: build, minApp: minApp,
    commit: commit || null, builtAt: new Date().toISOString(), files: files.length, bytes: bytes
  };
  fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(meta, null, 2) + '\n');
  files = files.concat(['bundle.json']).sort();
  fs.writeFileSync(path.join(dir, 'files.txt'), files.join('\n') + '\n');
  return { dir: dir, files: files, bytes: bytes, modules: copied.modules, meta: meta };
}

/**
 * The automatic update of the app: zips a built nodejs-project folder
 * (exactly the one that went into the APK) as OUT/bundle.zip and writes
 * OUT/bundle.json { version, pkg, build, built, sha256, size, minApp, commit, files }.
 * opts: { projectDir, outDir } -> that manifest
 */
function packOta(opts) {
  const dir = path.resolve(opts.projectDir);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8'));
  if (!meta.version || !meta.build) throw new Error('bundle.json sin versión o sin build en ' + dir);
  if (!fs.existsSync(path.join(dir, 'main.js'))) throw new Error('Falta main.js en ' + dir);
  const body = zip.zipDir(dir);
  const out = path.resolve(opts.outDir);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'bundle.zip'), body);
  const manifest = {
    version: meta.version,
    pkg: meta.pkg,
    build: meta.build,
    built: meta.builtAt,
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    size: body.length,
    minApp: meta.minApp,
    commit: meta.commit,
    files: listFiles(dir).length
  };
  fs.writeFileSync(path.join(out, 'bundle.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

module.exports = {
  APP_ID: APP_ID, buildAndroidBundle: buildAndroidBundle, packOta: packOta, listFiles: listFiles,
  contract: contract, buildNumber: buildNumber, gitBuild: gitBuild
};
