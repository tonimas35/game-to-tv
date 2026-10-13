'use strict';
/*
 * Ambient mode (/ambiente): a slideshow of the pictures in a local folder
 * (~/.game-to-tv/ambiente by default) with a big clock. Nothing is shipped:
 * with an empty folder the page shows a placeholder.
 *
 *   /ambiente                 the page (public/ambiente.html)
 *   /ambiente/lista.json      { fotos: [...], zonaHoraria, intervalo, carpeta }
 *   /ambiente/foto/<nombre>   one picture
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const IMG_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const SAFE_NAME = /^[^/\\\u0000-\u001f]{1,200}$/;

function listPictures(dir, cb) {
  fs.readdir(dir, function (err, files) {
    if (err) return cb([]);
    cb(files.filter(function (f) {
      return IMG_TYPES[path.extname(f).toLowerCase()] && f.charAt(0) !== '.';
    }).sort(function (a, b) { return a.localeCompare(b, 'es'); }));
  });
}

function prettyDir(dir) {
  const home = os.homedir();
  return dir.indexOf(home) === 0 ? '~' + dir.slice(home.length) : dir;
}

function handle(req, res, pathname, ctx) {
  if (pathname === '/ambiente' || pathname === '/ambiente/') {
    return fs.readFile(path.join(ctx.publicDir, 'ambiente.html'), function (err, data) {
      if (err) return ctx.send(res, 500, 'text/plain; charset=utf-8', 'Error leyendo ambiente.html');
      ctx.send(res, 200, 'text/html; charset=utf-8', data);
    });
  }
  if (pathname === '/ambiente/lista.json') {
    return listPictures(ctx.dir, function (files) {
      ctx.send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
        fotos: files.map(function (f) { return '/ambiente/foto/' + encodeURIComponent(f); }),
        zonaHoraria: ctx.timezone,
        intervalo: parseInt(process.env.AMBIENTE_INTERVALO, 10) || 20,
        carpeta: prettyDir(ctx.dir)
      }));
    });
  }
  if (pathname.indexOf('/ambiente/foto/') === 0) {
    let name = '';
    try { name = decodeURIComponent(pathname.slice('/ambiente/foto/'.length)); } catch (e) { return ctx.notFound(res); }
    const type = IMG_TYPES[path.extname(name).toLowerCase()];
    if (!type || !SAFE_NAME.test(name) || name.indexOf('..') >= 0) return ctx.notFound(res);
    return fs.readFile(path.join(ctx.dir, name), function (err, data) {
      if (err) return ctx.notFound(res);
      ctx.send(res, 200, type, data);
    });
  }
  ctx.notFound(res);
}

module.exports = { handle: handle, listPictures: listPictures };
