#!/usr/bin/env node
'use strict';
require('../src/cli').main(process.argv.slice(2)).then(function (code) {
  if (typeof code === 'number') process.exitCode = code;
}, function (err) {
  const text = String(err && err.message ? err.message : err).split('\n').join('\n  ');
  console.error('\n  Error: ' + text + '\n');
  if (process.env.G2T_DEBUG && err && err.stack) console.error(err.stack);
  process.exitCode = 1;
});
