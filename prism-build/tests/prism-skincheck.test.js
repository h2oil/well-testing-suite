// Build-up Surveillance — WP7 PRiSM skin maths and the Skin-check card
// (docs/BUILDUP-SURVEILLANCE-PLAN.md §3.4, D23, §4.7 T7/T8/T14/T15, §6.11, §9 WP7, §11 Q7).
//
//   SK1  perforation skin: UNVERIFIED while the Karakas–Tariq table is unverified (the plan vectors 180° 2 spf → 2.19,
//        0° / 90° / 60° → 3.09 / 2.03 / 2.29 go through the public function once verified, and through the internal
//        routine always, so flipping the flag is one line)
//   SK2  mechanical skin: S_total 5.5 → 12 with S_pp 4 → S_mech 1.5 → 8; S_d = S_mech·h_w/h; D·q removed
//   SK3  deviation above 75° → validity warning, not split
//   SK4  rateSkin guards: q ratio < 1.5 → unresolved; collinear q and t → joint fit refused; a 2× spread resolves D
//   SK9a products: TR7 numbers, guard, bounds labelled when reSource 'rinv'
//   SK0  54 in Round 8 and the app; no Math.random or timers in 54; Tab-6 panel and report entry registered
//   SK0b Tools drawer lists the card once with its written title (no machine-named "More" entry) and opens it
//   SK5  the card renders on Tab 6 after a fit with no localStorage change, no events and no timers on render;
//        hidden in decline mode and without a fit or straight line; the BuildupSpec / EvidenceVector it builds pass checkShape
//   SK5b a drawdown from pi is passed as a build-up after a very long producing time, labelled indicative, no p*
//   SK6  the PRiSM report contains the "Skin check" section (order 45)
//   SK7  "Use this window" stores the semilog window (user action, the C7 event allowed)
//   SK8  the C-held button runs through PRiSM_autoInterp.drive, can be cancelled (button or unmount), leaves no timers
//   SK9  rate status n/a (no KC4 cap), the numeric reach is shown, PI ratio labelled lower bound; completion inputs saved
//        on change and the mechanical skin re-split
//
// The maths tests load 54-prism-skin.js on its own (self-test stripped exactly as Round 8 strips it), so they need no app.
// STUBS: SK0b and SK5–SK9 need WP1's PRiSM_autoInterp pieces (§3.1: prepare, storage, iarf, line, reach, triggers,
// agreement, sErr, sensitivity, confidence, fitJob, cHeldJob, drive). While 53 has only the WP0 skeleton, engine() installs
// explicit stubs built from the WP0 fixtures (FIX.result); once WP1 is merged the real engine is used and the assertions
// that depend on stub values are skipped (they are guarded by eng.stubbed).
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

// ─────────────────────────────────────────────────────────────────────────────
// Card fixtures (SK5–SK9): a 240 h drawdown at 850 STB/d then a 72 h build-up from the homogeneous model
// (k 45 md, Cd 80, S 2.5), a PRiSM homogeneous match with the true parameters, field units.
// ─────────────────────────────────────────────────────────────────────────────
const TRUTH = { k: 45, Cd: 80, S: 2.5, q: 850, B: 1.25, mu: 1.1, ct: 1.2e-5, h: 35, phi: 0.18, rw: 0.354, pi: 4200 };
TRUTH.C = TRUTH.Cd * TRUTH.phi * TRUTH.ct * TRUTH.h * TRUTH.rw * TRUTH.rw / 0.8936;
const A1 = 141.2 * TRUTH.B * TRUTH.mu / (TRUTH.k * TRUTH.h);
const BT = 0.0002637 * TRUTH.k / (TRUTH.phi * TRUTH.mu * TRUTH.ct * TRUTH.rw * TRUTH.rw);
const TP = 240;
function logspace(lo, hi, n) { const o = []; for (let i = 0; i < n; i++) o.push(Math.pow(10, lo + (hi - lo) * i / (n - 1))); return o; }
function buildupData(app) {
  const pd = (td) => app.win.PRiSM_MODELS.homogeneous.pd(td, { Cd: TRUTH.Cd, S: TRUTH.S });
  const tDD = logspace(-2, Math.log10(TP), 50); tDD[tDD.length - 1] = TP;
  const dts = logspace(-3, Math.log10(72), 140);
  const t = [], p = [], q = [];
  // Deterministic sub-0.01 psi wobble (no Math.random): the record is not unrealistically smooth.
  const wob = (i) => 0.004 * Math.sin(1.7 * i) * Math.cos(0.37 * i);
  tDD.forEach((tt, i) => { t.push(tt); p.push(TRUTH.pi - TRUTH.q * A1 * pd(BT * tt) + wob(i)); q.push(TRUTH.q); });
  dts.forEach((dt, i) => {
    t.push(TP + dt);
    p.push(TRUTH.pi - TRUTH.q * A1 * (pd(BT * (TP + dt)) - pd(BT * dt)) + wob(i + 50));
    q.push(0);
  });
  return { t, p, q };
}
const MATCH = { modelKey: 'homogeneous', params: { Cd: TRUTH.Cd, S: TRUTH.S }, phys: { k: TRUTH.k, S: TRUTH.S, C: TRUTH.C },
                ci95: { k: [44.6, 45.4], S: [2.44, 2.56], C: [TRUTH.C * 0.98, TRUTH.C * 1.02] }, r2: 0.9995, converged: true };
