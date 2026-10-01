// v3.1 sidebar: fewer groups, accordion (one group open), hubs (one sidebar entry → tabbed
// calculators), "What's new" link under the version label.
//
// Expected values come from the task statement: the group list and the hub membership below are
// the agreed structure; every old route key must keep working (nav('<old>'), autosave key
// wts_page_<old>, report snapshot under <old>); the desktop no-scroll fit itself is measured in a
// real engine by prism-build/ux-layout-check.js (scrollHeight ≤ clientHeight at 1280×800 / 1440×900).
'use strict';

const WP = 'NAV';
const GROUPS = ['Overview', 'Metering & Chokes', 'Well Test & Flowlines', 'Production & Reservoir', 'Live Data',
  'Test System Safety', 'Separation & Process', 'Flare & Relief', 'Fluids & Utilities'];
const HUBS = {
  chokes: ['choke', 'chokeflow', 'chokecnv', 'chokeperf'],
  esd: ['esdhi', 'esdlo'],
  separators: ['sep', 'seprate', 'sephand'],
  electrical: ['gensz', 'cablesz', 'vdrop', 'elec'],
};
const MAX_ROWS = 8;   // rows of the largest group: fits 1280×800 with every other group label shown

const text = (e) => String(e && e.textContent || '').replace(/\s+/g, ' ').trim();
const groups = (app) => app.findAll('#sidebar .nav-group').map((g) => ({ el: g, label: text(g.querySelector('.nav-group-label')) }));
const grp = (app, label) => { const g = groups(app).find((x) => x.label === label); if (!g) throw new Error('no group ' + label); return g.el; };
const openLabels = (app) => groups(app).filter((g) => !g.el.classList.contains('collapsed')).map((g) => g.label);
// rows a group shows when open: buttons that are not hub members (hub buttons count once)
const rows = (g) => Array.from(g.querySelectorAll('.nav-btn')).filter((b) => !b.classList.contains('nav-hub-member') && !b.classList.contains('sb-hide'));
const hubBtn = (app, h) => app.find('#sidebar .nav-btn[data-hub="' + h + '"]');
const tabs = (app) => app.findAll('#hubTabs [role="tab"]').map((t) => t.getAttribute('data-hub-go'));

