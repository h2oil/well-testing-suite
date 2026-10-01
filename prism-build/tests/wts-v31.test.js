// Well Test Simulator v3.1 review (Round-7: 31-wts-sim, 32-wts-3d, 38-wts-live).
//   • Rig-up without a surge tank (V-101 dumps straight into T-301): an LSHH-301 trip closes the high-high T-301 inlet —
//     there is no LCV-201 in line, so no message, event or button may say "LCV-201" (or "P-201") for it.
//   • A latched LCV-201 low-low trip is released when T-201 (and LCV-201) leave the rig-up, like the LSHH-301 latch
//     when T-301 leaves.
//   • The ESD-reset hint names the separator dump route that is actually shut (T-201 inlets, or T-301 inlets when
//     there is no surge tank).
//   • Snapshot memo caches (performance): two identical sims stay bit-identical through rig-up and fluid changes.
//   • GUI sweep: every button of the live simulator page (toolbar, menus, info cards, drawer, rig-up switches) can be
//     pressed with no handler error and no console error; no timers pile up.
// Expected values are configuration set points, event order and tag names from the P&ID — never numbers taken from
// the code under test.
'use strict';

const WP = 'WTS31';
const NOISE_OFF = { noise: { on: false } };

function sim(app, o, flow) { const S = app.win.WTS_sim; if (!S) throw new Error('WTS_sim missing (round 7 not built?)'); return S.create(flow || S.SAMPLE_FLOW, app.toWin(Object.assign({ seed: 7 }, o || {}))); }
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
// no surge tank, fast oil, the gauge compartment is never switched before high-high (switch point above LAHH)
function lshhNoSurge(app, extra) {
  const S = app.win.WTS_sim;
  const s = sim(app, { config: Object.assign({ gauge: { switchFrac: 0.995 } }, NOISE_OFF), rigup: { surge: false } }, S.flowFromInputs(app.toWin({ Qo: 4000, Qw: 400 })));
  if (extra) extra(s);
  return s;
}

