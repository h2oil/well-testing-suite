#!/usr/bin/env node
'use strict';
// server/ops/monitor-check.js — the hourly alert check of docs/ACCOUNTS-PLAN.md §13.6 (site/site.json "monitor-check").
// Reads aggregate metrics with the jobs credential (counters, outbox age, deletion lag, storage, linked subjects), the
// health endpoint and the newest weekly export, evaluates site/monitor.js RULES and sends any alert as "alert:" log lines
// and one POST to WTS_ALERT_WEBHOOK (https). Request-level alerts (5xx rate, p95, provider callback failures) come from the
// access lines through the host's log alerting, or from `--lines <file>` (one access line per row).
//
//   WTS_JOBS_DB_URL=… [WTS_HEALTH_URL=https://welltest.h2oil.co.uk/api/v1/health] [WTS_EXPORT_DIR=…]
//   [WTS_STORAGE_PLAN_BYTES=…] [WTS_ALERT_WEBHOOK=…] [WTS_ALERT_EMAIL=…] node server/ops/monitor-check.js [--lines <file>] [--dry]
//
// Output: one JSON line {ok, metrics, alerts:[ids]} — counts only. Exit 0 also when alerts fire (they are delivered); 1 only
// when the check itself fails.

const fs = require('fs');
const M = require('../site/monitor');

// each query is optional: a metric the credential cannot read is left out (never alerted) and reported as skipped
async function dbMetrics(sql, env) {
  const m = {}; const skipped = [];
  const q = async (name, fn) => { try { await fn(); } catch (e) { skipped.push(name); } };
  await q('counters', async () => {
    const rows = await sql`select split_part(bucket, ':', 1) as b, max(n)::bigint as top, count(*) filter (where n > 0)::int as keys, sum(n)::bigint as total
      from wts.rate_counters where window_start > now() - interval '1 hour' group by 1`;
    const by = {}; rows.forEach((r) => { by[r.b] = { top: Number(r.top), keys: r.keys, total: Number(r.total) }; });
    m.codeSendsHour = by.codeStartSiteHour ? by.codeStartSiteHour.top : 0;
    const ipRows = await sql`select count(*)::int as n from wts.rate_counters where window_start > now() - interval '1 hour' and bucket like 'codeStartIpHour:%' and n > 300`;
    m.ipSoftHits = ipRows[0].n;
    const burst = await sql`select count(*)::int as n from wts.rate_counters where window_start > now() - interval '1 hour' and bucket like 'commitBurst:%' and n > 10`;
    m.commitBursts = burst[0].n;
    const reads = await sql`select count(*)::int as n from wts.rate_counters where window_start > now() - interval '1 day' and bucket like 'projectsReadSessionDay:%' and n > 10`;
    m.readAnomalies = reads[0].n;
  });
  await q('outbox', async () => {
    const r = (await sql`select extract(epoch from (now() - min(created_at)))::float as s from wts.mail_outbox where sent_at is null`)[0];
    m.outboxAgeMin = r && r.s != null ? r.s / 60 : 0;
  });
  await q('deletion', async () => {
    const r = (await sql`select extract(epoch from (now() - min(delete_at)))::float as s from wts.users where status = 'deleting' and delete_at < now()`)[0];
    m.deletionLagHours = r && r.s != null ? r.s / 3600 : 0;
  });
  await q('storage', async () => {
    const plan = Number(env.WTS_STORAGE_PLAN_BYTES || 0);
    if (!(plan > 0)) throw new Error('no plan size');
    const r = (await sql`select coalesce(sum(used_bytes), 0)::float as b from wts.users`)[0];
    m.storageRatio = r.b / plan;
  });
  await q('subjects', async () => {
    const r = (await sql`select count(*)::int as n from (select subject_bidx from wts.identities group by subject_bidx having count(distinct user_id) > 1) s`)[0];
    m.subjectMultiLinked = r.n;
  });
  return { metrics: m, skipped };
}

async function check(o) {
  const env = o.env || process.env;
  const metrics = {}; const skipped = [];
  if (o.db) { const r = await dbMetrics(o.db.sql, env); Object.assign(metrics, r.metrics); skipped.push(...r.skipped); }
  if (env.WTS_HEALTH_URL && o.fetch) {
    try { const r = await o.fetch(env.WTS_HEALTH_URL, { headers: { 'X-WTS-App': 'monitor' } }); const j = r.ok ? await r.json() : null; metrics.healthDown = j && j.ok && j.db ? 0 : 1; }
    catch (e) { metrics.healthDown = 1; }
  }
  if (env.WTS_EXPORT_DIR) {
    const n = require('../site/backup').newestExport(env.WTS_EXPORT_DIR);
    metrics.exportAgeDays = n ? ((o.nowMs || Date.now()) - n.at) / 86400000 : 999;
  }
  if (o.lines) {
    const s = M.summarise(o.lines);
    Object.assign(metrics, { requests: s.requests, http5xxRate: s.http5xxRate, p95Ms: s.p95Ms, rate429: s.rate429, verifyFails: s.verifyFails });
    metrics.providerFailRate = {}; metrics.providerN = {};
    Object.keys(s.providerFinish).forEach((p) => { metrics.providerFailRate[p] = s.providerFinish[p].failRate; metrics.providerN[p] = s.providerFinish[p].n; });
  }
  const alerts = M.evaluate(metrics, o.baseline || {});
  if (metrics.healthDown) alerts.push({ id: 'health', value: 1, limit: 0, text: 'health endpoint down or database unreachable' });
  const sent = o.dry ? { logged: 0, posted: false } : await M.sendAlerts(alerts, { log: o.log, webhook: env.WTS_ALERT_WEBHOOK, email: env.WTS_ALERT_EMAIL, fetch: o.fetch, nowMs: o.nowMs });
  return { ok: true, metrics, skipped, alerts: alerts.map((a) => a.id), sent };
}

module.exports = { check, dbMetrics };

if (require.main === module) {
  (async () => {
    const a = process.argv.slice(2);
    const li = a.indexOf('--lines');
    const lines = li !== -1 ? fs.readFileSync(a[li + 1], 'utf8').split('\n').filter(Boolean) : null;
    let db = null;
    if (process.env.WTS_JOBS_DB_URL) db = require('../core/db').createDb(process.env.WTS_JOBS_DB_URL, { max: 1 });
    try {
      const r = await check({ db, lines, dry: a.includes('--dry'), fetch: typeof fetch === 'function' ? fetch : null, log: { warn: (m) => console.error(m) } });
      process.stdout.write(JSON.stringify(r) + '\n');
    } finally { if (db) await db.close(); }
  })().catch((e) => { process.stderr.write(JSON.stringify({ ok: false, error: String(e.message || e) }) + '\n'); process.exitCode = 1; });
}
