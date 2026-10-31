// Build-up Surveillance — WP2 data-layer tests (docs/BUILDUP-SURVEILLANCE-PLAN.md §3.6, §4.1–§4.5, §9 WP2):
//   DA1 noise (σ from second differences, quantisation, σ_flow vs σ_shut)   DA9  allocation consistency (R3, clean days)
//   DA2 detection at 10 min / 1 min / 1 s, short and partial events           DA10 zones (IANA days, device zone, offset scan)
//   DA3 slow rise (multi-scale rule)                                          DA11 parser (chunked = one-shot, rate column, psig)
//   DA4 end of the build-up (hump vs reopen)                                  DA12 history start, table mode, zero-rate periods
//   DA5 closing time, pwf0, ramp, pwf0SE                                      DA13 injector fall-offs
//   DA6 partial cuts (f̂ by late Δp differences; 0.9–0.95 interpreted)         DA14 two events in one day
//   DA7 stimulation without a workover date stays a shut-in                   DA15 interventions
//   DA8 rate spreading over the flowing hours, short closing day              DA16 phase basis (water cut, condensate)
//
// Synthetic records come from the small analytic generator below (homogeneous reservoir with wellbore storage and skin,
// superposed over the rate steps), not from WP4's generator. Every test checks the §3 shapes of what it produces.
'use strict';

const S = require('./_buildup-shapes');

const WP = 'BU2';
const HOUR = 3600000, DAY = 86400000, MIN = 60000;
const J = (x) => JSON.parse(JSON.stringify(x));
const T0 = Date.UTC(2026, 2, 1);

// ── analytic generator ────────────────────────────────────────────────────────────────────────────────────────────
function rng(seed) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, normal() { const u = Math.max(1e-12, next()), v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); } };
}
const W0 = { k: 45, h: 50, phi: 0.2, mu: 1, B: 1.2, ct: 1e-5, rw: 0.354, C: 0.02, S: 2, q: 800, pInit: 4000 };
// unit-rate drawdown g(t) = blend(m1·(log10 t + logTerm + 0.8686·S), B·t/(24·C)) — linear in the rate, so superposable
function unitResponse(w) {
  const m1 = 162.6 * w.B * w.mu / (w.k * w.h);
  const logTerm = Math.log10(w.k / (w.phi * w.mu * w.ct * w.rw * w.rw)) - 3.2275;
  return (t, S) => {
    if (!(t > 0)) return 0;
    const a = m1 * (Math.log10(t) + logTerm + 0.8686 * S), b = w.B * t / (24 * w.C);
    return a > 0 ? a * (1 - Math.exp(-b / a)) : b;
  };
}
// rate steps: production from open_ms at q; each event cuts f·q at t_ms (a linear ramp in 10 sub-steps when ramp_s) and
// restores it after dur_h (skin Safter from then on)
function rateSteps(o, w) {
  let S = w.S;
  const out = [{ t: o.open_ms, dq: w.q, S }];
  (o.events || []).slice().sort((a, b) => a.t_ms - b.t_ms).forEach((e) => {
    const f = e.f == null ? 1 : e.f, q = w.q;
    if (e.ramp_s) for (let i = 0; i < 10; i++) out.push({ t: e.t_ms + (i + 0.5) * e.ramp_s * 100, dq: -f * q / 10, S });
    else out.push({ t: e.t_ms, dq: -f * q, S });
    if (e.Safter != null) S = e.Safter;
    if (e.dur_h != null) out.push({ t: e.t_ms + e.dur_h * HOUR, dq: f * q, S });
  });
  return out.sort((a, b) => a.t - b.t);
}
// o {start_ms, days|end_ms, sample_s, open_ms, events, well, sigma, sigmaFlow, drift_psi_d, deplete_psi_d, seed, quant, spikes,
//    spikeSize, sign (−1 injector), humps:[{t_ms, at_h, dp, width_h}]}
function makeRecord(o) {
  const w = Object.assign({}, W0, o.well || {}), g = unitResponse(w), sign = o.sign || 1, r = rng(o.seed || 1);
  const st = rateSteps(Object.assign({ open_ms: o.open_ms != null ? o.open_ms : o.start_ms - 720 * HOUR }, o), w);
  const t0 = o.start_ms, t1 = o.end_ms || (t0 + o.days * DAY), dt = Math.round(o.sample_s * 1000), n = Math.floor((t1 - t0) / dt) + 1;
  const t = new Float64Array(n), p = new Float64Array(n);
  const exact = (ms) => {
    let s = 0;
    for (let j = 0; j < st.length && st[j].t < ms; j++) s += st[j].dq * g((ms - st[j].t) / HOUR, st[j].S);
    let v = w.pInit - (o.deplete_psi_d || 0) * (ms - t0) / DAY - sign * s;
    (o.humps || []).forEach((h) => { const d = (ms - h.t_ms) / HOUR; if (d > 0) v += sign * h.dp * Math.exp(-Math.pow((d - h.at_h) / h.width_h, 2)); });
    return v;
  };
  const coarse = 30000, cache = new Map();
  const grid = (ms) => { let v = cache.get(ms); if (v === undefined) { v = exact(ms); cache.set(ms, v); } return v; };
  let js = 0, qNow = 0;
  for (let i = 0; i < n; i++) {
    const ms = t0 + i * dt;
    t[i] = ms;
    while (js < st.length && st[js].t <= ms) { qNow += st[js].dq; js++; }
    const last = js > 0 ? st[js - 1] : null;
    let v;
    if (dt >= coarse || (last && ms - last.t < HOUR) || (o.humps && o.humps.length)) v = exact(ms);
    else { const a = Math.floor(ms / coarse) * coarse; v = grid(a) + (grid(a + coarse) - grid(a)) * (ms - a) / coarse; }
    const sg = qNow > 1e-9 ? (o.sigmaFlow != null ? o.sigmaFlow : (o.sigma || 0)) : (o.sigma || 0);
    if (sg) v += sg * r.normal();
    v += (o.drift_psi_d || 0) * (ms - t0) / DAY;
    if (o.quant) v = Math.round(v / o.quant) * o.quant;
    p[i] = v;
  }
  if (o.spikes) for (let k = 0; k < o.spikes; k++) { const i = 20 + Math.floor(r.next() * (n - 40)); p[i] += (r.next() < 0.5 ? -1 : 1) * (o.spikeSize || 5); }
  return { t, p, exact, steps: st, w };
}
// daily allocation (days starting at startHour UTC): q flowing, (1 − f)·q in a cut, 0 shut. errFn(date) scales the volume.
function allocRows(o) {
  const w = Object.assign({}, W0, o.well || {}), evs = o.events || [], sh = (o.startHour || 0) * HOUR;
  const s0 = new Date(o.start_ms), end = o.end_ms || (o.start_ms + o.days * DAY);
  const rows = [];
  for (let a = Date.UTC(s0.getUTCFullYear(), s0.getUTCMonth(), s0.getUTCDate()) + sh; a < end; a += DAY) {
    const b = a + DAY, cuts = [a, b];
    let V = 0, hOn = 0;
    evs.forEach((e) => { [e.t_ms, e.t_ms + e.dur_h * HOUR].forEach((x) => { if (x > a && x < b) cuts.push(x); }); });
    cuts.sort((x, y) => x - y);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const mid = 0.5 * (cuts[i] + cuts[i + 1]);
      let fr = 1;
      evs.forEach((e) => { if (mid >= e.t_ms && mid < e.t_ms + e.dur_h * HOUR) fr = 1 - (e.f == null ? 1 : e.f); });
      const hh = (cuts[i + 1] - cuts[i]) / HOUR;
      V += w.q * fr * hh / 24; if (fr > 0) hOn += hh;
    }
    const date = new Date(a).toISOString().slice(0, 10);
    const err = o.errFn ? o.errFn(date) : 1, wc = o.wcFn ? o.wcFn(date) : 0;
    rows.push({ date, oil: Math.round(V * err * (1 - wc) * 10) / 10, gas: Math.round(V * err * (1 - wc) * (o.gor || 400)) / 1000, water: Math.round(V * err * wc * 10) / 10, hours: Math.round(hOn * 100) / 100 });
  }
  return rows;
}
function record(D, rec, extra) {
  return Object.assign({ ok: true, origin_ms: rec.t[0], t: rec.t, p: rec.p, T: null, n: rec.t.length, source: 'csv', name: 'synthetic', zone: { mode: 'utc' },
    pUnitIn: 'psia', patm: 14.696, elapsed: false, rollup: false, hash: D.recordHash(rec.t, rec.p), warnings: [] }, extra || {});
}
const UTC_DAY = { zone: { mode: 'utc' }, startHour: 0 };
function scan(D, rec, rows, o) {
  o = o || {};
  return D.scan(rec, Object.assign({
    allocation: rows ? { rows, resolution: { oil: 0.1, gas: 0.1, water: 0.1 } } : null, zones: { day: o.day || UTC_DAY },
    settings: { detect: o.detect || {} }, history: o.history || { mode: 'unknown' }, well: Object.assign({ fluid: 'oil', B: 1.2, Bw: 1.02 }, o.well || {}),
  }, o.extra || {}));
}
function ev(id, tc, dur_h, extra) {
  return Object.assign({ id, kind: 'shutin', status: 'analysable', tc_ms: tc, tEnd_ms: tc + dur_h * HOUR, dtEnd_h: dur_h, fhat: 1, fhatMethod: 'allocation',
    ramp: { present: false, dur_s: 0 }, alloc: { date: new Date(tc).toISOString().slice(0, 10), ratio: null, pass: null, ignoresShutin: false, confirm: 'confirmed' }, warnings: [] }, extra || {});
}
function shapeOk(assert, name, obj, what) {
  const r = S.checkShape(name, J(obj));
  assert.ok(r.ok, (what || name) + ' shape: ' + JSON.stringify(r.errors.slice(0, 6)));
}
function rateAt(rh, ms) { let q = 0; for (const s of rh.steps) { if (s.t_ms <= ms) q = s.q; else break; } return q; }
const codes = (ws) => Array.from(ws || []).map((w) => w.code);
const Dof = (app) => app.win.WTS_buildup.data;

