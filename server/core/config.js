'use strict';
// server/core/config.js — the server configuration, read ONLY from environment variables (docs/ACCOUNTS-PLAN.md §13.3,
// §13.6, D19). Nothing is read from files, the repository or the static bundle. Every switch fails closed: an unknown value
// turns the feature off and adds a warning. Secrets are kept out of every log line (`redacted()`).
//
//   loadConfig(env = process.env) → frozen config (request handlers). The jobs database credential is NOT read here.
//   loadJobsConfig(env)           → the same plus `jobsDbUrl` (the scheduled function only, D12).
//   SWITCHES                      the kill-switch names and their allowed values
//   SECRET_ENV                    names of every secret variable (the publish check of §13.2 refuses a bundle that names them)
//   CONFIG_ENV                    names of the non-secret variables
//
// WTS_ENV=production|staging|preview|local|test — missing or unknown = production (fail closed). WTS_PROXY_SIG may list two
// values (current,previous) during a rotation.
// staging = a disposable TEST BACKEND deployed like production (server/RUNBOOK.md "Test backend"): `production` is TRUE there,
// so every security rule of production applies unchanged (proxy signature, production host and origin only, cookies, no
// development origin, no provider overrides, pins, the 400 ms code floor, the client-address header, ephemeral keys never
// used). The differences are only what makes it a test site: `staging` true, site/isolation.js requires the test key ids
// (≥ 9000 — which production refuses, so its keys can never be loaded by production nor production's by it) and skips the
// production-only database-name check. ACCOUNTS_SIGNUP=open is the test site's setting, not a default. Nothing in staging
// relaxes a rule: a value that is not exactly "staging" is production.
// Kill switches (§13.6): ACCOUNTS_SIGNUP=open|invite|off · SYNC_MODE=on|readonly|off · ACCOUNTS_OFF=1 ·
// OAUTH_GOOGLE=on|signin|off · OAUTH_LINKEDIN=on|signin|off (both off unless set AND the client id and secret are configured).
// WTS_SITE_MODE=separate|same (missing or unknown = separate, which needs the proxy signature — fail closed):
//   separate  the functions run on their own site behind the main site's proxy rule: X-WTS-Proxy-Sig is required and the
//             original host comes from the trusted forwarding header WTS_HOST_HEADER (core/http.js proxyOk / originalHost).
//   same      the functions run ON the live site itself (welltest.h2oil.co.uk/api/v1/*; server/RUNBOOK.md "Live site
//             (same-site) setup"): there is no proxy, so no signature is checked and WTS_PROXY_SIG / WTS_HOST_HEADER are
//             ignored (a warning when set); the Host header itself must be EXACTLY the production host in every WTS_ENV (no
//             loopback, no platform address, no forwarding header) — same mode cannot run without it; the client address
//             comes ONLY from the platform's own header x-nf-client-connection-ip (any other WTS_CLIENT_IP_HEADER is ignored).
//             Origin / X-WTS-Req / Content-Type, the cookies and every other rule are exactly those of separate mode.
//             Same mode REFUSES (throws) unless WTS_ENV is production or staging: local / test / preview would turn on the
//             development options with only the Host rule in front of them (the tests: allowSameSiteInTests(), WTS_ENV=test).
// WTS_INVITE_BOOTSTRAP=<address>[,<address> …] — with ACCOUNTS_SIGNUP=invite these addresses may create an account as if
//   they were on the database allow-list (the owner's first sign-in without a direct database connection; RUNBOOK "Live site
//   (same-site) setup"). Read at run time, normalised like every address; an invalid entry is ignored with a warning; not a
//   secret, but personal data: set it in the site's environment only, never in the repository.
// WTS_ADMIN_EMAILS=<address>[,<address> …] — the accounts that may use the admin routes (functions/admin.js; the app's Account
//   page → Admin, route #admin). Unset = the WTS_INVITE_BOOTSTRAP addresses. Compared after normalisation (case-insensitive);
//   an invalid entry is ignored with a warning. Not a secret; personal data like the bootstrap list (site environment only).
// WTS_GEO_HEADERS=1 — TESTS ONLY (accepted only with WTS_ENV=test): read the platform's geolocation headers outside same-site
//   mode. Same-site mode always reads them (the platform's edge sets them; core/http.js clientGeo validates every value).

const providersPins = require('./oidc-providers');

const PROD_HOST = 'welltest.h2oil.co.uk';
const PROD_ORIGIN = 'https://' + PROD_HOST;
// same-site mode: the ONLY client-address header (the platform's edge sets it; a client cannot)
const SAME_SITE_IP_HEADER = 'x-nf-client-connection-ip';
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

