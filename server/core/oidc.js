'use strict';
// server/core/oidc.js — OpenID Connect for Google and LinkedIn sign-in (docs/ACCOUNTS-PLAN.md D22, §4.10, §4.11, §8.3).
// Pure logic on the runtime's built-in crypto; no dependency. The provider configuration comes ONLY from
// core/oidc-providers.js (production pins; test / dev overrides are refused on the production host there).
//
//   randomToken(bytes)                       → base64url text of `bytes` random bytes
//   pkce()                                   → {verifier (64 chars), challenge (S256)}
//   sha256(text|Buffer)                      → Buffer
//   redirectUri(config, provider)            → the fixed callback address (production: the production origin)
//   authorizationUrl(cfg, {clientId, redirectUri, state, nonce, challenge, fresh})
//                                            → the provider's authorization URL; throws OidcError('reauth_stale') when a
//                                              fresh-login attempt asks a provider that cannot force one (§4.11)
//   mapCallbackError(provider, code)         → {reason:'cancelled'|'provider', logged:'<known code>'|'unknown'}
//                                              (error_description is never read)
//   exchangeCode(cfg, {code, verifier, clientId, clientSecret, redirectUri, fetch, timeoutMs})
//                                            → {ok:true, idToken} | {ok:false, reason:'provider'|'token', providerFailure}
//                                              The access token (and any refresh token) is dropped here.
//   createKeyCache({fetch, now, store, log, refetchMs}) → {getKey(cfg, kid) → {key|null, providerFailure}, clear()}
//                                              memory + the `oidc_keys` store (definer functions); an unknown kid causes
//                                              at most ONE JWKS fetch per provider per 5 minutes (§4.11): in memory per
//                                              instance, and across instances through store.claimFetch(provider) (a
//                                              5-minute window in the database) when the store has it
//   verifyIdToken(token, {cfg, clientId, nonce, freshLogin, attemptCreatedAt, now, getKey})
//                                            → {ok:true, claims:{iss, sub, email, emailVerified, hd, authTime}}
//                                            | {ok:false, reason:'token'|'reauth_stale', providerFailure?}
//   emailTrusted(cfg, claims)                → true only when the provider vouches for AND manages the address (§4.11)
//   BREAKER, breakerDecision(window)          the provider-side breaker policy (§8.3) over {total, bad} counts
//   memoryBreaker({now})                      an in-process breaker (tests and the fake server); the server uses the
//                                              database form in core/oauth-store.js
// Nothing here logs a code, state, token, claim or provider error description.

const crypto = require('crypto');
const PINS = require('./oidc-providers');
const { normEmail, domainOf } = require('./validate');
const { BASE } = require('./contract');

const MIN = 60 * 1000;
const SKEW_S = 60;
const IAT_MAX_AGE_S = 600;
const REFETCH_MS = 5 * MIN;
const MAX_TOKEN_BYTES = 16 * 1024;

class OidcError extends Error { constructor(reason) { super(reason); this.reason = reason; } }

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function fromB64u(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new OidcError('token');
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function randomToken(bytes) { return b64u(crypto.randomBytes(bytes || 32)); }
function sha256(v) { return crypto.createHash('sha256').update(v).digest(); }
function pkce() {
  const verifier = randomToken(48);                       // 64 characters of [A-Za-z0-9_-] (RFC 7636: 43–128)
  return { verifier, challenge: b64u(sha256(verifier)) };
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a)); const y = Buffer.from(String(b == null ? '' : b));
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}

// The fixed callback address (§4.10 item 6): production always the production origin; a local / test run may use the
// localhost development origin (WTS_DEV_ORIGIN), which config.js accepts only outside production.
function redirectUri(config, provider) {
  const origin = config.production || !config.devOrigin ? config.prodOrigin : config.devOrigin;
  return origin + BASE + '/auth/oauth/' + provider + '/callback';
}

