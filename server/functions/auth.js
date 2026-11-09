'use strict';
// server/functions/auth.js — Auth (docs/ACCOUNTS-PLAN.md §3.3, §4.1–4.9): e-mail codes (sign-in and step-up), e-mail change
// and 7-day revert, recovery address, sign-out and sign-out everywhere. WP-S1.
// GET /auth/methods and POST /auth/methods/unlink are in functions/oauth.js (WP-O); passkeys (WP-C3, Phase 3) still answer
// 501 not_implemented.
//
// Rules kept here:
//   • code/start ALWAYS answers 202 after a fixed floor (config.codeFloorMs); unknown, throttled, paused, locked and
//     invite-refused addresses take the same path; the mail is queued and sent after the response (§3.3, T4).
//   • A code is an HMAC over purpose ‖ address ‖ code (‖ user ‖ session for step-up, e-mail change, recovery add); two live
//     per address, purpose and client range (sign-in); 5 tries each; sends limited per address AND range (5/h, 20/day) and
//     10 failures per address and range per 24 h pause that pair for 1 h (§8.3, review fix: a stranger elsewhere can neither
//     use up nor pause the owner's codes). Session-bound codes are limited per session. The e-mail revert proof is a
//     130-bit key, not an 8-digit code.
//   • code/verify for a new account without the current consent answers 409 consent_required and does NOT burn the code.
//   • stepup_at is set by a code only (session.js); a sign-in revokes the session the request carried.

const { fail, ApiError } = require('../core/errors');
const V = require('../core/validate');
const S = require('../core/service');
const { inviteListed } = require('../core/config');
const SE = require('../core/session');
const R = require('../core/rate');
const E = require('../core/envelope');
const { code8, revertKey } = require('../core/keys');
const I = require('../core/insight');

const ADDR = 'user.address';     // one envelope field label for every address column (they move between columns in SQL)
const iso = (d) => (d == null ? null : new Date(d).toISOString());
const addrKey = (bidx) => bidx.toString('hex').slice(0, 32);
const consentOk = (ctx, c) => !!c && c.terms === ctx.config.terms && c.privacy === ctx.config.privacy;
const arr = (sql, bufs) => sql.array(bufs, 17);     // bytea[]

function signInBody(user, emailPlain, sess, device, first) {
  return {
    user: { id: user.id, emailMasked: V.maskEmail(emailPlain), created: iso(user.created_at) },
    firstSignIn: !!first,
    device: { id: device.id, label: device.label || '' },
    session: { publicDevice: !!sess.publicDevice, idleExpires: iso(sess.idleExpires), absExpires: iso(sess.absExpires) },
  };
}
function mailParams(unit) { return { browser: unit.ua.browser, os: unit.ua.os, at: S.whenText(Date.now()) }; }

