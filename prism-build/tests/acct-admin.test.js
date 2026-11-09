// Accounts — the sidebar chip, the signed-out welcome prompt and the owner's admin page (66 / 68 / 69). The app runs on the
// production https location against the in-memory fake API (tests/_acct-fake-server.js) with the invite-beta flag; the admin
// routes and the admin flag of GET /me are added by a small fetch wrapper (the server side is tested in server/test).
//
//   AW1  the chip host sits in the sidebar footer (#sbAccountLine, bottom-left), full width, "Sign in / Sign up" while signed out
//   AW2  signed in: the chip menu opens upward (fixed, bottom-anchored, no top), Escape closes it; "Admin dashboard" only for an admin
//   AW3  welcome prompt: modal dialog once on a first signed-out visit; Esc = guest, stored as the wtspref_ device pref; not again
//        on a reload; offered again after 30 days; Tab stays inside the dialog; the pref never travels in a project file
//   AW4  welcome prompt waits for the consent banner and the Terms notice (never stacked), skips the help / account / privacy
//        routes and shows on the next page change; never while signed in, never with the switch off or without the beta flag
//   AW5  "Create free account" opens the sign-in dialog on its sign-up path (title, invitation note, the invite-mode code error)
//   AW6  admin page: a normal account (and a 404 from the server) sees "Not available"; an admin sees KPIs, countries with names
//        and flags, the sign-up chart, the users table, Load more (cursor), search (q), CSV, invite POST and its list
//   AW7  every server string is escaped: a malicious e-mail / note / city never becomes markup (page and CSV)
//   AW8  a load with #admin opens the admin route ("Not available" for a normal account); the route is in the host skip tables
//   AW9  a Search while the first users page is still loading wins (the late unfiltered answer is dropped, view.q / next agree);
//        the country caption names the sign-up fallback; the share column follows the decimal-comma setting
'use strict';

const T = require('./_acct-app');
const WP = 'ACAD';
const E1 = 'owner@company.example';
const DAY = 24 * 3600 * 1000;
const BASE = Date.UTC(2026, 8, 29, 9, 0, 0);   // the harness's virtual clock starts here (manual timers)
const EVIL = '<img src=x onerror="alert(1)">@evil.example';

function json(status, body) {
  const text = JSON.stringify(body);
  return Promise.resolve({ status, headers: { get: (n) => (String(n).toLowerCase() === 'content-type' ? 'application/json' : null), has: () => false, forEach() {} },
    json: () => Promise.resolve(JSON.parse(text)), arrayBuffer: () => Promise.resolve(Buffer.from(text)) });
}
const SUMMARY = {
  generatedAt: '2026-11-09T10:00:00.000Z',
  totals: { users: 3, active7d: 2, active30d: 3, projects: 5, storageBytes: 2500000, invitesPending: 1 },
  byCountry: [{ country: 'AE', users: 2, active30d: 2 }, { country: null, users: 1, active30d: 1 }],
  byMethod: [{ method: 'code', users: 2 }, { method: 'google', users: 1 }],
  signupsByDay: [{ day: '2026-11-01', n: 2 }, { day: '2026-11-09', n: 1 }],
};
const U = (id, email, more) => Object.assign({ id: '00000000-0000-4000-8000-00000000000' + id, email, method: 'code', status: 'active', createdAt: '2026-11-0' + id + 'T08:00:00.000Z',
  lastSignInAt: '2026-11-09T09:00:00.000Z', signupCountry: 'AE', lastCountry: 'AE', lastCity: 'Dubai', projects: 2, usedBytes: 1200000 }, more || {});
const PAGE1 = [U(1, EVIL, { lastCity: '<b>Dubai</b>' }), U(2, 'b@company.example', { method: 'google', lastCountry: 'GB', lastCity: null })];
const PAGE2 = [U(3, 'c@company.example', { method: 'linkedin', signupCountry: null, lastCountry: null, lastCity: null, lastSignInAt: null })];

