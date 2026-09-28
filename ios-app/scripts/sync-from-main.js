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
// privacy manifest hassle — the iOS app declares no data collection).
// The markers are added in well-testing-app.html; this regex removes
// everything between them, inclusive.
const gaBefore = html.length;
html = html.replace(/<!--\s*GA:START[\s\S]*?GA:END\s*-->/g, '<!-- GA stripped from iOS bundle -->');
if (html.length !== gaBefore) {
    console.log(`[sync] Stripped Google Analytics block (${gaBefore - html.length} chars)`);
}

// ── 0b. Drop in-app Release Notes entries about the old iOS subscription
// work. The iOS app is free with no in-app purchases; release-note text
// mentioning paywalls / subscription pricing / web-only subscriptions
// would be misleading in the iOS build (and is an App Review risk). The
// web build keeps them. Entries look like:
//     { date:'…', tag:'…', title:'…',
//       details:'…' },
// Only entries whose text matches the pattern below are removed; if the
// release-notes format ever changes this is a harmless no-op.
const RELEASE_ENTRY_RE = /\r?\n[ \t]*\{ date:'[^'\n]*',\s*tag:'[^'\n]*',\s*title:'(?:[^'\\\n]|\\.)*',\s*details:'(?:[^'\\\n]|\\.)*' \},?/g;
// (vendor name of the removed subscription SDK is matched as revenue\s?cat)
const IOS_MONETISATION_RE = /revenue\s?cat|paywall|subscription|entitlement/i;
let droppedNotes = 0;
html = html.replace(RELEASE_ENTRY_RE, (entry) => {
    if (IOS_MONETISATION_RE.test(entry)) { droppedNotes++; return ''; }
    return entry;
});
if (droppedNotes) {
    console.log(`[sync] Dropped ${droppedNotes} subscription-related Release Notes entr${droppedNotes === 1 ? 'y' : 'ies'} from iOS bundle`);
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