// The 30-day schedule of DA2 (6 analysable shut-ins, a short one and a 40 % partial cut lasting a full day)
const SCHED = [
  { t_ms: T0 + 3 * DAY + 9 * HOUR, dur_h: 30 }, { t_ms: T0 + 7 * DAY + 14 * HOUR, dur_h: 48 }, { t_ms: T0 + 11 * DAY + 8 * HOUR, dur_h: 1.5 },
  { t_ms: T0 + 14 * DAY + 10 * HOUR, dur_h: 36 }, { t_ms: T0 + 18 * DAY, dur_h: 30, f: 0.4 }, { t_ms: T0 + 21 * DAY + 15 * HOUR, dur_h: 24 },
  { t_ms: T0 + 25 * DAY + 11 * HOUR, dur_h: 40 }, { t_ms: T0 + 28 * DAY + 6 * HOUR, dur_h: 20 },
];

module.exports = [
  {
    name: 'DA1 noise: σ within ±10 % with a trend and spikes; quantised record → resolution-limited 0.0029 psi; slugging → σ_flow ≈ 10·σ_shut',
    wp: WP,
    run(app, assert) {
      const D = Dof(app), r = rng(11), n = 8640;
      // (a) 10 s sampling, σ 0.05 psi, a 1 psi/h trend and 30 spikes of 5 psi
      const t = new Float64Array(n), p = new Float64Array(n);
      for (let i = 0; i < n; i++) { t[i] = T0 + i * 10000; p[i] = 3000 + i * 10 / 3600 + 0.05 * r.normal(); }
      for (let k = 0; k < 30; k++) p[50 + k * 270] += 5;
      const q1 = D.qc(record(D, { t, p }), {});
      shapeOk(assert, 'QC', q1);
      assert.within(q1.sigma_psi, 0.045, 0.055, 'σ (true 0.05 psi)');
      assert.strictEqual(q1.resolutionLimited, false);
      assert.near(q1.dtMed_s, 10, 1e-9, 'Δt_med');
      // spikes are flagged in 'flag' mode (runs ≤ 2), and only there
      const q1f = D.qc(record(D, { t, p }), { spike: 'flag' });
      assert.within(q1f.spikes.count, 28, 32, 'spikes flagged'); assert.strictEqual(q1.spikes.count, 0, 'spike filter off by default');
      // (b) quantised: 0.01 psi resolution, σ 0.0005 psi, slow trend
      const tq = new Float64Array(n), pq = new Float64Array(n);
      for (let i = 0; i < n; i++) { tq[i] = T0 + i * 10000; pq[i] = Math.round((3000 + i * 10 / 3600 * 0.2 + 0.0005 * r.normal()) * 100) / 100; }
      const q2 = D.qc(record(D, { t: tq, p: pq }), {});
      assert.strictEqual(q2.resolutionLimited, true, 'resolution-limited');
      assert.near(q2.resolution_psi, 0.01, 1e-9, 'resolution 0.01 psi');
      assert.near(q2.sigma_psi, 0.0029, 0.00005, 'σ = Δq/√12 = 0.0029 psi');
      assert.ok(codes(q2.plausibility).includes('RESOLUTION_LIMITED'));
      // (c) slugging while flowing at 10× the shut-in noise; σ_shut is unaffected
      const evs = [{ t_ms: T0 + 2 * DAY + 9 * HOUR, dur_h: 48 }];
      const rec = record(D, makeRecord({ start_ms: T0, days: 6, sample_s: 60, events: evs, sigma: 0.05, sigmaFlow: 0.5, seed: 3 }));
      const q0 = D.qc(rec, {}), det = D.detect(rec, q0, {});
      assert.strictEqual(det.events.length, 1, 'one shut-in found under slugging');
      const q3 = D.qc(rec, { events: det.events });
      assert.within(q3.sigmaShut_psi, 0.0425, 0.0575, 'σ_shut (true 0.05)');
      assert.within(q3.sigmaFlow_psi / q3.sigmaShut_psi, 8.5, 11.5, 'σ_flow ≈ 10·σ_shut');
      assert.ok(q3.segments.some((s) => s.kind === 'shut') && q3.segments.some((s) => s.kind === 'flow'), 'flow and shut segments');
    },
  },
  {
    name: 'DA2 detection: 30 days, 6 shut-ins + 1 short + 1 partial (40 %) at 10 min and 1 min (1 s on a 10-day record): all found and classified; no event in 1,000 h of noise and drift',
    wp: WP,
    run(app, assert) {
      const D = Dof(app);
      const rows = allocRows({ start_ms: T0, days: 30, events: SCHED });
      const expect = ['analysable', 'analysable', 'too_short', 'analysable', 'partial', 'analysable', 'analysable', 'analysable'];
      [600, 60].forEach((ss) => {
        const rec = record(D, makeRecord({ start_ms: T0, days: 30, sample_s: ss, events: SCHED, sigma: 0.02, sigmaFlow: 0.05, seed: 7 }));
        const res = scan(D, rec, rows);
        assert.ok(res.ok, 'scan ok at ' + ss + ' s');
        assert.strictEqual(res.events.length, 8, ss + ' s: 8 events');
        assert.deepStrictEqual(J(res.events.map((e) => e.status)), expect, ss + ' s statuses');
        res.events.forEach((e, i) => {
          shapeOk(assert, 'Event', e, ss + ' s ' + e.id);
          assert.ok(Math.abs(e.tc_ms - SCHED[i].t_ms) <= ss * 1000, ss + ' s ' + e.id + ' closing within one sample');
          if (SCHED[i].dur_h > 2) assert.near(e.dtEnd_h, SCHED[i].dur_h, 2 * Math.max(5 * MIN, 3 * ss * 1000) / HOUR, ss + ' s ' + e.id + ' duration');
        });
        assert.strictEqual(res.events[4].kind, 'partial');
        assert.within(res.events[4].fhat, 0.32, 0.48, ss + ' s partial rate fraction');
        assert.deepStrictEqual(J(res.missed.tooShort), ['E3']);
        shapeOk(assert, 'Missed', res.missed); shapeOk(assert, 'QC', res.qc); shapeOk(assert, 'RateHistory', res.rates);
      });
      // 1 s sampling on the first 10 days (2 shut-ins and the short one)
      const s10 = SCHED.slice(0, 3);
      const rec1 = record(D, makeRecord({ start_ms: T0, days: 13, sample_s: 1, events: s10, sigma: 0.02, sigmaFlow: 0.05, seed: 8 }));
      const r1 = scan(D, rec1, allocRows({ start_ms: T0, days: 13, events: s10 }));
      assert.deepStrictEqual(J(r1.events.map((e) => e.status)), ['analysable', 'analysable', 'too_short'], '1 s statuses');
      r1.events.forEach((e, i) => assert.ok(Math.abs(e.tc_ms - s10[i].t_ms) <= 2000, '1 s closing time ' + e.id));
      // 1,000 h of noise plus drift: nothing found
      const quiet = record(D, makeRecord({ start_ms: T0, end_ms: T0 + 1000 * HOUR, sample_s: 60, events: [], sigma: 0.05, sigmaFlow: 0.05, drift_psi_d: 0.01, seed: 9 }));
      const qq = D.qc(quiet, {});
      assert.strictEqual(D.detect(quiet, qq, {}).events.length, 0, 'no event in noise and drift');
    },
  },
  {
    name: 'DA3 slow rise: q = 100 STB/d, C = 0.2 bbl/psi at 1 min sampling is detected through the multi-scale rule',
    wp: WP,
    run(app, assert) {
      const D = Dof(app);
      const evs = [{ t_ms: T0 + 2 * DAY + 10 * HOUR, dur_h: 24 }];
      const rec = record(D, makeRecord({ start_ms: T0, days: 5, sample_s: 60, events: evs, well: { q: 100, C: 0.2 }, sigma: 0.02, seed: 4 }));
      const q = D.qc(rec, {}), det = D.detect(rec, q, {});
      assert.strictEqual(det.events.length, 1, 'found');
      const e = det.events[0];
      assert.strictEqual(e.status, 'analysable');
      assert.ok(e.riseScale_min >= 10, 'rise needed more than one 5-min window (riseScale ' + e.riseScale_min + ' min)');
      assert.ok(Math.abs(e.tc_ms - evs[0].t_ms) <= 2 * MIN, 'closing time');
    },
  },
  {
    name: 'DA4 end persistence: a 20 psi hump at 0.3 h does not end the build-up; a real reopen does, within one window',
    wp: WP,
    run(app, assert) {
      const D = Dof(app);
      const evs = [{ t_ms: T0 + 2 * DAY + 9 * HOUR, dur_h: 24 }];
      const hump = [{ t_ms: evs[0].t_ms, at_h: 0.3, dp: 20, width_h: 0.08 }];
      const rec = record(D, makeRecord({ start_ms: T0, days: 5, sample_s: 60, events: evs, humps: hump, sigma: 0.02, seed: 5 }));
      const q = D.qc(rec, {}), det = D.detect(rec, q, {});
      assert.strictEqual(det.events.length, 1, 'one build-up (the hump does not split it)');
      const e = det.events[0];
      assert.strictEqual(e.endReason, 'reopen');
      assert.ok(Math.abs(e.tEnd_ms - (evs[0].t_ms + 24 * HOUR)) <= 5 * MIN, 'ends at the real reopen within one 5-min window (' + ((e.tEnd_ms - evs[0].t_ms) / HOUR) + ' h)');
    },
  },
  {
    name: 'DA5 closing time ≤ 0.2·Δt_med with samples in storage; pwf0 within max(2σ, 0.05 psi); a ramp is detected; pwf0SE grows with slugging and with 3 samples at 600 s',
    wp: WP,
    run(app, assert) {
      const D = Dof(app);
      const tcTrue = T0 + 2 * DAY + 9 * HOUR + 23000;
      const base = { start_ms: T0, days: 4, sample_s: 60, events: [{ t_ms: tcTrue, dur_h: 24 }], well: { C: 0.2 }, sigma: 0.01, sigmaFlow: 0.01, seed: 6 };
      const g = makeRecord(base), rec = record(D, g);
      const q = D.qc(rec, {}), e = D.detect(rec, q, {}).events[0];
      assert.ok(Math.abs(e.tc_ms - tcTrue) <= 12000, 'closing time error ' + (e.tc_ms - tcTrue) / 1000 + ' s ≤ 0.2·60 s');
      assert.ok(Math.abs(e.pwf0 - g.exact(tcTrue)) <= Math.max(2 * 0.01, 0.05), 'pwf0 ' + e.pwf0 + ' vs ' + g.exact(tcTrue));
      assert.strictEqual(e.ramp.present, false);
      // closing ramp over 10 min
      const gr = makeRecord(Object.assign({}, base, { events: [{ t_ms: tcTrue, dur_h: 24, ramp_s: 600 }] }));
      const er = D.detect(record(D, gr), D.qc(record(D, gr), {}), {}).events[0];
      assert.strictEqual(er.ramp.present, true, 'ramp detected');
      assert.within(er.ramp.dur_s, 300, 900, 'ramp duration');
      // pwf0SE grows with slugging …
      const gs = makeRecord(Object.assign({}, base, { sigmaFlow: 0.5 }));
      const es = D.detect(record(D, gs), D.qc(record(D, gs), {}), {}).events[0];
      assert.ok(es.pwf0SE > 5 * e.pwf0SE, 'pwf0SE with slugging ' + es.pwf0SE + ' > ' + e.pwf0SE);
      // … and with only 3 flowing samples at 600 s (the previous build-up reopened 30 min before)
      const t2 = T0 + 3 * DAY + 9 * HOUR;
      const g3 = makeRecord({ start_ms: T0, days: 5, sample_s: 600, events: [{ t_ms: T0 + 2 * DAY + 8.5 * HOUR, dur_h: 24 }, { t_ms: t2, dur_h: 24 }], sigma: 0.01, sigmaFlow: 0.05, seed: 6 });
      const r3 = record(D, g3), d3 = D.detect(r3, D.qc(r3, {}), {});
      const e3 = d3.events[d3.events.length - 1];
      assert.ok(e3.trend.n <= 4, 'short trend (' + e3.trend.n + ' samples)');
      assert.ok(codes(e3.warnings).includes('TREND_SHORT'), 'D3 flagged');
      const g4 = makeRecord({ start_ms: T0, days: 5, sample_s: 60, events: [{ t_ms: t2, dur_h: 24 }], sigma: 0.01, sigmaFlow: 0.05, seed: 6 });
      const e4 = D.detect(record(D, g4), D.qc(record(D, g4), {}), {}).events[0];
      assert.ok(e3.pwf0SE > 1.3 * e4.pwf0SE, 'pwf0SE with 3 samples ' + e3.pwf0SE + ' > ' + e4.pwf0SE);
    },
  },
  {
    name: 'DA6 partial: a 40 % cut gives f̂ 0.32–0.48 by late Δp differences with the volume preserved; a 92 % cut gives f̂ in [0.9, 0.95) → interpreted with fRate',
    wp: WP,
    run(app, assert) {
      const D = Dof(app), R = app.win.WTS_buildup.run;
      [[0.4, 'partial'], [0.92, 'shutin']].forEach(([f, kind]) => {
        const evs = [{ t_ms: T0 + 3 * DAY + 9 * HOUR, dur_h: 36 }, { t_ms: T0 + 9 * DAY + 12 * HOUR, dur_h: 40, f }];
        const rows = allocRows({ start_ms: T0, days: 14, events: evs });
        const rec = record(D, makeRecord({ start_ms: T0, days: 14, sample_s: 60, events: evs, sigma: 0.02, sigmaFlow: 0.05, seed: 12 }));
        const res = scan(D, rec, rows);
        const e = res.events[1];
        assert.strictEqual(e.fhatMethod, 'dpDiff', f + ': gate by late Δp differences');
        assert.strictEqual(e.kind, kind, f + ': kind');
        if (f < 0.9) {
          assert.within(e.fhat, 0.32, 0.48, '40 % cut f̂');
          assert.strictEqual(e.status, 'partial');
          assert.near(e.qAfter / e.qBefore, 1 - e.fhat, 1e-9, 'q_after = (1 − f̂)·q_before');
          // volume preserved on every day of the cut
          res.rates.days.filter((d) => d.events.indexOf(e.id) >= 0).forEach((d) => {
            let V = 0;
            const st = res.rates.steps;
            for (let i = 0; i < st.length; i++) {
              const a = Math.max(st[i].t_ms, d.t0_ms), b = Math.min(i + 1 < st.length ? st[i + 1].t_ms : d.t1_ms, d.t1_ms);
              if (b > a) V += st[i].q * (b - a) / DAY;
            }
            assert.rel(V, d.V, 1e-6, 'volume preserved on ' + d.date);
          });
        } else {
          assert.within(e.fhat, 0.9, 0.95 - 1e-12, '92 % cut f̂');
          assert.strictEqual(e.status, 'analysable');
          assert.ok(codes(e.warnings).includes('RATE_FRACTION'), 'rate-fraction warning (KC6 basis)');
          const spec = R.specFor(e, res.record, res.rates, { well: { fluid: 'oil', h: 50, phi: 0.2, mu: 1, B: 1.2, ct: 1e-5, rw: 0.354, allocAccPct: 5, driftPsiPerDay: 0.01, defaulted: [] }, settings: {} }, { id: 'B2', qc: res.qc });
          assert.near(spec.fRate, e.fhat, 1e-12, 'spec.fRate = f̂');
          assert.rel(spec.Dq, e.fhat * res.rates.byEvent[e.id].Dq, 1e-12, 'Δq·f̂');
          assert.rel(res.rates.byEvent[e.id].Dq, 800, 0.005, 'the residual (1 − f̂)·q keeps its volume, so Δq is the flowing rate');
          shapeOk(assert, 'BuildupSpec', spec);
        }
      });
    },
  },
  {
    name: 'DA7 stimulation without an entered workover date (S 8 → 0 between the reference and the event): f̂ ≥ 0.95 → shut-in',
    wp: WP,
    run(app, assert) {
      const D = Dof(app);
      const evs = [{ t_ms: T0 + 3 * DAY + 9 * HOUR, dur_h: 36, Safter: 0 }, { t_ms: T0 + 9 * DAY + 13 * HOUR, dur_h: 30 }];
      const rec = record(D, makeRecord({ start_ms: T0, days: 12, sample_s: 60, events: evs, well: { S: 8 }, sigma: 0.02, sigmaFlow: 0.05, seed: 13 }));
      // the allocation confirms the reference (S = 8); the event's days have no allocation rows, so the gate decides from the pressure
      const rows = allocRows({ start_ms: T0, days: 12, events: evs }).filter((r) => r.date < '2026-03-10' || r.date > '2026-03-11');
      const res = scan(D, rec, rows);
      assert.strictEqual(res.events.length, 2);
      assert.strictEqual(res.events[0].alloc.confirm, 'confirmed');
      const e = res.events[1];
      assert.strictEqual(e.fhatMethod, 'dpDiff');
      assert.ok(e.fhat >= 0.95, 'f̂ ' + e.fhat + ' ≥ 0.95 (skin cancels in the late differences)');
      assert.strictEqual(e.kind, 'shutin'); assert.strictEqual(e.status, 'analysable');
    },
  },
  {
    name: 'DA8 spreading: a 15:00 shut-in day reads 24·V/15 (V/24 is 37.5 % low); volume on a shut day → R2; a 00:30 closing → Δq from the previous day (R1)',
    wp: WP,
    run(app, assert) {
      const D = Dof(app);
      const d5 = T0 + 5 * DAY, rows = allocRows({ start_ms: T0, days: 14, events: [{ t_ms: d5 + 15 * HOUR, dur_h: 30 }] });
      const rh = D.rates(null, [ev('E1', d5 + 15 * HOUR, 30)], rows, { fluid: 'oil', day: UTC_DAY, history: { mode: 'unknown' } });
      shapeOk(assert, 'RateHistory', rh);
      const day = rh.days.find((d) => d.date === '2026-03-06');
      assert.near(day.hOn, 15, 1e-9, '15 flowing hours');
      assert.rel(day.q, 24 * day.V / 15, 1e-12, 'q = 24·V/15');
      assert.near(day.V / day.q - 1, -0.375, 1e-9, 'the V/24 alternative (q = V per day) is 37.5 % low');
      assert.rel(rh.byEvent.E1.Dq, 800, 1e-3, 'Δq = the flowing rate');
      // a whole shut-in day with an allocated volume
      const rows2 = J(rows); rows2[6].oil = 500;
      const rh2 = D.rates(null, [ev('E1', d5 + 15 * HOUR, 40)], rows2, { fluid: 'oil', day: UTC_DAY });
      assert.ok(codes(rh2.warnings).includes('VOLUME_ON_SHUT_DAY'), 'R2: volume on a shut-in day');
      // closing at 00:30: Δq from the previous full day
      const tc = d5 + 30 * MIN, rows3 = allocRows({ start_ms: T0, days: 14, events: [{ t_ms: tc, dur_h: 30 }] });
      rows3[4].oil = 760;                                    // previous day: a different rate, so the source is visible
      const rh3 = D.rates(null, [ev('E1', tc, 30)], rows3, { fluid: 'oil', day: UTC_DAY });
      assert.strictEqual(rh3.byEvent.E1.dqSource, 'previousDay');
      assert.rel(rh3.byEvent.E1.Dq, 760, 1e-9, 'Δq = the previous day\'s rate');
      assert.ok(codes(rh3.warnings).includes('SHORT_CLOSING_DAY'), 'R1 flag');
      assert.strictEqual(rh3.days[5].shortDay, true);
    },
  },
  {
    name: 'DA9 allocation: ignores-shut-in, pass and fail; < 2 clean days → unavailable; a flush day is not clean; a 23-h DST day can be clean; 10-unit rounding widens the tolerance',
    wp: WP,
    run(app, assert) {
      const D = Dof(app);
      const tcA = T0 + 5 * DAY + 9 * HOUR, tcB = T0 + 10 * DAY + 9 * HOUR, tcC = T0 + 15 * DAY + 9 * HOUR;
      const evs = [{ t_ms: tcA, dur_h: 6 }, { t_ms: tcB, dur_h: 6 }, { t_ms: tcC, dur_h: 6 }];
      const rows = allocRows({ start_ms: T0, days: 22, events: evs });
      const iA = rows.findIndex((r) => r.date === '2026-03-06'), iC = rows.findIndex((r) => r.date === '2026-03-16');
      rows[iA].oil = 800;                                     // A: a full day of volume despite 6 h shut (ignores the shut-in)
      rows[iC].oil = Math.round(rows[iC].oil * 0.7 * 10) / 10; // C: 30 % low (fail)
      const E = [ev('E1', tcA, 6), ev('E2', tcB, 6), ev('E3', tcC, 6)];
      const rh = D.rates(null, E, rows, { fluid: 'oil', day: UTC_DAY, resolution: { oil: 0.1 } });
      const dA = rh.days[iA], dB = rh.days.find((d) => d.date === '2026-03-11'), dC = rh.days[iC];
      assert.strictEqual(dA.ignoresShutin, true, 'A ignores the shut-in'); assert.strictEqual(rh.byEvent.E1.dqSource, 'qref');
      assert.strictEqual(dB.R3.status, 'pass', 'B passes'); assert.near(dB.R3.ratio, 1, 0.01);
      assert.strictEqual(dC.R3.status, 'fail', 'C fails');
      // the day after a reopening late in the evening is a flush day, not clean
      const late = [ev('E1', T0 + 5 * DAY + 14 * HOUR, 6)];
      const rhF = D.rates(null, late, allocRows({ start_ms: T0, days: 12, events: [{ t_ms: T0 + 5 * DAY + 14 * HOUR, dur_h: 6 }] }), { fluid: 'oil', day: UTC_DAY });
      assert.strictEqual(rhF.days.find((d) => d.date === '2026-03-07').cls, 'flush', 'reopening at 20:00 → next day flush');
      // fewer than 2 clean days within ±10 days → unavailable
      const few = rows.filter((r) => r.date >= '2026-03-05' && r.date <= '2026-03-07');
      const rhU = D.rates(null, [ev('E2', T0 + 5 * DAY + 9 * HOUR, 6)], few.map((r) => Object.assign({}, r, { oil: r.date === '2026-03-06' ? 600 : r.oil })), { fluid: 'oil', day: UTC_DAY });
      assert.strictEqual(rhU.days[1].R3.status, 'unavailable', '< 2 clean days');
      // Europe/London: the 23-h day (2026-03-29) can be clean
      const lon = { zone: { mode: 'iana', tz: 'Europe/London' }, startHour: 0 };
      const rowsL = [];
      for (let d = 20; d <= 31; d++) rowsL.push({ date: '2026-03-' + String(d).padStart(2, '0'), oil: d === 29 ? 800 * 23 / 24 : 800, gas: null, water: 0, hours: d === 29 ? 23 : 24 });
      const rhL = D.rates(null, [], rowsL, { fluid: 'oil', day: lon });
      const dst = rhL.days.find((d) => d.date === '2026-03-29');
      assert.near(dst.hours, 23, 1e-9); assert.strictEqual(dst.cls, 'clean', '23-h day is clean'); assert.rel(dst.q, 800, 1e-9);
      // 10-unit volume rounding widens the R3 tolerance
      const rows10 = rows.map((r) => Object.assign({}, r, { oil: Math.round(r.oil / 10) * 10 }));
      const rh10 = D.rates(null, E, rows10, { fluid: 'oil', day: UTC_DAY, resolution: { oil: 10 } });
      const dB10 = rh10.days.find((d) => d.date === '2026-03-11');
      assert.near(dB10.R3.tol, 0.15 + 10 / (dB10.qRef * dB10.hEff / 24), 1e-12, 'tol = 0.15 + ΔV_res/V_exp');
      assert.ok(dB10.R3.tol > dB.R3.tol, 'wider than with 0.1-unit rounding');
      const pa = D.parseAllocation('date,oil,gas,water,hours\n2026-03-01,800,320,0,24\n2026-03-02,790,316,10,24\n2026-03-03,810,324,0,24\n', {});
      assert.strictEqual(pa.resolution.oil, 10, 'detected oil resolution'); assert.strictEqual(pa.rows.length, 3);
      pa.rows.forEach((r) => shapeOk(assert, 'AllocRow', r));
    },
  },
  {
    name: 'DA10 zones: Europe/London days of 23/25 h whatever the process time zone; device resolves to the IANA name; the offset scan finds a 6 h shift',
    wp: WP,
    run(app, assert) {
      const D = Dof(app);
      const lon = { zone: { mode: 'iana', tz: 'Europe/London' }, startHour: 0 };
      const saved = process.env.TZ;
      try {
        ['America/New_York', 'Asia/Tokyo', 'UTC'].forEach((tz) => {
          process.env.TZ = tz;
          assert.near(D.dayBounds('2026-03-29', lon).hours, 23, 1e-9, tz + ': spring day');
          assert.near(D.dayBounds('2026-10-25', lon).hours, 25, 1e-9, tz + ': autumn day');
          assert.strictEqual(D.dayBounds('2026-07-01', lon).t0_ms, Date.UTC(2026, 5, 30, 23), tz + ': BST midnight');
          assert.strictEqual(D.dayOf(Date.UTC(2026, 5, 30, 23, 30), lon), '2026-07-01', tz + ': day label');
        });
      } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
      const dev = D.resolveZone({ mode: 'device' });
      assert.strictEqual(dev.mode, 'iana'); assert.strictEqual(dev.tz, app.win.Intl.DateTimeFormat().resolvedOptions().timeZone);
      S.checkShape('ZoneResolved', J(dev)).ok || assert.fail('ZoneResolved');
      assert.deepStrictEqual(J(D.resolveZone({ mode: 'fixed', offset_h: 99 })), { mode: 'fixed', offset_h: 14 }, 'clamped offset');
      // allocation days start at 06:00 but the analysis uses 00:00 → the scan finds +6 h
      const evs = [3, 6, 9, 12].map((d, i) => ({ t_ms: T0 + d * DAY + (1 + i) * HOUR, dur_h: 10 }));   // closings before 06:00, reopening after
      const rows = allocRows({ start_ms: T0, days: 16, events: evs, startHour: 6 });
      const rh = D.rates(null, evs.map((e, i) => ev('E' + (i + 1), e.t_ms, e.dur_h)), rows, { fluid: 'oil', day: UTC_DAY });
      assert.strictEqual(rh.offsetScan.best_h, 6, 'best offset +6 h'); assert.strictEqual(rh.offsetScan.better, true);
      assert.ok(codes(rh.warnings).includes('DAY_OFFSET'), 'R3 warning');
      const rh6 = D.rates(null, evs.map((e, i) => ev('E' + (i + 1), e.t_ms, e.dur_h)), rows, { fluid: 'oil', day: { zone: { mode: 'utc' }, startHour: 6 } });
      assert.strictEqual(rh6.offsetScan.better, false, 'no warning with the right start hour');
    },
  },
  {
    name: 'DA11 parser: chunked = one-shot; elapsed-hours CSV with a rate column → rateTable; psig → psia; 500k rows take ≥ 50 steps',
    wp: WP,
    run(app, assert) {
      const D = Dof(app);
      assert.ok(D.DEFAULTS.parse.chunkLines <= 10000, 'frozen chunk size');
      const iso = ['Time;Pressure (psig);Temp (degC)'];
      for (let i = 0; i < 3000; i++) iso.push(new Date(T0 + i * 60000).toISOString().replace('T', ' ').slice(0, 19) + ';' + (2985.3 + i * 0.01).toFixed(2).replace('.', ',') + ';' + (80 + i * 0.001).toFixed(3).replace('.', ','));
      const txt = iso.join('\n'), zone = { mode: 'iana', tz: 'Europe/London' };
      const sn = D.sniff(txt);
      assert.strictEqual(sn.sep, ';'); assert.strictEqual(sn.timeFormat, 'iso'); assert.strictEqual(sn.pUnitGuess, 'psig'); assert.strictEqual(sn.tempUnit, 'C');
      const one = D.parse(txt, { zone, chunkLines: 1e9 }), ch = D.parse(txt, { zone, chunkLines: 250 });
      assert.strictEqual(one.record.n, 3000);
      assert.deepStrictEqual(Array.from(ch.record.t), Array.from(one.record.t), 'times equal');
      assert.deepStrictEqual(Array.from(ch.record.p), Array.from(one.record.p), 'pressures equal');
      assert.strictEqual(ch.record.hash, one.record.hash);
      assert.near(one.record.p[0], 2985.3 + 14.696, 1e-9, 'psig + patm (decimal comma)');
      assert.strictEqual(one.record.t[0], Date.UTC(2026, 2, 1) - 0, 'naive time read in the gauge zone (GMT in March)');
      assert.near(one.record.T[0], 176, 1e-9, '°C → °F');
      { const r = S.checkShape('GaugeRecord', one.record); assert.ok(r.ok, 'GaugeRecord shape: ' + JSON.stringify(r.errors.slice(0, 4))); }
      // the GUI-sweep sample: time_hr, pressure_psi, rate_stbd → elapsed hours and a rate table
      const rows = ['time_hr,pressure_psi,rate_stbd'];
      for (let i = 0; i < 80; i++) { const t = 0.001 * Math.pow(10, i / 16); rows.push(t.toFixed(5) + ',' + (2500 + 180 * Math.log10(1 + t * 1000)).toFixed(2) + ',' + (i < 40 ? 600 : 0)); }
      const gs = D.parse(rows.join('\n'), { zone: { mode: 'utc' } });
      assert.strictEqual(D.sniff(rows.join('\n')).timeFormat, 'elapsed_h'); assert.strictEqual(D.sniff(rows.join('\n')).hasRate, true);
      assert.ok(gs.rateTable && gs.rateTable.length === 2, 'rate table (600 → 0)');
      assert.strictEqual(gs.record.elapsed, true); assert.strictEqual(gs.record.t[0], D.DEFAULTS.parse.t0_ms + Math.round(0.001 * HOUR));
      // 500k rows: at least 50 steps
      const big = new Array(500001); big[0] = 'time_hr,pressure_psia';
      for (let i = 1; i <= 500000; i++) big[i] = (i / 3600).toFixed(6) + ',' + (3000 + (i % 977) * 0.001).toFixed(3);
      const job = D.parseJob(big.join('\n'), { zone: { mode: 'utc' } });
      let steps = 0; for (;;) { steps++; if (job.step().done) break; }
      assert.ok(steps >= 50, steps + ' steps'); assert.strictEqual(job.result().record.n, 500000);
    },
  },
  {
    name: 'DA12 history: unknown → default prepend + flag; date and cum modes; table mode builds steps from the table; every zero-rate period stays in steps',
    wp: WP,
    run(app, assert) {
      const D = Dof(app);
      const tc = T0 + 6 * DAY + 9 * HOUR, rows = allocRows({ start_ms: T0, days: 14, events: [{ t_ms: tc, dur_h: 96 }] });
      const E = [ev('E1', tc, 96)];
      const u = D.rates(null, E, rows, { fluid: 'oil', day: UTC_DAY, history: { mode: 'unknown' } });
      assert.strictEqual(u.start.source, 'default'); assert.strictEqual(u.start.flag, true);
      assert.near(u.start.prepend_h, 960, 1e-9, 'max(30 d, 10 × 96 h)');
      assert.strictEqual(u.steps[0].t_ms, T0 - 960 * HOUR); assert.ok(codes(u.warnings).includes('HISTORY_ESTIMATED'));
      const d = D.rates(null, E, rows, { fluid: 'oil', day: UTC_DAY, history: { mode: 'date', date: '2025-12-01' } });
      assert.strictEqual(d.start.source, 'date'); assert.strictEqual(d.start.flag, false);
      assert.near(d.start.prepend_h, (T0 - Date.UTC(2025, 11, 1)) / HOUR, 1e-9);
      const c = D.rates(null, E, rows, { fluid: 'oil', day: UTC_DAY, history: { mode: 'cum', cum: 240000 } });
      assert.strictEqual(c.start.source, 'cum'); assert.near(c.start.prepend_h, 24 * 240000 / 800, 1e-6, 't_eq = Np/q_first');
      // table mode
      const tab = [{ t_ms: T0, q: 650 }, { t_ms: T0 + 10 * HOUR, q: 0 }, { t_ms: T0 + 30 * HOUR, q: 700 }, { t_ms: T0 + 50 * HOUR, q: 0 }];
      const tt = D.rateTable(tab, { events: [ev('E1', T0 + 10 * HOUR + 20000, 20)] });
      shapeOk(assert, 'RateHistory', tt);
      assert.strictEqual(tt.mode, 'table'); assert.strictEqual(tt.start.source, 'data');
      assert.deepStrictEqual(J(tt.steps.map((s) => s.q)), [650, 0, 700, 0]);
      assert.strictEqual(tt.steps[1].t_ms, T0 + 10 * HOUR + 20000, 'tabled closing moved to the refined t_c');
      assert.strictEqual(tt.byEvent.E1.dqSource, 'table'); assert.strictEqual(tt.byEvent.E1.r3Status, 'n/a'); assert.strictEqual(tt.byEvent.E1.Dq, 650);
      // zero-rate periods of every status stay in the steps; a partial cut is split
      const evs = [ev('E1', T0 + 2 * DAY + 3 * HOUR, 1.5, { status: 'too_short' }), ev('E2', T0 + 4 * DAY + 5 * HOUR, 8, { status: 'gap_at_closing' }),
        ev('E3', T0 + 6 * DAY + 7 * HOUR, 8, { status: 'not_confirmed' }), ev('E4', T0 + 8 * DAY + 9 * HOUR, 8, { status: 'intervention' }),
        ev('E5', T0 + 10 * DAY + 4 * HOUR, 30, { kind: 'partial', status: 'partial', fhat: 0.4, fhatMethod: 'dpDiff' })];
      const rh = D.rates(null, evs, allocRows({ start_ms: T0, days: 14, events: evs.map((e) => ({ t_ms: e.tc_ms, dur_h: e.dtEnd_h, f: e.kind === 'partial' ? 0.4 : 1 })) }), { fluid: 'oil', day: UTC_DAY });
      evs.slice(0, 4).forEach((e) => assert.strictEqual(rateAt(rh, e.tc_ms + e.dtEnd_h * HOUR / 2), 0, e.status + ': q = 0 in the steps'));
      assert.near(rateAt(rh, evs[4].tc_ms + 20 * HOUR), 0.6 * 800, 0.5, 'partial cut: (1 − f)·q (allocation rounded to 0.1)');
      evs.slice(0, 4).forEach((e) => assert.ok(D.stepIndexAt(rh, e.tc_ms) >= 0, e.id + ' has a q = 0 step at t_c'));
    },
  },
  {
    name: 'DA13 injector: falls are detected as fall-offs; the rate unit is bbl/d',
    wp: WP,
    run(app, assert) {
      const D = Dof(app);
      const evs = [{ t_ms: T0 + 2 * DAY + 9 * HOUR, dur_h: 30 }, { t_ms: T0 + 6 * DAY + 15 * HOUR, dur_h: 24 }];
      const rec = record(D, makeRecord({ start_ms: T0, days: 9, sample_s: 60, events: evs, sign: -1, well: { pInit: 3000, B: 1.02, mu: 0.5 }, sigma: 0.02, seed: 14 }));
      const rows = allocRows({ start_ms: T0, days: 9, events: evs }).map((r) => ({ date: r.date, oil: null, gas: null, water: r.oil, hours: r.hours }));
      const res = scan(D, rec, rows, { well: { fluid: 'water_inj', B: 1.02, Bw: 1.02 } });
      assert.ok(res.ok);
      assert.strictEqual(res.events.length, 2);
      res.events.forEach((e) => { assert.strictEqual(e.kind, 'falloff'); assert.strictEqual(e.status, 'analysable'); shapeOk(assert, 'Event', e); });
      assert.strictEqual(res.rates.unit, 'bbl/d'); assert.strictEqual(res.rates.phase, 'water_inj');
      assert.rel(res.rates.byEvent.E1.Dq, 800, 0.01, 'injection rate before the fall-off');
      assert.ok(res.events[0].rise_psi > 0, 'sign-aware fall');
    },
  },
  {
    name: 'DA14 two events in one day → equalRateAssumed (day and per test)',
    wp: WP,
    run(app, assert) {
      const D = Dof(app);
      const a = T0 + 5 * DAY + 3 * HOUR, b = T0 + 5 * DAY + 14 * HOUR;
      const evs = [{ t_ms: a, dur_h: 4 }, { t_ms: b, dur_h: 5 }];
      const rh = D.rates(null, [ev('E1', a, 4), ev('E2', b, 5)], allocRows({ start_ms: T0, days: 12, events: evs }), { fluid: 'oil', day: UTC_DAY });
      const d = rh.days.find((x) => x.date === '2026-03-06');
      assert.strictEqual(d.equalRateAssumed, true);
      assert.strictEqual(rh.byEvent.E1.equalRateAssumed, true); assert.strictEqual(rh.byEvent.E2.equalRateAssumed, true);
      assert.near(d.hOn, 15, 1e-9); assert.rel(d.q, 800, 1e-3);
    },
  },
  {
    name: 'DA15 intervention: a pressure above the previous p* by more than 2·T_s → intervention, not interpreted, listed in missed.interventions',
    wp: WP,
    run(app, assert) {
      const D = Dof(app);
      const e2 = T0 + 7 * DAY + 10 * HOUR;
      const evs = [{ t_ms: T0 + 2 * DAY + 9 * HOUR, dur_h: 48 }, { t_ms: e2, dur_h: 30 }];
      const rec = record(D, makeRecord({ start_ms: T0, days: 11, sample_s: 60, events: evs, humps: [{ t_ms: e2, at_h: 14, dp: 60, width_h: 9 }], sigma: 0.02, seed: 15 }));
      const res = scan(D, rec, allocRows({ start_ms: T0, days: 11, events: evs }));
      assert.strictEqual(res.events.length, 2);
      assert.strictEqual(res.events[0].status, 'analysable');
      assert.strictEqual(res.events[1].status, 'intervention');
      assert.deepStrictEqual(J(res.missed.interventions), ['E2']);
      assert.ok(codes(res.events[1].warnings).includes('INTERVENTION'));
      // without the bump both stay analysable (the later, longer build-up does not trip the rule)
      const ok = scan(D, record(D, makeRecord({ start_ms: T0, days: 11, sample_s: 60, events: evs, sigma: 0.02, seed: 15 })), allocRows({ start_ms: T0, days: 11, events: evs }));
      assert.deepStrictEqual(J(ok.events.map((e) => e.status)), ['analysable', 'analysable']);
    },
  },
  {
    name: 'DA16 phase basis once per analysis: water cut crossing 5 % → every day on the total basis; gas with condensate → q_eq',
    wp: WP,
    run(app, assert) {
      const D = Dof(app);
      const rows = allocRows({ start_ms: T0, days: 20, events: [], wcFn: (d) => (d >= '2026-03-12' ? 0.08 : 0.02), gor: 500 });
      const rh = D.rates(null, [], rows, { fluid: 'oil', day: UTC_DAY, B: 1.2, Bw: 1.02, Rs: 600 });
      assert.strictEqual(rh.phaseBasis.used, 'total'); assert.strictEqual(rh.phase, 'total_rb'); assert.strictEqual(rh.unit, 'bbl/d');
      assert.near(rh.phaseBasis.wcMax, 0.08, 1e-3);
      rh.days.forEach((d, i) => assert.rel(d.V, rows[i].oil * 1.2 + rows[i].water * 1.02, 1e-9, 'total reservoir volume ' + d.date));
      const rhOil = D.rates(null, [], allocRows({ start_ms: T0, days: 20, events: [], wcFn: () => 0.02, gor: 500 }), { fluid: 'oil', day: UTC_DAY, B: 1.2, Bw: 1.02, Rs: 600 });
      assert.strictEqual(rhOil.phaseBasis.used, 'oil');
      // gas with condensate: q_eq = q_g + 133.3·γo·q_o/M_o (API 50, M_o = 6,084/(API − 5.9))
      const grows = [];
      for (let d = 1; d <= 10; d++) grows.push({ date: '2026-03-' + String(d).padStart(2, '0'), oil: 500, gas: 5000, water: 0, hours: 24 });
      const rg = D.rates(null, [], grows, { fluid: 'gas', day: UTC_DAY, gas: { apiCond: 50 } });
      const go = 141.5 / (131.5 + 50), Mo = 6084 / (50 - 5.9);
      assert.strictEqual(rg.phaseBasis.used, 'gasEq'); assert.strictEqual(rg.unit, 'Mscf/d');
      assert.rel(rg.days[0].V, 5000 + 133.3 * go * 500 / Mo, 1e-12, 'wet-gas equivalent');
      const dry = D.rates(null, [], grows.map((r) => Object.assign({}, r, { oil: 10 })), { fluid: 'gas', day: UTC_DAY, gas: { apiCond: 50 } });
      assert.strictEqual(dry.phaseBasis.used, 'gas', 'condensate below 5 %: dry-gas basis');
    },
  },
];
