#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'well-testing-app.html');
const BLOB = path.join(__dirname, 'combined-round6.js');

const START = '// ── Round-6 (features) injection START ──';
const END   = '// ── Round-6 (features) injection END ──';
const ANCHOR_PATTERN = '// ── PRiSM Round-5 injection END ──';

const html = fs.readFileSync(HTML, 'utf8');
const blob = fs.readFileSync(BLOB, 'utf8');

let out;
const startIdx = html.indexOf(START);
if (startIdx !== -1) {
  const endIdx = html.indexOf(END, startIdx);
  if (endIdx === -1) { console.error('Found START but no END — aborting'); process.exit(1); }
  out = html.slice(0, startIdx) + START + '\n' + blob + '\n' + END + html.slice(endIdx + END.length);
  console.log('[replace] Replaced existing Round-6 block');
} else {
  const anchorIdx = html.indexOf(ANCHOR_PATTERN);
  if (anchorIdx === -1) { console.error('Could not find Round-5 END sentinel'); process.exit(1); }
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const insertAt = anchorIdx + ANCHOR_PATTERN.length;
  out = html.slice(0, insertAt) + eol + eol + START + eol + blob + eol + END + eol + html.slice(insertAt);
  console.log('[insert] Injected Round-6 block after Round-5 END (line ' +
              (html.slice(0, insertAt).split('\n').length) + ')');
}

fs.writeFileSync(HTML, out, 'utf8');
console.log('[ok] wrote ' + HTML);
