// Help page (route help) — docs/HELP-GUIDE-PLAN.md §7.2, WP-H.
//
// Builds the app from sources with fixed in-memory test content (every real 48-calc-help-*.js content
// file is left out, so the tests do not depend on what the writers have shipped) and applies the host
// edits H1–H7 with prism-build/help-host-patch.js patch() in memory (D21: help branches never commit a
// rebuilt well-testing-app.html). Covers the sidebar row and #sbHelp, the header ? button and F1, open /
// Back with focus, PRiSM and simulator context, reports / autosave / snapshots / project keys, search
// (ranking, synonyms, keyboard), Metric and decimal comma, escaping, missing images, the lightbox, the
// phone contents, and no timers.
'use strict';

const harness = require('./_harness');
const { patch } = require('../help-host-patch');
const MODEL = require('./_help-model');

const WP = 'HELP';
const CONTENT = ['start', 'overview', 'metering', 'welltest', 'simcourse', 'wpcourse', 'production', 'livedata', 'safety', 'process', 'flare', 'utilities', 'manifest']
  .map((g) => '48-calc-help-' + g + '.js');
const FIX = {
  guides: {
    orifice: MODEL.ORIFICE,
    flare: { route: 'flare', reviewed: 'v3.3.2', units: 'dual', keywords: ['burner boom'], purpose: 'Radiation and noise from the flare or burner boom.',
      what: ['Fixture guide. Amp & volt readings; see the orifice notes on plate selection by category.'], when: ['a', 'b'], steps: ['one', 'two', 'three'], related: ['prv'] },
    prism: { route: 'prism', reviewed: 'v3.3.2', units: 'field', purpose: 'Pressure-transient analysis at {{150|pressureG}}.', what: ['Fixture.'],
      parts: [1, 2, 3, 4, 5].map((n) => ({ id: 'step-' + n, title: 'Step ' + n, what: ['Part ' + n + '.'] })).concat([{ id: 'tools', title: 'Tools', what: ['The drawer.'] }]) },
    releasenotes: { route: 'releasenotes', title: 'Release Notes', reviewed: 'v3.3.2', units: 'none', purpose: 'What changed in each version.', what: ['Fixture.'] },
    wts: { route: 'wts', reviewed: 'v3.3.2', units: 'dual', purpose: 'Dynamic replay around a steady design calculation.', what: ['Fixture.'],
      parts: [{ id: 'reference', title: 'Reference', what: ['The reference.'] }, { id: 'inputs', title: 'Inputs', what: ['Which pressure goes where.'] }] },
  },
  start: [{ id: 'screen', title: 'The screen', body: ['The sidebar has nine groups.', { list: ['one', 'two'] }] }],
  tasks: [{ id: 'meter', title: 'Meter gas', purpose: 'From the plate to the meter factor.', steps: [{ route: 'orifice', t: 'Choose the orifice plate.', carry: 'plate and DP range' }, { route: 'aga3', t: 'Meter.' }] }],
  scenarios: [{ id: 'FS-1', title: 'Unloading the completion cushion straight to the burner boom', intro: ['Which pressure goes where.'],
    today: ['Switch V-101 out today.'], afterSim: ['Choose the bypass destination.'], feature: 'bypassDest' }],
  glossary: { bean: { term: 'bean', def: 'Choke size in 64ths of an inch.' } },
};
const FIX_SRC = '(function () { var G = window; G.WTS_helpContent = G.WTS_helpContent || { guides: {}, factories: [] };\n' +
  "G.WTS_helpContent.factories.push({ group: 'zztest', routes: ['orifice', 'flare', 'prism', 'wts', 'releasenotes'], build: function () { return " + JSON.stringify(FIX) + '; } });\n})();\n';
const OVERRIDES = Object.assign({ '48-calc-help-zztest.js': FIX_SRC }, ...CONTENT.map((f) => ({ [f]: null })));

let _html = null;
function html() {
  if (_html == null) _html = patch(harness.buildFromSources({ silent: true, overrides: OVERRIDES }).html);
  return _html;
}
const open = (ctx, o) => ctx.loadApp(Object.assign({ html: html() }, o || {}));
const txt = (e) => String((e && e.textContent) || '').replace(/\s+/g, ' ').trim();
const shown = (e) => !!e && !e.hasAttribute('hidden');

