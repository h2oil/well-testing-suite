// Well Performance fluid engine (WP1) — docs/WELL-PERFORMANCE-PLAN.md §3.2, §4.1, §15.2, §17.1 (wellperf-pvt, 8 tests).
//
// PV1 the Standing / Beggs-Robinson path through fluid.pvt: below the bubble point F.at equals the default flowline props bit for
//     bit; hand values of Standing Rs / Bo and Beggs-Robinson μo; above the bubble point Rs = GOR, Bo = Bob·(p/pb)^(−A/1e5) and the
//     Vasquez-Beggs μo by hand; F.pb = the Standing bubble point
// PV2 one-point bubble-point shift (Rs(pbUser) = GOR at the reservoir temperature; no temperature → a warning and no shift)
// PV3 wet gas (D14): Rs = 0, all the separator gas is free gas at the separator gravity, condensate of constant volume B_c,
//     in-situ mass = standard mass (no double count); recombine by hand (mass and moles balance) and its inverse; 'total' basis
// PV4 mass balance top = bottom of a traverse: wet gas exact (1e-9); oil exact once the flowline's dissolved-gas density
//     constant (0.01361 lbm/ft³ per scf/STB) is replaced by the base-condition air density (the only residual, finding for WP0b)
// PV5 checks: required inputs (no defaults), Appendix A validity verdicts and warnings, unknown correlation key, impurities
// PV6 the table and the traverse use one path: the marcher's inlet props = F.at; F.table rows = F.at; WTS_wp_fluid.table = F.table
// PV7 flowlineFluid rate bases and units (liquid STB/d split by WC, separator gas Mscf/d → MMscf/d with CGR / WGR, water BWPD,
//     explicit object), in-situ volumetric rates by hand
// PV8 the (p, T)-binned property table: lookup error on a grid and the BHP of an 8,000 ft traverse within 0.05 % (§4.5)
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP1';
const app0 = (ctx) => S.sharedApp(ctx);
const plain = (x) => JSON.parse(JSON.stringify(x));
const RANK = 459.67, MW_AIR = 28.9647, R_GAS = 10.7316, FT3_BBL = 5.614583, RHO_W = 62.366;
const RHO_AIR = 14.696 * MW_AIR / (R_GAS * (60 + RANK));   // lbm/scf at the default base conditions (60 °F, 14.696 psia)
const OIL = () => Object.assign(S.FIX.oilWell.fluid, {});    // 35 °API, γg 0.65, GOR 500, WC 0.30, γw 1.07
const GAS = () => S.FIX.gasWell.fluid;                       // condensate: separator γg 0.65, CGR 20, WGR 2, 55 °API
const SEG8000 = () => [{ len: 8000, id: 2.441, dz: 8000 }];

// in-situ mass rate (lbm/s) from a props object
function mdot(r) { return r.rhoO * r.qL * r.fo + r.rhoW * r.qL * r.fw + r.rhoG * r.qG; }

