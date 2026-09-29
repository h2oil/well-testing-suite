#!/usr/bin/env node
// Round-8 concatenator — PRiSM gap-closure layer (PTA core, semilog/skin,
// RTA + DCA results, report, workflow shell content).
//
// Run with:  node prism-build/concat-round8.js
// Writes:    prism-build/combined-round8.js
//
// Files that do not exist yet are skipped with a warning so partial landings
// still build. Self-tests are stripped exactly like Round-5/6 (last
// `// SELF-TEST` / `// === SELF-TEST ===` / `// SECTION N — SELF-TEST`
// marker to EOF, re-closing the module IIFE only if the cut unbalanced it).
//
// require()-able: module.exports = { FILES, OUT, build, stripSelfTest, main }.

const fs = require('fs');
const path = require('path');

const FILES = [
  '33-pta-core.js',
  '34-semilog-skin.js',
  '35-rta-dca.js',
  '36-report.js',
  '37-prism-workflow.js',
  '39-prism-fieldtools.js',
  '51-prism-workspace.js',
  '52-prism-gas.js',
];

const ROOT = __dirname;
const OUT = path.join(ROOT, 'combined-round8.js');

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
    return lines.join('\n');
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

function defaultRead(f) {
  const p = path.join(ROOT, f);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

// opts.read(fileName) → source text, or null when the file is unavailable.
// opts.log → { log, warn } (default: console).
function build(opts) {
  opts = opts || {};
  const log = opts.log || console;
  const read = opts.read || defaultRead;
  let combined =
    '\n// ═══════════════════════════════════════════════════════════════════════\n' +
    '// PRiSM Round-8 (gap closure) — auto-injected from prism-build/\n' +
    '//   • 33-pta-core          (Well & Test store, analysis data, physical model, lastFit, persistence)\n' +
    '//   • 34-semilog-skin      (MDH / Horner / superposition semilog + skin)\n' +
    '//   • 35-rta-dca           (decline results + rate-transient analysis)\n' +
    '//   • 36-report            (Tab 7 report + CSV export)\n' +
    '//   • 37-prism-workflow    (workflow shell content: flow periods, rail, tools)\n' +
    '//   • 39-prism-fieldtools  (gauge register, sequence of events, ct builder)\n' +
    '//   • 51-prism-workspace   (fit library + compare overlays, analysis branches, model browser)\n' +
    '//   • 52-prism-gas         (gas m(p) results, pseudo-time, skin vs rate, AOF / IPR)\n' +
    '// ═══════════════════════════════════════════════════════════════════════\n';
  let included = 0;
  for (const f of FILES) {
    const src = read(f);
    if (src == null) { log.warn(`[WARN] ${f}: not present — skipped`); continue; }
    const stripped = stripSelfTest(src, f, log);
    const label = f.replace(/\.js$/, '');
    combined += banner(label) + stripped + footer(label);
    included++;
  }
  log.log(`[round8] ${included}/${FILES.length} files included`);
  return combined;
}

function main() {
  const combined = build();
  fs.writeFileSync(OUT, combined, 'utf8');
  console.log(`\n[ok] wrote ${OUT} (${combined.split('\n').length} lines)`);
}

module.exports = { FILES, OUT, build, stripSelfTest, main };
if (require.main === module) main();
