// Well Performance lift-curve tables and PVT tables — docs/WELL-PERFORMANCE-PLAN.md §3.9, §9, §13, §16, §17.3 (WP20, increment B).
//
// WX1 axes: suggest() / normalize() for oil, wet gas and injector wells; types that do not apply, bad values, the point cap refused;
//     datum MD → TVD on the deviated path; a datum below the mid-perforations clamped
// WX2 every point is the system solver's own top-down evaluation (WTS_wp_system.evalAt at the THP, outflowOnly): the middle point
//     exactly, the others within 0.1 psi (the frozen step layout); oil-rate and liquid-rate axes agree; a datum above the
//     mid-perforations reads the traverse at that MD; the additive evalAt options (outflowOnly, ctx / thp_psig) leave solve() unchanged
// WX3 the Job through PRiSM_autoInterp.drive: SHAPE.Job, progress and labels, one point per step with sliceMs 0, Cancel within one
//     point (CANCELLED, result discarded), 1 E per natural-flow point
// WX4 the lift-curve table text format: round trip (producer and injector), record layout (9 items in record 1, the axis records,
//     NT·NW·NG·NA BHP records with the four 1-based indices and NFLO values), comments and n*v repeats read, malformed text refused
// WX5 monotone fill along the rate axis (interpolated, extrapolated never falling for a producer / never rising for an injector,
//     held at the low end, a lost row from the next THP row), listed in the notes, the text comment and the CSV flags; monotone()
//     finds a THP break and a second minimum; the oil table rises with THP on every column and has single-minimum rows
// WX6 CSV long format: unit headers, one row per point, field units
// WX7 lift-gas axis: q_inj = 0 = the natural-flow table exactly, a lifted point = evalAt with that rate, lift lowers the BHP;
//     refused without an injection pressure
// WX8 PVT tables: the rows are WTS_wp_fluid.table's (identical), the bubble point is a row with Rs = GOR, CSV (field and metric),
//     the black-oil PVT table text format round trip (saturated Rs rising, the undersaturated branch under the last Rs), a wet gas
//     exports the gas table only; a provisional family is labelled
// WX9 injector: BHP at a small rate = THP + the water column on the deviated path (0.5 %), BHP falls with rate (friction lost)
// WX10 page: the step ⑦ cards, axes filled from the example and following it, wplt_ inputs never solve, Run fills the KPI chips, the
//      chart (curves per THP, inflow, rate handle), the readout and the slice table; #wp_ltsum is in the report model; downloads;
//      a model change marks the table stale; a provisional correlation is labelled
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP20';
const PATM = 14.696;
const app = (ctx) => S.sharedApp(ctx);
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
const SPEC_OIL = { flo: { type: 'OIL', values: [100, 400, 800, 1200] }, thp: [150, 300, 600], wfr: { type: 'WCT', values: [0.3, 0.6] }, gfr: { type: 'GOR', values: [0.5, 1] }, alq: { type: '', values: [0] } };
const _memo = new Map();
function table(G, M, spec, o) { const k = JSON.stringify([M, spec, o || null]); if (!_memo.has(k)) _memo.set(k, G.WTS_wp_export.liftTable(M, spec, o)); return _memo.get(k); }
function evalAt(G, M, thpA, q, mut) {
  const Mx = JSON.parse(JSON.stringify(M)); Mx.surface.choke.present = false; Mx.system.thp_psig = thpA - PATM; Mx.system.mode = 'rate'; Mx.system.node = 'bottom';
  if (mut) mut(Mx);
  return G.WTS_wp_system.evalAt(Mx, q, { outflowOnly: true });
}
function synth(kind) {
  // a hand-made table: 2 THP × 4 rates (no fluid axes), some points lost
  const st = (r) => r.map((v) => (v == null ? 'lost' : 'ok'));
  const rows = kind === 'inj' ? [[3000, 2800, null, null], [3300, 3100, 2700, null]] : [[2000, 1900, null, 2100], [null, 2200, 2250, null]];
  return { ok: true, kind, spec: { kind, tableNo: 1, flo: { type: kind === 'inj' ? 'WAT' : 'LIQ' }, wfr: {}, gfr: {}, alq: {} }, axes: { flo: [100, 200, 300, 400], thp: [200, 500], wfr: [0], gfr: [0], alq: [0] },
    bhp: rows.map((r) => [[[r.slice()]]]), status: rows.map((r) => [[[st(r)]]]), codes: rows.map((r) => [[[r.map((v) => (v == null ? 'LOST' : null))]]]), filled: [] };
}