function authorizationUrl(cfg, o) {
  if (o.fresh && !cfg.freshLogin) throw new OidcError('reauth_stale');
  const q = new URLSearchParams();
  q.set('response_type', 'code');
  q.set('client_id', o.clientId);
  q.set('redirect_uri', o.redirectUri);
  q.set('scope', cfg.scopes.join(' '));
  q.set('state', o.state);
  q.set('nonce', o.nonce);                                 // always sent (LinkedIn: required when returned)
  q.set('code_challenge', o.challenge);
  q.set('code_challenge_method', 'S256');
  if (o.fresh) Object.keys(cfg.freshLogin).forEach((k) => q.set(k, cfg.freshLogin[k]));
  else if (cfg.prompt) q.set('prompt', cfg.prompt);
  // no access_type=offline: no refresh token is ever asked for (§4.15)
  return cfg.authorization + '?' + q.toString();
}

function mapCallbackError(provider, code) {
  const known = typeof code === 'string' && PINS.isKnownError(code);
  return { reason: known ? PINS.mapError(provider, code) : 'provider', logged: known ? code : 'unknown' };
}

// Server-to-server code exchange (client_secret_post). Provider-side failures (5xx, timeout, network / TLS) are flagged for
// the breaker; a 4xx (junk or replayed code, invalid_grant, PKCE mismatch) is 'token' and never counts (§8.3).
async function exchangeCode(cfg, o) {
  const f = o.fetch || globalThis.fetch;
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: String(o.code || ''), redirect_uri: o.redirectUri,
    client_id: o.clientId, client_secret: o.clientSecret, code_verifier: o.verifier }).toString();
  let r;
  try {
    const init = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, redirect: 'error' };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(o.timeoutMs || 8000);
    r = await f(cfg.token, init);
  } catch (e) {
    return { ok: false, reason: 'provider', providerFailure: true };
  }
  if (!r || r.status >= 500) return { ok: false, reason: 'provider', providerFailure: true };
  if (r.status !== 200) return { ok: false, reason: 'token', providerFailure: false };
  let j;
  try { j = await r.json(); } catch (e) { return { ok: false, reason: 'provider', providerFailure: true }; }
  const idToken = j && typeof j.id_token === 'string' ? j.id_token : null;
  // j.access_token / j.refresh_token are dropped here and never stored or logged (D22)
  if (!idToken) return { ok: false, reason: 'token', providerFailure: false };
  return { ok: true, idToken };
}

// JWKS cache-control → lifetime (5 min … 24 h; default 1 h)
function cacheLifetime(headers) {
  let cc = null;
  try { cc = headers && headers.get ? headers.get('cache-control') : null; } catch (e) { cc = null; }
  const m = /max-age=(\d+)/i.exec(cc || '');
  const s = m ? Number(m[1]) : 3600;
  return Math.min(24 * 3600, Math.max(300, s)) * 1000;
}
function importRsaJwk(jwk) {
  if (!jwk || jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') return null;
  if (jwk.alg !== undefined && jwk.alg !== 'RS256') return null;
  if (jwk.use !== undefined && jwk.use !== 'sig') return null;
  try { return crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }); } catch (e) { return null; }
}