// the send limits of a code to an address (§8.3, review fix). HARD per address AND client address range (5/h, 20/day, and the
// 1-hour pause of that pair after 10 failed codes), so a stranger elsewhere can never use up or pause the owner's sends; per
// address in all (50/day) only an alert. Shared with provider sign-in (functions/oauth.js): every unbound code mail obeys it.
const rangeKey = (ctx, bidx) => addrKey(bidx) + ':' + (ctx.ipPrefix || '-');
async function mayStart(unit, ctx, bidx) {
  const k = rangeKey(ctx, bidx);
  if ((await R.peek(unit.sql, 'codePauseHour', k)).n > 0) return false;
  const h = await R.hit(unit.sql, 'codeStartAddrIpHour', k);
  const d = await R.hit(unit.sql, 'codeStartAddrIpDay', k);
  const all = await R.hit(unit.sql, 'codeStartAddrDay', addrKey(bidx));
  if (all.over && all.n === all.limit + 1) ctx.log.warn('alert: one address above 50 code sends in 24 h (all client ranges together)');
  return h.allowed && d.allowed;
}
// codes bound to a session (step-up, e-mail change, recovery add): counted per session, never in the address buckets, so a
// stranger's sends to the address cannot block the signed-in owner's step-up
async function mayStartSession(unit, s) {
  return (await R.hit(unit.sql, 'codeStartSessionHour', Buffer.from(s.hash).toString('hex').slice(0, 32))).allowed;
}
// a verify from an address and range that reached 10 failed codes today is refused without checking (bounds guessing per
// range; other ranges, and so the owner elsewhere, are not affected)
async function verifyBlocked(unit, ctx, bidx) {
  const k = rangeKey(ctx, bidx);
  const f = await R.peek(unit.sql, 'codeVerifyFailDay', k);
  return f.n >= f.limit;
}
// a wrong unbound code counts a try only on the codes sent to the caller's own range (migration 050, wts.ip_prefix)
async function scopeChecks(unit, ctx) { await unit.sql`select set_config('wts.ip_prefix', ${ctx.ipPrefix || ''}, true)`; }
async function issueCode(unit, ctx, o) {
  const code = o.purpose === 'email_revert' ? revertKey() : code8();
  // the revert code is checked before anyone is signed in (old address + code only), so its HMAC carries no binding; the
  // row still names its user
  const { kid, hmac } = ctx.keys.codeHmac(o.purpose, o.email, code, o.purpose === 'email_revert' ? null : o.bind);
  await unit.sql`select wts.code_issue(${ctx.keys.emailBidx(o.email)}, ${hmac}, ${kid}, ${o.purpose}, ${(o.bind && o.bind.user) || null},
    ${(o.bind && o.bind.sid) || null}, ${null}, ${null}, ${ctx.ipPrefix})`;
  if (o.template) await unit.mail(o.email, o.template, Object.assign(mailParams(unit), { code }, o.params || {}));
  return code;
}
// a failed code, counted only when a live code existed for the address (attempts_left -1 = none: nothing to guess, so junk
// verifies cannot pause anyone). Per address and range: the 10th in 24 h pauses that pair's codes for 1 h; per address in
// all only an alert.
async function noteFailure(unit, ctx, bidx, email, attemptsLeft) {
  if (attemptsLeft === -1) return null;
  const k = rangeKey(ctx, bidx);
  const f = await R.hit(unit.sql, 'codeVerifyFailDay', k);
  const all = await R.hit(unit.sql, 'codeVerifyFailAddrDay', addrKey(bidx));
  if (all.over && all.n === all.limit + 1) ctx.log.warn('alert: one address above 50 failed codes in 24 h (all client ranges together)');
  if (f.n === f.limit) {                                    // the 10th failure in 24 h from one range: that pair pauses for 1 h
    await R.hit(unit.sql, 'codePauseHour', k);
    ctx.log.warn('alert: an address reached 10 failed codes in 24 h from one client range — paused there for 1 h');
    // the notice goes only to an address that belongs to an account (never a mail to an address nobody registered)
    if (email && (await unit.sql`select 1 from wts.user_by_email(${bidx})`).length) await unit.mail(email, 'notice_codes_paused', { at: S.whenText(Date.now()) });
  }
  return f;
}

// the session user's addresses (decrypted)
async function addresses(unit) {
  const u = await unit.user();
  return { u, primary: u.open(ADDR, u.row.email_enc), recovery: u.row.recovery_enc ? u.open(ADDR, u.row.recovery_enc) : null };
}

