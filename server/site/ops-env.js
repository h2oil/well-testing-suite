'use strict';
// server/site/ops-env.js — names of the environment variables used by the functions-only site adapter and the operations
// scripts (docs/ACCOUNTS-PLAN.md §13.2–13.6; WP-OPS), beside the request handlers' own names in core/config.js. Values are
// NEVER in the repository: the owner sets them in the host's environment (functions site) or as repository secrets of the
// tagged release workflow. prism-build/publish-site.js --check and server/ci/secret-scan.js refuse any published file that
// names a secret variable.

const OPS_SECRET_ENV = [
  'WTS_SUPPORT_DB_URL',      // wts_support credential (server/ops support scripts)
  'WTS_MIGRATE_DB_URL',      // database administrator (the manual tagged migration job only)
  'WTS_BACKUP_KEY',          // weekly export encryption key(s) "kid:base64,…" — separate from the master keys (§13.5)
  'WTS_BACKUP_PRIVATE_KEY',  // "kid:base64" X25519 private key that opens the exports the functions site writes (offline + drill only)
  'WTS_BACKUP_DB_URL',       // read-only credential for the weekly logical export
  'WTS_OBJECTS_CREDENTIAL',  // the blob store credential (when the host's store needs one)
  'WTS_EXPORT_CREDENTIAL',   // the separate export storage (another region, §13.5)
  'WTS_ALERT_WEBHOOK',       // owner alert hook (an https URL with its own token)
  'WTS_MAIL_API_URL',        // the e-mail service endpoint (may carry an account path; kept with the credential)
  'WTS_OUTBOX_KEY',          // reserved name of §13.2 (the per-user outbox key itself is stored wrapped in the database)
  'WTS_DEPLOY_TOKEN',        // release workflow: the functions-site deploy credential (repository secret)
];
const OPS_CONFIG_ENV = [
  'WTS_EXPORT_DIR',          // weekly export target folder (a mounted, separate store) — non-secret
  'WTS_BACKUP_PUBLIC_KEY',   // "kid:base64" X25519 public key the functions site seals the weekly export to (not secret)
  'WTS_BLOBS_SITE_ID',       // operations scripts outside the site: the functions site's id for the blob store (not secret)
  'WTS_BLOBS_STORE',         // the blob store name (default wts-objects)
  'WTS_OBJECTS_DIR',         // filesystem blob store for local runs and restore drills
  'WTS_OBJECTS_BINDING',     // the host blob-store binding module (a .js path inside server/; default site/objects-binding.js)
  'WTS_EXPORT_RETAIN_DAYS',  // 28 by default (§13.5)
  'WTS_PG_BIN',              // folder of the database engine's dump / restore tools (export and drill)
  'WTS_DRILL_ADMIN_URL',     // restore drill: administrator of an ISOLATED scratch cluster (never production)
  'WTS_ALERT_EMAIL',         // the owner's alert address (alerts are also log lines starting "alert:")
  'WTS_DEPLOY_SITE',         // release workflow: the functions site id (repository variable)
  'WTS_DEPLOY_COMMAND',      // release workflow: the host CLI deploy command (repository variable)
  'WTS_PREVIEW_SIGNIN',      // preview only: 1 allows sign-in on a preview deployment (synthetic database only)
];

module.exports = { OPS_SECRET_ENV, OPS_CONFIG_ENV };
