#!/usr/bin/env node
// Idempotently injects prism-build/combined-round8.js into
// well-testing-app.html.
//
// First run: inserted right after the Round-7 END sentinel if that block is
// present, otherwise right after the Round-6 END sentinel. Later runs replace
// everything between the Round-8 START/END sentinels (wherever they are).
// CRLF-aware (the blob takes the host's line ending). Refuses to write if the
// HTML changed on disk while this script ran.
//
// This script never touches the Round-7 block.
//
// require()-able: module.exports = { START, END, ANCHORS, BLOB, HTML, inject, main }.

const path = require('path');
const { makeRoundInjector } = require('./inject-lib');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'well-testing-app.html');
const BLOB = path.join(__dirname, 'combined-round8.js');

const START = '// ── PRiSM Round-8 injection START ──';
const END   = '// ── PRiSM Round-8 injection END ──';
const ANCHORS = [
  '// ── Round-7 (3D WTS) injection END ──',
  '// ── Round-6 (features) injection END ──',
];

const { inject, main } = makeRoundInjector({
  START, END, ANCHOR: ANCHORS, HTML, BLOB, summary: true, eolAware: true, guardMtime: true,
  msg: {
    noEnd: 'Found Round-8 START but no END — aborting',
    noAnchor: (a) => ['Could not find a Round-7 or Round-6 END sentinel — aborting',
                      '(searched for: ' + a.map((s) => JSON.stringify(s)).join(', ') + ')'],
    replaced: '[replace] Replaced existing Round-8 block',
    inserted: (line, anchor) => '[insert] Injected Round-8 block after ' +
      (anchor === ANCHORS[0] ? 'Round-7' : 'Round-6') + ' END (line ' + line + ')',
  },
});

module.exports = { START, END, ANCHORS, BLOB, HTML, inject, main };
if (require.main === module) main();
