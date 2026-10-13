'use strict';
/*
 * Part of `npm run check`: everything that runs inside the LG TV («modo
 * tele») must work on the TV's Node.js, which is v12.21.0 on webOS 22.
 *
 * It builds the real service folder (src/drivers/webos/bundle.js), so what
 * is checked is exactly what is shipped, and for every server-side .js file:
 *  1) strict ES2019 parse with acorn (no ?. / ??, no ||= / ??=, no class
 *     fields, no top-level await, no numeric separators…)
 *  2) our own code: no APIs that Node 12 lacks (fs.rm, fetch, AbortController,
 *     structuredClone, Array.prototype.at, replaceAll, Object.hasOwn,
 *     crypto.randomUUID, require('node:…'), fs/promises…)
 *  3) the shipped package.json files: no dependency declares it needs a
 *     newer Node than 12 unless it is in KNOWN_OK (verified on Node 12)
 * The browser-side files (public/, games' tv.js/phone.js) are checked by
 * scripts/check-browser-js.js. The real proof is test/tele.test.js, which
 * boots the packaged service (and on Node 12 too if G2T_NODE12 points to a
 * Node 12 binary).
 *
 *   node scripts/check-node12.js [--dir CARPETA-DEL-SERVICIO]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let acorn = null;
try { acorn = require('acorn'); } catch (e) { /* devDependency */ }