const SWITCHES = {
  ACCOUNTS_SIGNUP: ['open', 'invite', 'off'],
  SYNC_MODE: ['on', 'readonly', 'off'],
  ACCOUNTS_OFF: ['0', '1'],
  OAUTH_GOOGLE: ['on', 'signin', 'off'],
  OAUTH_LINKEDIN: ['on', 'signin', 'off'],
};
// the last value is the fail-closed one (pick() falls back to it): separate mode requires the proxy signature
const SITE_MODES = ['same', 'separate'];
const SECRET_ENV = [
  'WTS_DB_URL', 'WTS_JOBS_DB_URL', 'WTS_MASTER_KEYS', 'WTS_INDEX_PEPPER', 'WTS_CODE_PEPPERS', 'WTS_SESSION_PEPPER',
  'WTS_PROXY_SIG', 'WTS_OPS_HMAC', 'WTS_MAIL_CREDENTIAL', 'WTS_MAIL_KEY', 'OAUTH_GOOGLE_CLIENT_SECRET', 'OAUTH_LINKEDIN_CLIENT_SECRET',
];
const CONFIG_ENV = [
  'WTS_ENV', 'WTS_OIDC_MODE', 'WTS_MASTER_KID', 'WTS_APP_PATH', 'WTS_DEV_ORIGIN', 'WTS_DEV_PORT', 'WTS_CLIENT_IP_HEADER',
  'WTS_HOST_HEADER', 'WTS_DB_ROLE', 'WTS_MAIL_FROM', 'WTS_MAIL_PROVIDER', 'WTS_CODE_FLOOR_MS', 'WTS_TERMS_VERSION', 'WTS_PRIVACY_VERSION', 'WTS_MIN_CLIENT', 'WTS_VERSION',
  'WTS_SITE_MODE', 'WTS_INVITE_BOOTSTRAP', 'WTS_ADMIN_EMAILS', 'WTS_GEO_HEADERS', 'OAUTH_GOOGLE_CLIENT_ID', 'OAUTH_LINKEDIN_CLIENT_ID',
].concat(Object.keys(SWITCHES));
const ENVS = ['production', 'staging', 'preview', 'local', 'test'];

function pick(env, name, allowed, def, warn) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const v = String(raw).trim().toLowerCase();
  if (allowed.indexOf(v) !== -1) return v;
  warn.push(name + ': unknown value — treated as ' + allowed[allowed.length - 1]);
  return allowed[allowed.length - 1];           // the last allowed value is always the "off" one
}
function truthy(v) { return /^(1|true|on|yes)$/i.test(String(v == null ? '' : v).trim()); }
// "kid:base64,kid:base64" → [{kid, key:Buffer}] (keys of 32 bytes only)
function parseKeyList(raw, name, warn) {
  if (!raw) return [];
  const out = [];
  String(raw).split(',').map((s) => s.trim()).filter(Boolean).forEach((item) => {
    const m = /^(\d{1,6}):([A-Za-z0-9+/=_-]+)$/.exec(item);
    const key = m ? Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64') : null;
    if (!m || key.length !== 32) { warn.push(name + ': an entry is not "kid:<32-byte base64>" — ignored'); return; }
    out.push({ kid: Number(m[1]), key });
  });
  return out;
}
function oneKey(raw, name, warn) {
  if (!raw) return null;
  const key = Buffer.from(String(raw).trim(), 'base64');
  if (key.length < 32) { warn.push(name + ': shorter than 32 bytes — ignored'); return null; }
  return key;
}
function isLocalOrigin(o) { return /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(o || ''); }

// test-only escape hatch for same-site mode with WTS_ENV=test (server/test/*; nothing in the deployed code calls it)
let sameSiteTestHatch = false;
function allowSameSiteInTests(on) { sameSiteTestHatch = on !== false; }

