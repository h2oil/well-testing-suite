#!/usr/bin/env node
'use strict';
// prism-build/acct-hash.js — SHA-384 of the ACCOUNT BLOCK of the built web page (docs/ACCOUNTS-PLAN.md D19, T11, §13.8;
// WP-OPS). The account block is every web-only region between ACCT markers — the JS blocks
// `// ── ACCT:START … // ── ACCT:END ──` of 66–68 (and any host edit wrapped the same way) and the HTML blocks
// `<!-- ACCT:START … ACCT:END -->` — in document order. The release notes and the owner's server release checklist carry
// this value, so anyone can check that the account code served at welltest.h2oil.co.uk is the reviewed one.
//
//   node prism-build/acct-hash.js [file]        default well-testing-app.html; prints the digest and the block count
//        --json      one JSON line {file, blocks, bytes, sha384, perBlock:[…]}
//        --release   one line for the release notes: "Account code SHA-384 (N blocks): sha384-…"
//        --require   exit 1 when the file has no account block (use on a release build)
//   Exit 1 also when the START / END marker counts differ or a block is not closed.
//
//   require('./acct-hash') → { extractBlocks(text) → {blocks:[{kind, start, text}], errors:[…]}, digest(text) → {…} }
//
// Hash input: the blocks' text exactly as between and including their markers, line endings normalised to LF (the Windows
// working copy is CRLF, git stores LF), joined with one LF. The digest is the Subresource-Integrity form `sha384-<base64>`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const JS_START = '// ── ACCT:START';
const JS_END = '// ── ACCT:END ──';
const HTML_START = /<!--\s*ACCT:START/g;
const HTML_END_RE = /ACCT:END\s*-->/g;

function extractBlocks(raw) {
  const text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n');
  const blocks = []; const errors = [];
  // JS blocks
  let i = 0;
  for (;;) {
    const s = text.indexOf(JS_START, i);
    if (s === -1) break;
    const e = text.indexOf(JS_END, s + JS_START.length);
    const nextStart = text.indexOf(JS_START, s + JS_START.length);
    if (e === -1 || (nextStart !== -1 && nextStart < e)) { errors.push('JS block at offset ' + s + ' is not closed before the next start'); i = s + JS_START.length; continue; }
    blocks.push({ kind: 'js', start: s, text: text.slice(s, e + JS_END.length) });
    i = e + JS_END.length;
  }
  const jsStarts = text.split(JS_START).length - 1; const jsEnds = text.split(JS_END).length - 1;
  if (jsStarts !== jsEnds) errors.push('JS markers: ' + jsStarts + ' start / ' + jsEnds + ' end');
  // HTML blocks
  const hs = []; let m;
  HTML_START.lastIndex = 0; while ((m = HTML_START.exec(text))) hs.push(m.index);
  const he = []; HTML_END_RE.lastIndex = 0; while ((m = HTML_END_RE.exec(text))) he.push({ at: m.index, end: m.index + m[0].length });
  if (hs.length !== he.length) errors.push('HTML markers: ' + hs.length + ' start / ' + he.length + ' end');
  hs.forEach((s, k) => {
    const e = he.find((x) => x.at > s);
    if (!e || (hs[k + 1] !== undefined && hs[k + 1] < e.at)) { errors.push('HTML block at offset ' + s + ' is not closed before the next start'); return; }
    blocks.push({ kind: 'html', start: s, text: text.slice(s, e.end) });
  });
  blocks.sort((a, b) => a.start - b.start);
  return { blocks, errors };
}

function sri(buf) { return 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64'); }
function digest(raw) {
  const r = extractBlocks(raw);
  const joined = Buffer.from(r.blocks.map((b) => b.text).join('\n'), 'utf8');
  return {
    blocks: r.blocks.length, bytes: joined.length, errors: r.errors,
    sha384: r.blocks.length ? sri(joined) : null,
    perBlock: r.blocks.map((b) => ({ kind: b.kind, bytes: Buffer.byteLength(b.text), sha384: sri(Buffer.from(b.text, 'utf8')), head: b.text.split('\n')[0].slice(0, 80) })),
  };
}

module.exports = { extractBlocks, digest, sri };

if (require.main === module) {
  const a = process.argv.slice(2);
  const file = a.find((x) => !x.startsWith('--')) || path.join(__dirname, '..', 'well-testing-app.html');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { console.error('[acct-hash] cannot read ' + file); process.exit(2); }
  const d = digest(text);
  if (d.errors.length) { d.errors.forEach((e) => console.error('[acct-hash] ' + e)); process.exit(1); }
  if (!d.blocks) {
    if (a.includes('--json')) console.log(JSON.stringify({ file: path.basename(file), blocks: 0, sha384: null }));
    else console.log('[acct-hash] ' + path.basename(file) + ': no account block');
    process.exit(a.includes('--require') ? 1 : 0);
  }
  if (a.includes('--json')) console.log(JSON.stringify(Object.assign({ file: path.basename(file) }, d)));
  else if (a.includes('--release')) console.log('Account code SHA-384 (' + d.blocks + ' blocks): ' + d.sha384);
  else {
    console.log('[acct-hash] ' + path.basename(file) + ': ' + d.blocks + ' account blocks, ' + d.bytes + ' bytes');
    d.perBlock.forEach((b) => console.log('  ' + b.kind + ' ' + b.bytes + ' B ' + b.sha384 + '  ' + b.head));
    console.log(d.sha384);
  }
}
