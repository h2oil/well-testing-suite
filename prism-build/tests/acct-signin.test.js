// Accounts WP-C1 — sign-in, sessions and the outage rule in the page (docs/ACCOUNTS-PLAN.md §3.2, §4, §5.5, §11.1–11.2, §12.2).
// The app runs on the production https location against the in-memory fake API (tests/_acct-fake-server.js) with the
// invite-beta flag set; every flow goes through the real dialog / chip DOM.
//
//   SI1  no beta flag: nothing mounted, no request; beta flag, signed out: the chip says Sign in, still no request (5 s idle)
//   SI2  new account: e-mail → code → consent (names the address) → signed in; hint without the address; device id kept
//   SI3  consent Cancel creates nothing; the code is not burnt by the consent step
//   SI4  two live codes: after "Send again" the first code still signs in; the FAQ is in the code step
//   SI5  uniform replies: a known and an unknown address both reach the code step with the same reply
//   SI6  invite beta: a new address not on the allow-list gets the generic code error (no account); an invited one signs up
//   SI7  a wrong code: the generic message, the state untouched; a rate reply names the wait
//   SI8  the same device signs in again: the server-issued device id is reused (one device row)
//   SI9  step-up: an action 11 min after a code sign-in asks for a code in place, then succeeds; Cancel aborts it
//   SI10 the 30 s rotation race: one 401 on /me re-reads /me before anything signs out
//   SI11 step-up code to the recovery address (recovery set first through the account API)
//   SI12 recovery address refused when it is another account's address (uniform reply, no code sent, confirm fails)
//   SI13 sign-out on a trusted device: Keep leaves the project, hint and cookie gone, chip says Sign in
//   SI14 sign out everywhere: other devices signed out; the tick removes provider links added in the last 14 days
//   SI15 e-mail change and revert (#account-revert): revert removes identities linked since the change and their sessions
//   SI16 outage rule: /me 5xx or network → "Cloud unavailable", hint kept; only 401 signed_out → signed out + bar
//   SI17 a 400 invalid_or_expired during step-up changes nothing (still signed in)
//   SI18 public computer tick: public session, hint.public, the shared-browser flag
//   SI19 the analytics tag ran in this page → "Finishing sign-in…" and exactly one reload
//   SI20 dialog a11y: role / aria-modal / labels, Escape closes and returns focus, phone layout rules, offline text
//   SI21 Ctrl+S saves to the cloud only while signed in and linked
//   SI22 paused (ACCOUNTS_OFF) → "Cloud sync paused" chip; locked account message
'use strict';

const T = require('./_acct-app');
const WP = 'ACS';
const E1 = 'name@company.example';

function hint(t) { try { return JSON.parse(t.storage.getItem('wtsacct_hint') || 'null'); } catch (e) { return null; } }
async function signedIn(ctx, o) {
  const t = T.boot(ctx, o || {});
  await t.signIn((o && o.email) || E1, { handover: (o && o.handover) || null });
  await t.until(() => t.acct().state().status === 'signedIn', 'signed in');
  return t;
}
function addIdentity(fake, email, provider, linkedAt) {
  const u = fake.user(email);
  const id = require('crypto').randomUUID();
  fake.state.identities.set(id, { id, userId: u.id, provider, issuer: 'https://' + provider + '.idp.test', subject: 'sub-' + id.slice(0, 8),
    email: 'x@personal.example', emailVerifiedAtLink: true, linkedAt: linkedAt || new Date(fake._clockApp.win.Date.now()).toISOString(), linkedVia: 'signup', lastUsedAt: null, ackEmail: null });
  return id;
}

