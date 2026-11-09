// Well Test Simulator live HMI (38-wts-live.js) — release 3.4.2, LP flare line + GOR1 / GOR2 / Total GOR (designs lpgas.md §5,
// INTEGRATION.md §2.4 / §2.7 / C9): the surge tank gas (PCV-201 / PCV-203, PSV-201 / PSV-202) runs on its own LP flare line through
// FT-201 to an LP tip on FS-401.
//   • pure: gorOf (null while V-101 is out), gorLine, summaryOf rates appended, metric alarm templates PAH_LP / VEL_LP, the
//     gasRateSmall category (MSCFD → m³/d);
//   • HMI (recording stub with the contract snapshot keys built here): HUD total GOR + '1 n · 2 n' sub-line, separator GOR1,
//     surge 'Flash (calc, PVT)' / 'Tank gas FT-201' / GOR2 / 'LP back P' (PSV lifting), flare HP / LP tip and LP line velocity,
//     the 'lp' card, the 2D strip GOR line and the dashed LP line with FT-201 — all only while lp.on (legacy: hidden / not drawn);
//   • engine (only when the engine has the LP line, WTS_sim.features.lpFlare): the real snapshot drives the same rows.
'use strict';

const WP = 'WTSLLP';
const J = (o) => JSON.parse(JSON.stringify(o));
const text = (el) => String(el ? el.textContent : '').trim();

function openWts(app) {
  const b = app.find('.nav-btn[data-p="wts"]');
  if (!b) throw new Error('no Well Test Simulator sidebar button');
  app.click(b); app.flush(500);
  const s = app.win.WTS_live && app.win.WTS_live.getSim && app.win.WTS_live.getSim();
  if (!s) throw new Error('live simulator did not start');
  return s;
}
const ctlOf = (app) => app.win.WTS_live._internals.ctl();
const I = (app) => app.win.WTS_live._internals;
// the LP keys of the snapshot contract (lpgas.md §3), example values
function lpPatch(st, o) {
  o = o || {};
  const on = o.on !== false;
  st.lp = Object.assign({ on, to: on ? 'lp' : 'hp', tag: 'FT-201', lineTag: 'LP flare line', nps: 3, sch: '40', ID_in: 3.068, L_ft: 150, q_mscfd: 42.5, meter_mscfd: 41.9,
    meterType: 'usm', unc_txt: '±3 % of reading', turndown_txt: '≈ 1000:1', lowCut_fts: 0.1, belowCut: false, P_in_psig: 0.6, P0_psig: 0.2, dP_psi: 0.15,
    vel_fts: 9.4, ve_fts: 350, vPct: 2.7, mach: 0.01, vSt: 'OK', sources: { t201: 40.1, t202: 0, psv: 2.4 }, psvIn: !!o.psv, note: 'T-301 vent, not metered' }, o.lp || {});
  Object.assign(st.rates, { gor1_scf_stb: 9500, gor2_scf_stb: 42, gorTot_scf_stb: 9542, gor_scf_stb: 9542, lpGas_mscfd: 41.9 }, o.rates || {});
  if (!on) Object.assign(st.rates, { gor2_scf_stb: null, gorTot_scf_stb: 9500, gor_scf_stb: 9500 });
  st.nodes.flare = Object.assign({}, st.nodes.flare, { qHP_mmscfd: 9.95, qLP_mmscfd: on ? 0.0419 : 0, Plp_psig: 0.6 });
  st.cum.lpGas_mscf = 12.5;
  if (o.separated === false) { st.rates.separated = false; st.rates.gor1_scf_stb = null; st.rates.gor2_scf_stb = null; st.rates.gorTot_scf_stb = null; st.rates.gor_scf_stb = null; }
  return st;
}
function installStub(app, o) {
  const L = I(app), real = L.sim(), opts = Object.assign({}, o || {});
  let key = null, cache = null;
  const stub = Object.create(real);
  stub.__v = 0;
  stub.getState = function () {
    const st = real.getState(), k = st.t + '|' + st.alarmVersion + '|' + stub.__v;
    if (k !== key) { key = k; cache = app.toWin(lpPatch(J(st), opts)); }
    return cache;
  };
  L.useSim(stub);
  return { stub, opts, set: (p) => { Object.keys(opts).forEach((k) => delete opts[k]); Object.assign(opts, p); stub.__v++; }, restore: () => L.useSim(real) };
}
function openCard(app, id) { ctlOf(app)._debug.openCard(id); app.flush(300); return app.el('wtsl_card'); }
const rows = (card) => Array.from(card.querySelectorAll('.wtsl-kv > div')).filter((d) => !d.hidden);
const rowLabels = (card) => rows(card).map((d) => text(d.querySelector('.l')));
const row = (card, l) => rows(card).find((d) => text(d.querySelector('.l')) === l);
const rowVal = (card, l) => { const r = row(card, l); return r ? text(r.querySelector('.v')) : null; };
const rowSub = (card, l) => { const r = row(card, l), d = r && r.querySelector('.d'); return d ? text(d) : null; };
const noErr = (app, assert) => assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().map((l) => l.text || l).join(' | '));
// the texts of the last complete 2D frame (host clearRect(0, 0, …) … end of the overlay)
function frameTexts(app, cv) {
  const log = app.canvasLog(cv);
  let i = log.length - 1;
  while (i >= 0 && !(log[i].op === 'clearRect' && log[i].args[0] === 0 && log[i].args[1] === 0)) i--;
  return log.slice(Math.max(0, i)).filter((e) => e.op === 'fillText').map((e) => String(e.args[0]));
}