async function codeStart(ctx) {
  S.need(ctx);
  const t0 = Date.now();
  const b = ctx.body;
  const email = b.email === undefined ? null : V.normEmail(b.email);
  if (b.email !== undefined && !email) fail('bad_request', { field: 'email' });
  try {
    if (b.purpose === 'signin') await startSignin(ctx, email);
    else await startForSession(ctx, b, email);
  } catch (e) {
    if (!(e instanceof ApiError) || ['paused'].indexOf(e.code) !== -1) { await S.pad(ctx.config.codeFloorMs, t0); throw e; }
    // signed_out / locked / gone / reauth / rate … never show: the reply stays uniform
  }
  await S.pad(ctx.config.codeFloorMs, t0);
  return { status: 202, body: { ok: true } };
}
async function startSignin(ctx, email) {
  const bidx = ctx.keys.emailBidx(email);
  await S.unitOf(ctx, null, async (unit) => {
    const ip = ctx.ipPrefix ? await R.hit(unit.sql, 'codeStartIpHour', ctx.ipPrefix) : null;
    if (ip && ip.over && ip.n === ip.limit + 1) ctx.log.warn('alert: code starts above the soft per-prefix limit');
    const site = await R.hit(unit.sql, 'codeStartSiteHour', 'all');
    if (site.over && site.n === site.limit + 1) ctx.log.warn('alert: site-wide code starts above 1,000/h — unknown addresses paused');
    if (!(await mayStart(unit, ctx, bidx))) return;
    const acc = (await unit.sql`select * from wts.user_by_email(${bidx})`)[0];
    if (acc) { if (acc.status === 'locked') return; }
    else {
      if (site.over || ctx.config.signup === 'off') return;
      if (ctx.config.signup === 'invite' && !(await inviteListed(ctx.config, email, async () => (await unit.sql`select wts.allowlist_has(${bidx}) as ok`)[0].ok))) return;
    }
    await issueCode(unit, ctx, { purpose: 'signin', email, template: 'code_signin' });
  });
}
async function startForSession(ctx, b, email) {
  await SE.withSession(ctx, {}, async (unit, s) => {
    const a = await addresses(unit);
    if (b.purpose === 'stepup') {
      const to = b.to === 'recovery' && a.recovery ? a.recovery : a.primary;
      if (!(await mayStartSession(unit, s))) return;
      await issueCode(unit, ctx, { purpose: 'stepup', email: to, bind: { user: s.userId, sid: s.hash }, template: 'code_stepup' });
      return;
    }
    // "Send again" for an e-mail change or a recovery address: only to the address that is waiting for its code
    const col = b.purpose === 'email_change' ? a.u.row.email_pending_enc : a.u.row.recovery_pending_enc;
    const pending = col ? a.u.open(ADDR, col) : null;
    if (!pending || pending !== email) return;
    if (!(await mayStartSession(unit, s))) return;
    await issueCode(unit, ctx, { purpose: b.purpose, email: pending, bind: { user: s.userId, sid: s.hash },
      template: b.purpose === 'email_change' ? 'code_email_change' : 'code_recovery_add' });
  });
}

