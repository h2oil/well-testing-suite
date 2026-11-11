// Well Performance identity guards — docs/WELL-PERFORMANCE-PLAN.md §2.3, D3 (WP0b; FI7 / FI8 are extended by WP2).
//
// The shared engines the module edits must give today's output bit for bit when no new option is used. Each test runs the same
// vectors in two apps: the app built from the current sources and an app whose engine files are the FROZEN v4.2 copies in
// tests/_wp-v42/ (master a3e87c3; never edit them), and deep-compares the FULL outputs with Object.is on every number.
//   FI1 flowline page + WTS_flowline_compute (well routes, coupled heat) + WTS_flowline_march (forward / reverse / refine / accel)
//   FI2 flare routes (PCV, flare line, choked exit) through WTS_flowline_compute
//   FI3 gas-lift design page (it marches with WTS_flowline_march)
//   FI4 Choke Performance engines and page
//   FI5 WTS_wellbore column / tempProfile static | displaced (and ramey → NOT_AVAILABLE kept: _ramey stays DFIT 3.4b's) / hydrostatic
//   FI6 WTS_tubulars catalogue
//   FI7 Oil Well IPR page / WTS_oilipr_compute; FI8 Gas Well Deliverability page / WTS_gasdeliv_compute
//   FI9 the new marcher options at their neutral values reproduce the default output; unknown correlation key; grid replay;
//       detail fields; restriction loss by hand; holdup / friction multipliers; fluid.pvt neutral and the (p, T) table
//   FIT timing: one fine evaluation E (10,000 ft, 100 ft steps) measured and reported against BASELINE (no gate here; WP11 gates)
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('./_wellperf-shapes');

const WP = 'WP0b';
const OLD_DIR = path.join(__dirname, '_wp-v42');
const OLD_FILES = ['49-calc-flowline.js', '49-calc-chokeperf.js', '48-calc-wellbore.js', '40-calc-tubulars.js', '42-calc-oilipr.js',
  '41-calc-gasdeliv.js', '49-calc-gaslift.js'];
let _old = null;
function oldApp(ctx) {
  if (_old) return _old;
  const ov = {};
  OLD_FILES.forEach((f) => { ov[f] = fs.readFileSync(path.join(OLD_DIR, f), 'utf8'); });
  _old = ctx.loadApp({ sourceOverrides: ov });
  return _old;
}
const newApp = (ctx) => S.sharedApp(ctx);   // the built page under --html, the sources otherwise

// canonical form: Object.is on numbers (−0, NaN and Infinity kept apart), key order ignored, 'ts' (clock) skipped, functions named
function canon(x, seen, skip) {
  seen = seen || new Set();
  if (typeof x === 'number') return Object.is(x, -0) ? '-0' : String(x);
  if (x === null || x === undefined || typeof x === 'boolean' || typeof x === 'string') return JSON.stringify(x === undefined ? '__undef__' : x);
  if (typeof x === 'function') return '"fn"';
  if (seen.has(x)) return '"cycle"';
  seen.add(x);
  let out;
  if (Array.isArray(x) || (x && typeof x.length === 'number' && typeof x !== 'string' && ArrayBuffer.isView(x))) out = '[' + Array.from(x).map((v) => canon(v, seen, skip)).join(',') + ']';
  else out = '{' + Object.keys(x).filter((k) => k !== 'ts' && !(skip && skip.includes(k))).sort().map((k) => JSON.stringify(k) + ':' + canon(x[k], seen, skip)).join(',') + '}';
  seen.delete(x);
  return out;
}
function same(assert, a, b, what, skip) {
  const ca = canon(a, null, skip), cb = canon(b, null, skip);
  if (ca === cb) return;
  let i = 0; while (i < ca.length && ca[i] === cb[i]) i++;
  assert.fail(what + ' differs at char ' + i + ':\n  new: …' + ca.slice(Math.max(0, i - 120), i + 80) + '\n  old: …' + cb.slice(Math.max(0, i - 120), i + 80));
}
function pageState(app, route, key) {
  app.hook.nav(route);
  app.flush(50);
  const st = app.win.WTS_state && app.win.WTS_state[key];
  return st ? JSON.parse(JSON.stringify(st, (k, v) => (typeof v === 'number' && !isFinite(v) ? String(v) : v))) : st;
}