// the admin API fake: admin.on = the account is an admin (GET /me admin:true, admin routes answer); otherwise 404 not_found
function boot(ctx, o) {
  o = o || {};
  const F = T.F;
  const fake = F.createFakeServer({});
  const br = fake.browser('dev-admin');
  const admin = { on: !!o.admin, log: [], invites: [{ addedAt: '2026-11-08T12:00:00.000Z', note: '<script>x</script>' }] };
  const fetch = (u, i) => {
    const url = T.abs(u); const p = new URL(url).pathname; const method = (i && i.method) || 'GET';
    if (p.startsWith('/api/v1/admin/')) {
      const body = i && typeof i.body === 'string' ? JSON.parse(i.body) : null;
      admin.log.push({ url, path: p, method, body, headers: Object.assign({}, (i && i.headers) || {}) });
      if (!admin.on) return json(404, { error: 'not_found' });
      const q = new URL(url).searchParams;
      if (p === '/api/v1/admin/summary') return json(200, SUMMARY);
      if (p === '/api/v1/admin/users' && admin.hold) {
        // a held answer (AW9): resolved by the test, so a later request can overtake it
        const h = admin.hold; admin.hold = null;
        return h.then(() => json(200, { users: PAGE1, next: 'c1' }));
      }
      if (p === '/api/v1/admin/users') {
        if (q.get('q')) return json(200, { users: PAGE1.concat(PAGE2).filter((x) => x.email.indexOf(q.get('q')) !== -1), next: null });
        return json(200, q.get('cursor') === 'c1' ? { users: PAGE2, next: null } : { users: PAGE1, next: 'c1' });
      }
      if (p === '/api/v1/admin/invites' && method === 'POST') { admin.invites.unshift({ addedAt: '2026-11-09T10:05:00.000Z', note: body.note || null }); return json(201, { ok: true }); }
      if (p === '/api/v1/admin/invites') return json(200, { invites: admin.invites });
      return json(404, { error: 'not_found' });
    }
    return br.fetch(url, i).then((r) => {
      if (p !== '/api/v1/me' || r.status !== 200) return r;
      return { status: r.status, headers: r.headers, json: () => r.json().then((j) => Object.assign(j, { admin: admin.on })) };
    });
  };
  const t = T.boot(ctx, Object.assign({}, o, { fake, browser: br, globals: Object.assign({ fetch }, o.globals || {}) }));
  t.admin = admin;
  return t;
}
// a storage where the consent banner and the Terms notice are already dealt with
function settledStore(extra) {
  return T.createStorage(Object.assign({ wtspref_cloud_beta: '1', wtspref_terms_seen: JSON.stringify({ v: 1, at: Date.now() }),
    wtspref_analytics_consent: JSON.stringify({ choice: 'denied', v: 2, at: Date.now() }) }, extra || {}));
}
async function signedIn(ctx, o) {
  const t = boot(ctx, o);
  await t.signIn(E1);
  await t.until(() => t.acct().state().status === 'signedIn', 'signed in');
  await t.settle();
  return t;
}

