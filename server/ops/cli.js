'use strict';
// server/ops/cli.js — the shared runner of the audited support and incident scripts (docs/ACCOUNTS-PLAN.md D18, §13.4–13.7;
// procedures in server/RUNBOOK.md, WP-OPS). Credentials and keys come only from the environment:
//   WTS_SUPPORT_DB_URL   the wts_support credential (lookup, allowlist-add, security-reset, recover)
//   WTS_JOBS_DB_URL      the wts_jobs credential (rewrap, ledger-replay, recover's sealing step)
//   WTS_MASTER_KEYS, WTS_MASTER_KID, WTS_INDEX_PEPPER, WTS_CODE_PEPPERS   as for the functions
// Output is one JSON line with ids, counts and dates only — never an address, a key or a body.
// Each connection runs as its role (wts_support / wts_jobs) through the start-up role of core/db.js: with a dedicated login
// that is the login itself; with a one-login host (v4.0) both variables may hold the platform's production connection
// string, and the statements still run as wts_support / wts_jobs, never as the database owner.
//
//   node server/ops/<script>.js --actor support:<id> [--email …] [--user …] [--since ISO] [--to-kid n] [--note …]

const { loadJobsConfig } = require('../core/config');
const { createKeys } = require('../core/keys');
const { createDb } = require('../core/db');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (m) { out[m[1]] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  }
  return out;
}

async function run(name, needs, fn) {
  const a = args(process.argv.slice(2));
  const config = loadJobsConfig(Object.assign({}, process.env));
  const keys = createKeys(config);
  const open = [];
  const db = (env, role) => { const url = process.env[env]; if (!url) throw new Error(env + ' is not set'); const d = createDb(url, { max: 1, role, sessionRole: true }); open.push(d); return d; };
  try {
    if (config.production && !keys.ready) throw new Error('keys are not configured: ' + keys.missing.join(', '));
    const ctx = { args: a, keys, config };
    if (needs.indexOf('support') !== -1) ctx.support = db('WTS_SUPPORT_DB_URL', 'wts_support');
    if (needs.indexOf('jobs') !== -1) ctx.jobs = db('WTS_JOBS_DB_URL', 'wts_jobs');
    const out = await fn(ctx);
    process.stdout.write(JSON.stringify({ ok: true, op: name, result: out }) + '\n');
    return 0;
  } catch (e) {
    process.stderr.write(JSON.stringify({ ok: false, op: name, error: String(e.message || e) }) + '\n');
    return 1;
  } finally {
    for (const d of open) { try { await d.close(); } catch (e) { /* closed */ } }
  }
}
function main(name, needs, fn) {
  if (require.main && require.main.filename && /server[\\/]ops[\\/]/.test(require.main.filename)) run(name, needs, fn).then((c) => { process.exitCode = c; });
}

module.exports = { args, run, main };
