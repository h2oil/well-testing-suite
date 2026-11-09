// Well Test Simulator — release 4.1 (WTS_sim code comments v1.7.0): the LP flare line of the surge-tank gas, FT-201 / FQI-201
// and GOR1 / GOR2 / total (lpgas design §1–3; INTEGRATION E3, C1, C3, C9). The engine runs in its own vm context
// (tests/_wts-equip-shapes.js loadEngine); identity is against the frozen v3.3.1 (legacyOpts) and v3.4.1 (v341Opts) engines.
'use strict';

const X = require('./_wts-equip-shapes');
const LPX = require('./_wts-lp-shapes');
const { legacyOpts, v341Opts } = require('./_wts-lineup-pin.js');

const WP = 'WTSLP';
const J = (o) => JSON.parse(JSON.stringify(o));
let W0 = null;
const work = () => (W0 = W0 || X.loadEngine('work'));
const st = (sim) => J(sim.getState());
function run(sim, secs, dt, cb) {
  const n = Math.round(secs / dt);
  for (let i = 0; i < n; i++) { sim.advance(dt); if (cb && cb(st(sim), i)) return true; }
  return false;
}
const active = (s, id) => s.alarms.some((a) => a.id === id);
function oldPathsDiff(a, b, p, out) {
  if (out.length > 6) return out;
  if (a === null || typeof a !== 'object') {
    if (!(a === b || (typeof a === 'number' && a !== a && b !== b))) out.push(p + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b));
    return out;
  }
  if (b === null || typeof b !== 'object') { out.push(p + ': not an object'); return out; }
  if (Array.isArray(a) && (!Array.isArray(b) || a.length !== b.length)) { out.push(p + ': length'); return out; }
  Object.keys(a).forEach((k) => oldPathsDiff(a[k], b[k], p + '.' + k, out));
  return out;
}
function finiteBad(o, nullable, p, bad) {
  p = p || ''; bad = bad || [];
  if (o === null) { if (nullable.indexOf(p.replace(/\[\d+\]/g, '[*]')) < 0) bad.push(p + '=null'); return bad; }
  if (o === undefined) { bad.push(p + '=undefined'); return bad; }
  if (typeof o === 'number') { if (!isFinite(o)) bad.push(p + '=' + o); return bad; }
  if (Array.isArray(o)) { o.forEach((v, i) => finiteBad(v, nullable, p + '[' + i + ']', bad)); return bad; }
  if (typeof o === 'object') Object.keys(o).forEach((k) => finiteBad(o[k], nullable, p ? p + '.' + k : k, bad));
  return bad;
}
function mk(o) {
  o = o || {};
  const S = work(), f = J(S.SAMPLE_FLOW);
  Object.assign(f.inputs, o.inputs || {}); Object.assign(f.sim, o.sim || {});
  const opts = { seed: o.seed || 3 };
  if (o.rigup) opts.rigup = o.rigup;
  if (o.config) opts.config = o.config;
  return S.create(f, opts);
}
function pairIdentity(Fz, opts, setup, secs, assert, tag, pinFn) {
  const a = Fz.create(Fz.SAMPLE_FLOW, Object.assign({ seed: 14 }, opts)), b = work().create(work().SAMPLE_FLOW, pinFn(Object.assign({ seed: 14 }, opts)));
  if (setup) { setup(a); setup(b); }
  for (let t = 0; t < secs; t += 10) {
    a.advance(10); b.advance(10);
    if (t % 600 === 0) { const d = X.identityDiff(J(a.getState()), J(b.getState()), 6); assert.ok(d.length === 0, tag + ' t ' + t + ': ' + d.join(' | ')); }
  }
  assert.strictEqual(J(b.getState()).alarmLog.map((e) => e.msg).join('\n'), J(a.getState()).alarmLog.map((e) => e.msg).join('\n'), tag + ': alarm log');
}

