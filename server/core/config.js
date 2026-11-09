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
// WTS_ENV=production|preview|local|test — missing or unknown = production (fail closed). WTS_PROXY_SIG may list two values
// (current,previous) during a rotation.
// Kill switches (§13.6): ACCOUNTS_SIGNUP=open|invite|off · SYNC_MODE=on|readonly|off · ACCOUNTS_OFF=1 ·
// OAUTH_GOOGLE=on|signin|off · OAUTH_LINKEDIN=on|signin|off (both off unless set AND the client id and secret are configured).

const providersPins = require('./oidc-providers');

const PROD_HOST = 'welltest.h2oil.co.uk';
const PROD_ORIGIN = 'https://' + PROD_HOST;

const SWITCHES = {
  ACCOUNTS_SIGNUP: ['open', 'invite', 'off'],
  SYNC_MODE: ['on', 'readonly', 'off'],
  ACCOUNTS_OFF: ['0', '1'],
  OAUTH_GOOGLE: ['on', 'signin', 'off'],
  OAUTH_LINKEDIN: ['on', 'signin', 'off'],
};
const SECRET_ENV = [
  'WTS_DB_URL', 'WTS_JOBS_DB_URL', 'WTS_MASTER_KEYS', 'WTS_INDEX_PEPPER', 'WTS_CODE_PEPPERS', 'WTS_SESSION_PEPPER',
  'WTS_PROXY_SIG', 'WTS_OPS_HMAC', 'WTS_MAIL_CREDENTIAL', 'OAUTH_GOOGLE_CLIENT_SECRET', 'OAUTH_LINKEDIN_CLIENT_SECRET',
];
const CONFIG_ENV = [
  'WTS_ENV', 'WTS_OIDC_MODE', 'WTS_MASTER_KID', 'WTS_APP_PATH', 'WTS_DEV_ORIGIN', 'WTS_DEV_PORT', 'WTS_CLIENT_IP_HEADER',
  'WTS_HOST_HEADER', 'WTS_MAIL_FROM', 'WTS_CODE_FLOOR_MS', 'WTS_TERMS_VERSION', 'WTS_PRIVACY_VERSION', 'WTS_MIN_CLIENT', 'WTS_VERSION',
  'OAUTH_GOOGLE_CLIENT_ID', 'OAUTH_LINKEDIN_CLIENT_ID',
].concat(Object.keys(SWITCHES));
const ENVS = ['production', 'preview', 'local', 'test'];

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

function loadConfig(env) {
  env = env || process.env;
  const warnings = [];
  const alerts = [];
  // Fail closed: a missing or unknown WTS_ENV is production (proxy signature required, production Host only, alerts on).
  // dev.js and the tests always pass WTS_ENV explicitly.
  let wtsEnv = String(env.WTS_ENV == null ? '' : env.WTS_ENV).trim().toLowerCase();
  if (!wtsEnv) { warnings.push('WTS_ENV: not set — treated as production'); wtsEnv = 'production'; }
  else if (ENVS.indexOf(wtsEnv) === -1) { warnings.push('WTS_ENV: unknown value — treated as production'); wtsEnv = 'production'; }
  const production = wtsEnv === 'production';

  const signup = pick(env, 'ACCOUNTS_SIGNUP', SWITCHES.ACCOUNTS_SIGNUP, 'invite', warnings);
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
  const hostHeader = env.WTS_HOST_HEADER ? String(env.WTS_HOST_HEADER).trim().toLowerCase() : '';
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
    mailCredential: env.WTS_MAIL_CREDENTIAL || '',
  };
  if (production && !secrets.proxySigs.length) alerts.push('WTS_PROXY_SIG missing on the production host — every request answers 404');
  // behind the static site's rewrite the socket address is the proxy's: without the header every user would share one
  // client-address bucket (provider sign-in is refused then, see functions/oauth.js noPrefix)
  if (production && !ipHeader) alerts.push('WTS_CLIENT_IP_HEADER missing on the production host — provider sign-in is refused and per-range limits cannot work');

  const cfg = {
    env: wtsEnv, production, prodHost: PROD_HOST, prodOrigin: PROD_ORIGIN, devOrigin,
    allowedOrigins: devOrigin ? [PROD_ORIGIN, devOrigin] : [PROD_ORIGIN],
    appUrl: appOrigin + appPath, appPath,
    signup, syncMode, accountsOff, oidcMode: production ? '' : oidcMode,
    providers: Object.freeze(providers),
    providerSwitches() { const o = {}; Object.keys(providers).forEach((p) => { o[p] = providers[p].effective; }); return o; },
    ipHeader, hostHeader,
    mailFrom: env.WTS_MAIL_FROM || 'no-reply@h2oil.co.uk',
    terms: String(env.WTS_TERMS_VERSION || '1'), privacy: String(env.WTS_PRIVACY_VERSION || '1'),
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

module.exports = { loadConfig, loadJobsConfig, SWITCHES, SECRET_ENV, CONFIG_ENV, PROD_HOST, PROD_ORIGIN, isLocalOrigin };
