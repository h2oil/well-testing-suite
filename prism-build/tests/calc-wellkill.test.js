// Roadmap calculators #5 (Well Kill & Bullhead, route `wellkill`,
// prism-build/48-calc-wellkill.js) and #19 (liquid / mixed gradient,
// window.WTS_gradient_compute, a card on the same page), plus the shared
// tubular table (prism-build/40-calc-tubulars.js, window.WTS_tubulars).
//
// Expected values are independent hand calculations:
//   kill weight   KWF = Pres / (0.052·TVD) + OB / (0.052·TVD)          [ppg]
//   capacity      ID² / 1029.4 bbl/ft (1 bbl = 9702 in³)
//   MASP          0.052·(FG_EMW − ρ_column)·TVD                        [psi]
//   U-tube        0.052·(ρ_tubing − ρ_annulus)·TVD_packer              [psi]
//   gas column    P2 = P1·exp(0.01875·SG·L / (Z·T°R))                  [psia]
//   mixed column  explicit numerical integration of dp/dh (RK4, 1 ft steps)
'use strict';

const fs = require('fs');
const path = require('path');
const WP = 'KILL';

function rows(app, resId) {
  return app.findAll('#' + resId + ' .rrow').map((r) => {
    const l = r.querySelector('.rl'), v = r.querySelector('.rv');
    return { l: String(l ? l.textContent : '').trim(), v: String(v ? v.textContent : '').trim() };
  });
}
function rv(app, resId, label, nth) {
  const r = rows(app, resId).find((x) => x.l === label);
  if (!r) throw new Error('no result row "' + label + '" in #' + resId + ': ' + JSON.stringify(rows(app, resId).map((x) => x.l)));
  const nums = r.v.replace(/,/g, '').match(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi);
  if (!nums || nums[nth || 0] == null) throw new Error('row "' + label + '" has no number #' + (nth || 0) + ': ' + r.v);
  return parseFloat(nums[nth || 0]);
}
function rtext(app, resId, label) { const r = rows(app, resId).find((x) => x.l === label); return r ? r.v : null; }
function txt(app, id) { const e = app.el(id); return String(e ? e.textContent : '').trim(); }
function errText(app, resId) { return app.findAll('#' + resId + ' .val-error').map((e) => e.textContent).join(' | '); }
function noBadNumbers(assert, app, where) {
  const t = String(app.el('pgBody').textContent || '');
  assert.ok(!/NaN|Infinity|∞|undefined/.test(t), where + ': page shows NaN/Infinity/undefined');
}
function set(app, vals) {
  for (const k of Object.keys(vals)) {
    if (!app.el(k)) throw new Error('no input #' + k);
    if (app.el(k).tagName === 'SELECT') app.select(k, String(vals[k]));
    else app.input(k, String(vals[k]));
  }
}
function open(app) {
  const b = app.find('.nav-btn[data-p="wellkill"]');
  if (!b) throw new Error('no wellkill nav button');
  app.click(b);
  if (!app.el('wk_root')) throw new Error('wellkill page did not render');
}
const calc = (app) => app.click('wk_calc');
const S = (app) => app.win.WTS_state.wellkill;
const SG = (app) => app.win.WTS_state.gradient;

// Hand-calc helpers (independent of the module)
const cap = (id) => id * id / 1029.4;
const BASE = {
  pres: 5400, tvd: 10000, ob: 200, fg: 15, wf: 1.9, ann: 8.6, tub: 'tubing-2.875-6.5', cas: 'casing-7-29',
  pmd: 9800, ptvd: 9620, tmd: 10150, bmd: 10250, pbtd: 10400, to: 'top', od: 10, pump: 0.1, spm: 40,
};
function rk4Mixed(p0psia, len, hl, rho, sg, tF, z) {
  const gL = 0.052 * rho, TR = tF + 459.67;
  const f = (P) => hl * gL + (1 - hl) * 0.018743 * sg * P / (z * TR);
  let P = p0psia;
  for (let h = 0; h < len; h++) {
    const k1 = f(P), k2 = f(P + k1 / 2), k3 = f(P + k2 / 2), k4 = f(P + k3);
    P += (k1 + 2 * k2 + 2 * k3 + k4) / 6;
  }
  return P;
}

