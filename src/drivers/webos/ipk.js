'use strict';
/*
 * webOS .ipk packaging in pure JavaScript (no ares-cli needed to BUILD it).
 *
 * An .ipk is a Debian-style `ar` archive with three members, in this order:
 *   debian-binary     "2.0\n"
 *   control.tar.gz    ./control  (Package, Version, Architecture: all, ...)
 *   data.tar.gz       ./usr/palm/applications/<id>/...   (the app)
 *                     ./usr/palm/packages/<id>/packageinfo.json
 * This mirrors what `ares-package` produces. Installing still needs
 * `ares-install` (or another tool that talks to the TV in Developer Mode).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------- tar (ustar)
function octal(n, len) {
  const s = n.toString(8);
  return '0'.repeat(Math.max(0, len - 1 - s.length)) + s + '\0';
}

function tarHeader(name, size, mode, mtime, type) {
  const h = Buffer.alloc(512, 0);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    // ustar: split long paths into prefix (155) + name (100)
    const cut = name.lastIndexOf('/', name.length - 2);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error('Ruta demasiado larga para tar: ' + prefix + '/' + name);
  }
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');           // uid
  h.write(octal(0, 8), 116, 8, 'ascii');           // gid
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(mtime, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');            // checksum placeholder
  h.write(type, 156, 1, 'ascii');                  // '0' file, '5' dir
  h.write('ustar\u000000', 257, 8, 'binary');
  h.write('root', 265, 32, 'ascii');
  h.write('root', 297, 32, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return h;
}

/** entries: [{ name: './a/b', data: Buffer } | { name: './a/', dir: true }] */
function tar(entries, mtime) {
  mtime = mtime || Math.floor(Date.now() / 1000);
  const parts = [];
  entries.forEach(function (e) {
    if (e.dir) {
      parts.push(tarHeader(e.name.replace(/\/?$/, '/'), 0, 0o755, mtime, '5'));
      return;
    }
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data));
    parts.push(tarHeader(e.name, data.length, e.mode || 0o644, mtime, '0'));
    parts.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  });
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

function parseTar(buf) {
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.slice(off, off + 512);
    if (h.every(function (b) { return b === 0; })) break;
    const field = function (a, b) { return h.slice(a, b).toString('utf8').replace(/\0.*$/s, ''); };
    let name = field(0, 100);
    const prefix = field(345, 500);
    if (prefix) name = prefix + '/' + name;
    const size = parseInt(field(124, 136).trim() || '0', 8);
    const type = field(156, 157) || '0';
    const stored = parseInt(field(148, 156).trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : h[i];
    off += 512;
    out.push({ name: name, type: type, size: size, checksumOk: sum === stored, data: buf.slice(off, off + size) });
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

// ---------------------------------------------------------------- ar
function arField(s, len) { s = String(s); return s + ' '.repeat(Math.max(0, len - s.length)); }

function ar(members, mtime) {
  mtime = mtime || Math.floor(Date.now() / 1000);
  const parts = [Buffer.from('!<arch>\n', 'ascii')];
  members.forEach(function (m) {
    const data = Buffer.isBuffer(m.data) ? m.data : Buffer.from(m.data);
    const header = arField(m.name, 16) + arField(mtime, 12) + arField(0, 6) + arField(0, 6) +
      arField('100644', 8) + arField(data.length, 10) + '`\n';
    parts.push(Buffer.from(header, 'ascii'));
    parts.push(data);
    if (data.length % 2) parts.push(Buffer.from('\n'));
  });
  return Buffer.concat(parts);
}

function parseAr(buf) {
  if (buf.slice(0, 8).toString('ascii') !== '!<arch>\n') throw new Error('No es un archivo ar');
  const out = [];
  let off = 8;
  while (off + 60 <= buf.length) {
    const h = buf.slice(off, off + 60).toString('ascii');
    const name = h.slice(0, 16).trim().replace(/\/$/, '');
    const size = parseInt(h.slice(48, 58).trim(), 10);
    off += 60;
    out.push({ name: name, size: size, data: buf.slice(off, off + size) });
    off += size + (size % 2);
  }
  return out;
}

// ---------------------------------------------------------------- ipk
function walk(dir, base) {
  base = base || '';
  let out = [];
  fs.readdirSync(dir, { withFileTypes: true }).sort(function (a, b) { return a.name < b.name ? -1 : 1; }).forEach(function (d) {
    const rel = base ? base + '/' + d.name : d.name;
    if (d.isDirectory()) {
      out.push({ rel: rel, dir: true });
      out = out.concat(walk(path.join(dir, d.name), rel));
    } else if (d.isFile()) {
      out.push({ rel: rel, file: path.join(dir, d.name) });
    }
  });
  return out;
}

/**
 * Builds an .ipk from an app folder (with appinfo.json).
 * Returns { buffer, fileName, appId, version }.
 */
function buildIpk(appDir, opts) {
  opts = opts || {};
  const appinfo = JSON.parse(fs.readFileSync(path.join(appDir, 'appinfo.json'), 'utf8'));
  const id = appinfo.id;
  const version = appinfo.version;
  const files = walk(appDir);
  let installedSize = 0;
  const appRoot = './usr/palm/applications/' + id;
  const pkgRoot = './usr/palm/packages/' + id;
  const entries = [
    { name: './', dir: true }, { name: './usr', dir: true }, { name: './usr/palm', dir: true },
    { name: './usr/palm/applications', dir: true }, { name: appRoot, dir: true }
  ];
  files.forEach(function (f) {
    if (f.dir) { entries.push({ name: appRoot + '/' + f.rel, dir: true }); return; }
    const data = fs.readFileSync(f.file);
    installedSize += data.length;
    entries.push({ name: appRoot + '/' + f.rel, data: data });
  });
  const packageinfo = Buffer.from(JSON.stringify({
    app: id, id: id, loc_name: appinfo.title, package_format_version: 2,
    vendor: appinfo.vendor || 'game-to-tv', version: version
  }, null, 2) + '\n');
  installedSize += packageinfo.length;
  entries.push({ name: './usr/palm/packages', dir: true }, { name: pkgRoot, dir: true }, { name: pkgRoot + '/packageinfo.json', data: packageinfo });

  const control = [
    'Package: ' + id,
    'Version: ' + version,
    'Section: misc',
    'Priority: optional',
    'Architecture: all',
    'Installed-Size: ' + Math.max(1, Math.ceil(installedSize / 1024)),
    'Maintainer: ' + (appinfo.vendor || 'game-to-tv') + ' <noreply@invalid>',
    'Description: ' + appinfo.title,
    'webOS-Package-Format-Version: 2',
    'webOS-Packager-Version: game-to-tv-' + (opts.packagerVersion || '1'),
    ''
  ].join('\n');

  const mtime = opts.mtime || Math.floor(Date.now() / 1000);
  const controlTgz = zlib.gzipSync(tar([{ name: './', dir: true }, { name: './control', data: Buffer.from(control) }], mtime));
  const dataTgz = zlib.gzipSync(tar(entries, mtime));
  const buffer = ar([
    { name: 'debian-binary', data: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', data: controlTgz },
    { name: 'data.tar.gz', data: dataTgz }
  ], mtime);
  return { buffer: buffer, fileName: id + '_' + version + '_all.ipk', appId: id, version: version };
}

module.exports = { tar: tar, parseTar: parseTar, ar: ar, parseAr: parseAr, buildIpk: buildIpk };
