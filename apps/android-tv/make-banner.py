#!/usr/bin/env python3
"""Leanback banner (320x180, drawable-xhdpi/banner.png) for Android TV.

Same art as the launcher icon (scripts/make-icons.js draws it; this takes the
xxxhdpi one) next to the app name, on the app's dark background.
Needs Pillow: pip install pillow. Run after `npm run icons`:

    python3 apps/android-tv/make-banner.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, 'app', 'src', 'main', 'res')
W, H, S = 320, 180, 4  # supersampled

FONTS = [
    '/usr/share/fonts/truetype/google-fonts/Poppins-ExtraBold.ttf',
    '/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
]


def font(size):
    for f in FONTS:
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


img = Image.new('RGBA', (W * S, H * S), (7, 9, 21, 255))
# Soft purple glow, like the TV page and the loading screen
glow = Image.new('RGBA', img.size, (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
for i in range(60, 0, -1):
    a = int(110 * (1 - i / 60) ** 2)
    r = i * 7 * S
    gd.ellipse([W * S * 0.3 - r, H * S * 0.35 - r * 0.6, W * S * 0.3 + r, H * S * 0.35 + r * 0.6], fill=(26, 20, 64, a))
img = Image.alpha_composite(img, glow)

icon = Image.open(os.path.join(RES, 'mipmap-xxxhdpi', 'ic_launcher.png')).convert('RGBA')
isz = 112 * S
icon = icon.resize((isz, isz), Image.LANCZOS)
img.alpha_composite(icon, (14 * S, (H * S - isz) // 2))

d = ImageDraw.Draw(img)
x = 136 * S
f1 = font(30 * S)
f2 = font(30 * S)
d.text((x, 52 * S), 'Juegos', font=f1, fill=(169, 139, 255, 255))
d.text((x, 88 * S), 'del Salón', font=f2, fill=(255, 255, 255, 255))
d.rectangle([x, 132 * S, x + 150 * S, 134 * S], fill=(34, 230, 255, 255))

out = os.path.join(RES, 'drawable-xhdpi', 'banner.png')
os.makedirs(os.path.dirname(out), exist_ok=True)
img.resize((W, H), Image.LANCZOS).convert('RGB').save(out, optimize=True)
print('Banner:', out)
