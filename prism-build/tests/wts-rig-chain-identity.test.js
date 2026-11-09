// Well Test Simulator — release 3.4.2 identity matrix of the rig-up chain (INTEGRATION C7; rigup-next "Identity contract" 3 and 4):
//   (1) cfg.rig.routing 'v341' (+ compartments 1, vent 'hp' = v341Opts) on the working engine === the frozen v3.4.1 engine on every
//       snapshot path that existed in v3.4.1: each core item out, V-101 out to 'flare' and 'line', T-202 / DS-101 / CK-102 cases;
//   (2) the chain UNPINNED (pinOpts with lineup and routing false: compartments 1 + vent 'hp' + chain) === v3.4.1 wherever the chain
//       changes nothing: default rig-up, H-101 out, V-101 out to 'flare' / 'line' (FS-401 in), T-201 + T-202 out, P-201 out, the
//       optional items in. Its rig-up notes are left out of (2): the chain words the H-101 note as "H-101 out: … heater bypass …".
//   (3) legacyOpts (all four pins) === the frozen v3.3.1 engine for a few rig-ups (the wts-fu-identity suite covers the rest).
'use strict';

const X = require('./_wts-equip-shapes');
const { legacyOpts, v341Opts, pinOpts } = require('./_wts-lineup-pin.js');

const WP = 'WTSRCI';
const J = (o) => JSON.parse(JSON.stringify(o));
let W0 = null, F0 = null, F1 = null;
const work = () => (W0 = W0 || X.loadEngine('work'));
const v341 = () => (F0 = F0 || X.loadEngine('v341'));
const v331 = () => (F1 = F1 || X.loadEngine('v331'));
function flowOf(S, sim) { const f = J(S.SAMPLE_FLOW); Object.assign(f.sim, sim || {}); return f; }
function pair(Fz, pinFn, c, assert, skipNotes) {
  const a = Fz.create(flowOf(Fz, c.sim), Object.assign({ seed: 21 }, c.opts)), b = work().create(flowOf(work(), c.sim), pinFn(Object.assign({ seed: 21 }, c.opts)));
  if (c.setup) { c.setup(a); c.setup(b); }
  const n = Math.round((c.secs || 3600) / 10);
  for (let i = 1; i <= n; i++) {
    a.advance(10); b.advance(10);
    if (i % 60 === 0 || i === n) {
      const sa = J(a.getState()), sb = J(b.getState());
      if (skipNotes) { sa.rigup.notes = []; sb.rigup.notes = []; }
      const d = X.identityDiff(sa, sb, 6);
      assert.ok(d.length === 0, c.name + ' t ' + i * 10 + ': ' + d.join(' | '));
    }
  }
  const la = J(a.getState()).alarmLog.map((e) => e.msg).join('\n'), lb = J(b.getState()).alarmLog.map((e) => e.msg).join('\n');
  assert.strictEqual(lb, la, c.name + ': alarm log');
}
const CASES_V341 = [
  { name: 'default' }, { name: 'H-101 out', opts: { rigup: { heater: false } } }, { name: 'V-101 out (flare)', opts: { rigup: { separator: false } } },
  { name: 'V-101 out (line)', opts: { rigup: { separator: false } }, sim: { sepByDest: 'line', sepByP_psig: 150 } },
  { name: 'V-101 + FS-401 out (line)', opts: { rigup: { separator: false, flare: false } }, sim: { sepByDest: 'line', sepByP_psig: 150 } },
  { name: 'T-201 out', opts: { rigup: { surge: false } } }, { name: 'T-301 out', opts: { rigup: { gauge: false } } },
  { name: 'P-201 out', opts: { rigup: { pump: false } } }, { name: 'FS-401 out', opts: { rigup: { flare: false } } },
  { name: 'T-202 in, both', opts: { rigup: { surge2: true } }, setup: (s) => s.setSurgeRoute('both') },
  { name: 'DS-101 in', opts: { rigup: { desander: true } } }, { name: 'CK-102 in', opts: { rigup: { heaterChoke: true } } },
  { name: 'V-101 out with destination surge requested (v341: flare)', opts: { rigup: { separator: false } }, sim: { sepByDest: 'surge' } }];
const CASES_UNPINNED = [
  { name: 'default' }, { name: 'H-101 out', opts: { rigup: { heater: false } } }, { name: 'V-101 out (flare)', opts: { rigup: { separator: false } } },
  { name: 'V-101 out (line)', opts: { rigup: { separator: false } }, sim: { sepByDest: 'line', sepByP_psig: 150 } },
  { name: 'T-201 + T-202 out', opts: { rigup: { surge: false } } }, { name: 'P-201 out', opts: { rigup: { pump: false } } },
  { name: 'T-202 in, both', opts: { rigup: { surge2: true } }, setup: (s) => s.setSurgeRoute('both') },
  { name: 'DS-101 in', opts: { rigup: { desander: true } } }, { name: 'CK-102 in', opts: { rigup: { heaterChoke: true } } }];

module.exports = [
  {
    name: 'WTSRCI (1) routing v341 + compartments 1 + vent hp (v341Opts) === frozen v3.4.1: every core item out, V-101 out to flare / line, the optional items',
    wp: WP, opts: false, timeoutMs: 600000,
    run(app, assert) { CASES_V341.forEach((c) => pair(v341(), v341Opts, c, assert, false)); },
  },
  {
    name: 'WTSRCI (2) the chain unpinned (compartments 1 + vent hp + chain) === frozen v3.4.1 where the chain changes nothing (rig-up notes aside)',
    wp: WP, opts: false, timeoutMs: 600000,
    run(app, assert) {
      const pin = (o) => pinOpts(o, { lineup: false, routing: false });
      CASES_UNPINNED.forEach((c) => pair(v341(), pin, c, assert, true));
      // and the chain differs where it should: T-301 out (booster) and FS-401 out (vent accounting)
      const a = work().create(work().SAMPLE_FLOW, pin({ seed: 21, rigup: { gauge: false } })).getState();
      assert.ok(a.rigup.pump === true && a.gauge.pump.mode === 'booster', 'T-301 out: the booster');
    },
  },
  {
    name: 'WTSRCI (3) legacyOpts (lineup + compartments 1 + vent hp + routing v341) === frozen v3.3.1 on the default, T-301 out, FS-401 out and V-101 out',
    wp: WP, opts: false, timeoutMs: 600000,
    run(app, assert) {
      [{ name: 'default' }, { name: 'T-301 out', opts: { rigup: { gauge: false } } }, { name: 'FS-401 out', opts: { rigup: { flare: false } } },
        { name: 'V-101 out', opts: { rigup: { separator: false } } }].forEach((c) => pair(v331(), legacyOpts, c, assert, false));
    },
  },
];
