'use strict';
/*
 * Tiny argument parser: positional arguments and --flags.
 *   --port 3000   --port=3000   --solo-ipk (boolean)   -h
 * Flags listed in `booleans` never take the next argument as their value.
 */
function parseArgs(argv, booleans) {
  booleans = booleans || [];
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push.apply(out._, argv.slice(i + 1)); break; }
    if (/^--[^=]+=/.test(a)) {
      const k = a.slice(2, a.indexOf('='));
      out.flags[k] = a.slice(a.indexOf('=') + 1);
    } else if (a.indexOf('--') === 0 && a.length > 2) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (booleans.indexOf(k) < 0 && next !== undefined && next.indexOf('-') !== 0) {
        out.flags[k] = next;
        i++;
      } else {
        out.flags[k] = true;
      }
    } else if (a === '-h') {
      out.flags.help = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

module.exports = { parseArgs: parseArgs };
