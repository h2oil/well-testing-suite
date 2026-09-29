#!/usr/bin/env node
// Idempotently injects prism-build/combined-round7.js (31-wts-sim, 32-wts-3d,
// 38-wts-live — the Live 3D Well Test Simulator) into well-testing-app.html,
// immediately after the Round-6 END sentinel, i.e. BEFORE the host's
// "── Well Test Simulator ──" section (so wtsDrawDiag/renderWTS are hoisted,
// but WTS_PIPES and window.calcWTS do not exist yet when Round-7 code loads).
//
// Line endings: the blob is converted to the host's EOL (CRLF) in BOTH the
// insert branch and the replace branch, and the sentinels are joined with the
// same EOL, so re-running never produces mixed endings.
//
// require()-able: module.exports = { START, END, ANCHOR_PATTERN, BLOB, HTML, inject, main }.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'well-testing-app.html');
const BLOB = path.join(__dirname, 'combined-round7.js');

const START = '// ── Round-7 (3D WTS) injection START ──';
const END   = '// ── Round-7 (3D WTS) injection END ──';
const ANCHOR_PATTERN = '// ── Round-6 (features) injection END ──';

const MSG = {
  noEnd: 'Found START but no END — aborting',
  noAnchor: ['Could not find Round-6 END sentinel'],
  replaced: '[replace] Replaced existing Round-7 block',
  inserted: (line) => '[insert] Injected Round-7 block after Round-6 END (line ' + line + ')',
};

// Shared splice logic when available (prism-build/inject-lib.js); a local
// equivalent otherwise, so this script never depends on the shared helper.
function localInjector() {
  function fail(lines) { const e = new Error(lines[0]); e.lines = lines; throw e; }
  function inject(html, blob) {
    const eol = html.includes('\r\n') ? '\r\n' : '\n';
    blob = blob.replace(/\r?\n/g, eol);
    const startIdx = html.indexOf(START);
    if (startIdx !== -1) {
      const endIdx = html.indexOf(END, startIdx);
      if (endIdx === -1) fail([MSG.noEnd]);
      const out = html.slice(0, startIdx) + START + eol + blob + eol + END + html.slice(endIdx + END.length);
      return { out, mode: 'replace', messages: [MSG.replaced] };
    }
    const anchorIdx = html.indexOf(ANCHOR_PATTERN);
    if (anchorIdx === -1) fail(MSG.noAnchor);
    const insertAt = anchorIdx + ANCHOR_PATTERN.length;
    const out = html.slice(0, insertAt) + eol + eol + START + eol + blob + eol + END + eol + html.slice(insertAt);
    return { out, mode: 'insert', anchor: ANCHOR_PATTERN, messages: [MSG.inserted(html.slice(0, insertAt).split('\n').length)] };
  }
  function main() {
    const st0 = fs.statSync(HTML);
    const html = fs.readFileSync(HTML, 'utf8');
    const blob = fs.readFileSync(BLOB, 'utf8');
    let res;
    try { res = inject(html, blob); }
    catch (e) { (e.lines || [e.message]).forEach((l) => console.error(l)); process.exit(1); }
    res.messages.forEach((m) => console.log(m));
    const st1 = fs.statSync(HTML);
    if (st1.mtimeMs !== st0.mtimeMs || st1.size !== st0.size) {
      console.error('well-testing-app.html changed on disk while injecting — aborting (re-run)');
      process.exit(1);
    }
    fs.writeFileSync(HTML, res.out, 'utf8');
    console.log('[ok] wrote ' + HTML);
  }
  return { inject, main };
}

let injector;
try {
  const { makeRoundInjector } = require('./inject-lib');
  injector = makeRoundInjector({
    START, END, ANCHOR: ANCHOR_PATTERN, HTML, BLOB, summary: false,
    eolAware: true, guardMtime: true, msg: MSG,
  });
} catch (e) {
  injector = localInjector();
}

const { inject, main } = injector;
module.exports = { START, END, ANCHOR_PATTERN, BLOB, HTML, inject, main };
if (require.main === module) main();