module.exports = [
  {
    name: 'NAV structure: nine groups in order, ≤ 8 rows each, hubs stand for their members, Mini WellOS first in Live Data, no Release Notes row',
    wp: WP,
    run(app, assert) {
      assert.deepStrictEqual(groups(app).map((g) => g.label), GROUPS);
      groups(app).forEach((g) => assert.ok(rows(g.el).length <= MAX_ROWS, g.label + ': ' + rows(g.el).length + ' rows'));
      Object.keys(HUBS).forEach((h) => {
        const b = hubBtn(app, h);
        assert.ok(b && !b.hasAttribute('data-p'), 'hub button ' + h);
        HUBS[h].forEach((m) => {
          const mb = app.find('#sidebar .nav-btn[data-p="' + m + '"]');
          assert.ok(mb && mb.classList.contains('nav-hub-member'), m + ' is a hub member');
          assert.strictEqual(mb.closest('.nav-group'), b.closest('.nav-group'), m + ' sits in its hub\'s group');
        });
      });
      assert.ok(/\.sidebar \.nav-btn\.nav-hub-member \{ display: none; \}/.test(app.html), 'CSS hides hub members');
      assert.deepStrictEqual(Array.from(grp(app, 'Live Data').querySelectorAll('.nav-btn[data-p]')).map((b) => b.getAttribute('data-p')), ['wellos', 'modbus', 'historian']);
      assert.strictEqual(rows(grp(app, 'Production & Reservoir'))[0].getAttribute('data-p'), 'prism', 'PRiSM heads its group');
      assert.strictEqual(rows(grp(app, 'Well Test & Flowlines'))[0].getAttribute('data-p'), 'wts', 'the simulator heads its group');
      assert.ok(!app.find('#sidebar .nav-group .nav-btn[data-p="releasenotes"]'), 'Release Notes not listed in a group');
      // plug-ins land in their place inside the group (host order), not at its end
      const mc = Array.from(grp(app, 'Metering & Chokes').querySelectorAll('.nav-btn')).map((b) => b.getAttribute('data-p') || 'hub:' + b.getAttribute('data-hub'));
      assert.deepStrictEqual(mc, ['aga3', 'orifice', 'hub:chokes', 'choke', 'chokeflow', 'chokecnv', 'chokeperf', 'mcfshr', 'turbmeter', 'proving', 'sepqc']);
    },
  },
  {
    name: 'NAV What’s new: compact link under the version label opens Release Notes, active + aria-current there, keyboard-native button',
    wp: WP,
    run(app, assert) {
      const rn = app.el('sbReleaseNotes');
      assert.ok(rn, '#sbReleaseNotes');
      assert.strictEqual(String(rn.localName).toLowerCase(), 'button', 'native button: focusable, Enter/Space');
      assert.strictEqual(rn.getAttribute('type'), 'button');
      assert.ok(rn.closest('.sidebar-brand'), 'in the brand block');
      const ver = app.el('appVersionLabel');
      assert.strictEqual(ver.parentNode, rn.parentNode, 'next to the version label');
      assert.ok(Array.from(rn.parentNode.children).indexOf(rn) > Array.from(rn.parentNode.children).indexOf(ver), 'below the version label');
      assert.ok(/What.s new/.test(text(rn)));
      assert.ok(!rn.classList.contains('active'));
      app.click(rn);
      assert.strictEqual(app.hook.page(), 'releasenotes');
      assert.ok(rn.classList.contains('active') && rn.getAttribute('aria-current') === 'page', 'active on its page');
      assert.ok(/v3\.1/.test(text(app.el('pgBody'))), 'release notes rendered');
      app.hook.nav('aga3');
      assert.ok(!rn.classList.contains('active') && !rn.hasAttribute('aria-current'), 'inactive elsewhere');
      app.hook.nav('releasenotes');
      assert.ok(rn.classList.contains('active'), 'nav(\'releasenotes\') still works');
      assert.ok(/html\.ios-app[^{]*\.sb-relnotes[^{]*\{[^}]*min-height:\s*44px/.test(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'ios-app', 'ios-additions', 'ios-styles.css'), 'utf8')), '44 pt target in the iOS app');
    },
  },
  {
    name: 'NAV accordion: only the active page’s group open at start; opening a group closes the others; click / Enter / Space; aria-expanded',
    wp: WP,
    run(app, assert) {
      assert.strictEqual(app.hook.page(), 'clientinfo');
      assert.deepStrictEqual(openLabels(app), ['Overview'], 'start: the active page\'s group only');
      const tss = grp(app, 'Test System Safety'), lab = tss.querySelector('.nav-group-label');
      assert.strictEqual(lab.getAttribute('role'), 'button');
      assert.strictEqual(lab.getAttribute('tabindex'), '0');
      assert.strictEqual(lab.getAttribute('aria-expanded'), 'false');
      app.click(lab);
      assert.deepStrictEqual(openLabels(app), ['Test System Safety'], 'one open at a time');
      assert.strictEqual(lab.getAttribute('aria-expanded'), 'true');
      assert.strictEqual(grp(app, 'Overview').querySelector('.nav-group-label').getAttribute('aria-expanded'), 'false');
      assert.ok(app.find('#sidebar .nav-btn[data-p="clientinfo"]').classList.contains('active'), 'active page button kept (CSS shows it in a closed group)');
      assert.ok(/\.nav-group\.collapsed \.nav-btn:not\(\.active\)\s*\{\s*display:\s*none/.test(app.html));
      app.click(lab);
      assert.deepStrictEqual(openLabels(app), [], 'clicking the open group closes it');
      app.key(lab, 'Enter');
      assert.deepStrictEqual(openLabels(app), ['Test System Safety'], 'Enter opens');
      const fl = grp(app, 'Flare & Relief').querySelector('.nav-group-label');
      app.key(fl, ' ');
      assert.deepStrictEqual(openLabels(app), ['Flare & Relief'], 'Space opens another, closing the first');
      // a group created / filled by the plug-in registry behaves the same
      app.click(grp(app, 'Live Data').querySelector('.nav-group-label'));
      assert.deepStrictEqual(openLabels(app), ['Live Data']);
      assert.strictEqual(app.storage.getItem('wts_ui_nav_open'), 'live data', 'choice stored');
    },
  },
  {
    name: 'NAV accordion: navigating reveals the page’s group (plain, hub member, plug-in, alias route); choice survives a reload',
    wp: WP,
    run(app, assert) {
      app.hook.nav('flare');
      assert.deepStrictEqual(openLabels(app), ['Flare & Relief']);
      app.hook.nav('sephand');
      assert.deepStrictEqual(openLabels(app), ['Separation & Process'], 'hub member page');
      assert.ok(hubBtn(app, 'separators').classList.contains('active'), 'hub button active');
      app.hook.nav('historian');
      assert.deepStrictEqual(openLabels(app), ['Live Data'], 'plug-in page');
      app.hook.nav('dca');
      assert.deepStrictEqual(openLabels(app), ['Production & Reservoir'], 'legacy dca route → PRiSM');
      assert.ok(app.find('#sidebar .nav-btn[data-p="prism"]').classList.contains('active'), 'PRiSM marked active');
      app.click(grp(app, 'Test System Safety').querySelector('.nav-group-label'));
      const app2 = app.reload();
      try {
        assert.deepStrictEqual(openLabels(app2), ['Test System Safety'], 'remembered open group restored at start-up');
        app2.hook.nav('aga3');
        assert.deepStrictEqual(openLabels(app2), ['Metering & Chokes'], 'navigation still reveals');
      } finally { app2.dispose(); }
      // stale stored group (e.g. a pre-v3.1 label) → the active page's group
      const app3 = app.reload();
      try {
        app3.storage.setItem('wts_ui_nav_open', 'well testing');
        const app4 = app3.reload();
        try { assert.deepStrictEqual(openLabels(app4), ['Overview'], 'unknown stored group falls back'); } finally { app4.dispose(); }
      } finally { app3.dispose(); }
    },
  },
  {
    name: 'NAV hubs: every old route still opens its own page with a tab strip; tabs and the hub button navigate; last tab remembered',
    wp: WP,
    run(app, assert) {
      Object.keys(HUBS).forEach((h) => {
        HUBS[h].forEach((m) => {
          app.hook.nav(m);
          assert.strictEqual(app.hook.page(), m, 'route ' + m);
          assert.ok(text(app.el('pgTitle')).length > 2, m + ' title');
          assert.ok(app.el('pgBody').children.length > 0, m + ' rendered');
          assert.ok(!app.el('hubTabs').classList.contains('hidden'), m + ': tab strip shown');
          assert.deepStrictEqual(tabs(app), HUBS[h], m + ': tabs = hub members');
          const sel = app.findAll('#hubTabs [role="tab"][aria-selected="true"]').map((t) => t.getAttribute('data-hub-go'));
          assert.deepStrictEqual(sel, [m], m + ': its tab selected');
          assert.ok(hubBtn(app, h).classList.contains('active'), m + ': hub button active');
          assert.ok(!app.el('pgBody').contains(app.el('hubTabs')), 'tab strip outside #pgBody (autosave / reports untouched)');
        });
      });
      app.hook.nav('aga3');
      assert.ok(app.el('hubTabs').classList.contains('hidden'), 'no strip on other pages');
      assert.ok(!Object.keys(HUBS).some((h) => hubBtn(app, h).classList.contains('active')));
      app.hook.nav('chokecnv');
      app.click(app.find('#hubTabs [data-hub-go="chokeperf"]'));
      assert.strictEqual(app.hook.page(), 'chokeperf', 'tab opens the member route');
      app.hook.nav('home');
      app.click(hubBtn(app, 'chokes'));
      assert.strictEqual(app.hook.page(), 'chokeperf', 'hub button opens the tab used last');
      app.click(hubBtn(app, 'electrical'));
      assert.strictEqual(app.hook.page(), 'elec', 'last member visited in the loop above');
      app.storage.removeItem('wts_ui_hub_last');
      app.hook.nav('home');
      app.click(hubBtn(app, 'electrical'));
      assert.strictEqual(app.hook.page(), 'gensz', 'first member by default');
      // tab labels are the calculators' names (no icon glyphs)
      assert.deepStrictEqual(app.findAll('#hubTabs [role="tab"]').map(text), ['Generator Sizing', 'Cable Sizing', 'Voltage Drop', 'Electrical & Pumps']);
    },
  },
  {
    name: 'NAV hubs: each tab keeps its own autosave record, report snapshot and export (old keys unchanged)',
    wp: WP,
    run(app, assert) {
      app.hook.nav('choke');
      app.input('c_P1', '2345');
      app.click(app.find('#pgBody [onclick="calcChoke()"]'));   // results → report snapshot
      app.flush(1200);   // autosave (300 ms) + report snapshot (900 ms)
      const rec = JSON.parse(app.storage.getItem('wts_page_choke') || 'null');
      assert.ok(rec && rec.f && rec.f.c_P1 === '2345', 'wts_page_choke: ' + JSON.stringify(rec && rec.f && rec.f.c_P1));
      assert.ok(!rec.tabs || rec.tabs.length === 0 || rec.tabs.every((x) => typeof x === 'number'), 'hub strip not recorded as a page tab strip');
      app.click(app.find('#hubTabs [data-hub-go="chokeflow"]'));
      app.flush(1200);
      app.click(app.find('#hubTabs [data-hub-go="choke"]'));
      assert.strictEqual(app.el('c_P1').value, '2345', 'value restored when coming back through the tabs');
      const snaps = JSON.parse(app.storage.getItem('wts_report_snapshots') || '{}');
      assert.ok(snaps.choke && /Choke/.test(snaps.choke.title || ''), 'report snapshot under the old route key');
      assert.ok(!/Chokes(Dual|Choke)/.test(JSON.stringify(snaps.choke)), 'snapshot has no hub tab text');
      assert.strictEqual(app.el('exportBtns').style.display, 'flex', 'export buttons on a hub tab');
    },
  },
  {
    name: 'NAV search: hub members listed one by one, hub buttons hidden, own names before group labels; clearing restores the accordion',
    wp: WP,
    run(app, assert) {
      const vis = () => app.findAll('#sidebar .nav-group .nav-btn:not(.sb-hide)').map((b) => b.getAttribute('data-p') || 'hub:' + b.getAttribute('data-hub'));
      app.hook.nav('flare');
      const before = openLabels(app);
      app.input('sb_search', 'choke');
      const v = vis();
      HUBS.chokes.forEach((m) => assert.ok(v.includes(m), 'match ' + m));
      assert.ok(!v.some((k) => /^hub:/.test(k)), 'hub buttons hidden while searching');
      assert.ok(!v.includes('aga3'), 'the group label "Metering & Chokes" does not pull in the whole group');
      assert.ok(app.el('sidebar').classList.contains('sb-searching'), 'CSS shows the hub members and closed groups while searching');
      assert.ok(/\.sidebar\.sb-searching \.nav-group \.nav-btn\.nav-hub-member \{ display: flex; \}/.test(app.html));
      app.input('sb_search', 'electrical');
      assert.deepStrictEqual(vis().sort(), HUBS.electrical.slice().sort(), 'hub title finds its members');
      app.input('sb_search', 'safety');
      assert.ok(vis().includes('hydrate') && vis().includes('esdhi'), 'a group label matches its group when no name does');
      app.key('sb_search', 'Escape');
      assert.deepStrictEqual(openLabels(app), before, 'accordion state restored');
      assert.ok(!app.find('#sidebar .nav-btn.sb-hide'), 'nothing filtered');
      app.input('sb_search', 'voltage');
      app.key('sb_search', 'Enter');
      assert.strictEqual(app.hook.page(), 'vdrop', 'Enter opens the first hit (a hub member)');
    },
  },
  {
    name: 'NAV keyboard: the sidebar tab stop and ↑/↓ never land on a hidden button; hub buttons are role=button',
    wp: WP,
    run(app, assert) {
      app.hook.nav('chokeflow');
      app.flush(10);
      const stops = app.findAll('#sidebar .nav-btn[tabindex="0"]');
      assert.strictEqual(stops.length, 1, 'one tab stop');
      assert.strictEqual(stops[0].getAttribute('data-hub'), 'chokes', 'tab stop on the (shown) hub button, not the hidden member');
      assert.strictEqual(stops[0].getAttribute('role'), 'button');
      // ↓ from the hub button skips the hidden members
      app.key(stops[0], 'ArrowDown');
      const now = app.findAll('#sidebar .nav-btn[tabindex="0"]');
      assert.strictEqual(now.length, 1);
      assert.strictEqual(now[0].getAttribute('data-p'), 'mcfshr', 'next shown button');
    },
  },
];