module.exports = [
  {
    name: 'WTSLLP pure: gorOf (total / GOR1 / GOR2, null with V-101 out), gorLine, summaryOf appended rates, PAH_LP / VEL_LP metric templates, gasRateSmall MSCFD → m³/d',
    wp: WP,
    run(app, assert) {
      const L = I(app);
      const st = { rates: { gor1_scf_stb: 900, gor2_scf_stb: 40, gorTot_scf_stb: 940, gor_scf_stb: 940, lpGas_mscfd: 40 }, lp: { on: true } };
      assert.strictEqual(L.gorOf(st, 1), 900); assert.strictEqual(L.gorOf(st, 2), 40); assert.strictEqual(L.gorOf(st, 'tot'), 940);
      assert.strictEqual(L.gorOf({ rates: { gor_scf_stb: 777 } }, 'tot'), 777, 'older engine: the total is gor_scf_stb');
      assert.strictEqual(L.gorOf({ rates: { gor_scf_stb: 777 } }, 1), null);
      assert.strictEqual(L.gorOf({ rates: { separated: false, gor_scf_stb: 777, gor1_scf_stb: 5 } }, 'tot'), null, 'V-101 out: no GOR');
      assert.strictEqual(L.gorOf({ rates: { separated: false, gor1_scf_stb: 5 } }, 1), null);
      assert.strictEqual(L.lpOn(st), true); assert.strictEqual(L.lpOn({ lp: { on: false } }), false); assert.strictEqual(L.lpOn({}), false);
      assert.strictEqual(L.gorLine(st), 'GOR1 sep 900 · GOR2 tank 40 · total 940 scf/STB');
      // review 3.4.2: the HUD sub-line is labelled and five-digit values shrink to thousands so it fits the GOR cell
      assert.strictEqual(L.gorSub(st), 'G1 900 · G2 40');
      assert.strictEqual(L.gorSub(app.toWin({ rates: { gor1_scf_stb: 10132, gor2_scf_stb: 16, gorTot_scf_stb: 10148 } })), 'G1 10.1k · G2 16');
      assert.strictEqual(L.gorSub(app.toWin({ rates: { separated: false } })), 'G1 — · G2 —');
      // LP meter texts: the FT-201 reading vs what flows now; metric low-cut with 2 decimals and the turndown range converted
      const ln = (o) => L.lpNowTxt(app.toWin({ lp: Object.assign({ on: true, q_mscfd: 42.5, belowCut: false }, o) }), true);
      assert.strictEqual(ln({}), '10-min average · now 42.5 MSCFD');
      assert.strictEqual(ln({ q_mscfd: 0, belowCut: true }), '10-min average · no flow now (back-pressure valves shut)');
      assert.strictEqual(ln({ q_mscfd: 3, belowCut: true }), '10-min average · below the meter low-cut now (FT-201 reads 0)');
      assert.strictEqual(L.lpNowTxt(app.toWin({ lp: { on: false } })), null);
      assert.strictEqual(L.lpCutTxt(0.1), '0.1 ft/s'); assert.strictEqual(L.lpTurndownTxt('≈1000:1 (0.1–300 ft/s)'), '≈1000:1 (0.1–300 ft/s)');
      const sm = J(L.summaryOf(app.toWin(Object.assign({ t: 0, cum: {}, gauge: {}, alarms: [] }, st))));
      assert.deepStrictEqual([sm.rates.gor, sm.rates.gor1, sm.rates.gor2, sm.rates.gorTot, sm.rates.lpGas_mscfd], [940, 900, 40, 940, 40], 'summaryOf rates');
      const sm0 = J(L.summaryOf(app.toWin({ t: 0, cum: {}, rates: { gor_scf_stb: 5 }, gauge: {}, alarms: [] })));
      assert.deepStrictEqual([sm0.rates.gor1, sm0.rates.gor2, sm0.rates.gorTot, sm0.rates.lpGas_mscfd], [null, null, null, null], 'older engine: null keys');
      assert.deepStrictEqual(J(L.ALM_T.PAH_LP), ['LP flare line back pressure high', ' ≥ ', 'pressureG']);
      assert.deepStrictEqual(J(L.ALM_T.VEL_LP), ['LP flare line velocity', ' ≥ ', 'percent', ' of the limit']);
      assert.ok(L.EQ_IDS.indexOf('lp') >= 0 && L.TAG.lp === 'FT-201' && L.NAME.lp === 'LP flare line');
      assert.strictEqual(L.fmtU ? 1 : 1, 1);
      const W = app.win.WTS_live;
      assert.strictEqual(W.fmtU(42.5, 'gasRateSmall', 1), '42.5 MSCFD');
      if (app.win.WTS_units && app.win.WTS_units.setSystem) {
        app.win.WTS_units.setSystem('metric');
        try {
          assert.strictEqual(W.fmtU(10, 'gasRateSmall', 1), '283.2 m³/d');
          const t1 = L.alarmText(app.toWin({ id: 'PAH_LP', tag: 'FT-201', msg: 'FT-201 LP flare line back pressure high 6.0 psig ≥ 5.0 psig', value: 6, limit: 5 }));
          assert.ok(/^LP flare line back pressure high [\d.,]+ kPa.* ≥ [\d.,]+ kPa/.test(t1), 'PAH_LP metric: ' + t1);
          const t2 = L.alarmText(app.toWin({ id: 'VEL_LP', tag: 'FT-201', msg: 'x', value: 85, limit: 80 }));
          assert.strictEqual(t2, 'LP flare line velocity 85 % ≥ 80 % of the limit', 'VEL_LP metric (percent of the limit)');
          assert.strictEqual(L.lpCutTxt(0.1), '0.03 m/s', 'metric low-cut not rounded to 0.0');
          assert.ok(/^≈1000:1 \(0\.03–91 m\/s\)$/.test(L.lpTurndownTxt('≈1000:1 (0.1–300 ft/s)')), 'metric turndown: ' + L.lpTurndownTxt('≈1000:1 (0.1–300 ft/s)'));
        } finally { app.win.WTS_units.setSystem('imperial'); }
      }
    }
  },
  {
    name: 'WTSLLP HUD + cards with the LP line in service: total GOR + "1 · 2" sub-line, separator GOR1, surge tank gas / GOR2 / LP back P, flare HP / LP tip, the lp card',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app, { psv: true });
      try {
        app.flush(600);
        const hud = app.el('wtsl_hud'), rR = hud.querySelector('[data-h="rR"]'), sub = hud.querySelector('[data-h="rRs"]');
        assert.strictEqual(text(rR), '9,542', 'HUD GOR = total');
        assert.ok(sub && !sub.hidden && text(sub) === 'G1 9,500 · G2 42', 'sub-line: ' + text(sub));
        assert.ok(/GOR1 separator \(FE-101\) \+ GOR2 tank \(FT-201\)/.test(rR.closest('.wtsl-hi').getAttribute('title')), 'GOR tooltip');
        let card = openCard(app, 'separator');
        assert.strictEqual(rowVal(card, 'GOR1'), '9,500 scf/STB');
        card = openCard(app, 'surge');
        assert.ok(rowLabels(card).indexOf('Flash (calc, PVT)') >= 0 && rowLabels(card).indexOf('Flash gas') < 0, 'flash row renamed');
        assert.ok(/ MSCFD$/.test(rowVal(card, 'Flash (calc, PVT)')) || rowVal(card, 'Flash (calc, PVT)') === '—', 'flash: ' + rowVal(card, 'Flash (calc, PVT)'));
        assert.strictEqual(rowVal(card, 'Tank gas FT-201'), '41.9 MSCFD');
        assert.strictEqual(rowSub(card, 'Tank gas FT-201'), '10-min average · now 42.5 MSCFD', 'the reading and the flow now are named');
        assert.strictEqual(rowVal(card, 'GOR2'), '42 scf/STB');
        assert.ok(/^0\.6 psig$/.test(rowVal(card, 'LP back P')) && rowSub(card, 'LP back P') === 'PSV lifting into the LP line', 'LP back P: ' + rowVal(card, 'LP back P') + ' / ' + rowSub(card, 'LP back P'));
        card = openCard(app, 'flare');
        assert.strictEqual(rowVal(card, 'HP tip'), '9.95 MMSCFD'); assert.strictEqual(rowVal(card, 'LP tip'), '0.04 MMSCFD');
        assert.ok(/^9\.4 ft\/s · 3%$/.test(rowVal(card, 'LP line vel')), 'LP line vel: ' + rowVal(card, 'LP line vel'));
        card = openCard(app, 'wellhead');
        assert.strictEqual(rowVal(card, 'GOR'), '9,542 scf/STB'); assert.strictEqual(rowSub(card, 'GOR'), 'total (GOR1 + GOR2)');
        card = openCard(app, 'lp');
        assert.strictEqual(text(card.querySelector('.tt b')), 'FT-201');
        const ls = rowLabels(card);
        ['Service', 'Line', 'Flow (now)', 'FT-201 (10-min avg)', 'Meter', 'Inlet P', 'ΔP', 'Velocity', 'Sources', 'GOR1 (separator)', 'GOR2 (tank)', 'Total GOR', 'Cumulative', 'Note'].forEach((l) => assert.ok(ls.indexOf(l) >= 0, 'lp row ' + l + ': ' + ls.join(',')));
        assert.strictEqual(rowVal(card, 'Service'), 'To the LP tip on FS-401');
        assert.ok(/^3″ SCH 40 · 150 ft$/.test(rowVal(card, 'Line')), 'Line: ' + rowVal(card, 'Line'));
        assert.strictEqual(rowVal(card, 'Meter'), 'Insertion ultrasonic · ±3 % of reading');
        assert.strictEqual(rowVal(card, 'Flow (now)'), '42.5 MSCFD'); assert.strictEqual(rowSub(card, 'Flow (now)'), '');
        assert.strictEqual(rowVal(card, 'FT-201 (10-min avg)'), '41.9 MSCFD');
        ['Line', 'Meter'].forEach((l) => assert.ok(row(card, l).classList.contains('f'), l + ' spans the card (no truncation)'));
        assert.strictEqual(rowVal(card, 'Sources'), 'T-201 40.1 MSCFD · T-202 0.0 MSCFD · PSV 2.4 MSCFD');
        assert.strictEqual(rowVal(card, 'Note'), 'T-301 vent, not metered');
        assert.strictEqual(card.querySelectorAll('canvas.wtsl-sk').length, 2, 'two sparks (tank gas, GOR1 · GOR2)');
        // PCV-201 shut now: the flow row says so; the reading (10-min average) stays and is not flagged as below the low-cut
        t.set({ lp: { q_mscfd: 0, belowCut: true } }); app.flush(400);
        card = openCard(app, 'lp');
        assert.strictEqual(rowVal(card, 'Flow (now)'), '0.0 MSCFD'); assert.strictEqual(rowSub(card, 'Flow (now)'), 'no flow now (back-pressure valves shut)');
        assert.strictEqual(rowVal(card, 'FT-201 (10-min avg)'), '41.9 MSCFD');
        assert.ok(!/below the low-cut/.test(text(card)), 'no "below the low-cut" next to a non-zero reading');
        // FS-401 out with the surge destination: LP gas to the vent
        t.set({ psv: false, lp: { to: 'vent', note: 'LP gas to the atmospheric vent (FS-401 out)' } }); app.flush(400);
        card = openCard(app, 'lp');
        assert.strictEqual(rowVal(card, 'Service'), 'To the atmospheric vent (FS-401 out)');
        // V-101 out: no GOR anywhere (no separator meters)
        t.set({ separated: false }); app.flush(600);
        card = openCard(app, 'lp');
        assert.strictEqual(rowVal(card, 'Total GOR'), '—'); assert.strictEqual(rowSub(card, 'Total GOR'), 'V-101 out: no separator meters');
        assert.strictEqual(text(hud.querySelector('[data-h="rR"]')), '—'); assert.ok(hud.querySelector('[data-h="rRs"]').hidden, 'no sub-line with V-101 out');
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSLLP LP line not in service (lp.on false, legacy \'hp\'): LP rows hidden, no HUD sub-line, no strip GOR line and no FT-201 in 2D; lp card says not in service',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const cv = app.el('wts_cv');
      const t = installStub(app, { on: false });
      try {
        app.flush(600);
        assert.ok(app.el('wtsl_hud').querySelector('[data-h="rRs"]').hidden, 'no sub-line');
        let card = openCard(app, 'surge');
        ['Tank gas FT-201', 'GOR2', 'LP back P'].forEach((l) => assert.ok(rowLabels(card).indexOf(l) < 0, 'hidden ' + l));
        card = openCard(app, 'flare');
        ['HP tip', 'LP tip', 'LP line vel'].forEach((l) => assert.ok(rowLabels(card).indexOf(l) < 0, 'hidden ' + l));
        card = openCard(app, 'lp');
        assert.strictEqual(rowVal(card, 'Service'), 'Not in service'); assert.strictEqual(rowSub(card, 'Service'), 'tank gas to the HP flare header');
        assert.deepStrictEqual(rowLabels(card), ['Service', 'Note'], 'only the service row (+ note): ' + rowLabels(card).join(','));
        ctlOf(app)._debug.closeCard();
        if (cv) {
          app.flush(400);
          let tx = frameTexts(app, cv);
          assert.ok(!tx.some((x) => /^GOR1 /.test(x)) && tx.indexOf('FT-201') < 0, '2D: no GOR line / FT-201 while off');
          t.set({}); app.flush(600);
          tx = frameTexts(app, cv);
          assert.ok(tx.some((x) => x === 'GOR1 sep 9,500 · GOR2 tank 42 · total 9,542 scf/STB'), '2D strip GOR line: ' + tx.filter((x) => /GOR/.test(x)).join('|'));
          assert.ok(tx.indexOf('FT-201') >= 0, '2D dashed LP line labelled FT-201');
        }
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSLLP engine (LP-line engine only): the real snapshot fills the HUD sub-line and the lp card; summaryOf carries the split GOR',
    wp: WP, integration: true,
    run(app, assert) {
      const S = app.win.WTS_sim;
      if (!(S && S.features && S.features.lpFlare)) { assert.ok(true, 'engine without the LP flare line: skipped'); return; }
      const live = openWts(app);
      for (let i = 0; i < 6; i++) live.advance(600);
      app.flush(800);
      const st = live.getState();
      assert.ok(st.lp && st.lp.on === true, 'LP line in service by default');
      const card = openCard(app, 'lp');
      assert.strictEqual(rowVal(card, 'Service'), 'To the LP tip on FS-401');
      assert.ok(!/NaN|undefined|Infinity/.test(text(card)), 'no NaN in the lp card');
      const sub = app.el('wtsl_hud').querySelector('[data-h="rRs"]');
      assert.ok(!sub.hidden && /^G1 [\d,.]+k? · G2 [\d,.]+k?$/.test(text(sub)), 'sub-line: ' + text(sub));
      const sm = J(I(app).summaryOf(st));
      assert.ok(sm.rates.gor1 > 0 && sm.rates.gorTot >= sm.rates.gor1, 'summaryOf GOR split: ' + JSON.stringify(sm.rates));
      noErr(app, assert);
    }
  }
];
