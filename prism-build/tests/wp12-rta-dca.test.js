// WP12 — decline results (EUR, t_ab, terminal decline, forecast, P10/P50/P90)
// and rate-transient analysis (RNP / NPI / normalised rate, FMB, linear flow).
// Source under test: prism-build/35-rta-dca.js (round 8).
'use strict';

// ── Node-side reference maths (independent of the app code) ────────────────
function arpsQ(t, qi, Di, b) {
  if (!(t > 0)) return qi;
  if (b < 1e-12) return qi * Math.exp(-Di * t);
  return qi * Math.pow(1 + b * Di * t, -1 / b);
}
function simpson(f, a, b, n) {
  if (n % 2) n++;
  const h = (b - a) / n;
  let s = f(a) + f(b);
  for (let k = 1; k < n; k++) s += (k % 2 ? 4 : 2) * f(a + k * h);
  return s * h / 3;
}
// ∫_a^b f(t) dt on a log grid (t = e^u) — for long spans with fast early decline.
function simpsonLog(f, a, b, n) {
  const ua = Math.log(a), ub = Math.log(b);
  return simpson((u) => { const t = Math.exp(u); return f(t) * t; }, ua, ub, n);
}
function bisect(fn, lo, hi) {           // fn(lo) > 0 > fn(hi)
  for (let i = 0; i < 200; i++) { const m = 0.5 * (lo + hi); if (fn(m) > 0) lo = m; else hi = m; }
  return 0.5 * (lo + hi);
}
function mulberry(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function E1(x) {
  if (!(x > 0)) return Infinity;
  if (x < 1) {
    let sum = 0, term = 1;
    for (let k = 1; k < 80; k++) { term *= -x / k; sum += term / k; if (Math.abs(term) < 1e-17) break; }
    return -0.5772156649015329 - Math.log(x) - sum;
  }
  let b = x + 1, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 300; i++) {
    const an = -i * i; b += 2;
    d = 1 / (an * d + b); c = b + an / c;
    const del = c * d; h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h * Math.exp(-x);
}
function median(a) { const s = a.filter(Number.isFinite).slice().sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]); }
function logspace(a, b, n) { const out = []; for (let i = 0; i < n; i++) out.push(a * Math.pow(b / a, i / (n - 1))); return out; }

// Arps rate dataset: t in HOURS (canonical), no pressure.
function arpsDataset(qi, Di, b, days, stepDays) {
  const t = [], q = [];
  for (let d = 0; d <= days; d += stepDays) { t.push(d * 24); q.push(arpsQ(d, qi, Di, b)); }
  return { t, q, p: null, timeUnit: 'h' };
}

// Closed square, well at the centre, constant rate — image-well lattice.
const SQ = { q: 500, B: 1.2, mu: 1.0, h: 50, phi: 0.2, ct: 1e-5, k: 10, rw: 0.3, L: 1320, pi: 5000 };
function squareDrawdown() {
  const s = SQ, Lr = s.L / s.rw;
  const tDperHr = 0.0002637 * s.k / (s.phi * s.mu * s.ct * s.rw * s.rw);
  const A = 141.2 * s.q * s.B * s.mu / (s.k * s.h);
  const t = logspace(0.5, 3300, 80), p = [], q = [];
  for (const th of t) {
    const tD = tDperHr * th;
    const M = Math.ceil(Math.sqrt(240 * tD) / Lr) + 1;
    let pD = 0.5 * E1(1 / (4 * tD));
    for (let m = -M; m <= M; m++) {
      for (let n = -M; n <= M; n++) {
        if (!m && !n) continue;
        const x = (m * m + n * n) * Lr * Lr / (4 * tD);
        if (x < 60) pD += 0.5 * E1(x);
      }
    }
    p.push(s.pi - A * pD); q.push(s.q);
  }
  return { t, p, q, timeUnit: 'h' };
}
const SQ_WELL = { pi: SQ.pi, B: SQ.B, mu: SQ.mu, ct: SQ.ct, h: SQ.h, phi: SQ.phi, rw: SQ.rw, fluid: 'oil', testType: 'drawdown' };
const SQ_N = SQ.L * SQ.L * SQ.h * SQ.phi / (5.615 * SQ.B);          // STB, Sw = 0

// Linear flow (infinite-conductivity fracture), xf·√k = 1000 ft·md½.
const LF = { B: 1.2, mu: 0.8, h: 60, phi: 0.08, ct: 1.5e-5, xk: 1000, pi: 5000, rw: 0.3 };
const LF_WELL = { pi: LF.pi, B: LF.B, mu: LF.mu, ct: LF.ct, h: LF.h, phi: LF.phi, rw: LF.rw, fluid: 'oil' };
function linearFlow(condition) {
  const mcr = 4.064 * Math.sqrt(24) * LF.B / (LF.h * LF.xk) * Math.sqrt(LF.mu / (LF.phi * LF.ct));   // RNP per √day
  const bSkin = 0.02;
  const td = logspace(1, 300, 60), t = [], p = [], q = [];
  for (const d of td) {
    t.push(d * 24);
    if (condition === 'pwf') {
      const dp = 1500, rnp = bSkin + (Math.PI / 2) * mcr * Math.sqrt(d);
      p.push(LF.pi - dp); q.push(dp / rnp);
    } else {
      const qc = 200; q.push(qc); p.push(LF.pi - qc * (bSkin + mcr * Math.sqrt(d)));
    }
  }
  return { t, p, q, timeUnit: 'h' };
}

