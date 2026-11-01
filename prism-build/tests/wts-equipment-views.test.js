// Well Test Simulator equipment — views of DS-101 (cyclonic desander upstream of the choke) and T-202 (second surge tank)
// (docs/SIM-EQUIPMENT-PLAN.md §8.3–8.5, §9.2 "wts-equipment-views"). One array, separate groups:
//   • HMI group (WP-L, this part): Rig-up card status rows and report, EQV routing of valve / dump / bypass actions (3D
//     onAction, card buttons), the DS-101 card (Dump sand with confirm, hold → Resume / Abort, auto-dump, bypass, no-sand hint),
//     the T-202 card (route, XV-202, auto route, stroke, LCV-202 trip reset), the 375 px phone inset (44 px Dump sand),
//     HUD / tiles / popovers / trends / legend, Scenarios menu, fault toasts, summaryOf, Metric texts.
//   • 2D group (WP-2D) is appended by that package.
// Before the engine lands (WP-E1 / WP-E2) the call contract is checked with a recording stub sim installed through
// WTS_live._internals.useSim: it delegates to the real (v3.3.1 foundation) engine and serves fakeEquipSnapshot over the real
// snapshot (tests/_wts-equip-shapes.js), so the visible result comes from the frozen contract. The lead adds engine-backed
// versions at WP-I. Expected values are plan texts (§8.3 / §8.4), tags of the P&ID and fixture example values — never numbers
// taken from the code under test.
'use strict';

const X = require('./_wts-equip-shapes');

const WP = 'WTSEQV';
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
// Recording stub over the real engine. o: fakeEquipSnapshot options (desander, surge2, sand, flushing, held, refused) plus
// patch(st) (edits the app-realm snapshot after the fake is built). Records every equipment API call.
function installStub(app, o) {
  const I = app.win.WTS_live._internals, real = I.sim();
  const opts = Object.assign({ desander: true, surge2: true }, o || {});
  const calls = [];
  let key = null, cache = null;
  const stub = Object.create(real);
  stub.getState = function () {
    const st = real.getState();
    const k = st.t + '|' + st.alarmVersion + '|' + JSON.stringify(opts, (kk, v) => (typeof v === 'function' ? 'fn' : v)) + '|' + stub.__v;
    if (k !== key) {
      key = k;
      cache = app.toWin(X.fakeEquipSnapshot(J(st), opts));
      if (opts.patch) opts.patch(cache);
    }
    return cache;
  };
  stub.__v = 0;
  stub.getRigup = function () { const r = J(real.getRigup()); r.desander = !!opts.desander; r.surge2 = !!opts.surge2; return app.toWin(r); };
  const rec = (name, fn) => { stub[name] = function () { const a = J(Array.prototype.slice.call(arguments)); calls.push([name].concat(a)); return fn.apply(null, arguments); }; };
  rec('dumpDesander', () => app.toWin({ ok: true, msg: 'DS-101 dump started: isolating the accumulator' }));
  rec('setDesander', () => true);
  rec('setSurgeRoute', (m) => app.toWin({ ok: true, msg: 'Separator dumps → ' + m }));
  rec('setValve', (eq, i, v) => (eq === 'surge2' ? true : real.setValve(eq, i, v)));
  rec('setAutoDivert', (eq, on, x) => (eq === 'surge2' ? true : real.setAutoDivert(eq, on, x)));
  rec('setValveOptions', (eq, x) => (eq === 'surge2' ? true : real.setValveOptions(eq, x)));
  rec('resetTrip', (id) => (id === 'XFER2_DRYRUN' ? app.toWin({ ok: true, reset: ['XFER2_DRYRUN'] }) : real.resetTrip(id)));
  I.useSim(stub);
  const set = (p) => { Object.assign(opts, p); stub.__v++; };
  return { stub, real, calls, opts, set, restore: () => I.useSim(real), of: (n) => calls.filter((c) => c[0] === n) };
}
const ctlOf = (app) => app.win.WTS_live._internals.ctl();
function openCard(app, id) { ctlOf(app)._debug.openCard(id); app.flush(300); return app.el('wtsl_card'); }
const cardBtn = (app, act, v) => { const c = app.el('wtsl_card'); return c && c.querySelector('[data-act="' + act + '"]' + (v != null ? '[data-v="' + v + '"]' : '')); };
const yes = (app) => app.find('[data-act="confirm-yes"]');

