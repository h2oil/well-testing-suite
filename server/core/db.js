'use strict';
// server/core/db.js — the SQL adapter (docs/ACCOUNTS-PLAN.md D2, D12). The one place that loads the database driver
// (server/package.json pins it; the browser bundle never sees it). Request handlers connect as wts_api and run each request
// in a transaction that first sets app.user_id with set_config(…, true) — the transaction-local form, so a pooled
// connection never carries a user id into the next transaction (rls.test.js checks it).
//
//   createDb(conn, {max, role?, sessionRole?}) → { sql, role, ping(), asUser(userId, fn), anon(fn), checkRole(), close() }
//     conn: a connection URL (WTS_DB_URL) or {host, port, user, password?, database}
//   asUser(userId, fn(tx))  BEGIN; [SET LOCAL ROLE <role>;] set_config('app.user_id', userId, true); fn; COMMIT
//   anon(fn(tx))            BEGIN; [SET LOCAL ROLE <role>;] fn; COMMIT — the pre-auth path, which may only call the definer functions
//
// One-login hosting (v4.0, server/README.md "Hosting"): a platform that hands out ONE database login (the owner of the
// database) cannot give wts_api / wts_jobs / wts_support their own credentials. `role` keeps the plan's separate roles there:
//   • every asUser / anon transaction starts with SET LOCAL ROLE <role> (transaction-scoped, safe behind a transaction pooler;
//     forced row-level security then applies exactly as for a wts_api login);
//   • sessionRole:true also sends `role` as a connection start-up parameter, so EVERY statement of that pool runs as the
//     role — for the scheduled jobs (core/jobs.js uses db.sql directly) and the operations scripts. A login that is not a
//     member of the role cannot connect at all (fail closed).
//   checkRole() → the current_user of a plain statement; throws unless it equals `role` (sessionRole pools only).
// URLs: query parameters other than sslmode / sslrootcert are dropped (the driver would send them as start-up parameters,
// e.g. channel_binding, which the server refuses); sslmode require / prefer / verify-ca to a non-loopback host is raised to
// verify-full (certificate and host name checked).

const ROLE_RE = /^wts_[a-z]{2,16}$/;
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/;

function loadDriver() {
  // The driver is a server-only dependency (server/node_modules); it is never required by the client or the fake server.
  return require('postgres');
}

// a connection URL with only the parameters the driver should see; TLS raised to verify-full off loopback
function cleanUrl(raw) {
  const u = new URL(String(raw));
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('db: not a database URL');
  const keep = new URLSearchParams();
  const mode = u.searchParams.get('sslmode');
  const root = u.searchParams.get('sslrootcert');
  if (mode) keep.set('sslmode', !LOOPBACK.test(u.hostname) && /^(require|prefer|verify-ca|allow)$/.test(mode) ? 'verify-full' : mode);
  if (root) keep.set('sslrootcert', root);
  u.search = keep.toString() ? '?' + keep.toString() : '';
  return u.toString();
}

function createDb(conn, o) {
  o = o || {};
  const role = o.role ? String(o.role) : '';
  if (role && !ROLE_RE.test(role)) throw new Error('db: role must be one of the wts_* roles');
  const driver = loadDriver();
  const opts = { max: o.max || 4, idle_timeout: o.idleTimeout || 20, connect_timeout: o.connectTimeout || 10, onnotice: () => {}, prepare: false };
  if (role && o.sessionRole) opts.connection = { role };
  const sql = typeof conn === 'string' ? driver(cleanUrl(conn), opts) : driver(Object.assign({}, opts, {
    host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: conn.database,
  }));
  // the role name is checked against ROLE_RE above, so it can be spliced into the statement
  const enter = role ? (tx) => tx.unsafe('set local role ' + role) : () => null;
  return {
    sql, role,
    async ping() { const r = await sql`select 1 as ok`; return !!(r[0] && r[0].ok === 1); },
    asUser(userId, fn) {
      if (!/^[0-9a-f-]{36}$/.test(String(userId || ''))) throw new Error('db.asUser: a user id is required');
      return sql.begin(async (tx) => { await enter(tx); await tx`select set_config('app.user_id', ${userId}, true)`; return fn(tx); });
    },
    anon(fn) { return sql.begin(async (tx) => { await enter(tx); return fn(tx); }); },
    async checkRole() {
      const r = (await sql`select current_user as u`)[0].u;
      if (role && r !== role) throw new Error('db: statements run as ' + r + ', expected ' + role);
      return r;
    },
    close() { return sql.end({ timeout: 5 }); },
  };
}

module.exports = { createDb, cleanUrl, ROLE_RE };
