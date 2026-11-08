// Accounts WP-H — storage-to-HTML sink audit (docs/ACCOUNTS-PLAN.md §8.7, H18, §12.2 acct-fuzz).
//
// A synced project is applied on other devices with no Open by the user, so a stored string that reached innerHTML
// unescaped would run everywhere after every pull. These tests load hostile projects and open every route, then look for
// any element or attribute the payload could have created (the harness DOM parses innerHTML but runs no handlers, so
// "nothing runs" is checked as "no element, event-handler attribute or javascript: URL came from the payload").
//
//   FZ1  a real project (page records on every route, client info, wells, PRiSM, report snapshots and templates) whose
//        every string field is replaced by the payload, opened with loadFromObject → every route, the home page, the wells
//        page, the Quick Report, the template picker and a page PDF export are clean
//   FZ2  hand-shaped records where the shape matters (template ids / types, well registry, client logo javascript: URL,
//        snapshot titles, PRiSM notes, build-up state strings) → every route and the reports are clean
//   FZ3  the same hostile content arriving in a second app (its own storage) through the cloud paths: loadFromObject
//        {source:'cloud'} and the key-level apply (applyChanges {source:'cloud'}, the Phase 2 fast-forward path)
//   FZ4  shape checks: modules of the wrong type (string, number, array, null, nested junk) are refused or ignored —
//        no throw, project keys untouched by a refused storage module, the app keeps rendering
//
// Sink audit (§8.7, 2026-11-08). Storage-fed innerHTML / insertAdjacentHTML / report-window sinks reviewed and covered
// by FZ1–FZ3: page autosave values (restored into control .value, echoed by calculators through _uFmt / textContent),
// Client & Well Info (cover, header, Quick Report; logo through _safeImgSrc), report snapshots and templates (picker,
// editor, job report: _rEsc / __calcEsc), well names (29-multiwell _cleanName strips <>, switcher / wells page / compare
// table escape), PRiSM notes, saved fits, gauge register, sequence of events (36 / 39 / 51 esc), build-up state and
// review (49-calc-buildup* esc), Modbus devices / tags (62 opt/esc), historian messages (47 esc), release notes and help
// (fixed strings only). Fixes from the audit (H18): 29-project-save refuses a loaded module whose value is null (New's
// clear value; a hostile file could wipe a module) and a storage module whose keys are an array.
'use strict';

const WP = 'WP-H';
const P = '"\'><img src=x onerror=__xss(1) id=xssprobe>';
const JS_URL = 'javascript:__xss(2)';

