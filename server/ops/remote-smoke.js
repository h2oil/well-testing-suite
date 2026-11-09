#!/usr/bin/env node
'use strict';
// server/ops/remote-smoke.js — the operator's smoke test of a DEPLOYED functions site (server/RUNBOOK.md "Test backend",
// step "Smoke test"). Run from any machine with Node 22; it only sends HTTPS requests to the site and prints a pass / fail
// table (never a secret, never the test address).
//
//   WTS_SMOKE_BASE=https://<functions-site-address> WTS_PROXY_SIG=<value> WTS_OPS_HMAC=<value> node server/ops/remote-smoke.js [--mail-to <address>]
//
// The base URL and both secrets come ONLY from the environment (never the command line, so they stay out of the shell
// history and the process list). WTS_PROXY_SIG may hold "current,previous": the first value is sent. Checks:
//   1  health, signed          GET /api/v1/health with X-WTS-Proxy-Sig + X-WTS-Host → 200 {ok:true, db:true, ver}
//   2  health, no signature    the same without the signature → 404 (the site answers nothing to a direct caller)
//   3  health, wrong signature → 404
//   4  write without Origin    POST /api/v1/auth/code/start, signed, no Origin → 403 origin (refused before any work)
//   5  self-test, no HMAC      POST /api/v1/ops/selftest with only the proxy signature → 404
//   6  self-test, signed       the same with the ops HMAC (site/handler.js) → 200 {ok, checks}: isolation, keys, database,
//                              request role wts_api, the jobs' role switch (session | local), the mail transport
//   7  test e-mail             only with --mail-to: the self-test sends one notice_ops_test mail through the configured
//                              transport → checks.mail = 'sent' (else the transport error kind, e.g. mail_sender)
// Exit 0 when every check passed, 1 otherwise, 2 on a usage error.
//
//   require('./remote-smoke').run({base, sig, hmac, mailTo?, fetch?, now?}) → Promise<{ok, rows:[{id, name, ok, detail}]}>

const crypto = require('crypto');
const { opsSignature } = require('../core/http');
const { PROD_HOST } = require('../core/config');

const SELFTEST = '/api/v1/ops/selftest';

function checkBase(base) {
  const b = String(base || '').replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(b) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(b)) {
    throw new Error('WTS_SMOKE_BASE must be https://<host> (or a loopback http address for a local run)');
  }
  return b;
}
async function readJson(res) { try { return await res.json(); } catch (e) { return null; } }