const FL = { qo: 800, qw: 400, qg: 0.3, api: 35, sgg: 0.7, sgw: 1.07 };
const GAS5 = { qo: 0, qw: 0, qg: 5, api: 35, sgg: 0.65, sgw: 1.0, pwh: 600, t0: 100, t1: 100, psep: 250, rough: 0.0018, payne: true, accel: true,
  well: [{ name: 'Choke to separator', len: 100, id: 3.826, dz: 0 }],
  flare: [{ name: 'PCV to knock-out drum', len: 300, id: 3.826, dz: 0 }, { name: 'Flare line', len: 200, id: 3.826, dz: 0 }] };
const OIL = { qo: 1500, qw: 500, qg: 1.2, api: 32, sgg: 0.72, sgw: 1.05, pwh: 900, t0: 140, t1: 110, psep: 150, rough: 0.0018, payne: true, accel: false,
  well: [{ name: 'Manifold', len: 60, id: 2.9, dz: 0 }, { name: 'Heater', len: 300, id: 2.624, dz: 0 }, { name: 'Line', len: 1200, id: 3.826, dz: 15 }],
  flare: [{ name: 'Flare line', len: 400, id: 3.826, dz: 0 }] };
const HEAT = Object.assign({}, OIL, { tmode: 'heat', tair: 60, wind: 10, wall: 0.3, ins: 0, kp: 26, kins: 0.025, cpo: 0.5, cpw: 1, cpg: 0.55, jt: 0.07 });
const CHOKED = Object.assign({}, GAS5, { qg: 40, flare: [{ name: 'Flare line', len: 300, id: 2.9, dz: 0 }] });
const MARCH = [
  [[{ len: 8000, id: 2.441, dz: 8000 }], FL, 200, 80, 200, { reverse: true }],
  [[{ len: 8000, id: 2.441, dz: 8000 }], FL, 200, 80, 200, { reverse: true, refine: true, accel: true }],
  [[{ len: 3000, id: 2.992, dz: 2900 }, { len: 5000, id: 2.441, dz: 4000 }], FL, 2500, 200, 120, {}],
  [[{ len: 20000, id: 2.441, dz: 20000 }], FL, 200, 80, 200, { reverse: true }],
  [[{ len: 2000, id: 3, dz: 0 }], { qo: 0, qw: 0, qg: 8, api: 35, sgg: 0.65, sgw: 1 }, 300, 80, 80, { accel: true, refine: true, payne: false, rough: 0.0006 }],
];

