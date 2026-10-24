#!/usr/bin/env node
'use strict';
/*
 * Builds the Node.js project of the Android TV app (see
 * src/drivers/android/bundle.js). Run by apps/android-tv/app/build.gradle:
 *
 *   node scripts/android-bundle.js OUT_DIR [--commit SHA] [--build N] [--min-app N]
 *
 * Automatic updates (CI, .github/workflows/android.yml): zips a built project
 * folder into OUT/bundle.zip + OUT/bundle.json
 *
 *   node scripts/android-bundle.js --ota OUT --from PROJECT_DIR
 */
const { buildAndroidBundle, packOta } = require('../src/drivers/android/bundle');

const args = process.argv.slice(2);
const VALUED = ['--commit', '--build', '--min-app', '--ota', '--from'];
function opt(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
const positional = args.filter(function (a, i) { return a.indexOf('--') !== 0 && (i === 0 || VALUED.indexOf(args[i - 1]) < 0); });

if (opt('--ota')) {
  if (!opt('--from')) {
    console.error('Uso: node scripts/android-bundle.js --ota CARPETA-DE-SALIDA --from CARPETA-DEL-PROYECTO');
    process.exit(2);
  }
  const m = packOta({ projectDir: opt('--from'), outDir: opt('--ota') });
  console.log('Paquete de juegos para actualizar la app: ' + m.version + ' (' + m.files + ' archivos, ' + Math.round(m.size / 1024) + ' KB, minApp ' + m.minApp + ', sha256 ' + m.sha256 + ')');
  process.exit(0);
}

const out = positional[0];
if (!out) {
  console.error('Uso: node scripts/android-bundle.js CARPETA-DE-SALIDA [--commit SHA] [--build N] [--min-app N]');
  process.exit(2);
}
const r = buildAndroidBundle({
  outDir: out,
  commit: opt('--commit') || process.env.GITHUB_SHA || undefined,
  build: opt('--build') != null ? Number(opt('--build')) : undefined,
  minApp: opt('--min-app') != null ? Number(opt('--min-app')) : undefined
});
console.log('Proyecto de Node para Android: ' + r.dir + ' (' + r.meta.version + ', ' + r.files.length + ' archivos, ' + Math.round(r.bytes / 1024) + ' KB; ' +
  r.modules.map(function (m) { return m.name + '@' + m.version; }).join(', ') + ')');
