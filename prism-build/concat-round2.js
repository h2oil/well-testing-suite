#!/usr/bin/env node
// Round-2 concatenator — strips SELF-TEST IIFEs from each Phase 5/6/7
// + polish + crop + auto-match + interpretation + annotations source
// and concatenates them with section banners.
//
// Run with:  node prism-build/concat-round2.js
// Writes:    prism-build/combined-round2.js

const fs = require('fs');
const path = require('path');

const FILES = [
  '08-composite-multilayer.js',
  '09-interference-multilateral.js',
  '10-specialised-solvers.js',
  '11-polish.js',
  '12-data-crop.js',
  '13-auto-match.js',
  '14-interpretation.js',
  '15-diagnostic-annotations.js',
];

const ROOT = __dirname;

function stripSelfTest(src, fileLabel) {
  const lines = src.split(/\r?\n/);
  let selfTestStart = -1;
  // Find the LAST self-test marker. Accepts:
  //   // SELF-TEST
  //   // === SELF-TEST ===
  //   // SECTION N — SELF-TEST
  //   (with or without leading whitespace, with various separators)
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
  // Walk back over comment-banner separator lines + blank lines.
  let cutAt = selfTestStart;
  while (cutAt > 0) {
    const prev = lines[cutAt - 1].trim();
    if (prev.startsWith('//') && /^\/\/\s*=+\s*$/.test(prev)) cutAt--;
    else if (prev === '') cutAt--;
    else break;
  }
  const head = lines.slice(0, cutAt);
  // Find LAST `})();` in original — that's the outer module IIFE close.
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
  const before = lines.length;
  const after = head.length;
  console.log(`[strip] ${fileLabel}: ${before} → ${after} lines (cut self-test from line ${selfTestStart + 1})`);
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
  '// PRiSM Round-2 expansion — auto-injected from prism-build/\n' +
  '//   • 08-composite-multilayer        (Phase 5: 7 composite/multi-layer single-well)\n' +
  '//   • 09-interference-multilateral   (Phase 6: 16 interference + multi-lateral)\n' +
  '//   • 10-specialised-solvers         (Phase 7: #18 user-defined + #38 water injection)\n' +
  '//   • 11-polish                      (14 SVG schematics + 20 analysis keys + PNG + GA4)\n' +
  '//   • 12-data-crop                   (interactive Data-tab crop/trim chart)\n' +
  '//   • 13-auto-match                  (regime classifier + LM model race + top-N ranking)\n' +
  '//   • 14-interpretation              (plain-English fit narrative + actions + cautions)\n' +
  '//   • 15-diagnostic-annotations      (auto-Bourdet-L picker + plot-regime markers)\n' +
  '// ═══════════════════════════════════════════════════════════════════════\n';

for (const f of FILES) {
  const p = path.join(ROOT, f);
  const src = fs.readFileSync(p, 'utf8');
  const stripped = stripSelfTest(src, f);
  const label = f.replace(/\.js$/, '');
  combined += banner(label) + stripped + footer(label);
}

const outPath = path.join(ROOT, 'combined-round2.js');
fs.writeFileSync(outPath, combined, 'utf8');
console.log(`\n[ok] wrote ${outPath} (${combined.split('\n').length} lines)`);
