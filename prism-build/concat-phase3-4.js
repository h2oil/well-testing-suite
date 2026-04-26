#!/usr/bin/env node
// One-shot helper — strips the SELF-TEST IIFE from each Phase 3+4 source
// file and concatenates them with section banners for injection into
// well-testing-app.html.
//
// Run with:  node prism-build/concat-phase3-4.js
// Writes:    prism-build/combined-phase3-4.js
//
// Strategy per file:
//   1. Locate the first occurrence of `// SELF-TEST` or `// === SELF-TEST ===`
//      that is followed (within ~10 lines) by a `(function PRiSM_*SelfTest()`
//      IIFE.
//   2. Truncate the file at the line BEFORE that comment header.
//   3. Re-append the outer IIFE close (`})();`) so the module remains valid.

const fs = require('fs');
const path = require('path');

const FILES = [
  '04-ui-wiring.js',
  '05-regression.js',
  '06-decline-and-specialised.js',
  '07-data-enhancements.js',
];

const ROOT = __dirname;

function stripSelfTest(src, fileLabel) {
  const lines = src.split(/\r?\n/);
  // Find the LAST self-test marker (some files have multiple "SELF-TEST"
  // mentions in earlier comments — the executable one is always last).
  let selfTestStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (/^\/\/\s*=*\s*SELF[-_ ]?TEST\s*=*\s*$/i.test(ln) ||
        /^\/\/\s*SELF[-_ ]?TEST\s*$/i.test(ln)) {
      selfTestStart = i;
      break;
    }
  }
  if (selfTestStart === -1) {
    console.warn(`[WARN] ${fileLabel}: no self-test marker found, leaving unchanged`);
    return src;
  }
  // Walk back over the comment header (=== separator lines and blank lines)
  // so we strip the whole "// === SELF-TEST ===" banner cleanly.
  let cutAt = selfTestStart;
  while (cutAt > 0) {
    const prev = lines[cutAt - 1].trim();
    if (prev.startsWith('//') && /^\/\/\s*=+\s*$/.test(prev)) cutAt--;
    else if (prev === '') cutAt--;
    else break;
  }
  // Find the LAST `})();` in the original file — that's the outer module IIFE.
  let outerClose = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*\}\)\(\);?\s*(\/\/.*)?\s*$/.test(lines[i])) {
      outerClose = i;
      break;
    }
  }
  if (outerClose === -1) {
    console.warn(`[WARN] ${fileLabel}: no outer IIFE close found`);
  }
  const head = lines.slice(0, cutAt);
  // Re-append the closing `})();` of the OUTER IIFE.
  head.push('');
  head.push('})();');
  head.push('');
  const before = lines.length;
  const after = head.length;
  console.log(`[strip] ${fileLabel}: ${before} → ${after} lines (cut self-test starting at line ${selfTestStart + 1})`);
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
  '// PRiSM Phase 3 + 4 expansion — auto-injected from prism-build/\n' +
  '//   • 04-ui-wiring         (Tabs 2-7 render fns + state seed + plot registry)\n' +
  '//   • 05-regression        (Levenberg-Marquardt + bootstrap + sandface conv)\n' +
  '//   • 06-decline-and-specialised (Arps/Duong/SEPD/Fetkovich + 3 PTA models)\n' +
  '//   • 07-data-enhancements (multi-format file parser + filters + col-mapper)\n' +
  '// ═══════════════════════════════════════════════════════════════════════\n';

for (const f of FILES) {
  const p = path.join(ROOT, f);
  const src = fs.readFileSync(p, 'utf8');
  const stripped = stripSelfTest(src, f);
  const label = f.replace(/\.js$/, '');
  combined += banner(label) + stripped + footer(label);
}

const outPath = path.join(ROOT, 'combined-phase3-4.js');
fs.writeFileSync(outPath, combined, 'utf8');
console.log(`\n[ok] wrote ${outPath} (${combined.split('\n').length} lines)`);
