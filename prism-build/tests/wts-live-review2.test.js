// Well Test Simulator live HMI (38-wts-live.js) — release 3.4.2 review, round 2 (lane live). Covers the round-1 fixes that had
// no test and the round-2 fixes:
//   • pure: xferDest (booster), surgeDestTxt / inputsDiff receiver [23], capWhy [32], almShow relabel of the Sep→Flare run [34];
//   • HUD: a cell is never narrower than its value (minmax(min-content, …) groups, label not widening a cell), the GOR split on a
//     line of its own under the rates group (no flex-shrink:0 GOR cell squeezing the rates), the T-202 tank cell / pSu label [12];
//   • Rates pop-up: GOR1 (separator) / GOR2 (tank) / Total GOR; tanks pop-up with T-202 standing in;
//   • cards: P-201 booster texts and the LINE-UP notes [13]; T-201 out with T-202 in: no transfer ΔP / tank gas / GOR2 / LP back P
//     on the T-201 card, on the T-202 card instead [12] / [17]; T-202 auto route / stroke / route buttons disabled with the reason,
//     refusal toasts [15] / [19]; H-101 bypass button disabled while H-101 is out [37];
//   • Rig-up: FS-401 toast text under the chain [14], FS-401 tooltip [20], T-201 row with V-101 out to the flare [21];
//   • ESD banner / trip toast name SEPBY_SURGE_CAP, drawer design warnings include the V-101-out block warnings [32];
//   • live 2D with T-202 standing in: no T-201 'AUTO' tag, the T-301 line labelled from LCV-202, T-202 inside filled [12].
'use strict';

