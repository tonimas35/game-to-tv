'use strict';
/*
 * Minimal .zip writer (deflate, no zip64), enough for the game bundle that
 * the Android TV app downloads (apps/android-tv/, BundleFiles.java reads it
 * with java.util.zip.ZipInputStream: every size and CRC is in the local
 * headers, no data descriptors). Fixed dates, so the same files always give
 * the same bytes (and the same SHA-256).
 *
 *   makeZip([{ name: 'a/b.js', data: Buffer|string, store: bool }]) -> Buffer
 *   zipDir(dir, files?) -> Buffer   (files: relative paths, default: all, sorted)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (function () {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_DATE = (1 << 5) | 1;   // 1980-01-01
const UTF8 = 0x0800;

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  entries.forEach(function (e) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    let method = e.store ? 0 : 8;
    let comp = method ? zlib.deflateRawSync(data, { level: 9 }) : data;
    if (method && comp.length >= data.length) { method = 0; comp = data; }
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(UTF8, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(UTF8, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  });
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, end]));
}

function listFiles(dir, base, out) {
  base = base || '';
  out = out || [];
  fs.readdirSync(path.join(dir, base), { withFileTypes: true }).forEach(function (d) {
    const rel = base ? base + '/' + d.name : d.name;
    if (d.isDirectory()) listFiles(dir, rel, out);
    else if (d.isFile()) out.push(rel);
  });
  return out;
}

function zipDir(dir, files) {
  const list = (files || listFiles(dir)).slice().sort();
  return makeZip(list.map(function (rel) { return { name: rel, data: fs.readFileSync(path.join(dir, rel)) }; }));
}

module.exports = { makeZip: makeZip, zipDir: zipDir, crc32: crc32, listFiles: listFiles };
