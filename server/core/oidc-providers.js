'use strict';
// server/core/oidc-providers.js — the two identity-provider configurations (docs/ACCOUNTS-PLAN.md §4.11, §4.15, D22).
// The ONLY file in the repository with provider addresses. Production values are pinned here; nothing in the environment can
// replace them on the production host (config.js refuses every provider when checkPins() reports a problem or when
// WTS_OIDC_MODE is set there). Test and local runs pass their own endpoints through `resolve(p, {override})`, which is refused
// on the production host.
//
// Status: the Google values are the documented ones. LinkedIn is pinned since release 4.2 (owner decision 2026-11-10, "enable
// linkedin login"), each WP0 item resolved conservatively instead of by the live tests of §13.10 item 13:
//   • issuer — LinkedIn's OpenID discovery document (https://www.linkedin.com/oauth/.well-known/openid-configuration, fetched
//     2026-11-10) states issuer "https://www.linkedin.com/oauth", jwks_uri https://www.linkedin.com/oauth/openid/jwks, RS256,
//     response_types code, scopes openid profile email, subject_types pairwise, and the authorization / token endpoints below.
//   • pkce 'sent' — PKCE (S256) is sent on every attempt but not relied on; the residual (a stolen code redeemed without the
//     verifier) is accepted as T23 / Q32: the code is bound by the state cookie, the confidential client secret and the fixed
//     redirect URI.
//   • nonce 'when-returned' — verified (constant time) whenever LinkedIn returns it; the state cookie and the code exchange
//     still bind the flow when it does not.
//   • freshLogin null — no forced-login parameter is relied on: a fresh-login attempt (public-computer tick or a shared
//     browser) is refused at start with reauth_stale and the client hides the LinkedIn button while the tick is set; a step-up
//     never uses a provider sign-in (stepup_at is set only by an e-mail code, functions/oauth.js).
// The owner's first live LinkedIn sign-in after the deploy is the check (RUNBOOK §3P item 7).

const PROVIDERS = ['google', 'linkedin'];

const CONFIG = {
  google: {
    authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    scopes: ['openid', 'email'],
    pkce: 'required',                 // S256 with the client secret; a mismatch fails
    nonce: 'required',
    callbackIss: true,                // `iss` arrives on the callback and must equal the issuer
    prompt: 'select_account',
    freshLogin: { prompt: 'login', max_age: '0' },
    trustEmailVerified: true,         // only for a Google-managed address (consumer domain or matching hd)
    consumerDomains: ['gmail.com'],
    pairwiseSubject: false,
    errorMap: { access_denied: 'cancelled' },
    pending: [],
  },
  linkedin: {
    authorization: 'https://www.linkedin.com/oauth/v2/authorization',
    token: 'https://www.linkedin.com/oauth/v2/accessToken',
    jwks: 'https://www.linkedin.com/oauth/openid/jwks',
    issuers: ['https://www.linkedin.com/oauth'],   // the discovery document's issuer (fetched 2026-11-10)
    scopes: ['openid', 'profile', 'email'],
    pkce: 'sent',                     // sent, not relied on: the T23 residual accepted (Q32)
    nonce: 'when-returned',           // checked whenever it comes back
    callbackIss: false,
    prompt: null,
    freshLogin: null,                 // not offered on a fresh-login attempt (reauth_stale); step-up uses the e-mail code
    trustEmailVerified: false,        // always our e-mail code (Q27)
    consumerDomains: [],
    pairwiseSubject: true,
    errorMap: { user_cancelled_login: 'cancelled', user_cancelled_authorize: 'cancelled' },
    pending: [],                      // resolved 2026-11-10 (see the header)
  },
};
const KNOWN_ERRORS = ['access_denied', 'user_cancelled_login', 'user_cancelled_authorize', 'invalid_request', 'unauthorized_client',
  'unsupported_response_type', 'invalid_scope', 'server_error', 'temporarily_unavailable', 'interaction_required', 'login_required',
  'consent_required', 'account_selection_required'];

function isHttps(u) { return typeof u === 'string' && /^https:\/\/[a-z0-9.-]+(\/[^\s]*)?$/.test(u); }
// Every production address https and present; issuers https or the documented bare form of Google's issuer.
// `candidate` (tests only) checks another configuration object of the same form instead of the pins.
function checkPins(candidate) {
  const errs = [];
  const all = candidate || CONFIG;
  PROVIDERS.forEach((p) => {
    const c = all[p];
    if (!c) { errs.push(p + ' has no configuration'); return; }
    ['authorization', 'token', 'jwks'].forEach((k) => { if (!isHttps(c[k])) errs.push(p + '.' + k + ' is not a pinned https address'); });
    c.issuers.forEach((i) => { if (!(isHttps(i) || /^[a-z0-9.-]+\.[a-z]{2,}$/.test(i))) errs.push(p + '.issuer ' + i + ' is not acceptable'); });
    if (/localhost|127\.0\.0\.1|\.test(\/|$)/.test(JSON.stringify(c))) errs.push(p + ' names a local or test host');
  });
  return errs;
}
function pinned(p) { const c = CONFIG[p]; return !!c && c.pending.length === 0 && c.issuers.length > 0; }
// The configuration to use: production → the pins; elsewhere an override (fake or development provider) may replace the
// endpoints and issuers. Returns a fresh object.
function resolve(p, opts) {
  opts = opts || {};
  const c = CONFIG[p];
  if (!c) return null;
  const out = JSON.parse(JSON.stringify(c));
  if (opts.override) {
    if (opts.production) throw new Error('oidc-providers: overrides are refused on the production host');
    Object.assign(out, opts.override);
  }
  out.provider = p;
  return out;
}
// A provider `error` on the callback → the fixed reason enum (§4.10 item 4). Unknown codes are only ever logged as 'unknown'.
function mapError(p, code) {
  const c = CONFIG[p];
  if (c && c.errorMap[code]) return c.errorMap[code];
  return 'provider';
}
function isKnownError(code) { return KNOWN_ERRORS.indexOf(code) !== -1 || PROVIDERS.some((p) => !!CONFIG[p].errorMap[code]); }

module.exports = { PROVIDERS, CONFIG, checkPins, pinned, resolve, mapError, isKnownError };
