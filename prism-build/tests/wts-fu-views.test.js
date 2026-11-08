// Well Test Simulator follow-up — views of CK-102 (heater inlet choke), the V-101-out bypass destination and the cushion-unload
// scenario (docs/SIM-FOLLOWUP-PLAN.md §8, §9.2 "wts-fu-views"). One array, separate groups (the lead merges them):
//   • HMI group (WP-L, this file's first group): the CK-102 card (rows, bypassed / out states, bean2 action → wts_bean2), the
//     Heater card row and the bypass confirm, the Flare card by destination, the Rig-up card notes (CK-102 bypassed, V-101 by
//     destination, the FS-401 switch rule), the Scenarios entry and the Cushion unload form (ids wtsl_cush_*, not in reports or
//     the page autosave, device prefs round trip and sanitiser, Start / Stop / Esc), the HUD cushion line and the totals to
//     the production line / vent, the 3D → 38 payloads, inputsDiff entries, the rigup handler (wtsRenderResults, never calcWTS).
//   • 2D group (WP-2D, the second group, in its own function scope: it names the two fixtures FU / X) — see its header below;
//     the 3D group (WP-3D) is the wts3d-test section.
// The HMI group checks the call contract with a recording stub sim installed through WTS_live._internals.useSim: it delegates
// to the real engine and serves fakeFuSnapshot over the real snapshot (tests/_wts-fu-shapes.js), so the visible result comes
// from the frozen contract. Expected texts are plan texts (§8.3, D17 LABELS) and fixture example values, never numbers taken
// from the code under test.
'use strict';

const X = require('./_wts-fu-shapes');

const WP = 'WTSFUV';
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
// Recording stub over the real engine. o: fakeFuSnapshot options ({ck2, bypassed, pos, sepOut, flareOut, dest, P, cushion});
// startCushion returns o.start (default {ok:true, msg, warn:''}). Records the cushion API calls.
function installStub(app, o) {
  const I = app.win.WTS_live._internals, real = I.sim();
  const opts = Object.assign({}, o || {});
  const calls = [];
  let key = null, cache = null;
  const stub = Object.create(real);
  stub.getState = function () {
    const st = real.getState();
    const k = st.t + '|' + st.alarmVersion + '|' + JSON.stringify(opts) + '|' + stub.__v;
    if (k !== key) { key = k; cache = app.toWin(X.fakeFuSnapshot(J(st), opts)); }
    return cache;
  };
  stub.__v = 0;
  stub.getRigup = function () { return app.toWin(J(stub.getState().rigup)); };
  const rec = (name, fn) => { stub[name] = function () { const a = J(Array.prototype.slice.call(arguments)); calls.push([name].concat(a)); return fn.apply(null, arguments); }; };
  rec('startCushion', () => app.toWin(opts.start || { ok: true, msg: X.EVENT_CUSHION_EXAMPLE.msg, warn: '' }));
  rec('stopCushion', () => true);
  I.useSim(stub);
  const set = (p) => { Object.assign(opts, p); stub.__v++; };
  return { stub, real, calls, opts, set, restore: () => I.useSim(real), of: (n) => calls.filter((c) => c[0] === n) };
}
const ctlOf = (app) => app.win.WTS_live._internals.ctl();
function openCard(app, id) { ctlOf(app)._debug.openCard(id); app.flush(300); return app.el('wtsl_card'); }
const cardBtn = (app, act, v) => { const c = app.el('wtsl_card'); return c && c.querySelector('[data-act="' + act + '"]' + (v != null ? '[data-v="' + v + '"]' : '')); };
// card rows {label: {v, d, hidden}}
function cardRows(app) {
  const out = {};
  Array.prototype.forEach.call(app.el('wtsl_card').querySelectorAll('.wtsl-kv > div'), (r) => {
    const l = text(r.querySelector('.l')), v = text(r.querySelector('.v')), d = r.querySelector('.d');
    out[l] = { v, d: d ? text(d) : null, hidden: !!r.hidden };
  });
  return out;
}
// a host input on the page (WP-C adds the real ones; the card actions only need the id)
function hostInput(app, id, value) {
  let el = app.el(id);
  if (!el) {
    el = app.document.createElement('input'); el.id = id; el.type = 'number';
    app.el('pgBody').appendChild(el);
  }
  el.value = String(value);
  return el;
}
const rigRow = (app, k) => { const s = app.el('wtsl_rigup').querySelector('[data-rig="' + k + '"]'); return s ? s.closest('.rrow') : null; };
const hudOf = (app, k) => app.el('wtsl_hud').querySelector('[data-h="' + k + '"]');
const noErr = (app, assert) => assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().map((l) => l.text || l).join(' | '));

