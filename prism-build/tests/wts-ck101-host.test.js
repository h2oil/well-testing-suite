// Well Test Simulator — CK-101 choke manifold, host side (review finding [tests 3]).
// The host steady walk calcWTS takes the bean of the leg in service: the adjustable choke (#wts_bean, the v3.3.3 input) or the
// positive (fixed) choke (#wts_beanFix, clamped to 4-128, blank / invalid → 24) when #wts_ckLeg is 'fixed'. The golden
// (wts-calc-golden.js) only runs the 'adj' leg, so these tests run the 'fixed' leg through the golden's own stub DOM (makeCalc):
//   H1  flow.chokeBean / inputs.bean = beanFix, flow.ck1 = {v:1, leg:'fixed', beanAdj, beanFix, bean}, the positive-choke
//       flow-limited warning, the 'positive choke' result labels; the adjustable leg keeps the v3.3.3 texts;
//   H2  the beanFix clamp (2 → 4, 200 → 128, blank / 0 / -5 / text → 24; 4 and 128 kept);
//   H3  the fixed walk equals the adjustable walk at the same bean apart from the labels (flow, nodes, segs, page);
//   H4  mutation check: with the effective-bean line replaced by `const bean=beanAdj` H1 / H3 fail (the tests can see the leg);
//   H5  the Quick Report row label (30-quick-report.js) names the positive choke;
//   H6  the host 2D painter wtsDrawDiag prints 'positive NN/64"' for nodes[2].leg 'fixed', the plain label for 'adj', and with no
//       leg follows the leg of the last calcWTS;
//   H7  page autosave → reload and a project file round trip keep wts_ckLeg / wts_beanFix.
'use strict';

const GOLD = require('../wts-calc-golden.js');

const WP = 'WTSCK1H';
const J = (x) => JSON.parse(JSON.stringify(x));
const mix = (...a) => Object.assign({}, ...a);
const BASE = GOLD.SETS[0].vals;
const EFF_LINE = "const bean=ckLeg==='fixed'?beanFix:beanAdj";
const POS_WARN = (b) => 'Choke is flow-limited — positive choke ' + b + '/64" at Cd=0.85 can only pass';
const POS_WARN_TAIL = 'Switch to the adjustable choke (change the positive bean while its leg is on standby) or reduce rate.';
const ADJ_WARN_TAIL = 'Increase bean or reduce rate.';

