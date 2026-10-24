'use strict';
/*
 * Draws the launcher icons (apps/webos-launcher/icon.png 80x80 and
 * largeIcon.png 130x130) with pngjs, so no image editor is needed.
 * A TV with a cyan-to-magenta frame and a small phone in front.
 *
 *   npm run icons
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function mix(a, b, t) { return a + (b - a) * t; }
function hex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

function draw(size) {
  const png = new PNG({ width: size, height: size });
  const S = 4; // supersampling
  const c1 = hex('#22e6ff'), c2 = hex('#ff3df2'), bg = hex('#0b0e24'), screen = hex('#151a3d');
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size, v = (y + (sy + 0.5) / S) / size;
          let col = null;
          // background tile
          if (sdRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.2) <= 0) { col = bg; }
          // TV frame (gradient) and screen
          const dTv = sdRoundRect(u, v, 0.47, 0.44, 0.33, 0.23, 0.06);
          if (dTv <= 0) {
            const t = Math.max(0, Math.min(1, (u - 0.14) / 0.66));
            col = [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)];
            if (sdRoundRect(u, v, 0.47, 0.44, 0.28, 0.18, 0.03) <= 0) col = screen;
          }
          // stand
          if (sdRoundRect(u, v, 0.47, 0.72, 0.12, 0.025, 0.02) <= 0) col = [170, 140, 255];
          // play triangle on the screen
          const tx = u - 0.40, ty = v - 0.44;
          if (tx >= 0 && tx <= 0.14 && Math.abs(ty) <= 0.08 * (1 - tx / 0.14)) col = [255, 255, 255];
          // phone in front (bottom right)
          if (sdRoundRect(u, v, 0.76, 0.68, 0.1, 0.17, 0.035) <= 0) {
            col = [255, 255, 255];
            if (sdRoundRect(u, v, 0.76, 0.665, 0.075, 0.125, 0.015) <= 0) col = c2;
          }
          if (col) { acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 255; }
        }
      }
      const n = S * S;
      const o = (y * size + x) * 4;
      const cov = acc[3] / 255;
      png.data[o] = cov ? Math.round(acc[0] / cov) : 0;
      png.data[o + 1] = cov ? Math.round(acc[1] / cov) : 0;
      png.data[o + 2] = cov ? Math.round(acc[2] / cov) : 0;
      png.data[o + 3] = Math.round(acc[3] / n);
    }
  }
  return PNG.sync.write(png);
}

const dir = path.join(__dirname, '..', 'apps', 'webos-launcher');
fs.writeFileSync(path.join(dir, 'icon.png'), draw(80));
fs.writeFileSync(path.join(dir, 'largeIcon.png'), draw(130));
console.log('Iconos creados en ' + dir);

// Android TV / Fire TV app (apps/android-tv/): the same art as launcher icons.
// The 320x180 TV banner (drawable-xhdpi/banner.png) is the 192 px icon plus
// the name: python3 apps/android-tv/make-banner.py (needs Pillow).
const res = path.join(__dirname, '..', 'apps', 'android-tv', 'app', 'src', 'main', 'res');
const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
Object.keys(DENSITIES).forEach(function (d) {
  const out = path.join(res, 'mipmap-' + d);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'ic_launcher.png'), draw(DENSITIES[d]));
});
console.log('Iconos de Android creados en ' + res);
