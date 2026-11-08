'use strict';
// server/site/isolation.js — preview isolation and production fail-safes (docs/ACCOUNTS-PLAN.md §13.1, T10, D19; WP-OPS).
//
// Production secrets live only in the production functions site. A preview (or local / test) deployment gets its own empty
// database with synthetic data, its own keys, no mail credential and no provider secrets, and sign-in only when
// WTS_PREVIEW_SIGNIN=1. Because a value cannot be recognised as "the production one", the separation is made checkable by
// two conventions the owner follows when creating secrets (server/RUNBOOK.md, "Environments"):
//   • key ids: production master-key and code-pepper kids are 1–8999; every other environment uses kids 9000–999999.
//   • database names: the production database name never contains preview / test / drill / scratch; a preview database
//     name ends in "_preview".
//
//   checkIsolation(config, env) → {ok, env, signinAllowed, problems:[text], warnings:[text]}
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

function checkIsolation(config, env) {
  env = env || process.env;
  const problems = []; const warnings = [];
  const mode = config.env;                                 // production | preview | local | test (config.js fails closed)
  const masterKids = kidsOf(env.WTS_MASTER_KEYS);
  const pepperKids = kidsOf(env.WTS_CODE_PEPPERS);
  const db = dbNameOf(env.WTS_DB_URL);
  const previewFlag = String(env.WTS_PREVIEW_SIGNIN || '').trim() === '1';
  let signinAllowed = true;

  if (mode === 'production') {
    if (masterKids.some((k) => k >= PREVIEW_KID_MIN)) problems.push('a master key with a non-production kid (≥ 9000) is loaded in production');
    if (pepperKids.some((k) => k >= PREVIEW_KID_MIN)) problems.push('a code pepper with a non-production kid (≥ 9000) is loaded in production');
    if (db && NON_PROD_DB.test(db)) problems.push('the production database name looks like a preview / test / drill database');
    if (previewFlag) problems.push('WTS_PREVIEW_SIGNIN is set in production');
    if (env.WTS_DRILL_ADMIN_URL) problems.push('a restore-drill credential is present in the production functions environment');
    if (env.WTS_MIGRATE_DB_URL) problems.push('the migration (administrator) credential is present in the production functions environment');
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

module.exports = { checkIsolation, kidsOf, dbNameOf, PREVIEW_KID_MIN };