// strip the leg-only parts so a fixed walk and an adjustable walk at the same bean can be compared
function normFlow(f) {
  const x = J(GOLD.encode(GOLD.baseFields(f)));
  delete x.inputs.leg; delete x.inputs.beanAdj; delete x.inputs.beanFix;
  x.warnings = (x.warnings || []).map((w) => ({ t: w.t, m: normText(w.m) }));
  return x;
}
function normText(s) {
  return String(s)
    .replace(/positive choke (\d+)\/64" at/g, 'bean $1/64" at')
    .replace(/Switch to the adjustable choke \(change the positive bean while its leg is on standby\) or reduce rate\./g, ADJ_WARN_TAIL);
}
function normRes(s) {
  return normText(s)
    .replace(/<span class="rv">positive choke /g, '<span class="rv">')
    .replace(/\n\s*<div class="rrow"><span class="rl">Choke in service<\/span><span class="rv">Positive \(fixed\) choke [^<]*<\/span><\/div>/g, '');
}
function walkKey(r) {
  return JSON.stringify({ nodes: GOLD.encode(r.lastCalc.nodes), segs: GOLD.encode(r.lastCalc.segs), regime: r.lastCalc.regime,
    flowLimited: r.lastCalc.flowLimited, choke: GOLD.encode(r.lastCalc.choke), heater: GOLD.encode(r.lastCalc.heater) });
}

// H1 + H3 as one function over a calcWTS region, so H4 can run it on a mutated region
function fixedLegChecks(regionSrc, assert) {
  const C = GOLD.makeCalc(regionSrc);
  // H1: a small positive bean (flow-limited at the default rates), adjustable bean left at 32
  const r = C.run(mix(BASE, { wts_ckLeg: 'fixed', wts_beanFix: '12' }));
  assert.ok(r.flow, 'calcWTS published a flow');
  assert.strictEqual(r.flow.chokeBean, 12, 'flow.chokeBean = beanFix');
  assert.strictEqual(r.lastCalc.inputs.bean, 12, 'WTS_lastCalc.inputs.bean = beanFix');
  assert.strictEqual(r.flow.inputs.bean, 12, 'flow.inputs.bean = beanFix');
  assert.deepStrictEqual(J(r.flow.ck1), { v: 1, leg: 'fixed', beanAdj: 32, beanFix: 12, bean: 12 }, 'flow.ck1');
  assert.ok(r.lastCalc.inputs.leg === 'fixed' && r.lastCalc.inputs.beanAdj === 32 && r.lastCalc.inputs.beanFix === 12, 'lastCalc.inputs leg / beans');
  assert.strictEqual(r.lastCalc.flowLimited, true, 'a 12/64 positive bean is flow-limited at 10 MMSCFD');
  assert.ok(r.page.warn.indexOf(POS_WARN(12)) >= 0 && r.page.warn.indexOf(POS_WARN_TAIL) >= 0, 'positive-choke flow-limited warning: ' + r.page.warn);
  assert.ok(r.page.warn.indexOf(ADJ_WARN_TAIL) < 0, 'no adjustable-choke advice on the positive leg');
  assert.ok(r.flow.warnings.some((w) => w.t === 'error' && w.m.indexOf(POS_WARN(12)) === 0), 'flow.warnings carries the positive-choke text');
  assert.ok(r.page.res.indexOf('<span class="rv">positive choke 12/64" (0.188") &middot; Cd=0.85</span>') >= 0, 'result label "positive choke 12/64""');
  assert.ok(r.page.res.indexOf('Positive (fixed) choke 12/64" &middot; adjustable choke on standby at 32/64"') >= 0, 'Choke in service row');
  // the adjustable leg at the same bean: the v3.3.3 texts
  const a = C.run(mix(BASE, { wts_ckLeg: 'adj', wts_bean: '12', wts_beanFix: '24' }));
  assert.deepStrictEqual(J(a.flow.ck1), { v: 1, leg: 'adj', beanAdj: 12, beanFix: 24, bean: 12 }, 'adj flow.ck1');
  assert.ok(a.page.warn.indexOf('Choke is flow-limited — bean 12/64" at Cd=0.85') >= 0 && a.page.warn.indexOf(ADJ_WARN_TAIL) >= 0, 'adjustable warning');
  assert.ok(a.page.res.indexOf('positive choke') < 0 && a.page.res.indexOf('Choke in service') < 0, 'no positive-choke labels on the adjustable leg');
  // H3: the fixed walk equals the adjustable walk at the same bean apart from the labels
  [['12', '32'], ['48', '20'], ['24', '64']].forEach(([b, other]) => {
    const f = C.run(mix(BASE, { wts_ckLeg: 'fixed', wts_beanFix: b, wts_bean: other }));
    const d = C.run(mix(BASE, { wts_ckLeg: 'adj', wts_bean: b, wts_beanFix: other }));
    assert.strictEqual(walkKey(f), walkKey(d), 'bean ' + b + ': nodes / segs / regime / choke / heater equal');
    assert.deepStrictEqual(normFlow(f.flow), normFlow(d.flow), 'bean ' + b + ': flow equal apart from the leg fields and labels');
    assert.strictEqual(normRes(f.page.res), d.page.res, 'bean ' + b + ': results equal apart from the positive-choke labels');
    assert.strictEqual(normText(f.page.warn), d.page.warn, 'bean ' + b + ': warnings equal apart from the positive-choke text');
    assert.ok(f.page.regime === d.page.regime && f.page.regimeColor === d.page.regimeColor, 'bean ' + b + ': regime text / colour');
  });
}

module.exports = [
  {
    name: 'WTSCK1H H1/H3 host calcWTS positive leg: chokeBean / inputs.bean = beanFix, flow.ck1, positive-choke warning and labels; the fixed walk = the adjustable walk at the same bean apart from the labels',
    wp: WP,
    opts: false,
    run(app, assert) { fixedLegChecks(GOLD.hostRegion(), assert); },
  },
  {
    name: 'WTSCK1H H2 host calcWTS beanFix clamp: 2 → 4, 200 → 128, blank / 0 / -5 / text → 24; 4, 128 and 30 kept; the adjustable leg never uses it',
    wp: WP,
    opts: false,
    run(app, assert) {
      const C = GOLD.makeCalc(GOLD.hostRegion());
      [['2', 4], ['200', 128], ['', 24], ['0', 24], ['-5', 24], ['abc', 24], ['4', 4], ['128', 128], ['30', 30]].forEach(([v, exp]) => {
        const r = C.run(mix(BASE, { wts_ckLeg: 'fixed', wts_beanFix: v }));
        assert.strictEqual(r.flow.chokeBean, exp, 'beanFix "' + v + '" → chokeBean ' + exp);
        assert.deepStrictEqual(J(r.flow.ck1), { v: 1, leg: 'fixed', beanAdj: 32, beanFix: exp, bean: exp }, 'beanFix "' + v + '": flow.ck1');
        assert.ok(r.page.res.indexOf('positive choke ' + exp + '/64"') >= 0, 'beanFix "' + v + '": label ' + exp);
        const a = C.run(mix(BASE, { wts_ckLeg: 'adj', wts_beanFix: v }));
        assert.ok(a.flow.chokeBean === 32 && a.flow.ck1.beanFix === exp && a.flow.ck1.bean === 32, 'adj leg with beanFix "' + v + '": bean 32');
      });
      // no #wts_beanFix / #wts_ckLeg on the page (a v3.3.3 page): adjustable leg, beanFix 24
      const n = C.run(mix(BASE));
      assert.deepStrictEqual(J(n.flow.ck1), { v: 1, leg: 'adj', beanAdj: 32, beanFix: 24, bean: 32 }, 'no CK-101 inputs');
      // any leg value other than 'fixed' is the adjustable leg
      const o = C.run(mix(BASE, { wts_ckLeg: 'FIXED', wts_beanFix: '12' }));
      assert.ok(o.flow.ck1.leg === 'adj' && o.flow.chokeBean === 32, 'leg "FIXED" → adj');
    },
  },
  {
    name: 'WTSCK1H H4 mutation check: with the effective-bean line replaced by `const bean=beanAdj` the H1 / H3 checks fail (the golden --check alone does not see it)',
    wp: WP,
    opts: false,
    run(app, assert) {
      const src = GOLD.hostRegion();
      assert.strictEqual(src.split(EFF_LINE).length - 1, 1, 'the effective-bean line is in the calcWTS region once');
      const mut = src.replace(EFF_LINE, 'const bean=beanAdj');
      let failed = null;
      try { fixedLegChecks(mut, assert); } catch (e) { failed = e; }
      assert.ok(failed, 'the mutated region must fail the positive-leg checks');
      assert.ok(/flow\.chokeBean = beanFix/.test(String(failed && failed.message)), 'it fails on the effective bean: ' + (failed && failed.message));
    },
  },
  {
    name: 'WTSCK1H H5 Quick Report: the WTS row reads "Choke Bean (positive choke)" with the positive bean on the fixed leg and "Choke Bean" on the adjustable leg',
    wp: WP,
    integration: true,
    run(app, assert) {
      const W = app.win;
      const b = app.find('.nav-btn[data-p="wts"]');
      assert.ok(b, 'Well Test Simulator sidebar button'); app.click(b); app.flush(500);
      const row = () => {
        const h = String(W.WTS_quickReport.preview({ modules: ['wts'] }));
        const m = h.match(/<tr><th>(Choke Bean[^<]*)<\/th><td>([^<]*)</);
        return m ? [m[1], m[2]] : [null, h.slice(0, 400)];
      };
      app.el('wts_ckLeg').value = 'fixed'; app.el('wts_beanFix').value = '20'; W.calcWTS(); app.flush(50);
      assert.strictEqual(W.WTS_state.flow.ck1.leg, 'fixed', 'flow.ck1.leg fixed');
      const f = row();
      assert.strictEqual(f[0], 'Choke Bean (positive choke)', 'fixed-leg row label: ' + f[1]);
      assert.ok(/(^|\D)20(\D|$)/.test(f[1]), 'fixed-leg row value 20: ' + f[1]);
      app.el('wts_ckLeg').value = 'adj'; app.el('wts_bean').value = '40'; W.calcWTS(); app.flush(50);
      const a = row();
      assert.strictEqual(a[0], 'Choke Bean', 'adjustable-leg row label: ' + a[1]);
      assert.ok(/(^|\D)40(\D|$)/.test(a[1]), 'adjustable-leg row value 40: ' + a[1]);
    },
  },
  {
    name: 'WTSCK1H H6 host 2D painter wtsDrawDiag: nodes[2].leg "fixed" → \'positive NN/64"\', "adj" → the plain label; no leg → the leg of the last calcWTS',
    wp: WP,
    integration: true,
    run(app, assert) {
      const W = app.win;
      const b = app.find('.nav-btn[data-p="wts"]');
      assert.ok(b, 'Well Test Simulator sidebar button'); app.click(b); app.flush(500);
      const cv = app.el('wts_cv');
      assert.ok(cv && typeof W.wtsDrawDiag === 'function', 'wts_cv and wtsDrawDiag');
      const texts = (leg, bean) => {
        const lc = W.WTS_lastCalc, n = J(lc.nodes);
        n[2].bean = bean; n[2].regime = n[2].regime || 'Critical';
        if (leg === undefined) delete n[2].leg; else n[2].leg = leg;
        cv._log.length = 0; W.wtsDrawDiag(app.toWin(n), lc.segs);
        return cv._log.filter((e) => e.op === 'fillText').map((e) => String(e.args[0]));
      };
      const calc = (leg) => { app.el('wts_ckLeg').value = leg; W.calcWTS(); app.flush(50); };
      calc('adj');
      let t = texts('fixed', 24);
      assert.ok(t.indexOf('positive 24/64"') >= 0, 'fixed leg: positive 24/64" — ' + t.filter((s) => /64"/.test(s)).join('|'));
      assert.ok(!t.some((s) => /POS|positive positive/.test(s)), 'a single prefix');
      t = texts('adj', 24);
      assert.ok(t.indexOf('24/64"') >= 0 && !t.some((s) => /positive/.test(s)), 'adj leg: plain 24/64"');
      t = texts(undefined, 24);
      assert.ok(t.indexOf('24/64"') >= 0 && !t.some((s) => /positive/.test(s)), 'no leg after an adjustable calc: plain 24/64"');
      calc('fixed');
      t = texts(undefined, 24);
      assert.ok(t.indexOf('positive 24/64"') >= 0, 'no leg after a fixed calc (static diagram): positive 24/64"');
      t = texts('adj', 32);
      assert.ok(t.indexOf('32/64"') >= 0 && !t.some((s) => /positive/.test(s)), 'explicit adj leg wins over the last calc');
      assert.deepStrictEqual(app.consoleErrors(), [], 'no console errors');
    },
  },
  {
    name: 'WTSCK1H H7 persistence: page autosave → reload and a project file round trip keep wts_ckLeg / wts_beanFix (and the walk uses them)',
    wp: WP,
    integration: true,
    run(app, assert, ctx) {
      const go = (a) => { const b = a.find('.nav-btn[data-p="wts"]'); if (!b) throw new Error('no Well Test Simulator button'); a.click(b); a.flush(800); };
      const flushSave = (a) => { if (a.win.WTS_pageAutosave && a.win.WTS_pageAutosave.flush) a.win.WTS_pageAutosave.flush(); a.flush(800); };
      go(app);
      assert.strictEqual(app.el('wts_ckLeg').value, 'adj', 'default leg adj');
      assert.strictEqual(app.el('wts_beanFix').value, '24', 'default beanFix 24');
      app.change('wts_ckLeg', 'fixed'); app.flush(400);
      app.input('wts_beanFix', '18'); app.flush(800);
      flushSave(app);
      const rec = JSON.parse(app.win.localStorage.getItem('wts_page_wts') || '{}');
      const recS = JSON.stringify(rec);
      assert.ok(/wts_ckLeg/.test(recS) && /fixed/.test(recS) && /wts_beanFix/.test(recS) && /18/.test(recS), 'page record holds the leg and bean: ' + recS.slice(0, 300));
      app.win.localStorage.removeItem('wts_wts');                   // only the universal page record is left
      const b = ctx.loadApp({ storage: app.storage });
      go(b); b.flush(1000);
      assert.ok(b.el('wts_ckLeg').value === 'fixed' && b.el('wts_beanFix').value === '18', 'restored after reload: ' + b.el('wts_ckLeg').value + ' / ' + b.el('wts_beanFix').value);
      b.win.calcWTS(); b.flush(50);
      assert.deepStrictEqual(J(b.win.WTS_lastCalc.flow.ck1), { v: 1, leg: 'fixed', beanAdj: 32, beanFix: 18, bean: 18 }, 'the walk after the reload uses the positive leg');
      // project file round trip: save, change the page, apply the file, re-open the page
      flushSave(b);
      const payload = JSON.parse(JSON.stringify(b.win.WTS_project._buildPayload()));
      const ps = JSON.stringify(payload);
      assert.ok(/wts_ckLeg/.test(ps) && /wts_beanFix/.test(ps), 'project payload carries wts_ckLeg / wts_beanFix');
      b.change('wts_ckLeg', 'adj'); b.flush(400);
      b.input('wts_beanFix', '60'); b.flush(800);
      flushSave(b);
      assert.ok(b.el('wts_ckLeg').value === 'adj' && b.el('wts_beanFix').value === '60', 'page changed before the load');
      const res = b.win.WTS_project._internals.applyPayload(b.toWin(payload));
      assert.ok(res && !res.error, 'applyPayload: ' + JSON.stringify(res));
      b.flush(800);
      b.click(b.find('.nav-btn[data-p="home"]') || b.find('.nav-btn')); b.flush(300);
      go(b); b.flush(800);
      assert.ok(b.el('wts_ckLeg').value === 'fixed' && b.el('wts_beanFix').value === '18', 'restored from the project file: ' + b.el('wts_ckLeg').value + ' / ' + b.el('wts_beanFix').value);
      b.win.calcWTS(); b.flush(50);
      assert.strictEqual(b.win.WTS_lastCalc.flow.chokeBean, 18, 'chokeBean 18 after the project load');
    },
  },
];
