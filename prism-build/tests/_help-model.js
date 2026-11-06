// prism-build/tests/_help-model.js — Help content model for writers (docs/HELP-GUIDE-PLAN.md §4, WP-H milestone H0).
//
// What is here:
//   ORIFICE      the model guide: every field of the schema (§4.1), filled for the real Orifice Plate Selection
//                page (prism-build/45-calc-orifice.js). tests/help-content.test.js validates it with the same
//                checks as every shipped guide (labels, reverse coverage, verdict cases, worked example, limits).
//                WP-C2 copies it into 48-calc-help-metering.js.
//   TEMPLATE     the blank guide skeleton (plan Appendix A).
//   FILE_TEMPLATE the source of one content file 48-calc-help-<group>.js: one IIFE, a factory, nothing at load.
//   OTHER        the shapes of the non-guide content (start chapters, tasks, course, scenarios, glossary, FAQ).
//
// Writer checklist (help-content.test.js enforces every point):
//   • text is plain text plus the markup subset (§4.3): **bold** (must be visible text on the page: a label,
//     button, card title, option or heading — or a menu path with →, or listed in boldExempt), `code`, [[route]],
//     [[route#section|text]], [[glossary#term|text]], [[task#id|text]], [[fs#FS-1|text]], unit tokens
//     {{value|category[|dp]}} in canonical imperial with a 22-units.js category, ①…⑨ call-outs, ✓ ⚠ ✗,
//     and {{site}} / {{email}} for the only address and e-mail. No HTML: < and > are rejected, and & only as a
//     plain character (never an entity). No URL, domain, e-mail, ™ or ®.
//   • inputs[].label is the page label without its trailing "(…)" group (the unit); inputs[].id must exist
//     on the page; every id'd input / select / textarea / button in #<prefix>_root is in inputs[] or in
//     notDocumented with a reason. inputs[].cat, when given, equals the category the page tags the input with.
//   • verdicts[].match (or, without it, the first four words of text) is a phrase found in the page's
//     ✓ / ⚠ / ✗ line; every distinct verdict line the page shows for the default inputs and for each
//     verdictCases entry must be covered.
//   • example.check reproduces: compute (pure engine) or page (set ids, call window.calc<X>(), read ids or
//     WTS_state) within tol (relative, against max(1, |expected|)); manual only for the simulator, PRiSM fits,
//     Live Data and Overview pages.
//   • reviewedSrc = first 8 hex of sha256 of the page source with LF line endings; print it with
//       node prism-build/tests/help-content.test.js --hash <route>
//     and update reviewed + reviewedSrc whenever you re-check a guide against a changed page.
//   • limits (§4.6): purpose ≤ 160; when 2–5 × ≤ 200; steps 3–12 × ≤ 300; input / output text ≤ 300, label ≤ 60;
//     tips + pitfalls 1–10 × ≤ 300; caption ≤ 160, alt ≤ 200; a guide ≤ 6 kB serialised (parts modules ≤ 14 kB);
//     the file cap of §3.6 binds first. Sentences above 25 words give a warning.
//   • write "select", not "click" or "tap"; UK English; neutral names only.
'use strict';

