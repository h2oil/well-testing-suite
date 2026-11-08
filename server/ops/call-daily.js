#!/usr/bin/env node
'use strict';
// server/ops/call-daily.js — calls POST /api/v1/ops/daily with the HMAC rule of docs/ACCOUNTS-PLAN.md §3.2 / §3.5, for a
// host plan without its own scheduler (the owner's scheduler or a jobs host runs it daily; never the release workflow).
//
//   WTS_OPS_HMAC=<base64 key> node server/ops/call-daily.js [https://welltest.h2oil.co.uk]
//
// Signature: HMAC-SHA256(key, method \n path \n ts \n nonce) in X-WTS-Sig; X-WTS-Ts (seconds) and X-WTS-Nonce (random, used
// once). The key is used only for this call. Output: one JSON line {ok, status}.

const crypto = require('crypto');
const { opsSignature } = require('../core/http');

function signedRequest(base, keyB64, nowMs) {
  const key = Buffer.from(String(keyB64 || ''), 'base64');
  if (key.length < 32) throw new Error('WTS_OPS_HMAC is not set (32 bytes, base64)');
  const p = '/api/v1/ops/daily';
  const ts = String(Math.floor((nowMs || Date.now()) / 1000));
  const nonce = crypto.randomBytes(18).toString('base64url');
  return {
    url: String(base || 'https://welltest.h2oil.co.uk').replace(/\/+$/, '') + p,
    init: { method: 'POST', headers: { 'X-WTS-Ts': ts, 'X-WTS-Nonce': nonce, 'X-WTS-Sig': opsSignature(key, 'POST', p, ts, nonce), 'Content-Type': 'application/json' }, body: '{}' },
  };
}

module.exports = { signedRequest };

if (require.main === module) {
  (async () => {
    const base = process.argv[2] || 'https://welltest.h2oil.co.uk';
    if (!/^https:\/\//.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error('https only (or a loopback dev server)');
    const r = signedRequest(base, process.env.WTS_OPS_HMAC);
    const res = await fetch(r.url, r.init);
    process.stdout.write(JSON.stringify({ ok: res.ok, status: res.status }) + '\n');
    if (!res.ok) process.exitCode = 1;
  })().catch((e) => { process.stderr.write(JSON.stringify({ ok: false, error: String(e.message || e) }) + '\n'); process.exitCode = 1; });
}
