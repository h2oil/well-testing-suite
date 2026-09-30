// P3 multi-well projects + P5(a) read-only snapshots — prism-build/29-multiwell.js
// (window.WTS_wells, window.WTS_snapshot), the `wells` project-file module and the
// host route 'wells' / header switcher (#wts_well_host).
//
// Expected numbers come from published conversion constants, not from the app:
//   1 ft³ = 0.028316846592 m³ (exact) → 1 MSCF = 28.316846592 m³
//   1 bbl = 0.158987294928 m³ (exact), 1 psi = 6.894757293 kPa
//   1 ft = 0.3048 m (exact), 1 US gal = 3.785411784 L, 1 lb = 0.45359237 kg
//     → 1 lb/gal = 0.45359237 / 3.785411784 = 0.1198264 kg/L
// and from proportionality: at fixed composition, efficiency and duration the
// flare CO₂e (40 CFR 98 Subpart W combustion + slip) is linear in gas volume.
'use strict';

const WP = 'P3MW';

const go = (app, key) => { app.hook.nav(key); app.flush(60); };
const W = (app) => app.win.WTS_wells;
const rec = (app, key) => JSON.parse(app.storage.getItem(key) || 'null');
const fe = (app) => app.el('fe_qg').value;

function flareInput(app, v) {
  go(app, 'flareghg');
  app.input('fe_qg', v);
  app.flush(1200);                         // autosave debounce + report snapshot
}
function quotaStorage(limitRef) {
  const data = new Map();
  const used = () => { let n = 0; for (const [k, v] of data) n += k.length + v.length; return n; };
  return {
    getItem: (k) => (data.has(String(k)) ? data.get(String(k)) : null),
    setItem(k, v) {
      k = String(k); v = String(v);
      const prev = data.has(k) ? k.length + data.get(k).length : 0;
      if (used() - prev + k.length + v.length > limitRef.limit) {
        const e = new Error('quota'); e.name = 'QuotaExceededError'; e.code = 22; throw e;
      }
      data.set(k, v);
    },
    removeItem: (k) => { data.delete(String(k)); },
    clear: () => data.clear(),
    key: (i) => Array.from(data.keys())[i] ?? null,
    get length() { return data.size; },
    used,
  };
}