async function codeVerify(ctx) {
  S.need(ctx);
  const b = ctx.body;
  const code = V.normCode(b.code);
  // 1. a step-up of the session the request carries
  const s0 = await SE.resolve(ctx);
  if (s0 && s0.status !== 'locked') {
    const res = await SE.withSession(ctx, { allowDeleting: true }, async (unit, s) => {
      const a = await addresses(unit);
      let cands = [a.primary].concat(a.recovery ? [a.recovery] : []);
      if (b.email !== undefined) { const e = V.normEmail(b.email); cands = cands.filter((x) => x === e); if (!cands.length) return null; }
      const hm = ctx.keys.codeCandidates('stepup', cands, code, { user: s.userId, sid: s.hash });
      const r = (await unit.sql`select * from wts.code_check(${null}, 'stepup', ${arr(unit.sql, hm)}, ${s.userId}, ${s.hash}, ${null})`)[0];
      if (!r.ok) {
        if (b.email !== undefined) return null;               // not a step-up code: try it as a sign-in code below
        // a step-up code is bound to this session (5 tries each, 5 sends per session per hour): never in the address buckets
        return unit.failAfterCommit('invalid_or_expired');
      }
      const n = await SE.rotate(unit, ctx, s, { stepup: true });
      const d = (await unit.sql`select device_id, label_enc from wts.devices where user_id = ${s.userId} and device_id = ${s.deviceId}`)[0];
      const device = d ? { id: d.device_id, label: a.u.open('device.label', d.label_enc) || '' } : await S.deviceFor(unit, ctx, s.userId, { publicDevice: s.publicDevice });
      await unit.audit('stepup', { deviceId: device.id, detail: { method: 'code' } });
      return signInBody(a.u.row, a.primary, n, device, false);
    });
    if (res) return { status: 200, body: res };
  }
  if (b.email === undefined) fail('invalid_or_expired');
  // 2. a sign-in (or sign-up) with an e-mail code
  const email = V.normEmail(b.email);
  if (!email) fail('invalid_or_expired');
  // the optional profile (insight follow-up) is stored only when this request creates the account; checked before any try
  const profile = b.profile !== undefined ? I.normProfile(b.profile) : null;
  const bidx = ctx.keys.emailBidx(email);
  const CONSENT = {};
  const res = await S.unitOf(ctx, null, async (unit) => {
    const acc = (await unit.sql`select * from wts.user_by_email(${bidx})`)[0] || null;
    const hm = ctx.keys.codeCandidates('signin', email, code);
    if (await verifyBlocked(unit, ctx, bidx)) return unit.failAfterCommit('invalid_or_expired');
    await scopeChecks(unit, ctx);
    let outcome; let left = 0;
    try {
      outcome = await unit.sql.savepoint(async (sp) => {
        const r = (await sp`select * from wts.code_check(${bidx}, 'signin', ${arr(sp, hm)}, ${null}, ${null}, ${null})`)[0];
        if (!r.ok) { left = r.attempts_left; return 'miss'; }
        if (!acc && !consentOk(ctx, b.consent)) throw CONSENT;   // roll the savepoint back: the code is not burnt
        return 'hit';
      });
    } catch (e) { if (e === CONSENT) outcome = 'consent'; else throw e; }
    if (outcome === 'miss') { await noteFailure(unit, ctx, bidx, email, left); return unit.failAfterCommit('invalid_or_expired'); }
    // countryHint (user insight): the platform-detected country, the default of the optional sign-up profile (only when known)
    if (outcome === 'consent') return unit.failAfterCommit('consent_required', Object.assign({ terms: ctx.config.terms, privacy: ctx.config.privacy }, countryHint(ctx)));
    let userId; let first = false;
    if (acc) {
      if (acc.status === 'locked') return unit.failAfterCommit('locked');
      userId = acc.user_id;
    } else {
      if (ctx.config.signup === 'off') return unit.failAfterCommit('invalid_or_expired');
      if (ctx.config.signup === 'invite' && !(await inviteListed(ctx.config, email, async () => (await unit.sql`select wts.allowlist_has(${bidx}) as ok`)[0].ok))) return unit.failAfterCommit('invalid_or_expired');
      const ring = ctx.keys.ring.create();
      const enc = E.sealField(ring.keys.get(1), 1, ADDR, email);
      userId = (await unit.sql`select wts.create_user(${bidx}, ${enc}, 'code', ${ctx.config.terms}, ${ctx.config.privacy}, now(), ${ring.wrapped}, ${ring.kid}) as id`)[0].id;
      if (!userId) return unit.failAfterCommit('invalid_or_expired');
      first = true;
    }
    await unit.setUser(userId);
    const a = await addresses(unit);
    // a version bump asks again at the next sign-in (§8.4): stale consent on an existing account → 409 (code kept)
    if (!first && (a.u.row.terms_version !== ctx.config.terms || a.u.row.privacy_version !== ctx.config.privacy)) {
      if (!consentOk(ctx, b.consent)) throw CONSENT;
    }
    if (!first && consentOk(ctx, b.consent)) await unit.sql`update wts.users set terms_version = ${ctx.config.terms}, privacy_version = ${ctx.config.privacy}, consented_at = now() where id = ${userId}`;
    const device = await S.deviceFor(unit, ctx, userId, { label: b.deviceLabel, publicDevice: b.publicDevice });
    const sess = await SE.issue(unit, ctx, { userId, deviceId: device.id, publicDevice: b.publicDevice, method: 'code', stepup: true, signup: first });
    if (first) await unit.audit('signup', { deviceId: device.id, detail: { method: 'code' } });
    if (first && profile && !I.isEmptyProfile(profile)) await I.storeProfile(unit, profile, 'signup', device.id);
    await unit.audit('signin', { deviceId: device.id, detail: { method: 'code', newDevice: device.isNew, via: acc && acc.role === 'recovery' ? 'recovery' : 'primary' } });
    if (device.isNew && !first) await unit.mail(a.primary, 'notice_new_device', mailParams(unit));
    return signInBody(a.u.row, a.primary, sess, device, first);
  }).catch(async (e) => {
    if (e !== CONSENT) throw e;
    // stale consent of an existing account: the whole transaction rolled back, so the code was not burnt
    throw new ApiError('consent_required', { terms: ctx.config.terms, privacy: ctx.config.privacy });
  });
  await revokeOther(ctx);
  return { status: 200, body: res };
}
// a sign-in revokes the session the request carried (same user: replaced by the new one; another user: revoked)
async function revokeOther(ctx) { try { await SE.revokePresented(ctx); } catch (e) { ctx.log.warn('revoke presented session failed'); } }