// store (optional): {get(provider, kid) → Promise<jwk|null>, put(provider, kid, jwk, expiresAtMs) → Promise}
function createKeyCache(o) {
  o = o || {};
  const now = o.now || (() => Date.now());
  const log = o.log || { warn() {} };
  const refetchMs = o.refetchMs || REFETCH_MS;
  const mem = new Map();                                  // provider → Map(kid → {key, expiresAt})
  const lastFetch = new Map();                            // provider → ms
  const stats = { fetches: 0, storeHits: 0, memHits: 0 };
  const memOf = (p) => { if (!mem.has(p)) mem.set(p, new Map()); return mem.get(p); };
  function fromMem(p, kid) {
    const e = memOf(p).get(kid);
    if (e && e.expiresAt > now()) { stats.memHits++; return e.key; }
    if (e) memOf(p).delete(kid);
    return null;
  }
  async function fetchJwks(cfg) {
    const f = o.fetch || globalThis.fetch;
    stats.fetches++;
    lastFetch.set(cfg.provider, now());
    let r;
    try {
      const init = { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error' };
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(o.timeoutMs || 8000);
      r = await f(cfg.jwks, init);
    } catch (e) { return false; }
    if (!r || r.status !== 200) return false;
    let j;
    try { j = await r.json(); } catch (e) { return false; }
    const until = now() + cacheLifetime(r.headers);
    for (const jwk of (j && Array.isArray(j.keys) ? j.keys : [])) {
      if (!jwk || typeof jwk.kid !== 'string' || jwk.kid.length > 256) continue;
      const key = importRsaJwk(jwk);
      if (!key) continue;
      const pub = { kty: 'RSA', n: jwk.n, e: jwk.e, kid: jwk.kid, alg: 'RS256', use: 'sig' };
      memOf(cfg.provider).set(jwk.kid, { key, expiresAt: until });
      if (o.store) { try { await o.store.put(cfg.provider, jwk.kid, pub, until); } catch (e) { log.warn('oidc: key store put failed'); } }
    }
    return true;
  }
  return {
    stats,
    clear() { mem.clear(); lastFetch.clear(); },
    async getKey(cfg, kid) {
      if (typeof kid !== 'string' || !kid || kid.length > 256) return { key: null, providerFailure: false };
      let key = fromMem(cfg.provider, kid);
      if (key) return { key, providerFailure: false };
      if (o.store) {
        let jwk = null;
        try { jwk = await o.store.get(cfg.provider, kid); } catch (e) { jwk = null; }
        key = jwk ? importRsaJwk(jwk) : null;
        if (key) { stats.storeHits++; memOf(cfg.provider).set(kid, { key, expiresAt: now() + REFETCH_MS }); return { key, providerFailure: false }; }
      }
      const last = lastFetch.get(cfg.provider);
      if (last !== undefined && now() - last < refetchMs) {                                            // refetch limit
        log.warn('alert: unknownKid — an unknown signing key for ' + cfg.provider + ' within the refetch limit');
        return { key: null, providerFailure: false };
      }
      if (o.store && typeof o.store.claimFetch === 'function') {
        let claimed = true;
        try { claimed = await o.store.claimFetch(cfg.provider); } catch (e) { claimed = true; }      // the memory limit still holds
        if (!claimed) { stats.claimRefused = (stats.claimRefused || 0) + 1; return { key: null, providerFailure: false }; }
      }
      const ok = await fetchJwks(cfg);
      if (!ok) { log.warn('alert: jwksFetch — the signing-key fetch for ' + cfg.provider + ' failed'); return { key: null, providerFailure: true }; }
      key = fromMem(cfg.provider, kid);
      return { key, providerFailure: false };
    },
  };
}

function parseJwt(token) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_BYTES) throw new OidcError('token');
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new OidcError('token');
  let header; let payload;
  try {
    header = JSON.parse(fromB64u(parts[0]).toString('utf8'));
    payload = JSON.parse(fromB64u(parts[1]).toString('utf8'));
  } catch (e) { throw new OidcError('token'); }
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new OidcError('token');
  return { header, payload, signingInput: parts[0] + '.' + parts[1], signature: fromB64u(parts[2]) };
}

