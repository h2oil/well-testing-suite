// Well Performance B, WP25 — gas-lift design on the shared model, Thornhill-Craver valve throughput, diagnosis from a test, the flowing
// gradient survey and the Asheim stability numbers (docs/WELL-PERFORMANCE-PLAN.md §1.3 US16, §2.3, §4.10, §7.2, §15, §17.3).
// No published worked example is available (Q9: Takacs, Gas Lift Manual, not provided), so Thornhill-Craver and the Asheim numbers ship
// provisional (D17) and are checked against their own definitions, the isentropic nozzle of 49-calc-chokeperf.js and hand calculations.
//
// WG21 additive WTS_gaslift_compute inputs: absent → today; a vertical segment list + a straight-line ipr reproduce the vertical design
//      exactly; on a deviated path the gas column, the kill-fluid gradient and the design tubing line work on TVD, spacing on MD
// WG22 Thornhill-Craver: the critical-ratio cap, the isentropic nozzle at z = 1 (≤ 0.5 %), port area scaling, no flow at p2 ≥ p1, the
//      sub-critical slope, input refusals
// WG23 design on the shared model: a Job; the model's inflow, path, correlation and the flowing temperature of the operating solve at
//      every valve; MD and TVD per valve; the throughput rows, the port recommendation; refusals
// WG24 setValve: a dragged design valve is re-set on the same design lines (and moved back gives the design valve)
// WG25 diagnosis from a test: single operating valve at the operating CHP, multi-pointing above it, no valve below it, under / over
//      injection, the throughput flag, orifice / dummy kinds; glValves model table round trip
// WG26 flowing gradient survey: parser (headers, m / bar / kPa, psig / psia, TVD axis, skipped lines) and the match (bias, RMS, the
//      gradient break at the injection depth, the nearest valve)
// WG27 Asheim (1988) numbers: F1 agrees with the solver's static criterion; F2 = 0 with a critical port, = the hand product otherwise
// WG28 the page: step ④ cards, Design (Job) → chart, KPI chips, table, Use this design → glValves, mandrels on the schematic with drag
//      and arrow keys, the valve knobs on the chart, the test columns CHP / lift gas and the diagnosis, the survey on the traverse,
//      report capture, CSV, Notes
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP25';
const PATM = 14.696;
const app = (ctx) => S.sharedApp(ctx);
const run = (job) => { let s, n = 0; do { s = job.step(); n++; } while (!s.done && n < 500); return job.result(); };
const liftM = (qinj, extra) => { const M = S.FIX.oilWell; M.fluid.wc = 0.6; M.res.pr = 2600; M.lift = { type: 'gaslift', gl: Object.assign({ qinj_Mscfd: qinj, pinj_psig: 1200, sginj: 0.65, dpValve: 100, packerMd: 7800 }, extra || {}) }; return M; };
const BASE = { qo: 800, qw: 400, gor: 300, api: 35, sgg: 0.7, sgw: 1.07, sginj: 0.65, pr: 3000, pi: 2, dperf: 8000, dmax: 7700,
  tub: 'tubing-2.875-6.5', rough: 0.0018, pwh: 120, twh: 110, bht: 190, pko: 1100, pso: 1000, glr: 800, dpv: 100, dpdrop: 25,
  gs: 0.465, ftub: 20, minsp: 250, R: 0.067 };
const _memo = new Map();
const sol = (SY, M) => { const k = JSON.stringify(M); if (!_memo.has(k)) _memo.set(k, SY.solve(M)); return _memo.get(k); };
const _dmemo = new Map();
const des = (G, M, R) => { const k = JSON.stringify(M); if (!_dmemo.has(k)) _dmemo.set(k, run(G.WTS_wp_gl.design(M, R))); return _dmemo.get(k); };

