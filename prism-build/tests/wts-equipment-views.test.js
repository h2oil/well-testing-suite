// Well Test Simulator equipment views (plan docs/SIM-EQUIPMENT-PLAN.md §8.2 / §8.3 / §9.2): DS-101 cyclonic desander and
// T-202 second surge tank on the 2D schematic and the live HMI.
//   • Groups: WP-2D (this group: host wtsDrawDiag variants, 38 2D overlay / zones / taps, Dynamic Simulation inputs)
//     and WP-L (HMI cards, actions, insets — its own group); the lead merges both arrays and adds engine-backed versions.
//   • Before WP-I the visible result is checked with a recording stub sim (WTS_live._internals.useSim) whose getState() is
//     fakeEquipSnapshot() over the real snapshot (tests/_wts-equip-shapes.js) — nothing here depends on engine internals.
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const X = require('./_wts-equip-shapes.js');

const WP = 'WTSEQV';
const REPO = path.resolve(__dirname, '..', '..');
const V33 = '666be77';                      // v3.3 tree (plan Appendix A): host + Round 7 as shipped

function openWts(app) {
  const b = app.find('.nav-btn[data-p="wts"]');
  if (!b) throw new Error('no Well Test Simulator sidebar button');
  app.click(b); app.flush(500);
  const L = app.win.WTS_live, s = L && L.getSim && L.getSim();
  if (!s) throw new Error('live simulator did not start');
  return s;
}
// Recording stub: the real engine underneath (step / controls keep working), getState() = fakeEquipSnapshot(real, o)
function stubSim(app, real, o) {
  const calls = [];
  const stub = Object.create(real);
  stub.getState = () => X.fakeEquipSnapshot(real.getState(), stub.opts);
  stub.opts = o || {};
  ['setValve', 'dumpDesander', 'setDesander', 'setSurgeRoute', 'setSuction', 'setRigup'].forEach((k) => {
    stub[k] = function () { calls.push([k].concat(Array.prototype.slice.call(arguments))); return k === 'dumpDesander' || k === 'setSurgeRoute' ? { ok: true, msg: '' } : true; };
  });
  stub.calls = calls;
  app.win.WTS_live._internals.useSim(stub);
  return stub;
}
const FULL = (args) => args[0] === 0 && args[1] === 0 && args[2] === 1200 && args[3] === 340;
// The last complete 2D frame on the canvas log (host clearRect(0, 0, W, H) … end of the overlay)
function lastFrame(app, cv) {
  const log = app.canvasLog(cv);
  let i = log.length - 1;
  while (i >= 0 && !(log[i].op === 'clearRect' && FULL(log[i].args))) i--;
  return i < 0 ? [] : log.slice(Math.max(0, i - 1));
}
function frameTexts(fr) { return fr.filter((e) => e.op === 'fillText').map((e) => String(e.args[0])); }
function redraw(app) { app.flush(250); }
function canvasXY(app, cv, x, y) {
  const L = app.win.WTS_DIAG_LAYOUT, r = cv.getBoundingClientRect();
  return { clientX: r.left + x / L.W * r.width, clientY: r.top + y / L.H * r.height, bubbles: true };
}
function v33Html() {
  for (const git of ['git', 'C:/Program Files/Git/cmd/git.exe', 'C:/Program Files/Git/bin/git.exe']) {
    try { return execFileSync(git, ['show', V33 + ':well-testing-app.html'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }); }
    catch (e) { if (e.code === 'ENOENT') continue; return null; }
  }
  return null;
}