const WP = 'WTSLR2';
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
const I = (app) => app.win.WTS_live._internals;
const D = (app) => I(app).ctl()._debug;
// o: {rig, routing, dest, recv, routes, booster, lp, alarms, esd, auto1}
function patch(st, o) {
  const ru = st.rigup;
  Object.assign(ru, o.rig || {});
  ru.routing = o.routing || 'chain';
  if (o.dest) ru.dest = o.dest;
  ru.routes = Object.assign({}, o.routes || {});
  if (o.dest) st.sepBy = Object.assign({}, st.sepBy || {}, { dest: o.dest, recv: o.recv || (o.dest === 'surge' ? 'T-201' : ''), P_psig: 150, vent: !!o.vent });
  if (o.booster) st.gauge.pump = Object.assign({}, st.gauge.pump || {}, { mode: 'booster', suction: 'transfer', on: true });
  if (o.lp) {
    st.lp = { on: true, to: 'lp', tag: 'FT-201', lineTag: 'LP flare line', nps: 3, sch: '40', ID_in: 3.068, L_ft: 150, q_mscfd: 42.5, meter_mscfd: 41.9,
      meterType: 'usm', unc_txt: '±3 % of reading', turndown_txt: '≈ 1000:1', lowCut_fts: 0.1, belowCut: false, P_in_psig: 0.6, P0_psig: 0.2, dP_psi: 0.15,
      vel_fts: 9.4, ve_fts: 350, vPct: 2.7, mach: 0.01, vSt: 'OK', sources: { t201: 40.1, t202: 0, psv: 0 }, psvIn: false, note: 'T-301 vent, not metered' };
    Object.assign(st.rates, { gor1_scf_stb: 9500, gor2_scf_stb: 42, gorTot_scf_stb: 9542, gor_scf_stb: 9542, lpGas_mscfd: 41.9 });
  }
  if (o.lpOff && st.lp) st.lp = Object.assign({}, st.lp, { on: false, to: 'hp' });
  if (o.auto1 && st.surge) st.surge.auto = Object.assign({}, st.surge.auto || {}, { on: true });
  if (o.alarms) st.alarms = (st.alarms || []).concat(o.alarms);
  if (o.esd) st.esd = Object.assign({}, st.esd || {}, o.esd);
  if (o.l2) st.lines = Object.assign({}, st.lines || {}, { surge2_gauge: Object.assign({ q: 0, unit: 'BPD', frac: 0, vel: 0, ID_in: 3.068, phase: 'liquid', active: false }, o.l2) });
  return st;
}
function installStub(app, o) {
  const L = I(app), real = L.sim(), opts = Object.assign({}, o || {}), calls = [];
  let key = null, cache = null;
  const stub = Object.create(real);
  stub.__v = 0;
  stub.getState = function () {
    const st = real.getState(), k = st.t + '|' + st.alarmVersion + '|' + stub.__v;
    if (k !== key) { key = k; cache = app.toWin(patch(J(st), opts)); }
    return cache;
  };
  stub.getRigup = function () { return app.toWin(Object.assign(J(real.getRigup()), opts.rig || {})); };
  stub.setSurgeRoute = function (m) { calls.push(['route', m]); return app.toWin(opts.routeRes || { ok: true, msg: 'Separator dumps → ' + m }); };
  stub.setAutoDivert = function (eq, on) { calls.push(['auto', eq, on]); return true; };
  stub.setValveOptions = function () { calls.push(['vopt'].concat([].slice.call(arguments))); return true; };
  L.useSim(stub);
  return { stub, opts, calls, set: (p) => { Object.keys(opts).forEach((k) => delete opts[k]); Object.assign(opts, p); stub.__v++; D(app).draw2d(); }, restore: () => L.useSim(real) };
}
function openCard(app, id) { D(app).openCard(id); app.flush(300); return app.el('wtsl_card'); }
const rows = (card) => Array.from(card.querySelectorAll('.wtsl-kv > div')).filter((d) => !d.hidden);
const rowLabels = (card) => rows(card).map((d) => text(d.querySelector('.l')));
const row = (card, l) => rows(card).find((d) => text(d.querySelector('.l')) === l);
const rowVal = (card, l) => { const r = row(card, l); return r ? text(r.querySelector('.v')) : null; };
const rowSub = (card, l) => { const r = row(card, l), d = r && r.querySelector('.d'); return d ? text(d) : null; };
const rigRow = (app, k) => app.el('wtsl_rigup').querySelector('[data-k="' + k + '"]');
const rigTxt = (app, k) => text(rigRow(app, k) && rigRow(app, k).querySelector('.rv'));
const rigSw = (app, k) => app.el('wtsl_rigup').querySelector('[data-rig="' + k + '"]');
function rerender(app) { D(app).closeCard(); app.flush(1500); }
const toasts = (app) => app.findAll('.wtsl-toast').map(text);
function lastOps(app, cv) {
  const log = app.canvasLog(cv);
  let i = log.length - 1;
  while (i >= 0 && !(log[i].op === 'clearRect' && log[i].args[0] === 0 && log[i].args[1] === 0)) i--;
  return log.slice(Math.max(0, i));
}
const textAt = (fr, s) => fr.filter((e) => e.op === 'fillText' && String(e.args[0]) === s).map((e) => [e.args[1], e.args[2]]);
const noErr = (app, assert) => assert.strictEqual(app.consoleErrors().length, 0, 'no console errors: ' + app.consoleErrors().map((l) => l.text || l).join(' | '));
const css = (app) => Array.from(app.document.querySelectorAll('style')).map((x) => x.textContent).join('\n');
function pop(app, g) {
  const b = app.document.createElement('div'); b.setAttribute('data-act', 'tile'); b.setAttribute('data-v', g);
  app.el('wts_viz').appendChild(b); app.click(b); b.remove(); app.flush(300);
  return app.find('.wtsl-pop');
}
const popRows = (p) => Array.from(p ? p.querySelectorAll('.r') : []).map((r) => [text(r.children[0]), text(r.children[1])]);

