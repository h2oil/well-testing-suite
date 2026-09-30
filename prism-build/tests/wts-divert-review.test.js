// Well Test Simulator — adversarial review of the tank divert valves / twin-compartment surge tank (Round-7).
//   • Separator water-dump level crossings are located by the adaptive step (F.rW1 is the true pre/post-step rate).
//   • Both gauge inlets closed at t = 0 records no empty zero-length batch.
//   • Long randomised operator sequences (every lineup, auto on/off, rapid toggling, faults, high / low rates):
//     finite state, no negative inventory, compartments add up, global mass balance, per-compartment flow direction.
//   • Auto-divert: no chattering, every automatic switch is logged; blocked / both-high alarms clear.
//   • Live view: automatic lineup changes persist; 2D valve glyphs work on a 375 px phone layout.
// Expected values are set points from the configuration (LSH, SP, delays), conservation laws or event counts —
// never numbers produced by the code under test.
'use strict';

const WP = 'WTSDV';
const NOISE_OFF = { noise: { on: false } };

function sim(app, o, flow) { const S = app.win.WTS_sim; if (!S) throw new Error('WTS_sim missing'); return S.create(flow || S.SAMPLE_FLOW, app.toWin(Object.assign({ seed: 7 }, o || {}))); }
function alarmIds(st) { return st.alarms.map((a) => a.id); }
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
function openWts(app) {
  const b = app.find('.nav-btn[data-p="wts"]');
  if (!b) throw new Error('no Well Test Simulator sidebar button');
  app.click(b); app.flush(500);
  const L = app.win.WTS_live, s = L && L.getSim && L.getSim();
  if (!s) throw new Error('live simulator did not start');
  return s;
}
// per-step invariants; returns a compact copy of the inventories for the flow-direction checks
function inv(st) {
  return { u: st.surge.comps.map((c) => [c.Vo_stb, c.Vw_bbl, c.frac]), g: st.gauge.tanks.map((t) => [t.Vo_stb, t.Vw_bbl, t.frac, t.state]) };
}
function checkStep(assert, st, where) {
  const nums = [st.surge.frac, st.surge.P, st.surge.Vo_stb, st.surge.Vw_bbl, st.sep.P, st.sep.c1.fracW];
  st.surge.comps.forEach((c) => nums.push(c.frac, c.fracW, c.Vo_stb, c.Vw_bbl, c.fill_bpd, c.draw_bpd));
  st.gauge.tanks.forEach((t) => nums.push(t.frac, t.Vo_stb, t.Vw_bbl, t.fill_bpd, t.drain_bpd));
  if (!nums.every(Number.isFinite)) assert.fail(where + ': non-finite state ' + JSON.stringify(nums));
  st.surge.comps.forEach((c) => { if (c.Vo_stb < 0 || c.Vw_bbl < 0 || c.frac > 1 + 1e-9) assert.fail(where + ': ' + c.tag + ' inventory ' + c.Vo_stb + ' / ' + c.Vw_bbl + ' / ' + c.frac); });
  st.gauge.tanks.forEach((t) => { if (t.Vo_stb < 0 || t.Vw_bbl < 0 || t.frac > 1 + 1e-9) assert.fail(where + ': ' + t.tag + ' inventory ' + t.Vo_stb + ' / ' + t.Vw_bbl + ' / ' + t.frac); });
  const cs = st.surge.comps.reduce((a, c) => a + c.Vo_bbl + c.Vw_bbl, 0);
  if (Math.abs(cs - (st.surge.Vo_bbl + st.surge.Vw_bbl)) > 1e-7) assert.fail(where + ': compartments ' + cs + ' ≠ tank ' + (st.surge.Vo_bbl + st.surge.Vw_bbl));
  const m = st.health.massErr;
  if (!(Math.abs(m.oil) < 1e-9 && Math.abs(m.water) < 1e-9 && Math.abs(m.gas) < 1e-9)) assert.fail(where + ': mass balance ' + JSON.stringify(m));
}
// Over one interval with an unchanged lineup (no 'control' event) and no baffle overflow, every compartment's
// inventory can only move in the direction its valves allow: isolated → constant, inlet only → non-decreasing,
// suction only → non-increasing. Gauge compartments with the inlet shut and not draining are constant.
function checkDirections(assert, a, b, lineup, where) {
  const tol = 1e-9;
  for (let k = 0; k < 2; k++) {
    const inl = lineup.uIn[k], suc = lineup.suc === 'both' || lineup.suc === (k ? 'B' : 'A');
    if (Math.max(a.u[0][2], a.u[1][2], b.u[0][2], b.u[1][2]) > 0.975) continue;     // baffle overflow possible
    for (let p = 0; p < 2; p++) {
      const d = b.u[k][p] - a.u[k][p], sc = Math.max(1, Math.abs(a.u[k][p]));
      if (!inl && !suc && Math.abs(d) > tol * sc) assert.fail(where + ': isolated T-201' + 'AB'[k] + ' changed by ' + d);
      if (inl && !suc && d < -tol * sc) assert.fail(where + ': T-201' + 'AB'[k] + ' (inlet only) fell by ' + d);
      if (!inl && suc && d > tol * sc) assert.fail(where + ': T-201' + 'AB'[k] + ' (suction only) rose by ' + d);
    }
    if (!lineup.gIn[k] && a.g[k][3] !== 'draining' && b.g[k][3] !== 'draining' && a.g[k][2] < 0.999)
      for (let p = 0; p < 2; p++) { const d = b.g[k][p] - a.g[k][p]; if (Math.abs(d) > tol * Math.max(1, Math.abs(a.g[k][p]))) assert.fail(where + ': T-301' + 'AB'[k] + ' (inlet shut, ' + b.g[k][3] + ') changed by ' + d); }
  }
}
// v3.0: divert valves travel — a compartment can receive flow while its valve is commanded shut but not yet at its closed
// limit (or held open by the open-new-before-close-old interlock), so "inlet" = commanded open OR valve not shut.
function lineupOf(st) { return { uIn: st.surge.comps.map((c) => !!c.inlet || c.pos > 0), suc: st.surge.suction, gIn: st.gauge.tanks.map((t) => !!t.inlet || t.pos > 0) }; }