const L = [
  {
    name: 'WTSFUV L CK-102 card: the §8.3 rows (Pm, regime, bean, position, ΔP, J-T, outlet, hydrate, pair capacity, limiter, PAH-102), spark Pck2; "Bypassed with H-101"; out of the rig-up',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app, { ck2: true });
      try {
        app.flush(600);
        openCard(app, 'heaterChoke');
        const card = app.el('wtsl_card');
        assert.ok(/CK-102/.test(text(card.querySelector('.tt'))) && /Heater inlet choke/.test(text(card.querySelector('.tt'))), 'card head: tag and name');
        const r = cardRows(app);
        ['Upstream P', 'Downstream P', 'Regime', 'Bean', 'Position', 'ΔP', 'J-T ΔT', 'Outlet T', 'Hydrate T / margin', 'Pair capacity', 'Limiter', 'Design P (PAH-102)']
          .forEach((l) => assert.ok(r[l] && !r[l].hidden, 'row ' + l + ': ' + JSON.stringify(Object.keys(r))));
        const ex = X.EXAMPLES.nodesHeaterChoke;
        assert.strictEqual(r.Regime.v, ex.regime.toUpperCase(), 'regime');
        assert.strictEqual(r.Bean.v, ex.bean + '/64″', 'bean');
        assert.strictEqual(r.Position.v, X.LABELS.ck2PosOptions.inlet, 'position');
        assert.strictEqual(r.Limiter.v, ex.limiter, 'limiter');
        assert.ok(/^1,?440 psig$/.test(r['Design P (PAH-102)'].v) && /PAH-102 at 90 % = 1,?296 psig/.test(r['Design P (PAH-102)'].d), 'design P: ' + JSON.stringify(r['Design P (PAH-102)']));
        assert.ok(/^\d/.test(r['Upstream P'].v) && /psig/.test(r['Upstream P'].v), 'upstream P: ' + r['Upstream P'].v);
        assert.ok(/^38\.3/.test(r['J-T ΔT'].v), 'J-T from the snapshot: ' + r['J-T ΔT'].v);
        assert.ok(/Pressure between the chokes/.test(card.textContent) && card.querySelector('canvas.wtsl-sk'), 'spark Pck2');
        assert.strictEqual(text(card.querySelector('[data-cref="chip"]')), 'Normal', 'chip');
        assert.ok(card.querySelector('[data-cref="rigout"]').hidden, 'no rig-out note while in line');
        // between the coil passes
        t.set({ pos: 'midcoil' }); app.flush(600);
        assert.strictEqual(cardRows(app).Position.v, X.LABELS.ck2PosOptions.midcoil, 'midcoil position');
        // bypassed with H-101: values blank, chip and note
        t.set({ bypassed: true, pos: 'inlet' }); app.flush(600);
        const rb = cardRows(app), ro = card.querySelector('[data-cref="rigout"]');
        assert.strictEqual(text(card.querySelector('[data-cref="chip"]')), 'Bypassed', 'chip bypassed');
        assert.ok(!ro.hidden && text(ro).indexOf(X.LABELS.bypassed) === 0, 'bypassed note: ' + text(ro));
        assert.strictEqual(rb['Upstream P'].v, '—', 'no live values while bypassed');
        // out of the rig-up
        t.set({ ck2: false, bypassed: false }); app.flush(600);
        assert.strictEqual(text(card.querySelector('[data-cref="chip"]')), 'Out of rig-up', 'chip out');
        assert.ok(/^Not in the rig-up/.test(text(card.querySelector('[data-cref="rigout"]'))), 'out note');
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSFUV L bean2 action: CK-102 −/+ 4/64″ → setHostInput(wts_bean2) with input events, clamped 4–128; 3D {type:bean, eq:heaterChoke, d:±4}; disabled without the input or with CK-102 out',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app, { ck2: true });
      try {
        app.flush(600);
        openCard(app, 'heaterChoke');
        // no page input yet: the buttons are shown disabled with the reason
        if (!app.el('wts_bean2')) {                          // before WP-C the page has no CK-102 bean input
          const m = cardBtn(app, 'bean2', '-4');
          assert.ok(m && m.disabled && m.getAttribute('title').indexOf(X.LABELS.bean2) >= 0, 'disabled without wts_bean2: ' + (m && m.getAttribute('title')));
        }
        const el = hostInput(app, 'wts_bean2', 48), ev = [];
        el.addEventListener('input', () => ev.push(el.value));
        ctlOf(app)._debug.closeCard(); openCard(app, 'heaterChoke');
        assert.ok(/48\/64″/.test(text(app.el('wtsl_card').querySelector('[data-cref="act"]'))), 'value shown');
        app.click(cardBtn(app, 'bean2', '4')); app.flush(50);
        assert.strictEqual(el.value, '52', '+4');
        app.click(cardBtn(app, 'bean2', '-4')); app.flush(50); app.click(cardBtn(app, 'bean2', '-4')); app.flush(50);
        assert.strictEqual(el.value, '44', '−4 twice');
        assert.deepStrictEqual(ev, ['52', '48', '44'], 'one input event per click: ' + JSON.stringify(ev));
        el.value = '126'; app.click(cardBtn(app, 'bean2', '4')); app.flush(50);
        assert.strictEqual(el.value, '128', 'clamped at 128');
        el.value = '6'; app.click(cardBtn(app, 'bean2', '-4')); app.flush(50);
        assert.strictEqual(el.value, '4', 'clamped at 4');
        // the wts_bean (CK-101) input is not touched
        const b1 = app.el('wts_bean'), b1v = b1 ? b1.value : null;
        // 3D handwheel payloads (§7.3)
        el.value = '48';
        ctlOf(app)._debug.onAction(app.toWin(X.ACTIONS.bean2Minus)); app.flush(50);
        assert.strictEqual(el.value, '44', '3D bean2 −4');
        ctlOf(app)._debug.onAction(app.toWin(X.ACTIONS.bean2Plus)); app.flush(50);
        assert.strictEqual(el.value, '48', '3D bean2 +4');
        ctlOf(app)._debug.onAction(app.toWin({ type: 'bean', eq: 'heaterChoke', d: 40 })); app.flush(50);
        assert.strictEqual(el.value, '48', 'only ±4 steps');
        if (b1) assert.strictEqual(b1.value, b1v, 'CK-101 bean unchanged');
        // CK-102 out of the rig-up: disabled, no change
        t.set({ ck2: false }); app.flush(600);
        const m2 = cardBtn(app, 'bean2', '4');
        assert.ok(m2 && m2.disabled && /not in the rig-up/.test(m2.getAttribute('title')), 'disabled while out');
        ctlOf(app)._debug.onAction(app.toWin(X.ACTIONS.bean2Plus)); app.flush(50);
        assert.strictEqual(el.value, '48', 'no change while CK-102 is out');
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSFUV L Heater card: "Heater choke" row while CK-102 is in; Bypass with CK-102 in line asks first ("CK-102 goes out of line with it"); without CK-102 it toggles at once',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app, { ck2: true });
      try {
        app.flush(600);
        openCard(app, 'heater');
        let r = cardRows(app);
        assert.ok(r['Heater choke'] && !r['Heater choke'].hidden && /^CK-102 48\/64″ · CRITICAL$/.test(r['Heater choke'].v), 'heater choke row: ' + JSON.stringify(r['Heater choke']));
        const by = app.el('wts_bypass'), v0 = by.value;
        assert.strictEqual(v0, '0', 'heater in line at the start');
        app.click(cardBtn(app, 'bypass')); app.flush(50);
        const yes = app.find('[data-act="confirm-yes"]');
        assert.ok(yes && /CK-102 goes out of line with it/.test(text(yes.closest('.wtsl-conf'))), 'confirm text');
        assert.strictEqual(by.value, '0', 'nothing before the confirm');
        app.click(app.find('[data-act="menu-close"]')); app.flush(50);
        assert.strictEqual(by.value, '0', 'Cancel keeps the heater in line');
        app.click(cardBtn(app, 'bypass')); app.flush(50); app.click(app.find('[data-act="confirm-yes"]')); app.flush(50);
        assert.strictEqual(by.value, '1', 'bypassed after the confirm');
        app.select('wts_bypass', '0'); app.flush(300);
        // bypassed state: the row says so
        t.set({ bypassed: true }); app.flush(600);
        assert.strictEqual(cardRows(app)['Heater choke'].v, 'CK-102 · ' + X.LABELS.bypassed, 'row while bypassed');
        // CK-102 out: no row, and Bypass toggles at once (v3.3.1 behaviour)
        t.set({ ck2: false, bypassed: false }); app.flush(600);
        r = cardRows(app);
        assert.ok(r['Heater choke'].hidden, 'no heater choke row while CK-102 is out');
        app.click(cardBtn(app, 'bypass')); app.flush(50);
        assert.ok(!app.find('[data-act="confirm-yes"]') && by.value === '1', 'no confirm without CK-102');
        app.select('wts_bypass', '0'); app.flush(300);
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSFUV L Rig-up card: CK-102 "Bypassed with H-101"; V-101 out → row by destination; FS-401 switch disabled with V-101 out to the burner line, enabled for a production line (relief to vent)',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app, { ck2: true, bypassed: true });
      try {
        app.flush(1200);
        const rv = (k) => text(rigRow(app, k).querySelector('.rv'));
        assert.strictEqual(rv('heaterChoke'), X.LABELS.bypassed, 'CK-102 bypassed: ' + rv('heaterChoke'));
        assert.ok(!rigRow(app, 'heaterChoke').classList.contains('rp-skip'), 'row reported while in the rig-up');
        t.set({ bypassed: false }); app.flush(1200);
        assert.strictEqual(rv('heaterChoke'), 'In service', 'CK-102 in line');
        // V-101 out, burner / flare line
        t.set({ ck2: false, sepOut: true, dest: 'flare' }); app.flush(1200);
        assert.strictEqual(rv('separator'), 'Bypassed → burner / flare line', 'V-101 row (flare)');
        const fs = app.el('wtsl_rigup').querySelector('[data-rig="flare"]');
        assert.ok(fs.disabled && /production line/.test(fs.getAttribute('title')), 'FS-401 switch disabled with the reason: ' + fs.getAttribute('title'));
        assert.ok(rigRow(app, 'heaterChoke').classList.contains('rp-skip'), 'CK-102 row rp-skip while out');
        // production line
        t.set({ dest: 'line', P: 300 }); app.flush(1200);
        assert.strictEqual(rv('separator'), 'Bypassed → production line', 'V-101 row (line)');
        const fs2 = app.el('wtsl_rigup').querySelector('[data-rig="flare"]');
        assert.ok(!fs2.disabled && /relief of the tanks goes to vent/.test(fs2.getAttribute('title')), 'FS-401 switch enabled for a production line: ' + fs2.getAttribute('title'));
        // FS-401 out too
        t.set({ flareOut: true }); app.flush(1200);
        assert.strictEqual(rv('flare'), 'Out of rig-up · relief of the tanks goes to vent', 'FS-401 row with vent');
        // V-101 back in: v3.3.1 rows
        t.set({ sepOut: false, flareOut: false, dest: 'flare' }); app.flush(1200);
        assert.ok(rv('separator') === 'In service' && rv('flare') === 'In service' && !app.el('wtsl_rigup').querySelector('[data-rig="flare"]').disabled, 'v3.3.1 rows with V-101 in');
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSFUV L Flare card and separator note by destination: "Production line" and its pressure, totals to the line and to vent; burner line: the v3.3.1 rows only',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app, {});
      try {
        app.flush(600);
        openCard(app, 'flare');
        let r = cardRows(app);
        ['Well stream to', X.LABELS.flareCardLine, X.LABELS.hudToLine, X.LABELS.hudToVent].forEach((l) => assert.ok(r[l] && r[l].hidden, l + ' hidden with V-101 in'));
        t.set({ sepOut: true, dest: 'flare' }); app.flush(600);
        r = cardRows(app);
        assert.ok(!r['Well stream to'].hidden && r['Well stream to'].v === X.LABELS.sepByDestOptions.flare && r[X.LABELS.flareCardLine].hidden, 'burner line');
        t.set({ dest: 'line', P: 300, flareOut: false }); app.flush(600);
        r = cardRows(app);
        assert.strictEqual(r['Well stream to'].v, X.LABELS.sepByDestOptions.line, 'destination row');
        assert.ok(!r[X.LABELS.flareCardLine].hidden && /^300 psig$/.test(r[X.LABELS.flareCardLine].v) && /NRV-501 \/ XV-501/.test(r[X.LABELS.flareCardLine].d), 'line pressure row: ' + JSON.stringify(r[X.LABELS.flareCardLine]));
        assert.ok(!r[X.LABELS.hudToLine].hidden && r[X.LABELS.hudToVent].hidden, 'to-line total shown, no vent');
        // the separator card note follows the destination
        openCard(app, 'separator');
        const ro = app.el('wtsl_card').querySelector('[data-cref="rigout"]');
        assert.ok(!ro.hidden && /production line \(300 psig\) through NRV-501 \/ XV-501/.test(text(ro)), 'separator note: ' + text(ro));
        t.set({ dest: 'flare' }); app.flush(600);
        assert.ok(/goes to the burner \/ flare line/.test(text(ro)), 'separator note (flare): ' + text(ro));
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSFUV L Scenarios: "Cushion unload (clean-up)" after the fault entries opens a modal form (ids wtsl_cush_*, rp-skip, not autosaved or reported); Start sanitises → startCushion, warn shown; Stop; Esc closes; prefs round trip',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app, { start: { ok: true, msg: X.EVENT_CUSHION_EXAMPLE.msg, warn: 'V-101 water dump passes 800 bbl/d: reduce the unload rate or route to the line' } });
      try {
        app.flush(600);
        app.click(app.find('[data-act="scen"]')); app.flush(50);
        const items = app.findAll('.wtsl-menu .wtsl-mi');
        const last = items[items.length - 1];
        assert.ok(last && last.getAttribute('data-act') === 'cush-open' && text(last) === X.LABELS.scenario, 'last Scenarios entry: ' + text(last));
        assert.strictEqual(items.filter((b) => b.getAttribute('data-act') === 'fault').length, app.win.WTS_sim.FAULTS.length, 'every fault still listed (FAULT_IDS unchanged)');
        app.click(last); app.flush(50);
        const dlg = app.el('wtsl_cush_dlg');
        assert.ok(dlg && dlg.tagName.toLowerCase() === 'dialog' && dlg.classList.contains('rp-skip') && dlg.hasAttribute('data-rp-nosnap') && dlg.hasAttribute('data-no-persist'), 'modal dialog, rp-skip, nosnap, no-persist');
        assert.ok(!app.find('.wtsl-menu'), 'menu closed');
        const ids = Array.from(dlg.querySelectorAll('[id]')).map((e) => e.id);
        assert.ok(ids.length >= 8 && ids.every((id) => /^wtsl_cush_/.test(id)), 'ids share the prefix: ' + ids.join(','));
        ['wtsl_cush_V', 'wtsl_cush_SG', 'wtsl_cush_q', 'wtsl_cush_tbg', 'wtsl_cush_depth', 'wtsl_cush_start', 'wtsl_cush_stop'].forEach((id) => assert.ok(app.el(id), id));
        const D = X.DEFAULTS_NEW.cushion;
        assert.ok(app.el('wtsl_cush_V').value === String(D.V_bbl) && app.el('wtsl_cush_SG').value === String(D.SG) && app.el('wtsl_cush_q').value === String(D.q_bpd) &&
          app.el('wtsl_cush_depth').value === String(D.depth_ft) && app.el('wtsl_cush_tbg').value === '3-1/2', 'D7 defaults in the form');
        assert.deepStrictEqual(Array.from(app.el('wtsl_cush_tbg').options).map((o) => [o.value, o.textContent]), X.CUSHION_TUBING.map((c) => [c.id, c.label]), 'four tubing sizes');
        assert.ok(app.el('wtsl_cush_stop').disabled && !app.el('wtsl_cush_start').disabled, 'Start enabled, Stop disabled while no cushion runs');
        // edge values, then Start: clamped by DEFAULTS.cushion.lim and written back
        app.input('wtsl_cush_V', '1e12'); app.input('wtsl_cush_SG', '-1'); app.input('wtsl_cush_q', ''); app.select('wtsl_cush_tbg', '2-7/8'); app.input('wtsl_cush_depth', '0');
        app.flush(1500);
        app.click('wtsl_cush_start'); app.flush(50);
        const sc = t.of('startCushion');
        assert.strictEqual(sc.length, 1, 'one startCushion');
        assert.deepStrictEqual(sc[0][1], { V: D.lim.V[1], SG: D.lim.SG[0], q: D.q_bpd, cap: X.CUSHION_TUBING[1].cap, depth: D.lim.depth[0] }, 'sanitised options: ' + JSON.stringify(sc[0][1]));
        assert.ok(app.el('wtsl_cush_V').value === '500' && app.el('wtsl_cush_SG').value === '0.8' && app.el('wtsl_cush_q').value === '1500' && app.el('wtsl_cush_depth').value === '500', 'form shows the sanitised values');
        assert.ok(X.textRe(X.ALARM_TEXTS.CUSH_DUMP_start).test(text(app.el('wtsl_cush_warn'))), 'dump warning shown in the form: ' + text(app.el('wtsl_cush_warn')));
        // review round: the form says which values it changed (an empty field takes the default silently)
        const wt = text(app.el('wtsl_cush_warn'));
        ['Cushion volume set to 500 bbl (range 1–500)', 'Cushion SG set to 0.8 (range 0.8–1.5)', 'Tubing depth set to 500 ft (range 500–25000)'].forEach((m) => assert.ok(wt.indexOf(m) >= 0, 'clamp note "' + m + '": ' + wt));
        assert.ok(wt.indexOf('Unload rate') < 0, 'no note for the empty field: ' + wt);
        // device prefs, not the page record, not the report
        const I = app.win.WTS_live._internals;
        assert.deepStrictEqual(J(I.readPrefs().cushion), { V: 500, SG: 0.8, q: 1500, tbg: '2-7/8', depth: 500 }, 'prefs round trip');
        const page = app.win.localStorage.getItem('wts_page_wts') || '';
        assert.ok(!/wtsl_cush_/.test(page), 'form values not in wts_page_wts');
        const model = JSON.stringify(app.win.collectPageReport(app.el('pgBody'), { charts: false }));
        assert.ok(!/Cushion volume|wtsl_cush/.test(model), 'form not in the page report');
        // running: Start disabled, Stop → stopCushion
        t.set({ cushion: 'unloading' }); app.flush(600);
        assert.ok(app.el('wtsl_cush_start').disabled && !app.el('wtsl_cush_stop').disabled, 'Start disabled while running');
        assert.ok(/^Cushion: unloading · recovered 15\.0 \/ 50\.0 bbl · 1,?500 (bbl\/d|BPD)/.test(text(app.el('wtsl_cush_status'))), 'status: ' + text(app.el('wtsl_cush_status')));
        app.click('wtsl_cush_stop'); app.flush(50);
        assert.strictEqual(t.of('stopCushion').length, 1, 'stopCushion');
        // Esc closes; reopening shows the saved values
        app.key('wtsl_cush_V', 'Escape'); app.flush(50);
        assert.ok(!app.el('wtsl_cush_dlg'), 'Esc closes the form');
        ctlOf(app)._debug.openCushion(null); app.flush(50);
        assert.ok(app.el('wtsl_cush_V').value === '500' && app.el('wtsl_cush_tbg').value === '2-7/8', 'saved values on reopen');
        app.click('wtsl_cush_x'); app.flush(50);
        assert.ok(!app.el('wtsl_cush_dlg'), '× closes the form');
        // a refused start shows the engine message
        t.set({ start: { ok: false, msg: 'ESD tripped', warn: '' }, cushion: false });
        ctlOf(app)._debug.openCushion(null); app.flush(50); app.click('wtsl_cush_start'); app.flush(50);
        assert.strictEqual(text(app.el('wtsl_cush_warn')), 'ESD tripped', 'refusal text');
        ctlOf(app)._debug.closeCushion();
        // 3D payloads: start with the saved values, stop
        ctlOf(app)._debug.onAction(app.toWin(X.ACTIONS.cushionStart)); ctlOf(app)._debug.onAction(app.toWin(X.ACTIONS.cushionStop)); app.flush(50);
        const sc2 = t.of('startCushion');
        assert.ok(sc2.length === 3 && sc2[2][1].V === 500 && sc2[2][1].cap === X.CUSHION_TUBING[1].cap && t.of('stopCushion').length === 2, '3D cushion payloads: ' + JSON.stringify(t.calls));
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSFUV L HUD: the cushion line ("Cushion: phase · recovered x / V bbl · q bbl/d") only while a cushion exists; the totals "To production line" / "To vent" only with V-101 out to a line / FS-401 out',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app, {});
      try {
        app.flush(600);
        const wrap = (k) => { const e = hudOf(app, k); return e && e.closest('.wtsl-hi'); };
        assert.ok(hudOf(app, 'tCu').hidden && wrap('cL').hidden && wrap('cV').hidden, 'nothing new by default');
        assert.ok(!app.el('wtsl_hud').classList.contains('ds4'), 'three tank lines by default');
        t.set({ cushion: 'unloading' }); app.flush(600);
        const cu = hudOf(app, 'tCu');
        assert.ok(!cu.hidden && /^Cushion: unloading · recovered 15\.0 \/ 50\.0 bbl · 1,?500 (bbl\/d|BPD)$/.test(text(cu)), 'cushion line: ' + text(cu));
        assert.ok(app.el('wtsl_hud').classList.contains('ds4'), 'four lines → compact');
        t.set({ cushion: 'stalled' }); app.flush(600);
        assert.ok(/^Cushion: STALLED \(no lift\) · recovered 5\.0 \/ 50\.0 bbl · 0 /.test(text(cu)), 'stalled: ' + text(cu));
        t.set({ cushion: 'done' }); app.flush(600);
        assert.ok(/^Cushion: recovered · recovered 50\.0 \/ 50\.0 bbl/.test(text(cu)), 'done: ' + text(cu));
        t.set({ cushion: false, sepOut: true, dest: 'line', P: 300 }); app.flush(600);
        assert.ok(cu.hidden && !wrap('cL').hidden && wrap('cV').hidden, 'to production line only');
        assert.strictEqual(text(wrap('cL').querySelector('[data-h="cLL"]')), X.LABELS.hudToLine, 'label');
        t.set({ flareOut: true }); app.flush(600);
        assert.ok(!wrap('cL').hidden && !wrap('cV').hidden && text(wrap('cV').querySelector('[data-h="cVL"]')) === X.LABELS.hudToVent, 'to vent');
        t.set({ dest: 'flare', flareOut: false }); app.flush(600);
        assert.ok(wrap('cL').hidden && wrap('cV').hidden, 'burner line: no line / vent totals');
        assert.ok(!/NaN|undefined|Infinity/.test(app.el('wtsl_hud').textContent), 'no bad tokens');
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSFUV L real engine: the form Start shows the engine answer (message or warning), the rigup handler re-renders through wtsRenderResults with no wts:calc dispatch, inputsDiff entries',
    wp: WP, integration: true,
    run(app, assert) {
      const live = openWts(app);
      app.flush(300);
      // the cushion form against the real engine: whatever it answers is shown, nothing throws
      ctlOf(app)._debug.openCushion(null); app.flush(50);
      const r = J(ctlOf(app)._debug.startCush()); app.flush(300);
      const w = text(app.el('wtsl_cush_warn'));
      assert.ok(r && (r.ok ? w === String(r.warn || '') : w === String(r.msg || 'Cushion unload refused')), 'form shows the engine answer: ' + JSON.stringify(r) + ' / ' + w);
      ctlOf(app)._debug.stopCush(); ctlOf(app)._debug.closeCushion(); app.flush(50);
      // CK-102 in from the Rig-up card: display-only host hook, no wts:calc
      const calls = [], keep = app.win.wtsRenderResults;
      let calcs = 0;
      const onCalc = () => { calcs++; };
      app.document.addEventListener('wts:calc', onCalc);
      app.win.wtsRenderResults = function (f, rig) { calls.push(J(rig)); };
      try {
        const seq0 = live.getState().flowSeq;
        app.click(app.el('wtsl_rigup').querySelector('[data-rig="heaterChoke"]')); app.flush(300);
        assert.ok(calls.length >= 1 && calls[calls.length - 1].heaterChoke === true, 'wtsRenderResults with the rig-up');
        assert.ok(calcs === 0 && live.getState().flowSeq === seq0, 'no wts:calc, no setFlow (' + calcs + ')');
        app.click(app.el('wtsl_rigup').querySelector('[data-rig="heaterChoke"]')); app.flush(300);
      } finally { app.win.wtsRenderResults = keep; app.document.removeEventListener('wts:calc', onCalc); }
      // inputsDiff (§3.4): CK-102 bean / position, destination, line pressure
      const I = app.win.WTS_live._internals, S = app.win.WTS_sim;
      const a = J(S.SAMPLE_FLOW), b = J(S.SAMPLE_FLOW);
      a.ck2 = X.EXAMPLES.flowCk2; b.ck2 = X.EXAMPLES.flowCk2; b.ck2.bean = 44; b.sim.sepByDest = 'line';
      const d = J(I.inputsDiff(app.toWin(a), app.toWin(b)));
      assert.deepStrictEqual(d.map((x) => x[1]), ['CK-102', 'V-101'], JSON.stringify(d));
      noErr(app, assert);
    }
  },
  {
    name: 'WTSFUV L Cushion form from stored device prefs: a damaged h2viz3d_prefs.cushion block opens sanitised (clamped by DEFAULTS.cushion.lim, unknown tubing → 3-1/2″); CK-102 ΔP in psi',
    wp: WP, integration: true,
    run(app, assert) {
      const I0 = () => app.win.WTS_live._internals;
      app.win.localStorage.setItem('h2viz3d_prefs', JSON.stringify({ mode: '2d', cushion: { V: 9999, SG: 'heavy', q: 50, tbg: '9-5/8', depth: 1e9 } }));
      openWts(app);
      const t = installStub(app, { ck2: true });
      try {
        app.flush(600);
        ctlOf(app)._debug.openCushion(null); app.flush(50);
        const D = X.DEFAULTS_NEW.cushion;
        assert.ok(app.el('wtsl_cush_V').value === String(D.lim.V[1]) && app.el('wtsl_cush_SG').value === String(D.SG) && app.el('wtsl_cush_q').value === String(D.lim.q[0]) &&
          app.el('wtsl_cush_tbg').value === '3-1/2' && app.el('wtsl_cush_depth').value === String(D.lim.depth[1]),
          'sanitised form: ' + ['V', 'SG', 'q', 'tbg', 'depth'].map((k) => app.el('wtsl_cush_' + k).value).join(','));
        assert.deepStrictEqual(J(I0().readPrefs().cushion), { V: 500, SG: D.SG, q: 100, tbg: '3-1/2', depth: 25000 }, 'prefs');
        ctlOf(app)._debug.closeCushion();
        openCard(app, 'heaterChoke');
        const dp = cardRows(app)['ΔP'].v;
        assert.ok(/^[\d,.]+ psi$/.test(dp), 'ΔP is a differential (psi, not psig): ' + dp);
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSFUV L iOS: the cushion form overlay keeps its web padding or the safe-area inset plus a gap (all four sides, both widths), 16 px inputs, 44 pt controls; no insets in the web form CSS',
    wp: WP,
    run(app, assert) {
      const fs = require('fs'), path = require('path');
      const ios = fs.readFileSync(path.join(__dirname, '..', '..', 'ios-app', 'ios-additions', 'ios-styles.css'), 'utf8');
      const blk = ios.slice(ios.indexOf('Cushion unload form'));
      assert.ok(blk.length > 100, 'WP-L block present');
      [16, 10].forEach((w) => ['top', 'right', 'bottom', 'left'].forEach((sd) =>
        assert.ok(blk.indexOf('max(' + w + 'px, calc(8px + env(safe-area-inset-' + sd + ')))') >= 0, 'padding ' + w + ' px / ' + sd)));
      assert.ok(/@media \(max-width: 600px\)[\s\S]*html\.ios-app \.wtsl-cush-ov/.test(blk), 'phone padding');
      assert.ok(/html\.ios-app \.wtsl-cush-f input, html\.ios-app \.wtsl-cush-f select \{ font-size: 16px; min-height: 44px; \}/.test(blk), '16 px inputs, 44 pt');
      assert.ok(/100dvh/.test(blk), 'box fits the dynamic viewport');
      const src = fs.readFileSync(path.join(__dirname, '..', '38-wts-live.js'), 'utf8');
      const css = src.slice(src.indexOf('var CSS = ['), src.indexOf('].join', src.indexOf('var CSS = [')));
      assert.ok(/\.wtsl-cush-ov\{position:fixed/.test(css) && /padding:16px/.test(css) && /\.wtsl-cush-ov\{padding:10px\}/.test(css), 'web paddings 16 / 10 px (the iOS rule keeps them)');
      assert.ok(css.split('\n').filter((l) => /wtsl-cush/.test(l)).every((l) => l.indexOf('env(') === -1), 'no safe-area insets in the web form CSS');
      assert.ok(/end of section 9/.test(blk) && ios.indexOf('/* 8. v3.3.2 Help centre') < ios.indexOf('Cushion unload form'), 'one commented section after the Help-centre rules (section 8), closed by its end marker');
    }
  },
  {
    name: 'WTSFUV L review fixes: focus returns to Scenarios after the form closes; field-units note in Metric only; CK-102 Note row hidden while bypassed; Flare card hides Header P / Line vel with a production line',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app, { ck2: true });
      let noteOn = true;
      const g = t.stub.getState;
      t.stub.getState = function () { const s = g.call(t.stub); if (noteOn && s && s.nodes && s.nodes.heaterChoke) s.nodes.heaterChoke.note = 'Gas only through CK-102'; return s; };
      try {
        app.flush(600);
        // focus back to the toolbar Scenarios button (the menu item is removed with the menu)
        const scen = app.find('[data-act="scen"]');
        let focused = 0; scen.focus = function () { focused++; };
        app.click(scen); app.flush(50);
        const items = app.findAll('.wtsl-menu .wtsl-mi');
        app.click(items[items.length - 1]); app.flush(50);
        assert.ok(app.el('wtsl_cush_dlg'), 'form open');
        assert.ok(app.el('wtsl_cush_units') && app.el('wtsl_cush_units').hidden, 'no units note in field units');
        app.key('wtsl_cush_V', 'Escape'); app.flush(50);
        assert.ok(!app.el('wtsl_cush_dlg') && focused === 1, 'Esc: focus back on Scenarios (' + focused + ')');
        ctlOf(app)._debug.openCushion(null); app.flush(50);
        app.click('wtsl_cush_x'); app.flush(50);
        assert.strictEqual(focused, 2, '× with no opener: falls back to the Scenarios button');
        // Metric: the inputs stay in field units and say so
        app.win.WTS_units.setSystem('metric'); app.flush(50);
        ctlOf(app)._debug.openCushion(null); app.flush(600);
        assert.ok(!app.el('wtsl_cush_units').hidden && /field units \(bbl, bbl\/d, ft\)/.test(text(app.el('wtsl_cush_units'))), 'units note in Metric');
        ctlOf(app)._debug.closeCushion();
        app.win.WTS_units.setSystem('imperial'); app.flush(50);
        // CK-102 Note row: shown while in line, hidden (not a stale '—') while bypassed
        openCard(app, 'heaterChoke');
        assert.ok(!cardRows(app).Note.hidden && cardRows(app).Note.v === 'Gas only through CK-102', 'note row while in line');
        t.set({ bypassed: true }); app.flush(600);
        assert.ok(cardRows(app).Note.hidden, 'note row hidden while bypassed');
        noteOn = false;
        // Flare card: flare-only rows hidden while the well stream goes to a production line
        t.set({ bypassed: false, ck2: false }); openCard(app, 'flare');
        let r = cardRows(app);
        assert.ok(!r['Header P'].hidden && !r['Line vel'].hidden, 'flare rows with V-101 in');
        t.set({ sepOut: true, dest: 'line', P: 300 }); app.flush(600);
        r = cardRows(app);
        assert.ok(r['Header P'].hidden && r['Line vel'].hidden && !r[X.LABELS.flareCardLine].hidden, 'flare-only rows hidden with a production line');
        t.set({ dest: 'flare' }); app.flush(600);
        r = cardRows(app);
        assert.ok(!r['Header P'].hidden && !r['Line vel'].hidden, 'back to the burner line: rows again');
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
];

// ─── 2D group (WP-2D) ───────────────────────────────────────────────────────────────────────────────
const D2 = (function () {
// Simulator follow-up (docs/SIM-FOLLOWUP-PLAN.md §8, §9.2 "wts-fu-views"): views of the CK-102 heater inlet choke, the separator
// (V-101) bypass destination and the cushion unload. One array, separate groups; the lead merges them:
//   • 2D group (WP-2D, this file's first group): host WTS_DIAG_LAYOUT.ck2 / wtsDrawDiag live branch / wtsEqChkS, and the 38 2D
//     overlay (draw2dLive dashes, drawRig2d destination labels, zones2d CK-102 zone and the 2D click branch).
//   • HMI group (WP-L) and 3D group (WP-3D, wts3d-test section): added by those packages.
// View packages code against tests/_wts-fu-shapes.js (fakeFuSnapshot, LABELS) and a stub sim over the real engine (the
// visible state comes from the frozen contract, not from the engine sections that are built in parallel). Expected values are
// plan texts (§8.0 / §8.2), P&ID tags and fixture example values — never numbers taken from the code under test.

const path = require('path');
const { execFileSync } = require('child_process');
const FU = require('./_wts-fu-shapes');
const X = require('./_wts-equip-shapes');

const WP = 'WTSFUV';
const J = (o) => JSON.parse(JSON.stringify(o));
const REPO = path.resolve(__dirname, '..', '..');
const V331 = '3611343';                      // v3.3.1 tree (plan Appendix A): host + Round 7 as shipped
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
      assert.ok(textAt(fr, 'Multiphase').length === 3 && !textAt(fr, 'Multiphase').some((p) => p[0] > 380 && p[0] < 535), 'no seg-3 phase label with CK-102 in (the regime texts sit there): ' + JSON.stringify(textAt(fr, 'Multiphase')));
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
      assert.strictEqual(textAt(hy, '48/64"').length, 0, 'CK-102 in hydrate: the flag replaces the bean (no overprint)');
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
      assert.strictEqual(textAt(fd, 'Multiphase').length, 3, 'three multiphase labels (none on seg 3 with CK-102 in)');
      assert.ok(!textAt(fd, 'Multiphase').some((p) => p[0] > 400 && p[0] < 535), 'DS-101 variant: no seg-3 phase label under the two regime texts');
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
    // v3.4.1: the live engine's default T-201 line-up changed (A fills / B transfers); the frame identity is about the 2D painter,
    // so the app under test runs the v3.3.1 line-up as its default (tests/_wts-lineup-pin.js legacyEngineOverrides)
    opts: { sourceOverrides: require('./_wts-lineup-pin.js').legacyEngineOverrides() },
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
      // the fixture CK-102 outlet (30.4 °F) is below its hydrate temperature: the flag stands in for the bean at CK-102
      assert.ok(textAt(fr, '❄ HYDRATE').some((p) => p[0] === 470) && t.indexOf('48/64"') < 0 && t.indexOf('Critical') >= 0, 'hydrate flag (not the bean) / regime from the snapshot: ' + t.join('|'));
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
      // a seg-3 hydrate mark (❄ at the seg-3 midpoint, x ≈ 613, cy + 42): the label moves right, clear of it
      stub.opts = { sepOut: true, dest: 'line', P: 300, patch: (s) => { s.segs[3].hydR = true; } }; redraw(app);
      const frH = lastFrame(app, cv);
      assert.deepStrictEqual(textAt(frH, lineLabel(300)), [[L.tx[4] + 60, L.cy + 40]], 'seg-3 hydrate: production line label at tx[4] + 60');
      assert.ok(textAt(frH, '❄').some((p) => p[0] < L.tx[4] + 60 - 121 && p[1] === L.cy + 42), 'the seg-3 ❄ is left of the label start: ' + JSON.stringify(textAt(frH, '❄')));
      stub.opts = { sepOut: true, dest: 'line', P: 300 };
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
return D2;
})();

module.exports = [].concat(L, D2);