module.exports = [
  {
    name: 'KILL tubulars: WTS_tubulars covers the host casingData / tubingData with identical IDs, drift, wall and helpers',
    wp: WP,
    run(app, assert) {
      const T = app.win.WTS_tubulars;
      assert.ok(T && typeof T.find === 'function', 'WTS_tubulars');
      const html = fs.readFileSync(path.join(__dirname, '..', '..', 'well-testing-app.html'), 'utf8');
      // eslint-disable-next-line no-eval
      const cd = eval(html.match(/const casingData=(\[[\s\S]*?\]);/)[1]);
      // eslint-disable-next-line no-eval
      const td = eval(html.match(/const tubingData=(\[[\s\S]*?\]);/)[1]);
      assert.strictEqual(T.hostCasingKeys.length, cd.length, 'host casing rows');
      assert.strictEqual(T.hostTubingKeys.length, td.length, 'host tubing rows');
      cd.forEach((c, i) => {
        const e = T.find(T.hostCasingKeys[i]);
        assert.ok(e && e.od === c.od && e.wt === c.wt && e.id === c.id, 'casing ' + JSON.stringify(c));
        assert.ok(T.casing.some((x) => x.od === c.od && x.wt === c.wt && x.id === c.id), 'in casing list');
      });
      td.forEach((c, i) => {
        const e = T.find(T.hostTubingKeys[i]);
        assert.ok(e && e.od === c.od && e.wt === c.wt && e.id === c.id, 'tubing ' + JSON.stringify(c));
      });
      assert.ok(T.casing.length > cd.length && T.tubing.length > td.length, 'table extends the host rows');
      assert.ok(T.drillpipe.length >= 10 && T.liners.length >= 20, 'drill pipe and liners');
      T.all().forEach((e) => {
        assert.ok(e.id < e.od && Math.abs(e.wall - (e.od - e.id) / 2) < 1e-4, e.key + ' wall');
        if (e.type !== 'drillpipe') assert.ok(e.drift > 0 && e.drift < e.id, e.key + ' drift');
      });
      // API drift rules
      assert.rel(T.find('casing-9.625-47').drift, 8.525, 1e-9, '9-5/8 drift (5/32", API 5CT: 8.525")');
      assert.rel(T.find('casing-13.375-68').drift, 12.415 - 5 / 32, 1e-3, '13-3/8 drift (5/32")');
      assert.rel(T.find('tubing-2.375-4.7').drift, 1.901, 1e-9, '2-3/8 drift (3/32")');
      assert.rel(T.find('tubing-3.5-9.3').drift, 2.867, 1e-9, '3-1/2 drift (1/8")');
      assert.rel(T.find('casing-5.5-17').wall, 0.304, 1e-9, '5-1/2 17# wall');
      // Helpers vs ID²/1029.4
      assert.rel(T.capacity(6.276), cap(6.276), 1e-4, 'capacity');
      assert.rel(T.annularCapacity(8.681, 3.5), (8.681 ** 2 - 3.5 ** 2) / 1029.4, 1e-4, 'annular capacity');
      assert.rel(T.displacement(5, 4.276), (25 - 4.276 ** 2) / 1029.4, 1e-4, 'displacement');
      assert.rel(T.closedEndDisplacement(5), 25 / 1029.4, 1e-4, 'closed end');
      assert.rel(T.bblFtToM3m(1), 0.521612, 1e-5, 'bbl/ft → m³/m');
      assert.ok(isNaN(T.annularCapacity(4, 5)), 'pipe larger than hole → NaN');
      assert.strictEqual(T.find('nope'), null);
      assert.ok(!app.win.WTS_calcRegistry.tubulars, 'data module registers no page');
      assert.ok(!app.find('.nav-btn[data-p="tubulars"]'), 'no nav button for the data module');
    },
  },
  {
    name: 'KILL compute: kill weight, bullhead volumes, strokes, MASP, U-tube and brines match hand calculations',
    wp: WP,
    run(app, assert) {
      const W = app.win, C = (o) => W.WTS_wellkill_compute(Object.assign({}, BASE, o || {}));
      ['renderWellKill', 'calcWellKill', 'WTS_wellkill_compute', 'WTS_gradient_compute'].forEach((f) => assert.strictEqual(typeof W[f], 'function', f));
      const r = C();
      assert.ok(r.ok, 'base ok');
      // Kill weight = Pres/(0.052·TVD) + overbalance/(0.052·TVD)
      const kwf = 5400 / (0.052 * 10000) + 200 / (0.052 * 10000);
      assert.rel(r.kill.kwf, kwf, 1e-9, 'KWF');
      assert.rel(r.kill.balance, 10.3846, 1e-4, 'balance');
      assert.strictEqual(r.kill.used, 10.8, 'rounded up to 0.1 ppg');
      assert.rel(r.kill.sg, 10.8 / 8.33, 1e-9, 'SG');
      assert.rel(r.kill.kgm3, 1294.12, 1e-4, 'kg/m³');
      assert.rel(r.kill.hyd, 0.052 * 10.8 * 10000, 1e-9, 'hydrostatic');
      assert.rel(r.kill.obActual, 216, 1e-9, 'actual overbalance');
      // Volumes: tubing 2.441" ID × 9800 ft + 7" 29# 6.184" ID × 350 ft
      const vt = cap(2.441) * 9800, vc = cap(6.184) * 350, vp = cap(6.184) * 100, vr = cap(6.184) * 150;
      assert.rel(r.bullhead.sections[0].vol, vt, 1e-4, 'tubing vol');
      assert.rel(r.bullhead.sections[1].vol, vc, 1e-4, 'casing vol');
      assert.rel(r.bullhead.vol, vt + vc, 1e-4, 'bullhead to top perf');
      assert.rel(r.bullhead.vol, 69.73, 1e-3, '≈ 69.7 bbl');
      assert.rel(r.bullhead.pumped, (vt + vc) * 1.1, 1e-4, '+10 %');
      assert.rel(r.bullhead.strokes, (vt + vc) * 1.1 / 0.1, 1e-4, 'strokes');
      assert.rel(r.bullhead.minutes, (vt + vc) * 1.1 / 0.1 / 40, 1e-4, 'minutes');
      assert.rel(C({ to: 'bot' }).bullhead.vol, vt + vc + vp, 1e-4, 'to bottom perf');
      assert.rel(C({ to: 'pbtd' }).bullhead.vol, vt + vc + vp + vr, 1e-4, 'to PBTD with rathole');
      assert.strictEqual(C({ spm: '' }).bullhead.minutes, null, 'no time without pump speed');
      // MASP = 0.052·(FG − ρ)·TVD
      assert.rel(r.limits.pFrac, 7800, 1e-9, 'frac pressure');
      assert.rel(r.limits.sithp, 5400 - 0.052 * 1.9 * 10000, 1e-9, 'SITHP');
      assert.rel(r.limits.maspStart, 0.052 * (15 - 1.9) * 10000, 1e-9, 'MASP start');
      assert.rel(r.limits.maspEnd, 0.052 * (15 - 10.8) * 10000, 1e-9, 'MASP end');
      assert.strictEqual(r.limits.endReq, 0, 'dead at end');
      const sch = r.bullhead.schedule;
      assert.strictEqual(sch.length, 11);
      assert.rel(sch[0].sitp, 4412, 1e-9); assert.rel(sch[10].masp, 2184, 1e-9);
      assert.rel(sch[10].frontMd, 10150, 1e-9, 'front at top perf');
      // Shoe: 12 ppg EMW at 6000 ft TVD governs
      const s = C({ stvd: 6000, sfg: 12 });
      assert.rel(s.limits.shoe.start, 0.052 * (12 - 1.9) * 6000, 1e-9, 'shoe start');
      assert.rel(s.limits.shoe.end, 0.052 * (12 - 10.8) * 6000, 1e-9, 'shoe end');
      assert.rel(s.limits.maspEnd, 374.4, 1e-9, 'shoe governs the end');
      assert.strictEqual(s.limits.governs, 'shoe');
      // U-tube and fluid level
      assert.rel(r.utube.dp, 0.052 * (10.8 - 8.6) * 9620, 1e-9, 'U-tube');
      assert.strictEqual(r.utube.heavier, 'tubing');
      assert.rel(r.utube.level, 10000 - 5400 / (0.052 * 10.8), 1e-9, 'fluid level');
      const light = C({ kwo: 10, ann: 11 });
      assert.ok(light.kill.belowBalance && !light.utube.onVacuum && light.utube.heavier === 'annulus', 'below balance, annulus heavier');
      // Brines
      assert.deepStrictEqual(Array.from(r.brineList), ['Na formate', 'CaCl2', 'NaBr', 'K formate']);
      assert.ok(r.brines.find((b) => b.name === 'Sodium chloride, NaCl').reaches === false, 'NaCl 10.0 does not reach 10.8');
      const heavy = C({ pres: 10500, ob: 300 });   // 20.77 ppg
      assert.ok(heavy.ok && !heavy.brineOk && heavy.limits.killFracs, 'beyond clear brines and above the fracture gradient');
      const tight = C({ pres: 7100 });             // window = pFrac − Pres = 700 psi
      assert.ok(tight.limits.windowStart > 0 && tight.limits.windowStart < 780, 'narrow window');
      // Validation returns errors, never NaN
      const bad = [C({ pres: 0 }), C({ tvd: -1 }), C({ fg: 1 }), C({ tub: 'x' }), C({ tub: 'casing-7-29', cas: 'casing-7-29' }),
        C({ tmd: 9000 }), C({ bmd: 10000 }), C({ pbtd: 10200 }), C({ pump: 0 }), C({ od: 150 }), C({ stvd: 5000 }), C({ ptvd: 9900 })];
      bad.forEach((b, i) => { assert.strictEqual(b.ok, false, 'bad ' + i); assert.ok(b.errors.length > 0 && b.bad.length > 0, 'bad ' + i + ' errors'); });
      assert.deepStrictEqual(Array.from(C({ stvd: 5000 }).bad), ['sfg'], 'shoe TVD without gradient');
    },
  },
  {
    name: 'KILL gradient: liquid, gas (average Z), mixed column and bottomhole → surface match hand calculations',
    wp: WP,
    run(app, assert) {
      const Gc = app.win.WTS_gradient_compute;
      const base = { dir: 's2b', p: 1500, tvd: 10000, gasLen: 0, mixLen: 0, hl: 40, rho: 8.6, sg: 0.65, t: 150, z: 0.9 };
      const C = (o) => Gc(Object.assign({}, base, o || {}));
      // Liquid only
      const l = C();
      assert.rel(l.pBot, 1500 + 0.052 * 8.6 * 10000, 1e-9, 'liquid column');
      assert.rel(l.avgGrad, 0.4472, 1e-9, 'avg gradient');
      // Gas only (P in psia, T in °R)
      const g = C({ gasLen: 10000 });
      const pg = (1500 + 14.696) * Math.exp(0.01875 * 0.65 * 10000 / (0.9 * 609.67)) - 14.696;
      assert.rel(g.pBot, pg, 2e-4, 'gas column');
      assert.rel(g.gasGradSurf, 0.01875 * 0.65 * 1514.696 / (0.9 * 609.67), 2e-3, 'gas gradient at surface');
      // Gas cap + mixed + liquid
      const m = C({ gasLen: 2000, mixLen: 1000 });
      const p1 = (1514.696) * Math.exp(0.018743 * 0.65 * 2000 / (0.9 * 609.67));
      const p2 = rk4Mixed(p1, 1000, 0.4, 8.6, 0.65, 150, 0.9);
      const p3 = p2 + 0.052 * 8.6 * 7000 - 14.696;
      assert.rel(m.sections[0].pBot, p1 - 14.696, 1e-5, 'gas cap bottom');
      assert.rel(m.sections[1].pBot, p2 - 14.696, 1e-6, 'mixed bottom (RK4)');
      assert.rel(m.pBot, p3, 1e-6, 'bottomhole');
      assert.rel(m.liqLen, 7000, 1e-12);
      // Bottomhole → surface inverts it
      const b = C({ dir: 'b2s', p: m.pBot, gasLen: 2000, mixLen: 1000 });
      assert.rel(b.pSurf, 1500, 1e-9, 'round trip');
      assert.rel(C({ dir: 'b2s', p: 5000 }).pSurf, 5000 - 4472, 1e-9, 'liquid b2s');
      // Bottomhole too low for a full liquid column
      const low = C({ dir: 'b2s', p: 5190, rho: 10 });     // 5204.7 psia − 5200 psi = 4.7 psia
      assert.ok(low.ok && low.pSurf < 0, 'sub-atmospheric surface flagged by value');
      const tooLow = C({ dir: 'b2s', p: 1000, rho: 10 });
      assert.strictEqual(tooLow.ok, false, 'column cannot reach surface');
      // Validation
      [C({ tvd: 0 }), C({ gasLen: 8000, mixLen: 3000 }), C({ hl: 120 }), C({ z: 0 }), C({ sg: 0.3 }), C({ rho: 0 })]
        .forEach((x, i) => assert.ok(x.ok === false && x.errors.length > 0, 'bad ' + i));
    },
  },
  {
    name: 'KILL page: registry nav in Test System Safety, defaults compute, rows, tables and verdicts through the DOM',
    wp: WP,
    run(app, assert) {
      const b = app.find('.nav-btn[data-p="wellkill"]');
      assert.ok(b, 'sidebar button');
      assert.strictEqual(String(b.closest('.nav-group').querySelector('.nav-group-label').textContent).trim(), 'Test System Safety');
      open(app);
      assert.strictEqual(txt(app, 'pgTitle'), 'Well Kill & Bullhead');
      assert.match(txt(app, 'pgSub'), /Kill-weight fluid, bullhead volumes/);
      assert.rel(S(app).kwf, 10.7692, 1e-4, 'default KWF');
      assert.strictEqual(S(app).kwfUsed, 10.8);
      assert.rel(S(app).bullheadVol, 69.73, 1e-3, 'default bullhead');
      assert.rel(rv(app, 'wk_res', 'Kill weight', 0), 10.77, 1e-9, 'KWF row');
      assert.rel(rv(app, 'wk_res', 'Kill weight', 1), 1.293, 1e-9, 'SG in row');
      assert.rel(rv(app, 'wk_res', 'Kill fluid used', 2), 1294, 1e-9, 'kg/m³ in row');
      assert.rel(rv(app, 'wk_res', 'Bullhead volume to top perforation'), 69.7, 1e-9);
      assert.rel(rv(app, 'wk_res', 'Total to pump'), 76.7, 1e-9);
      assert.rel(rv(app, 'wk_res', 'Pump strokes'), 767, 1e-9);
      assert.rel(rv(app, 'wk_res', 'Pumping time'), 19.2, 1e-9);
      assert.rel(rv(app, 'wk_res', 'Max surface pressure at start'), 6812, 1e-9);
      assert.rel(rv(app, 'wk_res', 'Max surface pressure at end'), 2184, 1e-9);
      assert.rel(rv(app, 'wk_res', 'Pressure difference at packer, tubing minus annulus'), 1101, 1e-9);
      assert.rel(rv(app, 'wk_res', 'Kill fluid gradient'), 0.5616, 1e-9);
      const t = txt(app, 'wk_res');
      assert.includes(t, '✓ Kill fluid gives 216 psi overbalance');
      assert.includes(t, '✓ Bullhead window at the start is 2,400 psi');
      assert.includes(t, '⚠ Kill fluid is heavier than the annulus fluid');
      assert.includes(t, '⚠ If the formation takes fluid, the tubing will go on vacuum');
      assert.includes(t, '✓ Clear brines that reach 10.80 ppg: Na formate, CaCl2, NaBr, K formate.');
      assert.strictEqual(app.findAll('#wk_res table.dtable').length, 3, 'section, schedule and brine tables');
      assert.strictEqual(app.findAll('#wk_res table.dtable')[2].querySelectorAll('tbody tr').length, 12, 'brine rows');
      // Gradient card defaults
      assert.rel(SG(app).pBot, 4900.49, 1e-5, 'gradient default');
      assert.rel(rv(app, 'wk_gres', 'Bottomhole pressure'), 4900.5, 1e-9);
      // Selects drive the volume
      set(app, { wk_to: 'pbtd' }); calc(app);
      assert.rel(S(app).bullheadVol, cap(2.441) * 9800 + cap(6.184) * 600, 1e-4, 'to PBTD');
      set(app, { wk_tub: 'tubing-3.5-9.3', wk_cas: 'liner-7-29', wk_to: 'top' }); calc(app);
      assert.rel(S(app).bullheadVol, cap(2.992) * 9800 + cap(6.184) * 350, 1e-4, '3-1/2" tubing in a 7" liner');
      assert.includes(rtext(app, 'wk_res', 'Casing / liner below packer'), 'liner');
      // Override density and shoe
      set(app, { wk_kwo: 11.5, wk_stvd: 6000, wk_sfg: 12 }); calc(app);
      assert.strictEqual(S(app).kwfUsed, 11.5);
      assert.rel(S(app).maspEnd, 0.052 * (12 - 11.5) * 6000, 1e-9, 'shoe governs');
      assert.strictEqual(rtext(app, 'wk_res', 'Governing limit'), 'casing shoe');
      // Heavy: beyond brines, over fracture gradient
      set(app, { wk_kwo: '', wk_stvd: '', wk_sfg: '', wk_pres: 10500, wk_ob: 300 }); calc(app);
      const t2 = txt(app, 'wk_res');
      assert.includes(t2, '✗ Kill fluid gradient is at or above the fracture gradient');
      assert.includes(t2, '✗ No clear brine in the guide reaches 20.80 ppg');
      noBadNumbers(assert, app, 'cases');
      // Gradient b2s through the DOM
      set(app, { wk_gdir: 'b2s', wk_gp: 4900.491403378863 }); app.click('wk_gcalc');
      assert.rel(SG(app).pSurf, 1500, 1e-6, 'b2s');
    },
  },
  {
    name: 'KILL validation: bad inputs are listed and flagged, never NaN; the gradient card is independent',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, { wk_pres: 0, wk_tmd: 9000, wk_pump: 0 }); calc(app);
      const e = errText(app, 'wk_res');
      assert.includes(e, 'Reservoir pressure must be above 0');
      assert.includes(e, 'Top perforation MD must be at or below the packer MD');
      assert.includes(e, 'Pump output must be between 0.001 bbl and 2 bbl per stroke');
      ['wk_pres', 'wk_tmd', 'wk_pump'].forEach((id) => assert.ok(app.el(id).classList.contains('input-err'), id + ' flagged'));
      assert.ok(!app.el('wk_tvd').classList.contains('input-err'), 'valid input not flagged');
      assert.strictEqual(S(app).kwf, null);
      assert.rel(SG(app).pBot, 4900.49, 1e-5, 'gradient card still computes');
      set(app, { wk_pres: 5400, wk_tmd: 10150, wk_pump: 0.1, wk_tub: 'casing-7-29' }); calc(app);
      assert.includes(errText(app, 'wk_res'), 'Tubing OD does not fit');
      set(app, { wk_tub: 'tubing-2.875-6.5', wk_glen: 9000, wk_gmix: 2000, wk_gz: 0 }); calc(app);
      assert.ok(S(app).kwf > 0, 'kill card back');
      const ge = errText(app, 'wk_gres');
      assert.includes(ge, 'cannot exceed the column TVD');
      assert.includes(ge, 'Z-factor');
      noBadNumbers(assert, app, 'validation');
      set(app, { wk_glen: 2000, wk_gmix: 1000, wk_gz: 0.9 }); calc(app);
      assert.strictEqual(app.findAll('#wk_root .input-err').length, 0, 'flags cleared');
      assert.strictEqual(app.findAll('#wk_root .val-error').length, 0, 'errors cleared');
    },
  },
  {
    name: 'KILL metric: tagged labels switch, state equals the imperial run, metric entry converts, unit flip recalculates',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, { wk_stvd: 6000, wk_sfg: 12.5 }); calc(app);
      const imp = Object.assign({}, S(app)), impG = Object.assign({}, SG(app));
      const U = app.win.WTS_units;
      app.flush(10);
      U.setSystem('metric');
      try {
        open(app);
        const lab = (id) => String(app.el(id).closest('.fg-item').querySelector('label').textContent);
        assert.match(lab('wk_pres'), /\(kPa\)/);
        assert.match(lab('wk_tvd'), /\(m\)/);
        assert.match(lab('wk_fg'), /EMW \(kg\/L\)/);
        assert.match(lab('wk_pump'), /\(m³\)/);
        assert.match(lab('wk_gp'), /\(kPa\(g\)\)|kPa/);
        // Restored densities come back through kg/L shown to 4 dp (±0.0008 ppg), so a small
        // difference of two large numbers (MASP at the end) carries up to ~1e-3 relative.
        ['kwf', 'kwfUsed', 'bullheadVol', 'pumpedVol', 'strokes', 'maspStart'].forEach((k) => assert.rel(S(app)[k], imp[k], 1e-4, 'metric ' + k));
        assert.rel(S(app).maspEnd, imp.maspEnd, 1e-3, 'metric maspEnd');
        ['pSurf', 'pBot', 'avgGrad'].forEach((k) => assert.rel(SG(app)[k], impG[k], 1e-4, 'metric gradient ' + k));
        assert.includes(rtext(app, 'wk_res', 'Max surface pressure at start'), 'kPa');
        assert.includes(rtext(app, 'wk_res', 'Total to pump'), 'm³');
        assert.includes(rtext(app, 'wk_res', 'Kill fluid gradient'), 'kPa/m');
        assert.includes(rtext(app, 'wk_res', 'Kill weight'), 'ppg · SG');
        // Metric entry: 3048 m TVD, 37232 kPa reservoir pressure
        app.input('wk_tvd', '3048'); app.input('wk_pres', String(5400 * 6.89476)); calc(app);
        assert.rel(S(app).kwf, imp.kwf, 1e-4, 'metric entry converted');
        set(app, { wk_pres: 0 }); calc(app);
        assert.includes(errText(app, 'wk_res'), 'kPa', 'limit shown in display units');
        set(app, { wk_pres: String(5400 * 6.89476) }); calc(app);
      } finally { U.setSystem('imperial'); }
      assert.rel(S(app).kwf, imp.kwf, 1e-4, 'recalc after flip keeps the physical value');
      assert.match(String(app.el('wk_pres').closest('.fg-item').querySelector('label').textContent), /\(psi\)/);
      assert.includes(rtext(app, 'wk_res', 'Max surface pressure at start'), 'psi');
    },
  },
  {
    name: 'KILL report + persistence: report sections, PDF, Quick Report, autosave restore after reload, no timers',
    wp: WP,
    run(app, assert) {
      open(app);
      set(app, { wk_pres: 6000, wk_to: 'bot' }); calc(app);
      const kwf = S(app).kwf;
      assert.rel(kwf, 6200 / 520, 1e-9);
      const model = app.win.collectPageReport(app.el('pgBody'), { charts: false });
      const s = JSON.stringify(model);
      assert.ok(model.inputs.length >= 3, 'input sections: ' + model.inputs.map((x) => x.title).join(' | '));
      const rt = model.results.map((x) => x.title);
      ['Kill Fluid', 'Bullhead Volume', 'Surface Pressure Limits', 'U-tube Check', 'Brine Selection Guide', 'Column Pressures']
        .forEach((t) => assert.ok(rt.indexOf(t) !== -1, 'results section ' + t + ': ' + rt.join(' | ')));
      ['Reservoir pressure at top perforation', 'Displace to', 'Bottom perforation', 'Clear brines that reach'].forEach((n) => assert.includes(s, n));
      // (The harness DOM has no table.rows, so table capture is checked in a real browser; here the DOM tables.)
      assert.includes(txt(app, 'wk_res'), 'Calcium chloride, CaCl2');
      const n0 = app.opened.length;
      app.win.exportPagePDF();
      const pdf = app.opened[n0] && app.opened[n0].html();
      assert.ok(pdf && pdf.indexOf('Well Kill') !== -1 && pdf.indexOf('Brine Selection Guide') !== -1, 'PDF has title and sections');
      app.flush(1200);
      const rec = JSON.parse(app.storage.getItem('wts_page_wellkill') || 'null');
      assert.ok(rec && rec.f && rec.f.wk_pres === '6000' && rec.f.wk_to === 'bot', 'autosaved: ' + JSON.stringify(rec && rec.f));
      const n1 = app.opened.length;
      app.win.WTS_exportJobReport();
      const job = app.opened[n1] && app.opened[n1].html();
      assert.ok(job && job.indexOf('Well Kill') !== -1, 'Quick Report includes the page');
      app.flushUntilIdle(10000);
      assert.strictEqual(app.pendingTimers(), 0, 'no timers left');
      const app2 = app.reload();
      try {
        open(app2);
        assert.strictEqual(app2.el('wk_pres').value, '6000', 'restored');
        assert.strictEqual(app2.el('wk_to').value, 'bot', 'select restored');
        assert.rel(app2.win.WTS_state.wellkill.kwf, kwf, 1e-9, 'recalculated on restore');
        app2.flushUntilIdle(10000);
        assert.strictEqual(app2.pendingTimers(), 0, 'no timers after reload');
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'KILL phone: renders at 375 px with every result card and a dashboard tile',
    wp: WP,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      open(app);
      assert.ok(app.el('wk_res').querySelector('.rrow') && app.el('wk_gres').querySelector('.rrow'), 'results rendered');
      assert.ok(!/width:\s*[4-9]\d\dpx|width:\s*\d{4,}px/.test(app.el('pgBody').innerHTML), 'no fixed widths above 340 px');
      app.hook.nav('home');
      const titles = app.findAll('.dash-card').map((c) => String(c.querySelector('h3').textContent).trim());
      assert.ok(titles.indexOf('Well Kill & Bullhead') !== -1, 'dashboard tile');
    },
  },
];