async function run(o) {
  o = o || {};
  const base = checkBase(o.base);
  const sig = String(o.sig || '').split(',')[0].trim();
  if (!sig) throw new Error('WTS_PROXY_SIG is not set');
  const key = Buffer.from(String(o.hmac || ''), 'base64');
  if (key.length < 32) throw new Error('WTS_OPS_HMAC is not set (32 bytes, base64)');
  const f = o.fetch || fetch;
  const now = o.now || Date.now;
  const rows = [];
  const add = (id, name, ok, detail) => rows.push({ id, name, ok: !!ok, detail: String(detail == null ? '' : detail) });
  const signed = (extra) => Object.assign({ 'X-WTS-Proxy-Sig': sig, 'X-WTS-Host': PROD_HOST }, extra || {});
  async function step(id, name, fn) {
    try { await fn(); } catch (e) { add(id, name, false, 'request failed: ' + String((e && e.message) || e).replace(/https?:\/\/\S+/g, '<url>').slice(0, 120)); }
  }

  await step(1, 'health, signed', async () => {
    const res = await f(base + '/api/v1/health', { headers: signed() });
    const b = await readJson(res);
    const ok = res.status === 200 && b && b.ok === true && b.db === true && typeof b.ver === 'string' && b.ver.length > 0;
    add(1, 'health, signed', ok, 'status ' + res.status + (b ? ', ok ' + b.ok + ', db ' + b.db + ', ver ' + b.ver : ''));
  });
  await step(2, 'health, no signature → 404', async () => {
    const res = await f(base + '/api/v1/health', { headers: { 'X-WTS-Host': PROD_HOST } });
    add(2, 'health, no signature → 404', res.status === 404, 'status ' + res.status);
  });
  await step(3, 'health, wrong signature → 404', async () => {
    const res = await f(base + '/api/v1/health', { headers: signed({ 'X-WTS-Proxy-Sig': crypto.randomBytes(32).toString('base64url') }) });
    add(3, 'health, wrong signature → 404', res.status === 404, 'status ' + res.status);
  });
  await step(4, 'write without Origin → 403 origin', async () => {
    const res = await f(base + '/api/v1/auth/code/start', {
      method: 'POST', headers: signed({ 'Content-Type': 'application/json', 'X-WTS-Req': '1' }),
      body: JSON.stringify({ email: 'smoke-test@company.example' }),
    });
    const b = await readJson(res);
    add(4, 'write without Origin → 403 origin', res.status === 403 && b && b.error === 'origin', 'status ' + res.status + (b && b.error ? ', ' + b.error : ''));
  });
  await step(5, 'self-test without HMAC → 404', async () => {
    const res = await f(base + SELFTEST, { method: 'POST', headers: signed({ 'Content-Type': 'application/json' }), body: '{}' });
    add(5, 'self-test without HMAC → 404', res.status === 404, 'status ' + res.status);
  });
  await step(6, 'self-test, signed', async () => {
    const ts = String(Math.floor(now() / 1000));
    const nonce = crypto.randomBytes(18).toString('base64url');
    const res = await f(base + SELFTEST, {
      method: 'POST',
      headers: signed({ 'Content-Type': 'application/json', 'X-WTS-Ts': ts, 'X-WTS-Nonce': nonce, 'X-WTS-Sig': opsSignature(key, 'POST', SELFTEST, ts, nonce) }),
      body: JSON.stringify(o.mailTo ? { mailTo: String(o.mailTo) } : {}),
    });
    const b = await readJson(res);
    const c = (b && b.checks) || {};
    const core = res.status === 200 && c.isolation === true && c.keys === true && c.db === true && c.requestRole === 'wts_api' && c.jobsRole !== 'refused';
    add(6, 'self-test, signed', core, 'status ' + res.status + (b ? ', isolation ' + c.isolation + (c.problems && c.problems.length ? ' (' + c.problems.length + ' problem(s): ' + c.problems.join('; ').slice(0, 200) + ')' : '')
      + ', keys ' + c.keys + ', objects ' + c.objects + ', db ' + c.db + ', request role ' + c.requestRole + ', jobs role ' + c.jobsRole
      + ', mail transport ' + (c.mailTransport || 'none') : ''));
    if (o.mailTo) add(7, 'test e-mail sent', res.status === 200 && c.mail === 'sent', 'mail ' + (c.mail || 'no answer') + ' (address not shown)');
    if (c.jobsRole === 'local') add(6.1, 'note: jobs role', true, 'start-up role refused, transaction role ok — set WTS_DB_ROLE_MODE=local on the site');
  });
  return { ok: rows.every((r) => r.ok), rows };
}

function table(rows) {
  const w = Math.max(4, ...rows.map((r) => r.name.length));
  const lines = ['  #   ' + 'check'.padEnd(w) + '  result  detail', '  ' + '-'.repeat(w + 22)];
  rows.forEach((r) => lines.push('  ' + String(r.id).padEnd(4) + r.name.padEnd(w) + '  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + '  ' + r.detail));
  return lines.join('\n');
}

module.exports = { run, table, checkBase, SELFTEST };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--mail-to');
  const mailTo = i !== -1 ? argv[i + 1] : null;
  if (i !== -1 && !(mailTo && /@/.test(mailTo))) { console.error('[remote-smoke] --mail-to needs an address'); process.exit(2); }
  if (argv.some((a, k) => !(i !== -1 && (k === i || k === i + 1)))) { console.error('[remote-smoke] the base URL and secrets come from WTS_SMOKE_BASE, WTS_PROXY_SIG and WTS_OPS_HMAC only'); process.exit(2); }
  run({ base: process.env.WTS_SMOKE_BASE, sig: process.env.WTS_PROXY_SIG, hmac: process.env.WTS_OPS_HMAC, mailTo }).then((r) => {
    console.log('[remote-smoke] ' + checkBase(process.env.WTS_SMOKE_BASE).replace(/^https?:\/\//, '') + '\n' + table(r.rows));
    console.log('[remote-smoke] ' + (r.ok ? 'all checks passed' : 'FAILED: ' + r.rows.filter((x) => !x.ok).map((x) => x.id).join(', ')));
    process.exitCode = r.ok ? 0 : 1;
  }, (e) => { console.error('[remote-smoke] ' + e.message); process.exitCode = 2; });
}
