'use strict';
// server/core/session.js — sessions and step-up, shared by every sign-in method (docs/ACCOUNTS-PLAN.md D4, §4.6–4.8, §4.13).
// The provider sign-in (WP-O) issues its sessions through the same `issue` with {method:'google'|'linkedin', identityId,
// stepup:false}: `stepup_at` is set ONLY by an e-mail code (and, in Phase 3, a UV passkey) — never by a provider sign-in.
//
//   withSession(ctx, opts, fn(unit, s)) → resolve the __Host-wts_sid cookie (definer resolve_session; a rotated id is valid
//        for 30 s), then ONE transaction as that user: slide the idle expiry (written at most every 10 min) and run fn.
//        opts: {optional, allowDeleting, stepup:true|'fresh'}. Errors: 401 signed_out (the only 401), 403 locked, 410 gone
//        (account deleting), 403 reauth (stepup_at older than 10 min; 'fresh' = 2 min, used for a second confirmation).
//        s = {sid, hash (the current row), presentedHash, userId, deviceId, publicDevice, authAt, stepupAt, authMethod,
//             identityId, idleExpires, absExpires, status, readUnlockUntil}
//   resolve(ctx) → s | null      (no transaction work; used by sign-out and by the presented-session revocation)
//   issue(unit, ctx, {userId, deviceId, publicDevice, method, identityId, stepup}) → {sid, hash, idleExpires, absExpires}
//        sets the cookie with Max-Age = seconds to abs_expires_at (contract COOKIES.session)
//   rotate(unit, ctx, s, {stepup}) → the new session (the old id stays valid for 30 s: replaced_by / replaced_at)
//   revoke(unit, hash)            delete one session and the rotated ids that point at it
//   revokePresented(ctx)          a sign-in revokes the session the request carried, whoever it belongs to (§4.10 item 5)
//   clearCookie(ctx)
//   LIFETIME                      trusted 35 d idle / 180 d absolute; public 12 h / 7 d

const C = require('./contract');
const { ApiError } = require('./errors');
const { randomToken } = require('./keys');
const S = require('./service');

const LIFETIME = { trusted: { idle: '35 days', abs: '180 days' }, public: { idle: '12 hours', abs: '7 days' } };
const SID_RE = /^[A-Za-z0-9_-]{43}$/;

async function resolve(ctx) {
  S.need(ctx);
  const sid = ctx.cookies[C.COOKIES.session.name];
  if (!sid || !SID_RE.test(sid)) return null;
  const h = ctx.keys.sidHash(sid);
  const r = (await ctx.db.anon((tx) => tx`select * from wts.resolve_session(${h})`))[0];
  if (!r) return null;
  return { sid, presentedHash: h, userId: r.user_id, deviceId: r.device_id, publicDevice: r.public_device, authAt: r.auth_at,
    stepupAt: r.stepup_at, authMethod: r.auth_method, identityId: r.identity_id, idleExpires: r.idle_expires_at,
    absExpires: r.abs_expires_at, status: r.status };
}

async function withSession(ctx, opts, fn) {
  opts = opts || {};
  const s = await resolve(ctx);
  if (!s) { if (opts.optional) return fn ? S.unitOf(ctx, null, (u) => fn(u, null)) : null; throw new ApiError('signed_out'); }
  if (ctx.req && ctx.req.meta) ctx.req.meta.uid = s.userId;          // the access line's user id (site/monitor.js)
  if (s.status === 'locked') throw new ApiError('locked');
  if (s.status === 'deleting' && !opts.allowDeleting) throw new ApiError('gone');
  return S.unitOf(ctx, s.userId, async (unit) => {
    const life = s.publicDevice ? LIFETIME.public : LIFETIME.trusted;
    const row = (await unit.sql`
      with cur as (select coalesce(x.replaced_by, x.sid_hash) as h from wts.sessions x where x.sid_hash = ${s.presentedHash}),
      slid as (update wts.sessions t set last_seen_at = now(), idle_expires_at = least(t.abs_expires_at, now() + ${life.idle}::interval)
               where t.sid_hash = (select h from cur) and t.last_seen_at < now() - interval '10 minutes' returning t.sid_hash)
      select t.sid_hash, t.read_unlock_until, t.idle_expires_at,
             (t.stepup_at is not null and t.stepup_at > now() - interval '10 minutes') as stepup_ok,
             (t.stepup_at is not null and t.stepup_at > now() - interval '2 minutes') as stepup_fresh,
             (t.read_unlock_until is not null and t.read_unlock_until > now()) as unlocked
      from wts.sessions t where t.sid_hash = (select h from cur)`)[0];
    if (!row) throw new ApiError('signed_out');
    s.hash = row.sid_hash; s.readUnlocked = row.unlocked; s.readUnlockUntil = row.read_unlock_until;
    s.stepupOk = row.stepup_ok; s.stepupFresh = row.stepup_fresh;
    if (opts.stepup === 'fresh' ? !row.stepup_fresh : (opts.stepup && !row.stepup_ok)) throw new ApiError('reauth');
    return fn(unit, s);
  });
}

