'use strict';
// server/functions/admin.js — the operator's admin dashboard (server/RUNBOOK.md "Admin dashboard"; the app's Account page →
// Admin, route #admin): who has signed up, from where (the country / city the hosting platform derives from the connection,
// never the address), how active, how much is stored; the invite allow-list.
//
//   GET  /admin/summary   totals, byCountry, byMethod, signupsByDay (one aggregate statement, definer wts.admin_summary)
//   GET  /admin/users     ?limit=50 (1–200) &cursor=<opaque> &q=<part of an address>; newest first, keyset on (created_at, id)
//   POST /admin/invites   {email, note?} → 201 {ok:true}; adds the address's keyed index to the allow-list (idempotent)
//   GET  /admin/invites   the allow-list: {addedAt, note} (the list holds keyed indexes only, so no address comes back)
//
// Admin = a signed-in, active account whose primary address is in WTS_ADMIN_EMAILS (core/config.js; unset = the
// WTS_INVITE_BOOTSTRAP addresses). Everyone else — signed out, locked, deleting or simply not an admin — gets 404 not_found,
// exactly like an unknown route. The database repeats the check (every admin definer refuses unless app.user_id is an active
// account whose address index is in the list the handler passes). Every admin call is rate-limited per admin and writes an
// audit row on the admin's chain (actor 'admin', action admin.summary / admin.users / admin.invite — add and list); a signed-in non-admin's
// call writes 'admin.denied' (actor 'user'). The search text and invited addresses are never written to the audit.

const { fail, ApiError } = require('../core/errors');
const V = require('../core/validate');
const E = require('../core/envelope');
const SE = require('../core/session');
const R = require('../core/rate');
const { _internal: A } = require('./auth');

const iso = (d) => (d == null ? null : new Date(d).toISOString());
const arr = (sql, bufs) => sql.array(bufs, 17);     // bytea[]
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SCAN = 500;                                    // rows read per batch while a search filters on the opened addresses

function adminBidxs(ctx) { return Array.from(ctx.config.adminEmails || []).map((e) => ctx.keys.emailBidx(e)); }

// the admin gate: fn(unit, s, admins) runs in the session's transaction only for an admin; everyone else → 404 not_found
async function asAdmin(ctx, fn) {
  if (!ctx.config.adminEmails || !ctx.config.adminEmails.size) fail('not_found');
  try {
    return await SE.withSession(ctx, {}, async (unit, s) => {
      const a = await A.addresses(unit);
      if (!ctx.config.adminEmails.has(a.primary)) {
        await unit.audit('admin.denied', { deviceId: s.deviceId, detail: { route: ctx.endpoint.id } });
        return unit.failAfterCommit('not_found');
      }
      return fn(unit, s, arr(unit.sql, adminBidxs(ctx)));
    });
  } catch (e) {
    if (e instanceof ApiError && ['signed_out', 'locked', 'gone', 'reauth'].indexOf(e.code) !== -1) fail('not_found');
    throw e;
  }
}

function parseLimit(q) {
  if (q.limit === undefined || q.limit === '') return 50;
  if (!/^\d{1,3}$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > 200) fail('bad_request', { field: 'limit' });
  return Number(q.limit);
}
function parseCursor(q) {
  if (q.cursor === undefined || q.cursor === '') return null;
  let m = null;
  if (/^[A-Za-z0-9_-]{1,120}$/.test(q.cursor)) m = CURSOR_RE.exec(Buffer.from(q.cursor, 'base64url').toString('utf8'));
  if (!m || isNaN(Date.parse(m[1]))) fail('bad_request', { field: 'cursor' });
  return { at: m[1], id: m[2] };
}
function makeCursor(row) { return Buffer.from(row.created_us + '|' + row.id, 'utf8').toString('base64url'); }
function parseSearch(q) {
  if (q.q === undefined) return '';
  const s = String(q.q).normalize('NFKC').trim().toLowerCase();
  if (s.length > 254 || /[\u0000-\u001f]/.test(s)) fail('bad_request', { field: 'q' });
  return s;
}
function openEmail(ctx, row) {
  try { return E.openField(ctx.keys.ring.open(row.data_key_wrapped), A.ADDR, row.email_enc).toString('utf8'); } catch (e) {
    ctx.log.warn('admin: an address could not be opened');
    return '';
  }
}

