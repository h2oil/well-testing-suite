'use strict';
// server/test/contract-live.test.js — every WP-S1 endpoint of the frozen contract (core/contract.js, the plan's §3.3) answers
// its example request against the real database with a status and body the contract allows: signed out (the only 401 is
// signed_out), signed in, and signed in with a fresh step-up. The provider endpoints (WP-O) and passkeys (Phase 3) are left
// to their packages.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const S = require('./_shapes');
const { harness, available } = require('./_api');

const skip = !available() && 'no throwaway database (run through server/test/run.js)';
const LATER = new Set(['providers', 'oauthStart', 'oauthCallback', 'oauthFinish', 'methods', 'unlink',
  'passkeyOptions', 'passkeyVerify', 'passkeyRegisterOptions', 'passkeyRegisterVerify', 'passkeyRename', 'passkeyRemove']);

test.describe('the contract, live (§3.3)', { skip }, () => {
  let T = null;
  test.before(async () => { T = await harness('contract_live'); });
  test.after(async () => { if (T) await T.close(); });

  async function sweep(br, pid, label) {
    const seen = {};
    for (const e of S.ENDPOINTS) {
      if (LATER.has(e.id) || e.auth === 'hmac') continue;
      const p = e.path.replace(':id', pid).replace(':hash', 'a'.repeat(64)).replace(':n', '0').replace(':rev', '1');
      let body; let co = {};
      if (e.method !== 'GET') {
        if (e.body === 'octet') { co = { raw: Buffer.from('x'), ct: 'application/octet-stream', headers: { 'x-wts-zsha': 'b'.repeat(64), 'x-wts-chunk-sha': crypto.createHash('sha256').update('x').digest('hex') } }; }
        else if (e.auth === 'report') { co = { bare: true, headers: { 'content-type': 'application/csp-report' } }; body = {}; }
        else body = JSON.parse(JSON.stringify(S.EXAMPLES[e.id].req || {}));
        if (body && body.pushId) body.pushId = crypto.randomUUID();
        if (e.id === 'accountDelete' || e.id === 'signOut' || e.id === 'signOutAll') continue;     // run last, they end the session
      }
      const url = p + (e.id === 'blobPut' ? '?of=1' : '');
      const r = await br.call(e.method, url, body, co);
      const json = r.json != null ? r.json : (r.body && r.status < 300 ? r.body : null);
      const c = S.checkResponse(e.id, r.status, json);
      assert.ok(c.ok, label + ' ' + e.id + ' → ' + r.status + ' ' + JSON.stringify(r.json) + ' ' + JSON.stringify(c.errors));
      assert.notStrictEqual(r.status, 501, label + ' ' + e.id + ' is built');
      if (r.status === 401) assert.strictEqual(r.json.error, 'signed_out', 'the only 401');
      seen[e.id] = r.status;
    }
    return seen;
  }

  test('signed out, signed in, stepped up: every answer fits the contract; nothing is a foundation stub', async () => {
    const out = await sweep(T.browser(), crypto.randomUUID(), 'signed out');
    assert.strictEqual(out.me, 401); assert.strictEqual(out.projectList, 401); assert.strictEqual(out.codeStart, 202);
    const br = T.browser();
    await T.signIn(br, 'live@company.example');
    const pid = (await br.call('POST', '/projects', { name: 'Live', meta: { client: '', well: '', field: '', operator: '' } })).json.id;
    const a = await sweep(br, pid, 'signed in');
    assert.strictEqual(a.me, 200); assert.strictEqual(a.projectHead, 200);
    await T.age`update wts.sessions set stepup_at = now() - interval '11 minutes'`;
    const b = await sweep(br, pid, 'no step-up');
    assert.strictEqual(b.accountExport, 403); assert.strictEqual(b.emailChange, 403);
    await T.stepUp(br);
    await sweep(br, pid, 'stepped up');
    for (const id of ['signOutAll', 'accountDelete']) {
      const e = S.ENDPOINTS.find((x) => x.id === id);
      const r = await br.call(e.method, e.path, S.EXAMPLES[id].req);
      assert.ok(S.checkResponse(id, r.status, r.json).ok, id + ' ' + r.status + ' ' + JSON.stringify(r.json));
    }
    const so = await br.call('POST', '/auth/signout', {});
    assert.ok(S.checkResponse('signOut', so.status, so.json).ok);
  });
});
