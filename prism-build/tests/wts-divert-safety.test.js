// Well Test Simulator — v3.0 tank-farm process safety (Round-7: 31-wts-sim, 32-wts-3d, 38-wts-live).
//   • LSHH-301 (gauge tank, fed by the pressure-driven surge transfer LCV-201) shuts LCV-201 and fail-safe closes the high-high compartment's
//     XV-301 — no ESD; latched until the operator resets it below the reset point. The surge tank then fills and
//     LSHH-201 closes its inlet(s) and trips the ESD (a high-high on a vessel stops what fills it).
//   • Auto-divert never opens a compartment holding a batch (settling / draining) unless "allow interrupting
//     batches" is on; with nowhere to go it raises LAH-301 instead.
//   • LCV-201 low-low (gas blow-by / dry-run) protection: an open transfer whose suction reaches LSLL moves its suction to
//     the other compartment (auto-divert on) or trips (latched, reset once the suction is above LSL).
//   (surge.pump is the legacy snapshot key of the surge outlet transfer; P-201 now sits downstream of the gauge tank)
//   • Divert valve travel: open-new-before-close-old respects the stroke time; "in transit" state in the snapshot.
//   • Per-compartment surge temperatures (an isolated compartment cools as Newton's law with the model's stated
//     ambient-loss time constant, 14 400 s — hand calculation below).
//   • Persistence of the new options; phone inset with ≥ 44 px valve buttons.
// Expected values are configuration set points (LAHH, reset point, LSLL, LSL, stroke), conservation, event
// order or an independent hand calculation — never numbers taken from the code under test.
'use strict';

const WP = 'WTSDV';
const NOISE_OFF = { noise: { on: false } };

function sim(app, o, flow) { const S = app.win.WTS_sim; if (!S) throw new Error('WTS_sim missing'); return S.create(flow || S.SAMPLE_FLOW, app.toWin(Object.assign({ seed: 7 }, o || {}))); }
function alarmIds(st) { return st.alarms.map((a) => a.id); }
function runUntil(s, maxSec, dt, pred) { for (let i = 0; i < Math.ceil(maxSec / dt); i++) { s.advance(dt); if (pred(s.getState())) return true; } return false; }
function balanced(assert, st, where) {
  const m = st.health.massErr;
  assert.ok(Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9, where + ': mass balance ' + JSON.stringify(m));
}
function openWts(app) {
  const b = app.find('.nav-btn[data-p="wts"]');
  if (!b) throw new Error('no Well Test Simulator sidebar button');
  app.click(b); app.flush(500);
  const L = app.win.WTS_live, s = L && L.getSim && L.getSim();
  if (!s) throw new Error('live simulator did not start');
  return s;
}

