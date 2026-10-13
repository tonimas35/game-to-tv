'use strict';
/*
 * `npm run check`: every piece of JavaScript that runs in a browser (TV or
 * phone) must be plain ES2019, because the LG webOS 22 engine is Chromium 87
 * and phones may run older Safari versions.
 *
 *  1) node --check on every script
 *  2) strict ES2019 parse with acorn
 *  3) search for APIs that are too new (and CSS that Chromium 87 lacks)
 *  4) no external resources (CDNs): everything must work offline on the LAN
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let acorn = null;
try { acorn = require('acorn'); } catch (e) { /* optional */ }

const ROOT = path.join(__dirname, '..');
const BANNED = [
  { re: /\bstructuredClone\s*\(/, why: 'structuredClone' },
  { re: /\.at\(\s*-?\d+\s*\)/, why: 'Array.prototype.at' },
  { re: /\breplaceAll\s*\(/, why: 'String.prototype.replaceAll' },
  { re: /\.roundRect\s*\(/, why: 'ctx.roundRect (Chromium 99+)' },
  { re: /\?\?|\?\.[a-zA-Z_$(\[]/, why: 'operador ?? o ?. (ES2020)' },
  { re: /\bPromise\.any\s*\(/, why: 'Promise.any (ES2021)' },
  { re: /\bString\.prototype\.at\b|\bfindLast\s*\(/, why: 'findLast / at (ES2022)' }
];
const BANNED_CSS = [
  { re: /\baspect-ratio\s*:/, why: 'CSS aspect-ratio (Chromium 88+)' },
  { re: /:has\(/, why: 'CSS :has() (Chromium 105+)' },
  { re: /(^|[;{\s])inset\s*:/, why: 'CSS inset (Safari < 14.1 no lo tiene)' }
];

function listFiles() {
  const out = [];
  const pub = path.join(ROOT, 'public');
  fs.readdirSync(pub).forEach(function (f) { if (f.endsWith('.html')) out.push(path.join(pub, f)); });
  fs.readdirSync(path.join(pub, 'lib')).forEach(function (f) { if (/\.(js|css)$/.test(f)) out.push(path.join(pub, 'lib', f)); });
  const games = path.join(ROOT, 'src', 'games');
  fs.readdirSync(games, { withFileTypes: true }).forEach(function (d) {
    if (!d.isDirectory()) return;
    fs.readdirSync(path.join(games, d.name)).forEach(function (f) {
      if (/^(tv|phone)\.(js|css)$/.test(f)) out.push(path.join(games, d.name, f));
    });
  });
  const launcher = path.join(ROOT, 'apps', 'webos-launcher', 'index.html');
  if (fs.existsSync(launcher)) out.push(launcher);
  return out;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g2t-check-'));
let failures = 0;
let n = 0;

function checkJs(code, label) {
  n++;
  const out = path.join(tmpDir, 'script-' + n + '.js');
  fs.writeFileSync(out, code);
  try {
    execFileSync(process.execPath, ['--check', out], { stdio: 'pipe' });
    console.log('  ok  node --check  ' + label + ' (' + code.length + ' caracteres)');
  } catch (e) {
    failures++;
    console.log('  FAIL node --check ' + label + '\n' + e.stderr.toString());
  }
  if (acorn) {
    try {
      acorn.parse(code, { ecmaVersion: 2019, sourceType: 'script' });
      console.log('  ok  ES2019       ' + label);
    } catch (e) {
      failures++;
      console.log('  FAIL ES2019      ' + label + ': ' + e.message);
    }
  }
  code.split('\n').forEach(function (line, i) {
    BANNED.forEach(function (b) {
      if (b.re.test(line)) { failures++; console.log('  FAIL API nueva   ' + label + ' línea ' + (i + 1) + ': ' + b.why); }
    });
  });
}

function checkCss(css, label) {
  BANNED_CSS.forEach(function (b) {
    if (b.why && b.re.test(css)) { failures++; console.log('  FAIL CSS ' + label + ': ' + b.why); }
  });
}

function checkNoCdn(text, label) {
  const clean = text.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/(src|href)\s*=\s*["']https?:\/\//i.test(clean) || /@import\s+url\(\s*["']?https?:/i.test(clean)) {
    failures++;
    console.log('  FAIL ' + label + ' carga recursos externos (CDN): todo debe funcionar sin Internet');
  }
}

listFiles().forEach(function (file) {
  const rel = path.relative(ROOT, file);
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.js')) {
    checkJs(text, rel);
  } else if (file.endsWith('.css')) {
    checkCss(text, rel);
    console.log('  ok  CSS          ' + rel);
  } else {
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    let k = 0;
    while ((m = re.exec(text))) {
      if (/\bsrc\s*=/.test(m[1])) continue; // shared files are checked on their own
      k++;
      checkJs(m[2], rel + ' #' + k);
    }
    const styles = text.match(/<style>[\s\S]*?<\/style>/g) || [];
    styles.forEach(function (css) { checkCss(css, rel); });
    if (!k) console.log('  -   ' + rel + ': sin scripts inline');
    checkNoCdn(text, rel);
  }
});

fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures) { console.log('\n' + failures + ' problema(s) encontrado(s)'); process.exit(1); }
console.log('\nTodo el JavaScript del navegador es válido (ES2019) y no usa recursos externos.');
