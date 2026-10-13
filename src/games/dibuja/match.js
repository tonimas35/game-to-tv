'use strict';
/*
 * Answer matching for «Dibuja y adivina» (generous on purpose):
 *  - lower case, no accents or diaeresis (é→e, ü→u, ñ→n)
 *  - no punctuation; hyphens = spaces; collapsed spaces
 *  - no leading article (el, la, los, las, un, una, unos, unas)
 *  - exact => correct
 *  - Levenshtein distance <= 1 if the word has >= 5 letters,
 *    <= 2 if it has >= 9 letters => correct
 *  - one more unit of distance => «¡Casi!»
 */

const ARTICLES = /^(el|la|los|las|un|una|unos|unas)\s+/;

function stripAccents(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalize(s) {
  let t = stripAccents(String(s == null ? '' : s).toLowerCase());
  t = t.replace(/[^a-z0-9\s-]/g, ' ').replace(/-/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(ARTICLES, '');
  return t;
}

function compact(s) { return s.replace(/\s+/g, ''); }

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[b.length];
}

function tolerance(len) {
  if (len >= 9) return 2;
  if (len >= 5) return 1;
  return 0;
}

/** Devuelve 'ok', 'casi' o 'no'. */
function judge(guess, target) {
  const g = normalize(guess);
  const t = normalize(target);
  if (!g || !t) return 'no';
  const gc = compact(g);
  const tc = compact(t);
  if (g === t || gc === tc) return 'ok';
  const tol = tolerance(tc.length);
  const d = levenshtein(gc, tc);
  if (d <= tol) return 'ok';
  if (d === tol + 1) return 'casi';
  // Pistas de «casi» adicionales para expresiones de varias palabras:
  // el intento contiene la respuesta entera, o es una de sus palabras largas.
  const gTokens = g.split(' ');
  const tTokens = t.split(' ');
  if (tTokens.length > 1 && gTokens.length < tTokens.length && gc.length >= 4) {
    for (let i = 0; i < tTokens.length; i++) if (tTokens[i].length >= 4 && tTokens[i] === g) return 'casi';
  }
  if (gTokens.length > tTokens.length && (' ' + g + ' ').indexOf(' ' + t + ' ') >= 0) return 'casi';
  return 'no';
}

module.exports = { normalize: normalize, judge: judge, levenshtein: levenshtein, stripAccents: stripAccents };
