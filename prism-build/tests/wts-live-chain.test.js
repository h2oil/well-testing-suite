// Well Test Simulator live HMI (38-wts-live.js) — release 3.4.2, rig-up "next item downstream" chain (designs rigup-next.md §G,
// INTEGRATION.md C2 / C3 / §2.7): an item taken out sends its flow to the next item in the rig-up.
//   • pure: destTxt / bypSurge for the new V-101-out destination 'surge', ventOn under the chain rules, the three-valued
//     destination text of inputsDiff, rigRoute (rigup.routes);
//   • Rig-up card (recording stub with the contract snapshot keys built here): row texts from rigup.routes, the FS-401 switch held
//     in only while the stream goes to the burner / flare line, T-202 allowed without T-201 under the chain (legacy: disabled);
//   • live 2D overlay: H-101 "BYPASSED → V-101", the V-101 bypass to T-201 "(WHOLE STREAM) · PSHH-104" with the dump pipe in use,
//     "DUMPS → T-202", "T-201 → P-201 → EXPORT" (booster), "HP GAS → EXPORT LINE · LP / RELIEF → VENT".
'use strict';

const WP = 'WTSLCH';
const J = (o) => JSON.parse(JSON.stringify(o));
const text = (el) => String(el ? el.textContent : '').trim();

function openWts(app) {
  const b = app.find('.nav-btn[data-p="wts"]');
  if (!b) throw new Error('no Well Test Simulator sidebar button');
  app.click(b); app.flush(500);
  const s = app.win.WTS_live && app.win.WTS_live.getSim && app.win.WTS_live.getSim();
  if (!s) throw new Error('live simulator did not start');
  return s;
}
const I = (app) => app.win.WTS_live._internals;
// o: {rig: {key: bool}, routing, dest, recv, routes, booster}
function chainPatch(st, o) {
  const ru = st.rigup;
  Object.assign(ru, o.rig || {});
  ru.routing = o.routing || 'chain';
  if (o.dest) ru.dest = o.dest;
  ru.routes = Object.assign({}, o.routes || {});
  if (o.dest) st.sepBy = Object.assign({}, st.sepBy || {}, { dest: o.dest, recv: o.recv || (o.dest === 'surge' ? 'T-201' : ''), P_psig: 150, vent: !!o.vent });
  if (o.booster) st.gauge.pump = Object.assign({}, st.gauge.pump || {}, { mode: 'booster', suction: 'transfer', on: true });
  return st;
}
function installStub(app, o) {
  const L = I(app), real = L.sim(), opts = Object.assign({}, o || {});
  let key = null, cache = null;
  const stub = Object.create(real);
  stub.__v = 0;
  stub.getState = function () {
    const st = real.getState(), k = st.t + '|' + st.alarmVersion + '|' + stub.__v;
    if (k !== key) { key = k; cache = app.toWin(chainPatch(J(st), opts)); }
    return cache;
  };
  stub.getRigup = function () { const r = Object.assign(J(real.getRigup()), opts.rig || {}); return app.toWin(r); };
  L.useSim(stub);
  return { stub, opts, set: (p) => { Object.keys(opts).forEach((k) => delete opts[k]); Object.assign(opts, p); stub.__v++; app.win.WTS_live._internals.ctl()._debug.draw2d(); }, restore: () => L.useSim(real) };
}
const rigRow = (app, k) => app.el('wtsl_rigup').querySelector('[data-k="' + k + '"]');
const rigTxt = (app, k) => text(rigRow(app, k) && rigRow(app, k).querySelector('.rv'));
const rigSw = (app, k) => app.el('wtsl_rigup').querySelector('[data-rig="' + k + '"]');
function rerender(app) { app.win.WTS_live._internals.ctl()._debug.closeCard(); app.flush(1500); }
function lastOps(app, cv) {
  const log = app.canvasLog(cv);
  let i = log.length - 1;
  while (i >= 0 && !(log[i].op === 'clearRect' && log[i].args[0] === 0 && log[i].args[1] === 0)) i--;
  return log.slice(Math.max(0, i));
}
const textAt = (fr, s) => fr.filter((e) => e.op === 'fillText' && String(e.args[0]) === s).map((e) => [e.args[1], e.args[2]]);
function frameTexts(app, cv) {
  const log = app.canvasLog(cv);
  let i = log.length - 1;
  while (i >= 0 && !(log[i].op === 'clearRect' && log[i].args[0] === 0 && log[i].args[1] === 0)) i--;
  return log.slice(Math.max(0, i)).filter((e) => e.op === 'fillText').map((e) => String(e.args[0]));
}
const noErr = (app, assert) => assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().map((l) => l.text || l).join(' | '));

