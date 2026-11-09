'use strict';
// server/test/_db.js — database helpers for the server tests. Each test FILE gets its own freshly migrated database in the
// throwaway cluster started by test/run.js, so files never share rows.
//
//   available()                 → true when WTS_TEST_DB is set (run.js started a cluster)
//   freshDatabase(name) → Promise<{conn, admin (driver as wts_admin), as(role) (a driver logged in as that role), close()}>

const { createDb } = require('../core/db');
const { migrate } = require('../db/migrate');

function available() { return !!process.env.WTS_TEST_DB; }

async function freshDatabase(name) {
  const base = JSON.parse(process.env.WTS_TEST_DB);
  const server = createDb(base, { max: 1 });
  const db = 'wts_t_' + String(name).replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  try {
    await server.sql.unsafe('DROP DATABASE IF EXISTS ' + db);
    await server.sql.unsafe('CREATE DATABASE ' + db);
  } finally { await server.close(); }
  const conn = Object.assign({}, base, { database: db });
  const admin = createDb(conn, { max: 2 });
  await migrate(admin.sql);
  const opened = [admin];
  return {
    conn, admin,
    as(role) { const d = createDb(Object.assign({}, conn, { user: role }), { max: 2 }); opened.push(d); return d; },
    async close() { for (const d of opened) { try { await d.close(); } catch (e) { /* closed */ } } },
  };
}

module.exports = { available, freshDatabase };