// the uniform 202 of e-mail change and recovery add is padded to the same floor as code/start (T4): a taken address, an
// address inside the revert window and a sent code take the same time
async function padded(ctx, fn) {
  const t0 = Date.now();
  try { return await fn(); } finally { await S.pad(ctx.config.codeFloorMs, t0); }
}

async function emailChange(ctx) {
  await padded(ctx, () => SE.withSession(ctx, { stepup: true }, async (unit, s) => {
    const e = V.normEmail(ctx.body.newEmail);
    if (!e) fail('bad_request', { field: 'newEmail' });
    await R.enforce(unit.sql, 'mailEmailChangeHour', s.userId);
    const a = await addresses(unit);
    if (e === a.primary) return;
    // inside the 7-day revert window of an earlier change no further change starts (wts.email_move refuses it too), so the
    // first address keeps its revert code (T18); the reply stays uniform
    const w = a.u.row.email_revert_until;
    if (w && new Date(w).getTime() > Date.now()) return;
    const bidx = ctx.keys.emailBidx(e);
    if ((await unit.sql`select 1 from wts.user_by_email(${bidx})`).length) return;   // uniform: nothing is said or sent
    await unit.sql`update wts.users set email_pending_enc = ${a.u.seal(ADDR, e)} where id = ${s.userId}`;
    await issueCode(unit, ctx, { purpose: 'email_change', email: e, bind: { user: s.userId, sid: s.hash }, template: 'code_email_change' });
  }));
  return { status: 202, body: { ok: true } };
}

async function emailConfirm(ctx) {
  const out = await SE.withSession(ctx, {}, async (unit, s) => {
    const a = await addresses(unit);
    const pending = a.u.row.email_pending_enc ? a.u.open(ADDR, a.u.row.email_pending_enc) : null;
    if (!pending) return unit.failAfterCommit('invalid_or_expired');
    const bidx = ctx.keys.emailBidx(pending);
    const hm = ctx.keys.codeCandidates('email_change', pending, V.normCode(ctx.body.code), { user: s.userId, sid: s.hash });
    const r = (await unit.sql`select * from wts.code_check(${bidx}, 'email_change', ${arr(unit.sql, hm)}, ${s.userId}, ${s.hash}, ${null})`)[0];
    if (!r.ok) return unit.failAfterCommit('invalid_or_expired');
    const moved = (await unit.sql`select wts.email_move(${s.userId}, ${bidx}, ${a.u.seal(ADDR, pending)}) as ok`)[0].ok;
    if (!moved) return unit.failAfterCommit('invalid_or_expired');            // the uniform reply: taken in the meantime
    const revertCode = await issueCode(unit, ctx, { purpose: 'email_revert', email: a.primary, bind: { user: s.userId } });
    await unit.sql`delete from wts.sessions where user_id = ${s.userId} and sid_hash <> ${s.hash} and (replaced_by is null or replaced_by <> ${s.hash})`;
    const at = S.whenText(Date.now());
    await unit.mail(a.primary, 'notice_email_changed', { at, revertCode });
    await unit.mail(pending, 'notice_email_added', { at });
    await unit.audit('email_change', { deviceId: s.deviceId });
    return { emailMasked: V.maskEmail(pending) };
  });
  return { status: 200, body: out };
}

