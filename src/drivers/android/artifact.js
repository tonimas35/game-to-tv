'use strict';
/*
 * The Android app's APKs come from GitHub Actions (.github/workflows/android.yml,
 * artifact «juegos-del-salon-android»: one APK per ABI plus a universal one).
 *
 *  - findApks(dir)          the .apk files of a folder (an unzipped artifact)
 *  - pickApk(apks, abis)    the best one for the TV's ABI list (ro.product.cpu.abilist)
 *  - unzip(zipFile, dir)    minimal unzip (stored/deflate), for the artifact .zip
 *  - downloadLatest(opts)   latest non-expired artifact through the GitHub REST
 *                           API. Listing is public, but GitHub only lets you
 *                           DOWNLOAD artifacts with a token: GITHUB_TOKEN /
 *                           GH_TOKEN, or `gh auth token` if the GitHub CLI is
 *                           logged in. Without one, manualSteps() says how to
 *                           get it from the web.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const http = require('http');
const { spawnSync } = require('child_process');

const REPO = 'tonimas35/game-to-tv';
const ARTIFACT = 'juegos-del-salon-android';
const APP_ID = 'io.gametotv.android';

function repo() { return process.env.GAME_TO_TV_REPO || REPO; }
function apiBase() { return (process.env.GAME_TO_TV_GITHUB_API || 'https://api.github.com').replace(/\/$/, ''); }

/** APK files directly in dir (and one level down). */
function findApks(dir) {
  const out = [];
  function scan(d, depth) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    list.forEach(function (e) {
      const f = path.join(d, e.name);
      if (e.isFile() && /\.apk$/i.test(e.name)) out.push(f);
      else if (e.isDirectory() && depth < 1) scan(f, depth + 1);
    });
  }
  scan(dir, 0);
  return out.sort();
}

/**
 * The APK for this TV: the first ABI of its list that has its own APK, then
 * the universal one, then whatever there is. abis: ['armeabi-v7a', 'armeabi'].
 */
function pickApk(apks, abis) {
  abis = abis || [];
  for (let i = 0; i < abis.length; i++) {
    const abi = abis[i];
    if (!abi) continue;
    const hit = apks.filter(function (f) { return path.basename(f).indexOf('-' + abi + '.apk') >= 0 || path.basename(f).indexOf('-' + abi + '-') >= 0; })[0];
    if (hit) return { apk: hit, abi: abi };
  }
  const uni = apks.filter(function (f) { return /universal/i.test(path.basename(f)); })[0];
  if (uni) return { apk: uni, abi: 'universal' };
  return apks.length ? { apk: apks[0], abi: null } : null;
}

/** Version from the file name: juegos-del-salon-0.7.0-armeabi-v7a.apk -> '0.7.0' */
function versionOf(apk) {
  const m = /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(?:armeabi|arm64|x86|universal)/.exec(path.basename(apk || ''));
  return m ? m[1] : null;
}

/** Minimal unzip: stored (0) and deflate (8) entries. Returns the written files. */
function unzip(zipFile, outDir) {
  const buf = fs.readFileSync(zipFile);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('No es un zip válido: ' + zipFile);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const written = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Zip dañado (directorio central)');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (/\/$/.test(name)) continue;
    const clean = name.split(/[\\/]+/).filter(function (s) { return s && s !== '.' && s !== '..'; }).join(path.sep);
    if (!clean) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('Zip dañado (cabecera local)');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.slice(start, start + csize);
    let content;
    if (method === 0) content = data;
    else if (method === 8) content = zlib.inflateRawSync(data);
    else throw new Error('Compresión no soportada (' + method + ') en ' + name);
    const out = path.join(outDir, clean);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, content);
    written.push(out);
  }
  return written;
}

/** A GitHub token from the environment or from `gh auth token`, or null. */
function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GAME_TO_TV_NO_GH) return null;
  try {
    const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const t = r.status === 0 ? String(r.stdout || '').trim() : '';
    return t || null;
  } catch (e) { return null; }
}

/** GET with redirects. Resolves { status, headers, body: Buffer }. The token is only sent to the API host. */
function get(url, token, redirects) {
  redirects = redirects || 0;
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const headers = { 'User-Agent': 'game-to-tv', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token && u.host === new URL(apiBase()).host) headers.Authorization = 'Bearer ' + token;
    const req = lib.get(u, { headers: headers, timeout: 60000 }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), token, redirects + 1));
      }
      const chunks = [];
      res.on('data', function (d) { chunks.push(d); });
      res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
      res.on('error', reject);
    });
    req.on('timeout', function () { req.destroy(new Error('GitHub no responde (' + u.host + ')')); });
    req.on('error', reject);
  });
}

