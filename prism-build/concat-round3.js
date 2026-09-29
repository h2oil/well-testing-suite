#!/usr/bin/env node
// Round-3 concatenator — strips SELF-TEST IIFEs from each file in 16-21
// and concatenates them with section banners.
//
// Run with:  node prism-build/concat-round3.js
// Writes:    prism-build/combined-round3.js

const fs = require('fs');
const path = require('path');

const FILES = [
  '16-pvt.js',
  '17-deconvolution.js',
  '18-tide-analysis.js',
  '19-data-managers.js',
  '20-plt-inverse.js',
  '21-plot-utilities.js',
];

const ROOT = __dirname;

function stripSelfTest(src, fileLabel, logger) {
  const log = logger || console;
  const lines = src.split(/\r?\n/);
  let selfTestStart = -1;
  // Find the LAST self-test marker. Same flexible regex as concat-round2.
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
    '// PRiSM Round-3 expansion — auto-injected from prism-build/\n' +
    '//   • 16-pvt                 (PVT correlations + dimensional conversion)\n' +
    '//   • 17-deconvolution       (von Schroeter-Levitan deconvolution)\n' +
    '//   • 18-tide-analysis       (tidal harmonic regression + ct estimate)\n' +
    '//   • 19-data-managers       (gauge-data + analysis-data + project file)\n' +
    '//   • 20-plt-inverse         (synthetic PLT + inverse rate-from-pressure sim)\n' +
    '//   • 21-plot-utilities      (overlays + diff + XML export + clipboard)\n' +
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

const OUT = path.join(ROOT, 'combined-round3.js');

function main() {
  const combined = build();
  const outPath = OUT;
  fs.writeFileSync(outPath, combined, 'utf8');
  console.log(`\n[ok] wrote ${outPath} (${combined.split('\n').length} lines)`);
}

module.exports = { FILES, OUT, build, stripSelfTest, main };
if (require.main === module) main();