module.exports = [
  {
    name: 'WX1 axes: suggest / normalize for oil, wet gas and injector wells; inapplicable types, bad values and the point cap refused; datum MD → TVD on the deviated path, a deep datum clamped',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, X = G.WTS_wp_export;
      assert.ok(X && typeof X.liftJob === 'function' && typeof X.pvtTable === 'function', 'WTS_wp_export');
      const Mo = S.FIX.oilWell, Mg = S.FIX.gasWell, Mi = S.FIX.oilWell; Mi.fluid.type = 'waterinj';
      assert.strictEqual(X.kind(Mo), 'prod'); assert.strictEqual(X.kind(Mg), 'prod'); assert.strictEqual(X.kind(Mi), 'inj');
      const so = X.suggest(Mo, G.WTS_wp_system.solve(Mo)), no = X.normalize(Mo, so);
      assert.ok(no.ok, 'oil suggestion valid: ' + no.errors.join('; '));
      assert.strictEqual(no.n, 10 * 5 * 4 * 4 * 1, 'the plan grid 10 × 5 × 4 × 4 (no lift)');
      assert.deepStrictEqual([so.flo.type, so.wfr.type, so.gfr.type, so.alq.type], ['OIL', 'WCT', 'GOR', '']);
      assert.ok(so.wfr.values.indexOf(0.3) !== -1 && so.gfr.values.indexOf(0.5) !== -1, 'the model WC 0.3 and GOR 0.5 Mscf/STB are on the axes');
      const sg = X.suggest(Mg, null), ng = X.normalize(Mg, sg);
      assert.ok(ng.ok && sg.flo.type === 'GAS' && sg.wfr.type === 'WGR' && sg.gfr.type === 'OGR', 'wet gas: GAS / WGR / OGR ' + ng.errors.join('; '));
      assert.ok(sg.wfr.values.indexOf(0.002) !== -1 && sg.gfr.values.indexOf(0.02) !== -1, 'WGR 2 and CGR 20 STB/MMscf in STB/Mscf');
      // the deviated datum: mid-perforations by default; MD → TVD on the surveyed path
      const W = G.WTS_wp_well.build(Mg.well, { res: Mg.res });
      assert.ok(Math.abs(ng.datum.md - W.nodes.midPerfMd) < 1e-9 && Math.abs(ng.datum.tvd - W.tvdAt(W.nodes.midPerfMd)) < 1e-9 && ng.datum.tvd < ng.datum.md - 100, 'datum TVD on the deviated path: ' + JSON.stringify(ng.datum));
      const n5 = X.normalize(Mg, Object.assign({}, sg, { datumMd: 5000 }));
      assert.ok(Math.abs(n5.datum.tvd - W.tvdAt(5000)) < 1e-9, 'datum 5,000 ft MD → its TVD');
      const nd = X.normalize(Mg, Object.assign({}, sg, { datumMd: 20000 }));
      assert.ok(nd.ok && nd.datum.md === W.nodes.midPerfMd && nd.warnings.some((w) => w.code === 'DATUM_DEEP'), 'a datum below the mid-perforations is clamped with a warning');
      const si = X.suggest(Mi, null), ni = X.normalize(Mi, si);
      assert.ok(ni.ok && si.flo.type === 'WAT' && ni.spec.wfr.values.length === 1, 'injector: water rate and THP only ' + ni.errors.join('; '));
      // refusals
      const bad = (sp, re, M) => { const r = X.normalize(M || Mo, sp); assert.ok(!r.ok && re.test(r.errors.join(' ')), re + ' → ' + r.errors.join('; ')); };
      bad(Object.assign({}, SPEC_OIL, { wfr: { type: 'WGR', values: [0.01] } }), /not a water-fraction axis/);
      bad(Object.assign({}, SPEC_OIL, { gfr: { type: 'OGR', values: [0.01] } }), /not a gas-fraction axis/);
      bad(Object.assign({}, SPEC_OIL, { flo: { type: 'GAS', values: [100] } }), /not a rate axis/, Mi);
      bad(Object.assign({}, SPEC_OIL, { thp: [] }), /THP: at least one value/);
      bad(Object.assign({}, SPEC_OIL, { thp: [5] }), /below 14\.696/);
      bad(Object.assign({}, SPEC_OIL, { wfr: { type: 'WCT', values: [0.3, 1.2] } }), /below 1/);
      bad(Object.assign({}, SPEC_OIL, { flo: { type: 'OIL', values: ['x'] } }), /not a number/);
      bad(Object.assign({}, SPEC_OIL, { alq: { type: 'GRAT', values: [0, 500] } }), /injection pressure/);
      bad(Object.assign({}, SPEC_OIL, { flo: { type: 'OIL', values: Array.from({ length: 30 }, (_, i) => 50 + 50 * i) }, thp: Array.from({ length: 15 }, (_, i) => 100 + 50 * i),
        wfr: { type: 'WCT', values: Array.from({ length: 10 }, (_, i) => i / 20) }, gfr: { type: 'GOR', values: [0.2, 0.4, 0.6] } }), /at most 12000 points/);
      const dup = X.normalize(Mo, Object.assign({}, SPEC_OIL, { thp: [600, 150, 300, 300] }));
      assert.deepStrictEqual(plain(dup.spec.thp), [150, 300, 600], 'values sorted, duplicates dropped');
    },
  },
  {
    name: 'WX2 each point = the solver\'s top-down evaluation at the THP (middle point exact, others ≤ 0.1 psi); oil / liquid rate axes agree; a datum above the perforations reads the traverse; solve() unchanged by the additive evalAt options',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, X = G.WTS_wp_export, M = S.FIX.oilWell;
      const T = table(G, M, SPEC_OIL);
      assert.ok(T.ok && T.n === 4 * 3 * 2 * 2 && T.filled.length === 0, 'oil table: ' + (T.errors || []).join('; '));
      let worst = 0, exact = null;
      for (let t = 0; t < 3; t++) for (let w = 0; w < 2; w++) for (let g = 0; g < 2; g++) for (let f = 0; f < 4; f++) {
        const wc = T.axes.wfr[w], e = evalAt(G, M, T.axes.thp[t], T.axes.flo[f] / (1 - wc), (Mx) => { Mx.fluid.wc = wc; Mx.fluid.gor = T.axes.gfr[g] * 1000; });
        assert.ok(e.ok, 'evalAt ok');
        const d = Math.abs(e.pOut - T.bhp[t][w][g][0][f]); worst = Math.max(worst, d);
        if (f === 1 && w === 0 && g === 0) exact = Math.max(exact || 0, d);
      }
      assert.ok(worst < 0.1, 'every point within 0.1 psi of evalAt: ' + worst);
      assert.strictEqual(exact, 0, 'the middle rate of a row (it records the step layout) is the evaluation exactly');
      // the liquid-rate axis at q_L = q_o / (1 − WC) gives the same BHP
      const TL = table(G, M, Object.assign({}, SPEC_OIL, { flo: { type: 'LIQ', values: SPEC_OIL.flo.values.map((q) => q / 0.7) }, wfr: { type: 'WCT', values: [0.3] } }));
      for (let f = 0; f < 4; f++) assert.ok(Math.abs(TL.bhp[1][0][0][0][f] - T.bhp[1][0][0][0][f]) < 0.1, 'LIQ vs OIL axis ' + f);
      // a datum above the mid-perforations: the traverse pressure at that MD (and its TVD in the record)
      const Mg = S.FIX.gasWell, sp = { flo: { type: 'GAS', values: [3000, 6000] }, thp: [1200], wfr: { type: 'WGR', values: [0.002] }, gfr: { type: 'OGR', values: [0.02] }, alq: { type: '', values: [0] }, datumMd: 6000 };
      const Tg = table(G, Mg, sp), e2 = evalAt(G, Mg, 1200, 6000);
      const pr = e2.tr.profile, i = pr.findIndex((r) => r.md >= 6000), p6 = pr[i - 1].p + (pr[i].p - pr[i - 1].p) * (6000 - pr[i - 1].md) / (pr[i].md - pr[i - 1].md);
      assert.ok(Math.abs(Tg.bhp[0][0][0][0][1] - p6) < 0.1 && Tg.bhp[0][0][0][0][1] < e2.pOut - 100, 'datum 6,000 ft MD: ' + Tg.bhp[0][0][0][0][1] + ' vs ' + p6);
      const W = G.WTS_wp_well.build(Mg.well, { res: Mg.res });
      assert.ok(Math.abs(Tg.datum.tvd - W.tvdAt(6000)) < 1e-9 && /Datum 6000 ft MD = \d+ ft TVD/.test(Tg.notes[0]), 'datum MD and TVD: ' + Tg.notes[0]);
      // the additive options: a context reused with thp_psig = a fresh evaluation; solve() without them is unchanged
      const Mx = JSON.parse(JSON.stringify(M)); Mx.surface.choke.present = false; Mx.system.thp_psig = 300;
      const cx = G.WTS_wp_system.context(Mx, { outflowOnly: true });
      assert.ok(cx.ok, 'context');
      const a1 = G.WTS_wp_system.evalAt(Mx, 700, { ctx: cx, thp_psig: 300 }), b1 = G.WTS_wp_system.evalAt(Mx, 700, { outflowOnly: true });
      assert.strictEqual(a1.pOut, b1.pOut, 'ctx evaluation = a fresh evaluation (same step layout source)');
      assert.ok(!Number.isFinite(b1.pIn), 'outflowOnly: no inflow (pIn NaN)');
      const Mn = S.FIX.oilWell; Mn.res.pr = null;
      assert.ok(G.WTS_wp_system.evalAt(Mn, 700, { outflowOnly: true }).ok && G.WTS_wp_system.evalAt(Mn, 700).code === 'NEEDS_IPR', 'outflowOnly needs no p̄r; the default still does');
      const R1 = G.WTS_wp_system.solve(S.FIX.oilWell), R2 = G.WTS_wp_system.solve(S.FIX.oilWell);
      assert.strictEqual(R1.op.q, R2.op.q, 'solve unchanged');
    },
  },
  {
    name: 'WX3 the Job via PRiSM_autoInterp.drive: SHAPE.Job, progress and labels, one point per step with sliceMs 0, cancel within one point (CANCELLED), 1 E per natural-flow point',
    wp: WP, opts: false,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, X = G.WTS_wp_export, M = S.FIX.oilWell;
      const j = X.liftJob(M, SPEC_OIL, { sliceMs: 0 });
      assert.ok(S.checkShape('Job', j).ok !== false && typeof j.cancel === 'function', 'SHAPE.Job');
      const prog = [];
      const r = await new Promise((res, rej) => { G.PRiSM_autoInterp.drive(j, { onProgress: (p, l) => prog.push([p, l]) }).then(res, rej); (async () => { for (let i = 0; i < 400; i++) await A.flushAsync(1); })(); });
      assert.ok(r.ok && r.n === 48, 'result: ' + (r.errors || []).join('; '));
      assert.strictEqual(prog.length, 48, 'one point per step with sliceMs 0 (48 steps)');
      assert.ok(prog.every((p, i) => i === 0 || p[0] >= prog[i - 1][0]) && /point 48 of 48/.test(prog[prog.length - 1][1]), 'progress rises; labels "point n of N"');
      assert.strictEqual(r.evals, 48, '1 E per natural-flow point');
      // cancel within one point: the result is discarded
      const j2 = X.liftJob(M, SPEC_OIL, { sliceMs: 0 }); let n = 0, err = null;
      const pr = G.PRiSM_autoInterp.drive(j2, { shouldCancel: () => ++n > 3 }).then(() => null, (e) => { err = e; });
      for (let i = 0; i < 40 && !err; i++) await A.flushAsync(1);
      await pr;
      assert.ok(err && err.code === 'CANCELLED', 'drive rejects CANCELLED');
      assert.ok(j2.result().cancelled === true && j2.result().ok === false, 'cancelled result discarded');
    },
  },
  {
    name: 'WX4 the lift-curve table text format: round trip (producer, injector), record layout, comments and n*v repeats, malformed text refused',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, X = G.WTS_wp_export, T = table(G, S.FIX.oilWell, SPEC_OIL);
      const s = X.text(T, { date: '2026-11-12' }), P = X.parseText(s);
      assert.ok(P.ok, 'parse: ' + (P.errors || []).join('; '));
      assert.strictEqual(P.kind, 'prod'); assert.strictEqual(P.tableNo, 1); assert.strictEqual(P.datum, 8000);
      assert.deepStrictEqual(plain(P.types), { flo: 'OIL', wfr: 'WCT', gfr: 'GOR', thp: 'THP', alq: '', units: 'FIELD', tab: 'BHP' });
      assert.deepStrictEqual(plain(P.axes), plain(T.axes), 'axes back exactly');
      let worst = 0;
      for (let t = 0; t < 3; t++) for (let w = 0; w < 2; w++) for (let g = 0; g < 2; g++) for (let f = 0; f < 4; f++) worst = Math.max(worst, Math.abs(P.bhp[t][w][g][0][f] - T.bhp[t][w][g][0][f]));
      assert.ok(worst <= 0.005 + 1e-9, 'BHP back within the printed 0.01 psi: ' + worst);
      // layout: the keyword, record 1 with 9 items, BHP records = NT·NW·NG·NA with the four indices then NFLO values
      const body = s.split('\n').filter((l) => !/^\s*--/.test(l) && l.trim());
      assert.strictEqual(body[0].trim(), 'VFPPROD', 'producer keyword line');
      assert.match(body[1], /^\s*1\s+8000\s+'OIL'\s+'WCT'\s+'GOR'\s+'THP'\s+' '\s+'FIELD'\s+'BHP' \/$/, 'record 1: ' + body[1]);
      const recs = s.replace(/--.*$/gm, '').split('/').map((r) => r.trim()).filter(Boolean);
      assert.strictEqual(recs.length, 6 + 3 * 2 * 2 * 1, 'record count (1 + 5 axis records + 12 BHP records)');
      const r7 = recs[6].replace('VFPPROD', '').trim().split(/\s+/).map(Number);
      assert.deepStrictEqual(r7.slice(0, 4), [1, 1, 1, 1], 'first BHP record indices THP WFR GFR ALQ');
      assert.strictEqual(r7.length, 4 + 4, 'four indices + NFLO values');
      assert.match(recs[7], /^1 1 2 1\b/, 'the GFR index runs fastest after ALQ');
      assert.match(s, /Field units: oil \/ liquid \/ water rate STB\/d/, 'units header');
      // injector
      const Mi = S.FIX.oilWell; Mi.fluid.type = 'waterinj';
      const Ti = table(G, Mi, { flo: { type: 'WAT', values: [1000, 4000, 8000] }, thp: [200, 800] });
      const si = X.text(Ti), Pi = X.parseText(si);
      assert.ok(Ti.ok && Pi.ok && Pi.kind === 'inj' && Pi.types.flo === 'WAT', 'injector parse: ' + (Pi.errors || []).join('; '));
      assert.match(si, /\nVFPINJ\n/, 'injector keyword');
      assert.ok(Pi.bhp.every((r, t) => r[0][0][0].every((v, f) => Math.abs(v - Ti.bhp[t][0][0][0][f]) <= 0.005 + 1e-9)), 'injector BHP back');
      // reader: comments, quotes, n*v repeats
      const hand = "-- a hand-written table\nVFPINJ\n 7 5000 'GAS' 'THP' 'FIELD' 'BHP' / -- record 1\n 100 200 /\n 3*500 /\n";
      const Ph = X.parseText(hand);
      assert.ok(!Ph.ok && /0 BHP records/.test(Ph.errors.join(' ')) && Ph.axes.thp.length === 3 && Ph.axes.thp.every((v) => v === 500), 'n*v expanded; missing records reported: ' + Ph.errors.join('; '));
      assert.ok(!X.parseText('nothing here').ok, 'no keyword refused');
      assert.ok(!X.parseText(s.replace(/\n {4}[\d. ]+ \/\n/, '\n 1 2 /\n')).ok, 'a short BHP record refused');
    },
  },
  {
    name: 'WX5 monotone fill along the rate axis (interpolated, extrapolated, held, from the next THP row; injector never rising), listed in notes / text / CSV; monotone() finds breaks; the oil table is monotone in THP with single-minimum rows',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, X = G.WTS_wp_export;
      const T = X.fill(synth('prod'));
      const r0 = T.bhp[0][0][0][0], r1 = T.bhp[1][0][0][0];
      assert.strictEqual(r0[2], 2000, 'interior: interpolated between 1900 and 2100');
      assert.strictEqual(r1[0], 2200, 'below the first valid rate: held');
      assert.strictEqual(r1[3], 2300, 'above the last valid rate: straight-line extension (slope 0.5 psi per STB/d)');
      const hows = T.filled.map((f) => f.how).sort();
      assert.deepStrictEqual(hows, ['extrapolated', 'held', 'interpolated'], 'every filled point listed with how');
      // a producer row whose valid end falls: extension flat (never falling)
      const Tf = synth('prod'); Tf.bhp[0][0][0][0] = [2000, 1900, 1800, null]; Tf.status[0][0][0][0] = ['ok', 'ok', 'ok', 'lost'];
      X.fill(Tf); assert.strictEqual(Tf.bhp[0][0][0][0][3], 1800, 'producer: never falls above the last valid rate');
      // injector: never rising, floored at 1 atm
      const Ti = X.fill(synth('inj'));
      assert.ok(Ti.bhp[0][0][0][0][2] < 2800 && Ti.bhp[0][0][0][0][3] >= PATM && Ti.bhp[1][0][0][0][3] < 2700, 'injector extension falls: ' + Ti.bhp.map((r) => r[0][0][0].join(' ')).join(' | '));
      // a whole row lost: from the next THP row + ΔTHP
      const Tr = synth('prod'); Tr.bhp[1][0][0][0] = [null, null, null, null]; Tr.status[1][0][0][0] = ['lost', 'lost', 'lost', 'lost'];
      X.fill(Tr);
      assert.ok(Tr.bhp[1][0][0][0].every((v, f) => Math.abs(v - (Tr.bhp[0][0][0][0][f] + 300)) < 1e-9) && Tr.filled.some((f) => /from THP row 1/.test(f.how)), 'row filled from THP row 1 + 300 psi');
      // monotone(): a THP break and a second minimum
      const Tm = synth('prod'); X.fill(Tm);
      Tm.bhp[1][0][0][0] = [2500, 1800, 2400, 2300];
      const mo = X.monotone(Tm);
      assert.ok(!mo.thp.ok && mo.thp.list.some((l) => l.f === 1), 'THP break found at rate 2');
      assert.ok(!mo.rate.ok && mo.rate.list.some((l) => l.t === 1 && l.side === 'rising branch falls'), 'second minimum found');
      // the real table: notes, text comment and CSV flags of a filled point (force one lost point through the pure functions)
      const Tok = table(G, S.FIX.oilWell, SPEC_OIL);
      assert.ok(Tok.monotone.thp.ok, 'oil table: BHP rises with THP on every column');
      assert.ok(Tok.monotone.rate.ok, 'oil table: every row single-minimum: ' + JSON.stringify(Tok.monotone.rate.list));
      const Tx = JSON.parse(JSON.stringify(Tok)); Tx.status[0][0][0][0][3] = 'lost'; Tx.codes[0][0][0][0][3] = 'LOST'; Tx.bhp[0][0][0][0][3] = null; Tx.filled = [];
      X.fill(Tx);
      assert.strictEqual(Tx.filled.length, 1);
      // rebuild points / notes as the Job does
      const J = X.liftTable(S.FIX.oilWell, Object.assign({}, SPEC_OIL, { flo: { type: 'OIL', values: [100, 400, 800, 1200, 1e6] }, wfr: { type: 'WCT', values: [0.3] }, gfr: { type: 'GOR', values: [0.5] }, thp: [300] }), { pMax: 6000 });
      assert.ok(J.ok && J.filled.length >= 1 && J.filled.every((f) => f.f === 4 && f.how === 'extrapolated'), 'a point above pMax is filled by extrapolation: ' + JSON.stringify(J.filled));
      assert.ok(J.notes.some((n) => /points filled \(\d+ extrapolated\)/.test(n)), 'notes list the filled points: ' + J.notes.join(' | '));
      assert.match(X.text(J), /-- Filled points \(THP, WFR, GFR, ALQ, rate indices\): \(1,1,1,1,5 extrapolated\)/, 'text comment');
      assert.match(X.csv(J), /,filled:extrapolated:/, 'CSV flag');
      assert.ok(J.bhp[0][0][0][0][4] >= J.bhp[0][0][0][0][3], 'filled point continues the row upwards');
    },
  },
  {
    name: 'WX6 CSV long format: unit headers, one row per point, field units',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, X = G.WTS_wp_export, T = table(G, S.FIX.oilWell, SPEC_OIL), c = X.csv(T).trim().split('\n');
      assert.match(c[0], /^# Lift-curve table \(producer\) 1, datum 8000 ft MD \/ 8000 ft TVD, field units$/);
      assert.strictEqual(c[1], 'rate_OIL_STB/d,thp_psia,wfr_WCT_fraction,gfr_GOR_Mscf/STB,alq_none,bhp_psia,flags');
      assert.strictEqual(c.length - 2, T.n, 'one row per point');
      const r = c[2].split(',');
      assert.deepStrictEqual(r.slice(0, 5), ['100', '150', '0.3', '0.5', '0'], 'first point in field units');
      assert.strictEqual(+r[5], +T.bhp[0][0][0][0][0].toFixed(2));
    },
  },
  {
    name: 'WX7 lift-gas axis: q_inj = 0 = the natural-flow table exactly, a lifted point = evalAt at that rate, lift lowers the BHP; refused without an injection pressure',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, X = G.WTS_wp_export, M = S.FIX.oilWell;
      M.fluid.wc = 0.6; M.res.pr = 2600; M.lift = { type: 'gaslift', gl: { qinj_Mscfd: 500, pinj_psig: 1200, sginj: 0.65, dpValve: 100, packerMd: 7800 } };
      const sp = { flo: { type: 'OIL', values: [200, 500] }, thp: [150, 400], wfr: { type: 'WCT', values: [0.6] }, gfr: { type: 'GOR', values: [0.5] }, alq: { type: 'GRAT', values: [0, 500] } };
      const T = table(G, M, sp);
      assert.ok(T.ok && T.n === 8, (T.errors || []).join('; '));
      const Mn = JSON.parse(JSON.stringify(M)); Mn.lift.type = 'none';
      const Tn = table(G, Mn, Object.assign({}, sp, { alq: { type: '', values: [0] } }));
      for (let t = 0; t < 2; t++) for (let f = 0; f < 2; f++) assert.strictEqual(T.bhp[t][0][0][0][f], Tn.bhp[t][0][0][0][f], 'q_inj 0 = natural flow ' + t + ',' + f);
      const e = evalAt(G, M, 150, 500 / 0.4, (Mx) => { Mx.lift.qinj_Mscfd = 500; Mx.lift.gl.qinj_Mscfd = 500; });
      assert.ok(e.ok && Math.abs(e.pOut - T.bhp[0][0][0][1][1]) < 0.5, 'lifted point = evalAt: ' + e.pOut + ' vs ' + T.bhp[0][0][0][1][1]);
      assert.ok(T.bhp[0][0][0][1][1] < T.bhp[0][0][0][0][1] - 100, 'lift gas lowers the BHP');
      assert.strictEqual(T.evals > 8, true, 'lifted points count more than 1 E');
      const Mx = JSON.parse(JSON.stringify(M)); Mx.lift.gl.pinj_psig = null;
      assert.ok(!X.normalize(Mx, sp).ok, 'no injection pressure → refused');
    },
  },
  {
    name: 'WX8 PVT tables: rows = WTS_wp_fluid.table, the bubble point a row (Rs = GOR), CSV field / metric, the black-oil text format round trip, wet gas = gas table only, provisional family labelled',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, X = G.WTS_wp_export, M = S.FIX.oilWell;
      const P = X.pvtTable(M);
      assert.ok(P.ok && P.type === 'oil' && P.rows.length === 16 && Math.abs(P.T - 200) < 1e-12, 'oil PVT: 15 pressures + the bubble point');
      const F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), tb = G.WTS_wp_fluid.table(F, P.rows.map((r) => r.p), 200);
      assert.deepStrictEqual(plain(P.rows), plain(tb.rows), 'the rows are the fluid engine\'s table (one property path)');
      const rb = P.rows.find((r) => Math.abs(r.p - P.pb) < 1e-9);
      assert.ok(rb && Math.abs(rb.rs - 500) < 1e-6 && rb.saturated === true, 'bubble point row, Rs = GOR 500');
      const c = X.pvtCsv(P).trim().split('\n');
      assert.match(c[1], /^p_psia,Rs_scf\/STB,Bo_rb\/STB,mu_o_cp,co_1\/psi,Z_-,Bg_rb\/Mscf,mu_g_cp,Bw_rb\/STB,mu_w_cp,rho_o_lbm\/ft3,rho_g_lbm\/ft3,rho_w_lbm\/ft3,state$/);
      assert.strictEqual(c.length - 2, P.rows.length);
      const cm = X.pvtCsv(P, { metric: true }).trim().split('\n');
      assert.ok(/^p_kPa/.test(cm[1]) && Math.abs(+cm[2].split(',')[0] - 14.7 * 6.894757) < 0.05 && /degC/.test(cm[0]), 'metric CSV: ' + cm[1].slice(0, 40) + ' ' + cm[2].slice(0, 20));
      const s = X.pvtText(P), Q = X.parsePvtText(s);
      assert.ok(Q.ok, 'parse: ' + Q.errors.join('; '));
      assert.ok(/\nPVTO\n/.test(s) && /\nPVDG\n/.test(s) && /\nPVTW\n/.test(s), 'live oil, dry gas, water');
      assert.ok(Q.oil.every((r, i) => i === 0 || r.rs > Q.oil[i - 1].rs), 'saturated Rs strictly rising');
      const last = Q.oil[Q.oil.length - 1];
      assert.ok(Math.abs(last.rs - 0.5) < 1e-6 && last.rows.length === 1 + P.rows.filter((r) => !r.saturated).length && last.rows[0].p === +P.pb.toPrecision(7), 'the undersaturated branch sits under the bubble-point Rs');
      assert.strictEqual(Q.gas.length, P.rows.length, 'gas table: every pressure');
      assert.ok(Q.water && Q.water.cw > 0 && Q.water.bw > 1, 'water record');
      // wet gas: the gas table only; the D14 note
      const Pg = X.pvtTable(S.FIX.gasWell), sg = X.pvtText(Pg), Qg = X.parsePvtText(sg);
      assert.ok(Pg.ok && Qg.ok && !Qg.oil.length && Qg.gas.length === Pg.rows.length && /no vaporised-oil table/.test(sg), 'wet gas exports the gas table only');
      // a provisional family is labelled in the notes and the text header
      const Mv = S.FIX.oilWell; Mv.fluid.corr.pb = 'vasquezBeggs'; Mv.fluid.corr.rs = 'vasquezBeggs'; Mv.fluid.corr.bo = 'vasquezBeggs';
      const Pv = X.pvtTable(Mv);
      assert.ok(Pv.ok && Pv.provisional.length && /provisional — not verified against a published example/.test(X.pvtText(Pv)), 'provisional family labelled');
    },
  },
  {
    name: 'WX9 injector: BHP at a small rate = THP + the water column on the deviated path (0.5 %); BHP falls with rate (friction lost); gas injector',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, X = G.WTS_wp_export;
      const M = S.FIX.gasWell; M.fluid.type = 'waterinj'; M.fluid.sgw = 1.05;
      const T = table(G, M, { flo: { type: 'WAT', values: [10, 2000, 6000] }, thp: [500] });
      assert.ok(T.ok, (T.errors || []).join('; '));
      const W = G.WTS_wp_well.build(M.well, { res: M.res }), tvd = T.datum.tvd;
      // the water column with the engine's own density at mid-column (weak p, T dependence)
      const F = G.WTS_wp_fluid.build(M.fluid, { T_F: M.res.T_F }), r = G.WTS_wp_fluid.table(F, [500 + 0.45 * tvd / 2], W.tAt(W.nodes.midPerfMd / 2)).rows[0];
      const hyd = 500 + r.rhoW * tvd / 144;
      assert.ok(Math.abs(T.bhp[0][0][0][0][0] - hyd) / hyd < 0.005, 'small rate ≈ THP + water column: ' + T.bhp[0][0][0][0][0] + ' vs ' + hyd);
      assert.ok(T.bhp[0][0][0][0][1] < T.bhp[0][0][0][0][0] && T.bhp[0][0][0][0][2] < T.bhp[0][0][0][0][1], 'BHP falls with rate (friction lost)');
      assert.ok(T.warnings.some((w) => w.code === 'INJ_TEMP'), 'temperature note');
      const Mg = S.FIX.gasWell; Mg.fluid.type = 'gasinj';
      const Tg = table(G, Mg, { flo: { type: 'GAS', values: [1000, 10000] }, thp: [1500, 2500] });
      assert.ok(Tg.ok && Tg.bhp[0][0][0][0][0] > 1500 && Tg.monotone.thp.ok, 'gas injector table');
    },
  },
  {
    name: 'WX10 page: step ⑦ cards, axes from the example, wplt_ inputs never solve, Run → KPI chips, chart, readout, slice table, #wp_ltsum in the report, downloads, stale on a model change, provisional label',
    wp: WP,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, P = G.WTS_wellperf_page;
      S.resetWellPerf(A); P.resetJobs(); P.budget(300);
      A.hook.nav('wellperf'); A.flush(30);
      A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
      assert.ok(A.el('wplt_card') && A.el('wplt_pvtcard') && A.el('wp_ltsum'), 'cards and the summary box');
      assert.ok(A.el('wp_step_7').contains(A.el('wplt_card')) && A.el('wp_res').contains(A.el('wp_ltsum')), 'cards in step ⑦, the summary in #wp_res');
      assert.strictEqual(A.el('wplt_flot').value, 'OIL');
      assert.match(A.el('wplt_wfrv').value, /\b0\.3\b/, 'the example WC on the axis');
      assert.match(txt(A.el('wplt_meta')), /800 points/, 'point count');
      assert.match(txt(A.el('wplt_datumtvd')), /8,000 ft MD · 8,000 ft TVD/, 'datum MD · TVD');
      const c0 = P.calcs();
      A.el('wplt_flov').value = '200 600 1000'; A.change(A.el('wplt_flov'));
      A.el('wplt_wfrv').value = '0.3'; A.change(A.el('wplt_wfrv')); A.el('wplt_gfrv').value = '0.5'; A.change(A.el('wplt_gfrv'));
      assert.strictEqual(P.calcs(), c0, 'wplt_ inputs never solve');
      assert.match(txt(A.el('wplt_meta')), /15 points/, 'count follows the axes');
      A.click(A.find('#wplt_card [data-lt="run"]'));
      const st = G.WTS_wp_tables.state();
      for (let i = 0; i < 100 && !st.T; i++) await A.flushAsync(1);
      assert.ok(st.T && st.T.ok && st.T.n === 15, 'the table ran');
      const kp = txt(A.el('wplt_res'));
      assert.match(kp, /Points\s*15/); assert.match(kp, /BHP vs THP\s*rising/); assert.match(kp, /Datum\s*8,000 ft MD\s*8,000 ft TVD/);
      assert.ok(!/NaN|undefined|Infinity/.test(kp), 'no NaN');
      const cv = A.el('wplt_cv');
      assert.ok(cv && cv._wpAxes, 'chart drawn');
      assert.match(txt(A.el('wplt_read')), /600 STB\/d.*psia/, 'rate readout');
      assert.strictEqual(A.el('wplt_tbl').querySelectorAll('tbody tr').length, 5, 'slice table: a row per THP');
      // the handle moves the readout
      const before = txt(A.el('wplt_read'));
      G.WTS_wp_tables.handle('rate', 900, 'end');
      assert.strictEqual(st.cursor, 900, 'cursor in field units');
      assert.notStrictEqual(txt(A.el('wplt_read')), before, 'the rate line re-reads every THP');
      // report capture (#wp_res is always visible)
      const m = JSON.stringify(G.collectPageReport(A.el('pgBody'), { charts: false }));
      assert.ok(/Lift-curve table/.test(m) && /BHP rises with THP on every column/.test(m), 'the summary is in the report model');
      // downloads
      A.click(A.find('#wplt_card [data-lt="txt"]'));
      assert.ok(/^wellperf_lift_table_1_.*\.txt$/.test(G.WTS_wp_tables.last.name) && /VFPPROD/.test(G.WTS_wp_tables.last.text), 'text download');
      A.click(A.find('#wplt_card [data-lt="csv"]')); assert.match(G.WTS_wp_tables.last.name, /\.csv$/);
      A.click(A.find('#wplt_pvtcard [data-lt="pvttxt"]')); assert.ok(/PVTO/.test(G.WTS_wp_tables.last.text), 'PVT text download');
      assert.match(txt(A.el('wplt_pvtmeta')), /16 pressures/);
      // a model change marks the table stale
      A.el('wp_wc').value = '50'; A.change(A.el('wp_wc')); A.flush(30);
      assert.match(txt(A.el('wp_ltsum')), /previous inputs/, 'stale after a model change');
      // a provisional correlation is labelled in the summary
      A.el('wp_corr_well').value = 'hb'; A.change(A.el('wp_corr_well')); A.flush(30);
      A.click(A.find('#wplt_card [data-lt="run"]')); st.T = null;
      for (let i = 0; i < 100 && !st.T; i++) await A.flushAsync(1);
      assert.match(txt(A.el('wp_ltsum')), /provisional — not verified against a published example/, 'provisional label in the summary');
      assert.strictEqual(A.consoleErrors ? A.consoleErrors().length : 0, 0, 'no console errors');
    },
  },
];