const ORIFICE = {
  route: 'orifice', reviewed: 'v3.3.2', reviewedSrc: '778aed14', units: 'dual',
  keywords: ['plate', 'bore', 'beta', 'DP cell', 'plate change'],
  notDocumented: [{ id: 'op_calc', why: 'the Select Plate button (step 5)' }],
  purpose: 'Picks the orifice bore that keeps the differential inside your window of the transmitter range at a target gas rate.',
  what: ['The page runs the [[aga3]] calculation backwards. It finds the exact bore for your design differential, then the nearest 0.125" plate that stays inside your low and high limits.'],
  when: ['Before a test: choose the plate for the expected gas rate.', 'During a test: the differential nears the top or bottom of the range.'],
  steps: [
    { t: 'Select **Orifice Plate Selection** in **Metering & Chokes**.', shot: 'view' },
    { t: 'Enter the **Target gas rate** ① and the meter run, line and gas data.' },
    { t: 'Enter the **Transmitter range, 0 to** of your DP cell ②.' },
    { t: 'Set the window: **Low limit**, **High limit** and **Design differential**.' },
    { t: 'Select **Select Plate** ③. The page also updates on every change.' },
    { t: 'Read the verdict ④, then the **Orifice bore** ⑤.', shot: 'res' },
    { t: 'Plan plate changes with the **Plate-Change Points** table ⑥.' },
  ],
  inputs: [
    { label: 'Target gas rate', id: 'op_q', cat: 'gasRateSmall', def: '{{5000|gasRateSmall}}', text: 'Expected rate at the base conditions.' },
    { label: 'Meter run internal diameter', id: 'op_D', cat: 'lengthSmall', def: '{{4.026|lengthSmall}}', text: 'Measured tube bore; at least 2 in.' },
    { label: 'Static (line) pressure', id: 'op_P', cat: 'pressureG', def: '{{500|pressureG}}', text: 'At the upstream tap.' },
    { label: 'Flowing temperature', id: 'op_T', cat: 'temperature', def: '{{80|temperature}}' },
    { label: 'Gas specific gravity', id: 'op_SG', def: '0.65', text: 'Air = 1; 0.5 to 1.8.' },
    { label: 'Gas gravity basis', id: 'op_sgb', def: 'Real', text: 'Ideal only for a gravity from the molecular weight.' },
    { label: 'CO2', id: 'op_CO2', def: '0.5 %' },
    { label: 'N2', id: 'op_N2', def: '1.0 %', text: 'Recorded; not in the Z correction.' },
    { label: 'H2S', id: 'op_H2S', def: '0 %' },
    { label: 'Transmitter range, 0 to', id: 'op_urv', cat: 'pressureSmall60', def: '{{200|pressureSmall60}}', text: 'DP cell upper range value.' },
    { label: 'Low limit', id: 'op_lo', def: '20 %' },
    { label: 'High limit', id: 'op_hi', def: '80 %' },
    { label: 'Design differential', id: 'op_des', def: '50 %', text: 'Where the target rate should sit.' },
    { label: 'Base temperature', id: 'op_Tb', cat: 'temperature', def: '{{60|temperature}}', text: 'Follows the header Std setting until you type a value.' },
    { label: 'Base pressure, absolute', id: 'op_Pb', cat: 'pressureBase', def: '{{14.696|pressureBase}}' },
  ],
  outputs: [
    { label: 'Orifice bore, Beta ratio', text: 'The plate to fit and d/D (AGA-3: 0.10 to 0.75).' },
    { label: 'Rate at low and high % of range', text: 'Plate-change points: change down below the low rate, up above the high rate.' },
    { label: 'Exact Bore and Neighbours', text: 'Exact bore, next plates up and down, Z, Fpv and gravities.' },
  ],
  verdicts: [
    { mark: '✓', match: 'of range at the target rate — inside', text: 'The plate reads inside the window. Fit it; confirm the bore on site.' },
    { mark: '✗', match: 'plate lands inside', text: 'No 0.125" plate fits the window. Widen it or change the range.' },
    { mark: '✗', match: 'keeps the differential below', text: 'Too much gas: use a larger meter run or a higher range.' },
    { mark: '✗', match: 'lifts the differential above', text: 'Too little gas: use a smaller meter run or a lower range.' },
    { mark: '⚠', match: 'at the target rate — above 0.2', text: 'x1 above 0.2: Y1 is outside its validated range.' },
    { mark: '⚠', match: 'x1 exceeds 0.2', text: 'Line pressure is low for this range.' },
    { mark: '⚠', match: 'below the AGA-3 minimum', text: 'Meter run below 2 in: treat the result as an estimate.' },
    { mark: '⚠', match: 'straight lengths', text: 'β above 0.6: check the upstream straight lengths.' },
  ],
  verdictCases: [{ set: { op_q: '50000' } }, { set: { op_lo: '49', op_hi: '51' } }, { set: { op_q: '20' } }, { set: { op_P: '50' } },
    { set: { op_P: '20', op_urv: '400', op_q: '1500' } }, { set: { op_P: '10', op_urv: '400' } }, { set: { op_D: '1.5', op_q: '500' } }],
  example: {
    title: 'The default inputs',
    setup: ['{{5000|gasRateSmall}}, {{4.026|lengthSmall}} run, {{500|pressureG}}, {{80|temperature}}, gravity 0.65, cell 0 to {{200|pressureSmall60}}.'],
    result: ['✓ 1.875" plate, β 0.466, {{97.2|pressureSmall60|1}} = 48.6 % of range.', 'Change down below {{3214|gasRateSmall}}, up above {{6406|gasRateSmall}}.'],
    check: { kind: 'compute', fn: 'WTS_orifice_compute', tol: 0.001,
      input: { q: 5000, D: 4.026, Ps: 500, TfF: 80, SG: 0.65, co2: 0.5, n2: 1, h2s: 0, urv: 200 },
      expect: { inWindow: true, 'chosen.d': 1.875, 'chosen.beta': 0.4657, 'chosen.hw': 97.16, 'chosen.pct': 48.58, 'chosen.qLo': 3213.6, 'chosen.qHi': 6405.7 } },
  },
  tips: ['Keep the next plate up and down at the meter.'],
  pitfalls: ['Enter the measured tube bore (4.026 in), not the nominal size.'],
  refs: [{ std: 'AGA Report No. 3 / API MPMS Ch. 14.3', note: 'orifice equation, β limits' }, { std: 'ISO 5167-1 and -2', note: 'working range of the differential' }],
  related: ['aga3', 'proving', 'sepqc'],
  shots: [
    { id: 'view', view: 'both', alt: 'Orifice Plate Selection with the default inputs', caption: 'The page as it opens',
      callouts: [{ sel: '#op_q', n: 1 }, { sel: '#op_urv', n: 2 }, { sel: '#op_calc', n: 3 }] },
    { id: 'res', view: 'desktop', target: '#op_res', alt: 'Verdict, Selected Plate box and plate-change table', caption: 'Results for the default inputs',
      callouts: [{ sel: '#op_res > div:nth-child(1)', n: 4 }, { sel: '#op_res .rbox:nth-child(2) .rrow:nth-child(2)', n: 5 }, { sel: '#op_res table.dtable', n: 6 }] },
  ],
};

