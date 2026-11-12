// Well Performance A2 — 16-pvt correlation families (WP13) — docs/WELL-PERFORMANCE-PLAN.md §2.3 (16-pvt row), §4.1, §15.1 (D17),
// §17.2 (wellperf-pvt2, 10 tests) and the owner GUI requirement (the families on the interactive page).
//
// PV2-1 P-ID: the 20 A1 keys of PRiSM_pvt_correlations give identical numbers (Object.is) to the frozen A1 copy
//       tests/_pvt16-v43.js on the 16-pvt self-test grid and a wider grid; 18 keys merged (38), none replaced
// PV2-2 Vasquez-Beggs = the host pages: Rs equal to the Solution GOR page (separator normalisation, both API brackets), the 100 psig
//       gravity equal to the Bubble Point page; Pb the exact inverse of Rs; the sep argument
// PV2-3 Glasø Pb / Rs / Bo from the published equations (independent hand code); Rs inverts Pb (printed constants); flat above the
//       quadratic's vertex (no NaN in the march)
// PV2-4 Petrosky-Farshad Pb / Rs / Bo / co by hand; the marcher's undersaturated Bo with corr.co = 'petrosky' equals the closed-form
//       integral Bob·exp[A·(pb^0.4094 − p^0.4094)] (Gauss-Legendre within 1e-9)
// PV2-5 viscosities: Egbogah, Bergman-Sutton dead oil and Chew-Connally live oil by hand; the march uses the selected chain
// PV2-6 McCain water: standard density from salinity, Bw (= the A1 Bw_meehan coefficients, recorded), gas solubility with the
//       salinity correction, in-situ density; a blank water gravity with a salinity takes the McCain density in the builder
// PV2-7 Abdul-Majeed σ by hand and in the march at the in-situ Rs; the A1 path (no new pvt field, or the default keys spelled out)
//       is unchanged bit for bit
// PV2-8 D17 gate: every new key provisional in PRiSM_pvt_corrInfo, no default provisional, families() order, validity messages and
//       F.provisional; published-example benchmarks: none verifiable (owner Q9) — recorded as the gate, not as a pass
// PV2-9 page: the Fluid properties card (families overlaid, provisional dashed, chips with pb and range state, spread verdict,
//       comparison table in the report, case summary row); a chip click selects the family (Pb / Rs / Bo) and solves
// PV2-10 page: the bubble-point handle previews on move (no solve) and commits on release (one-point shift, Clear button); keyboard;
//       the property switch (pref), the gas well's Z comparison, Metric labels; no NaN
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const S = require('./_wellperf-shapes');

const WP = 'WP13';
const app0 = (ctx) => S.sharedApp(ctx);
const txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
const J = (x) => JSON.parse(JSON.stringify(x));
const BAD = /NaN|undefined|Infinity|\[object Object\]/;
const NEW_KEYS = ['Pb_vasquezBeggs', 'Rs_vasquezBeggs', 'Bo_vasquezBeggs', 'Pb_glaso', 'Rs_glaso', 'Bo_glaso', 'Pb_petrosky', 'Rs_petrosky', 'Bo_petrosky',
  'mu_oD_egbogah', 'mu_oD_bergmanSutton', 'mu_o_chewConnally', 'co_petrosky', 'sg_gas100_vasquezBeggs', 'rho_w_mcCain', 'Bw_mcCain', 'sigma_og_abdulMajeed', 'Rsw_mcCain'];
const OLD_KEYS = ['Pb_standing', 'Rs_standing', 'Bo_standing', 'mu_oD_beggsRobinson', 'mu_o_beggsRobinson', 'co_vasquezBeggs', 'Bo_undersaturated', 'mu_o_vasquezBeggs',
  'Tpc_sutton', 'Ppc_sutton', 'Z_dranchukAbouKassem', 'Z_hallYarborough', 'mu_g_leeGonzalezEakin', 'Bg', 'cg_realGas', 'Bw_meehan', 'mu_w_meehan', 'cw_dodson', 'm_p', 'ct'];

let FROZEN = null;
function frozen() {
  if (FROZEN) return FROZEN;
  const src = fs.readFileSync(path.join(__dirname, '_pvt16-v43.js'), 'utf8');
  const c = { console: { log() {}, error() {}, warn() {} } };
  c.window = c; c.globalThis = c;
  vm.createContext(c); vm.runInContext(src, c);
  FROZEN = c.PRiSM_pvt_correlations;
  return FROZEN;
}
const OIL = (corr, extra) => Object.assign({ type: 'oil', api: 35, sgg: 0.75, gor: 600, wc: 0, sgw: 1.07, psep_psig: 100, tsep_F: 80 }, extra || {}, corr ? { corr } : {});
function open(app) { app.hook.nav('wellperf'); app.flush(30); return app.el('wp_root'); }
function example(app, k) { app.click(app.find('[data-act="example"][data-ex="' + (k || 'oil') + '"]')); app.flush(30); }
function step(app, n) { app.click(app.find('#wp_steps [data-step="' + n + '"]')); app.flush(5); }

