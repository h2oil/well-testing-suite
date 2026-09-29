#!/usr/bin/env node
// Round-4 concatenator — strips SELF-TEST IIFEs from each file in the
// FILES list and concatenates them with section banners.
//
// Round-4 ships the app-wide unit-system layer (22-units.js). Even
// though it's "global" rather than PRiSM-specific, we keep the
// "Round-N" naming convention for build-pipeline consistency.
//
// Run with:  node prism-build/concat-round4.js
// Writes:    prism-build/combined-round4.js

const fs = require('fs');
const path = require('path');

const FILES = [
  '22-units.js',
];

const ROOT = __dirname;

function stripSelfTest(src, fileLabel, logger) {
  const log = logger || console;
  const lines = src.split(/\r?\n/);
  let selfTestStart = -1;
  // Find the LAST self-test marker. Same flexible regex as round-3.
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (/^\/\/\s*(?:=*|SECTION\s+\d+\s*[—-]?)\s*SELF[-_ ]?TEST\s*=*\s*$/i.test(ln)) {
      selfTestStart = i;
      break;
    }
  }
  if (selfTestStart === -1) {
    log.warn(`[WARN] ${fileLabel}: no self-test marker — leaving unchanged`);
    return src;
  }
  let cutAt = selfTestStart;
  while (cutAt > 0) {
    const prev = lines[cutAt - 1].trim();
    if (prev.startsWith('//') && /^\/\/\s*=+\s*$/.test(prev)) cutAt--;
    else if (prev === '') cutAt--;
    else break;
  }
  const head = lines.slice(0, cutAt);
  let outerCloseLine = '})();';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*\}\)\(\);?\s*(\/\/.*)?\s*$/.test(lines[i])) {
      outerCloseLine = lines[i];
      break;
    }
  }
  head.push('');
  head.push(outerCloseLine);
  head.push('');
  log.log(`[strip] ${fileLabel}: ${lines.length} → ${head.length} lines (cut self-test from line ${selfTestStart + 1})`);
  return head.join('\n');
}

const banner = (label) =>
  '\n' +
  '// ═══════════════════════════════════════════════════════════════════════\n' +
  '// ─── BEGIN ' + label + ' ───────────────────────────────────────────\n' +
  '// ═══════════════════════════════════════════════════════════════════════\n';

const footer = (label) =>
  '\n// ─── END ' + label + ' ─────────────────────────────────────────────\n\n';

// opts.read(fileName) → source text, or null to skip the file
//   (default: read prism-build/<fileName>; a missing file throws, as before).
// opts.log → { log, warn } (default: console).
function build(opts) {
  opts = opts || {};
  const log = opts.log || console;
  const read = opts.read || ((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
  let combined =
    '\n// ═══════════════════════════════════════════════════════════════════════\n' +
    '// PRiSM Round-4 expansion — auto-injected from prism-build/\n' +
    '//   • 22-units              (Imperial/Metric toggle — global to suite)\n' +
    '// ═══════════════════════════════════════════════════════════════════════\n';
  for (const f of FILES) {
    const src = read(f);
    if (src == null) { log.warn(`[WARN] ${f}: not available — skipped`); continue; }
    const stripped = stripSelfTest(src, f, log);
    const label = f.replace(/\.js$/, '');
    combined += banner(label) + stripped + footer(label);
  }
  return combined;
}

const OUT = path.join(ROOT, 'combined-round4.js');

function main() {
  const combined = build();
  const outPath = OUT;
  fs.writeFileSync(outPath, combined, 'utf8');
  console.log(`\n[ok] wrote ${outPath} (${combined.split('\n').length} lines)`);
}

module.exports = { FILES, OUT, build, stripSelfTest, main };
if (require.main === module) main();