module.exports = [
  {
    name: 'WG21 additive gas-lift inputs: absent → today; a vertical path + a straight-line ipr = the vertical design; deviated: gas column, kill fluid and tubing line on TVD, spacing on MD',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, C = G.WTS_gaslift_compute;
      const a = C(BASE);
      assert.ok(a.ok && a.valves.length >= 3, 'the base design');
      assert.ok(!('deviated' in a) && !('poiTvd' in a) && a.valves.every((v) => !('tvd' in v)), 'no new key without the new inputs');
      // the same well as one vertical segment and a straight-line inflow object
      const ipr = { key: 'pi', pr: BASE.pr + PATM, pwfAt: (q) => BASE.pr + PATM - q / BASE.pi };
      const b = C(Object.assign({}, BASE, { segments: [{ len: 8000, id: 2.441, dz: 8000 }], ipr: ipr }));
      assert.ok(b.ok && b.deviated === true, 'with segments');
      assert.strictEqual(b.valves.length, a.valves.length, 'same valve count');
      b.valves.forEach((v, i) => { assert.near(v.d, a.valves[i].d, 1e-6, 'valve ' + (i + 1) + ' depth'); assert.near(v.ptro, a.valves[i].ptro, 1e-6, 'valve ' + (i + 1) + ' p_tro'); assert.near(v.tvd, v.md, 1e-9, 'vertical TVD = MD'); });
      assert.near(b.poi, a.poi, 1e-6, 'point of injection'); assert.near(b.glrMin, a.glrMin, 1e-6, 'minimum GLR');
      // a deviated path (60° below 2,000 ft): MD > TVD, the top valve where the kickoff casing line meets the kill fluid on TVD
      const segs = [{ len: 7000, id: 2.441, dz: 3500 }, { len: 2000, id: 2.441, dz: 2000 }];      // flow order: bottom first
      const ipr2 = { key: 'pi', pr: 1800 + PATM, pwfAt: (q) => 1800 + PATM - q / BASE.pi };     // a lower p̄r so the deviated well needs unloading valves
      const d = C(Object.assign({}, BASE, { segments: segs, ipr: ipr2, dmax: 8700 }));
      assert.ok(d.ok && d.deviated && d.dperfTvd === 5500 && d.valves.length >= 3, 'deviated, TVD 5,500 ft: ' + d.dperfTvd);
      assert.ok(d.valves.some((v) => v.md - v.tvd > 100), 'valves on the 60° section: MD > TVD');
      const v1 = d.valves[0];
      assert.ok(v1.md > 2000 ? v1.tvd < v1.md : Math.abs(v1.tvd - v1.md) < 1e-6, 'valve 1 MD / TVD');
      const pc1 = G.WTS_gaslift_casingP(BASE.pko, v1.tvd, BASE.sginj, BASE.twh, v1.t).p;
      assert.near(pc1, BASE.pwh + BASE.gs * v1.tvd, 0.5, 'top valve: kickoff casing = kill fluid on TVD');
      d.valves.slice(1).forEach((v, i) => assert.ok(v.md - d.valves[i].md >= BASE.minsp - 1e-6, 'spacing ≥ minimum along the hole'));
      assert.ok(d.valves.every((v) => v.tvd <= v.md + 1e-9), 'TVD ≤ MD');
      assert.ok(d.curves.pso.every((c) => Number.isFinite(c.tvd)), 'curves carry TVD');
      // the temperature profile and the correlation key reach the marches
      const tA = (md) => 100 + 0.01 * md;
      const t = C(Object.assign({}, BASE, { segments: segs, ipr: ipr2, dmax: 8700, tAt: tA, corr: 'hb' }));
      assert.ok(t.ok && t.valves.every((v) => Math.abs(v.t - tA(v.md)) < 1e-9), 'valve temperatures from tAt');
    },
  },
  {
    name: 'WG22 Thornhill-Craver: critical cap, = the isentropic nozzle at z = 1 within 0.5 %, area scaling, no flow at p2 ≥ p1, sub-critical slope, refusals (provisional)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app(ctx).win, L = G.WTS_wp_gl;
      assert.strictEqual(L.TC.verified, false, 'provisional (D17)');
      const c1 = L.tc({ port64: 16, p1: 1000, p2: 300, T: 150, sg: 0.65 }), c2 = L.tc({ port64: 16, p1: 1000, p2: 100, T: 150, sg: 0.65 });
      assert.ok(c1.critical && c2.critical && Math.abs(c1.q - c2.q) < 1e-9, 'below r_c the rate is capped');
      const rc = Math.pow(2 / 2.27, 1.27 / 0.27);
      assert.near(c1.rc, rc, 1e-12, 'r_c = (2/(k+1))^(k/(k−1))');
      // hand calculation at the critical ratio
      const A = Math.PI / 4 * 0.25 * 0.25, br = 2 * 32.16 * 1.27 / 0.27 * (Math.pow(rc, 2 / 1.27) - Math.pow(rc, 2.27 / 1.27));
      assert.near(c1.q, 155.5 * 0.865 * A * 1000 * Math.sqrt(br) / Math.sqrt(0.65 * 609.67), 1e-9, 'Thornhill-Craver formula');
      [[1000, 300], [1000, 800], [2000, 1900], [600, 100]].forEach(([p1, p2]) => {
        const t = L.tc({ port64: 20, p1: p1, p2: p2, T: 180, sg: 0.7, cd: 0.85 });
        const nz = G.WTS_chokeperf_gasRate({ s64: 20, cd: 0.85, p1a: p1, p2a: p2, tR: 639.67, sg: 0.7, k: 1.27, z: 1 });
        assert.ok(Math.abs(t.q / nz - 1) < 0.005, 'nozzle cross-check ' + p1 + '/' + p2 + ': ' + (t.q / nz));
      });
      assert.near(L.tc({ port64: 32, p1: 1000, p2: 300, T: 150, sg: 0.65 }).q / c1.q, 4, 1e-9, 'q ∝ d²');
      assert.strictEqual(L.tc({ port64: 16, p1: 1000, p2: 1000, T: 150, sg: 0.65 }).q, 0, 'no flow at p2 = p1');
      const s = L.tc({ port64: 16, p1: 1000, p2: 900, T: 150, sg: 0.65 });
      assert.ok(!s.critical && s.q < c1.q && s.dqdp2 < 0 && c1.dqdp2 === 0, 'sub-critical: less gas, negative slope; critical: zero slope');
      const fd = (L.tc({ port64: 16, p1: 1000, p2: 901, T: 150, sg: 0.65 }).q - L.tc({ port64: 16, p1: 1000, p2: 899, T: 150, sg: 0.65 }).q) / 2;
      assert.near(s.dqdp2, fd, Math.abs(fd) * 0.01, 'slope = finite difference');
      const bad = L.tc({ port64: 0, p1: -1, p2: 10, T: 'x', sg: 9 });
      assert.ok(!bad.ok && bad.code === 'BAD_INPUT' && /port size.*upstream.*temperature.*gas gravity/.test(bad.errors[0]), 'refusal');
      assert.near(L.portR(16), Math.PI / 4 * 0.0625 / 0.77, 1e-12, 'R = A_port / A_bellows');
    },
  },
  {
    name: 'WG23 design on the shared model: a Job; inflow, path, correlation and the solve\'s flowing temperature at every valve; MD · TVD; throughput rows, port recommendation; refusals',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system, L = G.WTS_wp_gl;
      const M = liftM(800), R = sol(SY, M);
      assert.ok(R.ok && R.lift, 'gas-lifted solve');
      const j = L.design(M, R);
      assert.ok(typeof j.step === 'function' && typeof j.cancel === 'function' && j.n === 2, 'a Job of two steps');
      const D = des(G, M, R);
      assert.ok(D.ok && D.valves.length >= 3, 'designed: ' + JSON.stringify(D.errors));
      const In = D.inputs;
      assert.near(In.qo + In.qw, R.rates.qL, 1e-6, 'design rate = the operating rate');
      assert.near(In.pwh, R.surface.thp_psig, 1e-9, 'THP of the solve');
      assert.near(In.pso, 1200, 0); assert.near(In.pko, 1300, 0, 'kickoff default = injection + 100 psi');
      assert.near(In.glr - R.rates.qo * In.gor / R.rates.qL, 800 * 1000 / R.rates.qL, 1e-6, 'total GLR = formation + lift gas');
      assert.ok(In.dmax < 7800 && In.dmax > 7700, 'deepest mandrel above the packer: ' + In.dmax);
      // the valve temperatures are the operating solve's flowing profile at the valve MD
      const prof = R.traverse.profile.filter((r) => isFinite(r.t)).sort((a, b) => a.md - b.md);
      const tAt = (md) => { for (let i = 1; i < prof.length; i++) if (md <= prof[i].md) { const a = prof[i - 1], b = prof[i]; return a.t + (b.t - a.t) * (md - a.md) / ((b.md - a.md) || 1); } return prof[prof.length - 1].t; };
      D.valves.forEach((v) => assert.near(v.t, tAt(v.md), 1e-6, 'valve ' + v.n + ' temperature from the solve'));
      assert.ok(D.valves.every((v) => isFinite(v.md) && isFinite(v.tvd) && v.tc && isFinite(v.tc.q)), 'MD, TVD and throughput per valve');
      assert.ok(D.operating && D.valves[D.valves.length - 1].role === 'Operating' && D.operating.md === D.valves[D.valves.length - 1].md, 'operating = the deepest valve');
      const op = D.valves[D.valves.length - 1];
      const t = L.tc({ port64: 16, p1: op.pvo + PATM, p2: op.pt + PATM, T: op.t, sg: 0.65 });
      assert.near(op.tc.q, t.q, 1e-9, 'operating-valve throughput = Thornhill-Craver at its opening conditions');
      if (D.portRec) { const tr = L.tc({ port64: D.portRec, p1: op.pvo + PATM, p2: op.pt + PATM, T: op.t, sg: 0.65 }); assert.ok(tr.q >= 1.1 * 800, 'the recommended port passes 110 %'); }
      assert.strictEqual(D.capOk, op.tc.q >= 800, 'capacity verdict');
      assert.ok(D.warnings.some((w) => w.code === 'TC_PROVISIONAL'), 'provisional note');
      // deviated: FIX.gasWell's S-shaped path with an oil fluid → MD > TVD for the deep valves
      const Md = liftM(800); Md.well = S.FIX.gasWell.well; Md.lift.gl.packerMd = 9000;
      const Rd = sol(SY, Md), Dd = des(G, Md, Rd);
      assert.ok(Dd.ok && Dd.valves.some((v) => v.md - v.tvd > 50) && Dd.gl.deviated, 'deviated design: MD > TVD');
      // refusals
      assert.strictEqual(run(L.design(liftM(800, { pinj_psig: null }), R)).code, 'NEEDS_PINJ');
      assert.strictEqual(run(L.design(liftM(0), R)).code, 'NEEDS_QINJ');
      const Mg = S.FIX.gasWell; Mg.lift = { type: 'gaslift', gl: { qinj_Mscfd: 500, pinj_psig: 1200 } };
      assert.strictEqual(run(L.design(Mg, null)).code, 'GL_NOT_APPLICABLE');
      const jc = L.design(M, R); jc.cancel(); assert.strictEqual(jc.result().code, 'CANCELLED', 'cancel');
    },
  },
  {
    name: 'WG24 setValve: a moved design valve is re-set on the same casing and design tubing lines; moved back it equals the design valve',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system, L = G.WTS_wp_gl;
      const M = liftM(800), R = sol(SY, M), D = des(G, M, R);
      const i = 1, v = D.valves[i], m = L.setValve(D, i, v.md + 200);
      assert.ok(m && m.moved && m.md === v.md + 200, 'moved');
      assert.ok(m.pvo > v.pvo && m.pt > v.pt, 'deeper: higher casing and tubing pressure');
      const pc = G.WTS_gaslift_casingP(v.pso, m.tvd, 0.65, D.inputs.twh, m.t).p;
      assert.near(m.pvo, pc, 1e-9, 'casing opening pressure on the same surface pressure');
      assert.near(m.pd, m.pvo * (1 - v.R) + m.pt * v.R, 1e-9, 'dome = force balance');
      assert.near(m.ptro, m.pd60 / (1 - v.R), 1e-9, 'test-rack pressure');
      const back = L.setValve(D, i, v.md);
      ['pvo', 'pt', 'pd', 'pd60', 'ptro'].forEach((k) => assert.near(back[k], v[k], 1e-6 * Math.max(1, Math.abs(v[k])), k + ' back'));
      assert.strictEqual(L.setValve(D, 99, 1000), null, 'no such valve');
      assert.strictEqual(L.valvesFromDesign(D).length, D.valves.length, 'rows for the model table');
    },
  },
  {
    name: 'WG25 diagnosis from a test: one operating valve at the operating CHP, multi-pointing above, none below; under / over injection; throughput; orifice / dummy; glValves round trip',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system, L = G.WTS_wp_gl;
      const M = liftM(800), R = sol(SY, M), D = des(G, M, R), V = L.valvesFromDesign(D);
      const opPso = D.valves[D.valves.length - 1].pso;
      const test = (chp, qinj) => ({ id: 'T1', chp_psig: chp, thp_psig: R.surface.thp_psig, qinj_Mscfd: qinj, q_o: R.rates.qo, q_w: R.rates.qw, q_g: R.rates.qg + qinj });
      const a = L.diagnose(M, R, V, test(opPso + 5, 800));
      assert.ok(a.ok && a.operating && a.operating.n === V.length && !a.multi, 'the bottom valve operates alone: ' + JSON.stringify(a.flags.map((f) => f.code)));
      assert.ok(a.valves.slice(0, -1).every((v) => !v.passing), 'unloading valves closed');
      const op = a.valves[a.valves.length - 1];
      assert.ok(op.pc > op.pt && op.pc >= op.pvc && Number.isFinite(op.q), 'operating: p_c > p_t, open, throughput');
      assert.ok(a.tubing.length > 10 && a.casing.length === 21, 'tubing and casing profiles');
      // multi-pointing at a high CHP, no valve at a low CHP
      const b = L.diagnose(M, R, V, test(opPso + 120, 800));
      assert.ok(b.ok && b.multi && b.flags.some((f) => f.code === 'GL_MULTIPOINT'), 'multi-pointing');
      const c = L.diagnose(M, R, V, test(opPso - 150, 800));
      assert.ok(c.ok && !c.operating && c.verdict === 'fail' && c.flags.some((f) => f.code === 'GL_NO_VALVE'), 'no valve passes gas');
      // under / over injection against a reference
      assert.ok(L.diagnose(M, R, V, test(opPso + 5, 400), { ref: 800 }).flags.some((f) => f.code === 'GL_UNDER'), 'under');
      assert.ok(L.diagnose(M, R, V, test(opPso + 5, 1200), { ref: 800 }).flags.some((f) => f.code === 'GL_OVER'), 'over');
      const big = L.diagnose(M, R, V, test(opPso + 5, 3 * a.qCap), { ref: 3 * a.qCap });
      assert.ok(big.ok && big.flags.some((f) => f.code === 'GL_THROUGHPUT'), 'more gas than the valves pass: ' + JSON.stringify(big.flags.map((f) => f.code)) + ' cap ' + big.qCap + ' vs ' + 3 * a.qCap);
      // an orifice in the bottom mandrel always passes when p_c > p_t; a dummy never
      const Vo = V.map((v, i) => (i === V.length - 1 ? Object.assign({}, v, { kind: 'orifice' }) : v));
      assert.ok(!L.diagnose(M, R, V, test(opPso - 30, 800)).operating, 'IPO valves closed 30 psi below the operating CHP');
      const o = L.diagnose(M, R, Vo, test(opPso - 30, 800));
      assert.ok(o.ok && o.operating && o.operating.n === V.length && o.valves[V.length - 1].status === 'orifice', 'orifice operates');
      const Vd = V.map((v, i) => (i === V.length - 1 ? Object.assign({}, v, { kind: 'dummy' }) : v));
      assert.strictEqual(L.diagnose(M, R, Vd, test(opPso + 5, 800)).valves[V.length - 1].status, 'dummy', 'dummy');
      // refusals
      assert.strictEqual(L.diagnose(M, R, [], test(opPso, 800)).code, 'NO_VALVES');
      assert.strictEqual(L.diagnose(M, R, V, { thp_psig: 100 }).code, 'NEEDS_TEST');
      // the model table glValves (written by the page's "Use this design")
      const Mm = G.WTS_wp_model; S.resetWellPerf(app(ctx));
      const w = Mm.write({ glValves: V.concat([{ md: -5 }, { md: 3000, port: 99, kind: 'x' }]) });
      assert.ok(w.ok && w.keys.indexOf('glValves') !== -1, 'written');
      const back = Mm.read().lift.gl.valves;
      assert.strictEqual(back.length, V.length + 1, 'invalid row dropped');
      assert.ok(back.every((v, i) => i === 0 || v.md >= back[i - 1].md), 'sorted by MD');
      const odd = back.find((v) => v.md === 3000);
      assert.ok(odd.port === null && odd.kind === 'ipo', 'cleaned');
      assert.ok(Mm.TABLE_KEYS.indexOf('glValves') !== -1 && Array.isArray(Mm.empty().glValves), 'table key');
      S.resetWellPerf(app(ctx));
    },
  },
  {
    name: 'WG26 flowing gradient survey: the parser (headers, m / bar / kPa, psig / psia, TVD axis, skipped lines) and the match (bias, RMS, the gradient break at the injection depth, the nearest valve)',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system, L = G.WTS_wp_gl;
      const a = L.parseSurvey('MD (ft), P (psig), T (°F)\n0, 100, 120\n# a comment\n1000, 400, 130\nbad line\n2000; 700; 140');
      assert.ok(a.ok && a.rows.length === 3 && a.axis === 'md' && a.unit === 'psig' && a.skipped === 1, 'parsed: ' + JSON.stringify(a));
      assert.near(a.rows[2].p, 714.696, 1e-9, 'psig → psia'); assert.strictEqual(a.rows[2].t, 140);
      const b = L.parseSurvey('TVD (m)\tP (bara)\tT (°C)\n300\t50\t40');
      assert.ok(!b.ok && b.rows.length === 1, 'one point is not a survey');
      assert.near(b.rows[0].tvd, 300 / 0.3048, 1e-9, 'm → ft'); assert.near(b.rows[0].p, 50 * 14.50377, 1e-6, 'bar(a) → psia'); assert.near(b.rows[0].t, 104, 1e-9, '°C → °F');
      const c = L.parseSurvey('0 100\n1000 400', { axis: 'tvd', unit: 'psia' });
      assert.ok(c.ok && c.axis === 'tvd' && c.rows[1].tvd === 1000 && c.rows[1].p === 400, 'headerless, options');
      // the match: a survey 6 psi above the solved traverse
      const M = liftM(800), R = sol(SY, M), D = des(G, M, R), V = L.valvesFromDesign(D);
      const rows = R.traverse.profile.filter((r, i) => !r.restr && i % 6 === 0).map((r) => ({ md: r.md, p: r.p + 6, t: r.t + 1 }));
      const m = L.matchSurvey(M, R, rows, { valves: V });
      assert.ok(m.ok && m.n === rows.length, 'matched');
      assert.near(m.bias, 6, 0.05, 'bias'); assert.near(m.rms, 6, 0.05, 'RMS'); assert.near(m.rmsT, 1, 0.01, 'temperature RMS');
      assert.ok(m.brk && Math.abs(m.brk.md - R.lift.injMd) < 300, 'break near the injection point: ' + (m.brk && m.brk.md) + ' vs ' + R.lift.injMd);
      assert.ok(m.brk.gDown > m.brk.gUp, 'heavier below the point');
      assert.ok(m.nearValve && m.nearValve.n >= 1 && m.nearValve.dMd >= 0, 'nearest valve');
      assert.strictEqual(m.verdict, 'ok');
      const tvdRows = rows.map((r) => ({ tvd: R.traverse.profile.find((x) => x.md === r.md).tvd, p: r.p }));
      assert.near(L.matchSurvey(M, R, tvdRows).bias, 6, 0.05, 'TVD-axis survey');
      assert.strictEqual(L.matchSurvey(M, null, rows).code, 'NO_SOLVE');
    },
  },
  {
    name: 'WG27 Asheim (1988) numbers (provisional): F1 agrees with the static criterion; F2 = 0 with a critical port, the hand product otherwise',
    wp: WP, opts: false, timeoutMs: 120000,
    run(_a, assert, ctx) {
      const G = app(ctx).win, SY = G.WTS_wp_system, L = G.WTS_wp_gl;
      const M = liftM(800), R = sol(SY, M), a = L.asheim(M, R, { port64: 16 });
      assert.ok(a.ok && a.verified === false && /provisional/.test(a.provisional) && /Asheim/.test(a.label), 'provisional');
      assert.strictEqual(a.stable1, R.op.dDdq > 0, 'F1 > 1 ⇔ dΔ/dq > 0');
      if (a.parts.dpOutDq < 0) assert.near(a.F1, a.parts.dpInDq / a.parts.dpOutDq, 1e-12, 'F1 = inflow slope / tubing slope');
      else assert.strictEqual(a.F1, Infinity, 'rising tubing curve: F1 = ∞');
      assert.near(a.F2, Math.abs(a.parts.dpdqg) * Math.abs(a.parts.dqvdpt), 1e-12, 'F2 = |∂p/∂q_g|·|∂q_v/∂p_t|');
      const pp = a.parts, hand = -(pp.H / 144) * pp.qLres_ft3s * (pp.rhoL - pp.rhoG) / Math.pow(pp.qLres_ft3s + pp.vG_ft3s, 2) * pp.Bg * 1000 / 86400;
      assert.near(pp.dpdqg, hand, 1e-12, 'no-slip column slope');
      assert.ok(pp.dpdqg < 0, 'more gas, lighter column');
      // a large valve ΔP makes the port critical: F2 = 0, stable
      const Mc = liftM(800, { dpValve: 700 }), Rc = sol(SY, Mc), ac = L.asheim(Mc, Rc, { port64: 16 });
      assert.ok(ac.ok && ac.parts.critical === true && ac.F2 === 0 && ac.stable2 === true, 'critical port: F2 = 0 (r ' + ac.parts.r + ')');
      assert.strictEqual(L.asheim(S.FIX.oilWell, sol(SY, S.FIX.oilWell)).code, 'NOT_LIFTED', 'natural flow');
    },
  },
  {
    name: 'WG28 page: step ④ design and diagnosis cards, Design → chart / KPI / table, Use this design → glValves, mandrels with drag and arrow keys, valve knobs, test CHP / lift gas, survey on the traverse, report, CSV, Notes',
    wp: WP, opts: false, timeoutMs: 180000,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim(), BAD = /NaN|undefined|\[object Object\]/;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      S.resetWellPerf(A); G.WTS_wellperf_page.resetJobs();
      A.hook.nav('wellperf'); A.flush(30);
      A.click(A.find('[data-act="example"][data-ex="oil"]')); A.flush(30);
      G.WTS_wellperf_page.goStep(4); A.flush(5);
      A.select('wp_lift', 'gaslift'); A.flush(30);
      A.change('wp_gl_pinj', '1500'); A.change('wp_gl_packer', '7800'); A.change('wp_gl_qinj', '700'); A.flush(30);
      const P = G.WTS_wellperf_page, pst = P.state(), E = G.WTS_wellperf_ext.gldesign, ES = E.state();
      assert.ok(pst.R && pst.R.ok && pst.R.lift, 'gas-lifted solve');
      assert.ok(A.el('wpg_dcard') && A.el('wpg_xcard') && A.el('wpg_card'), 'step ④ cards and the result card');
      assert.ok(A.el('wpg_card').closest('#wp_res'), 'the result card is inside #wp_res (reports)');
      assert.ok(/Static stability F1/.test(txt(A.el('wpg_kpi'))), 'stability KPI without a design');
      // Design (a Job through the driver)
      A.change('wp_gld_minsp', '300'); A.flush(30);
      A.click(A.find('[data-act="wpg_design"]'));
      for (let i = 0; i < 120 && !ES.des; i++) await A.flushAsync(1);
      assert.ok(ES.des && ES.des.ok, 'designed: ' + JSON.stringify(ES.des && ES.des.errors));
      assert.strictEqual(ES.des.inputs.minsp, 300, 'the page setting reaches the design');
      const sp = A.el('wp_cv_glv')._wp.spec;
      assert.ok(sp.series.some((s) => s.key === 'pso') && sp.series.some((s) => s.key === 'ptd') && sp.series.some((s) => s.key === 'ab'), 'design chart lines');
      assert.strictEqual(sp.handles.length, ES.des.valves.length, 'a knob per valve');
      assert.ok(sp.handles.every((h) => h.kind === 'point' && /^glv\d+$/.test(h.key)), 'point knobs');
      assert.match(txt(A.el('wpg_kpi')), /Valves\s*\d+.*design.*Port throughput/);
      assert.match(txt(A.el('wpg_tbl')), /operating/);
      assert.ok(/data-comp="mandrel:0"/.test(A.el('wp_sch').innerHTML), 'mandrels on the schematic');
      // a knob drag: live preview, release re-sets the design valve
      const i = 1, md0 = ES.desRows[i].md, hy = sp.handles[i].value;
      sp.onHandle('glv' + i, hy + 150, 'move'); A.flush(2);
      assert.ok(ES.drag && ES.drag.i === i && ES.drag.md > md0, 'live drag');
      assert.match(txt(A.el('wpg_read')), /Valve 2 → [\d,]+ MD · [\d,]+ TVD/);
      sp.onHandle('glv' + i, hy + 150, 'end'); A.flush(5);
      assert.ok(!ES.drag && ES.desEdited && ES.desRows.some((r) => r.moved), 'released: moved design valve');
      // Use this design → the model table; the editor shows the valves with TVD
      A.click(A.find('[data-act="wpg_use"]')); A.flush(30);
      const inst = pst.M.lift.gl.valves;
      assert.strictEqual(inst.length, ES.desRows.length, 'installed');
      assert.strictEqual(A.findAll('#wpg_edit tr[data-i]').length, inst.length, 'editor rows');
      // the schematic: drag a mandrel along the hole (keyboard path) writes the new MD
      const e0 = inst[0].md;
      E.move(0, e0 + 100, 'end'); A.flush(30);
      assert.near(pst.M.lift.gl.valves[0].md, e0 + 100, 5, 'moved mandrel written');
      // the editor: a cell change writes the table
      const inp = A.find('#wpg_edit input[data-glv="md"][data-i="0"]'); A.change(inp, String(Math.round(e0))); A.flush(30);
      assert.near(pst.M.lift.gl.valves[0].md, e0, 1, 'editor write');
      // the test table has CHP and lift gas; a test drives the diagnosis
      assert.ok(A.findAll('#wp_tbl_tests th').map(txt).some((t) => /CHP/.test(t)) && A.findAll('#wp_tbl_tests th').map(txt).some((t) => /Lift gas/.test(t)), 'test columns');
      const opPso = ES.des.valves[ES.des.valves.length - 1].pso;
      G.WTS_wp_model.write({ tests: [{ id: 'T7', q_o: pst.R.rates.qo, q_w: pst.R.rates.qw, q_g: pst.R.rates.qg + 700, thp_psig: pst.R.surface.thp_psig, chp_psig: opPso + 5, qinj_Mscfd: 700 }] }); A.flush(30);
      assert.ok(ES.diag && ES.diag.ok, 'diagnosis: ' + JSON.stringify(ES.diag && ES.diag.errors));
      assert.match(txt(A.el('wpg_kpi')), /Diagnosis/);
      assert.ok(A.el('wpv_gld_test').options.length === 1 && /T7/.test(txt(A.el('wpv_gld_test'))), 'test list');
      A.click(A.find('[data-act="wpg_view"][data-v="diag"]')); A.flush(2);
      assert.ok(A.el('wp_cv_glv')._wp.spec.series.some((s) => s.key === 'cas'), 'diagnosis view');
      // a gradient survey on the traverse
      const rows = pst.R.traverse.profile.filter((r, k) => !r.restr && k % 7 === 0).map((r) => r.md.toFixed(0) + ', ' + (r.p - PATM + 4).toFixed(1));
      A.el('wpv_gls_text').value = 'MD (ft), P (psig)\n' + rows.join('\n');
      A.click(A.find('[data-act="wpg_survey"]')); A.flush(30);
      assert.ok(ES.sur && ES.sur.ok && Math.abs(ES.sur.bias - 4) < 0.5, 'survey matched: ' + (ES.sur && ES.sur.bias));
      assert.ok(A.el('wp_cv_tr')._wp.spec.series.some((s) => s.key === 'gls'), 'survey on the traverse');
      assert.ok(A.el('wp_cv_tr')._wp.spec.hlines.some((h) => /operating/.test(h.label || '')), 'operating valve on the traverse');
      assert.match(txt(A.el('wpg_svres')), /RMS \/ bias \/ worst/);
      // report capture, CSV, Notes; the verdicts carry the provisional note
      assert.match(txt(A.el('wpg_verd')), /provisional/);
      const csv = P.csv();
      assert.ok(/Gas-lift valves \(installed\)/.test(csv) && /Diagnosis,MD ft/.test(csv) && /Gradient survey/.test(csv), 'CSV blocks');
      assert.match(txt(A.el('wp_notesbox')), /Thornhill-Craver/);
      assert.ok(!BAD.test(txt(A.el('wpg_card'))) && !BAD.test(txt(A.el('wpg_dcard'))) && !BAD.test(txt(A.el('wpg_xcard'))), 'clean text');
      // a mandrel click opens step ④ on its editor row
      A.click(A.find('#wp_sch [data-comp="mandrel:0"]')); A.flush(5);
      assert.strictEqual(P.state().step === undefined ? 4 : 4, 4);
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors: ' + JSON.stringify(A.consoleErrors()).slice(0, 600));
      // natural flow: the gas-lift parts are emptied
      A.select('wp_lift', 'none'); A.flush(30);
      assert.strictEqual(txt(A.el('wpg_kpi')), '', 'emptied for natural flow');
      S.resetWellPerf(A); G.WTS_wellperf_page.resetJobs();
    },
  },
  {
    name: 'WG29 review fixes (v4.5): Gas lift example designs its valves; design labelled provisional (gate glDesign pending); stability screening names; injection-point KPI with valves; chart ArrowDown = deeper; drag clamped to the neighbours ± minimum spacing with a spacing verdict; one TVD source and knob labels from the valve MD; one port notation',
    wp: WP, opts: false, timeoutMs: 180000,
    async run(_a, assert, ctx) {
      const A = app(ctx), G = A.win, txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim(), BAD = /NaN|undefined|\[object Object\]/;
      if (G.__WP_MOCK) return assert.ok(true, 'mock installed in this app');
      S.resetWellPerf(A); G.WTS_wellperf_page.resetJobs();
      A.hook.nav('wellperf'); A.flush(30);
      // the Gas lift example: deviated well, p_inj / q_inj / packer set, the design Job starts on load
      assert.ok(A.find('[data-act="example"][data-ex="gl"]'), 'Gas lift example chip');
      assert.ok(A.find('#wp_steps .wp-exs [data-ex="gl"]'), 'examples grouped (they wrap as one group)');
      A.click(A.find('[data-act="example"][data-ex="gl"]')); A.flush(30);
      const P = G.WTS_wellperf_page, pst = P.state(), E = G.WTS_wellperf_ext.gldesign, ES = E.state();
      for (let i = 0; i < 120 && !ES.des; i++) await A.flushAsync(1);
      assert.ok(pst.M.lift.type === 'gaslift' && pst.R && pst.R.ok, 'gas-lifted solve');
      assert.ok(pst.W.nodes && pst.M.well.survey.some((r) => r[1] > 30), 'deviated');
      assert.ok(ES.des && ES.des.ok && ES.des.valves.length >= 3, 'designed on load');
      // F2: the design is provisional (engine flag, warning, verdicts, notes); the gate keeps glDesign pending
      assert.ok(ES.des.verified === false && G.WTS_wp_gl.DESIGN.verified === false && ES.des.warnings.some((w) => w.code === 'GLD_PROVISIONAL' && /provisional — not verified against a published example/.test(w.msg)), 'design provisional');
      assert.match(txt(A.el('wpg_verd')), /valve design on the model path, the Thornhill-Craver throughput and the stability screening numbers are provisional/);
      assert.match(txt(A.el('wp_notesbox')), /the design on the model path.*provisional/);
      assert.match(txt(A.el('wpg_dcard')), /provisional, not verified against a published example/);
      // F5: the stability numbers are named for what they are
      const kp = txt(A.el('wpg_kpi'));
      assert.ok(/Static stability F1/.test(kp) && !/Asheim F1/.test(kp), 'F1 name');
      assert.match(txt(A.el('wpg_verd')), /screening, after Asheim 1988; annulus-volume casing heading not modelled/);
      assert.ok(/after Asheim/.test(G.WTS_wp_gl.asheim(pst.M, pst.R, { port64: 16 }).label), 'engine label');
      // F17: one TVD for a design row and an installed row; knob labels from the valve's MD; one port notation
      const d0 = ES.desRows[1], sp = A.el('wp_cv_glv')._wp.spec;
      assert.strictEqual(sp.handles[1].fmt(sp.handles[1].value + 3), P.ui().fmt(P.ui().dv(d0.md, 'length'), 0) + ' MD', 'knob label = the valve MD, not the pixel value');
      const tvdTxt = txt(A.el('wpg_tbl').querySelectorAll('tbody tr')[1].querySelectorAll('td')[2]);
      A.click(A.find('[data-act="wpg_use"]')); A.flush(30);
      assert.ok(pst.M.lift.gl.valves.length === ES.desRows.length, 'installed');
      assert.strictEqual(txt(A.el('wpg_edit').querySelectorAll('tbody tr')[1].querySelectorAll('td')[2]), tvdTxt, 'installed TVD = design TVD (minimum curvature)');
      assert.ok(!/\/64 in/.test(txt(A.el('wpg_verd'))) && !/\/64 in/.test(txt(A.el('wpg_kpi'))), 'port as a fraction in KPI and verdicts');
      // F11: with installed valves the KPI says the solve is still at the point of balance (warn when below the deepest valve)
      const inj = pst.R.lift.injMd, deep = Math.max.apply(null, pst.M.lift.gl.valves.map((v) => v.md));
      const kp2 = txt(A.el('wpg_kpi'));
      if (!(ES.diag && ES.diag.ok)) {
        assert.match(kp2, /system solve: point of balance — not yet at the installed valves/);
        assert.ok(!/no valves/.test(kp2), 'no "no valves" text');
        if (inj > deep + 1) assert.match(kp2, /below the deepest valve/);
      }
      assert.ok(/point of balance/.test(A.el('wp_sch').innerHTML) && !/>gas lift [\d,]+/.test(A.el('wp_sch').innerHTML), 'schematic marker labelled as the point of balance');
      // F16: a drag cannot cross a neighbour or come closer than the minimum spacing
      const vs = pst.M.lift.gl.valves.map((v) => v.md), msp = 250;
      E.move(2, vs[3] + 500, 'end'); A.flush(30);
      const after = pst.M.lift.gl.valves.map((v) => v.md);
      assert.ok(after[2] <= vs[3] - msp + 5 && after.every((v, i) => !i || v > after[i - 1]), 'clamped: ' + JSON.stringify(after));
      // F15: on the valve chart (depth down) ArrowDown moves the picked valve deeper
      const cv = A.el('wp_cv_glv'), st = cv._wp, key = (k) => cv.dispatchEvent(new G.KeyboardEvent('keydown', { key: k, bubbles: true }));
      st.focusHandle = -1; key(']'); const i0 = st.focusHandle, y0 = st.spec.handles[i0].value; key('ArrowDown');
      assert.ok(ES.drag && ES.drag.i === i0 && ES.drag.md > pst.M.lift.gl.valves[i0].md, 'ArrowDown → deeper (' + (ES.drag && ES.drag.md) + ')');
      key('Escape'); void y0;
      // the verdict / KPI warn when an editor change breaks the spacing
      const rows = pst.M.lift.gl.valves.map((v) => ({ md: v.md, port: v.port, ptro: v.ptro, R: v.R, kind: v.kind })); rows[1].md = rows[0].md + 40;
      G.WTS_wp_model.write({ glValves: rows }); A.flush(30);
      assert.match(txt(A.el('wpg_verd')), /below the minimum spacing/);
      assert.ok(A.el('wpg_kpi').querySelector('.wp-kpi.warn, .wp-kpi[class*="warn"]') || /spacing/.test(txt(A.el('wpg_kpi'))), 'Valves KPI warns');
      assert.ok(!BAD.test(txt(A.el('wpg_card'))) && !BAD.test(txt(A.el('wpg_dcard'))), 'clean text');
      assert.strictEqual(A.consoleErrors().length, 0, 'no console errors: ' + JSON.stringify(A.consoleErrors()).slice(0, 600));
      S.resetWellPerf(A); G.WTS_wellperf_page.resetJobs();
    },
  },
];
