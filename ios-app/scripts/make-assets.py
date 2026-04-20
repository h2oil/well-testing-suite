#!/usr/bin/env python3
"""
Generate icon.png and splash.png for the H2Oil iOS app from the sidebar logo.

Extracts the first base64 PNG in well-testing-app.html, auto-crops it to its
ink bounding box, then composites onto opaque square canvases sized for
`npx @capacitor/assets generate --ios`.

Fill ratios are chosen to avoid Apple's Guideline 2.3.8 "placeholder-looking"
rejection. The H2Oil wordmark (H₂OIL with droplet replacing the "O") fills
92% of the icon's longest axis — dense enough that the brand reads clearly at
every size from 20pt spotlight to 1024pt App Store listing.

Run after any logo change:
    pip install Pillow
    python3 scripts/make-assets.py
    cd ios-app && npx @capacitor/assets generate --ios
"""
from PIL import Image
import base64, os, re, io

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
HTML = os.path.join(ROOT, 'well-testing-app.html')
OUT_DIR = os.path.abspath(os.path.join(HERE, '..', 'resources'))
BG = (13, 17, 23)  # #0d1117

os.makedirs(OUT_DIR, exist_ok=True)

with open(HTML, 'r', encoding='utf-8') as f:
    text = f.read()
m = re.search(r'data:image/png;base64,([A-Za-z0-9+/=]+)', text)
if not m:
    raise SystemExit('No inline PNG found in well-testing-app.html')
logo = Image.open(io.BytesIO(base64.b64decode(m.group(1)))).convert('RGBA')
print(f'Source logo: {logo.size}')

# Auto-crop to ink bounding box (removes the built-in padding around the mark)
alpha_bbox = logo.split()[-1].getbbox()
if alpha_bbox:
    logo = logo.crop(alpha_bbox)
    print(f'Cropped to ink bbox: {logo.size}')


def compose(canvas_size, logo_img, fill_fraction_of_longest_axis, bg):
    """Scale logo to fill fill_fraction of the canvas's longest axis, center,
    and composite onto an opaque square background."""
    target_longest = int(canvas_size * fill_fraction_of_longest_axis)
    w, h = logo_img.size
    if w >= h:
        new_w = target_longest
        new_h = int(h * target_longest / w)
    else:
        new_h = target_longest
        new_w = int(w * target_longest / h)
    scaled = logo_img.resize((new_w, new_h), Image.LANCZOS)
    canvas = Image.new('RGB', (canvas_size, canvas_size), bg)
    ox = (canvas_size - new_w) // 2
    oy = (canvas_size - new_h) // 2
    canvas.paste(scaled, (ox, oy), scaled)
    return canvas


def ink_percent(img, bg, tol=20):
    n = 0
    total = img.width * img.height
    for p in img.getdata():
        if abs(p[0] - bg[0]) > tol or abs(p[1] - bg[1]) > tol or abs(p[2] - bg[2]) > tol:
            n += 1
    return 100 * n / total


# ── Icon: 1024x1024, opaque, logo fills 92% of the longer axis ──
#    Dense branded icon — the H₂OIL wordmark reads cleanly at every size.
#    92% leaves ~4% margin on the dominant axis (iOS rounds corners but this
#    margin keeps the wordmark's extremes away from the rounded corner clip).
icon = compose(1024, logo, 0.92, BG)
icon.save(os.path.join(OUT_DIR, 'icon.png'), 'PNG')
print(f'Wrote icon.png (1024x1024, ink fill: {ink_percent(icon, BG):.1f}%)')

# ── Splash: 2732x2732, opaque, logo fills 60% of the longer axis ──
#    Splashes want a bit more negative space (brand moment, not cramped).
#    60% on 2732 = 1639px logo width — plenty large on all iPads/iPhones.
splash = compose(2732, logo, 0.60, BG)
splash.save(os.path.join(OUT_DIR, 'splash.png'), 'PNG')
splash.save(os.path.join(OUT_DIR, 'splash-dark.png'), 'PNG')
print(f'Wrote splash.png + splash-dark.png (2732x2732, ink fill: {ink_percent(splash, BG):.1f}%)')

# ── Foreground / background split (Android adaptive icons; iOS ignores) ──
fg = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
tl = int(1024 * 0.72)  # Android crops more aggressively
w, h = logo.size
if w >= h:
    nw, nh = tl, int(h * tl / w)
else:
    nh, nw = tl, int(w * tl / h)
scaled = logo.resize((nw, nh), Image.LANCZOS)
fg.paste(scaled, ((1024 - nw) // 2, (1024 - nh) // 2), scaled)
fg.save(os.path.join(OUT_DIR, 'icon-foreground.png'), 'PNG')
Image.new('RGB', (1024, 1024), BG).save(os.path.join(OUT_DIR, 'icon-background.png'), 'PNG')
print('Wrote icon-foreground.png + icon-background.png')

print('\nDone. Next on a Mac: cd ios-app && npm run assets')
