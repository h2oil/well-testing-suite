#!/usr/bin/env node
// Round-9 concatenator — plug-in calculators.
//
// Run with:  node prism-build/concat-round9.js
// Writes:    prism-build/combined-round9.js
//
// FILES is not a hand-kept list: every prism-build/4N-calc-*.js (N = 0-9) is
// picked up automatically, in numeric order (ties by name). Each file
// registers itself in window.WTS_calcRegistry, so adding a calculator never
// touches the host route table, sidebar or dashboard (see CLAUDE.md
// "Adding a calculator"). Self-tests are stripped exactly like Round-8 (last
// `// SELF-TEST` / `// === SELF-TEST ===` / `// SECTION N — SELF-TEST` marker
// to EOF, re-closing the module IIFE only if the cut unbalanced it).
//
// A file that never mentions WTS_calcRegistry is still included, with a
// warning (it would render nowhere).
//
// require()-able: module.exports = { PATTERN, FILES, OUT, listFiles, build, stripSelfTest, main }.
//   build({ read, log, extraFiles }) — extraFiles: names that may not exist on
//   disk (the test harness passes its in-memory override names); they are
//   filtered by PATTERN and merged into the directory listing.

const fs = require('fs');
const path = require('path');
const { stripSelfTest } = require('./concat-round8');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'combined-round9.js');
const PATTERN = /^4[0-9]-calc-[\w.-]+\.js$/;

function _num(f) { return parseInt(f, 10); }
function sortFiles(list) {
  return Array.from(new Set(list)).filter((f) => PATTERN.test(f))
    .sort((a, b) => (_num(a) - _num(b)) || (a < b ? -1 : a > b ? 1 : 0));
}

function listFiles(extra) {
  let names = [];
  try { names = fs.readdirSync(ROOT); } catch (e) { names = []; }
  return sortFiles(names.concat(extra || []));
}

const FILES = listFiles();   // snapshot at require time (build() re-lists)

const banner = (label) =>
  '\n// ═══════════════════════════════════════════════════════════════════════\n' +
  '// ─── BEGIN ' + label + ' ───────────────────────────────────────────\n' +
  '// ═══════════════════════════════════════════════════════════════════════\n';

const footer = (label) =>
  '\n// ─── END ' + label + ' ─────────────────────────────────────────────\n\n';

function defaultRead(f) {
  const p = path.join(ROOT, f);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

// opts.read(fileName) → source text, or null when the file is unavailable.
// opts.log → { log, warn } (default: console).
// opts.extraFiles → additional candidate names (see header).
function build(opts) {
  opts = opts || {};
  const log = opts.log || console;
  const read = opts.read || defaultRead;
  const files = listFiles(opts.extraFiles);
  let combined =
    '\n// ═══════════════════════════════════════════════════════════════════════\n' +
    '// Round-9 (calculators) — auto-injected from prism-build/4N-calc-*.js\n' +
    '//   Each file registers window.WTS_calcRegistry[key] = { key, title, sub, group, icon, render(body) };\n' +
    '//   the host render() / sidebar / dashboard pick the entries up (no route-table edit).\n' +
    (files.length ? files.map((f) => '//   • ' + f.replace(/\.js$/, '')).join('\n') + '\n' : '//   (no calculator files)\n') +
    '// ═══════════════════════════════════════════════════════════════════════\n';
  let included = 0;
  for (const f of files) {
    const src = read(f);
    if (src == null) { log.warn(`[WARN] ${f}: not present — skipped`); continue; }
    if (src.indexOf('WTS_calcRegistry') === -1) log.warn(`[WARN] ${f}: does not register in window.WTS_calcRegistry`);
    const stripped = stripSelfTest(src, f, log);
    const label = f.replace(/\.js$/, '');
    combined += banner(label) + stripped + footer(label);
    included++;
  }
  log.log(`[round9] ${included}/${files.length} calculator files included`);
  return combined;
}

function main() {
  const combined = build();
  fs.writeFileSync(OUT, combined, 'utf8');
  console.log(`\n[ok] wrote ${OUT} (${combined.split('\n').length} lines)`);
}

module.exports = { PATTERN, FILES, OUT, listFiles, build, stripSelfTest, main };
if (require.main === module) main();
