// Simulator follow-up (docs/SIM-FOLLOWUP-PLAN.md §8, §9.2 "wts-fu-views"): views of the CK-102 heater inlet choke, the separator
// (V-101) bypass destination and the cushion unload. One array, separate groups; the lead merges them:
//   • 2D group (WP-2D, this file's first group): host WTS_DIAG_LAYOUT.ck2 / wtsDrawDiag live branch / wtsEqChkS, and the 38 2D
//     overlay (draw2dLive dashes, drawRig2d destination labels, zones2d CK-102 zone and the 2D click branch).
//   • HMI group (WP-L) and 3D group (WP-3D, wts3d-test section): added by those packages.
// View packages code against tests/_wts-fu-shapes.js (fakeFuSnapshot, LABELS) and a stub sim over the real engine (the
// visible state comes from the frozen contract, not from the engine sections that are built in parallel). Expected values are
// plan texts (§8.0 / §8.2), P&ID tags and fixture example values — never numbers taken from the code under test.
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const FU = require('./_wts-fu-shapes');
const X = require('./_wts-equip-shapes');

const WP = 'WTSFUV';
const J = (o) => JSON.parse(JSON.stringify(o));
const REPO = path.resolve(__dirname, '..', '..');
const V331 = '3611343';                      // v3.3.1 tree (plan Appendix A): host + Round 7 as shipped

