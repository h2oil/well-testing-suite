#!/usr/bin/env node
'use strict';
// prism-build/publish-site.js — the static site's PUBLISH ALLOW-LIST (docs/ACCOUNTS-PLAN.md §13.2, §8.2; WP-OPS).
//
// The static site publishes only an explicit allow-list from a publish directory built here — the app page, sw.js, help/**,
// and, when they exist, the icons, the web manifest and the privacy / legal pages. Functions are never part of the static
// output (the server lives in server/ as a separate functions-only site, server/site/). Nothing changes for the live site
// until the owner points the static site's publish directory at the folder this script writes (server/RUNBOOK.md,
// "Activation checklist" step 0 — a PRECONDITION before server/ reaches master: a site that publishes the repository tree
// would otherwise serve server/, docs/ and prism-build/ as static files); until then the site keeps deploying exactly as v3.4.
//
//   node prism-build/publish-site.js [--out <dir>] [--api] [--extra-connect "<host> …"] [--extra-img "<host> …"]
//        writes the publish directory (default ./dist-site, git-ignored): the allowed files, a `_headers` file with the
//        security headers (and, with --api, the CSP in Report-Only mode reporting to /api/v1/csp-report) and
//        publish-manifest.json (path, bytes, sha256 of every file). Exits 1 if the check below fails (nothing is written).
//   node prism-build/publish-site.js --check [--dir <dir>]
//        the CI check: builds the set in memory (or reads an existing publish dir) and fails (exit 1) when it contains
//        server/, docs/, tools/, prism-build/, ios-app/, *.sql, .env*, PEM / JWK / key files, a PEM private key or a private
//        JWK in any text file, or the NAME of any secret environment variable (server/core/config.js SECRET_ENV plus the ops
//        secrets of server/site/ops-env.js).
//   node prism-build/publish-site.js --list       prints the allowed set
//
//   require('./publish-site') → { ALLOW, collect, checkSet, secretNames, cspHosts, cspPolicy, headersFile, build }
//
// No host or vendor is named here: the CSP's external hosts are read from the page itself (its <script src> tags and its
// pinned library URLs) and from sw.js; collection hosts that appear in neither come from --extra-connect / --extra-img
// (the owner's vendor notes).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

// ── the allow-list ────────────────────────────────────────────────────────────────────────────────────────────────
const ALLOW = {
  required: ['well-testing-app.html', 'sw.js'],
  optional: ['index.html', 'favicon.ico', 'favicon.svg', 'robots.txt', 'manifest.webmanifest', 'site.webmanifest',
    'apple-touch-icon.png', 'privacy.html', 'terms.html'],
  dirs: [
    { dir: 'help/', ext: /\.(?:html?|json|webp|png|jpe?g|svg|css|js)$/i },
    { dir: 'icons/', ext: /\.(?:png|svg|ico|webp)$/i },
    { dir: 'legal/', ext: /\.(?:html?|css|pdf|txt)$/i },
  ],
};

// ── the check ─────────────────────────────────────────────────────────────────────────────────────────────────────
const FORBIDDEN_PREFIX = ['server/', 'docs/', 'tools/', 'prism-build/', 'ios-app/', 'wiki/', '.git/', '.github/', '.claude/', 'node_modules/'];
const FORBIDDEN_NAME = [
  /\.sql$/i, /(^|\/)\.env($|\.)/i, /\.pem$/i, /\.key$/i, /\.jwk$/i, /\.p12$/i, /\.pfx$/i, /(^|\/)id_(rsa|ed25519|ecdsa)/i,
  /(^|\/)package(-lock)?\.json$/i, /\.(?:test|spec)\.js$/i,
];
const TEXT_EXT = /\.(?:html?|js|mjs|json|css|txt|svg|webmanifest|md|xml)$/i;
// built from parts so this file never matches its own patterns
const PEM_PRIVATE = new RegExp('-----BEGIN ' + '(?:[A-Z]+ )?PRIVATE ' + 'KEY-----');
const JWK_PRIVATE = /"kty"\s*:\s*"(?:RSA|EC|OKP)"[^}]{0,4000}"d"\s*:\s*"[A-Za-z0-9_-]{16,}"|"d"\s*:\s*"[A-Za-z0-9_-]{16,}"[^}]{0,4000}"kty"\s*:\s*"(?:RSA|EC|OKP)"/;

