// New calculator #1 — Gas Deliverability & AOF (prism-build/41-calc-gasdeliv.js,
// Round-9 plug-in registry key `gasdeliv`), driven through the real page:
// sidebar button → set inputs → click Calculate → read result rows.
//
// Expected values are the spec verification cases (NEW-CALCS-SPEC §1.6), which
// were produced by an independent reference script implementing:
//   • back-pressure q = C·Δⁿ, log–log least squares (Rawlins & Schellhardt 1935);
//   • LIT Δ = a·q + b·q², least squares of Δ/q on q (Houpeurt 1959);
//   • Δ = p̄r² − pwf² (faf / iso / stabilised), pws² − pwf² (modified isochronal
//     transient points); C and a from the stabilised point for iso / miso.
// G1 is the classic flow-after-flow textbook data set (n = 0.87, C = 0.017).
'use strict';

const WP = 'NEW1';

function rows(app, resId) {
  return app.findAll('#' + resId + ' .rrow').map((r) => {
    const l = r.querySelector('.rl'), v = r.querySelector('.rv');
    return { l: String(l ? l.textContent : '').trim(), v: String(v ? v.textContent : '').trim() };
  });
}
// nth-match of a label (the C&n box comes before the LIT box).
function rv(app, label, nth) {
  const hits = rows(app, 'gd_res').filter((r) => r.l.indexOf(label) === 0);
  const r = hits[nth || 0];
  if (!r) throw new Error('no result row "' + label + '": ' + JSON.stringify(rows(app, 'gd_res')));
  const m = r.v.replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/i);
  if (!m) throw new Error('row "' + label + '" has no number: ' + r.v);
  return parseFloat(m[0]);
}
function rvText(app, label, nth) {
  const r = rows(app, 'gd_res').filter((x) => x.l.indexOf(label) === 0)[nth || 0];
  return r ? r.v : null;
}
const errText = (app) => app.findAll('#gd_res .val-error').map((e) => e.textContent).join(' | ');
const resText = (app) => String(app.el('gd_res').textContent || '');
function noBadNumbers(assert, app, where) {
  const t = String(app.el('pgBody').textContent || '');
  assert.ok(!/NaN|Infinity|undefined/.test(t), where + ': page shows NaN/Infinity/undefined');
}
function set(app, vals) {
  for (const k of Object.keys(vals)) {
    const e = app.el(k);
    if (!e) throw new Error('no input #' + k);
    if (String(e.tagName).toUpperCase() === 'SELECT') app.select(k, String(vals[k])); else app.input(k, String(vals[k]));
  }
}
function clearRows(app) {
  const v = {};
  for (let i = 1; i <= 6; i++) { v['gd_q' + i] = ''; v['gd_pwf' + i] = ''; v['gd_pws' + i] = ''; }
  set(app, v);
}
function open(app) {
  const b = app.find('.nav-btn[data-p="gasdeliv"]');
  if (!b) throw new Error('no gasdeliv sidebar button (round 9 not built?)');
  app.click(b);
  if (!app.el('gd_root')) throw new Error('gasdeliv page did not render');
  return b;
}
const calc = (app) => app.click('gd_go');
const st = (app) => app.win.WTS_state.gasdeliv;
const pt = (kind, q, pwf, pws) => ({ kind, q, pwf, pws });

const G1 = { type: 'faf', pr: 1952, pb: 14.65, pwfDesign: 1000, qTarget: 5000,
  points: [pt('stab', 2624.6, 1700), pt('stab', 4154.7, 1500), pt('stab', 5425.1, 1300)] };
const G2 = { type: 'iso', pr: 3000, pb: 14.65, pwfDesign: 2000,
  points: [pt('trans', 3534.6, 2800), pt('trans', 5790.1, 2600), pt('trans', 7636.8, 2400), pt('stab', 4727.1, 2500)] };