async function adminSummary(ctx) {
  const body = await asAdmin(ctx, async (unit, s, admins) => {
    await R.enforce(unit.sql, 'adminReadUserHour', s.userId);
    const r = (await unit.sql`select wts.admin_summary(${admins}) as v`)[0].v;
    await unit.audit('admin.summary', { actor: 'admin', deviceId: s.deviceId, detail: { users: r.totals.users } });
    const n = (v) => Number(v) || 0;
    return {
      generatedAt: new Date().toISOString(),
      totals: { users: n(r.totals.users), active7d: n(r.totals.active7d), active30d: n(r.totals.active30d), projects: n(r.totals.projects),
        storageBytes: n(r.totals.storageBytes), invitesPending: n(r.totals.invitesPending) },
      byCountry: r.byCountry.map((c) => ({ country: c.country || null, users: n(c.users), active30d: n(c.active30d) })),
      byMethod: r.byMethod.map((m) => ({ method: m.method, users: n(m.users) })),
      signupsByDay: r.signupsByDay.map((d) => ({ day: d.day, n: n(d.n) })),
    };
  });
  return { status: 200, body };
}

async function adminUsers(ctx) {
  const limit = parseLimit(ctx.query);
  const cursor = parseCursor(ctx.query);
  const q = parseSearch(ctx.query);
  const body = await asAdmin(ctx, async (unit, s, admins) => {
    await R.enforce(unit.sql, 'adminReadUserHour', s.userId);
    const out = [];
    let before = cursor;
    let more = false;
    // without a search one page plus one row tells whether there is more; with one, batches are read and filtered on the
    // opened addresses until a page plus one row matched or the list ends
    for (;;) {
      const batch = q ? SCAN : limit + 1;
      // the cursor time goes in as text: a timestamptz parameter would pass through a JS Date and lose the microseconds
      const rows = await unit.sql`select *, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_us
        from wts.admin_users(${admins}, ${batch}, ${before ? before.at : null}::text::timestamptz, ${before ? before.id : null}::text::uuid)`;
      for (const r of rows) {
        const email = openEmail(ctx, r);
        if (q && email.indexOf(q) === -1) continue;
        if (out.length === limit) { more = true; break; }
        out.push({ r, email });
      }
      if (more || rows.length < batch) break;
      const last = rows[rows.length - 1];
      before = { at: last.created_us, id: last.id };
    }
    await unit.audit('admin.users', { actor: 'admin', deviceId: s.deviceId, detail: { limit, n: out.length, search: !!q, page: cursor ? 'next' : 'first' } });
    return {
      users: out.map(({ r, email }) => ({
        id: r.id, email, method: r.signup_method, status: r.status, createdAt: iso(r.created_at), lastSignInAt: iso(r.last_sign_in_at),
        signupCountry: r.signup_country || null, lastCountry: r.last_country || null, lastCity: r.last_city || null,
        projects: Number(r.projects) || 0, usedBytes: Number(r.used_bytes) || 0,
      })),
      next: more && out.length ? makeCursor(out[out.length - 1].r) : null,
    };
  });
  return { status: 200, body };
}

async function adminInviteAdd(ctx) {
  const email = V.normEmail(ctx.body.email);
  if (!email) fail('bad_request', { field: 'email' });
  const note = ctx.body.note === undefined ? '' : String(ctx.body.note).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
  await asAdmin(ctx, async (unit, s, admins) => {
    await R.enforce(unit.sql, 'adminInviteUserDay', s.userId);
    const added = (await unit.sql`select wts.admin_invite_add(${admins}, ${ctx.keys.emailBidx(email)}, ${note}) as ok`)[0].ok;
    await unit.audit('admin.invite', { actor: 'admin', deviceId: s.deviceId, detail: { op: 'add', added: !!added, note: !!note } });
  });
  return { status: 201, body: { ok: true } };
}

async function adminInvites(ctx) {
  const body = await asAdmin(ctx, async (unit, s, admins) => {
    await R.enforce(unit.sql, 'adminReadUserHour', s.userId);
    const rows = await unit.sql`select * from wts.admin_invites(${admins})`;
    await unit.audit('admin.invite', { actor: 'admin', deviceId: s.deviceId, detail: { op: 'list', n: rows.length } });
    return { invites: rows.map((r) => ({ addedAt: iso(r.added_at), note: r.note == null ? null : r.note })) };
  });
  return { status: 200, body };
}

module.exports = { handlers: { adminSummary, adminUsers, adminInviteAdd, adminInvites }, _internal: { parseCursor, makeCursor, asAdmin } };
