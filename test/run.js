'use strict';
/*
 * `npm test`: runs every test/*.test.js in its own process (one after the
 * other: some start servers on fixed test ports) and sums the results.
 * The headless-browser smoke test is separate: `npm run test:browser`.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const only = process.argv.slice(2);
const files = fs.readdirSync(__dirname).filter(function (f) { return /\.test\.js$/.test(f); })
  .filter(function (f) { return !only.length || only.some(function (o) { return f.indexOf(o) >= 0; }); })
  .sort();

function runOne(file) {
  return new Promise(function (resolve) {
    const t0 = Date.now();
    const p = spawn(process.execPath, [path.join(__dirname, file)], { stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { NO_COLOR: '1' }) });
    let out = '';
    p.stdout.on('data', function (d) { out += d; process.stdout.write(d); });
    p.stderr.on('data', function (d) { out += d; process.stderr.write(d); });
    p.on('exit', function (code) {
      const m = /Resultado: (\d+) OK, (\d+) fallos/.exec(out);
      resolve({ file: file, code: code, ok: m ? +m[1] : 0, failed: m ? +m[2] : (code ? 1 : 0), secs: Math.round((Date.now() - t0) / 1000) });
    });
  });
}

(async function () {
  const results = [];
  for (const f of files) {
    console.log('\n######## ' + f + ' ########');
    results.push(await runOne(f));
  }
  console.log('\n======== Resumen ========');
  let ok = 0, failed = 0;
  results.forEach(function (r) {
    ok += r.ok;
    failed += r.failed + (r.code && !r.failed ? 1 : 0);
    console.log('  ' + (r.code ? 'FALLO ' : 'OK    ') + r.file + ': ' + r.ok + ' OK, ' + r.failed + ' fallos (' + r.secs + ' s)');
  });
  console.log('\n  Total: ' + ok + ' comprobaciones OK, ' + failed + ' fallos\n');
  process.exit(failed ? 1 : 0);
})();
