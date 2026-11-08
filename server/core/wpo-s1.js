'use strict';
// server/core/wpo-s1.js — WP-O SHIM for WP-S1 pieces (docs/ACCOUNTS-PLAN.md §3.4, §4, D4, D11).
//
// WP-O (provider sign-in) is built in parallel with WP-S1 (server core). This file holds the MINIMAL forms of the WP-S1
// helpers that functions/oauth.js needs — keyed indexes, the envelope seal, the session cookie and row, the device row,
// e-mail codes, the account lookups, the audit row and mail — each written against the FROZEN definer signatures of
// db/migrations/001-schema.sql and the contract. At the merge, each export is replaced by (or re-exported from) the WP-S1
// module that owns it; functions/oauth.js imports only through this file, so the swap is one place (see the WP-O merge
// note). Nothing here is used by the browser or by the fake server.
//
//   bidx(config, text)                     HMAC-SHA256(index pepper, text) — address and subject indexes
//   seal(config, buf, aad) / open(config, enc, aad)    AES-256-GCM with the current master key (header v1 | kid | iv | tag)
//   sidHash(sid)                           SHA-256 of a session id (D4)
//   resolveSession(ctx) / requireSession(ctx, {stepup})   the presented session → {sidHash, userId, …} | null; 401 / 403
//   issueSession(ctx, tx, userId, o)       new session row + cookie (Max-Age = seconds to abs_expires_at)
//   ensureDevice(ctx, tx, userId, label, publicDevice) → {id, label, isNew}
//   issueCode(ctx, o) / checkCode(ctx, o)  e-mail codes through code_issue / code_check (purpose and binding in the HMAC)
//   userByEmail(ctx, email), createUser(ctx, o), userEmail(tx, config, userId), allowlistHas(ctx, email)
//   audit(ctx, tx, userId, action, detail), sendMail(ctx, to, template, params), softLimit(ctx, bucket, seconds, limit)

const crypto = require('crypto');
const C = require('./contract');
const V = require('./validate');
const { ApiError } = require('./errors');

const MIN = 60 * 1000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;

