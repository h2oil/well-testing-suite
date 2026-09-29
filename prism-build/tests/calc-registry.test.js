// Plug-in calculator registry (Round-9) — contract tests.
//
// Builds the app from sources with IN-MEMORY calculator files (sourceOverrides
// named 4N-calc-*.js, which never exist on disk) and checks that the host picks
// them up with no route-table, sidebar or dashboard edit:
//   • concat-round9 discovery (pattern + numeric order) and inject-round9
//     idempotency / CRLF handling;
//   • sidebar button in the matching nav group (new group before the footer),
//     active state, render() fallback + pgTitle/pgSub, dashboard tile;
//   • universal autosave (wts_page_<key>) + reload restore, PDF export, the
//     Quick Report snapshot/job report, metric units via WTS_units.tagInput;
//   • bad entries (built-in key, key mismatch, no render, throwing render)
//     are ignored or contained.
'use strict';

const path = require('path');
const WP = 'REG';

// A minimal calculator that follows the documented file contract exactly.
const PROBE = [
  '// 49-calc-zzprobe.js — in-memory registry probe (tests only)',
  '(function () {',
  "    'use strict';",
  "    var G = (typeof window !== 'undefined') ? window : globalThis;",
  "    function _byId(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }",
  "    function _num(id) { var e = _byId(id); if (!e) return NaN; var s = String(e.value).trim(); return s === '' ? NaN : parseFloat(s); }",
  '    function _tag(map) { var U = G.WTS_units; if (!U || !U.tagInput) return; for (var id in map) U.tagInput(id, map[id]); }',
  '    function _canon(fn) { var U = G.WTS_units; return (U && U.runCanonical) ? U.runCanonical(fn) : fn(); }',
  '    G.WTS_zzprobe_compute = function (inp) { return { ok: isFinite(inp.p) && inp.p > 0, twice: 2 * inp.p }; };',
  '    function _calc() {',
  "        var p = _num('zp_p'), r = G.WTS_zzprobe_compute({ p: p }), res = _byId('zp_res');",
  '        if (!res) return r;',
  "        if (!r.ok) { res.innerHTML = '<div class=\"val-error\"><strong>Please fix the following:</strong><ul><li>Pressure must be above 0.</li></ul></div>'; return r; }",
  "        res.innerHTML = '<div class=\"rbox\"><div class=\"rbox-title\">Probe Result</div>' +",
  "            '<div class=\"rrow\"><span class=\"rl\">Twice the pressure</span><span class=\"rv\">' + r.twice.toFixed(1) + ' psia</span></div></div>' +",
  "            '<div style=\"color:var(--green)\">\\u2713 Probe verdict ok.</div>';",
  "        res.setAttribute('data-done', '1');",
  '        G.WTS_state = G.WTS_state || {};',
  '        G.WTS_state.zzprobe = { p: p, twice: r.twice, ts: Date.now() };',
  '        return r;',
  '    }',
  '    G.calcZzProbe = function () { return _canon(_calc); };',
  '    function render(body) {',
  "        body.innerHTML = '<div id=\"zp_root\"><div class=\"cols-2\"><div><div class=\"card\"><div class=\"card-title\">Probe Inputs</div><div class=\"fg\">' +",
  "            '<div class=\"fg-item\"><label>Reservoir pressure, absolute (psia)</label><input type=\"number\" id=\"zp_p\" value=\"1000\"></div>' +",
  "            '<div class=\"fg-item\"><label>Note count</label><input type=\"number\" id=\"zp_n\" value=\"3\"></div>' +",
  "            '</div><div class=\"btn-row\"><button class=\"btn btn-primary\" id=\"zp_go\" onclick=\"calcZzProbe()\">Calculate</button></div></div></div>' +",
  "            '<div id=\"zp_res\"></div></div></div>';",
  "        _tag({ zp_p: 'pressure' });",
  "        _byId('zp_root').addEventListener('change', function (e) { if (e.target && /^zp_/.test(e.target.id || '')) G.calcZzProbe(); });",
  '        G.calcZzProbe();',
  '    }',
  '    G.WTS_calcRegistry = G.WTS_calcRegistry || {};',
  '    G.WTS_calcRegistry.zzprobe = {',
  "        key: 'zzprobe', title: 'Registry Probe', sub: 'In-memory plug-in calculator used by the registry tests',",
  "        group: 'Production & Reservoir', icon: '&#8599;', desc: 'Probe tile for the registry tests.', render: render",
  '    };',
  "    if (typeof document !== 'undefined' && document.addEventListener) {",
  "        document.addEventListener('wts:unit-system-changed', function () { var r = _byId('zp_res'); if (r && r.getAttribute('data-done') === '1') G.calcZzProbe(); });",
  '    }',
  '})();',
  '',
  '// === SELF-TEST ===',
  "(function () { if (typeof window === 'undefined') return; if (window.WTS_zzprobe_compute({ p: 5 }).twice !== 10) throw new Error('probe self-test'); window.__zzprobeSelfTestRan = true; })();",
  '',
].join('\n');

