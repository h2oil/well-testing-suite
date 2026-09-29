// New calculator #2 — Oil Well IPR (`oilipr`, prism-build/42-calc-oilipr.js).
//
// Drives the page through the host (registry nav → inputs → Calculate → result
// rows) and checks the pure compute against the spec's verification cases
// O1–O4. Expected values are independent hand calculations:
//   • Vogel (1968): V(x) = 1 − 0.2x − 0.8x²; qmax = q₁/V(pwf₁/p̄r)  (textbook 250 BPD)
//   • Standing (1970) FE: pwf′ = p̄r − FE·(p̄r − pwf)
//   • Composite: J = q₁/[(p̄r − pb) + pb/1.8·V(pwf₁/pb)], qmax = J(p̄r − pb) + J·pb/1.8
//   • Fetkovich (1973): log-log least squares of q vs (p̄r² − pwf²)
// Metric runs enter the same physical case and must give the same canonical state.
'use strict';

const WP = 'NEW2';

// ── Independent reference (not the app's code) ─────────────────────────────
const V = (x) => 1 - 0.2 * x - 0.8 * x * x;
function fetkRef(pr, pts) {
  const X = pts.map((p) => Math.log10(pr * pr - p.pwf * p.pwf)), Y = pts.map((p) => Math.log10(p.q));
  const m = pts.length, xb = X.reduce((a, b) => a + b) / m, yb = Y.reduce((a, b) => a + b) / m;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < m; i++) { sxx += (X[i] - xb) ** 2; sxy += (X[i] - xb) * (Y[i] - yb); }
  const n = sxy / sxx;
  return { n, C: 10 ** (yb - n * xb) };
}

function rows(app) {
  return app.findAll('#oi_res .rrow').map((r) => {
    const l = r.querySelector('.rl'), v = r.querySelector('.rv');
    return { l: String(l ? l.textContent : '').trim(), v: String(v ? v.textContent : '').trim() };
  });
}
function rv(app, label) {
  const r = rows(app).find((x) => x.l.indexOf(label) !== -1);
  if (!r) throw new Error('no result row "' + label + '": ' + JSON.stringify(rows(app)));
  const m = r.v.replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/i);
  if (!m) throw new Error('row "' + label + '" has no number: ' + r.v);
  return parseFloat(m[0]);
}
const resText = (app) => String(app.el('oi_res').textContent || '');
function noBadNumbers(assert, app, where) {
  assert.ok(!/NaN|Infinity|undefined/.test(String(app.el('pgBody').textContent || '')), where + ': page shows NaN/Infinity/undefined');
}
function set(app, vals) {
  for (const k of Object.keys(vals)) {
    const e = app.el(k);
    if (!e) throw new Error('no input #' + k);
    if (String(e.tagName).toUpperCase() === 'SELECT') app.select(k, String(vals[k])); else app.input(k, String(vals[k]));
  }
}
function clearPts(app) { for (let i = 1; i <= 4; i++) set(app, { ['oi_q' + i]: '', ['oi_pwf' + i]: '' }); }
function open(app) {
  const b = app.find('.nav-btn[data-p="oilipr"]');
  if (!b) throw new Error('no oilipr nav button (round 9 not built?)');
  app.click(b);
  if (!app.el('oi_root')) throw new Error('oilipr page did not render');
}
const S = (app) => app.win.WTS_state.oilipr;