// every element / attribute the payload could have produced
function injected(app) {
  const bad = [];
  for (const el of app.findAll('*')) {
    if (el.id && /^xssprobe/.test(el.id)) bad.push('#' + el.id + ' in ' + where(el));
    for (const n of el.getAttributeNames()) {
      const v = String(el.getAttribute(n) == null ? '' : el.getAttribute(n));
      if (/^on/i.test(n) && /__xss/.test(v)) bad.push(el.localName + '[' + n + '] in ' + where(el));
      if (/^(href|src|action|formaction|xlink:href|data)$/i.test(n) && /^\s*javascript:/i.test(v)) bad.push(el.localName + '[' + n + '=' + v + '] in ' + where(el));
    }
  }
  return bad;
}
function where(el) {
  const ids = [];
  for (let n = el; n && ids.length < 3; n = n.parentNode) if (n.id) ids.push('#' + n.id);
  return ids.join(' < ') || el.localName;
}
// markup strings handed to report windows / downloads
function injectedHtml(s) {
  const bad = [];
  s = String(s || '');
  if (/<img[^>]*\bonerror\s*=\s*__xss/i.test(s)) bad.push('raw <img onerror>');
  if (/id=xssprobe/i.test(s) && /<img src=x/i.test(s)) bad.push('raw probe element');
  if (/\b(src|href)\s*=\s*["']?\s*javascript:/i.test(s)) bad.push('javascript: URL');
  return bad;
}
function routes(app) {
  const r = new Set(app.findAll('.nav-btn[data-p]').map((b) => b.getAttribute('data-p')));
  ['home', 'clientinfo', 'wells', 'privacy', 'releasenotes', 'help'].forEach((x) => r.add(x));
  return Array.from(r);
}
// visit every route (and a few report surfaces); collect findings per route
function sweep(app, label, seen) {
  const found = [];
  seen = seen || { text: 0, routes: [] };
  const note = (where, list) => list.forEach((x) => found.push(label + ' / ' + where + ': ' + x));
  for (const r of routes(app)) {
    try { app.hook.nav(r); } catch (e) { found.push(label + ' / ' + r + ': nav threw ' + (e && e.message)); continue; }
    app.flush(120);
    note(r, injected(app));
    const body = app.el('pgBody');
    if (body && /onerror=__xss/.test(body.textContent || '') || app.findAll('#pgBody input, #pgBody textarea').some((e) => /onerror=__xss/.test(String(e.value || '')))) { seen.text++; seen.routes.push(r); }
    if (r === 'prism') {
      for (let n = 1; n <= 7; n++) { try { app.renderTab(n); app.flush(50); } catch (e) { /* tab render not under test */ } note('prism tab ' + n, injected(app)); }
      // the field tools and the fit workspace render into their own hosts
      for (const fn of ['PRiSM_renderGaugeRegister', 'PRiSM_renderEventsLog', 'PRiSM_renderCtBuilder']) {
        if (typeof app.win[fn] !== 'function') continue;
        const h = app.document.createElement('div'); app.el('pgBody').appendChild(h);
        try { app.win[fn](h); app.flush(20); } catch (e) { /* not under test */ }
        note('prism ' + fn, injected(app));
      }
      try { if (typeof app.win.PRiSM_openTools === 'function') { app.win.PRiSM_openTools(); app.flush(50); note('prism tools', injected(app)); } } catch (e) { /* tools */ }
    }
  }
  // reports: Quick Report, a page PDF, the template picker
  const n0 = app.opened.length;
  try { app.win.WTS_exportJobReport(); } catch (e) { /* nothing captured */ }
  try { app.hook.nav('clientinfo'); app.win.exportPagePDF(); } catch (e) { /* export */ }
  app.flush(500);
  app.opened.slice(n0).forEach((o) => note('report window', injectedHtml(o.html())));
  seen.reports = app.opened.length - n0;
  seen.reportText = app.opened.slice(n0).some((o) => /&lt;img src=x onerror=__xss/.test(o.html()));
  (app.downloads || []).forEach((d) => note('download ' + (d.name || ''), injectedHtml(d.text || d.data || '')));
  try { app.win.WTS_reportTemplates.openPicker(); app.flush(50); note('template picker', injected(app)); app.win.WTS_reportTemplates.closePicker(); } catch (e) { /* picker */ }
  found.seen = seen;
  return Array.from(new Set(found));
}
// the payload must have reached the pages (as text or as control values) for a clean sweep to mean anything
function reached(assert, seen, min, label) {
  assert.ok(seen.text >= min, label + ': the payload reached ' + seen.text + ' routes (' + seen.routes.slice(0, 12).join(', ') + '), expected ≥ ' + min);
  assert.ok(seen.reports >= 1, label + ': a report window was produced (' + seen.reports + ')');
  assert.ok(seen.reportText, label + ': the payload reached a report window as escaped text');
}
// replace every string leaf (JSON inside storage values too)
function poison(v, depth) {
  depth = depth || 0;
  if (typeof v === 'string') {
    if (depth > 0 || v.length === 0) return P;
    return P;
  }
  if (Array.isArray(v)) return v.map((x) => poison(x, depth + 1));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = poison(v[k], depth + 1); return o; }
  return v;
}
function poisonStorageValue(raw) {
  try { const j = JSON.parse(raw); if (j && typeof j === 'object') return JSON.stringify(poison(j, 1)); } catch (e) { /* not JSON */ }
  return P;
}
// a realistic project: every route rendered once with its text controls filled, PRiSM with data, two wells
function buildProject(app) {
  const W = app.win;
  for (const r of routes(app)) {
    if (r === 'wts') continue;
    try { app.hook.nav(r); } catch (e) { continue; }
    const ctrls = app.findAll('#pgBody input[id], #pgBody textarea[id]')
      .filter((e) => !/^(checkbox|radio|file|range|color|button|submit|hidden)$/i.test(e.type || ''));
    ctrls.slice(0, 40).forEach((e) => { try { app.input(e, e.type === 'number' ? '3' : 'text'); } catch (x) { /* odd page */ } });
    app.flush(320);
  }
  app.openPRiSM(); app.seedSample(); app.flush(500);
  // PRiSM records with user text: a saved fit, a gauge in the register, a sequence-of-events entry
  try { W.PRiSM_setLastFit(app.toWin({ modelKey: 'homogeneous', source: 'regression', params: { Cd: 80, S: 2.5 }, phys: { k: 45, kh: 1600 } })); } catch (e) { /* optional */ }
  try { W.PRiSM_saveFit('Fit A'); } catch (e) { /* optional */ }
  try { W.PRiSM_setGauge(app.toWin({ id: 'g1', serial: 'S-1', type: 'quartz', depth: 9000 })); } catch (e) { /* optional */ }
  try { W.PRiSM_addEvent(app.toWin({ type: 'note', t: 1, note: 'event note', text: 'event note' })); } catch (e) { /* optional */ }
  try { W.PRiSM_saveState(); } catch (e) { /* optional */ }
  W.WTS_lsSet('wts_prism_report_notes', 'notes');
  W.WTS_lsSet('h2oil_client_info', JSON.stringify({ client: 'Operator Energy Ltd', well: 'W-1', field: 'F', operator: 'O', engineer: 'E', company: 'C', eng_email: 'name@company.example', clientLogo: 'data:image/png;base64,iVBORw0KGgo=' }));
  W.WTS_reportTemplates.save(app.toWin({ id: 'u1', name: 'T', title: 'T', sections: [{ type: 'notes', heading: 'H', text: 'x' }, { type: 'client' }, { type: 'allPages' }] }));
  W.WTS_wells.create('Second'); app.flush(200);
  W.WTS_wells.switchTo(W.WTS_wells.list()[0].id); app.flush(200);
  return JSON.parse(JSON.stringify(W.WTS_project._buildPayload()));
}
function hostile(pay) {
  const out = JSON.parse(JSON.stringify(pay));
  const mods = out.modules || {};
  for (const k of Object.keys(mods)) {
    if (k === 'storage') {
      const keys = mods.storage.keys || {};
      for (const kk of Object.keys(keys)) keys[kk] = poisonStorageValue(keys[kk]);
    } else if (k === 'wells') {
      const w = mods.wells;
      (w.wells || w.list || []).forEach((x) => { if (x && typeof x === 'object') x.name = P; });
      const blobs = w.blobs || {};
      for (const id of Object.keys(blobs)) {
        const b = blobs[id];
        if (b && b.keys) for (const kk of Object.keys(b.keys)) b.keys[kk] = poisonStorageValue(b.keys[kk]);
      }
    } else if (k === 'prism_dataset' || k === 'prism_gauges' || k === 'buildup_raw') {
      // numeric records: poison only their names / labels
      out.modules[k] = poison(mods[k], 1);
    } else {
      out.modules[k] = poison(mods[k], 1);
    }
  }
  out.meta = poison(out.meta || {}, 1);
  return out;
}
// shaped seeds where a blind string swap would be refused by the readers
function shapedSeed(W) {
  W.WTS_lsSet('h2oil_client_info', JSON.stringify({ client: P, well: P, field: P, operator: P, engineer: P, position: P, company: P, eng_email: P,
    rig: P, location: P, test_type: P, date: P, notes: P, clientLogo: JS_URL }));
  W.WTS_lsSet('wts_report_templates', JSON.stringify({ v: 1, defaultId: 'u1', templates: [{ id: 'u1', name: P, title: P,
    sections: [{ type: 'notes', heading: P, text: P }, { type: 'client', heading: P }, { type: 'summary', heading: P }, { type: 'allPages', heading: P }] }] }));
  W.WTS_lsSet('wts_report_snapshots', JSON.stringify({ choke: { title: P, subtitle: P, inputs: [{ title: P, rows: [[P, P]] }],
    results: [{ title: P, rows: [[P, P]], kpis: [[P, P]], tables: [{ title: P, head: [P], rows: [[P]] }], verdict: { cls: P, text: P } }], at: '2026-11-08T00:00:00Z' } }));
  W.WTS_lsSet('wts_prism_report_notes', P);
  W.WTS_lsSet('wts_wells', JSON.stringify({ v: 1, active: 'w1', wells: [{ id: 'w1', name: P, created: P, modified: P }, { id: 'w2', name: P, created: P, modified: P }] }));
  W.WTS_lsSet('wts_well_w2', JSON.stringify({ v: 1, savedAt: P, keys: { h2oil_client_info: JSON.stringify({ well: P, client: P }) }, modules: {} }));
  W.WTS_lsSet('wts_mw_results', JSON.stringify({ v: 1, r: { flareghg: { co2e_t: P } } }));
  W.WTS_lsSet('wts_buildup_state', JSON.stringify({ v: 1, appVersion: P, savedAt: P, input: { name: P, wellName: P }, analysis: null, review: null, qa: [], uiSel: {}, signoff: null }));
  W.WTS_lsSet('wts_prism_state', JSON.stringify({ v: 1, model: P, mode: P, notes: P, savedAt: 1 }));
  W.WTS_lsSet('wts_modbus_config', JSON.stringify({ v: 1, devices: [{ id: 'd1', name: P, host: P, port: 502, unit: 1 }], tags: [{ name: P, device: 'd1', address: 1, type: 'holding', unit: P, desc: P }] }));
}

module.exports = [
  {
    name: 'FZ1 a hostile copy of a real project (every string field replaced) opened with loadFromObject: every route and report is clean', wp: WP,
    integration: true, opts: false, timeoutMs: 240000,
    run(_a, assert, ctx) {
      const src = ctx.loadApp({});
      let pay;
      try { pay = buildProject(src); } finally { src.dispose(); }
      const app = ctx.loadApp({});
      try {
        app.win.__xss = function () { throw new Error('payload ran'); };
        const r = app.win.WTS_project.loadFromObject(app.toWin(hostile(pay)));
        assert.ok(r && !r.error, 'loaded: ' + (r && r.error));
        app.flush(500);
        const seen = { text: 0, routes: [] };
        assert.deepStrictEqual(sweep(app, 'open', seen), []);
        reached(assert, seen, 20, 'open');
      } finally { app.dispose(); }
    },
  },
  {
    name: 'FZ2 hand-shaped hostile records (templates, wells, client logo javascript: URL, snapshots, notes, build-up, Modbus) are escaped everywhere', wp: WP,
    integration: true, opts: false, timeoutMs: 240000,
    run(_a, assert, ctx) {
      const app = ctx.loadApp({});
      try {
        app.win.__xss = function () { throw new Error('payload ran'); };
        shapedSeed(app.win);
        app.win.WTS_rerender({ discardPending: true });
        const seen = { text: 0, routes: [] };
        assert.deepStrictEqual(sweep(app, 'seed', seen), []);
        reached(assert, seen, 2, 'seed');
      } finally { app.dispose(); }
    },
  },
  {
    name: 'FZ3 the hostile content reaching a second device through the cloud paths (loadFromObject source cloud, applyChanges) is clean', wp: WP,
    integration: true, opts: false, timeoutMs: 240000,
    run(_a, assert, ctx) {
      const one = ctx.loadApp({});
      let pay;
      try { shapedSeed(one.win); pay = hostile(JSON.parse(JSON.stringify(one.win.WTS_project._buildPayload()))); } finally { one.dispose(); }
      // device B: Open from cloud (the load path with source 'cloud')
      const b = ctx.loadApp({});
      try {
        const r = b.win.WTS_project.loadFromObject(b.toWin(pay), b.toWin({ source: 'cloud' }));
        assert.ok(r && !r.error);
        const seen = { text: 0, routes: [] };
        assert.deepStrictEqual(sweep(b, 'cloud open', seen), []);
        reached(assert, seen, 2, 'cloud open');
      } finally { b.dispose(); }
      // device C: the key-level apply (fast-forward of changed keys and the PRiSM modules)
      // TODO(WP-C2, Phase 2): plan §8.7 asks for the hostile project to be fast-forwarded from tests/_acct-fake-server.js
      // into this second app through 67's real sync; while 67's sync is a stub, applyChanges is driven directly here.
      // Replace this block with that fast-forward when WP-C2 lands.
      const c = ctx.loadApp({});
      try {
        const keys = pay.modules.storage.keys;
        const res = c.win.WTS_project.applyChanges(c.toWin({ set: keys, modules: { pvt: pay.modules.pvt, prism: pay.modules.prism } }), c.toWin({ source: 'cloud' }));
        assert.ok(res.applied.length > 5, res.applied.length + ' applied');
        const seen = { text: 0, routes: [] };
        assert.deepStrictEqual(sweep(c, 'fast-forward', seen), []);
        reached(assert, seen, 2, 'fast-forward');
      } finally { c.dispose(); }
    },
  },
  {
    name: 'FZ4 shape checks: wrong module types are refused or ignored without a throw; a refused storage module changes no key', wp: WP,
    run(app, assert) {
      const W = app.win, Pj = W.WTS_project;
      // the detector itself: an unescaped sink is caught
      app.hook.nav('choke');
      app.el('pgBody').insertAdjacentHTML('beforeend', '<div id="fz_ctl">' + P + '<a href="' + JS_URL + '">x</a></div>');
      const ctl = injected(app);
      assert.ok(ctl.some((x) => /#xssprobe/.test(x)) && ctl.some((x) => /onerror/.test(x)) && ctl.some((x) => /javascript:/.test(x)), 'detector: ' + ctl.join('; '));
      assert.ok(injectedHtml('<p>' + P + '</p>').length > 0 && injectedHtml('<p>&lt;img src=x onerror=__xss(1)&gt;</p>').length === 0, 'html detector');
      app.el('fz_ctl').remove();
      W.WTS_lsSet('wts_page_choke', '{"v":1,"f":{"keep":"1"}}');
      const junk = ['x', 42, [1, 2], null, true, { keys: 'x' }, { keys: [1] }, { wells: 'x' }, { __proto__: { polluted: 1 } }];
      for (const j of junk) {
        const mods = {};
        for (const m of Pj.listModules()) mods[m] = j;
        let r;
        assert.doesNotThrow(() => { r = Pj.loadFromObject(app.toWin({ format: 'h2oilproj', version: '1.0', modules: mods })); }, 'junk ' + JSON.stringify(j));
        assert.ok(r && r.error === null, 'structured result');
        assert.strictEqual(JSON.parse(app.storage.getItem('wts_page_choke') || '{"f":{}}').f.keep, '1', 'storage kept for junk ' + JSON.stringify(j));
        assert.strictEqual(({}).polluted, undefined, 'no prototype pollution');
      }
      for (const bad of [null, 'x', 5, [], { format: 'other' }]) {
        const r = Pj.loadFromObject(app.toWin(bad));
        assert.ok(r && (r.error || (r.loaded && r.loaded.length === 0)), 'refused: ' + JSON.stringify(bad));
      }
      // applyChanges (the Phase 2 fast-forward path): a null / non-object PRiSM module is refused like in _applyPayload
      const pvtBefore = JSON.stringify(W.PRiSM_pvt || null);
      for (const j of [null, 'x', 42, [1, 2], true]) {
        let r;
        assert.doesNotThrow(() => { r = Pj.applyChanges(app.toWin({ modules: { prism: j, prism_dataset: j, pvt: j } })); }, 'applyChanges junk ' + JSON.stringify(j));
        assert.deepStrictEqual(Array.from(r.applied), [], 'nothing applied for ' + JSON.stringify(j));
        assert.deepStrictEqual(Array.from(r.skipped).sort(), ['prism', 'prism_dataset', 'pvt'], 'all three skipped for ' + JSON.stringify(j));
        assert.strictEqual(JSON.stringify(W.PRiSM_pvt || null), pvtBefore, 'PRiSM inputs not wiped by ' + JSON.stringify(j));
      }
      // the app still renders every core page after the junk
      for (const r of ['home', 'choke', 'clientinfo', 'wells', 'prism']) assert.doesNotThrow(() => app.hook.nav(r), r);
      assert.deepStrictEqual(injected(app), []);
    },
  },
];