const TEMPLATE = {
  route: '', reviewed: 'v3.3.2', reviewedSrc: '', units: 'dual', keywords: [], notDocumented: [],
  purpose: '',
  what: [''],
  when: ['', ''],
  steps: [{ t: 'Select **<page title>** in **<sidebar group>** ①', shot: 'view' }, { t: '' }, { t: '' }],
  inputs: [{ label: '', id: '', cat: '', def: '', text: '' }],
  outputs: [{ label: '', text: '' }],
  verdicts: [{ mark: '✓', match: '', text: '' }],
  verdictCases: [],
  example: { title: '', setup: [''], result: [''], check: { kind: 'compute', fn: '', input: {}, expect: {}, tol: 0.01 } },
  tips: [''], pitfalls: [''],
  refs: [{ std: '', note: '' }],
  related: [''],
  shots: [{ id: 'view', view: 'both', alt: '', caption: '' }],
};

// One content file. Replace <group> (start, overview, metering, welltest, simcourse, production, livedata,
// safety, process, flare, utilities) and list every route the factory builds in `routes`.
const FILE_TEMPLATE = [
  '// prism-build/48-calc-help-<group>.js — Help content: <sidebar group> (docs/HELP-GUIDE-PLAN.md §4).',
  '// Data only (no WTS_calcRegistry page). The factory runs on the first Help open (WTS_help.load()); nothing runs at load.',
  '(function () {',
  "    'use strict';",
  "    var G = (typeof window !== 'undefined') ? window : globalThis;",
  '    G.WTS_helpContent = G.WTS_helpContent || { guides: {}, factories: [] };',
  '    G.WTS_helpContent.factories = G.WTS_helpContent.factories || [];',
  "    G.WTS_helpContent.factories.push({ group: '<group>', routes: [/* every route below */], build: function () {",
  '        return { guides: { /* route: { …schema… } */ } };',
  '    } });',
  '})();',
  '',
  '// === SELF-TEST ===',
  '(function () { /* content is checked by tests/help-content.test.js */ })();',
  '',
].join('\n');

// Shapes of the other content (any field may be omitted when empty). Blocks are: a string (paragraph),
// { h: 'sub-heading' }, { list: [...], ordered: true|false }, { table: { head: [...], rows: [[...]] } },
// { details: { summary: '...', body: [blocks] } } or { shot: '<shot id>' }.
const OTHER = {
  start: [{ id: 'screen', title: 'The screen', body: ['…', { list: ['…'] }], shots: [] }],
  tasks: [{ id: 'spread', title: 'Design a well test spread', purpose: '…', steps: [{ route: 'wts', t: '…', carry: '…' }] }],
  course: [{ id: 'ex1', title: '…', keywords: [], goal: '…', setup: ['…'], steps: ['…'], observe: ['…'], questions: ['…'], answers: ['…'],
    trainer: { duration: '…', fault: '…', good: '…', mistakes: ['…'], debrief: ['…', '…', '…'] }, blocks: [], shots: [] }],
  scenarios: [{ id: 'FS-1', title: '…', keywords: [], intro: ['…'], blocks: [], today: ['…'], afterSim: ['…'], feature: 'bypassDest', shots: [] }],
  glossary: { bean: { term: 'bean', def: '…', variants: ['beans'] } },
  faq: [{ id: 'reset', q: '…', a: ['…'] }],
};

module.exports = { ORIFICE, TEMPLATE, FILE_TEMPLATE, OTHER };
