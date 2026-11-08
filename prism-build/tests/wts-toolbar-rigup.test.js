// Well Test Simulator live HMI (38-wts-live.js) — v3.3.4:
//   • Feature 3: the toolbar "Rig-up" menu next to Scenarios / View: one row per rig-up item (tag, name, status, in/out switch),
//     optional items marked, locked items disabled with their reason, the same change path as the Rig-up card (one handler,
//     _sim.setRigup + wts_sim_rigup), refusal toast, re-render on the 'rigup' event, keyboard like the other toolbar menus.
//   • Feature 1 (38 part): the CK-101 two-leg manifold — the 3D action {type:'ckleg'}, the card buttons (data-act 'ckleg'),
//     the adjustable bean ±4 (#wts_bean) and the positive bean ±2 (#wts_beanFix), the card text and the 2D label.
//   • Feature 2 (38 part): the T-201 HUD line and card show which side fills (inlet ▸) and which side transfers (suction ▾).
//   • The operator line-up prefs (h2viz3d_prefs.ctl) restore only the groups the operator changed by hand; pre-v3.3.4 prefs
//     holding the untouched v3.3.1 T-201 line-up no longer hide the engine's default.
// The engine's default T-201 line-up and the host inputs are changed in parallel elsewhere: every check here either sets the
// line-up / inputs it tests, or compares with a fresh engine's own default, so it holds with either engine default.
'use strict';

const FU = require('./_wts-fu-shapes');
const X = require('./_wts-equip-shapes');

const WP = 'WTSTBR';
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
const rigBtn = (app) => app.el('wtsl_tb').querySelector('[data-act="rigmenu"]');
const menuEl = (app) => app.find('.wtsl-menu');
const menuRow = (app, k) => { const m = menuEl(app); return m && m.querySelector('[data-act="rig"][data-v="' + k + '"]'); };
const cardSw = (app, k) => app.el('wtsl_rigup').querySelector('[data-rig="' + k + '"]');
function openRigMenu(app) {
  if (!menuRow(app, 'surge')) app.click(rigBtn(app));
  app.flush(20);
  const m = menuEl(app);
  if (!m || !menuRow(app, 'surge')) throw new Error('Rig-up menu did not open');
  return m;
}
// a host input on the page (the host adds the real ones; the HMI only needs the id); returns the element
function hostInput(app, id, value, tag) {
  let el = app.el(id);
  if (!el) {
    el = app.document.createElement(tag || 'input'); el.id = id;
    if (!tag) el.type = 'number';
    app.el('pgBody').appendChild(el);
  }
  if (value != null) el.value = String(value);
  return el;
}
function fresh(app, o) { const S = app.win.WTS_sim; return S.create(S.SAMPLE_FLOW, app.toWin(Object.assign({ seed: 5 }, o || {}))); }
const noErr = (app, assert) => assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().map((l) => l.text || l).join(' | '));

