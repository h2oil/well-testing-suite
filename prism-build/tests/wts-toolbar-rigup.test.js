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
// WTS_3d's WebGL parts replaced by a fake so the live view mounts 3D in the harness (as ios-app-3d-layout.test.js)
function fake3d(app) {
  const W = app.win, noop = () => {};
  const handle = () => ({ dispose: noop, focus: noop, frame: noop, legend: noop, refreshUnits: noop, resize: noop, select: noop,
    setAutoOrbit: noop, setInsets: noop, setInteraction: noop, setLabels: noop, setOverlay: noop, setPaused: noop,
    setQuality: noop, setReducedMotion: noop, view: noop, stats: {} });
  W.WTS_3d = Object.assign({}, W.WTS_3d, {
    isSupported: () => true, loadThree: () => Promise.resolve({}), hasLocalCopy: () => Promise.resolve(true),
    mount: () => Promise.resolve(handle()),
  });
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
    // review: the host painter (wtsDrawDiag) prints the one prefix from nodes[2].leg; 38 passes the leg and a numeric bean, so the
    // positive leg reads 'positive 20/64"' (never 'positive POS 20/64"') and the adjustable leg keeps the plain v3.3 label
    name: 'WTSTBR CK-101 2D label: one prefix — "positive 20/64\"" while the positive leg is in service (change event), back to the plain adjustable label',
    wp: WP, integration: true,
    run(app, assert) {
      const live = openWts(app);
      const leg = app.el('wts_ckLeg'), bf = app.el('wts_beanFix'), ba = app.el('wts_bean');
      assert.ok(leg && bf && ba, 'host CK-101 inputs on the page');
      const m2 = app.el('wtsl_tb').querySelector('[data-act="mode2d"]');
      if (m2) app.click(m2);
      const cv = app.el('wts_viz').querySelector('canvas');
      const labels = () => app.canvasTexts(cv).filter((t) => /64"/.test(t));
      // the recording canvas log is cumulative: clear it after each change so only the frames drawn since then are read
      const drive = (id, v) => { const el = app.el(id); el.value = String(v); app.fire(el, 'input'); app.fire(el, 'change'); app.flush(2000); if (cv._log) cv._log.length = 0; live.advance(5); app.flush(600); };
      // positive leg in service, bean 20
      drive('wts_beanFix', 20);
      drive('wts_ckLeg', 'fixed');
      assert.strictEqual(live.getState().nodes.choke.leg, 'fixed', 'snapshot: positive leg in service');
      assert.strictEqual(live.getState().nodes.choke.bean, 20, 'snapshot: bean = the positive bean');
      let L = labels();
      assert.ok(L.length > 0 && L.indexOf('positive 20/64"') >= 0, '2D label "positive 20/64\"" in ' + L.join(' | '));
      assert.ok(!L.some((t) => /POS |positive positive/.test(t)), 'one prefix only: ' + L.join(' | '));
      // back to the adjustable leg: the plain v3.3 label
      drive('wts_ckLeg', 'adj');
      assert.strictEqual(live.getState().nodes.choke.leg, 'adj', 'snapshot: adjustable leg in service');
      const bAdj = +ba.value;
      L = labels();
      assert.ok(L.length > 0 && L.indexOf(bAdj + '/64"') >= 0, '2D label "' + bAdj + '/64\"" in ' + L.join(' | '));
      assert.ok(!L.some((t) => /positive|POS|ADJ/.test(t)), 'adjustable leg: no prefix: ' + L.join(' | '));
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
        // 5. review round 2: an automatic divert followed by a hand change to ANOTHER group (the gauge tank) must not save the
        //    auto-diverted T-201 line-up — the reload restores the operator's hand line-up
        live.setValve('surge', 0, true); live.setValve('surge', 1, false); live.setSuction('B');
        live.setAutoDivert('surge', true, a1.toWin({ sp: 0.4 })); a1.flush(50);
        for (let i = 0; i < 3; i++) live.advance(10);           // valves at their limits
        const hand = J(live.getControls()).surge;
        let dv = 0; live.on('divert', (e) => { if (e.eq === 'surge') dv++; });
        for (let i = 0; i < 720 && !dv; i++) live.advance(10);
        assert.ok(dv > 0, 'an automatic T-201 divert happened');
        const after = J(live.getControls()).surge;
        assert.notDeepStrictEqual(after.inlet, hand.inlet, 'the divert changed the live inlets');
        live.setValveOptions('gauge', a1.toWin({ strokeS: 12 })); a1.flush(50);
        const a4 = ctx.loadApp({ storage: a1.storage });
        try {
          const c4 = J(openWts(a4).getControls());
          assert.deepStrictEqual(c4.surge, hand, 'hand T-201 line-up restored, not the auto-diverted one: ' + JSON.stringify(c4.surge));
          assert.strictEqual(c4.gauge.strokeS, 12, 'the later gauge hand change is restored');
        } finally { if (a4.dispose) a4.dispose(); }
      } finally { if (a1.dispose) a1.dispose(); }
      // 6-8. final pass: a T-201 event that is not a line-up item (a trip reset) keeps the saved hand line-up, and a hand
      //      'options' / 'auto' change after an auto-divert merges only its own fields into the saved part
      const handThenDivert = (a) => {
        const live = openWts(a);
        // the opposite of the engine default line-up (B fills, A transfers), so a reload that fell back to the default would show
        live.setValve('surge', 1, true); live.setValve('surge', 0, false); live.setSuction('A');
        // set point above B's start level (0.60), so the reloaded line-up does not divert in its first seconds
        live.setAutoDivert('surge', true, a.toWin({ sp: 0.7 })); a.flush(50);
        for (let i = 0; i < 3; i++) live.advance(10);
        const hand = J(live.getControls()).surge;
        let dv = 0; live.on('divert', (e) => { if (e.eq === 'surge') dv++; });
        for (let i = 0; i < 720 && !dv; i++) live.advance(10);
        assert.ok(dv > 0, 'an automatic T-201 divert happened');
        assert.notDeepStrictEqual(J(live.getControls()).surge.inlet, hand.inlet, 'the divert changed the live inlets');
        return { live, hand };
      };
      const reloadSurge = (a) => {
        const b = ctx.loadApp({ storage: a.storage });
        try { return J(openWts(b).getControls()).surge; } finally { if (b.dispose) b.dispose(); }
      };
      // 6. hand line-up, auto-divert, an LSHH-301 trip (both gauge inlets open) and its reset → the hand line-up is restored
      let a5 = ctx.loadApp({});
      try {
        const { live, hand } = handThenDivert(a5);
        live.setValve('gauge', 0, true); live.setValve('gauge', 1, true); a5.flush(50);
        const hasA = (id) => (live.getState().alarms || []).some((x) => (x.id || x) === id);
        let n = 0; while (!hasA('LSHH_GT') && n++ < 4000) live.advance(10);
        assert.ok(hasA('LSHH_GT'), 'LSHH-301 tripped');
        let resets = 0; live.on('control', (e) => { if (e.what === 'reset' && !e.auto) resets++; });
        let r = null; n = 0;
        // reset only while the live T-201 line-up is not the hand one (the automation moves it on its own), so saving the live
        // part at the reset would show
        const off = () => JSON.stringify(J(live.getControls()).surge) !== JSON.stringify(hand);
        while (!(r && r.ok && r.reset.indexOf('LSHH_GT') >= 0) && n++ < 8000) { live.advance(10); if (off()) r = live.resetTrip('LSHH_GT'); }
        assert.ok(r && r.ok && resets > 0, 'trip reset (a hand reset control event): ' + JSON.stringify(r));
        assert.ok(off(), 'the live line-up at the reset is not the hand one');
        a5.flush(50);
        assert.deepStrictEqual(reloadSurge(a5), hand, 'trip reset → the hand T-201 line-up is restored, not the diverted one');
      } finally { if (a5.dispose) a5.dispose(); }
      // 7. hand line-up, auto-divert, then a hand stroke time → the hand inlets / suction with stroke 8 s
      a5 = ctx.loadApp({});
      try {
        const { live, hand } = handThenDivert(a5);
        live.setValveOptions('surge', a5.toWin({ strokeS: 8 })); a5.flush(50);
        assert.deepStrictEqual(reloadSurge(a5), Object.assign({}, hand, { strokeS: 8 }), 'stroke merged into the hand line-up');
      } finally { if (a5.dispose) a5.dispose(); }
      // 8. the same with a hand auto-divert set point → the hand inlets / suction with the new set point
      a5 = ctx.loadApp({});
      try {
        const { live, hand } = handThenDivert(a5);
        live.setAutoDivert('surge', true, a5.toWin({ sp: 0.75 })); a5.flush(50);
        assert.deepStrictEqual(reloadSurge(a5), Object.assign({}, hand, { sp: 0.75 }), 'set point merged into the hand line-up');
      } finally { if (a5.dispose) a5.dispose(); }
      // 9. fresh prefs, T-201 never set by hand: the first saved event is the engine's own auto-divert, then a hand stroke time →
      //    the reload starts from the engine default line-up (the run's start), with stroke 9 s — never the diverted inlets
      a5 = ctx.loadApp({});
      try {
        const live = openWts(a5);
        const start = J(live.getControls()).surge;
        let dv = 0; live.on('divert', (e) => { if (e.eq === 'surge') dv++; });
        for (let i = 0; i < 720 && !dv; i++) live.advance(10);
        a5.flush(50);
        assert.ok(dv > 0, 'the default line-up auto-diverted');
        assert.notDeepStrictEqual(J(live.getControls()).surge.inlet, start.inlet, 'the live inlets are the diverted ones');
        live.setValveOptions('surge', a5.toWin({ strokeS: 9 })); a5.flush(50);
        assert.deepStrictEqual(reloadSurge(a5), Object.assign({}, start, { strokeS: 9 }), 'run-start line-up with the stroke, not the diverted one');
      } finally { if (a5.dispose) a5.dispose(); }
    }
  },
  {
    // review (live 1): pre-v3.3.4 prefs stored automatic events too, so they cannot tell an automatic LSHH-201 closure or auto-divert
    // from a hand change: a T-201 part that differs from the v3.3.1 default only by its inlets counts as untouched, and a saved
    // line-up with both inlets shut is never restored (new prefs: the other hand-set parts are kept, the inlets follow the engine)
    name: 'WTSTBR line-up prefs migration: inlet-only differences (an automatic LSHH-201 closure) are untouched; both inlets shut is never restored',
    wp: WP, integration: true,
    run(app, assert, ctx) {
      const def = J(fresh(app).getControls());
      const load = (prefs) => {
        const a = ctx.loadApp({});
        a.win.localStorage.setItem('h2viz3d_prefs', JSON.stringify(prefs));
        const b = ctx.loadApp({ storage: a.storage });
        if (a.dispose) a.dispose();
        return b;
      };
      const legacy = (inlet) => ({ inlet, suction: 'both', auto: false, sp: 0.8, hyst: 0.1, strokeS: 6 });
      [[false, false], [true, false], [false, true]].forEach((inl) => {
        const a1 = load({ mode: '2d', ctl: { surge: legacy(inl), gauge: def.gauge, v: 1 } });
        try {
          const live = openWts(a1);
          const c = J(live.getControls());
          assert.deepStrictEqual(c.surge, def.surge, 'old prefs, inlets ' + JSON.stringify(inl) + ' only → engine default');
          assert.ok(!live.getState().surge.comps.every((k) => !k.inlet), 'the start is not blocked (an inlet is open)');
        } finally { if (a1.dispose) a1.dispose(); }
      });
      // new prefs, T-201 set by hand, saved with both inlets shut: suction / set point kept, inlets = the engine default
      const a2 = load({ mode: '2d', ctl: { surge: { inlet: [false, false], suction: 'A', auto: true, sp: 0.7, hyst: 0.1, strokeS: 6 }, gauge: def.gauge, v: 1 },
        ctlUser: { surge: true } });
      try {
        const c = J(openWts(a2).getControls());
        assert.deepStrictEqual(c.surge.inlet, def.surge.inlet, 'both-shut inlets never restored: ' + JSON.stringify(c.surge.inlet));
        assert.strictEqual(c.surge.sp, 0.7, 'the rest of the hand line-up kept (set point)');
      } finally { if (a2.dispose) a2.dispose(); }
      noErr(app, assert);
    }
  },
  {
    // review (live 2): the Line-up words come from the flows (fill / draw, LCV-201 on), not from the inlet and suction commands
    name: 'WTSTBR T-201 Line-up row: LCV-201 stuck shut → "suction, LCV-201 stuck shut"; after an ESD → "inlet open, no flow"; normal → filling / transferring',
    wp: WP, integration: true,
    run(app, assert) {
      const live = openWts(app);
      live.setValve('surge', 0, true); live.setValve('surge', 1, false); live.setSuction('B');
      live.advance(20); app.flush(800);
      ctlOf(app)._debug.openCard('surge'); app.flush(400);
      const card = app.el('wtsl_card');
      const row = () => Array.from(card.querySelectorAll('.wtsl-kv > div')).find((r) => text(r.querySelector('.l')) === 'Line-up');
      const val = () => text(row() && row().querySelector('.v'));
      const hud = () => app.el('wtsl_hud').querySelector('[data-h="tSu"]').getAttribute('title') || '';
      assert.ok(/^A filling \d+% · B transferring \d+%$/.test(val()), 'normal: ' + val());
      live.setFault('xferStuckClosed', true); live.advance(20); app.flush(800);
      assert.strictEqual(live.getState().surge.transfer ? live.getState().surge.transfer.on : live.getState().surge.pump.on, false, 'LCV-201 not drawing');
      assert.ok(/^A filling \d+% · B suction, LCV-201 stuck shut \d+%$/.test(val()), 'stuck shut: ' + val());
      assert.ok(!/transferring/.test(hud()), 'HUD tooltip says no transfer: ' + hud());
      live.setFault('xferStuckClosed', false);
      live.tripESD('test'); live.advance(30); app.flush(800);
      assert.ok(/^A inlet open, no flow \d+%/.test(val()), 'after an ESD: ' + val());
      assert.ok(!/A filling/.test(hud()), 'HUD tooltip after an ESD: ' + hud());
      noErr(app, assert);
    }
  },
  {
    // review (live 3): a menu taller than the space below its toolbar button stays below it (max-height = the space left, it
    // scrolls) instead of flipping over the toolbar; an open menu puts the toast stack under it
    name: 'WTSTBR Rig-up menu placement: stays below its button with max-height = the space left; toasts go under an open menu',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app); app.flush(200);
      const btn = rigBtn(app);
      const viz = btn.closest('.wtsl-viz');
      assert.ok(viz, 'viz element');
      viz.getBoundingClientRect = () => ({ left: 0, top: 0, width: 965, height: 460, right: 965, bottom: 460 });
      btn.getBoundingClientRect = () => ({ left: 614, top: 12, width: 50, height: 32, right: 664, bottom: 44 });
      const m = openRigMenu(app);
      assert.strictEqual(m.parentNode, viz, 'menu in the viz');
      assert.strictEqual(m.style.top, '50px', 'menu stays below its button (top ' + m.style.top + ')');
      assert.strictEqual(m.style.maxHeight, '402px', 'max-height = the space left below the button (' + m.style.maxHeight + ')');
      assert.ok(m.offsetHeight <= 402, 'menu height within the space left');
      assert.ok(viz.hasAttribute('data-menu'), 'viz marks the open menu');
      const css = Array.from(app.document.querySelectorAll('style')).map((x) => x.textContent).join('\n');
      assert.ok(/\.wtsl-viz\[data-menu\] \.wtsl-toasts\{z-index:19\}/.test(css) && /\.wtsl-menu,\.wtsl-pop\{position:absolute;z-index:20/.test(css), 'toasts (z 19) under an open menu (z 20)');
      app.click(btn); app.flush(20);
      assert.ok(!menuEl(app) && !viz.hasAttribute('data-menu'), 'closed: toasts back on top');
      noErr(app, assert);
    }
  },
  {
    // review (ux 1, ux 2): long key rows get a full-width cell, wrap and carry their full text as a tooltip; the Rig-up button
    // keeps its text at md (hidden only at sm, where the More menu carries Rig-up)
    name: 'WTSTBR key rows: CK-101 In service / Bean and T-201 Line-up / T-201A / T-201B are full width with a title; Rig-up text not hidden at md',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app); app.flush(400);
      const css = Array.from(app.document.querySelectorAll('style')).map((x) => x.textContent).join('\n');
      assert.ok(/\.wtsl-kv>div\.f\{grid-column:1\/-1\}/.test(css) && /\.wtsl-kv \.v\.f,\.wtsl-kv div\.f \.d\{white-space:normal/.test(css), 'full-width wrapping rows in the CSS');
      const rows = (id) => { ctlOf(app)._debug.openCard(id); app.flush(400); return Array.from(app.el('wtsl_card').querySelectorAll('.wtsl-kv > div')); };
      const check = (id, labels) => {
        const R = rows(id);
        labels.forEach((l) => {
          const r = R.find((x) => text(x.querySelector('.l')) === l);
          assert.ok(r, id + ': row ' + l);
          assert.ok(r.classList.contains('f'), id + ' ' + l + ': full-width row');
          const v = r.querySelector('.v');
          assert.ok(v.classList.contains('f'), id + ' ' + l + ': wrapping value');
          assert.strictEqual(v.getAttribute('title'), text(v), id + ' ' + l + ': title = the full text');
        });
      };
      check('choke', ['In service', 'Bean']);
      check('surge', ['Line-up', 'T-201A', 'T-201B']);
      const b = rigBtn(app), sp = b.querySelector('span');
      assert.ok(sp && text(sp) === 'Rig-up' && !sp.classList.contains('wtsl-txt-md'), 'Rig-up text not hidden at md');
      assert.ok(b.classList.contains('wtsl-hide-sm'), 'the button is hidden at sm (More carries Rig-up)');
      noErr(app, assert);
    }
  },
  {
    // final pass: T-202 enters the rig-up empty with XV-202 shut and the dumps still to T-201 — a toast says how to use it and its
    // button opens the T-202 card; the Rig-up menu row carries the route; the HUD tank cell uses 'T2' (full text in its title)
    name: 'WTSTBR T-202 in: guidance toast with an Open T-202 button (opens the card), route in the menu row, HUD "T2" with the full title',
    wp: WP, integration: true,
    run(app, assert) {
      const live = openWts(app); app.flush(400);
      const tSu = () => app.el('wtsl_hud').querySelector('[data-h="tSu"]');
      assert.ok(!/T2/.test(text(tSu())) && !/T-202/.test(text(tSu())), 'T-202 out: tank cell unchanged: ' + text(tSu()));
      openRigMenu(app);
      assert.ok(!/route/.test(text(menuRow(app, 'surge2'))), 'T-202 out: no route in its row');
      app.click(menuRow(app, 'surge2')); app.flush(50);
      assert.strictEqual(live.getState().rigup.surge2, true, 'T-202 in');
      const tst = app.el('wtsl_toast');
      // release 4.1: the two-compartment T-202 (A fills first, B on LCV-202); one compartment keeps the v3.4.1 text
      const g2 = live.getState().surge2.compartments === 2 ? 'T-202 in (standby, XV-202A/B shut — A fills first, B on LCV-202): set Route to T-202 or Both on its card'
        : 'T-202 in (standby, XV-202 shut): set Route to T-202 or Both on its card';
      assert.ok(text(tst).indexOf(g2) >= 0, 'guidance toast: ' + text(tst));
      assert.ok(/route T-201/.test(text(menuRow(app, 'surge2'))), 'menu row has the route: ' + text(menuRow(app, 'surge2')));
      app.flush(800);
      assert.ok(/ · T2 \d+%/.test(text(tSu())), 'HUD short form: ' + text(tSu()));
      assert.ok(/T-202 \d+%/.test(tSu().getAttribute('title') || ''), 'HUD title has the full text: ' + tSu().getAttribute('title'));
      const ob = Array.from(tst.querySelectorAll('button')).find((b) => text(b) === 'Open T-202');
      assert.ok(ob, 'Open T-202 button in the toast');
      app.click(ob); app.flush(300);
      const card = app.el('wtsl_card');
      assert.ok(card && !card.hidden && text(card.querySelector('.tt b')) === 'T-202', 'T-202 card opened: ' + text(card && card.querySelector('.tt b')));
      assert.ok(!Array.from(tst.querySelectorAll('button')).some((b) => text(b) === 'Open T-202'), 'that toast closed');
      // a later rig-up change (not T-202 entering) keeps the plain rig-up toast
      app.click(cardSw(app, 'heater')); app.flush(50);
      const last = tst.lastElementChild;
      assert.ok(last && !/standby/.test(text(last)), 'other change: plain toast ' + text(last));
      noErr(app, assert);
    }
  },
  {
    // final pass: the HUD Gas / Oil / Water figures are the separator meters (smoothed): a bean or leg change says so, and the Gas
    // cell has a title; the CK-101 card hints the 3D leg tap in 3D mode only
    name: 'WTSTBR bean / leg change toasts say the metered rates settle; HUD gas title; CK-101 "tap a leg" hint only in 3D',
    wp: WP, integration: true,
    async run(app, assert) {
      fake3d(app);                                            // the live view mounts 3D in the harness
      app.click(app.find('.nav-btn[data-p="wts"]')); await app.flushAsync(500);
      const leg = app.el('wts_ckLeg') || hostInput(app, 'wts_ckLeg', 'adj');
      if (leg.tagName === 'SELECT' && !leg.querySelector('option')) ['adj', 'fixed'].forEach((v) => { const o = app.document.createElement('option'); o.value = v; o.textContent = v; leg.appendChild(o); });
      leg.value = 'adj';
      hostInput(app, 'wts_beanFix', 24); hostInput(app, 'wts_bean', 32);
      const D = ctlOf(app)._debug;
      assert.strictEqual(D.loop().mode, '3d', '3D mounted (fake)');
      const gasCell = app.el('wtsl_hud').querySelector('[data-h="rG"]').closest('.wtsl-hi');
      assert.strictEqual(gasCell.getAttribute('title'), 'separator gas meter (smoothed); the choke rate is on the CK-101 card', 'HUD gas title');
      D.openCard('choke'); app.flush(300);
      const card = app.el('wtsl_card'), tst = app.el('wtsl_toast');
      const lastT = () => text(tst.lastElementChild);
      app.click(card.querySelector('[data-act="bean"][data-v="4"]')); app.flush(50);
      assert.strictEqual(lastT(), 'CK-101 adjustable bean 36/64″ — metered rates settle over a few minutes', 'bean toast');
      app.click(card.querySelector('[data-act="beanFix"][data-v="2"]')); app.flush(50);
      assert.strictEqual(lastT(), 'CK-101 positive bean 26/64″ — metered rates settle over a few minutes', 'beanFix toast');
      D.onAction(app.toWin({ type: 'ckleg', eq: 'choke', leg: 'fixed' })); app.flush(50);
      assert.strictEqual(lastT(), 'CK-101 in service: Positive (fixed) choke — metered rates settle over a few minutes', 'leg toast');
      app.flush(400);
      const hint = () => app.el('wtsl_card').querySelector('[data-k="ckleg-hint"]');
      assert.ok(hint() && text(hint()) === 'or tap a leg in the 3D view', '3D: hint under In service');
      app.click(app.el('wtsl_tb').querySelector('[data-act="mode2d"]')); await app.flushAsync(800);
      assert.strictEqual(D.loop().mode, '2d', '2D now');
      D.openCard('choke'); app.flush(400);
      assert.ok(!hint(), '2D: no hint');
      noErr(app, assert);
    }
  }
];