async function emailRevert(ctx) {
  S.need(ctx);
  const old = V.normEmail(ctx.body.email);
  if (!old) fail('invalid_or_expired');
  const out = await S.unitOf(ctx, null, async (unit) => {
    const bidx = ctx.keys.emailBidx(old);
    const ak = addrKey(bidx);
    if (ctx.ipPrefix) {
      const ip = await R.hit(unit.sql, 'revertIpHour', ctx.ipPrefix);
      if (ip.over && ip.n === ip.limit + 1) ctx.log.warn('alert: revert tries above the soft per-prefix limit');
    }
    // the proof is a 130-bit revert key (keys.revertKey), so a guess cannot succeed; wrong tries are throttled only per old
    // address AND client range (5/h; the key is not even checked then, and never burnt). Per old address in all they only
    // raise an alert: the person who changed the address cannot use up the owner's way back from other ranges (T18).
    const k = ak + ':' + (ctx.ipPrefix || '-');
    const f1 = await R.peek(unit.sql, 'revertFailAddrIpHour', k);
    if (f1.n >= f1.limit) return unit.failAfterCommit('rate', { retryAfter: Math.max(1, Number(f1.retryAfter) || 60) });
    const key = V.normRevertKey(ctx.body.code);
    const r = key ? (await unit.sql`select * from wts.email_revert(${bidx}, ${arr(unit.sql, ctx.keys.codeCandidates('email_revert', old, key))})`)[0] : null;
    if (!r) {
      await R.hit(unit.sql, 'revertFailAddrIpHour', k);
      const f2 = await R.hit(unit.sql, 'revertFailAddrDay', ak);
      if (f2.over && f2.n === f2.limit + 1) ctx.log.warn('alert: more than 100 wrong revert tries for one old address in 24 h');
      return unit.failAfterCommit('invalid_or_expired');
    }
    await unit.setUser(r.user_id);
    const a = await addresses(unit);
    const device = await S.deviceFor(unit, ctx, r.user_id, {});
    await SE.issue(unit, ctx, { userId: r.user_id, deviceId: device.id, publicDevice: false, method: 'code', stepup: true });
    await unit.mail(a.primary, 'notice_email_reverted', { at: S.whenText(Date.now()) });
    await unit.audit('email_revert', { deviceId: device.id, detail: { sessions: r.sessions, passkeys: r.passkeys, identities: r.identities } });
    return { ok: true, sessions: r.sessions, passkeysRemoved: r.passkeys, identitiesRemoved: r.identities };
  });
  await revokeOther(ctx);
  return { status: 200, body: out };
}

async function recoverySet(ctx) {
  const b = ctx.body;
  if (b.email !== undefined) return padded(ctx, () => recoverySetWith(ctx, b));
  return recoverySetWith(ctx, b);
}
async function recoverySetWith(ctx, b) {
  return SE.withSession(ctx, { stepup: true }, async (unit, s) => {
    const a = await addresses(unit);
    if (b.email !== undefined) {
      const e = V.normEmail(b.email);
      if (!e) fail('bad_request', { field: 'email' });
      await R.enforce(unit.sql, 'mailEmailChangeHour', s.userId);
      const bidx = ctx.keys.emailBidx(e);
      if (e !== a.primary && !(await unit.sql`select 1 from wts.user_by_email(${bidx})`).length) {
        await unit.sql`update wts.users set recovery_pending_enc = ${a.u.seal(ADDR, e)} where id = ${s.userId}`;
        await issueCode(unit, ctx, { purpose: 'recovery_add', email: e, bind: { user: s.userId, sid: s.hash }, template: 'code_recovery_add' });
      }
      return { status: 202, body: { ok: true } };
    }
    const pending = a.u.row.recovery_pending_enc ? a.u.open(ADDR, a.u.row.recovery_pending_enc) : null;
    if (!pending) return unit.failAfterCommit('invalid_or_expired');
    const bidx = ctx.keys.emailBidx(pending);
    const hm = ctx.keys.codeCandidates('recovery_add', pending, V.normCode(b.code), { user: s.userId, sid: s.hash });
    const r = (await unit.sql`select * from wts.code_check(${bidx}, 'recovery_add', ${arr(unit.sql, hm)}, ${s.userId}, ${s.hash}, ${null})`)[0];
    if (!r.ok) return unit.failAfterCommit('invalid_or_expired');
    const ok = (await unit.sql`select wts.recovery_set(${s.userId}, ${bidx}, ${a.u.seal(ADDR, pending)}) as ok`)[0].ok;
    if (!ok) return unit.failAfterCommit('invalid_or_expired');
    const at = S.whenText(Date.now());
    await unit.mail(a.primary, 'notice_recovery_set', { at });
    await unit.mail(pending, 'notice_recovery_set', { at });
    if (a.recovery) await unit.mail(a.recovery, 'notice_recovery_removed', { at });
    await unit.audit('recovery_set', { deviceId: s.deviceId });
    return { status: 200, body: { ok: true } };
  });
}