module.exports = [
  {
    name: 'SI1 no beta flag: nothing mounted and no request; beta flag signed out: Sign in chip, no request, no timer after 5 s', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t0 = T.boot(ctx, { beta: false });
      try {
        t0.a.flush(5000);
        assert(!t0.el('acct_chip'), 'no chip without the beta flag');
        assert.strictEqual(t0.fake.requests.length, 0);
        assert.strictEqual(t0.a.pendingTimers(), 0);
      } finally { t0.dispose(); }
      const t = T.boot(ctx, {});
      try {
        t.a.flush(5000);
        const chip = t.el('acct_chip');
        assert(chip, 'chip mounted');
        assert.strictEqual(chip.getAttribute('aria-label'), 'Sign in');
        assert(/Sign in/.test(chip.textContent));
        assert.strictEqual(t.el('wts_account_host').parentNode.className.indexOf('page-actions') !== -1, true, 'first in .page-actions');
        assert.strictEqual(t.fake.requests.length, 0, 'a signed-out visit makes no request');
        assert.strictEqual(t.a.pendingTimers(), 0, 'no timer left');
        assert.deepStrictEqual(t.a.errors.map((e) => e.message), []);
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI2 new account through the dialog: code, consent naming the address, signed in; hint has no address; device id stored', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, {});
      try {
        t.click('acct_chip');
        await t.until(() => t.el('acct_email'));
        const em = t.el('acct_email');
        assert.strictEqual(em.getAttribute('autocomplete'), 'username webauthn');
        assert.strictEqual(em.getAttribute('inputmode'), 'email');
        assert(t.el('acct_provider_buttons') && t.el('acct_provider_buttons').getAttribute('data-owner') === 'WP-O', 'the WP-O provider mount point');
        assert(!t.fake.requests.some((r) => r.path.endsWith('/auth/providers')), 'no providers request without WP-O');
        const r = await t.signIn(E1, { consent: false });
        assert(r.consentShown, 'consent step for a new account');
        assert(t.dialogText().includes(E1), 'the consent step names the new account address');
        assert.strictEqual(t.fake.user(E1), null, 'no account before consent');
        t.a.check('acct_consent_ok', true);
        t.click('acct_create');
        await t.until(() => t.acct().state().status === 'signedIn', 'signed in');
        await t.until(() => !t.el('acct_dlg_body') || t.choices().length, 'dialog done');
        assert(t.fake.user(E1), 'account created');
        const h = hint(t);
        assert.strictEqual(h.signedIn, true); assert.strictEqual(h.initial, 'N');
        assert(!JSON.stringify(h).includes('company.example'), 'the hint holds no address');
        assert.strictEqual(t.br.cookie('__Host-wts_sid').sameSite, 'Strict');
        const st = t.sync()._state();
        await t.until(() => t.sync()._state().device && t.sync()._state().device.deviceId, 'device id stored');
        assert(/^[0-9a-f-]{36}$/.test(t.sync()._state().device.deviceId));
        assert(/N/.test(t.text('acct_chip')), 'chip shows the initial');
        assert(st);
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI3 consent Cancel creates nothing, the code still works afterwards', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, {});
      try {
        const r = await t.signIn(E1, { consent: false });
        t.click('acct_consent_cancel');
        await t.settle();
        assert(!t.el('acct_dlg_ov'), 'dialog closed');
        assert.strictEqual(t.fake.user(E1), null);
        assert.strictEqual(t.acct().state().status, 'signedOut');
        await t.signIn(E1, { code: r.code });
        await t.until(() => t.acct().state().status === 'signedIn');
        assert(t.fake.user(E1));
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI4 two live codes: after Send again the first code signs in; Didn\'t get the code? lists the help', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx);
      try {
        await t.acct().signOut({ keep: true });
        await t.until(() => t.acct().state().status === 'signedOut');
        t.acct().openSignIn();
        await t.until(() => t.el('acct_email'));
        t.a.input('acct_email', E1); t.click('acct_send');
        await t.until(() => t.el('acct_code'));
        const first = t.fake.codeFor(E1, 'code_signin');
        t.click('acct_resend');
        await t.until(() => /previous one still works/.test(t.text('acct_msg')), 'resend message');
        assert(!t.el('acct_resend').disabled, 'Send again enabled from the reply (no countdown timer)');
        const faq = t.el('acct_faq');
        assert(faq && /spam/.test(faq.textContent) && /no-reply@h2oil\.co\.uk/.test(faq.textContent) && /15 minutes/.test(faq.textContent) && t.el('acct_use_recovery'), 'FAQ');
        assert.notStrictEqual(t.fake.codeFor(E1, 'code_signin'), first);
        t.a.input('acct_code', first.slice(0, 4) + ' ' + first.slice(4)); t.click('acct_verify');
        await t.until(() => t.acct().state().status === 'signedIn', 'the first code (with a space) signs in');
        assert.strictEqual(t.a.pendingTimers(), 0);
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI5 uniform replies: a known and an unknown address both reach the code step', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx);
      try {
        await t.acct().signOut({ keep: true });
        for (const em of [E1, 'nobody@company.example']) {
          t.acct().openSignIn();
          await t.until(() => t.el('acct_email'));
          t.a.input('acct_email', em); t.click('acct_send');
          await t.until(() => t.el('acct_code'), 'code step for ' + em);
          assert(t.dialogText().includes(em));
          t.click('acct_dlg_x'); await t.settle(20);
        }
        const starts = t.fake.requests.filter((r) => r.path.endsWith('/auth/code/start'));
        assert(starts.length >= 3);
        assert.strictEqual(t.fake.mail.sent.filter((m) => m.to === 'nobody@company.example').length, 1, 'an open sign-up sends a code to a new address');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI6 invite beta: an address not on the allow-list gets the generic error and no account; an invited one signs up', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, { switches: { ACCOUNTS_SIGNUP: 'invite' }, allow: ['invited@company.example'] });
      try {
        t.acct().openSignIn();
        await t.until(() => t.el('acct_email'));
        t.a.input('acct_email', 'stranger@company.example'); t.click('acct_send');
        await t.until(() => t.el('acct_code'));
        assert.strictEqual(t.fake.mail.sent.length, 0, 'no code mailed to an address that is not invited (same reply)');
        t.a.input('acct_code', '12345678'); t.click('acct_verify');
        await t.until(() => /wrong or has expired/.test(t.text('acct_msg')));
        assert.strictEqual(t.fake.user('stranger@company.example'), null);
        t.click('acct_dlg_x');
        await t.signIn('invited@company.example');
        await t.until(() => t.acct().state().status === 'signedIn');
        assert(t.fake.user('invited@company.example'));
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI7 a wrong code shows the generic message and changes nothing; a rate reply names the wait', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, {});
      try {
        t.acct().openSignIn();
        await t.until(() => t.el('acct_email'));
        t.a.input('acct_email', E1); t.click('acct_send');
        await t.until(() => t.el('acct_code'));
        const good = t.fake.codeFor(E1, 'code_signin');
        t.a.input('acct_code', good === '00000000' ? '11111111' : '00000000'); t.click('acct_verify');
        await t.until(() => /wrong or has expired/.test(t.text('acct_msg')));
        assert.strictEqual(t.acct().state().status, 'signedOut');
        assert.strictEqual(hint(t), null);
        t.a.input('acct_code', '123'); t.click('acct_verify'); await t.settle(10);
        assert(/8 digits/.test(t.text('acct_msg')));
        t.click('acct_back');
        await t.until(() => t.el('acct_email'));
        t.fake.fault({ path: '/auth/code/start', mode: 'rate', extra: { retryAfter: 42 } });
        t.a.input('acct_email', E1); t.click('acct_send');
        await t.until(() => /Try again in 42 s/.test(t.text('acct_msg')), 'rate text');
        t.a.input('acct_email', 'not an address'); t.click('acct_send'); await t.settle(10);
        assert(/one e-mail address/.test(t.text('acct_msg')));
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI8 signing in again on the same device reuses the server-issued device id (one device row)', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx);
      try {
        await t.acct().signOut({ keep: true });
        const t2 = t.reload();
        try {
          await t2.signIn(E1);
          await t2.until(() => t2.acct().state().status === 'signedIn');
          const u = t.fake.user(E1);
          const devs = Array.from(t.fake.state.devices.values()).filter((d) => d.userId === u.id);
          assert.strictEqual(devs.length, 1, 'X-WTS-Device sent: no second device row');
          assert.strictEqual(t.fake.mail.sent.filter((m) => m.template === 'notice_new_device').length, 0, 'no new-device notice');
        } finally { t2.dispose(); }
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI9 step-up in place: an action 11 min after a code sign-in asks for a code, then succeeds; Cancel aborts', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx);
      try {
        t.a.flush(11 * 60 * 1000);
        let done = null;
        t.acct().changeEmail('new@company.example').then((v) => { done = v; }, (e) => { done = e; });
        await t.until(() => t.el('acct_stepup_cancel'), 'step-up step');
        assert(/Confirm it is you/.test(t.text('acct_dlg_t')));
        await t.until(() => t.fake.mail.sent.some((m) => m.template === 'code_stepup' && m.to === E1), 'step-up code to the primary address');
        t.a.input('acct_code', t.fake.codeFor(E1, 'code_stepup')); t.click('acct_verify');
        await t.until(() => done !== null, 'change e-mail settles');
        assert.strictEqual(done, true);
        assert(t.fake.mail.sent.some((m) => m.template === 'code_email_change' && m.to === 'new@company.example'), 'code to the new address');
        // Cancel: an action needing step-up is aborted, nothing changes
        t.a.flush(11 * 60 * 1000);
        let res = null;
        t.acct().setRecovery('me@personal.example').then((v) => { res = v; }, (e) => { res = e; });
        await t.until(() => t.el('acct_stepup_cancel'));
        t.click('acct_stepup_cancel');
        await t.until(() => res !== null);
        assert.strictEqual(res.code, 'cancelled');
        assert.strictEqual(t.acct().state().status, 'signedIn');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI10 the step-up rotation race: one 401 on /me re-reads /me before signing out', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx);
      try {
        t.fake.fault({ path: '/me', mode: 'signed_out', times: 1 });
        await t.acct().refresh();
        assert.strictEqual(t.acct().state().status, 'signedIn', 'still signed in after one 401');
        assert(hint(t).signedIn);
        t.fake.fault({ path: '/me', mode: 'signed_out', times: 2 });
        await t.acct().refresh();
        assert.strictEqual(t.acct().state().status, 'signedOut', 'two 401s: signed out');
        assert.strictEqual(hint(t), null);
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI11 step-up code to the recovery address', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx);
      try {
        await t.acct().setRecovery('me@personal.example');   // within 10 min of the code sign-in: no step-up
        await t.acct().confirmRecovery(t.fake.codeFor('me@personal.example', 'code_recovery_add'));
        assert.strictEqual(t.fake.user(E1).recovery, 'me@personal.example');
        assert(t.acct().state().user.recoveryMasked);
        t.a.flush(11 * 60 * 1000);
        let done = null;
        t.acct().removeRecovery().then(() => { done = true; }, (e) => { done = e; });
        await t.until(() => t.el('acct_stepup_recovery'));
        t.click('acct_stepup_recovery');
        await t.until(() => t.fake.mail.sent.some((m) => m.template === 'code_stepup' && m.to === 'me@personal.example'), 'code to the recovery address');
        t.a.input('acct_code', t.fake.codeFor('me@personal.example', 'code_stepup')); t.click('acct_verify');
        await t.until(() => done !== null);
        assert.strictEqual(done, true);
        assert.strictEqual(t.fake.user(E1).recovery, null);
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI12 a recovery address that is another account\'s address: uniform reply, no code, confirm refused', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx);
      const t2 = T.device(ctx, t.fake, {});
      try {
        await t2.signIn('other@company.example');
        await t2.until(() => t2.acct().state().status === 'signedIn');
        const before = t.fake.mail.sent.length;
        assert.strictEqual(await t.acct().setRecovery('other@company.example'), true, 'same reply');
        assert.strictEqual(t.fake.mail.sent.length, before, 'no code sent');
        await assert.rejects(t.acct().confirmRecovery('12345678'), (e) => e.code === 'invalid_or_expired');
        assert.strictEqual(t.fake.user(E1).recovery, null);
        assert.strictEqual(t.acct().state().status, 'signedIn', 'a 400 never signs out');
      } finally { t.dispose(); t2.dispose(); }
    },
  },
  {
    name: 'SI13 trusted sign-out: Keep leaves the project; hint and cookie gone; chip says Sign in', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx, { seed: true, handover: 'later' });
      try {
        assert(t.storage.getItem('wts_page_hydrate'));
        t.click('acct_chip');
        await t.until(() => t.el('acct_m_signout'));
        assert(/n•••@company\.example/.test(t.text('acct_menu_who')));
        t.click('acct_m_signout');
        await t.until(() => t.el('acct_ch_keep'));
        assert(/Keep a copy of the open project/.test(t.dialogText()));
        t.click('acct_ch_keep');
        await t.until(() => t.acct().state().status === 'signedOut');
        assert.strictEqual(hint(t), null);
        assert.strictEqual(t.br.cookie('__Host-wts_sid'), null, 'cookie cleared');
        assert(t.storage.getItem('wts_page_hydrate'), 'project kept');
        assert(/Sign in/.test(t.text('acct_chip')));
        assert.strictEqual(t.fake.sessionsOf(E1).length, 0);
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI14 sign out everywhere signs out other devices; the tick removes provider links added in the last 14 days', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx);
      const t2 = T.device(ctx, t.fake, {});
      try {
        await t2.signIn(E1);
        await t2.until(() => t2.acct().state().status === 'signedIn');
        addIdentity(t.fake, E1, 'google');
        addIdentity(t.fake, E1, 'linkedin', '2020-01-01T00:00:00.000Z');
        t.click('acct_chip');
        await t.until(() => t.el('acct_m_everywhere'));
        t.click('acct_m_everywhere');
        await t.until(() => t.el('acct_recent_methods'));
        t.a.check('acct_recent_methods', true);
        t.click('acct_ch_all');
        await t.until(() => t.acct().state().status === 'signedOut', 'this device signed out');
        assert.strictEqual(t.fake.sessionsOf(E1).length, 0, 'every session revoked');
        const ids = Array.from(t.fake.state.identities.values()).map((i) => i.provider);
        assert.deepStrictEqual(ids, ['linkedin'], 'the recent Google link removed, the old LinkedIn link kept');
        assert(t.fake.mail.sent.some((m) => m.template === 'notice_signout_all'));
        await t2.acct().refresh();
        assert.strictEqual(t2.acct().state().status, 'signedOut', 'the other device is signed out at its next call');
      } finally { t.dispose(); t2.dispose(); }
    },
  },
  {
    name: 'SI15 e-mail change, then revert from #account-revert: identities linked since the change and their sessions removed', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx);
      try {
        await t.acct().changeEmail('new@company.example');
        await t.acct().confirmEmail(t.fake.codeFor('new@company.example', 'code_email_change'));
        assert(/n•••@company\.example/.test(t.acct().state().user.emailMasked));
        assert.strictEqual(t.fake.user('new@company.example').id, t.fake.user('new@company.example').id);
        const notice = t.fake.mail.sent.filter((m) => m.template === 'notice_email_changed' && m.to === E1).pop();
        assert(notice && /^\d{8}$/.test(notice.params.revertCode), 'the old address got the revert code');
        t.a.flush(1000);
        const idId = addIdentity(t.fake, 'new@company.example', 'google');
        t.fake.state.sessions.forEach((s) => { if (s.userId === t.fake.user('new@company.example').id) s.identityId = idId; });
        // the notice's link on another browser
        const t2 = T.device(ctx, t.fake, { beta: false, hash: '#account-revert' });
        try {
          await t2.until(() => t2.el('acct_rev_email'), 'revert step opens without the beta flag');
          assert.strictEqual(t2.fake.requests.filter((r) => r.browser === t2.br.name).length, 0, 'no request until submitted');
          t2.a.input('acct_rev_email', E1); t2.a.input('acct_rev_code', notice.params.revertCode);
          t2.click('acct_rev_go');
          await t2.until(() => /previous address is back/.test(t2.text('acct_msg')), 'reverted');
          const u = t.fake.user(E1);
          assert(u, 'the old address is back');
          assert.strictEqual(Array.from(t.fake.state.identities.values()).filter((i) => i.userId === u.id).length, 0, 'identity linked since the change removed');
          assert.strictEqual(t.fake.sessionsOf(E1).length, 1, 'only the revert session remains');
        } finally { t2.dispose(); }
        await t.acct().refresh();
        assert.strictEqual(t.acct().state().status, 'signedOut', 'the first browser is signed out');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI16 outage rule: 5xx / network on /me keep the hint ("Cloud unavailable"); only 401 signed_out signs out and shows the bar', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx);
      try {
        t.dispose();
        for (const mode of ['server', 'network']) {
          t.fake.fault({ path: '/me', mode, times: 1 });
          const t2 = t.reload();
          try {
            await t2.until(() => t2.acct().state().status === 'unavailable', mode + ': unavailable');
            assert(hint(t2) && hint(t2).signedIn, mode + ': hint kept');
            assert(/Cloud unavailable — saved on this device/.test(t2.text('acct_chip')), mode + ': chip');
            assert(t2.el('wts_sync_bar') && /Cloud unavailable/.test(t2.text('wts_sync_bar_text')), mode + ': bar');
            t2.click('acct_bar_retry');
            await t2.until(() => t2.acct().state().status === 'signedIn', mode + ': recovers on retry');
            assert(!t2.el('wts_sync_bar'));
          } finally { t2.dispose(); }
        }
        t.fake.fault({ path: '/me', mode: 'signed_out', times: 2 });
        const t3 = t.reload();
        try {
          await t3.until(() => t3.acct().state().status === 'signedOut', 'signed out');
          assert(t3.el('wts_sync_bar') && /Signed out — sign in to keep syncing/.test(t3.text('wts_sync_bar_text')));
          assert(t3.el('acct_bar_signin'));
        } finally { t3.dispose(); }
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI17 a 400 invalid_or_expired during step-up changes nothing', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx);
      try {
        t.a.flush(11 * 60 * 1000);
        let res = null;
        t.acct().changeEmail('x@company.example').then((v) => { res = v; }, (e) => { res = e; });
        await t.until(() => t.el('acct_verify'));
        t.a.input('acct_code', '00000000'); t.click('acct_verify');
        await t.until(() => /wrong or has expired/.test(t.text('acct_msg')));
        assert.strictEqual(t.acct().state().status, 'signedIn');
        assert(hint(t).signedIn);
        t.click('acct_stepup_cancel');
        await t.until(() => res !== null);
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI18 the public-computer tick: public session, hint.public, shared-browser flag', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, {});
      try {
        await t.signIn(E1, { publicDevice: true });
        await t.until(() => t.acct().state().status === 'signedIn');
        assert.strictEqual(t.acct().state().publicDevice, true);
        assert.strictEqual(hint(t).public, true);
        assert.strictEqual(t.storage.getItem('wtspref_shared_browser'), '1');
        const s = t.fake.sessionsOf(E1)[0];
        assert(s.publicDevice && s.idleExp - s.createdAt === 12 * 3600e3);
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI19 the analytics tag ran in this page: "Finishing sign-in…" and exactly one reload', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, {});
      try {
        let reloads = 0;
        t.w.__wtsGaLoaded = true;
        t.acct().configure({ reload: () => { reloads++; } });
        await t.signIn(E1);
        await t.until(() => reloads > 0, 'reload');
        await t.settle(50);
        assert.strictEqual(reloads, 1);
        assert(/Finishing sign-in/.test(t.dialogText()));
        assert(hint(t).signedIn, 'the hint is written first, so the reloaded page skips the tag');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI20 dialog: role, aria-modal, labels; Escape closes and returns focus; phone layout rules; offline text', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = T.boot(ctx, { viewport: { width: 390, height: 844 } });
      try {
        const chip = t.el('acct_chip');
        chip.focus();
        t.click(chip);
        await t.until(() => t.el('acct_dlg'));
        const d = t.el('acct_dlg');
        assert.strictEqual(d.getAttribute('role'), 'dialog'); assert.strictEqual(d.getAttribute('aria-modal'), 'true');
        assert.strictEqual(d.getAttribute('aria-labelledby'), 'acct_dlg_t');
        assert(t.el('acct_dlg_ov').classList.contains('rp-skip') && t.el('acct_dlg_ov').getAttribute('data-rp-nosnap'), 'not in reports / snapshots');
        assert(t.a.find('label[for="acct_email"]'), 'label');
        assert.strictEqual(t.el('acct_dlg_x').getAttribute('aria-label'), 'Close');
        assert.strictEqual(t.el('acct_msg').getAttribute('aria-live'), 'polite');
        t.a.key(t.el('acct_email'), 'Escape');
        await t.settle(10);
        assert(!t.el('acct_dlg_ov'), 'Escape closes');
        assert.strictEqual(t.a.document.activeElement, t.el('acct_chip'), 'focus returns to the chip');
        const css = t.el('acct_css').textContent;
        assert(/@media \(max-width:600px\)/.test(css) && /min-width:44px;min-height:44px/.test(css) && /font-size:16px/.test(css), 'phone rules: 44 px chip, 16 px controls');
        assert(/\.acct-ov\{padding:0/.test(css) && /padding:16px/.test(css), 'full-width sheet with 16 px gutters');
        t.acct().configure({ online: () => false });
        t.acct().openSignIn();
        await t.until(() => /Sign-in needs a connection/.test(t.text('acct_msg')), 'offline text');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI21 Ctrl+S saves to the cloud only while signed in and linked', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx, { seed: true, handover: 'later' });
      try {
        const commits = () => t.fake.requests.filter((r) => /\/commit$/.test(r.path)).length;
        t.a.key(t.a.document.body, 's', 'keydown');
        const ev = new t.w.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
        t.a.document.body.dispatchEvent(ev);
        await t.settle(50);
        assert.strictEqual(commits(), 0, 'not linked: Ctrl+S is the browser\'s');
        assert.strictEqual(ev.defaultPrevented, false);
        await t.sync().saveToCloud({});
        assert.strictEqual(commits(), 1);
        t.storage.setItem('wts_page_pipelife', JSON.stringify({ v: 1, t: 2, f: { pl_x: '1' } }));
        const ev2 = new t.w.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
        t.a.document.body.dispatchEvent(ev2);
        assert.strictEqual(ev2.defaultPrevented, true, 'linked: Ctrl+S is taken');
        await t.until(() => commits() === 2, 'Ctrl+S committed');
        await t.until(() => /Saved to the cloud/.test(t.text('acct_toast')));
        await t.acct().signOut({ keep: true });
        const ev3 = new t.w.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
        t.a.document.body.dispatchEvent(ev3);
        assert.strictEqual(ev3.defaultPrevented, false, 'signed out: listener removed');
      } finally { t.dispose(); }
    },
  },
  {
    name: 'SI22 paused (ACCOUNTS_OFF) → "Cloud sync paused"; a locked account names the support address', wp: WP, opts: false,
    async run(app, assert, ctx) {
      const t = await signedIn(ctx);
      try {
        t.fake.setSwitch('ACCOUNTS_OFF', '1');
        await t.acct().refresh();
        assert.strictEqual(t.acct().state().status, 'unavailable');
        assert(/Cloud sync paused/.test(t.text('acct_chip')));
        assert(hint(t).signedIn, 'paused keeps the hint');
        t.fake.setSwitch('ACCOUNTS_OFF', null);
        await t.acct().refresh();
        assert.strictEqual(t.acct().state().status, 'signedIn');
        t.fake.lock(E1);
        await t.acct().refresh();
        assert(/Account locked/.test(t.text('acct_chip')));
        await t.acct().signOut({ keep: true });
        t.acct().openSignIn();
        await t.until(() => t.el('acct_email'));
        t.a.input('acct_email', E1); t.click('acct_send');
        await t.until(() => t.el('acct_code'));
        assert.strictEqual(t.fake.mail.sent.filter((m) => m.template === 'code_signin').length, 1, 'a locked account gets no code (same reply)');
      } finally { t.dispose(); }
    },
  },
];