const HMI = [
  {
    name: 'WTSEQV L Rig-up card: DS-101 / T-202 status rows while in (and in the page report), none while out; a refused T-202 removal disables its switch with the note',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app);
      try {
        app.flush(1200);
        const card = app.el('wtsl_rigup');
        const row = (k) => card.querySelector('[data-k="' + k + '"]');
        assert.ok(row('ds-status') && row('t202-status'), 'status rows shown');
        const ds = text(row('ds-status').querySelector('.rv')), u2 = text(row('t202-status').querySelector('.rv'));
        // fixture example: ΔP 3.93 psi, cut 39.8 µm, capture 94.6 %, rating 10,000 psi ≥ SITHP 3,600 psig (estimated)
        assert.ok(/^ΔP 3\.9 psi \(clean 3\.9 psi\) · cut 40 µm · capture 94\.6 % · accumulator 0% \(0 lb of 663 lb\) · last dump none/.test(ds), 'DS-101 status: ' + ds);
        assert.ok(/rating 10,000 psi ✓ ≥ max SITHP 3600 psig \(estimated\)$/.test(ds), 'rating text: ' + ds);
        assert.ok(/^level 0% · P [\d.]+ psig · route T-201 · share 0% · XV-202 SHUT · LCV-202 SHUT$/.test(u2), 'T-202 status: ' + u2);
        assert.ok(/Full rig-up · with DS-101 \/ T-202/.test(card.textContent), 'configuration names the extras');
        ['desander', 'surge2'].forEach((k) => assert.ok(!card.querySelector('[data-rig="' + k + '"]').closest('.rrow').classList.contains('rp-skip'), k + ' row reported while in'));
        let model = JSON.stringify(app.win.collectPageReport(app.el('pgBody'), { charts: false }));
        assert.ok(/DS-101/.test(model) && /T-202/.test(model) && /capture 94\.6 %/.test(model), 'page report carries the DS-101 / T-202 rows');
        // a refused removal (rigup.refused) — note shown, T-202 switch disabled with the reason
        t.set({ refused: true }); app.flush(1200);
        const sw2 = card.querySelector('[data-rig="surge2"]');
        assert.ok(sw2.disabled && sw2.getAttribute('title') === X.RIG_NOTES.surge2OnlyRouteRefused, 'T-202 switch disabled with the note: ' + sw2.getAttribute('title'));
        assert.ok(Array.from(card.querySelectorAll('.wtsl-rig-note')).some((n) => text(n).indexOf(X.RIG_NOTES.surge2OnlyRouteRefused) >= 0), 'refusal note shown');
        // both out: no status rows, no DS-101 / T-202 text in the report
        t.set({ desander: false, surge2: false, refused: false }); app.flush(1200);
        assert.ok(!row('ds-status') && !row('t202-status'), 'no status rows while out');
        model = JSON.stringify(app.win.collectPageReport(app.el('pgBody'), { charts: false }));
        assert.ok(!/DS-101|T-202/.test(model), 'default report without DS-101 / T-202');
      } finally { t.restore(); }
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().map((l) => l.text).join(' | '));
    }
  },
  {
    name: 'WTSEQV L EQV routing: 3D onAction valve surge2 → setValve(surge2, 0) only (never a T-201 / T-301 valve); dump / bypass payloads reach DS-101; an unknown eq does nothing',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app), D = ctlOf(app)._debug;
      try {
        app.flush(300);
        D.onAction(app.toWin(X.ACTIONS.valveSurge2.action)); app.flush(50);
        assert.deepStrictEqual(t.of('setValve'), [['setValve', 'surge2', 0, true]], '3D XV-202 tap: ' + JSON.stringify(t.calls));
        // unknown equipment: no valve call of any kind
        D.onAction(app.toWin({ type: 'valve', eq: 'bogus', idx: 1 })); D.onAction(app.toWin({ type: 'valve', eq: 'desander', idx: 0 }));
        D.onAction(app.toWin({ type: 'dump', eq: 'surge2' })); app.flush(50);
        assert.strictEqual(t.of('setValve').length, 1, 'unknown / non-valve eq ignored: ' + JSON.stringify(t.calls));
        assert.ok(!yes(app), 'no confirm for a dump payload on another item');
        // dump: the confirm first, then exactly one dumpDesander call
        D.onAction(app.toWin(X.ACTIONS.dump.action)); app.flush(50);
        assert.ok(yes(app), 'Dump sand confirm opened from the 3D XV-103 tap');
        assert.strictEqual(t.of('dumpDesander').length, 0, 'nothing before the confirm');
        app.click(yes(app)); app.flush(50);
        assert.strictEqual(t.of('dumpDesander').length, 1, 'one dumpDesander after the confirm');
        D.onAction(app.toWin(X.ACTIONS.bypass.action)); app.flush(50);
        assert.deepStrictEqual(t.of('setDesander'), [['setDesander', { bypass: true }]], 'HV-104 bypass line-up');
        // the card valve button for T-202 also goes to XV-202
        openCard(app, 'surge2');
        app.click(cardBtn(app, 'valve', 'surge2:0')); app.flush(50);
        assert.strictEqual(t.of('setValve').filter((c) => c[1] !== 'surge2').length, 0, 'never a T-201 / T-301 valve');
        assert.strictEqual(t.of('setValve').length, 2, 'card XV-202 button');
      } finally { t.restore(); }
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors');
    }
  },
  {
    name: 'WTSEQV L DS-101 card: rows, "Dump sand" calls dumpDesander once after the confirm (Cancel: never); disabled while a dump runs; held → Resume / Abort after the ESD reset; auto-dump, bypass, no-sand hint',
    wp: WP, integration: true,
    run(app, assert) {
      const live = openWts(app);
      const t = installStub(app);
      try {
        const card = openCard(app, 'desander');
        assert.ok(card && !card.hidden, 'card open');
        const ct = text(card);
        ['Inlet P', 'Outlet P', 'ΔP', 'Cut size', 'Capture', 'Accumulator', 'Sand in', 'Caught', 'To choke', 'Choke erosion', 'Dump', 'Last dump', 'Bypass', 'Auto-dump', 'Rating']
          .forEach((l) => assert.ok(ct.indexOf(l) >= 0, 'row ' + l));
        assert.ok(/40 µm/.test(ct) && /94\.6%/.test(ct) && /663 lb/.test(ct) && /0\.646 lb\/d/.test(ct), 'fixture values: ' + ct.slice(0, 400));
        assert.ok(/OK · 0\.065 mil\/d/.test(ct) && /23\.6 mpy/.test(ct) && /screening/.test(ct), 'erosion band, mil/d and mpy');
        assert.ok(/steel-equivalent erosion \(screening\)/.test(ct) && /attended, interlocked dump system/.test(ct), 'card notes');
        assert.ok(/10,000 psi ✓/.test(ct) && /max SITHP 3600 psig \(estimated\)/.test(ct), 'rating');
        // Cancel → no call; confirm → one call
        const b = cardBtn(app, 'ds-dump');
        assert.ok(b && !b.disabled && b.classList.contains('dump'), 'red-bordered Dump sand enabled');
        app.click(b); app.flush(30);
        assert.ok(/Dump DS-101 sand to the skip\?/.test(text(app.find('.wtsl-conf'))) && /bled to below 50 psig/.test(text(app.find('.wtsl-conf'))) && /about 17 min/.test(text(app.find('.wtsl-conf'))), 'confirm text');
        app.click(app.find('.wtsl-conf [data-act="menu-close"]')); app.flush(30);
        assert.strictEqual(t.of('dumpDesander').length, 0, 'Cancel: no dump');
        app.click(cardBtn(app, 'ds-dump')); app.flush(30); app.click(yes(app)); app.flush(30);
        assert.strictEqual(t.of('dumpDesander').length, 1, 'confirmed once');
        // a dump running (flush): the button is disabled with the reason; the Accumulator P and Buffer rows show
        t.set({ flushing: true }); app.flush(600);
        assert.ok(cardBtn(app, 'ds-dump').disabled && /A dump is running/.test(cardBtn(app, 'ds-dump').getAttribute('title')), 'disabled while dumping');
        const vis = (l) => Array.from(app.el('wtsl_card').querySelectorAll('.wtsl-kv > div')).some((d) => !d.hidden && text(d.querySelector('.l')) === l);
        assert.ok(vis('Accumulator P') && vis('Buffer') && /FLUSHING/.test(text(app.el('wtsl_card'))), 'dump rows');
        // held with the ESD tripped: Resume / Abort disabled; after the reset they call dumpDesander('resume' / 'abort')
        t.set({ flushing: false, held: true, patch: (st) => { st.esd.tripped = true; st.esd.canReset = true; } }); app.flush(600);
        assert.ok(!cardBtn(app, 'ds-dump'), 'no Dump sand while held');
        assert.ok(cardBtn(app, 'ds-resume').disabled && /Reset the ESD first/.test(cardBtn(app, 'ds-resume').getAttribute('title')) && cardBtn(app, 'ds-abort').disabled, 'held + ESD: disabled');
        t.set({ patch: null }); app.flush(600);
        app.click(cardBtn(app, 'ds-resume')); app.flush(30);
        app.click(cardBtn(app, 'ds-abort')); app.flush(30);
        assert.deepStrictEqual(t.of('dumpDesander').slice(1).map((c) => c[1]), ['resume', 'abort'], 'resume / abort');
        // auto-dump and bypass
        t.set({ held: false }); app.flush(600);
        app.click(cardBtn(app, 'ds-auto')); app.click(cardBtn(app, 'ds-autosp', '0.05')); app.click(cardBtn(app, 'ds-bypass')); app.flush(30);
        assert.deepStrictEqual(t.of('setDesander').map((c) => c[1]), [{ auto: { on: true } }, { auto: { on: false, sp: 0.85 } }, { bypass: true }], 'auto-dump / set point / bypass');
        assert.ok(/stays pressurised while bypassed until it is bled/.test(cardBtn(app, 'ds-bypass').getAttribute('title')), 'bypass note');
        // no sand in the stream → hint
        t.set({ sand: false }); app.flush(600);
        assert.ok(/No sand in the well stream — set Sand rate in Dynamic Simulation or start Scenarios → Sand \/ proppant flow-back\./.test(text(app.el('wtsl_card'))), 'no-sand hint');
        // out of the rig-up: chip says so, actions disabled
        t.set({ desander: false }); app.flush(600);
        assert.ok(/Out of rig-up/.test(text(app.el('wtsl_card').querySelector('.wtsl-chip'))), 'chip out');
        assert.ok(cardBtn(app, 'ds-dump').disabled && /not in the rig-up/.test(cardBtn(app, 'ds-dump').getAttribute('title')), 'Dump disabled while out');
        assert.ok(live, 'live');
      } finally { t.restore(); }
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors');
    }
  },
  {
    name: 'WTSEQV L T-202 card: route T-201 / T-202 / Both, XV-202, auto route, stroke, LCV-202 trip reset; rows from the snapshot',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app);
      try {
        const card = openCard(app, 'surge2');
        const ct = text(card);
        ['Level', 'Pressure', 'Liquid', 'Water cut', 'Inlet XV-202', 'Route', 'Share of dumps', 'LCV-202', 'Time to HH', 'Flash gas', 'Auto route'].forEach((l) => assert.ok(ct.indexOf(l) >= 0, 'row ' + l));
        assert.ok(/of 100 bbl/.test(ct) && /fire case is not modelled/.test(ct), 'capacity and PSV-202 note');
        ['surge2', 'both', 'surge'].forEach((m) => { app.click(cardBtn(app, 's2route', m)); app.flush(20); });
        assert.deepStrictEqual(t.of('setSurgeRoute').map((c) => c[1]), ['surge2', 'both', 'surge'], 'routes');
        assert.ok(cardBtn(app, 's2route', 'surge').classList.contains('on'), 'current route marked');
        app.click(cardBtn(app, 'valve', 'surge2:0')); app.click(cardBtn(app, 'auto', 'surge2')); app.click(cardBtn(app, 'stroke', 'surge2:1')); app.flush(20);
        assert.deepStrictEqual(t.of('setValve').map((c) => c.slice(1)), [['surge2', 0, true]], 'XV-202 open');
        assert.deepStrictEqual(t.of('setAutoDivert').map((c) => c.slice(1, 3)), [['surge2', true]], 'auto route');
        assert.deepStrictEqual(t.of('setValveOptions').map((c) => c.slice(1)), [['surge2', { strokeS: 7 }]], 'stroke + 1 s');
        // a latched LCV-202 dry-run trip: reset row (disabled with the reason, then enabled)
        t.set({ patch: (st) => { st.surge2.transfer.trip = 'XFER2_DRYRUN'; st.surge2.transfer.tripped = true; st.surge2.transfer.resetBlock = 'T-202 below LSL'; } }); app.flush(600);
        assert.ok(cardBtn(app, 'xfer2-reset').disabled && cardBtn(app, 'xfer2-reset').getAttribute('title') === 'T-202 below LSL', 'reset blocked');
        t.set({ patch: (st) => { st.surge2.transfer.trip = 'XFER2_DRYRUN'; st.surge2.transfer.tripped = true; st.surge2.transfer.canReset = true; } }); app.flush(600);
        app.click(cardBtn(app, 'xfer2-reset')); app.flush(20);
        assert.deepStrictEqual(t.of('resetTrip').map((c) => c[1]), ['XFER2_DRYRUN'], 'LCV-202 trip reset');
      } finally { t.restore(); }
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors');
    }
  },
  {
    name: 'WTSEQV L 375 px phone: the DS-101 inset has a 44 px "Dump sand" that calls dumpDesander once after the confirm; T-202 inset operates XV-202; no inset for an item that is out',
    wp: WP, integration: true, opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      openWts(app);
      assert.strictEqual(app.el('wts_viz').getAttribute('data-bp'), 'sm', 'phone breakpoint');
      assert.ok(/\.wtsl-viz \.wtsl-vin \.wtsl-b\{min-height:44px;height:44px;min-width:44px/.test(app.win.WTS_live._internals.CSS), '44 × 44 px inset buttons');
      const t = installStub(app), D = ctlOf(app)._debug;
      try {
        app.flush(300);
        D.openVin('desander'); app.flush(50);
        let vin = app.el('wtsl_vin');
        assert.ok(vin && /DS-101 desander · sand dump/.test(text(vin)) && vin.getAttribute('aria-label') === 'DS-101 desander sand dump', 'DS-101 inset');
        app.click(vin.querySelector('[data-act="ds-dump"]')); app.flush(30);
        assert.strictEqual(t.of('dumpDesander').length, 0, 'confirm first');
        app.click(yes(app)); app.flush(30);
        assert.strictEqual(t.of('dumpDesander').length, 1, 'one dump from the inset');
        D.openVin('surge2'); app.flush(50);
        vin = app.el('wtsl_vin');
        assert.ok(vin && /T-202 surge tank/.test(text(vin)) && vin.querySelectorAll('[data-act="s2route"]').length === 3, 'T-202 inset with routes');
        app.click(vin.querySelector('[data-act="valve"][data-v="surge2:0"]')); app.flush(30);
        assert.deepStrictEqual(t.of('setValve').map((c) => c.slice(1)), [['surge2', 0, true]], 'XV-202 from the inset');
        app.click(app.el('wtsl_vin').querySelector('[data-act="vin-close"]'));
        // both out: nothing opens
        t.set({ desander: false, surge2: false }); app.flush(300);
        D.openVin('desander'); D.openVin('surge2'); D.openVin('bogus'); app.flush(50);
        assert.ok(!app.el('wtsl_vin'), 'no inset for an item out of the rig-up (or an unknown one)');
      } finally { t.restore(); }
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors');
    }
  },
  {
    name: 'WTSEQV L HUD, tiles, popovers, trends and legend show T-202 and DS-101 without NaN while in, and nothing new while out',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const D = ctlOf(app)._debug, hud = app.el('wtsl_hud');
      const h = (k) => hud.querySelector('[data-h="' + k + '"]');
      // both out first: v3.3 HUD
      app.flush(600);
      assert.ok(h('tDs').hidden && !hud.classList.contains('ds4') && !/T-202/.test(text(h('tSu'))), 'HUD unchanged while out');
      const t = installStub(app);
      try {
        app.flush(800);
        assert.ok(/T-202 0%/.test(text(h('tSu'))), 'surge line names T-202: ' + text(h('tSu')));
        assert.ok(!h('tDs').hidden && hud.classList.contains('ds4') && /^DS-101 sand 0% · ΔP 3\.9 psi$/.test(text(h('tDs'))), 'DS-101 line: ' + text(h('tDs')));
        // trends and legend
        // the trends panel needs a stage tall enough in 2D (no layout in the harness): show it, the 1 Hz update draws it
        app.el('wtsl_trends').hidden = false; app.flush(1200);
        const dsCell = app.find('#wtsl_trends [data-k="ds"]');
        assert.ok(dsCell && !dsCell.hidden && /Desander sand · ΔP/.test(text(dsCell)), 'trend cell');
        assert.ok(/Surge A · B · T-202/.test(text(app.find('#wtsl_trends [data-k="surge"]'))), 'surge trend names T-202');
        const lb = app.find('#wts_viz [data-act="legend"]'); if (lb) { app.click(lb); app.flush(1200); }
        assert.ok(/Sand/.test(text(app.el('wtsl_legend'))), 'legend Sand swatch');
        // popovers (phone tiles open them; drive them through the tile action)
        const tile = (g) => { const b = app.document.createElement('div'); b.setAttribute('data-act', 'tile'); b.setAttribute('data-v', g); app.el('wts_viz').appendChild(b); app.click(b); b.remove(); app.flush(300); return app.find('.wtsl-pop'); };
        let pop = tile('press');
        assert.ok(pop && /DS-101 in → out/.test(text(pop)) && /Surge tank 2 \(T-202\)/.test(text(pop)), 'pressures popover: ' + text(pop));
        tile('press');
        pop = tile('tanks');
        assert.ok(pop && /T-202/.test(text(pop)) && /DS-101 sand/.test(text(pop)), 'tanks popover: ' + text(pop));
        const all = text(hud) + text(app.el('wtsl_trends')) + text(pop) + text(app.el('wtsl_rigup'));
        assert.ok(!/NaN|undefined|Infinity|\[object/.test(all), 'no NaN / undefined text');
        // summaryOf (WTS_state.sim)
        const sum = J(app.win.WTS_live._internals.summaryOf(t.stub.getState()));
        assert.deepStrictEqual(sum.desander, { acc_frac: 0, capt_lb: 0, dumps: 0, toChoke_lbd: 0.646 }, 'summary desander');
        assert.ok(sum.surge2 && sum.surge2.frac === 0 && isFinite(sum.surge2.P), 'summary surge2');
        t.set({ desander: false, surge2: false }); app.flush(800);
        assert.ok(h('tDs').hidden && !hud.classList.contains('ds4'), 'HUD DS-101 line gone while out');
        assert.ok(!/T-202/.test(text(h('tSu'))), 'surge line without T-202: ' + text(h('tSu')));
        app.el('wtsl_trends').hidden = false; app.flush(1200);
        assert.ok(app.find('#wtsl_trends [data-k="ds"]').hidden, 'trend cell hidden while out');
        const s2 = J(app.win.WTS_live._internals.summaryOf(t.stub.getState()));
        assert.ok(s2.desander === null && s2.surge2 === null, 'summary null while out');
        assert.ok(D, 'debug');
      } finally { t.restore(); }
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors');
    }
  },
  {
    name: 'WTSEQV L phone tiles name T-202; Scenarios menu = WTS_sim.FAULTS (v3.3 entries first in v3.3 order, descriptive labels); fault toasts use the label',
    wp: WP, integration: true, opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      const live = openWts(app);
      const t = installStub(app);
      try {
        app.flush(800);
        assert.ok(/T-202 0%/.test(text(app.find('[data-h="t_tanks"]'))), 'phone tile: ' + text(app.find('[data-h="t_tanks"]')));
      } finally { t.restore(); }
      app.click(app.find('#wts_viz [data-act="more"]')); app.flush(60);
      const items = app.findAll('.wtsl-menu [data-act="fault"]');
      const F = app.win.WTS_sim.FAULTS;
      assert.strictEqual(items.length, F.length, 'menu length = WTS_sim.FAULTS.length (' + F.length + ')');
      const ids = items.map((b) => b.getAttribute('data-v'));
      assert.deepStrictEqual(ids.slice(0, 8), ['pcvStuckClosed', 'pcvStuckOpen', 'oilDumpStuckOpen', 'oilDumpStuckClosed', 'waterDumpStuckClosed', 'xferStuckClosed', 'surgePumpFail', 'slugging'], 'v3.3 order first');
      assert.deepStrictEqual(ids.slice(8), X.FAULTS_NEW.map((f) => f.id), 'then the new engine ids in engine order');
      const lbl = (id) => text(items[ids.indexOf(id)]);
      assert.strictEqual(lbl('sandFlowback'), 'Sand / proppant flow-back (clean-up)');
      assert.strictEqual(lbl('desanderIsoPassing'), 'DS-101 upper isolation passing (dump interlock)');
      assert.strictEqual(lbl('bpv2StuckClosed'), 'PCV-203 stuck closed (T-202 back-pressure)');
      app.click(app.find('#wts_viz [data-act="more"]')); app.flush(30);
      live.setFault('sandFlowback', true); app.flush(50);
      assert.ok(app.findAll('.wtsl-toast').some((x) => /Sand \/ proppant flow-back \(clean-up\) ON/.test(text(x))), 'fault toast label');
      live.setFault('sandFlowback', false);
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors');
    }
  },
  {
    name: 'WTSEQV L Metric mode: DS-101 / T-202 card, HUD and Rig-up status texts convert (kg, kg/d, mm/y, mm/d, kPa) — no psig / lb / gal / mpy / mil/d',
    wp: WP, integration: true,
    run(app, assert) {
      app.win.WTS_units.setSystem('metric'); app.flush(100);
      openWts(app);
      const t = installStub(app);
      try {
        app.flush(1200);
        const L = app.win.WTS_live;
        assert.strictEqual(L.fmtU(100, 'massDay'), '45.4 kg/d', '100 lb/d = 45.36 kg/d');
        assert.strictEqual(L.fmtU(10, 'erosionDay', 3), '0.254 mm/d', '10 mil/d = 0.254 mm/d');
        assert.strictEqual(L.fmtU(10, 'erosionRate', 3), '0.254 mm/y', '10 mpy = 0.254 mm/y');
        assert.strictEqual(L.fmtU(100, 'mass', 1), '45.4 kg', '100 lb = 45.36 kg');
        const IMPERIAL = /\bpsig?\b|\blb\b|\blb\/d\b|\bgal\b|\bmpy\b|mil\/d|\bmil\b|\bbbl\b|°F/;
        ['desander', 'surge2'].forEach((id) => {
          const c = openCard(app, id), ct = text(c);
          assert.ok(!IMPERIAL.test(ct), id + ' card has no imperial unit: ' + (ct.match(new RegExp('.{25}(' + IMPERIAL.source + ').{10}')) || [''])[0]);
          assert.ok(/kPa/.test(ct), id + ' card shows kPa');
          if (id === 'desander') assert.ok(/kg\/d/.test(ct) && /mm\/d/.test(ct) && /mm\/y/.test(ct) && /\bkg\b/.test(ct), 'desander metric units');
          ctlOf(app)._debug.closeCard();
        });
        const rig = text(app.el('wtsl_rigup').querySelector('[data-k="ds-status"]')) + ' ' + text(app.el('wtsl_rigup').querySelector('[data-k="t202-status"]'));
        assert.ok(!IMPERIAL.test(rig) && /kPa/.test(rig) && /\bkg\b/.test(rig), 'Rig-up status rows: ' + rig);
        const hud = text(app.el('wtsl_hud').querySelector('[data-h="tDs"]'));
        assert.ok(/kPa/.test(hud) && !/psi/.test(hud), 'HUD DS-101 line: ' + hud);
        const D = ctlOf(app)._debug; D.askDump(null); app.flush(30);
        const conf = text(app.find('.wtsl-conf'));
        assert.ok(/kPa\(g\)/.test(conf) && !/psig/.test(conf), 'confirm text: ' + conf);
      } finally { t.restore(); }
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors');
    }
  }
];

module.exports = [].concat(HMI);
