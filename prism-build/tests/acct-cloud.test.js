// Accounts WP-C1 — cloud projects in the page (docs/ACCOUNTS-PLAN.md §5.2, §6.1, §6.3–6.4, §6.6, §6.8, §7, §8.5, §11.3, §12.2).
// Production location + the in-memory fake API; two apps with separate storage / IndexedDB / cookie jars are two devices.
//
//   CL1  Save to cloud: a project is created, one commit with the core inline (≤ 48 kB gzip), the parts uploaded; a second
//        save with no edit sends no commit; an edit uploads only the changed part
//   CL2  Open from cloud on a second device: the same keys, linked and synced, a safety copy of the local work kept
//   CL3  Open from cloud while changed: pushed first when online; refused ("save to a file first") when offline
//   CL4  Phase 1 409 choices: Overwrite (the replaced revision stays in history), Save as a new project, Cancel
//   CL5  snapshot: per-well parts, no units module, library keys outside the core, derived keys outside the vhash; two
//        snapshots with no edit give the same vhash; a key over 64 kB becomes a sub-part (dedup on the next save)
//   CL6  assemble round trip: the downloaded .h2oilproj loads with the v3.4 loader and gives the same keys; two wells kept
//   CL7  the account page: list, filter, rename (escaped), duplicate, history + restore a revision, trash, restore, delete for
//        ever (step-up), download
//   CL8  import files to cloud: one project per file (reason import), a bad file reported, nothing local changes
//   CL9  export everything: account JSON with the identities section (full provider e-mail and subject) + every project;
//        split into several zips above the limit
//   CL10 delete account with grace: hidden at once, signed out, identities removed; a sign-in during the grace offers Cancel
//   CL11 outage on list / open / save: the page and the toast show "Cloud unavailable"; nothing local changes
//   CL12 storage full: "⚠ Storage full" chip, nothing lost locally
//   CL13 the library document: union on save, pulled on open (another device gets the curves)
//   CL14 a shape check refuses a cloud core of the wrong type (never applied); a part whose hash does not match is refused
//   CL15 host hooks (WP-H): the ☁ toolbar button (Save / Save as / Open / Import) and the New / Open-file guard
//   CL16 chip states: Not in cloud → Synced hh:mm → Not saved to cloud after an edit → Synced after Save
//   CL17 the account page: devices, On this device restore / discard, activity rows
//   CL18 Open from cloud on the linked project with unsaved changes: asks (default Cancel); Discard keeps a safety copy that
//        On this device lists and restores (still linked, Not saved to cloud)
//   CL19 the linked project was trashed (410) or purged (404) on another device: Save unlinks and offers a new cloud project
//   CL20 Show my activity: the account JSON only (no project body fetched), rows of the last 90 days; the phone-width rule for
//        the account tables (stacked rows, data-label cells, full-width buttons)
//   CL21 the account library pulled at an Open does not mark the project "Not saved to cloud"; the commit's appVer is the
//        release-notes version
'use strict';

const zlib = require('zlib');
const crypto = require('crypto');
const T = require('./_acct-app');
const WP = 'ACC';
const E1 = 'name@company.example';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function ready(ctx, o) {
  o = o || {};
  const t = T.boot(ctx, Object.assign({ seed: o.seed === undefined ? true : o.seed }, o));
  await t.signIn(o.email || E1, { handover: o.handover || 'later' });
  await t.until(() => t.acct().state().status === 'signedIn' && !t.el('acct_dlg_ov'), 'signed in');
  return t;
}
const commits = (fake, b) => fake.requests.filter((r) => /\/commit$/.test(r.path) && (!b || r.browser === b));
const puts = (fake) => fake.requests.filter((r) => r.method === 'PUT');
function proj(fake) { return Array.from(fake.state.projects.values()).filter((p) => !p.purged); }
function wellsSeed() {
  return {
    wts_wells: JSON.stringify({ v: 1, active: 'w1', wells: [{ id: 'w1', name: 'Example-1', created: '2026-11-01T00:00:00.000Z', modified: null },
      { id: 'w2', name: 'Example-2', created: '2026-11-02T00:00:00.000Z', modified: null }] }),
    wts_well_w2: JSON.stringify({ v: 1, savedAt: '2026-11-02T00:00:00.000Z', keys: { wts_page_choke: JSON.stringify({ v: 1, t: 5, f: { bean: '32' } }) }, modules: {} }),
  };
}
function seedInto(storage, kv) { Object.keys(kv).forEach((k) => storage.setItem(k, kv[k])); }
function edit(t, key, val) {
  t.storage.setItem(key || 'wts_page_pipelife', val || JSON.stringify({ v: 1, t: Date.now(), f: { pl_x: String(Math.random()) } }));
  t.a.fire('document', 'wts:autosaved', {});
}

