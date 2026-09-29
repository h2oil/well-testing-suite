#!/usr/bin/env node
// Phase 1+2 concatenator — rebuilds the foundation / models / plots block
// (01-foundation → 03-models → 02-plots, the order the host HTML has always
// used) with the self-test IIFEs stripped, so the Phase 1+2 region of
// well-testing-app.html is regenerable like every later round.
//
// Run with:  node prism-build/concat-phase1-2.js
// Writes:    prism-build/combined-phase1-2.js
// (combined.js is the historical Phase 1+2 artefact and is left untouched.)
//
// Strip rule per file: remove from the `// === SELF-TEST ===` marker line
// (the LAST such marker) through the column-0 `})();` that closes the
// self-test IIFE that follows it. Anything after that close (03-models'
// outer `})();  // end IIFE`) is kept. If no marker is present, the named
// self-test IIFE (`(function PRiSM_selfTest() {`, `(function _selfTest() {`,
// `(function PRiSM_plot_selftest() {`) is removed on its own.
//
// require()-able: module.exports = { FILES, OUT, build, stripSelfTest, main }.

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const FILES = [
  '01-foundation.js',
  '03-models.js',
  '02-plots.js',
];
const OUT = path.join(ROOT, 'combined-phase1-2.js');

const SELFTEST_IIFE = /^\s*\(function\s+(PRiSM_selfTest|_selfTest|PRiSM_plot_selftest)\s*\(\)\s*\{/;
const MARKER = /^\s*\/\/\s*=+\s*SELF[-_ ]?TEST\b/i;
const COL0_CLOSE = /^\}\)\(\);?\s*(\/\/.*)?$/;

function stripSelfTest(src, fileLabel, logger) {
  const log = logger || console;
  const lines = src.split(/\r?\n/);
  let marker = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (MARKER.test(lines[i])) { marker = i; break; }
  }
  // The self-test IIFE: first `(function …() {` after the marker, or (no
  // marker) the last named self-test IIFE in the file.
  let start = -1;
  if (marker !== -1) {
    for (let i = marker + 1; i < lines.length; i++) {
      if (/^\s*\(function\b/.test(lines[i])) { start = i; break; }
    }
  } else {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (SELFTEST_IIFE.test(lines[i])) { start = i; break; }
    }
  }
  if (start === -1) {
    log.warn(`[WARN] ${fileLabel}: no self-test block found — leaving unchanged`);
    return src.replace(/\r\n/g, '\n');
  }
  let close = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (COL0_CLOSE.test(lines[i])) { close = i; break; }
  }
  if (close === -1) close = lines.length - 1;   // unterminated: cut to EOF
  const cutFrom = marker !== -1 ? marker : start;
  const kept = lines.slice(0, cutFrom).concat(lines.slice(close + 1));
  log.log(`[strip] ${fileLabel}: ${lines.length} → ${kept.length} lines ` +
          `(cut self-test lines ${cutFrom + 1}-${close + 1})`);
  return kept.join('\n');
}

const RULE = '═'.repeat(74);
const begin = (label) => '// ─── BEGIN ' + label + ' ' + '─'.repeat(49);
const end   = (label) => '// ─── END ' + label + ' ' + '─'.repeat(51);

// opts.read(fileName) → source text (default: read from prism-build/).
// opts.log  → { log, warn } (default: console).
function build(opts) {
  opts = opts || {};
  const log = opts.log || console;
  const read = opts.read || ((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
  let combined =
    '// ' + RULE + '\n' +
    '// PRiSM ─ Pressure Reservoir Inversion & Simulation Model\n' +
    '// Auto-assembled from prism-build/{01-foundation,03-models,02-plots}.js\n' +
    '// by prism-build/concat-phase1-2.js (self-tests stripped)\n' +
    '// ' + RULE + '\n\n';
  for (const f of FILES) {
    const src = read(f);
    if (src == null) { log.warn(`[WARN] ${f}: missing — skipped`); continue; }
    const label = f.replace(/\.js$/, '');
    combined += begin(label) + '\n' + stripSelfTest(src, f, log) + '\n' + end(label) + '\n\n';
  }
  return combined;
}

function main() {
  const combined = build();
  fs.writeFileSync(OUT, combined, 'utf8');
  console.log(`\n[ok] wrote ${OUT} (${combined.split('\n').length} lines)`);
}

module.exports = { FILES, OUT, build, stripSelfTest, main };
if (require.main === module) main();