module.exports = [
  {
    name: 'PV2-1 P-ID: the 20 A1 keys equal the frozen A1 16-pvt (Object.is) on the self-test grid and a wide grid; 18 keys merged (38), none replaced',
    wp: WP,
    run(_a, assert, ctx) {
      const app = app0(ctx), L = app.win.PRiSM_pvt_correlations, F0 = frozen();
      assert.deepStrictEqual(J(Object.keys(F0).sort()), OLD_KEYS.slice().sort(), 'frozen copy = the 20 A1 keys');
      assert.strictEqual(Object.keys(L).length, 38, '20 + 18 keys');
      NEW_KEYS.concat(OLD_KEYS).forEach((k) => assert.strictEqual(typeof L[k], 'function', k));
      let n = 0;
      const eq = (k, args) => { const a = L[k].apply(null, args), b = F0[k].apply(null, args); n++; assert.ok(Object.is(a, b), k + '(' + args.join(', ') + '): ' + a + ' vs ' + b); };
      // the self-test points
      eq('Bo_standing', [35, 0.65, 500, 180]); eq('Tpc_sutton', [0.65]); eq('Ppc_sutton', [0.65]);
      eq('Z_dranchukAbouKassem', [(180 + 459.67) / F0.Tpc_sutton(0.65), 4000 / F0.Ppc_sutton(0.65)]); eq('m_p', [4000, 180, 0.65]); eq('Bg', [4000, 180, 0.9]);
      // a wide grid over every signature
      const API = [12, 25, 35, 48, 62], SG = [0.58, 0.75, 1.1], RS = [0, 40, 500, 1800], P = [0, 14.7, 600, 2500, 6000, 12000], T = [60, 150, 260], PB = [0, 1500, 3000];
      API.forEach((api) => SG.forEach((sg) => T.forEach((t) => {
        RS.forEach((rs) => { eq('Pb_standing', [api, sg, rs, t]); eq('Bo_standing', [api, sg, rs, t]); });
        P.forEach((p) => {
          eq('Rs_standing', [api, sg, p, t]);
          RS.forEach((rs) => { eq('co_vasquezBeggs', [api, sg, rs, p, t]); PB.forEach((pb) => eq('Bo_undersaturated', [1.3, api, sg, rs, p, t, pb])); });
        });
        eq('mu_oD_beggsRobinson', [api, t]);
      })));
      [0.3, 2, 40].forEach((mu) => RS.forEach((rs) => { eq('mu_o_beggsRobinson', [mu, rs]); P.forEach((p) => PB.forEach((pb) => eq('mu_o_vasquezBeggs', [mu, p, pb]))); }));
      [1.05, 1.3, 1.8, 2.6].forEach((tpr) => [0, 0.5, 2, 6, 12].forEach((ppr) => { eq('Z_dranchukAbouKassem', [tpr, ppr]); eq('Z_hallYarborough', [tpr, ppr]); }));
      SG.forEach((sg) => T.forEach((t) => [0.8, 0.95].forEach((z) => P.forEach((p) => { eq('mu_g_leeGonzalezEakin', [sg, t, z, p]); eq('Bg', [p, t, z]); eq('cg_realGas', [p, t, z, sg]); eq('cg_realGas', [p, t, z]); }))));
      P.forEach((p) => T.forEach((t) => { eq('Bw_meehan', [p, t]); eq('cw_dodson', [p, t, 0]); eq('cw_dodson', [p, t, 15]); [0, 30000, 200000].forEach((s) => eq('mu_w_meehan', [t, s, p])); eq('mu_w_meehan', [t, 0]); }));
      [500, 3000, 8000].forEach((p) => [0.6, 0.9].forEach((sg) => eq('m_p', [p, 200, sg])));
      eq('ct', [0.8, 1e-5, 0.2, 3e-6, 0, 0, 4e-6]); eq('ct', [1, 1e-5]);
      assert.ok(n > 3000, 'evaluations ' + n);
      // the WP13 merge added names only: the self-test of the live file passed with its new check
      const r = app.win.PRiSM_pvt_selfTestResults;
      if (Array.isArray(r)) assert.ok(r.every((c) => c.ok), JSON.stringify(r.filter((c) => !c.ok)));
    },
  },
  {
    name: 'PV2-2 Vasquez-Beggs = the host Solution GOR page (separator normalisation, both API brackets) and the Bubble Point page gravity; Pb inverts Rs; sep argument',
    wp: WP,
    run(_a, assert, ctx) {
      const app = app0(ctx), L = app.win.PRiSM_pvt_correlations;
      const rowNum = (resId, label) => {
        const r = app.findAll('#' + resId + ' .rrow').find((x) => txt(x.querySelector('.rl')).indexOf(label) !== -1);
        if (!r) throw new Error('no row ' + label);
        return parseFloat(txt(r.querySelector('.rv')).replace(/,/g, '').match(/-?\d+(\.\d+)?/)[0]);
      };
      app.hook.nav('solgor');
      const cases = [[500, 150, 0.75, 35, '', ''], [500, 150, 0.75, 35, 100, 150], [500, 150, 0.75, 35, 200, 80], [500, 150, 0.75, 25, '', ''], [2400, 210, 0.82, 28, 350, 95], [3000, 180, 0.68, 44, 60, 70]];
      cases.forEach(([p, t, gg, api, ps, ts]) => {
        ['sg_p', 'sg_t', 'sg_gg', 'sg_api', 'sg_psep', 'sg_tsep'].forEach((id, i) => app.input(id, String([p, t, gg, api, ps, ts][i])));
        app.win.calcSolGOR();
        const psep = ps === '' ? p : ps, tsep = ts === '' ? t : ts;
        const g100 = L.sg_gas100_vasquezBeggs(gg, api, tsep, psep);
        assert.near(rowNum('sg_res', 'Gas Gravity (V'), g100, 5.1e-5, 'γgs ' + [p, t, gg, api, ps, ts]);
        assert.near(rowNum('sg_res', 'Vasquez'), L.Rs_vasquezBeggs(api, gg, p + 14.7, t, { psep_psig: psep, tsep_F: tsep }), 0.051, 'Rs ' + [p, t, gg, api, ps, ts]);
        assert.near(rowNum('sg_res', 'Vasquez'), L.Rs_vasquezBeggs(api, g100, p + 14.7, t), 0.051, 'Rs with the gravity given');
      });
      // the Bubble Point page's corrected gravity is the same relation (psig in)
      app.hook.nav('fluid'); app.click('flt2');
      [['bp_api', 45], ['bp_gor', 300], ['bp_gg', 0.7], ['bp_st', 110], ['bp_sp', 500], ['bp_rt', 440]].forEach(([k, v]) => app.input(k, String(v)));
      app.win.calcBubblePoint();
      assert.near(rowNum('bp_res', 'Corrected Gas Gravity'), L.sg_gas100_vasquezBeggs(0.7, 45, 110, 500), 5.1e-5);
      // 100 psig = identity, the brackets, the inverse and the FVF by hand
      assert.strictEqual(L.sg_gas100_vasquezBeggs(0.8, 30, 120, 100), 0.8);
      const sep = { psep_psig: 250, tsep_F: 90 };
      [[22, 0.8], [30, 0.7], [30.01, 0.7], [42, 0.66]].forEach(([api, gg]) => {
        const T = 190, rs = 450, g = L.sg_gas100_vasquezBeggs(gg, api, 90, 250);
        const pb = L.Pb_vasquezBeggs(api, gg, rs, T, sep);
        assert.rel(L.Rs_vasquezBeggs(api, gg, pb, T, sep), rs, 1e-12, 'inverse at API ' + api);
        const c = api <= 30 ? [4.677e-4, 1.751e-5, -1.811e-8] : [4.670e-4, 1.100e-5, 1.337e-9];
        assert.rel(L.Bo_vasquezBeggs(api, gg, rs, T, sep), 1 + c[0] * rs + (T - 60) * (api / g) * (c[1] + c[2] * rs), 1e-14, 'Bo at API ' + api);
      });
      assert.strictEqual(L.Rs_vasquezBeggs(35, 0.7, 0, 150), 0);
      assert.strictEqual(L.Pb_vasquezBeggs(35, 0.7, 0, 150), 14.7);
      assert.ok(Number.isNaN(L.Rs_vasquezBeggs(35, 0.7, 'x', 150)));
      // the builder passes the separator conditions to the march only for this family
      const W = app.win.WTS_wp_fluid;
      const Fv = W.build(OIL({ pb: 'vasquezBeggs', rs: 'vasquezBeggs', bo: 'vasquezBeggs' }, { psep_psig: 250, tsep_F: 90 }), { T_F: 190 });
      assert.deepStrictEqual(J(JSON.parse(JSON.stringify(Fv.pvt.sep))), { psep_psig: 250, tsep_F: 90 });
      assert.rel(Fv.sg100, L.sg_gas100_vasquezBeggs(0.75, 35, 90, 250), 1e-14);
      assert.rel(Fv.at(1200, 190).rs, L.Rs_vasquezBeggs(35, 0.75, 1200, 190, sep), 1e-12, 'march Rs');
      assert.rel(Fv.pb(190), L.Pb_vasquezBeggs(35, 0.75, 600, 190, sep), 1e-12, 'march pb');
      assert.ok(Fv.warnings.some((w) => w.code === 'VB_SG100'));
      const Fb = W.build(OIL({ rs: 'vasquezBeggs', bo: 'standing' }, { psep_psig: null }), { T_F: 190 });
      assert.ok(!Fb.pvt.sep && Fb.warnings.some((w) => w.code === 'VB_SEP_BLANK') && Fb.warnings.some((w) => w.code === 'PB_FOLLOWS_RS'));
      assert.ok(!W.build(OIL(), { T_F: 190 }).pvt.sep, 'Standing: no sep');
    },
  },
  {
    name: 'PV2-3 Glasø Pb / Rs / Bo from the published equations (independent code); Rs inverts Pb; Rs flat above the vertex, no NaN in the march',
    wp: WP,
    run(_a, assert, ctx) {
      const app = app0(ctx), L = app.win.PRiSM_pvt_correlations, lg = Math.log10;
      [[35, 0.75, 600, 200], [25, 0.9, 150, 120], [45, 0.65, 1500, 260]].forEach(([api, gg, rs, T]) => {
        const go = 141.5 / (131.5 + api);
        const ps = Math.pow(rs / gg, 0.816) * Math.pow(T, 0.172) * Math.pow(api, -0.989);
        const pb = Math.pow(10, 1.7669 + 1.7447 * lg(ps) - 0.30218 * lg(ps) * lg(ps));
        assert.rel(L.Pb_glaso(api, gg, rs, T), pb, 1e-13, 'pb');
        const bs = rs * Math.pow(gg / go, 0.526) + 0.968 * T;
        assert.rel(L.Bo_glaso(api, gg, rs, T), 1 + Math.pow(10, -6.58511 + 2.91329 * lg(bs) - 0.27683 * lg(bs) * lg(bs)), 1e-13, 'Bo');
        const x = 2.8869 - Math.sqrt(14.1811 - 3.3093 * lg(pb));
        assert.rel(L.Rs_glaso(api, gg, pb, T), gg * Math.pow(Math.pow(api, 0.989) / Math.pow(T, 0.172) * Math.pow(10, x), 1 / 0.816), 1e-13, 'Rs');
        assert.rel(L.Rs_glaso(api, gg, pb, T), rs, 5e-4, 'Rs inverts Pb to the printed constants');
      });
      const vmax = Math.pow(10, 14.1811 / 3.3093);
      assert.ok(vmax > 19000 && vmax < 19500, 'vertex ' + vmax);
      assert.strictEqual(L.Rs_glaso(35, 0.75, 25000, 200), L.Rs_glaso(35, 0.75, vmax, 200), 'flat above the vertex');
      assert.ok(isFinite(L.Rs_glaso(35, 0.75, 30000, 200)));
      const F = app.win.WTS_wp_fluid.build(OIL({ pb: 'glaso', rs: 'glaso', bo: 'glaso' }), { T_F: 200 });
      [14.7, 500, 2000, 6000, 25000].forEach((p) => { const r = F.at(p, 200); assert.ok(isFinite(r.rs) && isFinite(r.bo) && isFinite(r.rhoO), 'finite at ' + p); });
      assert.rel(F.pb(200), L.Pb_glaso(35, 0.75, 600, 200), 1e-12);
      assert.rel(F.at(1000, 200).bo, L.Bo_glaso(35, 0.75, L.Rs_glaso(35, 0.75, 1000, 200), 200), 1e-12);
    },
  },
  {
    name: 'PV2-4 Petrosky-Farshad Pb / Rs / Bo / co by hand; the march undersaturated Bo with corr.co petrosky = the closed-form integral',
    wp: WP,
    run(_a, assert, ctx) {
      const app = app0(ctx), L = app.win.PRiSM_pvt_correlations;
      const api = 32, gg = 0.8, T = 210, rs = 700, go = 141.5 / (131.5 + api);
      const X = 7.916e-4 * Math.pow(api, 1.5410) - 4.561e-5 * Math.pow(T, 1.3911);
      const pb = 112.727 * (Math.pow(rs, 0.5774) / (Math.pow(gg, 0.8439) * Math.pow(10, X)) - 12.340);
      assert.rel(L.Pb_petrosky(api, gg, rs, T), pb, 1e-13);
      assert.rel(L.Rs_petrosky(api, gg, pb, T), Math.pow((pb / 112.727 + 12.340) * Math.pow(gg, 0.8439) * Math.pow(10, X), 1.73184), 1e-13);
      assert.rel(L.Rs_petrosky(api, gg, pb, T), rs, 5e-4, 'inverse to the printed constants');
      const Fb = Math.pow(rs, 0.3738) * Math.pow(gg, 0.2914) / Math.pow(go, 0.6265) + 0.24626 * Math.pow(T, 0.5371);
      assert.rel(L.Bo_petrosky(api, gg, rs, T), 1.0113 + 7.2046e-5 * Math.pow(Fb, 3.0936), 1e-13);
      const A = 1.705e-7 * Math.pow(rs, 0.69357) * Math.pow(gg, 0.1885) * Math.pow(api, 0.3272) * Math.pow(T, 0.6729);
      assert.rel(L.co_petrosky(api, gg, rs, 4000, T), A * Math.pow(4000, -0.5906), 1e-13);
      assert.ok(Number.isNaN(L.co_petrosky(api, gg, rs, 0, T)));
      // the march: Bo above pb = Bob·exp[(A/0.4094)·(pb^0.4094 − p^0.4094)]
      const spec = OIL({ pb: 'petrosky', rs: 'petrosky', bo: 'petrosky', co: 'petrosky' }, { api, sgg: gg, gor: rs });
      const F = app.win.WTS_wp_fluid.build(spec, { T_F: T });
      assert.strictEqual(F.pvt.corr.co, 'petrosky');
      const pbF = F.pb(T);
      assert.rel(pbF, pb, 1e-12);
      const bob = L.Bo_petrosky(api, gg, rs, T);
      [pbF * 1.05, 4500, 7000].forEach((p) => {
        const want = bob * Math.exp((A / 0.4094) * (Math.pow(pbF, 0.4094) - Math.pow(p, 0.4094)));
        assert.rel(F.at(p, T).bo, want, 1e-9, 'Bo at ' + p);
      });
      // the table reports co from the selected key above pb; the Vasquez-Beggs co stays the default
      const tb = F.table([pbF * 1.2], T).rows[0];
      assert.rel(tb.co, L.co_petrosky(api, gg, rs, pbF * 1.2, T), 1e-14);
      const Fd = app.win.WTS_wp_fluid.build(OIL(null, { api, sgg: gg, gor: rs }), { T_F: T });
      assert.ok(!('co' in Fd.pvt.corr));
      assert.rel(Fd.table([Fd.pb(T) * 1.2], T).rows[0].co, L.co_vasquezBeggs(api, gg, rs, Fd.pb(T) * 1.2, T), 1e-14);
    },
  },
  {
    name: 'PV2-5 viscosity: Egbogah and Bergman-Sutton dead oil, Chew-Connally live oil by hand; the march uses the selected chain',
    wp: WP,
    run(_a, assert, ctx) {
      const app = app0(ctx), L = app.win.PRiSM_pvt_correlations;
      [[20, 120], [35, 150], [50, 250]].forEach(([api, T]) => {
        assert.rel(L.mu_oD_egbogah(api, T), Math.pow(10, Math.pow(10, 1.8653 - 0.025086 * api - 0.5644 * Math.log10(T))) - 1, 1e-13, 'Egbogah');
        const A0 = 22.33 - 0.194 * api + 0.00033 * api * api, A1 = -3.2 + 0.0185 * api;
        assert.rel(L.mu_oD_bergmanSutton(api, T), Math.exp(Math.exp(A0 + A1 * Math.log(T + 310))) - 1, 1e-13, 'Bergman-Sutton');
        // the three dead-oil correlations agree within a factor of 2 on these oils (plausibility, not verification)
        const br = L.mu_oD_beggsRobinson(api, T);
        [L.mu_oD_egbogah(api, T), L.mu_oD_bergmanSutton(api, T)].forEach((v) => assert.ok(v > br / 2 && v < br * 2, api + '/' + T + ': ' + v + ' vs ' + br));
      });
      [0, 150, 800, 2000].forEach((rs) => {
        const a = rs * (2.2e-7 * rs - 7.4e-4), b = 0.68 / Math.pow(10, 8.62e-5 * rs) + 0.25 / Math.pow(10, 1.1e-3 * rs) + 0.062 / Math.pow(10, 3.74e-3 * rs);
        assert.rel(L.mu_o_chewConnally(3, rs), Math.pow(10, a) * Math.pow(3, b), 1e-13, 'Chew-Connally Rs ' + rs);
      });
      assert.rel(L.mu_o_chewConnally(3, 0), Math.pow(3, 0.992), 1e-13);
      assert.ok(L.mu_o_chewConnally(3, 800) < 3);
      const F = app.win.WTS_wp_fluid.build(OIL({ muod: 'egbogah', muo: 'chewConnally' }), { T_F: 200 });
      const r = F.at(1200, 180);
      assert.rel(r.muo, L.mu_o_chewConnally(L.mu_oD_egbogah(35, 180), r.rs), 1e-12, 'march μo');
      const Fb = app.win.WTS_wp_fluid.build(OIL({ muod: 'bergmanSutton' }), { T_F: 200 });
      assert.rel(Fb.at(1200, 180).muo, L.mu_o_beggsRobinson(L.mu_oD_bergmanSutton(35, 180), r.rs), 1e-12);
      // above pb the Vasquez-Beggs undersaturated factor applies to the selected chain
      const pb = F.pb(200), p = pb * 1.4, rb = F.at(p, 200);
      assert.rel(rb.muo, L.mu_o_vasquezBeggs(L.mu_o_chewConnally(L.mu_oD_egbogah(35, 200), 600), p, pb), 1e-12);
    },
  },
  {
    name: 'PV2-6 McCain water: ρw from salinity, Bw (= the A1 Bw_meehan coefficients), Rsw with the salinity correction, in-situ ρw; the builder takes γw from the salinity',
    wp: WP,
    run(_a, assert, ctx) {
      const app = app0(ctx), L = app.win.PRiSM_pvt_correlations;
      [0, 35000, 150000, 300000].forEach((ppm) => { const s = ppm / 1e4; assert.rel(L.rho_w_mcCain(ppm), 62.368 + 0.438603 * s + 1.60074e-3 * s * s, 1e-14, 'ρw ' + ppm); });
      assert.rel(L.rho_w_mcCain(100000, 1.03, 15, 0.7), (L.rho_w_mcCain(100000) + 0.01361 * 15 * 0.7) / 1.03, 1e-14, 'in situ with dissolved gas');
      assert.rel(L.rho_w_mcCain(100000, 1.03), L.rho_w_mcCain(100000) / 1.03, 1e-14);
      [[14.7, 60], [3000, 200], [8000, 280]].forEach(([p, t]) => assert.ok(Math.abs(L.Bw_mcCain(p, t) - L.Bw_meehan(p, t)) <= 1e-15, 'same McCain coefficients at ' + p + ' / ' + t));
      // Rsw (pure water) by hand at 3,000 psia / 200 °F, then the salinity factor
      const T = 200, P = 3000;
      const A = 8.15839 - 6.12265e-2 * T + 1.91663e-4 * T * T - 2.1654e-7 * T * T * T;
      const B = 1.01021e-2 - 7.44241e-5 * T + 3.05553e-7 * T * T - 2.94883e-10 * T * T * T;
      const C = -1e-7 * (9.02505 - 0.130237 * T + 8.53425e-4 * T * T - 2.34122e-6 * T * T * T + 2.37049e-9 * T * T * T * T);
      const rp = A + B * P + C * P * P;
      assert.rel(L.Rsw_mcCain(P, T, 0), rp, 1e-13);
      assert.ok(rp > 10 && rp < 25, 'pure-water solubility ' + rp);
      assert.rel(L.Rsw_mcCain(P, T, 100000), rp * Math.pow(10, -0.0840655 * 10 * Math.pow(T, -0.285854)), 1e-13);
      assert.strictEqual(L.Rsw_mcCain(0, T, 0), 0);
      // builder: blank γw + salinity → McCain standard density; the march water density follows; table Rsw
      const W = app.win.WTS_wp_fluid;
      const F = W.build({ type: 'water', sgw: null, salinity_ppm: 120000 }, { T_F: 200 });
      assert.ok(F.ok, JSON.stringify(F.errors));
      assert.rel(F.sgw, L.rho_w_mcCain(120000) / 62.368, 1e-14);
      assert.ok(F.warnings.some((w) => w.code === 'SGW_MCCAIN'));
      const r = F.at(3000, 200, 1000);
      assert.rel(r.rhoW, 62.366 * F.sgw / L.Bw_meehan(3000, 200), 1e-12, 'march ρw');
      const tr = F.table([3000], 200, 1000).rows[0];
      assert.rel(tr.rsw, L.Rsw_mcCain(3000, 200, 120000), 1e-14);
      assert.ok(!W.build({ type: 'water', sgw: null }).ok, 'no γw and no salinity: still an error');
      assert.ok(W.build({ type: 'water', sgw: 1.05, salinity_ppm: -5 }).bad.indexOf('salinity_ppm') >= 0, 'salinity range');
      assert.strictEqual(W.build({ type: 'water', sgw: 1.05, salinity_ppm: 120000 }).sgw, 1.05, 'an entered γw wins');
    },
  },
  {
    name: 'PV2-7 Abdul-Majeed σ by hand and in the march at the in-situ Rs (dead for the condensate); the A1 path is unchanged bit for bit',
    wp: WP,
    run(_a, assert, ctx) {
      const app = app0(ctx), G = app.win, L = G.PRiSM_pvt_correlations, W = G.WTS_wp_fluid;
      const sig = (api, t, rs) => (1.17013 - 1.694e-3 * t) * (38.085 - 0.259 * api) * (0.056379 + 0.94362 * Math.exp(-3.8491e-3 * rs));
      [[35, 150, 0], [35, 150, 500], [22, 220, 1200]].forEach(([a, t, r]) => assert.rel(L.sigma_og_abdulMajeed(a, t, r), sig(a, t, r), 1e-14));
      const F = W.build(OIL({ sigma: 'abdulMajeed' }), { T_F: 200 });
      assert.strictEqual(F.pvt.corr.sigma, 'abdulMajeed');
      const r = F.at(1500, 180);
      assert.rel(r.sigO, Math.max(1, sig(35, 180, r.rs)), 1e-12, 'σo at the in-situ Rs');
      const Fc = W.build(Object.assign({}, S.FIX.gasWell.fluid, { corr: { sigma: 'abdulMajeed' } }), { T_F: 220 });
      const rc = Fc.at(1500, 150);
      assert.rel(rc.sigO, Math.max(1, sig(Fc.api, 150, 0)), 1e-12, 'condensate: dead-oil value (Rs = 0)');
      // A1 path: the default keys spelled out, or the default co / sigma named, give the same props as the A1 pvt object
      const KEYS = ['rs', 'bo', 'z', 'bg', 'muo', 'mug', 'rhoO', 'rhoG', 'sigO', 'sigW', 'qL', 'qG', 'rhoL', 'muL', 'sigL'];
      const F1 = W.build(OIL(), { T_F: 200 });
      const F2 = W.build(OIL({ pb: 'standing', rs: 'standing', bo: 'standing', co: 'vasquezBeggs', sigma: 'bakerSwerdloff', muod: 'beggsRobinson', muo: 'beggsRobinson', z: 'dranchukAbouKassem', mug: 'leeGonzalezEakin' }), { T_F: 200 });
      assert.deepStrictEqual(J(JSON.parse(JSON.stringify(F2.pvt))), JSON.parse(JSON.stringify(F1.pvt)), 'same pvt object');
      const fl = G.WTS_wp_fluid.flowlineFluid(F1, 1000);
      const raw = { qo: fl.qo, qw: fl.qw, qg: fl.qg, api: fl.api, sgg: fl.sgg, sgw: fl.sgw };
      // an explicit pvt with the default co spelled out = the A1 pvt (Bo_undersaturated branch)
      const pvtCo = Object.assign({}, JSON.parse(JSON.stringify(F1.pvt))); pvtCo.corr.co = 'vasquezBeggs';
      [[300, 90], [1800, 200], [2600, 200], [5000, 200]].forEach(([p, t]) => {
        const a = F1.at(p, t), b = F2.at(p, t), c = G.WTS_flowline_props(Object.assign({}, raw, { pvt: pvtCo }), p, t);
        KEYS.forEach((k) => { assert.ok(Object.is(a[k], b[k]), k + ' ' + p); assert.ok(Object.is(a[k], c[k]), k + ' co named ' + p); });
      });
      const d = G.WTS_flowline_props(raw, 1000, 150);
      assert.rel(d.sigO, F1.at(1000, 150).sigO, 1e-15, 'no pvt object: Baker & Swerdloff as before');
    },
  },
  {
    name: 'PV2-8 D17 gate: every new correlation provisional (PRiSM_pvt_corrInfo), no default provisional, families() order, validity messages and F.provisional; published examples not verifiable (Q9)',
    wp: WP,
    run(_a, assert, ctx) {
      const app = app0(ctx), G = app.win, I = G.PRiSM_pvt_corrInfo, W = G.WTS_wp_fluid;
      NEW_KEYS.concat(['Z_hallYarborough']).forEach((k) => {
        assert.ok(I[k], k + ' has metadata');
        assert.strictEqual(I[k].verified, false, k + ' provisional');
        assert.match(I[k].note, /provisional — not verified against a published example/);
        assert.ok(I[k].label && I[k].slot && I[k].family && I[k].ref, k + ' fields');
      });
      assert.deepStrictEqual(J(I.Rs_glaso.range), { api: [22.3, 48.1], t: [80, 280], rs: [90, 2637] }, 'Appendix A range');
      const fam = W.families();
      Object.keys(fam).forEach((sl) => {
        assert.strictEqual(fam[sl][0].key, W.CORR_DEFAULT[sl], sl + ' default first');
        assert.strictEqual(fam[sl][0].verified, true, sl + ' default not provisional');
        fam[sl].slice(1).forEach((o) => assert.strictEqual(o.verified, false, sl + ' ' + o.key));
      });
      assert.deepStrictEqual(J(fam.rs.map((o) => o.key)), ['standing', 'vasquezBeggs', 'glaso', 'petrosky']);
      assert.deepStrictEqual(J(fam.muod.map((o) => o.key)), ['beggsRobinson', 'egbogah', 'bergmanSutton']);
      assert.deepStrictEqual(J(fam.z.map((o) => o.key)), ['dranchukAbouKassem', 'hallYarborough']);
      assert.deepStrictEqual(J(fam.co.map((o) => o.key)), ['vasquezBeggs', 'petrosky']);
      assert.deepStrictEqual(J(fam.sigma.map((o) => o.key)), ['bakerSwerdloff', 'abdulMajeed']);
      // the defaults carry no provisional label; the selection lists every provisional one in use
      const F0 = W.build(OIL(), { T_F: 200 });
      assert.deepStrictEqual(J(F0.provisional), []);
      assert.ok(F0.validity.every((v) => !/provisional/.test(v.msg)));
      const F = W.build(OIL({ pb: 'glaso', rs: 'glaso', bo: 'glaso', muod: 'egbogah', muo: 'chewConnally', co: 'petrosky', sigma: 'abdulMajeed', z: 'hallYarborough' }), { T_F: 200, tMin: 90, tMax: 200, pMin: 300, pMax: 3000 });
      assert.deepStrictEqual(J(F.provisional), ['Glasø solution GOR', 'Glasø oil FVF', 'Egbogah dead-oil viscosity', 'Chew-Connally live-oil viscosity', 'Petrosky-Farshad undersaturated co', 'Abdul-Majeed gas-oil surface tension', 'Hall-Yarborough Z factor']);
      const msgs = F.validity.map((v) => v.msg);
      ['Glasø Pb / Rs / Bo', 'Petrosky-Farshad Pb / Rs / Bo / co', 'Egbogah', 'Chew-Connally', 'Abdul-Majeed', 'Hall-Yarborough'].forEach((l) => assert.ok(msgs.some((m) => m.indexOf(l) !== -1 && /provisional/.test(m)), l + ' validity: ' + msgs.join(' | ')));
      assert.ok(msgs.some((m) => /^Standing Pb \/ Rs \/ Bo: not used/.test(m)), 'Standing not used');
      // the range check works on the families: 15 °API is outside Glasø's 22.3–48.1
      const Fo = W.build(OIL({ pb: 'glaso', rs: 'glaso', bo: 'glaso' }, { api: 15 }), { T_F: 200 });
      const vg = Fo.validity.find((v) => v.corr === 'glaso');
      assert.ok(vg && vg.inRange === false && /API 15 is outside 22\.3–48\.1/.test(vg.msg), vg && vg.msg);
      // WTS_wp_check carries the family verdicts to the page's validity card (provisional in the text)
      const M = JSON.parse(JSON.stringify(S.FIX.oilWell)); M.fluid.corr = Object.assign({}, M.fluid.corr || {}, { pb: 'glaso', rs: 'glaso', bo: 'glaso' });
      const ck = G.WTS_wp_check(M);
      assert.ok(ck.validity.some((v) => /Glasø/.test(v.msg) && /provisional/.test(v.msg)), JSON.stringify(ck.validity.map((v) => v.msg)));
      // published-example benchmarks: the owner did not provide the textbooks (Q9), so no family is verified — the gate holds
      assert.ok(Object.keys(I).every((k) => I[k].verified === false));
    },
  },
  {
    name: 'PV2-9 page: Fluid properties card — families overlaid (provisional dashed), chips with pb and range state, spread verdict, comparison table in the report, case summary; a chip click selects the family and solves',
    wp: WP,
    run(_a, assert, ctx) {
      const app = app0(ctx); S.resetWellPerf(app);
      open(app); example(app, 'oil'); step(app, 1);
      ['wp_corr_pb', 'wp_corr_rs', 'wp_corr_bo', 'wp_corr_co', 'wp_corr_muod', 'wp_corr_muo', 'wp_corr_sigma', 'wp_corr_z', 'wp_corr_mug'].forEach((id) => assert.ok(app.el(id), id));
      const opts = (id) => Array.prototype.map.call(app.el(id).options, (o) => o.value + '|' + o.textContent);
      assert.deepStrictEqual(J(opts('wp_corr_pb')), ['standing|Standing', 'vasquezBeggs|Vasquez-Beggs — provisional', 'glaso|Glasø — provisional', 'petrosky|Petrosky-Farshad — provisional']);
      assert.ok(opts('wp_corr_z').indexOf('hallYarborough|Hall-Yarborough — provisional') >= 0);
      const cv = app.el('wp_cv_pvt');
      assert.ok(cv && cv._wp, 'property plot drawn');
      const sp = cv._wp.spec, keys = sp.series.map((x) => x.key);
      assert.deepStrictEqual(J(keys), ['c_vasquezBeggs', 'c_glaso', 'c_petrosky', 'sel'], 'three other families + the selected (Standing) on the Rs plot');
      assert.ok(sp.series.filter((x) => /^c_/.test(x.key)).every((x) => Array.isArray(x.dash) && /\(prov\.\)/.test(x.label)), 'provisional dashed and labelled');
      assert.ok(sp.series.find((x) => x.key === 'sel').width >= 3);
      assert.ok(sp.markers.filter((m) => m.kind === 'diamond').length === 3 && sp.markers.some((m) => m.kind === 'filled'), 'pb markers');
      assert.ok(sp.handles.length === 1 && sp.handles[0].key === 'pb' && sp.handles[0].kind === 'pointX', 'pb drag handle');
      assert.ok(sp.vlines.some((v) => v.label === 'p̄r'));
      const chips = app.findAll('#wp_pvtchips .wp-fchip');
      assert.strictEqual(chips.length, 4);
      assert.ok(/sel/.test(chips[0].className) && /Standing/.test(txt(chips[0])) && /pb [\d,]+ psia/.test(txt(chips[0])), txt(chips[0]));
      assert.ok(chips.slice(1).every((c) => /provisional/.test(txt(c))));
      assert.ok(chips.every((c) => /st-(ok|warn)/.test(c.className)));
      assert.match(txt(app.el('wp_pvtverd')), /bubble-point correlations (differ|agree)/);
      const tbl = app.find('#wp_pvtcmp table');
      assert.ok(tbl && app.findAll('#wp_pvtcmp tbody tr').length === 4, 'comparison table');
      assert.match(txt(tbl), /● Standing/);
      // report: the card (canvas + table) and the case summary row
      const rep = JSON.stringify(app.win.collectPageReport(app.el('pgBody'), { charts: false }));
      assert.ok(/Black-oil family/.test(rep) && /Fluid properties/.test(rep), 'comparison table + card in the report');
      assert.ok(/PVT correlations/.test(rep) && /Pb \/ Rs Standing/.test(rep), 'case summary row');
      assert.ok(!/Fluid properties[^"]*wp-fchip/.test(rep));
      // a chip click selects the family for Pb / Rs / Bo and solves
      const n0 = app.win.WTS_wellperf_page.calcs();
      app.click(app.find('#wp_pvtchips [data-k="glaso"]')); app.flush(30);
      assert.ok(app.win.WTS_wellperf_page.calcs() > n0, 'solved');
      ['wp_corr_pb', 'wp_corr_rs', 'wp_corr_bo'].forEach((id) => assert.strictEqual(app.el(id).value, 'glaso', id));
      const M = app.win.WTS_wellperf_page.state().M;
      assert.strictEqual(M.fluid.corr.rs, 'glaso');
      assert.ok(/sel/.test(app.find('#wp_pvtchips [data-k="glaso"]').className));
      assert.match(txt(app.el('wp_case')), /Pb \/ Rs Glasø \(provisional\)/);
      assert.match(txt(app.el('wp_valid')), /Glasø Pb \/ Rs \/ Bo.*provisional/);
      assert.deepStrictEqual(J(app.el('wp_cv_pvt')._wp.spec.series.map((x) => x.key)), ['c_standing', 'c_vasquezBeggs', 'c_petrosky', 'sel']);
      // the Rs selector moves the family selector (the bubble point follows Rs)
      app.change('wp_corr_rs', 'petrosky'); app.flush(30);
      assert.strictEqual(app.el('wp_corr_pb').value, 'petrosky');
      assert.strictEqual(app.el('wp_corr_bo').value, 'glaso', 'Bo stays as chosen');
      const rec = JSON.parse(app.storage.getItem('wts_page_wellperf') || '{}');
      app.flush(1200);
      const rec2 = JSON.parse(app.storage.getItem('wts_page_wellperf') || '{}');
      assert.ok((rec2.f || rec.f || {}).wp_corr_rs === 'petrosky', 'autosaved');
      ['wp_step_1', 'wp_res'].forEach((id) => assert.ok(!BAD.test(txt(app.el(id))), id + ' clean'));
      assert.strictEqual(app.consoleErrors().length, 0);
      S.resetWellPerf(app);
    },
  },
  {
    name: 'PV2-10 page: the pb handle previews on move (no solve) and commits on release (one-point shift, Clear); keyboard; property switch (pref); gas Z comparison; Metric labels',
    wp: WP,
    run(_a, assert, ctx) {
      const app = app0(ctx); S.resetWellPerf(app);
      open(app); example(app, 'oil'); step(app, 1);
      const P = app.win.WTS_wellperf_page, cv = () => app.el('wp_cv_pvt');
      const h0 = cv()._wp.spec.handles[0], pb0 = h0.value;
      const n0 = P.calcs();
      cv()._wp.spec.onHandle('pb', 2400, 'move');
      assert.strictEqual(P.calcs(), n0, 'a move previews without a solve');
      assert.strictEqual(app.el('wp_pbUser').value, '2400');
      const sel = cv()._wp.spec.series.find((x) => x.key === 'sel');
      assert.match(sel.label, /pb shifted/);
      assert.ok(cv()._wp.spec.series.some((x) => x.key === 'c_standing' && /correlation pb/.test(x.label)), 'the unshifted correlation stays as a reference');
      assert.strictEqual(cv()._wp.spec.handles[0].value, 2400);
      cv()._wp.spec.onHandle('pb', 2400, 'end'); app.flush(30);
      assert.ok(P.calcs() > n0, 'release commits and solves');
      const M = P.state().M;
      assert.strictEqual(M.fluid.pbUser, 2400);
      assert.ok(P.state().F.pbShift && Math.abs(P.state().F.pb(M.res.T_F) - 2400) < 1e-6, 'one-point shift applied');
      assert.match(txt(app.el('wp_pvtclr')), /Clear pb shift \(2,400 psia\)/);
      assert.match(txt(app.el('wp_case')), /pb shifted to 2,400 psia/);
      // keyboard: the handle steps 5 psi per arrow and Enter commits
      const c = cv(), key = (k) => c.dispatchEvent(new app.win.KeyboardEvent('keydown', { key: k, bubbles: true }));
      c._wp.focusHandle = -1; key(']'); key('ArrowRight'); key('ArrowRight'); key('Enter'); app.flush(30);
      assert.strictEqual(P.state().M.fluid.pbUser, 2410, 'keyboard 2400 → 2410');
      app.click(app.find('[data-act="pbclear"]')); app.flush(30);
      assert.strictEqual(P.state().M.fluid.pbUser, null, 'cleared');
      assert.ok(Math.abs(cv()._wp.spec.handles[0].value - pb0) < 1e-6, 'back to the correlation pb');
      // property switch (device pref) — Bo, μo (the dead-oil options compared), Z, density
      app.click(app.find('#wp_pvtseg [data-k="bo"]'));
      assert.match(cv()._wp.spec.y.label, /^Bo/);
      app.click(app.find('#wp_pvtseg [data-k="muo"]'));
      assert.deepStrictEqual(J(cv()._wp.spec.series.map((x) => x.key)), ['c_egbogah', 'c_bergmanSutton', 'sel']);
      app.click(app.find('#wp_pvtseg [data-k="rho"]'));
      assert.deepStrictEqual(J(cv()._wp.spec.series.map((x) => x.key)), ['rhoO', 'rhoG', 'rhoW']);
      assert.strictEqual(JSON.parse(app.storage.getItem('wtspref_wp_plots')).pvtProp, 'rho');
      assert.ok(/aria-pressed="true"/.test(app.el('wp_pvtseg').innerHTML));
      // the gas well: Z / μg / Bg / density; Hall-Yarborough compared with DAK in a table
      example(app, 'gas'); step(app, 1);
      assert.deepStrictEqual(J(app.findAll('#wp_pvtseg button').map((b) => b.getAttribute('data-k'))), ['z', 'mug', 'bg', 'rho']);
      app.click(app.find('#wp_pvtseg [data-k="z"]'));
      assert.deepStrictEqual(J(cv()._wp.spec.series.map((x) => x.key)), ['c_hallYarborough', 'sel']);
      assert.strictEqual(cv()._wp.spec.handles.length, 0, 'no pb handle for a gas');
      assert.strictEqual(app.findAll('#wp_pvtchips .wp-fchip').length, 0);
      assert.match(txt(app.el('wp_pvtcmp')), /Z correlation at p̄r.*Dranchuk-Abou-Kassem.*Hall-Yarborough \(provisional\)/);
      // Metric: the axis follows the unit system
      const U = app.win.WTS_units;
      U.setSystem('metric'); app.flush(30);
      try {
        assert.ok(/kPa|bar/.test(cv()._wp.spec.x.label), cv()._wp.spec.x.label);
        assert.ok(!BAD.test(txt(app.el('wp_step_1'))));
      } finally { U.setSystem('imperial'); app.flush(30); }
      assert.strictEqual(app.consoleErrors().length, 0);
      S.resetWellPerf(app);
    },
  },
];
