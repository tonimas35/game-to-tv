'use strict';
/*
 * Fake games for the menu tests (they only exist in a temporary folder, never
 * in src/games): a manifest.json, an index.js that does nothing and an icon.
 * The server loads them with createServer({ gamesDirs: [GAMES_DIR, dir] }).
 * Must run on Node 12 too.
 */
const fs = require('fs');
const path = require('path');

// Four duels of the «1 contra 1» section
const DUELOS = [
  { id: 'prueba-duelo-a', title: 'Duelo Alfa', accent: '#22e6ff', order: 50 },
  { id: 'prueba-duelo-b', title: 'Duelo Beta', accent: '#ff3df2', order: 51 },
  { id: 'prueba-duelo-c', title: 'Duelo Gamma', accent: '#3ee07a', order: 52 },
  { id: 'prueba-duelo-d', title: 'Duelo Delta larguísimo', accent: '#ff8a3d', order: 53 }
].map(function (g) {
  return Object.assign({
    description: 'Juego de prueba de la sección «1 contra 1»: no existe de verdad, solo sirve para probar el menú.',
    phoneDescription: 'Juego de prueba de la sección «1 contra 1»',
    minPlayers: 2, maxPlayers: 2, tags: ['Prueba', 'A 5'], section: '1vs1'
  }, g);
});

const INDEX_JS = "'use strict';\n" +
  '// Fake game for the menu tests: it starts and does nothing.\n' +
  'module.exports = {\n' +
  '  create: function (api) {\n' +
  '    return {\n' +
  "      start: function () { api.sendTvs({ t: 'falso.start', game: api.gameId }); },\n" +
  '      stop: function () {},\n' +
  '      tick: function () {},\n' +
  '      onPlayerLeft: function () { return false; }\n' +
  '    };\n' +
  '  }\n' +
  '};\n';

function iconSvg(color) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 170"><rect x="40" y="35" width="90" height="100" rx="18" fill="' + color + '"/>' +
    '<rect x="170" y="35" width="90" height="100" rx="18" fill="none" stroke="' + color + '" stroke-width="10"/></svg>';
}

/**
 * Writes fake games into `dir` (created if needed) and returns `dir`.
 * list: manifests (default: DUELOS); `null` fields are left out.
 */
function writeFakeGames(dir, list) {
  (list || DUELOS).forEach(function (m) {
    const gdir = path.join(dir, m.id);
    fs.mkdirSync(gdir, { recursive: true });
    const manifest = Object.assign({ icon: 'icon.svg' }, m);
    Object.keys(manifest).forEach(function (k) { if (manifest[k] === null) delete manifest[k]; });
    fs.writeFileSync(path.join(gdir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(gdir, 'index.js'), INDEX_JS);
    fs.writeFileSync(path.join(gdir, 'icon.svg'), iconSvg(m.accent || '#ffffff'));
  });
  return dir;
}

module.exports = { DUELOS: DUELOS, writeFakeGames: writeFakeGames };