async function verifyIdToken(token, o) {
  const cfg = o.cfg;
  const nowS = Math.floor((o.now != null ? o.now : Date.now()) / 1000);
  let jwt;
  try { jwt = parseJwt(token); } catch (e) { return { ok: false, reason: 'token' }; }
  const h = jwt.header;
  // RS256 only, decided before any key lookup: none, HS256 (the public key as an HMAC secret) and every other value refused
  if (h.alg !== 'RS256') return { ok: false, reason: 'token' };
  if (h.crit !== undefined) return { ok: false, reason: 'token' };
  const got = await o.getKey(cfg, h.kid);
  if (!got || !got.key) return { ok: false, reason: 'token', providerFailure: !!(got && got.providerFailure) };
  let good = false;
  try { good = jwt.signature.length >= 128 && crypto.verify('RSA-SHA256', Buffer.from(jwt.signingInput), got.key, jwt.signature); } catch (e) { good = false; }
  if (!good) return { ok: false, reason: 'token' };
  const c = jwt.payload;
  if (typeof c.iss !== 'string' || cfg.issuers.indexOf(c.iss) === -1) return { ok: false, reason: 'token' };
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.length || aud.indexOf(o.clientId) === -1 || aud.some((x) => x !== o.clientId)) return { ok: false, reason: 'token' };
  if (c.azp !== undefined && c.azp !== o.clientId) return { ok: false, reason: 'token' };
  if (typeof c.exp !== 'number' || !(c.exp > nowS - SKEW_S)) return { ok: false, reason: 'token' };
  if (typeof c.iat !== 'number' || c.iat > nowS + SKEW_S || nowS - c.iat > IAT_MAX_AGE_S) return { ok: false, reason: 'token' };
  if (c.nonce !== undefined || cfg.nonce === 'required') {
    if (typeof c.nonce !== 'string' || !safeEqual(c.nonce, o.nonce)) return { ok: false, reason: 'token' };
  }
  if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255) return { ok: false, reason: 'token' };
  let authTime = null;
  if (o.freshLogin) {
    if (!cfg.freshLogin) return { ok: false, reason: 'reauth_stale' };
    const startS = Math.floor(o.attemptCreatedAt / 1000);
    if (typeof c.auth_time !== 'number' || c.auth_time < startS - SKEW_S || c.auth_time > nowS + SKEW_S) return { ok: false, reason: 'reauth_stale' };
    authTime = c.auth_time;
  }
  const email = typeof c.email === 'string' ? normEmail(c.email) : null;
  const emailVerified = !!email && (c.email_verified === true || c.email_verified === 'true');
  const hd = typeof c.hd === 'string' && /^[a-z0-9.-]{1,253}$/i.test(c.hd) ? c.hd.toLowerCase() : null;
  // everything else (name, picture, locale, …) is dropped here
  return { ok: true, claims: { iss: c.iss, sub: c.sub, email, emailVerified, hd, authTime } };
}

function emailTrusted(cfg, claims) {
  if (!cfg.trustEmailVerified || !claims || !claims.email || claims.emailVerified !== true) return false;
  const dom = domainOf(claims.email);
  return (cfg.consumerDomains || []).indexOf(dom) !== -1 || (!!claims.hd && claims.hd === dom);
}

// Breaker (§8.3): provider-side failures only; opens with ≥ 20 exchanges in the window and > 50 % failing; stays open 10 min.
const BREAKER = Object.freeze({ windowMs: 10 * MIN, minExchanges: 20, ratio: 0.5, openMs: 10 * MIN });
function breakerDecision(w) { return w.total >= BREAKER.minExchanges && w.bad / w.total > BREAKER.ratio; }
function memoryBreaker(o) {
  o = o || {};
  const now = o.now || (() => Date.now());
  const s = {};
  const of = (p) => (s[p] = s[p] || { win: [], openUntil: 0 });
  return {
    async isOpen(p) { return of(p).openUntil > now(); },
    async note(p, providerFailure) {
      const b = of(p); const t = now();
      b.win = b.win.filter((x) => t - x.at < BREAKER.windowMs);
      b.win.push({ at: t, bad: !!providerFailure });
      if (breakerDecision({ total: b.win.length, bad: b.win.filter((x) => x.bad).length })) b.openUntil = t + BREAKER.openMs;
      return b.openUntil > t;
    },
  };
}

module.exports = {
  OidcError, b64u, fromB64u, randomToken, sha256, pkce, safeEqual, redirectUri, authorizationUrl, mapCallbackError,
  exchangeCode, createKeyCache, parseJwt, verifyIdToken, emailTrusted, BREAKER, breakerDecision, memoryBreaker,
  REFETCH_MS, SKEW_S, IAT_MAX_AGE_S,
};