module.exports = [
  {
    name: 'FI1 flowline: page output, WTS_flowline_compute (well routes, coupled heat) and WTS_flowline_march (5 vectors) equal the frozen v4.2 engine bit for bit',
    wp: WP,
    opts: false,
    timeoutMs: 120000,
    run(_a, assert, ctx) {
      const A = newApp(ctx), B = oldApp(ctx);
      assert.ok(A.win.WTS_flowline_corr && !B.win.WTS_flowline_corr, 'the frozen v4.2 engine is the one in the second app');
      same(assert, pageState(A, 'flowline', 'flowline'), pageState(B, 'flowline', 'flowline'), 'flowline page state');
      [OIL, HEAT].forEach((v, i) => same(assert, A.win.WTS_flowline_compute(v), B.win.WTS_flowline_compute(v), 'compute #' + i));
      MARCH.forEach((m, i) => same(assert, A.win.WTS_flowline_march.apply(null, m), B.win.WTS_flowline_march.apply(null, m), 'march #' + i));
      same(assert, A.win.WTS_flowline_props(FL, 1500, 150), B.win.WTS_flowline_props(FL, 1500, 150), 'props');
      same(assert, A.win.WTS_flowline_bb({ vsl: 3.97, vsg: 3.86, d: 6, rhoL: 47.61, rhoG: 5.88, muL: 0.97, muG: 0.016, sigma: 8.41, theta: 90, rough: 0.00072, p: 1700 }),
        B.win.WTS_flowline_bb({ vsl: 3.97, vsg: 3.86, d: 6, rhoL: 47.61, rhoG: 5.88, muL: 0.97, muG: 0.016, sigma: 8.41, theta: 90, rough: 0.00072, p: 1700 }), 'bb');
    },
  },
  {
    name: 'FI2 flare: PCV, flare line and a choked flare exit through WTS_flowline_compute equal the frozen v4.2 engine bit for bit',
    wp: WP,
    opts: false,
    timeoutMs: 120000,
    run(_a, assert, ctx) {
      const A = newApp(ctx), B = oldApp(ctx);
      [GAS5, CHOKED, Object.assign({}, GAS5, { psvset: '' })].forEach((v, i) => same(assert, A.win.WTS_flowline_compute(v), B.win.WTS_flowline_compute(v), 'flare compute #' + i));
    },
  },
  {
    name: 'FI3 gas lift: the design page and WTS_gaslift_compute (they march with WTS_flowline_march) equal the frozen v4.2 engines',
    wp: WP,
    opts: false,
    timeoutMs: 120000,
    run(_a, assert, ctx) {
      const A = newApp(ctx), B = oldApp(ctx);
      const a = pageState(A, 'gaslift', 'gaslift'), b = pageState(B, 'gaslift', 'gaslift');
      assert.ok(a && a.ok, 'gas-lift page solved');
      same(assert, a, b, 'gas-lift page state');
    },
  },
  {
    name: 'FI4 chokes: Choke Performance page and the multiphase / gas rate engines equal the frozen v4.2 engine',
    wp: WP,
    opts: false,
    timeoutMs: 120000,
    run(_a, assert, ctx) {
      const A = newApp(ctx), B = oldApp(ctx);
      same(assert, pageState(A, 'chokeperf', 'chokeperf'), pageState(B, 'chokeperf', 'chokeperf'), 'chokeperf page');
      same(assert, A.win.WTS_chokeperf_CORR, B.win.WTS_chokeperf_CORR, 'CORR');
      const mp = (W) => Object.keys(W.WTS_chokeperf_CORR).map((k) => { try { return W.WTS_chokeperf_multiphaseRate({ corr: k, p1: 1200, s64: 32, glr: 800, s: 32, d64: 32 }); } catch (e) { return 'threw ' + e.message; } });
      same(assert, mp(A.win), mp(B.win), 'multiphaseRate');
    },
  },
  {
    name: 'FI5 wellbore: column, tempProfile static / displaced, hydrostatic equal the frozen v4.2 engine; tempProfile ramey stays NOT_AVAILABLE (_ramey is DFIT 3.4b\'s)',
    wp: WP,
    opts: false,
    timeoutMs: 120000,
    run(_a, assert, ctx) {
      const A = newApp(ctx).win.WTS_wellbore, B = oldApp(ctx).win.WTS_wellbore;
      const spec = { datumTvd: 10000, survey: [[0, 0], [4000, 4000], [10400, 10000]], strings: [{ tubKey: null, id: 2.992, od: 3.5, wall: 0.254, topMd: 0, botMd: 10400 }] };
      const ca = A.column(spec), cb = B.column(spec);
      same(assert, ca, cb, 'column');
      same(assert, A.tempProfile(ca, { model: 'static' }), B.tempProfile(cb, { model: 'static' }), 'static');
      same(assert, A.tempProfile(ca, { model: 'displaced', Vinj: 50, t: 0, tInjF: 70 }), B.tempProfile(cb, { model: 'displaced', Vinj: 50, t: 0, tInjF: 70 }), 'displaced');
      same(assert, A.hydrostatic(7600, 10000, 0, ca, null), B.hydrostatic(7600, 10000, 0, cb, null), 'hydrostatic');
      assert.strictEqual(A.tempProfile(ca, { model: 'ramey' }).code, 'NOT_AVAILABLE', 'Ramey belongs to DFIT 3.4b');
      assert.ok(!A._ramey, 'WTS_wellbore._ramey is not defined by this module');
    },
  },
  {
    name: 'FI6 tubulars: the WTS_tubulars catalogue equals the frozen v4.2 data (find(key).rough stays undefined)',
    wp: WP,
    opts: false,
    timeoutMs: 120000,
    run(_a, assert, ctx) {
      const A = newApp(ctx).win.WTS_tubulars, B = oldApp(ctx).win.WTS_tubulars;
      const strip = (T) => { const o = {}; Object.keys(T).filter((k) => k !== 'roughness').forEach((k) => { o[k] = T[k]; }); return o; };
      same(assert, strip(A), strip(B), 'WTS_tubulars');
      const keys = (A.list ? A.list() : []).slice(0, 5).map((x) => (x && x.key) || x);
      keys.forEach((k) => assert.strictEqual(A.find && A.find(k) && A.find(k).rough, undefined, k + ': no rough on the catalogue row'));
    },
  },
  {
    name: 'FI7 / FI8 inflow: Oil Well IPR and Gas Well Deliverability pages (WTS_oilipr_compute / WTS_gasdeliv_compute) equal the frozen v4.2 engines',
    wp: WP,
    opts: false,
    timeoutMs: 120000,
    run(_a, assert, ctx) {
      const A = newApp(ctx), B = oldApp(ctx);
      const oa = pageState(A, 'oilipr', 'oilipr'), ob = pageState(B, 'oilipr', 'oilipr');
      assert.ok(oa && oa.ok, 'oil IPR solved'); same(assert, oa, ob, 'oilipr page');
      const ga = pageState(A, 'gasdeliv', 'gasdeliv'), gb = pageState(B, 'gasdeliv', 'gasdeliv');
      assert.ok(ga && ga.ok, 'gas deliverability solved'); same(assert, ga, gb, 'gasdeliv page');
    },
  },
  {
    name: 'FI9 marcher options (WP0b): neutral values = default; unknown key; grid replay = cold; detail; restriction Δp by hand; holdup / friction multipliers; fluid.pvt neutral and the (p, T) table',
    wp: WP,
    opts: false,
    timeoutMs: 120000,
    run(_a, assert, ctx) {
      const W = newApp(ctx).win, M = W.WTS_flowline_march;
      const seg = [{ len: 8000, id: 2.441, dz: 8000 }], o0 = { reverse: true, refine: true };
      const base = M(seg, FL, 200, 80, 200, o0);
      // neutral values give today's output exactly
      same(assert, M(seg, FL, 200, 80, 200, Object.assign({ corr: 'bb', stepFt: 50, eroC: 100, mult: { hl: 1, f: 1 } }, o0)), base, 'neutral options');
      const PVTX = ['pb', 'sgGas', 'pvt'];   // the fields the pvt path adds to the props object
      same(assert, M(seg, Object.assign({ pvt: {} }, FL), 200, 80, 200, o0), base, 'empty fluid.pvt', PVTX);
      same(assert, M(seg, Object.assign({ pvt: { corr: { rs: 'standing', bo: 'standing', muod: 'beggsRobinson', muo: 'beggsRobinson', z: 'dranchukAbouKassem', mug: 'leeGonzalezEakin' }, pbFactor: 1 } }, FL), 200, 80, 200, o0), base, 'explicit default correlation keys', PVTX);
      // registry
      assert.ok(W.WTS_flowline_corr && W.WTS_flowline_corr.bb && W.WTS_flowline_corr.bb.verified === true, 'bb registered');
      const bad = M(seg, FL, 200, 80, 200, { corr: 'nope' });
      assert.ok(bad && bad.ok === false && bad.code === 'UNKNOWN_CORR', 'unknown key');
      // step length and grid
      const s100 = M(seg, FL, 200, 80, 200, { reverse: true, stepFt: 100 });
      assert.strictEqual(s100.profile.length - 1, 80, '8,000 ft at 100 ft = 80 steps');
      assert.ok(Math.abs(s100.pOut - base.pOut) < 2, 'step convergence (|Δ| < 2 psi): ' + (s100.pOut - base.pOut));
      const rec = M(seg, FL, 200, 80, 200, Object.assign({ grid: true }, o0));
      assert.ok(rec.grid && rec.grid.segs.length === 1 && rec.grid.segs[0].n === 160 && rec.grid.segs[0].m.length === 160, 'grid recorded');
      const { grid, ...recNoGrid } = rec;
      same(assert, recNoGrid, base, 'recording does not change the march');
      const fl2 = Object.assign({}, FL, { qo: 900 });
      same(assert, M(seg, fl2, 200, 80, 200, Object.assign({ grid: rec.grid }, o0)), M(seg, fl2, 200, 80, 200, Object.assign({ grid: rec.grid }, o0)), 'frozen grid deterministic');
      const frozen = M(seg, fl2, 200, 80, 200, Object.assign({ grid: rec.grid }, o0));
      assert.ok(frozen.profile.length === rec.profile.length, 'the frozen layout is used at another rate');
      // detail
      const d = M(seg, FL, 200, 80, 200, { reverse: true, detail: true, eroC: 125 });
      const p1 = d.profile[5];
      ['seg', 'vm', 'vsl', 'vsg', 'rhoS', 'gradEl', 'gradF', 'gradAcc', 'ero'].forEach((k) => assert.ok(typeof p1[k] === 'number', 'detail.' + k));
      const d0 = M(seg, FL, 200, 80, 200, { reverse: true });
      assert.ok(Math.abs(d.segments[0].eroMax / d0.segments[0].eroMax - 100 / 125) < 1e-12, 'eroC scales the erosional ratio');
      same(assert, d.profile.map((q) => [q.x, q.p, q.t]), d0.profile.map((q) => [q.x, q.p, q.t]), 'detail and eroC leave the traverse unchanged');
      // restriction at the flow inlet of the upper segment (a 1.875 in nipple at 4,000 ft): Δp = K·ρn·v²/(2·gc·144)
      const two = [{ len: 4000, id: 2.441, dz: 4000 }, { len: 4000, id: 2.441, dz: 4000, restr: { d: 1.875 } }];
      const f = M(two, FL, 2600, 200, 80, { detail: true });
      const ev = f.profile.find((q) => q.restr), sg = f.segments[1];
      assert.ok(ev && sg.dpRestr > 0 && Math.abs(ev.dp - sg.dpRestr) < 1e-12, 'restriction booked');
      const beta = 1.875 / 2.441, K = 0.5 * (1 - beta * beta) + Math.pow(1 - beta * beta, 2);
      assert.ok(Math.abs(sg.restr.K - K) < 1e-12 && Math.abs(sg.restr.beta - beta) < 1e-12, 'K from β');
      const ev0 = f.profile[f.profile.indexOf(ev) - 1];
      assert.ok(sg.restr.v > 0 && ev0 && Math.abs((ev0.p - ev.p) - sg.dpRestr) < 1e-9, 'the pressure steps down by Δp at the restriction (forward march)');
      const fr = M(two.map((x) => ({ len: x.len, id: x.id, dz: x.dz })), FL, 2600, 200, 80, {});
      assert.ok(Math.abs((fr.pOut - f.pOut) - sg.dpRestr) < 5, 'outlet lower by about the restriction loss');
      // multipliers: holdup ×1.2 raises the elevation gradient, clamp at λL; friction ×1.5 raises the friction loss
      const h = M(seg, FL, 200, 80, 200, { reverse: true, mult: { hl: 1.2, f: 1 } });
      assert.ok(h.pOut > base.pOut, 'more holdup → higher bottom-hole pressure');
      const lo = M(seg, FL, 200, 80, 200, { reverse: true, mult: { hl: 0.01, f: 1 } });
      const nsl = W.WTS_flowline_bb({ vsl: 1, vsg: 1, d: 2.441, rhoL: 50, rhoG: 5, muL: 1, muG: 0.015, sigma: 20, theta: 90, rough: 0.0006, p: 1000 });
      assert.ok(lo.pOut < base.pOut && nsl.hl >= nsl.lambdaL, 'holdup clamped at λL (no-slip lower bound)');
      const fm = M(seg, FL, 200, 80, 200, { reverse: true, mult: { hl: 1, f: 1.5 } });
      assert.ok(fm.segments[0].dpF > base.segments[0].dpF * 1.4, 'friction ×1.5');
      // fluid.pvt: wet gas (Rs = 0, all gas free), lift gas (free gas only), the (p, T) table within 0.05 % in BHP
      const wet = W.WTS_flowline_props({ qo: 100, qw: 10, qg: 5, api: 55, sgg: 0.65, sgw: 1.07, pvt: { liquidNoTransfer: true, bc: 1 } }, 2000, 180);
      assert.ok(wet.rs === 0 && wet.bo === 1 && Math.abs(wet.freeGas - 5e6) < 1e-6, 'wet gas: Rs 0, Bc 1, all gas free');
      const inj = W.WTS_flowline_props(Object.assign({ pvt: { injGas: { qg_MMscfd: 1, sg: 0.65 } } }, FL), 1000, 150);
      const noi = W.WTS_flowline_props(Object.assign({ pvt: {} }, FL), 1000, 150);
      assert.ok(Math.abs(inj.freeGas - noi.freeGas - 1e6) < 1e-6 && inj.rs === noi.rs, 'lift gas adds free gas only');
      const tab = M(seg, Object.assign({ pvt: { table: true } }, FL), 200, 80, 200, o0);
      assert.ok(Math.abs(tab.pOut - base.pOut) / (base.pOut + 14.696) < 5e-4, 'binned PVT within 0.05 % in BHP: ' + tab.pOut + ' vs ' + base.pOut);
      const us = W.WTS_flowline_props(Object.assign({ pvt: { undersat: true } }, FL, { qg: 0.2 }), 4000, 180);
      const sat = W.WTS_flowline_props(Object.assign({ pvt: {} }, FL, { qg: 0.2 }), 4000, 180);
      assert.ok(us.pb > 0 && us.bo < sat.bo, 'undersaturated Bo below Bob above the bubble point');
    },
  },
  {
    name: 'FIT timing: one fine evaluation E (10,000 ft vertical, 100 ft steps, Beggs & Brill) measured against the WP0 baseline (report; WP11 gates)',
    wp: WP,
    opts: false,
    timeoutMs: 120000,
    run(_a, assert, ctx) {
      const W = newApp(ctx).win, seg = [{ len: 10000, id: 2.441, dz: 10000 }];
      W.WTS_flowline_march(seg, FL, 250, 120, 200, { reverse: true, stepFt: 100 });
      const n = 20, t0 = process.hrtime.bigint();
      let r;
      for (let i = 0; i < n; i++) r = W.WTS_flowline_march(seg, FL, 250, 120, 200, { reverse: true, stepFt: 100 });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6 / n;
      console.log('    [FIT] E = ' + ms.toFixed(2) + ' ms (baseline E ' + S.BASELINE.E_ms + ' ms; 8,000 ft at 50 ft ' + S.BASELINE.traverse8000ft_50ft_ms + ' ms)');
      assert.ok(r && r.profile.length === 101, '100 steps');
      assert.ok(ms < 10 * S.BASELINE.E_ms, 'within 10 × the baseline (a loose sanity bound; the budget gate is WP11)');
    },
  },
];
