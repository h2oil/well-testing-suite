'use strict';
// server/functions/admin.js — the operator's admin dashboard (server/RUNBOOK.md "Admin dashboard"; the app's Account page →
// Admin, route #admin): who has signed up, from where (the country / city the hosting platform derives from the connection,
// never the address), how active, how much is stored; the invite allow-list.
//
//   GET  /admin/summary   totals, byCountry, byMethod, signupsByDay (one aggregate statement, definer wts.admin_summary);
//                         byCompany (profiles), topClients / topFields (project summaries) — opened here with each account's
//                         key ring (definer wts.admin_insight), top 20, counted case-insensitively
//   GET  /admin/users     ?limit=50 (1–200) &cursor=<opaque> &q=<part of an address>; newest first, keyset on (created_at, id);
//                         each row with the optional profile and "work" (what the account's live projects are about, from
//                         their latest summaries: wells, clients, operators, fields, countries, lastProjectAt)
//   GET  /admin/users/:id one account (the same row) and its live projects with their latest summaries (definers
//                         wts.admin_user_get / admin_user_projects of 070-insight.sql); an unknown id → 404; audited admin.user
//   POST /admin/invites   {email, note?} → 201 {ok:true}; adds the address's keyed index to the allow-list (idempotent)
//   GET  /admin/invites   the allow-list: {addedAt, note} (the list holds keyed indexes only, so no address comes back)
//
// Admin = a signed-in, active account whose primary address is in WTS_ADMIN_EMAILS (core/config.js; unset = the
// WTS_INVITE_BOOTSTRAP addresses). Everyone else — signed out, locked, deleting or simply not an admin — gets 404 not_found,
// exactly like an unknown route. The database repeats the check (every admin definer refuses unless app.user_id is an active
// account whose address index is in the list the handler passes). Every admin call is rate-limited per admin and writes an
// audit row on the admin's chain (actor 'admin', action admin.summary / admin.users / admin.user / admin.invite — add and list); a signed-in non-admin's
// call writes 'admin.denied' (actor 'user'; the first 30 an hour, rate adminDeniedUserHour, still 404 after). Parameters and
// bodies are checked only behind the gate, and core/app.js answers 404 for any refusal before the handler. The search text and invited addresses are never written to the audit.

const { fail, ApiError } = require('../core/errors');
const V = require('../core/validate');
const E = require('../core/envelope');
const SE = require('../core/session');
const R = require('../core/rate');
const { _internal: A } = require('./auth');
const I = require('../core/insight');

const iso = (d) => (d == null ? null : new Date(d).toISOString());
const arr = (sql, bufs) => sql.array(bufs, 17);     // bytea[]
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCAN = 500;                                    // rows read per batch while a search filters on the opened addresses

function adminBidxs(ctx) { return Array.from(ctx.config.adminEmails || []).map((e) => ctx.keys.emailBidx(e)); }