module.exports = [
  {
    name: 'single well by default: nothing written, name follows Client & Well Info, switcher mounted',
    wp: WP,
    run(app, assert) {
      app.flush(20);
      const l = W(app).list();
      assert.strictEqual(l.length, 1);
      assert.strictEqual(l[0].name, 'Well 1');
      assert.strictEqual(app.storage.getItem('wts_wells'), null, 'no well list until a second well exists');
      app.storage.setItem('h2oil_client_info', JSON.stringify({ well: 'Alpha-1' }));
      assert.strictEqual(W(app).list()[0].name, 'Alpha-1');
      const sel = app.el('wts_well_select');
      assert.ok(sel, 'header switcher mounted in #wts_well_host');
      assert.ok(app.find('.nav-btn[data-p="wells"]'), 'sidebar entry for the comparison page');
    },
  },
  {
    name: 'switching wells keeps page inputs, legacy lists, Client & Well Info and results isolated',
    wp: WP,
    run(app, assert) {
      app.storage.setItem('h2oil_client_info', JSON.stringify({ client: 'Acme', field: 'North', well: 'A-1', engineer: 'J. Doe', notes: 'A notes' }));
      go(app, 'aga3');
      app.input(app.find('#pgBody input[id]'), '1.234');
      app.flush(800);
      assert.ok(app.storage.getItem('wts_aga3') || app.storage.getItem('wts_page_aga3'), 'aga3 inputs saved');
      flareInput(app, '7.5');
      const coA = app.win.WTS_state.flareghg.co2e_t;
      const r = W(app).create('B-2');
      app.flush(60);
      assert.ok(r.ok, 'created');
      assert.strictEqual(W(app).active(), r.id);
      // New well: defaults on the page, no inputs of A anywhere in the active keys.
      assert.strictEqual(fe(app), '5', 'new well shows the page default');
      assert.strictEqual(app.storage.getItem('wts_page_aga3'), null);
      assert.strictEqual(app.storage.getItem('wts_aga3'), null);
      assert.ok(!app.win.WTS_state.flareghg || app.win.WTS_state.flareghg.co2e_t !== coA, 'A results not in B');
      const ciB = rec(app, 'h2oil_client_info');
      assert.strictEqual(ciB.well, 'B-2');
      assert.strictEqual(ciB.client, 'Acme', 'client / field / preparer inherited');
      assert.strictEqual(ciB.engineer, 'J. Doe');
      assert.ok(!('notes' in ciB), 'well notes not inherited');
      // A is parked in one blob.
      const blobA = rec(app, 'wts_well_w1');
      assert.strictEqual(JSON.parse(blobA.keys.wts_page_flareghg).f.fe_qg, '7.5');
      assert.strictEqual(JSON.parse(blobA.keys.h2oil_client_info).well, 'A-1');
      flareInput(app, '3.2');
      const coB = app.win.WTS_state.flareghg.co2e_t;
      assert.ok(W(app).switchTo('w1').ok);
      app.flush(60);
      assert.strictEqual(W(app).active(), 'w1');
      assert.strictEqual(fe(app), '7.5', 'A inputs back on the page');
      assert.strictEqual(rec(app, 'h2oil_client_info').well, 'A-1');
      assert.strictEqual(rec(app, 'h2oil_client_info').notes, 'A notes');
      assert.ok(app.storage.getItem('wts_page_aga3') || app.storage.getItem('wts_aga3'), 'A legacy / page lists back');
      assert.strictEqual(app.storage.getItem('wts_well_w1'), null, 'active well is never parked');
      assert.strictEqual(JSON.parse(rec(app, 'wts_well_w2').keys.wts_page_flareghg).f.fe_qg, '3.2');
      // CO2e ∝ flared volume at identical composition / efficiency / hours.
      assert.ok(Math.abs(coA / coB - 7.5 / 3.2) < 1e-9, 'CO2e ratio ' + (coA / coB));
      assert.ok(Math.abs(app.win.WTS_state.flareghg.co2e_t - coA) < 1e-9, 'A results recomputed from A inputs');
      assert.strictEqual(app.pendingTimers() < 50, true);
    },
  },
  {
    name: 'PRiSM well inputs and last fit belong to their well',
    wp: WP,
    run(app, assert) {
      const w = app.win;
      w.PRiSM_setWell({ h: 55 }, { source: 'user' });
      w.PRiSM_setLastFit({ modelKey: 'homogeneous', phys: { k: 12.5, S: 3.1, C: 0.01 }, r2: 0.99 });
      assert.strictEqual(w.PRiSM_getWell().h, 55);
      W(app).create('B');
      app.flush(400);
      assert.strictEqual(w.PRiSM_getLastFit(), null, 'no fit in the new well');
      assert.notStrictEqual(w.PRiSM_getWell().h, 55, 'well inputs back to defaults');
      assert.strictEqual(w.PRiSM_pvt.provenance && w.PRiSM_pvt.provenance.h, undefined);
      const t = W(app).table();
      const k = t.rows.findIndex((r) => r.key === 'k'), s = t.rows.findIndex((r) => r.key === 'S');
      assert.strictEqual(t.cells[k][0], '12.5 md', 'parked well A fit from its blob');
      assert.strictEqual(t.cells[s][0], '3.1');
      assert.strictEqual(t.cells[k][1], '—');
      W(app).switchTo('w1');
      app.flush(400);
      const f = w.PRiSM_getLastFit();
      assert.ok(f && f.phys.k === 12.5 && f.phys.S === 3.1, 'fit restored');
      assert.strictEqual(w.PRiSM_getWell().h, 55);
      assert.strictEqual(JSON.parse(app.storage.getItem('wts_prism_state')).lastFit.phys.k, 12.5);
    },
  },
  {
    name: 'project file round trip keeps every well; reload keeps them too',
    wp: WP,
    run(app, assert) {
      app.storage.setItem('h2oil_client_info', JSON.stringify({ well: 'A-1' }));
      flareInput(app, '7.5');
      W(app).create('B-2'); app.flush(60);
      flareInput(app, '3.2');
      W(app).create('C-3'); app.flush(60);
      flareInput(app, '9.9');
      W(app).switchTo('w2'); app.flush(60);
      const payload = JSON.parse(JSON.stringify(app.win.WTS_project._buildPayload()));
      const mw = payload.modules.wells;
      assert.ok(mw, 'wells module saved');
      assert.deepStrictEqual(Array.from(mw.wells).map((x) => x.name), ['A-1', 'B-2', 'C-3']);
      assert.strictEqual(mw.active, 'w2');
      assert.strictEqual(mw.wells[1].data, null, 'active well travels in the other modules');
      assert.strictEqual(JSON.parse(mw.wells[0].data.keys.wts_page_flareghg).f.fe_qg, '7.5');
      const sk = Object.keys(payload.modules.storage.keys);
      assert.ok(!sk.some((k) => /^wts_wells?(_|$)/.test(k)), 'no well blobs in the storage module');
      assert.strictEqual(JSON.parse(payload.modules.storage.keys.wts_page_flareghg).f.fe_qg, '3.2');
      // New → one empty well; Open → all three back.
      app.win.WTS_project['new']();
      app.flush(60);
      assert.strictEqual(W(app).list().length, 1);
      assert.strictEqual(app.storage.getItem('wts_well_w1'), null);
      const res = app.win.WTS_project.loadFromObject(payload);
      app.flush(60);
      assert.ok(res.loaded.indexOf('wells') !== -1);
      assert.deepStrictEqual(Array.from(W(app).list()).map((x) => x.name + (x.active ? '*' : '')), ['A-1', 'B-2*', 'C-3']);
      go(app, 'flareghg');
      assert.strictEqual(fe(app), '3.2');
      W(app).switchTo('w3'); app.flush(60);
      assert.strictEqual(fe(app), '9.9');
      // Reload (new session, same storage).
      const app2 = app.reload();
      app2.flush(60);
      assert.deepStrictEqual(Array.from(app2.win.WTS_wells.list()).map((x) => x.name + (x.active ? '*' : '')), ['A-1', 'B-2', 'C-3*']);
      app2.win.WTS_wells.switchTo('w1'); app2.flush(60);
      app2.hook.nav('flareghg'); app2.flush(60);
      assert.strictEqual(app2.el('fe_qg').value, '7.5');
      app2.dispose && app2.dispose();
    },
  },
  {
    name: 'an old single-well project opens as one well (replacing the current well list)',
    wp: WP,
    run(app, assert) {
      flareInput(app, '7.5');
      W(app).create('B'); app.flush(60);
      assert.strictEqual(W(app).list().length, 2);
      const old = {
        format: 'h2oilproj', version: '1.0', generator: 'H2Oil Well Testing Suite', savedAt: '2026-04-28T12:00:00.000Z',
        modules: { storage: { keys: {
          wts_page_flareghg: JSON.stringify({ v: 1, t: 1, f: { fe_qg: '4.4' }, tabs: [] }),
          h2oil_client_info: JSON.stringify({ client: 'Old Co', well: 'Old-7' }),
        }, skipped: [] } },
      };
      const res = app.win.WTS_project.loadFromObject(old);
      app.flush(60);
      assert.ok(!res.error);
      const l = W(app).list();
      assert.strictEqual(l.length, 1);
      assert.strictEqual(l[0].name, 'Old-7');
      assert.strictEqual(app.storage.getItem('wts_wells'), null);
      assert.ok(!Object.keys(app.storage.__snapshot()).some((k) => k.indexOf('wts_well_') === 0), 'old well blobs removed');
      go(app, 'flareghg');
      assert.strictEqual(fe(app), '4.4');
      // Partial files (no storage module) leave the well list alone.
      W(app).create('Second'); app.flush(60);
      app.win.WTS_project.loadFromObject({ format: 'h2oilproj', modules: { esdhi: { pass: true } } });
      assert.strictEqual(W(app).list().length, 2);
    },
  },
  {
    name: 'comparison table: key results per well, unit system, comparison page and reload cache',
    wp: WP,
    run(app, assert) {
      const S = app.win.WTS_state = app.win.WTS_state || {};
      S.gasdeliv = { ok: true, aofCn: 1000, aofLit: 990, n: 0.8 };
      S.oilipr = { ok: true, J: 2.5, qmax: 3000 };
      S.oilgas = { ok: true, oil_stbd: 1500, gas_mscfd: 2400, gor: 1600 };
      S.h2sroe = { x100_ft: 250.4, x500_ft: 114.4 };
      S.wellkill = { kwf: 10.25 };
      S.flareghg = { co2e_t: 12.345 };
      app.storage.setItem('h2oil_client_info', JSON.stringify({ well: 'A-1' }));
      W(app).create('B-2'); app.flush(60);
      app.win.WTS_state.sepqc = { ok: true, qOilST: 800, qGasCorr: 950, gorSTCorr: 1187.5 };
      app.win.WTS_state.gasdeliv = { ok: false, aofCn: null };
      const t = W(app).table();
      const cell = (key, i) => t.cells[t.rows.findIndex((r) => r.key === key)][i];
      assert.deepStrictEqual(Array.from(t.wells).map((w) => w.name), ['A-1', 'B-2']);
      assert.strictEqual(cell('aof', 0), '1,000 MSCFD');
      assert.strictEqual(cell('aof', 1), '—', 'failed calculation shows no value');
      assert.strictEqual(cell('J', 0), '2.5 STB/d/psi');
      assert.strictEqual(cell('qmax', 0), '3,000 STB/d');
      assert.strictEqual(cell('oil', 0), '1,500 STB/d');
      assert.strictEqual(cell('gas', 1), '950 MSCFD', 'B rates from Separator QC');
      assert.strictEqual(cell('gor', 0), '1,600 SCF/STB');
      assert.strictEqual(cell('co2e', 0), '12.35 t');
      assert.strictEqual(cell('roe100', 0), '250 ft');
      assert.strictEqual(cell('kwf', 0), '10.25 ppg');
      assert.deepStrictEqual(Array.from(t.rateSource), ['Oil & Gas Rate', 'Separator QC']);
      // Metric: independent conversion constants.
      app.win.WTS_units.setSystem('metric');
      const m = W(app).table();
      const mc = (key, i) => m.cells[m.rows.findIndex((r) => r.key === key)][i];
      const f0 = (v) => Math.round(v).toLocaleString('en-US');
      assert.strictEqual(mc('aof', 0), f0(1000 * 28.316846592) + ' m³/d');                     // 28,317
      assert.strictEqual(mc('roe100', 0), f0(250.4 * 0.3048) + ' m');                          // 76
      assert.strictEqual(mc('kwf', 0), (10.25 * 0.45359237 / 3.785411784).toFixed(2) + ' kg/L'); // 1.23
      assert.strictEqual(mc('J', 0), (2.5 * 0.158987294928 / 6.894757293).toFixed(3) + ' m³/d/kPa'); // 0.058
      app.win.WTS_units.setSystem('imperial');
      // Comparison page.
      go(app, 'wells');
      assert.strictEqual(app.el('pgTitle').textContent, 'Well Comparison');
      const row = app.find('#mw_table tr[data-row="aof"]');
      assert.ok(row && /1,000 MSCFD/.test(row.textContent), 'page shows A AOF');
      assert.ok(app.find('[data-mw-open="w1"]'), 'open button for the parked well');
      app.click(app.find('[data-mw-open="w1"]'));
      app.flush(60);
      assert.strictEqual(W(app).active(), 'w1');
      // Results cache survives a reload (results written on autosave).
      app.fire('document', 'wts:autosaved', { page: 'oilgas', at: 1 });
      const app2 = app.reload();
      app2.flush(60);
      const t2 = app2.win.WTS_wells.table();
      assert.strictEqual(t2.cells[t2.rows.findIndex((r) => r.key === 'aof')][0], '1,000 MSCFD', 'active well value from the cache after reload');
      assert.strictEqual(t2.cells[t2.rows.findIndex((r) => r.key === 'gas')][1], '950 MSCFD');
      app2.dispose && app2.dispose();
    },
  },
  {
    name: 'copy one page\'s inputs from another well',
    wp: WP,
    run(app, assert) {
      go(app, 'aga3');
      app.input(app.find('#pgBody input[id]'), '1.234');
      app.flush(800);
      flareInput(app, '7.5');
      W(app).create('B'); app.flush(60);
      go(app, 'flareghg');
      assert.strictEqual(fe(app), '5');
      const r = W(app).copyPage('w1', 'flareghg');
      app.flush(60);
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepStrictEqual(Array.from(r.copied), ['wts_page_flareghg']);
      assert.strictEqual(fe(app), '7.5');
      assert.strictEqual(app.storage.getItem('wts_page_aga3'), null, 'other pages untouched');
      assert.strictEqual(JSON.parse(rec(app, 'wts_well_w1').keys.wts_page_flareghg).f.fe_qg, '7.5', 'source well unchanged');
      assert.ok(!W(app).copyPage('w2', 'flareghg').ok, 'cannot copy from the active well');
      assert.ok(!W(app).copyPage('w1', 'home').ok);
      // Client & Well Info: everything but the well name.
      app.storage.setItem('h2oil_client_info', JSON.stringify({ well: 'B' }));
      const blob = rec(app, 'wts_well_w1');
      blob.keys.h2oil_client_info = JSON.stringify({ well: 'A', client: 'Acme', rig: 'R-9' });
      app.storage.setItem('wts_well_w1', JSON.stringify(blob));
      assert.ok(W(app).copyPage('w1', 'clientinfo').ok);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(rec(app, 'h2oil_client_info'))), { well: 'B', client: 'Acme', rig: 'R-9' });
    },
  },
  {
    name: 'duplicate, rename and delete wells',
    wp: WP,
    run(app, assert) {
      app.storage.setItem('h2oil_client_info', JSON.stringify({ well: 'A' }));
      flareInput(app, '7.5');
      const d = W(app).create('A copy', { duplicate: true });
      app.flush(60);
      assert.ok(d.ok);
      assert.strictEqual(fe(app), '7.5', 'duplicate keeps the inputs');
      assert.strictEqual(rec(app, 'h2oil_client_info').well, 'A copy');
      assert.strictEqual(JSON.parse(rec(app, 'wts_well_w1').keys.h2oil_client_info).well, 'A');
      assert.strictEqual(W(app).create('A copy').name, 'A copy (2)', 'names stay unique');
      app.flush(60);
      const rn = W(app).rename('w2', 'A-2');
      assert.ok(rn.ok);
      assert.strictEqual(JSON.parse(rec(app, 'wts_well_w2').keys.h2oil_client_info).well, 'A-2', 'parked Client & Well Info follows the rename');
      W(app).switchTo('w2'); app.flush(60);
      assert.ok(!W(app).rename('w2', '   ').ok);
      const del = W(app).remove('w2');
      app.flush(60);
      assert.ok(del.ok);
      assert.deepStrictEqual(Array.from(W(app).list()).map((x) => x.name), ['A', 'A copy (2)']);
      assert.strictEqual(W(app).active(), 'w1', 'deleting the active well opens its neighbour');
      assert.strictEqual(fe(app), '7.5');
      W(app).remove('w3');
      assert.strictEqual(W(app).remove('w1').error, 'last well');
    },
  },
  {
    name: 'read-only snapshot: results inside, no scripts or handlers, download and iOS share sheet',
    wp: WP,
    run(app, assert) {
      app.storage.setItem('h2oil_client_info', JSON.stringify({ client: 'Acme', well: 'A-1' }));
      flareInput(app, '7.5');
      const co = app.win.WTS_state.flareghg.co2e_t;
      const job = app.win.WTS_snapshot.build('job');
      assert.ok(job && /\.html$/.test(job.filename));
      const noScript = (h) => !/<script/i.test(h) && !/<[^>]+\son[a-z]+\s*=/i.test(h) && !/javascript:/i.test(h);
      assert.ok(noScript(job.html), 'job snapshot has no script');
      assert.ok(/Content-Security-Policy/.test(job.html) && /default-src 'none'/.test(job.html));
      assert.ok(/Flare Emissions/.test(job.html), 'job report content');
      assert.ok(/Read-only snapshot/.test(job.html));
      go(app, 'flareghg');
      const pg = app.win.WTS_snapshot.build('page');
      assert.ok(pg && noScript(pg.html));
      assert.ok(pg.html.indexOf(co.toLocaleString('en-US', { maximumFractionDigits: 1 }).split('.')[0]) !== -1, 'page result value in snapshot');
      W(app).create('B-2'); app.flush(60);
      flareInput(app, '3.2');
      const wl = app.win.WTS_snapshot.build('wells');
      assert.ok(noScript(wl.html));
      assert.ok(wl.html.indexOf('A-1') !== -1 && wl.html.indexOf('B-2') !== -1);
      assert.ok(wl.html.indexOf(co.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' t') !== -1, 'A CO2e in the comparison snapshot');
      // Sanitizer on hostile markup.
      const bad = app.win.WTS_snapshot.sanitize('<div onmouseover="x()"><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">l</a>' +
        '<iframe src="https://e.x"></iframe><form><input value="1"></form><script src="a.js"></script><svg onload="x"></svg></div>');
      assert.ok(noScript(bad) && !/iframe|<form|<input/i.test(bad), bad);
      // Delivery: download, then the iOS share sheet.
      return app.win.WTS_snapshot.share('wells').then((r) => {
        assert.ok(r.ok && r.method === 'download');
        const dl = app.downloads[app.downloads.length - 1];
        assert.strictEqual(dl.filename, r.filename);
        assert.ok(dl.content && noScript(dl.content) && dl.content.indexOf('B-2') !== -1);
        const calls = [];
        app.win.iosSaveFile = (name, text, b64) => { calls.push([name, text, b64]); return Promise.resolve(true); };
        const n = app.downloads.length;
        return app.win.WTS_snapshot.share('job').then((r2) => {
          assert.strictEqual(r2.method, 'share');
          assert.strictEqual(calls.length, 1);
          assert.strictEqual(calls[0][2], false);
          assert.ok(/\.html$/.test(calls[0][0]) && noScript(calls[0][1]));
          assert.strictEqual(app.downloads.length, n, 'no download on iOS');
        });
      });
    },
  },
  {
    name: 'header switcher at 375 px: select switches wells, menu opens and closes, compare navigates',
    wp: WP,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      app.flush(20);
      flareInput(app, '7.5');
      W(app).create('B'); app.flush(60);
      const sel = app.el('wts_well_select');
      assert.strictEqual(sel.querySelectorAll('option').length, 2);
      assert.strictEqual(sel.value, 'w2');
      app.change(sel, 'w1'); app.flush(60);
      assert.strictEqual(W(app).active(), 'w1');
      assert.strictEqual(fe(app), '7.5');
      const menu = app.el('wts_well_menu');
      assert.ok(menu.hasAttribute('hidden'));
      app.click('wts_well_menu_btn');
      assert.ok(!menu.hasAttribute('hidden'));
      assert.strictEqual(app.el('wts_well_menu_btn').getAttribute('aria-expanded'), 'true');
      assert.strictEqual(app.el('wts_well_copy_from').querySelectorAll('option').length, 1);
      const css = app.el('wts-mw-css').textContent;
      assert.ok(/max-width:600px/.test(css) && /calc\(100vw - 32px\)/.test(css) && /min\(160px,40vw\)/.test(css), 'phone-width rules');
      app.click(app.find('[data-mw="compare"]')); app.flush(60);
      assert.strictEqual(app.el('pgTitle').textContent, 'Well Comparison');
      assert.ok(menu.hasAttribute('hidden'));
    },
  },
  {
    name: 'storage full: a new well is refused and nothing is lost',
    wp: WP,
    opts: false,
    run(_app, assert, ctx) {
      const lim = { limit: 1e9 };
      const st = quotaStorage(lim);
      const app = ctx.loadApp({ storage: st });
      try {
        app.flush(20);
        flareInput(app, '7.5');
        lim.limit = st.used() + 200;                     // the parked blob cannot fit
        const before = JSON.stringify(Object.fromEntries(Array.from({ length: st.length }, (_, i) => [st.key(i), st.getItem(st.key(i))])));
        const r = app.win.WTS_wells.create('B');
        app.flush(60);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.error, 'quota');
        assert.strictEqual(app.win.WTS_wells.list().length, 1);
        assert.strictEqual(app.el('fe_qg').value, '7.5');
        assert.strictEqual(JSON.parse(st.getItem('wts_page_flareghg')).f.fe_qg, '7.5');
        assert.strictEqual(st.getItem('wts_wells'), null);
        const after = JSON.parse(JSON.stringify(Object.fromEntries(Array.from({ length: st.length }, (_, i) => [st.key(i), st.getItem(st.key(i))]))));
        Object.keys(JSON.parse(before)).filter((k) => k !== 'wts_report_snapshots').forEach((k) => {
          assert.ok(k in after, 'kept ' + k);
        });
      } finally { app.dispose && app.dispose(); }
    },
  },
  {
    name: 'well menu is placed on screen from the switcher (v3.0.1: was right-aligned to the ⋯ button and ran under the sidebar / off screen)',
    wp: WP,
    opts: { viewport: { width: 1280, height: 800 } },
    run(app, assert) {
      app.flush(20);
      const css = app.el('wts-mw-css').textContent;
      assert.ok(/\.wts-mw-menu\{position:fixed/.test(css), 'menu is viewport-positioned (escapes overflow clipping)');
      assert.ok(!/\.wts-mw-menu\{position:absolute;right:0/.test(css), 'no longer right-aligned to the button');
      const anchor = app.find('.wts-mw'), menu = app.el('wts_well_menu');
      const place = (l, t, w, h) => { anchor.getBoundingClientRect = () => ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h }); };
      const px = (v) => parseFloat(String(v || '').replace('px', ''));
      // Desktop: switcher at the left of the page header (just right of a 250 px sidebar)
      place(290, 90, 180, 28);
      app.click('wts_well_menu_btn');
      assert.ok(!menu.hasAttribute('hidden'));
      assert.strictEqual(px(menu.style.left), 290, 'left-aligned to the switcher, not extended leftwards under the sidebar');
      assert.strictEqual(px(menu.style.top), 122, '4 px below the switcher');
      assert.strictEqual(px(menu.style.width), 280);
      app.click('wts_well_menu_btn');
      assert.ok(menu.hasAttribute('hidden'));
      // Switcher near the right edge: clamped inside the viewport (1280 − 280 − 8)
      place(1150, 90, 120, 28);
      app.click('wts_well_menu_btn');
      assert.strictEqual(px(menu.style.left), 992, 'clamped to the right edge');
      app.click('wts_well_menu_btn');
      // Phone: full width with 16 px gutters
      app.resize(375, 812);
      place(10, 150, 200, 28);
      app.click('wts_well_menu_btn');
      assert.strictEqual(px(menu.style.left), 16);
      assert.strictEqual(px(menu.style.width), 375 - 32);
      assert.ok(px(menu.style.top) >= 0, 'never above the top of the screen');
      assert.deepEqual(app.consoleErrors(), []);
    },
  },
];