module.exports = [
  {
    name: 'WTS31 no surge tank: LSHH-301 closes the T-301 inlet; trip / reset texts, event and log name LSHH-301, never LCV-201 or P-201',
    wp: WP,
    run(app, assert) {
      const s = lshhNoSurge(app), trips = [], resets = [];
      s.on('pumpTrip', (p) => trips.push(p)); s.on('pumpReset', (p) => resets.push(p));
      const lahh = app.win.WTS_sim.DEFAULTS.gauge.lahh;
      assert.ok(runUntil(s, 6 * 3600, 5, (x) => x.surge.transfer.trip === 'LSHH_GT'), 'LSHH-301 latched');
      let st = s.getState();
      assert.ok(st.gauge.tanks[0].frac >= lahh - 1e-6, 'T-301A at LAHH ' + st.gauge.tanks[0].frac);
      assert.strictEqual(st.gauge.tanks[0].inlet, false, 'XV-301A commanded shut (fail-safe)');
      assert.strictEqual(st.esd.tripped, false, 'no ESD for LSHH-301');
      assert.strictEqual(trips.length, 1, 'one trip event');
      assert.strictEqual(trips[0].tag, 'LSHH-301', 'event tag');
      assert.match(trips[0].action, /^LSHH-301 trip — XV-301A closing$/, 'event action: ' + trips[0].action);
      const logTrip = st.alarmLog.filter((e) => e.type === 'trip' && e.id === 'LSHH_GT').pop();
      assert.ok(logTrip && /^LSHH-301 trip — /.test(logTrip.msg) && !/LCV-201|P-201/.test(logTrip.msg), 'log: ' + (logTrip && logTrip.msg));
      const A = st.alarms.find((a) => a.id === 'LSHH_GT');
      assert.ok(A && !/LCV-201/.test(A.msg) && /XV-301A closed/.test(A.msg), 'alarm text: ' + (A && A.msg));
      // reopening the tripped compartment is refused until the LSHH-301 trip is reset
      assert.strictEqual(s.setValve('gauge', 0, true), false, 'open refused');
      const ref = s.getState().alarmLog.filter((e) => e.id === 'VALVE').pop();
      assert.ok(ref && /reset the LSHH-301 trip first/.test(ref.msg) && !/P-201/.test(ref.msg), 'refusal: ' + (ref && ref.msg));
      // reset refused while the compartment is above the reset point, and the refusal names the LSHH-301 trip
      let r = s.resetTrip();
      assert.ok(!r.ok, 'reset refused above the reset point');
      const rl = s.getState().alarmLog.filter((e) => e.id === 'PUMP').pop();
      assert.ok(rl && /^LSHH-301 trip reset refused — /.test(rl.msg), 'refusal log: ' + (rl && rl.msg));
      // the compartment settles and drains (P-201) below the reset point → reset
      const reset = app.win.WTS_sim.DEFAULTS.gauge.lshhReset;
      assert.ok(runUntil(s, 4 * 3600, 5, (x) => x.gauge.tanks[0].frac < reset - 0.01), 'T-301A drained below the reset point');
      r = s.resetTrip();
      assert.ok(r.ok && r.reset.indexOf('LSHH_GT') >= 0, 'reset: ' + JSON.stringify(r));
      assert.strictEqual(resets.length, 1);
      assert.strictEqual(resets[0].tag, 'LSHH-301');
      assert.match(resets[0].msg, /^LSHH-301 trip reset — XV-301A\/B may be reopened$/);
      assert.strictEqual(s.setValve('gauge', 0, true), true, 'XV-301A may be reopened after the reset');
      balanced(assert, s.getState(), 'no-surge LSHH-301');
    }
  },
  {
    name: 'WTS31 full rig-up: the LSHH-301 trip still shuts LCV-201 and says so',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_sim;
      const s = sim(app, { config: Object.assign({ gauge: { switchFrac: 0.995 } }, NOISE_OFF) }, S.flowFromInputs(app.toWin({ Qo: 4000, Qw: 400 })));
      const trips = []; s.on('pumpTrip', (p) => trips.push(p));
      assert.ok(runUntil(s, 6 * 3600, 5, (x) => x.surge.transfer.trip === 'LSHH_GT'), 'LSHH-301 latched');
      assert.strictEqual(trips[0].tag, 'LCV-201'); assert.strictEqual(trips[0].action, 'LCV-201 transfer shut');
      assert.strictEqual(s.getState().surge.transfer.q_bpd, 0, 'LCV-201 shut');
    }
  },
  {
    name: 'WTS31 a latched LCV-201 low-low trip is released when the surge tank leaves the rig-up (as LSHH-301 when T-301 leaves)',
    wp: WP,
    run(app, assert) {
      const s = sim(app, { config: NOISE_OFF, seed: 81 });
      s.setValve('surge', 1, false); s.setSuction('B'); s.setConfig(app.toWin({ surge: { lsl: 0.06 } }));
      assert.ok(runUntil(s, 3600, 5, (x) => x.surge.transfer.q_bpd === 0), 'B pumped down to LSL 6 %');
      s.setConfig(app.toWin({ surge: { lsl: 0.25, lsll: 0.08 } }));
      s.setSuction('A');
      assert.ok(runUntil(s, 3600, 5, (x) => x.surge.transfer.q_bpd > 0), 'transfer open on A');
      s.setSuction('B'); s.advance(1);
      assert.strictEqual(s.getState().surge.transfer.trip, 'PUMP_DRYRUN', 'low-low latched');
      s.setRigup(app.toWin({ surge: false }));
      const st = s.getState();
      assert.strictEqual(st.surge.transfer.trip, null, 'latch released');
      assert.ok(!st.alarms.some((a) => a.id === 'PUMP_DRYRUN'), 'alarm cleared');
      const rl = st.alarmLog.filter((e) => e.id === 'RIGUP').pop();
      assert.ok(rl && /LCV-201 low-low latch released/.test(rl.msg), 'rig-up log: ' + (rl && rl.msg));
      balanced(assert, st, 'latch release');
    }
  },
  {
    name: 'WTS31 ESD reset hint names the shut separator dump route: T-201 inlets (full rig-up) or T-301 inlets (no surge tank)',
    wp: WP,
    run(app, assert) {
      const a = sim(app, { config: NOISE_OFF });
      a.setValve('surge', 0, false); a.setValve('surge', 1, false); a.tripESD('test'); a.advance(10);
      assert.ok(a.resetESD().ok);
      assert.match(a.getState().alarmLog.filter((e) => e.id === 'ESD').pop().msg, /XV-201A\/B still shut/);
      const b = sim(app, { config: NOISE_OFF, rigup: { surge: false } });
      b.setValve('gauge', 0, false); b.advance(10); b.tripESD('test'); b.advance(10);
      assert.ok(b.resetESD().ok);
      const m = b.getState().alarmLog.filter((e) => e.id === 'ESD').pop().msg;
      assert.ok(/XV-301A\/B still shut/.test(m) && !/XV-201/.test(m), 'no-surge hint: ' + m);
      const c = sim(app, { config: NOISE_OFF, rigup: { surge: false } });
      c.setValve('surge', 0, false); c.setValve('surge', 1, false); c.tripESD('test'); c.advance(10);
      assert.ok(c.resetESD().ok);
      assert.strictEqual(c.getState().alarmLog.filter((e) => e.id === 'ESD').pop().msg, 'ESD reset — reopening', 'T-201 inlets are irrelevant without T-201');
    }
  },
  {
    name: 'WTS31 performance memos keep the model deterministic: two sims stay bit-identical through rig-up, fluid and geometry changes',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_sim, a = sim(app, { seed: 5 }), b = sim(app, { seed: 5 });
      const step = (f) => { f(a); f(b); };
      step((s) => { for (let i = 0; i < 120; i++) s.advance(10); });
      step((s) => s.setFlow(S.flowFromInputs(app.toWin({ API: 28, SGg: 0.72 }))));
      step((s) => { for (let i = 0; i < 60; i++) s.advance(10); });
      step((s) => s.setRigup(app.toWin({ surge: false })));
      step((s) => { for (let i = 0; i < 60; i++) s.advance(10); });
      step((s) => s.setRigup(app.toWin({ surge: true, heater: false })));
      step((s) => s.setConfig(app.toWin({ sep: { D_in: 42 } })));
      step((s) => { for (let i = 0; i < 60; i++) s.advance(10); });
      assert.strictEqual(JSON.stringify(a.getState()), JSON.stringify(b.getState()), 'bit-identical');
      // the fluid change reached the PVT (Bo at the separator follows the new API / gas gravity)
      const c = sim(app, { seed: 5 }), d = sim(app, { seed: 5 }, S.flowFromInputs(app.toWin({ API: 28, SGg: 0.72 })));
      c.advance(10); d.advance(10);
      c.setFlow(S.flowFromInputs(app.toWin({ API: 28, SGg: 0.72 }))); c.reset(); d.reset();
      for (let i = 0; i < 30; i++) { c.advance(10); d.advance(10); }
      assert.strictEqual(JSON.stringify(c.getState().rates), JSON.stringify(d.getState().rates), 'no stale PVT memo after setFlow');
    }
  },
  {
    name: 'WTS31 live page, no surge tank: the latched LSHH-301 reset button says "Reset LSHH-301" (no LCV-201 in line)',
    wp: WP, integration: true,
    run(app, assert) {
      const s = openWts(app);
      s.setRigup(app.toWin({ surge: false }));
      s.setConfig(app.toWin({ gauge: { switchFrac: 0.995 } }));
      assert.ok(runUntil(s, 8 * 3600, 20, (x) => x.surge.transfer.trip === 'LSHH_GT'), 'LSHH-301 latched');
      app.flush(600);
      const viz = app.el('wts_viz');
      const f = app.win.document.createElement('button'); f.setAttribute('data-act', 'focus'); f.setAttribute('data-v', 'gauge'); viz.appendChild(f); app.click(f); f.remove();
      app.flush(300);
      const card = app.el('wtsl_card'), btn = card && card.querySelector('[data-act="xfer-reset"]');
      assert.ok(btn, 'reset button shown');
      assert.match(String(btn.textContent), /^Reset LSHH-301$/);
      const lbl = btn.parentNode.querySelector('.wtsl-hl');
      assert.strictEqual(String(lbl.textContent), 'LSHH-301 trip');
    }
  },
  {
    name: 'WTS31 GUI sweep: every button on the live simulator page works (no handler error, no console error) and the rig-up switches round-trip',
    wp: WP, integration: true, opts: { confirm: true },
    run(app, assert) {
      const s = openWts(app);
      const root = app.el('wts_viz');
      assert.ok(root, 'live view root');
      const seen = new Set(), done = [];
      const sig = (b) => b.getAttribute('data-act') + '|' + (b.getAttribute('data-v') || '');
      const visible = (b) => { const r = b.getBoundingClientRect(); return r.width > 0 && !b.disabled && b.isConnected; };
      const skip = new Set(['max|']);            // full-screen toggle: pressed separately (twice) below
      for (let pass = 0; pass < 400; pass++) {
        // an open menu first (its items), then the page
        const inMenu = Array.from(app.document.querySelectorAll('.wtsl-menu [data-act]')).filter(visible);
        const all = inMenu.concat(Array.from(root.querySelectorAll('[data-act]')).filter(visible));
        const next = all.find((b) => !seen.has(sig(b)) && !skip.has(sig(b)));
        if (!next) break;
        seen.add(sig(next)); done.push(sig(next));
        app.click(next); app.flush(120);
        // a confirmation menu (reset / trip) → confirm, so the action itself runs
        const yes = app.find('[data-act="confirm-yes"]');
        if (yes && visible(yes)) { app.click(yes); app.flush(120); seen.add('confirm-yes|'); }
      }
      const confirmIf = () => { const yes = app.find('[data-act="confirm-yes"]'); if (yes && visible(yes)) { app.click(yes); app.flush(120); } };
      // every item of every toolbar menu (a menu closes after an item: reopen it for the next one)
      ['resetmenu', 'scen', 'viewmenu', 'colour', 'more'].forEach((op) => {
        const opener = () => root.querySelector('[data-act="' + op + '"]');
        const items = () => Array.from(app.document.querySelectorAll('.wtsl-menu [data-act]')).filter(visible);
        if (!opener()) return;
        app.click(opener()); app.flush(60);
        const sigs = items().map(sig);
        if (!items().length) return;
        app.click(opener()); app.flush(60);                // close
        sigs.forEach((sg) => {
          if (seen.has(sg) || sg === 'menu-close|') return;
          if (!items().length) { app.click(opener()); app.flush(60); }
          const it = items().find((b) => sig(b) === sg);
          if (!it) return;
          seen.add(sg); done.push(sg);
          app.click(it); app.flush(120); confirmIf();
          if (items().length && app.document.querySelector('.wtsl-menu [data-act="menu-close"]')) { app.click(app.document.querySelector('.wtsl-menu [data-act="menu-close"]')); app.flush(30); }
        });
        if (items().length) { app.click(opener()); app.flush(30); }
      });
      // every equipment card (the 3D / 2D pick path) and every action in it
      ['wellhead', 'esd', 'choke', 'heater', 'separator', 'flare', 'surge', 'pump', 'gauge'].forEach((eq) => {
        const f = app.document.createElement('button'); f.setAttribute('data-act', 'focus'); f.setAttribute('data-v', eq); root.appendChild(f); app.click(f); f.remove();
        app.flush(200);
        const card = app.el('wtsl_card');
        assert.ok(card && visible(card), eq + ' card opens');
        for (let k = 0; k < 40; k++) {
          const c = app.el('wtsl_card'); if (!c) break;
          const b = Array.from(c.querySelectorAll('[data-act]')).filter(visible).find((x) => !seen.has(eq + ':' + sig(x)) && sig(x) !== 'card-close|');
          if (!b) break;
          seen.add(eq + ':' + sig(b)); done.push(eq + ':' + sig(b));
          app.click(b); app.flush(120); confirmIf();
          if (!app.el('wtsl_card') || !visible(app.el('wtsl_card'))) { root.appendChild(f); app.click(f); f.remove(); app.flush(120); }
        }
        const cc = app.el('wtsl_card') && app.el('wtsl_card').querySelector('[data-act="card-close"]');
        if (cc && visible(cc)) { app.click(cc); app.flush(60); done.push(eq + ':card-close|'); }
      });
      const mx = app.find('[data-act="max"]');
      if (mx) { app.click(mx); app.flush(100); app.click(mx); app.flush(100); done.push('max|'); }
      if (process.env.WTS_SWEEP_VERBOSE) console.log('pressed ' + done.length + ': ' + done.join(' '));
      ['play', 'speed', 'esd', 'resetmenu', 'alarms', 'mode2d', 'fault', 'dtab', 'ackall', 'view', 'gauge:valve', 'surge:suction', 'surge:auto', 'choke:bean', 'separator:sp', 'heater:bypass'].forEach((a) => assert.ok(done.some((d) => d.indexOf(a + '|') === 0), 'pressed ' + a + ' (' + done.length + ' buttons)'));
      assert.ok(done.length >= 80, 'buttons pressed: ' + done.length);
      // rig-up switches: each one out and back in
      const rig = app.el('wtsl_rigup');
      assert.ok(rig, 'rig-up card');
      const keys = Array.from(rig.querySelectorAll('[data-rig]')).filter((b) => !b.disabled).map((b) => b.getAttribute('data-rig'));
      assert.ok(keys.length >= 6, 'switches: ' + keys.join());
      keys.forEach((k) => {
        app.click(rig.querySelector('[data-rig="' + k + '"]')); app.flush(60);
        assert.strictEqual(s.getRigup()[k], false, k + ' out');
        app.click(rig.querySelector('[data-rig="' + k + '"]')); app.flush(60);
        assert.strictEqual(s.getRigup()[k], true, k + ' back in');
      });
      app.click(rig.querySelector('[data-rig-act="all"]')); app.flush(60);
      assert.strictEqual(s.getState().rigup.full, true, 'full rig-up');
      assert.deepStrictEqual(app.errors.map((e) => e.message), [], 'no handler errors');
      assert.deepStrictEqual(app.consoleErrors().map((l) => l.text), [], 'no console errors');
      balanced(assert, s.getState(), 'after the sweep');
    }
  }
];