const BANNED = [
  { re: /\?\?|\?\.[a-zA-Z_$(\[]/, why: 'operador ?? o ?. (Node 14+)' },
  { re: /\|\|=|&&=|\?\?=/, why: 'asignación lógica ||= &&= ??= (Node 15+)' },
  { re: /\bstructuredClone\s*\(/, why: 'structuredClone (Node 17+)' },
  { re: /\.at\(\s*-?[\w.]+\s*\)/, why: 'Array/String.prototype.at (Node 16.6+)' },
  { re: /\breplaceAll\s*\(/, why: 'String.prototype.replaceAll (Node 15+)' },
  { re: /\bObject\.hasOwn\s*\(/, why: 'Object.hasOwn (Node 16.9+)' },
  { re: /\brandomUUID\s*\(/, why: 'crypto.randomUUID (Node 14.17+): usa crypto.randomBytes' },
  { re: /\brmSync\s*\(|\b(fs|fsp|promises)\.rm\s*\(/, why: 'fs.rm / fs.rmSync (Node 14.14+): usa fs.rmdir / fs.unlink' },
  { re: /\bAbortController\b|\bAbortSignal\b/, why: 'AbortController (Node 15+)' },
  { re: /(^|[^.\w$])fetch\s*\(/, why: 'fetch (Node 18+)' },
  { re: /\bPromise\.any\s*\(|\bAggregateError\b/, why: 'Promise.any (Node 15+)' },
  { re: /\bfindLast(Index)?\s*\(|\.toSorted\s*\(|\.toReversed\s*\(|\bObject\.groupBy\b/, why: 'métodos de arrays de ES2023 (Node 18+)' },
  { re: /\bWeakRef\b|\bFinalizationRegistry\b/, why: 'WeakRef (Node 14.6+)' },
  { re: /require\(\s*['"]node:/, why: "require('node:…') (Node 14.18+)" },
  { re: /require\(\s*['"](fs|timers|stream|dns)\/promises['"]\s*\)/, why: "require('x/promises') (Node 14+): usa require('fs').promises" },
  { re: /['"]base64url['"]/, why: "codificación 'base64url' (Node 15.7+)" },
  { re: /\bavailableParallelism\s*\(|\bEventTarget\b|\bBroadcastChannel\b/, why: 'API de Node 15+' }
];

// Dependencies that declare engines > 12 but were verified on Node 12.22 (load, write and read PNGs)
const KNOWN_OK = { pngjs: '>=14.19.0' };

function rmrf(dir) {
  try {
    if (fs.rmSync) fs.rmSync(dir, { recursive: true, force: true });
    else fs.rmdirSync(dir, { recursive: true });
  } catch (e) { /* noop */ }
}

function walk(dir, base, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
    const rel = base ? base + '/' + d.name : d.name;
    if (d.isDirectory()) walk(path.join(dir, d.name), rel, out);
    else if (d.isFile()) out.push(rel);
  });
  return out;
}

// Browser-side code: checked (as ES2019 for Chromium 87) by check-browser-js.js
function isBrowserFile(rel) {
  return /^public\//.test(rel) || /^src\/games\/[^/]+\/(tv|phone)\.js$/.test(rel) || /\/browser\.js$/.test(rel) || /\.mjs$/.test(rel);
}

// Engines range that excludes Node 12 (only the simple forms npm packages use)
function needsNewerNode(range) {
  const m = /^\s*>=?\s*v?(\d+)/.exec(String(range || ''));
  return m ? Number(m[1]) > 12 : false;
}

function stripComments(code) {
  if (!acorn) return code;
  const ranges = [];
  try {
    acorn.parse(code, { ecmaVersion: 2019, sourceType: 'script', allowHashBang: true, onComment: function (block, text, start, end) { ranges.push([start, end]); } });
  } catch (e) { return code; }
  let out = '';
  let last = 0;
  ranges.forEach(function (r) {
    out += code.slice(last, r[0]) + code.slice(r[0], r[1]).replace(/[^\n]/g, ' ');
    last = r[1];
  });
  return out + code.slice(last);
}

function check(dir) {
  const problems = [];
  const files = walk(dir, '', []);
  let parsed = 0, scanned = 0;
  files.forEach(function (rel) {
    const file = path.join(dir, rel);
    if (/(^|\/)package\.json$/.test(rel)) {
      let p = {};
      try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { problems.push(rel + ': JSON no válido'); return; }
      const eng = p.engines && p.engines.node;
      if (eng && needsNewerNode(eng) && KNOWN_OK[p.name] !== eng) problems.push(rel + ': ' + p.name + ' pide Node ' + eng + ' (la tele tiene Node 12)');
      return;
    }
    if (!/\.js$/.test(rel) || isBrowserFile(rel)) return;
    const code = fs.readFileSync(file, 'utf8');
    if (acorn) {
      try {
        acorn.parse(code, { ecmaVersion: 2019, sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
        parsed++;
      } catch (e) {
        problems.push(rel + ': no es ES2019 (Node 12): ' + e.message);
      }
    }
    if (/(^|\/)node_modules\//.test(rel)) return;     // third-party code: syntax only (APIs are proven by test/tele.test.js)
    scanned++;
    stripComments(code).split('\n').forEach(function (line, i) {
      BANNED.forEach(function (b) {
        if (b.re.test(line)) problems.push(rel + ' línea ' + (i + 1) + ': ' + b.why);
      });
    });
  });
  if (files.some(function (f) { return /(^|\/)node_modules\/webos-service\//.test(f); })) problems.push('webos-service no debe ir en el paquete (la tele tiene el suyo)');
  return { problems: problems, parsed: parsed, scanned: scanned, files: files.length };
}

function main() {
  const i = process.argv.indexOf('--dir');
  let dir = i > 0 ? path.resolve(process.argv[i + 1]) : null;
  let tmp = null;
  if (!dir) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g2t-node12-'));
    dir = path.join(tmp, 'svc');
    require('../src/drivers/webos/bundle').buildService({ outDir: dir });
  }
  if (!acorn) console.log('  (acorn no está instalado: solo se buscan APIs; ejecuta npm install)');
  const r = check(dir);
  if (tmp) rmrf(tmp);
  r.problems.forEach(function (p) { console.log('  FAIL Node 12     ' + p); });
  console.log('  ' + (r.problems.length ? 'FAIL' : 'ok  ') + ' Node 12      servicio de la tele: ' + r.parsed + ' archivos .js de servidor en ES2019, ' +
    r.scanned + ' propios sin APIs nuevas (' + r.files + ' archivos en el paquete)');
  if (r.problems.length) { console.log('\n' + r.problems.length + ' problema(s) para Node 12'); process.exit(1); }
  console.log('\nTodo el código del servidor que va dentro de la tele es compatible con Node 12.');
}

if (require.main === module) main();
module.exports = { check: check, BANNED: BANNED, needsNewerNode: needsNewerNode };