async function recoveryRemove(ctx) {
  await SE.withSession(ctx, { stepup: true }, async (unit, s) => {
    const a = await addresses(unit);
    if (!a.recovery) return;
    await unit.sql`select wts.recovery_set(${s.userId}, ${null}, ${null})`;
    const at = S.whenText(Date.now());
    await unit.mail(a.primary, 'notice_recovery_removed', { at });
    await unit.mail(a.recovery, 'notice_recovery_removed', { at });
    await unit.audit('recovery_remove', { deviceId: s.deviceId });
  });
  return { status: 200, body: { ok: true } };
}

async function signOut(ctx) {
  if (ctx.db && ctx.keys && ctx.keys.ready) {
    try {
      const s = await SE.resolve(ctx);
      if (s) {
        await S.unitOf(ctx, s.userId, async (unit) => {
          const cur = (await unit.sql`select coalesce(replaced_by, sid_hash) as h from wts.sessions where sid_hash = ${s.presentedHash}`)[0];
          if (cur) await SE.revoke(unit, cur.h);
          await unit.audit('signout', { deviceId: s.deviceId });
        });
      }
    } catch (e) { if (!(e instanceof ApiError)) ctx.log.warn('signout: ' + e.message); }
  }
  SE.clearCookie(ctx);
  return { status: 200, body: { ok: true } };
}

async function signOutAll(ctx) {
  const days = ctx.body.alsoRecentMethodsDays;
  const out = await SE.withSession(ctx, { stepup: true, allowDeleting: false }, async (unit, s) => {
    const a = await addresses(unit);
    let passkeys = 0; let identities = 0;
    if (days) {
      const since = unit.sql`now() - ${Math.min(days, 3650) + ' days'}::interval`;
      passkeys = (await unit.sql`delete from wts.passkeys where user_id = ${s.userId} and created_at >= ${since} returning 1`).length;
      identities = (await unit.sql`select * from wts.identities_remove_since(${s.userId}, ${since})`)[0].identities;
    }
    const sessions = (await unit.sql`delete from wts.sessions where user_id = ${s.userId} and replaced_by is null returning 1`).length;
    await unit.sql`delete from wts.sessions where user_id = ${s.userId}`;
    await unit.mail(a.primary, 'notice_signout_all', { at: S.whenText(Date.now()) });
    await unit.audit('signout_all', { deviceId: s.deviceId, detail: { sessions, passkeys, identities, recentDays: days || 0 } });
    return { ok: true, sessions, passkeysRemoved: passkeys, identitiesRemoved: identities };
  });
  SE.clearCookie(ctx);
  return { status: 200, body: out };
}

const notImplemented = () => fail('not_implemented');

function countryHint(ctx) { return ctx.geo && ctx.geo.country ? { countryHint: ctx.geo.country } : {}; }
module.exports = {
  handlers: {
    codeStart, codeVerify, emailChange, emailConfirm, emailRevert, recoverySet, recoveryRemove, signOut, signOutAll,
    // Phase 3 (WP-C3)
    passkeyOptions: notImplemented, passkeyVerify: notImplemented, passkeyRegisterOptions: notImplemented,
    passkeyRegisterVerify: notImplemented, passkeyRename: notImplemented, passkeyRemove: notImplemented,
    // methods / unlink live in functions/oauth.js (WP-O)
  },
  _internal: { signInBody, addresses, issueCode, mailParams, mayStart, noteFailure, verifyBlocked, scopeChecks, ADDR },
};
