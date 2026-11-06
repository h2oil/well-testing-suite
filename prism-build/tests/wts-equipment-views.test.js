// Well Test Simulator equipment — views of DS-101 (cyclonic desander upstream of the choke) and T-202 (second surge tank)
// (docs/SIM-EQUIPMENT-PLAN.md §8.2–8.5, §9.2 "wts-equipment-views"). One array, separate groups:
//   • HMI group (WP-L): Rig-up card status rows and report, EQV routing of valve / dump / bypass actions (3D onAction, card
//     buttons), the DS-101 card (Dump sand with confirm, hold → Resume / Abort, auto-dump, bypass, no-sand hint), the T-202 card
//     (route, XV-202, auto route, stroke, LCV-202 trip reset), the 375 px phone inset (44 px Dump sand), HUD / tiles / popovers /
//     trends / legend, Scenarios menu, fault toasts, summaryOf, Metric texts.
//   • 2D group (WP-2D): host wtsDrawDiag variants, 38 2D overlay / zones / taps, Dynamic Simulation inputs.
//   • Engine group (WP-I): the same views driven by the real engine (no stub, no fixture) with DS-101 / T-202 switched in.
// The HMI and 2D groups check the call contract with a recording stub sim installed through WTS_live._internals.useSim: it
// delegates to the real engine and serves fakeEquipSnapshot over the real snapshot (tests/_wts-equip-shapes.js), so the visible
// result comes from the frozen contract. Expected values are plan texts (§8.3 / §8.4), tags of the P&ID and fixture example
// values — never numbers taken from the code under test.
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const X = require('./_wts-equip-shapes');

