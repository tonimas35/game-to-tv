'use strict';
/*
 * The hub: player slots, reconnection, game lifecycle and the WebSocket
 * protocol shared by every game.
 *
 * Hub messages (any game can rely on them):
 *   TV     -> { t: 'hello', role: 'tv' }
 *   phone  -> { t: 'join', name, cid }           cid = client id kept by the phone
 *   phone  -> { t: 'leave' }
 *   any    -> { t: 'pick', game }                start a game from the menu
 *   any    -> { t: 'menu' }                      back to the menu
 *   any    -> { t: 'ping', c }                   -> { t: 'pong', ts, c }
 *   server -> { t: 'info', ... }                 URLs (to the TV)
 *   server -> { t: 'joined', slot, name, color, cid, reconnect }
 *   server -> { t: 'full' }
 *   server -> { t: 'hub', screen, ready, pick, slots, players: [...] }
 *   server -> { t: 'ev', k: 'join' | 'menu' | 'left', ... }
 *   server -> { t: 'ev', k: 'need2' | 'toomany', game, title, min, max, n, by, text }
 *             a game that does not fit the players in the room was picked
 *             (sent to the TV and every phone; `text` is ready to show)
 * Everything else goes to the lobby handlers of the games (messages a player
 * can send from the menu, e.g. the secret words of «Dibuja y adivina») or to
 * the game that is running.
 *
 * Player slots: 6 by default (--jugadores N, 2 to 8). Slot numbers in messages
 * start at 1; the game API uses 0-based indexes. Slots may have gaps (Ana in 1,
 * Carla in 3): use api.players(). A game whose maxPlayers is lower than the
 * highest occupied slot gets the slots compacted before it starts.
 */
const crypto = require('crypto');
const { WebSocket } = require('ws');

const COLORS = ['#22e6ff', '#ff3df2', '#ffd23e', '#3ee07a', '#ff8a3d', '#a98bff', '#ffffff', '#7dffcf'];
const DEFAULT_SLOTS = 6;
const TICK_HZ = 60;
const DT = 1 / TICK_HZ;

