#!/usr/bin/env node
'use strict';
/*
 * Builds the Node.js project of the Android TV app (see
 * src/drivers/android/bundle.js). Run by apps/android-tv/app/build.gradle:
 *
 *   node scripts/android-bundle.js OUT_DIR [--commit SHA]
 */
const { buildAndroidBundle } = require('../src/drivers/android/bundle');

const args = process.argv.slice(2);
const out = args.filter(function (a, i) { return a.indexOf('--') !== 0 && (i === 0 || args[i - 1] !== '--commit'); })[0];
const ci = args.indexOf('--commit');
if (!out) {
  console.error('Uso: node scripts/android-bundle.js CARPETA-DE-SALIDA [--commit SHA]');
  process.exit(2);
}
const r = buildAndroidBundle({ outDir: out, commit: ci >= 0 ? args[ci + 1] : process.env.GITHUB_SHA });
console.log('Proyecto de Node para Android: ' + r.dir + ' (' + r.files.length + ' archivos, ' + Math.round(r.bytes / 1024) + ' KB; ' +
  r.modules.map(function (m) { return m.name + '@' + m.version; }).join(', ') + ')');
