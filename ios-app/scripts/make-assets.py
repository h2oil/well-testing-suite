#!/usr/bin/env python3
"""
Generate icon.png and splash.png for the H2Oil iOS app from the sidebar logo.

Extracts the first base64 PNG in well-testing-app.html (the <img> inside
.mob-header) and produces opaque 1024x1024 / 2732x2732 source images sized
for `npx @capacitor/assets generate --ios`.

Run once on any machine with Python + Pillow:
    pip install Pillow
    python3 scripts/make-assets.py
"""
from PIL import Image
import base64, os, re, io

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
HTML = os.path.join(ROOT, 'well-testing-app.html')
OUT_DIR = os.path.abspath(os.path.join(HERE, '..', 'resources'))
BG = (13, 17, 23)  # #0d1117

os.makedirs(OUT_DIR, exist_ok=True)

# Extract first base64 PNG from the HTML (the sidebar H2Oil logo)
with open(HTML, 'r', encoding='utf-8') as f:
    text = f.read()
m = re.search(r'data:image/png;base64,([A-Za-z0-9+/=]+)', text)
if not m:
    raise SystemExit('No inline PNG found in well-testing-app.html')
logo = Image.open(io.BytesIO(base64.b64decode(m.group(1)))).convert('RGBA')
print(f'Source logo: {logo.size}')


def centered_on_bg(logo_img, canvas_size, logo_fraction, bg):
    """Fit logo inside (canvas_size * logo_fraction) and center on opaque bg."""
    target_w = int(canvas_size * logo_fraction)
    ratio = target_w / logo_img.width
    target_h = int(logo_img.height * ratio)
    scaled = logo_img.resize((target_w, target_h), Image.LANCZOS)
    canvas = Image.new('RGB', (canvas_size, canvas_size), bg)
    ox = (canvas_size - target_w) // 2
    oy = (canvas_size - target_h) // 2
    canvas.paste(scaled, (ox, oy), scaled)
    return canvas


# ── Icon: 1024x1024, opaque, logo at ~72% width ──
icon = centered_on_bg(logo, 1024, 0.72, BG)
icon.save(os.path.join(OUT_DIR, 'icon.png'), 'PNG')
print(f'Wrote icon.png (1024x1024, opaque #0d1117)')

# ── Splash: 2732x2732, opaque, logo at ~45% width ──
splash = centered_on_bg(logo, 2732, 0.45, BG)
splash.save(os.path.join(OUT_DIR, 'splash.png'), 'PNG')
splash.save(os.path.join(OUT_DIR, 'splash-dark.png'), 'PNG')
print(f'Wrote splash.png + splash-dark.png (2732x2732)')

# ── Foreground / background split (Android adaptive icons; iOS ignores) ──
fg = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
target_w = int(1024 * 0.72)
ratio = target_w / logo.width
target_h = int(logo.height * ratio)
scaled = logo.resize((target_w, target_h), Image.LANCZOS)
fg.paste(scaled, ((1024 - target_w) // 2, (1024 - target_h) // 2), scaled)
fg.save(os.path.join(OUT_DIR, 'icon-foreground.png'), 'PNG')
Image.new('RGB', (1024, 1024), BG).save(os.path.join(OUT_DIR, 'icon-background.png'), 'PNG')
print('Wrote icon-foreground.png + icon-background.png')

print('\nDone. Next on a Mac: cd ios-app && npx @capacitor/assets generate --ios')