function createHub(opts) {
  const games = opts.games;                       // registry from src/games
  const SLOTS = Math.max(2, Math.min(COLORS.length, opts.maxPlayers || DEFAULT_SLOTS));
  const SLOT_HOLD_MS = opts.slotHoldMs || 30000;
  const log = opts.log || function (s) { console.log(s); };

  // players[i] = { cid, name, ws, disconnectedAt, store: { <gameId>: {...} } }
  const players = new Array(SLOTS).fill(null);
  const tvs = new Set();
  const hub = { screen: 'menu', game: null, gameId: null, pick: null };

  function isConnected(p) { return !!(p && p.ws && p.ws.readyState === WebSocket.OPEN); }
  function occupied() {
    const out = [];
    for (let i = 0; i < SLOTS; i++) if (players[i]) out.push(i);
    return out;
  }
  // Every player in the room is connected (and there is at least one)
  function allConnected() {
    const occ = occupied();
    return occ.length > 0 && occ.every(function (i) { return isConnected(players[i]); });
  }
  function readyCount() { return allConnected() ? occupied().length : 0; }

  function sendJSON(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch (e) { /* noop */ }
    }
  }
  function sendTvs(obj) {
    if (!tvs.size) return;
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    tvs.forEach(function (ws) { sendJSON(ws, s); });
  }
  function sendSlot(i, obj) { if (isConnected(players[i])) sendJSON(players[i].ws, obj); }
  function sendPhones(obj) {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    for (let i = 0; i < SLOTS; i++) sendSlot(i, s);
  }
  function broadcast(obj) {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    sendTvs(s);
    sendPhones(s);
  }
  function nameOf(i) { return players[i] ? players[i].name : 'Jugador ' + (i + 1); }

  function storeOf(i, gameId) {
    const p = players[i];
    if (!p) return {};
    if (!p.store[gameId]) p.store[gameId] = {};
    return p.store[gameId];
  }

  // API given to every game module (one object per game)
  function makeApi(gameId) {
    return {
      gameId: gameId,
      COLORS: COLORS,
      GALERIA_DIR: opts.galleryDir,
      galleryDir: opts.galleryDir,
      slots: SLOTS,
      tvs: tvs,
      isConnected: function (i) { return isConnected(players[i]); },
      bothConnected: allConnected,      // name kept from the 2-player version
      allConnected: allConnected,
      players: occupied,
      name: nameOf,
      store: function (i) { return storeOf(i, gameId); },
      sendSlot: sendSlot,
      sendTvs: sendTvs,
      sendPhones: sendPhones,
      broadcast: broadcast,
      sendWs: sendJSON,
      log: log
    };
  }
  const apis = {};
  function apiFor(id) { return apis[id] || (apis[id] = makeApi(id)); }

  function badgesOf(p) {
    const out = [];
    games.list.forEach(function (g) {
      const lobby = g.module.lobby;
      if (!lobby || !lobby.badge) return;
      try {
        const b = lobby.badge(p.store[g.id] || {});
        if (b) out.push(String(b));
      } catch (e) { /* noop */ }
    });
    return out;
  }

  function buildHub() {
    const now = Date.now();
    return {
      t: 'hub',
      screen: hub.screen,
      ready: readyCount() >= 2,
      pick: hub.pick,
      slots: SLOTS,
      players: players.map(function (p, i) {
        if (!p) return null;
        const conn = isConnected(p);
        return {
          slot: i + 1,
          name: p.name,
          color: COLORS[i],
          connected: conn,
          badges: badgesOf(p),
          holdLeft: conn ? 0 : (p.disconnectedAt
            ? Math.max(0, Math.ceil((SLOT_HOLD_MS - (now - p.disconnectedAt)) / 1000))
            : Math.ceil(SLOT_HOLD_MS / 1000))
        };
      })
    };
  }

  let lastHubStr = '';
  let lastHubAt = 0;
  function broadcastHub(force) {
    const str = JSON.stringify(buildHub());
    const now = Date.now();
    if (!force && str === lastHubStr && now - lastHubAt < 1000) return;
    lastHubStr = str;
    lastHubAt = now;
    broadcast(str);
  }

  // Moves players down so that slots 0..n-1 are used (only needed when a game
  // accepts fewer players than there are slots, e.g. Pong with 4 slots).
  function compactSlots() {
    const occ = occupied();
    let changed = false;
    occ.forEach(function (from, to) {
      if (from === to) return;
      players[to] = players[from];
      players[from] = null;
      const p = players[to];
      if (p.ws) { p.ws._slot = to; }
      sendSlot(to, { t: 'joined', slot: to + 1, name: p.name, color: COLORS[to], cid: p.cid, reconnect: true });
      changed = true;
    });
    return changed;
  }

  function startGame(id, by) {
    const g = games.byId[id];
    if (!g) return;
    if (hub.game) { try { hub.game.stop(); } catch (e) { log('Error parando juego: ' + e.message); } }
    // The name first: compacting may move the player who picked to another slot
    const byCid = by > 0 && players[by - 1] ? players[by - 1].cid : null;
    const byName = by > 0 ? nameOf(by - 1) : 'la tele';
    if (occupied().some(function (i) { return i >= g.manifest.maxPlayers; })) compactSlots();
    if (byCid) for (let i = 0; i < SLOTS; i++) if (players[i] && players[i].cid === byCid) by = i + 1;
    hub.pick = { game: id, title: g.manifest.title, by: by, name: byName, at: Date.now() };
    hub.screen = id;
    hub.gameId = id;
    hub.game = g.module.create(apiFor(id));
    log('[hub] ' + hub.pick.name + ' elige «' + g.manifest.title + '»');
    broadcastHub(true);
    hub.game.start();
    if (hub.game.flush) hub.game.flush();
  }

  function backToMenu(reason) {
    if (hub.game) { try { hub.game.stop(); } catch (e) { /* noop */ } }
    hub.game = null;
    hub.gameId = null;
    hub.screen = 'menu';
    log('[hub] Vuelta al menú' + (reason ? ' (' + reason + ')' : ''));
    broadcast({ t: 'ev', k: 'menu', reason: reason || '' });
    broadcastHub(true);
  }

  // ---------------------------------------------------------------- input cleanup
  function cleanName(raw, slot) {
    let s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
    s = Array.from(s).slice(0, 12).join('').trim();
    return s || ('Jugador ' + slot);
  }
  function cleanCid(raw) {
    const s = String(raw == null ? '' : raw).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    return s || crypto.randomBytes(8).toString('hex');
  }

  function lobbyJoin(slot) {
    games.list.forEach(function (g) {
      const lobby = g.module.lobby;
      if (lobby && lobby.onJoin) {
        try { lobby.onJoin(apiFor(g.id), slot, storeOf(slot, g.id)); } catch (e) { log('Error en ' + g.id + '.lobby.onJoin: ' + e.message); }
      }
    });
  }

  function handleJoin(ws, msg) {
    const cid = cleanCid(msg.cid);
    let slot = -1;
    for (let i = 0; i < SLOTS; i++) if (players[i] && players[i].cid === cid) slot = i;
    let reconnect = false;
    if (slot >= 0) {
      const p = players[slot];
      reconnect = true;
      if (p.ws && p.ws !== ws) {
        p.ws._replaced = true;
        try { p.ws.close(4000, 'Sustituido por una nueva conexión'); } catch (e) { /* noop */ }
      }
      p.ws = ws;
      p.disconnectedAt = 0;
      if (msg.name != null && String(msg.name).trim()) p.name = cleanName(msg.name, slot + 1);
    } else {
      for (let i = 0; i < SLOTS; i++) if (!players[i]) { slot = i; break; }
      if (slot < 0) { sendJSON(ws, { t: 'full', slots: SLOTS }); return; }
      players[slot] = { cid: cid, name: cleanName(msg.name, slot + 1), ws: ws, disconnectedAt: 0, store: {} };
    }
    ws._role = 'phone';
    ws._slot = slot;
    ws._cid = cid;
    const p = players[slot];
    log('[hub] ' + (reconnect ? 'Reconecta' : 'Se une') + ' Jugador ' + (slot + 1) + ': ' + p.name);
    sendJSON(ws, { t: 'joined', slot: slot + 1, name: p.name, color: COLORS[slot], cid: cid, reconnect: reconnect });
    lobbyJoin(slot);
    broadcast({ t: 'ev', k: 'join', slot: slot + 1 });
    broadcastHub(true);
    if (hub.game && hub.game.onPlayerJoined) hub.game.onPlayerJoined(slot, reconnect);
  }

  // A player is gone for good (left, or did not come back in SLOT_HOLD_MS).
  // A game that can go on without them says so with onPlayerLeft(i) (anything
  // but `false`); otherwise, or with fewer than minPlayers left, back to the menu.
  function freeSlot(i, why) {
    const p = players[i];
    if (!p) return;
    log('[hub] Hueco del Jugador ' + (i + 1) + ' (' + p.name + ') liberado: ' + why);
    players[i] = null;
    if (hub.screen === 'menu') return;
    const g = games.byId[hub.gameId];
    let keep = false;
    if (hub.game && hub.game.onPlayerLeft && g && occupied().length >= g.manifest.minPlayers) {
      try { keep = hub.game.onPlayerLeft(i) !== false; } catch (e) { log('Error en ' + hub.gameId + '.onPlayerLeft: ' + (e && e.stack || e)); }
    }
    if (keep) {
      log('[hub] «' + g.manifest.title + '» sigue sin ' + p.name);
      broadcast({ t: 'ev', k: 'left', slot: i + 1, name: p.name });
    } else {
      backToMenu('falta un jugador');
    }
  }

  // «Pong» es de 2 a 4 jugadores y sois 6. / «Dibuja y adivina» es de 2 a 6 jugadores: falta 1.
  function rangeText(m) {
    return m.minPlayers === m.maxPlayers ? 'para ' + m.minPlayers + ' jugadores' : 'de ' + m.minPlayers + ' a ' + m.maxPlayers + ' jugadores';
  }
  function pickProblem(g, by) {
    const m = g.manifest;
    const n = occupied().length;
    const base = { t: 'ev', game: g.id, title: m.title, min: m.minPlayers, max: m.maxPlayers, n: n, by: by, name: by > 0 ? nameOf(by - 1) : 'la tele' };
    if (n < m.minPlayers) {
      const k = m.minPlayers - n;
      return Object.assign(base, { k: 'need2', text: '«' + m.title + '» es ' + rangeText(m) + ': falta' + (k > 1 ? 'n ' : ' ') + k + (k > 1 ? ' jugadores' : ' jugador') + '. Escanead el QR.' });
    }
    if (n > m.maxPlayers) {
      return Object.assign(base, { k: 'toomany', text: '«' + m.title + '» es ' + rangeText(m) + ' y sois ' + n + '. Elegid otro juego.' });
    }
    if (!allConnected()) {
      const away = occupied().filter(function (i) { return !isConnected(players[i]); }).map(nameOf);
      return Object.assign(base, { k: 'need2', text: 'Esperando a que vuelva ' + away.join(' y ') + ' para empezar.' });
    }
    return null;
  }

  function phoneOf(ws) {
    if (ws._role !== 'phone') return -1;
    const p = players[ws._slot];
    return p && p.ws === ws ? ws._slot : -1;
  }

  function tryLobbyMessage(ws, msg) {
    for (let k = 0; k < games.list.length; k++) {
      const g = games.list[k];
      const lobby = g.module.lobby;
      if (!lobby || !lobby.messages || lobby.messages.indexOf(msg.t) < 0) continue;
      const i = phoneOf(ws);
      if (i < 0) return true;
      try { lobby.onMessage(apiFor(g.id), i, msg, storeOf(i, g.id)); } catch (e) { log('Error en ' + g.id + '.lobby: ' + (e && e.stack || e)); }
      broadcastHub(true);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- WebSocket
  function onConnection(ws) {
    ws._alive = true;
    ws._role = null;
    ws.on('pong', function () { ws._alive = true; });

    ws.on('message', function (data) {
      ws._alive = true;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

      switch (msg.t) {
        case 'hello':
          if (msg.role === 'tv') {
            ws._role = 'tv';
            tvs.add(ws);
            sendJSON(ws, Object.assign({ t: 'info', colors: COLORS, slots: SLOTS }, opts.infoForTv ? opts.infoForTv() : {}));
            sendJSON(ws, buildHub());
            if (hub.game && hub.game.syncTv) hub.game.syncTv(ws);
          }
          return;
        case 'join':
          if (ws._role === 'tv') return;
          if (phoneOf(ws) >= 0) {
            if (msg.name) players[ws._slot].name = cleanName(msg.name, ws._slot + 1);
            broadcastHub(true);
            return;
          }
          handleJoin(ws, msg);
          return;
        case 'ping':
          sendJSON(ws, { t: 'pong', ts: Date.now(), c: msg.c });
          return;
        case 'leave': {
          const i = phoneOf(ws);
          if (i < 0) return;
          ws._role = null;
          freeSlot(i, 'sale voluntariamente');
          broadcastHub(true);
          return;
        }
        case 'pick': {
          const by = ws._role === 'tv' ? 0 : phoneOf(ws) + 1;
          if (by < 0 || (ws._role !== 'tv' && by === 0)) return;
          if (hub.screen !== 'menu') return;
          const g = games.byId[msg.game];
          if (!g) return;
          const problem = pickProblem(g, by);
          if (problem) {
            // Everybody sees why nothing happens (the TV and every phone)
            log('[hub] No se puede empezar «' + g.manifest.title + '»: ' + problem.text);
            broadcast(problem);
            return;
          }
          startGame(msg.game, by);
          return;
        }
        case 'menu': {
          if (ws._role !== 'tv' && phoneOf(ws) < 0) return;
          if (hub.screen === 'menu') return;
          const who = ws._role === 'tv' ? 'la tele' : nameOf(ws._slot);
          backToMenu('lo pide ' + who);
          return;
        }
      }

      if (ws._role !== 'tv' && tryLobbyMessage(ws, msg)) return;

      // Messages for the running game
      if (!hub.game || !hub.game.onMessage) return;
      let who = -2;
      if (ws._role === 'tv') who = -1;
      else who = phoneOf(ws);
      if (who === -2 || (who < 0 && ws._role !== 'tv')) return;
      try { hub.game.onMessage(who, msg, ws); } catch (e) { log('Error en el juego: ' + (e && e.stack || e)); }
    });

    ws.on('close', function () {
      if (ws._role === 'tv') {
        tvs.delete(ws);
      } else if (ws._role === 'phone') {
        const p = players[ws._slot];
        if (p && p.ws === ws) {
          p.ws = null;
          p.disconnectedAt = Date.now();
          log('[hub] Se desconecta Jugador ' + (ws._slot + 1) + ' (' + p.name + ')');
          if (hub.game && hub.game.onPlayerDisconnected) hub.game.onPlayerDisconnected(ws._slot);
          broadcastHub(true);
        }
      }
    });

    ws.on('error', function () { /* handled in close */ });
  }

  // ---------------------------------------------------------------- fixed-step loop (60 Hz)
  function hubTick() {
    const now = Date.now();
    for (let i = 0; i < SLOTS; i++) {
      const p = players[i];
      if (p && !p.ws && p.disconnectedAt > 0 && now - p.disconnectedAt > SLOT_HOLD_MS) {
        freeSlot(i, 'no ha vuelto a tiempo');
        broadcastHub(true);
      }
    }
  }

  let lastTime = process.hrtime.bigint();
  let acc = 0;
  let loopTimer = null;
  let running = false;
  function loop() {
    const now = process.hrtime.bigint();
    acc += Number(now - lastTime) / 1e9;
    lastTime = now;
    if (acc > 0.25) acc = 0.25;
    let steps = 0;
    try {
      while (acc >= DT) {
        hubTick();
        if (hub.game) hub.game.tick(DT);
        acc -= DT;
        steps++;
      }
      if (steps > 0) {
        if (hub.game && hub.game.flush) hub.game.flush();
        broadcastHub(false);
      }
    } catch (e) {
      log('Error en el bucle: ' + (e && e.stack || e));
    }
    if (running) loopTimer = setTimeout(loop, Math.max(1, (DT - acc) * 1000));
  }

  return {
    COLORS: COLORS,
    slots: SLOTS,
    onConnection: onConnection,
    start: function () { running = true; lastTime = process.hrtime.bigint(); loop(); },
    stop: function () {
      running = false;
      clearTimeout(loopTimer);
      if (hub.game) { try { hub.game.stop(); } catch (e) { /* noop */ } }
    },
    state: function () { return { screen: hub.screen, players: buildHub().players }; },
    // For the TV service's idle shutdown and /info: TV pages and players right now
    counts: function () {
      let connected = 0;
      for (let i = 0; i < SLOTS; i++) if (isConnected(players[i])) connected++;
      return { tvs: tvs.size, players: occupied().length, connected: connected, slots: SLOTS, screen: hub.screen };
    }
  };
}

module.exports = { createHub: createHub, COLORS: COLORS, DEFAULT_SLOTS: DEFAULT_SLOTS };
