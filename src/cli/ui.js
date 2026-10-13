'use strict';
// Terminal helpers: colors (off with NO_COLOR or when not a TTY) and boxes.

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
function wrap(code) { return function (s) { return useColor ? '\u001b[' + code + 'm' + s + '\u001b[0m' : String(s); }; }

const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  cyan: wrap('36'),
  magenta: wrap('35')
};

function ok(s) { console.log('  ' + c.green('✔') + ' ' + s); }
function warn(s) { console.log('  ' + c.yellow('!') + ' ' + s); }
function fail(s) { console.log('  ' + c.red('✘') + ' ' + s); }
function info(s) { console.log('  ' + s); }

// A big framed message (e.g. «accept on the TV»)
function box(lines) {
  const width = Math.max.apply(null, lines.map(function (l) { return Array.from(l).length; })) + 4;
  const bar = '═'.repeat(width);
  console.log('');
  console.log('  ╔' + bar + '╗');
  lines.forEach(function (l) {
    console.log('  ║  ' + c.bold(l) + ' '.repeat(width - 2 - Array.from(l).length) + '║');
  });
  console.log('  ╚' + bar + '╝');
  console.log('');
}

module.exports = { c: c, ok: ok, warn: warn, fail: fail, info: info, box: box };