// the per-user outbox key of a public device (§10.8) is created at sign-in, so GET /me/outbox-key never writes (§3.2)
async function ensureOutboxKey(unit, ctx, userId) {
  if (unit.userId !== userId || typeof ctx.keys.outboxKey !== 'function') return;
  const u = await unit.user();
  if (u.row.outbox_key_enc) return;
  const key = ctx.keys.outboxKey();
  await unit.sql`update wts.users set outbox_key_enc = ${u.seal('user.outbox_key', key.toString('base64'))} where id = ${userId} and outbox_key_enc is null`;
}

async function issue(unit, ctx, o) {
  const sid = randomToken(32);
  const h = ctx.keys.sidHash(sid);
  const life = o.publicDevice ? LIFETIME.public : LIFETIME.trusted;
  const method = o.method || 'code';
  const r = (await unit.sql`insert into wts.sessions (sid_hash, user_id, device_id, public_device, created_at, auth_at, stepup_at,
      last_seen_at, idle_expires_at, abs_expires_at, auth_method, identity_id, ip_prefix, ua_family)
    values (${h}, ${o.userId}, ${o.deviceId || null}, ${!!o.publicDevice}, now(), now(), ${o.stepup ? unit.sql`now()` : null},
      now(), now() + ${life.idle}::interval, now() + ${life.abs}::interval, ${method}, ${o.identityId || null}, ${ctx.ipPrefix}, ${unit.ua.family})
    returning idle_expires_at, abs_expires_at, ceil(extract(epoch from abs_expires_at - now()))::int as secs`)[0];
  await unit.sql`update wts.users set last_sign_in_at = now() where id = ${o.userId}`;
  await ensureOutboxKey(unit, ctx, o.userId);
  ctx.setCookie(C.COOKIES.session, sid, { maxAge: Math.max(1, r.secs) });
  if (ctx.req && ctx.req.meta) ctx.req.meta.uid = o.userId;
  return { sid, hash: h, idleExpires: r.idle_expires_at, absExpires: r.abs_expires_at, publicDevice: !!o.publicDevice };
}

async function rotate(unit, ctx, s, o) {
  o = o || {};
  const sid = randomToken(32);
  const h = ctx.keys.sidHash(sid);
  const r = (await unit.sql`insert into wts.sessions (sid_hash, user_id, device_id, public_device, created_at, auth_at, stepup_at,
      last_seen_at, idle_expires_at, abs_expires_at, auth_method, identity_id, ip_prefix, ua_family, read_unlock_until)
    select ${h}, user_id, device_id, public_device, created_at, auth_at, ${o.stepup ? unit.sql`now()` : unit.sql`stepup_at`},
      now(), idle_expires_at, abs_expires_at, auth_method, identity_id, ${ctx.ipPrefix}, ${unit.ua.family}, read_unlock_until
    from wts.sessions where sid_hash = ${s.hash}
    returning idle_expires_at, abs_expires_at, public_device, ceil(extract(epoch from abs_expires_at - now()))::int as secs`)[0];
  if (!r) throw new ApiError('signed_out');
  await unit.sql`update wts.sessions set replaced_by = ${h}, replaced_at = now() where sid_hash = ${s.hash}`;
  await unit.sql`update wts.sessions set replaced_by = ${h} where replaced_by = ${s.hash}`;      // older ids follow the chain
  ctx.setCookie(C.COOKIES.session, sid, { maxAge: Math.max(1, r.secs) });
  return { sid, hash: h, idleExpires: r.idle_expires_at, absExpires: r.abs_expires_at, publicDevice: r.public_device };
}

async function revoke(unit, hash) {
  const r = await unit.sql`delete from wts.sessions where sid_hash = ${hash} or replaced_by = ${hash} returning 1`;
  return r.length;
}
async function revokePresented(ctx) {
  const s = await resolve(ctx);
  if (!s) return null;
  await S.unitOf(ctx, s.userId, async (unit) => {
    const cur = (await unit.sql`select coalesce(replaced_by, sid_hash) as h from wts.sessions where sid_hash = ${s.presentedHash}`)[0];
    if (cur) await revoke(unit, cur.h);
  });
  return s.userId;
}
function clearCookie(ctx) { ctx.setCookie(C.COOKIES.session, null); }

module.exports = { LIFETIME, resolve, withSession, issue, rotate, revoke, revokePresented, clearCookie };
