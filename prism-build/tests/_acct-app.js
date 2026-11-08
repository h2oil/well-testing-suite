'use strict';
// prism-build/tests/_acct-app.js — helpers for the WP-C1 account client tests (acct-signin, acct-cloud, acct-migrate, …).
//
//   const T = require('./_acct-app');
//   const t = T.boot(ctx, { fake?, storage?, idb?, browser?, beta: true, switches, quota })  — one browser tab on the production
//         location with the fake API (docs/ACCOUNTS-PLAN.md §12.1), the IndexedDB fake, node zlib for gzip and the beta flag
//   t.a (the harness app), t.w (its window), t.fake, t.br (this device's fake browser), t.idb, t.storage
//   await t.settle()                      — microtasks + due timers until the promise chains have run
//   await t.signIn(email, {publicDevice, consent, handover})  — the e-mail-code flow through the dialog
//   t.choose(id)                          — click a choice button of the dialog (acct_ch_<id>)
//   t.reload()                            — a new page load on the same device (same storage, IndexedDB and cookie jar)
//   T.device(ctx, fake, o)                — a second device: its own storage, IndexedDB and cookie jar
//   T.hostReady(t)                        — the WP-H host hooks present? (registerToolbarItems, registerGuard, navHidden host div)

const zlib = require('zlib');
const F = require('./_acct-fake-server');
const { createFakeIDB } = require('./_buildup-idb-fake');
const { createStorage } = require('./_harness');

function abs(u) { u = String(u); return u.startsWith('/') ? F.PROD + u : u; }

function boot(ctx, o) {
  o = o || {};
  const clock = { a: null };
  const fake = o.fake || F.createFakeServer({ now: () => (clock.a ? clock.a.win.Date.now() : Date.now()), switches: o.switches, allow: o.allow, quota: o.quota });
  const br = o.browser || (o.fake ? fake.browser('dev-' + Math.random().toString(36).slice(2, 7)) : fake);
  const storage = o.storage || createStorage(o.beta === false ? {} : { wtspref_cloud_beta: '1' });
  const idb = o.idb || createFakeIDB();
  const loc = F.prodLocation(o.path);
  if (o.hash) { loc.hash = o.hash; loc.href += o.hash; }
  const globals = Object.assign({ fetch: (u, i) => br.fetch(abs(u), i), location: loc }, o.globals || {});
  const a = ctx.loadApp({ timers: 'manual', console: 'capture', storage, viewport: o.viewport, globals, confirm: o.confirm, prompt: o.prompt });
  clock.a = a;
  if (!fake._clockApp) fake._clockApp = a;
  const w = a.win;
  if (w.WTS_account && w.WTS_account.configure) {
    w.WTS_account.configure({ idb: idb.indexedDB, gzip: (b) => zlib.gzipSync(Buffer.from(b.buffer, b.byteOffset, b.byteLength)),
      gunzip: (b) => zlib.gunzipSync(Buffer.from(b.buffer, b.byteOffset, b.byteLength)), appVer: '3.5' });
  }
  a.flush(1);
  const t = {
    a, w, fake, br, idb, storage, o,
    async settle(n) { for (let i = 0; i < (n || 60); i++) { await new Promise((r) => setImmediate(r)); a.flush(0); } },
    el: (id) => a.el(id),
    text: (id) => { const e = a.el(id); return e ? String(e.textContent || '') : ''; },
    click(id) { const e = a.el(id); if (!e) throw new Error('no element #' + id + ' (dialog: ' + (a.el('acct_dlg_body') ? a.el('acct_dlg_body').textContent.slice(0, 160) : 'closed') + ')'); a.click(e); },
    async choose(id) { await t.settle(); t.click('acct_ch_' + id); await t.settle(); },
    choices() { return a.findAll('[data-choice]').map((b) => b.getAttribute('data-choice')); },
    dialogText() { const b = a.el('acct_dlg'); return b ? String(b.textContent || '') : ''; },
    async signIn(email, so) {
      so = so || {};
      w.WTS_account.openSignIn();
      await t.settle();
      a.input('acct_email', email);
      if (so.publicDevice) a.check('acct_public', true);
      t.click('acct_send');
      await t.settle();
      const code = fake.codeFor(email, 'code_signin');
      a.input('acct_code', code);
      t.click('acct_verify');
      await t.settle();
      if (a.el('acct_consent_ok')) {
        if (so.consent === false) return { consentShown: true };
        a.check('acct_consent_ok', true);
        t.click('acct_create');
        await t.settle();
      }
      if (so.handover && a.el('acct_ch_' + so.handover)) await t.choose(so.handover);
      return { code };
    },
    reload(extra) {
      const t2 = boot(ctx, Object.assign({}, o, { fake, browser: br, storage, idb }, extra || {}));
      return t2;
    },
    dispose() { try { a.dispose(); } catch (e) { /* none */ } },
  };
  return t;
}
function device(ctx, fake, o) { return boot(ctx, Object.assign({}, o || {}, { fake, browser: fake.browser('device-' + Math.random().toString(36).slice(2, 7)) })); }
function hostReady(t) {
  const P = t.w.WTS_project;
  return !!(P && typeof P.registerToolbarItems === 'function' && typeof P.registerGuard === 'function');
}
// seed a small local project (Client & Well Info + one page autosave)
function seedWork(t, o) {
  o = o || {};
  const s = t.storage;
  s.setItem('h2oil_client_info', JSON.stringify({ client: o.client || 'Operator Energy Ltd', well: o.well || 'Example-1', field: '', operator: '' }));
  s.setItem('wts_page_hydrate', JSON.stringify({ v: 1, t: 1, f: { hy_T: o.T || '38' } }));
  if (o.big) s.setItem('wts_prism', 'x'.repeat(o.big));
}
module.exports = { boot, device, hostReady, seedWork, abs, F };
