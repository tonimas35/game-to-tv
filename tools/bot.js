'use strict';
/*
 * A «Rivales bot» bot from outside the server: it joins a running server as
 * a normal phone (plus a hidden TV connection to watch the screen) and plays
 * with the game's bot.js, through the same contract the hub uses. Handy to
 * try a bot, or to watch two bots fight: add one from a phone («🤖 Añadir
 * rival») and let this one be the other player.
 *
 *   node tools/bot.js --juego tanques [--nivel facil|normal|dificil|imposible]
 *        [--server ws://IP:PUERTO/ws] [--nombre Robotina] [--rival NIVEL] [--elegir] [--segundos N]
 *
 * --rival adds a bot of the hub as its opponent (bot against bot, to watch on
 * the TV page); --elegir picks the game from the menu once it has joined.
 */
const path = require('path');
const WebSocket = require('ws');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.slice(0, 2) !== '--') continue;
  const nx = process.argv[i + 1];
  if (nx && nx.slice(0, 2) !== '--') { args[a.slice(2)] = nx; i++; } else args[a.slice(2)] = true;
}
const GAME = args.juego || 'tanques';
const LEVEL = args.nivel || 'normal';
const SERVER = args.server || 'ws://127.0.0.1:3000/ws';
const NAME = args.nombre || 'Robotina';
const Bots = require(path.join(__dirname, '..', 'src', 'server', 'bots'));
let Mod;
try { Mod = require(path.join(__dirname, '..', 'src', 'games', GAME, 'bot.js')); } catch (e) {
  console.error('El juego «' + GAME + '» no tiene bot.js');
  process.exit(1);
}

const phone = new WebSocket(SERVER);
const eye = new WebSocket(SERVER);   // watches the screen like a TV
let bot = null, slot = 0;
function send(obj) { if (phone.readyState === 1) { phone.send(JSON.stringify(obj)); return true; } return false; }
function start() {
  bot = Mod.create({
    slot: slot, level: LEVEL, levelValue: Bots.levelValue(LEVEL), name: NAME, gameId: GAME,
    // Like the hub: what it sends goes out after its tick, never inside it
    send: function (msg) { const s = JSON.stringify(msg); setImmediate(function () { if (phone.readyState === 1) phone.send(s); }); return true; },
    random: Math.random, now: Date.now, log: function (s) { console.log('[bot] ' + s); }
  }) || {};
}
function stop() { if (bot && bot.stop) { try { bot.stop(); } catch (e) { /* noop */ } } bot = null; }
phone.on('open', function () { send({ t: 'join', name: NAME, cid: 'tool-bot-' + NAME.toLowerCase().replace(/[^a-z0-9]/g, '') }); });
eye.on('open', function () { eye.send(JSON.stringify({ t: 'hello', role: 'tv' })); });
phone.on('message', function (d) {
  let m; try { m = JSON.parse(d); } catch (e) { return; }
  if (m.t === 'joined') {
    slot = m.slot;
    console.log('Dentro como ' + m.name + ' (hueco ' + slot + '), nivel ' + Bots.levelLabel(LEVEL));
    if (args.rival && m.reconnect === false) send({ t: 'bot.add', level: args.rival });
    if (args.elegir) setTimeout(function () { send({ t: 'pick', game: GAME }); }, 800);
  }
  if (m.t === 'hub') {
    // A bot per game, as in the hub: created when the game starts, stopped on the menu
    if (m.screen === GAME && !bot) start();
    if (m.screen !== GAME && bot) stop();
  }
  if (bot && bot.onSlot) bot.onSlot(m);
});
eye.on('message', function (d) {
  if (!bot || !bot.onTv) return;
  let m; try { m = JSON.parse(d); } catch (e) { return; }
  bot.onTv(m);
});
const timer = setInterval(function () { if (bot && bot.tick) bot.tick(1 / 60); }, 1000 / 60);
function bye(code) { clearInterval(timer); stop(); try { phone.close(); eye.close(); } catch (e) { /* noop */ } setTimeout(function () { process.exit(code); }, 300); }
phone.on('close', function () { console.log('Desconectado'); bye(0); });
phone.on('error', function (e) { console.log('Error: ' + e.message); bye(1); });
eye.on('error', function () {});
if (args.segundos) setTimeout(function () { bye(0); }, Number(args.segundos) * 1000);