module.exports = [
  {
    name: 'HELP page: registry row 2 of Overview (H1), #sbHelp inline after "What’s new" (H2), Overview 5 rows; the patch is idempotent',
    wp: WP, opts: false,
    run(_, assert, ctx) {
      const app = open(ctx);
      const ov = app.findAll('#sidebar .nav-group').find((g) => txt(g.querySelector('.nav-group-label')) === 'Overview');
      const rows = Array.from(ov.querySelectorAll('.nav-btn')).filter((b) => !b.classList.contains('nav-hub-member')).map((b) => b.getAttribute('data-p'));
      assert.deepStrictEqual(rows, ['home', 'help', 'clientinfo', 'wells', 'privacy']);
      assert.ok(txt(ov.querySelector('.nav-btn[data-p="help"]')).indexOf('Help & Guide') !== -1, 'navTitle in the sidebar');
      app.findAll('#sidebar .nav-group').forEach((g) => assert.ok(Array.from(g.querySelectorAll('.nav-btn')).filter((b) => !b.classList.contains('nav-hub-member')).length <= 8));
      const rn = app.el('sbReleaseNotes'), hb = app.el('sbHelp');
      assert.ok(hb && hb.parentNode === rn.parentNode, '#sbHelp next to What’s new');
      const sib = Array.from(rn.parentNode.childNodes);
      assert.ok(sib.indexOf(hb) > sib.indexOf(rn), 'after it');
      assert.ok(!sib.slice(sib.indexOf(rn) + 1, sib.indexOf(hb)).some((n) => n.localName === 'br' || n.localName === 'div' || n.localName === 'p'), 'same line');
      assert.strictEqual(hb.getAttribute('type'), 'button');
      app.click(hb);
      assert.strictEqual(app.hook.page(), 'help');
      assert.ok(hb.classList.contains('active') && hb.getAttribute('aria-current') === 'page');
      app.hook.nav('aga3');
      assert.ok(!hb.classList.contains('active'));
      assert.strictEqual(patch(html()), html(), 'second patch() changes nothing');
      const crlf = harness.buildFromSources({ silent: true, overrides: OVERRIDES }).html.replace(/\r?\n/g, '\r\n');
      const p = patch(crlf);
      assert.strictEqual((p.match(/(^|[^\r])\n/g) || []).length, 0, 'CRLF kept');
      assert.strictEqual(patch(p), p);
    },
  },
  {
    name: 'HELP page: #pgHelpBtn shown on routes with a guide (aria-label "Help: <title>"), hidden without one and on help; home opens Getting started',
    wp: WP, opts: false,
    run(_, assert, ctx) {
      const app = open(ctx), b = () => app.el('pgHelpBtn');
      assert.ok(b(), '#pgHelpBtn in the header (H3)');
      assert.ok(!shown(b()), 'clientinfo has no guide in the fixture');
      app.hook.nav('orifice');
      assert.ok(shown(b()));
      assert.strictEqual(b().getAttribute('aria-label'), 'Help: Orifice Plate Selection');
      app.hook.nav('tank');
      assert.ok(!shown(b()));
      app.hook.nav('dca');
      assert.ok(shown(b()), 'dca alias → prism guide');
      app.hook.nav('help');
      assert.ok(!shown(b()));
      app.hook.nav('home');
      assert.ok(shown(b()) && b().getAttribute('aria-label') === 'Help: Getting started');
      app.click(b());
      assert.strictEqual(app.hook.page(), 'help');
      assert.strictEqual(app.win.WTS_help.view().kind, 'start');
      assert.ok(/The screen/.test(txt(app.el('help_main'))));
      const css = require('fs').readFileSync(require('path').join(harness.REPO, 'ios-app', 'ios-additions', 'ios-styles.css'), 'utf8');
      assert.ok(/html\.ios-app #pgHelpBtn \{[^}]*height: 44px/.test(css), '44 pt ? button in the iOS app');
      assert.ok(/html\.ios-app \.help-lb \{[^}]*env\(safe-area-inset-top\)[^}]*env\(safe-area-inset-bottom\)/.test(css), 'lightbox safe-area padding');
      assert.ok(/\.pg-help \{[^}]*width: 28px; height: 28px;[^}]*border-radius: 50%/.test(app.html), '28 px circle on the web');
    },
  },
  {
    name: 'HELP page: ? opens the guide with focus on its heading; Back returns to the page and focus to #pgHelpBtn; F1 and WTS_help.open',
    wp: WP, opts: false,
    run(_, assert, ctx) {
      const app = open(ctx), W = app.win;
      app.hook.nav('orifice');
      app.click('pgHelpBtn');
      assert.strictEqual(app.hook.page(), 'help');
      assert.deepStrictEqual([W.WTS_help.view().kind, W.WTS_help.view().route], ['guide', 'orifice']);
      assert.strictEqual(app.document.activeElement.id, 'help-orifice-top', 'focus on the guide heading');
      assert.strictEqual(txt(app.el('help-orifice-top')), 'Orifice Plate Selection');
      const back = app.el('help_back');
      assert.ok(!back.hidden && /Back to Orifice Plate Selection/.test(txt(back)));
      app.click(back);
      assert.strictEqual(app.hook.page(), 'orifice');
      assert.strictEqual(app.document.activeElement.id, 'pgHelpBtn', 'focus back on the opener');
      app.hook.nav('flare');
      app.key(app.el('pgBody'), 'F1');
      assert.strictEqual(app.hook.page(), 'help');
      assert.strictEqual(W.WTS_help.view().route, 'flare');
      W.WTS_help.open('orifice');
      assert.strictEqual(W.WTS_help.view().route, 'orifice', 'open() while on help switches the guide');
      app.hook.nav('help');
      assert.ok(app.el('help_back').hidden, 'no Back when Help is opened from the sidebar');
      assert.strictEqual(W.WTS_help.view().kind, 'landing');
      assert.ok(/Meter gas/.test(txt(app.el('help_main'))), 'landing lists the tasks');
      assert.ok(/Continue: Orifice Plate Selection/.test(txt(app.el('help_main'))), 'last guide (wtspref_help_last)');
      assert.strictEqual(app.storage.getItem('wtspref_help_last'), 'orifice');
    },
  },
  {
    name: 'HELP page: PRiSM context opens the current step’s part; the simulator opens its reference part',
    wp: WP, opts: false,
    run(_, assert, ctx) {
      const app = open(ctx), W = app.win;
      app.hook.nav('prism');
      app.flush(300);
      if (typeof W.PRiSM_gotoStep === 'function') W.PRiSM_gotoStep(3);
      const step = W.PRiSM_currentStep();
      assert.ok(step >= 1, 'PRiSM_currentStep');
      app.key(app.el('pgBody'), 'F1');
      assert.deepStrictEqual([W.WTS_help.view().route, W.WTS_help.view().sec], ['prism', 'step-' + step]);
      assert.ok(app.el('help-prism-step-' + step), 'the part is rendered with its id');
      assert.ok(/PRiSM works in oilfield units/.test(txt(app.el('help_main'))), 'field-units notice');
      app.hook.nav('prism');
      app.flush(300);
      assert.ok(W.PRiSM_openTools() !== null && app.el('prism_tools_drawer'), 'Tools drawer open');
      app.key(app.el('pgBody'), 'F1');
      assert.deepStrictEqual([W.WTS_help.view().route, W.WTS_help.view().sec], ['prism', 'tools'], 'the Tools drawer has its own part (§2.7)');
      assert.ok(app.el('help-prism-tools'));
      W.PRiSM_closeTools();
      app.hook.nav('wts');
      app.flush(200);
      app.key(app.el('pgBody'), 'F1');
      assert.deepStrictEqual([W.WTS_help.view().route, W.WTS_help.view().sec], ['wts', 'reference']);
    },
  },
  {
    name: 'HELP page: kept out of reports and saves — #exportBtns hidden after pagechange, no report blocks, no wts_page_help, no snapshot, no project keys',
    wp: WP, opts: false,
    run(_, assert, ctx) {
      const app = open(ctx), W = app.win;
      app.hook.nav('orifice');
      assert.notStrictEqual(app.el('exportBtns').style.display, 'none', 'export bar on a calculator');
      app.hook.nav('help');
      assert.strictEqual(app.el('exportBtns').style.display, 'none', 'hidden on help after the h2oil:pagechange listeners (H4)');
      const root = app.el('help_root');
      assert.ok(root.classList.contains('rp-skip') && root.hasAttribute('data-rp-nosnap') && root.hasAttribute('data-no-persist'));
      app.input('help_q', 'orifice');
      app.key('help_q', 'Enter');
      app.click(app.find('#help_main .help-a[data-help-go]'));
      app.flush(2000);
      const m = W.collectPageReport(app.el('pgBody'), { charts: false });
      assert.deepStrictEqual([m.inputs.length, m.results.length], [0, 0], 'no report blocks');
      if (typeof W.WTS_snapshotNow === 'function') W.WTS_snapshotNow();
      app.hook.nav('home');
      app.flush(2000);
      assert.strictEqual(app.storage.getItem('wts_page_help'), null, 'no autosave record');
      const snaps = JSON.parse(app.storage.getItem('wts_report_snapshots') || '{}');
      assert.ok(!snaps.help, 'no Quick Report snapshot (H5)');
      const keys = Object.keys(app.storage).filter((k) => /^(wts_|h2oil_)/.test(k) && /help/.test(k));
      assert.deepStrictEqual(keys, [], 'no help keys go into project files');
      assert.ok(/_REPORT_SKIP = \{ home:1, help:1,/.test(app.html), 'help in _REPORT_SKIP');
    },
  },
  {
    name: 'HELP page: search ranks titles, tasks and synonyms (orifice, burner, production pressure); ↑ / ↓ / Enter / Esc and "/" work',
    wp: WP, opts: false,
    run(_, assert, ctx) {
      const app = open(ctx), H = app.win.WTS_help;
      assert.strictEqual(H.search('orifice')[0].route, 'orifice');
      const burner = H.search('burner');
      assert.ok(burner.some((r) => r.route === 'flare') && burner.some((r) => r.kind === 'scenario' && r.id === 'FS-1'), JSON.stringify(burner.map((r) => r.title)));
      assert.ok(H.search('production pressure').slice(0, 3).some((r) => r.id === 'FS-1'), 'pressure terms find FS-1');
      assert.strictEqual(H.search('meter gas')[0].kind, 'task', 'a task title ranks first');
      const r0 = H.search('orifice')[0];
      assert.ok(/<mark>/i.test(r0.snippet) && r0.snippet.length < 400, 'snippet with marks');
      assert.ok(H.search('<b>x</b>').every((r) => !/<b>x/.test(r.snippet)), 'snippets escaped');
      // loose word lists (§2.4): words need not be adjacent; title words outrank a body-only hit
      assert.ok(H.search('bore transmitter').some((r) => r.route === 'orifice'), 'words in steps / inputs, not adjacent');
      const so = H.search('selection orifice'), fl = so.find((r) => r.route === 'flare');
      assert.strictEqual(so[0].route, 'orifice', JSON.stringify(so.map((r) => [r.title, r.score])));
      assert.ok(fl && so[0].score > fl.score, 'title words (6) above the body-only hit');
      // synonyms and short terms on word boundaries
      assert.ok(H.terms('category').indexOf('gas-oil ratio') === -1 && H.terms('source').indexOf('sour') === -1, 'no trigger inside a word');
      assert.ok(H.terms('gor').indexOf('gas-oil ratio') !== -1 && H.terms('h2s scavenger').indexOf('sour') !== -1, 'whole-word triggers expand');
      assert.ok(!H.search('gor').some((r) => r.route === 'flare'), '"gor" does not match inside "category"');
      // marks never land inside an escaped entity
      const amp = H.search('amp').find((r) => r.route === 'flare');
      assert.ok(amp && /<mark>Amp<\/mark> &amp; volt/.test(amp.snippet) && !/&<mark>|<mark>amp<\/mark>;/.test(amp.snippet), amp && amp.snippet);
      assert.ok(H.search('transmitter range')[0].secName === 'Inputs', 'section of the hit');
      // a blank line is a paragraph only where the caller wraps paragraphs
      assert.ok(!/<\/?p>/.test(H.md('a\n\nb')) && /a<br><br>b/.test(H.md('a\n\nb')));
      assert.ok(/<p>a<\/p><p>b<\/p>/.test(H.renderBlocks(['a\n\nb'], {})));
      assert.ok(/<li>a<br><br>b<\/li>/.test(H.renderBlocks([{ list: ['a\n\nb'] }], {})));
      // a route with no sidebar row goes to its plan group, not "Other"
      assert.ok(H.sidebarGroups().find((g) => g.label === 'Overview').routes.indexOf('releasenotes') !== -1);
      assert.ok(!H.sidebarGroups().some((g) => g.label === 'Other'));
      assert.ok(/Overview · /.test(H.renderGuide('releasenotes')), 'guide meta line');
      app.hook.nav('help');
      assert.strictEqual(app.el('help_q').getAttribute('role'), 'combobox');
      assert.strictEqual(app.el('help_q').getAttribute('type'), 'search');
      app.key(app.el('pgBody'), '/');
      assert.strictEqual(app.document.activeElement.id, 'help_q', '/ focuses the search');
      app.input('help_q', 'orifice');
      const box = app.el('help_res'), q = app.el('help_q');
      assert.ok(!box.hidden && box.getAttribute('role') === 'listbox' && box.querySelectorAll('[role=option]').length >= 1);
      assert.strictEqual(q.getAttribute('aria-expanded'), 'true');
      assert.ok(/Metering & Chokes/.test(txt(app.find('#help_res [role=option] small'))), 'module shown');
      app.input('help_q', 'transmitter range');
      assert.ok(/Metering & Chokes · Inputs/.test(txt(app.find('#help_res [role=option] small'))), 'module and section shown');
      app.input('help_q', 'orifice');
      app.key('help_q', 'ArrowDown');
      assert.strictEqual(q.getAttribute('aria-activedescendant'), 'help_opt_0');
      assert.strictEqual(app.el('help_opt_0').getAttribute('aria-selected'), 'true');
      app.key('help_q', 'Enter');
      assert.strictEqual(H.view().route, 'orifice');
      app.input('help_q', 'bean');
      app.key('help_q', 'Escape');
      assert.strictEqual(q.value, '');
      assert.ok(box.hidden);
      app.input('help_q', 'zzzz nothing');
      assert.ok(/No help topic matches/.test(txt(box)));
    },
  },
  {
    name: 'HELP page: unit tokens follow Metric mode ({{150|pressureG}} → 1034 kPa(g)), print shows both, decimal comma applied, PRiSM tokens stay field units',
    wp: WP, opts: false,
    run(_, assert, ctx) {
      const app = open(ctx), W = app.win, H = W.WTS_help;
      assert.ok(/150 psig/.test(H.md('{{150|pressureG}}')));
      W.WTS_units.setSystem('metric');
      assert.ok(/1034 kPa\(g\)/.test(H.md('{{150|pressureG}}')), H.md('{{150|pressureG}}'));
      assert.strictEqual(H.fmtU(150, 'pressureG', null, 'both'), '150 psig (1034 kPa(g))');
      assert.ok(/150 psig/.test(H.renderGuide('prism')), 'field-units guide renders imperial');
      W.WTS_a11y.decimalComma(true);
      assert.ok(/10,3 kPa\(g\)/.test(H.md('{{1.5|pressureG}}')), H.md('{{1.5|pressureG}}'));
      W.WTS_a11y.decimalComma(false);
      W.WTS_units.setSystem('imperial');
      assert.ok(/welltest\.h2oil\.co\.uk/.test(H.md('{{site}}')) && /software@h2oil\.co\.uk/.test(H.md('{{email}}')));
    },
  },
  {
    name: 'HELP page review round: open guide re-renders on a unit / decimal-comma change; sections clear the sticky bar; p* keeps its asterisk; tags do not break in tables; course / scenario shots use the item prefix',
    wp: WP, opts: false,
    run(_, assert, ctx) {
      const app = open(ctx), W = app.win, H = W.WTS_help;
      app.hook.nav('orifice');
      app.click('pgHelpBtn');
      assert.ok(/500 psig/.test(txt(app.el('help_main'))), 'imperial first');
      W.WTS_units.setSystem('metric');   // fires wts:unit-system-changed
      assert.ok(/kPa\(g\)/.test(txt(app.el('help_main'))) && !/500 psig/.test(txt(app.el('help_main'))), 'the open guide follows Metric mode without navigating away');
      W.WTS_units.setSystem('imperial');
      assert.ok(/500 psig/.test(txt(app.el('help_main'))), 'and back');
      const dc = app.el('wts_dec_comma');
      assert.ok(dc, '#wts_dec_comma toggle present');
      app.click(dc);
      assert.ok(W.WTS_a11y.decimalComma() && /4,026/.test(txt(app.el('help_main'))), 'decimal comma applied to the open guide');
      app.click(dc);
      assert.ok(/4\.026/.test(txt(app.el('help_main'))), 'decimal point again');
      // sticky bar: every jump target has scroll-margin-top from the measured bar height; the bar is static on phones
      const css = app.find('#help_root style').textContent;
      assert.ok(/\.help-sec,\.help-part,\.help-h,\.help dt\[id\],\.help \[id\^=help-\]\{scroll-margin-top:calc\(var\(--help-bar-h,84px\) \+ 8px\)\}/.test(css), 'scroll-margin-top');
      assert.ok(/@media \(max-width:700px\)\{[^@]*\.help-bar\{position:static/.test(css), 'not sticky on phones');
      assert.ok(/#help_pm\{width:auto/.test(css), 'Print ▾ keeps its own width');
      // search: p* survives, keyword snippets read as a list, the snippet prefers the body
      assert.ok(H.md('**Bold** p* `c`').indexOf('p*') !== -1);
      W.WTS_helpContent.guides.flare.what = ['The extrapolated pressure p* from a shut-in.'];
      W.WTS_helpContent.guides.flare.keywords = ['burner boom', 'sand', 'T-202'];
      W.WTS_units.setSystem('metric'); W.WTS_units.setSystem('imperial');   // the re-render also drops the search index
      const hit = H.search('p*').filter((h) => h.route === 'flare')[0];
      assert.ok(hit && /p\*/.test(hit.snippet), 'p* matches and keeps its asterisk: ' + JSON.stringify(hit));
      const kw = H.search('burner boom').filter((h) => h.route === 'flare')[0];
      assert.ok(kw && kw.snippet.indexOf(' ; ') === -1, 'no " ; " list in a snippet: ' + (kw && kw.snippet));
      // tables: tags wrapped so "V-101 in" does not break at the hyphen; never inside an attribute
      const t = H.renderBlocks([{ table: { head: ['a', 'b'], rows: [['V-101 in', '[[fs#FS-1|FS-1]] and PSHH-201']] } }], {});
      assert.ok(/<span class="help-nw">V-101 in<\/span>/.test(t) && /<span class="help-nw">PSHH-201<\/span>/.test(t), t);
      assert.ok(!/data-help-sec="<span/.test(t) && /data-help-sec="FS-1"/.test(t), 'attributes untouched');
      // course / scenario shots: <folder>/<slug(item id)>-<shot>-d.webp, as help-shots.js saves them
      W.WTS_helpManifest = { files: { 'scenarios/fs-1-rigup-d.webp': { w: 982, h: 488, h8: '12345678' } } };
      const b = H.renderBlocks([{ shot: 'rigup' }], {}, [{ id: 'rigup', alt: 'Rig-up', caption: 'Rig-up' }], 'scenarios', 'FS-1');
      assert.ok(/src="help\/img\/scenarios\/fs-1-rigup-d\.webp\?v=12345678"/.test(b), b);
      delete W.WTS_helpManifest;
    },
  },
  {
    name: 'HELP page: content is escaped (a "<img onerror>" string is rejected by the validator and rendered inert); markup subset and links render',
    wp: WP, opts: false,
    run(_, assert, ctx) {
      const app = open(ctx), H = app.win.WTS_help, C = H.load();
      const bad = '<img src=x onerror=alert(1)>';
      const lib = require('./help-content.test.js').lib;
      assert.ok(lib.textIssues(bad, 'x', null).length > 0, 'validator rejects it');
      C.guides.zzx = { route: 'zzx', units: 'dual', purpose: bad, what: ['**' + bad + '** [[orifice]] [[glossary#bean|bean]] `code` ③'] };
      const h = H.renderGuide('zzx');
      assert.ok(h.indexOf('<img src=x') === -1 && h.indexOf('&lt;img src=x onerror=alert(1)&gt;') !== -1, 'inert');
      assert.ok(/data-help-go="orifice"[^>]*>Orifice Plate Selection</.test(h), 'route link with the page title');
      assert.ok(/data-help-go="glossary" data-help-sec="bean"/.test(h) && /<code>code<\/code>/.test(h) && /class="help-co"[^>]*>3</.test(h));
      delete C.guides.zzx;
      const g = H.renderGuide('orifice');
      ['what', 'when', 'steps', 'inputs', 'results', 'example', 'tips', 'refs', 'related'].forEach((s) => assert.ok(g.indexOf('id="help-orifice-' + s + '"') !== -1, s));
      assert.ok(/In Metric mode the page shows the same values converted/.test(g));
      assert.ok(/Reviewed for v3\.3\.2/.test(g));
    },
  },
  {
    name: 'HELP page: screenshots — caption box without a manifest entry, <picture> with a hashed src when present, image error → missing box + one notice; lightbox opens and closes with focus back',
    wp: WP, opts: false,
    run(_, assert, ctx) {
      const app = open(ctx), W = app.win;
      app.hook.nav('orifice');
      app.click('pgHelpBtn');
      assert.ok(app.findAll('#help_main .help-shot-missing').length === 2, 'both shots shown as caption boxes');
      assert.ok(/Orifice Plate Selection with the default inputs/.test(txt(app.find('#help_main .help-shot-missing'))), 'the box shows the alt text');
      assert.ok(!/The page as it opens/.test(txt(app.find('#help_main .help-shot-missing'))), 'the caption is not repeated in the box');
      assert.strictEqual(txt(app.find('#help_main .help-fig figcaption')), 'The page as it opens', 'the caption stays in the figcaption');
      W.WTS_helpManifest = { files: { 'orifice/view-d.webp': { w: 1280, h: 800, bytes: 90000, h8: 'abcd1234' }, 'orifice/view-p.webp': { w: 780, h: 1688, bytes: 60000, h8: 'ef567890' } } };
      W.WTS_help.goTo('orifice');
      const img = app.find('#help_main img.help-img');
      assert.strictEqual(img.getAttribute('src'), 'help/img/orifice/view-d.webp?v=abcd1234');
      assert.strictEqual(app.find('#help_main picture source').getAttribute('srcset'), 'help/img/orifice/view-p.webp?v=ef567890');
      assert.ok(img.getAttribute('alt') && img.getAttribute('width') === '1280' && img.getAttribute('loading') === 'lazy');
      app.click(img);
      const lb = app.el('help_lb');
      assert.ok(lb.hasAttribute('open'), 'lightbox open');
      assert.strictEqual(app.el('help_lb_img').getAttribute('src'), img.getAttribute('src'));
      app.key('help_lb_x', 'Escape');
      assert.ok(!lb.hasAttribute('open'), 'Esc closes');
      assert.strictEqual(app.document.activeElement, img, 'focus back on the image');
      app.key(img, 'Enter');
      assert.ok(lb.hasAttribute('open'), 'Enter opens');
      app.click('help_lb_x');
      assert.ok(!lb.hasAttribute('open'), '✕ closes');
      W.WTS_helpManifest = { files: { 'orifice/res-d.webp': { w: 987, h: 563, bytes: 9000, h8: '0badf00d' } } };   // desktop crop only, with call-outs
      W.WTS_help.goTo('orifice');
      const crop = app.find('#help_main img.help-img');
      assert.ok(crop && app.find('#help_main .help-enlarge'), 'a desktop-only crop with call-outs offers "Select to enlarge"');
      app.fire(crop, 'error');
      assert.ok(!app.find('#help_main .help-enlarge'), 'nothing left to enlarge after the image fails');
      W.WTS_helpManifest = { files: { 'orifice/view-d.webp': { w: 1280, h: 800, bytes: 90000, h8: 'abcd1234' }, 'orifice/view-p.webp': { w: 780, h: 1688, bytes: 60000, h8: 'ef567890' } } };
      W.WTS_help.goTo('orifice');
      app.fire(app.find('#help_main img.help-img'), 'error');
      assert.ok(!app.find('#help_main img.help-img'), 'broken image replaced');
      assert.strictEqual(app.findAll('#help_main .help-shot-missing').length, 2);
      assert.ok(/Screenshots are not available in this copy/.test(txt(app.el('help_noimg'))));
      W.WTS_helpManifest = { files: { 'orifice/view-d.webp': { w: 1280, h: 800, bytes: 1048576, h8: 'abcd1234' } } };
      W.WTS_help.goTo('landing');
      assert.ok(/Download screenshots for offline use \(≈ 1 MB\)/.test(txt(app.el('help_offline'))));
      W.WTS_helpManifest = { bytes: 7776956, files: { 'orifice/view-d.webp': { w: 1280, h: 800, h8: 'abcd1234' } } };   // the generated module: rows + total
      W.WTS_help.goTo('landing');
      assert.ok(/\(≈ 7\.4 MB\)/.test(txt(app.el('help_offline'))), 'size from the module total: ' + txt(app.el('help_offline')));
      W.WTS_helpManifest = { files: { 'orifice/view-d.webp': { w: 1280, h: 800, h8: 'abcd1234' } } };
      W.WTS_help.goTo('landing');
      assert.strictEqual(txt(app.el('help_offline')), 'Download screenshots for offline use', 'no "≈ 0 MB" when the size is unknown');
      delete W.WTS_helpManifest;
    },
  },
  {
    name: 'HELP page: contents follow the sidebar order; phones get a closed Contents <details>; Field scenarios follow WTS_sim.features; no timers after 5 s',
    wp: WP, opts: false,
    run(_, assert, ctx) {
      const app = open(ctx), W = app.win;
      app.hook.nav('help');
      const toc = app.findAll('#help_toc_nav .help-a[data-help-go]').map((b) => b.getAttribute('data-help-go'));
      const order = ['start', 'tasks', 'releasenotes', 'orifice', 'wts', 'prism', 'flare', 'scenarios', 'glossary'];
      assert.deepStrictEqual(toc, order);
      assert.ok(app.el('help_toc').hasAttribute('open'), 'desktop: contents open');
      const feat = W.WTS_sim && W.WTS_sim.features;   // the simulator ships the features since v1.5.0: hide them for the today variant
      if (W.WTS_sim) W.WTS_sim.features = undefined;
      W.WTS_help.goTo('scenarios');
      assert.ok(/Switch V-101 out today/.test(txt(app.el('help_main'))) && !/bypass destination/.test(txt(app.el('help_main'))), 'today variant');
      W.WTS_sim = Object.assign(W.WTS_sim || {}, { features: { bypassDest: true } });
      W.WTS_help.goTo('scenarios');
      assert.ok(/Choose the bypass destination/.test(txt(app.el('help_main'))), 'after-WP-SIM variant by feature detection');
      W.WTS_sim.features = feat;
      app.hook.nav('home');
      app.flush(5000);
      assert.strictEqual(app.pendingTimers(), 0, 'no pending timers: ' + JSON.stringify(app.timers()).slice(0, 300));
      const ph = open(ctx, { viewport: { width: 390, height: 844 } });
      ph.hook.nav('help');
      assert.ok(!ph.el('help_toc').hasAttribute('open'), 'phone: contents closed');
      ph.hook.nav('orifice');
      ph.click('pgHelpBtn');
      ph.flush(5000);
      assert.strictEqual(ph.pendingTimers(), 0, 'no pending timers on the phone path');
    },
  },
];