module.exports = [
  {
    name: 'WTSEQV 2D both items out: the live 2D frame equals the v3.3 frame command for command (legacy variants)',
    wp: WP,
    integration: true,
    run(app, assert, ctx) {
      const html = v33Html();
      openWts(app);
      const cv = app.el('wts_cv');
      app.flush(2000);
      const now = lastFrame(app, cv);
      assert.ok(now.length > 200, 'a frame was drawn (' + now.length + ' ops)');
      const t = frameTexts(now).join('|');
      assert.ok(!/Desander|T-202|LCV-202|DS-101|XV-103|HV-104/.test(t), 'nothing of DS-101 / T-202 drawn while out');
      if (!html) { assert.ok(true, 'v3.3 tree not available — compared against the static path only'); return; }
      const old = ctx.loadApp({ html });
      try {
        openWts(old);
        const cv0 = old.el('wts_cv');
        old.flush(2000);
        const ref = lastFrame(old, cv0);
        const a = JSON.stringify(ref), b = JSON.stringify(now);
        if (a !== b) {
          let k = 0; while (k < ref.length && JSON.stringify(ref[k]) === JSON.stringify(now[k])) k++;
          assert.fail('first difference at op ' + k + ': v3.3 ' + JSON.stringify(ref[k]) + ' vs now ' + JSON.stringify(now[k]));
        }
      } finally { if (old.dispose) old.dispose(); }
    }
  },
  {
    name: 'WTSEQV 2D host wtsDrawDiag: no opts / both out = the base layout; DS-101 and T-202 variants; missing nodes[8] / nodes[9] → "—"',
    wp: WP,
    integration: true,
    run(app, assert) {
      openWts(app);
      const W = app.win, cv = app.el('wts_cv'), lc = W.WTS_lastCalc;
      assert.strictEqual(W.wtsDiagLayout(), W.WTS_DIAG_LAYOUT, 'no rig-up → base layout object');
      assert.strictEqual(W.wtsDiagLayout({ desander: false, surge2: false }), W.WTS_DIAG_LAYOUT, 'both out → base layout object');
      assert.strictEqual(W.wtsDiagLayout({ surge2: true, surge: false }), W.WTS_DIAG_LAYOUT, 'T-202 without T-201 → base (D11)');
      const Ld = W.wtsDiagLayout({ desander: true }), Lt = W.wtsDiagLayout({ surge2: true });
      assert.deepStrictEqual(Array.from(Ld.tx), [70, 180, 400, 535, 695, 950], 'DS-101 variant tx');
      assert.deepStrictEqual(Array.from(Lt.tx), [85, 230, 380, 535, 695, 950], 'T-202 variant keeps the v3.3 top row');
      [Ld, Lt].forEach((L) => assert.deepStrictEqual(Array.from(L.bx), [695, 1000], 'bx identical in every variant'));
      assert.ok(Ld.dsOn && !Ld.t2On && Lt.t2On && !Lt.dsOn && Ld.ds.x === 290 && Lt.t202.x === 775, 'variant flags / positions');
      const frame = (opts, nodes) => { cv._log.length = 0; W.wtsDrawDiag(nodes || lc.nodes, lc.segs, opts); return cv._log.slice(); };
      const base = JSON.stringify(frame()), out = JSON.stringify(frame({ rigup: { desander: false, surge2: false } }));
      assert.strictEqual(out, base, 'both out draws exactly the no-opts (v3.3) picture');
      const n10 = lc.nodes.concat([{ nm: 'Desander', P: 2995, T: 180, th: 60, dP: 3.93 }, { nm: 'Surge Tank 2', P: 25, T: 80, th: 32 }]);
      const td = frameTexts(frame({ rigup: { desander: true } }, n10));
      assert.ok(td.indexOf('Desander') >= 0 && td.indexOf('SAND') >= 0 && td.some((x) => /^ΔP 3\.9/.test(x)), 'DS-101 glyph, label and ΔP: ' + td.join('|'));
      assert.ok(td.indexOf('4" S40') >= 0, 'compact seg-0 spec label in the DS-101 variant');
      assert.ok(td.filter((x) => x === 'Multiphase').length === 4 && td.indexOf('T-202') < 0, 'phase labels; no T-202');
      const tt = frameTexts(frame({ rigup: { surge2: true } }, n10));
      assert.ok(tt.indexOf('T-202') >= 0 && tt.indexOf('Desander') < 0 && tt.indexOf('Surge Tank') >= 0, 'T-202 label: ' + tt.join('|'));
      const tm = frameTexts(frame({ rigup: { desander: true, surge2: true } }));   // only 8 nodes: DS-101 / T-202 values "—"
      assert.ok(tm.filter((x) => x === '—').length >= 4 && tm.indexOf('ΔP —') >= 0, 'missing nodes → "—"');
      assert.ok(!/NaN|undefined|Infinity/.test(td.concat(tt, tm).join('|')), 'no NaN text');
      // status text drawn from nodes[8].status (live view): DUMPING / HELD amber, SAND HIGH red
      const n10s = n10.slice(); n10s[8] = Object.assign({}, n10[8], { status: 'SAND HIGH' });
      const fs2 = frame({ rigup: { desander: true } }, n10s);
      const i = fs2.findIndex((e) => e.op === 'fillText' && e.args[0] === 'SAND HIGH');
      const col = fs2.slice(0, i).reverse().find((e) => e.op === 'set' && e.prop === 'fillStyle');
      assert.ok(i >= 0 && col && col.value === '#f85149', 'SAND HIGH in red');
    }
  },
  {
    name: 'WTSEQV 2D live overlay (stub sim, fakeEquipSnapshot): DS-101 / T-202 drawn only when in, sand %, XV-202 / LCV-202 / XV-103 / HV-104, strip pitch, no NaN',
    wp: WP,
    integration: true,
    run(app, assert) {
      const real = openWts(app);
      const cv = app.el('wts_cv');
      const stub = stubSim(app, real, {});
      redraw(app);
      let fr = lastFrame(app, cv), t = frameTexts(fr);
      assert.ok(!/Desander|T-202|LCV-202|XV-103|HV-104|DS-101/.test(t.join('|')), 'stub both out: nothing new drawn');
      const barX = (f) => f.filter((e) => e.op === 'fillRect' && e.args[1] === 235 && e.args[2] === 14 && e.args[3] === 58).map((e) => e.args[0]);
      assert.deepStrictEqual(barX(fr), [40, 95, 150, 205, 260], 'default strip: 5 bars, pitch 55');
      const unitX = (f) => { const e = f.find((x) => x.op === 'fillText' && /^\(.+\)$/.test(String(x.args[0])) && x.args[2] === 227); return e && e.args[1]; };
      assert.strictEqual(unitX(fr), 239, 'default strip: volume unit at its v3.3 x');
      stub.opts = { desander: true, surge2: true };
      redraw(app);
      fr = lastFrame(app, cv); t = frameTexts(fr);
      ['Desander', 'T-202', 'LCV-201', 'LCV-202', 'XV-103', 'HV-104', 'DS-101', 'SAND'].forEach((k) => assert.ok(t.indexOf(k) >= 0, k + ' drawn: ' + t.join('|')));
      assert.deepStrictEqual(barX(fr), [40, 82, 124, 166, 208, 250, 292], 'both in: 7 bars, pitch 42');
      assert.strictEqual(unitX(fr), 277.5, 'both in: volume unit centred over the T-301A/B bars');
      const hv = fr.findIndex((e) => e.op === 'fillText' && e.args[0] === 'HV-104');
      assert.ok(hv >= 0 && fr[hv + 1] && fr[hv + 1].op === 'restore', 'HV-104 label drawn inside save/restore (textAlign not left behind)');
      assert.ok(t.some((x) => x === 'WHP · DS-101 ΔP') && t.some((x) => x === 'SURGE T-201 · T-202'), 'strip readouts name DS-101 / T-202');
      assert.ok(!/NaN|undefined|Infinity|\[object/.test(t.join('|')), 'no NaN text');
      // LCV-201 moves under T-202 (x 738, by + 28); T-202 fill at x 775
      const lab = fr.find((e) => e.op === 'fillText' && e.args[0] === 'LCV-201');
      assert.ok(lab && lab.args[1] === 738 && lab.args[2] === 253, 'LCV-201 at (738, by + 28 − 20): ' + JSON.stringify(lab && lab.args));
      stub.opts = { desander: true };
      redraw(app);
      fr = lastFrame(app, cv);
      assert.deepStrictEqual(barX(fr), [40, 86, 132, 178, 224, 270], 'DS-101 only: 6 bars, pitch 46');
      assert.strictEqual(unitX(fr), 253.5, 'DS-101 only: volume unit centred over the T-301A/B bars');
      const lab1 = fr.find((e) => e.op === 'fillText' && e.args[0] === 'LCV-201');
      assert.ok(lab1 && lab1.args[1] === 758 && lab1.args[2] === 225, 'T-202 out: LCV-201 at its v3.3 place');
      // dump states on the DS-101 label
      stub.opts = { desander: true, flushing: true }; redraw(app);
      assert.ok(frameTexts(lastFrame(app, cv)).indexOf('DUMPING') >= 0, 'DUMPING while flushing');
      stub.opts = { desander: true, held: true }; redraw(app);
      assert.ok(frameTexts(lastFrame(app, cv)).indexOf('HELD') >= 0, 'HELD while the dump is held');
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().join(' | '));
    }
  },
  {
    name: 'WTSEQV 2D clicks: XV-202 → setValve(surge2, 0) (never a T-301 valve); XV-103 dumps only after a confirm; zones exist only for items in',
    wp: WP,
    integration: true,
    run(app, assert) {
      const real = openWts(app);
      const cv = app.el('wts_cv'), L = app.win.WTS_DIAG_LAYOUT;
      const stub = stubSim(app, real, { desander: true, surge2: true });
      redraw(app);
      cv.dispatchEvent(new app.win.MouseEvent('click', canvasXY(app, cv, 775, L.by - 26)));
      const sv = stub.calls.filter((c) => c[0] === 'setValve');
      assert.ok(sv.length === 1 && sv[0][1] === 'surge2' && sv[0][2] === 0, 'XV-202 click → setValve("surge2", 0, …): ' + JSON.stringify(sv));
      // XV-103 (dump glyph at ds.x + 16, cy + 20): never dumps without a confirm
      stub.calls.length = 0;
      cv.dispatchEvent(new app.win.MouseEvent('click', canvasXY(app, cv, 306, L.cy + 20)));
      assert.strictEqual(stub.calls.filter((c) => c[0] === 'dumpDesander').length, 0, 'no dump without a confirm');
      const yes = app.find('#wts_viz [data-act="confirm-yes"]');
      const hasDsDump = /'ds-dump'/.test(fs.readFileSync(path.join(__dirname, '..', '38-wts-live.js'), 'utf8').replace(/doAct\('ds-dump'/g, ''));
      if (hasDsDump) {                                   // WP-L's card action is present: confirm → exactly one dump
        assert.ok(yes, 'confirm box shown');
        app.click(yes);
        assert.strictEqual(stub.calls.filter((c) => c[0] === 'dumpDesander').length, 1, 'one dump after the confirm');
      }
      // zones: DS-101 x 260…320, T-202 x 760…790, XV-202 / LCV-202, LCV-201 under T-202; none of them with both out
      app.win.WTS_live._internals.useSim(stub);
      const st = stub.getState();
      assert.ok(st.rigup.desander && st.rigup.surge2, 'stub rig-up');
      stub.opts = {};
      redraw(app);
      stub.calls.length = 0;
      cv.dispatchEvent(new app.win.MouseEvent('click', canvasXY(app, cv, 775, L.by - 26)));
      assert.strictEqual(stub.calls.filter((c) => c[0] === 'setValve').length, 0, 'both out: nothing at the XV-202 slot');
      cv.dispatchEvent(new app.win.MouseEvent('click', canvasXY(app, cv, 306, L.cy + 20)));
      assert.strictEqual(stub.calls.length, 0, 'both out: nothing at the XV-103 slot');
      // plan §9.2: with both out there is no DS-101 / T-202 zone — a click at either body opens neither card
      const cardTag = () => { const c = app.el('wtsl_card'), b = c && !c.hidden && c.querySelector('.tt b'); return b ? String(b.textContent) : ''; };
      cv.dispatchEvent(new app.win.MouseEvent('click', canvasXY(app, cv, 290, L.cy)));
      assert.ok(!/DS-101|T-202/.test(cardTag()), 'both out: no DS-101 / T-202 card at the DS-101 body: ' + cardTag());
      cv.dispatchEvent(new app.win.MouseEvent('click', canvasXY(app, cv, 775, L.by)));
      assert.ok(!/DS-101|T-202/.test(cardTag()), 'both out: no DS-101 / T-202 card at the T-202 body: ' + cardTag());
      // positive control: with both in, the same clicks open the DS-101 / T-202 cards
      stub.opts = { desander: true, surge2: true }; redraw(app);
      cv.dispatchEvent(new app.win.MouseEvent('click', canvasXY(app, cv, 290, L.cy)));
      assert.strictEqual(cardTag(), 'DS-101', 'DS-101 in: its body opens the DS-101 card');
      cv.dispatchEvent(new app.win.MouseEvent('click', canvasXY(app, cv, 775, L.by)));
      assert.strictEqual(cardTag(), 'T-202', 'T-202 in: its body opens the T-202 card');
    }
  },
  {
    name: 'WTSEQV 2D phone (375 px): a tap at the DS-101 / T-202 slots opens nothing while out; a tap near XV-202 opens its inset when in',
    wp: WP,
    integration: true,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      const real = openWts(app);
      const cv = app.el('wts_cv'), L = app.win.WTS_DIAG_LAYOUT;
      const stub = stubSim(app, real, {});
      redraw(app);
      const tap = (x, y) => cv.dispatchEvent(new app.win.MouseEvent('click', canvasXY(app, cv, x, y)));
      tap(306, L.cy + 20); tap(290, L.cy - 29);
      assert.ok(!app.el('wtsl_vin'), 'both out: no inset at the DS-101 valves');
      tap(775, L.by - 26);
      assert.ok(!app.el('wtsl_vin') && stub.calls.length === 0, 'both out: no inset / call at the XV-202 slot');
      stub.opts = { surge2: true }; redraw(app);
      tap(775, L.by - 26);
      const vin = app.el('wtsl_vin'), card = app.el('wtsl_card');
      const cardTag = card && !card.hidden && card.querySelector('.tt b') ? String(card.querySelector('.tt b').textContent) : '';
      assert.ok((vin && !vin.hidden) || cardTag === 'T-202', 'T-202 in: the XV-202 tap opens its inset or the T-202 card (' + cardTag + ')');
      if (vin) {                                         // never the T-301 inset for a T-202 valve (WP-L's renderVin owns its content)
        assert.ok(!/T-301/.test(String(vin.getAttribute('aria-label') || '')), 'inset is not the T-301 inset: ' + vin.getAttribute('aria-label'));
        assert.strictEqual(vin.querySelectorAll('[data-act="valve"][data-v^="gauge:"]').length, 0, 'no XV-301 buttons in the T-202 inset');
      }
      assert.strictEqual(stub.calls.filter((c) => c[0] === 'setValve').length, 0, 'a phone tap never toggles a valve directly');
    }
  },
  {
    name: 'WTSEQV 2D Metric: the DS-101 / T-202 canvas texts convert (no psig / psi / °F / gal / lb left)',
    wp: WP,
    integration: true,
    run(app, assert) {
      const real = openWts(app);
      const cv = app.el('wts_cv');
      const stub = stubSim(app, real, {});
      app.win.WTS_units.setSystem('metric'); app.flush(100);
      redraw(app);
      const before = new Set(frameTexts(lastFrame(app, cv)));
      stub.opts = { desander: true, surge2: true };
      redraw(app);
      // texts that only the DS-101 / T-202 variants draw (the v3.3 pipe labels are outside this package)
      const t = frameTexts(lastFrame(app, cv)).filter((x) => !before.has(x)).join('|');
      assert.ok(/Desander/.test(t) && /T-202/.test(t), 'variants drawn');
      assert.ok(!/psig|\bpsi\b|°F|\bgal\b|\blb\b|mpy|mil\/d/.test(t), 'no imperial units on the canvas: ' + t);
    }
  },
  {
    name: 'WTSEQV Dynamic Simulation inputs: seven .fg-item inputs, saved with the page, published in flow.sim',
    wp: WP,
    integration: true,
    run(app, assert) {
      openWts(app);
      X.FLOW_SIM.forEach((r) => {
        const el = app.el(r.host);
        assert.ok(el && el.closest('.fg-item'), r.host + ' in a .fg-item');
        const lab = el.closest('.fg-item').querySelector('label');
        assert.strictEqual(String(lab.textContent), r.label, r.host + ' label');
      });
      const f = app.win.WTS_state.flow;
      X.FLOW_SIM.forEach((r) => assert.strictEqual(f.sim[r.key], r.def, 'flow.sim.' + r.key + ' default'));
      app.input('wts_sandPptb', '25'); app.change('wts_dsRating', '5000'); app.input('wts_SITHP', '5200');
      app.flush(400);
      const g = app.win.WTS_state.flow;
      assert.ok(g.sim.sand_pptb === 25 && g.sim.desRating_psi === 5000 && g.sim.sithp_psig === 5200, 'edited values published: ' + JSON.stringify(g.sim));
      const saved = JSON.parse(app.win.localStorage.getItem('wts_page_wts') || app.win.localStorage.getItem('wts_wts') || '{}');
      assert.ok(JSON.stringify(saved).indexOf('5200') >= 0, 'saved with the page inputs');
    }
  },
];
