// Well Performance B, WP27 — the page part of the studies (49-calc-wp-studies.js through the page's extension hooks).
// docs/WELL-PERFORMANCE-PLAN.md §1.3 US18, §2.9 (report capture), §6, §7.4, §8, §10 and the owner GUI requirement.
//
// WST1 the Studies card in #wp_res (always visible, captured by the report), its five tabs, the controls .rp-skip; the extension
//      hooks do not change the A2 page (no study → no study rows); lift screening card in step ④ with the live matrix
// WST2 operating envelope on the Oil example: the window band, constraint lines, the operating point, the drag handle along the
//      curve (live read-out with each limit, release → Bean for this rate → Use this bean through the normal input path); study row
// WST3 forecast: p̄r steps (slider → the IPR and the operating point of the step on the system plot), the Gas example tank: loading
//      onset with MD · TVD in the KPI, on the schematic (tick) and in the studies row, lift needed, provisional chip, time line handle
// WST4 tornado (bars, select → Use low / high) and the 3-variable matrix (heat map, slice slider, cell → Use these values)
// WST5 cases: save, list, compare two (overlay, Δ %), load restores the inputs, delete; persisted in wts_wellperf_model (per well);
//      CSV sections; the Quick Report snapshot stays within 60 kB with the studies; no NaN / undefined text; no console errors
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP27';
const app = (ctx) => S.sharedApp(ctx);
const txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
const BAD = /NaN|undefined|Infinity|\[object Object\]/;
async function wait(A, cond, n) { for (let i = 0; i < (n || 200) && !cond(); i++) await A.flushAsync(1); return cond(); }
function open(A, ex) {
  const G = A.win;
  S.resetWellPerf(A); G.WTS_wellperf_page.resetJobs();
  A.hook.nav('wellperf'); A.flush(30);
  A.click(A.find('[data-act="example"][data-ex="' + (ex || 'oil') + '"]')); A.flush(30);
}
function tab(A, k) { A.click(A.find('#wpb_tabs [data-k="' + k + '"]')); A.flush(5); }
const ST = (G) => G.WTS_wellperf_ext.studies.state();