module.exports = [
  {
    name: 'WTSLP (1) contract: DEFAULTS.surge.vent, exports SURGE_VENT_DEF / SURGE_VENT_LEGACY / LP_METERS, features.lpFlare, TAGS, NULLABLE, HIST keys, the snap.lp block',
    wp: WP, opts: false,
    run(app, assert) {
      const S = work();
      assert.deepStrictEqual(J(S.DEFAULTS.surge.vent), LPX.DEFAULTS_VENT, 'DEFAULTS.surge.vent');
      assert.deepStrictEqual(J(S.SURGE_VENT_DEF), LPX.DEFAULTS_VENT); assert.deepStrictEqual(J(S.SURGE_VENT_LEGACY), LPX.VENT_LEGACY);
      assert.deepStrictEqual(J(S.LP_METERS), LPX.LP_METERS, 'LP_METERS');
      assert.strictEqual(S.features.lpFlare, true);
      Object.keys(LPX.TAGS_NEW).forEach((k) => assert.strictEqual(S.TAGS[k], LPX.TAGS_NEW[k], 'TAGS.' + k));
      LPX.NULLABLE_NEW.forEach((p) => assert.ok(S.NULLABLE.indexOf(p) >= 0, 'NULLABLE ' + p));
      LPX.HIST_KEYS_NEW.forEach((k) => assert.ok(S.HIST_KEYS.indexOf(k) >= 0, 'HIST ' + k));
      const s = st(mk());
      assert.deepStrictEqual(Object.keys(s.lp), LPX.LP_KEYS, 'snap.lp keys');
      assert.deepStrictEqual(Object.keys(s.lp.sources), LPX.LP_SOURCES);
      LPX.RATES_NEW.forEach((k) => assert.ok(k in s.rates, 'rates.' + k)); LPX.CUM_NEW.forEach((k) => assert.ok(k in s.cum, 'cum.' + k));
      LPX.FLARE_NODE_NEW.forEach((k) => assert.ok(typeof s.nodes.flare[k] === 'number', 'nodes.flare.' + k));
      assert.ok(s.lines.lp_flare && s.lines.lp_flare.unit === 'MMSCFD' && s.lines.lp_flare.phase === 'gas', 'lines.lp_flare');
      Object.keys(LPX.EX_LP).forEach((k) => { if (typeof LPX.EX_LP[k] === 'string' || typeof LPX.EX_LP[k] === 'boolean') assert.strictEqual(s.lp[k], LPX.EX_LP[k], 'lp.' + k); });
      assert.ok(Math.abs(s.lp.q_mscfd - LPX.SAMPLE.qFlashD_mscfd) < 0.01 && Math.abs(s.lp.P_in_psig - LPX.EX_LP.P_in_psig) < 0.002, 'steady start q / P_in');
      const I = mk()._internal().lp.LP;
      assert.ok(Math.abs(I.qD * 86.4 - LPX.SAMPLE.lpDesign_mscfd) < 0.05 && Math.abs(I.P2d - LPX.SAMPLE.P2d_psig) < 0.002 && I.bpA === LPX.SAMPLE.bpAlarm_psig, 'design ' + JSON.stringify(I));
      const h = st(mk({ config: { surge: { vent: { to: 'hp' } } } }));
      assert.deepStrictEqual(h.lp, J(LPX.EX_LP_OFF), 'hp: the static block');
      assert.ok(h.rates.gor2_scf_stb === null && h.rates.gorTot_scf_stb === h.rates.gor_scf_stb && h.nodes.flare.qLP_mmscfd === 0, 'hp rates / flare');
    },
  },
  {
    name: 'WTSLP (1) identity: vent hp + the line-up pin === frozen v3.3.1 (default, T-201 out, T-202 both, DS-101 + sand); vent hp === frozen v3.4.1 on the default line-up',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const V331 = X.loadEngine('v331'), V341 = X.loadEngine('v341');
      pairIdentity(V331, {}, null, 7200, assert, 'v331 default', legacyOpts);
      pairIdentity(V331, { rigup: { surge: false } }, null, 3600, assert, 'v331 T-201 out', legacyOpts);
      pairIdentity(V331, { rigup: { surge2: true } }, (s) => s.setSurgeRoute('both'), 3600, assert, 'v331 T-202 both', legacyOpts);
      pairIdentity(V331, { rigup: { desander: true } }, (s) => s.setFault('sandFlowback', true), 3600, assert, 'v331 DS-101', legacyOpts);
      pairIdentity(V341, {}, null, 7200, assert, 'v341 default', v341Opts);
      pairIdentity(V341, { rigup: { surge2: true } }, (s) => s.setSurgeRoute('both'), 3600, assert, 'v341 T-202 both', v341Opts);
    },
  },
  {
    name: 'WTSLP (2) default engine: LP flow = PCV-201 + PSV-201 (+ T-202), flare node = HP + LP tips, balances; 2 h: GOR2 = FT-201 ÷ oil, total within 2 % of v3.4.1, P_in < 1 psig on average, T-201 at SP',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const sim = mk({ seed: 14 }), V341 = X.loadEngine('v341'), ref = V341.create(V341.SAMPLE_FLOW, { seed: 14 });
      let sumP = 0, sumPu = 0, n = 0, maxP = 0;
      run(sim, 7200, 10, (s) => {
        n++; sumP += s.lp.P_in_psig; sumPu += s.surge.P; maxP = Math.max(maxP, s.lp.P_in_psig);
        assert.ok(Math.abs(s.lp.q_mscfd - (s.lp.sources.t201 + s.lp.sources.t202 + s.lp.sources.psv)) < 1e-9, 'LP flow = its sources');
        assert.ok(Math.abs(s.nodes.flare.qMMscfd - (s.nodes.flare.qHP_mmscfd + s.nodes.flare.qLP_mmscfd)) < 1e-12, 'flare = HP + LP');
        return false;
      });
      for (let i = 0; i < 720; i++) ref.advance(10);
      const s = st(sim), r = J(ref.getState()), m = s.health.massErr;
      assert.ok(Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9, 'balances ' + JSON.stringify(m));
      const oil = s.rates.oil_stbd;
      assert.ok(Math.abs(s.rates.gor2_scf_stb - s.rates.lpGas_mscfd * 1000 / oil) < 1e-9 && Math.abs(s.rates.gor1_scf_stb - s.rates.gas_mmscfd * 1e6 / oil) < 1e-6, 'GOR1 / GOR2 = meters ÷ oil');
      assert.strictEqual(s.rates.gor_scf_stb, s.rates.gorTot_scf_stb, 'gor_scf_stb = the total');
      assert.ok(Math.abs(s.rates.gorTot_scf_stb / r.rates.gor_scf_stb - 1) < 0.02, 'total within 2 % of v3.4.1: ' + s.rates.gorTot_scf_stb + ' vs ' + r.rates.gor_scf_stb);
      assert.ok(Math.abs(s.rates.gor1_scf_stb / (r.rates.gas_mmscfd * 1e6 / r.rates.oil_stbd) - 1) < 0.005, 'GOR1 within 0.5 % of the v3.4.1 separator GOR');
      assert.ok(sumP / n < 1 && maxP < LPX.SAMPLE.bpAlarm_psig, 'P_in mean ' + (sumP / n) + ', max ' + maxP);
      assert.ok(Math.abs(sumPu / n - 25) < 0.5, 'T-201 holds its SP: ' + (sumPu / n));
      assert.ok(s.cum.lpGas_mscf > 0 && s.cum.lpGas_mscf * 1e3 <= s.cum.flare_mmscf * 1e6, 'cum.lpGas within cum.flare');
      const I = sim._internal().lp;
      assert.ok(Math.abs(I.Plp - I.target) < 2, 'P_in follows the LP line law (lag ± ' + (I.Plp - I.target) + ')');
      ['qgLP', 'gor1', 'gor2'].forEach((k) => { const hh = sim.getHistory(k); assert.ok(hh.y.length > 0 && hh.y.every(isFinite), 'history ' + k); });
    },
  },
  {
    name: 'WTSLP (3) back pressure: a 0.5" line raises PAH_LP and VEL_LP; a 4" line gives a lower P_in than 3"; PSV-201 lifting relieves into the LP line (psvIn, sources.psv)',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const small = mk({ config: { surge: { vent: { ID_in: 0.5 } }, noise: { on: false } } });
      assert.ok(run(small, 3600, 5, (s) => active(s, 'PAH_LP') && active(s, 'VEL_LP')), 'PAH_LP and VEL_LP');
      const s = st(small), a = s.alarms.find((x) => x.id === 'PAH_LP');
      assert.ok(a.tag === 'FT-201' && /PAH-LP FT-201 LP flare line back pressure/.test(a.msg), a.msg);
      const f3 = mk({ seed: 7 }), f4 = mk({ seed: 7, sim: { lpNps: 4 } });
      let p3 = 0, p4 = 0;
      run(f3, 1800, 10, (x) => { p3 += x.lp.P_in_psig; }); run(f4, 1800, 10, (x) => { p4 += x.lp.P_in_psig; });
      assert.ok(st(f4).lp.nps === 4 && st(f4).lp.ID_in === 4.026 && p4 < p3, '4" P_in lower: ' + p4 + ' vs ' + p3);
      const ps = mk({ config: { surge: { mawp: 25 }, noise: { on: false } } });   // PSV-201 set at the tank SP: it lifts on the dump pulses
      assert.ok(run(ps, 1800, 1, (x) => x.lp.psvIn && x.lp.sources.psv > 0), 'PSV-201 lifting into the LP line');
      assert.ok(st(ps).surge.psv.lifting, 'PSV-201 lifting');
    },
  },
  {
    name: 'WTSLP (4) FT-201 types: low-cut (reading 0, belowCut, FT201_LOWCUT on a trickle), the orifice adds ≈ 1 psi to the design back pressure, texts = LP_METERS',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      Object.keys(LPX.LP_METERS).forEach((t) => {
        const sim = mk({ inputs: { Qo: 1000 }, config: { surge: { vent: { meter: { type: t } } } } }), s = st(sim), M = LPX.LP_METERS[t];
        assert.ok(s.lp.meterType === t && s.lp.unc_txt === M.unc_txt && s.lp.turndown_txt === M.turndown_txt, t + ' texts');
        if (M.lowCut_fts !== null) assert.strictEqual(s.lp.lowCut_fts, M.lowCut_fts, t + ' low-cut');
      });
      const base = mk()._internal().lp.LP, ori = mk({ config: { surge: { vent: { meter: { type: 'orifice' } } } } })._internal().lp.LP;
      assert.ok(Math.abs(ori.P2d - base.P2d - 1) < 1e-9, 'orifice +1 psi: ' + ori.P2d + ' vs ' + base.P2d);
      assert.ok(Math.abs(ori.cutV - 0.25 * ori.vD) < 1e-12, 'orifice low-cut = 1/4 of the design velocity');
      // a vortex meter (low-cut 8 ft/s) on a low-oil well: the reading is cut off
      const v = mk({ inputs: { Qo: 100 }, config: { surge: { vent: { meter: { type: 'vortex' } } }, noise: { on: false } } });
      assert.ok(run(v, 4 * 3600, 10, (s) => active(s, 'FT201_LOWCUT')), 'FT201_LOWCUT');
      const sv = st(v);
      assert.ok(sv.lp.meter_mscfd < 0.9 * (sv.cum.lpGas_mscf * 1e3 / sv.t * 86400) && sv.alarms.find((x) => x.id === 'FT201_LOWCUT').sev === 'info', 'reading below the flow');
      // the meter EMA (τ 600 s): a step in the flow reaches 63 % in 600 s
      const I = mk({ config: { noise: { on: false } } });
      assert.ok(I._internal().lp.LP.cutV === 0.1, 'usm');
    },
  },
  {
    name: 'WTSLP (5) modes: V-101 out → GORs null; V-101 + FS-401 out to the line → lp.to vent, the tank gas in cum.toVent; T-201 out → lp off; T-202 both → sources.t202; ESD; cushion; reset',
    wp: WP, opts: false, timeoutMs: 300000,
    run(app, assert) {
      const S = work();
      let s;
      const v = mk({ rigup: { separator: false } }); run(v, 1200, 10); s = st(v);
      assert.ok(s.rates.separated === false && s.rates.gor1_scf_stb === null && s.rates.gor2_scf_stb === null && s.rates.gorTot_scf_stb === null, 'V-101 out: GORs null');
      const vl = mk({ rigup: { separator: false, flare: false }, sim: { sepByDest: 'line', sepByP_psig: 150 } }); run(vl, 1200, 10); s = st(vl);
      assert.ok(s.lp.to === 'vent' && s.lp.note === LPX.LP_NOTES.vent && s.nodes.flare.qLP_mmscfd === 0, 'to vent: ' + s.lp.to);
      assert.ok(s.cum.toVent_gas_mscf > 0 && s.cum.toVent_gas_mscf + 1e-9 >= s.cum.lpGas_mscf, 'tank gas vents');
      const u = mk({ rigup: { surge: false } }); run(u, 600, 10); s = st(u);
      assert.ok(!s.lp.on && s.lp.note === LPX.LP_NOTES.noTank && s.rates.gor2_scf_stb === null && s.rates.gorTot_scf_stb === s.rates.gor1_scf_stb, 'T-201 out');
      const b = mk({ rigup: { surge2: true } }); b.setSurgeRoute('both'); run(b, 1800, 10, (x) => x.lp.sources.t202 > 0); s = st(b);
      assert.ok(s.lp.sources.t202 > 0 || b.getHistory('qgLP').y.some((y) => y > 0), 'T-202 gas in the LP line');
      const e = mk({ config: { noise: { on: false } } }); run(e, 600, 10); e.tripESD('test');
      assert.ok(run(e, 6 * 3600, 30, (x) => x.rates.gor2_scf_stb === null), 'ESD: GOR2 null once the oil decays');
      assert.ok(st(e).lp.meter_mscfd < 1, 'meter decays');
      const c = mk(); assert.ok(c.startCushion({}).ok); run(c, 1800, 10); s = st(c);
      assert.ok(finiteBad(s, J(S.NULLABLE)).length === 0, 'cushion: finite');
      const r = mk(); run(r, 1200, 10); r.reset('steady');
      const I = r._internal().lp;
      assert.ok(Math.abs(I.emaLp * 86.4 - LPX.SAMPLE.qFlashD_mscfd) < 0.01, 'reset: emaLp = the design flash');
    },
  },
  {
    name: 'WTSLP (6) 4.1 review: the LP back pressure is a compressible gas-line law — the design anchor holds (steady default ≈ unchanged), 1.2 MMscf/d gives a few psig (not tens), the open tip chokes near 4–5 MMscf/d; PSV-201 / PSV-202 rechecked against it; nps / sch overrides set the hydraulic ID',
    wp: WP, opts: false,
    run(app, assert) {
      const I = mk()._internal().lp, L = I.LP, at = I.at;
      // design anchor: at qD the law gives the design back pressure P2d (+ one exit velocity head, < 0.01 psi)
      assert.ok(Math.abs(at(L.qD, true) - L.P2d) < 0.01, 'anchor at qD: ' + at(L.qD, true) + ' vs ' + L.P2d);
      // the steady default (the design flash ≈ qD / 3) within 0.01 psi of the v1.7.0 quadratic law
      const q0 = LPX.SAMPLE.qFlashD_mscfd / 86.4;
      assert.ok(Math.abs(at(q0, true) - (L.P0 + L.K * q0 * q0)) < 0.01 && Math.abs(st(mk()).lp.P_in_psig - LPX.EX_LP.P_in_psig) < 0.002, 'steady default unchanged: ' + at(q0, true));
      // relief-rate anchors (3" SCH 40, 150 ft, SG 0.65): an isothermal hand estimate gives 3–5 psig at 1.16–1.2 MMscf/d
      const p12 = at(1200 / 86.4, true);
      assert.ok(p12 > 2 && p12 < 6, '1.2 MMscf/d → ' + p12 + ' psig (the incompressible P0 + K·q² gave ' + (L.P0 + L.K * Math.pow(1200 / 86.4, 2)) + ')');
      // monotonic; compressible (the rise is slower than q²); at the critical-flow limit P_t = q / kCh (≈ 2.5 scf/s per psia for 3")
      let last = L.P0;
      [100, 500, 1000, 2000, 4000, 8000].forEach((m) => { const p = at(m / 86.4, true); assert.ok(p > last, 'monotonic at ' + m); last = p; });
      assert.ok(at(2000 / 86.4, true) - L.P0 < 4 * (at(1000 / 86.4, true) - L.P0), 'slower than q²');
      assert.ok(L.kCh > 2.2 && L.kCh < 2.8, 'tip critical-flow coefficient ' + L.kCh);
      const qc = 4500 / 86.4;
      assert.ok(at(qc, true) + 14.696 >= qc / L.kCh - 1e-9, 'never below the choked-tip pressure');
      // round 2: the exit term is one velocity head ρv²/(2·gc) at the tip (kEx had a stray /144): at 1.2 MMscf/d on 3.068 in at
      // ≈ 15.15 psia the direct head is ≈ 0.4–0.5 psi, and P_t² − P_b² = kEx·q² must give it within 5 %
      const q12 = 1200 / 86.4, Pb = L.P0a + L.tip, Pt = Math.sqrt(Pb * Pb + L.kEx * q12 * q12);
      const TR = 150 + 459.67, Mw = 28.97 * L.SG, A = Math.PI / 4 * Math.pow(L.ID / 12, 2);
      const vt = q12 * (14.696 / Pb) * (TR / 519.67) / A, rho = Pb * 144 * Mw / (1545.35 * TR), head = rho * vt * vt / (2 * 32.174 * 144);
      assert.ok(head > 0.3 && head < 0.6 && Math.abs((Pt - Pb) / head - 1) < 0.05, 'exit head ' + (Pt - Pb) + ' psi vs ρv²/2gc ' + head);
      assert.ok(p12 > 4.8 && p12 < 5.3, '1.2 MMscf/d ≈ 5 psig: ' + p12);
      // the open tip chokes (q / kCh above the subsonic tip pressure) between 4 and 5 MMscf/d, not ≈ 3.3
      const choked = (m) => { const q = m / 86.4, P2 = Pb * Pb + L.kEx * q * q; return (q / L.kCh) * (q / L.kCh) > P2; };
      assert.ok(!choked(4000) && choked(5000), 'tip chokes between 4 and 5 MMscf/d');
      // PSV-201 / PSV-202 against the LP line: rated relief with the PCV wide open; the flow stays critical so each keeps ≥ 90 %
      // of its rating at the built-up back pressure (bellows: built-up > 10 % of set, as the live run uses gq at the live P_in)
      const c = I.psvCheck;
      ['PSV-201', 'PSV-202'].forEach((k) => {
        const v = c[k];
        assert.ok(v && v.set_psig === 50 && v.Pb_psig > 0 && v.Pb_psig < v.set_psig && v.ok && v.psvAtPb_mscfd <= v.psv_mscfd + 1e-9, k + ' ' + JSON.stringify(v));
        assert.strictEqual(v.bellows, v.Pb_psig > 0.1 * v.set_psig, k + ' bellows flag');
      });
      assert.ok(c['PSV-201'].Pb_psig > 22.5 && c['PSV-201'].Pb_psig < 30 && c['PSV-202'].Pb_psig > 8 && c['PSV-202'].Pb_psig < 15, 'built-up back pressures ' + c['PSV-201'].Pb_psig + ' / ' + c['PSV-202'].Pb_psig);
      assert.strictEqual(mk({ config: { surge: { vent: { to: 'hp' } } } })._internal().lp.psvCheck, null, 'hp: no LP check');
      // the default-mode dump-stuck relief: P_in stays a few psig below the tank, not ≈ the tank pressure
      const d = mk({ seed: 3, config: { noise: { on: false } } });
      d.advance(600); d.setFault('oilDumpStuckOpen', true);
      let gap = Infinity, pk = 0;
      run(d, 300, 1, (x) => { if (x.lp.q_mscfd > 500) gap = Math.min(gap, x.surge.P - x.lp.P_in_psig); pk = Math.max(pk, x.lp.P_in_psig); });
      assert.ok(gap > 10 && pk < 30, 'relief: tank − P_in ≥ ' + gap + ' psi, peak P_in ' + pk);
      // [5] cfg nps / sch alone: the hydraulic ID follows the table (an explicit ID_in still wins; flow.sim.lpSch alone is applied)
      [[{ nps: 4 }, 4.026], [{ nps: 2 }, 2.067], [{ sch: 80 }, 2.900], [{ nps: 4, sch: 80 }, 3.826], [{ ID_in: 2.5 }, 2.5], [{ nps: 4, ID_in: 3.5 }, 3.5],
        // round 2: an explicit ID_in equal to the default 3.068 still wins (no longer read as "not given")
        [{ nps: 4, ID_in: 3.068 }, 3.068], [{ nps: 3, sch: 80, ID_in: 3.068 }, 3.068], [{ ID_in: 3.068 }, 3.068], [{}, 3.068]].forEach(([v, id]) => {
        const x = mk({ config: { surge: { vent: v } } }), s = st(x);
        assert.ok(Math.abs(x._internal().lp.LP.ID - id) < 1e-12 && Math.abs(s.lp.ID_in - id) < 1e-12, JSON.stringify(v) + ' → ' + x._internal().lp.LP.ID);
      });
      assert.strictEqual(st(mk({ sim: { lpSch: 80 } })).lp.ID_in, 2.900, 'flow.sim.lpSch alone');
      // the host size (flow.sim) with a cfg override on top: cfg ID_in wins; cfg nps alone → the table, not the host's ID
      assert.strictEqual(st(mk({ sim: { lpNps: 2 }, config: { surge: { vent: { ID_in: 3.068 } } } })).lp.ID_in, 3.068, 'cfg ID_in over the host size');
      assert.strictEqual(st(mk({ sim: { lpNps: 2 }, config: { surge: { vent: { nps: 4 } } } })).lp.ID_in, 4.026, 'cfg nps over the host size');
      assert.strictEqual(st(mk({ sim: { lpNps: 4, lpSch: 80 } })).lp.ID_in, 3.826, 'host size');
      assert.ok(st(mk({ sim: { lpSch: 80 } })).lp.sch === 80, 'flow.sim.lpSch alone: sch');
    },
  },
];
