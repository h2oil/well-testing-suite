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

const ROOT = path.resolve(__dirname, '..', '..');
const MAIN_HTML = path.join(ROOT, 'well-testing-app.html');
const IOS_ADDITIONS = path.join(__dirname, '..', 'ios-additions');
const OUTPUT = path.join(__dirname, '..', 'www', 'index.html');

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
// privacy manifest hassle; RevenueCat already handles subscription
// analytics). The markers are added in well-testing-app.html; this
// regex removes everything between them, inclusive.
const gaBefore = html.length;
html = html.replace(/<!--\s*GA:START[\s\S]*?GA:END\s*-->/g, '<!-- GA stripped from iOS bundle -->');
if (html.length !== gaBefore) {
    console.log(`[sync] Stripped Google Analytics block (${gaBefore - html.length} chars)`);
}

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

// ── 3. Capacitor bridge + iOS-specific JS (haptics, share, keyboard, subs) ──
const iosBridge = read(path.join(IOS_ADDITIONS, 'ios-bridge.js'));
const iosSubs = fs.existsSync(path.join(IOS_ADDITIONS, 'ios-subscriptions.js'))
    ? read(path.join(IOS_ADDITIONS, 'ios-subscriptions.js'))
    : '';
// Inject capacitor.js <script> tag before the main <script> block
html = html.replace(
    /(\s*)(<script>\s*\/\*)/,
    `$1<script src="capacitor.js"></script>$1$2`
);
// Inject ios-bridge.js + ios-subscriptions.js inside the IIFE near the end (before })();)
html = html.replace(
    /(\s*)(}\)\(\);\s*<\/script>\s*<\/body>)/,
    `\n\n// ── iOS Native Bridge ──\n${iosBridge}\n\n// ── iOS Subscription Gate ──\n${iosSubs}\n$1$2`
);

// NOTE: the HTML fallback paywall (ios-paywall.html/ios-paywall.css) has
// been removed as of v1.3. The native RC paywall is the only paywall —
// ios-subscriptions.js loops on presentPaywallIfNeeded until the user
// completes the purchase or the SDK reports an error to the console.

// ── 4. Ensure output dir exists ──
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, html, 'utf8');

// ── 5. Copy Capacitor stub + bundled libs (offline PDF export) ──
const capStub = `// Capacitor runtime bridge — replaced by Capacitor at build time.
// In browser (non-native) preview this is a no-op.
window.Capacitor = window.Capacitor || { isNativePlatform: () => false, Plugins: {} };
`;
fs.writeFileSync(path.join(__dirname, '..', 'www', 'capacitor.js'), capStub, 'utf8');

// Copy bundled libraries (jsPDF, html2canvas) into www/ for iOS-offline PDF export.
const LIBS_DIR = path.join(IOS_ADDITIONS, 'libs');
if (fs.existsSync(LIBS_DIR)) {
    const libsOutDir = path.join(__dirname, '..', 'www');
    fs.readdirSync(LIBS_DIR).forEach(f => {
        if (f.endsWith('.js')) {
            fs.copyFileSync(path.join(LIBS_DIR, f), path.join(libsOutDir, f));
        }
    });
    console.log(`[sync] Copied libs/ → www/ (${fs.readdirSync(LIBS_DIR).filter(f => f.endsWith('.js')).length} files)`);
}

const size = (fs.statSync(OUTPUT).size / 1024).toFixed(1);
console.log(`[sync] ✓ Wrote www/index.html (${size} KB)`);
console.log(`[sync] Next: \`npx cap sync ios\` to push to Xcode project`);
