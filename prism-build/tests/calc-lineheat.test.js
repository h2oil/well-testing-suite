// Roadmap calculator #12 — Line Heat Loss & Arrival Temperature (route `lineheat`,
// prism-build/49-calc-lineheat.js).
//
// Expected values are independent hand calculations typed from the references:
//   series resistances   R' = 1/(hi π Di) + ln(Do/Di)/(2π kp) + ln(Ds/Do)/(2π kins) + R'out
//                        (Incropera & DeWitt 6th ed. eq. 3.33)
//   buried pipe          R'soil = cosh⁻¹(2z/D)/(2π ks)            (Incropera Table 4.1, case 2)
//   pipe in air          Churchill-Bernstein (eq. 7.54) and Churchill-Chu (eq. 9.34), Nu³ = NuF³ + NuN³
//                        (eq. 9.64), radiation ε σ (Ts² + Ta²)(Ts + Ta); air data Incropera Table A.4;
//                        the surface temperature is found here by bisection on the heat balance
//   decay                T(L) = Ta + (T0 − Ta)·exp(−UA·L/(ṁ cp))
//   J-T                  ΔT = 0.07 °F/psi × Δp (7 °F per 100 psi, GPSA gas rule)
//   hydrate              Towler & Mokhatab (2005): T = 13.47 ln P + 34.27 ln γ − 1.675 ln P ln γ − 20.35
//   mass flow            oil 5.614583·62.366·γo/24 lb/hr per BPD, gas 1e6/379.48·28.9647·γg/24 per MMSCFD
'use strict';

const WP = 'HEAT';

function rows(app) {
  return app.findAll('#lh_res .rrow').map((r) => {
    const l = r.querySelector('.rl'), v = r.querySelector('.rv');
    return { l: String(l ? l.textContent : '').trim(), v: String(v ? v.textContent : '').trim() };
  });
}
function rtext(app, label) { const r = rows(app).find((x) => x.l === label); return r ? r.v : null; }
function rv(app, label) {
  const t = rtext(app, label);
  if (t == null) throw new Error('no row ' + label + ': ' + JSON.stringify(rows(app).map((x) => x.l)));
  return parseFloat(t.replace(/,/g, '').match(/-?\d+(\.\d+)?/)[0]);
}
function errText(app) { return app.findAll('#lh_res .val-error').map((e) => e.textContent).join(' | '); }
function set(app, vals) {
  for (const k of Object.keys(vals)) {
    if (!app.el(k)) throw new Error('no input #' + k);
    if (app.el(k).tagName === 'SELECT') app.select(k, String(vals[k]));
    else app.input(k, String(vals[k]));
  }
}
function open(app) {
  const b = app.find('.nav-btn[data-p="lineheat"]');
  if (!b) throw new Error('no lineheat nav button');
  app.click(b);
  if (!app.el('lh_root')) throw new Error('lineheat page did not render');
}
const calc = (app) => app.click('lh_calc');
const S = (app) => app.win.WTS_state.lineheat;