module.exports = [
  {
    name: 'WTSLR2 pure: xferDest (booster), surgeDestTxt + inputsDiff receiver [23], capWhy [32], almShow Sep→Flare relabel [34]',
    wp: WP,
    run(app, assert) {
      const L = I(app), W = (o) => app.toWin(o);
      assert.strictEqual(L.xferDest(W({ gauge: { pump: { mode: 'booster' } } })), 'P-201 booster → export');
      assert.strictEqual(L.xferDest(W({ gauge: { pump: { mode: 'transfer' } } })), 'T-301');
      assert.strictEqual(L.xferDest(null), 'T-301');
      assert.strictEqual(L.surgeDestTxt(null), 'the surge tank');
      assert.strictEqual(L.surgeDestTxt(W({ surge: true, surge2: false })), 'the surge tank T-201');
      assert.strictEqual(L.surgeDestTxt(W({ surge: false, surge2: true })), 'the surge tank T-202 (T-201 out)');
      assert.strictEqual(L.surgeDestTxt(W({ surge: false, surge2: false })), 'the surge tank (none in the rig-up: burner / flare line)');
      // capWhy: the active static SEPBY_SURGE_CAP warning (MMscf/d), named by its valve tag; nothing when absent or returned to normal
      const cap = { id: 'SEPBY_SURGE_CAP', tag: 'PCV-203', state: 'UNACK', value: 10, limit: 2.5 };
      assert.strictEqual(L.capWhy(W({ alarms: [cap] })), 'why: well gas 10.0 MMSCFD is over the PCV-203 capacity 2.50 MMSCFD with V-101 out to the surge tank');
      assert.strictEqual(L.capWhy(W({ alarms: [Object.assign({}, cap, { state: 'RTN' })] })), '');
      assert.strictEqual(L.capWhy(W({ alarms: [] })), ''); assert.strictEqual(L.capWhy(null), '');
      // [34] the reused seg-5 run: 'Sep→Flare' shown under the route it carries while V-101 is bypassed
      const a = W({ id: 'VEL_SEG4', tag: 'FI-Sep→Flare', msg: 'Sep→Flare velocity 80 ft/s', sev: 'warn' });
      const toT202 = W({ rigup: { separator: false, dest: 'surge' }, sepBy: { dest: 'surge', recv: 'T-202' } });
      const s = L.almShow(a, toT202);
      assert.strictEqual(s.tag, 'FI-V-101 bypass→T-202'); assert.strictEqual(s.msg, 'V-101 bypass→T-202 velocity 80 ft/s');
      assert.strictEqual(a.tag, 'FI-Sep→Flare', 'the alarm object itself is not changed');
      assert.strictEqual(L.almShow(a, W({ rigup: { separator: false, dest: 'line' }, sepBy: { dest: 'line' } })).tag, 'FI-V-101 bypass→line');
      assert.strictEqual(L.almShow(a, W({ rigup: {} })), a, 'V-101 in: unchanged');
      assert.strictEqual(L.almShow(a, W({ rigup: { separator: false, dest: 'flare' }, sepBy: { dest: 'flare' } })), a, 'to the flare: the run is Sep→Flare');
    }
  },
  {
    name: 'WTSLR2 HUD: groups never narrower than their values, the GOR split on its own line under the rates group, T-202 tank cell with T-201 out',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const c = css(app);
      // review round 2: the GOR cell no longer refuses to shrink (it cut Gas / Oil / BS&W at 1366 – 1600 px)
      assert.ok(!/\.wtsl-hi\.h-gor\{flex-shrink:0\}/.test(c), 'no flex-shrink:0 GOR cell');
      assert.ok(/\.wtsl-hgrid\{display:grid;grid-template-columns:minmax\(150px,176px\) minmax\(min-content,1\.2fr\) minmax\(min-content,1\.55fr\) minmax\(min-content,\.85fr\) minmax\(158px,172px\)/.test(c), 'lg grid: value groups at least min-content');
      assert.ok(/data-bp=md\] \.wtsl-hgrid\{grid-template-columns:150px minmax\(min-content,1\.35fr\) minmax\(min-content,1fr\) 158px\}/.test(c), 'md grid');
      assert.ok(/\.wtsl-hi\{display:flex;flex-direction:column;flex:1 1 auto\}/.test(c) && /\.wtsl-hi>\.wtsl-hl\{width:0;min-width:100%\}/.test(c), 'a cell is as wide as its value (labels do not widen it, min-width auto)');
      assert.ok(/\.wtsl-hsub\{[^}]*width:0;min-width:100%\}/.test(c), 'the sub-line takes the group width and does not widen it');
      const hud = app.el('wtsl_hud'), sub = hud.querySelector('[data-h="rRs"]');
      assert.ok(sub && sub.parentNode.classList.contains('wtsl-hg'), 'sub-line is a child of the rates group');
      assert.ok(!hud.querySelector('.h-gor [data-h="rRs"]'), 'not inside the GOR cell');
      assert.ok(sub.parentNode.querySelector('[data-h="rG"]') && sub.parentNode.querySelector('[data-h="rR"]'), 'the rates group');
      const t = installStub(app, { lp: true });
      try {
        app.flush(600);
        assert.ok(!sub.hidden && text(sub) === 'GOR1 sep 9,500 · GOR2 tank 42', 'sub-line: ' + text(sub));
        assert.ok(/GOR1 separator/.test(sub.getAttribute('title')), 'sub-line tooltip');
        // [12] T-201 out, T-202 in (chain): the HUD tank cell and the Surge pressure cell follow T-202
        t.set({ rig: { surge: false, surge2: true }, routes: { surge: 'T-202' }, lp: true }); app.flush(800);
        assert.strictEqual(text(hud.querySelector('[data-h="pSuL"]')), 'T-202', 'pressure cell label');
        assert.ok(/^T-202 .* · LCV-202 /.test(text(hud.querySelector('[data-h="tSu"]'))), 'tank cell: ' + text(hud.querySelector('[data-h="tSu"]')));
        assert.ok(/^T-201 out of rig-up · T-202 receives the dumps/.test(hud.querySelector('[data-h="tSu"]').getAttribute('title')), 'tank cell title');
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSLR2 pop-ups: Rates splits GOR1 (separator) / GOR2 (tank) / Total GOR with the LP line in service; tanks pop-up with T-202 standing in',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app, { lpOff: true });
      try {
        app.flush(400);
        let p = popRows(pop(app, 'rates'));
        assert.ok(p.some((r) => r[0] === 'GOR') && !p.some((r) => /GOR1/.test(r[0])), 'no LP line: one GOR row');
        pop(app, 'rates');                                   // closes it
        t.set({ lp: true }); app.flush(400);
        p = popRows(pop(app, 'rates'));
        const lab = p.map((r) => r[0]);
        assert.deepStrictEqual(lab.slice(3, 6), ['GOR1 (separator)', 'GOR2 (tank)', 'Total GOR'], 'rows: ' + lab.join(','));
        assert.ok(lab.indexOf('GOR') < 0, 'the single GOR row is replaced');
        assert.deepStrictEqual(p.slice(3, 6).map((r) => r[1]), ['9,500 scf/STB', '42 scf/STB', '9,542 scf/STB']);
        pop(app, 'rates');
        t.set({ rig: { surge: false, surge2: true }, routes: { surge: 'T-202' } }); app.flush(600);
        p = popRows(pop(app, 'tanks'));
        assert.deepStrictEqual(p[0], ['Surge tank', 'T-201 out of rig-up · dumps → T-202']);
        assert.strictEqual(p[1][0], 'T-202', 'T-202 row next: ' + JSON.stringify(p));
        assert.ok(/LCV-202 /.test(p[1][1]), 'T-202 row: ' + p[1][1]);
        pop(app, 'tanks');
        p = popRows(pop(app, 'press'));
        assert.ok(p.some((r) => r[0] === 'Surge tank' && r[1] === 'T-201 out of rig-up'), 'press: ' + JSON.stringify(p));
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSLR2 cards [12] [13] [17] [37]: P-201 booster texts and LINE-UP notes; T-201 out: no LCV-201 / LP rows on its card, LP rows on T-202; H-101 out: bypass button disabled',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app, { lp: true });
      try {
        app.flush(400);
        let card = openCard(app, 'surge');
        assert.ok(/transferring to T-301\)$/.test(rowSub(card, 'Line-up')), 'normal note: ' + rowSub(card, 'Line-up'));
        ['Transfer ΔP', 'Tank gas FT-201', 'GOR2', 'LP back P'].forEach((l) => assert.ok(rowLabels(card).indexOf(l) >= 0, 'T-201 in: row ' + l));
        assert.strictEqual(rowSub(card, 'Transfer ΔP').indexOf('LCV-201 by vessel pressure (no pump)'), 0);
        // [13] T-301 out: P-201 as the booster on the T-201 transfer to export
        t.set({ rig: { gauge: false }, booster: true, routes: { gauge: 'P-201 → export' }, lp: true }); app.flush(400);
        card = openCard(app, 'surge');
        assert.ok(/LCV-201 suction \(transferring to P-201 booster → export\)$/.test(rowSub(card, 'Line-up')), 'booster LINE-UP note: ' + rowSub(card, 'Line-up'));
        assert.strictEqual(rowSub(card, 'Transfer ΔP').indexOf('LCV-201 by vessel pressure + P-201 booster'), 0);
        card = openCard(app, 'pump');
        assert.strictEqual(rowVal(card, 'Service'), 'T-201 → P-201 → export (booster)');
        assert.ok(/→ P-201 booster$/.test(rowVal(card, 'Surge transfer')), 'surge transfer: ' + rowVal(card, 'Surge transfer'));
        assert.ok(rowLabels(card).indexOf('Draining') < 0, 'no T-301 draining row in booster mode');
        rerender(app);
        assert.strictEqual(rigTxt(app, 'gauge'), 'Out of rig-up → P-201 → export');
        // [12] / [17] T-201 out, T-202 in (chain): the T-201 card has no transfer ΔP / tank gas / GOR2 / LP back P; T-202 has them
        t.set({ rig: { surge: false, surge2: true }, routes: { surge: 'T-202' }, lp: true }); app.flush(400);
        card = openCard(app, 'surge');
        ['Transfer ΔP', 'Tank gas FT-201', 'GOR2', 'LP back P'].forEach((l) => assert.ok(rowLabels(card).indexOf(l) < 0, 'T-201 out: no row ' + l + ' (' + rowLabels(card).join(',') + ')'));
        assert.strictEqual(rowVal(card, 'Transfer'), 'OUT OF RIG-UP');
        card = openCard(app, 'surge2');
        ['Tank gas FT-201', 'GOR2', 'LP back P'].forEach((l) => assert.ok(rowLabels(card).indexOf(l) >= 0, 'T-202 card row ' + l + ' (' + rowLabels(card).join(',') + ')'));
        // [37] H-101 out: the page heater-bypass input is not the control
        t.set({ rig: { heater: false }, routes: { heater: 'V-101' } }); app.flush(400);
        card = openCard(app, 'heater');
        const bb = card.querySelector('[data-act="bypass"]');
        assert.ok(bb && bb.disabled, 'bypass button disabled');
        assert.ok(/H-101 is out of the rig-up/.test(bb.getAttribute('title') || bb.getAttribute('aria-description') || card.textContent), 'reason given');
        t.set({}); app.flush(400);
        card = openCard(app, 'heater');
        assert.ok(!card.querySelector('[data-act="bypass"]').disabled, 'H-101 in: bypass button enabled');
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSLR2 T-202 card [15] [19]: auto route / stroke / route buttons disabled with the reason; refusal toasts from the engine state',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app, { rig: { surge2: false } });
      try {
        app.flush(400);
        let card = openCard(app, 'surge2');
        const dis = (sel) => Array.from(card.querySelectorAll(sel));
        assert.ok(dis('[data-act="auto"][data-v="surge2"]').every((b) => b.disabled) && dis('[data-act="auto"][data-v="surge2"]').length, 'T-202 out: auto route disabled');
        assert.ok(dis('[data-act="stroke"][data-v^="surge2:"]').length === 2 && dis('[data-act="stroke"][data-v^="surge2:"]').every((b) => b.disabled), 'T-202 out: stroke disabled');
        assert.ok(dis('[data-act="s2route"]').every((b) => b.disabled), 'T-202 out: route buttons disabled');
        D(app).toggleAuto('surge2'); app.flush(50);
        assert.ok(toasts(app).some((x) => x === 'T-201 ↔ T-202 auto route: T-202 is not in the rig-up'), 'refusal toast: ' + toasts(app).join(' | '));
        assert.ok(!t.calls.some((c) => c[0] === 'auto'), 'no engine call');
        // [19] T-201 out, T-202 in: only the T-202 route exists
        t.set({ rig: { surge: false, surge2: true }, routes: { surge: 'T-202' } }); app.flush(400);
        card = openCard(app, 'surge2');
        const rb = (v) => card.querySelector('[data-act="s2route"][data-v="' + v + '"]');
        assert.ok(rb('surge').disabled && rb('both').disabled && !rb('surge2').disabled, 'T-201 / Both disabled, T-202 enabled');
        assert.ok(/T-201 is out of the rig-up/.test(rb('both').getAttribute('title') || ''), 'reason: ' + rb('both').getAttribute('title'));
        assert.ok(card.querySelector('[data-act="auto"][data-v="surge2"]').disabled, 'auto route disabled with T-201 out');
        D(app).toggleAuto('surge2'); app.flush(50);
        assert.ok(toasts(app).some((x) => x === 'T-201 ↔ T-202 auto route: T-201 is out of the rig-up — no tank to route to'), 'toast: ' + toasts(app).join(' | '));
        // a refused 'both' is named as the route asked for
        t.opts.routeRes = { ok: false, msg: 'Route to T-201 refused — T-201 is out of the rig-up' };
        D(app).setRoute('both'); app.flush(50);
        assert.ok(toasts(app).some((x) => x === 'route to both tanks refused — T-201 is out of the rig-up'), 'both refusal: ' + toasts(app).join(' | '));
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSLR2 Rig-up [14] [20] [21]: FS-401 toast text under the chain, FS-401 tooltip, T-201 row with V-101 out to the flare',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const t = installStub(app, { rig: { flare: false } });
      try {
        app.flush(400);
        const m = 'Rig-up: FS-401 out of the rig-up (gas to export)';
        assert.strictEqual(D(app).rigMsgTxt(m, D(app).state()), 'Rig-up — FS-401 out of the rig-up (HP gas to export, LP / relief to vent)');
        t.set({ rig: { flare: false, separator: false }, dest: 'surge' }); app.flush(200);
        assert.strictEqual(D(app).rigMsgTxt(m, D(app).state()), 'Rig-up — FS-401 out of the rig-up (tank gas and relief to the atmospheric vent)');
        t.set({ rig: { flare: false, separator: false }, dest: 'line' }); app.flush(200);
        assert.strictEqual(D(app).rigMsgTxt(m, D(app).state()), 'Rig-up — FS-401 out of the rig-up (relief of the tanks to vent)');
        t.set({ rig: { flare: false }, routing: 'v341' }); app.flush(200);
        assert.strictEqual(D(app).rigMsgTxt(m, D(app).state()), 'Rig-up — FS-401 out of the rig-up (gas to export)', 'v3.4.1 rules: the engine text');
        // [20] / [21] V-101 out to the burner / flare line
        t.set({ rig: { separator: false }, dest: 'flare', routes: { separator: 'burner / flare line', surge: 'T-301' } }); rerender(app);
        const tip = rigSw(app, 'flare').getAttribute('title');
        assert.ok(rigSw(app, 'flare').disabled && !/\(With V-101 out, well stream to\)$/.test(tip) && /"With V-101 out, well stream to"\)$/.test(tip), 'FS-401 tip: ' + tip);
        t.set({ rig: { separator: false, surge: false }, dest: 'flare', routes: { separator: 'burner / flare line', surge: 'T-301' } }); rerender(app);
        assert.strictEqual(rigTxt(app, 'surge'), 'Out of rig-up · no liquid to the tanks (V-101 out)');
        t.set({ rig: { surge: false }, routes: { surge: 'T-301' } }); rerender(app);
        assert.strictEqual(rigTxt(app, 'surge'), 'Out of rig-up → T-301', 'V-101 in: the route arrow stays');
      } finally { t.restore(); }
      noErr(app, assert);
    }
  },
  {
    name: 'WTSLR2 [32] ESD banner names SEPBY_SURGE_CAP (not on a manual close); the drawer lists the V-101-out block warnings while V-101 is out',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const cap = { id: 'SEPBY_SURGE_CAP', tag: 'PCV-201', eq: 'separator', sev: 'warn', state: 'UNACK', tOn: 1, value: 10, limit: 2.5, msg: 'Whole stream to T-201' };
      const t = installStub(app, { rig: { separator: false }, dest: 'surge', alarms: [cap], esd: { tripped: true, manual: false, causeMsg: 'PSHH-201 surge tank pressure high', canReset: false, blocking: [] } });
      try {
        app.flush(600);
        const el = app.el('wtsl_alarm') || app.find('.wtsl-alarm');
        assert.ok(el && /ESD TRIPPED/.test(text(el)), 'banner: ' + text(el));
        assert.ok(/why: well gas 10\.0 MMSCFD is over the PCV-201 capacity 2\.50 MMSCFD/.test(text(el)), 'banner names the cause: ' + text(el));
        t.set({ rig: { separator: false }, dest: 'surge', esd: { tripped: true, manual: true, causeMsg: 'ESD closed by the operator', canReset: true, blocking: [] }, alarms: [cap] }); app.flush(600);
        assert.ok(!/why:/.test(text(el)), 'manual close: no cause line');
        const flow = app.toWin({ warnings: [{ t: 'warn', m: 'Base warning' }], sepBy: { warnings: [{ t: 'error', k: 'surge', msg: 'Whole well stream into the surge tank: over capacity' }, { t: 'warn', msg: 'Base warning' }] } });
        let W = J(D(app).designWarnings(D(app).state(), flow));
        assert.deepStrictEqual(W, [{ t: 'warn', m: 'Base warning' }, { t: 'error', m: 'Whole well stream into the surge tank: over capacity' }], 'V-101 out: block warnings added once, {msg} → {m}');
        t.set({}); app.flush(300);
        W = J(D(app).designWarnings(D(app).state(), flow));
        assert.deepStrictEqual(W, [{ t: 'warn', m: 'Base warning' }], 'V-101 in: the base list only');
      } finally { t.restore(); }
    }
  },
  {
    name: 'WTSLR2 live 2D with T-202 standing in for T-201 [12]: no T-201 AUTO tag, the T-301 line labelled from LCV-202, T-202 inside filled first',
    wp: WP, integration: true,
    run(app, assert) {
      openWts(app);
      const cv = app.el('wts_cv');
      const t = installStub(app, { auto1: true });
      try {
        app.flush(600);
        const L0 = app.win.WTS_DIAG_LAYOUT;
        let fr = lastOps(app, cv);
        assert.ok(textAt(fr, 'AUTO').some((p) => Math.abs(p[0] - (L0.bx[0] + 26)) < 5 && p[1] === L0.by - 26), 'T-201 in: AUTO tag drawn ' + JSON.stringify(textAt(fr, 'AUTO')));
        t.set({ rig: { surge: false, surge2: true }, routes: { surge: 'T-202' }, auto1: true, l2: { q: 850, vel: 1.1, active: true } }); app.flush(600);
        const L1 = app.win.WTS_DIAG_LAYOUT; fr = lastOps(app, cv);
        assert.ok(!textAt(fr, 'AUTO').some((p) => Math.abs(p[0] - (L1.bx[0] + 26)) < 6), 'T-201 out: no AUTO tag at T-201: ' + JSON.stringify(textAt(fr, 'AUTO')));
        const mx = (L1.bx[0] + L1.bx[1]) / 2;
        assert.ok(fr.some((e) => e.op === 'clearRect' && e.args[0] === mx - 34 && e.args[1] === L1.by - 33), 'host velocity label cleared');
        assert.ok(fr.some((e) => e.op === 'clearRect' && e.args[0] === mx - 34 && e.args[1] === L1.by + 22), 'host ΔP label cleared');
        assert.deepStrictEqual(textAt(fr, 'LCV-202 850 BPD'), [[mx, L1.by + 30]], 'LCV-202 rate on the line: ' + JSON.stringify(fr.filter((e) => e.op === 'fillText' && /LCV-202/.test(e.args[0])).map((e) => e.args)));
        assert.deepStrictEqual(textAt(fr, '1 ft/s'), [[mx, L1.by - 14]], 'velocity from the LCV-202 line');
        const iL = fr.findIndex((e) => e.op === 'fillText' && e.args[0] === 'Liquid' && e.args[2] === L1.by - 25);
        assert.ok(iL >= 0, 'Liquid above the velocity');
        const t2 = L1.t202, fi = fr.findIndex((e) => e.op === 'fillRect' && e.args[0] === t2.x - t2.w / 2 && e.args[1] === L1.by - t2.h / 2 && e.args[2] === t2.w);
        assert.ok(fi >= 0, 'T-202 inside filled before its halves');
        t.set({ rig: { surge: false, surge2: true }, routes: { surge: 'T-202' }, l2: { q: 0, vel: 0, active: false } }); app.flush(600);
        fr = lastOps(app, cv);
        assert.deepStrictEqual(textAt(fr, 'LCV-202 0 BPD'), [[mx, L1.by + 30]], 'LCV-202 shut: 0');
        assert.ok(!fr.some((e) => e.op === 'fillText' && /NaN|undefined/.test(String(e.args[0]))), 'no NaN');
      } finally { t.restore(); }
      noErr(app, assert);
    }
  }
];
