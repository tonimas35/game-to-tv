'use strict';
/*
 * Boots a PACKAGED service folder (extracted from the .ipk) the way webOS
 * does, with the fake webos-service, and prints one line:
 *   RESULT {"start":…, "info":…, "qr":200, …}
 *
 *   NODE_PATH=test/helpers/fake-modules node test/helpers/boot-service.js <serviceDir>
 * The folder must live outside the project, so that only its own
 * node_modules can be used. Runs on Node 12 (G2T_NODE12).
 */
var path = require('path');
var http = require('http');

var dir = process.argv[2];
var Service = require('webos-service');
require(path.join(dir, 'service.js'));
var s = Service.instances[0];

function get(port, p) {
  return new Promise(function (resolve) {
    http.get({ host: '127.0.0.1', port: port, path: p }, function (res) {
      var body = '';
      res.setEncoding('utf8');
      res.on('data', function (d) { body += d; });
      res.on('end', function () { resolve({ status: res.statusCode, body: body }); });
    }).on('error', function (e) { resolve({ status: 0, body: String(e.message) }); });
  });
}

var out = { node: process.version, busId: s && s.busId };
var timer = setTimeout(function () { console.log('RESULT ' + JSON.stringify(Object.assign(out, { timeout: true }))); process.exit(2); }, 20000);

s.request('start', {}).then(function (r) {
  out.start = r;
  if (!r.returnValue) throw new Error(r.errorText);
  return get(r.port, '/info');
}).then(function (res) {
  out.info = JSON.parse(res.body);
  return get(out.start.port, '/qr.svg');
}).then(function (res) {
  out.qr = res.status;
  out.qrSvg = /<svg/.test(res.body);
  return get(out.start.port, '/');
}).then(function (res) {
  out.shell = res.status === 200 && /G2T_BOOT/.test(res.body) && /tvservice\.js/.test(res.body);
  return get(out.start.port, '/lib/tvservice.js');
}).then(function (res) {
  out.helper = res.status;
  return s.request('status', {});
}).then(function (st) {
  out.status = st;
  // PNG rendering with the bundled pngjs, in a worker_thread, as «Dibuja y adivina» does it
  var raster = require(path.join(dir, 'src', 'games', 'dibuja', 'raster.js'));
  return raster.renderPngAsync([{ c: '#ff3df2', w: 0.02, p: [0.1, 0.1, 0.9, 0.9] }], 80, 60);
}).then(function (buf) {
  out.png = buf.length > 50 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  return s.request('stop', {});
}).then(function (r) {
  out.stop = r;
  clearTimeout(timer);
  console.log('RESULT ' + JSON.stringify(out));
  setTimeout(function () { process.exit(0); }, 50);
}).catch(function (e) {
  out.error = String(e && e.stack || e);
  console.log('RESULT ' + JSON.stringify(out));
  process.exit(1);
});
