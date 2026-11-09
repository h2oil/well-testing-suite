'use strict';
// server/core/db.js — the SQL adapter (docs/ACCOUNTS-PLAN.md D2, D12). The one place that loads the database driver
// (server/package.json pins it; the browser bundle never sees it). Request handlers connect as wts_api and run each request
// in a transaction that first sets app.user_id with set_config(…, true) — the transaction-local form, so a pooled
// connection never carries a user id into the next transaction (rls.test.js checks it).
//
//   createDb(conn, {max}) → { sql, ping(), asUser(userId, fn), anon(fn), close() }
//     conn: a connection URL (WTS_DB_URL) or {host, port, user, password?, database}
//   asUser(userId, fn(tx))  BEGIN; set_config('app.user_id', userId, true); fn; COMMIT
//   anon(fn(tx))            BEGIN; fn; COMMIT — the pre-auth path, which may only call the definer functions

function loadDriver() {
  // The driver is a server-only dependency (server/node_modules); it is never required by the client or the fake server.
  return require('postgres');
}

function createDb(conn, o) {
  o = o || {};
  const driver = loadDriver();
  const opts = { max: o.max || 4, idle_timeout: o.idleTimeout || 20, connect_timeout: o.connectTimeout || 10, onnotice: () => {}, prepare: false };
  const sql = typeof conn === 'string' ? driver(conn, opts) : driver(Object.assign({}, opts, {
    host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: conn.database,
  }));
  return {
    sql,
    async ping() { const r = await sql`select 1 as ok`; return !!(r[0] && r[0].ok === 1); },
    asUser(userId, fn) {
      if (!/^[0-9a-f-]{36}$/.test(String(userId || ''))) throw new Error('db.asUser: a user id is required');
      return sql.begin(async (tx) => { await tx`select set_config('app.user_id', ${userId}, true)`; return fn(tx); });
    },
    anon(fn) { return sql.begin((tx) => fn(tx)); },
    close() { return sql.end({ timeout: 5 }); },
  };
}

module.exports = { createDb };
