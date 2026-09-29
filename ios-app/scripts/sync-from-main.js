#!/usr/bin/env node
/**
 * sync-from-main.js
 *
 * Single source of truth: ../well-testing-app.html
 *
 * This script reads the main HTML file and injects iOS-specific
 * enhancements (safe-area CSS, meta tags, Capacitor bridge) to produce
 * ios-app/www/index.html.
 *
 * Run this any time the main HTML file changes. `npm run build` runs
 * this automatically before `cap sync`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const MAIN_HTML = path.join(ROOT, 'well-testing-app.html');
const IOS_ADDITIONS = path.join(__dirname, '..', 'ios-additions');
// WTS_SYNC_OUT_DIR lets tests write the bundle to a scratch folder instead of ios-app/www.
const WWW = process.env.WTS_SYNC_OUT_DIR ? path.resolve(process.env.WTS_SYNC_OUT_DIR) : path.join(__dirname, '..', 'www');
const OUTPUT = path.join(WWW, 'index.html');

function read(p) {
    if (!fs.existsSync(p)) {
        throw new Error(`Missing file: ${p}`);
    }
    return fs.readFileSync(p, 'utf8');
}

console.log(`[sync] Reading ${path.relative(ROOT, MAIN_HTML)}`);
let html = read(MAIN_HTML);

// ── 0. Strip web-only blocks flagged <!-- GA:START --> ... <!-- GA:END -->
// Google Analytics and any similar network-analytics snippets live only
// on the web version. iOS builds shouldn't phone home to Google (Apple
// privacy manifest hassle — the iOS app declares no data collection).
// The markers are added in well-testing-app.html; this regex removes
// everything between them, inclusive.
const gaBefore = html.length;
html = html.replace(/<!--\s*GA:START[\s\S]*?GA:END\s*-->/g, '<!-- GA stripped from iOS bundle -->');
if (html.length !== gaBefore) {
    console.log(`[sync] Stripped Google Analytics block (${gaBefore - html.length} chars)`);
}

// (The in-app Release Notes are engineering-only and identical on web and
// iOS, so no release-note filtering is needed here.)

// ── 1. iOS-specific <meta> tags for status bar, web app mode, viewport ──
// Replaces the source viewport entirely — ios-meta.html contains the
// enhanced iOS viewport (viewport-fit=cover) as its last line, so we
// drop the basic one and inject the full iOS meta block in its place.
const iosMeta = read(path.join(IOS_ADDITIONS, 'ios-meta.html'));
html = html.replace(
    /<meta name="viewport"[^>]*>/,
    () => iosMeta.trim()
);

// ── 2. iOS-specific CSS (safe-area, tap highlight, bounce-lock) ──
const iosCss = read(path.join(IOS_ADDITIONS, 'ios-styles.css'));
html = html.replace(
    /(\s*)(<\/style>)/,
    `\n        /* ── iOS additions ── */\n${iosCss}$1$2`
);

// ── 3. Capacitor bridge + iOS-specific JS (haptics, share, file export) ──
const iosBridge = read(path.join(IOS_ADDITIONS, 'ios-bridge.js'));
// Inject capacitor.js <script> tag before the main <script> block
html = html.replace(
    /(\s*)(<script>\s*\/\*)/,
    `$1<script src="capacitor.js"></script>$1$2`
);
// Inject ios-bridge.js inside the IIFE near the end (before })();)
html = html.replace(
    /(\s*)(}\)\(\);\s*<\/script>\s*<\/body>)/,
    `\n\n// ── iOS Native Bridge ──\n${iosBridge}\n$1$2`
);

// NOTE: the iOS app is free and fully unlocked — there is no subscription
// gate, paywall or in-app-purchase SDK. It loads straight into the full app.

// ── 4. Ensure output dir exists ──
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, html, 'utf8');

// ── 5. Copy Capacitor stub + bundled libs (offline PDF export) ──
const capStub = `// Capacitor runtime bridge — replaced by Capacitor at build time.
// In browser (non-native) preview this is a no-op.
window.Capacitor = window.Capacitor || { isNativePlatform: () => false, Plugins: {} };
`;
fs.writeFileSync(path.join(WWW, 'capacitor.js'), capStub, 'utf8');

// Copy bundled libraries into www/ next to index.html (served at capacitor://localhost/<file>):
//   jsPDF + html2canvas  — iOS-offline PDF export
//   three.module.min.js  — three.js r170 for the offline 3D view (ios-bridge.js sets
//                          window.WTS3D_LOCAL_URL to it; 32-wts-3d.js still checks its SHA-384)
const LIBS_DIR = path.join(IOS_ADDITIONS, 'libs');
if (fs.existsSync(LIBS_DIR)) {
    const libsOutDir = WWW;
    fs.readdirSync(LIBS_DIR).forEach(f => {
        if (f.endsWith('.js')) {
            fs.copyFileSync(path.join(LIBS_DIR, f), path.join(libsOutDir, f));
        }
    });
    console.log(`[sync] Copied libs/ → www/ (${fs.readdirSync(LIBS_DIR).filter(f => f.endsWith('.js')).length} files)`);
}

// ── 6. three.js integrity: the bundled copy must match the SHA-384 pinned in 32-wts-3d.js.
// A mismatch is not fatal (the app then falls back to the CDN / 2D) but is loud, so a
// three.js bump without re-bundling is caught here rather than on a device.
const THREE_LIB = path.join(WWW, 'three.module.min.js');
const pin = /THREE_SHA384\s*=\s*'([A-Za-z0-9+/=]+)'/.exec(html);
if (fs.existsSync(THREE_LIB) && pin) {
    const got = crypto.createHash('sha384').update(fs.readFileSync(THREE_LIB)).digest('base64');
    if (got === pin[1]) console.log('[sync] three.module.min.js SHA-384 matches the pinned hash (offline 3D ready)');
    else console.warn('[sync] WARNING: www/three.module.min.js SHA-384 ' + got + ' does not match the pinned ' + pin[1] +
                      ' — the app will reject it and the 3D view needs the network. Re-bundle ios-additions/libs/three.module.min.js.');
} else if (!fs.existsSync(THREE_LIB)) {
    console.warn('[sync] WARNING: three.module.min.js not bundled — the 3D view will need the network on first use.');
}

const size = (fs.statSync(OUTPUT).size / 1024).toFixed(1);
console.log(`[sync] ✓ Wrote www/index.html (${size} KB)`);
console.log(`[sync] Next: \`npx cap sync ios\` to push to Xcode project`);