// A calculator in a group that does not exist yet + the misuse cases.
const MISC = [
  '(function () {',
  "    'use strict';",
  '    var R = window.WTS_calcRegistry = window.WTS_calcRegistry || {};',
  "    R.zzgroup = { key: 'zzgroup', title: 'Group Probe', sub: 'New nav group', group: 'Probe Group', icon: '<b>x</b>',",
  "                  render: function (body) { body.innerHTML = '<div id=\"zg_root\"><div class=\"card\"><div class=\"card-title\">Group</div></div></div>'; } };",
  "    R.aga3 = { key: 'aga3', title: 'Hijack', group: 'Well Testing', render: function (body) { body.innerHTML = '<div id=\"hijack\"></div>'; } };",
  "    R.zzmismatch = { key: 'other', title: 'Mismatch', group: 'Well Testing', render: function () {} };",
  "    R.zznorender = { key: 'zznorender', title: 'No render', group: 'Well Testing' };",
  "    R['Bad-Key'] = { title: 'Bad key', group: 'Well Testing', render: function () {} };",
  "    R.zzboom = { key: 'zzboom', title: 'Boom <Probe>', group: 'Probe Group', render: function () { throw new Error('boom'); } };",
  '})();',
  '',
  '// === SELF-TEST ===',
  '',
].join('\n');

const OVERRIDES = { '49-calc-zzprobe.js': PROBE, '47-calc-zzmisc.js': MISC };
const OPTS = { sourceOverrides: OVERRIDES, fromSources: true };

const navBtn = (app, key) => app.find('.nav-btn[data-p="' + key + '"]');
const groupLabel = (btn) => {
  const g = btn && btn.closest('.nav-group');
  const l = g && g.querySelector('.nav-group-label');
  return l ? String(l.textContent).trim() : null;
};
const text = (el) => String(el ? el.textContent : '').trim();

