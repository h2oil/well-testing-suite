'use strict';
// server/test/contract.test.js — the server side of the shared contract (test/_shapes.js = prism-build/tests/_acct-shapes.js):
// every example passes, every endpoint's stub answers through the pipeline with a status the contract allows, and the
// in-memory fake server (which the client tests use) runs on this same pipeline.

const test = require('node:test');
const assert = require('node:assert');
const S = require('./_shapes');
const { loadConfig } = require('../core/config');
const { createApp } = require('../core/app');

const ORIGIN = 'https://welltest.h2oil.co.uk';

test('examples pass their shapes; error examples pass their envelopes', () => {
  for (const e of S.ENDPOINTS) {
    const ex = S.EXAMPLES[e.id];
    assert.ok(ex, e.id);
    if (e.req) assert.ok(S.checkShape(e.req, ex.req).ok, e.id + ' req');
    Object.keys(e.res).forEach((st) => assert.ok(S.checkResponse(e.id, Number(st), ex.res[st]).ok, e.id + ' ' + st));
  }
  Object.keys(S.ERRORS).forEach((c) => assert.ok(S.checkError(c, S.ERROR_EXAMPLES[c]).ok, c));
});

test('every endpoint answers through the WP0 pipeline with a status the contract allows', async () => {
  const app = createApp({ config: loadConfig({ WTS_ENV: 'test' }) });
  for (const e of S.ENDPOINTS) {
    const p = e.path.replace(':provider', 'google').replace(':id', S.EXAMPLES.projectCreate.res[201].id).replace(':hash', 'a'.repeat(64)).replace(':n', '0').replace(':rev', '1');
    const headers = { host: 'welltest.h2oil.co.uk' };
    let body = null;
    if (e.method !== 'GET') {
      if (e.auth !== 'report' && e.auth !== 'hmac') Object.assign(headers, { origin: ORIGIN, 'x-wts-req': '1' });
      headers['content-type'] = e.body === 'octet' ? 'application/octet-stream' : (e.auth === 'report' ? 'application/csp-report' : 'application/json');
      body = Buffer.from(e.body === 'octet' ? 'x' : JSON.stringify(S.EXAMPLES[e.id].req || {}));
    }
    const out = await app.handle({ method: e.method, url: S.BASE + p + (e.id === 'blobPut' ? '?of=1' : ''), headers, body, remoteAddress: '203.0.113.1' });
    const json = out.body && /json/.test(out.headers['Content-Type'] || '') ? JSON.parse(out.body) : null;
    if (e.auth === 'hmac') { assert.strictEqual(out.status, 403, e.id + ' without a signature'); continue; }
    const r = S.checkResponse(e.id, out.status, json);
    assert.ok(r.ok, e.id + ' → ' + out.status + ' ' + out.body + ' ' + JSON.stringify(r.errors));
  }
});

test('the fake server for client tests is built on this pipeline and this contract', async () => {
  const F = S.FAKE;
  const fake = F.createFakeServer({});
  assert.strictEqual(typeof fake.handle, 'function');
  const r = await fake.fetch(F.PROD + '/api/v1/auth/providers');
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  assert.ok(S.checkResponse('providers', r.status, await r.json()).ok);
});
