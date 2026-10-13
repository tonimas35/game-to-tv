'use strict';
/*
 * LAN IP detection. The TV and the phones need the PC's address on the home
 * network, not 127.0.0.1 nor the address of a VPN or virtual adapter.
 * HOST_IP (or --host-ip) always wins.
 */
const os = require('os');

function listIPv4() {
  const ifaces = os.networkInterfaces();
  const out = [];
  Object.keys(ifaces).forEach(function (name) {
    (ifaces[name] || []).forEach(function (a) {
      const fam = a.family === 4 ? 'IPv4' : a.family;
      if (fam !== 'IPv4' || a.internal) return;
      out.push({ name: name, address: a.address, netmask: a.netmask });
    });
  });
  return out;
}

function scoreIface(c) {
  let s = 0;
  const ip = c.address;
  if (/^192\.168\./.test(ip)) s += 100;
  else if (/^10\./.test(ip)) s += 60;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) s += 40;
  if (/^169\.254\./.test(ip)) s -= 200;
  if (/virtual|vethernet|vmware|vbox|virtualbox|hyper-v|wsl|docker|loopback|bluetooth|tailscale|zerotier|hamachi|npcap/i.test(c.name)) s -= 80;
  if (/^192\.168\.56\./.test(ip)) s -= 50;
  if (/wi-?fi|wlan|wireless|ethernet|^en\d|^eth\d|^wl/i.test(c.name)) s += 10;
  return s;
}

function rankedIPv4() {
  return listIPv4().sort(function (a, b) { return scoreIface(b) - scoreIface(a); });
}

function detectLanIp(override) {
  const forced = override || process.env.HOST_IP;
  if (forced) return String(forced).trim();
  const c = rankedIPv4();
  return c.length ? c[0].address : '127.0.0.1';
}

module.exports = { listIPv4: listIPv4, scoreIface: scoreIface, rankedIPv4: rankedIPv4, detectLanIp: detectLanIp };
