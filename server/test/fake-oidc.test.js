'use strict';
// server/test/fake-oidc.test.js — the fake OpenID provider behaves as §12.1 says (profiles, PKCE, single-use codes, faults),
// so WP-O can build core/oidc.js against it.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createFakeOidc, decodeJwt, FAULTS } = require('./fake-oidc');
const pins = require('../core/oidc-providers');

const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function authUrl(op, o) {
  o = o || {};
  const v = o.verifier || 'v'.repeat(50);
  const q = new URLSearchParams({ response_type: 'code', client_id: op.clientId, redirect_uri: op.redirectUri,
    scope: op.provider === 'google' ? 'openid email' : 'openid profile email', state: 'st', nonce: o.nonce || 'n-1',
    code_challenge: b64u(crypto.createHash('sha256').update(v).digest()), code_challenge_method: 'S256' });
  return op.authorizationEndpoint + '?' + q;
}
function exchange(op, cb, o) {
  o = o || {};
  const code = new URL(cb).searchParams.get('code');
  return op.token({ grant_type: 'authorization_code', code, client_id: op.clientId, client_secret: o.secret || op.clientSecret,
    redirect_uri: op.redirectUri, code_verifier: o.verifier || 'v'.repeat(50) });
}
function verify(op, token) {
  const j = decodeJwt(token);
  const jwk = op.jwks().keys.find((k) => k.kid === j.header.kid);
  return !!jwk && crypto.verify('RSA-SHA256', Buffer.from(j.signingInput), crypto.createPublicKey({ key: jwk, format: 'jwk' }), j.signature);
}

test('google profile: callback iss, signed RS256 id_token with nonce, azp, boolean email_verified, hd', () => {
  const op = createFakeOidc({ provider: 'google' });
  const cb = op.authorize(authUrl(op), { user: { key: 'u1', email: 'a@corp.example', hd: 'corp.example' } });
  const u = new URL(cb);
  assert.strictEqual(u.origin + u.pathname, op.redirectUri);
  assert.strictEqual(u.searchParams.get('iss'), op.issuer);
  assert.strictEqual(u.searchParams.get('state'), 'st');
  const r = exchange(op, cb);
  assert.strictEqual(r.status, 200);
  const t = decodeJwt(r.json.id_token);
  assert.strictEqual(t.header.alg, 'RS256'); assert.ok(verify(op, r.json.id_token));
  assert.strictEqual(t.payload.iss, op.issuer); assert.strictEqual(t.payload.aud, op.clientId); assert.strictEqual(t.payload.azp, op.clientId);
  assert.strictEqual(t.payload.nonce, 'n-1'); assert.strictEqual(t.payload.email_verified, true); assert.strictEqual(t.payload.hd, 'corp.example');
  assert.strictEqual(t.payload.sub, op.subjectFor('u1'));
  assert.strictEqual(exchange(op, cb).status, 400, 'a code is single use');
  assert.deepStrictEqual(Object.keys(pins.resolve('google', { override: op.override })).includes('authorization'), true);
});

test('linkedin profile: no callback iss, pairwise subjects, profile claims, PKCE as configured', () => {
  const a = createFakeOidc({ provider: 'linkedin', clientId: 'app-a' });
  const b = createFakeOidc({ provider: 'linkedin', clientId: 'app-b' });
  assert.notStrictEqual(a.subjectFor('same-user'), b.subjectFor('same-user'), 'pairwise per client');
  const cb = a.authorize(authUrl(a), { user: { key: 'u', email: 'x@company.example' } });
  assert.strictEqual(new URL(cb).searchParams.get('iss'), null);
  const t = decodeJwt(exchange(a, cb).json.id_token).payload;
  assert.strictEqual(t.email_verified, 'true'); assert.ok(t.name && t.picture && t.locale);
  const lax = createFakeOidc({ provider: 'linkedin', enforcePkce: false, returnsNonce: false });
  const cb2 = lax.authorize(authUrl(lax), { user: { key: 'u' } });
  const r2 = exchange(lax, cb2, { verifier: 'w'.repeat(50) });
  assert.strictEqual(r2.status, 200, 'a provider that does not enforce PKCE accepts a wrong verifier (the WP0 question)');
  assert.strictEqual(decodeJwt(r2.json.id_token).payload.nonce, undefined);
  const strict = createFakeOidc({ provider: 'linkedin', enforcePkce: true });
  assert.strictEqual(exchange(strict, strict.authorize(authUrl(strict), {}), { verifier: 'w'.repeat(50) }).status, 400);
});

test('cancel, wrong client, wrong redirect, expiry, fault modes, key rotation, fetch seam', async () => {
  let t = Date.UTC(2026, 10, 8, 12);
  const op = createFakeOidc({ provider: 'google', now: () => t, freshKey: true });
  const c = new URL(op.authorize(authUrl(op), { cancel: true }));
  assert.strictEqual(c.searchParams.get('error'), 'access_denied');
  assert.throws(() => op.authorize(authUrl(op).replace(op.clientId, 'other'), {}), /client_id/);
  assert.throws(() => op.authorize(authUrl(op).replace(encodeURIComponent(op.redirectUri), encodeURIComponent('https://evil.example/cb')), {}), /redirect_uri/);
  const cb = op.authorize(authUrl(op), {});
  assert.strictEqual(exchange(op, cb, { secret: 'nope' }).status, 401);
  const cb2 = op.authorize(authUrl(op), {}); t += 11 * 60 * 1000;
  assert.strictEqual(exchange(op, cb2).status, 400, 'codes expire after 10 min');
  const seen = {};
  for (const f of FAULTS) {
    op.setFault(f);
    const r = exchange(op, op.authorize(authUrl(op), { user: { email: 'a@gmail.com' } }));
    seen[f] = r.status === 200 ? decodeJwt(r.json.id_token) : r.status;
  }
  op.setFault(null);
  assert.strictEqual(seen.token_5xx, 503); assert.strictEqual(seen.token_400, 400);
  assert.strictEqual(seen.alg_none.header.alg, 'none'); assert.strictEqual(seen.hs256.header.alg, 'HS256');
  assert.strictEqual(seen.iss.payload.iss, 'https://other.idp.test'); assert.deepStrictEqual(seen.aud_extra.payload.aud.length, 2);
  assert.strictEqual(seen.ev_string.payload.email_verified, 'true'); assert.strictEqual(seen.ev_false.payload.email_verified, false);
  assert.strictEqual(seen.no_email.payload.email, undefined); assert.strictEqual(seen.unknown_kid.header.kid, 'k-unknown');
  const old = op.jwks().keys[0].kid; const nk = op.rotateKey();
  assert.notStrictEqual(old, nk); assert.strictEqual(op.jwks().keys[0].kid, nk);
  const jw = await (await op.fetch(op.jwksUri)).json();
  assert.strictEqual(jw.keys[0].kid, nk);
  const cb3 = op.authorize(authUrl(op), {});
  const tr = await op.fetch(op.tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: new URL(cb3).searchParams.get('code'), client_id: op.clientId, client_secret: op.clientSecret, redirect_uri: op.redirectUri, code_verifier: 'v'.repeat(50) }).toString() });
  assert.strictEqual(tr.status, 200); assert.ok(verify(op, (await tr.json()).id_token));
  assert.throws(() => op.setFault('nope'), /unknown fault/);
});