function openWts(app) {
  const b = app.find('.nav-btn[data-p="wts"]');
  if (!b) throw new Error('no Well Test Simulator sidebar button');
  app.click(b); app.flush(500);
  const s = app.win.WTS_live && app.win.WTS_live.getSim && app.win.WTS_live.getSim();
  if (!s) throw new Error('live simulator did not start');
  return s;
}
function v331Html() {
  for (const git of ['git', 'C:/Program Files/Git/cmd/git.exe', 'C:/Program Files/Git/bin/git.exe']) {
    try { return execFileSync(git, ['show', V331 + ':well-testing-app.html'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }); }
    catch (e) { if (e.code === 'ENOENT') continue; return null; }
  }
  return null;
}
// Stub sim: the real engine underneath (step / controls keep working); getState() = fakeFuSnapshot over the real snapshot
// (o.equip: fakeEquipSnapshot options applied first, e.g. { desander: true }; o.patch(st): edits after the fake is built)
function stubSim(app, real, o) {
  const calls = [];
  const stub = Object.create(real);
  stub.opts = o || {};
  stub.getState = () => {
    let s = J(real.getState());
    if (stub.opts.equip) s = J(X.fakeEquipSnapshot(s, stub.opts.equip));
    const f = app.toWin(FU.fakeFuSnapshot(s, stub.opts));
    if (stub.opts.patch) stub.opts.patch(f);
    return f;
  };
  ['setValve', 'setRigup', 'setHostInput'].forEach((k) => {
    stub[k] = function () { calls.push([k].concat(Array.prototype.slice.call(arguments))); return true; };
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
const texts = (fr) => fr.filter((e) => e.op === 'fillText').map((e) => String(e.args[0]));
const textAt = (fr, s) => fr.filter((e) => e.op === 'fillText' && String(e.args[0]) === s).map((e) => [e.args[1], e.args[2]]);
const redraw = (app) => app.flush(250);
function canvasXY(app, cv, x, y) {
  const L = app.win.WTS_DIAG_LAYOUT, r = cv.getBoundingClientRect();
  return { clientX: r.left + x / L.W * r.width, clientY: r.top + y / L.H * r.height, bubbles: true };
}
const cardTag = (app) => { const c = app.el('wtsl_card'), b = c && !c.hidden && c.querySelector('.tt b'); return b ? String(b.textContent) : ''; };
const firstDiff = (a, b) => { let k = 0; while (k < a.length && JSON.stringify(a[k]) === JSON.stringify(b[k])) k++; return k; };
// a CK-102 node as liveNodes() emits it at index 10 (fixture example values, EX_NODES_HC)
function ck2Node(o) {
  const n = FU.EXAMPLES.nodesHeaterChoke;
  return Object.assign({ nm: 'Heater Choke', P: n.P, T: n.T, th: n.th, Pin: n.Pin, regime: n.regime, bean: n.bean, active: true, bypassed: false, flowLimited: false }, o || {});
}
const nodes11 = (lc, n10) => lc.nodes.concat([{ nm: 'Desander', P: 2995, T: 180, th: 60, dP: 3.9 }, { nm: 'Surge Tank 2', P: 25, T: 80, th: 32 }, n10 || ck2Node()]);
const lineLabel = (P) => FU.LABELS.diag2dLine.replace('{P}', String(P));

const D2 = [
  {
    name: 'WTSFUV 2D host layout: WTS_DIAG_LAYOUT.ck2 {x 470, cl 10} in every variant, between the choke and the heater; no CK-102 → the v3.3.1 layout objects',
    wp: WP,
    integration: true,
    run(app, assert) {
      openWts(app);
      const W = app.win, B = W.WTS_DIAG_LAYOUT;
      assert.deepStrictEqual(J(B.ck2), { x: 470, cl: 10 }, 'base layout ck2');
      assert.strictEqual(W.wtsDiagLayout(), B, 'no rig-up → base object');
      assert.strictEqual(W.wtsDiagLayout({ heaterChoke: true }), B, 'CK-102 alone does not make a new variant (the row x stay v3.3.1)');
      const Ld = W.wtsDiagLayout({ desander: true, heaterChoke: true });
      assert.deepStrictEqual(J(Ld.ck2), { x: 470, cl: 10 }, 'DS-101 variant ck2');
      [[B.tx, 'base'], [Ld.tx, 'DS-101']].forEach(([tx, nm]) => {
        assert.ok(tx[2] + B.cl[2] + 25 <= 470 - 10 && 470 + 10 + 25 <= tx[3] - B.cl[3] + 25 && tx[2] < 470 && 470 < tx[3], nm + ': CK-102 between CK-101 (' + tx[2] + ') and H-101 (' + tx[3] + ')');
      });
    }
  },
  {
    name: 'WTSFUV 2D host wtsDrawDiag: CK-102 only on the live call (11 nodes, rigup.heaterChoke === true, H-101 in); otherwise the frame is the CK-102-out frame command for command',
    wp: WP,
    integration: true,
    run(app, assert) {
      openWts(app);
      const W = app.win, cv = app.el('wts_cv'), lc = W.WTS_lastCalc;
      const frame = (nodes, opts) => { cv._log.length = 0; W.wtsDrawDiag(app.toWin(nodes), lc.segs, opts ? app.toWin(opts) : undefined); return cv._log.slice(); };
      const base = JSON.stringify(frame(J(lc.nodes)));
      const n11 = nodes11(J(lc));
      [[n11, undefined, '11 nodes, no opts (Mini WellOS / static)'],
        [n11, { rigup: { heaterChoke: false } }, 'CK-102 out'],
        [n11, { rigup: { heaterChoke: 'true' } }, 'strict true only'],
        [n11, { rigup: { heaterChoke: true, heater: false } }, 'H-101 out (CK-102 goes with it)'],
        [J(lc.nodes), { rigup: { heaterChoke: true } }, 'only 8 nodes (static calc nodes)']].forEach(([n, o, nm]) => {
        assert.strictEqual(JSON.stringify(frame(n, o)), base, nm + ': the v3.3.1 frame');
      });
      const fr = frame(n11, { rigup: { heaterChoke: true } }), t = texts(fr);
      assert.ok(t.indexOf('CK-102') >= 0, 'CK-102 tag drawn: ' + t.join('|'));
      assert.deepStrictEqual(textAt(fr, 'CK-102'), [[470, 82]], 'tag at (ck2.x, cy − 48)');
      assert.deepStrictEqual(textAt(fr, 'Critical'), [[470, 96], [380, 96]], 'CK-102 regime at cy − 34 beside the CK-101 one');
      assert.deepStrictEqual(textAt(fr, '48/64"'), [[470, 208]], 'bean at cy + 78');
      const pAt = fr.filter((e) => e.op === 'fillText' && e.args[1] === 470 && e.args[2] === 180).map((e) => e.args[0]);
      assert.ok(pAt.length === 1 && /^156 psig$/.test(pAt[0]), 'CK-102 outlet P at cy + 50: ' + pAt);
      assert.ok(textAt(fr, 'Multiphase').length === 4 && textAt(fr, 'Multiphase').some((p) => p[0] === 430), 'seg-3 phase label over the CK-101 → CK-102 part');
      // seg 3 split at ck2.x: 403 … 457 (labelled, compact spec) and 483 … 505 (bare); glyph = the CK-101 glyph at 0.6 scale
      const ml = fr.filter((e) => e.op === 'moveTo' || e.op === 'lineTo').map((e) => e.op[0] + e.args.join(','));
      const has = (a, b) => ml.some((x, i) => x === a && ml[i + 1] === b);
      assert.ok(has('m403,130', 'l457,130') && has('m483,130', 'l505,130') && !has('m403,130', 'l505,130'), 'seg 3 split round CK-102');
      assert.ok(t.indexOf('6" S40') >= 0, 'compact spec label on the short part');
      const ti = fr.findIndex((e) => e.op === 'translate' && e.args[0] === 470 && e.args[1] === 130);
      assert.ok(ti > 0 && fr[ti + 1].op === 'scale' && fr[ti + 1].args[0] === 0.6, 'wtsEqChkS: translate(470, cy) + scale 0.6');
      const col = fr.slice(ti).find((e) => e.op === 'set' && e.prop === 'fillStyle');
      assert.strictEqual(col.value, '#bc8cff', 'critical CK-102 in purple (the CK-101 colour rule)');
      assert.ok(fr.filter((e) => e.op === 'save').length === fr.filter((e) => e.op === 'restore').length, 'save / restore balanced');
      // flow-limited → red glyph and red regime text
      const fl = frame(nodes11(J(lc), ck2Node({ flowLimited: true })), { rigup: { heaterChoke: true } });
      const ti2 = fl.findIndex((e) => e.op === 'translate' && e.args[0] === 470);
      assert.strictEqual(fl.slice(ti2).find((e) => e.op === 'set' && e.prop === 'fillStyle').value, '#f85149', 'flow-limited CK-102 glyph red');
      // hydrate at the CK-102 outlet
      const hy = frame(nodes11(J(lc), ck2Node({ T: 30, th: 40 })), { rigup: { heaterChoke: true } });
      assert.deepStrictEqual(textAt(hy, '❄ HYDRATE').filter((p) => p[0] === 470), [[470, 206]], 'hydrate mark at cy + 76');
      // regime '' (no block yet) → no regime text, no NaN; missing values → '—'
      const nb = frame(nodes11(J(lc), { nm: 'Heater Choke', regime: '', bean: 0 }), { rigup: { heaterChoke: true } });
      assert.ok(textAt(nb, '—').filter((p) => p[0] === 470).length === 2 && !textAt(nb, '0/64"').length, 'no values → "—", no bean');
      assert.ok(!/NaN|undefined|Infinity|\[object/.test(texts(fr).concat(texts(fl), texts(hy), texts(nb)).join('|')), 'no NaN text');
    }
  },
  {
    name: 'WTSFUV 2D host wtsDrawDiag: CK-102 bypassed (heater bypass) is greyed with the label "bypassed", no regime / P / T; DS-101 + CK-102 share the row',
    wp: WP,
    integration: true,
    run(app, assert) {
      openWts(app);
      const W = app.win, cv = app.el('wts_cv'), lc = W.WTS_lastCalc;
      const frame = (nodes, opts) => { cv._log.length = 0; W.wtsDrawDiag(app.toWin(nodes), lc.segs, app.toWin(opts)); return cv._log.slice(); };
      [ck2Node({ bypassed: true, active: false }), null].forEach((n10, k) => {
        const n = nodes11(J(lc), n10 || ck2Node());
        if (!n10) n[3] = Object.assign({}, n[3], { bypass: true });           // heater node says bypassed (older snapshot)
        const fr = frame(n, { rigup: { heaterChoke: true } }), nm = k ? 'heater node bypass' : 'nodes[10].bypassed';
        assert.deepStrictEqual(textAt(fr, 'bypassed'), [[470, 96]], nm + ': "bypassed" at cy − 34');
        assert.ok(textAt(fr, 'Critical').every((p) => p[0] !== 470), nm + ': no CK-102 regime');
        assert.strictEqual(textAt(fr, '—').filter((p) => p[0] === 470).length, 2, nm + ': P / T "—"');
        const ti = fr.findIndex((e) => e.op === 'translate' && e.args[0] === 470);
        const a = fr.slice(0, ti).reverse().find((e) => e.op === 'set' && e.prop === 'globalAlpha');
        assert.ok(ti > 0 && a && a.value === 0.35, nm + ': glyph greyed (alpha 0.35)');
        const tagCol = fr.slice(0, fr.findIndex((e) => e.op === 'fillText' && e.args[0] === 'CK-102')).reverse().find((e) => e.op === 'set' && e.prop === 'fillStyle');
        assert.strictEqual(tagCol.value, '#6e7681', nm + ': tag grey');
      });
      const fd = frame(nodes11(J(lc)), { rigup: { heaterChoke: true, desander: true } }), td = texts(fd);
      assert.ok(td.indexOf('Desander') >= 0 && td.indexOf('CK-102') >= 0, 'both drawn');
      assert.deepStrictEqual(textAt(fd, 'Choke'), [[400, 82]], 'DS-101 variant: CK-101 at 400');
      const ml = fd.filter((e) => e.op === 'moveTo' || e.op === 'lineTo').map((e) => e.op[0] + e.args.join(','));
      assert.ok(ml.some((x, i) => x === 'm423,130' && ml[i + 1] === 'l457,130'), 'DS-101 variant: seg 3 from 423 to the CK-102 inlet');
      assert.strictEqual(textAt(fd, 'Multiphase').length, 4, 'four multiphase labels');
    }
  },
  {
    name: 'WTSFUV 2D static diagram byte-identical to v3.3.1: wtsDrawDiag(nodes, segs) and the DS-101 / T-202 variants draw the v3.3.1 commands',
    wp: WP,
    integration: true,
    run(app, assert, ctx) {
      const html = v331Html();
      openWts(app);
      if (!html) { assert.ok(true, 'v3.3.1 tree not available — the CK-102-out identity above stands'); return; }
      const old = ctx.loadApp({ html });
      try {
        openWts(old);
        const lc = J(app.win.WTS_lastCalc);
        const n11 = nodes11(lc);
        [[lc.nodes, undefined], [n11, undefined], [n11, { rigup: { desander: true, surge2: true } }], [n11, { rigup: { heaterChoke: false, desander: true } }]].forEach(([n, o], k) => {
          const draw = (A) => { const cv = A.el('wts_cv'); cv._log.length = 0; A.win.wtsDrawDiag(A.toWin(n), A.toWin(lc.segs), o ? A.toWin(o) : undefined); return cv._log.slice(); };
          const a = draw(old), b = draw(app);
          const i = firstDiff(a, b);
          assert.ok(a.length > 200 && JSON.stringify(a) === JSON.stringify(b), 'case ' + k + ': first difference at op ' + i + ': v3.3.1 ' + JSON.stringify(a[i]) + ' vs now ' + JSON.stringify(b[i]));
        });
      } finally { if (old.dispose) old.dispose(); }
    }
  },
  {
    name: 'WTSFUV 2D live, CK-102 out: the live frame equals the v3.3.1 live frame command for command (legacy row)',
    wp: WP,
    integration: true,
    run(app, assert, ctx) {
      const html = v331Html();
      openWts(app);
      const cv = app.el('wts_cv');
      app.flush(2000);
      const now = lastFrame(app, cv);
      assert.ok(now.length > 200, 'a frame was drawn (' + now.length + ' ops)');
      assert.ok(!/CK-102|PSHH-104|NRV-501|bypassed|BURNER LINE/.test(texts(now).join('|')), 'nothing of CK-102 / the destination drawn');
      if (!html) { assert.ok(true, 'v3.3.1 tree not available'); return; }
      const old = ctx.loadApp({ html });
      try {
        openWts(old);
        const cv0 = old.el('wts_cv');
        old.flush(2000);
        const ref = lastFrame(old, cv0);
        const i = firstDiff(ref, now);
        assert.ok(JSON.stringify(ref) === JSON.stringify(now), 'first difference at op ' + i + ': v3.3.1 ' + JSON.stringify(ref[i]) + ' vs now ' + JSON.stringify(now[i]));
      } finally { if (old.dispose) old.dispose(); }
    }
  },
  {
    name: 'WTSFUV 2D live overlay (stub sim, fakeFuSnapshot): CK-102 in line / bypassed / out; flow dashes split round it; its zone opens the CK-102 card; status marks',
    wp: WP,
    integration: true,
    run(app, assert) {
      const real = openWts(app);
      const cv = app.el('wts_cv'), L = app.win.WTS_DIAG_LAYOUT;
      const stub = stubSim(app, real, {});
      redraw(app);
      let fr = lastFrame(app, cv);
      assert.ok(!/CK-102|bypassed/.test(texts(fr).join('|')), 'stub CK-102 out: nothing drawn');
      const click = (x, y) => cv.dispatchEvent(new app.win.MouseEvent('click', canvasXY(app, cv, x, y)));
      click(470, L.cy);
      assert.notStrictEqual(cardTag(app), 'CK-102', 'CK-102 out: no zone at its slot');
      stub.opts = { ck2: true }; redraw(app);
      fr = lastFrame(app, cv);
      const t = texts(fr);
      assert.deepStrictEqual(textAt(fr, 'CK-102'), [[470, 82]], 'CK-102 drawn from liveNodes[10]');
      assert.ok(t.indexOf('48/64"') >= 0 && t.indexOf('Critical') >= 0, 'bean / regime from the snapshot: ' + t.join('|'));
      // the running stream's dashes go round the CK-102 body: one dash path ends at ck2.x − cl − 3, the next starts at + cl + 3
      const dashes = [];
      fr.forEach((e, i) => { if (e.op === 'setLineDash' && e.args[0] && e.args[0][0] === 6 && e.args[0][1] === 10) { const m = fr.slice(i).find((x) => x.op === 'moveTo'), l = fr.slice(i).find((x) => x.op === 'lineTo'); dashes.push([m.args[0], l.args[0], m.args[1]]); } });
      assert.ok(real.getState().running, 'the simulator runs (dashes drawn)');
      assert.ok(dashes.some((d) => d[1] === 457 && d[2] === L.cy) && dashes.some((d) => d[0] === 483 && d[2] === L.cy), 'dashes split round CK-102: ' + JSON.stringify(dashes));
      assert.ok(!dashes.some((d) => d[0] < 470 && d[1] > 470 && d[2] === L.cy), 'no dash across the CK-102 body');
      click(470, L.cy);
      assert.strictEqual(cardTag(app), 'CK-102', 'CK-102 in: its body opens the CK-102 card');
      app.win.WTS_live._internals.ctl()._debug.closeCard(); app.flush(50);
      // status marks on the CK-102 zone (x 448 … 492): hydrate ❄ at its top-right, alarm outline
      stub.opts = { ck2: true, patch: (s) => { s.alarms = (s.alarms || []).concat([{ id: 'HYD_heaterChoke', sev: 'hyd', tag: 'CK-102', eq: 'heaterChoke', msg: 'hydrate' }]); } };
      redraw(app);
      assert.ok(textAt(lastFrame(app, cv), '❄').some((p) => p[0] === 492 - 6), 'hydrate mark on the CK-102 zone');
      // bypassed (heater bypass): greyed, label "bypassed", zone kept
      stub.opts = { ck2: true, bypassed: true }; redraw(app);
      fr = lastFrame(app, cv);
      assert.deepStrictEqual(textAt(fr, 'bypassed'), [[470, 96]], 'bypassed label');
      click(470, L.cy);
      assert.strictEqual(cardTag(app), 'CK-102', 'bypassed: the CK-102 card still opens (it is in the rig-up)');
      // DS-101 + CK-102
      stub.opts = { ck2: true, equip: { desander: true } }; redraw(app);
      const td = texts(lastFrame(app, cv));
      assert.ok(td.indexOf('Desander') >= 0 && td.indexOf('CK-102') >= 0, 'DS-101 and CK-102 both drawn');
      assert.ok(!/NaN|undefined|Infinity|\[object/.test(t.concat(td).join('|')), 'no NaN text');
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().join(' | '));
    }
  },
  {
    name: 'WTSFUV 2D destination labels: V-101 out → "BYPASSED → BURNER LINE" / "BYPASSED → PRODUCTION LINE (P psig) · NRV-501 / XV-501" with PSHH-104; FS-401 out → "GAS → EXPORT LINE" and relief to vent; V-101 in → none',
    wp: WP,
    integration: true,
    run(app, assert) {
      const real = openWts(app);
      const cv = app.el('wts_cv'), L = app.win.WTS_DIAG_LAYOUT;
      const stub = stubSim(app, real, {});
      redraw(app);
      let t = texts(lastFrame(app, cv)).join('|');
      assert.ok(!/BYPASSED →|PSHH-104|NRV-501|VENT/.test(t), 'V-101 in: no destination labels');
      stub.opts = { dest: 'line', P: 300 }; redraw(app);
      assert.ok(!/BYPASSED →|PSHH-104/.test(texts(lastFrame(app, cv)).join('|')), 'V-101 in with dest line: still none');
      stub.opts = { sepOut: true }; redraw(app);
      let fr = lastFrame(app, cv);
      assert.deepStrictEqual(textAt(fr, FU.LABELS.diag2dBurner), [[L.tx[4], L.cy + 27]], 'burner line label');
      assert.ok(texts(fr).indexOf('BYPASSED → FLARE') < 0, 'v3.3.1 "→ FLARE" text replaced');
      assert.deepStrictEqual(textAt(fr, 'PSHH-104'), [[L.tx[4], L.cy - 21]], 'PSHH-104 on the bypass path');
      stub.opts = { sepOut: true, dest: 'line', P: 300 }; redraw(app);
      fr = lastFrame(app, cv);
      assert.deepStrictEqual(textAt(fr, lineLabel(300)), [[L.tx[4], L.cy + 40]], 'production line label: ' + texts(fr).filter((x) => /BYPASSED/.test(x)));
      assert.ok(texts(fr).indexOf(FU.LABELS.diag2dBurner) < 0 && textAt(fr, 'PSHH-104').length === 1, 'one destination label + PSHH-104');
      assert.ok(texts(fr).indexOf('GAS → EXPORT LINE') < 0 && !/VENT/.test(texts(fr).join('|')), 'FS-401 in: no export / vent label');
      stub.opts = { sepOut: true, dest: 'line', P: 0 }; redraw(app);
      assert.strictEqual(textAt(lastFrame(app, cv), lineLabel(0)).length, 1, 'line pressure 0 is shown as 0');
      stub.opts = { sepOut: true, dest: 'line', P: 300, flareOut: true }; redraw(app);
      fr = lastFrame(app, cv); t = texts(fr);
      assert.ok(t.indexOf('GAS → EXPORT LINE') >= 0 && t.indexOf(lineLabel(300)) >= 0, 'FS-401 out with the line: export line label stays');
      assert.deepStrictEqual(textAt(fr, 'TANK RELIEF → VENT'), [[L.tx[5], L.cy + 34]], 'relief of the tanks to vent');
      assert.ok(!/NaN|undefined|Infinity|\[object/.test(t.join('|')), 'no NaN text');
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().join(' | '));
    }
  },
  {
    name: 'WTSFUV 2D Metric: the CK-102 canvas texts convert (no psig / °F left)',
    wp: WP,
    integration: true,
    run(app, assert) {
      const real = openWts(app);
      const cv = app.el('wts_cv');
      const stub = stubSim(app, real, {});
      app.win.WTS_units.setSystem('metric'); app.flush(100);
      redraw(app);
      const fr0 = lastFrame(app, cv);
      stub.opts = { ck2: true }; redraw(app);
      const fr = lastFrame(app, cv);
      const at = fr.filter((e) => e.op === 'fillText' && e.args[1] === 470).map((e) => String(e.args[0]));
      assert.ok(at.indexOf('CK-102') >= 0 && at.length >= 4, 'CK-102 texts: ' + at.join('|'));
      assert.ok(!/psig|°F/.test(at.join('|')), 'metric CK-102 P / T: ' + at.join('|'));
      assert.ok(fr0.length > 0, 'base frame drawn');
    }
  },
];

module.exports = [].concat(D2);
