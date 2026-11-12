// Well Performance increment-B inflow — docs/WELL-PERFORMANCE-PLAN.md §4.2 (Increment B), §1.3 US15, §1.4 C1 / E9, §2.10, §17.3
// (wellperf-ipr2; WP24).
//
// IP2-1 registry and the D17 gate · IP2-2 water-cut composite · IP2-3 Joshi · IP2-4 Babu-Odeh · IP2-5 Furui · IP2-6 fractured well
// (Prats / Cinco-Ley F_cD fit, oil and gas) · IP2-7 transient IPR vs the exponential-integral line source · IP2-8 multilayer inflow
// (identities, crossflow balance, TVD from the deviated path, gas layers) · IP2-9 multilayer in the solver · IP2-10 injector inflow
// (water, gas m(p), Darcy II) · IP2-11 injector solve (closure, fracture limit and verdicts, no injection, DFIT closure, model checks)
// · IP2-12 injection traverse on the deviated path · IP2-13 Build-up Surveillance hand-off · IP2-14 model: the layers table and
// M.res.perf · IP2-15 page: the B examples wired into the interactive page (study plot handles, KPIs, schematic, report capture).
// Benchmarks (§15.1, Q9): the textbooks were not provided, so every B model ships verified:false with the provisional label (D17).
// The tests are hand calculations written out here (independent of the engine code) and internal identities (§15.2).
'use strict';

const S = require('./_wellperf-shapes');

const WP = 'WP24';
const PROV = 'provisional — not verified against a published example';
const PATM = 14.696;
const app0 = (ctx) => S.sharedApp(ctx);
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const txt = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
const BAD = /NaN|undefined|Infinity|\[object Object\]/;
const FF = { ok: true, type: 'oil', wc: 0.3, at: () => ({ bo: 1.25, muo: 0.9, bw: 1.02, muw: 0.4, rhoO: 45, rhoW: 63, rhoG: 8 }), pb: () => 2000, sgWell: 0.72 };

function inverses(assert, I, tag) {
  [0.02, 0.3, 0.7, 0.97].forEach((f) => { const q = f * I.aof, p = I.pwfAt(q); assert.rel(I.qAt(p), q, 1e-9, tag + ' q(pwf(q)) at ' + f); });
  for (let i = 1; i < I.curve.length; i++) assert.ok(I.curve[i].q >= I.curve[i - 1].q - 1e-9, tag + ' monotone curve');
}
function injM(G, o) {
  const M = S.FIX.gasWell;
  Object.assign(M.fluid, { type: 'waterinj', cgr: 0, wgr: 0, sgw: 1.05 });
  M.res = { model: 'injector', pr: 3200, T_F: 230, params: Object.assign({ II: 4, pfrac: 5200 }, (o && o.params) || {}), points: [], layers: [] };
  M.system.thp_psig = o && o.thp != null ? o.thp : 1200; M.surface.choke.present = false; M.surface.flowline = []; M.well.heat.tht_F = 80;
  return M;
}

