#!/usr/bin/env node
// Idempotently injects prism-build/combined-round9.js (plug-in calculators,
// prism-build/4N-calc-*.js) into well-testing-app.html.
//
// First run: inserted right after the PRiSM Round-8 END sentinel (inside the
// host IIFE, before the Well Test Simulator code and the initial render()).
// Later runs replace everything between the Round-9 START/END sentinels
// (wherever they are). CRLF-aware (the blob takes the host's line ending).
// Refuses to write if the HTML changed on disk while this script ran.
//
// require()-able: module.exports = { START, END, ANCHORS, BLOB, HTML, inject, main }.

const path = require('path');
const { makeRoundInjector } = require('./inject-lib');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'well-testing-app.html');
const BLOB = path.join(__dirname, 'combined-round9.js');

const START = '// ── Round-9 (calculators) injection START ──';
const END   = '// ── Round-9 (calculators) injection END ──';
const ANCHORS = [
  '// ── PRiSM Round-8 injection END ──',
];

const { inject, main } = makeRoundInjector({
  START, END, ANCHOR: ANCHORS, HTML, BLOB, summary: true, eolAware: true, guardMtime: true,
  msg: {
    noEnd: 'Found Round-9 START but no END — aborting',
    noAnchor: (a) => ['Could not find the Round-8 END sentinel — aborting',
                      '(searched for: ' + a.map((s) => JSON.stringify(s)).join(', ') + ')'],
    replaced: '[replace] Replaced existing Round-9 block',
    inserted: (line) => '[insert] Injected Round-9 block after Round-8 END (line ' + line + ')',
  },
});

module.exports = { START, END, ANCHORS, BLOB, HTML, inject, main };
if (require.main === module) main();