// ── Hand calculation ─────────────────────────────────────────────────
const AIR = [[250, 11.44, 22.3, 0.720], [300, 15.89, 26.3, 0.707], [350, 20.92, 30.0, 0.700], [400, 26.41, 33.8, 0.690], [450, 32.39, 37.3, 0.686]];
function airAt(TK) {
  const T = Math.min(450, Math.max(250, TK));
  let i = 0; while (i < 3 && T > AIR[i + 1][0]) i++;
  const a = AIR[i], b = AIR[i + 1], f = (T - a[0]) / 50;
  return { nu: (a[1] + f * (b[1] - a[1])) * 1e-6, k: (a[2] + f * (b[2] - a[2])) * 1e-3, pr: a[3] + f * (b[3] - a[3]) };
}
const K = (F) => (F - 32) / 1.8 + 273.15;
function hOut(Dft, mph, TsF, TaF, eps) {
  const D = Dft * 0.3048, V = mph * 0.44704, Tf = (K(TsF) + K(TaF)) / 2, p = airAt(Tf);
  const Re = V * D / p.nu;
  const NuF = 0.3 + (0.62 * Re ** 0.5 * p.pr ** (1 / 3)) / (1 + (0.4 / p.pr) ** (2 / 3)) ** 0.25 * (1 + (Re / 282000) ** 0.625) ** 0.8;
  const Ra = 9.80665 / Tf * Math.abs(K(TsF) - K(TaF)) * D ** 3 / (p.nu * p.nu / p.pr);
  const NuN = (0.6 + 0.387 * Ra ** (1 / 6) / (1 + (0.559 / p.pr) ** (9 / 16)) ** (8 / 27)) ** 2;
  const hc = Math.cbrt(NuF ** 3 + NuN ** 3) * p.k / D / 5.678263;
  const a = TsF + 459.67, b = TaF + 459.67;
  return hc + eps * 0.1714e-8 * (a * a + b * b) * (a + b);
}
// UA' per ft for a pipe in air, surface temperature by bisection on q_in = q_out.
function uaAir(T, seg, e) {
  const Di = seg.di / 12, Do = seg.od / 12, Ds = seg.ds / 12;
  const Rin = (e.hi > 0 ? 1 / (e.hi * Math.PI * Di) : 0) + Math.log(Do / Di) / (2 * Math.PI * e.kp) +
    (Ds > Do ? Math.log(Ds / Do) / (2 * Math.PI * e.kins) : 0);
  let lo = Math.min(T, e.ta), hi = Math.max(T, e.ta);
  const g = (Ts) => (T - Ts) / Rin - (Ts - e.ta) * hOut(Ds, e.wind, Ts, e.ta, e.eps) * Math.PI * Ds;
  for (let k = 0; k < 200; k++) { const m = (lo + hi) / 2; if (g(lo) * g(m) <= 0) hi = m; else lo = m; }
  const Ts = (lo + hi) / 2;
  return 1 / (Rin + 1 / (hOut(Ds, e.wind, Ts, e.ta, e.eps) * Math.PI * Ds));
}
function marchAir(T0, len, seg, e, mcp) {
  let T = T0; const dx = len / 20;
  for (let k = 0; k < 20; k++) T = e.ta + (T - e.ta) * Math.exp(-uaAir(T, seg, e) * dx / mcp);
  return T;
}
const towler = (Ppsia, sg) => 13.47 * Math.log(Ppsia) + 34.27 * Math.log(sg) - 1.675 * Math.log(Ppsia) * Math.log(sg) - 20.35;
const BASE = { qo: 1000, qw: 200, qg: 5, api: 38, sgg: 0.7, sgw: 1.05, cpo: 0.5, cpw: 1.0, cpg: 0.55, p0: 2500, t0: 150,
  hi: '', kp: 26, kins: 0.025, eps: 0.9, tair: 40, wind: 15, tsoil: 50, ksoil: 0.7, jt: 0.07 };
function mcpHand(b) {
  const mo = b.qo * 5.614583 * 62.366 * (141.5 / (131.5 + b.api)) / 24, mw = b.qw * 5.614583 * 62.366 * b.sgw / 24;
  const mg = b.qg * 1e6 / (10.7316 * 519.67 / 14.696) * 28.9647 * b.sgg / 24;
  return { mo, mw, mg, mcp: mo * b.cpo + mw * b.cpw + mg * b.cpg };
}

