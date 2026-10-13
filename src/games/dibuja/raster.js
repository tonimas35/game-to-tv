'use strict';
/*
 * Very small stroke-to-PNG rasterizer (pure JavaScript + pngjs).
 * Takes the strokes as stored by the server:
 *   { c: '#rrggbb', w: width (fraction of the width), p: [x0, y0, x1, y1, ...] }  (0..1)
 * Smooths like the browsers do (quadratic curves through midpoints) and
 * paints thick round-capped lines by computing, for every nearby pixel, the
 * distance to the segment (1 px anti-aliased edge).
 *
 * renderPngAsync() runs in a worker_thread so the game loop never blocks;
 * if workers are not available it runs on the main thread.
 */
const { PNG } = require('pngjs');

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  const n = m ? parseInt(m[1], 16) : 0x1a1a1a;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Convierte los puntos de un trazo en una polilínea densa (en píxeles)
function flatten(p, W, H) {
  const pts = [];
  const n = Math.floor(p.length / 2);
  if (n === 0) return pts;
  const X = function (i) { return p[i * 2] * W; };
  const Y = function (i) { return p[i * 2 + 1] * H; };
  pts.push([X(0), Y(0)]);
  if (n === 1) return pts;
  if (n === 2) { pts.push([X(1), Y(1)]); return pts; }
  let sx = X(0), sy = Y(0);
  for (let i = 1; i < n - 1; i++) {
    const cx = X(i), cy = Y(i);
    const ex = (X(i) + X(i + 1)) / 2, ey = (Y(i) + Y(i + 1)) / 2;
    const len = Math.hypot(cx - sx, cy - sy) + Math.hypot(ex - cx, ey - cy);
    const steps = Math.max(1, Math.min(32, Math.ceil(len / 4)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, u = 1 - t;
      pts.push([u * u * sx + 2 * u * t * cx + t * t * ex, u * u * sy + 2 * u * t * cy + t * t * ey]);
    }
    sx = ex; sy = ey;
  }
  pts.push([X(n - 1), Y(n - 1)]);
  return pts;
}

function renderPng(strokes, W, H) {
  W = W || 800;
  H = H || 600;
  const png = new PNG({ width: W, height: H });
  const data = png.data;
  data.fill(255);
  const mask = new Uint8Array(W * H);

  (strokes || []).forEach(function (st) {
    if (!st || !st.p || st.p.length < 2) return;
    const rgb = hexToRgb(st.c);
    const r = Math.max(0.7, (Number(st.w) || 0.01) * W / 2);
    const pts = flatten(st.p, W, H);
    let minX = W, minY = H, maxX = -1, maxY = -1;

    function segment(ax, ay, bx, by) {
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1)), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + r + 1));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1)), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + r + 1));
      if (x0 > x1 || y0 > y1) return;
      if (x0 < minX) minX = x0; if (y0 < minY) minY = y0;
      if (x1 > maxX) maxX = x1; if (y1 > maxY) maxY = y1;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const rr = (r + 0.5) * (r + 0.5);
      for (let yy = y0; yy <= y1; yy++) {
        const py = yy + 0.5 - ay;
        const row = yy * W;
        for (let xx = x0; xx <= x1; xx++) {
          const px = xx + 0.5 - ax;
          let t = len2 > 0 ? (px * dx + py * dy) / len2 : 0;
          if (t < 0) t = 0; else if (t > 1) t = 1;
          const ex = px - t * dx, ey = py - t * dy;
          const d2 = ex * ex + ey * ey;
          if (d2 >= rr) continue;
          const cov = r + 0.5 - Math.sqrt(d2);
          const v = cov >= 1 ? 255 : Math.round(cov * 255);
          if (v > mask[row + xx]) mask[row + xx] = v;
        }
      }
    }

    if (pts.length === 1) segment(pts[0][0], pts[0][1], pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) segment(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);

    // Composición del trazo y limpieza de la máscara (solo en su caja)
    for (let yy = minY; yy <= maxY; yy++) {
      for (let xx = minX; xx <= maxX; xx++) {
        const k = yy * W + xx;
        const m = mask[k];
        if (!m) continue;
        mask[k] = 0;
        const o = k * 4;
        if (m === 255) {
          data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2];
        } else {
          const a = m / 255;
          data[o] = Math.round(data[o] * (1 - a) + rgb[0] * a);
          data[o + 1] = Math.round(data[o + 1] * (1 - a) + rgb[1] * a);
          data[o + 2] = Math.round(data[o + 2] * (1 - a) + rgb[2] * a);
        }
      }
    }
  });

  return PNG.sync.write(png);
}

function renderPngAsync(strokes, W, H) {
  return new Promise(function (resolve, reject) {
    let Worker;
    try { Worker = require('worker_threads').Worker; } catch (e) { Worker = null; }
    if (!Worker) {
      try { resolve(renderPng(strokes, W, H)); } catch (e) { reject(e); }
      return;
    }
    let done = false;
    let w;
    try {
      w = new Worker(__filename, { workerData: { strokes: strokes, W: W, H: H } });
    } catch (e) {
      try { resolve(renderPng(strokes, W, H)); } catch (err) { reject(err); }
      return;
    }
    const timer = setTimeout(function () {
      if (done) return;
      done = true;
      try { w.terminate(); } catch (e) { /* noop */ }
      reject(new Error('tiempo agotado dibujando el PNG'));
    }, 30000);
    w.once('message', function (buf) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Buffer.from(buf));
    });
    w.once('error', function (e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    w.once('exit', function (code) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error('el worker terminó con código ' + code));
    });
  });
}

// Dentro del worker: dibuja y devuelve el PNG
try {
  const wt = require('worker_threads');
  if (!wt.isMainThread && wt.workerData && wt.workerData.strokes) {
    const buf = renderPng(wt.workerData.strokes, wt.workerData.W, wt.workerData.H);
    wt.parentPort.postMessage(buf);
  }
} catch (e) { /* noop */ }

module.exports = { renderPng: renderPng, renderPngAsync: renderPngAsync };
