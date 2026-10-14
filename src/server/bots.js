'use strict';
/*
 * «Rivales bot»: the levels and the names of the computer opponents.
 * The hub (hub.js) runs them; each game that supports them ships its own
 * src/games/<id>/bot.js (see docs/crear-un-juego.md, «Rivales bot»).
 * Must run on Node 12 (modo tele).
 */

// value: 0..1, the same scale for every game (ctx.levelValue)
const LEVELS = [
  { id: 'facil', label: 'Fácil', value: 0.25, hint: 'Para empezar' },
  { id: 'normal', label: 'Normal', value: 0.5, hint: 'Un rival de verdad' },
  { id: 'dificil', label: 'Difícil', value: 0.75, hint: 'Hay que sudar' },
  { id: 'imposible', label: 'Imposible', value: 1, hint: 'No se deja ganar' }
];
const LEVEL_IDS = LEVELS.map(function (l) { return l.id; });
const DEFAULT_LEVEL = 'normal';

// Wii-style names: Spanish, short and a bit funny (at most 12 characters)
const NAMES = [
  'Paco', 'Lola', 'Maripili', 'Nacho', 'Rocío', 'Curro', 'Pepa', 'Manolo',
  'Chelo', 'Paquita', 'Juanito', 'Puri', 'Fermín', 'Encarna', 'Toñi', 'Quique',
  'Charo', 'Rafa', 'Merche', 'Loli', 'Conchi', 'Moncho', 'Chema', 'Nieves',
  'Tere', 'Pepe', 'Rosi', 'Chus', 'Kiko', 'Sole', 'Benito', 'Remedios',
  'Anselmo', 'Tini', 'Rufino', 'Tito', 'Lupe', 'Visi', 'Juanjo', 'Mari Carmen'
];

function levelById(id) {
  for (let i = 0; i < LEVELS.length; i++) if (LEVELS[i].id === id) return LEVELS[i];
  return null;
}
/** A valid level id or null. */
function cleanLevel(id) { return levelById(String(id == null ? '' : id)) ? String(id) : null; }
function levelValue(id) { const l = levelById(id); return l ? l.value : levelById(DEFAULT_LEVEL).value; }
function levelLabel(id) { const l = levelById(id); return l ? l.label : id; }

/**
 * The level a game will really use: `id` if the game has it (manifest
 * "botLevels", default all four), else the closest one it has.
 */
function nearestLevel(id, allowed) {
  if (!Array.isArray(allowed) || !allowed.length) return id;
  if (allowed.indexOf(id) >= 0) return id;
  const want = levelValue(id);
  let best = allowed[0];
  allowed.forEach(function (a) { if (Math.abs(levelValue(a) - want) < Math.abs(levelValue(best) - want)) best = a; });
  return best;
}

/** A random name that nobody in the room has (case and accents ignored). */
function pickName(taken, random) {
  random = random || Math.random;
  // No String#normalize: the TV's Node 12 may be built without full ICU
  const ACC = { 'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u', 'ü': 'u', 'ñ': 'n' };
  const norm = function (s) { return String(s || '').toLowerCase().replace(/[áéíóúüñ]/g, function (c) { return ACC[c]; }).trim(); };
  const used = {};
  (taken || []).forEach(function (n) { used[norm(n)] = true; });
  const free = NAMES.filter(function (n) { return !used[norm(n)]; });
  if (free.length) return free[Math.floor(random() * free.length) % free.length];
  for (let k = 2; ; k++) {
    for (let j = 0; j < NAMES.length; j++) {
      const n = NAMES[j] + ' ' + k;
      if (!used[norm(n)] && n.length <= 12) return n;
    }
  }
}

module.exports = {
  LEVELS: LEVELS, LEVEL_IDS: LEVEL_IDS, DEFAULT_LEVEL: DEFAULT_LEVEL, NAMES: NAMES,
  levelById: levelById, cleanLevel: cleanLevel, levelValue: levelValue, levelLabel: levelLabel,
  nearestLevel: nearestLevel, pickName: pickName
};
