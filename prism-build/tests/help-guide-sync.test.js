// Printable User Guide — docs/HELP-GUIDE-PLAN.md §5 and §7.4 (WP-G).
//
// 1. Sync: `build-user-guide.js --check` passes — the committed help/user-guide.html is what the current content and
//    manifest generate (byte for byte, LF only, dated from RELEASE_NOTES[0].date), and it has every chapter (Getting
//    started, the nine sidebar groups, the simulator, field scenarios, appendices A–D); every image in it is in the manifest.
// 2. The book and the in-app print on fixed fixture content (every real 48-calc-help-*.js content file is left out, so
//    the checks do not depend on what the writers have shipped): chapter numbers, contents, [[links]] as chapter
//    references ("see Chapter N.M": no browser engine prints CSS target-counter() page numbers, so none are asserted),
//    the simulator chapter (exercises without answers, then all answers, then all trainer notes), appendices, quick card,
//    worksheet, Images off, data-URI images and caption boxes for missing ones, the Print ▾ menu per view, the iOS reader,
//    and the on-screen Help page reading the generated (WP-S, rows-only) manifest module.
'use strict';

const fs = require('fs');
const path = require('path');
const harness = require('./_harness');
const UG = require('../build-user-guide');
const HS = require('../help-shots');
const MODEL = require('./_help-model');

const WP = 'HELP';
const GROUPS = ['Overview', 'Metering & Chokes', 'Well Test & Flowlines', 'Production & Reservoir', 'Live Data', 'Test System Safety',
  'Separation & Process', 'Flare & Relief', 'Fluids & Utilities'];
const CONTENT = ['start', 'overview', 'metering', 'welltest', 'simcourse', 'production', 'livedata', 'safety', 'process', 'flare', 'utilities']
  .map((g) => '48-calc-help-' + g + '.js');
const ex = (id, title, q) => ({ id, title, goal: 'Goal of ' + id + '.', setup: ['Restore full rig-up.'], steps: ['Select **Reset**.'], observe: ['The HUD.'],
  questions: q, answers: ['Answer of ' + id + '.'], trainer: { duration: '20 min', fault: 'Faults → LCV-101 stuck closed at 10 min.', good: 'Spots the rising level.',
    mistakes: ['Resets too early.'], debrief: ['Why?', 'What next?', 'What changed?'] } });
const FIX = {
  guides: {
    orifice: Object.assign({}, MODEL.ORIFICE, { cardShot: 'res' }),
    flare: { route: 'flare', reviewed: 'v3.3.2', units: 'dual', purpose: 'Radiation from the burner boom.', what: ['See [[orifice]], [[orifice#inputs|the orifice inputs]] and [[glossary#bean|the bean]].'],
      when: ['a', 'b'], steps: ['one', 'two', 'three'], refs: [{ std: 'API STD 521', note: 'radiation' }, { std: 'AGA Report No. 3 / API MPMS Ch. 14.3' }, { std: 'API STD 521; ISO 23251' }], related: ['orifice', 'prv'] },
    wts: { route: 'wts', reviewed: 'v3.3.2', units: 'dual', purpose: 'Dynamic replay around a steady design calculation.', what: ['See [[fs#FS-1|FS-1]] and [[course#ex2|exercise 2]].'],
      parts: [{ id: 'reference', title: 'Reference', what: ['The reference.'], steps: ['Select **Run**.', 'b', 'c'] }] },
  },
  start: [{ id: 'screen', title: 'The screen', body: ['The sidebar has nine groups. See [[task#meter|Meter gas]].'] }, { id: 'keyboard', title: 'Keyboard and accessibility', body: ['Tab order.'] }],
  tasks: [{ id: 'meter', title: 'Meter gas', purpose: 'From the plate to the meter factor.', steps: [{ route: 'orifice', t: 'Choose the plate.', carry: 'plate and DP range' }] }],
  course: [ex('ex1', 'Normal test', ['Where is the separator pressure?']), ex('ex2', 'Choke capacity', ['What limits the rate?', 'Why the gas rate?'])],
  scenarios: [{ id: 'FS-1', title: 'Unloading the cushion to the burner boom', intro: ['Which pressure goes where.'], today: ['Switch V-101 out.'],
    blocks: [{ details: { summary: 'Why', body: ['Because.'] } }], afterSim: ['Choose the bypass destination.'], feature: 'bypassDest' }],
  glossary: { bean: { term: 'bean', def: 'Choke size in 64ths of an inch.' } },
  faq: [{ id: 'reset', q: 'How do I reset a page?', a: ['Use **Reset**.'] }],
};
const FIX_SRC = '(function () { var G = window; G.WTS_helpContent = G.WTS_helpContent || { guides: {}, factories: [] };\n' +
  "G.WTS_helpContent.factories.push({ group: 'zztest', routes: ['orifice', 'flare', 'wts'], build: function () { return " + JSON.stringify(FIX) + '; } });\n})();\n';
