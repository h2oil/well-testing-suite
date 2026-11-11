// Well Performance WP4 — well geometry (docs/WELL-PERFORMANCE-PLAN.md §2.3, §3.1, §4.5, §15.1, §17.1: wellperf-well).
//
// WW1 minimum curvature (WTS_wellbore.surveyMC) against the closed-form circular arc of FIX.devSurvey (±0.01 ft, §15.1) and an
//     independent quadrature of a 3-D build-and-turn interval; at(md) on the arc
// WW2 WTS_wellbore.column accepts [md, inc, azi] rows (key mc; TVD on the arcs, mdAt its inverse); [md, tvd] input unchanged
// WW3 column schema → segmentsFor: tapered deviated string, flow order, exact ΔTVD (hydrostatic on TVD, friction on MD), the dogleg
//     limit per segment, sub-ranges and downward flow
// WW4 annulus path: hydraulic diameter and flow area, casing bore below the tubing, the missing-casing error
// WW5 restrictions: the inlet-of-segment rule, β, ignored rows, and the WP0b marcher applying the loss on these segments
// WW6 checks: the warning and error codes of build()
// WW7 DFIT geometry import (WTS_wp_model.fromDfit → build)
// WW8 roughness defaults (WTS_tubulars.roughness, owner Q10) and the length-weighted march roughness
// WW9 schematic data: trajectory / vertical section / plan view, strings, perfs, gauges, hover readout and heat-map ranges
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP4';
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const app = (ctx) => S.sharedApp(ctx);
const deg = Math.PI / 180;
const codes = (W) => plain(W.warnings || []).map((w) => w.code);
const near = (assert, a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, what + ': ' + a + ' vs ' + b + ' (tol ' + tol + ')');

function sumBy(list, f) { return list.reduce((s, x) => s + f(x), 0); }

