'use strict';
/*
 * «2048»: best score («Récord») per player name, kept in
 * <dataDir>/records-2048.json (~/.game-to-tv in pc mode, a writable folder of
 * the TV in tele mode). If the folder is missing or cannot be written, the
 * records live in memory only (for as long as the server runs): the game
 * never fails because of it.
 */
const fs = require('fs');
const path = require('path');

const FILE = 'records-2048.json';
const MAX_ENTRIES = 300;

// One store per folder and process: records survive between matches
const stores = {};

function keyOf(name) {
  let s = String(name || '').trim().toLowerCase();
  // Node without ICU (some TVs) may lack normalize(): then accents count
  try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* noop */ }
  return s;
}

function createStore(dir, log) {
  log = log || function () {};
  const file = dir ? path.join(dir, FILE) : null;
  let data = {};          // key -> { name, best, at }
  let dirty = false;
  let failed = false;     // already said that it cannot be written

  if (file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && raw.records && typeof raw.records === 'object') {
        Object.keys(raw.records).forEach(function (k) {
          const r = raw.records[k];
          if (r && typeof r.best === 'number' && r.best >= 0) data[k] = { name: String(r.name || k).slice(0, 12), best: Math.floor(r.best), at: r.at || 0 };
        });
      }
    } catch (e) {
      if (e.code !== 'ENOENT') log('[2048] No se pueden leer los récords (' + file + '): ' + e.message);
    }
  }

  function get(name) {
    const r = data[keyOf(name)];
    return r ? r.best : 0;
  }

  // Returns true if it is a new record
  function update(name, score) {
    const k = keyOf(name);
    if (!k || !(score > 0)) return false;
    const r = data[k];
    if (r && r.best >= score) return false;
    data[k] = { name: String(name).slice(0, 12), best: Math.floor(score), at: Date.now() };
    dirty = true;
    return true;
  }

  function save() {
    if (!dirty || !file) return false;
    dirty = false;
    let keys = Object.keys(data);
    if (keys.length > MAX_ENTRIES) {
      keys.sort(function (a, b) { return (data[b].at || 0) - (data[a].at || 0); });
      keys.slice(MAX_ENTRIES).forEach(function (k) { delete data[k]; });
    }
    const tmp = file + '.' + process.pid + '.tmp';
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, records: data }, null, 1) + '\n');
      fs.renameSync(tmp, file);
      failed = false;
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { /* noop */ }
      if (!failed) log('[2048] No se pueden guardar los récords en ' + file + ' (' + (e.code || e.message) + '): se guardan solo en memoria');
      failed = true;
      return false;
    }
  }

  return { file: file, get: get, update: update, save: save, isDirty: function () { return dirty; } };
}

function storeFor(dir, log) {
  const k = dir || '(memoria)';
  if (!stores[k]) stores[k] = createStore(dir, log);
  return stores[k];
}

module.exports = { FILE: FILE, createStore: createStore, storeFor: storeFor, keyOf: keyOf };
