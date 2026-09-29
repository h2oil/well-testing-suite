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

function stripSelfTest(src, fileLabel, logger) {
  const log = logger || console;
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
  const headText = head.join('\n');
  const openCount  = (headText.match(/^\(function\b/gm) || []).length;
  const closeCount = (headText.match(/^\}\)\(\);?\s*$/gm) || []).length;
  if (openCount > closeCount) {
    head.push('');
    head.push('})();');
  }
  head.push('');
  log.log(`[strip] ${fileLabel}: ${lines.length} → ${head.length} lines`);
  return head.join('\n');
}

const banner = (label) =>
  '\n// ═══════════════════════════════════════════════════════════════════════\n' +
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
    '// Round-6 (feature layer) — auto-injected\n' +
    '//   • 28-help-tooltips   (ⓘ hover-help on every tagged input + 61 entries)\n' +
    '//   • 29-project-save    (.h2oilproj project file save/load across modules)\n' +
    '//   • 30-quick-report    (one-click cross-suite PDF report)\n' +
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

const OUT = path.join(ROOT, 'combined-round6.js');

function main() {
  const combined = build();
  const outPath = OUT;
  fs.writeFileSync(outPath, combined, 'utf8');
  console.log(`\n[ok] wrote ${outPath} (${combined.split('\n').length} lines)`);
}

module.exports = { FILES, OUT, build, stripSelfTest, main };
if (require.main === module) main();