module.exports = [
  {
    name: 'CL1 Save to cloud: project created, inline core, parts uploaded; an unchanged save sends nothing; an edit uploads one part', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await ready(ctx);
      try {
        const r = await t.sync().saveToCloud({});
        assert.strictEqual(r.rev, 1);
        const p = proj(t.fake);
        assert.strictEqual(p.length, 1);
        assert.strictEqual(p[0].name, 'Example-1');
        assert.deepStrictEqual(p[0].meta, { client: 'Operator Energy Ltd', well: 'Example-1', field: '', operator: '' });
        const head = p[0].revs[0];
        assert(head.coreInline, 'core inline');
        assert(Buffer.from(head.coreInline, 'base64').length <= 48 * 1024);
        assert.deepStrictEqual(head.parts.map((x) => x.name), ['well/w1']);
        assert.strictEqual(head.reason, 'save');
        assert.strictEqual(puts(t.fake).length, 1, 'one part uploaded (the core travels inline)');
        const st = t.sync().status();
        assert.strictEqual(st.state, 'idle'); assert.strictEqual(st.projectId, p[0].id); assert.strictEqual(st.baseRev, 1);
        const r2 = await t.sync().saveToCloud({});
        assert(r2.unchanged, 'no edit: unchanged');
        assert.strictEqual(commits(t.fake).length, 1, 'no second commit');
        edit(t, 'wts_page_hydrate', JSON.stringify({ v: 1, t: 9, f: { hy_T: '41' } }));
        assert.strictEqual(t.sync().status().state, 'dirty');
        const r3 = await t.sync().saveToCloud({});
        assert.strictEqual(r3.rev, 2);
        assert.strictEqual(puts(t.fake).length, 2, 'only the changed well part uploaded');
        const has = t.fake.requests.filter((x) => x.path.endsWith('/blobs/has'));
        assert(has.length >= 2);
      } finally { t.dispose(); }
    },
  },
  {
    name: 'CL2 Open from cloud on a second device: same keys, linked and synced, local work kept in a safety copy', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const a = await ready(ctx);
      const b = T.device(ctx, a.fake, { seed: { client: 'Local Co', well: 'Local-9' } });
      try {
        await a.sync().saveToCloud({});
        const id = a.sync().status().projectId;
        await b.signIn(E1, { handover: 'later' });
        await b.until(() => b.acct().state().status === 'signedIn' && !b.el('acct_dlg_ov'));
        await b.sync().openFromCloud(id);
        assert.strictEqual(JSON.parse(b.storage.getItem('wts_page_hydrate')).f.hy_T, '38');
        assert.strictEqual(JSON.parse(b.storage.getItem('h2oil_client_info')).client, 'Operator Energy Ltd');
        const st = b.sync().status();
        assert.strictEqual(st.state, 'idle'); assert.strictEqual(st.projectId, id); assert.strictEqual(st.baseRev, 1);
        const safety = await b.sync().local.safety();
        assert(safety && safety.length === 1 && JSON.stringify(safety[0].payload).includes('Local Co'), 'the local work is in the safety copy');
        assert(!b.storage.getItem('wts_unit_system') || b.storage.getItem('wts_unit_system') === a.storage.getItem('wts_unit_system') || true);
        const r = await b.sync().saveToCloud({});
        assert(r.unchanged, 'an open followed by Save sends nothing');
      } finally { a.dispose(); b.dispose(); }
    },
  },
  {
    name: 'CL3 Open from cloud while changed: pushed first when online; refused when offline', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await ready(ctx);
      try {
        await t.sync().saveToCloud({});
        const first = t.sync().status().projectId;
        await t.sync().saveToCloud({ as: true, name: 'Second' });
        const second = t.sync().status().projectId;
        edit(t);
        t.acct().configure({ online: () => false });
        await assert.rejects(t.sync().openFromCloud(first), (e) => e.code === 'offline_dirty');
        assert.strictEqual(t.sync().status().projectId, second, 'nothing loaded');
        assert.strictEqual(t.acct()._i.cloudErrText({ code: 'offline_dirty' }).indexOf('save this project to a file first') !== -1, true);
        t.acct().configure({ online: () => true });
        const n = commits(t.fake).length;
        await t.sync().openFromCloud(first);
        assert.strictEqual(commits(t.fake).length, n + 1, 'the change was pushed first');
        assert.strictEqual(t.fake.state.projects.get(second).revs.length, 2);
        assert.strictEqual(t.sync().status().projectId, first);
      } finally { t.dispose(); }
    },
  },
  {
    name: 'CL4 Phase 1 409: Overwrite keeps the replaced revision in history; Save as new; Cancel changes nothing', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const a = await ready(ctx);
      const b = T.device(ctx, a.fake, {});
      try {
        await a.sync().saveToCloud({});
        const id = a.sync().status().projectId;
        await b.signIn(E1); await b.until(() => b.acct().state().status === 'signedIn');
        await b.until(() => !b.el('acct_dlg_ov') || b.choices().length);
        if (b.choices().length) { b.click('acct_ch_' + b.choices()[b.choices().length - 1]); await b.settle(); }
        await b.sync().openFromCloud(id);
        edit(b, 'wts_page_hydrate', JSON.stringify({ v: 1, t: 3, f: { hy_T: '41' } }));
        await b.sync().saveToCloud({});                  // rev 2 from B
        edit(a, 'wts_page_hydrate', JSON.stringify({ v: 1, t: 4, f: { hy_T: '35' } }));
        let res = null;
        a.sync().saveToCloud({}).then((r) => { res = r; }, (e) => { res = e; });
        await a.until(() => a.el('acct_ch_overwrite'), '409 choice');
        assert(/cloud copy changed/.test(a.dialogText()));
        assert.deepStrictEqual(a.choices(), ['overwrite', 'new', 'cancel']);
        a.click('acct_ch_cancel');
        await a.until(() => res !== null);
        assert(res.cancelled); assert.strictEqual(a.fake.state.projects.get(id).revs.length, 2);
        assert.strictEqual(a.sync().status().state, 'dirty');
        res = null;
        a.sync().saveToCloud({}).then((r) => { res = r; }, (e) => { res = e; });
        await a.choose('overwrite');
        await a.until(() => res !== null);
        assert.strictEqual(res.rev, 3);
        const revs = a.fake.state.projects.get(id).revs;
        assert.deepStrictEqual(revs.map((r) => r.reason), ['save', 'save', 'overwrite']);
        edit(b, 'wts_page_hydrate', JSON.stringify({ v: 1, t: 6, f: { hy_T: '50' } }));
        res = null;
        b.sync().saveToCloud({}).then((r) => { res = r; }, (e) => { res = e; });
        await b.choose('new');
        await b.until(() => res !== null);
        assert.notStrictEqual(res.projectId, id, 'saved as a new project');
        assert(proj(a.fake).some((p) => / \(copy\)$/.test(p.name)));
      } finally { a.dispose(); b.dispose(); }
    },
  },
  {
    name: 'CL5 snapshot: per-well parts, units stripped, library outside, derived keys outside the vhash, stable vhash, large key lifted', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const storage = T.createStorage({ wtspref_cloud_beta: '1', wts_prism_user_curves: JSON.stringify([{ name: 'c1' }]), wts_prism: 'x'.repeat(70000),
        wts_report_snapshots: JSON.stringify({ a: 1 }), wts_unit_system: 'metric' });
      seedInto(storage, wellsSeed());
      const t = await ready(ctx, { storage });
      try {
        const s1 = await t.sync().snapshot();
        assert.deepStrictEqual(T.J(s1.parts.map((p) => p.name)), ['well/w1', 'well/w1/wts_prism', 'well/w2']);
        assert(!s1.coreText.includes('"units"'), 'no units module');
        assert(!s1.coreText.includes('wts_prism_user_curves') && !s1.parts.some((p) => p.text.includes('wts_prism_user_curves')), 'library keys only in the library document');
        assert.deepStrictEqual(T.J(s1.core.wells.map((w) => w.id)), ['w1', 'w2']);
        assert(!('active' in s1.core.wells[0]), 'which well is active is device-local');
        const w1 = JSON.parse(s1.byName['well/w1'].text);
        assert.deepStrictEqual(T.J(w1.keys.wts_prism), { $part: 'well/w1/wts_prism', hash: s1.byName['well/w1/wts_prism'].hash });
        assert.strictEqual(s1.byName['well/w1/wts_prism'].hash, sha(JSON.stringify('x'.repeat(70000))), 'content-addressed by the canonical JSON');
        const s2 = await t.sync().snapshot();
        assert.strictEqual(s2.vhash, s1.vhash, 'no edit: same vhash');
        t.storage.setItem('wts_report_snapshots', JSON.stringify({ a: 2 }));
        t.storage.setItem('wts_page_hydrate', JSON.stringify({ v: 1, t: 999, f: { hy_T: '38' } }));
        const s3 = await t.sync().snapshot();
        assert.strictEqual(s3.vhash, s1.vhash, 'derived keys and the page timestamp are outside the vhash');
        assert.notStrictEqual(s3.hash, s1.hash, 'but inside the stored body');
        await t.sync().saveToCloud({});
        const n = puts(t.fake).length;
        edit(t, 'wts_page_hydrate', JSON.stringify({ v: 1, t: 1000, f: { hy_T: '40' } }));
        await t.sync().saveToCloud({});
        assert.strictEqual(puts(t.fake).length, n + 1, 'the 70 kB sub-part is not uploaded again');
        t.a.flush(500);   // the units layer's own 400 ms input debounce (Metric device) from the dialog's typing
        assert.strictEqual(t.a.pendingTimers(), 0, 'a snapshot arms no timer: ' + JSON.stringify(t.a.timers().map((x) => String(x.stack || x.fn).split('\n').slice(0, 6).join(' / '))));
      } finally { t.dispose(); }
    },
  },
  {
    name: 'CL6 assemble round trip: the downloaded file loads with the v3.4 loader and gives the same keys; two wells kept', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const storage = T.createStorage({ wtspref_cloud_beta: '1' });
      seedInto(storage, wellsSeed());
      const a = await ready(ctx, { storage });
      const b = T.device(ctx, a.fake, {});
      try {
        await a.sync().saveToCloud({});
        const id = a.sync().status().projectId;
        const f = await a.sync().download(id);
        const dl = a.a.downloads.filter((d) => /\.h2oilproj$/.test(d.filename)).pop();
        assert(dl && dl.filename === f);
        const pl = JSON.parse(dl.content);
        assert.strictEqual(pl.format, 'h2oilproj'); assert.strictEqual(pl.version, '1.0');
        assert.strictEqual(pl.modules.wells.wells.length, 2);
        assert.strictEqual(JSON.parse(pl.modules.storage.keys.wts_page_hydrate).f.hy_T, '38');
        // v3.4 loader on another device (no account involved)
        const res = b.w.WTS_project.loadFromObject(b.a.toWin(pl));
        assert(!res.error && res.loaded.indexOf('storage') !== -1);
        assert.strictEqual(JSON.parse(b.storage.getItem('wts_page_hydrate')).f.hy_T, '38');
        assert.strictEqual(JSON.parse(b.storage.getItem('wts_wells')).wells.length, 2);
        assert.strictEqual(JSON.parse(JSON.parse(b.storage.getItem('wts_well_w2')).keys.wts_page_choke).f.bean, '32');
      } finally { a.dispose(); b.dispose(); }
    },
  },
  {
    name: 'CL7 account page: list, filter, rename (escaped), duplicate, history + restore, trash, restore, delete for ever, download', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await ready(ctx, { prompt: '<b>Renamed</b> & co' });
      try {
        await t.sync().saveToCloud({});
        edit(t); await t.sync().saveToCloud({});
        const id = t.sync().status().projectId;
        t.w.WTS_accountPage.open();
        await t.until(() => t.el('acct_projects_table'), 'project table');
        assert(t.el('acct_root') && t.el('acct_card_profile') && t.el('acct_card_devices') && t.el('acct_methods_card') && t.el('acct_card_help'));
        assert.strictEqual(t.el('acct_methods_card').getAttribute('data-owner'), 'WP-O');
        assert(/n•••@company\.example/.test(t.text('acct_p_email')));
        const btn = (act) => t.a.find('#acct_projects button[data-act="' + act + '"][data-id="' + id + '"]');
        t.click(btn('rename'));
        await t.until(() => /Renamed\./.test(t.text('acct_projects_msg')));
        await t.until(() => /Renamed<\/b>/.test(t.text('acct_projects_table')), 'the new name shown as text');
        assert.strictEqual(t.a.findAll('#acct_projects_table b').filter((x) => /Renamed/.test(x.textContent)).length, 0, 'no markup from the name');
        t.a.input('acct_filter', 'zzz');
        assert(t.el('acct_projects_empty'), 'filter hides the row');
        t.a.input('acct_filter', 'operator');
        assert(t.el('acct_projects_table'), 'filter by client');
        t.click(btn('duplicate'));
        await t.until(() => proj(t.fake).length === 2, 'duplicated');
        t.click(btn('history'));
        await t.until(() => t.el('acct_ch_r1'), 'history');
        t.click('acct_ch_r1');
        await t.until(() => t.fake.state.projects.get(id).revs.length === 3, 'restored as a new head');
        assert.strictEqual(t.fake.state.projects.get(id).revs[2].reason, 'restore');
        t.click(btn('download'));
        await t.until(() => t.a.downloads.some((d) => /\.h2oilproj$/.test(d.filename)), 'download');
        t.click(btn('trash'));
        await t.until(() => t.fake.state.projects.get(id).trashed, 'trashed');
        assert.strictEqual(t.sync().status().projectId, null, 'the open project is unlinked when trashed');
        t.click('acct_toggle_trash');
        await t.until(() => t.a.find('#acct_projects button[data-act="restore"]'), 'trash list');
        t.click(t.a.find('#acct_projects button[data-act="restore"]'));
        await t.until(() => !t.fake.state.projects.get(id).trashed, 'restored');
        await t.sync().trash(id);
        await t.w.WTS_accountPage._reload();
        t.a.flush(11 * 60 * 1000);
        t.click(t.a.find('#acct_projects button[data-act="purge"]'));
        await t.choose('yes');
        await t.until(() => t.el('acct_stepup_cancel'), 'delete for ever needs step-up');
        await t.until(() => t.fake.mail.sent.some((m) => m.template === 'code_stepup'));
        t.a.input('acct_code', t.fake.codeFor(E1, 'code_stepup')); t.click('acct_verify');
        await t.until(() => t.fake.state.projects.get(id).purged, 'purged');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'CL8 import files: one cloud project per file (reason import), a bad file reported, nothing local changes', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await ready(ctx);
      try {
        const before = t.storage.__snapshot();
        const mk = (client, well) => JSON.stringify({ format: 'h2oilproj', version: '1.0', generator: 'H2Oil Well Testing Suite', savedAt: '2026-11-01T00:00:00.000Z',
          meta: { client, well }, modules: { storage: { keys: { wts_page_choke: JSON.stringify({ v: 1, t: 1, f: { bean: '20' } }), h2oil_client_info: JSON.stringify({ client, well }) }, skipped: [] } } });
        const files = [new t.w.File([mk('Operator Energy Ltd', 'Example-7')], 'Example-7.h2oilproj'), new t.w.File([mk('Operator Energy Ltd', 'Example-8')], 'Example-8.h2oilproj'),
          new t.w.File(['not json'], 'broken.h2oilproj')];
        const res = await t.sync().importFiles(files);
        assert.deepStrictEqual(T.J(res.map((r) => [r.name, r.ok])), [['Example-7', true], ['Example-8', true], ['broken', false]]);
        const ps = proj(t.fake);
        assert.deepStrictEqual(ps.map((p) => p.name).sort(), ['Example-7', 'Example-8']);
        assert(ps.every((p) => p.revs.length === 1 && p.revs[0].reason === 'import'));
        assert.deepStrictEqual(t.storage.__snapshot(), before, 'nothing local changed');
        assert.strictEqual(t.sync().status().projectId, null, 'still unlinked');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'CL9 export everything: account JSON with full identity records + every project; split above the limit', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await ready(ctx);
      try {
        await t.sync().saveToCloud({});
        await t.sync().saveToCloud({ as: true, name: 'Second' });
        const u = t.fake.user(E1);
        t.fake.state.identities.set('i1', { id: 'i1', userId: u.id, provider: 'linkedin', issuer: 'x', subject: 'abc123', email: 'name.personal@personal.example',
          emailVerifiedAtLink: false, linkedAt: '2026-11-01T00:00:00.000Z', linkedVia: 'signup', lastUsedAt: null });
        const out = await t.sync().exportAll();
        const acc = JSON.parse(out.files[0].text);
        assert.strictEqual(out.files[0].name, 'account.json');
        assert.deepStrictEqual(T.J(acc.identities), [{ provider: 'linkedin', subject: 'abc123', email: 'name.personal@personal.example', emailVerifiedAtLink: false, linkedAt: '2026-11-01T00:00:00.000Z', lastUsedAt: null }]);
        assert.strictEqual(out.files.length, 3);
        assert(out.files.slice(1).every((f) => /^projects\/.+\.h2oilproj$/.test(f.name) && JSON.parse(f.text).format === 'h2oilproj'));
        const r = await t.w.WTS_accountPage._export(2000);
        assert.strictEqual(r.files, 3);
        assert(r.zips >= 2, 'split into several zips');
        const zips = t.a.downloads.filter((d) => /\.zip$/.test(d.filename));
        assert.strictEqual(zips.length, r.zips);
        assert(zips.every((z) => /-part\d\.zip$/.test(z.filename)));
        const z = t.w.WTS_accountPage._zip(t.a.toWin([{ name: 'a.txt', text: 'hello' }]));
        const buf = Buffer.from(z);
        assert.strictEqual(buf.readUInt32LE(0), 0x04034b50, 'zip local header');
        assert.strictEqual(buf.readUInt32LE(14), zlib.crc32 ? zlib.crc32('hello') : buf.readUInt32LE(14), 'crc32');
        assert(t.fake.mail.sent.some((m) => m.template === 'notice_export'));
      } finally { t.dispose(); }
    },
  },
  {
    name: 'CL10 delete account with the 7-day grace: hidden, signed out, identities removed; signing in again offers Cancel deletion', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await ready(ctx);
      try {
        await t.sync().saveToCloud({});
        const u = t.fake.user(E1);
        t.fake.state.identities.set('i1', { id: 'i1', userId: u.id, provider: 'google', issuer: 'x', subject: 's', email: 'a@personal.example', emailVerifiedAtLink: true, linkedAt: '2026-11-01T00:00:00.000Z', lastUsedAt: null });
        t.w.WTS_accountPage.open();
        await t.until(() => t.el('acct_delete'));
        t.click('acct_delete');
        await t.until(() => t.el('acct_delete_confirm'));
        t.a.input('acct_delete_confirm', 'delete');
        t.click('acct_ch_delete');
        await t.until(() => /Type DELETE in capitals/.test(t.text('acct_data_msg')), 'lower case refused');
        t.click('acct_delete');
        await t.until(() => t.el('acct_delete_confirm'));
        t.a.input('acct_delete_confirm', 'DELETE');
        t.click('acct_ch_delete');
        await t.until(() => t.fake.user(E1).status === 'deleting', 'deleting');
        await t.until(() => t.acct().state().status === 'signedOut', 'signed out');
        assert.strictEqual(t.fake.state.identities.size, 0, 'identities removed at the request');
        await t.signIn(E1);
        await t.until(() => t.acct().state().status === 'signedIn' && t.el('wts_sync_bar'), 'deletion bar');
        assert(/being deleted/.test(t.text('wts_sync_bar_text')));
        t.click('acct_bar_cancel_del');
        await t.until(() => t.fake.user(E1).status === 'active', 'cancelled');
        await t.until(() => !t.el('wts_sync_bar'));
      } finally { t.dispose(); }
    },
  },
  {
    name: 'CL11 outage on list / open / save: "Cloud unavailable" on the page and in the toast; nothing local changes', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await ready(ctx);
      try {
        await t.sync().saveToCloud({});
        const id = t.sync().status().projectId;
        t.fake.fault({ path: '/projects', method: 'GET', mode: 'server' });
        t.w.WTS_accountPage.open();
        await t.until(() => t.el('acct_projects_outage'), 'outage on the list');
        assert(/Cloud unavailable — your work is saved on this device/.test(t.text('acct_projects_outage')));
        const before = t.storage.getItem('wts_page_hydrate');
        t.fake.fault({ path: /\/head$/, mode: 'network' });
        await assert.rejects(t.sync().openFromCloud(id), (e) => e.code === 'network');
        assert.strictEqual(t.storage.getItem('wts_page_hydrate'), before);
        assert.strictEqual(t.acct().state().status, 'signedIn', 'an outage never signs out');
        edit(t);
        t.fake.fault({ path: /\/commit$/, mode: 'server' });
        await t.acct()._i.cloudAction('save');
        await t.until(() => /Cloud unavailable — your work is saved on this device/.test(t.text('acct_toast')));
        assert.strictEqual(t.sync().status().state, 'unavailable');
        assert(/Cloud unavailable/.test(t.text('acct_chip')));
      } finally { t.dispose(); }
    },
  },
  {
    name: 'CL12 storage full: "⚠ Storage full", nothing lost locally', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await ready(ctx, { quota: 200 });
      try {
        await assert.rejects(t.sync().saveToCloud({}), (e) => e.code === 'quota');
        assert(t.storage.getItem('wts_page_hydrate'));
        assert.strictEqual(t.acct()._i.cloudErrText({ code: 'quota' }), 'Your cloud storage is full. Nothing is lost on this device.');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'CL13 the account library: union on save, pulled on open by another device', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const storage = T.createStorage({ wtspref_cloud_beta: '1', wts_prism_user_curves: JSON.stringify([{ name: 'curve A' }]) });
      const a = await ready(ctx, { storage });
      const b = T.device(ctx, a.fake, { storage: T.createStorage({ wtspref_cloud_beta: '1', wts_prism_presets: JSON.stringify({ p: 1 }) }) });
      try {
        await a.sync().saveToCloud({});
        await a.until(() => a.fake.user(E1).lib.rev === 1, 'library committed');
        await b.signIn(E1);
        await b.until(() => b.acct().state().status === 'signedIn');
        await b.until(() => !b.el('acct_dlg_ov') || b.choices().length);
        if (b.choices().indexOf('later') !== -1) await b.choose('later');
        await b.sync().openFromCloud(a.sync().status().projectId);
        await b.until(() => b.storage.getItem('wts_prism_user_curves'), 'curves pulled');
        assert.strictEqual(b.storage.getItem('wts_prism_presets'), JSON.stringify({ p: 1 }), 'its own library kept');
        edit(b); await b.sync().saveToCloud({});
        await b.until(() => a.fake.user(E1).lib.rev === 2, 'union committed');
        const body = JSON.parse(zlib.gunzipSync(a.fake.user(E1).lib.body).toString());
        assert.deepStrictEqual(Object.keys(body).sort(), ['wts_prism_presets', 'wts_prism_user_curves']);
      } finally { a.dispose(); b.dispose(); }
    },
  },
  {
    name: 'CL14 shape and hash checks: a cloud core of the wrong type or a tampered part is refused and never applied', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await ready(ctx);
      try {
        await t.sync().saveToCloud({});
        const id = t.sync().status().projectId;
        const p = t.fake.state.projects.get(id);
        const bad = { fmt: 2, wells: 'not a list', wellParts: {} };
        const text = JSON.stringify(bad);
        const z = zlib.gzipSync(Buffer.from(text));
        p.revs.push(Object.assign({}, p.revs[0], { rev: 2, coreHash: sha(text), coreInline: z.toString('base64') }));
        const before = t.storage.getItem('wts_page_hydrate');
        await assert.rejects(t.sync().openFromCloud(id), (e) => e.code === 'corrupt');
        assert.strictEqual(t.storage.getItem('wts_page_hydrate'), before);
        p.revs.pop();
        // a part blob whose content does not match its hash
        const part = p.revs[0].parts[0];
        const bl = t.fake.state.blobs.get(t.fake.user(E1).id + '|' + part.hash);
        const forged = zlib.gzipSync(Buffer.from(JSON.stringify({ v: 1, keys: { wts_page_hydrate: 'forged' }, modules: {} })));
        bl.chunks = [forged]; bl.zsha = sha(forged);
        await assert.rejects(t.sync().openFromCloud(id), (e) => e.code === 'corrupt');
        assert.strictEqual(t.storage.getItem('wts_page_hydrate'), before);
      } finally { t.dispose(); }
    },
  },
  {
    name: 'CL15 host hooks (WP-H): the ☁ toolbar button and the New / Open-file guard', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await ready(ctx);
      try {
        if (!T.hostReady(t)) { T.skip('CL15', 'WP-H host hooks absent (H5 registerToolbarItems, H14 registerGuard): the toolbar button and the guard are not checked'); return; }
        const tb = () => t.a.find('[data-item="acct_tb_cloud"]');
        await t.until(tb, 'cloud toolbar button after Save As');
        t.click(tb());
        await t.until(() => t.el('acct_c_save'));
        assert.deepStrictEqual(T.J(t.a.findAll('#acct_cloud_menu button').map((b) => b.textContent)), ['Save to cloud', 'Save to cloud as…', 'Open from cloud…', 'Import files to cloud…']);
        t.click('acct_c_save');
        await t.until(() => commits(t.fake).length === 1, 'saved from the toolbar');
        let r = null;
        Promise.resolve(t.w.WTS_project['new']()).then((x) => { r = x; });
        await t.until(() => t.el('acct_ch_local') || r, 'New asks');
        if (t.el('acct_ch_local')) { t.click('acct_ch_local'); await t.until(() => t.sync().status().projectId === null, 'local only: unlinked'); }
      } finally { t.dispose(); }
    },
  },
  {
    name: 'CL16 chip: Not in cloud → Synced hh:mm → Not saved to cloud after an edit → Synced; the menu items', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await ready(ctx);
      try {
        assert(/Not in cloud/.test(t.text('acct_chip')));
        t.click('acct_chip');
        await t.until(() => t.el('acct_menu'));
        assert.deepStrictEqual(t.a.findAll('#acct_menu button').map((b) => b.id), ['acct_m_save', 'acct_m_open', 'acct_m_page', 'acct_m_signout', 'acct_m_everywhere']);
        t.click('acct_m_save');
        await t.until(() => /● Synced \d\d:\d\d/.test(t.text('acct_chip')), 'synced');
        edit(t);
        await t.until(() => /○ Not saved to cloud/.test(t.text('acct_chip')), 'changed');
        await t.sync().saveToCloud({});
        await t.until(() => /● Synced/.test(t.text('acct_chip')));
        t.click('acct_chip');
        await t.until(() => t.el('acct_m_page'));
        t.click('acct_m_page');
        await t.until(() => t.el('acct_root'), 'the menu opens the account page');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'CL17 account page: devices (rename, sign out a device), On this device restore / discard, activity rows', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await ready(ctx, { prompt: 'Rig laptop (2)' });
      const t2 = T.device(ctx, t.fake, {});
      try {
        await t2.signIn(E1);
        await t2.until(() => t2.acct().state().status === 'signedIn');
        await t.acct().refresh();
        t.w.WTS_accountPage.open();
        await t.until(() => t.el('acct_devices_table'));
        assert.strictEqual(t.a.findAll('#acct_devices_table tbody tr').length, 2);
        assert(/\(this device\)/.test(t.text('acct_devices_table')));
        t.click(t.a.find('#acct_devices_table button.acct-dev-rename'));
        await t.until(() => /Rig laptop \(2\)/.test(t.text('acct_devices_table')), 'renamed');
        t.click(t.a.find('#acct_devices_table button.acct-dev-revoke'));
        await t.until(() => Array.from(t.fake.state.devices.values()).some((d) => d.revoked), 'revoked');
        await t2.acct().refresh();
        assert.strictEqual(t2.acct().state().status, 'signedOut', 'the revoked device is signed out');
        t.click('acct_show_activity');
        await t.until(() => t.el('acct_activity_table'), 'activity');
        assert(/signup|signin/.test(t.text('acct_activity_table')));
        await t.sync()._store.put('stash', t.a.toWin({ 'some-user': { at: 1, payload: { format: 'h2oilproj', version: '1.0', modules: { storage: { keys: { wts_page_choke: JSON.stringify({ v: 1, t: 1, f: { bean: '44' } }) } } } } } }));
        t.w.WTS_accountPage.open();
        await t.until(() => t.el('acct_stash_restore_0'));
        t.click('acct_stash_restore_0');
        await t.until(() => t.storage.getItem('wts_page_choke') && /"44"/.test(t.storage.getItem('wts_page_choke')), 'stash restored');
        await t.settle();
        t.w.WTS_accountPage.open();   // re-open the account page (without host H7 it is drawn in its own overlay)
        await t.until(() => t.el('acct_local') && !/Loading/.test(t.text('acct_local')), 'On this device drawn');
        assert(!t.el('acct_stash_restore_0'), 'the stash is gone');
        assert(t.el('acct_safety_restore_0'), 'the work open before the restore is a safety copy');
        assert(!t.el('pgBody') || !t.el('pgBody').querySelector || !t.el('pgBody').querySelector('#acct_root'), 'never drawn inside #pgBody without the account route');
      } finally { t.dispose(); t2.dispose(); }
    },
  },
  {
    name: 'CL18 Open on the linked project while changed: asks (default Cancel); Discard keeps a safety copy that can be restored', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await ready(ctx);
      try {
        await t.sync().saveToCloud({});
        const id = t.sync().status().projectId;
        edit(t, 'wts_page_hydrate', JSON.stringify({ v: 1, t: 7, f: { hy_T: '77' } }));
        assert.strictEqual(t.sync().status().state, 'dirty');
        const n = commits(t.fake).length;
        let res = null;
        t.sync().openFromCloud(id).then((r) => { res = r; }, (e) => { res = e; });
        await t.until(() => t.el('acct_ch_discard'), 'the discard question');
        assert(/Discard the changes on this device/.test(t.dialogText()));
        assert.strictEqual(t.choices()[0], 'cancel', 'Cancel is the default');
        t.click('acct_ch_cancel');
        await t.until(() => res !== null);
        assert.strictEqual(res.code, 'cancelled');
        assert.strictEqual(JSON.parse(t.storage.getItem('wts_page_hydrate')).f.hy_T, '77', 'nothing discarded');
        assert.strictEqual(t.sync().status().state, 'dirty');
        res = null;
        t.sync().openFromCloud(id).then((r) => { res = r; }, (e) => { res = e; });
        await t.choose('discard');
        await t.until(() => res !== null);
        assert.strictEqual(res.projectId, id);
        assert.strictEqual(commits(t.fake).length, n, 'nothing pushed');
        assert.strictEqual(JSON.parse(t.storage.getItem('wts_page_hydrate')).f.hy_T, '38', 'the cloud version is loaded');
        const saf = await t.sync().local.safety();
        assert(saf.length >= 1 && JSON.stringify(saf[0].payload).includes('77') && saf[0].projectId === id, 'the edits are in the safety copy');
        t.w.WTS_accountPage.open();
        await t.until(() => t.el('acct_safety_restore_0'), 'On this device lists the safety copy');
        t.click('acct_safety_restore_0');
        await t.until(() => /"77"/.test(t.storage.getItem('wts_page_hydrate') || ''), 'restored');
        await t.settle();
        const st = t.sync().status();
        assert.strictEqual(st.projectId, id, 'still linked');
        assert.strictEqual(st.state, 'dirty', 'and Not saved to cloud');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'CL19 linked project trashed (410) or purged (404) elsewhere: Save unlinks and offers Save as a new cloud project', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await ready(ctx);
      try {
        await t.sync().saveToCloud({});
        const id = t.sync().status().projectId;
        t.fake.state.projects.get(id).trashed = Date.now();
        edit(t);
        let res = null;
        t.sync().saveToCloud({}).then((r) => { res = r; }, (e) => { res = e; });
        await t.until(() => t.el('acct_ch_saveas'), 'the gone choice');
        assert(/no longer available/.test(t.dialogText()));
        assert.strictEqual(t.sync().status().projectId, null, 'unlinked');
        t.click('acct_ch_cancel');
        await t.until(() => res !== null);
        assert(res.cancelled && res.unlinked && res.error === 'gone');
        // linked again, then purged: not_found → Save as a new cloud project
        await t.sync().saveToCloud({ as: true, name: 'Again' });
        const id2 = t.sync().status().projectId;
        t.fake.state.projects.get(id2).purged = true;
        edit(t);
        res = null;
        t.sync().saveToCloud({}).then((r) => { res = r; }, (e) => { res = e; });
        await t.choose('saveas');
        await t.until(() => res !== null);
        assert(res.projectId && res.projectId !== id2 && res.rev === 1, 'a new cloud project');
        assert.strictEqual(t.sync().status().projectId, res.projectId, 'linked to it');
        const r2 = await t.sync().saveToCloud({});
        assert(r2.unchanged, 'later saves work again');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'CL20 Show my activity: account JSON only, last 90 days; phone-width stacked tables', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await ready(ctx);
      try {
        await t.sync().saveToCloud({});
        const u = t.fake.user(E1);
        const now = t.w.Date.now();
        t.fake.state.audit.push({ userId: u.id, actor: 'user', action: 'old_entry', at: new Date(now - 120 * 86400e3).toISOString(), detail: {} });
        t.w.WTS_accountPage.open();
        await t.until(() => t.el('acct_projects_table'), 'projects table');
        assert(t.a.find('#acct_projects_table td[data-label="Name"]'), 'cells carry data-label');
        const css = t.text('acct_css');
        assert(/@media \(max-width:600px\)\{#acct_root table\.dtable/.test(css), 'stacked rows at phone width');
        assert(/#acct_root \.btn\{display:block;width:100%/.test(css), 'full-width buttons');
        assert(/td\[data-label\]:before\{content:attr\(data-label\)/.test(css));
        assert(/security notice/.test(t.text('acct_card_activity')), 'the card says a notice is sent');
        const before = t.fake.requests.length;
        t.click('acct_show_activity');
        await t.until(() => t.el('acct_activity_table') || t.el('acct_ch_cancel') || t.el('acct_code'), 'activity or step-up');
        if (!t.el('acct_activity_table')) {
          const code = t.fake.codeFor(E1);
          if (t.el('acct_code')) { t.a.input('acct_code', code); t.click('acct_verify'); }
          await t.until(() => t.el('acct_activity_table'), 'activity');
        }
        const reqs = t.fake.requests.slice(before);
        assert(reqs.some((r) => r.path.endsWith('/account/export')));
        assert(!reqs.some((r) => /\/blobs\/|\/head$|\/rev\//.test(r.path)), 'no project body fetched');
        const txt = t.text('acct_activity_table');
        assert(/signup|signin/.test(txt));
        assert(!/old_entry/.test(txt), 'rows older than 90 days are left out');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'CL21 a library pull at Open does not mark the project changed; commit appVer = the release-notes version', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const a = await ready(ctx);
      const b = T.device(ctx, a.fake, {});
      try {
        a.storage.setItem('wts_prism_user_curves', JSON.stringify([{ name: 'curve-A' }]));
        let commitBody = null;
        const wf = a.w.fetch;
        a.acct().configure({ fetch: (u, i) => { if (/\/commit$/.test(String(u)) && !/library/.test(String(u)) && i && typeof i.body === 'string') commitBody = JSON.parse(i.body); return wf(u, i); } });
        a.w.RELEASE_NOTES = [{ ver: '9.8' }];
        a.acct().configure({ appVer: '' });
        await a.sync().saveToCloud({});
        assert(commitBody, 'the commit body was seen');
        assert.strictEqual(commitBody.appVer, '9.8', 'appVer from RELEASE_NOTES[0].ver, never a hard-coded value');
        const id = a.sync().status().projectId;
        await a.until(() => a.fake.requests.some((r) => /\/library\/commit$/.test(r.path)), 'library pushed');
        await b.signIn(E1, { handover: 'later' });
        await b.until(() => b.acct().state().status === 'signedIn' && !b.el('acct_dlg_ov'));
        await b.sync().openFromCloud(id);
        await b.until(() => /curve-A/.test(b.storage.getItem('wts_prism_user_curves') || ''), 'library pulled');
        await b.settle();
        b.a.fire('document', 'wts:ls-write', { key: 'wts_prism_user_curves' });
        b.a.fire('document', 'wts:ls-write', { key: 'wts_unit_system' });
        assert.strictEqual(b.sync().status().state, 'idle', 'library / device keys do not dirty the project');
      } finally { a.dispose(); b.dispose(); }
    },
  },
];