module.exports = [
  {
    name: 'concat-round9 discovers 4N-calc-*.js in numeric order; inject-round9 is idempotent and CRLF-aware',
    wp: WP,
    opts: false,
    run(app, assert) {
      const concat = require(path.join(__dirname, '..', 'concat-round9.js'));
      const inject = require(path.join(__dirname, '..', 'inject-round9.js'));
      const listed = concat.listFiles(['45-calc-b.js', '41-calc-a.js', '4-calc-x.js', '39-gas.js', '40-oil-ipr.js', '50-calc-z.js', '41-calc-a.js']);
      const mine = listed.filter((f) => /-calc-(a|b|x|z)\.js$/.test(f));
      assert.deepStrictEqual(mine, ['41-calc-a.js', '45-calc-b.js'], 'pattern + numeric order + dedupe');
      assert(!listed.includes('40-oil-ipr.js') && !listed.includes('39-gas.js'), 'non-calc names are not picked up');
      const warns = [];
      const blob = concat.build({ read: (f) => (OVERRIDES[f] != null ? OVERRIDES[f] : null), extraFiles: Object.keys(OVERRIDES),
                                  log: { log() {}, warn: (m) => warns.push(m) } });
      assert(blob.indexOf('BEGIN 47-calc-zzmisc') !== -1 && blob.indexOf('BEGIN 47-calc-zzmisc') < blob.indexOf('BEGIN 49-calc-zzprobe'), '47 before 49');
      assert(blob.indexOf('__zzprobeSelfTestRan') === -1, 'self-test stripped');
      const host = ['a', '// ── PRiSM Round-8 injection END ──', 'b', ''].join('\r\n');
      const r1 = inject.inject(host, blob);
      assert.strictEqual(r1.mode, 'insert');
      assert(!/[^\r]\n/.test(r1.out), 'CRLF preserved');
      assert(r1.out.indexOf(inject.START) > r1.out.indexOf('Round-8 injection END'), 'after Round-8 END');
      const r2 = inject.inject(r1.out, blob);
      assert.strictEqual(r2.mode, 'replace');
      assert.strictEqual(r2.out, r1.out, 'second run is a no-op');
      assert.throws(() => inject.inject('no anchor here', blob));
    },
  },
  {
    name: 'registry calculators get a sidebar button in their group, route, title and dashboard tile',
    wp: WP,
    opts: OPTS,
    run(app, assert) {
      const W = app.win;
      assert.strictEqual(typeof W.WTS_calcRegistry, 'object', 'window.WTS_calcRegistry');
      assert(app.build.html.indexOf('// ── Round-9 (calculators) injection START ──') !== -1, 'round 9 built in memory');
      // Sidebar
      const b = navBtn(app, 'zzprobe');
      assert(b, 'zzprobe nav button');
      assert.strictEqual(groupLabel(b), 'Production & Reservoir');
      assert.strictEqual(b.parentNode.lastElementChild, b, 'appended at the end of its group');
      assert.strictEqual(text(b.querySelector('.nav-icon')), '↗');
      const g = navBtn(app, 'zzgroup');
      assert.strictEqual(groupLabel(g), 'Probe Group', 'missing group created');
      const grp = g.closest('.nav-group');
      assert(grp.nextElementSibling && grp.nextElementSibling.classList.contains('sidebar-footer'), 'new group sits before the footer');
      assert.strictEqual(text(g.querySelector('.nav-icon')), '◆', 'unsafe icon replaced by the default');
      assert.strictEqual(app.findAll('.nav-btn[data-p="aga3"]').length, 1, 'built-in key not duplicated');
      ['zzmismatch', 'zznorender', 'other', 'Bad-Key'].forEach((k) => assert(!navBtn(app, k), 'no button for ' + k));
      // Route + title + active state + export buttons
      app.click(b);
      assert.strictEqual(app.hook.page(), 'zzprobe');
      assert.strictEqual(text(app.el('pgTitle')), 'Registry Probe');
      assert.strictEqual(text(app.el('pgSub')), 'In-memory plug-in calculator used by the registry tests');
      assert(app.el('zp_root') && app.el('zp_res').getAttribute('data-done') === '1', 'rendered + calculated');
      assert(b.classList.contains('active') && !navBtn(app, 'clientinfo').classList.contains('active'), 'active state');
      assert.strictEqual(app.el('exportBtns').style.display, 'flex');
      assert.strictEqual(W.WTS_state.zzprobe.twice, 2000);
      // Built-in collision: the host page wins
      app.hook.nav('aga3');
      assert(!app.el('hijack'), 'registry cannot shadow a built-in route');
      assert(app.logs.some((l) => l.level === 'warn' && /"aga3" is a built-in route/.test(l.text)), 'collision warned');
      // Throwing render is contained
      app.click(navBtn(app, 'zzboom'));
      assert.strictEqual(text(app.el('pgTitle')), 'Boom <Probe>');
      assert(/failed to load/.test(text(app.el('pgBody'))), 'error card');
      assert(app.el('pgBody').innerHTML.indexOf('Boom &lt;Probe&gt;') !== -1, 'title escaped');
      // Dashboard tile, slotted in sidebar order
      app.hook.nav('home');
      const cards = app.findAll('.dash-card');
      const titles = cards.map((c) => text(c.querySelector('h3')));
      const i = titles.indexOf('Registry Probe');
      assert(i !== -1, 'dashboard tile');
      assert(i > titles.indexOf('PRiSM — Well Test Analysis') && i < titles.indexOf('Separator Retention'), 'tile in sidebar order: ' + titles.slice(i - 1, i + 2).join(' | '));
      assert.strictEqual(text(cards[i].querySelector('.dc-badge')), 'Production');
      assert(cards[i].querySelector('.dc-badge').classList.contains('dc-b-green'));
      assert(titles.indexOf('Group Probe') === titles.length - 2 || titles.indexOf('Group Probe') === titles.length - 1, 'new-group tiles last');
      app.click(cards[i]);
      assert.strictEqual(app.hook.page(), 'zzprobe', 'tile navigates');
    },
  },
  {
    name: 'registry pages autosave to wts_page_<key>, restore after reload, and feed the PDF export + Quick Report',
    wp: WP,
    opts: OPTS,
    run(app, assert) {
      app.click(navBtn(app, 'zzprobe'));
      app.input('zp_p', '1234');
      assert.strictEqual(app.win.WTS_state.zzprobe.twice, 2468);
      app.flush(1200);   // autosave (300 ms) + report snapshot (900 ms)
      const rec = JSON.parse(app.storage.getItem('wts_page_zzprobe') || 'null');
      assert(rec && rec.f && rec.f.zp_p === '1234', 'autosaved: ' + JSON.stringify(rec));
      const snaps = JSON.parse(app.storage.getItem('wts_report_snapshots') || '{}');
      assert(snaps.zzprobe && snaps.zzprobe.title === 'Registry Probe', 'report snapshot captured');
      const res = JSON.stringify(snaps.zzprobe.results);
      assert(res.indexOf('Twice the pressure') !== -1 && res.indexOf('2468.0 psia') !== -1, 'snapshot results: ' + res.slice(0, 300));
      // Page PDF
      const n0 = app.opened.length;
      app.win.exportPagePDF();
      const pdf = app.opened[n0] && app.opened[n0].html();
      assert(pdf && pdf.indexOf('Registry Probe') !== -1 && pdf.indexOf('Twice the pressure') !== -1 && pdf.indexOf('Probe verdict ok') !== -1, 'page PDF has title, result and verdict');
      // Quick Report (job report) — registry page listed
      const n1 = app.opened.length;
      app.win.WTS_exportJobReport();
      const job = app.opened[n1] && app.opened[n1].html();
      assert(job && job.indexOf('Registry Probe') !== -1 && job.indexOf('2468.0 psia') !== -1, 'Quick Report includes the registry page');
      // Reload → navigate → value restored and recalculated
      const app2 = app.reload();
      try {
        app2.click(navBtn(app2, 'zzprobe'));
        assert.strictEqual(app2.el('zp_p').value, '1234', 'restored');
        assert.strictEqual(app2.win.WTS_state.zzprobe.twice, 2468, 'recalculated on restore');
        app2.flushUntilIdle(10000);
        assert.strictEqual(app2.pendingTimers(), 0, 'no timers left');
      } finally { app2.dispose(); }
    },
  },
  {
    name: 'registry pages work in metric: tagged input shows kPa, calc stays canonical imperial',
    wp: WP,
    opts: OPTS,
    run(app, assert) {
      const U = app.win.WTS_units;
      app.flush(10);     // units bootstrap
      U.setSystem('metric');
      try {
        app.click(navBtn(app, 'zzprobe'));
        const lab = app.el('zp_p').closest('.fg-item').querySelector('label');
        assert(/\(kPa\)/.test(text(lab)), 'label: ' + text(lab));
        assert.rel(parseFloat(U.displayValue(app.el('zp_p'))), 6894.757, 1e-3, 'shown in kPa');
        assert.rel(app.win.WTS_state.zzprobe.twice, 2000, 1e-9, 'canonical calc');
        app.input('zp_p', '10000');   // 10 000 kPa = 1450.38 psi
        assert.rel(app.win.WTS_state.zzprobe.p, 1450.377, 1e-4, 'metric entry converted');
      } finally { U.setSystem('imperial'); }
      assert.rel(app.win.WTS_state.zzprobe.p, 1450.377, 1e-4, 'recalc on unit flip keeps the physical value');
    },
  },
  {
    name: 'registry pages work at 375 px (sidebar button reachable, page renders)',
    wp: WP,
    opts: Object.assign({ viewport: { width: 375, height: 812 } }, OPTS),
    run(app, assert) {
      const b = navBtn(app, 'zzprobe');
      assert(b && b.closest('#sidebar'), 'button inside the mobile sidebar');
      app.click(b);
      assert(app.el('zp_res') && app.el('zp_res').querySelector('.rrow'), 'rendered at 375 px');
    },
  },
];
