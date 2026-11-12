// Well Performance B, WP28 — batch over the wells of a project (WTS_wp_batch, the "All wells" card) and the schematic additions of B
// (layers, the correlation per section, ESP and gas-lift mandrels, kick-off point and horizontal sections).
// docs/WELL-PERFORMANCE-PLAN.md §18.3 (WP28), §1.4 K1 / K2 / L3, §2.9, §3.10, §16; record §18.3.1.
//   WW1 sources: single-well project, live + parked wells, injected wells · WW2 read only: storage byte-identical, no event, no switch,
//   no page calc · WW3 each row = the single solve of that well (open and parked) · WW4 rows without inputs / without a solution,
//   counts and totals · WW5 the Job: progress, labels, cancel within one well, a subset of wells · WW6 deviation per well (MD · TVD,
//   inclination, horizontal length) · WW7 table and CSV · WW8 page: call to action, Run → card in #wp_res (KPIs, map, table), report
//   capture, WTS_state.wellperf.wells, three map views, selection by click and keyboard, Open this well, stale chip · WW9 schematic
//   view: layers, sections, ESP, mandrels, KOP and horizontal brackets, devInfo; a vertical well has no deviation marks · WW10 page
//   schematic: deviation caption, "Correlation" colouring, R.lift marks contract.
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP28';
const BAD = /NaN|undefined|Infinity|\[object Object\]/;
const txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
const runJob = (job) => { let s, n = 0; const prog = []; do { s = job.step(); prog.push(s.progress); n++; } while (!s.done && n < 500); return { r: job.result(), prog }; };
const P = (A) => A.win.WTS_wellperf_page;
const keysOf = (st) => { const o = {}; for (let i = 0; i < st.length; i++) { const k = st.key(i); o[k] = st.getItem(k); } return o; };
const scalarsOf = (M) => ({ wts_page_wellperf: JSON.stringify({ f: {} }), wts_wellperf_model: JSON.stringify({ v: 1, survey: M.well.survey, strings: M.well.strings, geo: M.well.geo, flowline: M.surface.flowline }) });

function page(ctx, ex) {
  const A = S.sharedApp(ctx);
  S.resetWellPerf(A); P(A).resetJobs(); P(A).budget(1e6);
  A.hook.nav('wellperf'); A.flush(30);
  if (ex) { A.click(A.find('[data-act="example"][data-ex="' + ex + '"]')); A.flush(30); }
  return A;
}
// a project of wells built through WTS_wells (the gas example in well 1, the oil example in a second well, an empty third well)
function project(A, o) {
  o = o || {};
  const W = A.win.WTS_wells, made = [];
  const first = (W.list().filter((w) => w.active)[0] || {}).id;
  A.click(A.find('[data-act="example"][data-ex="gas"]')); A.flush(30);
  const c1 = W.create('Oil producer'); A.flush(60); made.push(c1.id);
  A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(60);
  if (o.empty !== false) { const c2 = W.create('New well'); A.flush(60); made.push(c2.id); W.switchTo(c1.id); A.flush(60); }
  return { first, made, cleanup() { W.switchTo(first); A.flush(60); made.forEach((id) => { W.remove(id); A.flush(60); }); } };
}
async function runCard(A) {
  const G = A.win;
  A.click(A.find('#wp_wells [data-act="wellsrun"]'));
  for (let i = 0; i < 80 && !(G.WTS_state.wellperf && G.WTS_state.wellperf.wells); i++) await A.flushAsync(1);
  return G.WTS_state.wellperf.wells;
}

