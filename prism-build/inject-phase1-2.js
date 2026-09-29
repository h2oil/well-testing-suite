#!/usr/bin/env node
// Idempotently injects prism-build/combined-phase1-2.js (01 → 03 → 02) into
// well-testing-app.html.
//
// First run (no sentinels yet): replaces from the `// ═══…` header line that
// precedes `// PRiSM ─ Pressure Reservoir Inversion & Simulation Model`
// through the `// ─── END 02-plots ───…` line with
//     // ── PRiSM Phase 1+2 injection START ──
//     <blob>
//     // ── PRiSM Phase 1+2 injection END ──
// The legacy DCA/PTA migration shim that follows END 02-plots is left
// untouched (it stays after the END sentinel).
// Later runs: replace everything between the START/END sentinels.
//
// CRLF-aware: the blob is written with the host file's line ending.
// Refuses to write if the HTML changed on disk while this script ran.
//
// require()-able: module.exports = { START, END, BLOB, HTML, inject, main }.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'well-testing-app.html');
const BLOB = path.join(__dirname, 'combined-phase1-2.js');

const START = '// ── PRiSM Phase 1+2 injection START ──';
const END   = '// ── PRiSM Phase 1+2 injection END ──';
const TITLE = '// PRiSM ─ Pressure Reservoir Inversion & Simulation Model';
const LAST  = '// ─── END 02-plots ';

function fail(msg) { const e = new Error(msg); e.injectFailure = true; throw e; }

// Pure function: returns { out, mode, line }. Throws on a malformed host.
function inject(html, blob) {
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const body = blob.replace(/\r\n/g, '\n').replace(/\n/g, eol);
  const startIdx = html.indexOf(START);
  if (startIdx !== -1) {
    const endIdx = html.indexOf(END, startIdx);
    if (endIdx === -1) fail('Found Phase 1+2 START sentinel but no END sentinel — aborting');
    const out = html.slice(0, startIdx) + START + eol + body + eol + END + html.slice(endIdx + END.length);
    return { out, mode: 'replace', line: html.slice(0, startIdx).split('\n').length };
  }
  // First run — locate the auto-assembled Phase 1+2 block.
  const titleIdx = html.indexOf(TITLE);
  if (titleIdx === -1) fail('Could not find the Phase 1+2 title line ' + JSON.stringify(TITLE));
  // Header rule line immediately before the title.
  const prevLineEnd = html.lastIndexOf('\n', titleIdx - 1);          // end of the rule line
  const ruleStart = html.lastIndexOf('\n', prevLineEnd - 1) + 1;     // start of the rule line
  const ruleLine = html.slice(ruleStart, prevLineEnd).replace(/\r$/, '');
  if (!/^\/\/ ═+$/.test(ruleLine)) fail('Line before the Phase 1+2 title is not a // ═══ rule: ' + JSON.stringify(ruleLine));
  const lastIdx = html.indexOf(LAST, titleIdx);
  if (lastIdx === -1) fail('Could not find "' + LAST + '" after the Phase 1+2 title');
  let lineEnd = html.indexOf('\n', lastIdx);
  if (lineEnd === -1) lineEnd = html.length;
  if (html[lineEnd - 1] === '\r') lineEnd--;
  const region = html.slice(ruleStart, lineEnd);
  for (const need of ['// ─── BEGIN 01-foundation', '// ─── BEGIN 03-models', '// ─── BEGIN 02-plots']) {
    if (region.indexOf(need) === -1) fail('Phase 1+2 region is missing ' + JSON.stringify(need));
  }
  if (region.indexOf('__h2oilMigrated') !== -1) fail('Phase 1+2 region unexpectedly contains the migration shim');
  const out = html.slice(0, ruleStart) + START + eol + body + eol + END + html.slice(lineEnd);
  return { out, mode: 'insert', line: html.slice(0, ruleStart).split('\n').length };
}

function main() {
  const st0 = fs.statSync(HTML);
  const html = fs.readFileSync(HTML, 'utf8');
  const blob = fs.readFileSync(BLOB, 'utf8');
  let res;
  try { res = inject(html, blob); }
  catch (e) { console.error(e.message); process.exit(1); }
  if (res.mode === 'replace') console.log('[replace] Replaced existing Phase 1+2 block (line ' + res.line + ')');
  else console.log('[insert] Converted the Phase 1+2 region to sentinel form (line ' + res.line + ')');
  const st1 = fs.statSync(HTML);
  if (st1.mtimeMs !== st0.mtimeMs || st1.size !== st0.size) {
    console.error('well-testing-app.html changed on disk while injecting — aborting (re-run)');
    process.exit(1);
  }
  fs.writeFileSync(HTML, res.out, 'utf8');
  const before = html.split('\n').length, after = res.out.split('\n').length;
  console.log('[ok] wrote ' + HTML);
  console.log('     before: ' + before + ' lines');
  console.log('     after:  ' + after + ' lines (' + (after - before >= 0 ? '+' : '') + (after - before) + ')');
}

module.exports = { START, END, BLOB, HTML, inject, main };
if (require.main === module) main();