module.exports = [
  {
    name: 'WTSLCH pure: destination \'surge\' (destTxt, bypSurge, receiver), ventOn under the chain, inputsDiff destination text, rigRoute',
    wp: WP,
    run(app, assert) {
      const L = I(app), W = (o) => app.toWin(o);
      const out = { separator: false };
      assert.strictEqual(L.destTxt(W({ rigup: out, sepBy: { dest: 'surge', recv: 'T-201' } })), 'surge tank T-201');
      assert.strictEqual(L.destTxt(W({ rigup: out, sepBy: { dest: 'surge', recv: 'T-202' } })), 'surge tank T-202');
      assert.strictEqual(L.destTxt(W({ rigup: out, sepBy: { dest: 'surge', recv: 'both' } })), 'surge tank T-201 + T-202');
      assert.strictEqual(L.destTxt(W({ rigup: out, sepBy: { dest: 'flare' } })), 'burner / flare line');
      assert.ok(/^production line \(/.test(L.destTxt(W({ rigup: out, sepBy: { dest: 'line', P_psig: 150 } }))));
      assert.strictEqual(L.bypSurge(W({ rigup: out, sepBy: { dest: 'surge' } })), true);
      assert.strictEqual(L.bypSurge(W({ rigup: {}, sepBy: { dest: 'surge' } })), false, 'V-101 in: no bypass');
      assert.strictEqual(L.ventOn(W({ rigup: { flare: false, routing: 'chain' } })), true, 'chain: FS-401 out → vent');
      assert.strictEqual(L.ventOn(W({ rigup: { flare: false, routing: 'v341' } })), false, 'v3.4.1 rules: V-101 in, FS-401 out → no vent');
      assert.strictEqual(L.ventOn(W({ rigup: { flare: false, separator: false }, sepBy: { dest: 'surge' } })), true, 'surge + FS-401 out → cold vent');
      assert.strictEqual(L.ventOn(W({ rigup: {} })), false);
      const f = (d) => ({ inputs: { bean: 32, Psep: 150, Qg: 10, Qo: 1000, Qw: 200 }, sim: { sepByDest: d } });
      const d1 = J(L.inputsDiff(W(f('flare')), W(f('surge'))));
      assert.deepStrictEqual(d1, [['With V-101 out, well stream to the surge tank T-201', 'V-101']]);
      assert.deepStrictEqual(J(L.inputsDiff(W(f('surge')), W(f('line')))), [['With V-101 out, well stream to the production line', 'V-101']]);
      assert.deepStrictEqual(J(L.inputsDiff(W(f('surge')), W(f('flare')))), [['With V-101 out, well stream to the burner / flare line', 'V-101']]);
      assert.strictEqual(L.rigRoute(W({ rigup: { routes: { heater: 'V-101' } } }), 'heater'), 'V-101');
      assert.strictEqual(L.rigRoute(W({ rigup: {} }), 'heater'), '');
      assert.strictEqual(L.rigChain(W({ rigup: { routing: 'chain' } })), true); assert.strictEqual(L.rigChain(W({ rigup: {} })), false);
    }
  },
  {
    name: 'WTSLCH Rig-up card under the chain: row texts from rigup.routes, V-101 bypassed to the surge tank, FS-401 switch free with \'surge\' / held with \'flare\', T-202 without T-201',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app, { rig: { heater: false, separator: false, gauge: false }, dest: 'surge',
        routes: { heater: 'V-101', separator: 'T-201', surge: '', gauge: 'P-201 → export', pump: '', flare: '' } });
      try {
        rerender(app);
        assert.strictEqual(rigTxt(app, 'heater'), 'Bypassed → V-101');
        assert.strictEqual(rigTxt(app, 'separator'), 'Bypassed → surge tank T-201');
        assert.strictEqual(rigTxt(app, 'gauge'), 'Out of rig-up → P-201 → export');
        assert.ok(!rigSw(app, 'flare').disabled, 'FS-401 switch free with the stream to the surge tank');
        assert.ok(/atmospheric vent \(cold vent\)/.test(rigSw(app, 'flare').getAttribute('title')), 'FS-401 tip: ' + rigSw(app, 'flare').getAttribute('title'));
        t.set({ rig: { separator: false }, dest: 'flare', routes: { separator: 'burner / flare line' } }); rerender(app);
        assert.ok(rigSw(app, 'flare').disabled, 'FS-401 held in with the burner / flare line: ' + rigTxt(app, 'separator') + ' | ' + rigSw(app, 'flare').getAttribute('title') + ' | ' + JSON.stringify(app.win.WTS_live.getSim().getState().rigup));
        assert.strictEqual(rigTxt(app, 'separator'), 'Bypassed → burner / flare line');
        // T-201 out, T-202 in: allowed under the chain (the T-202 switch can be used), refused under the v3.4.1 rules
        const it2 = (app.win.WTS_live._internals.rigItems() || []).find((x) => x.key === 'surge2');
        t.set({ rig: { surge: false, surge2: true }, routes: { surge: 'T-202' } }); rerender(app);
        assert.ok(!rigSw(app, 'surge2').disabled, 'chain: T-202 switch enabled without T-201');
        assert.strictEqual(rigTxt(app, 'surge'), 'Out of rig-up → T-202');
        if (it2 && it2.needs) {
          t.set({ rig: { surge: false, surge2: true }, routing: 'v341' }); rerender(app);
          assert.ok(rigSw(app, 'surge2').disabled, 'v3.4.1 rules: T-202 needs T-201');
        }
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSLCH 2D overlay under the chain: BYPASSED → V-101, whole stream to T-201 with PSHH-104, DUMPS → T-202, T-201 → P-201 → EXPORT, HP GAS / LP RELIEF',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const cv = app.el('wts_cv');
      assert.ok(cv, '2D canvas');
      const t = installStub(app, { rig: { heater: false, separator: false }, dest: 'surge', routes: { heater: 'V-101', separator: 'T-201' } });
      try {
        app.flush(600);
        let tx = frameTexts(app, cv);
        assert.ok(tx.indexOf('BYPASSED → V-101') >= 0, 'heater: ' + tx.filter((x) => /BYPASS|RIG-UP/.test(x)).join('|'));
        // review 3.4.2: two rows right of the dump pipe, inside the cleared P / T block (no stale separator values under it)
        assert.ok(tx.indexOf('BYPASSED → T-201') >= 0 && tx.indexOf('WHOLE STREAM · PSHH-104') >= 0, 'V-101 → T-201: ' + tx.filter((x) => /BYPASS|WHOLE/.test(x)).join('|'));
        const L0 = app.win.WTS_DIAG_LAYOUT, fr0 = lastOps(app, cv);
        assert.deepStrictEqual(textAt(fr0, 'BYPASSED → T-201'), [[L0.tx[4] + 7, L0.cy + 46]], 'row 1 position');
        assert.deepStrictEqual(textAt(fr0, 'WHOLE STREAM · PSHH-104'), [[L0.tx[4] + 7, L0.cy + 57]], 'row 2 position');
        assert.ok(fr0.some((e) => e.op === 'clearRect' && e.args[0] === L0.tx[4] - 62 && e.args[1] === L0.cy + 33 && e.args[3] === 33), 'the stale P / T block is cleared');
        assert.ok(tx.indexOf('BYPASSED → BURNER LINE') < 0 && tx.indexOf('PSHH-104') < 0, 'no burner label / separate PSHH-104 tag');
        t.set({ rig: { surge: false, surge2: true }, routes: { surge: 'T-202' } }); app.flush(600);
        tx = frameTexts(app, cv);
        assert.ok(tx.indexOf('DUMPS → T-202') >= 0 && tx.indexOf('DUMPS → T-301 (no surge tank)') < 0, 'T-201 out: ' + tx.filter((x) => /DUMPS/.test(x)).join('|'));
        // review 3.4.2: T-202 is drawn at its slot (the host draws the base row in this rig-up) with LCV-202 on the T-301 line
        const L1 = app.win.WTS_DIAG_LAYOUT, fr1 = lastOps(app, cv);
        assert.ok(textAt(fr1, 'T-202').some((p) => p[0] === L1.t202.x && p[1] === L1.by + 38), 'T-202 drawn at its slot: ' + JSON.stringify(textAt(fr1, 'T-202')));
        assert.ok(textAt(fr1, 'T-202').some((p) => p[1] > L1.strip.y), 'T-202 strip bar shown while it stands in for T-201');
        assert.ok(tx.indexOf('LCV-202') >= 0 && tx.indexOf('T-201') >= 0, 'LCV-202 and the T-201 name under its mask');
        assert.ok(app.win.WTS_live._internals.t2Alone(app.win.WTS_live.getSim().getState()), 't2Alone');
        t.set({ rig: { gauge: false }, booster: true, routes: { gauge: 'P-201 → export' } }); app.flush(600);
        tx = frameTexts(app, cv);
        assert.ok(tx.indexOf('T-201 → P-201 → EXPORT') >= 0 && tx.indexOf('P-201') >= 0, 'booster: ' + tx.filter((x) => /P-201|EXPORT/.test(x)).join('|'));
        const L2 = app.win.WTS_DIAG_LAYOUT, bl = textAt(lastOps(app, cv), 'T-201 → P-201 → EXPORT')[0];
        assert.ok(bl && bl[1] <= L2.by - 13, 'booster label clear above the P-201 circle (top at by − 9.5): ' + JSON.stringify(bl));
        t.set({ rig: { flare: false }, routes: { flare: 'export + vent' } }); app.flush(600);
        tx = frameTexts(app, cv);
        assert.ok(tx.indexOf('HP GAS → EXPORT LINE · LP / RELIEF → VENT') >= 0, 'flare out: ' + tx.filter((x) => /GAS/.test(x)).join('|'));
        t.set({ rig: { flare: false }, routing: 'v341' }); app.flush(600);
        tx = frameTexts(app, cv);
        assert.ok(tx.indexOf('GAS → EXPORT LINE') >= 0, 'v3.4.1 rules: the old flare label');
        assert.ok(!tx.some((x) => /NaN|undefined/.test(x)), 'no NaN');
      } finally { t.restore(); }
      noErr(app, assert);
    }
  }
];
