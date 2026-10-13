'use strict';
/*
 * LG webOS discovery with SSDP: an M-SEARCH to 239.255.255.250:1900 asking
 * for urn:lge-com:service:webos-second-screen:1. Each TV answers with HTTP-
 * like headers: LOCATION (its description XML), SERVER, USN and LG's
 * DLNADeviceName.lge.com (the TV name, URL-encoded).
 */
const dgram = require('dgram');
const http = require('http');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const ST_WEBOS = 'urn:lge-com:service:webos-second-screen:1';

function buildSearch(st, mx) {
  return [
    'M-SEARCH * HTTP/1.1',
    'HOST: ' + SSDP_ADDR + ':' + SSDP_PORT,
    'MAN: "ssdp:discover"',
    'MX: ' + (mx || 2),
    'ST: ' + (st || ST_WEBOS),
    '', ''
  ].join('\r\n');
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

/** Parses one SSDP answer. Returns null if it is not a valid answer. */
function parseResponse(text, rinfo) {
  const lines = String(text || '').split(/\r?\n/);
  if (!/^HTTP\/1\.[01] 200/i.test(lines[0] || '') && !/^NOTIFY /i.test(lines[0] || '')) return null;
  const headers = {};
  lines.slice(1).forEach(function (l) {
    const i = l.indexOf(':');
    if (i <= 0) return;
    headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  });
  let ip = rinfo && rinfo.address ? rinfo.address : null;
  if (headers.location) {
    try { ip = new URL(headers.location).hostname || ip; } catch (e) { /* keep rinfo */ }
  }
  if (!ip) return null;
  const name = headers['dlnadevicename.lge.com'] ? safeDecode(headers['dlnadevicename.lge.com']) : null;
  return {
    ip: ip,
    location: headers.location || null,
    st: headers.st || headers.nt || null,
    usn: headers.usn || null,
    server: headers.server || null,
    name: name,
    isWebOS: /webos|lge/i.test((headers.st || '') + ' ' + (headers.server || '') + ' ' + (headers.usn || '')),
    headers: headers
  };
}

/** Reads friendlyName / modelName from the UPnP description XML. */
function fetchDescription(location, timeout) {
  return new Promise(function (resolve) {
    let req;
    try {
      req = http.get(location, { timeout: timeout || 2000 }, function (res) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', function (d) { if (body.length < 200000) body += d; });
        res.on('end', function () {
          const pick = function (tag) {
            const m = new RegExp('<' + tag + '>([^<]*)</' + tag + '>', 'i').exec(body);
            return m ? m[1].trim() : null;
          };
          resolve({ friendlyName: pick('friendlyName'), modelName: pick('modelName'), manufacturer: pick('manufacturer') });
        });
      });
    } catch (e) { return resolve({}); }
    req.on('timeout', function () { req.destroy(); resolve({}); });
    req.on('error', function () { resolve({}); });
  });
}

/**
 * Local IPv4 addresses to search from. With several interfaces (WSL, Hyper-V,
 * VPN…) the OS may send multicast through the wrong one, so we send the
 * M-SEARCH from every non-internal IPv4 interface. Found on a real Windows PC
 * with WSL: without this, no device on the LAN answered.
 */
function localIPv4s() {
  const out = [];
  const ifs = require('os').networkInterfaces();
  Object.keys(ifs).forEach(function (name) {
    (ifs[name] || []).forEach(function (a) {
      const fam = typeof a.family === 'string' ? a.family : (a.family === 4 ? 'IPv4' : 'IPv6');
      if (fam === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) out.push(a.address);
    });
  });
  return out;
}

/**
 * Sends M-SEARCH and collects answers for `timeout` ms.
 * opts: { timeout, st, address, port (tests: unicast target), describe, interfaces }
 */
function discover(opts) {
  opts = opts || {};
  const timeout = opts.timeout || 3000;
  return new Promise(function (resolve) {
    const found = {};
    // One socket bound to each LAN interface (+ one default) unless a unicast target is given (tests)
    const binds = opts.address ? [null] : [null].concat(opts.interfaces || localIPv4s());
    const socks = [];
    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      socks.forEach(function (s) { try { s.close(); } catch (e) { /* noop */ } });
      const list = Object.keys(found).map(function (k) { return found[k]; });
      if (opts.describe === false) return resolve(list);
      Promise.all(list.map(function (tv) {
        if (!tv.location) return tv;
        return fetchDescription(tv.location, 1500).then(function (d) {
          tv.name = tv.name || d.friendlyName || null;
          tv.model = d.modelName || null;
          tv.manufacturer = d.manufacturer || null;
          return tv;
        });
      })).then(resolve);
    }
    function onMessage(msg, rinfo) {
      const r = parseResponse(msg.toString('utf8'), rinfo);
      if (!r) return;
      if (opts.st !== '*' && r.st && r.st !== (opts.st || ST_WEBOS) && !r.isWebOS) return;
      if (!found[r.ip]) found[r.ip] = r;
    }
    const payload = Buffer.from(buildSearch(opts.st, 2));
    const addr = opts.address || SSDP_ADDR;
    const port = opts.port || SSDP_PORT;
    binds.forEach(function (local) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socks.push(sock);
      sock.on('message', onMessage);
      sock.on('error', function () { try { sock.close(); } catch (e) { /* noop */ } });   // one bad interface must not stop the others
      const ready = function () {
        try {
          if (!opts.address) {
            sock.setMulticastTTL(4);
            if (local) sock.setMulticastInterface(local);
          }
        } catch (e) { /* noop */ }
        const send = function () { if (!finished) { try { sock.send(payload, 0, payload.length, port, addr); } catch (e) { /* noop */ } } };
        send();
        setTimeout(send, 400);   // twice: UDP can get lost
      };
      try { if (local) sock.bind(0, local, ready); else sock.bind(0, ready); } catch (e) { /* noop */ }
    });
    setTimeout(finish, timeout);
  });
}

module.exports = { ST_WEBOS: ST_WEBOS, buildSearch: buildSearch, parseResponse: parseResponse, fetchDescription: fetchDescription, discover: discover, localIPv4s: localIPv4s };
