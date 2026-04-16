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

// ── 1. iOS-specific <meta> tags for status bar, web app mode, viewport ──
const iosMeta = read(path.join(IOS_ADDITIONS, 'ios-meta.html'));
html = html.replace(
    /<meta name="viewport"[^>]*>/,
    (m) => m + '\n    ' + iosMeta.trim()
);

// ── 2. iOS-specific CSS (safe-area, tap highlight, bounce-lock) ──
const iosCss = read(path.join(IOS_ADDITIONS, 'ios-styles.css'));
html = html.replace(
    /(\s*)(<\/style>)/,
    `\n        /* ── iOS additions ── */\n${iosCss}$1$2`
);

// ── 3. Capacitor bridge + iOS-specific JS (haptics, share, keyboard) ──
const iosBridge = read(path.join(IOS_ADDITIONS, 'ios-bridge.js'));
// Inject capacitor.js <script> tag before the main <script> block
html = html.replace(
    /(\s*)(<script>\s*\/\*)/,
    `$1<script src="capacitor.js"></script>$1$2`
);
// Inject ios-bridge.js content inside the IIFE near the end (before })();)
html = html.replace(
    /(\s*)(}\)\(\);\s*<\/script>\s*<\/body>)/,
    `\n\n// ── iOS Native Bridge ──\n${iosBridge}\n$1$2`
);

// ── 4. Ensure output dir exists ──
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, html, 'utf8');

// ── 5. Copy capacitor.js stub (replaced at runtime by Capacitor native bridge) ──
const capStub = `// Capacitor runtime bridge — replaced by Capacitor at build time.
// In browser (non-native) preview this is a no-op.
window.Capacitor = window.Capacitor || { isNativePlatform: () => false, Plugins: {} };
`;
fs.writeFileSync(path.join(__dirname, '..', 'www', 'capacitor.js'), capStub, 'utf8');

const size = (fs.statSync(OUTPUT).size / 1024).toFixed(1);
console.log(`[sync] ✓ Wrote www/index.html (${size} KB)`);
console.log(`[sync] Next: \`npx cap sync ios\` to push to Xcode project`);