function secrets(config) { return config.secrets || {}; }
function indexPepper(config) {
  const k = secrets(config).indexPepper;
  if (!k) throw new Error('wpo-s1: WTS_INDEX_PEPPER is not configured');
  return k;
}
function bidx(config, text) { return crypto.createHmac('sha256', indexPepper(config)).update(String(text), 'utf8').digest(); }
function masterKey(config, kid) {
  const s = secrets(config);
  const list = s.masterKeys || [];
  if (!list.length) throw new Error('wpo-s1: WTS_MASTER_KEYS is not configured');
  if (kid == null) {
    const want = s.masterKid != null ? s.masterKid : list[0].kid;
    return list.find((k) => k.kid === want) || list[0];
  }
  return list.find((k) => k.kid === kid) || null;
}
// enc = 0x01 | kid (uint16) | iv (12) | tag (16) | ciphertext ; AAD binds the purpose of the bytes
function seal(config, buf, aad) {
  const mk = masterKey(config);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', mk.key, iv);
  c.setAAD(Buffer.from('wpo1|' + aad + '|' + mk.kid));
  const ct = Buffer.concat([c.update(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8')), c.final()]);
  const head = Buffer.alloc(3); head[0] = 1; head.writeUInt16BE(mk.kid, 1);
  return Buffer.concat([head, iv, c.getAuthTag(), ct]);
}
function open(config, enc, aad) {
  if (!enc || enc.length < 31 || enc[0] !== 1) return null;
  const kid = enc.readUInt16BE(1);
  const mk = masterKey(config, kid);
  if (!mk) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', mk.key, enc.subarray(3, 15));
    d.setAAD(Buffer.from('wpo1|' + aad + '|' + kid));
    d.setAuthTag(enc.subarray(15, 31));
    return Buffer.concat([d.update(enc.subarray(31)), d.final()]);
  } catch (e) { return null; }
}
const sealJson = (config, o, aad) => seal(config, Buffer.from(JSON.stringify(o), 'utf8'), aad);
function openJson(config, enc, aad) { const b = open(config, enc, aad); if (!b) return null; try { return JSON.parse(b.toString('utf8')); } catch (e) { return null; } }
function sidHash(sid) { return crypto.createHash('sha256').update(String(sid)).digest(); }
const toMs = (v) => (v == null ? null : (v instanceof Date ? v.getTime() : Date.parse(v)));
const iso = (v) => new Date(toMs(v)).toISOString();

async function resolveSession(ctx) {
  const sid = ctx.cookies[C.COOKIES.session.name];
  if (!sid || !ctx.db || !/^[A-Za-z0-9_-]{20,128}$/.test(sid)) return null;
  const h = sidHash(sid);
  const r = await ctx.db.anon((tx) => tx`select * from wts.resolve_session(${h})`);
  if (!r.length) return null;
  const s = r[0];
  const t = Date.now();
  if (toMs(s.idle_expires_at) <= t || toMs(s.abs_expires_at) <= t) return null;
  return { sid, sidHash: h, userId: s.user_id, deviceId: s.device_id, publicDevice: s.public_device, authAt: toMs(s.auth_at),
    stepupAt: toMs(s.stepup_at), authMethod: s.auth_method, identityId: s.identity_id, status: s.status,
    idleExpires: toMs(s.idle_expires_at), absExpires: toMs(s.abs_expires_at) };
}
async function requireSession(ctx, o) {
  const s = await resolveSession(ctx);
  if (!s) throw new ApiError('signed_out');
  if (s.status === 'locked') throw new ApiError('locked');
  if (o && o.stepup && (!s.stepupAt || Date.now() - s.stepupAt > 10 * MIN)) throw new ApiError('reauth');
  return s;
}
// A sign-in revokes the session id the request carried (same user: rotated into the new one; another user: revoked) and
// always issues a fresh id (§4.10 item 5). `tx` runs as the new session's user.
async function issueSession(ctx, tx, userId, o) {
  const presented = ctx.cookies[C.COOKIES.session.name];
  let revokedUser = null;
  if (presented) {
    const r = await tx`select wts.session_revoke_presented(${sidHash(presented)}) as u`;
    revokedUser = r[0] && r[0].u;
  }
  const sid = crypto.randomBytes(32).toString('base64url');
  const pub = !!o.publicDevice;
  const t = Date.now();
  const idle = new Date(t + (pub ? 12 * HOUR : 35 * DAY)); const abs = new Date(t + (pub ? 7 * DAY : 180 * DAY));
  await tx`insert into wts.sessions (sid_hash, user_id, device_id, public_device, created_at, auth_at, stepup_at, last_seen_at,
             idle_expires_at, abs_expires_at, auth_method, identity_id, ip_prefix)
           values (${sidHash(sid)}, ${userId}, ${o.deviceId || null}, ${pub}, now(), now(), ${o.stepup ? new Date(t) : null}, now(),
             ${idle}, ${abs}, ${o.method}, ${o.identityId || null}, ${ctx.ipPrefix || null}::inet)`;
  await tx`update wts.users set last_sign_in_at = now() where id = ${userId}`;
  ctx.setCookie(C.COOKIES.session, sid, { maxAge: Math.max(1, Math.ceil((abs.getTime() - t) / 1000)) });
  return { sid, publicDevice: pub, idleExpires: idle.toISOString(), absExpires: abs.toISOString(), revokedOther: !!revokedUser && revokedUser !== userId };
}
async function ensureDevice(ctx, tx, userId, label, publicDevice) {
  const asked = String((ctx.req.headers && ctx.req.headers['x-wts-device']) || '');
  const lab = V.isLabel(label || '') ? (label || '') : '';
  if (/^[0-9a-f-]{36}$/i.test(asked)) {
    const r = await tx`select device_id, label_enc from wts.devices where user_id = ${userId} and device_id = ${asked} and revoked_at is null`;
    if (r.length) {
      if (lab) await tx`update wts.devices set label_enc = ${seal(ctx.config, lab, 'device-label|' + userId)}, last_seen = now() where user_id = ${userId} and device_id = ${asked}`;
      else await tx`update wts.devices set last_seen = now() where user_id = ${userId} and device_id = ${asked}`;
      const old = r[0].label_enc ? (open(ctx.config, r[0].label_enc, 'device-label|' + userId) || '').toString() : '';
      return { id: asked, label: lab || old, isNew: false };
    }
  }
  const id = crypto.randomUUID();
  await tx`insert into wts.devices (user_id, device_id, label_enc, ua_family, first_seen, last_seen)
           values (${userId}, ${id}, ${lab ? seal(ctx.config, lab, 'device-label|' + userId) : null}, ${publicDevice ? 'public' : null}, now(), now())`;
  return { id, label: lab, isNew: true };
}
function codeHmac(config, key, purpose, email, code, bind) {
  return crypto.createHmac('sha256', key).update([purpose, email, code, (bind && bind.user) || '', (bind && bind.sid) ? Buffer.from(bind.sid).toString('hex') : '',
    (bind && bind.attempt) || ''].join('|')).digest();
}
// → {id, expiresAt}; the code itself goes only into the mail
async function issueCode(ctx, o) {
  const peppers = secrets(ctx.config).codePeppers || [];
  if (!peppers.length) throw new Error('wpo-s1: WTS_CODE_PEPPERS is not configured');
  const p = peppers[0];
  const code = String(crypto.randomInt(0, 1e8)).padStart(8, '0');
  const exp = new Date(Date.now() + 15 * MIN);
  const b = o.bind || {};
  const r = await ctx.db.anon((tx) => tx`select wts.code_issue(${bidx(ctx.config, o.email)}, ${codeHmac(ctx.config, p.key, o.purpose, o.email, code, b)}, ${p.kid},
    ${o.purpose}, ${b.user || null}, ${b.sid || null}, ${b.attempt || null}, ${exp}, ${ctx.ipPrefix || null}::inet) as id`);
  await sendMail(ctx, o.email, o.template, Object.assign({ code }, o.params || {}));
  return { id: r[0].id, expiresAt: exp.getTime() };
}
async function checkCode(ctx, o) {
  const code = V.normCode(o.code);
  if (!/^\d{8}$/.test(code)) return false;
  const b = o.bind || {};
  const hmacs = (secrets(ctx.config).codePeppers || []).map((p) => codeHmac(ctx.config, p.key, o.purpose, o.email, code, b).toString('hex'));
  const r = await ctx.db.anon((tx) => tx`select * from wts.code_check(${bidx(ctx.config, o.email)}, ${o.purpose},
    (select array_agg(decode(x, 'hex')) from unnest(${tx.array(hmacs)}::text[]) x), ${b.user || null}, ${b.sid || null}, ${b.attempt || null})`);
  return !!(r[0] && r[0].ok);
}
async function userByEmail(ctx, email) {
  const r = await ctx.db.anon((tx) => tx`select * from wts.user_by_email(${bidx(ctx.config, email)})`);
  return r.length ? { userId: r[0].user_id, status: r[0].status, role: r[0].role } : null;
}
async function allowlistHas(ctx, email) {
  const r = await ctx.db.anon((tx) => tx`select wts.allowlist_has(${bidx(ctx.config, email)}) as ok`);
  return !!(r[0] && r[0].ok);
}
// → user id, or null when the address is already some account's primary or recovery address
async function createUser(ctx, o) {
  const mk = masterKey(ctx.config);
  const wrapped = seal(ctx.config, crypto.randomBytes(32), 'data-key');
  const r = await ctx.db.anon((tx) => tx`select wts.create_user(${bidx(ctx.config, o.email)}, ${seal(ctx.config, o.email, 'email')}, ${o.method},
    ${ctx.config.terms}, ${ctx.config.privacy}, now(), ${wrapped}, ${mk.kid}) as id`);
  return r[0] && r[0].id;
}
async function userEmail(tx, config, userId) {
  const r = await tx`select email_enc, recovery_enc, status, created_at, terms_version, privacy_version from wts.users where id = ${userId}`;
  if (!r.length) return null;
  const e = open(config, r[0].email_enc, 'email');
  const rec = r[0].recovery_enc ? open(config, r[0].recovery_enc, 'email') : null;
  return { email: e ? e.toString() : null, recovery: rec ? rec.toString() : null, status: r[0].status, created: iso(r[0].created_at) };
}
// one audit row per user, hash-chained (prev_hash = the user's last row)
async function audit(ctx, tx, userId, action, detail) {
  const prev = await tx`select hash from wts.audit where user_id = ${userId} order by id desc limit 1`;
  const p = prev.length ? prev[0].hash : null;
  const at = new Date();
  const d = detail || {};
  const hash = crypto.createHash('sha256').update(Buffer.concat([p || Buffer.alloc(0), Buffer.from(action + '|' + JSON.stringify(d) + '|' + at.toISOString())])).digest();
  await tx`insert into wts.audit (user_id, actor, action, device_id, ip_prefix, at, detail, prev_hash, hash)
           values (${userId}, 'user', ${action}, ${d.device_id || null}, ${ctx.ipPrefix || null}::inet, ${at}, ${tx.json(d)}, ${p}, ${hash})`;
}
// The send is queued and drained after the response by WP-S1 (mail_outbox); the shim hands it to the configured transport
// (tests: the memory transport). Never a client-supplied text; a failure never fails the request.
async function sendMail(ctx, to, template, params) {
  const msg = { to, template, params: Object.assign({ at: new Date().toISOString(), browser: 'Browser', os: 'OS' }, params || {}) };
  try { if (ctx.mail && typeof ctx.mail.send === 'function') await ctx.mail.send(msg); }
  catch (e) { ctx.log.warn('mail: ' + template + ' not sent'); }
}
// Soft per-prefix limits (§8.3): counted through rate_hit; over the limit only logs (never refuses). Errors are ignored.
async function softLimit(ctx, bucket, seconds, limit) {
  if (!ctx.db) return true;
  try {
    const r = await ctx.db.anon((tx) => tx`select * from wts.rate_hit(${bucket}, ${seconds + ' seconds'}::interval, ${limit})`);
    if (r[0] && r[0].allowed === false) { ctx.log.warn('soft limit: ' + bucket.split(':')[0]); return false; }
  } catch (e) { /* rate_hit unavailable: allow */ }
  return true;
}

module.exports = {
  bidx, seal, open, sealJson, openJson, sidHash, resolveSession, requireSession, issueSession, ensureDevice, issueCode, checkCode,
  userByEmail, allowlistHas, createUser, userEmail, audit, sendMail, softLimit, iso, toMs,
};
