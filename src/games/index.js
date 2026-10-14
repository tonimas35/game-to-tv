'use strict';
/*
 * Game registry. Every folder in src/games/ with a manifest.json and an
 * index.js is a game:
 *
 *   src/games/<id>/
 *     manifest.json   id, title, description, minPlayers, maxPlayers, tags, icon...
 *     index.js        server side: module.exports = { create(api), lobby? }
 *     tv.js           TV view (loaded by public/tv.html)
 *     phone.js        phone view (loaded by public/m.html)
 *     tv.css / phone.css / icon.svg   optional
 *
 * A game can belong to a menu section (manifest "section": "1vs1"): the TV
 * and phone menus then show it inside that section instead of in the main
 * list. The known sections are in SECTIONS below.
 *
 * See docs/crear-un-juego.md.
 */
const fs = require('fs');
const path = require('path');

const GAMES_DIR = __dirname;
// Files of a game folder that the browser may download
const CLIENT_FILES = /^(tv|phone)\.(js|css)$|^icon\.(svg|png)$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// Menu sections. A section only shows up when at least one game declares it.
// order: where its card goes in the main row, among the games' "order"
// values (Dibuja 10, Pong 20, El Infiltrado 30, 2048 40, Reflejos 90).
const SECTIONS = {
  '1vs1': {
    id: '1vs1',
    title: '1 contra 1',
    subtitle: 'Duelos rápidos para dos',
    phoneSubtitle: 'Duelos rápidos para dos',
    accent: '#ffd23e',
    order: 15
  }
};

function validateManifest(m, dirName) {
  const errs = [];
  if (!m || typeof m !== 'object') return ['manifest.json no es un objeto'];
  if (!ID_RE.test(String(m.id || ''))) errs.push('id inválido (minúsculas, números y guiones)');
  if (m.id !== dirName) errs.push('el id («' + m.id + '») debe coincidir con el nombre de la carpeta («' + dirName + '»)');
  if (!m.title || typeof m.title !== 'string') errs.push('falta title');
  if (!m.description || typeof m.description !== 'string') errs.push('falta description');
  if (!(m.minPlayers >= 1)) errs.push('minPlayers debe ser >= 1');
  if (!(m.maxPlayers >= m.minPlayers)) errs.push('maxPlayers debe ser >= minPlayers');
  if (m.tags && !Array.isArray(m.tags)) errs.push('tags debe ser una lista');
  if (m.section != null && !Object.prototype.hasOwnProperty.call(SECTIONS, m.section)) {
    errs.push('section desconocida («' + m.section + '»); valores posibles: ' + Object.keys(SECTIONS).map(function (k) { return '«' + k + '»'; }).join(', '));
  }
  return errs;
}

function loadGame(dir) {
  const dirName = path.basename(dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const errs = validateManifest(manifest, dirName);
  if (errs.length) throw new Error('Juego «' + dirName + '»: ' + errs.join('; '));
  const mod = require(path.join(dir, 'index.js'));
  if (typeof mod.create !== 'function') throw new Error('Juego «' + dirName + '»: index.js debe exportar create(api)');
  const files = fs.readdirSync(dir);
  return {
    id: manifest.id,
    dir: dir,
    manifest: Object.assign({ tags: [], order: 100, accent: '#ffffff', icon: null, section: null, phoneDescription: manifest.description }, manifest),
    module: mod,
    client: {
      tvJs: files.indexOf('tv.js') >= 0,
      tvCss: files.indexOf('tv.css') >= 0,
      phoneJs: files.indexOf('phone.js') >= 0,
      phoneCss: files.indexOf('phone.css') >= 0
    }
  };
}

/** Loads every game found in the given folders (default: src/games). */
function loadGames(dirs, log) {
  dirs = dirs && dirs.length ? dirs : [GAMES_DIR];
  log = log || function (s) { console.error(s); };
  const list = [];
  const byId = {};
  dirs.forEach(function (root) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
    entries.forEach(function (ent) {
      if (!ent.isDirectory()) return;
      const dir = path.join(root, ent.name);
      if (!fs.existsSync(path.join(dir, 'manifest.json'))) return;
      try {
        const g = loadGame(dir);
        if (byId[g.id]) { log('Juego repetido, se ignora: ' + dir); return; }
        byId[g.id] = g;
        list.push(g);
      } catch (e) {
        log('No se pudo cargar el juego de ' + dir + ': ' + e.message);
      }
    });
  });
  list.sort(function (a, b) {
    return (a.manifest.order - b.manifest.order) || a.manifest.title.localeCompare(b.manifest.title, 'es');
  });
  return { list: list, byId: byId };
}

/** Public data about the games, for the TV and phone pages. */
function publicManifests(games) {
  return games.list.map(function (g) {
    const m = g.manifest;
    return {
      id: m.id,
      title: m.title,
      description: m.description,
      phoneDescription: m.phoneDescription,
      minPlayers: m.minPlayers,
      maxPlayers: m.maxPlayers,
      tags: m.tags,
      order: m.order,
      section: m.section || null,
      howTo: Array.isArray(m.howTo) ? m.howTo : null,
      accent: m.accent,
      icon: m.icon ? '/games/' + m.id + '/' + m.icon : null,
      client: g.client,
      tv: g.module.tvInfo || null
    };
  });
}

/**
 * The menu sections that have at least one game, for the TV and phone pages:
 * [{ id, title, subtitle, phoneSubtitle, accent, order, games: [ids in menu order] }]
 */
function publicSections(games) {
  const out = [];
  Object.keys(SECTIONS).forEach(function (k) {
    const ids = games.list.filter(function (g) { return g.manifest.section === k; }).map(function (g) { return g.id; });
    if (ids.length) out.push(Object.assign({}, SECTIONS[k], { games: ids }));
  });
  return out.sort(function (a, b) { return a.order - b.order; });
}

module.exports = {
  GAMES_DIR: GAMES_DIR, CLIENT_FILES: CLIENT_FILES, SECTIONS: SECTIONS,
  loadGames: loadGames, validateManifest: validateManifest, publicManifests: publicManifests, publicSections: publicSections
};
