// WP0 — harness sanity tests. These double as usage examples for other WPs.
'use strict';

module.exports = [
  {
    name: 'app loads; host rendered its landing page into #pgBody',
    wp: 'WP0',
    run(app, assert) {
      assert.ok(app.el('pgBody'), '#pgBody exists');
      assert.ok(app.el('pgBody').children.length > 0, 'landing page rendered');
      assert.fn(app.hook.renderPRiSM, 'host hook exposes renderPRiSM');
      assert.equal(typeof app.win.PRiSM_MODELS, 'object');
    },
  },
  {
    name: 'default sample seeds 55 points (t, p, q)',
    wp: 'WP0',
    run(app, assert) {
      const ds = app.seedSample();
      assert.ok(ds && ds.t && ds.p, 'PRiSM_dataset populated');
      assert.equal(ds.t.length, 55);
      assert.equal(ds.p.length, 55);
      assert.near(ds.t[0], 0.01, 1e-12);
      assert.near(ds.t[54], 120, 1e-9);
      assert.near(ds.p[0], 3861.4, 1e-9);
      assert.ok(ds.q && ds.q.every((q) => q === 850), 'q = 850 STB/d throughout');
    },
  },
  {
    name: 'renderPRiSM + PRiSM_renderTab(1..7) render without throwing',
    wp: 'WP0',
    run(app, assert) {
      app.openPRiSM();                      // host nav('prism') → renderPRiSM(#pgBody)
      assert.ok(app.el('prism_tab_1'), 'tab hosts exist');
      assert.ok(app.win.PRiSM_dataset && app.win.PRiSM_dataset.t.length === 55, 'sample seeded on first open');
      for (let n = 1; n <= 7; n++) {
        const host = app.renderTab(n);      // throws if a handler / renderer threw
        assert.ok(host, 'prism_tab_' + n + ' exists');
        assert.ok(host.innerHTML.trim().length > 0, 'tab ' + n + ' has content');
      }
      // Direct renderPRiSM call into a detached host also works.
      const host = app.document.createElement('div');
      app.renderPRiSM(host);
      assert.ok(host.innerHTML.indexOf('prism_tabs') !== -1);
      app.flush(2000);
    },
  },
  {
    name: 'tab buttons are clickable and setTab toggles visibility',
    wp: 'WP0',
    run(app, assert) {
      app.openPRiSM();
      const btn = app.find('#prism_tabs [data-prism-tab="3"]');
      assert.ok(btn, 'tab button 3 found by selector');
      app.click(btn);
      assert.equal(app.el('prism_tab_3').style.display, 'block');
      assert.equal(app.el('prism_tab_1').style.display, 'none');
      assert.ok(app.el('prism_tab_3').innerHTML.length > 0);
    },
  },
  {
    name: 'Plots tab draws on a canvas (recording 2D context)',
    wp: 'WP0',
    run(app, assert) {
      app.openPRiSM();
      app.gotoTab(2);
      app.flush(1000);
      const drawn = app.canvases('prism_tab_2').filter((c) => app.canvasLog(c).length > 0);
      assert.ok(drawn.length > 0, 'at least one canvas in tab 2 received draw calls');
      const texts = drawn.reduce((a, c) => a.concat(app.canvasTexts(c)), []);
      assert.ok(texts.length > 0, 'axis labels / text drawn');
    },
  },
  {
    name: 'localStorage round-trips between two sessions',
    wp: 'WP0',
    run(app, assert, ctx) {
      app.openPRiSM();                      // persists the seeded textarea under wts_prism
      app.flush(1000);
      app.win.localStorage.setItem('wp0_probe', JSON.stringify({ a: 1 }));
      const saved = app.storage.getItem('wts_prism');
      assert.ok(saved && saved.indexOf('3861.4') !== -1, 'session A persisted the data textarea');

      const b = ctx.loadApp({ storage: app.storage });   // "reload"
      assert.deepEqual(JSON.parse(b.win.localStorage.getItem('wp0_probe')), { a: 1 });
      b.openPRiSM();
      assert.equal(b.el('prism_data_paste').value.trim().split(/\r?\n/).length, 56, 'textarea restored (header + 55 rows)');
      // (Auto-promoting the restored textarea to PRiSM_dataset is C8 / WP8 — not asserted here.)
      // Keys are enumerable like a real Storage.
      assert.ok(Object.keys(b.win.localStorage).indexOf('wp0_probe') !== -1);
    },
  },
  {
    name: 'manual timers: nothing runs until flush; Date follows the virtual clock',
    wp: 'WP0',
    run(app, assert) {
      const w = app.win;
      let fired = 0;
      const t0 = w.Date.now();
      w.setTimeout(() => { fired++; }, 300);
      app.flush(299);
      assert.equal(fired, 0);
      app.flush(1);
      assert.equal(fired, 1);
      assert.equal(w.Date.now() - t0, 300);
      assert.equal(new w.Date().getTime(), w.Date.now());
    },
  },
  {
    name: 'events: window CustomEvent reaches listeners registered by app code',
    wp: 'WP0',
    run(app, assert) {
      app.evalInApp("window.__wp0 = 0; window.addEventListener('prism:wp0-probe', function (e) { window.__wp0 = e.detail.n; });");
      app.fire('window', 'prism:wp0-probe', { n: 42 });
      assert.equal(app.win.__wp0, 42);
    },
  },
];
