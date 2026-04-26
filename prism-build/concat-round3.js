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

function stripSelfTest(src, fileLabel) {
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
    console.warn(`[WARN] ${fileLabel}: no self-test marker — leaving unchanged`);
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
  console.log(`[strip] ${fileLabel}: ${lines.length} → ${head.length} lines (cut self-test from line ${selfTestStart + 1})`);
  return head.join('\n');
}

const banner = (label) =>
  '\n' +
  '// ═══════════════════════════════════════════════════════════════════════\n' +
  '// ─── BEGIN ' + label + ' ───────────────────────────────────────────\n' +
  '// ═══════════════════════════════════════════════════════════════════════\n';

const footer = (label) =>
  '\n// ─── END ' + label + ' ─────────────────────────────────────────────\n\n';

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
  const p = path.join(ROOT, f);
  const src = fs.readFileSync(p, 'utf8');
  const stripped = stripSelfTest(src, f);
  const label = f.replace(/\.js$/, '');
  combined += banner(label) + stripped + footer(label);
}

const outPath = path.join(ROOT, 'combined-round3.js');
fs.writeFileSync(outPath, combined, 'utf8');
console.log(`\n[ok] wrote ${outPath} (${combined.split('\n').length} lines)`);
