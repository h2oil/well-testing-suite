'use strict';
// server/site/isolation.js — preview isolation and production fail-safes (docs/ACCOUNTS-PLAN.md §13.1, T10, D19; WP-OPS).
//
// staging (the disposable test backend, core/config.js) follows the production rules with the test key ids (≥ 9000).
// Production secrets live only in the production functions site. A preview (or local / test) deployment gets its own empty
// database with synthetic data, its own keys, no mail credential and no provider secrets, and sign-in only when
// WTS_PREVIEW_SIGNIN=1. Because a value cannot be recognised as "the production one", the separation is made checkable by
// two conventions the owner follows when creating secrets (server/RUNBOOK.md, "Environments"):
//   • key ids: production master-key, code-pepper and backup public-key kids are 1–8999; every other environment uses kids
//     9000–999999 (ops/keygen.js: 1 for production, 9001 with --preview). Production and staging check all three, so the
//     test backend can never seal its weekly export to the production recovery key (or the reverse).
//   • database names: the production database name never contains preview / test / drill / scratch; a preview database
//     name ends in "_preview".
//
//   checkIsolation(config, env) → {ok, env, signinAllowed, problems:[text], warnings:[text]}
//     production + NETLIFY_DB_URL as the request database → the standing ONE_LOGIN_WARNING (logged as a "config:" line):
//     the platform's single login is administrator-equivalent and cannot be refused by name like the credentials below.
//     ok:false → the adapter (site/handler.js) serves nothing but /health (503 paused elsewhere) and logs "alert:" lines.
//   kidsOf(raw)  → [kid] from a "kid:base64,…" list (values never returned)
//   dbNameOf(url) → the database name of a connection URL ('' when none)

const PREVIEW_KID_MIN = 9000;