function loadConfig(env) {
  env = env || process.env;
  const warnings = [];
  const alerts = [];
  // Fail closed: a missing or unknown WTS_ENV is production (proxy signature required, production Host only, alerts on).
  // dev.js and the tests always pass WTS_ENV explicitly.
  let wtsEnv = String(env.WTS_ENV == null ? '' : env.WTS_ENV).trim().toLowerCase();
  if (!wtsEnv) { warnings.push('WTS_ENV: not set — treated as production'); wtsEnv = 'production'; }
  else if (ENVS.indexOf(wtsEnv) === -1) { warnings.push('WTS_ENV: unknown value — treated as production'); wtsEnv = 'production'; }
  // staging is production for every security rule (see the header); only `staging` and the isolation key rule tell them apart
  const staging = wtsEnv === 'staging';
  const production = wtsEnv === 'production' || staging;

  const signup = pick(env, 'ACCOUNTS_SIGNUP', SWITCHES.ACCOUNTS_SIGNUP, 'invite', warnings);
  const siteMode = pick(env, 'WTS_SITE_MODE', SITE_MODES, 'separate', warnings);
  const sameSite = siteMode === 'same';
  // same mode is never combined with a missing production host: the host check is the only thing standing in for the
  // proxy signature, so a missing or malformed production host stops the configuration outright
  if (sameSite && !HOSTNAME_RE.test(PROD_HOST)) throw new Error('config: WTS_SITE_MODE=same needs the production host');
  // same mode runs only as production or staging: without the proxy signature, a wrong WTS_ENV (local / test / preview) on the
  // live host would leave the Host rule as the only guard in front of the development options (WTS_OIDC_MODE, a development
  // origin). The tests use WTS_ENV=test through allowSameSiteInTests() — a module flag, never an environment variable.
  if (sameSite && !production && !(wtsEnv === 'test' && sameSiteTestHatch)) {
    throw new Error('config: WTS_SITE_MODE=same runs only with WTS_ENV=production or staging (WTS_ENV=' + wtsEnv + ')');
  }
  const inviteBootstrap = new Set();
  if (env.WTS_INVITE_BOOTSTRAP) {
    const { normEmail } = require('./validate');
    String(env.WTS_INVITE_BOOTSTRAP).split(/[\s,;]+/).filter(Boolean).forEach((raw) => {
      const e = normEmail(raw);
      if (e) inviteBootstrap.add(e); else warnings.push('WTS_INVITE_BOOTSTRAP: an entry is not an address — ignored');
    });
    if (inviteBootstrap.size && signup !== 'invite') warnings.push('WTS_INVITE_BOOTSTRAP: used only with ACCOUNTS_SIGNUP=invite');
  }
  // admin accounts: WTS_ADMIN_EMAILS, else the bootstrap addresses (a set of normalised addresses)
  const adminEmails = new Set();
  if (env.WTS_ADMIN_EMAILS !== undefined && String(env.WTS_ADMIN_EMAILS).trim() !== '') {
    const { normEmail } = require('./validate');
    String(env.WTS_ADMIN_EMAILS).split(/[\s,;]+/).filter(Boolean).forEach((raw) => {
      const e = normEmail(raw);
      if (e) adminEmails.add(e); else warnings.push('WTS_ADMIN_EMAILS: an entry is not an address — ignored');
    });
  } else inviteBootstrap.forEach((e) => adminEmails.add(e));
  // the platform geolocation headers: same-site mode only (the platform's edge sets them), or the tests' explicit flag
  let geoHeaders = sameSite;
  if (env.WTS_GEO_HEADERS !== undefined && String(env.WTS_GEO_HEADERS).trim() !== '') {
    if (wtsEnv === 'test' && truthy(env.WTS_GEO_HEADERS)) geoHeaders = true;
    else if (!sameSite) warnings.push('WTS_GEO_HEADERS: accepted only with WTS_ENV=test — ignored');
  }
  const syncMode = pick(env, 'SYNC_MODE', SWITCHES.SYNC_MODE, 'on', warnings);
  // ACCOUNTS_OFF fails closed too: unset / '0' / 'false' / 'off' / 'no' = accounts on; '1' / 'true' / 'on' / 'yes' = off;
  // any other non-empty value = off with a warning.
  let accountsOff = false;
  {
    const raw = env.ACCOUNTS_OFF == null ? '' : String(env.ACCOUNTS_OFF).trim().toLowerCase();
    if (raw === '' || /^(0|false|off|no)$/.test(raw)) accountsOff = false;
    else if (truthy(raw)) accountsOff = true;
    else { accountsOff = true; warnings.push('ACCOUNTS_OFF: unknown value — treated as 1 (accounts paused)'); }
  }

  const oidcMode = String(env.WTS_OIDC_MODE || '').trim().toLowerCase();
  const providers = {};
  let pinsOk = true;
  if (production) {
    const pinErr = providersPins.checkPins();
    if (pinErr.length) { pinsOk = false; pinErr.forEach((e) => alerts.push('provider pins: ' + e)); }
    if (oidcMode) { pinsOk = false; alerts.push('WTS_OIDC_MODE is set on the production host — every provider is off'); }
  } else if (oidcMode && oidcMode !== 'dev') {
    warnings.push('WTS_OIDC_MODE: only "dev" is known — ignored');
  }
  providersPins.PROVIDERS.forEach((p) => {
    const NAME = 'OAUTH_' + p.toUpperCase();
    const sw = pick(env, NAME, SWITCHES[NAME], 'off', warnings);
    const clientId = env[NAME + '_CLIENT_ID'] ? String(env[NAME + '_CLIENT_ID']).trim() : '';
    const clientSecret = env[NAME + '_CLIENT_SECRET'] ? String(env[NAME + '_CLIENT_SECRET']) : '';
    let effective = sw;
    if (sw !== 'off' && (!clientId || !clientSecret)) { effective = 'off'; warnings.push(NAME + ': client id or secret missing — off'); }
    if (sw !== 'off' && production && !pinsOk) effective = 'off';
    if (sw !== 'off' && production && !providersPins.pinned(p)) { effective = 'off'; alerts.push(NAME + ': production configuration not pinned yet (WP0) — off'); }
    if (sw !== 'off' && !production && wtsEnv !== 'test' && oidcMode !== 'dev') { effective = 'off'; warnings.push(NAME + ': outside production only with WTS_OIDC_MODE=dev — off'); }
    const entry = { switch: sw, effective, clientId };
    Object.defineProperty(entry, 'clientSecret', { value: clientSecret, enumerable: false });
    providers[p] = Object.freeze(entry);
  });

  let devOrigin = null;
  if (env.WTS_DEV_ORIGIN) {
    if (!production && (wtsEnv === 'local' || wtsEnv === 'test') && isLocalOrigin(String(env.WTS_DEV_ORIGIN).trim())) devOrigin = String(env.WTS_DEV_ORIGIN).trim();
    else warnings.push('WTS_DEV_ORIGIN: accepted only for a localhost origin with WTS_ENV=local|test — ignored');
  }
  let ipHeader = env.WTS_CLIENT_IP_HEADER ? String(env.WTS_CLIENT_IP_HEADER).trim().toLowerCase() : '';
  if (ipHeader === 'x-forwarded-for') { warnings.push('WTS_CLIENT_IP_HEADER: the client-supplied X-Forwarded-For is never trusted — ignored'); ipHeader = ''; }
  if (sameSite) {
    if (ipHeader && ipHeader !== SAME_SITE_IP_HEADER) warnings.push('WTS_CLIENT_IP_HEADER: same-site mode reads only ' + SAME_SITE_IP_HEADER + ' — ignored');
    ipHeader = SAME_SITE_IP_HEADER;
  }
  // one-login hosting (core/db.js): the request role every transaction switches to; only wts_api is accepted
  let dbRole = env.WTS_DB_ROLE ? String(env.WTS_DB_ROLE).trim() : '';
  if (dbRole && dbRole !== 'wts_api') { warnings.push('WTS_DB_ROLE: only wts_api is accepted for request handlers — the database is not used'); dbRole = 'invalid'; }
  let hostHeader = env.WTS_HOST_HEADER ? String(env.WTS_HOST_HEADER).trim().toLowerCase() : '';
  if (sameSite && hostHeader) { warnings.push('WTS_HOST_HEADER: not used in same-site mode (the Host header itself must be the production host) — ignored'); hostHeader = ''; }
  let appPath = String(env.WTS_APP_PATH || '/').trim();
  if (!/^\/[A-Za-z0-9._\/-]*$/.test(appPath) || appPath.indexOf('//') !== -1) { warnings.push('WTS_APP_PATH: not a plain path — "/" used'); appPath = '/'; }
  const appOrigin = production || !devOrigin ? PROD_ORIGIN : devOrigin;

  const secrets = {
    dbUrl: env.WTS_DB_URL || '',
    masterKeys: parseKeyList(env.WTS_MASTER_KEYS, 'WTS_MASTER_KEYS', warnings),
    masterKid: env.WTS_MASTER_KID ? Number(env.WTS_MASTER_KID) : null,
    indexPepper: oneKey(env.WTS_INDEX_PEPPER, 'WTS_INDEX_PEPPER', warnings),
    codePeppers: parseKeyList(env.WTS_CODE_PEPPERS, 'WTS_CODE_PEPPERS', warnings),
    sessionPepper: oneKey(env.WTS_SESSION_PEPPER, 'WTS_SESSION_PEPPER', warnings),
    // comma-separated: the current value first, the previous one still accepted during a rotation (§13.3)
    proxySigs: String(env.WTS_PROXY_SIG || '').split(',').map((v) => v.trim()).filter(Boolean),
    opsHmac: oneKey(env.WTS_OPS_HMAC, 'WTS_OPS_HMAC', warnings),
    mailCredential: env.WTS_MAIL_CREDENTIAL || env.WTS_MAIL_KEY || '',   // WTS_MAIL_KEY = accepted alias (owner set it under that name)
  };
  if (sameSite && secrets.proxySigs.length) warnings.push('WTS_PROXY_SIG: not used in same-site mode (there is no proxy) — ignored; remove it from the site');
  if (production && !sameSite && !secrets.proxySigs.length) alerts.push('WTS_PROXY_SIG missing on the production host — every request answers 404');
  // behind the static site's rewrite the socket address is the proxy's: without the header every user would share one
  // client-address bucket (provider sign-in is refused then, see functions/oauth.js noPrefix)
  if (production && !ipHeader) alerts.push('WTS_CLIENT_IP_HEADER missing on the production host — provider sign-in is refused and per-range limits cannot work');

  const cfg = {
    env: wtsEnv, production, staging, prodHost: PROD_HOST, prodOrigin: PROD_ORIGIN, devOrigin,
    allowedOrigins: devOrigin ? [PROD_ORIGIN, devOrigin] : [PROD_ORIGIN],
    appUrl: appOrigin + appPath, appPath,
    siteMode, sameSite, inviteBootstrap, adminEmails, geoHeaders,
    signup, syncMode, accountsOff, oidcMode: production ? '' : oidcMode,
    providers: Object.freeze(providers),
    providerSwitches() { const o = {}; Object.keys(providers).forEach((p) => { o[p] = providers[p].effective; }); return o; },
    ipHeader, hostHeader, dbRole,
    mailFrom: env.WTS_MAIL_FROM || 'no-reply@h2oil.co.uk',
    terms: String(env.WTS_TERMS_VERSION || '1'), privacy: String(env.WTS_PRIVACY_VERSION || '3'),
    // the security minimum of X-WTS-App (§3.2): unset = no gate; raised only for a security fix, never for a format change
    minClient: String(env.WTS_MIN_CLIENT || ''), version: String(env.WTS_VERSION || 'wp0'),
    devPort: env.WTS_DEV_PORT ? Number(env.WTS_DEV_PORT) : 8787,
    // code/start answers no sooner than this (§3.3: padded to a fixed floor, so response time never tells an address apart)
    codeFloorMs: /^\d{1,5}$/.test(String(env.WTS_CODE_FLOOR_MS || '')) ? Number(env.WTS_CODE_FLOOR_MS) : (production ? 400 : 0),
    warnings, alerts,
  };
  Object.defineProperty(cfg, 'secrets', { value: Object.freeze(secrets), enumerable: false });
  cfg.redacted = function () {
    const o = JSON.parse(JSON.stringify(cfg));
    o.providers = {}; Object.keys(providers).forEach((p) => { o.providers[p] = { switch: providers[p].switch, effective: providers[p].effective, clientId: providers[p].clientId ? '(set)' : '' }; });
    o.inviteBootstrap = inviteBootstrap.size;
    o.adminEmails = adminEmails.size;
    o.secrets = {}; Object.keys(secrets).forEach((k) => { const v = secrets[k]; o.secrets[k] = (Array.isArray(v) ? v.length : v) ? '(set)' : ''; });
    return o;
  };
  return Object.freeze(cfg);
}
function loadJobsConfig(env) {
  env = env || process.env;
  const cfg = loadConfig(env);
  const jobs = Object.assign({}, cfg, { jobsDbUrl: env.WTS_JOBS_DB_URL || '' });
  Object.defineProperty(jobs, 'secrets', { value: cfg.secrets, enumerable: false });
  return Object.freeze(jobs);
}

// with ACCOUNTS_SIGNUP=invite: is this (normalised) address allowed to create an account? WTS_INVITE_BOOTSTRAP first, then
// the database allow-list (bidxCheck: async () → boolean, only called when the address is not a bootstrap one)
async function inviteListed(cfg, email, bidxCheck) {
  if (email && cfg.inviteBootstrap && cfg.inviteBootstrap.has(email)) return true;
  return !!(await bidxCheck());
}

module.exports = { loadConfig, loadJobsConfig, inviteListed, allowSameSiteInTests, SWITCHES, SITE_MODES, SAME_SITE_IP_HEADER, SECRET_ENV, CONFIG_ENV, PROD_HOST, PROD_ORIGIN, isLocalOrigin };
