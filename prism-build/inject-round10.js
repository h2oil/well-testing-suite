#!/usr/bin/env node
// Idempotently injects prism-build/combined-round10.js (live data: Modbus +
// Mini WellOS, prism-build/5N-*.js) into well-testing-app.html.
//
// First run: inserted right after the Round-9 (calculators) END sentinel (inside
// the host IIFE, before the Well Test Simulator code and the initial render()),
// so the registry pages exist before the first render. Later runs replace
// everything between the Round-10 START/END sentinels. EOL-aware.
//
// require()-able: module.exports = { START, END, ANCHORS, BLOB, HTML, inject, main }.

const path = require('path');
const { makeRoundInjector } = require('./inject-lib');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'well-testing-app.html');
const BLOB = path.join(__dirname, 'combined-round10.js');

const START = '// ── Round-10 (live data) injection START ──';
const END   = '// ── Round-10 (live data) injection END ──';
const ANCHORS = [
  '// ── Round-9 (calculators) injection END ──',
];

const { inject, main } = makeRoundInjector({
  START, END, ANCHOR: ANCHORS, HTML, BLOB, summary: true, eolAware: true, guardMtime: true,
  msg: {
    noEnd: 'Found Round-10 START but no END — aborting',
    noAnchor: (a) => ['Could not find the Round-9 END sentinel — aborting',
                      '(searched for: ' + a.map((s) => JSON.stringify(s)).join(', ') + ')'],
    replaced: '[replace] Replaced existing Round-10 block',
    inserted: (line) => '[insert] Injected Round-10 block after Round-9 END (line ' + line + ')',
  },
});

module.exports = { START, END, ANCHORS, BLOB, HTML, inject, main };
if (require.main === module) main();
