'use strict';
// server/functions/me.js — Me and devices (docs/ACCOUNTS-PLAN.md §3.3): the account summary, the per-user outbox key of a
// public device (§10.8), the opt-ins, device rename and revoke (revoke deletes that device's sessions; notice mail). WP-S1.
// GET /me and the outbox key answer for an account in its deletion grace period too (the page offers Cancel deletion).

const { fail } = require('../core/errors');
const V = require('../core/validate');
const S = require('../core/service');
const SE = require('../core/session');
const { _internal: A } = require('./auth');

const iso = (d) => (d == null ? null : new Date(d).toISOString());

async function me(ctx) {
  const body = await SE.withSession(ctx, { allowDeleting: true }, async (unit, s) => {
    const a = await A.addresses(unit);
    const r = a.u.row;
    const user = { id: r.id, emailMasked: V.maskEmail(a.primary), created: iso(r.created_at), status: r.status, terms: r.terms_version, privacy: r.privacy_version };
    if (a.recovery) user.recoveryMasked = V.maskEmail(a.recovery);
    if (r.delete_at) user.deleteAt = iso(r.delete_at);
    const sess = (await unit.sql`select public_device, auth_at, auth_method, stepup_at, idle_expires_at, abs_expires_at from wts.sessions where sid_hash = ${s.hash}`)[0];
    const projects = (await unit.sql`select count(*)::int as n from wts.projects where user_id = ${r.id} and deleted_at is null`)[0].n;
    const passkeys = (await unit.sql`select id, name_enc, created_at, last_used_at from wts.passkeys where user_id = ${r.id} order by created_at`)
      .map((p) => ({ id: p.id, name: p.name_enc ? a.u.open('passkey.name', p.name_enc) : '', created: iso(p.created_at), lastUsed: iso(p.last_used_at) }));
    const identities = (await unit.sql`select id, provider, linked_at, last_used_at from wts.identities where user_id = ${r.id} order by linked_at`)
      .map((i) => ({ id: i.id, provider: i.provider, linkedAt: iso(i.linked_at), lastUsedAt: iso(i.last_used_at) }));
    const devices = (await unit.sql`select device_id, label_enc, last_seen from wts.devices where user_id = ${r.id} and revoked_at is null order by last_seen desc nulls last`)
      .map((d) => ({ id: d.device_id, label: (d.label_enc && a.u.open('device.label', d.label_enc)) || '', lastSeen: iso(d.last_seen), current: d.device_id === s.deviceId }));
    return {
      user,
      session: { publicDevice: sess.public_device, authAt: iso(sess.auth_at), authMethod: sess.auth_method, stepupAt: iso(sess.stepup_at),
        idleExpires: iso(sess.idle_expires_at), absExpires: iso(sess.abs_expires_at) },
      quota: { limit: Number(r.quota_bytes), used: Number(r.used_bytes) },
      opts: { historian: r.opt_historian, liveCfg: r.opt_livecfg },
      projects, passkeys, identities, devices, minClient: ctx.config.minClient,
    };
  });
  return { status: 200, body };
}

async function outboxKey(ctx) {
  const k = await SE.withSession(ctx, { allowDeleting: true }, async (unit, s) => {
    const u = await unit.user();
    if (u.row.outbox_key_enc) return Buffer.from(u.open('user.outbox_key', u.row.outbox_key_enc), 'base64');
    const key = ctx.keys.outboxKey();
    await unit.sql`update wts.users set outbox_key_enc = ${u.seal('user.outbox_key', key.toString('base64'))} where id = ${s.userId}`;
    return key;
  });
  return { status: 200, body: { k: k.toString('base64') } };
}

async function opts(ctx) {
  const b = ctx.body;
  const out = await SE.withSession(ctx, {}, async (unit, s) => {
    const r = (await unit.sql`update wts.users set opt_historian = coalesce(${b.historian === undefined ? null : b.historian}::boolean, opt_historian),
      opt_livecfg = coalesce(${b.liveCfg === undefined ? null : b.liveCfg}::boolean, opt_livecfg) where id = ${s.userId}
      returning opt_historian, opt_livecfg`)[0];
    return { historian: r.opt_historian, liveCfg: r.opt_livecfg };
  });
  return { status: 200, body: { opts: out } };
}

async function deviceRename(ctx) {
  await SE.withSession(ctx, {}, async (unit, s) => {
    const u = await unit.user();
    const r = await unit.sql`update wts.devices set label_enc = ${u.seal('device.label', ctx.body.label)}
      where user_id = ${s.userId} and device_id = ${ctx.body.id} and revoked_at is null returning 1`;
    if (!r.length) fail('not_found');
  });
  return { status: 200, body: { ok: true } };
}

async function deviceRevoke(ctx) {
  await SE.withSession(ctx, {}, async (unit, s) => {
    const r = await unit.sql`update wts.devices set revoked_at = now() where user_id = ${s.userId} and device_id = ${ctx.body.id} and revoked_at is null returning 1`;
    if (!r.length) fail('not_found');
    const n = (await unit.sql`delete from wts.sessions where user_id = ${s.userId} and device_id = ${ctx.body.id} returning 1`).length;
    const a = await A.addresses(unit);
    await unit.mail(a.primary, 'notice_device_revoked', { at: S.whenText(Date.now()) });
    await unit.audit('device_revoke', { deviceId: s.deviceId, target: ctx.body.id, detail: { sessions: n } });
  });
  return { status: 200, body: { ok: true } };
}

module.exports = { handlers: { me, outboxKey, opts, deviceRename, deviceRevoke } };
