#!/usr/bin/env node
'use strict';
// server/ci/secret-scan.js — the secret scan of docs/ACCOUNTS-PLAN.md §13.2 / T27 (WP-OPS). Runs in the tagged release
// workflow and in server/test (ops-site.test.js). It fails (exit 1) when a scanned file contains key material or a secret
// value — never when it only NAMES a secret variable (code reads them from process.env).
//
//   node server/ci/secret-scan.js [path …]     default: server/ and .github/workflows/ (tracked files when git is there)
//        --json   one JSON line {files, findings:[{file, line, rule}]}  (the matched text is never printed)
//
// Rules:
//   key-file      a tracked .env*, *.pem, *.key, *.p12 / *.pfx, *.jwk or id_rsa-style file
//   pem-private   a PEM private-key header
//   jwk-private   a JWK object with a private member "d"
//   secret-literal  a secret variable name (core/config.js SECRET_ENV, site/ops-env.js OPS_SECRET_ENV) assigned a literal of
//                 ≥ 20 characters with high entropy (placeholders such as 'test-proxy-sig' or '<set by the owner>' pass)
//   named-literal a name containing secret / token / password / api key / private key assigned a high-entropy literal
//   url-password  a URL with an embedded password for a host other than localhost / 127.0.0.1
// False positives go into server/ci/secret-scan-allow.json as {file, line: sha256 of the trimmed line} — never the value.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const SKIP_DIR = new Set(['node_modules', 'dist', '.git', '.tmp']);
const KEY_FILE = /(^|\/)(\.env(\..*)?|[^/]+\.(pem|key|p12|pfx|jwk)|id_(rsa|ed25519|ecdsa)(\.pub)?)$/i;
const TEXT = /\.(js|mjs|cjs|json|sql|md|yml|yaml|sh|txt|toml|html|css|ts)$|(^|\/)[^.]+$/i;
// built from parts so that this file never matches its own rules
const PEM = new RegExp('-----BEGIN ' + '(?:[A-Z]+ )?PRIVATE ' + 'KEY-----');
const JWK = /"kty"\s*:\s*"(?:RSA|EC|OKP)"[^}]{0,4000}"d"\s*:\s*"[A-Za-z0-9_-]{16,}"|"d"\s*:\s*"[A-Za-z0-9_-]{16,}"[^}]{0,4000}"kty"\s*:\s*"(?:RSA|EC|OKP)"/;
const URL_PW = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"`]{1,64}:([^\s@'"`/]{6,})@([^\s/:'"`]+)/i;
const NAMED = /\b[A-Za-z_]*(?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key)[A-Za-z_]*\b\s*[:=]\s*['"`]([^'"`\s]{20,})['"`]/i;

function secretNames() {
  const out = new Set();
  try { require('../core/config').SECRET_ENV.forEach((n) => out.add(n)); } catch (e) { /* standalone */ }
  try { require('../site/ops-env').OPS_SECRET_ENV.forEach((n) => out.add(n)); } catch (e) { /* standalone */ }
  return Array.from(out);
}
function entropy(s) {
  const f = {}; for (const c of s) f[c] = (f[c] || 0) + 1;
  let h = 0; const n = s.length; Object.keys(f).forEach((c) => { const p = f[c] / n; h -= p * Math.log2(p); });
  return h;
}
const looksSecret = (v) => v.length >= 20 && entropy(v) >= 3.5 && /[0-9]/.test(v) && /[A-Za-z]/.test(v) && !/^\$\{|^<|^https?:\/\/[^:@]*$|process\.env|secrets\./.test(v);

function listFiles(roots) {
  const files = [];
  const add = (rel) => { if (!rel.split('/').some((p) => SKIP_DIR.has(p))) files.push(rel); };
  let tracked = null;
  try { tracked = cp.execFileSync('git', ['ls-files', '-z', '--'].concat(roots), { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); } catch (e) { tracked = null; }
  if (tracked) {
    // tracked files plus untracked, not-ignored ones (a key dropped into the tree before a commit)
    let others = [];
    try { others = cp.execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard', '--'].concat(roots), { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); } catch (e) { others = []; }
    tracked.concat(others).forEach(add);
    return Array.from(new Set(files)).sort();
  }
  const walk = (rel) => {
    const abs = path.join(REPO, rel);
    let st; try { st = fs.statSync(abs); } catch (e) { return; }
    if (st.isDirectory()) fs.readdirSync(abs).forEach((n) => { if (!SKIP_DIR.has(n)) walk(rel ? rel + '/' + n : n); });
    else add(rel);
  };
  roots.forEach((r) => walk(r.replace(/\/$/, '')));
  return Array.from(new Set(files)).sort();
}

function loadAllow() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'secret-scan-allow.json'), 'utf8')); } catch (e) { return []; }
}
const lineSha = (l) => crypto.createHash('sha256').update(l.trim()).digest('hex');

// text → [{line, rule}] (pure; used by the tests)
function scanText(text, names) {
  names = names || secretNames();
  const found = [];
  const nameRe = names.length ? new RegExp('\\b(' + names.join('|') + ')\\b\\s*[:=]\\s*[\'"`]([^\'"`\\s]{20,})[\'"`]') : null;
  if (JWK.test(text)) {
    const idx = text.search(JWK); found.push({ line: text.slice(0, idx).split('\n').length, rule: 'jwk-private', text: '' });
  }
  text.split('\n').forEach((l, i) => {
    const n = i + 1;
    if (PEM.test(l)) found.push({ line: n, rule: 'pem-private', text: l });
    let m;
    if (nameRe && (m = nameRe.exec(l)) && looksSecret(m[2])) found.push({ line: n, rule: 'secret-literal', text: l });
    else if ((m = NAMED.exec(l)) && looksSecret(m[1])) found.push({ line: n, rule: 'named-literal', text: l });
    if ((m = URL_PW.exec(l)) && !/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(m[2]) && !/^(\$\{|<|\*+$|password$|pass$|secret$|xxx)/i.test(m[1])) found.push({ line: n, rule: 'url-password', text: l });
  });
  return found;
}

function scan(roots) {
  roots = roots && roots.length ? roots : ['server', '.github/workflows'];
  const names = secretNames();
  const allow = loadAllow();
  const allowed = (file, text) => allow.some((a) => a.file === file && a.line === lineSha(text));
  const files = listFiles(roots);
  const findings = [];
  files.forEach((rel) => {
    if (KEY_FILE.test(rel)) { findings.push({ file: rel, line: 0, rule: 'key-file' }); return; }
    if (!TEXT.test(rel)) return;
    let text; try { text = fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch (e) { return; }
    if (text.length > 4 * 1024 * 1024) return;
    scanText(text, names).forEach((f) => { if (!allowed(rel, f.text)) findings.push({ file: rel, line: f.line, rule: f.rule }); });
  });
  return { files: files.length, findings };
}

module.exports = { scan, scanText, entropy, looksSecret, secretNames, KEY_FILE };

if (require.main === module) {
  const a = process.argv.slice(2);
  const r = scan(a.filter((x) => !x.startsWith('--')));
  if (a.includes('--json')) console.log(JSON.stringify(r));
  else {
    r.findings.forEach((f) => console.error('[secret-scan] ' + f.file + ':' + f.line + ' ' + f.rule));
    console.log('[secret-scan] ' + r.files + ' files, ' + r.findings.length + ' finding' + (r.findings.length === 1 ? '' : 's'));
  }
  process.exit(r.findings.length ? 1 : 0);
}