function kidsOf(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => Number((/^(\d{1,6}):/.exec(s) || [])[1])).filter((n) => isFinite(n));
}
function dbNameOf(url) {
  if (!url) return '';
  try { const u = new URL(String(url)); return decodeURIComponent(u.pathname.replace(/^\//, '')); } catch (e) { return ''; }
}
const NON_PROD_DB = /(preview|test|drill|scratch)/i;
const OFF_SITE_CREDENTIALS = [
  { name: 'WTS_DRILL_ADMIN_URL', text: 'a restore-drill credential' },
  { name: 'WTS_MIGRATE_DB_URL', text: 'the migration (administrator) credential' },
  { name: 'WTS_SUPPORT_DB_URL', text: 'the support credential' },
  { name: 'WTS_BACKUP_DB_URL', text: 'the backup (export) database credential' },
  { name: 'WTS_BACKUP_KEY', text: 'the weekly export key' },
  { name: 'WTS_BACKUP_PRIVATE_KEY', text: 'the private key that opens the weekly exports' },
  { name: 'WTS_EXPORT_CREDENTIAL', text: 'the export storage credential' },
];

const ONE_LOGIN_WARNING = 'one-login database: this site holds the database owner credential (NETLIFY_DB_URL, BYPASSRLS — the '
  + 'same value as the migration credential); role separation and the read-only export role are not enforced by credentials '
  + 'here (plan B.4); set a dedicated WTS_DB_URL / WTS_JOBS_DB_URL if the platform allows it';

function checkIsolation(config, env) {
  env = env || process.env;
  const problems = []; const warnings = [];
  const mode = config.env;                                 // production | staging | preview | local | test (config.js fails closed)
  const masterKids = kidsOf(env.WTS_MASTER_KEYS);
  const pepperKids = kidsOf(env.WTS_CODE_PEPPERS);
  const backupKids = kidsOf(env.WTS_BACKUP_PUBLIC_KEY);
  const db = dbNameOf(env.WTS_DB_URL);
  const previewFlag = String(env.WTS_PREVIEW_SIGNIN || '').trim() === '1';
  let signinAllowed = true;

  if (mode === 'production' || mode === 'staging') {
    // staging (the disposable test backend) keeps every production rule below except the key ids, which are the TEST ids
    // there — production refuses them, so keys never cross between the two (and the database-name rule is production's own)
    const where = mode === 'staging' ? 'staging' : 'production';
    if (mode === 'production') {
      if (masterKids.some((k) => k >= PREVIEW_KID_MIN)) problems.push('a master key with a non-production kid (≥ 9000) is loaded in production');
      if (pepperKids.some((k) => k >= PREVIEW_KID_MIN)) problems.push('a code pepper with a non-production kid (≥ 9000) is loaded in production');
      if (backupKids.some((k) => k >= PREVIEW_KID_MIN)) problems.push('WTS_BACKUP_PUBLIC_KEY has a non-production kid (≥ 9000) in production — the weekly export would be sealed to a test key');
      if (db && NON_PROD_DB.test(db)) problems.push('the production database name looks like a preview / test / drill database');
    } else {
      if (masterKids.some((k) => k < PREVIEW_KID_MIN)) problems.push('staging: a master key with a production kid (< 9000) is loaded — use a test key (kid ≥ 9000, ops/keygen.js --preview)');
      if (pepperKids.some((k) => k < PREVIEW_KID_MIN)) problems.push('staging: a code pepper with a production kid (< 9000) is loaded');
      if (env.WTS_MASTER_KID && Number(env.WTS_MASTER_KID) < PREVIEW_KID_MIN) problems.push('staging: WTS_MASTER_KID is a production kid (< 9000)');
      if (backupKids.some((k) => k < PREVIEW_KID_MIN)) problems.push('staging: WTS_BACKUP_PUBLIC_KEY has a production kid (< 9000) — the test export would be sealed to the production recovery key; use the test key (ops/keygen.js --preview)');
    }
    if (previewFlag) problems.push('WTS_PREVIEW_SIGNIN is set in ' + where);
    // credentials D12 / §13.3 keep off the functions site (operations scripts, jobs host or the release workflow only)
    OFF_SITE_CREDENTIALS.forEach((c) => { if (env[c.name]) problems.push(c.text + ' (' + c.name + ') is present in the ' + where + ' functions environment'); });
    // one-login hosting: the platform's database login is the database OWNER (BYPASSRLS) — the same value as the migration
    // credential. It cannot be refused by name, so it is a standing warning instead of a silent pass (plan B.4 item 1)
    if (env.NETLIFY_DB_URL && (!env.WTS_DB_URL || env.WTS_DB_URL === env.NETLIFY_DB_URL)) {
      warnings.push(ONE_LOGIN_WARNING);
    }
  } else {
    if (masterKids.some((k) => k < PREVIEW_KID_MIN)) problems.push(mode + ': a master key with a production kid (< 9000) is loaded — use a ' + mode + ' key (kid ≥ 9000)');
    if (pepperKids.some((k) => k < PREVIEW_KID_MIN)) problems.push(mode + ': a code pepper with a production kid (< 9000) is loaded');
    ['OAUTH_GOOGLE_CLIENT_SECRET', 'OAUTH_LINKEDIN_CLIENT_SECRET'].forEach((n) => {
      if (env[n] && mode === 'preview') problems.push('preview: ' + n + ' is set — previews never get provider secrets');
    });
    if (mode === 'preview') {
      if (db && !/_preview$/.test(db)) problems.push('preview: the database name must end in "_preview"');
      signinAllowed = previewFlag;
      if (env.WTS_MAIL_CREDENTIAL && !previewFlag) problems.push('preview: a mail credential without WTS_PREVIEW_SIGNIN=1');
      if (!previewFlag) warnings.push('preview: sign-in disabled (WTS_PREVIEW_SIGNIN is not 1)');
    }
  }
  return { ok: problems.length === 0, env: mode, signinAllowed, problems, warnings };
}

module.exports = { checkIsolation, kidsOf, dbNameOf, PREVIEW_KID_MIN, OFF_SITE_CREDENTIALS, ONE_LOGIN_WARNING };
