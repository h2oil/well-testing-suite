'use strict';
// server/test/fake-oidc.js — a fake OpenID provider for tests only (docs/ACCOUNTS-PLAN.md §12.1), shared by the server tests
// and the in-memory fake server (prism-build/tests/_acct-fake-server.js). Never loaded by a deployment.
//
//   createFakeOidc({provider:'google'|'linkedin', clientId, clientSecret, redirectUri, now}) → op
//     op.issuer, op.authorizationEndpoint, op.tokenEndpoint, op.jwksUri   (https://<provider>.idp.test/…)
//     op.override            the object to pass to oidc-providers.resolve(p, {override}) in a test run
//     op.jwks()              {keys:[RSA public JWK, kid, alg RS256, use sig]}
//     op.authorize(url, {user, cancel, error}) → the callback URL the provider would send the browser to
//                            user = {sub?, key?, email?, email_verified?, hd?, authTime?}; cancel → the cancel error code;
//                            error → any provider error code. Checks client_id, redirect_uri, response_type, scope, state.
//     op.token(form)         → {status, json}: grant_type, client_id + client_secret, redirect_uri, single-use code ≤ 10 min,
//                            PKCE S256 (Google always; LinkedIn when op.enforcePkce) → {id_token, access_token, …}
//     op.fetch(url, init)    a fetch for the token and JWKS endpoints (Response-like), for code that takes a fetch seam
//     op.setFault(mode|null) one of FAULTS (applies to every following token until cleared)
//     op.sign(claims, {alg, kid, key}) → a compact JWT (also used to forge tokens in tests)
//     op.rotateKey()         new signing key and kid (the old kid disappears from the JWKS)
//     op.subjectFor(key)     the subject this provider gives a user key (LinkedIn: pairwise per client id)
//     op.calls               {authorize, token, jwks} counters
//   decodeJwt(token) → {header, payload, signingInput, signature}
//
// Profiles (§4.15): google — `iss` on the callback, nonce always returned, email_verified boolean, hd for hosted domains,
// a global subject. linkedin — no callback `iss`, nonce returned only when op.returnsNonce (default true), name / picture /
// locale claims that the server must drop, a pairwise subject.

const crypto = require('crypto');

const FAULTS = ['iss', 'aud', 'aud_extra', 'azp', 'nonce', 'no_nonce', 'alg_none', 'hs256', 'unknown_kid', 'expired', 'future_iat',
  'stale_iat', 'no_email', 'ev_missing', 'ev_string', 'ev_false', 'no_auth_time', 'old_auth_time', 'token_5xx', 'token_400', 'bad_sig'];
const CANCEL = { google: 'access_denied', linkedin: 'user_cancelled_login' };

let SHARED_KEY = null;
function newKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, publicKey, kid: 'k' + crypto.randomBytes(6).toString('hex') };
}
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function decodeJwt(token) {
  const p = String(token).split('.');
  if (p.length !== 3) throw new Error('not a JWT');
  return { header: JSON.parse(fromB64u(p[0]).toString('utf8')), payload: JSON.parse(fromB64u(p[1]).toString('utf8')), signingInput: p[0] + '.' + p[1], signature: fromB64u(p[2]) };
}

