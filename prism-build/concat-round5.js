#!/usr/bin/env node
// Round-5 concatenator — strips SELF-TEST IIFEs from each file in 23-27
// (Test System Safety modules) and concatenates them with section banners.
//
// Run with:  node prism-build/concat-round5.js
// Writes:    prism-build/combined-round5.js

const fs = require('fs');
const path = require('path');

const FILES = [
  '23-esd-hipilot.js',
  '24-esd-lopilot.js',
  '25-hydrate.js',
  '26-liquidline.js',
  '27-pipelife.js',
];

const ROOT = __dirname;

function stripSelfTest(src, fileLabel) {
  const lines = src.split(/\r?\n/);
  let selfTestStart = -1;
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
  // Balance check: only append `})();` if the truncated head has more
  // `(function` opens than `})()` closes. Round-2/3/4 agents nested their
  // self-test IIFE INSIDE the module IIFE (need to re-close after cut).
  // Some Round-5 agents put self-test as a SEPARATE top-level IIFE, so
  // the module IIFE is already balanced before the cut.
  const headText = head.join('\n');
  const openCount  = (headText.match(/^\(function\b/gm) || []).length;
  const closeCount = (headText.match(/^\}\)\(\);?\s*$/gm) || []).length;
  if (openCount > closeCount) {
    head.push('');
    head.push('})();');
    console.log(`         (appended ${openCount - closeCount} closing IIFE)`);
  } else {
    console.log(`         (already balanced; ${openCount} open / ${closeCount} close)`);
  }
  head.push('');
  console.log(`[strip] ${fileLabel}: ${lines.length} → ${head.length} lines (cut self-test from line ${selfTestStart + 1})`);
  return head.join('\n');
}

const banner = (label) =>
  '\n// ═══════════════════════════════════════════════════════════════════════\n' +
  '// ─── BEGIN ' + label + ' ───────────────────────────────────────────\n' +
  '// ═══════════════════════════════════════════════════════════════════════\n';

const footer = (label) =>
  '\n// ─── END ' + label + ' ─────────────────────────────────────────────\n\n';

let combined =
  '\n// ═══════════════════════════════════════════════════════════════════════\n' +
  '// Test System Safety (Round-5 expansion) — auto-injected\n' +
  '//   • 23-esd-hipilot   (gas release during ESD response window)\n' +
  '//   • 24-esd-lopilot   (leak-detection drawdown sizing)\n' +
  '//   • 25-hydrate       (per-segment hydrate temp + inhibitor injection)\n' +
  '//   • 26-liquidline    (gas blowby + RO sizing + flammability radii)\n' +
  '//   • 27-pipelife      (Salama sand-erosion service life per segment)\n' +
  '// ═══════════════════════════════════════════════════════════════════════\n';

for (const f of FILES) {
  const p = path.join(ROOT, f);
  const src = fs.readFileSync(p, 'utf8');
  const stripped = stripSelfTest(src, f);
  const label = f.replace(/\.js$/, '');
  combined += banner(label) + stripped + footer(label);
}

const outPath = path.join(ROOT, 'combined-round5.js');
fs.writeFileSync(outPath, combined, 'utf8');
console.log(`\n[ok] wrote ${outPath} (${combined.split('\n').length} lines)`);