module.exports = [
  {
    name: 'WTSDV-S LSHH-301 shuts the LCV-201 transfer (no ESD) and closes the gauge inlet; latched until reset below the reset point; surge LSHH-201 then closes its inlets and trips the ESD',
    wp: WP,
    run(app, assert) {
      const D = app.win.WTS_sim.DEFAULTS;
      // A long settling time keeps T-301A busy (batch in progress) when T-301B fills: no standby → B rises to LSHH-301
      const s = sim(app, { config: Object.assign({ gauge: { settleS: 14400 } }, NOISE_OFF) });
      const trips = [], esd = [];
      s.on('pumpTrip', (p) => trips.push(p)); s.on('trip', (p) => esd.push(p));
      assert.ok(runUntil(s, 6 * 3600, 10, (x) => alarmIds(x).indexOf('LSHH_GT') >= 0), 'LSHH-301 reached');
      let st = s.getState();
      const k = st.gauge.tanks[1].frac > st.gauge.tanks[0].frac ? 1 : 0;
      assert.strictEqual(k, 1, 'T-301B is the compartment at high-high');
      assert.ok(st.gauge.tanks[k].frac >= D.gauge.lahh - 1e-9 && st.gauge.tanks[k].frac < D.gauge.lahh + 0.005, 'tripped at LAHH ' + D.gauge.lahh + ' (level ' + st.gauge.tanks[k].frac + ')');
      assert.strictEqual(trips.length, 1, 'one pumpTrip event'); assert.strictEqual(trips[0].cause, 'LSHH_GT');
      assert.strictEqual(esd.length, 0, 'LSHH-301 does not trip the ESD');
      assert.strictEqual(st.surge.pump.q_bpd, 0, 'P-201 stopped'); assert.strictEqual(st.surge.pump.tripped, true); assert.strictEqual(st.surge.pump.trip, 'LSHH_GT');
      assert.strictEqual(st.gauge.tanks[k].inlet, false, 'XV-301B commanded closed (fail-safe)');
      assert.strictEqual(st.esd.tripped, false, 'well still flowing');
      assert.ok(st.esd.blocking.indexOf('LSHH_GT') < 0, 'a P-201 trip does not hold the ESD reset');
      const tripLog = st.alarmLog.filter((e) => e.type === 'trip' && e.id === 'LSHH_GT');
      assert.ok(tripLog.length === 1 && tripLog[0].tag === 'LCV-201' && /XV-301B closing \(fail-safe\)/.test(tripLog[0].msg), 'event log: ' + JSON.stringify(tripLog));
      s.advance(D.gauge.xvStrokeS + 1);
      st = s.getState();
      assert.strictEqual(st.gauge.tanks[k].pos, 0, 'XV-301B at its closed limit');
      // latched: the level no longer rises but the alarm stays; reset refused above the reset point; B cannot be reopened
      let r = s.resetTrip();
      assert.strictEqual(r.ok, false, 'reset refused while T-301B ≥ reset point ' + D.gauge.lshhReset); assert.ok(/reset 90%/.test(r.blocking[0]), r.blocking[0]);
      assert.strictEqual(s.setValve('gauge', 1, true), false, 'XV-301B open refused while latched');
      assert.ok(alarmIds(s.getState()).indexOf('LSHH_GT') >= 0, 'LSHH_GT stays latched');
      // the surge tank now fills (P-201 stopped): LSHH-201 closes the T-201 inlets and trips the ESD
      const su0 = st.surge.frac;
      assert.ok(runUntil(s, 3 * 3600, 5, (x) => x.esd.tripped), 'ESD tripped by the surge tank');
      st = s.getState();
      assert.ok(st.surge.frac > su0, 'surge level rose after the pump trip');
      assert.strictEqual(st.esd.cause, 'LSHH_SURGE', 'ESD cause');
      const hhComps = st.surge.comps.filter((c) => c.frac >= D.surge.lshh - 1e-9);
      assert.ok(hhComps.length >= 1 && hhComps.every((c) => c.inlet === false), 'every T-201 compartment at LSHH has its XV-201 commanded shut');
      assert.ok(st.alarmLog.some((e) => e.id === 'VALVE' && /XV-201[AB] closed \(LSHH-201 trip, fail-safe\)/.test(e.msg)), 'XV-201 closure logged');
      // shorten settling so T-301B settles and drains below the reset point → reset is accepted
      s.setConfig(app.toWin({ gauge: { settleS: 600 } }));
      assert.ok(runUntil(s, 1800, 5, (x) => x.gauge.tanks[1].frac < D.gauge.lshhReset), 'T-301B drained below the reset point');
      r = s.resetTrip();
      st = s.getState();
      assert.ok(r.ok && r.reset.indexOf('LSHH_GT') >= 0, 'reset accepted: ' + JSON.stringify(r));
      assert.strictEqual(st.surge.pump.trip, null); assert.ok(alarmIds(st).indexOf('LSHH_GT') < 0, 'alarm cleared by the reset');
      assert.ok(st.alarmLog.some((e) => e.type === 'reset' && e.id === 'LSHH_GT'), 'reset logged');
      // pump returns on level control once a gauge inlet is open again
      assert.strictEqual(s.setValve('gauge', 0, true), true, 'open XV-301A');
      assert.ok(runUntil(s, 600, 5, (x) => x.surge.pump.q_bpd > 0), 'P-201 pumping again');
      balanced(assert, s.getState(), 'LSHH-301 sequence');
    }
  },
  {
    name: 'WTSDV-S auto-divert does not interrupt a settling batch (LAH-301 instead) unless "allow interrupting batches" is on',
    wp: WP,
    run(app, assert) {
      const D = app.win.WTS_sim.DEFAULTS;
      const s = sim(app, { config: Object.assign({ gauge: { settleS: 7200 } }, NOISE_OFF), seed: 8 });
      // A (30 % at t = 0) is switched out after 60 s → A settles at ≈ 30 %, below SP − hysteresis; B fills
      s.advance(60);
      s.setValve('gauge', 1, true); s.setValve('gauge', 0, false);
      s.advance(2 * D.gauge.xvStrokeS + 1);
      assert.strictEqual(s.getState().gauge.tanks[0].state, 'settling', 'A holds a batch in progress');
      s.setAutoDivert('gauge', true, app.toWin({ sp: 0.5, hyst: 0.1 }));
      const dv = []; s.on('divert', (p) => dv.push(p));
      assert.ok(runUntil(s, 3 * 3600, 10, (x) => alarmIds(x).indexOf('LAH_GT_BOTH') >= 0), 'LAH-301 raised at the set point');
      let st = s.getState();
      assert.strictEqual(dv.length, 0, 'no divert into the settling compartment');
      assert.ok(st.gauge.tanks[1].frac >= 0.5 && st.gauge.tanks[0].frac < 0.4, 'B at SP, A has room (' + st.gauge.tanks[1].frac + ' / ' + st.gauge.tanks[0].frac + ')');
      assert.ok(/T-301A settling — batch in progress/.test(st.alarms.find((a) => a.id === 'LAH_GT_BOTH').msg), 'LAH text names the batch');
      assert.strictEqual(st.gauge.tanks[0].avail, false, 'A reported unavailable');
      s.advance(600);
      assert.strictEqual(dv.length, 0, 'still no divert'); assert.strictEqual(s.getState().gauge.tanks[0].state, 'settling', 'batch undisturbed');
      // the operator allows interruption → the divert happens and A's batch is recorded as unsettled
      assert.strictEqual(s.setValveOptions('gauge', app.toWin({ allowInterrupt: true })), true);
      assert.ok(runUntil(s, 60, 1, () => dv.length > 0), 'divert once interruption is allowed');
      st = s.getState();
      assert.strictEqual(dv[0].to, 0, 'into A'); assert.ok(/settling batch interrupted \(allowed\)/.test(dv[0].msg), dv[0].msg);
      const bA = st.gauge.batches.filter((b) => b.tag === 'T-301A');
      assert.ok(bA.length === 1 && bA[0].settled === false, 'A batch recorded as unsettled: ' + JSON.stringify(bA));
      balanced(assert, st, 'interrupt');
    }
  },
  {
    name: 'WTSDV-S LCV-201 low-low protection: LSLL on the open transfer suction trips it (latched), or auto-switches the suction when auto-divert is on',
    wp: WP,
    run(app, assert) {
      const D = app.win.WTS_sim.DEFAULTS;
      function prime(seed, auto) {
        // pump T-201B down with its inlet shut to 6 % (LSL temporarily 6 %), then raise LSLL to 8 % so B sits below LSLL
        const s = sim(app, { config: NOISE_OFF, seed });
        s.setValve('surge', 1, false); s.setSuction('B'); s.setConfig(app.toWin({ surge: { lsl: 0.06 } }));
        assert.ok(runUntil(s, 3600, 5, (x) => x.surge.pump.q_bpd === 0), 'B pumped down to its LSL');
        // (the valve flow follows the vessel pressure within a step, so the LSL crossing is located to ~1e-5 of the level)
        assert.near(s.getState().surge.comps[1].frac, 0.06, 1e-4, 'stopped at LSL 6 %');
        s.setConfig(app.toWin({ surge: { lsl: 0.25, lsll: 0.08 } }));
        s.setSuction('A');
        assert.ok(runUntil(s, 3600, 5, (x) => x.surge.pump.q_bpd > 0), 'P-201 running on A');
        if (auto) s.setAutoDivert('surge', true);
        return s;
      }
      // auto-divert off → trip
      const s = prime(81, false), pt = [];
      s.on('pumpTrip', (p) => pt.push(p));
      s.setSuction('B'); s.advance(1);
      let st = s.getState();
      assert.strictEqual(st.surge.pump.q_bpd, 0, 'pump stopped at once'); assert.strictEqual(st.surge.pump.trip, 'PUMP_DRYRUN');
      assert.ok(pt.length === 1 && pt[0].cause === 'PUMP_DRYRUN', 'pumpTrip event');
      const A = st.alarms.find((a) => a.id === 'PUMP_DRYRUN');
      assert.ok(A && A.sev === 'trip' && /suction T-201B level 6\.0% ≤ LSLL 8\.0%/.test(A.msg), 'dry-run alarm: ' + (A && A.msg));
      assert.strictEqual(st.esd.tripped, false, 'no ESD');
      let r = s.resetTrip('PUMP_DRYRUN');
      assert.ok(!r.ok && /≤ LSL 25%/.test(r.blocking[0]), 'reset refused on a dry suction: ' + JSON.stringify(r));
      s.setSuction('A'); s.advance(1);
      assert.strictEqual(s.getState().surge.pump.q_bpd, 0, 'still latched after the suction is moved');
      r = s.resetTrip('PUMP_DRYRUN');
      assert.ok(r.ok, 'reset once the suction is above LSL');
      assert.ok(runUntil(s, 3600, 5, (x) => x.surge.pump.q_bpd > 0), 'P-201 back on level control');
      balanced(assert, s.getState(), 'dry-run trip');
      // auto-divert on → the suction moves back to A, no trip
      const s2 = prime(82, true), ev = [], pt2 = [];
      s2.on('suction', (p) => ev.push(p)); s2.on('pumpTrip', (p) => pt2.push(p));
      s2.setSuction('B'); s2.advance(1);
      st = s2.getState();
      assert.strictEqual(st.surge.suction, 'A', 'suction auto-switched to A');
      assert.ok(ev.length === 1 && pt2.length === 0 && !st.surge.pump.tripped, 'switched, not tripped');
      assert.ok(st.surge.pump.q_bpd > 0, 'pump kept running');
      assert.ok(st.alarmLog.some((e) => e.id === 'AUTO_SUCTION' && /dry-run protection/.test(e.msg)), 'logged');
      // a stopped pump below LSLL is only a start permissive (no trip): empty start
      const s3 = sim(app, { config: NOISE_OFF, mode: 'empty', seed: 83 });
      s3.advance(600);
      assert.ok(!s3.getState().surge.pump.tripped, 'empty start does not latch a dry-run trip');
    }
  },
  {
    name: 'WTSDV-S divert valve travel: open-new-before-close-old follows the stroke; transit state; P-201 never dead-heads during a changeover',
    wp: WP,
    run(app, assert) {
      const s = sim(app, { config: NOISE_OFF, seed: 9 });
      assert.strictEqual(s.setValveOptions('gauge', app.toWin({ strokeS: 10 })), true, 'stroke 10 s');
      assert.strictEqual(s.getControls().gauge.strokeS, 10);
      assert.ok(runUntil(s, 3600, 5, (x) => x.surge.pump.q_bpd > 0), 'pump running');
      s.setValve('gauge', 1, true); s.setValve('gauge', 0, false);
      const seen = [];
      for (let i = 1; i <= 24; i++) {
        s.advance(1);
        const x = s.getState(), T = x.gauge.tanks;
        seen.push([x.t, T[0].pos, T[1].pos]);
        assert.ok(x.surge.pump.q_bpd > 0 && !x.surge.pump.blocked, 't+' + i + ': pump keeps running');
        assert.ok(T[0].pos + T[1].pos >= 1 - 1e-9, 't+' + i + ': an open path at all times');
        if (i === 5) { assert.near(T[1].pos, 0.5, 1e-6, 'B half open at 5 s'); assert.strictEqual(T[0].pos, 1, 'A held open'); assert.ok(T[0].hold && T[1].moving, 'transit flags'); assert.ok(T[0].fill_bpd > 0 && T[1].fill_bpd > 0, 'both receive flow'); }
        if (i === 10) { assert.strictEqual(T[1].pos, 1, 'B open at 10 s'); assert.strictEqual(T[0].state, 'filling', 'A still filling'); }
        if (i === 15) assert.near(T[0].pos, 0.5, 1e-6, 'A half closed at 15 s');
        if (i === 20) { assert.strictEqual(T[0].pos, 0, 'A closed at 20 s'); assert.strictEqual(T[0].state, 'settling', 'A settles at its closed limit'); assert.strictEqual(T[0].moving, false); }
      }
      // surge: closing XV-201B while XV-201A is already fully open needs no hold — it simply strokes shut (6 s default)
      const Su = app.win.WTS_sim.DEFAULTS.surge.xvStrokeS;
      s.setValve('surge', 1, false);
      let st = s.getState();
      assert.ok(!st.surge.comps[1].hold && st.surge.comps[1].moving, 'XV-201B closing, not held');
      s.advance(Su / 2); assert.near(s.getState().surge.comps[1].pos, 0.5, 1e-6, 'XV-201B half closed');
      s.advance(Su / 2); st = s.getState(); assert.strictEqual(st.surge.comps[1].pos, 0, 'XV-201B closed after one stroke');
      // manual close of the last open gauge valve: no hold (nothing else commanded open) → the pump is blocked at the closed limit
      s.setValve('gauge', 1, false);
      s.advance(5); assert.ok(!s.getState().surge.pump.blocked, 'not blocked while XV-301B still travels');
      s.advance(6); st = s.getState(); assert.ok(st.surge.pump.blocked && st.surge.pump.q_bpd === 0, 'blocked at the closed limit');
      // stroke 0 = instantaneous (the v1.8 behaviour)
      s.setValveOptions('gauge', app.toWin({ strokeS: 0 })); s.setValve('gauge', 0, true);
      st = s.getState(); assert.ok(st.gauge.tanks[0].pos === 1 && !st.gauge.tanks[0].moving, 'instant open with stroke 0');
      assert.ok(st.alarmLog.some((e) => e.id === 'VALVE_OPT' && /stroke 10 s/.test(e.msg)), 'stroke change logged');
      balanced(assert, st, 'travel');
    }
  },
  {
    name: 'WTSDV-S per-compartment surge temperatures: an isolated compartment cools with the 4 h ambient-loss time constant; the pump discharge mixes the suction compartments',
    wp: WP,
    run(app, assert) {
      const s = sim(app, { config: NOISE_OFF, seed: 10 });
      let st = s.getState();
      const T0 = st.surge.comps[1].T, Tamb = app.win.WTS_sim.DEFAULTS.ambientT;
      assert.near(st.surge.comps[0].T, st.surge.comps[1].T, 1e-9, 'equal at t = 0');
      // isolate B (inlet shut, suction A): no inflow, no draw → Newton cooling  T(t) = Tamb + (T0 − Tamb)·exp(−t / 14 400 s)
      s.setValveOptions('surge', app.toWin({ strokeS: 0 }));
      s.setValve('surge', 1, false); s.setSuction('A');
      for (let i = 0; i < 360; i++) s.advance(10);
      st = s.getState();
      const hand = Tamb + (T0 - Tamb) * Math.exp(-3600 / 14400);          // 80 + 70·e^−0.25 = 134.52 °F for T0 = 150 °F
      assert.near(st.surge.comps[1].T, hand, 1e-6, 'T-201B after 1 h isolated');
      assert.ok(st.surge.comps[0].T > st.surge.comps[1].T + 5, 'T-201A, fed at the separator temperature, stays warmer (' + st.surge.comps[0].T + ')');
      // bulk temperature = volume-weighted mean of the compartments
      const c = st.surge.comps, vA = c[0].Vo_bbl + c[0].Vw_bbl, vB = c[1].Vo_bbl + c[1].Vw_bbl;
      assert.near(st.surge.T, (vA * c[0].T + vB * c[1].T) / (vA + vB), 1e-6, 'bulk T');
      // suction A only: the discharge is T-201A's temperature
      assert.ok(runUntil(s, 3600, 5, (x) => x.surge.pump.q_bpd > 0), 'pump running');
      st = s.getState();
      assert.near(st.surge.pump.T, st.surge.comps[0].T, 0.05, 'discharge = T-201A (suction A)');
      // both suctions: the draw-weighted mix lies strictly between the two compartments
      s.setSuction('both'); s.advance(0.5); st = s.getState();
      if (st.surge.pump.q_bpd > 0) assert.ok(st.surge.pump.T < st.surge.comps[0].T && st.surge.pump.T > st.surge.comps[1].T, 'mixed discharge ' + st.surge.pump.T);
    }
  },
  {
    name: 'WTSDV-S live view: phone inset (≥ 44 px targets, 22 px tap radius), LCV-201 transfer trip reset from the card, options persist across reload',
    wp: WP,
    integration: true,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert, ctx) {
      const live = openWts(app);
      const viz = app.el('wts_viz');
      assert.strictEqual(viz.getAttribute('data-bp'), 'sm', 'phone breakpoint');
      const CSS = app.win.WTS_live._internals.CSS;
      assert.ok(/\.wtsl-vin \.wtsl-b\{min-height:44px;height:44px;min-width:44px/.test(CSS), 'inset buttons are 44 × 44 px');
      const cv = viz.querySelector('canvas'); app.flush(500);
      const L = app.win.WTS_DIAG_LAYOUT, r = cv.getBoundingClientRect();
      const px = r.width / L.W;
      // a tap 20 CSS px to the right of the XV-301B glyph (outside the drawn glyph) still reaches the gauge valves
      const gx = r.left + (L.bx[1] + 9) * px + 20, gy = r.top + (L.by - 26) * (r.height / L.H);
      cv.dispatchEvent(new app.win.MouseEvent('click', { clientX: gx, clientY: gy, bubbles: true }));
      const vin = app.el('wtsl_vin');
      assert.ok(vin && /T-301 gauge tank/.test(vin.textContent), 'gauge inset opened by a near tap');
      assert.ok(vin.querySelectorAll('[data-act="valve"]').length === 2, 'two 44 px valve buttons');
      app.click(vin.querySelector('[data-act="vin-close"]'));
      // latch an LCV-201 transfer trip (LSHH-301) in the live sim, then reset it from the surge tank card
      live.setConfig(app.toWin({ gauge: { settleS: 14400 } }));
      let n = 0; for (; n < 3000 && !live.getState().surge.pump.tripped; n++) live.advance(10);
      assert.ok(live.getState().surge.pump.trip === 'LSHH_GT', 'tripped in the live view');
      app.flush(300);
      live.setConfig(app.toWin({ gauge: { settleS: 600 } }));
      for (let i = 0; i < 360 && live.getState().gauge.tanks[1].frac >= 0.9; i++) live.advance(5);
      // open the surge tank card through the focus action (same path as the 3D pick) and press Reset LCV-201
      const b = app.win.document.createElement('button'); b.setAttribute('data-act', 'focus'); b.setAttribute('data-v', 'surge'); viz.appendChild(b); app.click(b); b.remove();
      app.flush(300);
      const card = app.el('wtsl_card');
      const rb = card && card.querySelector('[data-act="xfer-reset"]');
      assert.ok(rb && !rb.disabled, 'Reset LCV-201 button enabled below the reset point');
      app.click(rb); app.flush(50);
      assert.strictEqual(live.getState().surge.pump.trip, null, 'reset from the card');
      // options persist in the prefs and are restored after a reload
      live.setValveOptions('gauge', app.toWin({ strokeS: 9, allowInterrupt: true })); app.flush(50);
      const prefs = JSON.parse(app.win.localStorage.getItem('h2viz3d_prefs') || '{}');
      assert.ok(prefs.ctl && prefs.ctl.gauge.strokeS === 9 && prefs.ctl.gauge.allowInterrupt === true, 'saved: ' + JSON.stringify(prefs.ctl));
      const app2 = ctx.loadApp({ storage: app.storage, viewport: { width: 375, height: 812 } });
      try {
        const c2 = openWts(app2).getControls();
        assert.ok(c2.gauge.strokeS === 9 && c2.gauge.allowInterrupt === true, 'restored after reload');
      } finally { if (app2.dispose) app2.dispose(); }
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().join(' | '));
    }
  }
];
