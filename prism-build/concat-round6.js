#!/usr/bin/env node
// Round-6 concatenator — feature modules (tooltips + project save + report).

const fs = require('fs');
const path = require('path');

const FILES = [
  '28-help-tooltips.js',
  '29-project-save.js',
  '30-quick-report.js',
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
  const headText = head.join('\n');
  const openCount  = (headText.match(/^\(function\b/gm) || []).length;
  const closeCount = (headText.match(/^\}\)\(\);?\s*$/gm) || []).length;
  if (openCount > closeCount) {
    head.push('');
    head.push('})();');
  }
  head.push('');
  console.log(`[strip] ${fileLabel}: ${lines.length} → ${head.length} lines`);
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
  '// Round-6 (feature layer) — auto-injected\n' +
  '//   • 28-help-tooltips   (ⓘ hover-help on every tagged input + 61 entries)\n' +
  '//   • 29-project-save    (.h2oilproj project file save/load across modules)\n' +
  '//   • 30-quick-report    (one-click cross-suite PDF report)\n' +
  '// ═══════════════════════════════════════════════════════════════════════\n';

for (const f of FILES) {
  const p = path.join(ROOT, f);
  const src = fs.readFileSync(p, 'utf8');
  const stripped = stripSelfTest(src, f);
  const label = f.replace(/\.js$/, '');
  combined += banner(label) + stripped + footer(label);
}

const outPath = path.join(ROOT, 'combined-round6.js');
fs.writeFileSync(outPath, combined, 'utf8');
console.log(`\n[ok] wrote ${outPath} (${combined.split('\n').length} lines)`);
