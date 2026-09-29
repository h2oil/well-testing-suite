#!/usr/bin/env node
// Idempotently injects prism-build/combined-round2.js into
// well-testing-app.html, immediately after the existing PRiSM Phase 3+4
// injection block (which ends with the END sentinel) and before the WTS
// section. Uses sentinel comments so re-runs cleanly replace the block.
//
// require()-able: module.exports = { START, END, ANCHOR_PATTERN, BLOB, HTML, inject, main }.

const path = require('path');
const { makeRoundInjector } = require('./inject-lib');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'well-testing-app.html');
const BLOB = path.join(__dirname, 'combined-round2.js');

const START = '// ── PRiSM Round-2 injection START ──';
const END   = '// ── PRiSM Round-2 injection END ──';

// Anchor: end of Phase 3+4 block.
const ANCHOR_PATTERN = '// ── PRiSM Phase 3+4 injection END ──';

const { inject, main } = makeRoundInjector({
  START, END, ANCHOR: ANCHOR_PATTERN, HTML, BLOB, summary: true,
  msg: {
    noEnd: 'Found Round-2 START sentinel but no END sentinel — aborting',
    noAnchor: ['Could not find Phase 3+4 END sentinel — aborting',
               '(searched for: ' + JSON.stringify(ANCHOR_PATTERN) + ')'],
    replaced: '[replace] Replaced existing Round-2 block',
    inserted: (line) => '[insert] Injected Round-2 block after Phase 3+4 END sentinel ' +
                        '(line ' + line + ')',
  },
});

module.exports = { START, END, ANCHOR_PATTERN, BLOB, HTML, inject, main };
if (require.main === module) main();