function secretNames() {
  const names = new Set();
  try { require('../server/core/config').SECRET_ENV.forEach((n) => names.add(n)); } catch (e) { /* server/ absent: the fallback list */ }
  try { require('../server/site/ops-env').OPS_SECRET_ENV.forEach((n) => names.add(n)); } catch (e) { /* idem */ }
  // the fallback (and a floor): the names of §13.2 even if a server file failed to load
  ['WTS_MASTER_KEYS', 'WTS_INDEX_PEPPER', 'WTS_CODE_PEPPERS', 'WTS_SESSION_PEPPER', 'WTS_PROXY_SIG', 'WTS_OPS_HMAC',
    'WTS_MAIL_CREDENTIAL', 'WTS_OUTBOX_KEY', 'OAUTH_GOOGLE_CLIENT_SECRET', 'OAUTH_LINKEDIN_CLIENT_SECRET', 'WTS_DB_URL',
    'WTS_JOBS_DB_URL', 'WTS_BACKUP_KEY'].forEach((n) => names.add(n));
  return Array.from(names).sort();
}

// entries: [{rel, read() → Buffer}] → {ok, errors:[{path, why}]}
function checkSet(entries) {
  const errors = [];
  const names = secretNames();
  const nameRe = new RegExp('\\b(?:' + names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b');
  const seen = new Set();
  entries.forEach((e) => {
    const rel = String(e.rel).replace(/\\/g, '/');
    if (seen.has(rel)) errors.push({ path: rel, why: 'listed twice' });
    seen.add(rel);
    if (rel.startsWith('/') || rel.split('/').indexOf('..') !== -1) { errors.push({ path: rel, why: 'outside the publish root' }); return; }
    const pre = FORBIDDEN_PREFIX.find((p) => rel === p.slice(0, -1) || rel.startsWith(p));
    if (pre) errors.push({ path: rel, why: 'forbidden folder ' + pre });
    const nm = FORBIDDEN_NAME.find((re) => re.test(rel));
    if (nm) errors.push({ path: rel, why: 'forbidden file type ' + nm });
    if (rel.startsWith('_') || rel === 'publish-manifest.json') return;      // generated by this script (checked by tests)
    if (!TEXT_EXT.test(rel)) return;
    const text = e.read().toString('utf8');
    if (PEM_PRIVATE.test(text)) errors.push({ path: rel, why: 'contains a PEM private key' });
    if (JWK_PRIVATE.test(text)) errors.push({ path: rel, why: 'contains a private JWK' });
    const m = nameRe.exec(text);
    if (m) errors.push({ path: rel, why: 'names the secret variable ' + m[0] });
  });
  return { ok: errors.length === 0, errors };
}

// ── collecting the allowed set from a source tree ─────────────────────────────────────────────────────────────────
function walk(absDir, relDir, out) {
  let ents = [];
  try { ents = fs.readdirSync(absDir, { withFileTypes: true }); } catch (e) { return out; }
  ents.sort((a, b) => (a.name < b.name ? -1 : 1)).forEach((d) => {
    if (d.name.startsWith('.')) return;                              // never a dot file or folder
    const abs = path.join(absDir, d.name); const rel = relDir + d.name;
    if (d.isSymbolicLink()) return;                                  // never follow links out of the tree
    if (d.isDirectory()) walk(abs, rel + '/', out); else if (d.isFile()) out.push({ rel, abs });
  });
  return out;
}
// → [{rel, abs, read()}] ; throws when a required file is missing
function collect(root) {
  root = root || ROOT;
  const out = [];
  ALLOW.required.forEach((f) => {
    const abs = path.join(root, f);
    if (!fs.existsSync(abs)) throw new Error('publish-site: required file missing: ' + f);
    out.push({ rel: f, abs });
  });
  ALLOW.optional.forEach((f) => { const abs = path.join(root, f); if (fs.existsSync(abs) && fs.statSync(abs).isFile()) out.push({ rel: f, abs }); });
  ALLOW.dirs.forEach((d) => {
    walk(path.join(root, d.dir), d.dir, []).filter((e) => d.ext.test(e.rel)).forEach((e) => out.push(e));
  });
  return out.map((e) => Object.assign(e, { read: () => fs.readFileSync(e.abs) }));
}
function readDir(dir) {
  return walk(path.resolve(dir), '', []).map((e) => Object.assign(e, { read: () => fs.readFileSync(e.abs) }));
}

// ── security headers and the Report-Only CSP (§8.2) ───────────────────────────────────────────────────────────────
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
// external hosts the page loads code from: <script src>, pinned library URLs (.js / .mjs / .wasm) and CDN base prefixes
function cspHosts(html, swText) {
  const hosts = new Set();
  const add = (h) => { h = String(h || '').toLowerCase(); if (HOST_RE.test(h)) hosts.add(h); };
  const texts = [String(html || ''), String(swText || '')];
  texts.forEach((t) => {
    let m;
    const tag = /<script\b[^>]*\bsrc\s*=\s*["']https:\/\/([^/"'?#]+)/gi;
    while ((m = tag.exec(t))) add(m[1]);
    const lib = /["'`]https:\/\/([a-z0-9.-]+)\/[^"'`\s]*\.(?:m?js|wasm)["'`]/gi;
    while ((m = lib.exec(t))) add(m[1]);
    const base = /["'`]https:\/\/([a-z0-9.-]+)\/(?:npm\/)?["'`]/gi;
    while ((m = base.exec(t))) add(m[1]);
  });
  return Array.from(hosts).sort();
}
function hostList(s) { return String(s || '').split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter((h) => HOST_RE.test(h)); }
function cspPolicy(o) {
  o = o || {};
  const code = (o.hosts || []).map((h) => 'https://' + h);
  const connectX = hostList(o.extraConnect).map((h) => 'https://' + h);
  const imgX = hostList(o.extraImg).map((h) => 'https://' + h);
  const uniq = (a) => Array.from(new Set(a));
  const d = [
    ['default-src', ["'self'"]],
    ['script-src', uniq(["'self'", "'unsafe-inline'", "'unsafe-eval'", 'blob:'].concat(code))],
    ['worker-src', ["'self'", 'blob:']],
    ['connect-src', uniq(["'self'"].concat(code, connectX, ['ws://127.0.0.1:*', 'ws://localhost:*', 'http://localhost:*', 'http://127.0.0.1:*']))],
    ['img-src', uniq(["'self'", 'data:', 'blob:'].concat(imgX))],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['font-src', ["'self'", 'data:']],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ];
  if (o.reportUri) d.push(['report-uri', [o.reportUri]], ['report-to', ['csp']]);
  return d.map((x) => x[0] + ' ' + x[1].join(' ')).join('; ');
}
const SECURITY_HEADERS = [
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'same-origin'],
  ['Permissions-Policy', 'publickey-credentials-get=(self), publickey-credentials-create=(self)'],
  ['Strict-Transport-Security', 'max-age=31536000'],
];
const NO_CACHE_PATHS = ['/', '/index.html', '/well-testing-app.html', '/sw.js'];
// the common `_headers` text format (path line, then indented "Name: value" lines)
function headersFile(o) {
  o = o || {};
  const lines = ['# GENERATED by prism-build/publish-site.js — security headers of docs/ACCOUNTS-PLAN.md §8.2 (never edit by hand)', '/*'];
  SECURITY_HEADERS.forEach((h) => lines.push('  ' + h[0] + ': ' + h[1]));
  if (o.api) {
    lines.push('  Content-Security-Policy-Report-Only: ' + cspPolicy({ hosts: o.hosts, extraConnect: o.extraConnect, extraImg: o.extraImg, reportUri: '/api/v1/csp-report' }));
    lines.push('  Reporting-Endpoints: csp="/api/v1/csp-report"');
  }
  NO_CACHE_PATHS.forEach((p) => { lines.push(p); lines.push('  Cache-Control: no-cache'); });
  lines.push('/api/*');
  lines.push('  Cache-Control: no-store');
  return lines.join('\n') + '\n';
}

// ── build ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function build(o) {
  o = o || {};
  const root = o.root || ROOT;
  const entries = collect(root);
  const chk = checkSet(entries);
  if (!chk.ok) return { ok: false, errors: chk.errors, files: entries.map((e) => e.rel) };
  const html = fs.readFileSync(path.join(root, 'well-testing-app.html'), 'utf8');
  const swText = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const hosts = cspHosts(html, swText);
  const headers = headersFile({ api: !!o.api, hosts, extraConnect: o.extraConnect, extraImg: o.extraImg });
  const manifest = { generated: 'prism-build/publish-site.js', api: !!o.api, files: entries.map((e) => { const b = e.read(); return { path: e.rel, bytes: b.length, sha256: sha256(b) }; }) };
  if (o.out) {
    const out = path.resolve(o.out);
    const rootAbs = path.resolve(root);
    if (out === rootAbs || rootAbs.startsWith(out + path.sep)) throw new Error('publish-site: --out must not be the source tree or a parent of it');
    fs.rmSync(out, { recursive: true, force: true });
    entries.forEach((e) => { const f = path.join(out, e.rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.copyFileSync(e.abs, f); });
    fs.writeFileSync(path.join(out, '_headers'), headers);
    fs.writeFileSync(path.join(out, 'publish-manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  }
  return { ok: true, errors: [], files: entries.map((e) => e.rel), hosts, headers, manifest };
}

module.exports = { ALLOW, FORBIDDEN_PREFIX, collect, readDir, checkSet, secretNames, cspHosts, cspPolicy, headersFile, SECURITY_HEADERS, build };

if (require.main === module) {
  const a = process.argv.slice(2);
  const val = (k) => { const i = a.indexOf(k); return i !== -1 && a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : null; };
  try {
    if (a.includes('--list')) { collect(ROOT).forEach((e) => console.log(e.rel)); process.exit(0); }
    if (a.includes('--check')) {
      const dir = val('--dir');
      const entries = dir ? readDir(dir) : collect(ROOT);
      const r = checkSet(entries);
      if (!r.ok) { r.errors.forEach((e) => console.error('[publish-check] ' + e.path + ': ' + e.why)); console.error('[publish-check] FAILED (' + r.errors.length + ')'); process.exit(1); }
      console.log('[publish-check] ok — ' + entries.length + ' files, none outside the allow-list, no key material, no secret names');
      process.exit(0);
    }
    const r = build({ out: val('--out') || path.join(ROOT, 'dist-site'), api: a.includes('--api'), extraConnect: val('--extra-connect'), extraImg: val('--extra-img') });
    if (!r.ok) { r.errors.forEach((e) => console.error('[publish-site] ' + e.path + ': ' + e.why)); process.exit(1); }
    console.log('[publish-site] wrote ' + r.files.length + ' files + _headers + publish-manifest.json (CSP Report-Only: ' + (a.includes('--api') ? 'on' : 'off') + ')');
  } catch (e) { console.error('[publish-site] ' + e.message); process.exit(2); }
}