module.exports = [
  {
    name: 'AW1 the chip sits at the bottom-left: #wts_account_host moved into the sidebar footer, full width, "Sign in / Sign up"', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = boot(ctx, {});
      try {
        t.a.flush(10);
        const host = t.el('wts_account_host');
        assert(host && host.parentNode && host.parentNode.id === 'sbAccountLine', 'host in #sbAccountLine');
        assert(host.parentNode.parentNode.className.indexOf('sidebar-footer') !== -1, 'inside the sidebar footer');
        assert.strictEqual(host.className, 'acct-host-sb');
        const chip = t.el('acct_chip');
        assert(/Sign in \/ Sign up/.test(chip.textContent), chip.textContent);
        assert.strictEqual(chip.getAttribute('aria-label'), 'Sign in');
        assert(/acct-chip--out/.test(chip.className));
        const css = t.text('acct_css');
        assert(/\.acct-host-sb \.acct-chip\{display:flex;width:100%/.test(css), 'full-width chip rule');
        assert(/#sidebar \.sidebar-footer\{position:sticky;bottom:0/.test(css), 'the footer sticks to the sidebar bottom');
        assert(!t.a.find('.page-actions #acct_chip'), 'no chip left in the header');
        t.click('acct_chip');
        await t.until(() => t.el('acct_email'), 'sign-in dialog');
        assert.strictEqual(t.fake.requests.filter((r) => /\/me$/.test(r.path)).length, 0, 'no /me for a signed-out visit');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'AW2 signed in: the menu opens upward (fixed, bottom-anchored), Escape closes; Admin dashboard only for an admin', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx, {});
      try {
        assert(t.el('acct_chip').querySelector('.acct-caret'), 'an up caret on the sidebar chip');
        t.click('acct_chip');
        const m = t.el('acct_menu');
        assert(m, 'menu open');
        assert(/acct-menu--up/.test(m.className), m.className);
        assert(/^\d+px$/.test(m.style.bottom), 'bottom-anchored: ' + m.style.bottom);
        assert(!m.style.top, 'no top: it grows upward');
        assert(/^\d+px$/.test(m.style.left) && /^\d+px$/.test(m.style.maxHeight));
        assert(/\.acct-menu\.acct-menu--up\{position:fixed;top:auto/.test(t.text('acct_css')));
        assert(t.el('acct_m_page') && t.el('acct_m_signout'), 'the usual items');
        assert(!t.el('acct_m_admin'), 'no admin item for a normal account');
        assert.strictEqual(t.el('acct_chip').getAttribute('aria-expanded'), 'true');
        t.a.key('acct_m_save', 'Escape');
        assert(!t.el('acct_menu'), 'Escape closes the menu');
        assert.strictEqual(t.el('acct_chip').getAttribute('aria-expanded'), 'false');
        assert.strictEqual(t.acct().isAdmin(), false);
      } finally { t.dispose(); }
      const t2 = await signedIn(ctx, { admin: true });
      try {
        assert.strictEqual(t2.acct().isAdmin(), true);
        t2.click('acct_chip');
        assert(t2.el('acct_m_admin'), 'Admin dashboard in the menu');
        assert.strictEqual(t2.text('acct_m_admin'), 'Admin dashboard');
        t2.click('acct_m_admin');
        await t2.until(() => t2.el('adm_kpis') && t2.el('adm_k_users'), 'admin page');
        assert.strictEqual(t2.text('pgTitle'), 'Admin dashboard');
      } finally { t2.dispose(); }
    },
  },
  {
    name: 'AW3 welcome prompt: once, modal, Esc = guest (wtspref_ pref), not on reload, again after 30 days, Tab trapped', wp: WP, opts: false,
    async run(app, assert, ctx) {
      let clock = Date.now();
      const storage = settledStore();
      const t = boot(ctx, { welcome: true, storage, now: () => clock });
      try {
        t.a.flush(10);
        const ov = t.el('acct_welcome_ov');
        assert(ov, 'prompt shown');
        const d = t.el('acct_welcome');
        assert.strictEqual(d.getAttribute('role'), 'dialog'); assert.strictEqual(d.getAttribute('aria-modal'), 'true');
        assert.strictEqual(t.text('acct_welcome_t'), 'Keep your work safe');
        const txt = d.textContent;
        assert(/Create free account/.test(txt) && /Continue as guest/.test(txt) && /Sign in/.test(txt));
        assert(/save your projects to your account in the cloud with Save to cloud/.test(txt) && /Work you have not saved to the cloud stays only in this browser\./.test(txt), 'Phase 1 wording: manual save, no automatic-keep claim');
        assert(!/all your projects are kept|never lose work|own secure cloud database/.test(txt), 'no claim of automatic keeping or a database of one\'s own');
        assert(/Your work is saved only in this browser on this device\./.test(txt));
        assert(/rp-skip/.test(ov.className) && ov.getAttribute('data-rp-nosnap') === '1', 'never in a report');
        assert.strictEqual(t.w.document.activeElement && t.w.document.activeElement.id, 'acct_welcome_signup', 'focus on the primary choice');
        // Tab cycles inside: guest → (wrap) close button
        t.el('acct_welcome_guest').focus();
        t.a.key('acct_welcome_guest', 'Tab');
        assert.strictEqual(t.w.document.activeElement.id, 'acct_welcome_x', 'Tab wraps to the first control');
        t.a.key('acct_welcome_x', 'Escape');
        assert(!t.el('acct_welcome_ov'), 'Esc closes');
        const pref = JSON.parse(storage.getItem('wtspref_acct_welcome'));
        assert.strictEqual(pref.choice, 'guest'); assert.strictEqual(pref.at, clock);
        assert(!t.el('acct_dlg_ov'), 'guest opens no sign-in dialog');
        // the pref is a device preference: not in a project file
        const P = t.w.WTS_project;
        if (P && typeof P.buildProject === 'function') {
          const proj = JSON.stringify(P.buildProject());
          assert(proj.indexOf('wtspref_acct_welcome') === -1, 'not in the project file');
        }
        t.a.fire('document', 'h2oil:pagechange', { page: 'home' });
        assert(!t.el('acct_welcome_ov'), 'not again in the same visit');
      } finally { t.dispose(); }
      // the visitor comes back 29 days later (the mount runs inside the page load, so the time is set in the stored pref)
      storage.setItem('wtspref_acct_welcome', JSON.stringify({ choice: 'guest', at: BASE - 29 * DAY }));
      const t2 = boot(ctx, { welcome: true, storage });
      try {
        t2.a.flush(10);
        assert(!t2.el('acct_welcome_ov'), 'a guest is not asked again within 30 days');
        assert.strictEqual(t2.acct().welcome.due(), 'answered');
      } finally { t2.dispose(); }
      storage.setItem('wtspref_acct_welcome', JSON.stringify({ choice: 'guest', at: BASE - 31 * DAY }));
      const t3 = boot(ctx, { welcome: true, storage });
      try {
        t3.a.flush(10);
        assert(t3.el('acct_welcome_ov'), 'offered again after 30 days');
        t3.click('acct_welcome_guest');
        assert(!t3.el('acct_welcome_ov'));
        assert(JSON.parse(storage.getItem('wtspref_acct_welcome')).at >= BASE, 'the new choice is dated now');
      } finally { t3.dispose(); }
    },
  },
  {
    name: 'AW4 welcome waits for the consent banner and the Terms notice, skips help / account / privacy, never signed in or switched off', wp: WP, opts: false,
    async run(app, assert, ctx) {
      // consent banner open → waits; the choice → shows
      const s1 = T.createStorage({ wtspref_cloud_beta: '1', wtspref_terms_seen: JSON.stringify({ v: 1, at: Date.now() }) });
      const t = boot(ctx, { welcome: true, storage: s1 });
      try {
        t.a.flush(10);
        const banner = t.el('wtsConsent');
        if (banner && !banner.hidden) {
          assert(!t.el('acct_welcome_ov'), 'never stacked over the consent banner');
          assert.strictEqual(t.acct().welcome.due(), 'consent');
          t.click('wtsConsentReject');
          assert(banner.hidden, 'banner closed');
          assert(t.el('acct_welcome_ov'), 'shown once the banner is dealt with');
        } else {
          assert(t.el('acct_welcome_ov'), 'no banner in this harness: shown at once');
        }
      } finally { t.dispose(); }
      // Terms notice open → waits; OK → shows
      const s2 = T.createStorage({ wtspref_cloud_beta: '1', wtspref_analytics_consent: JSON.stringify({ choice: 'denied', v: 2, at: Date.now() }) });
      const t2 = boot(ctx, { welcome: true, storage: s2 });
      try {
        t2.a.flush(10);
        assert(!t2.el('wtsTermsNote').hidden, 'the Terms notice is up');
        assert(!t2.el('acct_welcome_ov'), 'never stacked over the Terms notice');
        assert.strictEqual(t2.acct().welcome.due(), 'terms');
        t2.click('wtsTermsNoteOk');
        assert(t2.el('acct_welcome_ov'), 'shown after OK');
      } finally { t2.dispose(); }
      // excluded routes: the Terms notice holds the prompt, the visitor goes to Help and presses OK there → still waits (route);
      // Privacy and Account wait too; the next page change to another route shows it
      const s3 = T.createStorage({ wtspref_cloud_beta: '1', wtspref_analytics_consent: JSON.stringify({ choice: 'denied', v: 2, at: Date.now() }) });
      const t3 = boot(ctx, { welcome: true, storage: s3 });
      try {
        t3.a.flush(10);
        assert.strictEqual(t3.acct().welcome.due(), 'terms');
        t3.w.WTS_nav('help');
        t3.click('wtsTermsNoteOk');
        assert(!t3.el('acct_welcome_ov'), 'not on the help route');
        assert.strictEqual(t3.acct().welcome.due(), 'route');
        for (const r of ['privacy', 'account']) {
          t3.w.WTS_nav(r);
          assert(!t3.el('acct_welcome_ov'), 'not on ' + r);
          assert.strictEqual(t3.acct().welcome.due(), 'route', r);
        }
        t3.w.WTS_nav('home');
        assert(t3.el('acct_welcome_ov'), 'shown on the next ordinary page');
        assert.strictEqual(t3.acct().welcome.due(), 'shown');
      } finally { t3.dispose(); }
      // signed in (hint) → never; switch off (the tests' default) → never; no beta flag → nothing mounted
      const t5 = await signedIn(ctx, { welcome: true, storage: settledStore() });
      try {
        assert(!t5.el('acct_welcome_ov'), 'not while signing in / signed in');
        const t6 = t5.reload({ welcome: true });
        try { t6.a.flush(10); await t6.settle(); assert(!t6.el('acct_welcome_ov'), 'a signed-in reload shows no prompt'); assert.strictEqual(t6.acct().welcome.due(), 'signed-in'); }
        finally { t6.dispose(); }
      } finally { t5.dispose(); }
      const t7 = boot(ctx, { storage: settledStore() });
      try { t7.a.flush(10); assert(!t7.el('acct_welcome_ov'), 'switched off'); assert.strictEqual(t7.acct().welcome.due(), 'off'); } finally { t7.dispose(); }
      const t9 = boot(ctx, { welcome: true, beta: false });
      try { t9.a.flush(5000); assert(!t9.el('acct_welcome_ov') && !t9.el('acct_chip'), 'no beta flag: nothing'); assert.strictEqual(t9.a.pendingTimers(), 0); } finally { t9.dispose(); }
    },
  },
  {
    name: 'AW5 Create free account opens the sign-up path of the sign-in dialog (title, invitation note, invite-mode code error)', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const storage = settledStore();
      const t = boot(ctx, { welcome: true, storage });
      try {
        t.a.flush(10);
        t.click('acct_welcome_signup');
        await t.until(() => t.el('acct_email'), 'e-mail step');
        assert(!t.el('acct_welcome_ov'));
        assert.strictEqual(t.text('acct_dlg_t'), 'Create your free account');
        assert(/by invitation during the beta/.test(t.text('acct_signup_note')));
        assert(/If no code arrives within a few minutes, your address may not be invited yet/.test(t.text('acct_signup_note')));
        assert(/save projects to your account with Save to cloud/.test(t.text('acct_dlg_body')) && /Work you have not saved to the cloud stays only in this browser/.test(t.text('acct_dlg_body')), 'sign-up text: Phase 1 manual save');
        assert(!/own secure cloud database/.test(t.text('acct_dlg_body')));
        assert.strictEqual(t.text('acct_send'), 'Send my code');
        assert(t.el('acct_provider_buttons'), 'Google / LinkedIn mount point is there too');
        assert.strictEqual(JSON.parse(storage.getItem('wtspref_acct_welcome')).choice, 'signup');
        // a wrong code on the sign-up path names the invitation route
        t.a.input('acct_email', 'new@company.example'); t.click('acct_send');
        await t.until(() => t.el('acct_code'), 'code step');
        assert(/your address may not be invited yet: write to software@h2oil\.co\.uk/.test(t.text('acct_code_invite')), 'code step: invitation hint on the sign-up path');
        t.a.input('acct_code', '00000000'); t.click('acct_verify');
        await t.until(() => /acct-msg--err/.test(t.el('acct_msg').className), 'error');
        assert(/New accounts are by invitation during the beta/.test(t.text('acct_msg')), t.text('acct_msg'));
        t.click('acct_dlg_x');
        // the ordinary sign-in afterwards has the ordinary title and message
        t.acct().openSignIn();
        await t.until(() => t.el('acct_email'));
        assert.strictEqual(t.text('acct_dlg_t'), 'Sign in to Well Testing Suite');
        assert(!t.el('acct_signup_note'));
      } finally { t.dispose(); }
      const t2 = boot(ctx, { welcome: true, storage: settledStore() });
      try {
        t2.a.flush(10);
        t2.click('acct_welcome_signin');
        await t2.until(() => t2.el('acct_email'));
        assert.strictEqual(t2.text('acct_dlg_t'), 'Sign in to Well Testing Suite');
      } finally { t2.dispose(); }
    },
  },
  {
    name: 'AW6 admin page: Not available for a normal account / a 404; for an admin KPIs, countries, chart, users, Load more, search, CSV, invite', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx, {});
      try {
        assert(t.w.WTS_calcRegistry.admin && t.w.WTS_calcRegistry.admin.navHidden === true, 'route registered, navHidden');
        assert(!t.a.find('.nav-btn[data-p="admin"]'), 'no sidebar button');
        t.w.WTS_nav('admin');
        await t.settle();
        assert.strictEqual(t.text('adm_na'), 'Not available.');
        assert.strictEqual(t.admin.log.length, 0, 'a normal account makes no admin request');
        assert(!t.el('adm_kpis'));
        assert.strictEqual(t.el('exportBtns') ? t.el('exportBtns').style.display : 'none', 'none', 'no page-export bar');
      } finally { t.dispose(); }
      const t2 = await signedIn(ctx, { admin: true });
      try {
        t2.w.WTS_nav('admin');
        await t2.until(() => t2.el('adm_countries_table') && t2.el('adm_users_table') && t2.el('adm_invites_table'), 'admin page loaded');
        const paths = t2.admin.log.map((x) => x.method + ' ' + x.path);
        assert(paths.includes('GET /api/v1/admin/summary') && paths.includes('GET /api/v1/admin/users') && paths.includes('GET /api/v1/admin/invites'), paths.join(', '));
        assert(t2.admin.log.every((x) => x.headers['X-WTS-Req'] === '1'), 'X-WTS-Req on every admin call');
        assert(/limit=50/.test(t2.admin.log.find((x) => x.path.endsWith('/users')).url));
        // KPIs
        assert(/Users\s*3/.test(t2.text('adm_k_users')), t2.text('adm_k_users'));
        assert(/2/.test(t2.text('adm_k_a7')) && /3/.test(t2.text('adm_k_a30')) && /5/.test(t2.text('adm_k_projects')));
        assert(/2\.5 MB/.test(t2.text('adm_k_storage')), t2.text('adm_k_storage'));
        assert(/1/.test(t2.text('adm_k_invites')));
        assert(/Updated 2026-11-09 10:00 UTC/.test(t2.text('adm_generated')));
        // countries: name (Intl.DisplayNames when present, else the code), flag, users, share; null = Unknown
        const ct = t2.text('adm_countries_table');
        assert(/United Arab Emirates|AE/.test(ct), ct);
        assert(ct.indexOf('🇦🇪') !== -1, 'AE flag');
        assert(/Unknown/.test(ct) && /66\.7 %/.test(ct) && /33\.3 %/.test(ct), ct);
        assert.strictEqual(t2.w.WTS_accountAdmin._flag('gb'), '🇬🇧');
        assert.strictEqual(t2.w.WTS_accountAdmin._countryName('XYZ'), 'Unknown');
        assert(/E-mail code 2/.test(t2.text('adm_methods')) && /Google 1/.test(t2.text('adm_methods')));
        // the chart: 90 days, bars for the two days with sign-ups
        const days = t2.w.WTS_accountAdmin._days90();
        assert.strictEqual(days.length, 90); assert.strictEqual(days[89].day, '2026-11-09'); assert.strictEqual(days[89].n, 1);
        assert.strictEqual(days.find((d) => d.day === '2026-11-01').n, 2);
        assert.strictEqual(t2.a.canvasLog('adm_chart', 'fillRect').length, 2, 'two bars');
        assert(/3 sign-ups in the last 90 days/.test(t2.text('adm_signups_total')));
        assert(t2.el('adm_chart').parentNode.className === 'chart-wrap');
        // users + Load more
        assert.strictEqual(t2.a.findAll('#adm_users_table tbody tr').length, 2);
        assert(!t2.el('adm_more').hidden, 'Load more shown while next is set');
        t2.click('adm_more');
        await t2.until(() => t2.a.findAll('#adm_users_table tbody tr').length === 3, 'third user');
        assert(/cursor=c1/.test(t2.admin.log.filter((x) => x.path.endsWith('/users')).pop().url));
        assert(t2.el('adm_more').hidden, 'no more');
        const ut = t2.text('adm_users_table');
        assert(/LinkedIn/.test(ut) && /Google/.test(ut) && /Dubai/.test(ut) && /2026-11-03/.test(ut), ut);
        // CSV of the loaded users
        t2.click('adm_csv');
        await t2.settle(20);
        const dl = t2.a.downloads.find((d) => /^wts-users-\d{4}-\d{2}-\d{2}\.csv$/.test(d.filename));
        assert(dl, 'CSV downloaded: ' + JSON.stringify(t2.a.downloads.map((d) => d.filename)));
        const csv = t2.w.WTS_accountAdmin._csv();
        assert.strictEqual(csv.split('\r\n').filter(Boolean).length, 4, 'header + 3 users');
        assert(/^email,method,status,createdAt,lastSignInAt,signupCountry,lastCountry,lastCity,projects,usedBytes,fullName,company,jobTitle,profileCountry,phone,wells,clients,operators,fields,workCountries,lastProjectAt\r\n/.test(csv), csv.split('\r\n')[0]);
        // search
        t2.a.input('adm_q', 'company'); t2.click('adm_search');
        await t2.until(() => /q=company/.test(t2.admin.log.filter((x) => x.path.endsWith('/users')).pop().url), 'search request');
        await t2.until(() => t2.a.findAll('#adm_users_table tbody tr').length === 2, 'two matches');
        // invite
        t2.a.input('adm_inv_email', 'not-an-address'); t2.click('adm_inv_send');
        assert(/valid e-mail/.test(t2.text('adm_inv_msg')));
        t2.a.input('adm_inv_email', 'friend@company.example'); t2.a.input('adm_inv_note', 'Field engineer'); t2.click('adm_inv_send');
        await t2.until(() => /Invitation added for friend@company\.example/.test(t2.text('adm_inv_msg')), 'invite ok');
        const post = t2.admin.log.find((x) => x.method === 'POST');
        assert.deepStrictEqual(post.body, { email: 'friend@company.example', note: 'Field engineer' });
        assert.strictEqual(post.path, '/api/v1/admin/invites');
        await t2.until(() => /Field engineer/.test(t2.text('adm_invites_table')), 'invite list refreshed');
        assert.strictEqual(t2.el('adm_inv_email').value, '');
        // Refresh reloads everything
        const n = t2.admin.log.length;
        t2.click('adm_refresh');
        await t2.settle();
        assert(t2.admin.log.length >= n + 3, 'refresh: summary, users, invites');
        // nothing typed here is stored
        assert.strictEqual(t2.storage.getItem('wts_page_admin'), null, 'no autosave');
        assert(t2.el('adm_root').getAttribute('data-acct-skip') === '1');
        // the account page links to the dashboard
        t2.w.WTS_nav('account');
        await t2.until(() => t2.el('acct_open_admin'), 'account page link');
        t2.click('acct_open_admin');
        await t2.until(() => t2.el('adm_root'), 'back to the admin page');
        // the server says 404 (no longer an admin) → Not available
        t2.admin.on = false;
        t2.click('adm_refresh');
        await t2.until(() => t2.el('adm_na'), 'not available after a 404');
      } finally { t2.dispose(); }
    },
  },
  {
    name: 'AW7 server strings are escaped: a malicious e-mail, city and invite note stay text (page and CSV)', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx, { admin: true });
      try {
        t.w.WTS_nav('admin');
        await t.until(() => t.el('adm_users_table') && t.el('adm_invites_table'), 'loaded');
        assert.strictEqual(t.a.findAll('#adm_root img').length, 0, 'no <img> element');
        assert.strictEqual(t.a.findAll('#adm_root script').length, 0, 'no <script> element');
        assert.strictEqual(t.a.findAll('#adm_users_table b').length, 0, 'no <b> from the city');
        assert(t.text('adm_users_table').indexOf(EVIL) !== -1, 'the address is shown as text');
        assert(t.text('adm_users_table').indexOf('<b>Dubai</b>') !== -1, 'the city as text');
        assert(t.text('adm_invites_table').indexOf('<script>x</script>') !== -1, 'the note as text');
        const csv = t.w.WTS_accountAdmin._csv();
        assert(csv.indexOf('"<img src=x onerror=""alert(1)"">@evil.example"') !== -1, 'CSV quotes the cell');
        // a cell that starts with = is never a formula
        t.w.WTS_accountAdmin._view().users.push({ email: '=HYPERLINK("x")', method: 'code' });
        assert(t.w.WTS_accountAdmin._csv().indexOf('"\'=HYPERLINK(""x"")"') !== -1, 'formula prefix');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'AW8 a load with #admin opens the admin route (Not available for a normal account); admin in the host skip tables', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx, {});
      try {
        const t2 = t.reload({ hash: '#admin' });
        try {
          t2.a.flush(10);
          await t2.settle();
          assert.strictEqual(t2.w.WTS_pageAutosave.page(), 'admin');
          await t2.until(() => t2.el('adm_na'), 'not available');
          assert.strictEqual(t2.admin ? t2.admin.log.length : 0, 0);
        } finally { t2.dispose(); }
      } finally { t.dispose(); }
      const html = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'well-testing-app.html'), 'utf8');
      for (const re of [/const PAGE_AUTOSAVE_SKIP = \{[^}]*admin:1/, /const _REPORT_SKIP = \{[^}]*admin:1/, /const __UI_NOT_TILE = \{[^}]*admin:1/, /page==='account'\|\|page==='admin'\) \? 'none'/]) {
        assert(re.test(html), String(re));
      }
    },
  },
  {
    name: 'AW9 a Search during a pending users load supersedes it; country caption; share with the decimal comma', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx, { admin: true });
      try {
        let release = null;
        t.admin.hold = new Promise((r) => { release = r; });
        t.w.WTS_nav('admin');
        await t.until(() => t.el('adm_countries_table') && t.el('adm_q'), 'page drawn, users pending');
        assert(!t.el('adm_users_table'), 'first page still loading');
        t.a.input('adm_q', 'b@company'); t.click('adm_search');
        await t.until(() => t.a.findAll('#adm_users_table tbody tr').length === 1, 'the search answer');
        release();
        await t.settle(20);
        const v = t.w.WTS_accountAdmin._view();
        assert.strictEqual(v.q, 'b@company');
        assert.strictEqual(t.a.findAll('#adm_users_table tbody tr').length, 1, 'the late unfiltered answer is dropped');
        assert(/b@company\.example/.test(t.text('adm_users_table')) && t.text('adm_users_table').indexOf(EVIL) === -1, t.text('adm_users_table'));
        assert.strictEqual(v.next, null, 'the cursor belongs to the filtered list');
        assert.strictEqual(v.loading, false);
        // caption and decimal comma
        assert(/Country of the last sign-in, else of the sign-up/.test(t.text('adm_card_countries')));
        t.w.WTS_a11y.decimalComma(true);
        t.click('adm_refresh');
        await t.settle(20);
        const ct = t.text('adm_countries_table');
        assert(/66,7 %/.test(ct) && /33,3 %/.test(ct) && !/66\.7/.test(ct), ct);
        assert(/2,5 MB/.test(t.text('adm_k_storage')), t.text('adm_k_storage'));
        t.w.WTS_a11y.decimalComma(false);
      } finally { t.dispose(); }
    },
  },
];
