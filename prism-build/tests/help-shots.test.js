// Help screenshots (docs/HELP-GUIDE-PLAN.md §3, §7.3; work package WP-S) — no browser.
// help-shots.js --check: content recipes ↔ help/img/manifest.json ↔ files on disk ↔ the GENERATED
// 48-calc-help-manifest.js, size caps, alt texts, call-outs and the structural fingerprints recomputed in the
// harness. Also: the recipe validator, the named actions and their clock modes, the WebP header reader, the
// generated module's API, the iOS copy step in sync-from-main.js and the ios-sync.yml / .gitattributes rules.
// (The sw.js help routing cases are in sw-offline.test.js.)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const WP = 'HELPS';
const BUILD = path.resolve(__dirname, '..');
const REPO = path.resolve(BUILD, '..');
const HS = require(path.join(BUILD, 'help-shots.js'));

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), 'wts-help-shots-' + tag + '-'));

// Recipes for two guides, loaded as an extra Round-9 data file (the real content files come from WP-C*).
const FIXTURE = `(function () { 'use strict';
  var G = (typeof window !== 'undefined') ? window : globalThis;
  G.WTS_helpContent = G.WTS_helpContent || { guides: {}, factories: [] };
  G.WTS_helpContent.factories.push({ group: 'fixture', build: function () { return { guides: {
    orifice: { route: 'orifice', shots: [
      { id: 'view', view: 'both', alt: 'Orifice Plate Selection page', caption: 'The page as it opens' },
      { id: 'res', view: 'desktop', target: '#op_res', alt: 'Results box', caption: 'Results',
        setup: [ { set: { '#op_q': '5000' } }, { waitFor: '#op_res .rbox' } ], callouts: [ { sel: '#op_res .rbox', n: 1 } ] }
    ] },
    wts: { route: 'wts', shots: [
      { id: 'run', view: 'desktop', target: '#wts_viz', alt: 'Simulator after a run', caption: 'After a run',
        setup: [ { action: 'simRun', args: { speed: 10, simSeconds: 600 } } ] }
    ] }
  } }; } });
})();`;
// The real content files (48-calc-help-<group>.js) are left out of these builds, so the fixture's recipes are the only ones;
// the generated manifest module stays in.
const OVR = { '48-calc-help-zz-test.js': FIXTURE };
fs.readdirSync(BUILD).filter((f) => /^48-calc-help-.*\.js$/.test(f) && f !== '48-calc-help-manifest.js').forEach((f) => { OVR[f] = null; });

// A WebP-shaped file: a valid VP8L header with the given size, padded to n bytes (--check reads headers, never pixels).
function fakeWebp(w, h, n, salt) {
  const head = Buffer.alloc(25);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(Math.max(n, 25) - 8, 4); head.write('WEBP', 8, 'ascii'); head.write('VP8L', 12, 'ascii');
  head.writeUInt32LE(Math.max(n, 25) - 20, 16); head[20] = 0x2f;
  head.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  const pad = Buffer.alloc(Math.max(0, n - 25), (salt || 0) & 0xff);
  return Buffer.concat([head, pad]);
}

// Build a consistent image folder for the fixture → { dir, module, man, html }.
function fixtureFolder(tag) {
  const H = require('./_harness');
  const html = H.buildFromSources({ silent: true, overrides: OVR }).html;
  const app = H.loadApp({ html });
  let content; try { content = HS.loadContent(app.win); } finally { app.dispose(); }
  const shots = HS.collectShots(content);
  const dir = tmp(tag);
  const files = [];
  shots.forEach((s, i) => HS.viewsOf(s.recipe).forEach((v) => {
    const file = HS.fileOf(s, v);
    const [w, h] = v === 'phone' ? [780, 1688] : s.recipe.target ? [400, 300] : [1280, 800];
    const buf = fakeWebp(w, h, 2000 + i * 10, i);
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), buf);
    const f = HS.fingerprint(s, v, { html });
    files.push({ file, route: s.folder, shot: s.stem, view: v, w, h, bytes: buf.length, sha256: require('crypto').createHash('sha256').update(buf).digest('hex'),
      recipeHash: HS.recipeHash(s), fp: f.fp, fpBox: f.fpBox, appVer: 'v0' });
  }));
  const man = Object.assign(HS.emptyManifest(), { chromium: 'test', fonts: ['B', 'A'], files });
  fs.writeFileSync(path.join(dir, 'manifest.json'), HS.manifestText(man));
  const module = path.join(dir, '48-calc-help-manifest.js');
  fs.writeFileSync(module, HS.moduleSource(man));
  return { dir, module, man, html, content, shots };
}
const rewrite = (fx, man) => { fs.writeFileSync(path.join(fx.dir, 'manifest.json'), HS.manifestText(man)); fs.writeFileSync(fx.module, HS.moduleSource(man)); };
const has = (r, re) => r.errors.some((e) => re.test(e));