module.exports = [
  {
    name: 'IP2-1 registry: the nine increment-B models are registered, verified:false with the provisional label, never a default; the A1 / A2 entries are unchanged',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_ipr;
      const B = ['wcComposite', 'joshi', 'babuOdeh', 'furui', 'frac', 'fracGas', 'transient', 'multilayer', 'injector'];
      assert.deepStrictEqual(plain(W.B_KEYS), B);
      B.forEach((k) => { const m = W.models[k]; assert.ok(m && m.verified === false && m.provisional === PROV, k); });
      ['joshi', 'babuOdeh', 'furui'].forEach((k) => assert.ok(W.models[k].horizontal, k + ' flagged horizontal'));
      assert.strictEqual(W.models.injector.kind, 'inj'); assert.strictEqual(W.models.multilayer.kind, 'any'); assert.strictEqual(W.models.fracGas.kind, 'gas');
      ['pi', 'vogel', 'composite', 'fetkovich', 'backPressure', 'litP2'].forEach((k) => assert.ok(W.models[k].verified, k + ' still verified'));
      assert.strictEqual(G.WTS_wp_model.DEFAULTS.res.model, 'pi', 'the default inflow is not a B model');
      // a B model in use is named provisional in the check validity (page + report)
      const M = S.FIX.oilWell; M.res.model = 'joshi';
      const v = G.WTS_wp_check(M).validity.find((x) => x.corr === 'joshi');
      assert.ok(v && v.provisional === true, 'validity line');
      const I = W.curve({ model: 'joshi', pr: 3000, params: { k: 20, h: 50, L: 2000, kvkh: 0.1, rw: 0.354, re: 2000 } }, FF);
      assert.ok(I.ok && I.warnings.some((w) => w.code === 'PROVISIONAL' && w.msg.indexOf(PROV) !== -1), 'PROVISIONAL warning');
      const sh = S.checkShape('I', I); assert.ok(sh.ok, sh.errors.join('; '));
    },
  },
  {
    name: 'IP2-2 water-cut composite: PI above pb, f_w·water PI + f_o·oil Vogel below, the exact straight-line extension past q_o,max (slope −(f_w + 9 f_o)/J), WC 0 / 1 limits, inverses',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app0(ctx).win.WTS_wp_ipr, J = 2, pr = 3000, pb = 2000, fw = 0.3, fo = 0.7;
      const I = W.curve({ model: 'wcComposite', pr, pb, params: { J } }, FF);
      assert.ok(I.ok, JSON.stringify(plain(I.errors)));
      const qb = J * (pr - pb), qom = qb + J * pb / 1.8, vog = (q) => { const r = (q - qb) / (J * pb / 1.8); return pb * (-0.2 + Math.sqrt(0.04 + 3.2 * (1 - r))) / 1.6; };
      assert.strictEqual(I.form.fw, 0.3, 'WC from the fluid');
      assert.rel(I.pwfAt(1000), pr - 1000 / J, 1e-12, 'above pb: PI');
      [2500, 3500, 4100].forEach((q) => assert.rel(I.pwfAt(q), fw * (pr - q / J) + fo * vog(q), 1e-9, 'weighted at ' + q));
      const s = -(fw + 9 * fo) / J, pq = fw * (pr - qom / J);
      assert.rel(I.form.slope, s, 1e-12); assert.rel(I.form.qtMax, qom - pq / s, 1e-12, 'q_t,max');
      assert.rel(I.pwfAt(qom + 20), pq + s * 20, 1e-9, 'straight line past q_o,max');
      assert.rel(I.aof, I.form.qtMax, 1e-12);
      // continuity at qb and q_o,max
      assert.ok(Math.abs(I.pwfAt(qb * (1 + 1e-9)) - I.pwfAt(qb * (1 - 1e-9))) < 1e-4 && Math.abs(I.pwfAt(qom * (1 + 1e-9)) - I.pwfAt(qom * (1 - 1e-9))) < 1e-3, 'continuous');
      inverses(assert, I, 'wcComposite');
      const one = W.curve({ model: 'wcComposite', pr, pb, params: { J, fw: 1 } }, FF);
      assert.rel(one.aof, J * pr, 1e-12, 'WC 100 % = the PI line');
      assert.strictEqual(W.curve({ model: 'wcComposite', pr, params: { J } }, Object.assign({}, FF, { pb: () => null })).code, 'PB_NEEDED');
    },
  },
  {
    name: 'IP2-3 Joshi: J by hand (a, the anisotropy term), the lateral from the perforated MD interval when L is blank, L/2 < 0.9·r_eh, composite below pb',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app0(ctx).win.WTS_wp_ipr;
      const k = 20, h = 60, L = 2000, kv = 0.1, rw = 0.354, reh = 2000, S0 = 1.5, B = 1.25, mu = 0.9;
      const Ia = Math.sqrt(1 / kv), a = (L / 2) * Math.sqrt(0.5 + Math.sqrt(0.25 + Math.pow(2 * reh / L, 4)));
      const X = Math.log((a + Math.sqrt(a * a - L * L / 4)) / (L / 2)) + (Ia * h / L) * Math.log(Ia * h / (rw * (Ia + 1)));
      const Jh = k * h / (141.2 * B * mu * (X + S0));
      const I = W.curve({ model: 'joshi', pr: 3000, pb: 1800, params: { k, h, L, kvkh: kv, rw, re: reh, S: S0 } }, FF);
      assert.ok(I.ok, JSON.stringify(plain(I.errors)));
      assert.rel(I.J, Jh, 1e-12, 'J'); assert.rel(I.form.a, a, 1e-12, 'a');
      assert.rel(I.form.ratio, Jh / (k * h / (141.2 * B * mu * Math.log(reh / rw))), 1e-12, 'J_h / J_v');
      assert.rel(I.qAt(2400), Jh * 600, 1e-12, 'PI above pb'); assert.ok(I.pb === 1800 && I.qAt(1000) < Jh * 2000, 'composite below pb');
      // the deviated survey sets the lateral: blank L → the perforated MD interval of M.res.perf
      const I2 = W.curve({ model: 'joshi', pr: 3000, perf: { topMd: 9400, botMd: 11400, midMd: 10400 }, params: { k, h, kvkh: kv, rw, re: reh, S: S0 } }, FF);
      assert.ok(I2.ok && I2.horizontal.L === 2000 && I2.warnings.some((w) => w.code === 'L_FROM_PERFS'), 'L from the perforations');
      assert.strictEqual(W.curve({ model: 'joshi', pr: 3000, params: { k, h, L: 3700, kvkh: kv, rw, re: reh } }, FF).code, 'L_TOO_LONG');
      assert.strictEqual(W.curve({ model: 'joshi', pr: 3000, params: { k, h, kvkh: kv, rw, re: reh } }, FF).code, 'NEEDS_L');
      inverses(assert, I, 'joshi');
    },
  },
  {
    name: 'IP2-4 Babu-Odeh: ln C_H and the full-penetration J by hand; case 2 partial penetration P_xyz + P_y + P_xy by hand; refusals (L > b, x0 outside the box)',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app0(ctx).win.WTS_wp_ipr;
      const k = 50, kz = 5, h = 50, a = 2000, b = 4000, rw = 0.354, B = 1.25, mu = 0.9, x0 = 1000, z0 = 25, ym = 2000;
      const r = Math.sqrt(kz / k), lnCH = 6.28 * (a / h) * r * (1 / 3 - 0.5 + 0.25) - Math.log(1) - 0.5 * Math.log((a / h) * r) - 1.088;
      const full = W.curve({ model: 'babuOdeh', pr: 3000, params: { k, h, L: 4000, kvkh: 0.1, rw, boxA: a, boxB: b } }, FF);
      assert.ok(full.ok, JSON.stringify(plain(full.errors)));
      assert.rel(full.form.lnCH, lnCH, 1e-12, 'ln C_H'); assert.strictEqual(full.form.sR, 0);
      assert.rel(full.J, b * Math.sqrt(k * kz) / (141.2 * B * mu * (Math.log(Math.sqrt(a * h) / rw) + lnCH - 0.75)), 1e-12, 'J full penetration');
      const L = 2000, Pxyz = (b / L - 1) * (Math.log(h / rw) + 0.25 * Math.log(k / kz) - 0 - 1.84);
      const Py = (6.28 * b * b / (a * h)) * (Math.sqrt(k * kz) / k) * ((1 / 3 - ym / b + ym * ym / (b * b)) + (L / (24 * b)) * (L / b - 3));
      const Pxy = (b / L - 1) * (6.28 * a / h) * r * (1 / 3 - x0 / a + (x0 / a) * (x0 / a));
      const pp = W.curve({ model: 'babuOdeh', pr: 3000, params: { k, h, L, kvkh: 0.1, rw, boxA: a, boxB: b, xPos: x0, zPos: z0, yMid: ym } }, FF);
      assert.strictEqual(pp.form.kase, 'case 2'); assert.rel(pp.form.sR, Pxyz + Py + Pxy, 1e-12, 's_R case 2');
      assert.ok(pp.J < full.J, 'partial penetration lowers J');
      // case 1 (a wide box): F(x) by hand at x ≤ 1
      const c1 = W.babuOdehX({ a: 8000, b: 4000, h: 50, L: 2000, rw, kx: k, ky: k, kz });
      const F = (x) => -x * (0.145 + Math.log(x) - 0.137 * x * x), Pxy1 = (2 * b * b / (L * h)) * Math.sqrt(kz / k) * (F(L / (2 * b)) + 0.5 * (F((4 * ym + L) / (2 * b)) - F((4 * ym - L) / (2 * b))));
      const Fg = (x) => (2 - x) * (0.145 + Math.log(2 - x) - 0.137 * (2 - x) * (2 - x));      // x > 1 branch
      const Pxy1b = (2 * b * b / (L * h)) * Math.sqrt(kz / k) * (F(L / (2 * b)) + 0.5 * (Fg((4 * ym + L) / (2 * b)) - F((4 * ym - L) / (2 * b))));
      assert.ok(/^case 1/.test(c1.kase), c1.kase);
      assert.rel(c1.sR, Pxyz + Pxy1b, 1e-12, 's_R case 1 (F on both branches)'); void Pxy1;
      assert.strictEqual(W.curve({ model: 'babuOdeh', pr: 3000, params: { k, h, L: 5000, kvkh: 0.1, rw, boxA: a, boxB: b } }, FF).code, 'L_GT_B');
      assert.strictEqual(W.curve({ model: 'babuOdeh', pr: 3000, params: { k, h, L, kvkh: 0.1, rw, boxA: a, boxB: b, xPos: 2500 } }, FF).code, 'BAD_X0');
      inverses(assert, pp, 'babuOdeh');
    },
  },
  {
    name: 'IP2-5 Furui: J by hand (ln(h·I_ani/(rw(I_ani + 1))) + π·y_b/(h·I_ani) − 1.224 + S), J proportional to L, y_b needed',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app0(ctx).win.WTS_wp_ipr, k = 20, h = 60, L = 2500, kv = 0.2, rw = 0.354, yb = 1200, S0 = 2, B = 1.25, mu = 0.9, Ia = Math.sqrt(1 / kv);
      const X = Math.log(h * Ia / (rw * (Ia + 1))) + Math.PI * yb / (h * Ia) - 1.224;
      const I = W.curve({ model: 'furui', pr: 3000, params: { k, h, L, kvkh: kv, rw, yb, S: S0 } }, FF);
      assert.ok(I.ok, JSON.stringify(plain(I.errors)));
      assert.rel(I.J, k * L / (141.2 * B * mu * (X + S0)), 1e-12, 'J');
      const I2 = W.curve({ model: 'furui', pr: 3000, params: { k, h, L: 2 * L, kvkh: kv, rw, yb, S: S0 } }, FF);
      assert.rel(I2.J, 2 * I.J, 1e-12, 'J ∝ L');
      assert.strictEqual(W.curve({ model: 'furui', pr: 3000, params: { k, h, L, kvkh: kv, rw } }, FF).code, 'NEEDS_YB');
      inverses(assert, I, 'furui');
    },
  },
  {
    name: 'IP2-6 fractured well: F_cD fit values (0.1, 1, 10, 1,000), Prats infinite conductivity ln(2rw/x_f), F_cD from k_f·w; frac = Darcy oil with S = s_f, fracGas = Darcy gas with S = s_f',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app0(ctx).win.WTS_wp_ipr, rw = 0.354, xf = 250;
      const fit = (F) => { const u = Math.log(F); return (1.65 - 0.328 * u + 0.116 * u * u) / (1 + 0.180 * u + 0.064 * u * u + 0.005 * u * u * u); };
      [0.1, 1, 10, 1000].forEach((F) => { const r = W.fracSkin({ xf, rw, FcD: F }); assert.rel(r.f, fit(F), 1e-12, 'f(' + F + ')'); assert.rel(r.sf, fit(F) - Math.log(xf / rw), 1e-12); });
      assert.ok(Math.abs(fit(1000) / Math.log(2) - 1) < 0.03, 'the fit tends to Prats (ln 2)');
      const inf = W.fracSkin({ xf, rw }); assert.rel(inf.sf, Math.log(2 * rw / xf), 1e-12, 'Prats r_w′ = x_f/2'); assert.rel(inf.rwEff, xf / 2, 1e-12);
      assert.rel(W.fracSkin({ xf, rw, k: 2, kfw: 2000 }).FcD, 2000 / (2 * xf), 1e-12, 'F_cD = k_f·w/(k·x_f)');
      assert.ok(W.fracSkin({ xf, rw, FcD: 0.01 }).warnings.some((w) => w.code === 'FCD_LOW'), 'below the fit range');
      const P = { k: 2, h: 40, rw, re: 1490, Bo: 1.2, muo: 1.1 };
      const fr = W.curve({ model: 'frac', pr: 3000, params: Object.assign({ xf, FcD: 8, S: 0.5 }, P) }, FF);
      const sf = W.fracSkin({ xf, rw, FcD: 8 }).sf, da = W.curve({ model: 'darcyOil', pr: 3000, params: Object.assign({ S: 0.5 + sf }, P) }, FF);
      assert.ok(fr.ok && Object.is(fr.J, da.J), 'frac J = Darcy J with S + s_f');
      assert.strictEqual(fr.params.S, 0.5, 'the other skin kept'); assert.rel(fr.form.Stotal, 0.5 + sf, 1e-12);
      const PG = { k: 2, h: 40, rw, re: 1490, sg: 0.7, D: 1e-4 };
      const fg = W.curve({ model: 'fracGas', pr: 4000, T_F: 220, params: Object.assign({ xf, FcD: 8 }, PG) });
      const dg = W.curve({ model: 'darcyGas', pr: 4000, T_F: 220, params: Object.assign({ S: sf }, PG) });
      assert.ok(fg.ok && dg.ok && fg.kind === 'gas', JSON.stringify(plain(fg.errors)));
      assert.rel(fg.aof, dg.aof, 1e-12, 'fracGas = Darcy gas with S = s_f');
      inverses(assert, fr, 'frac'); inverses(assert, fg, 'fracGas');
    },
  },
  {
    name: 'IP2-7 transient IPR: J(t) by the log approximation, within 0.2 % of the exponential-integral line source at t_D > 100; early-time and end-of-infinite-acting warnings; J falls with t',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const W = app0(ctx).win.WTS_wp_ipr, k = 20, h = 40, phi = 0.15, ct = 1.5e-5, rw = 0.354, S0 = 1, B = 1.25, mu = 0.9;
      const E1 = (x) => { let s = -0.5772156649 - Math.log(x), t = 1; for (let n = 1; n < 60; n++) { t *= -x / n; s -= t / n; } return s; };
      [3, 24, 300].forEach((t) => {
        const I = W.curve({ model: 'transient', pr: 3500, params: { k, h, phi, ct, rw, S: S0, tFlow: t } }, FF);
        assert.ok(I.ok, JSON.stringify(plain(I.errors)));
        const X = Math.log10(k * t / (phi * mu * ct * rw * rw)) - 3.23 + 0.87 * S0;
        assert.rel(I.J, k * h / (162.6 * B * mu * X), 1e-12, 'J at ' + t + ' h');
        const dpEi = 70.6 * 1 * B * mu / (k * h) * (E1(948 * phi * mu * ct * rw * rw / (k * t)) + 2 * S0);
        assert.ok(Math.abs((1 / I.J) / dpEi - 1) < 0.002, 'vs Ei at ' + t + ' h: ' + (1 / I.J) / dpEi);
      });
      const early = W.curve({ model: 'transient', pr: 3500, params: { k, h, phi: 0.3, ct: 3e-4, rw: 0.5, S: 0, tFlow: 0.005, Bo: B, muo: 30 } }, FF);
      assert.ok(!early.ok || early.warnings.some((w) => w.code === 'TD_SMALL'), 'early time flagged');
      const late = W.curve({ model: 'transient', pr: 3500, params: { k, h, phi, ct, rw, S: S0, tFlow: 5000, re: 745 } }, FF);
      assert.ok(late.warnings.some((w) => w.code === 'T_GT_PSS'), 'past the end of infinite-acting flow');
      assert.ok(late.transient.jOfT(10) > late.transient.jOfT(100), 'J falls with t');
    },
  },
  {
    name: 'IP2-8 multilayer inflow: one layer = PI; two identical layers at one depth = PI with 2J; layer rates at p_ws sum to 0; TVD from the deviated path (not MD); gas layers in p²',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_ipr;
      const one = W.curve({ model: 'multilayer', pr: 3000, layers: [{ name: 'A', topMd: 7990, botMd: 8010, pr: 3000, J: 2 }], perf: { midMd: 8000 }, params: {} }, FF);
      const pi = W.curve({ model: 'pi', pr: 3000, params: { J: 2 } });
      assert.ok(one.ok, JSON.stringify(plain(one.errors)));
      [0.2, 0.6, 0.9].forEach((f) => assert.ok(Math.abs(one.pwfAt(f * pi.aof) - pi.pwfAt(f * pi.aof)) < 1e-6, 'one layer = PI'));
      const twin = W.curve({ model: 'multilayer', pr: 3000, layers: [{ name: 'A', topMd: 7990, botMd: 8010, pr: 3000, J: 2 }, { name: 'B', topMd: 7990, botMd: 8010, pr: 3000, J: 2 }], perf: { midMd: 8000 }, params: {} }, FF);
      assert.rel(twin.qAt(2500), 2000, 1e-9, 'two identical layers = 2J');
      const L2 = [{ name: 'Up', topMd: 7800, botMd: 7850, pr: 3100, J: 1.2 }, { name: 'Lo', topMd: 8150, botMd: 8200, pr: 2400, J: 0.9 }];
      const two = W.curve({ model: 'multilayer', pr: 3000, layers: L2, perf: { midMd: 8000 }, params: {} }, FF);
      assert.ok(Math.abs(two.crossflow.layers.reduce((s, r) => s + r.q, 0)) < 1e-6, 'balance at p_ws');
      assert.deepStrictEqual(plain(two.crossflow.thief), ['Lo']); assert.ok(two.warnings.some((w) => w.code === 'CROSSFLOW_SHUTIN'));
      const g = 0.35 * 0 + (0.7 * 45 + 0.3 * 63) / 144;           // the gradient of FF's mixture
      assert.rel(two.form.grad, g, 1e-12, 'wellbore gradient from the fluid');
      // the layer pressure at the well: pwf + gradient × (TVD_layer − TVD_ref) with the TVD from the path
      const tvdAt = (md) => 0.8 * md, dv = W.curve({ model: 'multilayer', pr: 3000, layers: L2, perf: { midMd: 8000 }, params: {} }, FF, { tvdAt });
      const r = dv.layerRates(2500);
      assert.rel(r[0].pLayer, 2500 + g * (0.8 * 7825 - 0.8 * 8000), 1e-12, 'TVD-based layer pressure (deviated)');
      assert.ok(!dv.warnings.some((w) => w.code === 'LAYER_TVD') && two.warnings.some((w) => w.code === 'LAYER_TVD'), 'TVD = MD only without a path');
      assert.rel(r[1].q, -0.9 * (r[1].pLayer - 2400) * (r[1].pLayer > 2400 ? 1 : 0) + (r[1].pLayer > 2400 ? 0 : r[1].q), 1e-12, 'crossflow on the layer PI');
      inverses(assert, two, 'multilayer');
      // gas layers: LIT in p²
      const FG = { ok: true, type: 'gas', at: () => ({ rhoG: 10 }), pb: () => null, sgWell: 0.7 };
      const gl = W.curve({ model: 'multilayer', pr: 5000, T_F: 220, layers: [{ name: 'G1', topMd: 9000, botMd: 9050, pr: 5000, a: 500, b: 0.05 }], perf: { midMd: 9025 }, params: {} }, FG);
      const lit = W.curve({ model: 'litP2', pr: 5000, params: { a: 500, b: 0.05, pAof: 14.65 } });
      assert.ok(gl.ok && gl.kind === 'gas', JSON.stringify(plain(gl.errors)));
      assert.rel(gl.qAt(3000), lit.qAt(3000), 1e-9, 'one gas layer = LIT p²');
      assert.strictEqual(W.curve({ model: 'multilayer', pr: 3000, layers: [], params: {} }, FF).code, 'NEEDS_LAYERS');
    },
  },
  {
    name: 'IP2-9 multilayer in the solver: layer rates at the operating point sum to the well rate, crossflow flagged while flowing, the layer TVDs come from the deviated survey',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, M = S.FIX.gasWell;
      Object.assign(M.fluid, { type: 'oil', api: 35, gor: 500, wc: 0.3, cgr: 0, wgr: 0 });
      M.res = { model: 'multilayer', pr: 3000, T_F: 200, params: {}, points: [], layers: [{ name: 'Up', topMd: 9800, botMd: 9850, pr: 3700, J: 1.5 }, { name: 'Lo', topMd: 9950, botMd: 10000, pr: 2700, J: 0.8 }], perf: { topMd: 9800, botMd: 10000, midMd: 9900 } };
      M.surface.psep_psig = 100; M.surface.choke.bean64 = 32; M.system.corr.well = 'bb';
      const R = G.WTS_wp_system.solve(M);
      assert.ok(R.ok, JSON.stringify(plain(R.errors)));
      const sum = R.layers.rates.reduce((s, r) => s + r.q, 0);
      assert.rel(sum, R.op.q, 1e-7, 'Σ layer rates = q');
      const W = G.WTS_wp_well.build(M.well, { res: M.res });
      assert.rel(R.layers.rates[0].tvd, W.tvdAt(9825), 1e-9, 'layer TVD from the survey');
      assert.ok(R.layers.thief.indexOf('Lo') !== -1 && R.flags.some((f) => f.code === 'CROSSFLOW'), 'crossflow while flowing');
      assert.ok(Math.abs(R.layers.crossflow.layers.reduce((s, r) => s + r.q, 0)) < 1e-6, 'shut-in balance');
    },
  },
  {
    name: 'IP2-10 injector inflow: water q = II·(pwf − p̄r), Darcy II from k·h (Bw, μw); gas m(p) LIT reversed with exact inverses; the fracture pressure caps the curve; p_frac ≤ p̄r refused',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, W = G.WTS_wp_ipr, FW = Object.assign({}, FF, { type: 'waterinj' });
      const I = W.curve({ model: 'injector', pr: 3000, params: { II: 5, pfrac: 4500 } }, FW);
      assert.ok(I.ok && I.inj && I.kind === 'inj', JSON.stringify(plain(I.errors)));
      assert.strictEqual(I.qAt(3400), 2000); assert.strictEqual(I.pwfAt(2000), 3400); assert.strictEqual(I.qAt(2900), 0);
      assert.strictEqual(I.aof, 7500, 'rate at the fracture pressure'); assert.strictEqual(I.curve[40].pwf, 4500, 'the curve runs up to p_frac');
      const X = Math.log(1490 / 0.354) - 0.75, D = W.curve({ model: 'injector', pr: 3000, params: { k: 30, h: 40, rw: 0.354, re: 1490, S: 1 } }, FW);
      assert.rel(D.II, 30 * 40 / (141.2 * 1.02 * 0.4 * (X + 1)), 1e-12, 'Darcy II');
      assert.strictEqual(W.curve({ model: 'injector', pr: 3000, params: { II: 5, pfrac: 2900 } }, FW).code, 'BAD_PFRAC');
      const FGi = G.WTS_wp_fluid.build(Object.assign(S.FIX.oilWell.fluid, { type: 'gasinj', sgg: 0.65 }), { T_F: 200 });
      const Ig = W.curve({ model: 'injector', pr: 3000, T_F: 200, params: { k: 10, h: 50, rw: 0.354, re: 1490, S: 0, D: 1e-4, pfrac: 4800 } }, FGi);
      assert.ok(Ig.ok && Ig.injector.fluid === 'gas', JSON.stringify(plain(Ig.errors)));
      [500, 5000, 0.9 * Ig.aof].forEach((q) => assert.rel(Ig.qAt(Ig.pwfAt(q)), q, 1e-9, 'gas inverse at ' + q));
      assert.ok(Ig.pwfAt(0) === 3000 && Ig.pwfAt(1000) > 3000, 'gas: pwf above p̄r');
      assert.ok(G.WTS_wp_fluid.build(S.FIX.oilWell.fluid && Object.assign(S.FIX.oilWell.fluid, { type: 'gasinj' }), { T_F: 200 }).warnings.every((w) => !/later release/.test(w.msg)), 'gas injectors no longer deferred');
    },
  },
  {
    name: 'IP2-11 injector solve: the operating point closes; fracture verdicts ok / warn / fail with the THP; no injection below the column; the DFIT closure as a provisional p_frac; model / fluid checks',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, SY = G.WTS_wp_system;
      const R = SY.solve(injM(G));
      assert.ok(R.ok && R.injector, JSON.stringify(plain(R.errors)));
      assert.ok(R.roots.length === 1 && R.op.stable && R.qs === null, 'one stable root, no q_s');
      assert.rel(R.pwf, 3200 + R.op.q / 4, 1e-12, 'on the injectivity line');
      assert.strictEqual(R.inj.qFrac, 8000); assert.strictEqual(R.inj.verdict, 'ok');
      assert.ok(Math.abs(R.breakdown.reduce((s, b) => s + b.dp, 0) - (1200 + PATM - 3200)) < 1e-6, 'breakdown sums to THP − p̄r');
      assert.ok(R.breakdown.find((b) => b.key === 'gravity').dp < 0, 'the column is a gain');
      assert.ok(R.flags.some((f) => f.code === 'PROVISIONAL_INJ' && f.msg.indexOf(PROV) !== -1));
      assert.strictEqual(R.rates.qw, R.op.q); assert.strictEqual(R.rates.injection, true);
      const Rf = SY.solve(injM(G, { thp: R.inj.thpFrac_psig + 300 }));
      assert.strictEqual(Rf.inj.verdict, 'fail'); assert.ok(Rf.flags.some((f) => f.code === 'INJ_FRAC'));
      const Rw = SY.solve(injM(G, { thp: R.inj.thpFrac_psig - 80 }));
      assert.strictEqual(Rw.inj.verdict, 'warn');
      const Rn = SY.solve(injM(G, { params: { II: 4, pfrac: 5200 }, thp: 0 }));
      const M2 = injM(G, { thp: 0 }); M2.res.pr = 4800; M2.res.params.pfrac = 6500;
      const R0 = SY.solve(M2);
      assert.ok(!R0.ok && R0.code === 'NO_INJECTION' && R0.inj.thpStart_psig > 0, 'no injection, THP to start ' + R0.inj.thpStart_psig); void Rn;
      // DFIT closure (no p_frac entered): provisional
      G.WTS_state = G.WTS_state || {}; const keep = G.WTS_state.dfit;
      G.WTS_state.dfit = { ok: true, closureGrad: 0.66, isip: 5600, labelsCalibrated: false };
      const Md = injM(G); delete Md.res.params.pfrac;
      const Rd = SY.solve(Md), W = G.WTS_wp_well.build(Md.well, { res: Md.res });
      assert.rel(Rd.inj.pFrac, 0.66 * W.nodes.midPerfTvd, 1e-12, 'closure gradient × mid-perf TVD');
      assert.ok(Rd.inj.pFracProvisional && Rd.flags.some((f) => f.code === 'INJ_FRAC_DFIT'), 'provisional DFIT label');
      if (keep === undefined) delete G.WTS_state.dfit; else G.WTS_state.dfit = keep;
      // checks: an injector needs the injector model and a THP; a producer refuses the injector model
      const Mc = injM(G); Mc.res.model = 'pi'; Mc.system.thp_psig = null;
      const items = G.WTS_wp_check(Mc).items.map((x) => x.code);
      assert.ok(items.indexOf('INJ_MODEL') !== -1 && items.indexOf('INJ_THP') !== -1, items.join(','));
      assert.strictEqual(SY.solve(Mc).code, 'INJ_MODEL');
      const Mp = S.FIX.oilWell; Mp.res = { model: 'injector', pr: 3000, T_F: 200, params: { II: 5 }, points: [], layers: [] };
      assert.ok(G.WTS_wp_check(Mp).items.some((x) => x.code === 'INJ_MODEL_PROD') && SY.solve(Mp).code === 'INJ_MODEL', 'producer refuses the injector model');
    },
  },
  {
    name: 'IP2-12 injection traverse (flow down the deviated path): no-flow column hydrostatic on TVD, friction lowers pwf with rate, top-down and bottom-up agree within 0.5 psi',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const G = app0(ctx).win, V = G.WTS_wp_vlp, M = injM(G), F = G.WTS_wp_fluid.build(M.fluid, { T_F: 230 }), W = G.WTS_wp_well.build(M.well, { res: M.res });
      const t0 = V.traverse(F, W, 1e-6, { from: 'top', p0: 1200 + PATM, inject: true, corr: 'bb' });
      assert.ok(t0.ok && t0.inject, JSON.stringify(plain(t0.errors)));
      const pr = t0.profile.filter((r) => !r.restr); let p = 1200 + PATM;
      for (let i = 1; i < pr.length; i++) { const dz = pr[i].tvd - pr[i - 1].tvd, tm = 0.5 * (pr[i].t + pr[i - 1].t), r1 = F.at(p, tm).rhoW, r2 = F.at(p + r1 * dz / 144, tm).rhoW; p += 0.5 * (r1 + r2) * dz / 144; }
      assert.ok(Math.abs(t0.pEnd - p) / (p - 1200) < 1e-4, 'hydrostatic on TVD: ' + t0.pEnd + ' vs ' + p);
      const a = V.traverse(F, W, 3000, { from: 'top', p0: 1200 + PATM, inject: true, corr: 'bb' }), b = V.traverse(F, W, 6000, { from: 'top', p0: 1200 + PATM, inject: true, corr: 'bb' });
      assert.ok(t0.pEnd > a.pEnd && a.pEnd > b.pEnd, 'friction lowers pwf');
      const up = V.traverse(F, W, 6000, { from: 'bottom', p0: b.pEnd, inject: true, corr: 'bb' });
      assert.ok(Math.abs(up.pEnd - (1200 + PATM)) < 0.5, 'direction agreement ' + up.pEnd);
      // the producer march on the same path is unchanged by the option (absent → A1 / A2 bit for bit)
      const q = V.traverse(F, W, 3000, { from: 'top', p0: 1200 + PATM, corr: 'bb' }), q2 = V.traverse(F, W, 3000, { from: 'top', p0: 1200 + PATM, corr: 'bb', inject: false });
      assert.ok(Object.is(q.pEnd, q2.pEnd) && q.inject === false, 'inject:false = the producer march');
    },
  },
  {
    name: 'IP2-13 Build-up Surveillance hand-off: the latest interpreted build-up → k, h (or kh/k), S, rw / re; p̄r moved to the mid-perforations; p* caution; no result → NO_BUILDUP; the page button (async) writes the controls with provenance chips',
    wp: WP,
    async run(app, assert, ctx) {
      app = app0(ctx); S.resetWellPerf(app);
      const G = app.win, W = G.WTS_wp_ipr;
      const st = { v: 1, analysis: { well: { fluid: 'oil', h: null, rw: 0.354, re_ft: 1490 }, depth: { datumTVD: 7900, grad: 0.35 }, tests: [
        { id: 'B1', status: 'interpreted', tc_ms: 1, date: '2026-01-01', pExtDatum: 3100, result: { final: { k: 10, kh: 400, S: 3, pExtKind: 'pbar' } } },
        { id: 'B3', status: 'excluded', tc_ms: 9, date: '2026-05-01', result: { final: { k: 99 } } },
        { id: 'B2', status: 'interpreted', tc_ms: 2, date: '2026-03-01', pStarDatum: 3050, result: { final: { k: 12, kh: 480, S: 4, pExtKind: 'pStar' }, confidence: { headline: 'medium' } } }] } };
      const r = W.fromBuildup(st, { midPerfTvd: 8000 });
      assert.ok(r.ok, JSON.stringify(plain(r.errors)));
      assert.strictEqual(r.test.id, 'B2', 'the latest interpreted test');
      assert.deepStrictEqual(plain(r.spec.params), { k: 12, h: 40, S: 4, rw: 0.354, re: 1490 }, 'h = kh/k without a well h');
      assert.rel(r.spec.pr, 3050 + 0.35 * 100, 1e-12, 'p̄r at the mid-perforations');
      assert.ok(r.warnings.some((w) => w.code === 'BU_PSTAR') && /Build-up B2/.test(r.provenance.k), 'p* caution + provenance');
      assert.strictEqual(W.fromBuildup(null).code, 'NO_BUILDUP'); assert.strictEqual(W.fromBuildup({ v: 1, analysis: { tests: [] } }).code, 'NO_BUILDUP');
      // the page button: the store's state of this well (localStorage) through WTS_buildup.store
      app.storage.setItem('wts_buildup_state', JSON.stringify(st));
      app.hook.nav('wellperf'); app.flush(30);
      app.click(app.find('[data-act="example"][data-ex="oil"]')); app.flush(30);
      app.click(app.find('[data-act="bu"]'));
      for (let i = 0; i < 10; i++) { await Promise.resolve(); app.flush(5); }
      assert.match(txt(app.el('wp_bumsg')), /Imported build-up B2/);
      assert.strictEqual(app.el('wp_ipr').value, 'darcyOil', 'switched to a k·h model');
      assert.ok(Math.abs(parseFloat(app.el('wp_ip_k').value) - 12) < 1e-9 && /Build-up/.test(txt(app.find('label[for="wp_ip_k"]'))), 'k with its provenance chip');
      app.storage.removeItem('wts_buildup_state');
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors');
    },
  },
  {
    name: 'IP2-14 model: the layers table round-trips through WTS_wp_model (validated, TVD kept, at most 10 rows) and M.res carries the perforations; models without layers read exactly as before',
    wp: WP, opts: false,
    run(_a, assert, ctx) {
      const Mm = app0(ctx).win.WTS_wp_model;
      const mem = () => { const d = {}; return { getItem: (k) => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); }, removeItem: (k) => { delete d[k]; } }; };
      const s = mem();
      assert.ok(Mm.TABLE_KEYS.indexOf('layers') !== -1 && Array.isArray(Mm.empty().layers));
      const M0 = Mm.read({ storage: s, scalars: { wp_perfTop: '7980', wp_perfBot: '8020', wp_midPerf: '8000' } });
      assert.deepStrictEqual(plain(M0.res.layers), []); assert.deepStrictEqual(plain(M0.res.perf), { topMd: 7980, botMd: 8020, midMd: 8000 });
      const rows = []; for (let i = 0; i < 12; i++) rows.push({ name: 'L' + i, topMd: 7000 + 100 * i, botMd: 7050 + 100 * i, tvdTop: 6900 + 90 * i, tvdBot: 6945 + 90 * i, pr: '3000', J: 1 });
      rows.push({ name: 'bad', topMd: 9000, botMd: 8000, pr: 3000 });
      const w = Mm.write({ layers: rows }, { storage: s });
      assert.ok(w.ok, JSON.stringify(w));
      const M1 = Mm.read({ storage: s });
      assert.strictEqual(M1.res.layers.length, 10, 'capped at 10, the bad row dropped');
      assert.ok(M1.res.layers[0].pr === 3000 && M1.res.layers[0].tvdTop === 6900 && M1.res.layers[0].use === true, 'numbers and TVD kept');
      assert.ok(Object.isFrozen(M1.res.layers), 'frozen');
    },
  },
  {
    name: 'IP2-15 page: the horizontal, two-layer and injector examples are wired into the interactive page — study plot handles (L / THP) re-solve live, KPIs with chips, schematic beds and flow arrows, layer table TVD and rates, report capture, no NaN',
    wp: WP, integration: true,
    run(app, assert, ctx) {
      app = app0(ctx); S.resetWellPerf(app);
      app.hook.nav('wellperf'); app.flush(30);
      const P = app.win.WTS_wellperf_page; P.budget(5000); P.resetJobs();
      const ex = (k) => { app.click(app.find('[data-act="example"][data-ex="' + k + '"]')); app.flush(40); };
      const st = () => app.win.WTS_state.wellperf, kp = () => app.findAll('#wp_kpis .kpi').map((k) => txt(k.querySelector('.kpi-l')));
      // horizontal: Joshi on the surveyed lateral (L blank = the perforated MD interval)
      ex('hz');
      assert.ok(st().ok, 'hz solves');
      assert.ok(kp().indexOf('Lateral') !== -1 && /2,000 ft/.test(txt(app.el('wp_kpis'))), 'Lateral KPI');
      let cv = app.el('wp_cv_iprs');
      assert.ok(!/wp-off/.test(app.el('wp_iprsbox').className) && cv._wp && cv._wp.spec.handles[0].key === 'L', 'study plot with the L handle');
      const q0 = st().op.q;
      P.handle('L', 3000, 'end'); app.flush(40);
      assert.strictEqual(app.el('wp_ip_L').value, '3000'); assert.ok(st().op.q > q0, 'a longer lateral flows more');
      assert.match(app.el('wp_sch').innerHTML, /lateral/);
      // two layers with crossflow
      ex('ml');
      assert.ok(st().ok && kp().indexOf('Crossflow') !== -1, 'Crossflow KPI');
      assert.ok((app.el('wp_sch').innerHTML.match(/class="wp-layer"/g) || []).length === 2, 'two beds on the schematic');
      const lt = app.el('wp_tbl_layers'); assert.ok(lt && lt.querySelectorAll('tbody tr').length === 2, 'layers table');
      assert.match(txt(lt), /STB\/d/); assert.ok(/Top TVD/.test(txt(lt)), 'TVD columns');
      assert.match(txt(app.el('wp_verd')), /Crossflow while flowing: Lower \(depleted\) takes fluid/);
      assert.match(txt(app.el('wp_op')), /Layer Upper/);
      assert.match(txt(app.el('wp_studies')), /Inflow: Layers/);
      // the water injector
      ex('inj');
      assert.ok(st().ok && st().op.q > 0, 'injector solves');
      assert.deepStrictEqual(kp(), ['Injection rate', 'Injection BHP', 'Injection THP', 'Fracture margin', 'Max rate (no frac)', 'Injectivity', 'Injection temperature', 'Erosion ratio']);
      const sys = app.el('wp_cv_sys')._wp.spec;
      assert.ok(sys.hlines.some((h) => /fracture pressure/.test(h.label)) && sys.handles.map((h) => h.key).join(',') === 'pr,thp', 'p_frac line, THP handle');
      cv = app.el('wp_cv_iprs'); assert.strictEqual(cv._wp.spec.handles[0].key, 'thpI');
      const qi = st().op.q;
      P.handle('thpI', 1500, 'end'); app.flush(40);
      assert.strictEqual(app.el('wp_thp').value, '1500'); assert.ok(st().op.q > qi, 'more THP, more injection');
      assert.match(app.el('wp_sch').innerHTML, /injection ↓/); assert.ok(!/data-comp="choke"/.test(app.el('wp_sch').innerHTML), 'no choke on an injector');
      assert.match(txt(app.el('wp_verd')), /✓ Injecting/);
      ['wp_res', 'wp_step_2'].forEach((id) => assert.ok(!BAD.test(txt(app.el(id))), id + ' clean: ' + (txt(app.el(id)).match(BAD) || [''])[0]));
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors');
      // back to the A1 oil example: ten KPIs, no study plot
      ex('oil');
      assert.strictEqual(kp().length, 10); assert.ok(/wp-off/.test(app.el('wp_iprsbox').className));
    },
  },
];
