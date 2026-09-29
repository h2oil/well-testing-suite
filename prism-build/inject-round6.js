#!/usr/bin/env node
// Idempotently injects prism-build/combined-round6.js into
// well-testing-app.html, immediately after the Round-5 END sentinel.
//
// require()-able: module.exports = { START, END, ANCHOR_PATTERN, BLOB, HTML, inject, main }.

const path = require('path');
const { makeRoundInjector } = require('./inject-lib');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'well-testing-app.html');
const BLOB = path.join(__dirname, 'combined-round6.js');

const START = '// ── Round-6 (features) injection START ──';
const END   = '// ── Round-6 (features) injection END ──';
const ANCHOR_PATTERN = '// ── PRiSM Round-5 injection END ──';

const { inject, main } = makeRoundInjector({
  START, END, ANCHOR: ANCHOR_PATTERN, HTML, BLOB, summary: false,
  msg: {
    noEnd: 'Found START but no END — aborting',
    noAnchor: ['Could not find Round-5 END sentinel'],
    replaced: '[replace] Replaced existing Round-6 block',
    inserted: (line) => '[insert] Injected Round-6 block after Round-5 END (line ' + line + ')',
  },
});

module.exports = { START, END, ANCHOR_PATTERN, BLOB, HTML, inject, main };
if (require.main === module) main();
