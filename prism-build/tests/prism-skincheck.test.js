// Build-up Surveillance — WP7 PRiSM skin maths and the Skin-check card
// (docs/BUILDUP-SURVEILLANCE-PLAN.md §3.4, D23, §4.7 T7/T8/T14/T15, §6.11, §9 WP7, §11 Q7).
//
//   SK1  perforation skin: UNVERIFIED while the Karakas–Tariq table is unverified (the plan vectors 180° 2 spf → 2.19,
//        0° / 90° / 60° → 3.09 / 2.03 / 2.29 go through the public function once verified, and through the internal
//        routine always, so flipping the flag is one line)
//   SK2  mechanical skin: S_total 5.5 → 12 with S_pp 4 → S_mech 1.5 → 8; S_d = S_mech·h_w/h; D·q removed
//   SK3  deviation above 75° → validity warning, not split
//   SK4  rateSkin guards: q ratio < 1.5 → unresolved; collinear q and t → joint fit refused; a 2× spread resolves D
//   SK9  products: TR7 numbers, guard, bounds labelled when reSource 'rinv'
//
// The maths tests load 54-prism-skin.js on its own (self-test stripped exactly as Round 8 strips it), so they need no app.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WP = 'BU7';
const SRC_FILE = path.join(__dirname, '..', '54-prism-skin.js');

// 54 on its own, in a bare context (no document, no PRiSM): proves the module loads standalone.
let _sc = null;
function skin() {
  if (_sc) return _sc;
  const { stripSelfTest } = require(path.join(__dirname, '..', 'concat-round8.js'));
  const src = stripSelfTest(fs.readFileSync(SRC_FILE, 'utf8'), '54-prism-skin.js', { log() {}, warn() {} });
  const ctx = { console: { log() {}, warn() {}, error: (...a) => console.error(...a) } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: SRC_FILE });
  if (!ctx.PRiSM_skinCheck) throw new Error('54-prism-skin.js did not define PRiSM_skinCheck');
  if (ctx.PRiSM_skinCheck_selfTest !== undefined) throw new Error('the 54 self-test was not stripped');
  _sc = ctx.PRiSM_skinCheck;
  return _sc;
}
const plain = (o) => JSON.parse(JSON.stringify(o));
const BAD_TEXT = /\b(null|undefined|NaN|Infinity)\b|\[object Object\]/;
function textsOk(assert, o, where) {
  (function walk(v, p) {
    if (typeof v === 'string') assert(!BAD_TEXT.test(v), where + p + ': bad text "' + v + '"');
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, p + '[' + i + ']'));
    else if (v && typeof v === 'object') Object.keys(v).forEach((k) => walk(v[k], p + '.' + k));
    else if (typeof v === 'number') assert(isFinite(v), where + p + ': number must be finite or null');
  })(o, '');
}

// KT vectors (plan §9 WP7 SK1): rw 0.406 ft, lp 8 in, rp 0.25 in, kh/kv 3, 2 spf.
const KT_BASE = { rw_ft: 0.406, lp_in: 8, rp_in: 0.25, spf: 2, kvkh: 1 / 3 };
const KT_VECTORS = [[180, 2.19], [0, 3.09], [90, 2.03], [60, 2.29]];