module.exports = [
  {
    name: 'WTSDV-R separator water dump: LSH crossing located by the step control (dump opens at the set point, not on the 0.25 s grid)',
    wp: WP,
    run(app, assert) {
      // Snap-mode LCV-101 opens when the interface reaches LSH (sep.water.lsh = 0.35 D). Before the fix F.rW1 was
      // measured after the update (always 0), so the opening fell on the next substep boundary: 14-134 ppm past LSH.
      const s = sim(app, { config: NOISE_OFF });
      const stroke = app.win.WTS_sim.DEFAULTS.sep.water.strokeS;
      let prev = null, prev2 = null;
      const flips = [];
      for (let i = 0; i < 9000 && flips.length < 4; i++) {
        s.advance(0.5);
        const st = s.getState(), w = st.sep.waterDump, cur = { t: st.t, f: st.sep.c1.fracW, cmd: w.cmd, x: w.x };
        // first sample with the dump commanded open after ≥ 2 closed samples with the valve fully shut (linear level rise)
        if (prev && prev2 && cur.cmd > 0.5 && prev.cmd < 0.5 && prev2.cmd < 0.5 && prev.x === 0 && prev2.x === 0 && cur.x < 1) {
          const tOpen = cur.t - cur.x * stroke;                       // LCV-101 slews linearly from shut at 1/stroke per second
          const rate = (prev.f - prev2.f) / (prev.t - prev2.t);
          flips.push({ tOpen, fAt: prev.f + rate * (tOpen - prev.t), lsh: w.lsh });
        }
        prev2 = prev; prev = cur;
      }
      assert.ok(flips.length >= 3, 'observed ' + flips.length + ' dump openings');
      flips.forEach((f, i) => {
        assert.ok(Math.abs(f.fAt - f.lsh) / f.lsh < 3e-6, '#' + i + ' LCV-101 opened at ' + f.fAt + ' vs LSH ' + f.lsh + ' (' + ((f.fAt - f.lsh) / f.lsh * 1e6).toFixed(2) + ' ppm) t=' + f.tOpen);
      });
      assert.ok(flips.some((f) => Math.abs(f.tOpen * 4 - Math.round(f.tOpen * 4)) > 1e-3), 'openings are not locked to the 0.25 s substep grid');
    }
  },
  {
    name: 'WTSDV-R both gauge inlets closed at t = 0: no empty zero-length batch; the next real fill window records normally',
    wp: WP,
    run(app, assert) {
      const s = sim(app, { config: NOISE_OFF, seed: 51 });
      assert.strictEqual(s.setControls(app.toWin({ gauge: { inlet: [false, false] } }), app.toWin({ initial: true })), true);
      let st = s.getState();
      assert.strictEqual(st.gauge.blocked, true, 'P-201 discharge blocked');
      const settle = app.win.WTS_sim.DEFAULTS.gauge.settleS;
      for (let i = 0; i < Math.ceil((settle + 120) / 10); i++) s.advance(10);
      st = s.getState();
      assert.strictEqual(st.gauge.batches.length, 0, 'no batch without a fill window: ' + JSON.stringify(st.gauge.batches));
      assert.strictEqual(st.alarmLog.filter((e) => e.id === 'BATCH').length, 0, 'no BATCH log entry');
      assert.strictEqual(st.gauge.tanks[0].state, 'draining', 'A settled, then drains its initial contents');
      assert.ok(alarmIds(st).indexOf('PUMP_BLOCKED') >= 0, 'PUMP_BLOCKED while both inlets are shut');
      // open B, fill 30 min, divert back to A → B's batch covers exactly its fill window
      const tOpenB = st.t;
      s.setValve('gauge', 1, true);
      for (let i = 0; i < 180; i++) s.advance(10);
      const tClose = s.getState().t;
      s.setValve('gauge', 0, true); s.setValve('gauge', 1, false);
      for (let i = 0; i < Math.ceil((settle + 30) / 10); i++) s.advance(10);
      st = s.getState();
      assert.strictEqual(st.gauge.batches.length, 1, 'one batch');
      const b = st.gauge.batches[0];
      assert.strictEqual(b.tag, 'T-301B');
      assert.near(b.tOpen, tOpenB, 1e-9, 'window opened with XV-301B'); // v3.0: XV-301B is held open until XV-301A reaches its open limit (one stroke), then strokes shut (one stroke):
      // B's window closes at its closed limit, 2 strokes after the command
      assert.near(b.tClose, tClose + 2 * app.win.WTS_sim.DEFAULTS.gauge.xvStrokeS, 1e-6, 'window closed at XV-301B closed limit');
      assert.ok(b.oil_stb > 0 && b.settled === true, 'settled batch with oil ' + b.oil_stb);
      assert.ok(alarmIds(st).indexOf('PUMP_BLOCKED') < 0, 'PUMP_BLOCKED cleared');
    }
  },
  {
    name: 'WTSDV-R stress: 3 rates × randomised lineups / auto / rapid toggling / faults — finite, non-negative, balanced, per-compartment flow direction',
    wp: WP,
    timeoutMs: 240000,
    run(app, assert) {
      const S = app.win.WTS_sim;
      const flows = [['base', S.SAMPLE_FLOW], ['high', S.flowFromInputs(app.toWin({ Qo: 6000, Qw: 3000, Qg: 12 }))], ['low', S.flowFromInputs(app.toWin({ Qo: 30, Qw: 3, Qg: 0.3 }))]];
      const faults = ['surgePumpFail', 'xferStuckClosed', 'oilDumpStuckOpen', 'waterDumpStuckClosed', 'slugging', 'pcvStuckOpen'];
      let steps = 0, dirChecks = 0, ops = 0;
      flows.forEach(([name, flow], fi) => {
        const s = sim(app, { seed: 60 + fi }, flow), rnd = lcg(1000 + fi);
        let controls = 0;
        s.on('control', () => { controls++; });
        let st = s.getState(), a = inv(st), lu = lineupOf(st), c0 = controls;
        for (let i = 0; i < 1440; i++) {                                   // 4 h in 10 s steps
          const r = rnd();
          if (r < 0.06) { s.setValve('surge', rnd() < 0.5 ? 0 : 1, rnd() < 0.6); ops++; }
          else if (r < 0.12) { s.setValve('gauge', rnd() < 0.5 ? 0 : 1, rnd() < 0.6); ops++; }
          else if (r < 0.15) { s.setSuction(['A', 'B', 'both'][Math.floor(rnd() * 3)]); ops++; }
          else if (r < 0.17) { s.setAutoDivert(rnd() < 0.5 ? 'surge' : 'gauge', rnd() < 0.7, app.toWin({ sp: 0.5 + 0.4 * rnd() })); ops++; }
          else if (r < 0.175) { s.setFault(faults[Math.floor(rnd() * faults.length)], rnd() < 0.5); ops++; }
          else if (r < 0.18) { s.resetESD(); ops++; }
          else if (r < 0.2) { for (let k = 0; k < 6; k++) { s.setValve('gauge', k & 1, true); s.setValve('gauge', 1 - (k & 1), false); s.advance(0.3); } ops += 12; }   // rapid toggling
          st = s.getState(); a = inv(st); lu = lineupOf(st); c0 = controls;
          s.advance(10); steps++;
          st = s.getState();
          checkStep(assert, st, name + ' t=' + st.t.toFixed(1));
          if (controls === c0) { checkDirections(assert, a, inv(st), lu, name + ' t=' + st.t.toFixed(1)); dirChecks++; }
        }
      });
      assert.ok(steps === 4320 && dirChecks > 3000 && ops > 400, 'coverage: steps ' + steps + ', direction checks ' + dirChecks + ', operations ' + ops);
    }
  },
  {
    name: 'WTSDV-R auto-divert: no chattering at high rate, every automatic switch logged, blocked and both-high alarms clear',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_sim;
      // surge: inlet A, suction B, auto on; 8 h at a rate P-201 can still keep up with on one compartment
      const s = sim(app, { config: NOISE_OFF, seed: 71 }, S.flowFromInputs(app.toWin({ Qo: 2500, Qw: 800 })));
      s.setValve('surge', 1, false); s.setSuction('B'); s.setAutoDivert('surge', true); s.setAutoDivert('gauge', true);
      const ev = [];
      // (handlers run at the end of advance(): later entries of the same step — e.g. a batch record — may follow the divert)
      s.on('divert', (p, st) => { ev.push({ t: p.t, eq: p.eq, from: p.from, logged: st.alarmLog.some((e) => e.id === 'AUTO_DIVERT' && e.t === p.t && e.msg === p.msg) }); });
      for (let i = 0; i < 8 * 360; i++) { s.advance(10); checkStep(assert, s.getState(), 'auto t=' + s.getState().t); }
      const su = ev.filter((e) => e.eq === 'surge');
      assert.ok(su.length >= 4, 'surge diverts ' + su.length);
      assert.ok(ev.every((e) => e.logged), 'every divert has its AUTO_DIVERT log entry');
      for (let i = 1; i < su.length; i++) {
        assert.ok(su[i].from !== su[i - 1].from, 'alternates');
        // the new side must rise from < SP − hyst to SP: at least hyst·cap / max fill rate (P-201 off) apart
        assert.ok(su[i].t - su[i - 1].t > 60, 'spacing ' + (su[i].t - su[i - 1].t) + ' s');
      }
      assert.ok(!s.getState().esd.tripped, 'no trip: ' + s.getState().esd.cause);
      // blocked alarms raise after the on-delay and clear after the off-delay once a route is back
      const D = S.DEFAULTS.alarm;
      const b = sim(app, { config: NOISE_OFF, seed: 72 });
      b.advance(200);                                                   // past the start-up grace
      b.setValve('surge', 0, false); b.setValve('surge', 1, false); b.setValve('gauge', 0, false);
      // v3.0: P-201 is blocked once XV-301A reaches its closed limit (one stroke), then the on-delay applies
      b.advance(S.DEFAULTS.gauge.xvStrokeS + D.onDelay + 1);
      let st = b.getState();
      assert.ok(alarmIds(st).indexOf('SURGE_BLOCKED') >= 0 && alarmIds(st).indexOf('PUMP_BLOCKED') >= 0, 'both blocked alarms: ' + alarmIds(st));
      b.setValve('surge', 1, true); b.setValve('gauge', 1, true);
      b.advance(D.offDelay + 1);
      st = b.getState();
      assert.ok(alarmIds(st).indexOf('SURGE_BLOCKED') < 0 && alarmIds(st).indexOf('PUMP_BLOCKED') < 0, 'cleared: ' + alarmIds(st));
      assert.ok(!st.esd.tripped, 'short block does not trip');
      // LAH-201 both-high clears when auto-divert is switched off (the alarm belongs to the auto-divert function)
      const h = sim(app, { config: NOISE_OFF, seed: 73 });
      h.setValve('surge', 1, false); h.setAutoDivert('surge', true); h.setFault('xferStuckClosed', true);   // no transfer out of T-201
      let seen = false;
      for (let i = 0; i < 3 * 720 && !seen; i++) { h.advance(5); seen = alarmIds(h.getState()).indexOf('LAH_SURGE_BOTH') >= 0; }
      assert.ok(seen, 'LAH_SURGE_BOTH raised');
      h.setAutoDivert('surge', false); h.advance(D.offDelay + 1);
      assert.ok(alarmIds(h.getState()).indexOf('LAH_SURGE_BOTH') < 0, 'cleared with auto-divert off');
    }
  },
  {
    name: 'WTSDV-R live view: an automatic divert updates the saved lineup (restored after reload); 375 px phone layout valve glyphs toggle the right valve',
    wp: WP,
    integration: true,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert, ctx) {
      const live = openWts(app);
      const viz = app.el('wts_viz');
      assert.strictEqual(viz.getAttribute('data-bp'), 'sm', 'phone breakpoint');
      const cv = viz.querySelector('canvas');
      assert.ok(cv, 'schematic canvas');
      app.flush(500);
      const L = app.win.WTS_DIAG_LAYOUT, r = cv.getBoundingClientRect();
      assert.ok(r.width > 0 && r.height > 0, 'canvas has a box');
      const at = (x, y) => ({ clientX: r.left + x / L.W * r.width, clientY: r.top + y / L.H * r.height, bubbles: true });
      const click = (x, y) => cv.dispatchEvent(new app.win.MouseEvent('click', at(x, y)));
      // glyph centres from the layout (above each compartment for the inlets, below T-201 for the suctions)
      const g = { surge: [[L.bx[0] - 8, L.by - 26], [L.bx[0] + 8, L.by - 26]], gauge: [[L.bx[1] - 9, L.by - 26], [L.bx[1] + 9, L.by - 26]] };
      const inletOf = (eq, i) => { const st = live.getState(); return eq === 'surge' ? st.surge.comps[i].inlet : st.gauge.tanks[i].inlet; };
      // v3.0: on a phone the glyphs are ~4 CSS px apart, so a tap near a tank's valves opens a zoomed inset of that tank
      // whose valve buttons are 44 × 44 px; the inset's button then toggles exactly the valve it names.
      const inset = () => app.el('wtsl_vin');
      [['gauge', 1], ['gauge', 0], ['surge', 1], ['surge', 1], ['gauge', 0]].forEach(([eq, i]) => {
        const before = inletOf(eq, i), other = inletOf(eq, 1 - i);
        click(g[eq][i][0], g[eq][i][1]);
        assert.strictEqual(inletOf(eq, i), before, 'a phone tap alone does not operate a valve');
        const vin = inset(); assert.ok(vin, eq + ': zoomed inset opened');
        app.click(vin.querySelector('[data-act="valve"][data-v="' + eq + ':' + i + '"]'));
        assert.strictEqual(inletOf(eq, i), !before, eq + ' ' + 'AB'[i] + ' toggled from the 375 px inset');
        assert.strictEqual(inletOf(eq, 1 - i), other, 'other side untouched');
        app.click(inset().querySelector('[data-act="vin-close"]'));
        assert.ok(!inset(), 'inset closed');
      });
      click(L.bx[0] + 8, L.by + 23);                                  // suction marker → T-201 inset → suction A
      app.click(inset().querySelector('[data-act="suction"][data-v="A"]'));
      assert.strictEqual(live.getState().surge.suction, 'A', 'suction from the phone inset');
      app.click(inset().querySelector('[data-act="vin-close"]'));
      // lineup now: surge A+B inlets, suction A; gauge A+B open. Make an automatic divert happen in the live sim.
      live.setValve('surge', 1, false); live.setSuction('B'); live.setAutoDivert('surge', true, app.toWin({ sp: 0.6 }));
      let n = 0; live.on('divert', () => { n++; });
      for (let i = 0; i < 2000 && !n; i++) live.advance(10);
      assert.ok(n >= 1, 'automatic divert happened');
      app.flush(50);
      const now = JSON.parse(JSON.stringify(live.getControls()));
      assert.deepStrictEqual(now.surge.inlet, [false, true], 'auto moved the inlet to B');
      const prefs = JSON.parse(app.win.localStorage.getItem('h2viz3d_prefs') || '{}');
      assert.deepStrictEqual(prefs.ctl, now, 'prefs follow the automatic divert');
      const app2 = ctx.loadApp({ storage: app.storage, viewport: { width: 375, height: 812 } });
      try {
        const live2 = openWts(app2);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(live2.getControls())), now, 'restored after reload');
      } finally { if (app2.dispose) app2.dispose(); }
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().join(' | '));
    }
  }
];