const G3 = { type: 'miso', pr: 2500, pb: 14.65, pwfDesign: 1500,
  points: [pt('trans', 1500, 2399.0, 2500), pt('trans', 3000, 2257.3, 2485), pt('trans', 4500, 2087.1, 2472), pt('stab', 3500, 2104.8)] };
const G4 = { type: 'single', pr: 1952, pb: 14.65, nAssumed: 0.85, pwfDesign: 1000, points: [pt('stab', 4154.7, 1500)] };
const GW = { type: 'miso', pr: 2500, pb: 14.65,
  points: [pt('trans', 1500, 2350, 2500), pt('trans', 2900, 2200, 2480), pt('trans', 4100, 2050, 2465), pt('stab', 3900, 2000)] };

// Page inputs for a case (rows in order; point type select per row).
function caseInputs(c) {
  const v = { gd_type: c.type, gd_pr: c.pr, gd_pb: c.pb, gd_pwfd: c.pwfDesign == null ? '' : c.pwfDesign,
    gd_qt: c.qTarget == null ? '' : c.qTarget, gd_nass: c.nAssumed == null ? 0.85 : c.nAssumed };
  c.points.forEach((p, i) => {
    v['gd_k' + (i + 1)] = p.kind; v['gd_q' + (i + 1)] = p.q; v['gd_pwf' + (i + 1)] = p.pwf;
    v['gd_pws' + (i + 1)] = p.pws == null ? '' : p.pws;
  });
  return v;
}