// the admin gate: fn(unit, s, admins) runs in the session's transaction only for an admin; everyone else → 404 not_found
async function asAdmin(ctx, fn) {
  if (!ctx.config.adminEmails || !ctx.config.adminEmails.size) fail('not_found');
  try {
    return await SE.withSession(ctx, {}, async (unit, s) => {
      const a = await A.addresses(unit);
      if (!ctx.config.adminEmails.has(a.primary)) {
        // a non-admin's probes are counted (soft: the answer stays 404, never 429, so the routes stay hidden) and only the
        // first adminDeniedUserHour of them each hour are audited, so one account cannot grow its audit chain without bound
        const h = await R.hit(unit.sql, 'adminDeniedUserHour', s.userId);
        if (!h.over) await unit.audit('admin.denied', { deviceId: s.deviceId, detail: { route: ctx.endpoint.id } });
        return unit.failAfterCommit('not_found');
      }
      return fn(unit, s, arr(unit.sql, adminBidxs(ctx)));
    });
  } catch (e) {
    if (e instanceof ApiError && ['signed_out', 'locked', 'gone', 'reauth', 'paused'].indexOf(e.code) !== -1) fail('not_found');
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

// the profile and "work" of the given accounts (one statement, definer wts.admin_insight; ids null = every account) →
// Map<id, {profile, summaries[], lastProjectAt}>; each account's key ring is opened once
async function insightOf(ctx, unit, admins, ids) {
  const rows = await unit.sql`select * from wts.admin_insight(${admins}, ${ids ? unit.sql.array(ids, 2950) : null}::uuid[])`;
  const out = new Map();
  for (const r of rows) {
    // the profile and the summaries are shown only for an account that accepted the Privacy notice describing them (review
    // fix): anything stored before is not opened
    if (!I.consentCurrent(r, ctx.config)) { out.set(r.user_id, { profile: null, summaries: [], lastProjectAt: iso(r.last_project_at) }); continue; }
    const ring = I.ringOf(ctx.keys, r.data_key_wrapped);
    if (!ring) ctx.log.warn('admin: a key ring could not be opened');
    out.set(r.user_id, {
      profile: I.profileWith(ring, r.profile_enc),
      summaries: (r.summaries || []).map((b) => I.summaryWith(ring, b)).filter(Boolean),
      lastProjectAt: iso(r.last_project_at),
    });
  }
  return out;
}
function workOf(ins) {
  const sm = (ins && ins.summaries) || [];
  const flat = (k) => sm.map((x) => x[k]);
  return {
    wells: I.distinct([].concat(...sm.map((x) => x.wells)), 20),
    clients: I.distinct(flat('client'), 20), operators: I.distinct(flat('operator'), 20),
    fields: I.distinct(flat('field'), 20), countries: I.distinct(flat('country'), 20),
    lastProjectAt: ins ? ins.lastProjectAt : null,
  };
}
function userRow(r, email, ins) {
  return {
    id: r.id, email, method: r.signup_method, status: r.status, createdAt: iso(r.created_at), lastSignInAt: iso(r.last_sign_in_at),
    signupCountry: r.signup_country || null, lastCountry: r.last_country || null, lastCity: r.last_city || null,
    projects: Number(r.projects) || 0, usedBytes: Number(r.used_bytes) || 0,
    profile: (ins && ins.profile) || null, work: workOf(ins),
  };
}

async function adminSummary(ctx) {
  const body = await asAdmin(ctx, async (unit, s, admins) => {
    await R.enforce(unit.sql, 'adminReadUserHour', s.userId);
    const r = (await unit.sql`select wts.admin_summary(${admins}) as v`)[0].v;
    const ins = Array.from((await insightOf(ctx, unit, admins, null)).values());
    const sums = [].concat(...ins.map((x) => x.summaries));
    await unit.audit('admin.summary', { actor: 'admin', deviceId: s.deviceId, detail: { users: r.totals.users } });
    const n = (v) => Number(v) || 0;
    return {
      generatedAt: new Date().toISOString(),
      totals: { users: n(r.totals.users), active7d: n(r.totals.active7d), active30d: n(r.totals.active30d), projects: n(r.totals.projects),
        storageBytes: n(r.totals.storageBytes), invitesPending: n(r.totals.invitesPending) },
      byCountry: r.byCountry.map((c) => ({ country: c.country || null, users: n(c.users), active30d: n(c.active30d) })),
      byMethod: r.byMethod.map((m) => ({ method: m.method, users: n(m.users) })),
      signupsByDay: r.signupsByDay.map((d) => ({ day: d.day, n: n(d.n) })),
      byCompany: I.top(ins.map((x) => x.profile && x.profile.company), 20).map((t) => ({ company: t.value, users: t.n })),
      topClients: I.top(sums.map((x) => x.client), 20).map((t) => ({ client: t.value, projects: t.n })),
      topFields: I.top(sums.map((x) => x.field), 20).map((t) => ({ field: t.value, projects: t.n })),
    };
  });
  return { status: 200, body };
}

async function adminUsers(ctx) {
  // the parameters are checked only behind the gate: a non-admin gets 404 whatever they send
  const body = await asAdmin(ctx, async (unit, s, admins) => {
    const limit = parseLimit(ctx.query);
    const cursor = parseCursor(ctx.query);
    const q = parseSearch(ctx.query);
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
    const ins = out.length ? await insightOf(ctx, unit, admins, out.map((x) => x.r.id)) : new Map();
    return {
      users: out.map(({ r, email }) => userRow(r, email, ins.get(r.id))),
      next: more && out.length ? makeCursor(out[out.length - 1].r) : null,
    };
  });
  return { status: 200, body };
}

async function adminUser(ctx) {
  const body = await asAdmin(ctx, async (unit, s, admins) => {
    await R.enforce(unit.sql, 'adminReadUserHour', s.userId);
    const id = String(ctx.params.id || '');
    const r = UUID_RE.test(id) ? (await unit.sql`select * from wts.admin_user_get(${admins}, ${id}::uuid)`)[0] : null;
    await unit.audit('admin.user', { actor: 'admin', deviceId: s.deviceId, target: r ? r.id : null, detail: { found: !!r } });
    if (!r) return unit.failAfterCommit('not_found');
    // the projects' own names (meta_enc) are never opened here: the name shown is the one in the summary the page sent with a
    // save (privacy notice v2, "Accounts"); a project without a summary — or of an account that has not accepted the current
    // notice — shows only its size and update time (review fix)
    const ok = I.consentCurrent(r, ctx.config);
    const ring = ok ? I.ringOf(ctx.keys, r.data_key_wrapped) : null;
    const ins = (await insightOf(ctx, unit, admins, [r.id])).get(r.id);
    const projects = (await unit.sql`select * from wts.admin_user_projects(${admins}, ${r.id})`).map((p) => {
      const summary = ok ? I.summaryWith(ring, p.summary_enc) : null;
      return { id: p.id, name: (summary && summary.name) || '', updatedAt: iso(p.modified_at), bytes: Number(p.head_bytes) || 0,
        summary, summaryAt: summary ? iso(p.summary_at) : null };
    });
    return { user: userRow(r, openEmail(ctx, r), ins), projects };
  });
  return { status: 200, body };
}

async function adminInviteAdd(ctx) {
  await asAdmin(ctx, async (unit, s, admins) => {
    // the body (shape included: core/app.js defers it for the admin routes) is checked only behind the gate
    const b = ctx.checkBody ? ctx.checkBody() : ctx.body;
    const email = V.normEmail(b.email);
    if (!email) fail('bad_request', { field: 'email' });
    const note = b.note === undefined ? '' : String(b.note).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
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

module.exports = { handlers: { adminSummary, adminUsers, adminUser, adminInviteAdd, adminInvites }, _internal: { parseCursor, makeCursor, asAdmin, workOf } };
