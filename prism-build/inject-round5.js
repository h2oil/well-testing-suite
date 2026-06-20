#!/usr/bin/env node
// Idempotently injects prism-build/combined-round5.js into
// well-testing-app.html, immediately after the Round-4 END sentinel.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'well-testing-app.html');
const BLOB = path.join(__dirname, 'combined-round5.js');

const START = '// ── PRiSM Round-5 injection START ──';
const END   = '// ── PRiSM Round-5 injection END ──';
const ANCHOR_PATTERN = '// ── PRiSM Round-4 injection END ──';

const html = fs.readFileSync(HTML, 'utf8');
const blob = fs.readFileSync(BLOB, 'utf8');

let out;
const startIdx = html.indexOf(START);
if (startIdx !== -1) {
  const endIdx = html.indexOf(END, startIdx);
  if (endIdx === -1) {
    console.error('Found Round-5 START but no END — aborting');
    process.exit(1);
  }
  const blockEnd = endIdx + END.length;
  out = html.slice(0, startIdx) + START + '\n' + blob + '\n' + END + html.slice(blockEnd);
  console.log('[replace] Replaced existing Round-5 block');
} else {
  const anchorIdx = html.indexOf(ANCHOR_PATTERN);
  if (anchorIdx === -1) {
    console.error('Could not find Round-4 END sentinel — aborting');
    process.exit(1);
  }
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const insertAt = anchorIdx + ANCHOR_PATTERN.length;
  const wrapped = eol + eol + START + eol + blob + eol + END + eol;
  out = html.slice(0, insertAt) + wrapped + html.slice(insertAt);
  console.log('[insert] Injected Round-5 block after Round-4 END (line ' +
              (html.slice(0, insertAt).split('\n').length) + ')');
}

fs.writeFileSync(HTML, out, 'utf8');
const total = out.split('\n').length;
const added = total - html.split('\n').length;
console.log('[ok] wrote ' + HTML);
console.log('     before: ' + html.split('\n').length + ' lines');
console.log('     after:  ' + total + ' lines (+' + added + ')');