module.exports = [
  {
    name: 'NEW1 gasdeliv compute: verification cases G1 (faf), G2 (iso), G3 (miso), G4 (single), GW (warnings)',
    wp: WP,
    run(app, assert) {
      const f = app.win.WTS_gasdeliv_compute;
      assert.strictEqual(typeof f, 'function', 'WTS_gasdeliv_compute');
      const g1 = f(app.toWin(G1));
      assert.ok(g1.ok, 'G1 ok');
      assert.deepStrictEqual(Array.from(g1.deltas).map(Math.round), [920304, 1560304, 2120304], 'G1 Δ');
      assert.near(g1.cn.n, 0.8700, 1e-4, 'G1 n');
      assert.rel(g1.cn.C, 1.7000e-2, 1e-3, 'G1 C');
      assert.near(g1.cn.r2, 1.0, 1e-4, 'G1 R²');
      assert.rel(g1.cn.aof, 9033.5, 1e-3, 'G1 AOF C&n');
      assert.rel(g1.cn.qAtPwf, 6932.0, 1e-3, 'G1 q@1000');
      assert.rel(g1.cn.pwfAtQ, 1371.1, 1e-3, 'G1 pwf@5000');
      assert.rel(g1.lit.a, 313.70, 1e-3, 'G1 a');
      assert.rel(g1.lit.b, 1.4415e-2, 1e-3, 'G1 b');
      assert.rel(g1.lit.aof, 8682.0, 1e-3, 'G1 AOF LIT');
      assert.rel(g1.lit.qAtPwf, 6820.8, 1e-3, 'G1 LIT q@1000');
      assert.rel(g1.lit.pwfAtQ, 1371.7, 1e-3, 'G1 LIT pwf@5000');
      assert.near(g1.lit.nonDarcyPct, 28.5, 0.05, 'G1 non-Darcy %');
      // Spot values (1500 → 4154.7 / 4173.5; 500 → 8516.0 / 8234.0)
      const s1 = f(app.toWin(Object.assign({}, G1, { pwfDesign: 1500 }))), s2 = f(app.toWin(Object.assign({}, G1, { pwfDesign: 500 })));
      assert.rel(s1.cn.qAtPwf, 4154.7, 1e-3); assert.rel(s1.lit.qAtPwf, 4173.5, 1e-3);
      assert.rel(s2.cn.qAtPwf, 8516.0, 1e-3); assert.rel(s2.lit.qAtPwf, 8234.0, 1e-3);
      assert.strictEqual(g1.table.length, 11, 'IPR table rows');
      assert.near(g1.table[0].qCn, 0, 1e-9, 'q = 0 at p̄r');
      assert.rel(g1.table[10].qCn, g1.cn.aof, 1e-9, 'last row = AOF');
      assert.rel(g1.table[10].qLit, g1.lit.aof, 1e-9, 'last row = LIT AOF');
      assert.ok(/^✓ Exponent n = 0\.870 /.test(g1.verdicts[0].text), g1.verdicts[0].text);

      const g2 = f(app.toWin(G2));
      assert.near(g2.cn.n, 0.7500, 1e-4, 'G2 n');
      assert.rel(g2.cn.C, 6.9986e-2, 1e-3, 'G2 C');
      assert.rel(g2.cn.aof, 11502.1, 1e-3, 'G2 AOF');
      assert.rel(g2.cn.qAtPwf, 7401.6, 1e-3, 'G2 q@2000');
      assert.rel(g2.lit.a, 470.59, 1e-3, 'G2 a');
      assert.rel(g2.lit.b, 2.3515e-2, 1e-3, 'G2 b');
      assert.rel(g2.lit.aof, 11967.6, 1e-3, 'G2 LIT AOF');
      assert.rel(g2.lit.qAtPwf, 7678.6, 1e-3, 'G2 LIT q@2000');
      assert.near(g2.lit.nonDarcyPct, 37.4, 0.05, 'G2 non-Darcy');

      const g3 = f(app.toWin(G3));
      assert.deepStrictEqual(Array.from(g3.deltas).map(Math.round), [494799, 1079822, 1754798, 1819817], 'G3 Δ (pws² − pwf² for transients)');
      assert.near(g3.cn.n, 0.8697, 1e-4, 'G3 n');
      assert.rel(g3.cn.C, 1.2576e-2, 1e-3, 'G3 C');
      assert.near(g3.cn.r2, 0.9997, 1e-4, 'G3 R²');
      assert.rel(g3.cn.aof, 10235.3, 1e-3, 'G3 AOF');
      assert.rel(g3.cn.qAtPwf, 6942.9, 1e-3, 'G3 q@1500');
      assert.rel(g3.lit.a, 449.84, 1e-3, 'G3 a');
      assert.rel(g3.lit.b, 2.0030e-2, 1e-3, 'G3 b');
      assert.rel(g3.lit.aof, 9702.0, 1e-3, 'G3 LIT AOF');
      assert.rel(g3.lit.qAtPwf, 6820.6, 1e-3, 'G3 LIT q@1500');
      assert.near(g3.lit.nonDarcyPct, 30.2, 0.05, 'G3 non-Darcy');

      const g4 = f(app.toWin(G4));
      assert.rel(g4.cn.C, 2.2611e-2, 1e-3, 'G4 C');
      assert.rel(g4.cn.aof, 8873.7, 1e-3, 'G4 AOF');
      assert.rel(g4.cn.qAtPwf, 6851.0, 1e-3, 'G4 q@1000');
      assert.ok(!g4.lit.ok && /at least two points/.test(g4.lit.reason), 'G4 LIT not reported');
      assert.ok(g4.warnings.some((w) => /Single-point AOF uses an assumed n = 0\.85/.test(w)), 'G4 single-point warning');

      const gw = f(app.toWin(GW));
      assert.near(gw.cn.n, 1.0685, 1e-4, 'GW n');
      assert.rel(gw.cn.C, 6.3608e-4, 1e-3, 'GW C');
      assert.rel(gw.cn.aof, 11618.7, 1e-3, 'GW AOF');
      assert.rel(gw.lit.b, -1.1122e-2, 1e-3, 'GW b');
      assert.ok(!gw.lit.ok && gw.lit.aof == null, 'GW LIT not reported');
      assert.ok(gw.warnings.some((w) => /outside 0\.5–1\.0/.test(w)), 'n outside range warning');
      assert.ok(gw.warnings.some((w) => /b ≤ 0/.test(w)), 'b ≤ 0 warning');

      // Extra verdicts: several stabilised points, short extrapolation, scatter.
      const two = f(app.toWin(Object.assign({}, G2, { points: G2.points.concat([pt('stab', 4727.1, 2500)]) })));
      assert.ok(two.warnings.some((w) => /More than one stabilised point/.test(w)));
      const small = f(app.toWin({ type: 'faf', pr: 3000, pb: 14.65, points: [pt('stab', 500, 2990), pt('stab', 900, 2980), pt('stab', 1300, 2970)] }));
      assert.ok(small.warnings.some((w) => /long extrapolation/.test(w)), 'long extrapolation warning');
      const scat = f(app.toWin({ type: 'faf', pr: 2000, pb: 14.65, points: [pt('stab', 1000, 1800), pt('stab', 3000, 1600), pt('stab', 2000, 1400)] }));
      assert.ok(scat.warnings.some((w) => /Points scatter/.test(w)), 'scatter warning');
    },
  },
  {
    name: 'NEW1 gasdeliv validation: messages instead of NaN, offending inputs flagged',
    wp: WP,
    run(app, assert) {
      const f = app.win.WTS_gasdeliv_compute;
      const E = (inp) => f(app.toWin(inp)).errors.join(' | ');
      assert.match(E({ type: 'faf', pb: 14.65, points: G1.points }), /Average reservoir pressure is required/);
      assert.match(E(Object.assign({}, G1, { pb: 150 })), /must not exceed/);
      assert.match(E(Object.assign({}, G1, { pb: 2000 })), /below the average reservoir pressure/);
      assert.match(E(Object.assign({}, G1, { points: [pt('stab', 2624.6, null)] })), /Point 1: enter both rate and pwf/);
      assert.match(E(Object.assign({}, G1, { points: [pt('stab', -5, 1700), pt('stab', 100, 1600)] })), /Point 1: rate must be above 0/);
      assert.match(E(Object.assign({}, G1, { points: [pt('stab', 100, 2100), pt('stab', 200, 1600)] })), /Point 1: pwf must be above 0 and below/);
      assert.match(E(Object.assign({}, G1, { points: [pt('stab', 100, 1600)] })), /at least two test points/);
      assert.match(E(Object.assign({}, G3, { points: [pt('trans', 1500, 2399), pt('trans', 3000, 2257.3, 2485), pt('stab', 3500, 2104.8)] })), /Point 1: enter pws/);
      assert.match(E(Object.assign({}, G3, { points: [pt('trans', 1500, 2399, 2390), pt('trans', 3000, 2257.3, 2485), pt('stab', 3500, 2104.8)] })), /pws must be above pwf/);
      assert.match(E(Object.assign({}, G3, { points: [pt('trans', 1500, 2399, 2600), pt('trans', 3000, 2257.3, 2485), pt('stab', 3500, 2104.8)] })), /more than 1 %/);
      assert.match(E(Object.assign({}, G2, { points: G2.points.slice(0, 3) })), /one stabilised point/);
      assert.match(E(Object.assign({}, G2, { points: G2.points.slice(2) })), /at least two transient points/);
      assert.match(E(Object.assign({}, G4, { nAssumed: 1.3 })), /between 0\.5 and 1\.0/);
      assert.match(E(Object.assign({}, G4, { points: [] })), /Enter the stabilised test point/);
      assert.match(E(Object.assign({}, G1, { points: [pt('stab', 100, 1700), pt('stab', 200, 1700)] })), /same drawdown/);
      assert.match(E(Object.assign({}, G1, { pwfDesign: 5 })), /Flowing pressure for the rate readout/);
      assert.match(E(Object.assign({}, G1, { qTarget: -1 })), /Target rate/);
      assert.match(E(Object.assign({}, G1, { points: [pt('stab', 3000, 1700), pt('stab', 2000, 1500)] })), /not positive/);
      assert.match(E({ type: 'bogus', pr: 1952, pb: 14.65 }), /Select a test type/);

      // Through the page: errors render as .val-error, inputs get input-err, no NaN.
      open(app);
      set(app, { gd_q1: '' });
      calc(app);
      assert.includes(errText(app), 'Point 1: enter both rate and pwf');
      assert.ok(app.el('gd_q1').classList.contains('input-err'), 'missing q1 flagged');
      assert.ok(!app.find('#gd_res .rrow'), 'no results while invalid');
      assert.strictEqual(st(app).ok, false);
      assert.strictEqual(st(app).aofCn, null, 'no AOF published on error');
      noBadNumbers(assert, app, 'invalid');
      set(app, { gd_q1: 2624.6 });
      calc(app);
      assert.strictEqual(errText(app), '', 'fixed');
      assert.ok(!app.el('gd_q1').classList.contains('input-err'), 'flag cleared');
      set(app, { gd_type: 'miso' });
      assert.includes(errText(app), 'transient points');
      set(app, { gd_type: 'faf', gd_pb: 500 });
      assert.includes(errText(app), 'must not exceed');
      assert.ok(app.el('gd_pb').classList.contains('input-err'));
      noBadNumbers(assert, app, 'pb > 100');
    },
  },
  {
    name: 'NEW1 gasdeliv page: sidebar button → defaults give G1; results rows, verdict, table, chart, notes, report capture',
    wp: WP,
    run(app, assert) {
      const W = app.win;
      const reg = W.WTS_calcRegistry && W.WTS_calcRegistry.gasdeliv;
      assert.ok(reg && reg.key === 'gasdeliv' && typeof reg.render === 'function', 'registry entry');
      assert.strictEqual(reg.group, 'Production & Reservoir');
      const b = open(app);
      const g = b.closest('.nav-group'), lab = g && g.querySelector('.nav-group-label');
      assert.strictEqual(String(lab.textContent).trim(), 'Production & Reservoir', 'sidebar group');
      assert.strictEqual(app.hook.page(), 'gasdeliv');
      assert.strictEqual(String(app.el('pgTitle').textContent).trim(), 'Gas Deliverability & AOF');
      assert.ok(b.classList.contains('active'), 'active nav');
      // Defaults = case G1, computed on render.
      const s = st(app);
      assert.ok(s.ok && s.type === 'faf');
      assert.rel(s.aofCn, 9033.5, 1e-3, 'state AOF C&n');
      assert.rel(s.aofLit, 8682.0, 1e-3, 'state AOF LIT');
      assert.near(s.n, 0.87, 1e-4); assert.rel(s.C, 0.017, 1e-3); assert.rel(s.a, 313.70, 1e-3); assert.rel(s.b, 1.4415e-2, 1e-3);
      assert.strictEqual(app.el('gd_res').getAttribute('data-done'), '1');
      // Result rows (C&n first, LIT second)
      assert.near(rv(app, 'Exponent n'), 0.87, 1e-4);
      assert.strictEqual(rvText(app, 'Coefficient C'), '1.7000e-2 MSCFD/psia²ⁿ');
      assert.rel(rv(app, 'AOF', 0), 9033.5, 1e-4, 'AOF row');
      assert.includes(rvText(app, 'AOF', 0), '(9.034 MMSCFD)');
      assert.rel(rv(app, 'Rate at pwf', 0), 6932.0, 1e-4);
      assert.rel(rv(app, 'pwf at q', 0), 1371.1, 1e-4);
      assert.rel(rv(app, 'AOF', 1), 8682.0, 1e-4, 'LIT AOF row');
      assert.rel(rv(app, 'Rate at pwf', 1), 6820.8, 1e-4);
      assert.rel(rv(app, 'pwf at q', 1), 1371.7, 1e-4);
      assert.near(rv(app, 'Non-Darcy share'), 28.5, 0.05);
      assert.rel(rv(app, 'a'), 313.70, 1e-3);
      assert.includes(rows(app, 'gd_res').map((r) => r.l).join('|'), 'Rate at pwf = 1,000 psia');
      assert.includes(resText(app), '✓ Exponent n = 0.870 is within the physical range 0.5–1.0.');
      // Table: 11 rows, 3 columns, first row pwf = p̄r, q = 0
      const trs = app.findAll('#gd_res table.dtable tbody tr');
      assert.strictEqual(trs.length, 11, 'deliverability table rows');
      const td0 = trs[0].querySelectorAll('td');
      assert.strictEqual(String(td0[0].textContent).trim(), '1,952', 'first row pwf = p̄r');
      assert.strictEqual(String(td0[1].textContent).trim(), '0', 'first row q = 0');
      assert.strictEqual(String(trs[10].querySelectorAll('td')[1].textContent).trim(), '9,033.5', 'last row q = AOF');
      // Chart drawn with the host drawLineChart
      const texts = app.canvasTexts('gd_chart');
      assert.ok(texts.some((t) => /Gas rate \(MSCFD\)/.test(t)), 'x label drawn: ' + texts.slice(0, 8).join(' | '));
      assert.ok(texts.some((t) => /Test points/.test(t)) && texts.some((t) => /LIT/.test(t)), 'legend');
      assert.includes(resText(app), 'Notes AOF is the rate at a sandface back-pressure of 14.65 psia');
      noBadNumbers(assert, app, 'defaults');
      // Report capture (PDF/PNG/Quick Report share collectPageReport)
      const model = W.collectPageReport(app.el('pgBody'), { charts: false });
      const js = JSON.stringify(model);
      assert.ok(model.inputs.length > 0 && model.results.length > 0, 'inputs + results sections');
      // (Table capture — test points and the deliverability table — is covered by
      // tests/calc-report-tables.test.js; here .fg-item/.rrow/notes.)
      ['Average reservoir pressure', 'Test type', 'Exponent n', 'Non-Darcy share', 'Exponent n = 0.870', 'sandface back-pressure'].forEach((n) => assert.includes(js, n));
      assert.ok(js.indexOf('"verdict":true') !== -1, 'verdict captured as a callout');
      const n0 = app.opened.length;
      W.exportPagePDF();
      const pdf = app.opened[n0] && app.opened[n0].html();
      assert.ok(pdf && pdf.indexOf('Gas Deliverability') !== -1 && pdf.indexOf('Exponent n = 0.870') !== -1, 'page PDF has title + verdict');
      // Dashboard tile
      app.hook.nav('home');
      const tile = app.findAll('.dash-card').find((c) => /Gas Deliverability/.test(String(c.textContent)));
      assert.ok(tile, 'dashboard tile');
      app.click(tile);
      assert.strictEqual(app.hook.page(), 'gasdeliv', 'tile navigates');
    },
  },
  {
    name: 'NEW1 gasdeliv page: G2 isochronal, G3 modified isochronal, G4 single point and GW warnings entered through the inputs',
    wp: WP,
    run(app, assert) {
      open(app);
      clearRows(app); set(app, caseInputs(G2)); calc(app);
      assert.strictEqual(errText(app), '', 'G2 no errors');
      assert.near(st(app).n, 0.75, 1e-4, 'G2 n');
      assert.rel(st(app).aofCn, 11502.1, 1e-3); assert.rel(st(app).aofLit, 11967.6, 1e-3);
      assert.rel(rv(app, 'Rate at pwf', 0), 7401.6, 1e-4); assert.rel(rv(app, 'Rate at pwf', 1), 7678.6, 1e-4);
      assert.includes(rvText(app, 'Points used'), '(isochronal)');

      clearRows(app); set(app, caseInputs(G3)); calc(app);
      assert.strictEqual(errText(app), '', 'G3 no errors');
      assert.near(st(app).n, 0.8697, 1e-4, 'G3 n');
      assert.rel(st(app).a, 449.84, 1e-3); assert.rel(st(app).b, 2.0030e-2, 1e-3);
      assert.rel(st(app).aofCn, 10235.3, 1e-3); assert.rel(st(app).aofLit, 9702.0, 1e-3);
      assert.near(rv(app, 'Fit R²'), 0.9997, 1e-4);
      assert.near(rv(app, 'Non-Darcy share'), 30.2, 0.05);

      clearRows(app); set(app, caseInputs(G4)); calc(app);
      assert.rel(st(app).aofCn, 8873.7, 1e-3, 'G4 AOF');
      assert.strictEqual(st(app).aofLit, null);
      assert.strictEqual(rvText(app, 'Status'), 'LIT needs at least two points');
      assert.includes(resText(app), '⚠ Single-point AOF uses an assumed n = 0.85; confirm with a multipoint test.');
      assert.strictEqual(rows(app, 'gd_res').filter((r) => r.l === 'Fit R² (log–log)').length, 0, 'no R² for one point');

      clearRows(app); set(app, caseInputs(GW)); calc(app);
      assert.near(st(app).n, 1.0685, 1e-4, 'GW n');
      assert.rel(st(app).aofCn, 11618.7, 1e-3);
      assert.strictEqual(st(app).aofLit, null, 'LIT AOF not reported');
      assert.strictEqual(rvText(app, 'AOF', 1), '—');
      assert.includes(resText(app), '⚠ Exponent n = 1.069 is outside 0.5–1.0');
      assert.includes(resText(app), '⚠ LIT coefficient b ≤ 0');
      noBadNumbers(assert, app, 'GW');
      // Changing an input recalculates without the button (listener on #gd_root)
      set(app, { gd_type: 'faf' });
      clearRows(app); set(app, caseInputs(G1));
      assert.rel(st(app).aofCn, 9033.5, 1e-3, 'live recalc');
    },
  },
  {
    name: 'NEW1 gasdeliv metric: labels read kPa / m³/d, canonical results identical to imperial, unit flip recalculates',
    wp: WP,
    run(app, assert) {
      const U = app.win.WTS_units;
      app.flush(10);
      open(app);
      const imp = JSON.parse(JSON.stringify(st(app)));
      U.setSystem('metric');
      try {
        app.hook.nav('home');
        open(app);
        const lab = app.el('gd_pr').closest('.fg-item').querySelector('label');
        assert.match(String(lab.textContent), /\(kPa\)/, 'pressure label');
        assert.match(String(app.el('gd_qt').closest('.fg-item').querySelector('label').textContent), /\(m³\/d\)/, 'rate label');
        const s = st(app);
        ['n', 'C', 'r2', 'aofCn', 'a', 'b', 'aofLit'].forEach((k) => assert.rel(s[k], imp[k], 1e-6, 'metric ' + k));
        // AOF row shown in metric: 9033.5 MSCFD × 28.3168 = 255,799 m³/d
        assert.rel(rv(app, 'AOF', 0), 9033.5 * 28.3168, 2e-4, 'AOF in m³/d');
        assert.includes(rvText(app, 'AOF', 0), 'm³/d');
        const ths = app.findAll('#gd_res table.dtable th').map((t) => String(t.textContent));
        assert.ok(/kPa/.test(ths[0]), 'table pwf header in kPa: ' + ths[0]);
        // The field-unit row stays (the equation is unit-specific); v3.0 adds a metric companion row:
        // q[m³/d] = C_SI·Δ(p²)[kPa²]ⁿ → C_SI = C·28.3168466/6.894757²ⁿ; a_SI = a·6.894757²/28.3168466;
        // b_SI = b·6.894757²/28.3168466² (1 Mscf = 28.3168466 m³, 1 psi = 6.894757 kPa).
        assert.includes(rvText(app, 'Coefficient C'), 'MSCFD/psia²ⁿ', 'C stays in field units');
        const cSI = rvText(app, 'Coefficient C (metric');
        assert.ok(cSI && /\(m³\/d\)\/kPa²ⁿ/.test(cSI), 'metric C row: ' + cSI);
        assert.rel(parseFloat(cSI), imp.C * 28.3168466 / Math.pow(6.894757, 2 * imp.n), 2e-4, 'C in m³/d and kPa');
        const aSI = rvText(app, 'a (metric'), bSI = rvText(app, 'b (metric');
        assert.rel(parseFloat(aSI.replace(/,/g, '')), imp.a * 6.894757 ** 2 / 28.3168466, 2e-4, 'a in kPa²/(m³/d)');
        assert.rel(parseFloat(bSI), imp.b * 6.894757 ** 2 / 28.3168466 ** 2, 2e-4, 'b in kPa²/(m³/d)²');
        // Independent check of C_SI: it reproduces the AOF in m³/d from p̄r in kPa
        const prK = imp.pr * 6.894757;
        assert.rel(parseFloat(cSI) * Math.pow(prK * prK - 14.696 ** 2 * 6.894757 ** 2, imp.n), imp.aofCn * 28.3168466, 2e-3, 'C_SI·(p̄r² − pa²)ⁿ = AOF');
        assert.includes(rvText(app, 'a'), 'psia²/MSCFD', 'a stays in field units');
        // Enter a metric value: 13,000 kPa ≈ 1885.5 psia
        set(app, { gd_pr: 13000 });
        assert.rel(st(app).pr, 13000 / 6.894757, 1e-4, 'metric entry converted to psia');
        noBadNumbers(assert, app, 'metric');
      } finally { U.setSystem('imperial'); }
      assert.rel(st(app).pr, 13000 / 6.894757, 1e-4, 'flip back keeps the physical value');
      assert.match(rvText(app, 'AOF', 0), /MSCFD/, 'flip recalculated into imperial');
    },
  },
  {
    name: 'NEW1 gasdeliv persistence: autosave, reload restore (incl. selects and table rows), no timers left',
    wp: WP,
    run(app, assert) {
      open(app);
      clearRows(app); set(app, caseInputs(G3));
      const aof = st(app).aofCn;
      assert.rel(aof, 10235.3, 1e-3);
      app.flush(1200);
      const rec = JSON.parse(app.storage.getItem('wts_page_gasdeliv') || 'null');
      assert.ok(rec && rec.f && rec.f.gd_type === 'miso' && rec.f.gd_pws2 === '2485', 'autosaved: ' + JSON.stringify(rec && rec.f).slice(0, 200));
      const app2 = app.reload();
      try {
        open(app2);
        assert.strictEqual(app2.el('gd_type').value, 'miso', 'type restored');
        assert.strictEqual(app2.el('gd_k4').value, 'stab', 'row type restored');
        assert.strictEqual(app2.el('gd_pwf3').value, '2087.1', 'table value restored');
        assert.rel(app2.win.WTS_state.gasdeliv.aofCn, aof, 1e-9, 'recalculated on restore');
        app2.flushUntilIdle(10000);
        assert.strictEqual(app2.pendingTimers(), 0, 'no timers left');
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'NEW1 gasdeliv renders at 375 px (sidebar reachable, tables scroll inside wrappers)',
    wp: WP,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      const b = app.find('.nav-btn[data-p="gasdeliv"]');
      assert.ok(b && b.closest('#sidebar'), 'button in the mobile sidebar');
      open(app);
      assert.ok(app.find('#gd_res .rrow'), 'results at 375 px');
      app.findAll('#gd_root table').forEach((t) => {
        assert.strictEqual(t.parentNode.style.overflowX, 'auto', 'table wrapped in overflow-x:auto');
      });
      app.findAll('#gd_root [style]').forEach((e) => {
        const m = /(?:^|;)\s*(?:min-)?width\s*:\s*(\d+)px/.exec(e.getAttribute('style'));
        assert.ok(!m || +m[1] <= 340, 'no fixed width above 340 px: ' + e.getAttribute('style'));
      });
    },
  },
];
