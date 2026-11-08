'use strict';
// server/core/service.js — the shared request plumbing of the WP-S1 handlers (docs/ACCOUNTS-PLAN.md §3, D12):
//
//   need(ctx)                       the database and keys, else 503 paused (no database configured, or production secrets missing)
//   unitOf(ctx, userId|null, fn)    one transaction (wts_api; app.user_id set when a user id is given, or later by
//                                   unit.setUser). Mail queued in it is sent only AFTER the commit (ctx.after); a value of
//                                   unit.failAfterCommit(code) is thrown once the transaction has committed (so a wrong code's
//                                   counted try is kept).
//   unit: {sql, userId, setUser(id), user() → {row, keys, dkv, seal(field, v), open(field, buf)}, mail(to, template, params),
//          audit(action, {target, detail}), system(action, …)}
//   syncGate(ctx, write)            SYNC_MODE: off → 503 paused; readonly → 503 readonly on writes
//   uaFamily(ua)                    {browser, os, family} — generic words only (mails never carry a client-supplied string)
//   deviceFor(unit, ctx, userId, {label, publicDevice}) → {id, label, isNew}   (user, device id) only; a foreign id is ignored
//   whenText(ms)                    "2026-11-08 12:00 UTC" for mails
//   pad(ms, startedAt)              wait until a fixed floor has passed (code start, §3.3)

const { ApiError } = require('./errors');
const { checkMessage, compose, render } = require('./mail');
const H = require('./http');

function need(ctx) {
  if (!ctx.db || !ctx.keys || !ctx.keys.ready) throw new ApiError('paused');
  return ctx;
}
function syncGate(ctx, write) {
  if (ctx.config.syncMode === 'off') throw new ApiError('paused');
  if (write && ctx.config.syncMode === 'readonly') throw new ApiError('readonly');
}
function uaFamily(ua) {
  const s = String(ua || '');
  const mobile = /Mobi|Tablet/i.test(s);
  return { browser: 'a web browser', os: mobile ? 'a phone or tablet' : 'a computer', family: mobile ? 'browser/mobile' : (s ? 'browser/desktop' : 'unknown') };
}
function whenText(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' UTC';
}
function pad(ms, startedAt) {
  const wait = ms - (Date.now() - startedAt);
  return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
}

// send one queued message after the commit; the outbox row is marked sent, or keeps its try count for the daily retry
async function sendQueued(ctx, m) {
  if (!ctx.mail || typeof ctx.mail.send !== 'function') return;          // no transport here: the daily job sends it
  let ok = false;
  try { await ctx.mail.send(compose({ to: m.to, template: m.template, params: m.params })); ok = true; } catch (e) { ctx.log.warn('mail: send failed (' + m.template + ')'); }
  try { await ctx.db.anon((tx) => tx`select wts.mail_mark(${m.id}, ${ok})`); } catch (e) { ctx.log.warn('mail: mark failed'); }
}

async function unitOf(ctx, userId, fn) {
  need(ctx);
  const mails = [];
  let after = null;
  let userCache = null;
  const ua = uaFamily(H.header(ctx.req, 'user-agent'));
  const run = async (tx) => {
    const unit = {
      sql: tx, userId: userId || null, ua,
      async setUser(id) { await tx`select set_config('app.user_id', ${id}, true)`; unit.userId = id; userCache = null; },
      async user(force) {
        if (!unit.userId) throw new Error('unit.user: no user');
        if (userCache && !force) return userCache;
        const row = (await tx`select * from wts.users where id = ${unit.userId}`)[0];
        if (!row) throw new ApiError('signed_out');
        const keys = ctx.keys.ring.open(row.data_key_wrapped);
        const dkv = row.data_key_ver;
        userCache = {
          row, keys, dkv,
          seal: (field, v) => require('./envelope').sealField(keys.get(dkv), dkv, field, v),
          open: (field, buf) => (buf == null ? null : require('./envelope').openField(keys, field, buf).toString('utf8')),
        };
        return userCache;
      },
      // queue a mail: the outbox row is written in this transaction; the send happens after the commit
      async mail(to, template, params) {
        const msg = { to, template, params: Object.assign({}, params || {}) };
        const e = checkMessage(msg);
        if (e) throw new Error('mail: ' + e);
        render(template, msg.params);                     // a malformed parameter fails the request, not the later send
        const toEnc = ctx.keys.system.seal('mail.to', to);
        const pEnc = ctx.keys.system.seal('mail.params', JSON.stringify({ template, params: msg.params }));
        const id = (await tx`select wts.mail_queue(${toEnc}, ${template}, ${pEnc}) as id`)[0].id;
        mails.push(Object.assign({ id }, msg));
        return id;
      },
      async audit(action, o) {
        o = o || {};
        await tx`insert into wts.audit (user_id, actor, action, target, device_id, ip_prefix, ua_family, at, detail, hash)
          values (${o.userId || unit.userId}, 'user', ${action}, ${o.target || null}, ${o.deviceId || null}, ${ctx.ipPrefix}, ${ua.family},
                  now(), ${tx.json(o.detail || {})}, '\\x'::bytea)`;
      },
      async system(action, o) {
        o = o || {};
        await tx`select wts.audit_system(${action}, ${o.target || null}, ${o.deviceId || null}, ${ctx.ipPrefix}, ${ua.family}, ${tx.json(o.detail || {})})`;
      },
      failAfterCommit(code, extra) { after = { code, extra }; return null; },
    };
    if (userId) await tx`select set_config('app.user_id', ${userId}, true)`;
    return fn(unit);
  };
  const out = await ctx.db.anon(run);
  mails.forEach((m) => ctx.after(() => sendQueued(ctx, m)));
  if (after) throw new ApiError(after.code, after.extra);
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function deviceFor(unit, ctx, userId, o) {
  o = o || {};
  const asked = String(H.header(ctx.req, 'x-wts-device') || '').toLowerCase();
  const u = await unit.user();
  if (UUID_RE.test(asked)) {
    const d = (await unit.sql`select device_id, label_enc from wts.devices where user_id = ${userId} and device_id = ${asked} and revoked_at is null`)[0];
    if (d) {
      if (o.label) await unit.sql`update wts.devices set last_seen = now(), label_enc = ${u.seal('device.label', o.label)}, ua_family = ${unit.ua.family} where user_id = ${userId} and device_id = ${asked}`;
      else await unit.sql`update wts.devices set last_seen = now(), ua_family = ${unit.ua.family} where user_id = ${userId} and device_id = ${asked}`;
      return { id: d.device_id, label: o.label || u.open('device.label', d.label_enc) || '', isNew: false };
    }
  }
  const label = o.label || (o.publicDevice ? 'Public computer' : '');
  const id = (await unit.sql`insert into wts.devices (user_id, device_id, label_enc, ua_family, first_seen, last_seen)
    values (${userId}, gen_random_uuid(), ${u.seal('device.label', label)}, ${unit.ua.family}, now(), now()) returning device_id`)[0].device_id;
  return { id, label, isNew: true };
}

module.exports = { need, syncGate, uaFamily, whenText, pad, unitOf, deviceFor, sendQueued, UUID_RE };
