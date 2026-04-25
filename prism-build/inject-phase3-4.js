#!/usr/bin/env node
// Idempotently injects prism-build/combined-phase3-4.js into
// well-testing-app.html, immediately after the existing legacy-migration
// shim (which closes the Phase 1+2 PRiSM block) and before the WTS section.
//
// Markers used to find the splice point (substring matches, no regex
// metacharacters in the host so the search is robust):
//   START sentinel comment is auto-inserted on first run for re-runs.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'well-testing-app.html');
const BLOB = path.join(__dirname, 'combined-phase3-4.js');

const START = '// ── PRiSM Phase 3+4 injection START ──';
const END   = '// ── PRiSM Phase 3+4 injection END ──';

const html = fs.readFileSync(HTML, 'utf8');
const blob = fs.readFileSync(BLOB, 'utf8');

const wrapped = '\n' + START + '\n' + blob + '\n' + END + '\n';

let out;
const startIdx = html.indexOf(START);
if (startIdx !== -1) {
  // Already injected — replace the block.
  const endIdx = html.indexOf(END, startIdx);
  if (endIdx === -1) {
    console.error('Found START sentinel but no END sentinel — aborting');
    process.exit(1);
  }
  const blockEnd = endIdx + END.length;
  out = html.slice(0, startIdx) + START + '\n' + blob + '\n' + END + html.slice(blockEnd);
  console.log('[replace] Replaced existing Phase 3+4 block');
} else {
  // First-time inject: splice in after the migration shim.
  // The migration shim ends with this exact line (verified by Read).
  // Host file uses CRLF line endings (Windows); match them.
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const ANCHOR = 'renderPRiSM.__h2oilMigrated = true;' + eol + '}' + eol;
  const anchorIdx = html.indexOf(ANCHOR);
  if (anchorIdx === -1) {
    console.error('Could not find migration-shim anchor — aborting');
    console.error('(searched for: ' + JSON.stringify(ANCHOR) + ')');
    process.exit(1);
  }
  const insertAt = anchorIdx + ANCHOR.length;
  out = html.slice(0, insertAt) + wrapped + html.slice(insertAt);
  console.log('[insert] Injected Phase 3+4 block at offset ' + insertAt +
              ' (line ' + (html.slice(0, insertAt).split('\n').length) + ')');
}

fs.writeFileSync(HTML, out, 'utf8');
const total = out.split('\n').length;
const added = total - html.split('\n').length;
console.log('[ok] wrote ' + HTML);
console.log('     before: ' + html.split('\n').length + ' lines');
console.log('     after:  ' + total + ' lines (+' + added + ')');