module.exports = [
  {
    name: 'SK1 perforation skin: UNVERIFIED until the Karakas–Tariq table is verified; plan vectors from the table',
    wp: WP,
    opts: false,
    run(app, assert) {
      const SC = skin();
      assert.fn(SC.perforationSkin);
      assert.strictEqual(typeof SC.KT.verified, 'boolean');
      // The six phasings and every coefficient are present and finite.
      assert.deepStrictEqual(plain(SC.KT.phases), [0, 45, 60, 90, 120, 180]);
      SC.KT.phases.forEach((ph) => ['a_theta', 'a1', 'a2', 'b1', 'b2', 'c1', 'c2'].forEach((k) => assert.finite(SC.KT.rows[ph][k], ph + '° ' + k)));
      assert(Object.isFrozen(SC.KT) && Object.isFrozen(SC.KT.rows[90]), 'the table is frozen');
      // Table consistency: the internal routine reproduces the plan's vectors.
      KT_VECTORS.forEach(([ph, want]) => {
        const r = SC._ktCompute(Object.assign({ phase_deg: ph }, KT_BASE));
        assert.strictEqual(r.ok, true, ph + '°');
        assert.near(r.S_perf, want, 0.005, 'internal ' + ph + '°');
        assert.near(r.S_H + r.S_V + r.S_wb, r.S_perf, 1e-12, 'S_perf = S_H + S_V + S_wb');
      });
      // 360° is 0°; bad inputs fail with the field names.
      assert.near(SC._ktCompute(Object.assign({ phase_deg: 360 }, KT_BASE)).S_perf, 3.09, 0.005);
      const bad = SC._ktCompute({ rw_ft: 0.406, lp_in: 0, rp_in: 0.25, spf: 2, phase_deg: 75, kvkh: 1 });
      assert.strictEqual(bad.ok, false);
      assert.strictEqual(bad.code, 'BAD_INPUT');
      assert.deepStrictEqual(plain(bad.bad).sort(), ['lp_in', 'phase_deg']);
      // Outside the correlation range → a warning, still computed.
      const sparse = SC._ktCompute({ rw_ft: 0.354, lp_in: 6, rp_in: 0.2, spf: 0.5, phase_deg: 90, kvkh: 0.1 });
      assert(sparse.ok && sparse.warnings.some((w) => w.code === 'ktHd'), 'hD > 10 warned');
      textsOk(assert, plain(sparse), 'sparse');
      // The public function.
      KT_VECTORS.forEach(([ph, want]) => {
        const r = SC.perforationSkin(Object.assign({ phase_deg: ph }, KT_BASE));
        if (SC.KT.verified) {
          assert.strictEqual(r.ok, true);
          assert.strictEqual(r.verified, true);
          assert.near(r.S_perf, want, 0.005, 'public ' + ph + '°');
        } else {
          assert.strictEqual(r.ok, false);
          assert.strictEqual(r.code, 'UNVERIFIED');
          assert.strictEqual(r.verified, false);
          assert.strictEqual(r.S_perf, null);
          assert(Array.isArray(r.errors) && r.errors.length && Array.isArray(r.bad), 'failure shape {ok, code, errors, bad}');
          textsOk(assert, plain(r), 'UNVERIFIED');
        }
      });
      // An unverified table must say so in the header record (Q7).
      const src = fs.readFileSync(SRC_FILE, 'utf8');
      assert(/VERIFICATION RECORD/.test(src), 'the verification record is in the file header');
      if (!SC.KT.verified) assert(/Status: UNVERIFIED/.test(src), 'the header says UNVERIFIED');
      else assert(SC.KT.page != null, 'a verified table records its page');
    },
  },
  {
    name: 'SK2 mechanical skin: S_total 5.5 → 12 with S_pp 4 → S_mech 1.5 → 8; S_d = S_mech·h_w/h; D·q removed',
    wp: WP,
    opts: false,
    run(app, assert) {
      const SC = skin();
      const h = 50, rw = 0.354, kv = 0.5;
      const pp = (hp) => SC.mechanicalSkin({ S_total: 0, Serr: 0, h, rw, completion: { hp_ft: hp, htop_ft: 0, theta_deg: 0, kvkh: [kv, kv], perf: null } }).parts.pp;
      // Find the open interval whose partial-penetration skin is 4 (pp falls as hp grows).
      let lo = 1, hi = h * 0.999;
      assert(pp(lo) > 4 && pp(hi) < 4, 'bracket');
      for (let i = 0; i < 80; i++) { const mid = 0.5 * (lo + hi); if (pp(mid) > 4) lo = mid; else hi = mid; }
      const hp = 0.5 * (lo + hi);
      const comp = { hp_ft: hp, htop_ft: 0, theta_deg: 0, kvkh: [kv, kv], perf: null };
      const r1 = SC.mechanicalSkin({ S_total: 5.5, Serr: 0.4, h, rw, completion: comp, D: null, q: null });
      const r2 = SC.mechanicalSkin({ S_total: 12, Serr: 0.4, h, rw, completion: comp, D: null, q: null });
      [r1, r2].forEach((r) => {
        assert.strictEqual(r.available, true);
        assert.near(r.parts.pp, 4, 1e-6, 'S_pp');
        assert.strictEqual(r.parts.ppMethod, 'papatzacos');
        assert.near(r.S_geo, 4, 1e-6);
        assert.near(r.S_geo_lo, r.S_geo_hi, 1e-12, 'a single kv/kh gives no range');
        assert.near(r.S_mech_err, 0.4, 1e-9, 'S_mech_err = S_err when kv/kh is fixed');
        textsOk(assert, plain(r), 'mech');
      });
      assert.near(r1.S_mech, 1.5, 1e-6, 'S_mech 1.5');
      assert.near(r2.S_mech, 8, 1e-6, 'S_mech 8');
      assert.near(r1.S_d_local, 1.5 * hp / h, 1e-6, 'S_d = S_mech·h_w/h');
      assert.near(r2.S_d_local, 8 * hp / h, 1e-6);
      // ΔS_mech = ΔS_total (the geometric part is constant).
      assert.near(r2.S_mech - r1.S_mech, 12 - 5.5, 1e-9);
      // D·q is removed on the pressure-drop basis.
      const r3 = SC.mechanicalSkin({ S_total: 12, Serr: 0.4, h, rw, completion: comp, D: 2e-4, q: 5000 });
      assert.near(r3.S_mech, 8 - 1, 1e-6, 'S_mech = S_t − S_geo − D·q');
      assert.near(r3.parts.Dq, 1, 1e-12);
      // A kv/kh range widens the geometric skin and S_mech_err.
      const r4 = SC.mechanicalSkin({ S_total: 12, Serr: 0.4, h, rw, completion: Object.assign({}, comp, { kvkh: [0.1, 1] }) });
      assert(r4.S_geo_lo < r4.S_geo && r4.S_geo < r4.S_geo_hi, 'range brackets the central value');
      assert(r4.S_mech_err > 0.4);
      // Interval at the top: Brons–Marting is reported as a cross-check within 10 %.
      assert(Math.abs(r4.parts.ppBronsMarting - r4.parts.pp) / r4.parts.pp < 0.1, 'Brons–Marting cross-check ' + r4.parts.ppBronsMarting + ' vs ' + r4.parts.pp);
      // Full penetration, vertical: S_geo 0, S_mech = S_total.
      const full = SC.mechanicalSkin({ S_total: 3, Serr: 0.2, h, rw, completion: { hp_ft: h, htop_ft: 0, theta_deg: 0, kvkh: [0.1, 1], perf: null } });
      assert.strictEqual(full.available, true);
      assert.strictEqual(full.parts.ppMethod, 'none');
      assert.near(full.S_mech, 3, 1e-12);
      // No completion, interval outside the layer: not available, with a reason.
      const none = SC.mechanicalSkin({ S_total: 3, Serr: 0.2, h, rw, completion: null });
      assert.strictEqual(none.available, false);
      assert(none.reason.length > 0 && none.S_mech === null);
      const outside = SC.mechanicalSkin({ S_total: 3, Serr: 0.2, h, rw, completion: { hp_ft: 30, htop_ft: 30, theta_deg: 0, kvkh: [0.1, 1], perf: null } });
      assert.strictEqual(outside.available, false);
      assert(outside.validity.some((v) => v.code === 'intervalOutside'));
      // Perforation data: not split while unverified (Q7), and the text says so.
      const perf = SC.mechanicalSkin({ S_total: 6, Serr: 0.2, h, rw, completion: Object.assign({}, comp, { perf: { spf: 4, lp_in: 12, rp_in: 0.2, phase_deg: 90 } }) });
      assert.strictEqual(perf.available, true);
      if (!SC.KT.verified) {
        assert.strictEqual(perf.parts.perf, null);
        assert(perf.validity.some((v) => v.code === 'perfNotSplit' && /not split/.test(v.text)));
        assert.near(perf.S_mech, 6 - 4, 1e-6, 'S_mech keeps the perforation skin');
      } else {
        assert.finite(perf.parts.perf);
        assert.near(perf.parts.perf, perf.parts.perfLocal * h / hp, 1e-9, 'perforation skin referred to h');
      }
      textsOk(assert, plain(perf), 'perf');
    },
  },
  {
    name: 'SK3 deviation above 75° → validity warning, not split; 75° and below split',
    wp: WP,
    opts: false,
    run(app, assert) {
      const SC = skin();
      const base = { S_total: 4, Serr: 0.3, h: 100, rw: 0.354 };
      const at = (theta, kvkh) => SC.mechanicalSkin(Object.assign({}, base, { completion: { hp_ft: 100, htop_ft: 0, theta_deg: theta, kvkh: kvkh || [1, 1], perf: null } }));
      const r80 = at(80);
      assert.strictEqual(r80.available, false, '80° not split');
      assert.strictEqual(r80.S_mech, null);
      assert.strictEqual(r80.parts.theta, null);
      assert(r80.validity.some((v) => v.code === 'thetaRange' && /75/.test(v.text)), JSON.stringify(plain(r80.validity)));
      textsOk(assert, plain(r80), 'r80');
      const r75 = at(75);
      assert.strictEqual(r75.available, true, '75° split');
      assert(r75.parts.theta < 0, 'a slanted well has a negative pseudo-skin');
      assert.near(r75.S_mech, 4 - r75.parts.theta, 1e-12);
      // The Cinco-Ley value at 45°, kv/kh 1, h/rw 100/0.354 (PRiSM 03 self-test: −1.511).
      assert.near(at(45).parts.theta, -1.511, 0.01);
      // Thin layer → approximate-correlation note, still split.
      const thin = SC.mechanicalSkin({ S_total: 4, Serr: 0.3, h: 10, rw: 0.354, completion: { hp_ft: 10, htop_ft: 0, theta_deg: 30, kvkh: [1, 1], perf: null } });
      assert.strictEqual(thin.available, true);
      assert(thin.validity.some((v) => v.code === 'thetaHd'));
    },
  },
  {
    name: 'SK4 rateSkin guards: q ratio < 1.5 unresolved; collinear q and t → joint fit refused; 2× spread resolves D',
    wp: WP,
    opts: false,
    run(app, assert) {
      const SC = skin();
      const D = 2e-4, S0 = 3;
      const mk = (qs, ts, f) => qs.map((q, i) => ({ id: 'B' + (i + 1), t_days: ts[i], q, S: (f ? f(q, ts[i]) : S0 + D * q), Serr: 0.2 }));
      // q ratio below 1.5.
      const r1 = SC.rateSkin(mk([10000, 8000, 10000, 8000], [0, 10, 20, 30]));
      assert.strictEqual(r1.resolved, false);
      assert.near(r1.qRatio, 1.25, 1e-12);
      assert(/Rate ratio/.test(r1.reason) && r1.D === null, r1.reason);
      // Collinear rate and time (rate steps up with time; skin also rising): refused.
      const r2 = SC.rateSkin(mk([5000, 6000, 8000, 10000, 12000], [0, 10, 20, 30, 40], (q, t) => S0 + 0.05 * t));
      assert.strictEqual(r2.resolved, false);
      assert.strictEqual(r2.joint, null, 'joint fit refused');
      assert(/collinear/.test(r2.reason) && Math.abs(r2.corrQT) >= 0.8, r2.reason);
      // Two tests are always collinear.
      const r2b = SC.rateSkin(mk([5000, 10000], [0, 10]));
      assert.strictEqual(r2b.resolved, false);
      assert(/collinear/.test(r2b.reason));
      // 3 + 3 constant-skin tests 2.0× apart (the gas demo pattern): D within 10 % and D/se ≥ 2.
      const r3 = SC.rateSkin(mk([10000, 5000, 10000, 5000, 10000, 5000], [0, 7, 14, 21, 28, 35]),
        { expected: { k: 10, h: 50, hp: 50, rw: 0.354, sg: 0.65, mu_g: 0.02 } });
      assert.strictEqual(r3.resolved, true, r3.reason);
      assert(Math.abs(r3.D / D - 1) <= 0.10, 'D ' + r3.D);
      assert(r3.D / r3.seD >= 2, 'D/se ' + (r3.D / r3.seD));
      assert.near(r3.S, S0, 1e-9);
      assert.near(r3.qRatio, 2, 1e-12);
      assert.deepStrictEqual(plain(r3.ev), ['T15']);
      // se with S_err 0.2 at both levels: se(ΔS′) = 0.2·√(1/3 + 1/3) over Δq = 5000.
      assert.near(r3.seD, 0.2 * Math.sqrt(2 / 3) / 5000, 1e-12, 'GE5 arithmetic');
      // Joint fit runs (≥ 4 tests, low corr); the expected D is reported with its range.
      assert(r3.joint && Number.isFinite(r3.joint.D), 'joint fit present');
      assert(r3.expectedD && r3.expectedD.lo < r3.expectedD.D && r3.expectedD.D < r3.expectedD.hi);
      assert.strictEqual(typeof r3.consistent, 'boolean');
      // A real skin trend alongside the rate spread: the joint fit separates it.
      const r4 = SC.rateSkin(mk([10000, 5000, 5000, 10000, 10000, 5000], [0, 7, 14, 21, 28, 35], (q, t) => S0 + 0.06 * t + D * q));
      assert.strictEqual(r4.resolved, true, r4.reason);
      assert.near(r4.D, D, 1e-9, 'D from the joint fit');
      assert.near(r4.joint.r_per30d, 0.06 * 30, 1e-6);
      assert(/trend/.test(r4.reason));
      // Gaps > 60 days split the tests; the largest group is used.
      const r5 = SC.rateSkin(mk([10000, 5000, 10000, 5000, 10000, 5000, 9000], [0, 7, 14, 21, 28, 35, 200]));
      assert.strictEqual(r5.n, 6);
      assert(r5.ids.indexOf('B7') === -1);
      // Insufficient rows.
      assert.strictEqual(SC.rateSkin([]).resolved, false);
      [r1, r2, r2b, r3, r4, r5].forEach((r, i) => textsOk(assert, plain(r), 'rateSkin' + i));
    },
  },
  {
    name: 'SK9a products: TR7 numbers, m, guard, bounds labelled when reSource is rinv',
    wp: WP,
    opts: false,
    run(app, assert) {
      const SC = skin();
      const rw = 0.354, re = rw * Math.exp(7.68 + 0.75);
      const base = { k: 45, h: 50, B: 1.2, mu: 1, q: 800, Dq: 805, rw, re_ft: re, reSource: 'input', pbar: 3000, pwf: 2400 };
      const a = SC.products(Object.assign({ S: 1.2 }, base)), b = SC.products(Object.assign({ S: 7.4 }, base));
      assert.near(a.X, 7.68, 1e-9);
      assert.near(a.piRatio, 0.865, 0.0005);
      assert.near(b.piRatio, 0.509, 0.0005);
      assert.near(b.qIdealFactor / a.qIdealFactor, 15.08 / 8.88, 1e-9);
      assert.near((7.68 + 7.4) / (7.68 + 1.2), 1.698, 0.0005, 'rate factor');
      assert.near(a.m, 162.6 * 805 * 1.2 * 1 / (45 * 50), 1e-9, 'm = 162.6·Δq·B·μ/(k·h)');
      assert.near(b.dpSkin_psi, 0.8686 * b.m * 7.4, 1e-9, 'Δp_skin = 0.8686·m·S');
      assert.near(a.dpPerSkin_psi, 141.2 * 800 * 1.2 / 2250, 1e-9, '141.2·qBμ/kh');
      assert.near(b.FE, (600 - b.dpSkin_psi) / 600, 1e-12);
      assert.near(b.DR, 1 / b.FE, 1e-12);
      assert.strictEqual(a.reAssumed, false);
      assert.strictEqual(a.piRatioLowerBound, false);
      assert.strictEqual(a.guard, false);
      // Guard: X + S < 1.
      const g = SC.products(Object.assign({ S: -7 }, base));
      assert.strictEqual(g.guard, true);
      assert.strictEqual(g.piRatio, null);
      // r_e from r_inv → lower / upper bound labels.
      const r = SC.products(Object.assign({ S: 7.4 }, base, { reSource: 'rinv' }));
      assert.strictEqual(r.reAssumed, true);
      assert.strictEqual(r.piRatioLowerBound, true);
      assert.strictEqual(r.rateAtStakeUpperBound, true);
      assert(/lower bound/.test(r.labels.piRatio) && /upper bound/.test(r.labels.rateAtStake));
      // Missing inputs → nulls, no NaN.
      const m = SC.products({ S: 2 });
      assert.strictEqual(m.m, null);
      assert.strictEqual(m.dpSkin_psi, null);
      assert.strictEqual(m.FE, null);
      [a, b, g, r, m].forEach((x, i) => textsOk(assert, plain(x), 'products' + i));
    },
  },
  {
    name: 'SK0 sources: 54 is in Round 8 and the app build; no Math.random or timers in the skin maths',
    wp: WP,
    run(app, assert) {
      const { FILES } = require(path.join(__dirname, '..', 'concat-round8.js'));
      assert(FILES.indexOf('54-prism-skin.js') !== -1, 'concat-round8 FILES lists 54');
      const src = fs.readFileSync(SRC_FILE, 'utf8');
      assert(!/Math\.random/.test(src), 'no Math.random');
      assert(!/\bset(Timeout|Interval)\s*\(/.test(src), 'no timers in 54 (the C-held refits run through PRiSM_autoInterp.drive)');
      const SC = app.win.PRiSM_skinCheck;
      assert(SC, 'PRiSM_skinCheck in the app');
      ['perforationSkin', 'mechanicalSkin', 'rateSkin', 'products'].forEach((k) => assert.fn(SC[k], k));
    },
  },
];
