// Well Test Simulator live HMI (38-wts-live.js) — release 4.1, T-202 with two compartments A | B like T-201
// (designs t202.md §9, INTEGRATION.md §2.7 / C6):
//   • pure: u2Dual / eqvOf (the single XV-202 fallback while the snapshot has no compartments 2), mergeKey (dotted prefs keys);
//   • card (recording stub over a two-compartment T-202 snapshot): Line-up / T-202A / T-202B / Auto-divert rows, inlet A / B
//     buttons, LCV-202 suction A | B | A+B, compartment auto-divert (eq 'surge2div') next to the auto route (eq 'surge2'), status
//     texts, the phone inset, the 3D / 2D actions valve:surge2:0|1 and suction:surge2:0|1, the 2D halves;
//   • engine (only when the engine has the twin, WTS_sim.features.surge2Comps): the card drives the real engine and the prefs
//     rules — a hand T-202 auto-divert change saves only comp.auto / sp / hyst, an automatic divert saves nothing.
// The stub snapshot is built here from the contract (t202.md §6), so these checks hold with either engine in the tree.
'use strict';

const WP = 'WTSL2';
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
function comp(k, o) {
  return Object.assign({ tag: k ? 'T-202B' : 'T-202A', valveTag: k ? 'XV-202B' : 'XV-202A', cap_bbl: 50, h: 4, frac: k ? 0.1 : 0.42, hW: 0.5, fracW: 0.05,
    Vo_bbl: 18, Vo_stb: 17, Vw_bbl: 2, inlet: !k, suction: !!k, fill_bpd: k ? 0 : 900, draw_bpd: k ? 300 : 0, T: 80, pos: k ? 0 : 1, moving: false, hold: false }, o || {});
}
// a two-compartment T-202 in the rig-up over the real snapshot (contract keys only)
function dualPatch(st, o) {
  o = o || {};
  st.rigup.surge2 = true;
  const u = st.surge2;
  u.inRig = true; u.compartments = 2; u.comps = [comp(0, o.a), comp(1, o.b)];
  u.suction = o.suction || 'B'; u.divert = Object.assign({ on: true, sp: 0.8, hyst: 0.1 }, o.divert || {}); u.fill = [true, false];
  u.inlet = u.comps[0].inlet || u.comps[1].inlet; u.frac = (u.comps[0].frac + u.comps[1].frac) / 2; u.route = o.route || 'both'; u.share = 0.5;
  u.valveTag = 'XV-202A/B';
  u.transfer = Object.assign({}, u.transfer || {}, { on: true, suction: u.suction, q_bpd: 300, dP_psi: 12 });
  return st;
}
function installStub(app, o) {
  const L = I(app), real = L.sim();
  const opts = Object.assign({}, o || {});
  const calls = [];
  let key = null, cache = null;
  const stub = Object.create(real);
  stub.__v = 0;
  stub.getState = function () {
    const st = real.getState(), k = st.t + '|' + st.alarmVersion + '|' + stub.__v;
    if (k !== key) { key = k; cache = app.toWin(dualPatch(J(st), opts)); }
    return cache;
  };
  stub.getRigup = function () { const r = J(real.getRigup()); r.surge2 = true; return app.toWin(r); };
  const rec = (name, ret) => { stub[name] = function () { calls.push([name].concat(J(Array.prototype.slice.call(arguments)))); return ret; }; };
  rec('setValve', true); rec('setSuction', true); rec('setAutoDivert', true); rec('setValveOptions', true);
  stub.setSurgeRoute = function (m) { calls.push(['setSurgeRoute', m]); return app.toWin({ ok: true, msg: 'Separator dumps → ' + m }); };
  L.useSim(stub);
  return { stub, real, calls, opts, set: (p) => { Object.assign(opts, p); stub.__v++; }, restore: () => L.useSim(real), of: (n) => calls.filter((c) => c[0] === n).map((c) => c.slice(1)) };
}
function openCard(app, id) { ctlOf(app)._debug.openCard(id); app.flush(300); return app.el('wtsl_card'); }
const cardBtn = (app, act, v) => { const c = app.el('wtsl_card'); return c && c.querySelector('[data-act="' + act + '"]' + (v != null ? '[data-v="' + v + '"]' : '')); };
const rowLabels = (card) => Array.from(card.querySelectorAll('.wtsl-kv > div')).filter((d) => !d.hidden).map((d) => text(d.querySelector('.l')));
const rowVal = (card, l) => { const r = Array.from(card.querySelectorAll('.wtsl-kv > div')).find((d) => !d.hidden && text(d.querySelector('.l')) === l); return r ? text(r.querySelector('.v')) : null; };
const twin = (app) => !!(app.win.WTS_sim && app.win.WTS_sim.features && app.win.WTS_sim.features.surge2Comps);
const noErr = (app, assert) => assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().map((l) => l.text || l).join(' | '));

