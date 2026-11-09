'use strict';
// server/functions/account.js — export, delete with a 7-day grace, cancel (docs/ACCOUNTS-PLAN.md §3.3 Account, §8.5). WP-S1.
//   export (step-up, 5/day): the account JSON (profile, consents, devices, passkey names and dates, linked providers with the
//     subject and the e-mail as received at link time, the account's own audit rows of 12 months, projects with their
//     revision lists); raises THIS session's blob read limit to 300 MB/h for 2 h; a security notice. The page adds the bodies.
//   The export also carries the optional profile and each project's latest summary (insight follow-up).
//   profile (PUT /account/profile, a signed-in session; 30/h): replaces the optional profile (core/insight.js).
//   delete (step-up; `immediate` needs a FRESH step-up, ≤ 2 min — the second confirmation): status deleting, identities
//     released and every session revoked in the same transaction (definer deletion_request), the ledger row written; the daily
//     job purges after the grace. A sign-in during the grace reaches only GET /me and cancel (everything else answers 410 gone).

const S = require('../core/service');
const SE = require('../core/session');
const R = require('../core/rate');
const { _internal: A } = require('./auth');
const { _internal: P } = require('./projects');
const I = require('../core/insight');

const iso = (d) => (d == null ? null : new Date(d).toISOString());
const tryOpen = (u, field, buf) => { try { return buf == null ? null : u.open(field, buf); } catch (e) { return null; } };

async function accountExport(ctx) {
  const body = await SE.withSession(ctx, { stepup: true }, async (unit, s) => {
    await R.enforce(unit.sql, 'exportUserDay', s.userId);
    const a = await A.addresses(unit);
    const u = a.u; const r = u.row;
    const devices = (await unit.sql`select * from wts.devices where user_id = ${s.userId} order by first_seen`).map((d) => ({
      id: d.device_id, label: tryOpen(u, 'device.label', d.label_enc) || '', firstSeen: iso(d.first_seen), lastSeen: iso(d.last_seen), revoked: iso(d.revoked_at) }));
    const passkeys = (await unit.sql`select name_enc, created_at from wts.passkeys where user_id = ${s.userId} order by created_at`)
      .map((p) => ({ name: tryOpen(u, 'passkey.name', p.name_enc) || '', created: iso(p.created_at) }));
    const identities = (await unit.sql`select * from wts.identities where user_id = ${s.userId} order by linked_at`).map((i) => ({
      provider: i.provider, subject: tryOpen(u, 'identity.subject', i.subject_enc) || '(encrypted)', email: tryOpen(u, 'identity.email', i.email_link_enc),
      emailVerifiedAtLink: i.email_verified_at_link, linkedAt: iso(i.linked_at), lastUsedAt: iso(i.last_used_at) }));
    const audit = (await unit.sql`select action, at, target, device_id, ip_prefix, ua_family, detail from wts.audit
      where user_id = ${s.userId} and at > now() - interval '12 months' order by id`).map((x) => ({
      action: x.action, at: iso(x.at), target: x.target || null, device: x.device_id || null, ipPrefix: x.ip_prefix || null, browser: x.ua_family || null, detail: x.detail || {} }));
    const projects = [];
    for (const p of await unit.sql`select * from wts.projects where user_id = ${s.userId} order by created_at`) {
      const m = P.openMeta(u, p.meta_enc);
      const revs = (await unit.sql`select * from wts.revisions where project_id = ${p.id} order by rev`).map(P.revItem);
      // the latest summary sent with a Save to cloud (insight follow-up; privacy notice: what the operator can view)
      projects.push({ id: p.id, name: m.name, meta: m.meta, headRev: Number(p.head_rev), trashed: !!p.deleted_at, revs,
        summary: I.openSummary(u, p.summary_enc), summaryAt: iso(p.summary_at) });
    }
    await unit.sql`update wts.sessions set read_unlock_until = now() + interval '2 hours' where sid_hash = ${s.hash}`;
    await unit.mail(a.primary, 'notice_export', { at: S.whenText(Date.now()) });
    await unit.audit('export', { deviceId: s.deviceId, detail: { projects: projects.length } });
    return {
      user: { id: r.id, email: a.primary, recovery: a.recovery, created: iso(r.created_at), status: r.status, signupMethod: r.signup_method,
        lastSignIn: iso(r.last_sign_in_at),
        // the country / city the hosting platform gave for the sign-up and the last sign-in (privacy notice: profile data)
        signupCountry: r.signup_country || null, lastCountry: r.last_country || null, lastCity: r.last_city || null,
        quota: { limit: Number(r.quota_bytes), used: Number(r.used_bytes) },
        opts: { historian: r.opt_historian, liveCfg: r.opt_livecfg } },
      consents: { terms: r.terms_version, privacy: r.privacy_version, at: iso(r.consented_at) },
      devices, passkeys, identities, audit, projects,
      // the optional profile (insight follow-up); null when none was given
      profile: I.openProfile(u, r.profile_enc),
    };
  });
  return { status: 200, body };
}

// PUT /account/profile — replaces the whole optional profile (a missing key = null; every field null = none stored); the
// audit row names the fields set, never their values
async function profileUpdate(ctx) {
  const p = I.normProfile(ctx.body);
  const body = await SE.withSession(ctx, {}, async (unit, s) => {
    await R.enforce(unit.sql, 'profileUserHour', s.userId);
    await I.storeProfile(unit, p, 'account', s.deviceId);
    return { profile: p };
  });
  return { status: 200, body };
}

async function accountDelete(ctx) {
  const immediate = !!ctx.body.immediate;
  const body = await SE.withSession(ctx, { stepup: immediate ? 'fresh' : true }, async (unit, s) => {
    const a = await A.addresses(unit);
    const t = new Date();
    await unit.sql`select wts.deletion_request(${s.userId}, ${t}, ${new Date(t.getTime() + (immediate ? 0 : 7 * 86400e3))})`;
    const r = (await unit.sql`select delete_at from wts.users where id = ${s.userId}`)[0];
    await unit.mail(a.primary, 'notice_delete_requested', { deleteAt: S.whenText(+r.delete_at) });
    await unit.audit('delete_request', { deviceId: s.deviceId, detail: { immediate } });
    return { ok: true, deleteAt: iso(r.delete_at) };
  });
  SE.clearCookie(ctx);
  return { status: 200, body };
}

async function accountDeleteCancel(ctx) {
  await SE.withSession(ctx, { allowDeleting: true }, async (unit, s) => {
    const ok = (await unit.sql`select wts.deletion_cancel(${s.userId}) as ok`)[0].ok;
    // not cancelled (the account is not deleting, or its grace has passed and the purge is due): never report a cancel
    if (!ok) return unit.failAfterCommit('gone');
    const a = await A.addresses(unit);
    await unit.mail(a.primary, 'notice_delete_cancelled', { at: S.whenText(Date.now()) });
    await unit.audit('delete_cancel', { deviceId: s.deviceId });
  });
  return { status: 200, body: { ok: true } };
}

module.exports = { handlers: { accountExport, accountDelete, accountDeleteCancel, profileUpdate } };
