#!/usr/bin/env node
// Idempotently injects prism-build/combined-round5.js into
// well-testing-app.html, immediately after the Round-4 END sentinel.
//
// require()-able: module.exports = { START, END, ANCHOR_PATTERN, BLOB, HTML, inject, main }.

const path = require('path');
const { makeRoundInjector } = require('./inject-lib');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'well-testing-app.html');
const BLOB = path.join(__dirname, 'combined-round5.js');

const START = '// ── PRiSM Round-5 injection START ──';
const END   = '// ── PRiSM Round-5 injection END ──';
const ANCHOR_PATTERN = '// ── PRiSM Round-4 injection END ──';

const { inject, main } = makeRoundInjector({
  START, END, ANCHOR: ANCHOR_PATTERN, HTML, BLOB, summary: true,
  msg: {
    noEnd: 'Found Round-5 START but no END — aborting',
    noAnchor: ['Could not find Round-4 END sentinel — aborting'],
    replaced: '[replace] Replaced existing Round-5 block',
    inserted: (line) => '[insert] Injected Round-5 block after Round-4 END (line ' + line + ')',
  },
});

module.exports = { START, END, ANCHOR_PATTERN, BLOB, HTML, inject, main };
if (require.main === module) main();