module.exports = [
  {
    name: 'WTSL2 pure: u2Dual / eqvOf (XV-202A / XV-202B with compartments 2, else the single XV-202), mergeKey dotted keys, prefs constants',
    wp: WP,
    run(app, assert) {
      const L = I(app);
      assert.deepStrictEqual(J(L.EQV.surge2), { kind: 'comps', valves: ['XV-202A', 'XV-202B'], suction: true });
      assert.deepStrictEqual(J(L.EQV_U2_SINGLE), { kind: 'single', valves: ['XV-202'] });
      const d = { surge2: { compartments: 2, comps: [{}, {}] } };
      assert.strictEqual(L.u2Dual(d), true);
      [null, {}, { surge2: {} }, { surge2: { compartments: 1, comps: [{}, {}] } }, { surge2: { compartments: 2 } }, { surge2: { compartments: 2, comps: [{}] } }]
        .forEach((s) => assert.strictEqual(L.u2Dual(s), false, JSON.stringify(s)));
      assert.strictEqual(L.eqvOf('surge2', d).kind, 'comps');
      assert.strictEqual(L.eqvOf('surge2', { surge2: { compartments: 1 } }).kind, 'single');
      assert.strictEqual(L.eqvOf('surge2', null).kind, 'single', 'an older engine (no key) keeps XV-202');
      assert.strictEqual(L.eqvOf('surge', null).kind, 'comps'); assert.strictEqual(L.eqvOf('surge2div', d), null); assert.strictEqual(L.eqvOf('nope', d), null);
      assert.strictEqual(L.CTL_USER_WHAT.divert, 1);
      assert.deepStrictEqual(J(L.CTL_MERGE_KEYS.divert), ['comp.auto', 'comp.sp', 'comp.hyst']);
      assert.deepStrictEqual(J(L.CTL_MERGE_KEYS.auto), ['auto', 'sp', 'hyst'], "'auto' on T-202 stays the auto route (top level)");
      // mergeKey: top-level as before; dotted into the nested object, created when missing; absent source keys change nothing
      const live = { auto: true, sp: 0.7, comp: { inlet: [false, true], auto: false, sp: 0.65, hyst: 0.12 } };
      let m = { auto: false, sp: 0.8, comp: { inlet: [true, false], fill: [true, false], auto: true, sp: 0.8, hyst: 0.1 } };
      L.CTL_MERGE_KEYS.divert.forEach((k) => L.mergeKey(m, live, k));
      assert.deepStrictEqual(J(m), { auto: false, sp: 0.8, comp: { inlet: [true, false], fill: [true, false], auto: false, sp: 0.65, hyst: 0.12 } }, 'only comp.auto / sp / hyst merged');
      m = { inlet: true, auto: false };
      L.CTL_MERGE_KEYS.divert.forEach((k) => L.mergeKey(m, live, k));
      assert.deepStrictEqual(J(m), { inlet: true, auto: false, comp: { auto: false, sp: 0.65, hyst: 0.12 } }, 'an old part without comp gains only the merged fields');
      m = { auto: false }; L.mergeKey(m, live, 'sp'); L.mergeKey(m, live, 'hyst'); L.mergeKey(m, { comp: 1 }, 'comp.auto');
      assert.deepStrictEqual(J(m), { auto: false, sp: 0.7 }, 'top level unchanged; missing / non-object sources skipped');
      assert.ok(/XV-202A\/B shut — A fills first, B on LCV-202/.test(L.U2_IN_TXT) && /XV-202 shut/.test(L.U2_IN_TXT1));
    }
  },
  {
    name: 'WTSL2 T-202 card (two compartments): Line-up ▸ / ▾, T-202A / T-202B rows, Auto-divert row, no single Inlet XV-202 row; buttons drive setValve / setSuction / setAutoDivert({divert}) / the auto route',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app);
      try {
        app.flush(500);
        const card = openCard(app, 'surge2');
        assert.strictEqual(text(card.querySelector('.tt b')), 'T-202');
        const ls = rowLabels(card);
        ['Level (A+B)', 'Line-up', 'T-202A', 'T-202B', 'Pressure', 'Liquid', 'Water cut', 'Route', 'Share of dumps', 'LCV-202', 'Time to HH', 'Flash (calc, PVT)', 'Auto-divert', 'Auto route']
          .forEach((l) => assert.ok(ls.indexOf(l) >= 0, 'row ' + l + ' in ' + ls.join(',')));
        assert.ok(ls.indexOf('Inlet XV-202') < 0 && ls.indexOf('Level') < 0, 'single-compartment rows hidden: ' + ls.join(','));
        assert.ok(ls.indexOf('Auto-divert') < ls.indexOf('Auto route'), 'Auto-divert before Auto route');
        const lu = rowVal(card, 'Line-up');
        assert.ok(/^A filling 42% · B transferring 10%$/.test(lu), 'Line-up: ' + lu);
        assert.ok(/LCV-202 suction/.test(text(card)), 'Line-up note names LCV-202');
        assert.ok(/^42% · 80 ?°F · inlet OPEN$/.test(rowVal(card, 'T-202A')), 'T-202A: ' + rowVal(card, 'T-202A'));
        assert.ok(/^10% · 80 ?°F · inlet CLOSED · suction$/.test(rowVal(card, 'T-202B')), 'T-202B: ' + rowVal(card, 'T-202B'));
        assert.strictEqual(rowVal(card, 'Auto-divert'), 'ON · SP 80%');
        // inlet A / B buttons, the LCV-202 suction row, both auto rows
        const a = cardBtn(app, 'valve', 'surge2:0'), b = cardBtn(app, 'valve', 'surge2:1');
        assert.ok(a && b && /^A OPEN$/.test(text(a)) && /^B SHUT$/.test(text(b)), 'inlet buttons ' + text(a) + ' / ' + text(b));
        assert.ok(/XV-202B/.test(b.getAttribute('title')), 'B title names XV-202B');
        assert.ok(cardBtn(app, 'suction', 'surge2:A') && cardBtn(app, 'suction', 'surge2:B') && cardBtn(app, 'suction', 'surge2:both'), 'LCV-202 suction buttons');
        assert.ok(/LCV-202 suction/.test(text(app.el('wtsl_card').querySelector('[data-cref="act"]'))));
        assert.strictEqual(cardBtn(app, 'suction', 'surge2:B').getAttribute('aria-pressed'), 'true', 'suction B pressed');
        assert.ok(cardBtn(app, 'auto', 'surge2div') && cardBtn(app, 'auto', 'surge2'), 'compartment auto-divert and auto route');
        app.click(b); app.flush(20);
        app.click(cardBtn(app, 'suction', 'surge2:A')); app.flush(20);
        app.click(cardBtn(app, 'auto', 'surge2div')); app.flush(20);
        app.click(cardBtn(app, 'autosp', 'surge2div:-0.05')); app.flush(20);
        app.click(cardBtn(app, 'auto', 'surge2')); app.flush(20);
        assert.deepStrictEqual(t.of('setValve'), [['surge2', 1, true]], 'XV-202B open');
        assert.deepStrictEqual(t.of('setSuction'), [['A', 'surge2']], 'LCV-202 suction A');
        const ad = t.of('setAutoDivert');
        assert.deepStrictEqual(ad[0], ['surge2', false, { divert: true }], 'compartment auto-divert OFF: ' + JSON.stringify(ad));
        assert.deepStrictEqual(ad[1], ['surge2', true, { divert: true, sp: 0.75 }], 'compartment set point − 5 %');
        assert.strictEqual(ad[2][0], 'surge2'); assert.ok(!ad[2][2] || !ad[2][2].divert, 'the auto route has no divert flag: ' + JSON.stringify(ad[2]));
        // T-201 untouched by any T-202 button
        assert.ok(t.calls.every((c) => c[1] === 'surge2' || c[2] === 'surge2'), 'every call on T-202: ' + JSON.stringify(t.calls));
        // status texts
        const rs = text(app.el('wtsl_rigup').querySelector('[data-k="t202-status"] .rv'));
        assert.ok(/ · XV-202A OPEN · XV-202B SHUT · LCV-202 /.test(rs), 'Rig-up status: ' + rs);
        app.flush(600);
        const tSu = app.el('wtsl_hud').querySelector('[data-h="tSu"]'), tt = tSu.getAttribute('title') || '';
        assert.ok(/▸T-202 26% · LCV-201 .* · T-202: A filling 42% · B transferring 10% · LCV-202 OPEN/.test(tt), 'HUD title: ' + tt);
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSL2 T-202 actions: 3D valve:surge2:1 / suction:surge2:0 taps, 2D halves with XV-202A / B and SV-202A / B glyphs, phone inset with inlets and suction',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app);
      try {
        app.flush(300);
        const d = ctlOf(app)._debug;
        d.onAction({ type: 'valve', eq: 'surge2', idx: 1 }); d.onAction({ type: 'suction', eq: 'surge2', idx: 0 }); d.onAction({ type: 'valve', eq: 'surge2', idx: 0 });
        app.flush(20);
        assert.deepStrictEqual(t.of('setValve'), [['surge2', 1, true], ['surge2', 0, false]], '3D inlet taps: ' + JSON.stringify(t.calls));
        // suction B → tap A: 'both' (one outlet always open, as LCV-201)
        assert.deepStrictEqual(t.of('setSuction'), [['both', 'surge2']], '3D suction tap A with B selected → A + B');
        t.set({ suction: 'A' }); app.flush(20);
        d.onAction({ type: 'suction', eq: 'surge2', idx: 0 }); app.flush(20);
        assert.strictEqual(t.of('setSuction').length, 1, 'the only open outlet cannot be shut');
        assert.ok(/LCV-202 needs one outlet open — open SV-202B first/.test(text(app.el('wtsl_toast'))), 'toast: ' + text(app.el('wtsl_toast')));
        // a T-201 suction tap still reaches LCV-201 only
        d.onAction({ type: 'suction', idx: 1 }); app.flush(20);
        assert.ok(t.of('setSuction').slice(1).every((c) => c.length === 1), 'T-201 suction: one-argument call ' + JSON.stringify(t.of('setSuction')));
        // 2D (the harness runs 2D): halves A | B with a centre baffle; clicks on XV-202A / XV-202B and SV-202A / SV-202B glyphs
        const cv = app.el('wts_cv'), L2 = app.win.WTS_DIAG_LAYOUT;
        assert.ok(cv && L2 && L2.t202, "2D canvas and T-202 layout");
        {
          app.flush(300);
          const log = app.canvasLog(cv), tx = log.filter((e) => e.op === 'fillText').map((e) => e.args);
          const t2 = L2.t202;
          assert.ok(tx.some((a) => a[0] === 'A' && Math.abs(a[1] - (t2.x - t2.w / 4)) < 1e-9) && tx.some((a) => a[0] === 'B' && Math.abs(a[1] - (t2.x + t2.w / 4)) < 1e-9), 'T-202 A / B labels');
          const r = cv.getBoundingClientRect();
          const at = (x, y) => cv.dispatchEvent(new app.win.MouseEvent('click', { clientX: r.left + x / L2.W * r.width, clientY: r.top + y / L2.H * r.height, bubbles: true }));
          t.calls.length = 0;
          at(t2.x + t2.w / 4, L2.by - 26); app.flush(20);
          assert.deepStrictEqual(t.of('setValve'), [['surge2', 1, true]], '2D XV-202B click: ' + JSON.stringify(t.calls));
          t.set({ suction: 'B' }); app.flush(20); t.calls.length = 0;
          at(t2.x - t2.w / 4, L2.by + t2.h / 2 + 4); app.flush(20);
          assert.deepStrictEqual(t.of('setSuction'), [['both', 'surge2']], '2D SV-202A click: ' + JSON.stringify(t.calls));
        }
        const vin = (d.openVin('surge2'), app.flush(50), app.el('wtsl_vin'));
        assert.ok(vin && !vin.hidden, 'T-202 inset opens');
        assert.strictEqual(vin.getAttribute('aria-label'), 'T-202 inlet valves, suction and route');
        assert.ok(vin.querySelector('[data-act="valve"][data-v="surge2:1"]') && vin.querySelector('[data-act="suction"][data-v="surge2:both"]'), 'inlets and suction in the inset');
        assert.ok(/A 42% · B 10%/.test(text(vin)), 'inset level: ' + text(vin));
        assert.ok(!vin.querySelector('[data-act="auto"]'), 'no auto rows in the inset');
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSL2 T-202 one compartment (snapshot compartments 1, or no key): the v3.4.1 card — Inlet XV-202 row and button, no suction / Auto-divert rows',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app);
      const back = t.stub.getState;
      t.stub.getState = function () { const s = J(back.call(t.stub)); s.surge2.compartments = 1; return app.toWin(s); };
      try {
        app.flush(300);
        const card = openCard(app, 'surge2'), ls = rowLabels(card);
        assert.ok(ls.indexOf('Inlet XV-202') >= 0 && ls.indexOf('Level') >= 0, 'single rows: ' + ls.join(','));
        ['Line-up', 'T-202A', 'T-202B', 'Auto-divert', 'Level (A+B)'].forEach((l) => assert.ok(ls.indexOf(l) < 0, 'no ' + l));
        assert.ok(cardBtn(app, 'valve', 'surge2:0') && /^XV-202 /.test(text(cardBtn(app, 'valve', 'surge2:0'))), 'XV-202 button');
        assert.ok(!cardBtn(app, 'valve', 'surge2:1') && !cardBtn(app, 'suction', 'surge2:A') && !cardBtn(app, 'auto', 'surge2div'), 'no twin controls');
        ctlOf(app)._debug.onAction({ type: 'suction', eq: 'surge2', idx: 1 }); app.flush(10);
        assert.strictEqual(t.of('setSuction').length, 0, 'no LCV-202 suction choice');
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSL2 engine (twin engine only): route T-202 opens XV-202A; a hand T-202 auto-divert change saves only comp.auto / sp / hyst; an automatic divert keeps the saved part; old prefs restore the defaults',
    wp: WP, integration: true,
    run(app, assert, ctx) {
      if (!twin(app)) { assert.ok(true, 'engine without the T-202 twin: skipped'); return; }
      const live = openWts(app);
      live.setRigup(app.toWin({ surge2: true })); app.flush(100);
      let st = live.getState();
      assert.strictEqual(st.surge2.compartments, 2);
      const card = openCard(app, 'surge2');
      assert.ok(rowLabels(card).indexOf('T-202A') >= 0, 'twin rows from the real snapshot');
      app.click(cardBtn(app, 'auto', 'surge2div')); app.flush(50);     // hand: compartment auto-divert OFF
      const p1 = JSON.parse(app.win.localStorage.getItem('h2viz3d_prefs') || '{}');
      assert.ok(p1.ctlUser && p1.ctlUser.surge2 === true, 'T-202 marked as set by hand');
      assert.strictEqual(p1.ctl.surge2.comp.auto, false, 'comp.auto saved');
      assert.deepStrictEqual(p1.ctl.surge2.comp.inlet, J(live.getControls()).surge2.comp.inlet, 'inlets as the run started');
      // turn it back on, route to T-202: XV-202A opens (the fill line-up), B stays shut
      app.click(cardBtn(app, 'auto', 'surge2div')); app.flush(50);
      app.click(cardBtn(app, 's2route', 'surge2')); app.flush(50);
      for (let i = 0; i < 4; i++) live.advance(10);
      st = live.getState();
      assert.ok(st.surge2.comps[0].inlet && !st.surge2.comps[1].inlet, 'route T-202: XV-202A open, XV-202B shut');
      const saved = J(JSON.parse(app.win.localStorage.getItem('h2viz3d_prefs')).ctl.surge2);
      // an automatic T-202 compartment divert (A at the set point) does not change the saved part
      live.setAutoDivert('surge2', true, app.toWin({ divert: true, sp: 0.3 })); app.flush(20);
      const saved2 = J(JSON.parse(app.win.localStorage.getItem('h2viz3d_prefs')).ctl.surge2);
      assert.strictEqual(saved2.comp.sp, 0.3, 'hand set point merged');
      assert.deepStrictEqual(saved2.comp.inlet, saved.comp.inlet, 'hand divert change keeps the saved inlets');
      let dv = 0; live.on('divert', (e) => { if (e && e.eq === 'surge2') dv++; });
      for (let i = 0; i < 400 && !dv; i++) live.advance(30);
      const saved3 = J(JSON.parse(app.win.localStorage.getItem('h2viz3d_prefs')).ctl.surge2);
      if (dv) assert.deepStrictEqual(saved3, saved2, 'automatic divert: saved part unchanged');
      // old prefs (a T-202 part with only the boolean inlet) restore without error
      const a = ctx.loadApp({});
      try {
        a.win.localStorage.setItem('h2viz3d_prefs', JSON.stringify({ mode: '2d', ctl: { surge2: { inlet: false, auto: false, sp: 0.8, hyst: 0.1, strokeS: 6 }, v: 1 }, ctlUser: { surge2: true } }));
        const b = ctx.loadApp({ storage: a.storage });
        try {
          const c = J(openWts(b).getControls()).surge2;
          assert.ok(c.comp && c.comp.auto === true && c.comp.suction === 'B', 'old prefs: compartment defaults ' + JSON.stringify(c.comp));
        } finally { if (b.dispose) b.dispose(); }
      } finally { if (a.dispose) a.dispose(); }
      noErr(app, assert);
    }
  }
];
