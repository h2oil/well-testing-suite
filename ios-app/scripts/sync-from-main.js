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
// WTS_SYNC_MAIN_HTML lets tests sync a scratch copy of the built page (e.g. with Round 10 rebuilt in memory).
const MAIN_HTML = process.env.WTS_SYNC_MAIN_HTML ? path.resolve(process.env.WTS_SYNC_MAIN_HTML) : path.join(ROOT, 'well-testing-app.html');
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

// ── 0b. Strip the offline service-worker registration (web only). The iOS app
// loads from capacitor://localhost and already ships every file locally; a
// service worker there would only cache stale copies. The host code also
// refuses to register outside http(s) or inside a native Capacitor shell.
const swBefore = html.length;
html = html.replace(/\/\/ ── SW:START[\s\S]*?\/\/ ── SW:END ──/g, '// (offline service worker: web only — stripped from the iOS bundle)');
if (html.length !== swBefore) {
    console.log(`[sync] Stripped the web service-worker block (${swBefore - html.length} chars)`);
}

// ── 0c / 0d. Strip the web-only accounts and cloud-sync code (docs/ACCOUNTS-PLAN.md §9, layer 1). The account
// client files (prism-build/66-68) and the host hooks sit between ACCT markers; the iOS app is free, local and has no
// accounts. 0c = the JS form, 0d = the HTML form. The sync FAILS (no www/index.html is written) when the START / END
// counts differ or when any account identifier survives the strip.
const ACCT_JS_RE = /\/\/ ── ACCT:START[\s\S]*?\/\/ ── ACCT:END ──/g;
const ACCT_HTML_RE = /<!--\s*ACCT:START[\s\S]*?ACCT:END\s*-->/g;
let acctWrote = false;
function acctFail(msg) {
    if (acctWrote) { try { fs.rmSync(OUTPUT, { force: true }); } catch (e) { /* ignore */ } }
    console.error('[sync] ERROR: ' + msg + ' — www/index.html NOT written (docs/ACCOUNTS-PLAN.md §9)');
    process.exit(1);
}
{
    const jsStarts = (html.match(/\/\/ ── ACCT:START/g) || []).length;
    const jsEnds = (html.match(/\/\/ ── ACCT:END ──/g) || []).length;
    const htStarts = (html.match(/<!--\s*ACCT:START/g) || []).length;
    const htEnds = (html.match(/ACCT:END\s*-->/g) || []).length;
    if (jsStarts !== jsEnds) acctFail('ACCT JS markers unbalanced (' + jsStarts + ' START, ' + jsEnds + ' END)');
    if (htStarts !== htEnds) acctFail('ACCT HTML markers unbalanced (' + htStarts + ' START, ' + htEnds + ' END)');
    const acctBefore = html.length;
    html = html.replace(ACCT_JS_RE, '// (accounts and cloud sync: web only — stripped from the iOS bundle)');
    html = html.replace(ACCT_HTML_RE, '<!-- account control: web only -->');
    if (/ACCT:START|ACCT:END/.test(html)) acctFail('an ACCT marker survived the strip (nested or malformed block)');
    if (html.length !== acctBefore) {
        console.log(`[sync] Stripped the web-only accounts blocks (${jsStarts} JS, ${htStarts} HTML; ${acctBefore - html.length} chars)`);
    }
    const ACCT_IDS = ['WTS_account', 'WTS_cloudSync', '/api/v1', 'wts_account_host', 'wtsacct_', '/auth/oauth', 'wts_oa',
        'Continue with Google', 'Sign in with Google', 'Sign in with LinkedIn', 'LinkedIn',
        // WP-C1: the account page, dialog, status bar, device store and beta flag (docs/ACCOUNTS-PLAN.md §9, §11.4)
        'WTS_accountPage', 'wts_sync_bar', 'acct_root', 'acct_dlg', 'wts-sync', 'wtspref_cloud'];
    const left = ACCT_IDS.filter((t) => html.indexOf(t) !== -1);
    if (left.length) acctFail('account identifiers remain outside ACCT markers: ' + left.join(', '));
    // "Google" may appear once: the analytics sentence of the privacy text (baseline pinned; WP-H checks the sentence).
    const google = (html.match(/Google/g) || []).length;
    if (google > 1) acctFail('"Google" appears ' + google + ' times (the baseline is the one analytics sentence)');
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
acctWrote = true;

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
//   sqlite3.mjs + sqlite3.wasm   — official SQLite WASM build (historian, 47-calc-historian.js)
//   sql-wasm.js + sql-wasm.wasm  — sql.js (historian fallback engine; also reads .sqlite backups)
const LIBS_DIR = path.join(IOS_ADDITIONS, 'libs');
const LIB_RE = /\.(js|mjs|wasm)$/;
if (fs.existsSync(LIBS_DIR)) {
    const libsOutDir = WWW;
    const libFiles = fs.readdirSync(LIBS_DIR).filter(f => LIB_RE.test(f));
    libFiles.forEach(f => fs.copyFileSync(path.join(LIBS_DIR, f), path.join(libsOutDir, f)));
    console.log(`[sync] Copied libs/ → www/ (${libFiles.length} files)`);
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

// ── 7. Historian SQLite libraries: every file pinned in HIST_SHA384 (47-calc-historian.js)
// must be bundled with exactly that hash, or the app falls back to the CDN / IndexedDB.
const histPins = /HIST_SHA384\s*=\s*\{([\s\S]*?)\}/.exec(html);
if (histPins) {
    const re = /'([\w.-]+)':\s*'([A-Za-z0-9+/=]+)'/g;
    let m, ok = 0, bad = 0;
    while ((m = re.exec(histPins[1]))) {
        const f = path.join(WWW, m[1]);
        if (!fs.existsSync(f)) { bad++; console.warn('[sync] WARNING: historian library ' + m[1] + ' is not bundled — the app will need the network (or use IndexedDB).'); continue; }
        const got = crypto.createHash('sha384').update(fs.readFileSync(f)).digest('base64');
        if (got === m[2]) ok++;
        else { bad++; console.warn('[sync] WARNING: www/' + m[1] + ' SHA-384 ' + got + ' does not match the pinned ' + m[2] + ' — re-bundle ios-additions/libs/' + m[1] + '.'); }
    }
    if (ok && !bad) console.log('[sync] historian SQLite libraries: ' + ok + ' files match their pinned SHA-384 (offline SQLite ready)');
}

// ── 8. Help centre files (docs/HELP-GUIDE-PLAN.md §3.2): served at capacitor://localhost/help/… so the guides'
// screenshots and the printable user guide work offline in the app. www/help/ is rebuilt from scratch, and only
// help/img/**/*.webp, help/img/manifest.json and help/user-guide.html are copied (nothing else under help/).
// WTS_SYNC_HELP_DIR lets tests point at a scratch help/ folder.
const HELP_SRC = process.env.WTS_SYNC_HELP_DIR ? path.resolve(process.env.WTS_SYNC_HELP_DIR) : path.join(ROOT, 'help');
const HELP_OUT = path.join(WWW, 'help');
fs.rmSync(HELP_OUT, { recursive: true, force: true });
if (fs.existsSync(HELP_SRC)) {
    const copied = [];
    const copy = (rel) => {
        const to = path.join(HELP_OUT, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(HELP_SRC, rel), to);
        copied.push(rel);
    };
    const walk = (dir, rel) => {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).sort().forEach((n) => {
            const p = path.join(dir, n), r = rel + '/' + n;
            if (fs.statSync(p).isDirectory()) walk(p, r);
            else if (/\.webp$/i.test(n)) copy(r);
        });
    };
    walk(path.join(HELP_SRC, 'img'), 'img');
    if (fs.existsSync(path.join(HELP_SRC, 'img', 'manifest.json'))) copy('img/manifest.json');
    if (fs.existsSync(path.join(HELP_SRC, 'user-guide.html'))) copy('user-guide.html');
    console.log(`[sync] Copied help/ → www/help/ (${copied.length} files)`);
}

// ── 9. www/help must carry no account material (docs/ACCOUNTS-PLAN.md §9, layer 1).
if (fs.existsSync(HELP_OUT)) {
    if (fs.existsSync(path.join(HELP_OUT, 'img', 'account'))) acctFail('www/help/img/account/ (an account shot folder) was copied');
    const guide = path.join(HELP_OUT, 'user-guide.html');
    if (fs.existsSync(guide)) {
        const g = fs.readFileSync(guide, 'utf8');
        const bad = ['Google', 'LinkedIn', 'Sign in', 'wts_account_host'].filter((t) => g.indexOf(t) !== -1);
        if (bad.length) acctFail('www/help/user-guide.html contains account material: ' + bad.join(', '));
    }
}

const size = (fs.statSync(OUTPUT).size / 1024).toFixed(1);
console.log(`[sync] ✓ Wrote www/index.html (${size} KB)`);
console.log(`[sync] Next: \`npx cap sync ios\` to push to Xcode project`);