module.exports = [
  {
    name: 'NEW2 oilipr compute: verification cases O1–O4 (Vogel, composite, PI, Standing FE, Fetkovich, future IPR)',
    wp: WP,
    run(app, assert) {
      const f = app.win.WTS_oilipr_compute;
      assert.strictEqual(typeof f, 'function', 'WTS_oilipr_compute');
      const P = (o) => app.toWin(o);
      // O1
      let r = f(P({ method: 'vogel', pr: 2400, pb: 2400, fe: 1, pwfDesign: 800, qTarget: 150, prFuture: 2000, points: [{ q: 100, pwf: 1800 }] }));
      assert.ok(r.ok, JSON.stringify(r.errors));
      assert.strictEqual(r.mode, 'vogel-sat');
      assert.rel(r.qmax, 100 / V(0.75), 1e-9, 'O1 qmax'); assert.rel(r.qmax, 250.0, 1e-3);
      assert.rel(r.qAtPwf, 250 * V(800 / 2400), 1e-9, 'O1 q@800'); assert.rel(r.qAtPwf, 211.1, 1e-3);
      assert.rel(r.table.find((t) => Math.abs(t.pwf - 1200) < 1e-9).q, 175.0, 1e-3, 'O1 q@1200');
      assert.rel(r.pwfAtQ, 1423.4, 1e-3, 'O1 pwf@150');
      assert.rel(r.future.qmax, 144.7, 1e-3, 'O1 qmax_f'); assert.rel(r.future.qAtPwf, 114.6, 1e-3, 'O1 qf@800');
      // O2a / O2b / O2c
      r = f(P({ method: 'vogel', pr: 4000, pb: 3000, pwfDesign: 2000, qTarget: 4000, points: [{ q: 1000, pwf: 3500 }] }));
      assert.strictEqual(r.mode, 'composite');
      assert.rel(r.J, 2.0, 1e-3); assert.rel(r.qb, 2000, 1e-3); assert.rel(r.qmax, 5333.3, 1e-3);
      assert.rel(r.qAtPwf, 3703.7, 1e-3); assert.rel(r.pwfAtQ, 1779.2, 1e-3);
      r = f(P({ method: 'vogel', pr: 4000, pb: 3000, points: [{ q: 3000, pwf: 2000 }] }));
      assert.rel(r.J, 3000 / (1000 + 3000 / 1.8 * V(2 / 3)), 1e-9, 'O2b J'); assert.rel(r.J, 1.620, 1e-3);
      assert.rel(r.qmax, 4320.0, 1e-3, 'O2b qmax');
      r = f(P({ method: 'pi', pr: 4000, pb: 3000, points: [{ q: 1000, pwf: 3500 }] }));
      assert.rel(r.qmax, 8000, 1e-9, 'O2c qmax');
      assert.ok(!r.warnings.some((w) => /bubble point/.test(w)), 'O2c no bubble-point verdict');
      r = f(P({ method: 'pi', pr: 4000, pb: 3000, points: [{ q: 3000, pwf: 2000 }] }));
      assert.ok(r.warnings.some((w) => /^⚠ Test pwf is below the bubble point/.test(w)), 'PI below pb verdict');
      // O3
      r = f(P({ method: 'vogel', pr: 2400, pb: 2400, fe: 0.7, pwfDesign: 1200, qTarget: 150, points: [{ q: 100, pwf: 1800 }] }));
      assert.rel(r.qmaxFE1, 344.2, 1e-3); assert.rel(r.qAtPwf, 183.1, 1e-3); assert.rel(r.qmax, 298.8, 1e-3); assert.rel(r.pwfAtQ, 1454.0, 1e-3);
      r = f(P({ method: 'vogel', pr: 2400, pb: 2400, fe: 1.3, pwfDesign: 1000, points: [{ q: 100, pwf: 1800 }] }));
      assert.rel(r.qmaxFE1, 199.8, 1e-3); assert.rel(r.pwfLimitFE, 553.8, 1e-3); assert.rel(r.qAtPwf, 180.8, 1e-3);
      assert.ok(r.table.filter((t) => t.heldAtMax).every((t) => t.pwf < 553.8 && t.q === r.qmaxFE1), 'held rows');
      // O4
      const pts = [{ q: 500, pwf: 1800 }, { q: 900, pwf: 1600 }, { q: 1200, pwf: 1400 }];
      const ref = fetkRef(2000, pts);
      r = f(P({ method: 'fetk', pr: 2000, pwfDesign: 1000, qTarget: 1000, prFuture: 1800, points: pts }));
      assert.strictEqual(r.mode, 'fetkovich');
      assert.near(r.n, ref.n, 1e-9); assert.near(r.n, 0.8907, 1e-4, 'O4 n');
      assert.rel(r.C, 2.9027e-3, 1e-3, 'O4 C'); assert.rel(r.r2, 0.9993, 1e-3);
      assert.rel(r.qmax, 2205.5, 1e-3); assert.rel(r.qAtPwf, 1707.0, 1e-3); assert.rel(r.pwfAtQ, 1534.3, 1e-3);
      assert.rel(r.future.C, 2.6124e-3, 1e-3); assert.rel(r.future.qmax, 1645.3, 1e-3);
      // one-point Fetkovich
      r = f(P({ method: 'fetk', pr: 2000, points: [{ q: 500, pwf: 1800 }] }));
      assert.strictEqual(r.n, 1); assert.ok(r.warnings.indexOf('⚠ One point — n assumed 1.0.') !== -1);
    },
  },
  {
    name: 'NEW2 oilipr page: registry nav, default O1 results, method switch to composite + Fetkovich via Calculate',
    wp: WP,
    run(app, assert) {
      const b = app.find('.nav-btn[data-p="oilipr"]');
      assert.ok(b, 'sidebar button');
      const grp = b.closest('.nav-group'), lab = grp && grp.querySelector('.nav-group-label');
      assert.strictEqual(String(lab ? lab.textContent : '').trim(), 'Production & Reservoir');
      open(app);
      assert.strictEqual(String(app.el('pgTitle').textContent).trim(), 'Oil Well IPR');
      assert.strictEqual(app.el('oi_res').getAttribute('data-done'), '1');
      assert.rel(rv(app, 'Maximum rate qmax'), 250, 1e-3, 'default qmax');
      assert.rel(rv(app, 'Rate at pwf'), 175.0, 1e-3, 'default q@1200');
      assert.rel(rv(app, 'pwf at q'), 1423.4, 1e-3, 'default pwf@150');
      assert.strictEqual(S(app).mode, 'vogel-sat');
      assert.ok(app.find('#oi_res canvas#oi_chart'), 'chart canvas');
      assert.ok(app.canvasLog('oi_chart').length > 10, 'chart drawn');
      assert.strictEqual(app.findAll('#oi_tbl tbody tr').length, 11, '11 table rows');
      noBadNumbers(assert, app, 'default');
      // O2a through the UI
      set(app, { oi_pr: 4000, oi_pb: 3000, oi_q1: 1000, oi_pwf1: 3500, oi_pwfd: 2000, oi_qt: 4000 });
      app.click('oi_go');
      assert.strictEqual(S(app).mode, 'composite');
      assert.rel(rv(app, 'Productivity index J'), 2.0, 1e-4);
      assert.rel(rv(app, 'Rate at bubble point'), 2000, 1e-3);
      assert.rel(rv(app, 'Maximum rate qmax'), 5333.3, 1e-3);
      assert.rel(rv(app, 'Rate at pwf'), 3703.7, 1e-3);
      assert.rel(rv(app, 'pwf at q'), 1779.2, 1e-3);
      assert.ok(resText(app).indexOf('Composite (PI above pb, Vogel below)') !== -1);
      // target rate above qmax → ✗ verdict and "—"
      set(app, { oi_qt: 6000 });
      assert.ok(/✗ Target rate exceeds the maximum rate 5,333\.3 BPD\./.test(resText(app)), 'qt verdict: ' + resText(app).slice(0, 400));
      assert.strictEqual(rows(app).find((x) => /^pwf at q/.test(x.l)).v, '—');
      // O4 through the UI
      clearPts(app);
      set(app, { oi_method: 'fetk', oi_pr: 2000, oi_q1: 500, oi_pwf1: 1800, oi_q2: 900, oi_pwf2: 1600, oi_q3: 1200, oi_pwf3: 1400, oi_pwfd: 1000, oi_qt: 1000, oi_prf: 1800 });
      app.click('oi_go');
      assert.strictEqual(S(app).mode, 'fetkovich');
      assert.near(rv(app, 'Fetkovich n'), 0.8907, 1e-4);
      assert.rel(rv(app, 'Fetkovich C'), 2.9027e-3, 1e-3);
      assert.near(rv(app, 'Fit R²'), 0.9993, 1e-4);
      assert.rel(S(app).qmaxFuture, 1645.3, 1e-3);
      assert.ok(resText(app).indexOf('Future IPR at p̄r = 1,800 psia') !== -1, 'future box');
      noBadNumbers(assert, app, 'fetk');
    },
  },
  {
    name: 'NEW2 oilipr validation: messages + input-err instead of NaN; FE > 1 verdict and held rows',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, { oi_pr: '' });
      const err = app.find('#oi_res .val-error');
      assert.ok(err && /Please fix the following/.test(err.textContent) && /Average reservoir pressure is required/.test(err.textContent), 'error block');
      assert.ok(app.el('oi_pr').classList.contains('input-err'), 'input-err on pr');
      assert.strictEqual(S(app).ok, false);
      noBadNumbers(assert, app, 'blank pr');
      set(app, { oi_pr: 2400, oi_pwf1: '' });
      assert.ok(/Test point 1: enter both/.test(resText(app)) && app.el('oi_pwf1').classList.contains('input-err'), 'partly filled row');
      assert.ok(!app.el('oi_pr').classList.contains('input-err'), 'input-err cleared');
      set(app, { oi_pwf1: 2500 });
      assert.ok(/below the average reservoir pressure/.test(resText(app)), 'pwf ≥ pr');
      set(app, { oi_pwf1: 1800, oi_fe: 2.5 });
      assert.ok(/FE must be between 0.3 and 2.0/.test(resText(app)), 'FE range');
      set(app, { oi_fe: 1.3, oi_pwfd: 1000 });
      assert.ok(/⚠ Standing's FE > 1 curve is valid down to pwf = 553\.8 psia/.test(resText(app)), 'FE > 1 verdict');
      assert.rel(rv(app, 'FE validity limit'), 553.8, 1e-3);
      assert.rel(rv(app, 'qmax at FE = 1'), 199.8, 1e-3);
      assert.rel(rv(app, 'Rate at pwf'), 180.8, 1e-3);
      const held = app.findAll('#oi_tbl tbody tr').filter((tr) => /\*/.test(tr.textContent));
      assert.strictEqual(held.length, 3, 'rows at 480, 240, 0 psia held');
      set(app, { oi_method: 'pi', oi_fe: 1, oi_prf: 2000 });
      assert.ok(/⚠ Future IPR is available for saturated Vogel and Fetkovich only\./.test(resText(app)));
      assert.ok(/⚠ Test pwf is below the bubble point/.test(resText(app)));
      noBadNumbers(assert, app, 'validation');
    },
  },
  {
    name: 'NEW2 oilipr metric: kPa labels, same canonical state as imperial, unit flip recalculates',
    wp: WP,
    run(app, assert) {
      open(app);
      const imp = JSON.parse(JSON.stringify(S(app)));   // untouched defaults (memo-exact in metric)
      const U = app.win.WTS_units;
      app.flush(10);
      U.setSystem('metric');
      try {
        app.hook.nav('home');
        open(app);
        const lab = app.el('oi_pr').closest('.fg-item').querySelector('label');
        assert.ok(/\(kPa\)/.test(lab.textContent), 'label: ' + lab.textContent);
        assert.ok(/\(m³\/d\)/.test(app.find('#oi_pts th[data-wts-unit-label="liquidRate"]').textContent), 'table header');
        const met = S(app);
        for (const k of ['qmax', 'qAtPwf', 'pwfAtQ']) assert.rel(met[k], imp[k], 1e-6, 'metric ' + k);
        assert.ok(/m³\/d/.test(resText(app)) && /kPa/.test(resText(app)), 'results in metric');
        // same physical case typed in metric: prf = 2000 psia = 13 789.5 kPa, pwfd = 800 psia = 5 515.8 kPa
        set(app, { oi_prf: 13789.514, oi_pwfd: 5515.806 });
        assert.rel(S(app).qmaxFuture, 144.676, 1e-4, 'future qmax from metric entry');
        assert.rel(S(app).qAtPwf, 211.1, 1e-3, 'q@800 psia from metric entry');
        noBadNumbers(assert, app, 'metric');
      } finally { U.setSystem('imperial'); }
      assert.rel(S(app).qmax, imp.qmax, 1e-6, 'after flip back');
      assert.ok(/BPD/.test(resText(app)), 'results back in field units');
    },
  },
  {
    name: 'NEW2 oilipr autosave/reload restore, PDF + Quick Report capture, no timers left',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, { oi_q1: 120 });
      const q = S(app).qmax;
      assert.rel(q, 120 / V(0.75), 1e-9);
      app.flush(1200);
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const s = JSON.stringify(model);
      assert.ok(model.inputs.length > 0 && model.results.length > 0, 'report sections');
      assert.ok(s.indexOf('Maximum rate qmax (AOF)') !== -1 && s.indexOf('IPR method') !== -1, 'report content');
      const n0 = app.opened.length;
      app.win.exportPagePDF();
      const pdf = app.opened[n0] && app.opened[n0].html();
      assert.ok(pdf && pdf.indexOf('Oil Well IPR') !== -1 && pdf.indexOf('Maximum rate qmax') !== -1, 'PDF');
      const n1 = app.opened.length;
      app.win.WTS_exportJobReport();
      const job = app.opened[n1] && app.opened[n1].html();
      assert.ok(job && job.indexOf('Oil Well IPR') !== -1, 'Quick Report');
      const app2 = app.reload();
      try {
        open(app2);
        assert.strictEqual(app2.el('oi_q1').value, '120', 'restored');
        assert.rel(app2.win.WTS_state.oilipr.qmax, q, 1e-12, 'recalculated on restore');
        app2.flushUntilIdle(10000);
        assert.strictEqual(app2.pendingTimers(), 0, 'no timers left');
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'NEW2 oilipr at 375 px: renders with results and wrapped tables',
    wp: WP,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      open(app);
      assert.ok(app.find('#oi_res .rrow'), 'results');
      for (const t of app.findAll('#oi_root table')) {
        assert.ok(/overflow-x:\s*auto/.test(t.parentNode.getAttribute('style') || ''), 'table ' + t.id + ' wrapped');
      }
    },
  },
];