function createFakeOidc(o) {
  o = o || {};
  const provider = o.provider === 'linkedin' ? 'linkedin' : 'google';
  const host = 'https://' + provider + '.idp.test';
  const now = o.now || (() => Date.now());
  const clientId = o.clientId || provider + '-client-id';
  const clientSecret = o.clientSecret || provider + '-client-secret';
  const redirectUri = o.redirectUri || 'https://welltest.h2oil.co.uk/api/v1/auth/oauth/' + provider + '/callback';
  let key = o.freshKey ? newKey() : (SHARED_KEY || (SHARED_KEY = newKey()));
  const codes = new Map();
  let fault = null;
  const calls = { authorize: 0, token: 0, jwks: 0 };
  const issuer = provider === 'google' ? host : host + '/oauth';
  const op = {
    provider, issuer, clientId, clientSecret, redirectUri, calls,
    authorizationEndpoint: host + '/authorize', tokenEndpoint: host + '/token', jwksUri: host + '/jwks',
    enforcePkce: provider === 'google' || !!o.enforcePkce,
    returnsNonce: o.returnsNonce !== false,
    get override() {
      return { authorization: op.authorizationEndpoint, token: op.tokenEndpoint, jwks: op.jwksUri, issuers: [issuer], pending: [],
        freshLogin: provider === 'google' ? { prompt: 'login', max_age: '0' } : null };
    },
    setFault(m) { if (m !== null && FAULTS.indexOf(m) === -1) throw new Error('fake-oidc: unknown fault ' + m); fault = m; },
    rotateKey() { key = newKey(); return key.kid; },
    jwks() {
      calls.jwks++;
      const jwk = key.publicKey.export({ format: 'jwk' });
      return { keys: [Object.assign({ kid: key.kid, alg: 'RS256', use: 'sig' }, jwk)] };
    },
    subjectFor(userKey) {
      if (provider === 'linkedin') return 'li' + crypto.createHash('sha256').update(clientId + '|' + userKey).digest('hex').slice(0, 20);
      return String(1e20 + parseInt(crypto.createHash('sha256').update('g|' + userKey).digest('hex').slice(0, 12), 16));
    },
    sign(claims, s) {
      s = s || {};
      const alg = s.alg || 'RS256';
      const header = { alg, typ: 'JWT' };
      if (alg !== 'none') header.kid = s.kid || key.kid;
      const input = b64u(JSON.stringify(header)) + '.' + b64u(JSON.stringify(claims));
      if (alg === 'none') return input + '.';
      if (alg === 'HS256') {
        const secret = s.key || key.publicKey.export({ format: 'pem', type: 'spki' });
        return input + '.' + b64u(crypto.createHmac('sha256', secret).update(input).digest());
      }
      return input + '.' + b64u(crypto.sign('RSA-SHA256', Buffer.from(input), s.key || key.privateKey));
    },
    authorize(url, a) {
      a = a || {};
      calls.authorize++;
      const u = new URL(url);
      if (u.origin + u.pathname !== op.authorizationEndpoint) throw new Error('fake-oidc: not my authorization endpoint: ' + u.origin + u.pathname);
      const q = Object.fromEntries(u.searchParams);
      if (q.client_id !== clientId) throw new Error('fake-oidc: client_id');
      if (q.redirect_uri !== redirectUri) throw new Error('fake-oidc: redirect_uri ' + q.redirect_uri);
      if (q.response_type !== 'code') throw new Error('fake-oidc: response_type');
      const scopes = String(q.scope || '').split(' ');
      const need = provider === 'google' ? ['openid', 'email'] : ['openid', 'profile', 'email'];
      if (!need.every((s) => scopes.includes(s))) throw new Error('fake-oidc: scope ' + q.scope);
      const back = new URL(redirectUri);
      if (q.state !== undefined) back.searchParams.set('state', q.state);
      if (a.cancel || a.error) {
        back.searchParams.set('error', a.error || CANCEL[provider]);
        back.searchParams.set('error_description', 'The user said no <script>x</script>');
        return back.toString();
      }
      const user = a.user || {};
      const uk = user.key || user.email || 'user';
      const code = 'c' + crypto.randomBytes(16).toString('hex');
      codes.set(code, { at: now(), used: false, challenge: q.code_challenge || null, method: q.code_challenge_method || null,
        nonce: q.nonce || null, prompt: q.prompt || null, maxAge: q.max_age, user: Object.assign({ sub: user.sub || op.subjectFor(uk) }, user) });
      back.searchParams.set('code', code);
      if (provider === 'google') back.searchParams.set('iss', issuer);
      return back.toString();
    },
    token(form) {
      calls.token++;
      const f = form || {};
      if (fault === 'token_5xx') return { status: 503, json: { error: 'temporarily_unavailable' } };
      if (fault === 'token_400') return { status: 400, json: { error: 'invalid_grant' } };
      if (f.grant_type !== 'authorization_code') return { status: 400, json: { error: 'unsupported_grant_type' } };
      if (f.client_id !== clientId || f.client_secret !== clientSecret) return { status: 401, json: { error: 'invalid_client' } };
      if (f.redirect_uri !== redirectUri) return { status: 400, json: { error: 'invalid_grant' } };
      const c = codes.get(f.code);
      if (!c || c.used || now() - c.at > 10 * 60 * 1000) return { status: 400, json: { error: 'invalid_grant' } };
      c.used = true;
      if (c.challenge && op.enforcePkce) {
        const want = b64u(crypto.createHash('sha256').update(String(f.code_verifier || '')).digest());
        if (c.method !== 'S256' || want !== c.challenge) return { status: 400, json: { error: 'invalid_grant' } };
      } else if (provider === 'google' && !c.challenge) {
        return { status: 400, json: { error: 'invalid_request' } };
      }
      const t = Math.floor(now() / 1000);
      const u = c.user;
      const claims = { iss: issuer, aud: clientId, sub: u.sub, iat: t, exp: t + 3600 };
      if (provider === 'google') claims.azp = clientId;
      if (c.nonce && (provider === 'google' || op.returnsNonce)) claims.nonce = c.nonce;
      if (u.email !== undefined && u.email !== null) claims.email = u.email;
      if (u.email_verified !== undefined) claims.email_verified = u.email_verified;
      else if (claims.email) claims.email_verified = provider === 'google' ? true : 'true';
      if (u.hd) claims.hd = u.hd;
      if (c.prompt === 'login' || c.maxAge === '0' || u.authTime) claims.auth_time = u.authTime != null ? u.authTime : t;
      if (provider === 'linkedin') Object.assign(claims, { name: 'Example User', given_name: 'Example', family_name: 'User', picture: 'https://linkedin.idp.test/p.png', locale: 'en_GB' });
      let signOpts = {};
      switch (fault) {
        case 'iss': claims.iss = 'https://other.idp.test'; break;
        case 'aud': claims.aud = 'someone-else'; break;
        case 'aud_extra': claims.aud = [clientId, 'someone-else']; break;
        case 'azp': claims.azp = 'someone-else'; break;
        case 'nonce': claims.nonce = 'wrong-nonce'; break;
        case 'no_nonce': delete claims.nonce; break;
        case 'alg_none': signOpts = { alg: 'none' }; break;
        case 'hs256': signOpts = { alg: 'HS256' }; break;
        case 'unknown_kid': signOpts = { kid: 'k-unknown' }; break;
        case 'expired': claims.exp = t - 120; claims.iat = t - 3720; break;
        case 'future_iat': claims.iat = t + 120; break;
        case 'stale_iat': claims.iat = t - 11 * 60; break;
        case 'no_email': delete claims.email; delete claims.email_verified; break;
        case 'ev_missing': delete claims.email_verified; break;
        case 'ev_string': claims.email_verified = 'true'; break;
        case 'ev_false': claims.email_verified = false; break;
        case 'no_auth_time': delete claims.auth_time; break;
        case 'old_auth_time': claims.auth_time = t - 3600; break;
        case 'bad_sig': signOpts = { key: newKey().privateKey }; break;
        default: break;
      }
      return { status: 200, json: { access_token: 'at-' + crypto.randomBytes(8).toString('hex'), token_type: 'Bearer', expires_in: 3599, scope: 'openid email', id_token: op.sign(claims, signOpts) } };
    },
    async fetch(url, init) {
      init = init || {};
      const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: (n) => (/content-type/i.test(n) ? 'application/json' : (/cache-control/i.test(n) ? 'public, max-age=3600' : null)) }, json: async () => body, text: async () => JSON.stringify(body) });
      if (url === op.jwksUri) return resp(200, op.jwks());
      if (url === op.tokenEndpoint && String(init.method || 'GET').toUpperCase() === 'POST') {
        const form = Object.fromEntries(new URLSearchParams(typeof init.body === 'string' ? init.body : String(init.body || '')));
        const auth = init.headers && (init.headers.Authorization || init.headers.authorization);
        if (auth && /^Basic /.test(auth)) { const [id, sec] = Buffer.from(auth.slice(6), 'base64').toString().split(':'); form.client_id = form.client_id || decodeURIComponent(id); form.client_secret = form.client_secret || decodeURIComponent(sec); }
        const r = op.token(form);
        return resp(r.status, r.json);
      }
      return resp(404, { error: 'not_found' });
    },
  };
  return op;
}

module.exports = { createFakeOidc, decodeJwt, FAULTS, CANCEL, b64u, fromB64u };