const WP = 'WTSEQV';
const J = (o) => JSON.parse(JSON.stringify(o));
const text = (el) => String(el ? el.textContent : '').trim();
const REPO = path.resolve(__dirname, '..', '..');
const V33 = '666be77';                      // v3.3 tree (plan Appendix A): host + Round 7 as shipped

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
        // the 172 / 158 px tank cell ends long lines in an ellipsis: each line carries its full text as a tooltip
        assert.ok(/T-202 0%.*LCV-201/.test(h('tSu').getAttribute('title') || ''), 'surge line tooltip: ' + h('tSu').getAttribute('title'));
        assert.ok(/^DS-101 sand 0% · ΔP 3\.9 psi$/.test(h('tDs').getAttribute('title') || ''), 'DS-101 line tooltip: ' + h('tDs').getAttribute('title'));
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
        // one if / else-if chain: the press rows keep their order with both items in (DS-101 after Wellhead, T-202 before Flare header)
        assert.ok(/^Wellhead.*DS-101 in → out.*Choke in.*Surge tank(?! 2).*Surge tank 2 \(T-202\).*Flare header[^]*$/.test(text(pop)), 'pressures popover order: ' + text(pop));
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
    name: 'WTSEQV L reload restores the rig-up: DS-101 / T-202 switched in on the Rig-up card come back after a reload with their status rows, HUD line and cards (foundation engine, no stub); switched out again: nothing new is left',
    wp: WP, integration: true,
    run(app, assert, ctx) {
      openWts(app);
      const card = app.el('wtsl_rigup'), sw = (c, k) => c.querySelector('[data-rig="' + k + '"]');
      app.click(sw(card, 'desander')); app.flush(300);
      app.click(sw(card, 'surge2')); app.flush(1200);
      assert.ok(sw(card, 'desander').getAttribute('aria-checked') === 'true' && sw(card, 'surge2').getAttribute('aria-checked') === 'true', 'both switched in');
      const app2 = ctx.loadApp({ storage: app.storage });
      try {
        const live2 = openWts(app2);
        app2.flush(1200);
        const st = live2.getState();
        assert.ok(st.rigup.desander === true && st.rigup.surge2 === true, 'engine rig-up restored: ' + st.rigup.sig);
        const c2 = app2.el('wtsl_rigup');
        assert.ok(sw(c2, 'desander').getAttribute('aria-checked') === 'true' && sw(c2, 'surge2').getAttribute('aria-checked') === 'true', 'switches restored');
        assert.ok(c2.querySelector('[data-k="ds-status"]') && c2.querySelector('[data-k="t202-status"]'), 'status rows after the reload');
        const hud = app2.el('wtsl_hud').querySelector('[data-h="tDs"]');
        assert.ok(hud && !hud.hidden && /^DS-101 sand /.test(text(hud)), 'HUD DS-101 line: ' + text(hud));
        ['desander', 'surge2'].forEach((id) => {
          app2.win.WTS_live._internals.ctl()._debug.openCard(id); app2.flush(400);
          const ct = text(app2.el('wtsl_card'));
          assert.ok(!/Out of rig-up/.test(ct) && !/NaN|undefined|Infinity|\[object/.test(ct), id + ' card in service, no NaN: ' + ct.slice(0, 160));
          app2.win.WTS_live._internals.ctl()._debug.closeCard();
        });
        // switched out again: no status rows, HUD line hidden, the saved request is the default (key removed)
        app2.click(sw(c2, 'desander')); app2.flush(300);
        app2.click(sw(c2, 'surge2')); app2.flush(1200);
        assert.ok(!c2.querySelector('[data-k="ds-status"]') && !c2.querySelector('[data-k="t202-status"]') && hud.hidden, 'nothing left while out');
        assert.strictEqual(app2.win.localStorage.getItem('wts_sim_rigup'), null, 'default request: key removed');
        assert.strictEqual(app2.consoleErrors().length, 0, 'no console errors after the reload');
      } finally { if (app2.dispose) app2.dispose(); }
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

const D2 = [
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

// ── Engine group (WP-I, plan §9.2): the same views on the real engine (no stub sim, no fixture snapshot), DS-101 and T-202
// switched in on the Rig-up card. Expected values come from the engine's own snapshot read in the test, plan texts and tags.
function rigBothIn(app) {
  const card = app.el('wtsl_rigup'), sw = (k) => card.querySelector('[data-rig="' + k + '"]');
  ['desander', 'surge2'].forEach((k) => { if (sw(k).getAttribute('aria-checked') !== 'true') { app.click(sw(k)); app.flush(300); } });
  app.flush(1200);
  return card;
}
function advSim(app, sim, secs, dt) { const n = Math.round(secs / dt); for (let i = 0; i < n; i++) sim.advance(dt); app.flush(1200); }
const kv = (app, label) => {
  const c = app.el('wtsl_card'); if (!c) return null;
  const d = Array.from(c.querySelectorAll('.wtsl-kv > div')).filter((x) => !x.hidden && text(x.querySelector('.l')) === label)[0];
  return d ? { v: text(d.querySelector('.v')), d: text(d.querySelector('.d')) } : null;
};
const NAN = /NaN|undefined|Infinity|\[object/;
const ENG = [
  {
    name: 'WTSEQV engine: DS-101 / T-202 switched in on the Rig-up card — engine rig-up, status rows, HUD line, 2D variants and cards from the real snapshot, no NaN',
    wp: WP, integration: true,
    run(app, assert) {
      const sim = openWts(app);
      const card = rigBothIn(app);
      const st = sim.getState();
      assert.ok(st.rigup.desander === true && st.rigup.surge2 === true && st.desander.inRig && st.surge2.inRig, 'engine rig-up: ' + st.rigup.sig);
      assert.ok(st.desander.dP_psi > 0 && Math.abs(st.nodes.esd.P - st.nodes.choke.Pin - st.desander.dP_psi) < 1e-6, 'choke inlet = ESD node − desander ΔP');
      const ds = text(card.querySelector('[data-k="ds-status"] .rv')), t2 = text(card.querySelector('[data-k="t202-status"] .rv'));
      assert.ok(/^ΔP [\d.]+ psi/.test(ds) && /capture [\d.]+ %/.test(ds) && /rating 10,000 psi/.test(ds), 'DS-101 status: ' + ds);
      assert.ok(/route T-201/.test(t2) && /XV-202 SHUT/.test(t2), 'T-202 status: ' + t2);
      const hud = app.el('wtsl_hud').querySelector('[data-h="tDs"]');
      assert.ok(!hud.hidden && /^DS-101 sand \d+% · ΔP [\d.]+ psi$/.test(text(hud)), 'HUD DS-101 line: ' + text(hud));
      const cv = app.el('wts_cv'); app.flush(1200);
      const t = frameTexts(lastFrame(app, cv)).join('|');
      assert.ok(/Desander/.test(t) && /T-202/.test(t) && !NAN.test(t), '2D variants drawn from the engine: ' + t.slice(0, 200));
      ['desander', 'surge2'].forEach((id) => {
        const ct = text(openCard(app, id));
        assert.ok(!/Out of rig-up/.test(ct) && !NAN.test(ct), id + ' card in service, no NaN: ' + ct.slice(0, 200));
        ctlOf(app)._debug.closeCard();
      });
      openCard(app, 'desander');
      const dP = kv(app, 'ΔP');
      assert.ok(dP && dP.v.indexOf(sim.getState().desander.dP_psi.toFixed(1)) >= 0, 'card ΔP ' + JSON.stringify(dP) + ' vs engine ' + sim.getState().desander.dP_psi);
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().map((l) => l.text).join(' | '));
    }
  },
  {
    name: 'WTSEQV engine: "Dump sand" from the DS-101 card runs the real dump sequence (button disabled while it runs) and the card shows 1 dump when it ends; sand balance holds',
    wp: WP, integration: true, timeoutMs: 240000,
    run(app, assert) {
      const sim = openWts(app);
      rigBothIn(app);
      sim.setFault('sandFlowback', true);
      advSim(app, sim, 1800, 10);
      let st = sim.getState();
      assert.ok(st.desander.sand.acc_lb > 0, 'sand caught before the dump: ' + st.desander.sand.acc_lb);
      openCard(app, 'desander');
      app.click(cardBtn(app, 'ds-dump')); app.flush(30);
      assert.strictEqual(sim.getState().desander.dump.phase, 'idle', 'nothing before the confirm');
      app.click(yes(app)); app.flush(300);
      st = sim.getState();
      assert.ok(st.desander.dump.phase !== 'idle', 'dump running: ' + st.desander.dump.phase);
      assert.ok(cardBtn(app, 'ds-dump').disabled && /A dump is running/.test(cardBtn(app, 'ds-dump').getAttribute('title')), 'Dump sand disabled while it runs');
      advSim(app, sim, 1500, 5);                       // the sequence takes about 1,043 s on the sample (plan §4.4)
      st = sim.getState();
      assert.ok(st.desander.dump.phase === 'idle' && st.desander.dump.count === 1 && !st.desander.dump.failed, 'one completed dump: ' + JSON.stringify(st.desander.dump));
      assert.ok(st.sand.cum.dumped_lb > 0, 'sand dumped: ' + st.sand.cum.dumped_lb);
      const last = kv(app, 'Last dump');
      assert.ok(last && /^T\+/.test(last.v) && last.d === '1 dump', 'card Last dump: ' + JSON.stringify(last));
      const cum = st.sand.cum, d = st.desander.sand, tol = 1e-6 * Math.max(1, cum.in_lb);
      assert.ok(Math.abs(cum.in_lb - cum.capt_lb - cum.toChoke_lb) < tol && Math.abs(cum.capt_lb - d.acc_lb - d.buf_lb - cum.dumped_lb) < tol, 'sand balance');
      assert.ok(!NAN.test(text(app.el('wtsl_card'))), 'no NaN on the card');
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors');
    }
  },
  {
    name: 'WTSEQV engine: T-202 card route buttons drive the real engine (route both → XV-202 open; back to T-201 → XV-202 shut); the 375 px T-202 inset renders the real snapshot',
    wp: WP, integration: true, opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      const sim = openWts(app);
      rigBothIn(app);
      openCard(app, 'surge2');
      app.click(cardBtn(app, 's2route', 'both')); app.flush(50);
      advSim(app, sim, 600, 5);
      let st = sim.getState();
      assert.ok(st.surge2.inlet === true && st.surge2.pos === 1 && st.surge2.route === 'both', 'route both: ' + JSON.stringify({ inlet: st.surge2.inlet, pos: st.surge2.pos, route: st.surge2.route }));
      assert.ok(cardBtn(app, 's2route', 'both').classList.contains('on'), 'card marks route both');
      const share = kv(app, 'Share of dumps');
      assert.ok(share && !NAN.test(share.v), 'share row: ' + JSON.stringify(share));
      app.click(cardBtn(app, 's2route', 'surge')); app.flush(50);
      advSim(app, sim, 60, 5);
      st = sim.getState();
      assert.ok(st.surge2.inlet === false && st.surge2.pos === 0 && st.surge2.route === 'surge', 'back to T-201: ' + st.surge2.route);
      ctlOf(app)._debug.closeCard();
      ctlOf(app)._debug.openVin('surge2'); app.flush(50);
      const vin = app.el('wtsl_vin');
      assert.ok(vin && /T-202 surge tank/.test(text(vin)) && !NAN.test(text(vin)), 'T-202 inset on the real snapshot');
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors');
    }
  },
  {
    name: 'WTSEQV engine: Metric mode on the real snapshot — DS-101 / T-202 cards and the HUD line show kPa, no psig / lb / gal',
    wp: WP, integration: true,
    run(app, assert) {
      const sim = openWts(app);
      rigBothIn(app);
      sim.setFault('sandFlowback', true);
      advSim(app, sim, 600, 10);
      app.win.WTS_units.setSystem('metric'); app.flush(1200);
      const IMP = /\bpsig?\b|\blb\b|\blb\/d\b|\bgal\b|\bmpy\b|mil\/d|°F/;
      ['desander', 'surge2'].forEach((id) => {
        const ct = text(openCard(app, id));
        assert.ok(/kPa/.test(ct) && !IMP.test(ct), id + ' card metric: ' + (ct.match(new RegExp('.{25}(' + IMP.source + ').{10}')) || [''])[0]);
        ctlOf(app)._debug.closeCard();
      });
      const hud = text(app.el('wtsl_hud').querySelector('[data-h="tDs"]'));
      assert.ok(/kPa/.test(hud) && !/psi/.test(hud), 'HUD DS-101 line: ' + hud);
      app.win.WTS_units.setSystem('imperial'); app.flush(300);
      assert.strictEqual(app.consoleErrors().length, 0, 'no console errors');
    }
  },
];

module.exports = [].concat(HMI, D2, ENG);
