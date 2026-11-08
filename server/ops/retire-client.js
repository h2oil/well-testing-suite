#!/usr/bin/env node
'use strict';
// server/ops/retire-client.js — audited support script (docs/ACCOUNTS-PLAN.md §4.14, §13.7, D18): before a NEW provider client
// (app) goes live, remove every identity of that provider. A re-created LinkedIn app gives every user a new pairwise subject,
// and UNIQUE (user_id, provider) would otherwise answer provider_linked; after this script each user re-links with one e-mail
// code (§4.12 rule 5). Every removed identity takes its sessions with it, gets an audit row with actor support:<id> and the
// subject only as its keyed index, and queues an unlink notice to the account address.
//
//   node server/ops/retire-client.js --provider linkedin --actor support:<id> --yes
//     connection from WTS_SUPPORT_DB_URL (the wts_support credential: EXECUTE on the audited support functions only)
//   require('./retire-client').retireClient(db, {provider, actor}) → Promise<{users, identities, sessions}>
// Without --yes it prints what it would do and changes nothing. Never prints an address, subject or user id.

const PROVIDERS = ['google', 'linkedin'];
const ACTOR_RE = /^support:[A-Za-z0-9_.-]{1,64}$/;

async function retireClient(db, o) {
  o = o || {};
  if (PROVIDERS.indexOf(o.provider) === -1) throw new Error('retire-client: --provider google|linkedin');
  if (!ACTOR_RE.test(String(o.actor || ''))) throw new Error('retire-client: --actor support:<id>');
  const rows = await db.sql`select * from wts.support_retire_identities(${o.actor}, ${o.provider})`;
  return {
    users: new Set(rows.map((r) => r.user_id)).size,
    identities: rows.reduce((n, r) => n + r.identities, 0),
    sessions: rows.reduce((n, r) => n + r.sessions, 0),
  };
}

function parseArgs(argv) {
  const o = { yes: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--provider') o.provider = argv[++i];
    else if (argv[i] === '--actor') o.actor = argv[++i];
    else if (argv[i] === '--yes') o.yes = true;
  }
  return o;
}

module.exports = { retireClient, parseArgs };

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  if (PROVIDERS.indexOf(o.provider) === -1 || !ACTOR_RE.test(String(o.actor || ''))) {
    console.error('usage: retire-client.js --provider google|linkedin --actor support:<id> [--yes]');
    process.exit(2);
  }
  if (!o.yes) {
    console.log('[retire-client] dry run: would remove every ' + o.provider + ' identity (and the sessions it created), audit each as '
      + o.actor + ' and queue an unlink notice. Run again with --yes, only BEFORE the new client goes live.');
    process.exit(0);
  }
  const url = process.env.WTS_SUPPORT_DB_URL;
  if (!url) { console.error('[retire-client] WTS_SUPPORT_DB_URL is not set'); process.exit(2); }
  const { createDb } = require('../core/db');
  const db = createDb(url, { max: 1 });
  retireClient(db, o)
    .then((r) => { console.log('[retire-client] ' + o.provider + ': ' + r.identities + ' identities removed for ' + r.users + ' users; ' + r.sessions + ' sessions revoked'); return db.close(); })
    .catch((e) => { console.error('[retire-client] ' + e.message); db.close().finally(() => process.exit(1)); });
}