// the generated manifest module (WP-S form: per-folder rows); orifice/view has a phone file too
const MAN = HS.moduleSource({ files: [
  { file: 'orifice/view-d.webp', w: 1280, h: 800, sha256: 'abcdef0123' }, { file: 'orifice/view-p.webp', w: 780, h: 1688, sha256: '99887766aa' },
  { file: 'orifice/res-d.webp', w: 812, h: 430, sha256: '1a2b3c4d55' }] });
const OVERRIDES = Object.assign({ '48-calc-help-zztest.js': FIX_SRC, '48-calc-help-manifest.js': MAN }, ...CONTENT.map((f) => ({ [f]: null })));

let _fix = null;
function fixture() {
  if (!_fix) { const r = UG.build({ overrides: OVERRIDES }); _fix = { book: r.html, html: r.app.html, app: r.app }; }
  return _fix;
}
const openApp = (ctx) => ctx.loadApp({ html: require('../help-host-patch').patch(fixture().html) });
const ids = (h) => new Set((h.match(/\bid="([^"]+)"/g) || []).map((m) => m.slice(4, -1)));

module.exports = [
  {
    name: 'HELP guide sync: build-user-guide.js --check passes; help/user-guide.html has every chapter and only manifest images, LF, dated from RELEASE_NOTES[0]',
    wp: WP, opts: false,
    run(_, assert) {
      const r = UG.check();
      assert.ok(r.committed != null, 'help/user-guide.html is committed');
      assert.ok(r.ok, 'help/user-guide.html is out of date: run node prism-build/build-user-guide.js');
      const h = r.committed;
      assert.ok(!/\r/.test(h), 'LF only');
      assert.ok(/^<!DOCTYPE html>\n/.test(h) && /GENERATED by prism-build\/build-user-guide\.js/.test(h));
      const titles = (h.match(/<section class="bk-ch" id="[^"]+"><h2>([^<]+)<\/h2>/g) || []).map((s) => s.replace(/^.*<h2>|<\/h2>$/g, '').replace(/&amp;/g, '&'));
      assert.deepStrictEqual(titles, ['1 Getting started'].concat(GROUPS.map((g, i) => (i + 2) + ' ' + g), ['11 Well Test Simulator', '12 Field scenarios',
        'Appendix A Standards index', 'Appendix B Glossary', 'Appendix C Keyboard shortcuts', 'Appendix D Troubleshooting and FAQ']));
      const html = fs.readFileSync(harness.HTML_PATH, 'utf8');
      const rn = /const RELEASE_NOTES = \[\s*\{ ver:'([^']+)', date:'([^']+)'/.exec(html);
      if (rn) assert.ok(h.indexOf('Version ' + rn[1].replace(/^v/, '') + ' · ' + rn[2]) !== -1, 'version and date from RELEASE_NOTES[0]');
      const man = JSON.parse(fs.readFileSync(path.join(harness.REPO, 'help', 'img', 'manifest.json'), 'utf8'));
      const known = new Set((man.files || []).map((e) => e.file));
      const used = (h.match(/(?:src|srcset)="img\/([^"?]+)/g) || []).map((s) => s.replace(/^.*img\//, ''));
      used.forEach((f) => assert.ok(known.has(f), 'image ' + f + ' in the manifest'));
      used.forEach((f) => assert.ok(fs.existsSync(path.join(harness.REPO, 'help', 'img', f)), 'image file ' + f));
      assert.ok(!/<button|<script|\son[a-z]+="/i.test(h), 'no buttons, scripts or handlers in the printed guide');
    },
  },
  {
    name: 'HELP guide: the book — numbered chapters and guides, linked contents, [[links]] → "(see Chapter N.M)" to the section, details open, no lazy images, byte-stable',
    wp: WP, opts: false,
    run(_, assert) {
      const h = fixture().book;
      assert.strictEqual(UG.build({ overrides: OVERRIDES }).html, h, 'a second build is byte-identical');
      assert.ok(/<h1>Well Testing Suite — User Guide<\/h1>/.test(h) && /welltest\.h2oil\.co\.uk/.test(h));
      assert.ok(/<span class="bk-n">3\.1<\/span> Orifice Plate Selection/.test(h), 'orifice is 3.1 (Metering & Chokes)');
      assert.ok(/<span class="bk-n">9\.1<\/span> Flare/.test(h), 'flare is 9.1 (Flare & Relief)');
      assert.ok(/<span class="bk-n">11\.1<\/span>/.test(h) && h.indexOf('id="help-wts-top"') > h.indexOf('id="bk-ch-11"'), 'the simulator reference opens chapter 11');
      assert.ok(/<li><a href="#help-orifice-top">3\.1 Orifice Plate Selection<\/a><\/li>/.test(h), 'contents lists the guide');
      // every internal href resolves
      const all = ids(h);
      (h.match(/href="#([^"]+)"/g) || []).forEach((m) => assert.ok(all.has(m.slice(7, -1)), 'anchor ' + m));
      assert.ok(/Orifice Plate Selection \(see <a class="bk-x" href="#help-orifice-top">Chapter 3\.1<\/a>\)/.test(h), 'route link');
      assert.ok(/the bean \(see <a class="bk-x" href="#help-glossary-bean">Appendix B<\/a>\)/.test(h), 'glossary link');
      assert.ok(/FS-1 \(see <a class="bk-x" href="#help-fs-FS-1">Chapter 12<\/a>\)/.test(h), 'scenario link');
      assert.ok(/exercise 2 \(see <a class="bk-x" href="#help-course-ex2">Chapter 11<\/a>\)/.test(h), 'course link');
      assert.ok(/the orifice inputs \(see <a class="bk-x" href="#help-orifice-inputs">Chapter 3\.1<\/a>\)/.test(h), 'route#section link goes to the section');
      assert.ok(!/target-counter|leader\(/.test(h) && /@page\{size:A4/.test(h), 'no page-number CSS that no engine prints; A4');
      assert.ok(/<img /.test(h) && !/loading="lazy"|decoding="async"/.test(h), 'no lazy images in the printed book (page.pdf would skip them)');
      assert.ok(/\.bk-ch[^{]*\{break-before:page\}/.test(h), 'a page break per chapter');
      assert.ok(!/<button/.test(h) && !/Open this page/.test(h), 'no buttons or "Open this page" in print');
      assert.ok(/<details class="help-det" open>/.test(h) && !/<details class="help-det">/.test(h), 'details print open');
      assert.ok(/150 psig \(1034 kPa\(g\)\)|500 psig \(3447 kPa\(g\)\)/.test(h), 'unit tokens print both systems');
      assert.ok(/src="img\/orifice\/view-d\.webp\?v=abcdef01"/.test(h) && /srcset="img\/orifice\/view-p\.webp\?v=99887766"/.test(h), 'images relative to help/, hashed');
    },
  },
  {
    name: 'HELP guide: simulator chapter — exercises without answers, then all answers, then all trainer notes; scenario variant per WTS_sim.features; appendices',
    wp: WP, opts: false,
    run(_, assert) {
      const h = fixture().book;
      const c11 = h.slice(h.indexOf('id="bk-ch-11"'), h.indexOf('id="bk-ch-12"'));
      const ans = c11.indexOf('<h3>Answers</h3>'), tn = c11.indexOf('<h3>Trainer notes</h3>');
      assert.ok(ans > 0 && tn > ans, 'answers section, then trainer notes');
      assert.ok(c11.indexOf('Goal of ex2') < ans && c11.indexOf('Goal of ex1') < c11.indexOf('Goal of ex2'), 'exercises first');
      const A = c11.slice(ans, tn), T = c11.slice(tn);
      assert.ok(A.indexOf('Answer of ex1') !== -1 && A.indexOf('Answer of ex1') < A.indexOf('Answer of ex2') && c11.slice(0, ans).indexOf('Answer of ex') === -1, 'all answers together');
      assert.ok(/<h4>1 Normal test<\/h4>/.test(A) && /<h4>2 Choke capacity<\/h4>/.test(T), 'each answer and note under its exercise');
      assert.ok(T.indexOf('Answer of ex') === -1 && A.indexOf('Duration') === -1, 'answers and trainer notes not interleaved');
      assert.ok(/Duration:<\/b> 20 min/.test(T) && /Fault to inject:<\/b>/.test(T) && /Common mistakes:<\/b><\/p>\s*<ul><li>Resets too early\.<\/li><\/ul>/.test(T) && /Debrief questions/.test(T), 'trainer notes');
      assert.ok(c11.slice(0, ans).indexOf('For the trainer') === -1 && c11.slice(0, ans).indexOf('Duration') === -1, 'no trainer notes in the exercises');
      const c12 = h.slice(h.indexOf('id="bk-ch-12"'), h.indexOf('id="bk-app-a"'));
      assert.ok(/FS-1/.test(c12) && /Because\./.test(c12));
      // the variant follows WTS_sim.features of the build (Round 7 comes from the committed HTML in the harness)
      const W = fixture().app.win, has = !!(W.WTS_sim && W.WTS_sim.features && W.WTS_sim.features.bypassDest);
      assert.strictEqual(/Choose the bypass destination/.test(c12), has, 'afterSim variant iff bypassDest');
      assert.strictEqual(/Switch V-101 out/.test(c12), !has, 'today variant iff no bypassDest');
      const sim = W.WTS_sim = W.WTS_sim || {}, F0 = sim.features;
      sim.features = Object.assign({}, F0, { bypassDest: !has });
      try {
        const alt = W.WTS_help.renderBook('all', { standalone: true, imgBase: 'img/' });
        assert.strictEqual(/Choose the bypass destination/.test(alt), !has, 'the other variant when the feature set changes');
      } finally { sim.features = F0; }
      const a = h.slice(h.indexOf('id="bk-app-a"'), h.indexOf('id="bk-app-b"'));
      assert.ok(a.indexOf('AGA Report No. 3') < a.indexOf('API STD 521'), 'standards sorted');
      assert.ok(/<td>AGA Report No\. 3<\/td><td>Flare Simulation \(see <a[^>]*>Chapter 9\.1<\/a>\); Orifice Plate Selection \(see/.test(a), 'a combined "A / B" string is split: each standard lists its modules');
      assert.ok(/<td>API MPMS Ch\. 14\.3<\/td>/.test(a) && /<td>ISO 23251<\/td>/.test(a) && !/ \/ API MPMS|; ISO/.test(a), '" / " and ";" split');
      assert.strictEqual((a.match(/<td>API STD 521<\/td>/g) || []).length, 1, 'one row per standard');
      assert.ok(/Choke size in 64ths/.test(h.slice(h.indexOf('id="bk-app-b"'))), 'glossary');
      assert.ok(/<b>F1<\/b>/.test(h.slice(h.indexOf('id="bk-app-c"'))), 'keyboard shortcuts');
      assert.ok(/How do I reset a page\?/.test(h.slice(h.indexOf('id="bk-app-d"'))), 'FAQ');
      assert.ok(/<h3>How do I…<\/h3>/.test(h) && /<h4>Meter gas<\/h4>/.test(h), 'tasks in chapter 1');
    },
  },
  {
    name: 'HELP guide: in-app print — quick card (no screenshots but its cardShot), guide, group, worksheet (no answers), Images off; images as data URIs, missing → caption',
    wp: WP, opts: false,
    async run(_, assert, ctx) {
      const app = openApp(ctx), W = app.win, H = W.WTS_help, sent = [];
      W.__reportOverride = (t, html, sub) => { sent.push({ t, html, sub }); };
      const card = H.renderBook('card:orifice');
      assert.ok(/Quick card/.test(card) && /Select Plate/.test(card) && /Transmitter range, 0 to/.test(card) && /inside/.test(card), 'steps, inputs, verdicts');
      assert.ok(!/What it does|Worked example|Standards and references/.test(card), 'only the card sections');
      assert.ok(/orifice\/res-d\.webp/.test(card) && !/orifice\/view-d\.webp/.test(card), 'cardShot only');
      assert.ok(!/<source/.test(card), 'no <source> in the print window');
      const ws = H.renderBook('worksheet:ex2');
      assert.ok(/Trainee worksheet/.test(ws) && /Q2<\/b> Why the gas rate\?/.test(ws) && /bk-line/.test(ws));
      assert.ok(!/Answer of ex2/.test(ws) && !/For the trainer/.test(ws), 'no answers or trainer notes');
      assert.ok(/Metering &amp; Chokes/.test(H.renderBook('Metering & Chokes')) && /Orifice Plate Selection/.test(H.renderBook('Metering & Chokes')), 'a group prints its chapter');
      assert.ok(!/<img/.test(H.renderBook('orifice', { images: false })), 'Images off');
      // fetch → blob → FileReader: res-d is served, view-d is missing
      W.fetch = (u) => Promise.resolve(/res-d\.webp\?v=1a2b3c4d$/.test(u) ? { ok: true, blob: () => Promise.resolve(new W.Blob(['RIFFwebp'], { type: 'image/webp' })) } : { ok: false });
      const p = H.print('orifice', { images: true });
      await app.flushAsync(50); await app.flushAsync(50); await app.flushAsync(50);
      const r = await p;
      assert.strictEqual(sent.length, 1, 'sent to the report window');
      assert.strictEqual(sent[0].t, 'Orifice Plate Selection');
      assert.ok(/^Well Testing Suite v?[\d.]+/.test(sent[0].sub));
      assert.ok(/src="data:image\/webp;base64,/.test(sent[0].html), 'the served image is a data URI');
      assert.ok(!/src="help\/img\//.test(sent[0].html), 'no file URL left (CSP img-src data:)');
      assert.ok(!/loading="lazy"|decoding="async"/.test(sent[0].html), 'no lazy images: the print window waits for every image load');
      assert.deepStrictEqual(Array.from(r.missing), ['orifice/view-d.webp', 'orifice/view-p.webp'], 'the phone view is tried before the caption');
      assert.ok(/help-shot-missing[^>]*><b>Screenshot:<\/b> The page as it opens/.test(sent[0].html), 'the missing one prints as its caption');
      W.fetch = () => { throw new Error('no fetch with Images off'); };
      const p2 = H.print('card:orifice', { images: false });
      await app.flushAsync(10);
      await p2;
      assert.strictEqual(sent[1].t, 'Quick card — Orifice Plate Selection');
      assert.ok(!/<img/.test(sent[1].html));
      assert.strictEqual(app.pendingTimers(), 0, 'no timers left');
    },
  },
  {
    name: 'HELP guide: Print ▾ menu per view (quick card / guide / group / whole; worksheets on the course), autosave-free; iOS opens the bundled guide in an in-app reader',
    wp: WP, opts: false,
    async run(_, assert, ctx) {
      const app = openApp(ctx), W = app.win, H = W.WTS_help, sent = [];
      W.__reportOverride = (t, html) => { sent.push({ t, html }); };
      app.hook.nav('orifice');
      app.click('pgHelpBtn');
      const opts = () => app.findAll('#help_pm option').map((o) => [o.textContent, o.getAttribute('value')]);
      assert.deepStrictEqual(opts(), [['Print ▾', ''], ['Quick card', 'card:orifice'], ['This guide', 'orifice'], ['This group: Metering & Chokes', 'Metering & Chokes'], ['Whole user guide', 'all']]);
      H.goTo('course');
      assert.deepStrictEqual(opts().map((o) => o[1]), ['', 'worksheet:ex1', 'worksheet:ex2', 'all']);
      assert.ok(app.el('help_pm').hasAttribute('data-no-persist') && app.el('help_pm_noimg').hasAttribute('data-no-persist'));
      app.check('help_pm_noimg', true);
      app.select('help_pm', 'worksheet:ex1');
      await app.flushAsync(10);
      assert.strictEqual(app.el('help_pm').value, '', 'the menu resets');
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].t, 'Worksheet — Normal test');
      assert.ok(/Sent to print/.test(app.el('help_pm_msg').textContent));
      assert.strictEqual(app.storage.getItem('wts_page_help'), null, 'nothing autosaved');
      // iOS app: whole guide → reader with the bundled file (same origin), not the print window
      app.document.documentElement.classList.add('ios-app');
      app.select('help_pm', 'all');
      await app.flushAsync(10);
      assert.strictEqual(sent.length, 1, 'not printed');
      const d = app.el('help_rd'), f = app.el('help_rd_f');
      assert.ok(d && d.hasAttribute('open'), 'reader open');
      assert.ok(/^help\/user-guide\.html\?v=/.test(f.getAttribute('src')), f.getAttribute('src'));
      assert.ok(/welltest\.h2oil\.co\.uk\/help\/user-guide\.html/.test(d.textContent), 'the published link for a PDF');
      const iosCss = fs.readFileSync(path.join(harness.REPO, 'ios-app', 'ios-additions', 'ios-styles.css'), 'utf8');
      assert.ok(/html\.ios-app \.help-rd\[open\] \{[^}]*env\(safe-area-inset-top\)[^}]*env\(safe-area-inset-bottom\)/.test(iosCss), 'reader safe-area padding in ios-styles.css');
      assert.ok(!/ios-app/.test(app.find('#help_print_slot style').textContent), 'no iOS-only CSS in the web code');
      assert.ok(d.querySelector('form[method="dialog"] button'), '✕ closes the dialog');
      // a rejection without a message never prints "undefined"
      app.document.documentElement.classList.remove('ios-app');
      W.__reportOverride = () => { throw undefined; };   // eslint-disable-line no-throw-literal
      app.select('help_pm', 'all');
      await app.flushAsync(10); await app.flushAsync(10);
      assert.strictEqual(app.el('help_pm_msg').textContent, 'Printing failed: unknown error');
    },
  },
  {
    name: 'HELP guide: the on-screen Help page reads the generated (rows-only) manifest module — screenshots render as <img>, offline download offered',
    wp: WP, opts: false,
    run(_, assert, ctx) {
      const app = openApp(ctx), W = app.win, M = W.WTS_helpManifest;
      assert.ok(M && M.data && typeof M.get === 'function', 'the WP-S module shape');
      assert.strictEqual(JSON.stringify(M.files['orifice/view-d.webp']), JSON.stringify({ w: 1280, h: 800, h8: 'abcdef01' }), 'M.files derived from the rows');
      app.hook.nav('orifice');
      app.click('pgHelpBtn');
      const root = app.el('help_root'), h = root ? root.innerHTML : '';
      assert.ok(/<img class="help-img"[^>]* src="help\/img\/orifice\/view-d\.webp\?v=abcdef01"/.test(h), 'the screenshot is an <img>');
      assert.ok(!/data-help-shot="orifice\/view"><div class="help-shot-missing"/.test(h), 'not the missing-image box');
      W.WTS_help.goTo('home');
      assert.ok(app.el('help_offline'), '"Download screenshots for offline use" is offered');
    },
  },
];