module.exports = [
  {
    name: 'HEAT air properties (Incropera Table A.4) and the outside film coefficient against the hand correlations',
    wp: WP,
    run(app, assert) {
      const a = app.win.WTS_lineheat_air(300);
      assert.rel(a.nu, 15.89e-6, 1e-9); assert.rel(a.k, 0.0263, 1e-9); assert.rel(a.pr, 0.707, 1e-9);
      const a2 = app.win.WTS_lineheat_air(325);
      assert.rel(a2.k, (26.3 + 30.0) / 2 * 1e-3, 1e-9, 'linear interpolation');
      for (const c of [[3.5 / 12, 15, 120, 40, 0.9], [0.5, 0, 150, 40, 0], [1, 30, 60, 20, 0.5]]) {
        const h = app.win.WTS_lineheat_outsideH({ dFt: c[0], windMph: c[1], tsF: c[2], taF: c[3], eps: c[4] });
        assert.rel(h.h, hOut(c[0], c[1], c[2], c[3], c[4]), 1e-9, 'h ' + c.join('/'));
      }
      // Wind 15 mph on a 3.5 in pipe: forced convection dominates (Re ≈ 6e4)
      const h = app.win.WTS_lineheat_outsideH({ dFt: 3.5 / 12, windMph: 15, tsF: 60, taF: 40, eps: 0 });
      assert.within(h.re, 3.5e4, 5e4, 'Re = 6.71 m/s × 0.0889 m / 14.4e-6 m²/s ≈ 4.1e4');
      assert.ok(h.nuF > 5 * h.nuN, 'forced dominates');
    },
  },
  {
    name: 'HEAT bare and insulated pipe in air: UA and arrival temperature equal the hand calculation (bisection on Ts)',
    wp: WP,
    run(app, assert) {
      const C = app.win.WTS_lineheat_compute;
      const segs = [
        { name: 'bare', len: 500, od: 3.5, wall: 0.3, ins: '', type: 'bare', depth: '', dpc: '' },
        { name: 'ins', len: 2000, od: 3.5, wall: 0.3, ins: 1.5, type: 'ins', depth: '', dpc: '' },
      ];
      const b = Object.assign({}, BASE, { hi: 40 });
      const r = C(Object.assign({}, b, { segs }));
      assert.ok(r.ok, JSON.stringify(r.errors));
      const m = mcpHand(b);
      assert.rel(r.mo, m.mo, 1e-9); assert.rel(r.mg, m.mg, 1e-9); assert.rel(r.mcp, m.mcp, 1e-9, 'ṁ·cp');
      const e = { hi: 40, kp: 26, kins: 0.025, eps: 0.9, ta: 40, wind: 15 };
      const s1 = { di: 2.9, od: 3.5, ds: 3.5 }, s2 = { di: 2.9, od: 3.5, ds: 6.5 };
      assert.rel(r.segments[0].ua, uaAir(150, s1, e), 1e-6, 'bare UA at inlet');
      const t1 = marchAir(150, 500, s1, e, m.mcp);
      assert.rel(r.segments[0].tOut, t1, 1e-6, 'bare arrival ' + t1.toFixed(3));
      const t2 = marchAir(t1, 2000, s2, e, m.mcp);
      assert.rel(r.segments[1].tOut, t2, 1e-6, 'insulated arrival ' + t2.toFixed(3));
      // Insulation dominates: UA ≈ 2π kins / ln(Ds/Do) within 15 %
      assert.rel(r.segments[1].ua, 2 * Math.PI * 0.025 / Math.log(6.5 / 3.5), 0.15, 'insulation-controlled UA');
      assert.rel(r.segments[1].U, r.segments[1].ua / (Math.PI * 6.5 / 12), 1e-12, 'U on outer surface');
      // Heat lost = ṁ cp ΔT
      assert.rel(r.segments[0].q, m.mcp * (150 - t1), 1e-6);
      assert.ok(t1 < 150 && t1 > 40 && t2 < t1, 'cools toward ambient');
    },
  },
  {
    name: 'HEAT buried pipe (shape factor) closed form and JT + hydrate at a choke',
    wp: WP,
    run(app, assert) {
      const C = app.win.WTS_lineheat_compute;
      const b = Object.assign({}, BASE, { qo: 0, qg: 0, qw: 5000, sgw: 1.0 });
      const r = C(Object.assign({}, b, { segs: [{ name: 'b', len: 8000, od: 4.5, wall: 0.25, ins: 1, type: 'buried', depth: 4, dpc: '' }] }));
      assert.ok(r.ok, JSON.stringify(r.errors));
      const R = Math.log(4.5 / 4) / (2 * Math.PI * 26) + Math.log(6.5 / 4.5) / (2 * Math.PI * 0.025) + Math.acosh(2 * 4 / (6.5 / 12)) / (2 * Math.PI * 0.7);
      const mcp = 5000 * 5.614583 * 62.366 / 24;
      assert.rel(r.segments[0].ua, 1 / R, 1e-9, 'buried UA');
      assert.rel(r.tArr, 50 + 100 * Math.exp(-8000 / R / mcp), 1e-9, 'buried arrival (exact exponential)');
      // Choke: 1,500 psi × 0.07 °F/psi = 105 °F; hydrate at 1,014.696 psia, γ 0.7
      const r2 = C(Object.assign({}, BASE, { segs: [
        { name: 'up', len: 10, od: 3.5, wall: 0.3, type: 'bare' },
        { name: 'dn', len: 10, od: 3.5, wall: 0.3, type: 'bare', dpc: 1500 }] }));
      const s = r2.segments[1];
      assert.rel(s.jt, 105, 1e-12, 'J-T drop');
      assert.rel(s.tStart, r2.segments[0].tOut - 105, 1e-12);
      assert.rel(s.p, 1000, 1e-12);
      assert.rel(s.tHyd, towler(1014.696, 0.7), 1e-9, 'hydrate T ' + towler(1014.696, 0.7).toFixed(2));
      assert.within(s.tHyd, 62, 67, 'Katz chart ≈ 64 °F at 1,000 psia');
      assert.ok(s.risk && r2.hydrateRisk, 'hydrate risk flagged');
      assert.rel(r2.tIn, s.tStart, 1e-12, 'line inlet = downstream of the last choke');
      assert.rel(r2.segments[0].tHyd, towler(2514.696, 0.7), 1e-9);
    },
  },
  {
    name: 'HEAT page: default case, hydrate ✗ with link to Hydrate Management, chart, state',
    wp: WP,
    run(app, assert) {
      open(app);
      const st = S(app);
      assert.ok(st.ok);
      const r = st.result;
      assert.rel(rv(app, 'Arrival temperature'), r.tArr, 2e-3);
      assert.rel(r.segments[1].jt, 105, 1e-12);
      assert.ok(st.hydrateRisk, 'default case shows the hydrate risk');
      assert.includes(app.el('lh_res').textContent, '✗ Temperature falls below the hydrate temperature');
      assert.ok(app.canvasLog('lh_chart', 'lineTo').length > 20, 'temperature chart drawn');
      assert.ok(!/NaN|Infinity|undefined/.test(String(app.el('pgBody').textContent)));
      app.click('lh_gohyd');
      assert.ok(!app.el('lh_root'), 'left the page');
      assert.match(String(app.el('pgTitle').textContent), /Hydrate/);
      // Heat the stream: 1,000 psi choke only → no risk
      open(app);
      set(app, { lh_s2_dpc: 300, lh_t0: 180 }); calc(app);
      assert.ok(!S(app).hydrateRisk, 'no risk after the change');
      assert.includes(app.el('lh_res').textContent, '✓ Temperature stays');
    },
  },
  {
    name: 'HEAT validation: bad inputs, insulated without insulation, buried too shallow; clears on fix',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, { lh_kp: 0, lh_s3_ins: '', lh_s1_type: 'buried', lh_s1_depth: 0.1, lh_jt: 1 }); calc(app);
      const e = errText(app);
      assert.includes(e, 'Pipe wall conductivity');
      assert.includes(e, 'Segment 3: an insulated segment needs an insulation thickness');
      assert.includes(e, 'Segment 1: burial depth');
      assert.includes(e, 'Joule–Thomson');
      assert.ok(app.el('lh_s1_depth').classList.contains('input-err'));
      set(app, { lh_kp: 26, lh_s3_ins: 1.5, lh_s1_depth: 3, lh_jt: 0.07 }); calc(app);
      assert.strictEqual(app.findAll('#lh_root .input-err').length, 0);
      assert.ok(S(app).ok);
      set(app, { lh_s2_dpc: 3000 }); calc(app);
      assert.includes(errText(app), 'more than the inlet pressure');
    },
  },
  {
    name: 'HEAT metric: new unit categories, same physical answer, metric entry converts',
    wp: WP,
    run(app, assert) {
      open(app);
      const imp = S(app).tArr;
      const U = app.win.WTS_units;
      app.flush(10);
      U.setSystem('metric');
      try {
        open(app);
        const lab = (id) => String(app.el(id).closest('.fg-item').querySelector('label').textContent);
        assert.match(lab('lh_kp'), /W\/m·K/);
        assert.match(lab('lh_wind'), /m\/s/);
        assert.match(lab('lh_cpo'), /kJ\/kg·K/);
        assert.match(lab('lh_jt'), /°C\/bar/);
        assert.match(lab('lh_t0'), /°C/);
        assert.includes(app.el('lh_h_od').textContent, 'mm');
        assert.rel(Number(app.el('lh_jt').value), 0.07 * (5 / 9) / 0.0689476, 1e-3, '0.564 °C/bar');
        assert.rel(S(app).tArr, imp, 1e-3, 'same arrival temperature');
        assert.includes(rtext(app, 'Arrival temperature'), '°C');
        app.input('lh_wind', String(15 * 0.44704)); calc(app);
        assert.rel(S(app).tArr, imp, 1e-3, 'metric entry of wind');
      } finally { U.setSystem('imperial'); }
      assert.rel(S(app).tArr, imp, 1e-3);
      assert.match(String(app.el('lh_kp').closest('.fg-item').querySelector('label').textContent), /Btu/);
    },
  },
  {
    name: 'HEAT report + persistence + phone',
    wp: WP,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      open(app);
      set(app, { lh_wind: 5, lh_s1_type: 'ins', lh_s1_ins: 2 }); calc(app);
      const t = S(app).tArr;
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const rt = model.results.map((x) => x.title);
      ['Arrival Temperature', 'Segment Temperatures'].forEach((x) => assert.ok(rt.indexOf(x) !== -1, x + ': ' + rt.join(' | ')));
      const s = JSON.stringify(model);
      ['Wind speed', 'Joule–Thomson coefficient', 'Choke manifold to heater', 'Insulated, in air'].forEach((n) => assert.includes(s, n));
      const n0 = app.opened.length;
      app.win.exportPagePDF();
      const pdf = app.opened[n0] && app.opened[n0].html();
      assert.ok(pdf && pdf.indexOf('Line Heat Loss') !== -1 && pdf.indexOf('Segment Temperatures') !== -1, 'PDF');
      app.flush(1200);
      const rec = JSON.parse(app.storage.getItem('wts_page_lineheat') || 'null');
      assert.ok(rec && rec.f && rec.f.lh_wind === '5' && rec.f.lh_s1_type === 'ins', 'autosaved');
      assert.ok(!/width:\s*[4-9]\d\dpx|width:\s*\d{4,}px/.test(app.el('pgBody').innerHTML), 'no wide fixed widths');
      app.flushUntilIdle(10000);
      assert.strictEqual(app.pendingTimers(), 0);
      const app2 = app.reload();
      try {
        open(app2);
        assert.strictEqual(app2.el('lh_s1_type').value, 'ins');
        assert.rel(app2.win.WTS_state.lineheat.tArr, t, 1e-9, 'restored');
        app2.hook.nav('home');
        const titles = app2.findAll('.dash-card').map((c) => String(c.querySelector('h3').textContent).trim());
        assert.ok(titles.indexOf('Line Heat Loss & Arrival Temperature') !== -1, 'dashboard tile');
      } finally { app2.dispose(); }
    },
  },
];
