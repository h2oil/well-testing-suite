// Accounts WP-C1 — migration of local work, device hand-over, the public-computer wipe and the locked outbox
// (docs/ACCOUNTS-PLAN.md §5.5, §10, §11.2 step 5; §12.2 acct-migrate). Production location + the in-memory fake API.
//
//   MG1  empty browser, the account has projects: "Open your latest cloud project?" → it opens
//   MG2  pre-account work on a personal browser, empty account: upload preview (name, wells, pages, size) → a 'migrate'
//        project, the pre-account snapshot pinned, migratedFor recorded
//   MG3  own work, the account has projects: Upload / Open instead / Not now; Not now leaves it unlinked ("Not in cloud") and
//        the question comes back at the next sign-in
//   MG4  foreign work: A uploads and signs out keeping the copy; B signs in → "work from another account", nothing uploaded by
//        default; Start empty stashes A's work and empties the browser; A signs in again → the stash comes back
//   MG5  foreign work, More…: the confirmation names the client and the wells; Upload puts it into B's account
//   MG6  unknown work ('unowned' after another user's session) is treated like foreign work
//   MG7  over the size cap: the preview lists the large parts and offers the upload without bulk data
//   MG8  the pinned pre-account snapshot never rotates (after further saves and opens)
//   MG9  public sign-out with unsaved work: blocked; "Keep the waiting changes locked" stores only the encrypted outbox,
//        everything else is wiped (storage keys, IndexedDB records, hint), the shared-browser flag stays
//   MG10 public sign-out while the cloud is unreachable: Try to upload fails, the question comes back, lock works offline
//   MG11 public expiry at load: past the absolute expiry the reload leaves no client data (only the encrypted outbox), no request
//   MG12 the same user unlocks and pushes the locked outbox after signing in again; another user cannot
//   MG13 a public device's 401 signed_out wipes the browser
//   MG14 trusted sign-out "Remove it from this browser": the project goes, the library stays
'use strict';

const T = require('./_acct-app');
const WP = 'ACM';
const E1 = 'name@company.example';
const E2 = 'colleague@company.example';

async function settleDialog(t) { await t.until(() => !t.el('acct_dlg_ov') || t.choices().length || t.el('acct_consent_ok'), 'dialog settled'); }
async function signInPlain(t, email, o) {
  await t.signIn(email, o || {});
  await t.until(() => t.acct().state().status === 'signedIn', 'signed in');
  await settleDialog(t);
}
const kvKeys = (t) => t.idb.keys('wts-sync', 'kv');
const kv = (t, k) => t.idb.get('wts-sync', 'kv', k);
const projectKeys = (t) => Object.keys(t.storage.__snapshot()).filter((k) => /^(wts_|h2oil_)/.test(k) && !/^(wts_unit_system|wts_ui_|wts_prism_sample_suppress|wts_prism_migrated)/.test(k));
function proj(fake, email) { const u = fake.user(email); return Array.from(fake.state.projects.values()).filter((p) => p.userId === u.id && !p.purged); }

