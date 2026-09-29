// Well Test Simulator — tank inlet divert valves (Round-7: 31-wts-sim, 32-wts-3d, 38-wts-live).
//   • Gauge tank T-301A/B inlet valves XV-301A/B route the P-201 discharge left / right.
//   • Surge tank T-201 is two compartments A | B (half of cap_bbl each, common gas space) with inlet valves
//     XV-201A/B and a selectable P-201 suction (A, B or both).
//   • Auto-divert (per tank, off by default): at the high-level set point the filling compartment diverts to
//     the other one when it has room (below SP − hysteresis) — open the new inlet, then close the old one;
//     with no room anywhere a both-high alarm is raised instead and nothing switches back and forth.
//   • The lineup and toggles persist in the live view's prefs (h2viz3d_prefs → WTS_sim.setControls).
// Most checks drive WTS_sim directly (deterministic seeds, noise off where exactness matters); the UI checks
// open the Well Test Simulator page, which falls back to the live 2D schematic in the harness (no WebGL).
'use strict';

const WP = 'WTSDV';
const NOISE_OFF = { noise: { on: false } };

function sim(app, o) { const S = app.win.WTS_sim; if (!S) throw new Error('WTS_sim missing (round 7 not built?)'); return S.create(S.SAMPLE_FLOW, app.toWin(Object.assign({ seed: 7 }, o || {}))); }
function run(s, secs, dt, cb) { const n = Math.round(secs / dt); for (let i = 0; i < n; i++) { s.advance(dt); if (cb && cb(s.getState(), i) === false) return; } }
function balanced(assert, st, where) {
  const m = st.health.massErr;
  assert.ok(Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9, where + ': mass balance ' + JSON.stringify(m));
}
function alarmIds(st) { return st.alarms.map((a) => a.id); }
const plain = (x) => JSON.parse(JSON.stringify(x));   // app-realm values → this realm (deepStrictEqual)
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
    name: 'WTSDV gauge tank: XV-301A/B route the fill left or right; both closed blocks P-201 with an alarm',
    wp: WP,
    run(app, assert) {
      const s = sim(app, { config: NOISE_OFF });
      let st = s.getState();
      assert.deepStrictEqual(plain([st.gauge.tanks[0].inlet, st.gauge.tanks[1].inlet]), [true, false], 'default lineup: A open, B closed');
      assert.strictEqual(st.gauge.tanks[0].valveTag, 'XV-301A');
      run(s, 300, 5);
      const a0 = st.gauge.tanks[0].Vo_stb;
      assert.ok(a0 > 0 && st.gauge.tanks[1].Vo_stb === 0, 'A fills, B empty');
      // divert to B: open B first, then close A
      assert.strictEqual(s.setValve('gauge', 1, true), true, 'open XV-301B');
      assert.strictEqual(s.setValve('gauge', 0, false), true, 'close XV-301A');
      st = s.getState();
      assert.strictEqual(st.gauge.active, 1, 'B is the active compartment');
      // v3.0: divert valves travel (stroke from the DEFAULTS). XV-301A is held open until XV-301B reaches its open
      // limit (open-new-before-close-old), then strokes shut — A keeps filling until then.
      const stroke = app.win.WTS_sim.DEFAULTS.gauge.xvStrokeS;
      assert.ok(stroke > 0 && st.gauge.tanks[0].hold === true && st.gauge.tanks[0].state === 'filling', 'A held open while B opens');
      run(s, 2 * stroke, 1);
      st = s.getState();
      assert.ok(st.gauge.tanks[0].pos === 0 && st.gauge.tanks[1].pos === 1 && !st.gauge.tanks[0].moving, 'both valves at their limits after 2 strokes');
      assert.strictEqual(st.gauge.tanks[0].state, 'settling', 'A settles after its inlet closes');
      assert.strictEqual(st.gauge.tanks[1].state, 'filling', 'B fills');
      const aAt = st.gauge.tanks[0].Vo_stb + st.gauge.tanks[0].Vw_bbl, bAt = st.gauge.tanks[1].Vo_stb;
      let sawFillB = false;
      run(s, 700, 5, (x) => { if (x.gauge.tanks[1].fill_bpd > 0) sawFillB = true; assert.strictEqual(x.gauge.tanks[0].fill_bpd, 0, 'no flow to A'); });
      st = s.getState();
      assert.ok(sawFillB && st.gauge.tanks[1].Vo_stb > bAt + 1, 'B gains oil (' + bAt + ' → ' + st.gauge.tanks[1].Vo_stb + ')');
      assert.ok(st.gauge.tanks[0].Vo_stb + st.gauge.tanks[0].Vw_bbl <= aAt + 1e-9, 'A gains nothing');
      assert.strictEqual(st.gauge.batches.length, 1, 'A recorded its batch after settling');
      assert.strictEqual(st.gauge.batches[0].tag, 'T-301A');
      // both open: the discharge splits
      s.setValve('gauge', 0, true); run(s, 3600, 5, (x) => !(x.surge.pump.q_bpd > 0)); st = s.getState();   // until P-201 runs
      assert.ok(st.gauge.tanks[0].fill_bpd > 0 && st.gauge.tanks[1].fill_bpd > 0, 'both open → both fill');
      assert.near(st.gauge.tanks[0].fill_bpd, st.gauge.tanks[1].fill_bpd, 1e-6, 'even split');
      // both closed: dead-head protection — P-201 stops, PUMP_BLOCKED, surge level rises
      s.setValve('gauge', 0, false); s.setValve('gauge', 1, false);
      const su0 = s.getState().surge.frac;
      run(s, 120, 5); st = s.getState();
      assert.strictEqual(st.gauge.blocked, true, 'gauge.blocked');
      assert.strictEqual(st.surge.pump.q_bpd, 0, 'pump stopped');
      assert.strictEqual(st.surge.pump.blocked, true, 'pump.blocked');
      assert.ok(alarmIds(st).indexOf('PUMP_BLOCKED') >= 0, 'PUMP_BLOCKED alarm: ' + alarmIds(st));
      assert.ok(st.surge.frac > su0, 'surge tank takes the flow');
      // reopen → pump resumes, alarm clears
      s.setValve('gauge', 1, true); run(s, 120, 5); st = s.getState();
      assert.ok(alarmIds(st).indexOf('PUMP_BLOCKED') < 0, 'alarm clears');
      assert.ok(!st.surge.pump.blocked, 'pump unblocked');
      balanced(assert, st, 'gauge routing');
      const log = st.alarmLog.filter((e) => e.id === 'VALVE').map((e) => e.msg);
      assert.ok(log.some((m) => /^XV-301B opened \(manual\)/.test(m)) && log.some((m) => /^XV-301A closed \(manual\)/.test(m)), 'valve operations logged');
    }
  },
  {
    name: 'WTSDV surge tank: two compartments with per-compartment level/inventory, divert + selectable P-201 suction',
    wp: WP,
    run(app, assert) {
      const s = sim(app, { config: NOISE_OFF, seed: 11 });
      let st = s.getState();
      assert.strictEqual(st.surge.comps.length, 2, 'two compartments');
      assert.deepStrictEqual(plain(st.surge.comps.map((c) => c.tag)), ['T-201A', 'T-201B']);
      assert.deepStrictEqual(plain(st.surge.comps.map((c) => c.valveTag)), ['XV-201A', 'XV-201B']);
      assert.near(st.surge.comps[0].cap_bbl, st.surge.cap_bbl / 2, 1e-9, 'each compartment is half the tank');
      // default: both inlets open, suction from both → equal levels = the tank level (legacy single-tank behaviour)
      run(s, 1800, 10, (x) => { assert.near(x.surge.comps[0].frac, x.surge.comps[1].frac, 1e-6, 'A = B'); assert.near(x.surge.frac, (x.surge.comps[0].frac + x.surge.comps[1].frac) / 2, 1e-9, 'total = mean'); });
      st = s.getState();
      const volSum = st.surge.comps[0].Vo_bbl + st.surge.comps[0].Vw_bbl + st.surge.comps[1].Vo_bbl + st.surge.comps[1].Vw_bbl;
      assert.near(volSum, st.surge.Vo_bbl + st.surge.Vw_bbl, 1e-9, 'compartment inventories add up');
      // route the separator liquids to A only and pump from A: B is isolated (no fill, no draw)
      assert.strictEqual(s.setValve('surge', 1, false), true, 'close XV-201B');
      assert.strictEqual(s.setSuction('A'), true, 'suction A');
      run(s, app.win.WTS_sim.DEFAULTS.surge.xvStrokeS, 1);        // v3.0: XV-201B strokes shut before B is isolated
      st = s.getState();
      assert.strictEqual(st.surge.suction, 'A'); assert.strictEqual(st.surge.pump.suction, 'A');
      assert.deepStrictEqual(plain(st.surge.comps.map((c) => c.suction)), [true, false]);
      const b0 = st.surge.comps[1].Vo_stb + st.surge.comps[1].Vw_bbl;
      let aMax = 0, aMinAfter = 1, pumped = false;
      run(s, 3600, 5, (x) => {
        assert.strictEqual(x.surge.comps[1].fill_bpd, 0, 'nothing enters B'); assert.strictEqual(x.surge.comps[1].draw_bpd, 0, 'nothing drawn from B');
        aMax = Math.max(aMax, x.surge.comps[0].frac); if (x.surge.pump.q_bpd > 0) { pumped = true; assert.ok(x.surge.comps[0].draw_bpd > 0, 'P-201 draws A'); }
        if (pumped) aMinAfter = Math.min(aMinAfter, x.surge.comps[0].frac);
      });
      st = s.getState();
      assert.near(st.surge.comps[1].Vo_stb + st.surge.comps[1].Vw_bbl, b0, 1e-9, 'B inventory unchanged');
      // P-201 on/off level control follows its suction compartment: starts at LSH on A, stops at LSL on A
      assert.ok(pumped && aMax >= st.surge.lsh - 0.005 && aMax < st.surge.lsh + 0.02, 'pump started at A high level (max ' + aMax + ')');
      assert.ok(aMinAfter <= st.surge.lsl + 0.01, 'pumped A down to LSL (' + aMinAfter + ')');
      // now pump from B only: A has no outlet → with auto-divert off it overfills → LSHH-201 names T-201A and trips the ESD
      s.setSuction('B');
      run(s, 4 * 3600, 5, (x) => { assert.strictEqual(x.surge.comps[0].draw_bpd, 0, 'nothing drawn from A'); return !x.esd.tripped; });
      st = s.getState();
      assert.strictEqual(st.esd.cause, 'LSHH_SURGE', 'ESD cause ' + st.esd.cause);
      assert.ok(/T-201A level/.test(st.esd.causeMsg), 'message names T-201A: ' + st.esd.causeMsg);
      balanced(assert, st, 'surge compartments');
      // both inlets shut: separator dumps blocked (alarm), separator backs up
      const s2 = sim(app, { seed: 12 });
      s2.setValve('surge', 0, false); s2.setValve('surge', 1, false);
      let tTrip = null;
      run(s2, 600, 1, (x) => { if (x.esd.tripped) { tTrip = x.t; return false; } });
      const st2 = s2.getState();
      assert.strictEqual(st2.surge.blocked, true, 'surge.blocked');
      assert.ok(alarmIds(st2).indexOf('SURGE_BLOCKED') >= 0, 'SURGE_BLOCKED alarm');
      assert.ok(tTrip !== null && /^LSHH_SEP$/.test(st2.esd.cause), 'separator trips on high level: ' + st2.esd.cause);
      assert.strictEqual(st2.sep.oilDump.q_bpd + st2.sep.waterDump.q_bpd, 0, 'no dump flow');
    }
  },
  {
    name: 'WTSDV auto-divert: switches at the set point (open new, then close old) with hysteresis — surge and gauge',
    wp: WP,
    run(app, assert) {
      // surge: fill A, pump from B; auto on at SP 80 %, hysteresis 10 %
      const s = sim(app, { config: NOISE_OFF, seed: 21 });
      assert.strictEqual(s.getState().surge.auto.on, false, 'auto-divert is off by default');
      s.setValve('surge', 1, false); s.setSuction('B');
      assert.strictEqual(s.setAutoDivert('surge', true), true);
      const st0 = s.getState();
      assert.strictEqual(st0.surge.auto.on, true); assert.near(st0.surge.auto.sp, 0.8, 1e-12); assert.near(st0.surge.auto.hyst, 0.1, 1e-12);
      const ev = [];
      s.on('divert', (p, st) => ev.push({ t: p.t, eq: p.eq, from: p.from, to: p.to, lv: [st.surge.comps[0].frac, st.surge.comps[1].frac], inlet: [st.surge.comps[0].inlet, st.surge.comps[1].inlet], suction: st.surge.suction }));
      let maxLv = 0;
      run(s, 4 * 3600, 5, (x) => { maxLv = Math.max(maxLv, x.surge.comps[0].frac, x.surge.comps[1].frac); });
      const st = s.getState();
      assert.ok(ev.length >= 2, 'automatic switches ' + ev.length);
      ev.forEach((e, i) => {
        assert.strictEqual(e.eq, 'surge');
        // (levels are read at the end of the 5 s advance: the full side is already being pumped down)
        assert.ok(e.lv[e.from] >= 0.8 - 0.01 && e.lv[e.from] < 0.81, '#' + i + ' switched at the set point (' + e.lv[e.from] + ')');
        assert.ok(e.lv[e.to] < 0.7 + 0.01, '#' + i + ' only into a compartment with room (' + e.lv[e.to] + ')');
        assert.deepStrictEqual(plain(e.inlet), e.to ? [false, true] : [true, false], '#' + i + ' lineup after the switch');
        assert.strictEqual(e.suction, e.from ? 'B' : 'A', '#' + i + ' P-201 now draws the full compartment');
        if (i) assert.ok(e.from !== ev[i - 1].from, '#' + i + ' alternates (no back-and-forth on one side)');
      });
      for (let i = 1; i < ev.length; i++) assert.ok(ev[i].t - ev[i - 1].t > 600, 'hysteresis spacing ' + (ev[i].t - ev[i - 1].t) + ' s');
      assert.ok(maxLv < st.surge.lshh, 'never reached LSHH-201 (max ' + maxLv.toFixed(3) + ')');
      assert.ok(!st.esd.tripped, 'no trip with auto-divert on');
      const log = st.alarmLog.filter((e) => e.id === 'AUTO_DIVERT');
      assert.ok(log.length >= 1 && log.every((e) => e.type === 'switch'), 'auto switches logged as switch events');
      assert.ok(/XV-201[AB] open, XV-201[AB] closed/.test(log[0].msg), 'log names the valves: ' + log[0].msg);
      balanced(assert, st, 'surge auto');

      // gauge: auto on at SP 60 % — diverts to the other compartment before the batch sequencer's 90 % switch
      const g = sim(app, { config: NOISE_OFF, seed: 22 });
      g.setAutoDivert('gauge', true, { sp: 0.6 });
      const gev = [], sw = [];
      g.on('divert', (p, st2) => gev.push({ t: p.t, from: p.from, to: p.to, f: [st2.gauge.tanks[0].frac, st2.gauge.tanks[1].frac] }));
      g.on('switch', (p) => sw.push(p.t));
      run(g, 5 * 3600, 10);
      assert.ok(gev.length >= 2, 'gauge auto switches ' + gev.length);
      gev.forEach((e, i) => {
        assert.ok(e.f[e.from] >= 0.6 - 1e-4 && e.f[e.from] < 0.61, '#' + i + ' at the set point (' + e.f[e.from] + ')');   // (then shrinks as it cools)
        assert.ok(e.f[e.to] < 0.5 + 0.01, '#' + i + ' into room (' + e.f[e.to] + ')');
      });
      assert.strictEqual(sw.length, 0, 'the 90 % sequencer never had to switch');
      const gs = g.getState();
      assert.ok(gs.gauge.batches.length >= 1, 'batches still recorded');
      balanced(assert, gs, 'gauge auto');
      // set point limits: surge SP ≤ LSHH − 2 %, gauge SP ≤ LAHH − 2 %
      g.setAutoDivert('surge', true, { sp: 0.99 }); g.setAutoDivert('gauge', true, { sp: 0.99, hyst: 0.9 });
      const c = g.getControls();
      assert.near(c.surge.sp, 0.88, 1e-9, 'surge SP clamp'); assert.near(c.gauge.sp, 0.95, 1e-9, 'gauge SP clamp'); assert.near(c.gauge.hyst, 0.5, 1e-9, 'hysteresis clamp');
    }
  },
  {
    name: 'WTSDV both compartments high: LAH alarm, no switching back and forth',
    wp: WP,
    run(app, assert) {
      // surge: P-201 failed, inlet A only, auto on → one divert to B, then both high → LAH-201, no more switches
      const s = sim(app, { config: NOISE_OFF, seed: 31 });
      s.setValve('surge', 1, false); s.setAutoDivert('surge', true); s.setFault('surgePumpFail', true);
      const ev = [];
      s.on('divert', (p) => ev.push(p.t));
      let tBoth = null;
      run(s, 3 * 3600, 5, (x) => { if (tBoth === null && alarmIds(x).indexOf('LAH_SURGE_BOTH') >= 0) tBoth = x.t; if (x.esd.tripped) return false; });
      const st = s.getState();
      assert.strictEqual(ev.length, 1, 'exactly one divert (A → B) before both are high: ' + ev.length);
      assert.ok(tBoth !== null && tBoth > ev[0], 'LAH_SURGE_BOTH raised after the divert');
      const a = st.alarmLog.filter((e) => e.id === 'LAH_SURGE_BOTH' && e.type === 'raise');
      assert.ok(a.length >= 1 && /both surge compartments high/.test(a[0].msg), 'alarm text: ' + (a[0] && a[0].msg));
      assert.strictEqual(st.alarmLog.filter((e) => e.id === 'AUTO_DIVERT').length, 1, 'no further automatic switches');
      // gauge: both compartments above SP − hysteresis → LAH_GT_BOTH and no switch
      const g = sim(app, { config: NOISE_OFF, seed: 32 });
      g.setAutoDivert('gauge', true, { sp: 0.5 });
      const gd = [];
      g.on('divert', (p) => gd.push(p.t));
      let seen = false;
      // A fills to 50 % → divert to B; B fills to 50 % while A is still settling above 40 % → both high
      g.setConfig({ gauge: { settleS: 7200 } });
      run(g, 3 * 3600, 10, (x) => { if (alarmIds(x).indexOf('LAH_GT_BOTH') >= 0) { seen = true; return false; } });
      assert.ok(seen, 'LAH_GT_BOTH raised');
      const n0 = gd.length;
      run(g, 1200, 10);
      assert.strictEqual(gd.length, n0, 'no switching while both are high');
    }
  },
  {
    name: 'WTSDV persistence: getControls/setControls round-trip; reset keeps the lineup; the live view restores it after reload',
    wp: WP,
    integration: true,
    run(app, assert, ctx) {
      const s = sim(app, { seed: 41 });
      s.setValve('surge', 0, false); s.setSuction('A'); s.setAutoDivert('surge', true, { sp: 0.75, hyst: 0.15 });
      s.setValve('gauge', 1, true); s.setValve('gauge', 0, false); s.setAutoDivert('gauge', true);
      assert.strictEqual(s.setValveOptions('gauge', app.toWin({ strokeS: 8, allowInterrupt: true })), true, 'gauge valve options');
      const c = JSON.parse(JSON.stringify(s.getControls()));
      // v3.0 adds the valve stroke (both tanks) and the gauge "allow interrupting batches" option to the lineup
      assert.deepStrictEqual(c, { surge: { inlet: [false, true], suction: 'A', auto: true, sp: 0.75, hyst: 0.15, strokeS: 6 },
        gauge: { inlet: [false, true], auto: true, sp: 0.9, hyst: 0.1, strokeS: 8, allowInterrupt: true }, v: 1 });
      // a fresh sim restored at t = 0: same lineup, the initial gauge fill sits in B (no batch side effects)
      const s2 = sim(app, { seed: 41 });
      assert.strictEqual(s2.setControls(app.toWin(c), app.toWin({ initial: true })), true);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(s2.getControls())), c, 'round-trip');
      let st = s2.getState();
      assert.strictEqual(st.gauge.tanks[1].state, 'filling'); assert.strictEqual(st.gauge.tanks[0].state, 'ready');
      assert.ok(st.gauge.tanks[1].Vo_stb > 0 && st.gauge.tanks[0].Vo_stb === 0, 'initial inventory moved to B');
      assert.strictEqual(st.gauge.active, 1);
      assert.strictEqual(st.alarmLog.length, 0, 'initial restore logs nothing');
      // reset keeps the operator lineup
      s2.advance(60); s2.reset('steady');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(s2.getControls())), c, 'lineup kept across reset');
      st = s2.getState();
      assert.strictEqual(st.gauge.tanks[1].state, 'filling', 'reset refills into B');
      // bad input is ignored / clamped, never throws
      assert.strictEqual(s2.setControls(null), false);
      s2.setControls(app.toWin({ surge: { suction: 'X', sp: 'high' }, gauge: { inlet: [1] } }));
      assert.deepStrictEqual(JSON.parse(JSON.stringify(s2.getControls())), c, 'invalid fields ignored');
      // live view: lineup changes persist in h2viz3d_prefs and are restored after a reload
      const live = openWts(app);
      live.setValve('gauge', 1, true); live.setValve('gauge', 0, false); live.setSuction('B'); live.setAutoDivert('surge', true);
      app.flush(50);
      const prefs = JSON.parse(app.win.localStorage.getItem('h2viz3d_prefs') || '{}');
      assert.ok(prefs.ctl && prefs.ctl.gauge.inlet[1] === true && prefs.ctl.gauge.inlet[0] === false && prefs.ctl.surge.suction === 'B' && prefs.ctl.surge.auto === true,
        'prefs.ctl saved: ' + JSON.stringify(prefs.ctl));
      const app2 = ctx.loadApp({ storage: app.storage });
      try {
        const live2 = openWts(app2);
        const c2 = JSON.parse(JSON.stringify(live2.getControls()));
        assert.deepStrictEqual(c2, prefs.ctl, 'restored after reload');
        assert.strictEqual(live2.getState().gauge.active, 1, 'restored run fills B');
      } finally { if (app2.dispose) app2.dispose(); }
    }
  },
  {
    name: 'WTSDV live 2D: valve glyphs drawn, click toggles XV-301B, card buttons drive the lineup and auto-divert',
    wp: WP,
    integration: true,
    run(app, assert) {
      const live = openWts(app);
      const cv = app.el('wts_viz').querySelector('canvas');
      assert.ok(cv, 'schematic canvas');
      app.flush(1000);
      const L = app.win.WTS_DIAG_LAYOUT, r = cv.getBoundingClientRect();
      const at = (x, y) => ({ clientX: r.left + x / L.W * r.width, clientY: r.top + y / L.H * r.height, bubbles: true });
      const texts = app.canvasTexts(cv);
      assert.ok(texts.indexOf('A') >= 0 && texts.indexOf('B') >= 0, 'compartment letters drawn');
      // click the XV-301B glyph (above T-301B) → opens B
      const gx = L.bx[1] + 9, gy = L.by - 26;
      assert.strictEqual(live.getState().gauge.tanks[1].inlet, false);
      app.fire(cv, 'click', null);  // no coordinates → no zone
      cv.dispatchEvent(Object.assign(new app.win.MouseEvent('click', at(gx, gy)), {}));
      assert.strictEqual(live.getState().gauge.tanks[1].inlet, true, 'XV-301B opened from the schematic');
      // click the T-201 suction marker under B → suction goes from both to A (B's suction valve closes)
      cv.dispatchEvent(new app.win.MouseEvent('click', at(L.bx[0] + 8, L.by + 23)));
      assert.strictEqual(live.getState().surge.suction, 'A', 'SV-201B closed from the schematic');
      // open the surge info card (click the tank body) and use its buttons
      cv.dispatchEvent(new app.win.MouseEvent('click', at(L.bx[0], L.by + 5)));
      const card = app.el('wtsl_card');
      assert.ok(card && !card.hidden, 'surge card open');
      const btn = (act, v) => card.querySelector('[data-act="' + act + '"]' + (v != null ? '[data-v="' + v + '"]' : ''));
      assert.ok(btn('valve', 'surge:0') && btn('valve', 'surge:1') && btn('suction', 'both') && btn('auto', 'surge'), 'lineup controls present');
      app.click(btn('valve', 'surge:1'));
      assert.strictEqual(live.getState().surge.comps[1].inlet, false, 'XV-201B closed from the card');
      app.click(btn('suction', 'B'));
      assert.strictEqual(live.getState().surge.suction, 'B', 'suction B from the card');
      app.click(btn('auto', 'surge'));
      assert.strictEqual(live.getState().surge.auto.on, true, 'auto-divert on from the card');
      app.click(btn('autosp', 'surge:-0.05'));
      assert.near(live.getState().surge.auto.sp, 0.75, 1e-9, 'set point − 5 %');
      const t = String(card.textContent);
      assert.ok(/T-201A/.test(t) && /T-201B/.test(t) && /Auto-divert/.test(t), 'card rows');
      assert.ok(!/NaN|undefined/.test(t), 'no NaN in the card');
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().join(' | '));
    }
  }
];