module.exports = [
  {
    name: 'WW1 minimum curvature: FIX.devSurvey stations within 0.01 ft of the closed-form arc, DLS, at(md) on the arc; a 3-D build-and-turn interval equals an independent quadrature',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const WB = app(ctx).win.WTS_wellbore;
      assert.strictEqual(typeof WB.surveyMC, 'function', 'WTS_wellbore.surveyMC');
      const d = S.FIX.devSurvey, mc = WB.surveyMC(d.rows);
      assert.ok(mc.ok, 'ok');
      assert.strictEqual(mc.stations.length, d.expect.length);
      mc.stations.forEach((s, i) => {
        const e = d.expect[i];
        ['md', 'tvd', 'n', 'e', 'dep'].forEach((k) => near(assert, s[k], e[k], d.tol.ft, k + ' at ' + e.md.toFixed(1)));
        near(assert, s.dls, e.dls, 1e-9, 'DLS at ' + e.md.toFixed(1));
      });
      near(assert, mc.maxInc, 90, 1e-12, 'max inclination');
      near(assert, mc.maxDls, d.bur, 1e-9, 'max DLS');
      // a point inside the build: inclination 45° at MD = KOP + R·π/4
      const md45 = 1000 + d.R * Math.PI / 4, p = mc.at(md45);
      near(assert, p.tvd, 1000 + d.R * Math.sin(Math.PI / 4), d.tol.ft, 'TVD at 45°');
      near(assert, p.dep, d.R * (1 - Math.cos(Math.PI / 4)), d.tol.ft, 'departure at 45°');
      near(assert, p.inc, 45, 1e-9, 'inclination at 45°');
      near(assert, p.azi, 45, 1e-9, 'azimuth');
      // below the last station: straight along its tangent (horizontal here)
      const last = d.expect[d.expect.length - 1], q = mc.at(last.md + 100);
      near(assert, q.tvd, last.tvd, 1e-9, 'tangent extension keeps TVD at 90°');
      near(assert, q.dep, last.dep + 100, 1e-6, 'tangent extension departure');
      // 3-D interval: I 10° / A 30° → I 40° / A 80° over 600 ft; quadrature of the circular arc (slerp of the end tangents)
      const t = (i, a) => [Math.sin(i * deg) * Math.cos(a * deg), Math.sin(i * deg) * Math.sin(a * deg), Math.cos(i * deg)];
      const t1 = t(10, 30), t2 = t(40, 80), b = Math.acos(t1[0] * t2[0] + t1[1] * t2[1] + t1[2] * t2[2]), L = 600, n = 20000;
      const pos = [0, 0, 0];
      for (let k = 0; k < n; k++) {
        const f = (k + 0.5) / n, w1 = Math.sin((1 - f) * b) / Math.sin(b), w2 = Math.sin(f * b) / Math.sin(b);
        for (let j = 0; j < 3; j++) pos[j] += (w1 * t1[j] + w2 * t2[j]) * L / n;
      }
      const m3 = WB.surveyMC([[0, 0, 0], [1000, 10, 30], [1600, 40, 80]]), s1 = m3.stations[1], s2 = m3.stations[2];
      near(assert, s2.n - s1.n, pos[0], 0.01, 'ΔN'); near(assert, s2.e - s1.e, pos[1], 0.01, 'ΔE'); near(assert, s2.tvd - s1.tvd, pos[2], 0.01, 'ΔTVD');
      near(assert, s2.dogleg, b / deg, 1e-9, 'dogleg'); near(assert, s2.dls, b / deg / 6, 1e-9, 'DLS °/100 ft');
      // the first interval (vertical → I 10°) is the textbook radius-of-curvature-equals-arc case: ΔTVD = R sin I, R = L / I
      const R1 = 1000 / (10 * deg);
      near(assert, s1.tvd, R1 * Math.sin(10 * deg), 1e-9, 'build from vertical');
      // bad rows: dropped with a warning; nothing usable → NO_SURVEY
      const bad = WB.surveyMC([[0, 0, 0], [500, 200, 0], [600, 5, 0], [400, 5, 0], ['x', 1, 2], [900, 5, 400]]);
      assert.ok(bad.ok && bad.stations.length === 3 && bad.stations[2].azi === 40, 'azimuth taken modulo 360, bad rows dropped');
      assert.ok(plain(bad.warnings).filter((w) => w.code === 'SURVEY_ROW_DROPPED').length === 3, 'three rows dropped');
      assert.strictEqual(WB.surveyMC([]).code, 'NO_SURVEY');
      const tie = WB.surveyMC([[1000, 0, 0], [2000, 10, 0]]);
      assert.ok(tie.stations[0].md === 0 && tie.stations[1].tvd === 1000, 'tie-in at the surface');
    },
  },
  {
    name: 'WW2 WTS_wellbore.column takes [md, inc, azi] rows: TVD on the minimum-curvature arcs (key mc), mdAt is its inverse; a [md, tvd] column has no mc key',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const WB = app(ctx).win.WTS_wellbore, d = S.FIX.devSurvey;
      const mid = d.expect[3];   // inc 90°
      const col = WB.column({ datumTvd: mid.tvd, datumMd: mid.md, survey: d.rows, strings: [{ id: 2.992, od: 3.5, wall: 0.254, topMd: 0, botMd: mid.md }] });
      assert.ok(col.ok && col.mc && Array.isArray(col.mc.stations), 'column ok with mc');
      d.expect.forEach((e) => near(assert, col.tvdAt(e.md), e.tvd, d.tol.ft, 'tvdAt(' + e.md.toFixed(0) + ')'));
      [1500, 2000, 2500].forEach((md) => near(assert, col.mdAt(col.tvdAt(md)), md, 1e-4, 'mdAt(tvdAt(' + md + '))'));
      near(assert, col.tvdAt(1000 + d.R * Math.PI / 6 / 2), 1000 + d.R * Math.sin(Math.PI / 12), d.tol.ft, 'TVD inside an interval is on the arc');
      const col2 = WB.column({ datumTvd: 9000, survey: [[0, 0], [3000, 3000], [9500, 9000]], strings: [{ id: 2.992, od: 3.5, wall: 0.254, topMd: 0, botMd: 9500 }] });
      assert.ok(col2.ok && !('mc' in col2), '[md, tvd] column unchanged (no mc key)');
      near(assert, col2.tvdAt(6250), 6000, 1e-9, 'linear [md, tvd] interpolation');
    },
  },
  {
    name: 'WW3 segmentsFor: the tapered S-shaped gas well — flow order mid-perf → wellhead, exact ΔTVD, bore per depth, ≤ 5° turn per segment; sub-range, downward flow and a finer dogleg limit',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, M = S.FIX.gasWell;
      const W = G.WTS_wp_well.build(M.well, { res: M.res, fluidType: M.fluid.type });
      assert.ok(W.ok, JSON.stringify(plain(W.errors)));
      const sg = plain(W.segments);
      assert.ok(!(G.__WP_STUBS || []).some((n) => /^WTS_wp_well\./.test(n)), 'WP4 names left window.__WP_STUBS');
      assert.ok(sg.length >= 5, 'segments: ' + sg.length);
      near(assert, sg[0].md0, 9950, 1e-9, 'first segment starts at the mid-perforations');
      near(assert, sg[sg.length - 1].md1, 0, 1e-9, 'last segment ends at the wellhead');
      sg.forEach((s, i) => {
        assert.ok(s.md0 > s.md1 && s.len > 0, 'flow up: md0 > md1');
        near(assert, s.len, s.md0 - s.md1, 1e-9, 'length on MD');
        near(assert, s.dz, s.tvd0 - s.tvd1, 1e-9, 'dz on TVD');
        near(assert, s.tvd0, W.tvdAt(s.md0), 1e-9, 'tvd0 from the minimum-curvature trajectory');
        if (i) near(assert, s.md0, sg[i - 1].md1, 1e-9, 'contiguous');
        assert.ok(s.inc >= s.incMin - 1e-6 && s.inc <= s.incMax + 1e-6, 'average inclination inside the segment range');
        assert.ok(s.incMax - s.incMin <= 5 + 1e-6, 'inclination change per segment ≤ 5° (' + (s.incMax - s.incMin) + ')');
        const mid = (s.md0 + s.md1) / 2, idx = mid > 9850 ? 6.276 : mid > 5000 ? 2.441 : 2.992;
        assert.strictEqual(s.id, idx, 'bore at ' + mid);
        assert.ok(!('area' in s), 'tubing path: no area override');
        assert.ok(/ft MD$/.test(s.name), 'segment name');
      });
      near(assert, sumBy(sg, (s) => s.len), 9950, 1e-6, 'Σ length = mid-perf MD (friction on MD)');
      near(assert, sumBy(sg, (s) => s.dz), W.nodes.midPerfTvd, 1e-6, 'Σ dz = mid-perf TVD (hydrostatic on TVD)');
      const hold = sg.find((s) => s.md1 >= 3500 - 1e-6 && s.md0 <= 6000 + 1e-6);
      near(assert, hold.inc, 30, 1e-9, 'tangent section at 30°');
      // closed form of the S-shape: TVD = 10,000 − 2·(1,500 − R sin 30°)·… → check the build + hold + drop TVD against the arcs
      const R = 18000 / (Math.PI * 2), tvdBuild = R * Math.sin(30 * deg), tvdHold = 2500 * Math.cos(30 * deg);
      near(assert, W.tvdAt(10000), 2000 + tvdBuild + tvdHold + tvdBuild + 2500, 0.01, 'TVD at TD (S-shape closed form)');
      // a finer dogleg limit gives more segments; a sub-range; downward flow
      const fine = G.WTS_wp_well.segmentsFor(W, { maxDoglegDeg: 2 });
      assert.ok(fine.length > sg.length && fine.every((s) => s.incMax - s.incMin <= 2 + 1e-6), 'finer: ' + fine.length);
      const sub = plain(G.WTS_wp_well.segmentsFor(W, { from: 9950, toMd: 5000 }));
      near(assert, sumBy(sub, (s) => s.len), 4950, 1e-6, 'sub-range length');
      assert.ok(sub.every((s) => s.id !== 2.992), 'sub-range below the taper');
      const down = plain(G.WTS_wp_well.segmentsFor(W, { from: 0, toMd: 9950 }));
      assert.ok(down[0].md0 === 0 && down.every((s) => s.md1 > s.md0 && s.dz < 0), 'downward flow: md rises, dz < 0');
      near(assert, sumBy(down, (s) => s.dz), -W.nodes.midPerfTvd, 1e-6, 'downward Σ dz');
      // the vertical oil well: two segments (casing below the shoe, tubing above), inclination 0
      const O = S.FIX.oilWell, W0 = G.WTS_wp_well.build(O.well, { res: O.res });
      assert.deepStrictEqual(plain(W0.segments).map((s) => [s.md0, s.md1, s.id, s.dz, s.inc]), [[8000, 7950, 6.276, 50, 0], [7950, 0, 2.441, 7950, 0]]);
      // xToMd: distance along the flow → MD (from the inlet, or from the top for a top-down march)
      near(assert, W0.xToMd(50), 7950, 1e-9, 'x from the inlet'); near(assert, W0.xToMd(100, { fromTop: true }), 100, 1e-9, 'x from the top');
      near(assert, W.mdAt(W.tvdAt(4321)), 4321, 1e-4, 'mdAt inverse');
    },
  },
  {
    name: 'WW4 annulus path: hydraulic diameter D_ci − d_to and flow area π/4(D_ci² − d_to²), casing bore below the tubing shoe; no casing around the tubing → ANNULUS_NO_CASING',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, O = S.FIX.oilWell;
      O.well.path = 'annulus';
      O.well.strings.push({ kind: 'casing', tubKey: null, id: 6.276, od: 7, wall: 0.362, rough: 0.0006, topMd: 0, botMd: 7950 });
      const W = G.WTS_wp_well.build(O.well, { res: O.res });
      assert.ok(W.ok, JSON.stringify(plain(W.errors)));
      const sg = plain(W.segments);
      assert.strictEqual(sg.length, 2);
      assert.deepStrictEqual([sg[0].id, sg[0].kind, 'area' in sg[0]], [6.276, 'casing', false], 'below the shoe: the casing bore');
      near(assert, sg[1].id, 6.276 - 2.875, 1e-12, 'hydraulic diameter');
      near(assert, sg[1].area, Math.PI / 4 * (6.276 * 6.276 - 2.875 * 2.875), 1e-9, 'annular flow area (in²)');
      assert.strictEqual(sg[1].kind, 'annulus');
      // the tubing path of the same well ignores the casing above the shoe
      const tub = plain(G.WTS_wp_well.segmentsFor(W, { path: 'tubing' }));
      assert.strictEqual(tub[1].id, 2.441, 'tubing path override');
      // annulus without a casing around the tubing
      const O2 = S.FIX.oilWell; O2.well.path = 'annulus';
      const bad = G.WTS_wp_well.build(O2.well, { res: O2.res });
      assert.ok(bad.ok === false && bad.code === 'ANNULUS_NO_CASING', 'error: ' + bad.code);
    },
  },
  {
    name: 'WW5 restrictions: applied at the flow inlet of the segment above them (β = d / bore), rows below the perforations or not smaller than the bore are not applied; the WP0b marcher takes the loss on these segments',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, O = S.FIX.oilWell;
      O.well.restrictions = [{ kind: 'sssv', md: 1000, id: 1.875 }, { kind: 'nipple', md: 7900, id: 2.25, k: 0.8 },
        { kind: 'xo', md: 3000, id: 3.0 }, { kind: 'nipple', md: 9000, id: 1.5 }, { kind: 'bogus', md: 500, id: 2.0 }, { kind: 'sssv', md: null, id: 1 }];
      const W = G.WTS_wp_well.build(O.well, { res: O.res });
      assert.ok(W.ok);
      const sg = plain(W.segments), rs = plain(G.WTS_wp_well.restrictions(W));
      const with_ = sg.filter((s) => s.restr);
      assert.deepStrictEqual(with_.map((s) => [s.md0, s.restr.d, s.restr.k]), [[7900, 2.25, 0.8], [1000, 1.875, null], [500, 2, null]], 'restrictions at the segment inlets');
      assert.ok(sg.some((s) => s.md0 === 3000 && !s.restr), 'the 3 in crossover in 2.441 in tubing is not a restriction');
      assert.deepStrictEqual(rs.map((r) => [r.kind, r.md, r.applied]), [['nipple', 500, true], ['sssv', 1000, true], ['xo', 3000, false], ['nipple', 7900, true], ['nipple', 9000, false]]);
      near(assert, rs[1].beta, 1.875 / 2.441, 1e-12, 'β of the SSSV'); near(assert, rs[1].tvd, 1000, 1e-9, 'TVD');
      assert.strictEqual(rs[0].label, 'Nipple', 'an unknown kind is a nipple');
      const wc = codes(W);
      assert.ok(wc.includes('RESTR_NOT_SMALLER') && wc.includes('RESTR_DROPPED'), wc.join(','));
      // the marcher takes these segments as they are (flow order, restriction at the inlet)
      const fluid = { qo: 700, qw: 300, qg: 0.35, api: 35, sgg: 0.65, sgw: 1.07 };
      const r = G.WTS_flowline_march(W.segments, fluid, 3500, 200, 120, { stepFt: 100, rough: W.rough });
      assert.ok(r && r.pOut != null, 'march ok');
      const segOut = r.segments.filter((x) => x.dpRestr > 0);
      assert.strictEqual(segOut.length, 3, 'three restriction losses');
      const ssv = segOut.find((x) => Math.abs(x.restr.d - 1.875) < 1e-12);
      const b2 = Math.pow(1.875 / 2.441, 2);
      near(assert, ssv.restr.K, 0.5 * (1 - b2) + (1 - b2) * (1 - b2), 1e-12, 'default K');
      near(assert, sumBy(r.segments, (x) => x.dz), 8000, 1e-6, 'Σ dz through the marcher');
    },
  },
  {
    name: 'WW6 checks: warning codes (string dropped / overlap / not inside / gap, mid-perf default and outside, survey extrapolated, high DLS, gauge below mid-perf, deviated sections) and errors (no strings, no depth)',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, B = G.WTS_wp_well.build;
      const W1 = B({ survey: [], strings: [{ kind: 'tubing', id: 2.441, od: 2.875, topMd: 0, botMd: 4000 }, { kind: 'tubing', id: 1.995, od: 2.375, topMd: 3500, botMd: 6000 },
        { kind: 'casing', id: 2.0, od: 7, topMd: 0, botMd: 2000 }, { kind: 'tubing', id: 3, od: 2, topMd: 0, botMd: 10 }],
        perfTopMd: 6500, perfBotMd: 6600, midPerfMd: 7000 }, { res: { T_F: 180 }, gauges: [7200] });
      assert.ok(W1.ok);
      ['NO_SURVEY', 'STRING_DROPPED', 'STRING_OVERLAP', 'TUBING_NOT_INSIDE', 'STRING_GAP', 'MIDPERF_OUTSIDE', 'GAUGE_BELOW_MIDPERF', 'NO_THT'].forEach((c) =>
        assert.ok(codes(W1).includes(c), c + ' in ' + codes(W1).join(',')));
      const ns = plain(W1.warnings).find((w) => w.code === 'NO_SURVEY');
      assert.strictEqual(ns.sev, 'info');
      const W2 = B({ survey: [[0, 0, 0], [1000, 0, 0], [1500, 60, 90]], strings: [{ kind: 'tubing', id: 2.441, od: 2.875, topMd: 0, botMd: 3000 }] }, { res: { T_F: 180 } });
      assert.ok(W2.ok && W2.nodes.midPerfSource === 'default' && W2.nodes.midPerfMd === 3000, 'mid-perf default = deepest string');
      ['MIDPERF_DEFAULT', 'SURVEY_EXTRAPOLATED', 'HIGH_DLS'].forEach((c) => assert.ok(codes(W2).includes(c), c));
      const dev = plain(W2.deviated);
      assert.ok(dev.length === 1 && dev[0].md1 === 3000 && Math.abs(dev[0].incMax - 60) < 1e-9 && dev[0].md0 > 1000 && dev[0].md0 < 1500, 'one deviated section: ' + JSON.stringify(dev));
      near(assert, W2.tvdAt(3000) - W2.tvdAt(1500), 1500 * Math.cos(60 * deg), 1e-9, 'tangent below the last station');
      const e1 = B({ survey: [], strings: [], midPerfMd: 5000 }, {});
      assert.ok(e1.ok === false && e1.code === 'NO_STRINGS', 'no strings');
      const e2 = B({ survey: [], strings: [] }, {});
      assert.ok(e2.ok === false && e2.errors.length === 2, 'no strings and no depth');
      assert.strictEqual(B(null).ok, false, 'null well');
      // perforations swapped, mid-perf from the perforations
      const W3 = B({ strings: [{ kind: 'tubing', id: 2.441, od: 2.875, topMd: 0, botMd: 8000 }], perfTopMd: 8100, perfBotMd: 7900 }, { res: { T_F: 190 } });
      assert.ok(W3.ok && W3.nodes.midPerfMd === 8000 && W3.nodes.midPerfSource === 'perfs' && codes(W3).includes('PERF_ORDER'));
    },
  },
  {
    name: 'WW7 DFIT geometry import: WTS_wp_model.fromDfit → build — [md, tvd] survey, strings and the mid-perforations from the DFIT datum',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, dg = S.FIX.dfitGeometry;
      const imp = G.WTS_wp_model.fromDfit(dg.test);
      assert.ok(imp.ok, 'import');
      const well = Object.assign(S.FIX.oilWell.well, plain(imp.patch), { midPerfMd: imp.scalars.wp_midPerf, perfTopMd: null, perfBotMd: null });
      const W = G.WTS_wp_well.build(well, { res: { T_F: 220 } });
      assert.ok(W.ok, JSON.stringify(plain(W.errors)));
      assert.strictEqual(W.survey.kind, 'tvd');
      near(assert, W.nodes.midPerfTvd, 9000, 1e-9, 'datum TVD');
      const sg = plain(W.segments);
      assert.deepStrictEqual(sg.map((s) => [s.md0, s.md1, s.id]), [[9500, 9400, 6.184], [9400, 3000, 2.992], [3000, 0, 2.992]]);
      near(assert, sg[1].inc, Math.acos(6000 / 6500) / deg, 1e-9, 'inclination of the [md, tvd] interval');
      near(assert, sg[2].inc, 0, 1e-12, 'vertical top');
      assert.strictEqual(sg[0].kind, 'casing', 'the DFIT string below 9,400 ft maps to casing');
      near(assert, W.stations[W.stations.length - 1].dep, Math.sqrt(6500 * 6500 - 6000 * 6000), 1e-9, 'along-hole departure without azimuth');
      assert.strictEqual(W.survey.aziKnown, false);
    },
  },
  {
    name: 'WW8 roughness: WTS_tubulars.roughness defaults (new steel / wells 0.0006 in, used / lines 0.0018 in, coated and CRA 0.0002 in); a string without rough takes the well default; the march roughness is length-weighted',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, T = G.WTS_tubulars;
      assert.strictEqual(typeof T.roughness, 'function');
      assert.deepStrictEqual([T.roughness('well'), T.roughness('newSteel'), T.roughness('line'), T.roughness('usedTubing'), T.roughness('plasticCoated'), T.roughness('cra'), T.roughness('?'), T.roughness()],
        [0.0006, 0.0006, 0.0018, 0.0018, 0.0002, 0.0002, 0.0006, 0.0006]);
      assert.ok(Object.isFrozen(T.roughness.TABLE), 'frozen table');
      assert.strictEqual(T.find('tubing-2.875-6.5').rough, undefined, 'catalogue rows carry no rough');
      const W = G.WTS_wp_well.build({ midPerfMd: 8000, strings: [{ kind: 'tubing', tubKey: 'tubing-2.875-6.5', topMd: 0, botMd: 4000 },
        { kind: 'tubing', id: 2.441, od: 2.875, rough: 0.0018, topMd: 4000, botMd: 8000 }] }, { res: { T_F: 200 } });
      assert.ok(W.ok);
      const st = plain(W.strings);
      assert.deepStrictEqual(st.map((s) => [s.id, s.rough, s.roughSrc]), [[2.441, 0.0006, 'default'], [2.441, 0.0018, 'string']], 'catalogue ID, default roughness');
      near(assert, W.rough, (4000 * 0.0006 + 4000 * 0.0018) / 8000, 1e-15, 'length-weighted');
      assert.ok(codes(W).includes('ROUGH_MIXED'));
      assert.deepStrictEqual(plain(W.segments).map((s) => s.rough), [0.0018, 0.0006], 'segment roughness');
    },
  },
  {
    name: 'WW9 schematic: trajectory (MD / TVD / vertical section / plan N-E), strings outermost first with the flow path marked, perfs, gauges, choke; hover readout from a solution profile and heat-map ranges',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, M = S.FIX.gasWell;
      const W = G.WTS_wp_well.build(M.well, { res: M.res, fluidType: M.fluid.type, gauges: [9800], surface: M.surface });
      const sc0 = G.WTS_wp_well.schematic(W, null);
      assert.ok(sc0.ok && sc0.trajectory.length > 50 && sc0.trajectory.length <= 420, 'trajectory points ' + sc0.trajectory.length);
      near(assert, sc0.vsAzi, 120, 1e-6, 'vertical section along the closure azimuth');
      const tr = plain(sc0.trajectory);
      tr.forEach((p) => near(assert, p.vs, p.dep, 1e-6, 'constant azimuth: VS = departure'));
      near(assert, sc0.extents.tvdMax, W.tvdAt(10100), 1e-6, 'extents');
      assert.ok(sc0.extents.eMax > 0 && sc0.extents.nMin < 0, 'plan view: azimuth 120° → south-east');
      const st = plain(sc0.strings);
      assert.ok(st[0].od >= st[st.length - 1].od, 'outermost first');
      assert.ok(st.every((s) => s.inFlow), 'all three strings carry flow here');
      assert.deepStrictEqual([sc0.perfs.topMd, sc0.perfs.midMd, sc0.perfs.botMd], [9900, 9950, 10000]);
      assert.ok(sc0.gauges.length === 1 && sc0.gauges[0].md === 9800);
      assert.deepStrictEqual(plain(sc0.choke), { present: true, bean64: 24 });
      assert.deepStrictEqual(plain(sc0.props), ['t'], 'without a solution only the temperature colours the well');
      // a solution traverse (the R.traverse.profile contract carries md / tvd / inc)
      const prof = [];
      for (let md = 0; md <= 9950; md += 50) prof.push({ md, tvd: W.tvdAt(md), inc: W.at(md).inc, p: 1500 + 0.15 * md, t: 140 + md * 0.009, hl: 0.05 + md * 1e-5, vm: 40 - md * 0.002, pattern: md > 5000 ? 'distributed' : 'intermittent' });
      const R = { traverse: { profile: prof }, surface: { thp: 1500, tht: 140, thtHyd: 110, choke: { regime: 'critical', ratio: 0.4 } } };
      const sc = G.WTS_wp_well.schematic(W, R);
      ['p', 't', 'hl', 'vm', 'pattern'].forEach((k) => assert.ok(sc.props.includes(k), k));
      near(assert, sc.ranges.p[0], 1500, 1e-9, 'p min'); near(assert, sc.ranges.p[1], 1500 + 0.15 * 9950, 1e-9, 'p max');
      const h = sc.at(4025);
      near(assert, h.p, 1500 + 0.15 * 4025, 1e-9, 'hover p'); near(assert, h.tvd, W.tvdAt(4025), 1e-9, 'hover TVD');
      near(assert, h.inc, 30, 1e-6, 'hover inclination'); near(assert, h.hl, 0.05 + 4025e-5, 1e-12, 'hover holdup');
      assert.ok(/2\.992 in/.test(h.string), 'hover string: ' + h.string);
      near(assert, sc.norm('p', 1500), 0, 1e-12, 'norm low'); assert.strictEqual(sc.norm('nope', 1), null);
      assert.deepStrictEqual(plain(sc.surface), { thp: 1500, tht: 140, thtHyd: 110 });
      assert.strictEqual(sc.choke.regime, 'critical');
      assert.strictEqual(G.WTS_wp_well.schematic(null).ok, false);
    },
  },
];
