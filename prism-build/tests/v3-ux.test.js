// v3.0 navigation UX — dashboard search / group headings / favourites / recently used, sidebar
// search + collapsible groups, stacked input tables on phones, "Copy results" and the plug-in
// page consistency sweep.
//
// Expected values come from the task statement and from the DOM itself (independent of the code
// under test): the sidebar is the source of truth for group order; a table cell's label is the
// text of the header cell above it (colspan counted by hand here); the report model of a page with
// the stacking pass disabled (host function neutralised in the HTML) is the reference for "report
// capture unchanged". The real CSS (cards below 600 px, no 375 px overflow) is checked in real
// engines by prism-build/ux-layout-check.js (last test, integration, needs Playwright).
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const WP = 'UX';
const TABLE_PAGES = ['wts', 'pipelife', 'flowline', 'lineheat', 'proving', 'sepqc', 'gasdeliv', 'oilipr'];
const OVERVIEW = ['home', 'clientinfo', 'releasenotes', 'privacy'];

const text = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
const json = (v) => JSON.parse(JSON.stringify(v));   // app-realm objects → plain
function open(app, key) {
  const b = app.find('.nav-btn[data-p="' + key + '"]');
  if (!b) throw new Error('no sidebar button for ' + key);
  app.click(b);
}
function sidebarGroups(app) {
  return app.findAll('#sidebar .nav-group').map((g) => ({
    label: text(g.querySelector('.nav-group-label')),
    ids: Array.from(g.querySelectorAll('.nav-btn[data-p]')).map((b) => b.getAttribute('data-p')),
    el: g,
  }));
}
const visibleCards = (app) => app.findAll('.dash-sec[data-group]:not(.hidden) .dash-card:not(.hidden)').map((c) => c.getAttribute('data-id'));
const chips = (app, sec) => app.findAll('#dash_quick [data-sec="' + sec + '"] .dash-mini').map((c) => c.getAttribute('data-go'));
// Header labels by column, colspan-aware (independent re-implementation for the check).
function headerLabels(t) {
  const thead = t.tHead;
  const rows = Array.from(t.rows);
  const head = thead && thead.rows.length ? thead.rows[thead.rows.length - 1] : rows[0];
  const out = [];
  Array.from(head.cells).forEach((c) => {
    const sub = c.querySelector('div');
    let s;
    if (sub) { const cl = c.cloneNode(true); cl.querySelectorAll('div').forEach((d) => d.remove()); s = text(cl) + (text(sub) ? ' (' + text(sub) + ')' : ''); }
    else s = text(c);
    for (let i = 0; i < (c.colSpan || 1); i++) out.push(s);
  });
  return { head, labels: out };
}
function neutralised(html) {
  const a = 'function __wtsStackTables(root) {';
  if (html.split(a).length !== 2) throw new Error('stacking function not found once in the host');
  return html.replace(a, a + ' return 0;');
}

