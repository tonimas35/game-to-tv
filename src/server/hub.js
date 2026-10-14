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
 *             ready: every player is connected and there are enough of them
 *             for at least one game (1 with «2048», 2 with the others)
 *   server -> { t: 'ev', k: 'join' | 'menu' | 'left', ... }
 *             ('menu' may carry `text`: why, ready to show)
 *   server -> { t: 'ev', k: 'need2' | 'toomany', game, title, min, max, n, by, text }
 *             a game that does not fit the players in the room was picked
 *             (sent to the TV and every phone; `text` is ready to show)
 *   server -> { t: 'ev', k: 'nobots', game, title, text }
 *             a game without bots was picked while there are bots in the room
 *
 * «Rivales bot» (computer opponents, see docs/crear-un-juego.md):
 *   phone  -> { t: 'bot.add', level }            facil | normal | dificil | imposible (menu only)
 *   phone  -> { t: 'bot.remove', slot }          slot from 1 (menu only)
 *   server -> { t: 'ev', k: 'bot', add, slot, name, level, levelName, by, text }
 *   server -> { t: 'ev', k: 'nobot', why: 'full' | 'menu', text }
 * A bot takes a normal slot (colour, name, score) with no socket and is always
 * connected; the hub players list marks it with `bot: true, level, levelName`.
 * Bots stay in the room between games and go away when no human is left.
 * While a game with bots runs, each bot (the game's bot.js) sees what a
 * person sees: every TV message (onTv) and its own phone's messages (onSlot),
 * each JSON string parsed once for all bots; what it sends goes, at the next
 * tick, to the game's onMessage as if it came from that slot's phone.
 *
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
const Bots = require('./bots');

// Hub messages a bot may never send (it only plays: game messages)
const HUB_ONLY = { hello: 1, join: 1, leave: 1, pick: 1, menu: 1, ping: 1, 'bot.add': 1, 'bot.remove': 1 };
// A bot that throws this many times is stopped (it stays in its slot, idle)
const BOT_MAX_ERRORS = 20;

const COLORS = ['#22e6ff', '#ff3df2', '#ffd23e', '#3ee07a', '#ff8a3d', '#a98bff', '#ffffff', '#7dffcf'];
const DEFAULT_SLOTS = 6;
const TICK_HZ = 60;
const DT = 1 / TICK_HZ;

function createHub(opts) {
  const games = opts.games;                       // registry from src/games
  const SLOTS = Math.max(2, Math.min(COLORS.length, opts.maxPlayers || DEFAULT_SLOTS));
  const SLOT_HOLD_MS = opts.slotHoldMs || 30000;
  const log = opts.log || function (s) { console.log(s); };
  // The smallest room any game accepts (1 with «2048»): the room is «ready»
  // from there on, and each game card says whether it fits (whyNot)
  const MIN_ANY = games.list.reduce(function (m, g) { return Math.min(m, Math.max(1, g.manifest.minPlayers || 1)); }, games.list.length ? Infinity : 2);

  const random = opts.random || Math.random;      // bot names and ctx.random (tests: seeded)

  // players[i] = { cid, name, ws, disconnectedAt, store: { <gameId>: {...} } }
  //   a bot:     { cid: 'bot:…', name, ws: null, bot: true, level, disconnectedAt: 0, store }
  const players = new Array(SLOTS).fill(null);
  const tvs = new Set();
  const hub = { screen: 'menu', game: null, gameId: null, pick: null };

  // Running bots (only while a game with bots is on): [{ i, slot, name, inst, stopped, errors }]
  let botRun = [];
  let botQueue = [];                    // what the bots sent: [{ run, s }] (delivered at the next tick)
  let parsedStr = null, parsedObj = null;  // one JSON.parse per message for all the bots
  const botStats = { parses: 0, toBots: 0, fromBots: 0 };

  function isBot(p) { return !!(p && p.bot); }
  function isConnected(p) { return !!(p && (p.bot || (p.ws && p.ws.readyState === WebSocket.OPEN))); }
  function occupied() {
    const out = [];
    for (let i = 0; i < SLOTS; i++) if (players[i]) out.push(i);
    return out;
  }
  function humanCount() {
    let n = 0;
    for (let i = 0; i < SLOTS; i++) if (players[i] && !players[i].bot) n++;
    return n;
  }
  function botCount() {
    let n = 0;
    for (let i = 0; i < SLOTS; i++) if (isBot(players[i])) n++;
    return n;
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
    if (!tvs.size && !botRun.length) return;
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    tvs.forEach(function (ws) { sendJSON(ws, s); });
    if (botRun.length) botsSee(s, -1);
  }
  function sendSlot(i, obj) {
    const p = players[i];
    if (isBot(p)) { if (botRun.length) botsSee(typeof obj === 'string' ? obj : JSON.stringify(obj), i); return; }
    if (isConnected(p)) sendJSON(p.ws, obj);
  }
  function sendPhones(obj) {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    for (let i = 0; i < SLOTS; i++) sendSlot(i, s);
  }
  function broadcast(obj) {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    sendTvs(s);
    sendPhones(s);
  }

  // ---------------------------------------------------------------- bots: what they see
  // The same string (e.g. a broadcast: TV + every phone) is parsed only once,
  // and the object is shared by every bot (read-only for them).
  function parsedFor(s) {
    if (s !== parsedStr) {
      try { parsedObj = JSON.parse(s); } catch (e) { parsedObj = null; }
      parsedStr = s;
      botStats.parses++;
    }
    return parsedObj;
  }
  // who: -1 = a TV message (every bot), i = the phone of slot i (that bot)
  function botsSee(s, who) {
    const m = parsedFor(s);
    if (!m) return;
    for (let k = 0; k < botRun.length; k++) {
      const run = botRun[k];
      if (who >= 0 && run.i !== who) continue;
      botCall(run, who < 0 ? 'onTv' : 'onSlot', m);
    }
  }
  function botCall(run, fn, arg) {
    if (run.stopped || !run.inst || typeof run.inst[fn] !== 'function') return;
    if (fn !== 'tick') botStats.toBots++;
    try { run.inst[fn](arg); } catch (e) {
      run.errors++;
      log('Error en el bot ' + run.name + ' (' + hub.gameId + '.' + fn + '): ' + (e && e.stack || e));
      if (run.errors >= BOT_MAX_ERRORS) { log('[hub] El bot ' + run.name + ' se queda quieto: demasiados errores'); stopRun(run); }
    }
  }
  function stopRun(run) {
    if (run.stopped) return;
    run.stopped = true;
    if (run.inst && typeof run.inst.stop === 'function') { try { run.inst.stop(); } catch (e) { /* noop */ } }
  }
  function nameOf(i) { return players[i] ? players[i].name : 'Jugador ' + (i + 1); }

  function storeOf(i, gameId) {
    const p = players[i];
    if (!p) return {};
    if (!p.store[gameId]) p.store[gameId] = {};
    return p.store[gameId];
  }

  // What the games see as `api.tvs`: the TV sockets, plus one «TV» while bots
  // are playing (games skip their TV-only state when nobody watches: a bot
  // watches the TV too, even with no TV page open)
  const tvsView = {
    get size() { return tvs.size + (botRun.length ? 1 : 0); },
    has: function (ws) { return tvs.has(ws); },
    forEach: function (fn, self) { tvs.forEach(fn, self); }
  };

  // API given to every game module (one object per game)
  function makeApi(gameId) {
    return {
      gameId: gameId,
      COLORS: COLORS,
      GALERIA_DIR: opts.galleryDir,
      galleryDir: opts.galleryDir,
      // Folder for small persistent data (e.g. the «2048» records): ~/.game-to-tv
      // in pc mode, a writable folder of the TV in tele mode; null = keep in memory
      dataDir: opts.dataDir || null,
      slots: SLOTS,
      tvs: tvsView,
      isConnected: function (i) { return isConnected(players[i]); },
      isBot: function (i) { return isBot(players[i]); },
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
      ready: readyCount() >= MIN_ANY,
      pick: hub.pick,
      slots: SLOTS,
      players: players.map(function (p, i) {
        if (!p) return null;
        if (p.bot) {
          return { slot: i + 1, name: p.name, color: COLORS[i], connected: true, bot: true, level: p.level, levelName: Bots.levelLabel(p.level), badges: [], holdLeft: 0 };
        }
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

  // ---------------------------------------------------------------- bots: lifecycle
  // A bot instance per bot in the room, created when a game starts (after the
  // slots are compacted) and stopped on the way back to the menu
  function startBots(g) {
    stopBots();
    if (!g.bot) return;
    for (let i = 0; i < SLOTS; i++) {
      const p = players[i];
      if (!isBot(p)) continue;
      const level = Bots.nearestLevel(p.level, g.manifest.botLevels);
      const run = { i: i, slot: i + 1, name: p.name, inst: null, stopped: false, errors: 0 };
      const ctx = {
        slot: i + 1,                      // from 1, as in the messages (like host.slot() on a phone)
        level: level,
        levelValue: Bots.levelValue(level),
        name: p.name,
        gameId: g.id,
        send: function (msg) {
          if (run.stopped || !msg || typeof msg.t !== 'string') return false;
          if (botQueue.length >= 256) return false;
          botQueue.push({ run: run, s: JSON.stringify(msg) });
          return true;
        },
        random: random,
        now: function () { return Date.now(); },
        log: function (s) { log('[bot ' + p.name + '] ' + s); }
      };
      try { run.inst = g.bot.create(ctx) || {}; } catch (e) {
        log('Error creando el bot ' + p.name + ' de «' + g.manifest.title + '»: ' + (e && e.stack || e));
        run.inst = {};
      }
      botRun.push(run);
      log('[hub] ' + p.name + ' juega como bot (' + Bots.levelLabel(level) + ')');
    }
  }
  function stopBots() {
    const old = botRun;
    botRun = [];
    botQueue = [];
    parsedStr = null;
    parsedObj = null;
    old.forEach(stopRun);
  }
  // What the bots sent since the last tick goes to the game, as from their phones
  function deliverBots() {
    if (!botQueue.length) return;
    const q = botQueue;
    botQueue = [];
    for (let k = 0; k < q.length; k++) {
      const run = q[k].run;
      if (run.stopped || !hub.game || !hub.game.onMessage) continue;
      let msg = null;
      try { msg = JSON.parse(q[k].s); } catch (e) { continue; }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string' || HUB_ONLY[msg.t]) continue;
      botStats.fromBots++;
      try { hub.game.onMessage(run.i, msg, null); } catch (e) { log('Error en el juego (mensaje de un bot): ' + (e && e.stack || e)); }
    }
  }
  function tickBots(dt) {
    for (let k = 0; k < botRun.length; k++) botCall(botRun[k], 'tick', dt);
  }
  // Nobody human left in the room: the bots go too
  function dropBotsIfAlone() {
    if (humanCount() > 0 || !botCount()) return false;
    stopBots();
    for (let i = 0; i < SLOTS; i++) if (isBot(players[i])) players[i] = null;
    log('[hub] No queda nadie: se van los bots');
    return true;
  }

  function startGame(id, by) {
    const g = games.byId[id];
    if (!g) return;
    stopBots();
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
    // Before start(): the bots see the first state like everybody else
    startBots(g);
    broadcastHub(true);
    hub.game.start();
    if (hub.game.flush) hub.game.flush();
  }

  // text: optional explanation in Spanish, shown by the TV and the phones
  function backToMenu(reason, text) {
    stopBots();
    if (hub.game) { try { hub.game.stop(); } catch (e) { /* noop */ } }
    hub.game = null;
    hub.gameId = null;
    hub.screen = 'menu';
    log('[hub] Vuelta al menú' + (reason ? ' (' + reason + ')' : ''));
    const ev = { t: 'ev', k: 'menu', reason: reason || '' };
    if (text) ev.text = text;
    broadcast(ev);
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
    // (a bot's cid has a ':', which cleanCid never lets through: no phone can take its place)
    for (let i = 0; i < SLOTS; i++) if (players[i] && !players[i].bot && players[i].cid === cid) slot = i;
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
    dropBotsIfAlone();
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
      backToMenu('falta un jugador', g ? leftText(p.name, g.manifest) : '');
    }
  }

  // «Ana se ha ido y «Pong» necesita al menos 2 jugadores.» / «Ana se ha ido y no queda nadie.»
  function leftText(name, m) {
    if (!occupied().length) return name + ' se ha ido y no queda nadie jugando a «' + m.title + '». Volvemos al menú.';
    return name + ' se ha ido y «' + m.title + '» necesita al menos ' + m.minPlayers + (m.minPlayers === 1 ? ' jugador' : ' jugadores') + '. Volvemos al menú.';
  }

  // «Pong» es de 2 a 4 jugadores y sois 6. / «Dibuja y adivina» es de 2 a 6 jugadores: falta 1.
  function rangeText(m) {
    if (m.minPlayers === m.maxPlayers) return 'para ' + m.minPlayers + (m.minPlayers === 1 ? ' jugador' : ' jugadores');
    return 'de ' + m.minPlayers + ' a ' + m.maxPlayers + ' jugadores';
  }
  function pickProblem(g, by) {
    const m = g.manifest;
    const n = occupied().length;
    const base = { t: 'ev', game: g.id, title: m.title, min: m.minPlayers, max: m.maxPlayers, n: n, by: by, name: by > 0 ? nameOf(by - 1) : 'la tele' };
    if (botCount() && !g.bot) {
      return Object.assign(base, { k: 'nobots', text: '«' + m.title + '» no admite rivales: quita los bots.' });
    }
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

  // ---------------------------------------------------------------- bots: adding and removing
  // by: the slot (0…) of the phone that asks; only phones, only in the menu
  function addBot(by, rawLevel) {
    if (by < 0) return;
    if (hub.screen !== 'menu') {
      broadcast({ t: 'ev', k: 'nobot', why: 'menu', by: by + 1, text: 'Los rivales se añaden desde el menú.' });
      return;
    }
    const level = Bots.cleanLevel(rawLevel) || Bots.DEFAULT_LEVEL;
    let slot = -1;
    // Only a free slot: a human who is reconnecting keeps theirs
    for (let i = 0; i < SLOTS; i++) if (!players[i]) { slot = i; break; }
    if (slot < 0) {
      broadcast({ t: 'ev', k: 'nobot', why: 'full', by: by + 1, text: 'La sala está llena: no cabe otro rival.' });
      return;
    }
    const name = Bots.pickName(players.filter(Boolean).map(function (p) { return p.name; }), random);
    players[slot] = { cid: 'bot:' + crypto.randomBytes(6).toString('hex'), name: name, ws: null, bot: true, level: level, disconnectedAt: 0, store: {} };
    log('[hub] ' + nameOf(by) + ' añade un rival: ' + name + ' (' + Bots.levelLabel(level) + ', hueco ' + (slot + 1) + ')');
    lobbyJoin(slot);
    broadcast({ t: 'ev', k: 'bot', add: true, slot: slot + 1, name: name, level: level, levelName: Bots.levelLabel(level), by: by + 1, text: name + ' (' + Bots.levelLabel(level) + ') se une como rival' });
    broadcastHub(true);
  }
  function removeBot(by, rawSlot) {
    if (by < 0) return;
    const i = parseInt(rawSlot, 10) - 1;
    if (!(i >= 0 && i < SLOTS) || !isBot(players[i])) return;
    if (hub.screen !== 'menu') {
      broadcast({ t: 'ev', k: 'nobot', why: 'menu', by: by + 1, text: 'Los rivales se quitan desde el menú.' });
      return;
    }
    const p = players[i];
    players[i] = null;
    log('[hub] ' + nameOf(by) + ' quita al rival ' + p.name);
    broadcast({ t: 'ev', k: 'bot', add: false, slot: i + 1, name: p.name, level: p.level, levelName: Bots.levelLabel(p.level), by: by + 1, text: p.name + ' ya no juega' });
    broadcastHub(true);
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
        case 'bot.add':
          addBot(phoneOf(ws), msg.level);
          return;
        case 'bot.remove':
          removeBot(phoneOf(ws), msg.slot);
          return;
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

  // One fixed step: slots, what the bots sent, the game, the bots
  function step() {
    hubTick();
    if (botQueue.length) deliverBots();
    if (hub.game) hub.game.tick(DT);
    if (botRun.length) tickBots(DT);
  }
  function afterSteps() {
    if (hub.game && hub.game.flush) hub.game.flush();
    broadcastHub(false);
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
        step();
        acc -= DT;
        steps++;
      }
      if (steps > 0) afterSteps();
    } catch (e) {
      log('Error en el bucle: ' + (e && e.stack || e));
    }
    if (running) loopTimer = setTimeout(loop, Math.max(1, (DT - acc) * 1000));
  }

  return {
    COLORS: COLORS,
    slots: SLOTS,
    minAny: MIN_ANY,
    onConnection: onConnection,
    start: function () { running = true; lastTime = process.hrtime.bigint(); loop(); },
    stop: function () {
      running = false;
      clearTimeout(loopTimer);
      stopBots();
      if (hub.game) { try { hub.game.stop(); } catch (e) { /* noop */ } }
    },
    state: function () { return { screen: hub.screen, players: buildHub().players }; },
    // For the TV service's idle shutdown and /info: TV pages and players right now
    // (players and connected: people; the bots apart)
    counts: function () {
      let connected = 0;
      for (let i = 0; i < SLOTS; i++) if (players[i] && !players[i].bot && isConnected(players[i])) connected++;
      return { tvs: tvs.size, players: humanCount(), bots: botCount(), connected: connected, slots: SLOTS, screen: hub.screen };
    },
    // For tests: run n fixed steps by hand (with the loop stopped) and the bot counters
    // ({ parses: JSON.parse calls for bots, toBots: messages handed to bots, fromBots })
    stepForTests: function (n) {
      for (let k = 0; k < (n || 1); k++) step();
      afterSteps();
    },
    botStats: function () { return Object.assign({ running: botRun.length, queued: botQueue.length }, botStats); }
  };
}

module.exports = { createHub: createHub, COLORS: COLORS, DEFAULT_SLOTS: DEFAULT_SLOTS };