function panelList(win, n) {
  const reg = win.PRiSM_tabPanels && win.PRiSM_tabPanels[n];
  return Array.isArray(reg) || (reg && typeof reg.length === 'number') ? Array.from(reg) : [];
}
function newHost(app, style) {
  const host = app.document.createElement('div');
  if (style) host.style.cssText = style;
  app.document.body.appendChild(host);
  return host;
}
// Recorded ops of the LAST draw only (the harness log accumulates; a resize marks a new frame).
function lastDraw(app, c) {
  const log = app.canvasLog(c);
  let i = log.length - 1;
  while (i >= 0 && log[i].op !== 'resize') i--;
  return log.slice(i + 1);
}
function lastTexts(app, c) { return lastDraw(app, c).filter((e) => e.op === 'fillText').map((e) => String(e.args[0])); }
function clearFit(app) {
  const st = app.win.PRiSM_state;
  if (st) st.lastFit = null;
}

module.exports = [
  {
    name: 'exports, plot-registry entries (decline mode) and C7 panel registration',
    wp: 'WP12',
    run(app, assert) {
      const w = app.win;
      ['PRiSM_declineResults', 'PRiSM_declineRate', 'PRiSM_fitDecline', 'PRiSM_declineForecastCSV',
       'PRiSM_declineResultsHTML', 'PRiSM_renderDeclineResultsPanel', 'PRiSM_rtaData', 'PRiSM_rtaFMB',
       'PRiSM_rtaLinearFlow', 'PRiSM_rtaAG', 'PRiSM_rtaSummary', 'PRiSM_renderRTAPanel'].forEach((f) => assert.fn(w[f], f));
      const reg = w.PRiSM_PLOT_REGISTRY;
      assert.ok(reg, 'window.PRiSM_PLOT_REGISTRY exists');
      for (const k of ['rnp', 'blasingame', 'ag', 'fmb', 'sqrtRnp']) {
        assert.ok(reg[k], 'registry has ' + k);
        assert.equal(reg[k].mode, 'decline', k + ' is a decline-mode plot');
        const fn = typeof reg[k].fn === 'function' ? reg[k].fn : w[reg[k].fn];
        assert.fn(fn, k + ' plot function resolvable');
        assert.fn(reg[k].build, k + ' has build()');
        assert.ok(typeof reg[k].label === 'string' && reg[k].label.length > 3, 'plain-language label');
      }
      // Pre-existing registry entries (if WP7 exposes them) are merged, not replaced.
      if (reg.bourdet) assert.ok(reg.bourdet.fn, 'existing entries kept');
      const p6 = panelList(w, 6).find((p) => p && p.id === 'dcaResults');
      const p2 = panelList(w, 2).find((p) => p && p.id === 'rta');
      assert.ok(p6 && typeof p6.render === 'function' && typeof p6.when === 'function', 'Tab 6 decline-results panel registered');
      assert.ok(p2 && typeof p2.render === 'function' && typeof p2.when === 'function', 'Tab 2 rate-transient panel registered');
      clearFit(app);
      w.PRiSM_dataset = app.toWin(linearFlow('rate'));
      if (w.PRiSM) w.PRiSM.mode = 'transient';
      assert.equal(p2.when(), false, 'RTA panel hidden in transient mode for constant-rate data');
      w.PRiSM = w.PRiSM || {};
      w.PRiSM.mode = 'decline';
      assert.equal(p2.when(), true, 'RTA panel shown in decline mode when p and q exist');
      assert.equal(p6.when(), true, 'decline panel shown in decline mode');
    },
  },
  {
    name: 'a. Arps EUR(3650 d) matches PRiSM_eur_arps = 189,610 ± 0.1 % (fit to q, t from 0, p = null)',
    wp: 'WP12',
    run(app, assert) {
      const w = app.win;
      const ds = app.toWin(arpsDataset(1000, 0.01, 0.5, 1000, 10));
      const fit = w.PRiSM_fitDecline('arps', ds, { local: true });
      assert.ok(fit.ok, 'local fit ok: ' + fit.reason);
      assert.equal(fit.kind, 'rate');
      assert.rel(fit.params.qi, 1000, 1e-4, 'qi');
      assert.rel(fit.params.Di, 0.01, 1e-4, 'Di (1/day)');
      assert.rel(fit.params.b, 0.5, 1e-4, 'b');
      const res = w.PRiSM_declineResults(fit, ds, { q_ab: 0.5, t_end_days: 3650, bootstrap: 0 });
      assert.ok(res.ok, res.reason);
      assert.equal(res.limitedBy, 'time');
      assert.rel(res.eur, 189610, 1e-3, 'EUR(3650 d)');
      if (typeof w.PRiSM_eur_arps === 'function') {
        const lib = w.PRiSM_eur_arps(app.toWin({ qi: 1000, Di: 0.01, b: 0.5 }), 3650);
        assert.rel(res.eur, lib, 1e-3, 'matches PRiSM_eur_arps');
        assert.ok(res.crossCheck && res.crossCheck.ok, 'cross-check against the library passes');
      }
      assert.rel(res.Di_yr, 3.65, 1e-3, 'Di_yr = 365·Di');
      assert.rel(res.De, 1 - Math.pow(1 + 0.5 * 3.65, -2), 1e-3, 'effective annual decline');
      // Np_hist: trapezoid of the history (1000 days)
      let np = 0; for (let d = 10; d <= 1000; d += 10) np += 0.5 * (arpsQ(d, 1000, 0.01, 0.5) + arpsQ(d - 10, 1000, 0.01, 0.5)) * 10;
      assert.rel(res.Np_hist, np, 1e-9, 'Np_hist trapezoid in days');
      assert.near(res.remaining, res.eur - res.Np_hist, 1e-6);
    },
  },
  {
    name: 'a. t_ab and EUR(q_ab) closed forms match numeric integration ± 0.1 % (b = 0, 0.5, 1, 1.5)',
    wp: 'WP12',
    run(app, assert) {
      const w = app.win, qi = 1000, Di = 0.01, qab = 5;
      for (const b of [0, 0.5, 1, 1.5]) {
        const fit = app.toWin({ modelKey: 'arps', kind: 'rate', params: { qi, Di, b } });
        const res = w.PRiSM_declineResults(fit, app.toWin({ t: [0], q: [qi] }), { q_ab: qab, bootstrap: 0 });
        assert.ok(res.ok, res.reason);
        const tNum = bisect((t) => arpsQ(t, qi, Di, b) - qab, 0, 1e8);
        assert.rel(res.t_ab_days, tNum, 1e-3, 't_ab b=' + b);
        // plan closed forms
        const tForm = b === 0 ? Math.log(qi / qab) / Di : (Math.pow(qi / qab, b) - 1) / (b * Di);
        assert.rel(res.t_ab_days, tForm, 1e-9, 't_ab closed form b=' + b);
        const eForm = b === 0 ? (qi - qab) / Di
          : b === 1 ? (qi / Di) * Math.log(qi / qab)
          : Math.pow(qi, b) / ((1 - b) * Di) * (Math.pow(qi, 1 - b) - Math.pow(qab, 1 - b));
        const eNum = simpson((t) => arpsQ(t, qi, Di, b), 0, Math.min(tNum, 2000), 20000) +
                     (tNum > 2000 ? simpsonLog((t) => arpsQ(t, qi, Di, b), 2000, tNum, 20000) : 0);
        assert.rel(res.eur_qab, eForm, 1e-6, 'EUR closed form b=' + b);
        assert.rel(res.eur_qab, eNum, 1e-3, 'EUR vs numeric b=' + b);
        assert.equal(res.limitedBy, 'rate');
        if (b === 1.5) {
          assert.ok(res.warnings.some((x) => /b = 1\.5.*terminal decline/i.test(x)), 'b > 1 warning');
          assert.ok(res.warnings.some((x) => /years/.test(x) && /> 50/.test(x)), 't_ab > 50 yr warning');
        }
      }
    },
  },
  {
    name: 'a. terminal decline (Dmin) switch is C¹-continuous in q; modified-hyperbolic EUR matches integration',
    wp: 'WP12',
    run(app, assert) {
      const w = app.win;
      const params = app.toWin({ qi: 1000, Di: 0.01, b: 1.2 });
      const fit = app.toWin({ modelKey: 'arps', kind: 'rate', params: { qi: 1000, Di: 0.01, b: 1.2 } });
      const res = w.PRiSM_declineResults(fit, app.toWin({ t: [0], q: [1000] }), { q_ab: 2, DminEffYr: 0.06, bootstrap: 0 });
      assert.ok(res.ok, res.reason);
      const Dmin = -Math.log(0.94) / 365;
      assert.rel(res.Dmin, Dmin, 1e-9, 'nominal Dmin from 6 %/yr effective');
      const tsw = (0.01 / Dmin - 1) / (1.2 * 0.01);
      assert.rel(res.tSwitch_days, tsw, 1e-9, 't_sw = (Di/Dmin − 1)/(b·Di)');
      const q = (t) => w.PRiSM_declineRate('arps', params, t, { DminEffYr: 0.06 });
      const qL = q(tsw * (1 - 1e-12)), qR = q(tsw * (1 + 1e-12));
      assert.rel(qL, qR, 1e-9, 'q continuous at t_sw');
      const e = 1e-4 * tsw;
      const dL = (q(tsw) - q(tsw - e)) / e, dR = (q(tsw + e) - q(tsw)) / e;
      assert.rel(dL, dR, 2e-4, 'dq/dt continuous at t_sw');
      assert.rel(dR, -Dmin * q(tsw), 1e-3, 'exponential at Dmin after the switch');
      const eNum = simpson(q, 0, 2000, 20000) + simpsonLog(q, 2000, res.t_ab_days, 40000);
      assert.rel(res.eur, eNum, 1e-3, 'EUR with terminal decline vs numeric');
      assert.ok(!res.warnings.some((x) => /terminal decline/i.test(x) && /Consider/.test(x)), 'no b>1 warning once Dmin is set');
      // q_ab after the switch: t_ab = t_sw + ln(q_sw/q_ab)/Dmin
      assert.rel(res.t_ab_days, tsw + Math.log(res.qSwitch / 2) / Dmin, 1e-9);
    },
  },
  {
    name: 'Duong and SEPD results use the numeric cumulative (vs Simpson ± 0.2 %) and hit q_ab at t_ab',
    wp: 'WP12',
    run(app, assert) {
      const w = app.win;
      const cases = [
        { key: 'duong', params: { q1: 800, a: 1.2, m: 1.15 }, q: (t) => 800 * Math.pow(t, -1.15) * Math.exp(1.2 / (1 - 1.15) * (Math.pow(t, 1 - 1.15) - 1)), qab: 5 },
        { key: 'sepd', params: { qi: 1000, tau: 60, n: 0.45 }, q: (t) => 1000 * Math.exp(-Math.pow(t / 60, 0.45)), qab: 2 },
      ];
      for (const c of cases) {
        const res = w.PRiSM_declineResults(app.toWin({ modelKey: c.key, kind: 'rate', params: c.params }),
          app.toWin({ t: [24, 48], q: [c.q(1), c.q(2)] }), { q_ab: c.qab, t_end_days: 7300, bootstrap: 0 });
        assert.ok(res.ok, c.key + ': ' + res.reason);
        const tl = res.t_limit_days;
        const eNum = simpsonLog(c.q, 1e-6, tl, 60000);
        assert.rel(res.eur, eNum, 2e-3, c.key + ' EUR vs numeric');
        if (res.limitedBy === 'rate') assert.rel(c.q(res.t_ab_days), c.qab, 1e-6, c.key + ' q(t_ab) = q_ab');
      }
    },
  },
  {
    name: 'local rate fit recovers Arps (t from 0) and SEPD; Di reported in 1/day',
    wp: 'WP12',
    run(app, assert) {
      const w = app.win;
      const f1 = w.PRiSM_fitDecline('arps', app.toWin(arpsDataset(2500, 0.004, 0.9, 1500, 15)), { local: true });
      assert.ok(f1.ok && f1.converged, 'arps fit converged');
      assert.rel(f1.params.qi, 2500, 1e-4); assert.rel(f1.params.Di, 0.004, 1e-4); assert.rel(f1.params.b, 0.9, 1e-4);
      assert.ok(f1.r2 > 0.999999, 'R² on q');
      const t = [], q = [];
      for (let d = 1; d <= 900; d += 7) { t.push(d * 24); q.push(1000 * Math.exp(-Math.pow(d / 60, 0.45))); }
      const f2 = w.PRiSM_fitDecline('sepd', app.toWin({ t, q, p: null }), { local: true });
      assert.ok(f2.ok, f2.reason);
      assert.rel(f2.params.qi, 1000, 1e-3); assert.rel(f2.params.tau, 60, 1e-3); assert.rel(f2.params.n, 0.45, 1e-3);
    },
  },
  {
    name: 'forecast table sums to the model cumulative; CSV header and rows',
    wp: 'WP12',
    run(app, assert) {
      const w = app.win;
      const ds = app.toWin(arpsDataset(1000, 0.01, 0.5, 360, 30));
      const fit = app.toWin({ modelKey: 'arps', kind: 'rate', params: { qi: 1000, Di: 0.01, b: 0.5 } });
      const res = w.PRiSM_declineResults(fit, ds, { q_ab: 10, bootstrap: 0 });
      assert.ok(res.ok, res.reason);
      assert.near(res.t_ab_days, 1800, 1e-6, 't_ab = 1800 d at q_ab = 1 % of qi');
      assert.equal(res.t_last_days, 360);
      const rows = res.forecast;
      assert.equal(rows.length, Math.ceil((1800 - 360) / (365 / 12) - 1e-9), 'one row per month to the limit');
      const vol = rows.reduce((s, r) => s + r.volume, 0);
      const cumModel = (t) => Math.pow(1000, 0.5) / (0.5 * 0.01) * (Math.pow(1000, 0.5) - Math.pow(arpsQ(t, 1000, 0.01, 0.5), 0.5));
      assert.rel(vol, cumModel(1800) - cumModel(360), 1e-9, 'forecast volume = cum(t_ab) − cum(t_last)');
      assert.rel(rows[rows.length - 1].cum, res.Np_hist + vol, 1e-12);
      assert.near(rows[rows.length - 1].t1, 1800, 1e-6);
      const csv = w.PRiSM_declineForecastCSV(res).trim().split('\n');
      assert.equal(csv.length, rows.length + 1);
      assert.equal(csv[0], 'month,t_start_d,t_end_d,q_start_STB_per_d,q_end_STB_per_d,q_avg_STB_per_d,volume_STB,cum_STB');
      assert.equal(csv[1].split(',').length, 8);
    },
  },
  {
    name: 'P10/P50/P90 bootstrap: ordered, bracket the deterministic EUR, reproducible (shared + local)',
    wp: 'WP12',
    run(app, assert) {
      const w = app.win, rnd = mulberry(99);
      const t = [], q = [];
      for (let m = 0; m < 60; m++) {
        const d = m * 30.4;
        const z = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
        t.push(d * 24); q.push(arpsQ(d, 1200, 0.008, 0.7) * Math.exp(0.05 * z));
      }
      const ds = app.toWin({ t, q, p: null });
      const fit = w.PRiSM_fitDecline('arps', ds, { local: true });
      assert.ok(fit.ok, fit.reason);
      for (const impl of ['auto', 'local']) {
        const res = w.PRiSM_declineResults(fit, ds, { q_ab: 5, bootstrap: 200, seed: 11, bootstrapImpl: impl, useCachedBootstrap: false });
        const bs = res.percentiles;
        assert.ok(bs && bs.ok, impl + ': bootstrap ok ' + (bs && bs.reason));
        assert.ok(bs.n >= 150, impl + ': most refits succeed (' + bs.n + ')');
        assert.ok(bs.eur.P90 < bs.eur.P50 && bs.eur.P50 < bs.eur.P10, impl + ': P90 < P50 < P10 (P90 is the low case)');
        assert.ok(bs.eur.P10 / bs.eur.P90 > 1.005, impl + ': non-degenerate band');
        assert.rel(bs.eur.P50, res.eur, 0.05, impl + ': P50 near the deterministic EUR');
        assert.ok(bs.eur.P90 <= res.eur * 1.02 && bs.eur.P10 >= res.eur * 0.98, impl + ': band brackets the EUR');
        assert.ok(bs.params.b && bs.params.b.p10 <= bs.params.b.p90, impl + ': parameter percentiles');
        const again = w.PRiSM_declineResults(fit, ds, { q_ab: 5, bootstrap: 200, seed: 11, bootstrapImpl: impl, useCachedBootstrap: false });
        assert.equal(again.percentiles.eur.P50, bs.eur.P50, impl + ': seeded → reproducible');
      }
    },
  },
  {
    name: 'b. FMB on a synthetic bounded constant-rate drawdown (closed square, image wells) → N within 3 %',
    wp: 'WP12',
    timeoutMs: 60000,
    run(app, assert) {
      const w = app.win;
      const ds = app.toWin(squareDrawdown());
      const rta = w.PRiSM_rtaData(ds, app.toWin(SQ_WELL), {});
      assert.ok(rta.ok, rta.reason);
      assert.equal(rta.n, 80);
      for (let i = 0; i < rta.n; i++) assert.rel(rta.tc[i], rta.tDays[i], 1e-9, 'tc = t at constant rate');
      const fmb = w.PRiSM_rtaFMB(rta, { S: 0 });
      assert.ok(fmb.ok, fmb.reason);
      assert.ok(/unit-slope/.test(fmb.method), 'boundary-dominated points found automatically: ' + fmb.method);
      assert.ok(fmb.n >= 6, 'enough BDF points (' + fmb.n + ')');
      assert.rel(fmb.N, SQ_N, 0.03, 'N = A·h·φ/(5.615·B)');
      assert.rel(fmb.A_ft2, SQ.L * SQ.L, 0.03, 'drainage area');
      assert.rel(fmb.kh, SQ.k * SQ.h, 0.05, 'k·h from b_pss');
      // Sw scales N but not the area
      const fmb2 = w.PRiSM_rtaFMB(rta, { S: 0, Sw: 0.25 });
      assert.rel(fmb2.N, 0.75 * fmb.N, 1e-12);
      assert.rel(fmb2.A_ft2, fmb.A_ft2, 1e-12);
      // Agarwal–Gardner from the FMB results: late qD on the BDF line
      const ag = w.PRiSM_rtaAG(rta, { fmb });
      assert.ok(ag.ok, ag.reason);
      const last = ag.tDA.length - 1;
      assert.rel(ag.qD[last], 1 / (2 * Math.PI * ag.tDA[last] + ag.bD), 0.02, 'qD on the boundary-dominated line');
    },
  },
  {
    name: 'c. RNP on the default sample: RNP′ plateau = 52.4/850 = 0.0616 ± 2 %',
    wp: 'WP12',
    run(app, assert) {
      const w = app.win;
      const ds = app.seedSample();
      assert.ok(ds && ds.t.length === 55, 'sample seeded');
      const rta = w.PRiSM_rtaData(ds, app.toWin({ pi: 4200, B: 1.25, mu: 1.1, ct: 1.2e-5, h: 35, phi: 0.18, rw: 0.354, fluid: 'oil', testType: 'drawdown' }), {});
      assert.ok(rta.ok, rta.reason);
      assert.equal(rta.n, 55);
      assert.equal(rta.piSource, 'well', 'pi from the supplied well inputs');
      assert.near(rta.dp[0], 338.6, 0.1, 'Δp(t0) from pi');
      for (let i = 0; i < rta.n; i++) assert.rel(rta.tc[i], rta.tDays[i], 1e-9, 'tc = t for constant q');
      const late = [];
      for (let i = 0; i < rta.n; i++) if (rta.tDays[i] >= 10 / 24) late.push(rta.rnpd[i]);
      assert.ok(late.length >= 10);
      assert.rel(median(late), 52.4 / 850, 0.02, 'RNP′ plateau');
      // integral identities
      for (let i = 0; i < rta.n; i++) {
        assert.near(rta.rnpid[i], rta.rnp[i] - rta.rnpi[i], 1e-12);
        assert.near(rta.qdp[i] * rta.rnp[i], 1, 1e-12);
      }
      // Without pi (and no well store), pi is estimated and flagged — never silently.
      if (typeof w.PRiSM_getWell !== 'function') {
        const r2 = w.PRiSM_rtaData(ds, app.toWin({ B: 1.25, mu: 1.1, ct: 1.2e-5, h: 35, phi: 0.18, rw: 0.354 }), {});
        assert.equal(r2.piSource, 'extrapolated');
        assert.ok(r2.warnings.some((x) => /pi/.test(x) && /biased/.test(x)), 'pi warning');
      }
    },
  },
  {
    name: 'd. linear flow: synthetic xf·√k = 1000 → 1000 ± 3 % (constant rate and constant pwf ×π/2)',
    wp: 'WP12',
    run(app, assert) {
      const w = app.win;
      for (const cond of ['rate', 'pwf']) {
        const rta = w.PRiSM_rtaData(app.toWin(linearFlow(cond)), app.toWin(LF_WELL), {});
        assert.ok(rta.ok, rta.reason);
        const lf = w.PRiSM_rtaLinearFlow(rta, {});
        assert.ok(lf.ok, lf.reason);
        assert.equal(lf.condition, cond, 'flow condition auto-detected');
        assert.rel(lf.xf_sqrt_k, 1000, 0.03, 'xf√k ' + cond);
        const lfk = w.PRiSM_rtaLinearFlow(rta, { k: 0.04 });
        assert.rel(lfk.xf, lfk.xf_sqrt_k / 0.2, 1e-12, 'xf = xf√k/√k');
      }
      // Forcing the wrong condition changes the answer by exactly π/2.
      const rta = w.PRiSM_rtaData(app.toWin(linearFlow('rate')), app.toWin(LF_WELL), {});
      const a = w.PRiSM_rtaLinearFlow(rta, { condition: 'rate' }), b = w.PRiSM_rtaLinearFlow(rta, { condition: 'pwf' });
      assert.rel(b.xf_sqrt_k / a.xf_sqrt_k, Math.PI / 2, 1e-12);
    },
  },
  {
    name: 'RTA plots draw via the registry fns; "needs pressure" message without p; axes invertible (C6)',
    wp: 'WP12',
    run(app, assert) {
      const w = app.win, doc = app.document;
      w.PRiSM_dataset = app.toWin(squareDrawdown());
      const canvas = doc.createElement('canvas');
      canvas.setAttribute('width', '640'); canvas.setAttribute('height', '400');
      doc.body.appendChild(canvas);
      const reg = w.PRiSM_PLOT_REGISTRY;
      for (const k of ['rnp', 'blasingame', 'ag', 'fmb', 'sqrtRnp']) {
        const fn = typeof reg[k].fn === 'function' ? reg[k].fn : w[reg[k].fn];
        const built = reg[k].build();
        assert.ok(built && built.data && built.data.rta && built.opts.timeUnit === 'd', k + ' build → {data, opts}');
        fn(canvas, built.data, built.opts);
        const texts = lastTexts(app, canvas).join(' | ');
        assert.ok(lastDraw(app, canvas).length > 50, k + ' drew');
        assert.ok(!/NaN|undefined/.test(texts), k + ' no NaN labels: ' + texts.slice(0, 200));
      }
      w.PRiSM_plot_rta_rnp(canvas, {}, {});
      assert.ok(lastDraw(app, canvas).filter((e) => e.op === 'arc').length > 100, 'RNP markers');
      assert.ok(lastTexts(app, canvas).some((s) => /^RNP,/.test(s)), 'RNP axis label');
      const ax = canvas._prismAxes;
      assert.ok(ax && ax.scaleX.kind === 'log' && ax.plotKey === 'rnp', 'C6 _prismAxes');
      for (const v of [0.05, 1, 30]) assert.rel(ax.fromX(ax.toX(v)), v, 1e-9);
      for (const v of [0.3, 2, 7]) assert.rel(ax.fromY(ax.toY(v)), v, 1e-9);
      w.PRiSM_plot_rta_fmb(canvas, {}, {});
      assert.equal(canvas._prismAxes.scaleX.kind, 'lin');
      assert.rel(canvas._prismAxes.fromX(canvas._prismAxes.toX(1e6)), 1e6, 1e-9);
      // rate-only dataset → message, no throw
      w.PRiSM_dataset = app.toWin(arpsDataset(1000, 0.01, 0.5, 300, 10));
      w.PRiSM_plot_rta_blasingame(canvas, {}, {});
      assert.ok(/needs flowing pressure/.test(lastTexts(app, canvas).join(' ')), 'needs-pressure message');
      assert.equal(canvas._prismAxes, null);
    },
  },
  {
    name: 'decline results panel (Tab 6): Fit → EUR and P-band, q_ab input re-computes, forecast CSV downloads',
    wp: 'WP12',
    run(app, assert) {
      const w = app.win;
      clearFit(app);
      w.PRiSM_dataset = app.toWin(arpsDataset(1000, 0.01, 0.5, 720, 30));
      const timers0 = app.pendingTimers();
      const host = newHost(app);
      w.PRiSM_renderDeclineResultsPanel(host);
      assert.includes(host.textContent, 'No decline fit yet');
      assert.ok(app.el('prism_dca_fit'), 'fit button offered');
      app.click('prism_dca_fit');
      const fit = typeof w.PRiSM_getLastFit === 'function' ? w.PRiSM_getLastFit() : w.PRiSM_state.lastFit;
      assert.ok(fit && (fit.modelKey || fit.model) === 'arps' && fit.kind === 'rate', 'rate fit stored as lastFit');
      assert.equal(w.PRiSM_state.match && w.PRiSM_state.match.timeShift || 0, 0, 'st.match untouched');
      const txt1 = host.textContent;
      assert.includes(txt1, 'EUR');
      assert.includes(txt1, 'P90 / P50 / P10');
      assert.includes(txt1, 'Time to q_ab');
      assert.ok(!/NaN|undefined/.test(txt1), 'no NaN in the panel');
      app.input('prism_dca_qab', '5');
      const txt2 = host.textContent;
      assert.notEqual(txt1, txt2, 'results re-rendered for the new q_ab');
      assert.equal(w.PRiSM_state.dcaOpts.qab, 5);
      app.check('prism_dca_dmin_on', true);
      assert.equal(w.PRiSM_state.dcaOpts.dminOn, true, 'terminal decline enabled');
      assert.ok(/Terminal decline[^]*%\/yr[^]*switch at/.test(host.textContent), 'terminal-decline result shown');
      app.click('prism_dca_csv');
      assert.equal(app.downloads.length, 1, 'one download');
      assert.ok(/\.csv$/.test(app.downloads[0].filename));
      assert.ok(/^month,t_start_d/.test(app.downloads[0].content), 'CSV content');
      // Other layers may debounce on prism:fit-updated; this layer itself never schedules timers.
      assert.ok(!app.timers().some((t) => /35-rta-dca/.test(String(t.where || t.stack || ''))), 'no timers created by 35-rta-dca');
      assert.ok(app.pendingTimers() >= timers0);
      // read-only embedding for the report
      const h2 = newHost(app);
      w.PRiSM_renderDeclineResultsPanel(h2, { readOnly: true });
      assert.includes(h2.textContent, 'EUR');
      assert.equal(h2.querySelectorAll('input').length, 0);
      // Consumers that pass no limits (rail, report) see the panel's q_ab / terminal decline.
      const r = w.PRiSM_declineResults(null, w.PRiSM_dataset, {});
      assert.ok(r.ok, r.reason);
      assert.equal(r.q_ab, 5, 'saved q_ab applied');
      assert.ok(r.Dmin > 0, 'saved terminal decline applied');
      assert.equal(r.EUR, r.eur, 'EUR alias');
      assert.ok(r.bands && r.bands.P90 <= r.bands.P50 && r.bands.P50 <= r.bands.P10, 'bands alias (P90 low case; noiseless data → narrow band)');
      const r0 = w.PRiSM_declineResults(null, w.PRiSM_dataset, { useSavedOptions: false, bootstrap: 0 });
      assert.rel(r0.q_ab, 10, 1e-6, 'default q_ab = 1 % of qi');
      assert.equal(r0.Dmin, null);
    },
  },
  {
    name: 'P-band policy: automatic only when cheap (≤ 400 points, closed-form model); explicit request always runs',
    wp: 'WP12',
    run(app, assert) {
      const w = app.win;
      const big = app.toWin(arpsDataset(1000, 0.002, 0.6, 1200, 2));       // 601 points
      const fit = app.toWin({ modelKey: 'arps', kind: 'rate', params: { qi: 1000, Di: 0.002, b: 0.6 } });
      const r1 = w.PRiSM_declineResults(fit, big, { q_ab: 5, useCachedBootstrap: false });
      assert.equal(r1.percentiles, null, 'no automatic bootstrap on 601 points');
      assert.equal(r1.bands, null);
      const r2 = w.PRiSM_declineResults(fit, big, { q_ab: 5, bootstrap: 30, bootstrapImpl: 'local' });
      assert.ok(r2.percentiles && r2.percentiles.ok && r2.percentiles.nRequested === 30, 'explicit bootstrap runs');
      const r3 = w.PRiSM_declineResults(fit, big, { q_ab: 5, bootstrapImpl: 'local' });
      assert.ok(r3.percentiles && r3.percentiles.ok, 'cached result reused without recomputing');
    },
  },
  {
    name: 'rate-transient panel (Tab 2) at 375 px: own plot, FMB + linear-flow cards, plot switch, no fixed widths',
    wp: 'WP12',
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      const w = app.win;
      w.PRiSM_dataset = app.toWin(squareDrawdown());
      // Well inputs through the C1 store when present, else the PVT store.
      if (typeof w.PRiSM_setWell === 'function') {
        w.PRiSM_setWell(app.toWin({ p_res: SQ.pi, pi: SQ.pi, Bo: SQ.B, B: SQ.B, mu_o: SQ.mu, mu: SQ.mu, ct: SQ.ct, h: SQ.h, phi: SQ.phi, rw: SQ.rw, fluidType: 'oil', testType: 'drawdown' }), app.toWin({ source: 'user' }));
      } else {
        Object.assign(w.PRiSM_pvt, app.toWin({ p_res: SQ.pi, Bo: SQ.B, mu_o: SQ.mu, ct: SQ.ct, h: SQ.h, phi: SQ.phi, rw: SQ.rw, fluidType: 'oil', provenance: { p_res: 'user' } }));
      }
      const host = newHost(app, 'width:343px');
      const out = w.PRiSM_renderRTAPanel(host);
      assert.ok(out && out.rta && out.rta.ok, 'RTA data ok: ' + (out && out.rta && out.rta.reason));
      const txt = host.textContent;
      assert.includes(txt, 'Flowing material balance');
      assert.includes(txt, 'Linear flow');
      assert.ok(!/NaN|undefined/.test(txt), 'no NaN');
      assert.ok(out.fmb.ok, 'FMB ok in panel: ' + out.fmb.reason);
      assert.rel(out.fmb.N, SQ_N, 0.03, 'panel FMB N');
      assert.ok(app.canvasLog('prism_rta_canvas').length > 50, 'panel canvas drawn');
      const btn = host.querySelector('[data-rta-plot="fmb"]');
      app.click(btn);
      assert.equal(btn.getAttribute('aria-pressed'), 'true');
      assert.ok(lastTexts(app, 'prism_rta_canvas').some((s) => /material balance|Flowing mat/i.test(s)), 'switched to the FMB plot');
      assert.equal(w.PRiSM_state.rtaOpts.plot, 'fmb', 'choice remembered');
      app.input('prism_rta_sw', '0.2');
      assert.includes(host.textContent, 'Oil in place');
      // 375 px: nothing with a fixed inline width beyond the 343 px content box; tables scroll in a wrapper.
      Array.from(host.querySelectorAll('*')).forEach((el) => {
        ['width', 'minWidth'].forEach((p) => {
          const v = el.style && el.style[p];
          if (v && /px$/.test(v)) assert.ok(parseFloat(v) <= 343, 'inline ' + p + ' ' + v);
        });
      });
      Array.from(host.querySelectorAll('table')).forEach((tb) => assert.ok(tb.parentNode.classList.contains('prism-table-wrap')));
      assert.ok(app.el('prism-rta-dca-css'), 'scoped CSS injected once');
    },
  },

  // ── integration (need other WPs) ────────────────────────────────────────
  {
    name: '[WP2] shared PRiSM_fitRate → decline results EUR(3650 d) = 189,610 ± 0.1 %',
    wp: 'WP12',
    integration: true,
    run(app, assert) {
      const w = app.win;
      assert.fn(w.PRiSM_fitRate, 'PRiSM_fitRate (WP2)');
      const ds = app.toWin(arpsDataset(1000, 0.01, 0.5, 1000, 10));
      const fit = w.PRiSM_fitDecline('arps', ds, {});
      assert.equal(fit.impl, 'shared');
      const res = w.PRiSM_declineResults(fit, ds, { q_ab: 0.5, t_end_days: 3650, bootstrap: 0 });
      assert.rel(res.eur, 189610, 1e-3);
    },
  },
  {
    name: '[WP8/WP1] Tab 6 mounts the decline panel through the C7 registry when lastFit is a rate fit',
    wp: 'WP12',
    integration: true,
    run(app, assert) {
      const w = app.win;
      app.openPRiSM();
      w.PRiSM_dataset = app.toWin(arpsDataset(1000, 0.01, 0.5, 720, 30));
      const fit = w.PRiSM_fitDecline('arps', w.PRiSM_dataset, { local: true });
      assert.fn(w.PRiSM_setLastFit, 'PRiSM_setLastFit (WP1)');
      w.PRiSM_setLastFit(fit);
      if (w.PRiSM.setMode) w.PRiSM.setMode('decline');
      app.gotoTab(6);
      const panels = app.el('prism_tab_6_panels');
      assert.ok(panels, 'Tab 6 panel host (C7)');
      assert.ok(panels.querySelector('#prism_dca_results'), 'decline results panel mounted under Tab 6');
      assert.includes(panels.textContent, 'EUR');
    },
  },
  {
    name: '[WP7] main Tab 2 plot draws the RNP plot through PRiSM_PLOT_REGISTRY',
    wp: 'WP12',
    integration: true,
    run(app, assert) {
      const w = app.win;
      app.openPRiSM();
      w.PRiSM_dataset = app.toWin(squareDrawdown());
      if (w.PRiSM.setMode) w.PRiSM.setMode('decline');
      app.gotoTab(2);
      w.PRiSM_state.activePlot = 'rnp';
      assert.fn(w.PRiSM_drawActivePlot, 'PRiSM_drawActivePlot (WP7)');
      w.PRiSM_drawActivePlot();
      assert.ok(app.canvasTexts('prism_plot_canvas').some((s) => /RNP/.test(s)), 'RNP plot on the main canvas');
    },
  },
  {
    name: '[WP4a] FMB on the corrected closedRectangle kernel (centred, tDA > 0.3) → N within 3 %',
    wp: 'WP12',
    integration: true,
    timeoutMs: 120000,
    run(app, assert) {
      const w = app.win, m = w.PRiSM_MODELS && w.PRiSM_MODELS.closedRectangle;
      assert.ok(m && typeof m.pd === 'function', 'closedRectangle model');
      const s = SQ, d = s.L / 2 / s.rw;
      const tDperHr = 0.0002637 * s.k / (s.phi * s.mu * s.ct * s.rw * s.rw);
      const A = 141.2 * s.q * s.B * s.mu / (s.k * s.h);
      const t = logspace(1, 3300, 60);
      const pD = m.pd(app.toWin(t.map((x) => x * tDperHr)), app.toWin({ Cd: 1, S: 0, dN: d, dS: d, dE: d, dW: d }));
      const ds = { t, p: t.map((x, i) => s.pi - A * pD[i]), q: t.map(() => s.q), timeUnit: 'h' };
      const rta = w.PRiSM_rtaData(app.toWin(ds), app.toWin(SQ_WELL), {});
      const fmb = w.PRiSM_rtaFMB(rta, { S: 0 });
      assert.ok(fmb.ok, fmb.reason);
      assert.rel(fmb.N, SQ_N, 0.03);
    },
  },
  {
    name: '[WP1/WP8] default sample with its META: RNP′ plateau from the well store (no explicit well)',
    wp: 'WP12',
    integration: true,
    run(app, assert) {
      const w = app.win;
      assert.fn(w.PRiSM_getWell, 'PRiSM_getWell (WP1)');
      app.openPRiSM();
      const ds = app.seedSample();
      const rta = w.PRiSM_rtaData(ds);
      assert.ok(rta.ok, rta.reason);
      assert.near(rta.pi, 4200, 1e-6, 'pi from the sample META');
      const late = [];
      for (let i = 0; i < rta.n; i++) if (rta.tDays[i] >= 10 / 24) late.push(rta.rnpd[i]);
      assert.rel(median(late), 52.4 / 850, 0.02);
    },
  },
];