module.exports = [
  {
    name: 'WST1 Studies card in #wp_res with five tabs, controls rp-skip, no study → no rows; lift screening matrix live in step ④',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const A = app(ctx), G = A.win;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      open(A, 'oil');
      const card = A.el('wpb_card');
      assert.ok(card && A.el('wp_res').contains(card), 'Studies card inside #wp_res');
      assert.deepStrictEqual(A.findAll('#wpb_tabs [data-act="b27tab"]').map((b) => b.getAttribute('data-k')), ['env', 'fcst', 'torn', 'mat', 'cases']);
      assert.ok(A.findAll('#wpb_card .wpb-ctl').every((e) => /rp-skip/.test(e.className)), 'controls are rp-skip');
      assert.ok(!/Operating envelope|Depletion forecast|Tornado/.test(txt(A.el('wp_studies'))), 'no study rows before a run');
      tab(A, 'fcst');
      assert.ok(!/wp-off/.test(A.find('[data-stab="fcst"]').className) && /wp-off/.test(A.find('[data-stab="env"]').className), 'one control block per tab');
      assert.ok(A.el('wpv_fc_steps').value.split(' ').length === 6, 'steps suggested from the model p̄r: ' + A.el('wpv_fc_steps').value);
      tab(A, 'env');
      G.WTS_wellperf_page.goStep(4); A.flush(5);
      const sc = A.el('wpb_scres');
      assert.ok(sc && A.findAll('#wpb_scres table.wpb-sc tbody tr').length === 7, 'seven methods screened');
      assert.match(txt(sc), /ESP setting window|Setting window/);
      assert.match(txt(sc), /provisional/);
      assert.ok(A.findAll('#wpb_scres .wp-qcb').length >= 40, 'criterion chips');
      assert.ok(!BAD.test(txt(sc)), 'clean: ' + txt(sc).slice(0, 200));
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
    },
  },
  {
    name: 'WST2 operating envelope: window band, limits, operating point, drag read-out, bean design and Use, studies row',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      open(A, 'oil');
      tab(A, 'env');
      A.change('wpv_env_dd', '800'); A.flush(2);
      A.click(A.find('[data-act="b27env"]'));
      assert.ok(await wait(A, () => ST(G).env), 'envelope result');
      const e = ST(G).env;
      assert.ok(e.ok && e.window.ok && e.op && e.op.inside, JSON.stringify(e.errors));
      const cv = A.el('wp_cv_st'), sp = cv._wp.spec;
      assert.ok(sp.series.some((s) => s.kind === 'poly'), 'window band');
      assert.ok(sp.vlines.some((v) => /drawdown/.test(v.label)), 'drawdown limit line');
      assert.ok(sp.markers.some((m) => m.label === 'operating point') && sp.markers.some((m) => m.label === 'max rate'), 'markers');
      assert.ok(sp.handles.length === 1 && sp.handles[0].kind === 'pointX', 'drag handle');
      assert.match(txt(A.el('wpb_kpi')), /Operating window/);
      // drag: the handle follows the curve, the read-out updates
      const h = sp.handles[0], q2 = e.window.qLo + 0.25 * (e.window.qHi - e.window.qLo);
      sp.onHandle('env', q2, 'move');
      assert.ok(Math.abs(h.y - G.WTS_wp_envelope.at(e, q2).thp) < 1e-6, 'handle on the curve');
      assert.match(txt(A.el('wpb_read')), /Choke Δp/);
      sp.onHandle('env', q2, 'end');
      const bb = A.find('#wpb_read [data-act="b27envbean"]');
      assert.ok(bb, 'Bean for this rate');
      A.click(bb);
      assert.ok(await wait(A, () => ST(G).envBean), 'bean design');
      const use = A.find('#wpb_read [data-act="adopt"][data-id="wp_bean"]');
      assert.ok(use && ST(G).envBean.ok, 'Use this bean: ' + JSON.stringify(ST(G).envBean.errors || null));
      const b0 = +A.el('wp_bean').value;
      A.click(use); A.flush(30);
      assert.ok(+A.el('wp_bean').value === Math.round(ST(G).envBean.bean) && +A.el('wp_bean').value < b0, 'bean adopted: ' + b0 + ' → ' + A.el('wp_bean').value);
      assert.ok(G.WTS_state.wellperf.op.q < e.op.q, 'smaller bean, lower rate');
      assert.match(txt(A.el('wp_studies')), /Operating envelope \(previous inputs\)window/);
      assert.ok(!BAD.test(txt(A.el('wpb_card'))), 'clean');
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
    },
  },
  {
    name: 'WST3 forecast: steps slider → system-plot overlay; gas tank → loading onset MD · TVD (KPI, schematic, studies), lift needed, provisional',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      open(A, 'oil');
      tab(A, 'fcst');
      A.change('wpv_fc_steps', '3000 2800 2600'); A.flush(2);
      A.click(A.find('[data-act="b27fc"]'));
      assert.ok(await wait(A, () => ST(G).fc), 'steps forecast');
      const f = ST(G).fc;
      assert.ok(f.ok && f.mode === 'steps' && f.rows.length === 3 && f.rows[0].ok, JSON.stringify(f.errors));
      assert.ok(f.rows[0].q === G.WTS_state.wellperf.op.q, 'the first step = the page solve exactly');
      const sl = A.el('wpv_fc_t');
      assert.ok(!/wp-off/.test(A.el('wpb_tslider').className) && sl.max === '2', 'time slider');
      sl.value = '1'; A.fire(sl, 'input'); A.flush(2);
      const sys = A.el('wp_cv_sys')._wp.spec;
      assert.ok(sys.series.some((s) => s.key === 'fcipr') && sys.markers.some((m) => /forecast/.test(m.label)), 'IPR and operating point of the step on the system plot');
      assert.match(txt(A.el('wpb_read')), /2 of 3/);
      // the gas example: tank
      open(A, 'gas');
      tab(A, 'fcst');
      A.select('wpv_fc_mode', 'tank'); A.flush(2);
      A.change('wpv_fc_G', '20'); A.change('wpv_fc_years', '10'); A.change('wpv_fc_n', '12'); A.flush(2);
      ST(G).fc = null;
      A.click(A.find('[data-act="b27fc"]'));
      assert.ok(await wait(A, () => ST(G).fc, 400), 'tank forecast');
      const g = ST(G).fc;
      assert.ok(g.ok && g.mode === 'tank' && g.kind === 'gas' && g.provisional, JSON.stringify(g.errors));
      assert.ok(g.events.loading && isFinite(g.events.loading.md) && isFinite(g.events.loading.tvd), 'loading onset with MD and TVD');
      const kp = txt(A.el('wpb_kpi'));
      assert.match(kp, /Liquid loading/); assert.match(kp, /MD · .* TVD/); assert.match(kp, /provisional/);
      assert.ok(A.el('wp_sch').innerHTML.indexOf('loading onset') !== -1, 'onset tick on the schematic');
      assert.match(txt(A.el('wp_studies')), /Depletion forecastgas tank G 20 Bscf.*loading from year .* MD · .* TVD/);
      const sp = A.el('wp_cv_st')._wp.spec;
      assert.ok(sp.handles.length === 1 && sp.handles[0].kind === 'lineX', 'time line handle');
      sp.onHandle('fct', g.rows[g.rows.length - 1].t_d / 365.25, 'end'); A.flush(2);
      assert.strictEqual(ST(G).fcI, g.rows.length - 1, 'cursor snapped to the last step');
      A.click(A.find('#wpb_body [data-act="b27fcview"][data-k="mb"]')); A.flush(2);
      assert.ok(/p\/Z/.test(A.el('wp_cv_st')._wp.spec.y.label), 'material-balance view');
      assert.ok(!BAD.test(txt(A.el('wpb_card'))), 'clean: ' + txt(A.el('wpb_card')).slice(0, 300));
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
    },
  },
  {
    name: 'WST4 tornado bars (select → Use low / high) and the 3-variable matrix (heat map, slice slider, cell → Use these values)',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      open(A, 'oil');
      tab(A, 'torn');
      A.click(A.find('[data-act="b27torn"]'));
      assert.ok(await wait(A, () => ST(G).torn, 300), 'tornado');
      const t = ST(G).torn;
      assert.ok(t.ok && t.bars.length >= 5 && t.q0 === G.WTS_state.wellperf.op.q, 'base = the page solve');
      assert.strictEqual(A.findAll('#wpb_body table.wpb-torn tbody tr').length, t.bars.length);
      const first = A.find('#wpb_body button.wpb-row');
      A.click(first); A.flush(2);
      const lo = A.findAll('#wpb_body [data-act="adopt"]');
      assert.ok(lo.length === 2 && /Use low/.test(txt(lo[0])), 'Use low / Use high');
      assert.match(txt(A.el('wpb_kpi')), /Base rate/);
      tab(A, 'mat');
      A.select('wpv_mx1', 'wc'); A.select('wpv_mx2', 'pr'); A.select('wpv_mx3', 'bean'); A.flush(2);
      A.change('wpv_mxv1', '20 30 40'); A.change('wpv_mxv2', '2800 3000'); A.change('wpv_mxv3', '24 32'); A.select('wpv_mx4', ''); A.flush(2);
      assert.match(txt(A.el('wpb_mxn')), /3 variables · 12 cases/);
      A.click(A.find('[data-act="b27mat"]'));
      assert.ok(await wait(A, () => ST(G).mat, 300), 'matrix');
      const m = ST(G).mat;
      assert.ok(m.ok && m.nd && m.cases.length === 12, JSON.stringify(m.errors));
      assert.strictEqual(A.findAll('#wpb_body .wpb-heat td.wp-hc').length, 6, '3 × 2 cells at the slice');
      const s2 = A.el('wpv_mxs2'); s2.value = '0'; A.fire(s2, 'input'); A.flush(2);
      assert.strictEqual(ST(G).matSlice[2], 0, 'slice moved');
      const cell = A.findAll('#wpb_body [data-act="b27mxcell"]')[1];
      A.click(cell); A.flush(2);
      const use = A.find('#wpb_body [data-act="adopt"][data-ids]');
      assert.ok(use && /wp_wc/.test(use.getAttribute('data-ids')) && /wp_bean/.test(use.getAttribute('data-ids')), 'Use these values');
      assert.ok(A.el('wp_cv_st')._wp.spec.series.filter((s) => s.legend !== false).length === 2, 'a rate line per row value');
      assert.match(txt(A.el('wp_studies')), /Sensitivity matrix.*12 cases/);
      assert.ok(!BAD.test(txt(A.el('wpb_card'))), 'clean');
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
    },
  },
  {
    name: 'WST5 cases: save, compare (overlay, Δ %), load restores, delete; per well in the model; CSV; snapshot ≤ 60 kB; clean',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      open(A, 'oil');
      tab(A, 'cases');
      A.change('wpv_case_name', 'Base'); A.select('wpv_case_kind', 'base'); A.flush(2);
      A.click(A.find('[data-act="b27save"]')); A.flush(5);
      const q0 = G.WTS_state.wellperf.op.q;
      A.change('wp_bean', '40'); A.flush(30);
      const q1 = G.WTS_state.wellperf.op.q;
      A.change('wpv_case_name', 'Bean 40'); A.select('wpv_case_kind', 'proposed'); A.flush(2);
      A.click(A.find('[data-act="b27save"]')); A.flush(5);
      const rec = JSON.parse(A.storage.getItem('wts_wellperf_model'));
      assert.ok(rec.cases.length === 2 && rec.cases[0].name === 'Base' && rec.cases[1].kind === 'proposed', 'two cases in the model record');
      assert.ok(Math.abs(rec.cases[0].summary.q - q0) < 1e-9 && Math.abs(rec.cases[1].summary.q - q1) < 1e-9, 'summaries');
      assert.strictEqual(A.findAll('#wpb_cases .wpb-case').length, 2);
      A.click(A.find('[data-act="b27compare"]'));
      assert.ok(await wait(A, () => ST(G).cmp, 300), 'comparison');
      const c = ST(G).cmp;
      assert.ok(c.ok && c.rows.length === 2 && Math.abs(c.rows[0].R.q - q0) / q0 < 1e-9 && c.rows[1].dqPct > 0, 'Δ % of the bigger bean');
      assert.ok(c.rows[1].diff.scalars.some((d) => d.id === 'wp_bean'), 'the bean differs');
      assert.ok(A.el('wp_cv_st')._wp.spec.series.length === 4, 'inflow + outflow per case');
      assert.match(txt(A.el('wp_studies')), /Cases comparedBase .*Bean 40 .*\+/);
      // load the base case back
      A.click(A.find('#wpb_cases [data-act="b27load"][data-id="' + rec.cases[0].id + '"]')); A.flush(40);
      assert.strictEqual(+A.el('wp_bean').value, 32, 'bean restored');
      assert.ok(Math.abs(G.WTS_state.wellperf.op.q - q0) / q0 < 1e-9, 'the base rate again');
      const csv = G.WTS_wellperf_page.csv();
      assert.ok(/cases compared/.test(csv), 'CSV section');
      // the report captures the Studies card (the active tab, its KPIs and table) and the studies rows; the Quick Report snapshot
      // stays within 60 kB with the studies
      const rep = JSON.stringify(G.collectPageReport(A.el('pgBody'), { charts: false }));
      assert.ok(rep.indexOf('Studies — envelope') !== -1 && rep.indexOf('Cases compared') !== -1, 'report capture');
      A.change('wp_psep', '110'); A.flush(1200);
      const snaps = JSON.parse(A.storage.getItem('wts_report_snapshots') || '{}'), n = snaps.wellperf ? JSON.stringify(snaps.wellperf).length : 0;
      assert.ok(snaps.wellperf && n <= 60 * 1024, 'snapshot ' + n + ' bytes ≤ 60 kB');
      A.click(A.find('#wpb_cases [data-act="b27del"][data-id="' + rec.cases[1].id + '"]')); A.flush(5);
      assert.strictEqual(JSON.parse(A.storage.getItem('wts_wellperf_model')).cases.length, 1, 'deleted');
      assert.ok(!BAD.test(txt(A.el('wp_root'))), 'page clean');
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
    },
  },
];