module.exports = [
  {
    name: 'PV1 Standing path through fluid.pvt: = the default flowline props below Pb (bit for bit); Standing Rs / Bo and Beggs-Robinson μo by hand; undersaturated Bo and μo by hand; F.pb',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const app = app0(ctx), G = app.win, W = G.WTS_wp_fluid, L = G.PRiSM_pvt_correlations;
      const F = W.build(OIL(), { T_F: 200 });
      assert.ok(F.ok, JSON.stringify(F.errors));
      assert.ok(Object.isFrozen(F) && Object.isFrozen(F.pvt) && Object.isFrozen(F.pvt.corr), 'F and its pvt object are frozen');
      assert.deepStrictEqual(plain(F.pvt), { corr: { rs: 'standing', bo: 'standing', muod: 'beggsRobinson', muo: 'beggsRobinson', z: 'dranchukAbouKassem', mug: 'leeGonzalezEakin' }, undersat: true });
      assert.ok((G.__WP_STUBS || []).every((n) => !/^WTS_wp_fluid\./.test(n)), 'WP1 names removed from __WP_STUBS');
      const ff = W.flowlineFluid(F, 1000), plainFl = { qo: ff.qo, qw: ff.qw, qg: ff.qg, api: ff.api, sgg: ff.sgg, sgw: ff.sgw };
      const KEYS = ['p', 't', 'gor', 'rs', 'bo', 'bw', 'z', 'bg', 'muo', 'muw', 'mug', 'rhoO', 'rhoW', 'rhoG', 'sigO', 'sigW', 'freeGas', 'qL', 'qG', 'fo', 'fw', 'rhoL', 'muL', 'sigL'];
      [[300, 90], [1000, 150], [1800, 200], [2400, 200]].forEach(([p, t]) => {
        const a = F.at(p, t), b = G.WTS_flowline_props(plainFl, p, t);
        KEYS.forEach((k) => assert.ok(Object.is(a[k], b[k]), k + ' at ' + p + ' psia / ' + t + ' °F: ' + a[k] + ' vs ' + b[k]));
        assert.strictEqual(a.pvt, true);
      });
      // hand values (Standing 1947; Beggs & Robinson 1975) at 1,000 psia, 150 °F
      const api = 35, sg = 0.65, go = 141.5 / (131.5 + api), T = 150, p = 1000;
      const rsH = sg * Math.pow((p / 18.2 + 1.4) * Math.pow(10, 0.0125 * api - 0.00091 * T), 1 / 0.83);
      const boH = 0.972 + 0.000147 * Math.pow(rsH * Math.sqrt(sg / go) + 1.25 * T, 1.175);
      const muod = Math.pow(10, Math.pow(T, -1.163) * Math.pow(10, 3.0324 - 0.02023 * api)) - 1;
      const muoH = 10.715 * Math.pow(rsH + 100, -0.515) * Math.pow(muod, 5.44 * Math.pow(rsH + 150, -0.338));
      const r = F.at(p, T);
      assert.rel(r.rs, rsH, 1e-12, 'Rs'); assert.rel(r.bo, boH, 1e-12, 'Bo'); assert.rel(r.muo, muoH, 1e-12, 'μo');
      assert.rel(r.rhoO, (62.37 * go + 0.01361 * rsH * sg) / boH, 1e-12, 'ρo');
      // bubble point: Standing at 200 °F and GOR 500
      const pbH = 18.2 * (Math.pow(500 / sg, 0.83) * Math.pow(10, 0.00091 * 200 - 0.0125 * api) - 1.4);
      assert.rel(F.pb(200), pbH, 1e-9, 'F.pb = Standing Pb');
      assert.ok(Math.abs(pbH - 2486.4) < 0.1, 'Pb ≈ 2,486 psia: ' + pbH);
      // above Pb: Rs = Rsb, Bo = Bob·(p/pb)^(−A/1e5) (integrated Vasquez-Beggs co), μo = μob·(p/pb)^m
      const p2 = 4000, u = F.at(p2, 200), rs = 500;
      const bob = L.Bo_standing(api, sg, rs, 200), A = -1433 + 5 * rs + 17.2 * 200 - 1180 * sg + 12.61 * api;
      assert.strictEqual(u.rs, 500);
      assert.rel(u.bo, bob * Math.pow(p2 / pbH, -A / 1e5), 1e-9, 'undersaturated Bo');
      const muob = L.mu_o_beggsRobinson(L.mu_oD_beggsRobinson(api, 200), rs), m = 2.6 * Math.pow(p2, 1.187) * Math.exp(-11.513 - 8.98e-5 * p2);
      assert.rel(u.muo, muob * Math.pow(p2 / pbH, m), 1e-9, 'undersaturated μo');
      assert.ok(u.bo < bob && u.muo > muob, 'oil compresses and thickens above Pb');
      assert.rel(u.pb, pbH, 1e-9, 'props report pb above it');
      // the table marks the saturated rows and gives co above Pb
      const tb = F.table([1000, 2000, 3000, 4000], 200);
      assert.deepStrictEqual(plain(tb.rows.map((x) => x.saturated)), [true, true, false, false]);
      assert.ok(tb.rows[0].co === null && tb.rows[3].co > 0, 'co only above Pb');
      assert.rel(tb.rows[3].co, A / (1e5 * 4000), 1e-12, 'Vasquez-Beggs co');
    },
  },
  {
    name: 'PV2 one-point bubble-point shift: Rs(pbUser) = GOR at T_res, F.pb(T_res) = pbUser, Rs below = Rs_corr(p·factor); no T → PB_SHIFT_NO_T; ignored for a gas',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const W = app0(ctx).win.WTS_wp_fluid, L = app0(ctx).win.PRiSM_pvt_correlations;
      const F = W.build(Object.assign(OIL(), { pbUser: 2000 }), { T_F: 200 });
      assert.ok(F.ok);
      const pbC = L.Pb_standing(35, 0.65, 500, 200);
      assert.rel(F.pvt.pbFactor, pbC / 2000, 1e-12, 'factor = Pb_corr / Pb_user');
      assert.rel(F.pb(200), 2000, 1e-9, 'shifted bubble point');
      assert.rel(F.at(1999.9, 200).rs, 500, 1e-4, 'Rs reaches the GOR at pbUser');
      assert.strictEqual(F.at(2100, 200).rs, 500);
      assert.ok(F.at(2100, 200).bo < F.at(2000.01, 200).bo, 'undersaturated above the shifted Pb');
      assert.rel(F.at(1000, 200).rs, L.Rs_standing(35, 0.65, 1000 * pbC / 2000, 200), 1e-12, 'Rs(p) = Rs_corr(p·factor)');
      assert.deepStrictEqual(plain(F.pbShift), { pbCorr: pbC, pbUser: 2000, factor: pbC / 2000, T_F: 200 });
      const N = W.build(Object.assign(OIL(), { pbUser: 2000 }));
      assert.ok(N.ok && N.pvt.pbFactor === undefined && N.warnings.some((w) => w.code === 'PB_SHIFT_NO_T' && w.field === 'pbUser'), 'no T → no shift, warned');
      const g = W.build(Object.assign(GAS(), { pbUser: 2000 }), { T_F: 230 });
      assert.ok(g.ok && g.pb(230) === null && g.warnings.some((w) => w.code === 'PB_NOT_OIL'), 'a gas has no bubble point');
      const bad = W.build(Object.assign(OIL(), { pbUser: 10 }), { T_F: 200 });
      assert.ok(!bad.ok && bad.bad.indexOf('pbUser') >= 0);
    },
  },
  {
    name: 'PV3 wet gas (D14): Rs = 0, all separator gas free at the separator gravity, condensate volume constant (B_c), in-situ mass = standard mass (no double count); recombine by hand + inverse; total basis converted',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const W = app0(ctx).win.WTS_wp_fluid;
      const F = W.build(GAS(), { T_F: 230 });
      assert.ok(F.ok, JSON.stringify(F.errors));
      assert.ok(F.wet && F.type === 'condensate' && F.rateBasis === 'gas' && F.rateUnit === 'Mscf/d');
      assert.ok(F.pvt.liquidNoTransfer === true && F.pvt.bc === 1 && F.pvt.undersat === undefined);
      assert.strictEqual(F.sgg, 0.65, 'free gas at the separator gravity');
      const q = 5000, go = 141.5 / (131.5 + 55);
      [[3000, 200], [800, 120]].forEach(([p, t]) => {
        const r = F.at(p, t, q);
        assert.strictEqual(r.rs, 0, 'no solution gas');
        assert.strictEqual(r.bo, 1, 'B_c = 1');
        assert.strictEqual(r.freeGas, 5e6, 'all separator gas is free');
        assert.strictEqual(r.sgGas, 0.65);
        assert.rel(r.rhoO, 62.37 * go, 1e-12, 'condensate density from its API');
        const std = 5e6 * RHO_AIR * 0.65 + 100 * FT3_BBL * 62.37 * go + 10 * FT3_BBL * RHO_W * 1.07;   // lbm/d
        assert.rel(mdot(r) * 86400, std, 1e-12, 'in-situ mass = standard mass at ' + p + ' psia');
      });
      const F2 = W.build(Object.assign(GAS(), { bc: 1.1 }), { T_F: 230 });
      assert.rel(F2.at(2000, 150, q).qL * F2.at(2000, 150, q).fo, 100 * 1.1 * FT3_BBL / 86400, 1e-12, 'condensate in-situ volume = CGR·qg·B_c');
      // recombine: γw = (R γg + A γo) / (R + B γo / Mo), A = ρw Vm / M_air, B = ρw Vm — mass and moles balance per STB
      const rc = W.recombine({ sgSep: 0.65, apiST: 55, cgr: 20 }), R = 1e6 / 20, Mo = 5954 / (55 - 8.811);
      const Vm = R_GAS * (60 + RANK) / 14.696, rhoBbl = 62.37 * FT3_BBL;
      const mass = R * 0.65 * MW_AIR / Vm + rhoBbl * go, moles = R / Vm + rhoBbl * go / Mo;
      assert.rel(rc.sgWell, mass / moles / MW_AIR, 1e-12, 'well-stream gravity = mass / (moles · M_air)');
      assert.rel(rc.geq, rhoBbl * Vm * go / Mo, 1e-12, 'condensate gas equivalent');
      assert.ok(Math.abs(rc.geq - 782.2) < 0.1 && Math.abs(rc.sgWell - 0.70853) < 1e-4, 'values: ' + rc.geq + ', ' + rc.sgWell);
      assert.strictEqual(rc.gorTotal, 50000); assert.rel(rc.wellGasFactor, (R + rc.geq) / R, 1e-12);
      assert.rel(F.sgWell, rc.sgWell, 1e-12, 'F.sgWell for the inflow / shut-in column only');
      assert.rel(W.recombine({ sgSep: 0.65, apiST: 55, gorSep: 50000 }).sgWell, rc.sgWell, 1e-12, 'gorSep = 1e6 / CGR');
      assert.rel(W.separatorGravity({ sgWell: rc.sgWell, apiST: 55, cgr: 20 }).sgSep, 0.65, 1e-12, 'inverse');
      const dry = W.recombine({ sgSep: 0.6, cgr: 0 });
      assert.ok(dry.ok && dry.dry && dry.sgWell === 0.6, 'dry gas: well stream = separator gas');
      assert.strictEqual(W.recombine({ sgSep: 0.65, apiST: 5, cgr: 20 }).ok, false);
      // a well-stream ('total') gravity entered for the wet gas → the separator gravity for the free gas, with a note
      const T = W.build(Object.assign(GAS(), { sgg: rc.sgWell, sggBasis: 'total' }), { T_F: 230 });
      assert.ok(T.ok); assert.rel(T.sgg, 0.65, 1e-12); assert.rel(T.sgWell, rc.sgWell, 1e-12);
      assert.ok(T.warnings.some((w) => w.code === 'SGG_TOTAL' && w.sev === 'info'));
      assert.rel(T.at(2000, 150, q).sgGas, F.at(2000, 150, q).sgGas, 1e-12, 'the march sees the separator gravity in both bases');
      // a dry gas: no liquid
      const D = W.build({ type: 'gas', sgg: 0.6, cgr: 0, wgr: 0 }, { T_F: 200 });
      assert.ok(D.ok && !D.wet); const dr = D.at(1500, 150, 2000);
      assert.ok(dr.qL === 0 && dr.freeGas === 2e6);
    },
  },
  {
    name: 'PV4 mass balance top = bottom of a traverse: wet gas exact (1e-9); oil exact after the dissolved-gas density term is put on the base-condition air density (residual = that constant only)',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_fluid;
      // wet gas: 10,000 ft from 800 psig at the top (reverse march), 5 MMscf/d
      const Fg = W.build(GAS(), { T_F: 230 });
      const mg = G.WTS_flowline_march([{ len: 10000, id: 2.441, dz: 10000 }], W.flowlineFluid(Fg, 5000), 800, 140, 230, { reverse: true, detail: true });
      assert.ok(mg.pOut > 800 && !mg.lost, 'gas traverse');
      const top = Fg.at(800 + 14.696, 140, 5000), bot = Fg.at(mg.pOut + 14.696, 230, 5000);
      assert.ok(Math.abs(mdot(top) / mdot(bot) - 1) < 1e-9, 'wet gas: ṁ top / bottom − 1 = ' + (mdot(top) / mdot(bot) - 1));
      // oil: FIX.oilWell at 1,000 STB/d from 400 psig at the top (Rs grows downward, the oil goes undersaturated near the bottom)
      const Fo = W.build(OIL(), { T_F: 200 }), ff = W.flowlineFluid(Fo, 1000);
      const mo = G.WTS_flowline_march(SEG8000(), ff, 400, 120, 200, { reverse: true });
      assert.ok(mo.pOut > 2500 && !mo.lost, 'oil traverse ends above Pb (2,486 psia): ' + mo.pOut);
      const a = Fo.at(414.696, 120, 1000), b = Fo.at(mo.pOut + 14.696, 200, 1000);
      assert.ok(a.rs < 150 && b.rs === 500, 'Rs from ' + a.rs + ' to ' + b.rs);
      const k = (5.614583 * 0.01361 - RHO_AIR) * 0.65 * ff.qo / 86400;      // lbm/s per scf/STB dissolved
      const corr = (r) => mdot(r) - k * r.rs;
      assert.ok(Math.abs(corr(a) / corr(b) - 1) < 1e-9, 'oil corrected: ' + (corr(a) / corr(b) - 1));
      const raw = Math.abs(mdot(a) / mdot(b) - 1);
      assert.ok(raw > 1e-6 && raw < 2e-4, 'the flowline density constant leaves ≈ 1e-4: ' + raw);
    },
  },
  {
    name: 'PV5 checks: required inputs (no defaults, field ids), Appendix A validity verdicts and warnings, impurities, unknown correlation key, info notes',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const W = app0(ctx).win.WTS_wp_fluid;
      const e = (spec, field) => { const r = W.build(spec, { T_F: 200 }); assert.ok(!r.ok && r.bad.indexOf(field) >= 0 && r.errors.length > 0, field + ': ' + JSON.stringify(r.bad)); return r; };
      e(Object.assign(OIL(), { gor: null }), 'gor');
      e(Object.assign(OIL(), { api: '' }), 'api');
      e(Object.assign(OIL(), { sgg: 0.5 }), 'sgg');
      e(Object.assign(OIL(), { wc: 1.2 }), 'wc');
      e(Object.assign(OIL(), { sgw: 2 }), 'sgw');
      e(Object.assign(GAS(), { api: null }), 'api');
      e(Object.assign(GAS(), { cgr: -1 }), 'cgr');
      e(Object.assign(OIL(), { yCO2: 60, yH2S: 40 }), 'yN2');
      e({ type: 'steam' }, 'type');
      assert.strictEqual(W.build(OIL()).pvt.corr.rs, 'standing', 'no options needed');
      const blank = W.build(Object.assign(OIL(), { wc: null }), { T_F: 200 });
      assert.ok(blank.ok && blank.wc === 0 && blank.warnings.some((w) => w.code === 'WC_BLANK' && w.sev === 'info'));
      // validity: in range
      const c0 = W.check(OIL(), { T_F: 200, tMin: 120, pMin: 200, pMax: 3000 });
      assert.ok(c0.ok && c0.validity.every((v) => v.inRange), JSON.stringify(c0.validity.map((v) => v.msg)));
      assert.deepStrictEqual(plain(c0.validity.map((v) => v.corr)), ['standing', 'beggsRobinson', 'vasquezBeggs', 'dak']);
      // out of range: 70 °API, 60 °F wellhead, 7,000 psia
      const c1 = W.check(Object.assign(OIL(), { api: 70, gor: 3000 }), { T_F: 200, tMin: 60, pMax: 7000 });
      const st = c1.validity.find((v) => v.corr === 'standing');
      assert.ok(!st.inRange && /API 70 is outside 16\.5–63\.8/.test(st.msg) && /temperature 60 °F–200 °F is outside 100 °F–258 °F/.test(st.msg) && /GOR 3,000 is outside 20–1,425/.test(st.msg), st.msg);
      assert.ok(/^⚠ /.test(st.msg) && /extrapolated/.test(st.msg));
      assert.ok(c1.warnings.some((w) => w.code === 'RANGE_STANDING' && w.sev === 'warn'));
      assert.ok(c1.validity.find((v) => v.corr === 'vasquezBeggs').out.some((o) => o.v === 'p'), 'pressure above 6,055 psia');
      // wet gas: Standing not used; Wichert-Aziz with CO2
      const c2 = W.check(Object.assign(GAS(), { yCO2: 60 }), { T_F: 230, tMin: 70, pMax: 5000 });
      assert.ok(c2.ok);
      const sv = c2.validity.find((v) => v.corr === 'standing');
      assert.ok(sv && sv.used === false && /not used/.test(sv.msg) && sv.inRange, 'Standing not used for the condensate');
      const wa = c2.validity.find((v) => v.corr === 'wichertAziz');
      assert.ok(wa && !wa.inRange && /CO2 \(mol %\) 60 is outside 0–54\.4/.test(wa.msg), wa && wa.msg);
      assert.ok(c2.warnings.some((w) => w.code === 'IMP_MUG' && w.sev === 'info'), 'impurity viscosity note');
      const Fi = W.build(Object.assign(GAS(), { yCO2: 5, yN2: 2 }), { T_F: 230 });
      assert.deepStrictEqual(plain(Fi.pvt.imp), { n2: 2, co2: 5, h2s: 0 });
      assert.notStrictEqual(Fi.at(3000, 200, 5000).z, W.build(GAS(), { T_F: 230 }).at(3000, 200, 5000).z, 'Z corrected for the impurities');
      // DAK: Tpr below 1.05 at a cold surface on a heavy gas
      const c3 = W.check(Object.assign(OIL(), { sgg: 1.2 }), { T_F: 200, tMin: 40 });
      assert.ok(!c3.validity.find((v) => v.corr === 'dak').inRange, 'Tpr out of range');
      // unknown correlation key: warned, the march falls back to the default
      const u = W.build(Object.assign(OIL(), { corr: Object.assign({}, OIL().corr, { rs: 'nosuch' }) }), { T_F: 200 });
      assert.ok(u.ok && u.warnings.some((w) => w.code === 'CORR_UNKNOWN' && w.field === 'corr_rs'));
      assert.strictEqual(u.at(1000, 150).rs, W.build(OIL(), { T_F: 200 }).at(1000, 150).rs);
      const gi = W.build({ type: 'gasinj', sgg: 0.65 }, { T_F: 200 });
      assert.ok(gi.ok && gi.warnings.some((w) => w.code === 'GASINJ_B') && gi.at(2000, 150, 3000).qL === 0);
    },
  },
  {
    name: 'PV6 one path for tables and traverses: the marcher\'s inlet props = F.at; F.table rows = F.at; WTS_wp_fluid.table = F.table',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_fluid;
      [[W.build(OIL(), { T_F: 200 }), 1000, 200, 120], [W.build(GAS(), { T_F: 230 }), 4000, 800, 140]].forEach(([F, q, p0, t0]) => {
        const res = G.WTS_flowline_march(SEG8000(), W.flowlineFluid(F, q), p0, t0, 200, { reverse: true });
        assert.deepStrictEqual(plain(res.inlet.props), plain(F.at(p0 + 14.696, t0, q)), F.type + ': marcher inlet props = F.at');
        const pl = [p0 + 14.696, 1500, res.pOut + 14.696];
        const tb = F.table(pl, 160, q), tb2 = W.table(F, pl, 160, q);
        assert.deepStrictEqual(plain(tb), plain(tb2));
        tb.rows.forEach((r) => { const a = F.at(r.p, 160, q); ['rs', 'bo', 'muo', 'z', 'bg', 'mug', 'rhoO', 'rhoG', 'rhoW', 'bw', 'muw'].forEach((k) => assert.ok(Object.is(r[k], a[k]), k)); });
        assert.rel(tb.rows[0].bgRB, tb.rows[0].bg * 1000 / 5.614583, 1e-12, 'Bg in RB/Mscf');
      });
      const F = W.build(OIL(), { T_F: 200 });
      assert.strictEqual(W.table(F, [-5, 'x'], 150).ok, false, 'no valid pressure');
      assert.strictEqual(W.table(F, [1000], NaN).code, 'BAD_T');
      assert.strictEqual(W.table({ ok: false }, [1000], 150).code, 'NO_FLUID');
    },
  },
  {
    name: 'PV7 flowlineFluid: rate bases and units (liquid STB/d split by WC, gas Mscf/d → MMscf/d with CGR / WGR, water BWPD, explicit object); in-situ rates by hand',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const W = app0(ctx).win.WTS_wp_fluid;
      const Fo = W.build(OIL(), { T_F: 200 });
      assert.strictEqual(Fo.rateBasis, 'liquid'); assert.strictEqual(Fo.rateUnit, 'STB/d');
      const o = W.flowlineFluid(Fo, 1000);
      assert.rel(o.qo, 700, 1e-12); assert.rel(o.qw, 300, 1e-12); assert.rel(o.qg, 0.35, 1e-12); assert.strictEqual(o.qg_MMscfd, o.qg);
      assert.ok(o.api === 35 && o.sgg === 0.65 && o.sgw === 1.07 && o.pvt === Fo.pvt);
      assert.deepStrictEqual(plain(Fo.rates(1000)), { qo: 700, qw: 300, qg_Mscfd: 350, qL: 1000 });
      const g = W.flowlineFluid(W.build(GAS(), { T_F: 230 }), 5000);
      assert.ok(g.qg === 5 && g.qo === 100 && g.qw === 10, JSON.stringify(g));
      const w = W.build({ type: 'waterinj', sgw: 1.02 }, { T_F: 150 });
      assert.ok(w.ok && w.rateBasis === 'water' && w.rateUnit === 'BWPD');
      const wf = W.flowlineFluid(w, 2000); assert.ok(wf.qw === 2000 && wf.qo === 0 && wf.qg === 0);
      const x = W.flowlineFluid(Fo, { qo: 600, qw: 200, qg_Mscfd: 420 });
      assert.ok(x.qo === 600 && x.qw === 200 && Math.abs(x.qg - 0.42) < 1e-15);
      assert.strictEqual(W.flowlineFluid(Fo).qo, 700, 'no rate → the reference 1,000 on the basis');
      assert.strictEqual(W.flowlineFluid({ ok: false }, 1).code, 'NO_FLUID');
      // in-situ volumetric rates (ft³/s) by hand at 1,000 psia / 150 °F
      const r = Fo.at(1000, 150, 1000);
      assert.rel(r.qL, (700 * r.bo + 300 * r.bw) * FT3_BBL / 86400, 1e-12, 'liquid');
      assert.rel(r.qG, (350e3 - 700 * r.rs) * r.bg / 86400, 1e-12, 'free gas');
      assert.rel(r.bg, 14.696 * r.z * (150 + RANK) / ((60 + RANK) * 1000), 1e-12, 'Bg ft³/scf');
    },
  },
  {
    name: 'PV8 the (p, T)-binned property table: lookup error on a (p, T) grid; 8,000 ft BHP within 0.05 % of the exact path (§4.5); one cache per pvt object',
    wp: WP,
    opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_fluid;
      [[OIL(), 200, 1000, 200, 120], [GAS(), 230, 5000, 800, 140]].forEach(([spec, T, q, p0, t0]) => {
        const E = W.build(spec, { T_F: T }), Tb = W.build(spec, { T_F: T, table: true });
        assert.strictEqual(Tb.pvt.table, true);
        let worst = { k: '', e: 0 };
        for (let p = 213; p <= 5000; p += 137) for (let t = 81; t <= 230; t += 13) {
          const a = E.at(p, t, q), b = Tb.at(p, t, q);
          ['z', 'bo', 'mug', 'rhoG', 'rhoO', 'muo', 'bw'].forEach((k) => {
            if (!(a[k] > 0)) return;
            const e = Math.abs(b[k] / a[k] - 1); if (e > worst.e) worst = { k: k + '@' + p + '/' + t, e };
          });
        }
        assert.ok(worst.e < 2e-3, spec.type + ' worst property lookup error ' + worst.k + ' ' + worst.e);
        const opt = { reverse: true, stepFt: 100 };
        const m1 = G.WTS_flowline_march(SEG8000(), W.flowlineFluid(E, q), p0, t0, T, opt);
        const m2 = G.WTS_flowline_march(SEG8000(), W.flowlineFluid(Tb, q), p0, t0, T, opt);
        assert.ok(Math.abs((m2.pOut + 14.696) / (m1.pOut + 14.696) - 1) < 5e-4, spec.type + ' BHP ' + m1.pOut + ' vs ' + m2.pOut);
      });
      const Tc = W.build(OIL(), { T_F: 200, table: { dp: 10, dT: 4 } });
      assert.deepStrictEqual(plain(Tc.pvt.table), { dp: 10, dT: 4 });
      // two fluids with different GOR do not share a cache (WeakMap per pvt object)
      const A = W.build(OIL(), { T_F: 200, table: true }), B = W.build(Object.assign(OIL(), { api: 25 }), { T_F: 200, table: true });
      A.at(1000, 150); assert.rel(B.at(1000, 150).rs, W.build(Object.assign(OIL(), { api: 25 }), { T_F: 200 }).at(1000, 150).rs, 2e-3);
    },
  },
];