module.exports = [
  {
    name: 'MG1 empty browser, account with projects: "Open your latest cloud project?" opens it', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const a = T.boot(ctx, { seed: true });
      const b = T.device(ctx, a.fake, {});
      try {
        await signInPlain(a, E1);
        await a.choose('upload');
        await a.until(() => proj(a.fake, E1).length === 1 && a.sync().status().state === 'idle', 'uploaded');
        assert(!b.sync()._hasLocalWork(), 'device B is empty');
        await b.signIn(E1);
        await b.until(() => b.el('acct_ch_open'), 'open offer');
        assert(/Open "Example-1"/.test(b.dialogText()));
        await b.choose('open');
        await b.until(() => b.storage.getItem('wts_page_hydrate'), 'opened');
        assert.strictEqual(b.sync().status().projectId, proj(a.fake, E1)[0].id);
      } finally { a.dispose(); b.dispose(); }
    },
  },
  {
    name: 'MG2 pre-account work, empty account: upload preview, a migrate project, pre-account snapshot pinned', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, { seed: true });
      try {
        await t.until(() => kv(t, 'device'), 'device record at mount');
        assert.strictEqual(kv(t, 'device').workOwner, 'unowned', 'pre-account work is unowned');
        await signInPlain(t, E1);
        const txt = t.dialogText();
        assert(/Put the work on this device into your account\?/.test(txt));
        assert(/Project: Example-1 \(Operator Energy Ltd\)/.test(txt) && /Wells: 1/.test(txt) && /Pages with inputs: 1/.test(txt) && /Size: \d+ kB/.test(txt), txt);
        assert.deepStrictEqual(T.J(t.choices()), ['upload', 'later']);
        assert.strictEqual(proj(t.fake, E1).length, 0, 'nothing uploaded before the choice');
        await t.choose('upload');
        await t.until(() => proj(t.fake, E1).length === 1 && t.sync().status().state === 'idle', 'uploaded');
        assert.strictEqual(proj(t.fake, E1)[0].revs[0].reason, 'migrate');
        await t.until(() => kv(t, 'preAccount') && kv(t, 'migratedFor'), 'records');
        assert(JSON.stringify(kv(t, 'preAccount').payload).includes('Operator Energy Ltd'));
        assert.deepStrictEqual(kv(t, 'migratedFor'), [t.fake.user(E1).id]);
        assert.strictEqual(kv(t, 'device').workOwner, t.fake.user(E1).id);
      } finally { t.dispose(); }
    },
  },
  {
    name: 'MG3 own work with existing projects: Upload / Open instead / Not now; Not now stays unlinked and asks again', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const a = T.boot(ctx, { seed: true });
      try {
        await signInPlain(a, E1);
        await a.choose('upload');
        await a.until(() => a.sync().status().state === 'idle');
        await a.sync().saveToCloud({ as: true, name: 'Second' });
        await a.sync().unlink();
        a.storage.setItem('wts_page_choke', JSON.stringify({ v: 1, t: 1, f: { bean: '28' } }));
        await a.acct().signOut({ keep: true });
        await signInPlain(a, E1);
        assert(/Your work on this device/.test(a.dialogText()));
        assert.deepStrictEqual(T.J(a.choices()), ['upload', 'open', 'later']);
        await a.choose('later');
        assert.strictEqual(a.sync().status().state, 'off');
        await a.until(() => /Not in cloud/.test(a.text('acct_chip')));
        await a.acct().signOut({ keep: true });
        await signInPlain(a, E1);
        assert.deepStrictEqual(T.J(a.choices()), ['upload', 'open', 'later'], 'asked again while not linked');
        await a.choose('open');
        await a.until(() => a.el('acct_ch_p0'), 'project picker after the migrate upload');
        assert(proj(a.fake, E1).some((p) => p.revs[0].reason === 'migrate' && p.revs.length === 1), 'local work uploaded first');
        await a.choose('p0');
        await a.until(() => a.sync().status().state === 'idle', 'opened');
      } finally { a.dispose(); }
    },
  },
  {
    name: 'MG4 foreign work: no default upload; Start empty stashes it; the owner gets it back at the next sign-in', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, { seed: true });
      try {
        await signInPlain(t, E1);
        await t.choose('upload');
        await t.until(() => t.sync().status().state === 'idle');
        await t.acct().signOut({ keep: true });
        await t.until(() => t.acct().state().status === 'signedOut');
        await signInPlain(t, E2);
        assert(/This browser holds work from another account/.test(t.dialogText()));
        assert.deepStrictEqual(T.J(t.choices()), ['empty', 'signout', 'more']);
        assert.strictEqual(t.fake.user(E2) && proj(t.fake, E2).length, 0, 'nothing uploaded into B by default');
        await t.choose('empty');
        await t.until(() => !t.storage.getItem('wts_page_hydrate'), 'emptied');
        const st = kv(t, 'stash');
        assert(st && st[t.fake.user(E1).id] && JSON.stringify(st).includes('Operator Energy Ltd'), 'stashed under A');
        assert.strictEqual(kv(t, 'device').workOwner, t.fake.user(E2).id);
        await t.acct().signOut({ keep: true });
        await t.signIn(E1);
        await t.until(() => t.storage.getItem('wts_page_hydrate'), 'stash restored for A');
        await t.until(() => !kv(t, 'stash')[t.fake.user(E1).id], 'stash entry removed');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'MG5 foreign work, More…: the confirmation names the client and the wells; Upload puts it into B\'s account', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, { seed: true });
      try {
        await signInPlain(t, E1);
        await t.choose('later');
        await t.acct().signOut({ keep: true });
        await signInPlain(t, E2);
        await t.choose('more');
        await t.until(() => t.el('acct_ch_upload'), 'confirmation');
        assert(/Upload 'Operator Energy Ltd — Example-1' into c•••@company\.example's account\?/.test(t.dialogText()), t.dialogText());
        await t.choose('upload');
        await t.until(() => proj(t.fake, E2).length === 1, 'uploaded into B');
        assert.strictEqual(proj(t.fake, E2)[0].revs[0].reason, 'migrate');
        assert.strictEqual(proj(t.fake, E1).length, 0);
      } finally { t.dispose(); }
    },
  },
  {
    name: 'MG6 unknown work (unowned after another user\'s session) is treated like foreign work', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, { seed: true });
      try {
        await t.sync()._init();
        await t.sync()._store.put('device', t.a.toWin({ deviceId: null, lastUserId: 'someone-else', workOwner: 'unowned', workOwnerAt: 1, signedOutAfterOwner: false }));
        const t2 = t.reload();
        try {
          await signInPlain(t2, E1);
          assert(/This browser holds work from another account/.test(t2.dialogText()));
          assert.strictEqual(t2.sync()._classify(t2.acct().state().user), 'unknown');
          await t2.choose('empty');
          await t2.until(() => kv(t2, 'stash') && kv(t2, 'stash')['unknown:someone-else'], 'stashed as unknown');
        } finally { t2.dispose(); }
      } finally { t.dispose(); }
    },
  },
  {
    name: 'MG7 over the size cap: the preview lists the large parts and offers the upload without bulk data', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, { seed: { big: 90000 } });
      try {
        t.acct().configure({ maxProjectBytes: 50000 });
        await signInPlain(t, E1);
        const txt = t.dialogText();
        assert(/Over the 50 kB cloud limit/.test(txt) && /wts_prism 90 kB/.test(txt), txt);
        assert.deepStrictEqual(T.J(t.choices()), ['upload_lite', 'later']);
        await t.choose('upload_lite');
        await t.until(() => proj(t.fake, E1).length === 1, 'uploaded');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'MG8 the pinned pre-account snapshot never rotates', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, { seed: true });
      try {
        await signInPlain(t, E1);
        await t.choose('upload');
        await t.until(() => t.sync().status().state === 'idle' && kv(t, 'preAccount'));
        const pinned = JSON.stringify(kv(t, 'preAccount'));
        const id = t.sync().status().projectId;
        for (let i = 0; i < 3; i++) {
          t.storage.setItem('wts_page_hydrate', JSON.stringify({ v: 1, t: i + 10, f: { hy_T: String(50 + i) } }));
          t.a.fire('document', 'wts:autosaved', {});
          await t.sync().saveToCloud({});
          await t.sync().openFromCloud(id);
        }
        assert.strictEqual(JSON.stringify(kv(t, 'preAccount')), pinned, 'unchanged');
        assert(kv(t, 'safety').length <= 2, 'safety copies rotate (2)');
        t.w.WTS_accountPage.open();
        await t.until(() => t.el('acct_pre_restore'), 'the account page lists it');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'MG9 public sign-out with unsaved work: blocked; lock keeps only the encrypted outbox; all else wiped; shared flag kept', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, { seed: true, storage: T.createStorage({ wtspref_cloud_beta: '1', wts_prism_user_curves: '[1]' }) });
      try {
        await signInPlain(t, E1, { publicDevice: true });
        await t.choose('later');
        assert(t.sync()._state(), 'state');
        let done = false;
        t.acct().signOut().then(() => { done = true; });
        await t.until(() => t.el('acct_ch_lock'), 'blocked');
        assert.deepStrictEqual(T.J(t.choices()), ['upload', 'download', 'lock', 'cancel']);
        await t.choose('lock');
        await t.until(() => done && t.acct().state().status === 'signedOut', 'signed out');
        assert.deepStrictEqual(projectKeys(t), [], 'no project, library or client key left: ' + projectKeys(t).join(','));
        assert.strictEqual(t.storage.getItem('wtsacct_hint'), null);
        assert.strictEqual(t.storage.getItem('wtspref_shared_browser'), '1', 'shared flag kept');
        await t.until(() => kvKeys(t).indexOf('lockedOutbox') !== -1);
        const keys = kvKeys(t).filter((k) => k !== 'device');
        assert.deepStrictEqual(keys, ['lockedOutbox']);
        const dev = kv(t, 'device');
        assert(!dev || (dev.lastUserId === null && dev.workOwner === null), 'the device record names no one');
        const all = JSON.stringify(kvKeys(t).map((k) => kv(t, k)));
        assert(!/Operator Energy|Example-1|hy_T/.test(all), 'no client data in clear in IndexedDB');
        assert.strictEqual(kv(t, 'lockedOutbox').userId, t.fake.user(E1).id);
        assert.strictEqual(t.br.cookie('__Host-wts_sid'), null);
      } finally { t.dispose(); }
    },
  },
  {
    name: 'MG10 public sign-out while the cloud is unreachable: upload fails, the question returns, lock works offline', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, { seed: true });
      try {
        await signInPlain(t, E1, { publicDevice: true });
        await t.choose('upload');
        await t.until(() => t.sync().status().state === 'idle');
        t.storage.setItem('wts_page_hydrate', JSON.stringify({ v: 1, t: 77, f: { hy_T: '44' } }));
        t.a.fire('document', 'wts:autosaved', {});
        t.fake.fault({ path: '*', mode: 'network', times: 50 });
        let done = false;
        t.acct().signOut().then(() => { done = true; });
        await t.choose('upload');
        await t.until(() => t.el('acct_ch_lock'), 'asked again after the failed upload');
        await t.choose('lock');
        await t.until(() => done, 'signed out');
        assert(kv(t, 'lockedOutbox'), 'locked with the key held in memory since sign-in');
        assert.deepStrictEqual(projectKeys(t), []);
        t.fake.clearFaults();
      } finally { t.dispose(); }
    },
  },
  {
    name: 'MG11 public expiry at load: the reload leaves no client data (only the encrypted outbox) and makes no request', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, { seed: true });
      try {
        await signInPlain(t, E1, { publicDevice: true });
        await t.choose('upload');
        await t.until(() => t.sync().status().state === 'idle');
        await t.sync().lockOutbox(t.acct().state().user);
        assert(kvKeys(t).length >= 4);
        const h = JSON.parse(t.storage.getItem('wtsacct_hint'));
        t.storage.setItem('wtsacct_hint', JSON.stringify(Object.assign(h, { absExpires: '2000-01-01T00:00:00.000Z' })));
        t.dispose();
        const n = t.fake.requests.length;
        const t2 = t.reload();
        try {
          assert.deepStrictEqual(projectKeys(t2), [], 'wiped before anything is shown');
          assert.strictEqual(t2.storage.getItem('wtsacct_hint'), null);
          await t2.until(() => kvKeys(t2).filter((k) => k !== 'device').join() === 'lockedOutbox', 'IndexedDB: only the locked outbox');
          assert.strictEqual(t.fake.requests.length, n, 'no request');
          assert(/Sign in/.test(t2.text('acct_chip')));
        } finally { t2.dispose(); }
      } finally { t.dispose(); }
    },
  },
  {
    name: 'MG12 the same user unlocks and pushes the locked outbox after signing in again; another user cannot', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, { seed: true });
      try {
        await signInPlain(t, E1, { publicDevice: true });
        await t.choose('upload');
        await t.until(() => t.sync().status().state === 'idle');
        const id = t.sync().status().projectId;
        t.storage.setItem('wts_page_hydrate', JSON.stringify({ v: 1, t: 88, f: { hy_T: '47' } }));
        t.a.fire('document', 'wts:autosaved', {});
        let done = false;
        t.acct().signOut().then(() => { done = true; });
        await t.choose('lock');
        await t.until(() => done);
        await signInPlain(t, E2);
        assert(kv(t, 'lockedOutbox'), 'another user does not unlock it');
        await t.acct().signOut({ keep: true });
        await t.until(() => t.acct().state().status === 'signedOut');
        await t.signIn(E1);
        await t.until(() => !kv(t, 'lockedOutbox'), 'unlocked and pushed');
        const revs = t.fake.state.projects.get(id).revs;
        assert.strictEqual(revs.length, 2, 'a new revision from the locked changes');
        const files = await t.sync().projectFile(id);
        assert.strictEqual(JSON.parse(JSON.parse(files.text).modules.storage.keys.wts_page_hydrate).f.hy_T, '47');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'MG13 a public device\'s 401 signed_out wipes the browser', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, { seed: true });
      try {
        await signInPlain(t, E1, { publicDevice: true });
        await t.choose('later');
        assert(t.storage.getItem('wts_page_hydrate'));
        t.fake.fault({ path: '/me', mode: 'signed_out', times: 2 });
        await t.acct().refresh();
        await t.until(() => t.acct().state().status === 'signedOut');
        assert.deepStrictEqual(projectKeys(t), []);
        assert.strictEqual(t.storage.getItem('wtsacct_hint'), null);
      } finally { t.dispose(); }
    },
  },
  {
    name: 'MG14 trusted sign-out "Remove it from this browser": the project goes, the library stays', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, { seed: true, storage: T.createStorage({ wtspref_cloud_beta: '1', wts_prism_user_curves: '[1]' }) });
      try {
        await signInPlain(t, E1);
        await t.choose('upload');
        await t.until(() => t.sync().status().state === 'idle');
        let done = false;
        t.acct().signOut().then(() => { done = true; });
        await t.choose('remove');
        await t.until(() => done);
        assert.strictEqual(t.storage.getItem('wts_page_hydrate'), null);
        assert.strictEqual(t.storage.getItem('wts_prism_user_curves'), '[1]', 'the library stays on a trusted device');
        assert.strictEqual(t.sync().status().projectId, null);
      } finally { t.dispose(); }
    },
  },
];