function setupPRiSM(app, opts) {
  opts = opts || {};
  const w = app.win;
  app.openPRiSM();
  w.PRiSM_setWell(app.toWin({ pi: TRUTH.pi, testType: 'buildup', q: TRUTH.q, Bo: TRUTH.B, mu_o: TRUTH.mu, ct: TRUTH.ct, h: TRUTH.h,
                              phi: TRUTH.phi, rw: TRUTH.rw, fluidType: 'oil' }), app.toWin({ source: 'user' }));
  w.PRiSM_dataset = app.toWin(buildupData(app));
  w.PRiSM_state = w.PRiSM_state || app.toWin({});
  w.PRiSM_state.model = 'homogeneous';
  if (opts.fit !== false) w.PRiSM_setLastFit(app.toWin(MATCH));
  app.flushUntilIdle(10000);
  return w;
}

// PRiSM_autoInterp pieces from WP1 (plan §3.1). Where they do not exist yet (this branch), explicit stubs
// that return shape-valid objects from the WP0 fixtures (tests/_buildup-shapes.js FIX.result) are installed.
// The stubs are installed as one set only when PRiSM_autoInterp.prepare is missing, so after WP1 merges these
// tests run against the real engine.
function engine(app) {
  const W = app.win;
  const AI = W.PRiSM_autoInterp;
  if (typeof AI.prepare === 'function') return { stubbed: false, calls: null };
  const S = require('./_buildup-shapes');
  const R = S.FIX.result;
  const cp = (o) => app.toWin(JSON.parse(JSON.stringify(o)));
  const calls = { prepare: 0, confidence: [], sErr: [], specs: [], drive: 0 };
  const job = (n, res) => { let i = 0, cancelled = false; return {
    step() { if (cancelled) return { done: true, progress: 1, label: 'cancelled' }; i++; return { done: i >= n, progress: i / n, label: 'stub ' + i }; },
    result() { return (i >= n && !cancelled) ? cp(res) : null; },
    cancel() { cancelled = true; } }; };
  AI.DEFAULTS = AI.DEFAULTS || cp({ agree: { kPct: 5, dS: 0.5, biasKPct: 3, biasDS: 0.3 }, sErr: { floor: 0.2, winShift: 0.25, winShiftFrac: 0.2 } });
  AI.prepare = (spec) => {
    calls.prepare++; calls.specs.push(JSON.parse(JSON.stringify(spec)));
    const dt = Array.from(spec.dt);
    return cp({ ok: true, id: spec.id, sign: spec.testType === 'falloff' ? -1 : 1, bins: { dt: dt.slice(-5), dte: dt.slice(-5) },
                snrD: 400, rDrift: 0.001, rTide: 0.02, tideRemoved: false, warnings: [] });
  };
  AI.storage = () => cp(R.storage);
  AI.iarf = () => cp(R.iarf);
  AI.line = () => cp(R.line);
  AI.reach = () => cp(R.reach);
  AI.triggers = () => cp({ triggers: R.triggers, flags: R.flags });
  AI.agreement = () => cp(R.agreement);
  AI.sErr = (parts) => { calls.sErr.push(JSON.parse(JSON.stringify(parts))); return cp(R.sErr); };
  AI.sensitivity = () => cp(R.sensitivity);
  AI.confidence = (ev) => {
    const e = JSON.parse(JSON.stringify(ev));
    calls.confidence.push(e);
    const c = JSON.parse(JSON.stringify(R.confidence));
    // KC4 exactly as §5.1 states it: R3 unavailable or an equal-rate assumption; not when R3 is 'n/a'.
    if (e.r3Status === 'unavailable' || e.equalRateAssumed) c.reasons.push({ rule: 'KC4', kind: 'cap', text: 'KC4: rate check unavailable.', ev: ['R3'] });
    return cp(c);
  };
  AI.fitJob = () => job(3, R.models[0]);
  AI.cHeldJob = () => job(4, { triggered: true, mode: 'pair', meaningful: true, ev: ['C1'], S_C: 0.2,
    refits: [{ f: 0.8, k: 44.2, S: 4.6, C: 0.016, dBic: 3.1, rejected: false }, { f: 1.25, k: 45.9, S: 5.4, C: 0.025, dBic: 12.4, rejected: true }],
    range: { C: [0.016, 0.02], k: [44.2, 45], S: [4.6, 5] } });
  // The D19 driver: a terminating chain of one-shot setTimeout(0) yields, count-sliced, cancel → {code:'CANCELLED'}.
  AI.drive = (j, o) => new W.Promise((resolve, reject) => {
    calls.drive++;
    const tick = () => {
      if (o && o.shouldCancel && o.shouldCancel()) { j.cancel(); reject(app.toWin({ code: 'CANCELLED' })); return; }
      const s = j.step();
      if (o && o.onProgress) o.onProgress(s.progress, s.label);
      if (s.done) resolve(j.result()); else W.setTimeout(tick, 0);
    };
    W.setTimeout(tick, 0);
  });
  return { stubbed: true, calls };
}
function storageSnapshot(app) {
  const o = app.storage.__snapshot();
  const keys = Object.keys(o).sort();
  return JSON.stringify(keys.map((k) => [k, o[k]]));
}
const PRISM_EVENTS = ['prism:fit-updated', 'prism:well-changed', 'prism:dataset-loaded', 'prism:period-changed', 'prism:model-changed', 'prism:step-changed', 'prism:tab-open', 'prism:mode-changed'];
function recordEvents(app) {
  const log = [];
  PRISM_EVENTS.forEach((t) => app.win.addEventListener(t, (e) => log.push({ type: t, source: e && e.detail && e.detail.source })));
  return log;
}
function mountHost(app) {
  const host = app.document.createElement('div');
  host.id = 'skc_test_host';
  app.document.body.appendChild(host);
  return host;
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
      ['perforationSkin', 'mechanicalSkin', 'rateSkin', 'products', 'run', 'renderPanel', 'reportSection'].forEach((k) => assert.fn(SC[k], k));
      const panel = (app.win.PRiSM_tabPanels[6] || []).find((p) => p && p.id === 'prism_skincheck');
      assert(panel, 'Tab 6 panel registered');
      assert.strictEqual(panel.order, 8);
      assert.strictEqual(panel.title, 'Skin check: IARF window, line vs match, uncertainty, confidence');
      assert.strictEqual(panel.render, SC.renderPanel);
      const rs = (app.win.PRiSM_reportSections || []).filter((f) => f && f._prismId === 'skin-check');
      assert.strictEqual(rs.length, 1, 'one report-section entry');
    },
  },
  {
    name: 'SK0b Tools drawer: the card is listed once with its written title (no machine-named "More" entry) and opens',
    wp: WP,
    run(app, assert) {
      const w = setupPRiSM(app);
      engine(app);
      const tools = w.PRiSM_listTools().filter((t) => t.available);
      const mine = tools.filter((t) => /skin ?check/i.test(t.title + ' ' + t.id));
      assert.strictEqual(mine.length, 1, 'listed once: ' + JSON.stringify(mine.map((t) => t.title)));
      assert.strictEqual(mine[0].title, 'Skin check: IARF window, line vs match, uncertainty, confidence');
      assert.notStrictEqual(mine[0].group, 'More', 'a written title, not an auto-named entry');
      const more = Array.from(tools.filter((t) => t.group === 'More'), (t) => t.title);
      assert.strictEqual(more.length, 0, 'no auto-named tools (wp16 rule): ' + JSON.stringify(more));
      w.PRiSM_openTools(mine[0].id);
      assert(app.el('prism_tools_panel').querySelector('#prism_skc_root'), 'the drawer shows the card');
      w.PRiSM_closeTools();
    },
  },
  {
    name: 'SK5 the card renders on Tab 6 after a fit: no localStorage change, no events, no timers on render',
    wp: WP,
    run(app, assert) {
      const w = setupPRiSM(app);
      const eng = engine(app);
      const SC = w.PRiSM_skinCheck;
      // Placement: Tab 6 mounts the panel after a fit; hidden without a fit or in decline mode.
      assert.strictEqual(SC.PANEL.when(), true, 'when() after a fit');
      app.renderTab(6);
      app.flushUntilIdle(10000);
      const card = app.el('prism_panel_6_prism_skincheck');
      assert(card, 'Tab 6 card mounted in #prism_tab_6_panels');
      const body = app.el('prism_panel_6_prism_skincheck_body');
      assert(body && body.querySelector('#prism_skc_root'), 'card body rendered');
      // Render again on Tab 6 with storage, events and timers watched.
      const before = storageSnapshot(app);
      const log = recordEvents(app);
      const timers0 = app.pendingTimers();
      const m = SC.PANEL.render(body) || SC._ui.model;
      assert.strictEqual(storageSnapshot(app), before, 'render writes no localStorage');
      assert.strictEqual(log.length, 0, 'render fires no events: ' + JSON.stringify(log));
      assert.strictEqual(app.pendingTimers(), timers0, 'render starts no timers');
      const model = SC._ui.model;
      assert.strictEqual(model.ok, true, model.reason);
      const html = body.innerHTML;
      ['Automatic IARF window (L = 0.1 cycle)', 'Straight line through the window', 'Line vs match', 'Line vs derivative plateau (sanity check)',
       'Skin uncertainty S_err', 'Input sensitivity (analytic)', 'Confidence', 'Calibrated on build-ups; indicative for drawdowns.',
       'Δp skin', 'Flow efficiency', 'PI ratio', 'Mechanical skin', 'Expected IARF reach', 'Run C-held refits',
       'Use this window in the straight-line panel'].forEach((s) => assert.includes(html, s));
      assert(!BAD_TEXT.test(body.textContent), 'no null/NaN/undefined text: ' + (body.textContent.match(BAD_TEXT) || [])[0]);
      // The spec handed to the engine: build-up, PRiSM's own C2 data, measured/tabled rate with R3/R4 'n/a'.
      if (eng.stubbed) {
        const spec = eng.calls.specs[eng.calls.specs.length - 1];
        assert.strictEqual(spec.testType, 'buildup');
        assert.near(spec.tc_h, TP, 1e-9);
        assert.near(spec.Dq, TRUTH.q, 1e-9);
        assert.strictEqual(spec.rateQC.r3Status, 'n/a');
        assert.strictEqual(spec.steps[spec.steps.length - 1].q, 0);
        assert.near(spec.pwf0, w.PRiSM_getAnalysisData().pRefPressure, 1e-9);
        const S = require('./_buildup-shapes');
        const chk = S.checkShape('BuildupSpec', spec);
        assert(chk.ok, 'BuildupSpec shape: ' + JSON.stringify(chk.errors.slice(0, 5)));
        const ev = eng.calls.confidence[eng.calls.confidence.length - 1];
        const ce = S.checkShape('EvidenceVector', ev);
        assert(ce.ok, 'EvidenceVector shape: ' + JSON.stringify(ce.errors.slice(0, 5)));
      }
      // Decline mode or no fit and no straight line → hidden.
      w.PRiSM.mode = 'decline';
      assert.strictEqual(SC.PANEL.when(), false, 'hidden in decline mode');
      w.PRiSM.mode = 'transient';
      const keepFit = w.PRiSM_state.lastFit, keepSl = w.PRiSM_state.semilog;
      w.PRiSM_state.lastFit = null; w.PRiSM_state.semilog = null;
      assert.strictEqual(SC.PANEL.when(), false, 'hidden without a fit or a straight line');
      w.PRiSM_state.lastFit = keepFit; w.PRiSM_state.semilog = keepSl;
      // Without well inputs the card says what is missing (still no writes).
      const m2 = SC.run({ well: app.toWin({ q: 850, B: 1.25, mu: 1.1, ct: 1.2e-5, h: null, phi: 0.18, rw: 0.354 }) });
      assert.strictEqual(m2.ok, false);
      assert.includes(m2.reason, 'h');
      assert.strictEqual(storageSnapshot(app), before);
    },
  },
  {
    name: 'SK5b drawdown from pi: passed as a build-up after a long producing time, labelled indicative, no p*',
    wp: WP,
    run(app, assert) {
      const w = app.win;
      app.openPRiSM();
      app.seedSample();
      w.PRiSM_setWell(app.toWin(w.PRiSM_DEFAULT_SAMPLE_META), app.toWin({ source: 'sample' }));
      w.PRiSM_state.model = 'homogeneous';
      w.PRiSM_setLastFit(app.toWin(MATCH));
      app.flushUntilIdle(10000);
      const eng = engine(app);
      const ad = w.PRiSM_getAnalysisData();
      assert.strictEqual(ad.testType, 'drawdown');
      const sp = w.PRiSM_skinCheck.specFromAdata(ad, w.PRiSM_getWell());
      assert.strictEqual(sp.ok, true, sp.reason);
      assert.strictEqual(sp.indicative, true);
      assert.strictEqual(sp.spec.testType, 'buildup');
      assert.near(sp.spec.pwf0, 4200, 1e-9, 'reference = pi');
      assert(sp.spec.steps[0].t <= ad.tStart - 1e5, 'very long producing time');
      // Δp of the mirrored record equals the drawdown Δp (pi − p), increasing.
      const j = Math.floor(ad.n / 2);
      const k = sp.spec.dt.findIndex((x) => Math.abs(x - ad.t[j]) < 1e-12);
      assert.near(sp.spec.p[k] - sp.spec.pwf0, ad.dp[j], 1e-6);
      const S = require('./_buildup-shapes');
      const chk = S.checkShape('BuildupSpec', sp.spec);
      assert(chk.ok, 'BuildupSpec shape: ' + JSON.stringify(chk.errors.slice(0, 5)));
      const m = w.PRiSM_skinCheck.run();
      assert.strictEqual(m.ok, true, m.reason);
      assert.strictEqual(m.indicative, true);
      assert(m.warnings.some((x) => x.code === 'indicative'));
      if (m.line) assert.strictEqual(m.line.pStar, null, 'no p* for a drawdown');
      assert(m.notes.indexOf('Calibrated on build-ups; indicative for drawdowns.') !== -1);
      if (eng.stubbed) assert.strictEqual(eng.calls.specs[eng.calls.specs.length - 1].testType, 'buildup');
    },
  },
  {
    name: 'SK6 the PRiSM report contains the "Skin check" section (order 45, plain text)',
    wp: WP,
    run(app, assert) {
      const w = setupPRiSM(app);
      engine(app);
      const sec = w.PRiSM_skinCheck.reportSection({});
      assert(sec, 'section produced');
      assert.strictEqual(sec.id, 'skincheck');
      assert.strictEqual(sec.title, 'Skin check');
      assert.strictEqual(sec.order, 45);
      const labels = sec.kv.map((p) => p[0]);
      ['IARF window (L = 0.1 cycle)', 'Line vs match', 'Line vs derivative plateau (sanity check)', 'Skin uncertainty S_err', 'Confidence',
       'Δp skin', 'PI ratio', 'Mechanical skin', 'Expected IARF reach'].forEach((l) => assert(labels.indexOf(l) !== -1, 'kv ' + l));
      assert(sec.notes.some((n) => /indicative for drawdowns/.test(n)));
      textsOk(assert, plain(sec), 'section');
      sec.kv.forEach((p) => assert(p[1].length < 300));
      // Through 36-report: the model's extra sections and the PDF HTML.
      const m = w.PRiSM_reportData();
      const x = m.extra.find((s) => s.id === 'skincheck');
      assert(x && x.title === 'Skin check', 'in PRiSM_reportData().extra');
      const html = w.PRiSM_buildReportHTML({ model: m });
      assert.includes(html, 'Skin check');
      assert.includes(html, 'Line vs match');
      // No fit and no straight line → no section.
      w.PRiSM_state.lastFit = null; w.PRiSM_state.semilog = null;
      assert.strictEqual(w.PRiSM_skinCheck.reportSection({}), null);
    },
  },
  {
    name: 'SK7 "Use this window" stores the semilog window (a user action)',
    wp: WP,
    run(app, assert) {
      const w = setupPRiSM(app);
      engine(app);
      const host = mountHost(app);
      w.PRiSM_skinCheck.renderPanel(host);
      const iw = w.PRiSM_skinCheck._ui.model.iarf;
      assert(iw && iw.found, 'an IARF window on the reference build-up');
      const log = recordEvents(app);
      app.click('prism_skc_usewin');
      app.flushUntilIdle(5000);
      const sl = w.PRiSM_state.semilog;
      assert(sl && sl.ok, 'semilog stored: ' + (sl && sl.reason));
      assert(sl.opts && sl.opts.window, 'a manual window, not the automatic one');
      assert(sl.window.t0 >= iw.dt0_h - 1e-9 && sl.window.t1 <= iw.dt1_h + 1e-9, 'window inside the IARF window');
      assert(sl.window.t1 / sl.window.t0 > Math.pow(10, 0.8 * (Math.log10(iw.dt1_h / iw.dt0_h))), 'window spans the IARF window');
      assert(log.some((e) => e.type === 'prism:fit-updated' && e.source === 'semilog'), 'the C7 event of the user action');
      // The card re-rendered on the event and is still mounted.
      assert(app.el('prism_skc_root'), 'card still mounted');
    },
  },
  {
    name: 'SK8 "Run C-held refits" runs through drive, can be cancelled, and leaves no timers',
    wp: WP,
    async run(app, assert) {
      const w = setupPRiSM(app);
      const eng = engine(app);
      const host = mountHost(app);
      w.PRiSM_skinCheck.renderPanel(host);
      assert.strictEqual(w.PRiSM_skinCheck._ui.model.cheldAvailable, true);
      const before = storageSnapshot(app);
      app.click('prism_skc_cheld');
      assert.strictEqual(w.PRiSM_skinCheck._ui.running, true, 'running');
      if (eng.stubbed) assert(app.pendingTimers() > 0, 'yields through setTimeout(0) (drive)');
      for (let i = 0; i < 2000 && (app.pendingTimers() > 0 || w.PRiSM_skinCheck._ui.running); i++) await app.flushAsync(0);
      assert.strictEqual(w.PRiSM_skinCheck._ui.running, false, 'finished');
      assert.strictEqual(app.pendingTimers(), 0, 'no timers left');
      const ch = w.PRiSM_skinCheck._ui.model.cheld;
      assert(ch && ch.range && Array.isArray(ch.refits), 'C-held result on the card');
      // Refits when triggered (missed unit slope); otherwise the card says they are not needed.
      assert.includes(app.el('prism_skc_root').innerHTML, (ch.triggered || ch.refits.length) ? 'S_C (half range)' : 'not needed');
      assert.includes(app.el('prism_skc_cheld_status').textContent, 'finished');
      if (eng.stubbed) {
        assert(eng.calls.drive >= 1, 'through PRiSM_autoInterp.drive');
        const parts = eng.calls.sErr[eng.calls.sErr.length - 1];
        assert.near(parts.sC, 0.2, 1e-12, 'S_C feeds S_err (ext)');
      }
      assert.strictEqual(storageSnapshot(app), before, 'C-held writes no storage');
      // Cancel.
      app.click('prism_skc_cheld');
      assert.strictEqual(w.PRiSM_skinCheck._ui.running, true);
      app.click('prism_skc_cheld_cancel');
      for (let i = 0; i < 2000 && (app.pendingTimers() > 0 || w.PRiSM_skinCheck._ui.running); i++) await app.flushAsync(0);
      assert.strictEqual(w.PRiSM_skinCheck._ui.running, false);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers after cancel');
      assert.includes(app.el('prism_skc_cheld_status').textContent, 'Cancelled');
      // Unmounting cancels a running job too.
      app.click('prism_skc_cheld');
      host.innerHTML = '';
      for (let i = 0; i < 2000 && (app.pendingTimers() > 0 || w.PRiSM_skinCheck._ui.running); i++) await app.flushAsync(0);
      assert.strictEqual(w.PRiSM_skinCheck._ui.running, false, 'cancelled when the card is gone');
      assert.strictEqual(app.pendingTimers(), 0);
    },
  },
  {
    name: 'SK9 rate status n/a (no KC4 cap), numeric reach shown, PI ratio labelled lower bound (r_e from r_inv)',
    wp: WP,
    run(app, assert) {
      const w = setupPRiSM(app);
      const eng = engine(app);
      const host = mountHost(app);
      w.PRiSM_skinCheck.renderPanel(host);
      const m = w.PRiSM_skinCheck._ui.model;
      assert.strictEqual(m.rate.status, 'n/a');
      assert.strictEqual(m.evidence.r3Status, 'n/a');
      assert.strictEqual(m.evidence.r4Status, 'n/a');
      assert(m.evidence.rateSource === 'measured' || m.evidence.rateSource === 'table');
      assert.strictEqual(m.evidence.equalRateAssumed, false);
      assert(!(m.confidence.reasons || []).some((r) => r.rule === 'KC4'), 'no KC4 cap');
      // The reach is the numeric one from PRiSM_autoInterp.reach (not the Appendix A.1 correlation).
      assert(m.reach && Number.isFinite(m.reach.fair_h));
      const html = app.el('prism_skc_reach').innerHTML;
      assert.includes(html, String(+m.reach.fair_h.toPrecision(3)) + ' h');
      if (eng.stubbed) {
        const R = require('./_buildup-shapes').FIX.result;
        assert.near(m.reach.fair_h, R.reach.fair_h, 1e-9, 'shown reach = PRiSM_autoInterp.reach');
      }
      // Products with r_e from r_inv: labelled lower / upper bound.
      assert.strictEqual(m.products.reSource, 'rinv');
      assert.strictEqual(m.products.piRatioLowerBound, true);
      assert.strictEqual(m.products.rateAtStakeUpperBound, true);
      assert.includes(app.el('prism_skc_prod').innerHTML, 'lower bound');
      // Completion inputs: saved on change (user action), mechanical skin re-split, perforation inputs hidden while unverified.
      assert.strictEqual(app.el('prism_skc_perf_on'), null, 'perforation inputs hidden while the table is unverified');
      app.check('prism_skc_cmp_on', true);
      app.change('prism_skc_hp', '15');
      app.flushUntilIdle(2000);
      const saved = JSON.parse(app.storage.getItem('wts_prism_skincheck'));
      assert.strictEqual(saved.completion.on, true);
      assert.strictEqual(saved.completion.hp_ft, 15);
      const mech = w.PRiSM_skinCheck._ui.model.mech;
      assert.strictEqual(mech.available, true);
      assert(mech.parts.pp > 0, 'partial penetration split');
      assert.includes(app.el('prism_skc_mech_res').innerHTML, 'S_mech (pressure-drop basis)');
      assert.includes(app.el('prism_skc_mech_res').innerHTML, 'S_d local');
    },
  },
];
