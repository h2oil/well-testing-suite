'use strict';
// server/test/auth.test.js — e-mail codes, sessions, step-up, e-mail change and revert, recovery address, sign-out
// (docs/ACCOUNTS-PLAN.md §3.3 Auth, §4.1–4.9, §8.3) through the real pipeline against the throwaway database.

const test = require('node:test');
const assert = require('node:assert');
const { harness, available } = require('./_api');
const C = require('../core/contract');

const skip = !available() && 'no throwaway database (run through server/test/run.js)';
let T = null;
const A = 'alice@company.example'; const B = 'bob@company.example';

test.describe('auth (§3.3, §4)', { skip }, () => {
  test.before(async () => { T = await harness('auth'); });
  test.after(async () => { if (T) await T.close(); });

  test('code start always 202; the mail is queued and sent after the response; nothing in the database is plaintext', async () => {
    const br = T.browser();
    const r = await br.call('POST', '/auth/code/start', { email: '  Alice@Company.Example ', purpose: 'signin' });
    assert.strictEqual(r.status, 202); assert.deepStrictEqual(r.json, { ok: true });
    const m = T.lastMail(A, 'code_signin');
    assert.ok(m && /^\d{8}$/.test(m.params.code), 'a code mailed to the normalised address');
    const rows = await T.db.sql`select * from wts.mail_outbox`;
    assert.ok(rows.length >= 1 && rows.every((x) => x.sent_at), 'outbox rows marked sent');
    const dump = JSON.stringify(await T.db.sql`select encode(to_enc, 'escape') as a, encode(params_enc, 'escape') as b from wts.mail_outbox`);
    assert.ok(!dump.includes('alice') && !dump.includes(m.params.code), 'address and code encrypted in the outbox');
    const codes = await T.db.sql`select * from wts.email_codes`;
    assert.ok(codes.length >= 1 && !JSON.stringify(codes).includes(m.params.code));
  });

  test('new account: consent required (code not burnt), then signed in; session cookie Strict / HttpOnly / Max-Age = absolute life', async () => {
    const br = T.browser();
    await br.call('POST', '/auth/code/start', { email: B, purpose: 'signin' });
    const code = T.codeFor(B, 'code_signin');
    const r1 = await br.call('POST', '/auth/code/verify', { email: B, code, publicDevice: false });
    assert.strictEqual(r1.status, 409); assert.ok(C.checkError('consent_required', r1.json).ok);
    const r2 = await br.call('POST', '/auth/code/verify', { email: B, code, publicDevice: false, deviceLabel: 'Office PC', consent: { terms: '1', privacy: '1' } });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.json));
    assert.ok(C.checkShape('SignInResult', r2.json).ok, JSON.stringify(C.checkShape('SignInResult', r2.json).errors));
    assert.strictEqual(r2.json.firstSignIn, true); assert.strictEqual(r2.json.user.emailMasked, 'b•••@company.example');
    assert.strictEqual(r2.json.device.label, 'Office PC');
    const ck = r2.cookies.find((c) => c.startsWith('__Host-wts_sid='));
    assert.match(ck, /; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=(\d+)$/);
    const age = Number(/Max-Age=(\d+)/.exec(ck)[1]);
    assert.ok(Math.abs(age - 180 * 86400) < 5, 'trusted: 180 days');
    const sid = br.cookie('__Host-wts_sid');
    const rows = await T.db.sql`select sid_hash, auth_method, stepup_at, public_device from wts.sessions`;
    assert.ok(!JSON.stringify(rows).includes(sid), 'only the hash is stored');
    const me = await br.call('GET', '/me');
    assert.strictEqual(me.status, 200);
    assert.ok(C.checkShape('Me', me.json).ok, JSON.stringify(C.checkShape('Me', me.json).errors));
    assert.strictEqual(me.json.session.authMethod, 'code'); assert.ok(me.json.session.stepupAt);
    assert.strictEqual(me.json.devices.length, 1); assert.strictEqual(me.json.devices[0].current, true);
    // the same code cannot be used twice
    const again = await T.browser().call('POST', '/auth/code/verify', { email: B, code, publicDevice: false });
    assert.strictEqual(again.status, 400); assert.strictEqual(again.json.error, 'invalid_or_expired');
  });

  test('wrong code: generic 400; 5 tries per code; two live codes; a third start invalidates the oldest', async () => {
    const br = T.browser();
    const email = 'carol@company.example';
    await T.signIn(br, email);
    for (let i = 0; i < 3; i++) await br.call('POST', '/auth/code/start', { email, purpose: 'signin' });
    const live = await T.db.sql`select count(*)::int as n from wts.email_codes where email_bidx = ${T.keys.emailBidx(email)} and purpose = 'signin'
      and used_at is null and invalidated_at is null and expires_at > now()`;
    assert.strictEqual(live[0].n, 2, 'at most two live codes');
    const codes = T.mail.sent.filter((m) => m.to === email && m.template === 'code_signin').slice(-3).map((m) => m.params.code);
    const first = await T.browser().call('POST', '/auth/code/verify', { email, code: codes[0], publicDevice: false });
    assert.strictEqual(first.status, 400, 'the oldest of three is dead');
    const b2 = T.browser();
    for (let i = 0; i < 4; i++) assert.strictEqual((await b2.call('POST', '/auth/code/verify', { email, code: '00000000', publicDevice: false })).json.error, 'invalid_or_expired');
    // (with the try above, every live code has now had 5 tries) — the right code no longer works
    const late = await b2.call('POST', '/auth/code/verify', { email, code: codes[2], publicDevice: false });
    assert.strictEqual(late.status, 400, 'five tries burn the code');
  });

  test('second live code still works ("Send again" never kills a slow first mail); a sign-in revokes the presented session', async () => {
    const email = 'dan@company.example';
    const br = T.browser();
    await T.signIn(br, email);
    const sid1 = br.cookie('__Host-wts_sid');
    await br.call('POST', '/auth/code/start', { email, purpose: 'signin' });
    const c1 = T.codeFor(email, 'code_signin');
    await br.call('POST', '/auth/code/start', { email, purpose: 'signin' });
    const r = await br.call('POST', '/auth/code/verify', { email, code: c1, publicDevice: false });
    assert.strictEqual(r.status, 200, 'the first of two live codes');
    assert.notStrictEqual(br.cookie('__Host-wts_sid'), sid1);
    const old = T.browser(); old.jar.set('__Host-wts_sid', sid1);
    assert.strictEqual((await old.call('GET', '/me')).json.error, 'signed_out', 'the presented session was revoked');
  });

  test('unknown, locked, invite-refused, signup-off and throttled addresses take the same 202 path; no mail', async () => {
    const before = T.mail.sent.length;
    T.setEnv({ ACCOUNTS_SIGNUP: 'invite' });
    const br = T.browser();
    assert.strictEqual((await br.call('POST', '/auth/code/start', { email: 'stranger@company.example', purpose: 'signin' })).status, 202);
    assert.strictEqual(T.mail.sent.length, before, 'invite mode: an address off the list gets nothing');
    // on the list: a code, and the account can be created
    const inv = 'invited@company.example';
    await T.db.sql`insert into wts.signup_allowlist (email_bidx, added_at) values (${T.keys.emailBidx(inv)}, now())`;
    await T.signIn(T.browser(), inv);
    T.setEnv({ ACCOUNTS_SIGNUP: 'off' });
    assert.strictEqual((await br.call('POST', '/auth/code/start', { email: 'new2@company.example', purpose: 'signin' })).status, 202);
    const n1 = T.mail.sent.length;
    await br.call('POST', '/auth/code/start', { email: A, purpose: 'signin' });
    assert.strictEqual(T.mail.sent.length, n1, 'signup off: an unknown address gets nothing (alice has no account yet)');
    await br.call('POST', '/auth/code/start', { email: inv, purpose: 'signin' });
    assert.strictEqual(T.mail.sent.length, n1 + 1, 'existing accounts still sign in');
    T.setEnv({ ACCOUNTS_SIGNUP: 'open' });
    // locked
    const id = await T.userId(inv);
    await T.db.sql`update wts.users set status = 'locked' where id = ${id}`;
    const n2 = T.mail.sent.length;
    assert.strictEqual((await br.call('POST', '/auth/code/start', { email: inv, purpose: 'signin' })).status, 202);
    assert.strictEqual(T.mail.sent.length, n2, 'locked: no code');
    await T.db.sql`update wts.users set status = 'active' where id = ${id}`;
    // throttled: 5 per hour per address
    const th = 'throttle@company.example';
    for (let i = 0; i < 7; i++) assert.strictEqual((await br.call('POST', '/auth/code/start', { email: th, purpose: 'signin' })).status, 202);
    assert.strictEqual(T.mailsTo(th).length, 5, '5/h per address');
  });

  test('step-up: only from an e-mail code; rotates the session (old id valid 30 s); 10-minute window; recovery address', async () => {
    const br = T.browser();
    const email = 'erin@company.example';
    await T.signIn(br, email);
    // step-up endpoints answer 403 reauth once the window has passed
    await T.age`update wts.sessions set stepup_at = now() - interval '11 minutes'`;
    const r1 = await br.call('POST', '/auth/email/change', { newEmail: 'erin2@company.example' });
    assert.strictEqual(r1.status, 403); assert.strictEqual(r1.json.error, 'reauth');
    for (const [p, body] of [['/auth/signout-all', {}], ['/auth/recovery/set', { email: 'x@personal.example' }], ['/auth/recovery/remove', {}],
      ['/account/export', {}], ['/account/delete', { confirm: 'DELETE' }]]) {
      const r = await br.call('POST', p, body);
      assert.strictEqual(r.json && r.json.error, 'reauth', p);
    }
    const sidOld = br.cookie('__Host-wts_sid');
    await br.call('POST', '/auth/code/start', { purpose: 'stepup' });
    const code = T.lastMail(email, 'code_stepup').params.code;
    const wrong = await br.call('POST', '/auth/code/verify', { code: '12345678', publicDevice: false });
    assert.strictEqual(wrong.status, 400); assert.strictEqual(wrong.json.error, 'invalid_or_expired');
    assert.strictEqual(br.cookie('__Host-wts_sid'), sidOld, 'a wrong code leaves the session untouched');
    const ok = await br.call('POST', '/auth/code/verify', { code, publicDevice: false });
    assert.strictEqual(ok.status, 200);
    const sidNew = br.cookie('__Host-wts_sid');
    assert.notStrictEqual(sidNew, sidOld, 'step-up rotates the id');
    const old = T.browser(); old.jar.set('__Host-wts_sid', sidOld);
    assert.strictEqual((await old.call('GET', '/me')).status, 200, 'the previous id stays valid for 30 s');
    await T.age`update wts.sessions set replaced_at = now() - interval '31 seconds' where replaced_by is not null`;
    assert.strictEqual((await old.call('GET', '/me')).json.error, 'signed_out', 'then it is gone');
    assert.strictEqual((await br.call('GET', '/me')).status, 200);
    // a step-up code for another session does not work here
    const other = T.browser(); await T.signIn(other, email);
    await other.call('POST', '/auth/code/start', { purpose: 'stepup' });
    const otherCode = T.lastMail(email, 'code_stepup').params.code;
    assert.strictEqual((await br.call('POST', '/auth/code/verify', { code: otherCode, publicDevice: false })).status, 400, 'bound to the session');
    // a provider-made session (stepup_at NULL) must step up before any step-up action
    await T.age`update wts.sessions set stepup_at = null, auth_method = 'google'`;
    for (const [p, body] of [['/auth/email/change', { newEmail: 'x@company.example' }], ['/auth/signout-all', {}], ['/account/delete', { confirm: 'DELETE' }],
      ['/account/export', {}], ['/auth/recovery/set', { email: 'y@personal.example' }]]) {
      assert.strictEqual((await br.call('POST', p, body)).json.error, 'reauth', 'provider session: ' + p);
    }
  });

  test('e-mail change: code to the new address (uniform when taken), confirm moves it, other sessions out, 7-day revert', async () => {
    const br = T.browser(); const other = T.browser();
    const email = 'frank@company.example'; const neu = 'frank.new@company.example';
    await T.signIn(br, email); await T.signIn(other, email);
    // taken address: the same 202, nothing sent
    const n = T.mail.sent.length;
    assert.strictEqual((await br.call('POST', '/auth/email/change', { newEmail: B })).status, 202);
    assert.strictEqual(T.mail.sent.length, n);
    assert.strictEqual((await br.call('POST', '/auth/email/change', { newEmail: neu })).status, 202);
    const code = T.codeFor(neu, 'code_email_change');
    assert.ok(code);
    const bad = await br.call('POST', '/auth/email/confirm', { code: '99999999' });
    assert.strictEqual(bad.json.error, 'invalid_or_expired');
    const ok = await br.call('POST', '/auth/email/confirm', { code });
    assert.strictEqual(ok.status, 200); assert.strictEqual(ok.json.emailMasked, 'f•••@company.example');
    assert.strictEqual((await other.call('GET', '/me')).json.error, 'signed_out', 'every other session signed out');
    assert.strictEqual((await br.call('GET', '/me')).status, 200);
    const notice = T.lastMail(email, 'notice_email_changed');
    assert.ok(notice && /^\d{8}$/.test(notice.params.revertCode), 'the old address gets the revert code');
    assert.ok(T.lastMail(neu, 'notice_email_added'));
    // the new address signs in; the old one is reserved for the revert window (nobody can register it)
    await T.signIn(T.browser(), neu);
    const thief = T.browser();
    await thief.call('POST', '/auth/code/start', { email, purpose: 'signin' });
    const r = await thief.call('POST', '/auth/code/verify', { email, code: T.codeFor(email, 'code_signin'), publicDevice: false, consent: { terms: '1', privacy: '1' } });
    assert.strictEqual(r.status, 400, 'the old address cannot become a new account inside the revert window');
    // a recovery address and an identity added after the change go with the revert
    const id = await T.userId(neu);
    await T.db.sql`insert into wts.identities (id, user_id, provider, issuer, subject_bidx, subject_enc, email_verified_at_link, linked_at, linked_via)
      values (gen_random_uuid(), ${id}, 'google', 'https://issuer.example', ${Buffer.alloc(32, 7)}, ${Buffer.from('s')}, true, now(), 'account_page')`;
    await T.db.sql`insert into wts.sessions (sid_hash, user_id, public_device, created_at, auth_at, last_seen_at, idle_expires_at, abs_expires_at, auth_method, identity_id)
      select ${Buffer.alloc(32, 9)}, ${id}, false, now(), now(), now(), now() + interval '1 day', now() + interval '2 days', 'google', i.id from wts.identities i where i.user_id = ${id}`;
    const wrong = await T.browser().call('POST', '/auth/email/revert', { email, code: '11112222' });
    assert.strictEqual(wrong.json.error, 'invalid_or_expired');
    const rev = await T.browser().call('POST', '/auth/email/revert', { email, code: notice.params.revertCode });
    assert.strictEqual(rev.status, 200, JSON.stringify(rev.json));
    assert.ok(C.checkShape('RevokeRes', rev.json).ok);
    assert.strictEqual(rev.json.identitiesRemoved, 1); assert.ok(rev.json.sessions >= 2);
    assert.strictEqual((await br.call('GET', '/me')).json.error, 'signed_out', 'every session revoked');
    assert.strictEqual((await T.db.sql`select count(*)::int as n from wts.identities where user_id = ${id}`)[0].n, 0);
    assert.strictEqual(await T.userId(email), id, 'the old address is the primary again');
    assert.strictEqual((await T.browser().call('POST', '/auth/email/revert', { email, code: notice.params.revertCode })).status, 400, 'once');
    const audit = await T.db.sql`select action from wts.audit where user_id = ${id} order by id`;
    assert.ok(audit.some((a) => a.action === 'email_change') && audit.some((a) => a.action === 'email_revert'));
  });

  test('recovery address: code to it (step-up), one address one role, sign-in and step-up codes can go there, remove', async () => {
    const br = T.browser();
    const email = 'gina@company.example'; const rec = 'gina@personal.example';
    await T.signIn(br, email);
    assert.strictEqual((await br.call('POST', '/auth/recovery/set', { email: B })).status, 202, 'taken: uniform');
    assert.ok(!T.codeFor(B, 'code_recovery_add'));
    assert.strictEqual((await br.call('POST', '/auth/recovery/set', { email: rec })).status, 202);
    const code = T.codeFor(rec, 'code_recovery_add');
    const ok = await br.call('POST', '/auth/recovery/set', { code });
    assert.strictEqual(ok.status, 200);
    assert.ok(T.lastMail(email, 'notice_recovery_set') && T.lastMail(rec, 'notice_recovery_set'));
    const me = (await br.call('GET', '/me')).json;
    assert.strictEqual(me.user.recoveryMasked, 'g•••@personal.example');
    // sign-in through the recovery address reaches the same account
    const b2 = T.browser();
    const s = await T.signIn(b2, rec, { consent: false });
    assert.strictEqual(s.user.id, me.user.id); assert.strictEqual(s.firstSignIn, false);
    // a step-up code to the recovery address
    await br.call('POST', '/auth/code/start', { purpose: 'stepup', to: 'recovery' });
    const sc = T.lastMail(rec, 'code_stepup');
    assert.ok(sc, 'step-up code to the recovery address');
    assert.strictEqual((await br.call('POST', '/auth/code/verify', { code: sc.params.code, publicDevice: false })).status, 200);
    // no other account may take it
    const other = T.browser(); await T.signIn(other, 'henry@company.example');
    await other.call('POST', '/auth/recovery/set', { email: rec });
    assert.strictEqual(T.mailsTo(rec).filter((m) => m.template === 'code_recovery_add').length, 1, 'never a second code for an address in use');
    assert.strictEqual((await br.call('POST', '/auth/recovery/remove', {})).status, 200);
    assert.ok(T.lastMail(rec, 'notice_recovery_removed'));
    assert.strictEqual((await br.call('GET', '/me')).json.user.recoveryMasked, undefined);
  });

  test('sign-out, sign-out everywhere (recent provider links and their sessions), public device lifetimes, devices', async () => {
    const email = 'ivy@company.example';
    const pub = T.browser();
    const s = await T.signIn(pub, email, { publicDevice: true });
    assert.strictEqual(s.session.publicDevice, true);
    const idle = Date.parse(s.session.idleExpires) - Date.now(); const abs = Date.parse(s.session.absExpires) - Date.now();
    assert.ok(Math.abs(idle - 12 * 3600e3) < 10e3 && Math.abs(abs - 7 * 86400e3) < 10e3, 'public: 12 h idle / 7 days');
    const br = T.browser(); await T.signIn(br, email, { deviceLabel: 'Laptop' });
    const me = (await br.call('GET', '/me')).json;
    assert.strictEqual(me.devices.length, 2);
    assert.ok(T.lastMail(email, 'notice_new_device'), 'a new device sends a notice');
    // rename and revoke the public device
    const pubDev = me.devices.find((d) => !d.current);
    assert.strictEqual((await br.call('POST', '/devices/rename', { id: pubDev.id, label: 'Rig PC' })).status, 200);
    assert.strictEqual((await br.call('POST', '/devices/rename', { id: '00000000-0000-4000-8000-000000000000', label: 'x' })).json.error, 'not_found');
    assert.strictEqual((await br.call('POST', '/devices/revoke', { id: pubDev.id })).status, 200);
    assert.strictEqual((await pub.call('GET', '/me')).json.error, 'signed_out', 'revoking a device ends its sessions');
    assert.ok(T.lastMail(email, 'notice_device_revoked'));
    // a foreign device id is ignored (treated as no device)
    const other = T.browser(); const os = await T.signIn(other, 'jack@company.example');
    const third = T.browser(); third.device = os.device.id;
    const s3 = await T.signIn(third, email);
    assert.notStrictEqual(s3.device.id, os.device.id, 'another user\'s device id is never adopted');
    // sign-out
    assert.strictEqual((await third.call('POST', '/auth/signout', {})).status, 200);
    assert.strictEqual(third.cookie('__Host-wts_sid'), null);
    assert.strictEqual((await third.call('GET', '/me')).json.error, 'signed_out');
    assert.strictEqual((await T.browser().call('POST', '/auth/signout', {})).status, 200, 'without a session too');
    // sign-out everywhere with recent provider links: the link and every session it created go
    const id = me.user.id;
    await T.db.sql`insert into wts.identities (id, user_id, provider, issuer, subject_bidx, subject_enc, email_verified_at_link, linked_at, linked_via)
      values (gen_random_uuid(), ${id}, 'linkedin', 'https://issuer.example', ${Buffer.alloc(32, 3)}, ${Buffer.from('s')}, false, now() - interval '2 days', 'account_page')`;
    const r = await br.call('POST', '/auth/signout-all', { alsoRecentMethodsDays: 14 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.ok(C.checkShape('RevokeRes', r.json).ok);
    assert.strictEqual(r.json.identitiesRemoved, 1); assert.ok(r.json.sessions >= 1);
    assert.strictEqual((await br.call('GET', '/me')).json.error, 'signed_out');
    assert.ok(T.lastMail(email, 'notice_signout_all'));
    assert.strictEqual((await T.db.sql`select count(*)::int as n from wts.sessions where user_id = ${id}`)[0].n, 0);
  });

  test('idle expiry and absolute expiry sign out; the idle slide is written at most every 10 minutes; 401 is the only signed-out answer', async () => {
    const email = 'kim@company.example';
    const br = T.browser(); await T.signIn(br, email);
    const id = await T.userId(email);
    const s0 = (await T.db.sql`select last_seen_at from wts.sessions where user_id = ${id}`)[0].last_seen_at;
    await br.call('GET', '/me');
    const s1 = (await T.db.sql`select last_seen_at from wts.sessions where user_id = ${id}`)[0].last_seen_at;
    assert.strictEqual(+s1, +s0, 'no write inside 10 minutes');
    await T.age`update wts.sessions set last_seen_at = now() - interval '11 minutes' where user_id = ${id}`;
    await br.call('GET', '/me');
    const s2 = (await T.db.sql`select last_seen_at from wts.sessions where user_id = ${id}`)[0].last_seen_at;
    assert.ok(+s2 > +s1, 'slid after 10 minutes');
    await T.age`update wts.sessions set idle_expires_at = now() - interval '1 second' where user_id = ${id}`;
    const r = await br.call('GET', '/me');
    assert.strictEqual(r.status, 401); assert.ok(C.checkError('signed_out', r.json).ok);
    const b2 = T.browser(); await T.signIn(b2, email);
    await T.age`update wts.sessions set abs_expires_at = now() - interval '1 second' where user_id = ${id}`;
    assert.strictEqual((await b2.call('GET', '/projects')).status, 401);
    const garbage = T.browser(); garbage.jar.set('__Host-wts_sid', 'not-a-session');
    assert.strictEqual((await garbage.call('GET', '/me')).status, 401);
  });

  test('locked account: 403 locked on verify and on every signed-in route; 10 failed codes pause the address for 1 h', async () => {
    const email = 'leo@company.example';
    const br = T.browser(); await T.signIn(br, email);
    const id = await T.userId(email);
    await T.db.sql`update wts.users set status = 'locked' where id = ${id}`;
    assert.strictEqual((await br.call('GET', '/me')).json.error, 'locked');
    assert.strictEqual((await br.call('GET', '/projects')).json.error, 'locked');
    await T.db.sql`update wts.users set status = 'active' where id = ${id}`;
    const p = 'pause@company.example';
    await T.signIn(T.browser(), p);
    const b2 = T.browser();
    for (let i = 0; i < 10; i++) await b2.call('POST', '/auth/code/verify', { email: p, code: '00000000', publicDevice: false });
    const n = T.mailsTo(p).length;
    await b2.call('POST', '/auth/code/start', { email: p, purpose: 'signin' });
    assert.strictEqual(T.mailsTo(p).length, n, 'paused after 10 failures');
    assert.ok(T.logs.some((l) => /10 failed codes/.test(l)));
    assert.ok(T.lastMail(p, 'notice_codes_paused'), 'the account address is told');
    const nobody = 'nobody.paused@company.example';
    for (let i = 0; i < 10; i++) await b2.call('POST', '/auth/code/verify', { email: nobody, code: '00000000', publicDevice: false });
    assert.strictEqual(T.mailsTo(nobody).length, 0, 'no mail to an address without an account');
  });

  test('enumeration: the reply of code start does not depend on the mailer (queued) and is padded to the floor', async () => {
    const slow = require('../core/mail').memoryTransport({ delay: (r) => setTimeout(r, 400) });
    const T2 = await harness('auth_timing', { mail: slow, env: { WTS_CODE_FLOOR_MS: '120' } });
    try {
      const br = T2.browser();
      await T2.signIn(br, 'known@company.example');
      const time = async (email) => {
        const t0 = Date.now();
        const out = await T2.app.handle({ method: 'POST', url: '/api/v1/auth/code/start', headers: { host: 'welltest.h2oil.co.uk', origin: 'https://welltest.h2oil.co.uk', 'x-wts-req': '1', 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ email, purpose: 'signin' })), remoteAddress: '198.51.100.1' });
        const dt = Date.now() - t0;
        await T2.app.idle();
        return { dt, status: out.status, body: out.body };
      };
      const a = await time('known@company.example');
      const b = await time('nobody' + Date.now() + '@company.example');
      assert.strictEqual(a.status, 202); assert.strictEqual(b.status, 202); assert.strictEqual(a.body, b.body);
      assert.ok(a.dt >= 115 && b.dt >= 115, 'padded to the floor: ' + a.dt + ' / ' + b.dt);
      assert.ok(a.dt < 380 && b.dt < 380, 'the slow mailer is not waited for: ' + a.dt + ' / ' + b.dt);
    } finally { await T2.close(); }
  });
});