module.exports = [
  {
    name: 'WW1 sources: a single-well project is one live well; a project lists its wells (open = live storage, parked = its blob); injected wells for tests',
    wp: WP,
    run(_a, assert, ctx) {
      const A = page(ctx, 'oil'), B = A.win.WTS_wp_batch;
      A.flush(1500);   // the page autosave
      assert.ok(B && typeof B.job === 'function' && B.VERSION === '1.0.0', 'WTS_wp_batch present');
      let s = B.sources();
      assert.strictEqual(s.wells.length, 1, 'one well'); assert.ok(s.wells[0].active, 'the open well');
      assert.ok(s.wells[0].get('wts_page_wellperf') != null, 'the open well reads the live storage');
      const pj = project(A, { empty: false });
      try {
        s = B.sources();
        assert.strictEqual(s.wells.length, 2, 'two wells');
        const open = s.wells.filter((w) => w.active), parked = s.wells.filter((w) => !w.active);
        assert.ok(open.length === 1 && open[0].name === 'Oil producer' && open[0].origin === 'live', 'open well live');
        assert.ok(parked.length === 1 && parked[0].origin === 'parked' && /condensate/.test(parked[0].get('wts_page_wellperf')), 'parked well from its blob (the gas example)');
        const inj = B.sources({ wells: [{ id: 'a', name: 'A', active: true, keys: { k: '1' } }, { id: 'b', name: 'B', keys: {} }] });
        assert.ok(inj.wells.length === 2 && inj.wells[0].get('k') === '1' && inj.wells[1].get('k') === null, 'injected wells');
      } finally { pj.cleanup(); }
    },
  },
  {
    name: 'WW2 read only: a run over three wells leaves the storage byte-identical, fires no wts:* event, switches no well and runs no page calc',
    wp: WP,
    run(_a, assert, ctx) {
      const A = page(ctx, 'oil'), G = A.win, B = G.WTS_wp_batch, pj = project(A);
      try {
        A.flush(1500);
        const before = keysOf(A.storage), act = G.WTS_wells.active(), calcs = P(A).calcs(), ev = [];
        ['wts:wellperf-model-changed', 'wts:wellperf-solved', 'wts:well-changed', 'wts:project-loaded'].forEach((n) => G.document.addEventListener(n, () => ev.push(n)));
        const { r } = runJob(B.job());
        A.flush(1500);
        assert.strictEqual(r.rows.length, 3, 'three rows');
        assert.deepStrictEqual(keysOf(A.storage), before, 'storage unchanged');
        assert.strictEqual(G.WTS_wells.active(), act, 'no switch');
        assert.strictEqual(P(A).calcs(), calcs, 'no page calc');
        assert.strictEqual(ev.length, 0, 'no event: ' + ev.join(','));
        // the read of a parked well cannot write: its storage object refuses
        const src = B.sources().wells.filter((w) => !w.active)[0], rd = B.readWell(src);
        assert.ok(rd.ok && Object.isFrozen(rd.M), 'frozen model');
      } finally { pj.cleanup(); }
    },
  },
  {
    name: 'WW3 each row equals the single solve of that well: the open well with the live controls, a parked well from its stored inputs (identical q and p_wf)',
    wp: WP,
    run(_a, assert, ctx) {
      const A = page(ctx, 'oil'), G = A.win, B = G.WTS_wp_batch, pj = project(A, { empty: false });
      try {
        const live = P(A).ui.liveScalars(), { r } = runJob(B.job({ liveScalars: live }));
        const open = r.rows.find((x) => x.active), parked = r.rows.find((x) => !x.active);
        const st = G.WTS_state.wellperf;
        assert.ok(st.ok && open.status === 'ok', 'open well solved');
        assert.strictEqual(open.q, st.op.q, 'open well q = the page solve');
        assert.strictEqual(open.key, B.key(P(A).state().M), 'row key = the page model key');
        const M = G.WTS_wp_model.read({ storage: { getItem: (k) => B.sources().wells.find((w) => !w.active).get(k) } });
        const R = G.WTS_wp_system.solve(M);
        assert.ok(R.ok && parked.q === R.op.q && parked.pwf === (Number.isFinite(R.pwf) ? R.pwf : R.op.p), 'parked well = its own solve');
        // and the page agrees after opening that well
        G.WTS_wells.switchTo(parked.id); A.flush(60);
        assert.ok(Math.abs(G.WTS_state.wellperf.op.q - parked.q) <= 1e-9 * parked.q, 'page solve of the parked well after the switch: ' + G.WTS_state.wellperf.op.q + ' vs ' + parked.q);
        assert.ok(parked.gas && parked.fluid === 'condensate' && open.fluid === 'oil', 'fluids');
      } finally { pj.cleanup(); }
    },
  },
  {
    name: 'WW4 a well without inputs is listed as such; a well with no operating point is a failure; counts and totals add the stable wells only',
    wp: WP,
    run(_a, assert, ctx) {
      const A = page(ctx, 'oil'), G = A.win, B = G.WTS_wp_batch;
      const ok = S.FIX.oilWell, dead = S.FIX.oilWell; dead.res.pr = 900;   // 900 psia cannot lift the column to the separator
      const wells = [
        { id: 'a', name: 'A', active: true, keys: {} },
        { id: 'b', name: 'B', keys: Object.assign(scalarsOf(ok), { wts_page_wellperf: JSON.stringify({ f: { wp_ftype: 'oil', wp_api: '35', wp_gor: '500', wp_wc: '30', wp_ipr: 'pi', wp_pr: '3000', wp_tres: '200', wp_ip_J: '2', wp_bean: '32', wp_psep: '100', wp_tht: '120', wp_perfTop: '7980', wp_perfBot: '8020', wp_midPerf: '8000' } }) }) },
        { id: 'c', name: 'C', keys: Object.assign(scalarsOf(dead), { wts_page_wellperf: JSON.stringify({ f: { wp_ftype: 'oil', wp_api: '35', wp_gor: '500', wp_wc: '30', wp_ipr: 'pi', wp_pr: '900', wp_tres: '200', wp_ip_J: '2', wp_bean: '32', wp_psep: '100', wp_tht: '120', wp_perfTop: '7980', wp_perfBot: '8020', wp_midPerf: '8000' } }) }) },
      ];
      const { r } = runJob(B.job({ wells }));
      const [a, b, c] = r.rows;
      assert.ok(a.status === 'none' && a.verdict === 'none' && a.code === 'NO_INPUTS', 'A: no inputs');
      assert.ok(b.status === 'ok' && b.stable && b.verdict === 'ok', 'B: solved, stable: ' + b.verdict + ' ' + (b.flags || []).join(','));
      assert.ok(c.status === 'fail' && c.verdict === 'fail' && c.error, 'C: no solution (' + c.code + ')');
      assert.strictEqual(JSON.stringify(r.counts), JSON.stringify({ n: 3, solved: 1, stable: 1, unstable: 0, failed: 1, none: 1, warn: 0 }));
      assert.ok(r.ok && r.totals.nOil === 1 && r.totals.qo === b.qo && r.totals.qw === b.qw, 'totals = the stable well');
      assert.ok(Math.abs(b.q - G.WTS_wp_system.solve(G.WTS_wp_model.read({ storage: { getItem: (k) => wells[1].keys[k] || null } })).op.q) < 1e-9, 'B q = its solve');
      const none = runJob(B.job({ wells: [wells[0]] })).r;
      assert.ok(!none.ok && none.code === 'NO_SOLUTION' && none.rows.length === 1, 'nothing solvable');
    },
  },
  {
    name: 'WW5 the Job: one well per step with a label, monotone progress, cancel within one well keeps the partial rows, ids pick a subset',
    wp: WP,
    run(_a, assert, ctx) {
      const A = page(ctx, 'oil'), G = A.win, B = G.WTS_wp_batch, pj = project(A);
      try {
        const S0 = S.checkShape('Job', B.job());
        assert.ok(S0.ok, S0.errors.join('; '));
        const { r, prog } = runJob(B.job());
        assert.ok(prog.every((p, i) => i === 0 || p >= prog[i - 1]) && prog[prog.length - 1] === 1 && prog.length === 3, 'progress ' + prog.join(','));
        const j = B.job(), s1 = j.step();
        assert.ok(!s1.done && /\(2 of 3\)/.test(s1.label), 'label names the next well: ' + s1.label);
        j.cancel();
        const rc = j.result();
        assert.ok(rc.cancelled && !rc.ok && rc.rows.length === 1 && rc.code === 'CANCELLED', 'cancel keeps the finished well');
        const ids = r.rows.filter((x) => x.status === 'ok').map((x) => x.id);
        const sub = runJob(B.job({ ids: [ids[0]] })).r;
        assert.ok(sub.rows.length === 1 && sub.rows[0].id === ids[0], 'subset');
        const t = r.evals; assert.ok(t > 0 && t <= 2 * 20 + 1e-9, 'evaluations within two solves (' + t + ' E)');
      } finally { pj.cleanup(); }
    },
  },
  {
    name: 'WW6 deviation per well: mid-perforation MD and TVD, maximum inclination, departure, horizontal length (≥ 80°) and the trajectory for the well-path map',
    wp: WP,
    run(_a, assert, ctx) {
      const A = page(ctx, 'oil'), G = A.win, B = G.WTS_wp_batch;
      const gas = S.FIX.gasWell, Wg = G.WTS_wp_well.build(gas.well, { res: gas.res }), Rg = G.WTS_wp_system.solve(gas);
      const rg = B.summarise(gas, Rg, Wg);
      assert.ok(rg.status === 'ok' && rg.gas, 'gas well solved');
      assert.ok(Math.abs(rg.well.incMax - 30) < 0.5 && rg.well.hzMd === 0, 'S-shaped: 30° max, no horizontal');
      assert.ok(rg.well.midMd === 9950 && rg.well.midTvd < rg.well.midMd - 300, 'mid-perf TVD < MD: ' + rg.well.midTvd);
      assert.ok(rg.well.traj.length >= 10 && rg.well.traj.length <= 60 && rg.well.traj.every((p) => p.length === 3), 'trajectory [vs, tvd, md]');
      const hz = S.FIX.oilWell, dv = S.FIX.devSurvey;
      hz.well.survey = dv.rows; const last = dv.rows[dv.rows.length - 1][0];
      hz.well.strings = [{ kind: 'tubing', tubKey: null, rough: 0.0006, topMd: 0, botMd: last - 600, id: 2.441, od: 2.875 }, { kind: 'casing', tubKey: null, rough: 0.0006, topMd: last - 600, botMd: last + 50, id: 6.276, od: 7 }];
      Object.assign(hz.well, { perfTopMd: last - 400, perfBotMd: last, midPerfMd: last - 200 });
      const Wh = G.WTS_wp_well.build(hz.well, { res: hz.res }), rh = B.summarise(hz, null, Wh);
      assert.ok(Math.abs(rh.well.incMax - 90) < 0.5, 'horizontal: 90°');
      // the 500 ft hold + the last 10° of the 3°/100 ft build (333 ft) ≈ 833 ft, counted on the trajectory points (≤ one point spacing)
      assert.ok(rh.well.hzMd >= 800 && rh.well.hzMd <= 900, 'horizontal length ≈ 833 ft: ' + rh.well.hzMd);
      assert.ok(rh.status === 'fail' && rh.verdict === 'fail', 'no solve → fail row');
    },
  },
  {
    name: 'WW7 table (20 columns, field units) and CSV (header + one line per well, quoted names)',
    wp: WP,
    run(_a, assert, ctx) {
      const A = page(ctx, 'oil'), B = A.win.WTS_wp_batch;
      const res = { rows: [{ id: 'x', name: 'Well, "A"', fluid: 'oil', status: 'ok', verdict: 'ok', q: 914.1, qo: 640, qw: 274, qg: 320, pwf: 2543, thp: 320, tht: 120, bean: 32, stable: true, marginQs: 1.87, loadingMargin: null, corr: 'bb', provisional: false, flags: [], well: { midMd: 8000, midTvd: 8000, incMax: 0, hzMd: 0 } },
        { id: 'y', name: 'B', status: 'none', verdict: 'none', flags: [], well: {} }] };
      const T = B.table(res);
      assert.strictEqual(T.head.length, 20); assert.ok(T.rows.every((r) => r.length === 20), 'rows of 20');
      const csv = B.csv(res).trim().split('\n');
      assert.strictEqual(csv.length, 3, 'header + 2');
      assert.ok(csv[1].indexOf('"Well, ""A"""') === 0 && /,914\.1,/.test(csv[1]) && /no inputs/.test(csv[2]), csv.join(' | '));
    },
  },
  {
    name: 'WW8 page: call to action with several wells; Run → the All-wells card in #wp_res (KPIs, map, table) captured by the report; state; three views; selection; Open this well; stale chip',
    wp: WP,
    async run(_a, assert, ctx) {
      const A = page(ctx, 'oil'), G = A.win;
      assert.strictEqual(txt(A.el('wp_wells')), '', 'one well: no call to action');
      const pj = project(A, { empty: false });
      try {
        assert.match(txt(A.el('wp_wells')), /This project has 2 wells/);
        const sum = await runCard(A);
        assert.ok(sum && sum.counts.solved === 2 && sum.rows.length === 2, 'WTS_state.wellperf.wells');
        const card = A.el('wp_wells');
        assert.ok(/\bcard\b/.test(card.className) && card.closest('#wp_res'), 'card in the compact block');
        const k = A.findAll('#wp_wells .kpi');
        assert.ok(k.length >= 5 && /2 \/ 2/.test(txt(k[0])) && /st-(ok|warn)/.test(k[0].className), 'KPI chips: ' + k.map(txt).join(' | '));
        assert.strictEqual(A.findAll('#wp_wells tr.wp-wrow').length, 2, 'table rows');
        assert.match(txt(A.find('#wp_wells table')), /9,950 ft MD · 9,\d{3} ft TVD/, 'MD · TVD per well');
        assert.ok(!BAD.test(txt(card)), 'clean: ' + (txt(card).match(BAD) || [''])[0]);
        const cv = A.el('wp_cv_wells');
        assert.ok(cv && cv._wp && cv._wp.spec.key === 'wells-norm' && cv._wp.spec.markers.length === 2 && cv._wp.spec.readout === 'near', 'normalised map');
        const m = G.collectPageReport(A.el('pgBody'), { charts: false }), flat = JSON.stringify(m);
        ['All wells — operating points', 'Wells solved', 'Oil producer'].forEach((t) => assert.includes(flat, t));
        ['Run again', 'Open this well', 'Hover for each well'].forEach((t) => assert.ok(flat.indexOf(t) === -1, t + ' not captured'));
        A.click(A.find('#wp_wells [data-act="wellsview"][data-v="paths"]')); A.flush(5);
        let sp = A.el('wp_cv_wells')._wp.spec;
        assert.ok(sp.key === 'wells-paths' && sp.y.invert && sp.series.length === 2 && /MD · .* TVD/.test(sp.series[0].info[3][1]), 'well paths with MD · TVD read-out');
        A.click(A.find('#wp_wells [data-act="wellsview"][data-v="abs"]')); A.flush(5);
        sp = A.el('wp_cv_wells')._wp.spec;
        assert.ok(sp.key === 'wells-abs' && A.find('#wp_wells [data-act="wellskind"]'), 'rate – BHP view with the liquid / gas switch');
        // pick the parked (gas) well by its table row, then by the keyboard, then open it
        const row = A.findAll('#wp_wells tr.wp-wrow').find((tr) => /Well 1|condensate/.test(txt(tr)));
        A.click(row); A.flush(5);
        assert.ok(/wp-sel/.test(row.className) && /Open this well/.test(txt(A.el('wp_wsel'))), 'selected by click');
        A.click(row); A.flush(5);
        assert.ok(!/wp-sel/.test(row.className), 'second click clears');
        row.dispatchEvent(new G.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); A.flush(5);
        assert.ok(/wp-sel/.test(A.findAll('#wp_wells tr.wp-wrow').find((tr) => /condensate/.test(txt(tr))).className), 'selected by Enter');
        const id = row.getAttribute('data-well');
        A.click(A.find('#wp_wsel [data-act="wellsopen"]')); A.flush(80);
        assert.strictEqual(G.WTS_wells.active(), id, 'Open this well switched');
        assert.ok(A.el('wp_cv_wells') && A.findAll('#wp_wells tr.wp-wrow').length === 2, 'the card survives the switch');
        assert.ok(!/Previous inputs/.test(txt(A.el('wp_wells'))), 'not stale after the switch');
        A.change('wp_bean', '20'); A.flush(30);
        assert.match(txt(A.el('wp_wells')), /Previous inputs: the open well's inputs changed/, 'stale chip');
        const csv = P(A).csv();
        assert.ok(/All wells \(field units\)/.test(csv), 'CSV bundle carries the wells');
      } finally { pj.cleanup(); P(A).resetJobs(); }
    },
  },
  {
    name: 'WW9 schematic view (B): layers, correlation sections (rail + colouring), ESP and mandrels, KOP and horizontal brackets; devInfo; a vertical well is unchanged by the deviation marks',
    wp: WP,
    run(_a, assert, ctx) {
      const A = page(ctx), V = A.win.WTS_wp_view, dv = S.FIX.devSurvey;
      const R = 18000 / (Math.PI * 3), kop = 1000, last = dv.rows[dv.rows.length - 1][0];
      const traj = dv.expect.map((e, i) => ({ md: e.md, tvd: e.tvd, n: e.n, e: e.e, dep: e.dep, inc: dv.rows[i][1] }));
      const d = V.devInfo(traj);
      assert.ok(Math.abs(d.kopMd - (kop + 3 / 30 * (traj[2].md - kop))) < 1e-6 && d.incMax === 90, 'KOP at 3° (linear in MD between stations), max 90°');
      assert.ok(d.hz.length === 1 && Math.abs(d.hz[0].md1 - last) < 1e-9 && d.hz[0].md0 === traj[4].md, 'one horizontal stretch from the 90° station');
      void R;
      const Sx = { trajectory: traj, strings: [{ kind: 'tubing', od: 2.875, topMd: 0, botMd: last - 600 }], perfs: { topMd: last - 400, botMd: last, midMd: last - 200 }, profile: [] };
      const out = V.schematic(Sx, { width: 600, height: 600, prop: 'correlation',
        layers: [{ topMd: last - 450, botMd: last - 250, label: 'Upper sand' }, { topMd: last - 200, botMd: last, label: 'Lower sand' }],
        sections: [{ fromMd: 0, toMd: 2000, key: 'hb', label: 'Hagedorn & Brown', provisional: true }, { fromMd: 2000, toMd: last, key: 'bb', label: 'Beggs & Brill' }],
        marks: [{ md: last - 700, kind: 'esp', label: 'ESP', comp: 'esp' }, { md: 600, kind: 'mandrel', state: 'closed' }, { md: 1200, kind: 'mandrel', state: 'operating', label: 'valve 2 · operating' }] });
      const svg = out.svg;
      assert.strictEqual((svg.match(/class="wp-layer"/g) || []).length, 2, 'two layers');
      assert.ok(/Upper sand/.test(svg) && /Lower sand/.test(svg), 'layer labels');
      assert.strictEqual((svg.match(/class="wp-secrail"/g) || []).length, 2, 'section rail');
      assert.ok(/Hagedorn &amp; Brown \*/.test(svg) && /\* provisional/.test(svg), 'legend with the provisional mark');
      assert.ok(/data-comp="esp"/.test(svg) && /aria-label="ESP at /.test(svg), 'ESP');
      assert.strictEqual((svg.match(/Gas-lift mandrel at|valve 2 · operating at/g) || []).length, 2, 'two mandrels');
      assert.ok(/>KOP</.test(svg) && /class="wp-hz"/.test(svg) && /horizontal \d/.test(svg), 'KOP and horizontal bracket');
      assert.ok(out.sections.length === 2 && out.dev.hz.length === 1, 'returned sections and dev');
      const vert = V.schematic({ trajectory: [{ md: 0, tvd: 0, n: 0, e: 0, dep: 0, inc: 0 }, { md: 8000, tvd: 8000, n: 0, e: 0, dep: 0, inc: 0 }], strings: [], profile: [] }, { width: 600, height: 600 });
      assert.ok(!/KOP|wp-hz|wp-layer|wp-secrail/.test(vert.svg), 'vertical well: no new marks');
      const off = V.schematic(Sx, { width: 600, height: 600, deviation: false });
      assert.ok(!/>KOP<|class="wp-hz"/.test(off.svg), 'deviation:false');
    },
  },
  {
    name: 'WW10 page schematic: deviation caption (max inclination, KOP MD · TVD), "Correlation" colouring of the flow path, hover read-out of the section; R.lift marks contract',
    wp: WP,
    run(_a, assert, ctx) {
      const A = page(ctx, 'gas'), G = A.win;
      const cap = txt(A.el('wp_sch_cap'));
      assert.match(cap, /max inclination 30(\.0)?° at [\d,]+ ft MD · [\d,]+ ft TVD · KOP 2,150 ft MD · 2,150 ft TVD/, cap);
      const sel = A.el('wpv_prop');
      assert.ok(Array.from(sel.options).some((o) => o.value === 'correlation'), 'Colour by → Correlation');
      A.change('wpv_prop', 'correlation'); A.flush(5);
      const svg = A.el('wp_sch').innerHTML;
      const sec0 = P(A).state().schSections[0];
      assert.ok(/>Correlation</.test(svg) && svg.indexOf(G.WTS_wp_view.esc(sec0.label)) !== -1 && (sec0.provisional ? /stroke-dasharray="9 4"/.test(svg) : true), 'flow path painted by the section, legend ' + sec0.label);
      assert.ok(P(A).state().schSections.length === 1 && P(A).state().schSections[0].toMd === 9950, 'one section to the mid-perforation');
      // the lift-marks contract: an engine result carrying R.lift.marks reaches the schematic
      const st = P(A).state(), R0 = st.R;
      st.R = Object.assign({}, R0, { lift: { marks: [{ md: 4000, kind: 'esp' }, { md: 2500, kind: 'mandrel', state: 'open' }] } });
      G.dispatchEvent(new G.Event('resize')); A.flush(5);
      const svg2 = A.el('wp_sch').innerHTML;
      assert.ok(/aria-label="ESP 4,000 ft MD · [\d,]+ ft TVD at/.test(svg2) && /valve 2,500 ft MD/.test(svg2), 'ESP and mandrel drawn with MD · TVD labels');
      st.R = R0;
      A.change('wpv_prop', 'pressure'); A.flush(5);
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors');
    },
  },
];