/** How to get the APK by hand (Spanish). */
function manualSteps(tvName) {
  return [
    'Descarga la app a mano (hace falta iniciar sesión en GitHub):',
    '  1. Abre https://github.com/' + repo() + '/actions/workflows/android.yml',
    '  2. Entra en la última ejecución en verde y, abajo, en «Artifacts», descarga «' + ARTIFACT + '» (un .zip).',
    '  3. Instálala: game-to-tv tv install ' + (tvName || 'NOMBRE') + ' --apk RUTA-DEL-ZIP   (vale el .zip, la carpeta o un .apk)',
    'O deja que lo descargue game-to-tv: inicia sesión con «gh auth login» (GitHub CLI) o pon un token en GITHUB_TOKEN.'
  ].join('\n');
}

/**
 * Downloads and unzips the newest non-expired artifact (main branch first).
 * opts: { destRoot, token, branch, log } -> { dir, apks, artifact: { id, created_at, branch, run } }
 */
async function downloadLatest(opts) {
  opts = opts || {};
  const log = opts.log || function () {};
  const list = await get(apiBase() + '/repos/' + repo() + '/actions/artifacts?name=' + ARTIFACT + '&per_page=50', opts.token);
  if (list.status !== 200) throw Object.assign(new Error('GitHub ha respondido ' + list.status + ' al buscar la app.'), { code: 'EGITHUB' });
  let arts = [];
  try { arts = JSON.parse(list.body.toString('utf8')).artifacts || []; } catch (e) { /* noop */ }
  arts = arts.filter(function (a) { return a && !a.expired && a.name === ARTIFACT; });
  arts.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
  const branch = opts.branch || process.env.GAME_TO_TV_BRANCH || 'main';
  const art = arts.filter(function (a) { return a.workflow_run && a.workflow_run.head_branch === branch; })[0] || arts[0];
  if (!art) throw Object.assign(new Error('No hay ninguna compilación de la app en GitHub Actions (o han caducado).'), { code: 'ENOARTIFACT' });
  const info = { id: art.id, created_at: art.created_at, branch: art.workflow_run ? art.workflow_run.head_branch : null, run: art.workflow_run ? art.workflow_run.id : null, size: art.size_in_bytes };
  if (info.branch !== branch) log('Aviso: no hay compilación de la rama «' + branch + '»; uso la de «' + info.branch + '».');
  const token = opts.token !== undefined ? opts.token : githubToken();
  if (!token) throw Object.assign(new Error('GitHub solo deja descargar la app con una sesión iniciada.\n\n' + manualSteps(opts.tvName)), { code: 'ENOTOKEN' });
  log('Descargando la app de GitHub Actions (artefacto ' + art.id + ', ' + String(art.created_at).slice(0, 10) + ', ' + Math.round((art.size_in_bytes || 0) / 1048576) + ' MB)…');
  const zip = await get(art.archive_download_url || (apiBase() + '/repos/' + repo() + '/actions/artifacts/' + art.id + '/zip'), token);
  if (zip.status !== 200) {
    throw Object.assign(new Error('GitHub ha respondido ' + zip.status + ' al descargar la app' + (zip.status === 401 || zip.status === 403 ? ' (¿token sin permiso o caducado?)' : '') + '.\n\n' + manualSteps(opts.tvName)), { code: 'EGITHUB' });
  }
  const dir = path.join(opts.destRoot, 'artefacto-' + art.id);
  fs.mkdirSync(dir, { recursive: true });
  const zipFile = path.join(dir, ARTIFACT + '.zip');
  fs.writeFileSync(zipFile, zip.body);
  unzip(zipFile, dir);
  return { dir: dir, apks: findApks(dir), artifact: info };
}

module.exports = {
  REPO: REPO, ARTIFACT: ARTIFACT, APP_ID: APP_ID,
  findApks: findApks, pickApk: pickApk, versionOf: versionOf, unzip: unzip, githubToken: githubToken,
  downloadLatest: downloadLatest, manualSteps: manualSteps
};