module.exports = [
  // ── Dashboard ───────────────────────────────────────────────────────────
  {
    name: 'UX dashboard: one heading per sidebar group, tiles in sidebar order, every calculator exactly once',
    wp: WP,
    run(app, assert) {
      app.hook.nav('home');
      const groups = sidebarGroups(app).filter((g) => g.label.toLowerCase() !== 'overview');
      const secs = app.findAll('.dash-sec[data-group]');
      assert.deepStrictEqual(secs.map((s) => s.getAttribute('data-group')), groups.map((g) => g.label), 'section order = sidebar group order');
      secs.forEach((s, i) => {
        const ids = Array.from(s.querySelectorAll('.dash-card')).map((c) => c.getAttribute('data-id'));
        assert.deepStrictEqual(ids, groups[i].ids.filter((id) => id !== 'gaevents'), groups[i].label + ': tiles follow the sidebar buttons');
        assert.strictEqual(text(s.querySelector('.dash-group-n')), String(ids.length), 'group count badge');
        assert.ok(new RegExp('^' + groups[i].label.replace(/[&]/g, '\\$&')).test(text(s.querySelector('.dash-group-h'))), 'heading text');
      });
      const all = app.findAll('.dash-card').map((c) => c.getAttribute('data-id'));
      assert.strictEqual(new Set(all).size, all.length, 'no duplicate tiles in the grids');
      const sidebarCalcs = [].concat(...groups.map((g) => g.ids));
      assert.deepStrictEqual(all.slice().sort(), sidebarCalcs.slice().sort(), 'every sidebar calculator has a tile');
      ['esdhi', 'esdlo', 'hydrate', 'liquidline', 'pipelife'].forEach((k) => assert.ok(all.includes(k), 'Test System Safety tile ' + k));
      assert.ok(all.length >= 50, '~50 tiles: ' + all.length);
      assert.strictEqual(text(app.el('dash_count')), all.length + ' calculators');
      app.click(app.find('.dash-card[data-id="sepqc"]'));
      assert.strictEqual(app.hook.page(), 'sepqc', 'tile still navigates');
    },
  },
  {
    name: 'UX dashboard search: all words must match (title, description, group, key); Enter opens the first hit; Escape clears',
    wp: WP,
    run(app, assert) {
      app.storage.setItem('wts_ui_favs', JSON.stringify(['aga3']));
      app.hook.nav('home');
      app.input('dash_search', 'vogel');                        // only in the Oil IPR description
      assert.deepStrictEqual(visibleCards(app), ['oilipr']);
      assert.strictEqual(text(app.el('dash_count')), '1 of ' + app.findAll('.dash-card').length + ' calculators');
      assert.ok(app.el('dash_quick').classList.contains('hidden'), 'favourites / recent hidden while searching');
      app.input('dash_search', 'ELECTRICAL');                   // group label, case-insensitive
      const elec = sidebarGroups(app).find((g) => g.label === 'Electrical').ids;
      elec.forEach((id) => assert.ok(visibleCards(app).includes(id), 'electrical tile ' + id));
      app.input('dash_search', 'gas   pvt');                    // both words, any order / spacing
      assert.ok(visibleCards(app).includes('gaspvt'));
      assert.ok(!visibleCards(app).includes('pumpsz'));
      // sections without hits are hidden
      app.findAll('.dash-sec[data-group]').forEach((s) => {
        const hits = s.querySelectorAll('.dash-card:not(.hidden)').length;
        assert.strictEqual(s.classList.contains('hidden'), hits === 0, s.getAttribute('data-group'));
      });
      app.input('dash_search', 'zzqqxx');
      assert.deepStrictEqual(visibleCards(app), []);
      assert.ok(!app.el('dash_empty').classList.contains('hidden'), 'empty-state message');
      app.key('dash_search', 'Escape');
      assert.strictEqual(app.el('dash_search').value, '');
      assert.strictEqual(visibleCards(app).length, app.findAll('.dash-card').length, 'all tiles back');
      assert.ok(app.el('dash_empty').classList.contains('hidden'));
      assert.ok(!app.el('dash_quick').classList.contains('hidden'));
      app.input('dash_search', 'meter proving');
      app.key('dash_search', 'Enter');
      assert.strictEqual(app.hook.page(), 'proving', 'Enter opens the first visible tile');
    },
  },
  {
    name: 'UX favourites: star toggles without navigating, persists in wts_ui_favs across a reload, chip opens the page',
    wp: WP,
    run(app, assert) {
      app.hook.nav('home');
      assert.ok(app.find('#dash_quick .dash-hint'), 'hint when there are no favourites');
      const star = () => app.find('.dash-card[data-id="flowline"] .dc-fav');
      assert.strictEqual(star().getAttribute('aria-pressed'), 'false');
      assert.ok(/flowline/i.test(star().getAttribute('aria-label')) || /Flowline/.test(star().getAttribute('aria-label')), 'star has an accessible name');
      app.click(star());
      assert.strictEqual(app.hook.page(), 'home', 'star does not open the tile');
      assert.strictEqual(star().getAttribute('aria-pressed'), 'true');
      app.click(app.find('.dash-card[data-id="aga3"] .dc-fav'));
      assert.deepStrictEqual(JSON.parse(app.storage.getItem('wts_ui_favs')), ['flowline', 'aga3'], 'stored in pin order');
      assert.deepStrictEqual(chips(app, 'fav'), ['flowline', 'aga3']);
      // reload: same storage, new app
      const app2 = app.reload();
      try {
        app2.hook.nav('home');
        assert.deepStrictEqual(chips(app2, 'fav'), ['flowline', 'aga3'], 'favourites survive a reload');
        assert.strictEqual(app2.find('.dash-card[data-id="aga3"] .dc-fav').getAttribute('aria-pressed'), 'true');
        app2.click(app2.find('.dash-card[data-id="aga3"] .dc-fav'));        // un-star
        assert.deepStrictEqual(chips(app2, 'fav'), ['flowline']);
        assert.deepStrictEqual(JSON.parse(app2.storage.getItem('wts_ui_favs')), ['flowline']);
        app2.click(app2.find('#dash_quick .dash-mini[data-go="flowline"]'));
        assert.strictEqual(app2.hook.page(), 'flowline', 'chip opens its calculator');
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'UX favourites / recent: storage junk and unknown or unsafe ids are ignored, never injected',
    wp: WP,
    run(app, assert) {
      app.storage.setItem('wts_ui_favs', JSON.stringify(['<img src=x onerror=alert(1)>', 'nosuchcalc', 42, 'oilipr']));
      app.storage.setItem('wts_ui_recent', '{not json');
      app.hook.nav('home');
      assert.deepStrictEqual(chips(app, 'fav'), ['oilipr']);
      assert.ok(!app.find('#dash_quick img'), 'no markup from storage');
      assert.deepStrictEqual(chips(app, 'recent'), []);
    },
  },
  {
    name: 'UX recently used: most recent first, no duplicates, 8 stored / 6 shown, overview pages skipped, survives a reload',
    wp: WP,
    run(app, assert) {
      const visits = ['aga3', 'clientinfo', 'proving', 'aga3', 'privacy', 'flowline', 'pipelife', 'orifice', 'sepqc', 'gasdeliv', 'oilipr', 'hydrate'];
      visits.forEach((k) => app.hook.nav(k));
      // independent expectation: walk the visits backwards, keep first occurrences of non-overview pages
      const exp = [];
      visits.slice().reverse().forEach((k) => { if (!OVERVIEW.includes(k) && !exp.includes(k)) exp.push(k); });
      assert.deepStrictEqual(JSON.parse(app.storage.getItem('wts_ui_recent')), exp.slice(0, 8));
      app.hook.nav('home');
      assert.deepStrictEqual(chips(app, 'recent'), exp.slice(0, 6));
      const app2 = app.reload();
      try {
        app2.hook.nav('home');
        assert.deepStrictEqual(chips(app2, 'recent'), exp.slice(0, 6), 'after reload');
        app2.click(app2.find('#dash_quick [data-sec="recent"] .dash-mini[data-go="sepqc"]'));
        assert.strictEqual(app2.hook.page(), 'sepqc');
        assert.strictEqual(JSON.parse(app2.storage.getItem('wts_ui_recent'))[0], 'sepqc', 'moved to the front');
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'UX preferences are device settings: wts_ui_* never go into a project file and survive New',
    wp: WP,
    run(app, assert) {
      app.storage.setItem('wts_ui_favs', '["aga3"]');
      app.storage.setItem('wts_ui_recent', '["proving"]');
      app.storage.setItem('wts_ui_nav_collapsed', '["electrical"]');
      app.hook.nav('aga3');
      const P = app.win.WTS_project;
      const pl = json(P._buildPayload());
      const keys = Object.keys((pl.modules && pl.modules.storage && pl.modules.storage.keys) || {});
      assert.ok(keys.length > 0, 'storage module captured project keys');
      assert.ok(!keys.some((k) => /^wts_ui_/.test(k)), 'no wts_ui_* key in the file: ' + keys.join(','));
      P['new']();
      assert.strictEqual(app.storage.getItem('wts_ui_favs'), '["aga3"]', 'New keeps favourites');
      assert.strictEqual(app.storage.getItem('wts_ui_nav_collapsed'), '["electrical"]');
    },
  },

  // ── Sidebar ─────────────────────────────────────────────────────────────
  {
    name: 'UX sidebar groups collapse (click / Enter / Space), persist in wts_ui_nav_collapsed and restore after a reload',
    wp: WP,
    run(app, assert) {
      const grp = (a, label) => sidebarGroups(a).find((g) => g.label === label).el;
      const elec = grp(app, 'Electrical'), lab = elec.querySelector('.nav-group-label');
      assert.strictEqual(lab.getAttribute('role'), 'button');
      assert.strictEqual(lab.getAttribute('tabindex'), '0');
      assert.strictEqual(lab.getAttribute('aria-expanded'), 'true');
      app.click(lab);
      assert.ok(elec.classList.contains('collapsed'));
      assert.strictEqual(lab.getAttribute('aria-expanded'), 'false');
      assert.deepStrictEqual(JSON.parse(app.storage.getItem('wts_ui_nav_collapsed')), ['electrical']);
      app.key(lab, 'Enter');
      assert.ok(!elec.classList.contains('collapsed'), 'Enter expands');
      app.key(lab, ' ');
      assert.ok(elec.classList.contains('collapsed'), 'Space collapses');
      // a group created by the plug-in registry is collapsible too
      const wt = grp(app, 'Well Testing');
      app.click(wt.querySelector('.nav-group-label'));
      assert.deepStrictEqual(JSON.parse(app.storage.getItem('wts_ui_nav_collapsed')).sort(), ['electrical', 'well testing']);
      // the active page stays reachable: its button keeps .active inside the collapsed group
      app.hook.nav('proving');
      assert.ok(wt.querySelector('.nav-btn[data-p="proving"]').classList.contains('active'));
      assert.ok(/\.nav-group\.collapsed \.nav-btn:not\(\.active\)\s*\{\s*display:\s*none/.test(app.html), 'CSS hides only the inactive buttons');
      const app2 = app.reload();
      try {
        assert.ok(grp(app2, 'Electrical').classList.contains('collapsed'), 'restored after reload');
        assert.ok(grp(app2, 'Well Testing').classList.contains('collapsed'));
        assert.ok(!grp(app2, 'Separation & Vessels').classList.contains('collapsed'));
        assert.strictEqual(grp(app2, 'Electrical').querySelector('.nav-group-label').getAttribute('aria-expanded'), 'false');
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'UX sidebar search: filters buttons (label, group, plug-in subtitle), hides empty groups, Enter opens, Escape clears',
    wp: WP,
    run(app, assert) {
      const vis = () => app.findAll('#sidebar .nav-btn[data-p]:not(.sb-hide)').map((b) => b.getAttribute('data-p'));
      app.click(sidebarGroups(app).find((g) => g.label === 'Well Testing').el.querySelector('.nav-group-label'));  // collapse
      app.input('sb_search', 'choke');
      const exp = app.findAll('#sidebar .nav-btn[data-p]').filter((b) => /choke/i.test(b.textContent)).map((b) => b.getAttribute('data-p'));
      exp.forEach((k) => assert.ok(vis().includes(k), 'match ' + k));
      assert.ok(app.el('sidebar').classList.contains('sb-searching'), 'collapsed groups open while searching');
      sidebarGroups(app).forEach((g) => {
        const n = g.el.querySelectorAll('.nav-btn:not(.sb-hide)').length;
        assert.strictEqual(g.el.classList.contains('sb-hide'), n === 0, g.label);
      });
      // plug-in subtitle text: the flowline page subtitle names Beggs & Brill, its label does not
      const sub = String(app.win.WTS_calcRegistry.flowline.sub || '');
      assert.ok(/Beggs/.test(sub) && !/Beggs/.test(app.find('.nav-btn[data-p="flowline"]').textContent), 'precondition');
      app.input('sb_search', 'beggs');
      assert.ok(vis().includes('flowline'), 'found by its subtitle');
      app.input('sb_search', 'electrical');
      assert.deepStrictEqual(vis().sort(), sidebarGroups(app).find((g) => g.label === 'Electrical').ids.slice().sort(), 'group label matches its buttons');
      app.input('sb_search', 'qqzzxx');
      assert.deepStrictEqual(vis(), []);
      assert.ok(!app.el('sb_empty').classList.contains('hidden'), 'no-match message');
      app.key('sb_search', 'Escape');
      assert.strictEqual(vis().length, app.findAll('#sidebar .nav-btn[data-p]').length);
      assert.ok(!app.el('sidebar').classList.contains('sb-searching'));
      assert.ok(app.el('sb_empty').classList.contains('hidden'));
      app.input('sb_search', 'kill');
      app.key('sb_search', 'Enter');
      assert.strictEqual(app.hook.page(), 'wellkill');
    },
  },
  {
    name: 'UX sidebar + dashboard are 375 px-safe in markup: search boxes are fluid, no fixed widths, CSS contract present',
    wp: WP,
    opts: { viewport: { width: 375, height: 812 } },
    run(app, assert) {
      const css = (app.html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
      assert.ok(/\.sb-search input\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/.test(css), 'sidebar search box fills the drawer and may shrink');
      assert.ok(/\.dash-tools input\s*\{[^}]*min-width:\s*0/.test(css), 'dashboard search box may shrink');
      assert.ok(/@media \(max-width: 600px\)[\s\S]*\.cols-2 > \*, \.cols-3 > \*, \.fg > \*/.test(css), 'phone grids may shrink to the screen');
      app.hook.nav('home');
      const html = app.el('pgBody').innerHTML + app.el('sidebar').innerHTML.replace(/<img[^>]*>/g, '');
      assert.ok(!/width:\s*(3[8-9]\d|[4-9]\d\d|\d{4,})px/.test(html), 'no fixed widths wider than a phone');
    },
  },

  // ── Stacked input tables ────────────────────────────────────────────────
  {
    name: 'UX stacked tables: every input table on the listed pages gets .wts-stack and a data-label per cell from its column header',
    wp: WP,
    run(app, assert) {
      TABLE_PAGES.forEach((k) => {
        open(app, k);
        app.flush(50);
        const tables = app.findAll('#pgBody table').filter((t) => !t.parentElement.closest('table') &&
          Array.from(t.rows).some((r) => r.querySelector('input, select, textarea')));
        assert.ok(tables.length >= 1, k + ': has an input table');
        tables.forEach((t) => {
          assert.ok(t.classList.contains('wts-stack'), k + ': table marked');
          const { head, labels } = headerLabels(t);
          if (!t.tHead) assert.ok(head.classList.contains('wts-stack-head'), k + ': implicit header row marked');
          Array.from(t.rows).filter((r) => r !== head && r.parentElement !== t.tHead).forEach((r) => {
            let col = 0;
            Array.from(r.cells).forEach((c) => {
              assert.strictEqual(c.getAttribute('data-label'), labels[col], k + ' r' + r.rowIndex + 'c' + col);
              col += c.colSpan || 1;
            });
          });
        });
      });
      // result-only tables are left alone
      open(app, 'gaspvt');
      app.findAll('#pgBody table').forEach((t) => assert.ok(!t.classList.contains('wts-stack'), 'gaspvt result table untouched'));
    },
  },
  {
    name: 'UX stacked tables: ids, autosave and the report / CSV model are identical to the page without the stacking pass',
    wp: WP,
    run(app, assert) {
      const ref = app.reload({ html: neutralised(app.html), storage: require('./_harness.js').createStorage() });
      try {
        TABLE_PAGES.forEach((k) => {
          [app, ref].forEach((a) => { open(a, k); a.flush(50); });
          const ids = (a) => a.findAll('#pgBody [id]').map((e) => e.id);
          assert.deepStrictEqual(ids(app), ids(ref), k + ': same ids');
          assert.ok(app.findAll('#pgBody table.wts-stack').length > 0 && ref.findAll('#pgBody table.wts-stack').length === 0, k + ': precondition');
          const rep = (a) => { const m = json(a.win.collectPageReport(a.el('pgBody'), { charts: false })); delete m.date; return m; };
          assert.deepStrictEqual(rep(app), rep(ref), k + ': report model unchanged');
          assert.strictEqual(app.win.WTS_resultsToCSV(json(app.win.WTS_pageResults())).replace(/Exported,[^\r\n]*/, ''),
            ref.win.WTS_resultsToCSV(json(ref.win.WTS_pageResults())).replace(/Exported,[^\r\n]*/, ''), k + ': CSV unchanged');
          // autosave: edit the first numeric table cell in both and compare the stored records
          const first = (a) => a.find('#pgBody table.wts-stack input[type="number"][id], #pgBody table input[type="number"][id]');
          const i1 = first(app), i2 = first(ref);
          if (i1 && i2) {
            assert.strictEqual(i1.id, i2.id);
            app.input(i1, '7.5'); ref.input(i2, '7.5');
            app.flush(400); ref.flush(400);
            const rec = (a) => { const r = JSON.parse(a.storage.getItem('wts_page_' + k) || 'null'); return r && r.f; };
            assert.deepStrictEqual(rec(app), rec(ref), k + ': autosave record unchanged');
          }
        });
      } finally { ref.dispose(); }
    },
  },
  {
    name: 'UX stacked tables: labels follow rebuilt rows and the unit system (header unit labels)',
    wp: WP,
    run(app, assert) {
      open(app, 'proving');
      const lab = () => app.find('#pv_runs tbody tr td:nth-child(2)').getAttribute('data-label');
      assert.ok(/\(bbl\)/.test(lab()), 'imperial header unit: ' + lab());
      const U = app.win.WTS_units;
      U.setSystem('metric');
      app.flushAsync && app.flush(10);
      return Promise.resolve().then(() => Promise.resolve()).then(() => {
        try {
          const th = text(app.find('#pv_runs thead tr th:nth-child(2)'));
          assert.ok(!/\(bbl\)/.test(th), 'precondition: the header changed to metric: ' + th);
          assert.strictEqual(lab(), th, 'data-label follows the header');
          // rows rebuilt by a page action keep labels: pipelife repaints its tables on every input
          U.setSystem('imperial');
          open(app, 'pipelife');
          const inp = app.find('#pgBody table.wts-stack input[type="number"]');
          app.input(inp, String(Number(inp.value || 1) + 1));
          app.findAll('#pgBody table.wts-stack').forEach((t) =>
            Array.from(t.tBodies[0] ? t.tBodies[0].rows : []).forEach((r) => Array.from(r.cells).forEach((c) => assert.ok(c.hasAttribute('data-label'), 'label after repaint'))));
        } finally { U.setSystem('imperial'); }
      });
    },
  },
  {
    name: 'UX stacked tables CSS: phone-only (≤ 600 px) card rules, header clipped not removed; iOS keeps them over its table scroller',
    wp: WP,
    run(app, assert) {
      const css = ((app.html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '').replace(/\/\*[\s\S]*?\*\//g, '');
      const i = css.indexOf('.page-body table.wts-stack {');
      assert.ok(i > 0, 'stack rules present');
      const before = css.slice(0, i), mq = before.lastIndexOf('@media');
      assert.ok(/@media \(max-width: 600px\)\s*\{/.test(before.slice(mq)), 'inside the 600 px media query only');
      assert.strictEqual((css.match(/wts-stack/g) || []).length, (css.slice(mq).match(/wts-stack/g) || []).length, 'no stack rule outside it');
      assert.ok(/tr\.wts-stack-head \{\s*position: absolute !important;[^}]*clip-path: inset\(50%\)/.test(css), 'header visually hidden (kept for reports / screen readers)');
      assert.ok(!/wts-stack[^{]*\{[^}]*display:\s*none/.test(css.replace(/td:empty \{ display: none; \}/, '')), 'no stacked row or header is display:none');
      assert.ok(/td\[data-label\]::before \{\s*content: attr\(data-label\)/.test(css), 'label from data-label');
      const ios = require('fs').readFileSync(path.join(__dirname, '..', '..', 'ios-app', 'ios-additions', 'ios-styles.css'), 'utf8');
      assert.ok(/@media \(max-width: 600px\)\s*\{\s*html\.ios-app #pgBody table\.wts-stack \{ display: block; max-width: 100%; overflow: visible; \}/.test(ios), 'iOS override of the table scroller');
      assert.ok(/html\.ios-app \.nav-group-label \{ min-height: 44px;/.test(ios), '44 pt group headings in the app');
    },
  },

  // ── Copy results + consistency sweep ────────────────────────────────────
  {
    name: 'UX Copy results: header button on calculator pages copies inputs, results and tab-separated tables',
    wp: WP,
    run(app, assert) {
      app.hook.nav('home');
      assert.strictEqual(app.el('exportBtns').style.display, 'none', 'no export bar on the dashboard');
      open(app, 'proving');
      app.flush(50);
      assert.strictEqual(app.el('exportBtns').style.display, 'flex');
      const btn = app.el('copyResultsBtn');
      assert.ok(/Copy results/.test(text(btn)));
      app.click(btn);
      return app.flushAsync(20).then(() => {
        const t = String(app.clipboard || '');
        assert.ok(t.startsWith(text(app.el('pgTitle'))), 'starts with the page title');
        assert.ok(/\nINPUTS\n/.test(t) && /\nRESULTS\n/.test(t), 'both parts');
        // every result row on screen appears as "label: value"
        app.findAll('#pv_res .rrow').filter((r) => r.getClientRects().length).slice(0, 12).forEach((r) => {
          const line = text(r.querySelector('.rl')) + ': ' + text(r.querySelector('.rv'));
          assert.ok(t.indexOf(line) !== -1, 'line ' + line);
        });
        // the runs table: header row tab-separated
        const heads = Array.from(app.find('#pv_runs thead tr').cells).map((c) => text(c));
        assert.ok(t.indexOf(heads.join('\t')) !== -1, 'input table header row, tab-separated');
        app.flush(2000);   // flash timer
      });
    },
  },
  {
    name: 'UX consistency: every plug-in calculator has a Notes box, the header export bar (Copy / PDF / PNG / CSV / JSON), verdict colours that match their symbol, and labelled inputs',
    wp: WP,
    run(app, assert) {
      const reg = app.win.WTS_calcRegistry;
      const keys = Object.keys(reg).filter((k) => typeof reg[k].render === 'function');
      assert.ok(keys.length >= 15, 'plug-in calculators: ' + keys.length);
      const COLOR = { '✓': 'green', '⚠': 'yellow', '✗': 'red' };
      keys.forEach((k) => {
        open(app, k);
        app.flush(50);
        const body = app.el('pgBody');
        const notes = Array.from(body.querySelectorAll('div')).some((d) => d.firstElementChild && d.firstElementChild.tagName === 'B' && /^Notes?$/i.test(text(d.firstElementChild)));
        assert.ok(notes, k + ': Notes box');
        assert.strictEqual(app.el('exportBtns').style.display, 'flex', k + ': export bar shown');
        const btns = Array.from(app.el('exportBtns').querySelectorAll('button')).map((b) => text(b));
        ['Copy results', 'PDF', 'PNG', 'CSV', 'JSON'].forEach((w) => assert.ok(btns.some((b) => b.indexOf(w) !== -1), k + ': ' + w + ' button'));
        Array.from(body.querySelectorAll('div')).forEach((d) => {
          if (d.querySelector('div')) return;
          const s = text(d).charAt(0);
          if (!COLOR[s]) return;
          const st = String(d.getAttribute('style') || '');
          assert.ok(new RegExp('color:\\s*var\\(--' + COLOR[s] + '\\)').test(st), k + ': verdict "' + text(d).slice(0, 40) + '" coloured ' + COLOR[s] + ' (style: ' + st + ')');
        });
        body.querySelectorAll('input, select, textarea').forEach((c) => {
          if (/^(hidden|button|submit|file)$/.test(c.type)) return;
          const fi = c.closest('.fg-item'), td = c.closest('td');
          const name = (fi && fi.querySelector('label') && text(fi.querySelector('label'))) ||
            (td && td.getAttribute('data-label')) || c.getAttribute('aria-label') || c.getAttribute('title') ||
            (c.closest('label') && text(c.closest('label')));
          assert.ok(name, k + ': control ' + (c.id || c.tagName) + ' has a label');
        });
      });
    },
  },
  {
    name: 'UX label fixes on host pages: generator motor rows and the flare radiation level are named with their units',
    wp: WP,
    run(app, assert) {
      open(app, 'gensz');
      const row = app.find('#gs_motors .fg-grid');
      const [kw, meth, qty] = Array.from(row.querySelectorAll('input, select'));
      assert.ok(/\(kW\)/.test(kw.getAttribute('aria-label')), 'motor rating in kW');
      assert.strictEqual(meth.getAttribute('aria-label'), 'Starting method');
      assert.ok(/quantity/i.test(qty.getAttribute('aria-label')));
      assert.ok(/Remove motor/.test(row.querySelector('button').getAttribute('aria-label')));
      const rep = json(app.win.collectPageReport(app.el('pgBody'), { charts: false }));
      const motor = [].concat(...rep.inputs.map((s) => s.items)).find((it) => it.type === 'table' && it.head && it.head[0] === 'kW');
      assert.ok(motor, 'motor rows still reported as a table');
      assert.deepStrictEqual(motor.head, ['kW', 'Starting method', 'Qty']);
      open(app, 'flare');
      assert.strictEqual(text(app.el('fl_cl').closest('.fg-item').querySelector('label')), 'Radiation level (kW/m²)');
    },
  },

  // ── Real engines ────────────────────────────────────────────────────────
  {
    name: 'UX real-engine phone layout (Playwright): no overflow at 375 px, stacked row cards, same report at 375 and 1280 px, desktop tables unchanged',
    wp: WP,
    integration: true,
    timeoutMs: 600000,
    run(app, assert) {
      const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'ux-layout-check.js'), '--quick', '--json'], { encoding: 'utf8', timeout: 580000 });
      const line = String(r.stdout || '').trim().split('\n').pop() || '';
      let res = null;
      try { res = JSON.parse(line); } catch (e) { assert.fail('ux-layout-check output: ' + String(r.stdout).slice(-400) + String(r.stderr).slice(-400)); }
      if (res.skipped) { console.log('    [skip] ' + res.skipped); return; }
      assert.deepStrictEqual(res.fails, [], 'layout problems');
      assert.ok(res.checks >= 40, 'checks run: ' + res.checks);
    },
  },
];