module.exports = [
  {
    name: 'help-shots --check passes on the committed tree (content ↔ manifest ↔ files ↔ 48-calc-help-manifest.js)',
    wp: WP, opts: false,
    run(app, assert) {
      const r = HS.check({});
      assert.ok(r.ok, 'check errors:\n  ' + r.errors.join('\n  '));
      const man = JSON.parse(fs.readFileSync(path.join(REPO, 'help', 'img', 'manifest.json'), 'utf8'));
      const mod = fs.readFileSync(path.join(BUILD, '48-calc-help-manifest.js'), 'utf8');
      assert.strictEqual(mod, HS.moduleSource(man), 'the module equals what manifest.json generates');
      assert.ok(/GENERATED by help-shots\.js — never edit by hand/.test(mod), 'marked GENERATED');
      assert.ok(Buffer.byteLength(mod) <= HS.CAPS.moduleBytes, 'module within its cap (' + HS.CAPS.moduleBytes + ' bytes)');
      assert.strictEqual(man.platform, 'linux-container');
      assert.ok(r.files <= HS.CAPS.files && r.totalBytes <= HS.CAPS.totalBytes, 'total caps');
      // the CLI agrees (exit 0, no browser needed)
      const p = spawnSync(process.execPath, [path.join(BUILD, 'help-shots.js'), '--check'], { encoding: 'utf8', timeout: 120000 });
      assert.strictEqual(p.status, 0, 'help-shots --check exit code\n' + p.stdout + p.stderr);
      assert.ok(/\bok\b/.test(p.stdout), p.stdout);
    },
  },
  {
    name: 'fixture recipes: a consistent folder passes; missing, orphan, resized, re-encoded and over-cap files fail',
    wp: WP, opts: false,
    run(app, assert) {
      const fx = fixtureFolder('files');
      let r = HS.check({ imgDir: fx.dir, moduleFile: fx.module, html: fx.html });
      assert.ok(r.ok, 'consistent folder:\n  ' + r.errors.join('\n  '));
      assert.deepStrictEqual(r.expected.slice().sort(), ['orifice/res-d.webp', 'orifice/view-d.webp', 'orifice/view-p.webp', 'wts/run-d.webp']);
      // fingerprints: static shots have a 16-hex fp, the named-action shot is checked by recipeHash only
      const e = (f) => fx.man.files.find((x) => x.file === f);
      assert.ok(/^[0-9a-f]{16}$/.test(e('orifice/res-d.webp').fp), 'static shot fingerprint');
      assert.strictEqual(e('wts/run-d.webp').fp, 'browser', 'action shot → fp "browser"');
      // missing file
      fs.renameSync(path.join(fx.dir, 'orifice/view-p.webp'), path.join(fx.dir, 'view-p.bak'));
      r = HS.check({ imgDir: fx.dir, moduleFile: fx.module, html: fx.html, fingerprints: false });
      assert.ok(has(r, /orifice\/view-p\.webp is in the manifest but the file is missing/), r.errors.join('\n'));
      assert.ok(has(r, /orphan file help\/img\/view-p\.bak/), 'a stray file is an orphan');
      assert.deepStrictEqual(r.orphans, ['view-p.bak']);
      fs.renameSync(path.join(fx.dir, 'view-p.bak'), path.join(fx.dir, 'orifice/view-p.webp'));
      // resized + re-encoded file
      fs.writeFileSync(path.join(fx.dir, 'orifice/view-d.webp'), fakeWebp(1279, 800, 2001, 9));
      r = HS.check({ imgDir: fx.dir, moduleFile: fx.module, html: fx.html, fingerprints: false });
      assert.ok(has(r, /view-d\.webp is 1279×800, the manifest says 1280×800/), 'dimensions');
      assert.ok(has(r, /view-d\.webp is 2001 bytes/), 'bytes');
      assert.ok(has(r, /view-d\.webp sha256 differs/), 'hash');
      // not a WebP
      fs.writeFileSync(path.join(fx.dir, 'orifice/view-d.webp'), Buffer.from('not an image at all, just text padding'));
      r = HS.check({ imgDir: fx.dir, moduleFile: fx.module, html: fx.html, fingerprints: false });
      assert.ok(has(r, /view-d\.webp is not a WebP image/), 'non-WebP rejected');
      // over the desktop-crop cap (90 kB)
      const big = fakeWebp(400, 300, 90 * 1000 + 1, 3);
      fs.writeFileSync(path.join(fx.dir, 'orifice/res-d.webp'), big);
      const man = JSON.parse(JSON.stringify(fx.man));
      const er = man.files.find((x) => x.file === 'orifice/res-d.webp');
      er.bytes = big.length; er.sha256 = require('crypto').createHash('sha256').update(big).digest('hex');
      rewrite(fx, man);
      r = HS.check({ imgDir: fx.dir, moduleFile: fx.module, html: fx.html, fingerprints: false });
      assert.ok(has(r, /res-d\.webp is 90001 bytes, over its 90000-byte cap/), r.errors.join('\n'));
      assert.strictEqual(HS.capFor('desktop', undefined), 150000); assert.strictEqual(HS.capFor('phone', 'viewport'), 110000);
      assert.strictEqual(HS.capFor('phone', '#x'), 70000); assert.strictEqual(HS.CAPS.totalBytes, 8270000); assert.strictEqual(HS.CAPS.files, 300);
    },
  },
  {
    name: 'manifest ↔ module ↔ recipes: an out-of-date module, an unknown entry, a missing entry and stale shots fail',
    wp: WP, opts: false,
    run(app, assert) {
      const fx = fixtureFolder('stale');
      // module out of date
      fs.writeFileSync(fx.module, fs.readFileSync(fx.module, 'utf8').replace('M.count = 4;', 'M.count = 5;'));
      let r = HS.check({ imgDir: fx.dir, moduleFile: fx.module, html: fx.html, fingerprints: false });
      assert.ok(has(r, /48-calc-help-manifest\.js differs from what manifest\.json generates/), r.errors.join('\n'));
      rewrite(fx, fx.man);
      // manifest not in the stable form
      fs.writeFileSync(path.join(fx.dir, 'manifest.json'), JSON.stringify(fx.man));
      r = HS.check({ imgDir: fx.dir, moduleFile: fx.module, html: fx.html, fingerprints: false });
      assert.ok(has(r, /not in the tool's stable form/), 'stable form');
      // an entry for no recipe, and a recipe with no entry
      const man = JSON.parse(JSON.stringify(fx.man));
      const gone = man.files.splice(man.files.findIndex((x) => x.file === 'orifice/view-p.webp'), 1)[0];
      man.files.push(Object.assign({}, gone, { file: 'orifice/old-d.webp', shot: 'old', view: 'desktop' }));
      rewrite(fx, man);
      r = HS.check({ imgDir: fx.dir, moduleFile: fx.module, html: fx.html, fingerprints: false });
      assert.ok(has(r, /manifest entry orifice\/old-d\.webp matches no recipe/), 'unknown entry');
      assert.ok(has(r, /shot orifice\/view-p\.webp has no manifest entry \(run help-shots\.js --route orifice\)/), 'missing entry');
      rewrite(fx, fx.man);
      // stale: the page changed (fingerprint) and the recipe changed (recipeHash)
      const m2 = JSON.parse(JSON.stringify(fx.man));
      m2.files.find((x) => x.file === 'orifice/res-d.webp').fp = '0000000000000000';
      m2.files.find((x) => x.file === 'wts/run-d.webp').recipeHash = 'ffffffffffffffff';
      rewrite(fx, m2);
      r = HS.check({ imgDir: fx.dir, moduleFile: fx.module, html: fx.html });
      assert.ok(has(r, /shot orifice\/res is stale \(page changed \(structural fingerprint\)\): run help-shots --changed/), r.errors.join('\n'));
      assert.ok(has(r, /shot wts\/run is stale \(recipe changed\)/), 'recipe change');
      assert.deepStrictEqual(r.stale.map((x) => x.file).sort(), ['orifice/res-d.webp', 'wts/run-d.webp']);
      // a different set value changes the fingerprint; the app version alone changes nothing
      const res = fx.shots.find((s) => s.stem === 'res');
      const f1 = HS.fingerprint(res, 'desktop', { html: fx.html });
      const alt = Object.assign({}, res, { recipe: Object.assign({}, res.recipe, { setup: [{ set: { '#op_q': '9000' } }] }) });
      const f2 = HS.fingerprint(alt, 'desktop', { html: fx.html });
      assert.strictEqual(f1.fp, fx.man.files.find((x) => x.file === 'orifice/res-d.webp').fp, 'fingerprint is repeatable');
      assert.notStrictEqual(f2.fp, f1.fp, 'a changed value changes the fingerprint');
      assert.notStrictEqual(HS.recipeHash(alt), HS.recipeHash(res), 'and the recipe hash');
      const caption = Object.assign({}, res, { recipe: Object.assign({}, res.recipe, { caption: 'Other words', alt: 'Other alt' }) });
      assert.strictEqual(HS.recipeHash(caption), HS.recipeHash(res), 'caption / alt edits do not re-shoot');
      const pad = Object.assign({}, res, { recipe: Object.assign({}, res.recipe, { padTop: 0 }) });
      assert.notStrictEqual(HS.recipeHash(pad), HS.recipeHash(res), 'padTop re-shoots (absent padTop keeps the old hashes)');
    },
  },
  {
    name: 'recipe validator: ids, views, alt and caption, ops, named actions, call-outs, duplicates',
    wp: WP, opts: false,
    run(app, assert) {
      const shot = (r, folder) => ({ folder: folder || 'orifice', stem: r.id, route: 'orifice', recipe: r, where: 'guide ' + (folder || 'orifice') });
      const ok = { id: 'res', view: 'both', target: '#op_res', alt: 'a', caption: 'c', setup: [{ set: { '#op_q': '1' } }, { action: 'metric', args: true }, { click: '#op_calc' }],
        callouts: [{ sel: '#op_res', n: 1 }, { sel: '#op_q', n: 2 }], mask: ['.x'] };
      assert.deepStrictEqual(HS.validateShots([shot(ok)]), [], 'a full valid recipe');
      const bad = (patch, re, what) => {
        const errs = HS.validateShots([shot(Object.assign({}, ok, patch))]);
        assert.ok(errs.some((e) => re.test(e)), what + ' → ' + JSON.stringify(errs));
      };
      bad({ id: 'Res_1' }, /id must be lower-case/, 'bad id');
      bad({ view: 'tablet' }, /view must be desktop, phone or both/, 'bad view');
      bad({ alt: '' }, /alt text is empty/, 'empty alt');
      bad({ alt: 'x'.repeat(201) }, /alt longer than 200/, 'long alt');
      bad({ caption: ' ' }, /caption is empty/, 'empty caption');
      bad({ caption: 'x'.repeat(161) }, /caption longer than 160/, 'long caption');
      bad({ setup: [{ eval: 'x' }] }, /must hold exactly one of/, 'unknown op');
      bad({ setup: [{ click: '#a', set: { '#b': 1 } }] }, /must hold exactly one of/, 'two ops in one step');
      bad({ setup: [{ action: 'runScript' }] }, /unknown named action "runScript"/, 'unknown action');
      bad({ setup: [{ click: '#a', args: 1 }] }, /args only go with action/, 'args without action');
      bad({ setup: [{ set: {} }] }, /needs \{selector: value\}/, 'empty set');
      bad({ callouts: [{ sel: '#a', n: 1 }, { sel: '#b', n: 1 }] }, /call-out number 1 used twice/, 'duplicate call-out');
      bad({ callouts: [{ sel: '#a', n: 10 }] }, /n must be 1–9/, 'call-out out of range');
      bad({ callouts: [{ n: 2 }] }, /needs sel/, 'call-out without selector');
      bad({ mask: [''] }, /mask must be a list of selectors/, 'empty mask');
      bad({ padTop: 9 }, /padTop must be an integer 0–8/, 'padTop out of range');
      assert.deepStrictEqual(HS.validateShots([shot(Object.assign({}, ok, { padTop: 0 }))]), [], 'padTop 0 is valid');
      const dup = HS.validateShots([shot(ok), shot(Object.assign({}, ok))]);
      assert.ok(dup.some((e) => /duplicate shot orifice\/res/.test(e)), 'duplicate id in one folder');
      // course / scenario / start folders and stems
      const list = HS.collectShots({ guides: { orifice: { shots: [ok], parts: [{ id: 'p', shots: [Object.assign({}, ok, { id: 'part' })] }] } },
        course: [{ id: 'ex1', shots: [{ id: 'run', alt: 'a', caption: 'c' }] }], scenarios: { 'FS-1': { shots: [{ id: 'table', alt: 'a', caption: 'c' }] } },
        start: [{ id: 'screen', shots: [{ id: 'sidebar', alt: 'a', caption: 'c', route: 'aga3' }] }] });
      assert.deepStrictEqual(list.map((s) => s.folder + '/' + s.stem + '@' + s.route),
        ['orifice/res@orifice', 'orifice/part@orifice', 'course/ex1-run@wts', 'scenarios/fs-1-table@wts', 'start/sidebar@aga3']);
      assert.deepStrictEqual(HS.viewsOf({ view: 'both' }), ['desktop', 'phone']);
      assert.strictEqual(HS.fileOf(list[3], 'desktop'), 'scenarios/fs-1-table-d.webp');
      assert.strictEqual(HS.fileOf(list[0], 'phone'), 'orifice/res-p.webp');
    },
  },
  {
    name: 'named actions (§3.3) each declare a clock mode; shot clock: install for the simulator, PRiSM and live data, fixed Date elsewhere',
    wp: WP, opts: false,
    run(app, assert) {
      const want = ['prismAnalyse', 'prismStep', 'prismDfit', 'buildupDemo', 'modbusSimDemo', 'wellosDemo', 'simReset', 'simRun', 'simFault', 'simRigup', 'simCard',
        'simMenu', 'simView', 'quickReport', 'metric', 'wpJob', 'wellAdd', 'welldynRun'];
      assert.deepStrictEqual(Object.keys(HS.ACTIONS).sort(), want.slice().sort(), 'the initial set of named actions');
      want.forEach((k) => {
        assert.ok(['install', 'fixed'].indexOf(HS.ACTIONS[k].clock) >= 0, k + ' clock mode');
        assert.strictEqual(typeof HS.ACTIONS[k].run, 'function', k + ' run');
      });
      ['simRun', 'simView', 'prismAnalyse', 'prismDfit', 'simReset'].forEach((k) => assert.strictEqual(HS.ACTIONS[k].clock, 'install', k));
      assert.strictEqual(HS.ACTIONS.metric.clock, 'fixed');
      assert.strictEqual(HS.ACTIONS.welldynRun.clock, 'fixed');   // v4.6: the run is driven through the page hook, no frame loop
      const s = (route, setup) => ({ route, recipe: { setup: setup || [] } });
      assert.strictEqual(HS.clockOf(s('orifice')), 'fixed');
      assert.strictEqual(HS.clockOf(s('orifice', [{ action: 'metric', args: true }])), 'fixed');
      assert.strictEqual(HS.clockOf(s('orifice', [{ action: 'prismAnalyse' }])), 'install');
      assert.strictEqual(HS.clockOf(s('wts')), 'install');
      assert.strictEqual(HS.clockOf(s('prism')), 'install');
      assert.ok(HS.browserOnly(s('x', [{ waitEvent: 'prism:fit-updated' }])) && !HS.browserOnly(s('x', [{ click: '#a' }])), 'events need the browser');
      // fixed environment
      assert.deepStrictEqual([HS.VIEWS.desktop.viewport, HS.VIEWS.desktop.scale], [{ width: 1280, height: 800 }, 1]);
      assert.deepStrictEqual([HS.VIEWS.phone.viewport, HS.VIEWS.phone.scale, HS.VIEWS.phone.phone], [{ width: 390, height: 844 }, 2, true]);
      assert.strictEqual(HS.TIME, '2026-11-02T09:00:00Z');
      assert.strictEqual(HS.SEED.wts_unit_system, 'imperial');
      assert.strictEqual(HS.SEED.h2oil_client_info.client, 'Operator Energy Ltd');
      assert.strictEqual(HS.SEED.h2oil_client_info.well, 'Example-1');
      const src = fs.readFileSync(path.join(BUILD, 'help-shots.js'), 'utf8');
      assert.ok(/require\('\.\/pw-session'\)/.test(src) && !/require\('\.\/gui-sweep/.test(src), 'helpers come from pw-session.js, not the sweep');
      assert.ok(!/playwright install/.test(src.replace(/never `playwright install`/g, '')), 'never installs browsers');
    },
  },
  {
    name: 'WebP header reader (VP8, VP8L, VP8X) and the generated module API (?v=<hash8> src, list, byte-stable)',
    wp: WP, opts: false,
    run(app, assert) {
      assert.deepStrictEqual(HS.webpSize(fakeWebp(812, 430, 100)), { w: 812, h: 430 }, 'VP8L');
      const vp8 = Buffer.alloc(40); vp8.write('RIFF', 0); vp8.write('WEBP', 8); vp8.write('VP8 ', 12); vp8[23] = 0x9d; vp8[24] = 0x01; vp8[25] = 0x2a;
      vp8.writeUInt16LE(1280, 26); vp8.writeUInt16LE(800, 28);
      assert.deepStrictEqual(HS.webpSize(vp8), { w: 1280, h: 800 }, 'VP8');
      const vp8x = Buffer.alloc(40); vp8x.write('RIFF', 0); vp8x.write('WEBP', 8); vp8x.write('VP8X', 12); vp8x.writeUIntLE(779, 24, 3); vp8x.writeUIntLE(1687, 27, 3);
      assert.deepStrictEqual(HS.webpSize(vp8x), { w: 780, h: 1688 }, 'VP8X');
      assert.strictEqual(HS.webpSize(Buffer.from('GIF89a................................')), null);
      const files = [
        { file: 'orifice/view-p.webp', route: 'orifice', shot: 'view', view: 'phone', w: 780, h: 1688, bytes: 1, sha256: 'abcdef0123456789' },
        { file: 'orifice/res-d.webp', route: 'orifice', shot: 'res', view: 'desktop', w: 812, h: 430, bytes: 1, sha256: '1a2b3c4d5e6f' },
        { file: 'course/ex1-run-d.webp', route: 'course', shot: 'ex1-run', view: 'desktop', w: 900, h: 500, bytes: 1, sha256: '99887766aa' },
      ];
      const m1 = HS.moduleSource({ files }), m2 = HS.moduleSource({ files: files.slice().reverse() });
      assert.strictEqual(m1, m2, 'byte-stable whatever the entry order');
      assert.strictEqual(HS.manifestText({ files }), HS.manifestText({ files: files.slice().reverse() }), 'manifest text stable too');
      assert.ok(!/\d{4}-\d\d-\d\dT/.test(HS.manifestText({ files })), 'no capture time');
      const ctx = vm.createContext({ window: {} });
      vm.runInContext(m1, ctx);
      const M = ctx.window.WTS_helpManifest;
      assert.strictEqual(ctx.window.WTS_helpContent.manifest, M, 'merged into WTS_helpContent');
      assert.strictEqual(M.count, 3);
      const g = M.get('orifice', 'res', 'desktop');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(g)), { file: 'orifice/res-d.webp', src: 'help/img/orifice/res-d.webp?v=1a2b3c4d', w: 812, h: 430, v: '1a2b3c4d' });
      assert.strictEqual(M.get('orifice', 'view', 'phone').src, 'help/img/orifice/view-p.webp?v=abcdef01');
      assert.strictEqual(M.get('orifice', 'view', 'phone', 'img/').src, 'img/orifice/view-p.webp?v=abcdef01', 'the standalone guide uses img/');
      assert.strictEqual(M.get('orifice', 'view', 'desktop'), null, 'no desktop file → null');
      assert.strictEqual(M.get('nope', 'view', 'desktop'), null);
      assert.deepStrictEqual(Array.from(M.list('orifice')), ['res', 'view']);
      assert.deepStrictEqual(Array.from(M.list('course')), ['ex1-run']);
      // module keeps the existing namespace contents (help files merge, never assign)
      const ctx2 = vm.createContext({ window: { WTS_helpContent: { guides: { a: 1 }, factories: [9] } } });
      vm.runInContext(m1, ctx2);
      assert.strictEqual(ctx2.window.WTS_helpContent.guides.a, 1); assert.strictEqual(ctx2.window.WTS_helpContent.factories[0], 9);
    },
  },
  {
    name: 'iOS: sync-from-main.js rebuilds www/help from help/img/**/*.webp, manifest.json and user-guide.html only',
    wp: WP, opts: false,
    run(app, assert) {
      const src = tmp('helpsrc'), out = tmp('www');
      const put = (rel, body) => { fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true }); fs.writeFileSync(path.join(src, rel), body); };
      put('img/orifice/view-d.webp', fakeWebp(1280, 800, 64));
      put('img/course/ex1-run-d.webp', fakeWebp(900, 500, 64));
      put('img/manifest.json', '{"files":[]}\n');
      put('user-guide.html', '<!doctype html><title>Guide</title>\n');
      put('img/notes.txt', 'not copied'); put('img/x.png', 'not copied'); put('reply-draft.txt', 'not copied');
      fs.mkdirSync(path.join(out, 'help', 'img', 'gone'), { recursive: true });
      fs.writeFileSync(path.join(out, 'help', 'img', 'gone', 'old-d.webp'), 'stale');
      const p = spawnSync(process.execPath, [path.join(REPO, 'ios-app', 'scripts', 'sync-from-main.js')],
        { encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { WTS_SYNC_OUT_DIR: out, WTS_SYNC_HELP_DIR: src }) });
      assert.strictEqual(p.status, 0, p.stdout + p.stderr);
      assert.ok(/Copied help\/ → www\/help\/ \(4 files\)/.test(p.stdout), p.stdout);
      const list = [];
      const walk = (d, rel) => fs.readdirSync(d).sort().forEach((n) => { const q = path.join(d, n), r = rel ? rel + '/' + n : n; if (fs.statSync(q).isDirectory()) walk(q, r); else list.push(r); });
      walk(path.join(out, 'help'), '');
      assert.deepStrictEqual(list, ['img/course/ex1-run-d.webp', 'img/manifest.json', 'img/orifice/view-d.webp', 'user-guide.html'], 'exactly the help files; the stale one removed');
      assert.ok(fs.readFileSync(path.join(out, 'help', 'img', 'orifice', 'view-d.webp')).equals(fs.readFileSync(path.join(src, 'img', 'orifice', 'view-d.webp'))), 'bytes copied unchanged');
      assert.ok(fs.existsSync(path.join(out, 'index.html')), 'the app page is still written');
    },
  },
  {
    name: 'ios-sync.yml watches help/**, .gitattributes keeps WebP binary and the guide LF; the tools stay off the sweep',
    wp: WP, opts: false,
    run(app, assert) {
      const yml = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ios-sync.yml'), 'utf8');
      const paths = (/paths:\s*\n((?:\s+- .*\n)+)/.exec(yml) || [])[1] || '';
      assert.ok(/- 'help\/\*\*'/.test(paths), 'help/** in the push paths');
      assert.ok(/git add ios-app\/www\//.test(yml), 'www/ (incl. www/help) staged');
      const ga = fs.readFileSync(path.join(REPO, '.gitattributes'), 'utf8');
      assert.ok(/^\*\.webp binary$/m.test(ga), '*.webp binary');
      assert.ok(/^help\/\*\.html text eol=lf$/m.test(ga), 'help/*.html text eol=lf');
      const pws = require(path.join(BUILD, 'pw-session.js'));
      ['loadPlaywright', 'launch', 'serve', 'startServer', 'routeExternal', 'freshSession', 'navTo'].forEach((k) => assert.strictEqual(typeof pws[k], 'function', 'pw-session.' + k));
      assert.ok(pws.MIME['.webp'] === 'image/webp', 'the server knows WebP');
      assert.ok(pws.CDN_STUBS.length >= 7, 'library stubs copied from the sweep');
      // the in-memory page option of the static server
      const srv = pws.serve({ pageHtml: '<p>mem</p>' });
      assert.strictEqual(typeof srv.listen, 'function'); srv.close();
    },
  },
  {
    name: 'fix round: appVer has one v, crop grows to hold call-outs and warns on oversize targets, harness = seeded random + shot date, sim actions settle, server stays in its root',
    wp: WP, opts: false,
    async run(app, assert) {
      // appVer: WTS_appVersion() already says 'v3.3'
      ['v3.3', 'V3.3', '3.3', ' v3.3.2 '].forEach((v) => { const a = HS.appVerOf(v); assert.ok(/^v\d/.test(a) && !/^vv/i.test(a), v + ' → ' + a); });
      assert.strictEqual(HS.appVerOf('v3.3.2'), 'v3.3.2'); assert.strictEqual(HS.appVerOf(''), '');
      const src = fs.readFileSync(path.join(BUILD, 'help-shots.js'), 'utf8');
      assert.ok(!/'v' \+ app\.win\.WTS_appVersion\(\)/.test(src), 'no second v added to the app version');
      // crop: call-out on the target's top-left edge → the clip grows to hold its marker
      const vp = { vw: 1280, vh: 800 };
      const rect = Object.assign({ l: 300, t: 200, r: 700, b: 500 }, vp);
      const mk = (n, l, t, el) => ({ n, sel: '#c' + n, el: el || { l, t, r: l + 50, b: t + 20 }, m: { l: l - 13, t: t - 13, r: l + 13, b: t + 13 } });
      let c = HS.cropFor('#t', rect, { boxes: [mk(1, 300, 200)] });
      assert.deepStrictEqual(c.errors, []);
      assert.ok(c.clip.x <= 287 && c.clip.y <= 187, 'marker at left/top inside the clip: ' + JSON.stringify(c.clip));
      assert.strictEqual(c.clip.x + c.clip.width, 708, 'right edge = target + 8 px');
      // a call-out on an element outside the target fails
      c = HS.cropFor('#t', rect, { boxes: [mk(2, 900, 600)] });
      assert.ok(c.errors.some((e) => /call-out 2 .* outside the target/.test(e)), c.errors.join(';'));
      // a marker clamped at the viewport edge stays inside the clip
      c = HS.cropFor('#t', Object.assign({}, rect, { l: 2, t: 2 }), { boxes: [{ n: 3, sel: '#c3', el: { l: 2, t: 2, r: 40, b: 20 }, m: { l: -2, t: -2, r: 24, b: 24 } }] });
      assert.deepStrictEqual(c.errors, []); assert.strictEqual(c.clip.x, 0);
      // oversize target → a warning, not a silent cut
      c = HS.cropFor('#t', Object.assign({ l: 300, t: 150, r: 791, b: 950 }, vp), { boxes: [] });
      assert.ok(c.warnings.length === 1 && /does not fit the 1280×800 viewport/.test(c.warnings[0]), c.warnings.join(';'));
      assert.strictEqual(c.clip.y + c.clip.height, 800, 'clipped to the viewport');
      assert.deepStrictEqual(HS.cropFor('#t', rect, { boxes: [] }).warnings, [], 'a target that fits: no warning');
      const c0 = HS.cropFor('#t', rect, { boxes: [] }), cp = HS.cropFor('#t', rect, { boxes: [] }, 0);
      assert.ok(cp.clip.y === c0.clip.y + 8 && cp.clip.height === c0.clip.height - 8 && cp.clip.x === c0.clip.x, 'padTop 0: no strip above the target');
      assert.strictEqual(HS.parseArgs(['--route', 'x', '--strict']).strict, true, '--strict');
      // harness globals: the same seeded generator as the shots, and the shot date
      const g1 = HS.harnessGlobals().Math, g2 = HS.harnessGlobals().Math;
      const seq = [g1.random(), g1.random(), g1.random()];
      assert.deepStrictEqual([g2.random(), g2.random(), g2.random()], seq, 'each fingerprint starts the same sequence');
      assert.ok(Math.abs(seq[0] - 0.3588899802416563) < 1e-15, 'the browser init script algorithm (first value)');
      assert.strictEqual(g1.max(1, 4), 4); assert.strictEqual(g1.PI, Math.PI);
      assert.ok(/startTime: Date\.parse\(TIME\), globals: harnessGlobals\(\)/.test(src), 'fingerprint uses the shot date and the seeded random');
      // simulator actions end with a fixed 1 s of fake time (HUD 250 ms / slow 1000 ms phases)
      ['simRun', 'simReset', 'simFault', 'simRigup'].forEach((k) => assert.ok(/simQuiet\(s\)/.test(HS.ACTIONS[k].run.toString()), k + ' settles with simQuiet'));
      assert.ok(/async function simQuiet\(s\) \{ await steps\(s, 1000\); await s\.advance\(32\); \}/.test(src), 'simQuiet = 1000 ms in 250 ms steps + 32 ms');
      const pwsSrc = fs.readFileSync(path.join(BUILD, 'pw-session.js'), 'utf8');
      assert.ok(/s\.startSteps = fakeSteps;\s*\n\s*await s\.render\(\);\s*\n\s*await s\.advance\(500\);/.test(pwsSrc), 'a fixed fake-time start after readiness and a render barrier');
      // the install-mode clock is pauseAt alone: an install() + pauseAt() pair shifts the frame phase by the real gap between the calls
      const code = pwsSrc.replace(/\/\/.*$/gm, '');
      assert.ok(/p\.clock\.pauseAt\(t0 \+ 1000\)/.test(code) && !/p\.clock\.install\(/.test(code), 'pauseAt only, no clock.install');
      assert.ok(/if \(s\.render\) await s\.render\(\);/.test(code), 'navTo waits for the render barrier');
      // static server: a sibling folder with the same prefix is not served
      const pws = require(path.join(BUILD, 'pw-session.js'));
      const base = tmp('srv'), root = path.join(base, 'site'), sib = path.join(base, 'site-sibling');
      fs.mkdirSync(root); fs.mkdirSync(sib);
      fs.writeFileSync(path.join(root, 'a.txt'), 'in'); fs.writeFileSync(path.join(sib, 'b.txt'), 'out');
      const srv = await pws.startServer({ root });
      const get = (u) => new Promise((ok, no) => require('http').get(srv.base + u, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => ok({ status: r.statusCode, body: b })); }).on('error', no));
      try {
        const a = await get('a.txt');
        assert.deepStrictEqual([a.status, a.body], [200, 'in'], 'a file in the root');
        assert.strictEqual((await get('..%2Fsite-sibling%2Fb.txt')).status, 404, '../site-sibling is outside the root');
        assert.strictEqual((await get('..%2F..%2Fetc%2Fpasswd')).status, 404, '../.. refused');
      } finally { await srv.close(); }
    },
  },
];