module.exports = [
  {
    name: 'WTSTBR Rig-up menu: toolbar button next to Scenarios, one row per item in card order, optional marked, locked disabled with the reason, Esc closes',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const tb = app.el('wtsl_tb'), b = rigBtn(app);
      assert.ok(b, 'Rig-up toolbar button');
      assert.strictEqual(b.getAttribute('aria-haspopup'), 'true', 'menu button');
      assert.strictEqual(b.getAttribute('aria-expanded'), 'false');
      assert.ok(/Rig-up/.test(text(b)), 'label');
      const acts = Array.from(tb.querySelectorAll('[data-act]')).map((x) => x.getAttribute('data-act'));
      assert.strictEqual(acts.indexOf('rigmenu'), acts.indexOf('scen') + 1, 'right after Scenarios: ' + acts.join(','));
      assert.ok(acts.indexOf('rigmenu') < acts.indexOf('viewmenu'), 'before View');
      const m = openRigMenu(app);
      assert.strictEqual(m.getAttribute('role'), 'menu');
      assert.strictEqual(b.getAttribute('aria-expanded'), 'true', 'expanded while open');
      const rows = Array.from(m.querySelectorAll('[data-act="rig"]'));
      const cardOrder = Array.from(app.el('wtsl_rigup').querySelectorAll('[data-rig]')).map((x) => x.getAttribute('data-rig'));
      assert.deepStrictEqual(rows.map((r) => r.getAttribute('data-v')), cardOrder, 'same items, same order as the Rig-up card');
      assert.deepStrictEqual(cardOrder, FU.RIG_ORDER, 'process order');
      const items = app.win.WTS_sim.RIGUP;
      items.forEach((it) => {
        const r = menuRow(app, it.key);
        assert.strictEqual(r.getAttribute('role'), 'menuitemcheckbox', it.key + ' role');
        assert.ok(text(r.querySelector('.tg')) === it.tag && text(r.querySelector('.nm')).indexOf(it.name) === 0, it.key + ' tag + name: ' + text(r));
        assert.strictEqual(r.getAttribute('aria-checked'), cardSw(app, it.key).getAttribute('aria-checked'), it.key + ' switch state = card');
        assert.strictEqual(r.disabled, cardSw(app, it.key).disabled, it.key + ' disabled = card');
        assert.strictEqual(!!r.querySelector('em') && /optional/i.test(text(r.querySelector('em'))), !!it.optional, it.key + ' optional mark');
        if (it.locked) assert.ok(r.disabled && text(r.querySelector('small')) === (it.why || 'Required') && text(r.querySelector('small')).length > 3, it.key + ' locked with its reason: ' + text(r.querySelector('small')));
      });
      ['desander', 'heaterChoke', 'surge2'].forEach((k) => assert.strictEqual(menuRow(app, k).getAttribute('aria-checked'), 'false', k + ' out by default'));
      assert.ok(m.querySelector('[data-act="rigall"]'), 'Restore full rig-up item');
      // a second click on the button closes it (as the other toolbar menus)
      app.click(rigBtn(app)); app.flush(10);
      assert.ok(!menuRow(app, 'surge'), 'toggled closed');
      assert.strictEqual(b.getAttribute('aria-expanded'), 'false');
      // Esc closes it
      openRigMenu(app);
      const first = menuRow(app, 'heater'); first.focus();
      app.key(first, 'Escape'); app.flush(10);
      assert.ok(!menuRow(app, 'surge'), 'Esc closes the menu');
      noErr(app, assert);
    }
  },
  {
    name: 'WTSTBR Rig-up menu keyboard: focus moves to the first enabled row, Arrow keys rove over enabled rows only (locked ones skipped)',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const b = rigBtn(app);
      b.focus();
      assert.strictEqual(app.document.activeElement, b, 'button focused');
      app.click(b); app.flush(10);
      const m = menuEl(app);
      const enabled = Array.from(m.querySelectorAll('button')).filter((x) => !x.disabled);
      assert.strictEqual(app.document.activeElement, enabled[0], 'first enabled row focused: ' + (app.document.activeElement && app.document.activeElement.getAttribute('data-v')));
      assert.ok(enabled.every((x) => ['esd', 'choke'].indexOf(x.getAttribute('data-v')) < 0), 'locked rows are not in the rove');
      app.key(app.document.activeElement, 'ArrowDown'); app.flush(5);
      assert.strictEqual(app.document.activeElement, enabled[1], 'ArrowDown → next row');
      app.key(app.document.activeElement, 'ArrowUp'); app.key(app.document.activeElement, 'ArrowUp'); app.flush(5);
      assert.strictEqual(app.document.activeElement, enabled[enabled.length - 1], 'ArrowUp wraps');
      noErr(app, assert);
    }
  },
  {
    name: 'WTSTBR Rig-up menu toggles T-202 in / out exactly like the card (setRigup, wts_sim_rigup, card switch, toast); the menu stays open and re-renders on the rigup event',
    wp: WP, integration: true,
    run(app, assert, ctx) {
      const live = openWts(app);
      assert.strictEqual(live.getState().rigup.surge2, false, 'T-202 out by default');
      openRigMenu(app);
      app.click(menuRow(app, 'surge2')); app.flush(50);
      let st = live.getState();
      assert.strictEqual(st.rigup.surge2, true, 'T-202 in from the menu');
      assert.strictEqual(live.getRigup().surge2, true, 'request');
      assert.ok(menuRow(app, 'surge2'), 'menu still open');
      assert.strictEqual(menuRow(app, 'surge2').getAttribute('aria-checked'), 'true', 'menu row re-rendered');
      assert.strictEqual(cardSw(app, 'surge2').getAttribute('aria-checked'), 'true', 'card switch follows');
      const savedMenu = app.win.localStorage.getItem('wts_sim_rigup');
      assert.ok(savedMenu && JSON.parse(savedMenu).surge2 === true, 'saved in wts_sim_rigup: ' + savedMenu);
      assert.ok(/T-202/.test(text(app.el('wtsl_toast'))), 'rig-up toast: ' + text(app.el('wtsl_toast')));
      // the same change from the card in a second session gives the same request and the same saved key
      const app2 = ctx.loadApp({});
      try {
        const live2 = openWts(app2);
        app2.click(app2.el('wtsl_rigup').querySelector('[data-rig="surge2"]')); app2.flush(50);
        assert.deepStrictEqual(J(live2.getRigup()), J(live.getRigup()), 'card and menu → same request');
        assert.strictEqual(app2.win.localStorage.getItem('wts_sim_rigup'), savedMenu, 'card and menu → same saved rig-up');
        assert.strictEqual(live2.getState().rigup.sig, live.getState().rigup.sig, 'same effective rig-up');
      } finally { if (app2.dispose) app2.dispose(); }
      // a change from the card while the menu is open: the menu re-renders on the rigup event
      app.click(cardSw(app, 'heater')); app.flush(50);
      assert.strictEqual(live.getState().rigup.heater, false, 'H-101 out from the card');
      assert.ok(menuRow(app, 'heater'), 'menu still open');
      assert.strictEqual(menuRow(app, 'heater').getAttribute('aria-checked'), 'false', 'menu row follows the card');
      app.click(menuRow(app, 'heater')); app.flush(50);
      assert.strictEqual(live.getState().rigup.heater, true, 'H-101 back from the menu');
      // T-202 out again from the menu: back to the default (the key is removed, as the card does)
      openRigMenu(app);
      app.click(menuRow(app, 'surge2')); app.flush(50);
      st = live.getState();
      assert.strictEqual(st.rigup.surge2, false, 'T-202 out from the menu');
      assert.strictEqual(app.win.localStorage.getItem('wts_sim_rigup'), null, 'default rig-up → key removed');
      assert.strictEqual(cardSw(app, 'surge2').getAttribute('aria-checked'), 'false');
      // Restore full rig-up from the menu
      app.click(cardSw(app, 'separator')); app.flush(50);
      assert.strictEqual(live.getState().rigup.separator, false);
      openRigMenu(app);
      const all = menuEl(app).querySelector('[data-act="rigall"]');
      assert.ok(all && !all.disabled, 'Restore full rig-up enabled');
      app.click(all); app.flush(50);
      assert.strictEqual(live.getState().rigup.separator, true, 'full rig-up restored');
      assert.ok(menuEl(app).querySelector('[data-act="rigall"]').disabled, 'disabled at the full rig-up');
      noErr(app, assert);
    }
  },
  {
    name: 'WTSTBR Rig-up menu: CK-102 needs H-101 (disabled with the reason, as in the card); a refused T-202 removal disables the row with the engine note',
    wp: WP, integration: true,
    run(app, assert) {
      const live = openWts(app);
      live.setRigup(app.toWin({ heater: false })); app.flush(50);
      openRigMenu(app);
      const r = menuRow(app, 'heaterChoke'), c = cardSw(app, 'heaterChoke');
      assert.strictEqual(r.disabled, c.disabled, 'same rule as the card');
      if (c.disabled) assert.strictEqual(text(r.querySelector('small')), c.getAttribute('title'), 'reason shown: ' + text(r.querySelector('small')));
      live.setRigup(app.toWin({ heater: true })); app.flush(50);
      // refused removal (stub snapshot with rigup.refused, as wts-equipment-views)
      const I = app.win.WTS_live._internals, real = I.sim(), stub = Object.create(real);
      stub.getState = function () { return app.toWin(X.fakeEquipSnapshot(J(real.getState()), { desander: false, surge2: true, refused: true })); };
      stub.getRigup = function () { const q = J(real.getRigup()); q.surge2 = true; return app.toWin(q); };
      I.useSim(stub);
      try {
        app.flush(600);
        openRigMenu(app);
        const r2 = menuRow(app, 'surge2');
        assert.ok(r2.disabled, 'T-202 row disabled while the removal is refused');
        assert.strictEqual(text(r2.querySelector('small')), X.RIG_NOTES.surge2OnlyRouteRefused, 'refusal reason in the row');
        assert.strictEqual(r2.getAttribute('title'), cardSw(app, 'surge2').getAttribute('title'), 'same tooltip as the card');
      } finally { I.useSim(real); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSTBR Rig-up menu: a change the engine refuses is toasted with its reason (shared handler)',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const I = app.win.WTS_live._internals, real = I.sim(), stub = Object.create(real);
      const calls = [];
      let refused = '';
      stub.getState = function () { const st = J(real.getState()); if (refused) st.rigup.refused = refused; return app.toWin(st); };
      stub.setRigup = function (o) { calls.push(J(o)); refused = 'T-202 is the only open route'; return false; };
      I.useSim(stub);
      try {
        app.flush(300);
        openRigMenu(app);
        app.click(menuRow(app, 'surge2')); app.flush(50);
        assert.deepStrictEqual(calls, [{ surge2: true }], 'setRigup called once with the switch request');
        assert.ok(/Rig-up change refused — T-202 is the only open route/.test(text(app.el('wtsl_toast'))), 'refusal toast: ' + text(app.el('wtsl_toast')));
        // the card switch goes through the same handler
        refused = '';
        app.click(cardSw(app, 'gauge')); app.flush(50);
        assert.deepStrictEqual(calls[1], { gauge: false }, 'card → the same setRigup path');
      } finally { I.useSim(real); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSTBR the overflow (More) menu lists the rig-up rows too and toggles through the same handler',
    wp: WP, integration: true,
    run(app, assert) {
      const live = openWts(app);
      const more = app.el('wtsl_tb').querySelector('[data-act="more"]');
      app.click(more); app.flush(10);
      const m = menuEl(app);
      assert.ok(m && /Rig-up/.test(text(m)) && menuRow(app, 'surge2'), 'rig-up rows in the overflow menu');
      app.click(menuRow(app, 'surge2')); app.flush(50);
      assert.strictEqual(live.getState().rigup.surge2, true, 'T-202 in from the overflow menu');
      assert.strictEqual(menuRow(app, 'surge2').getAttribute('aria-checked'), 'true', 'overflow menu re-rendered');
      noErr(app, assert);
    }
  },
  {
    name: 'WTSTBR CK-101 legs: the 3D ckleg action and the card buttons set #wts_ckLeg; beanFix ±2 and bean ±4 set the host beans (clamped 4-128)',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const leg = app.el('wts_ckLeg') || hostInput(app, 'wts_ckLeg', 'adj');
      if (leg.tagName === 'SELECT' && !leg.querySelector('option')) ['adj', 'fixed'].forEach((v) => { const o = app.document.createElement('option'); o.value = v; o.textContent = v; leg.appendChild(o); });
      leg.value = 'adj';
      const fix = hostInput(app, 'wts_beanFix', 24);
      const bean = hostInput(app, 'wts_bean', 32);
      let changes = 0; leg.addEventListener('change', () => { changes++; });
      const D = ctlOf(app)._debug;
      D.onAction(app.toWin({ type: 'ckleg', eq: 'choke', leg: 'fixed' })); app.flush(50);
      assert.strictEqual(leg.value, 'fixed', '3D ckleg:fixed → #wts_ckLeg');
      assert.ok(changes >= 1, 'change event fired (the host recalculates)');
      D.onAction(app.toWin({ type: 'ckleg', eq: 'choke', leg: 'bogus' })); app.flush(20);
      assert.strictEqual(leg.value, 'fixed', 'an unknown leg does nothing');
      D.onAction(app.toWin({ type: 'ckleg', eq: 'separator', leg: 'adj' })); app.flush(20);
      assert.strictEqual(leg.value, 'fixed', 'another eq does nothing');
      D.onAction(app.toWin({ type: 'ckleg', eq: 'choke', leg: 'adj' })); app.flush(50);
      assert.strictEqual(leg.value, 'adj', '3D ckleg:adj → #wts_ckLeg');
      // card
      D.openCard('choke'); app.flush(300);
      const card = app.el('wtsl_card');
      const btn = (act, v) => card.querySelector('[data-act="' + act + '"][data-v="' + v + '"]');
      assert.ok(btn('ckleg', 'adj') && btn('ckleg', 'fixed'), 'In service buttons');
      assert.strictEqual(btn('ckleg', 'adj').getAttribute('aria-pressed'), 'true', 'adjustable pressed');
      app.click(btn('ckleg', 'fixed')); app.flush(50);
      assert.strictEqual(leg.value, 'fixed', 'card → positive leg');
      assert.strictEqual(card.querySelector('[data-act="ckleg"][data-v="fixed"]').getAttribute('aria-pressed'), 'true', 'positive pressed');
      app.click(btn('beanFix', '2')); app.flush(50);
      assert.strictEqual(+fix.value, 26, 'positive bean +2');
      app.click(card.querySelector('[data-act="beanFix"][data-v="-2"]')); app.click(card.querySelector('[data-act="beanFix"][data-v="-2"]')); app.flush(50);
      assert.strictEqual(+fix.value, 22, 'positive bean −2 twice');
      app.click(card.querySelector('[data-act="bean"][data-v="4"]')); app.flush(50);
      assert.strictEqual(+bean.value, 36, 'adjustable bean +4');
      app.click(card.querySelector('[data-act="bean"][data-v="-4"]')); app.flush(50);
      assert.strictEqual(+bean.value, 32, 'adjustable bean −4');
      fix.value = '127'; app.click(card.querySelector('[data-act="beanFix"][data-v="2"]')); app.flush(50);
      assert.strictEqual(+fix.value, 128, 'clamped at 128');
      fix.value = '5'; app.click(card.querySelector('[data-act="beanFix"][data-v="-2"]')); app.flush(50);
      assert.strictEqual(+fix.value, 4, 'clamped at 4');
      // card text: the in-service leg and both beans (host-input fallback when the snapshot has no leg yet)
      app.flush(400);
      const kv = {};
      Array.from(card.querySelectorAll('.wtsl-kv > div')).forEach((r) => { kv[text(r.querySelector('.l'))] = { v: text(r.querySelector('.v')), d: text(r.querySelector('.d')), hidden: !!r.hidden }; });
      const st = app.win.WTS_live.getSim().getState(), nc = st.nodes.choke;
      const expLeg = typeof nc.leg === 'string' ? nc.leg : 'fixed';
      assert.ok(kv['In service'] && !kv['In service'].hidden, 'In service row: ' + JSON.stringify(Object.keys(kv)));
      assert.strictEqual(kv['In service'].v, expLeg === 'fixed' ? 'Leg B · Positive (fixed) choke' : 'Leg A · Adjustable choke', 'leg text');
      const bA = typeof nc.beanAdj === 'number' ? nc.beanAdj : 32, bF = typeof nc.beanFix === 'number' ? nc.beanFix : 4;
      assert.strictEqual(kv.Bean.d, (expLeg === 'adj' ? '▸ ' : '') + 'Adjustable ' + bA + '/64″ · ' + (expLeg === 'fixed' ? '▸ ' : '') + 'Positive ' + bF + '/64″', 'both beans: ' + kv.Bean.d);
      noErr(app, assert);
    }
  },
  {
    name: 'WTSTBR CK-101 2D label: the in-service leg and its bean (ADJ / POS)',
    wp: WP, integration: true,
    run(app, assert) {
      const live = openWts(app);
      hostInput(app, 'wts_ckLeg', 'adj');
      app.el('wtsl_tb').querySelector('[data-act="mode2d"]') && app.click(app.el('wtsl_tb').querySelector('[data-act="mode2d"]'));
      live.advance(5); app.flush(600);
      const cv = app.el('wts_viz').querySelector('canvas');
      const nc = live.getState().nodes.choke;
      const legNow = typeof nc.leg === 'string' ? nc.leg : 'adj';
      const exp = (legNow === 'fixed' ? 'POS ' : 'ADJ ') + nc.bean + '/64"';
      const texts = app.canvasTexts(cv);
      assert.ok(texts.indexOf(exp) >= 0, '2D label ' + exp + ' in ' + texts.filter((t) => /64"/.test(t)).join(' | '));
      noErr(app, assert);
    }
  },
  {
    name: 'WTSTBR T-201 HUD and card: ▸ marks the side that fills (inlet open), ▾ the side that transfers (LCV-201 suction); Line-up row',
    wp: WP, integration: true,
    run(app, assert) {
      const live = openWts(app);
      // pin the line-up under test (independent of the engine default): A fills, B transfers
      live.setValve('surge', 0, true); live.setValve('surge', 1, false); live.setSuction('B');
      live.advance(20); app.flush(800);
      const st = live.getState(), C = st.surge.comps;
      assert.ok(C[0].inlet && !C[1].inlet && !C[0].suction && C[1].suction, 'line-up pinned: ' + JSON.stringify(J(C).map((c) => [c.inlet, c.suction])));
      const hud = app.el('wtsl_hud').querySelector('[data-h="tSu"]');
      const h = text(hud);
      assert.ok(/^Surge ▸A \d+% · B \d+%▾ · LCV-201 /.test(h), 'HUD: ' + h);
      assert.ok(/A filling \d+% · B transferring \d+%/.test(hud.getAttribute('title') || ''), 'HUD tooltip: ' + hud.getAttribute('title'));
      ctlOf(app)._debug.openCard('surge'); app.flush(400);
      const card = app.el('wtsl_card');
      const row = Array.from(card.querySelectorAll('.wtsl-kv > div')).find((r) => text(r.querySelector('.l')) === 'Line-up');
      assert.ok(row && /^A filling \d+% · B transferring \d+%$/.test(text(row.querySelector('.v'))), 'card Line-up: ' + text(row && row.querySelector('.v')));
      // both inlets and suction A + B (the v3.3.1 line-up): both marked
      live.setValve('surge', 1, true); live.setSuction('both'); live.advance(20); app.flush(800);
      const h2 = text(hud);
      assert.ok(/^Surge ▸A \d+%▾ · ▸B \d+%▾ · LCV-201 /.test(h2), 'HUD both: ' + h2);
      noErr(app, assert);
    }
  },
  {
    name: 'WTSTBR line-up prefs: a pre-v3.3.4 untouched T-201 line-up gives way to the engine default; a deliberate one (old or new prefs) is kept; gauge kept',
    wp: WP, integration: true,
    run(app, assert, ctx) {
      const def = J(fresh(app).getControls());
      const legacySurge = { inlet: [true, true], suction: 'both', auto: false, sp: 0.8, hyst: 0.1, strokeS: 6 };
      const gaugeUser = J(def.gauge); gaugeUser.inlet = [false, true]; gaugeUser.strokeS = 9;
      const load = (prefs) => {
        const a = ctx.loadApp({});
        a.win.localStorage.setItem('h2viz3d_prefs', JSON.stringify(prefs));
        const b = ctx.loadApp({ storage: a.storage });
        if (a.dispose) a.dispose();
        return b;
      };
      // 1. old prefs (no ctlUser), T-201 as the v3.3.1 default → the engine default applies; the gauge part is kept
      let a1 = load({ mode: '2d', ctl: { surge: legacySurge, gauge: gaugeUser, v: 1 } });
      try {
        const c = J(openWts(a1).getControls());
        assert.deepStrictEqual(c.surge, def.surge, 'untouched old T-201 line-up → engine default ' + JSON.stringify(def.surge));
        assert.deepStrictEqual(c.gauge.inlet, [false, true], 'gauge line-up kept'); assert.strictEqual(c.gauge.strokeS, 9);
      } finally { if (a1.dispose) a1.dispose(); }
      // 2. old prefs with a deliberate T-201 choice → kept
      const mine = { inlet: [false, true], suction: 'A', auto: true, sp: 0.75, hyst: 0.1, strokeS: 6 };
      a1 = load({ mode: '2d', ctl: { surge: mine, gauge: def.gauge, v: 1 } });
      try {
        const c = J(openWts(a1).getControls());
        assert.deepStrictEqual(c.surge, mine, 'deliberate old T-201 line-up kept');
      } finally { if (a1.dispose) a1.dispose(); }
      // 3. new prefs: the operator only touches the gauge tank → after a reload T-201 starts at the engine default, gauge restored
      a1 = ctx.loadApp({});
      try {
        const live = openWts(a1);
        live.setValveOptions('gauge', a1.toWin({ strokeS: 11 })); a1.flush(50);
        const p = JSON.parse(a1.win.localStorage.getItem('h2viz3d_prefs') || '{}');
        assert.ok(p.ctl && p.ctlUser && p.ctlUser.gauge === true && !p.ctlUser.surge, 'ctlUser marks the gauge only: ' + JSON.stringify(p.ctlUser));
        // simulate an automatic T-201 change saved in the prefs (auto events never mark the group)
        p.ctl.surge = { inlet: [false, true], suction: 'A', auto: false, sp: 0.8, hyst: 0.1, strokeS: 6 };
        a1.win.localStorage.setItem('h2viz3d_prefs', JSON.stringify(p));
        const a2 = ctx.loadApp({ storage: a1.storage });
        try {
          const c = J(openWts(a2).getControls());
          assert.deepStrictEqual(c.surge, def.surge, 'T-201 not touched by hand → engine default');
          assert.strictEqual(c.gauge.strokeS, 11, 'gauge restored');
        } finally { if (a2.dispose) a2.dispose(); }
        // 4. a hand change of T-201 is kept across a reload
        live.setSuction(def.surge.suction === 'A' ? 'B' : 'A'); a1.flush(50);
        const want = J(live.getControls()).surge;
        const a3 = ctx.loadApp({ storage: a1.storage });
        try {
          assert.deepStrictEqual(J(openWts(a3).getControls()).surge, want, 'hand-set T-201 line-up restored');
        } finally { if (a3.dispose) a3.dispose(); }
      } finally { if (a1.dispose) a1.dispose(); }
    }
  }
];
