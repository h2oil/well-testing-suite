#!/usr/bin/env node
'use strict';
// server/ops/monitor-check.js — the hourly alert check of docs/ACCOUNTS-PLAN.md §13.6 (site/site.json "monitor-check").
// Computes every site/monitor.js RULE whose source is 'db', 'export', 'code' or (with --lines) 'lines', evaluates the rules
// and sends any alert as "alert:" log lines and one POST to WTS_ALERT_WEBHOOK (https). Rules with source 'log' arrive as
// "alert: <id>" lines through the host's log alerting; 'external' ones from the e-mail service (RUNBOOK §5).
//
//   WTS_JOBS_DB_URL=… [WTS_HEALTH_URL=https://welltest.h2oil.co.uk/api/v1/health] [WTS_EXPORT_DIR=…]
//   [WTS_STORAGE_PLAN_BYTES=…] [WTS_ALERT_WEBHOOK=…] [WTS_ALERT_EMAIL=…] node server/ops/monitor-check.js [--lines <file>] [--dry]
//
// Database metrics (DB_METRICS; jobs credential, each group optional — a group the credential cannot read is reported as
// skipped and its metrics are left out, never alerted):
//   counters  codeSendsHour, ipSoftHits, commitBursts, readAnomalies — rate_counters; thresholds from core/rate.js LIMITS
//   outbox    outboxAgeMin; mailBounceRate / mailDay — outbox messages of the last 24 h still unsent after every retry
//   deletion  deletionLagHours        storage  storageRatio (WTS_STORAGE_PLAN_BYTES)
//   subjects  subjectMultiLinked      links    linksHour (+ baseline = mean per hour over 7 days) — audit identity_link/unlink
//   provider  ceilingReached (exchange counters at the per-prefix ceiling, prefixes at the live-attempt ceiling) and
//             breakerOpen (breakers opened in the last hour) — the provider counters in rate_counters / oauth_attempts
//   audit     auditChainBad — core/jobs.js auditVerify (the daily job's chain check) re-run read-only
// Code: pinsFailed = core/oidc-providers.js checkPins() problems. Export: exportAgeDays. Lines: summarise() of access lines.
//
// Output: one JSON line {ok, metrics, skipped, alerts:[ids]} — counts only. Exit 0 also when alerts fire (they are
// delivered); 1 only when the check itself fails.

const fs = require('fs');
const M = require('../site/monitor');

// plan §8.3 values, used only when core/rate.js (the single source of the limits) is not in this build
const FALLBACK_LIMITS = { codeStartIpHour: { limit: 300 }, commitBurst: { limit: 10 }, projectsReadSessionDay: { limit: 10 } };
const CEILINGS = { exchanges10min: 30, liveAttempts: 20 };   // plan §8.3 provider callback / start ceilings
const MAIL_TRIES = 5;                                          // the daily job retries outbox rows while tries < 5
function limits() {
  try { const L = require('../core/rate').LIMITS; if (L && L.codeStartIpHour) return L; } catch (e) { if (!e || e.code !== 'MODULE_NOT_FOUND') throw e; }
  return FALLBACK_LIMITS;
}

// metric → group (the test checks that every RULE with source 'db' is produced here)
const DB_METRICS = {
  codeSendsHour: 'counters', ipSoftHits: 'counters', commitBursts: 'counters', readAnomalies: 'counters',
  outboxAgeMin: 'outbox', mailBounceRate: 'outbox', mailDay: 'outbox',
  deletionLagHours: 'deletion', storageRatio: 'storage', subjectMultiLinked: 'subjects', linksHour: 'links',
  ceilingReached: 'provider', breakerOpen: 'provider', auditChainBad: 'audit',
};

async function dbMetrics(sql, env) {
  const m = {}; const skipped = []; const baseline = {};
  const L = limits();
  const q = async (name, fn) => { try { await fn(); } catch (e) { skipped.push(name); } };
  await q('counters', async () => {
    const site = await sql`select coalesce(max(n), 0)::bigint as top from wts.rate_counters where window_start > now() - interval '1 hour' and bucket like 'codeStartSiteHour:%'`;
    m.codeSendsHour = Number(site[0].top);
    const ipRows = await sql`select count(*)::int as n from wts.rate_counters where window_start > now() - interval '1 hour' and bucket like 'codeStartIpHour:%' and n > ${L.codeStartIpHour.limit}`;
    m.ipSoftHits = ipRows[0].n;
    const burst = await sql`select count(*)::int as n from wts.rate_counters where window_start > now() - interval '1 hour' and bucket like 'commitBurst:%' and n > ${L.commitBurst.limit}`;
    m.commitBursts = burst[0].n;
    const reads = await sql`select count(*)::int as n from wts.rate_counters where window_start > now() - interval '1 day' and bucket like 'projectsReadSessionDay:%' and n > ${L.projectsReadSessionDay.limit}`;
    m.readAnomalies = reads[0].n;
  });
  await q('outbox', async () => {
    const r = (await sql`select extract(epoch from (now() - min(created_at)))::float as s from wts.mail_outbox where sent_at is null`)[0];
    m.outboxAgeMin = r && r.s != null ? r.s / 60 : 0;
    const d = (await sql`select count(*)::int as total, count(*) filter (where sent_at is null and tries >= ${MAIL_TRIES})::int as failed
      from wts.mail_outbox where created_at > now() - interval '24 hours'`)[0];
    m.mailDay = d.total;
    m.mailBounceRate = d.total ? d.failed / d.total : 0;
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
  await q('links', async () => {
    const r = (await sql`select count(*) filter (where at > now() - interval '1 hour')::int as hour, count(*)::int as week
      from wts.audit where action in ('identity_link', 'identity_unlink') and at > now() - interval '7 days'`)[0];
    m.linksHour = r.hour;
    baseline.linksHour = r.week / 168;
  });
  await q('provider', async () => {
    const ex = (await sql`select count(*)::int as n from wts.rate_counters where bucket like 'oauth_ex:%' and window_start > now() - interval '1 hour' and n >= ${CEILINGS.exchanges10min}`)[0];
    const live = (await sql`select count(*)::int as n from (select ip_prefix from wts.oauth_attempts where expires_at > now() and finished_at is null
      group by ip_prefix having count(*) >= ${CEILINGS.liveAttempts}) s`)[0];
    m.ceilingReached = ex.n + live.n;
    // an open breaker is stored as 'oauth_brk_open:<provider>' with window_start = the moment it closes (opened + 10 min)
    const brk = (await sql`select count(*)::int as n from wts.rate_counters where bucket like 'oauth_brk_open:%' and window_start > now() - interval '50 minutes'`)[0];
    m.breakerOpen = brk.n;
  });
  await q('audit', async () => {
    const jobs = require('../core/jobs');
    if (typeof jobs.auditVerify !== 'function') throw new Error('no chain check in this build');
    const v = await jobs.auditVerify(sql);
    m.auditChainBad = (v.bad ? v.bad.length : 0) + (v.broken ? v.broken.length : 0);
  });
  return { metrics: m, skipped, baseline };
}

function codeMetrics() {
  const m = {}; const skipped = [];
  try { m.pinsFailed = require('../core/oidc-providers').checkPins().length; } catch (e) { skipped.push('pins'); }
  return { metrics: m, skipped };
}

async function check(o) {
  const env = o.env || process.env;
  const metrics = {}; const skipped = []; const baseline = Object.assign({}, o.baseline || {});
  if (o.db) {
    const r = await dbMetrics(o.db.sql, env);
    Object.assign(metrics, r.metrics); skipped.push(...r.skipped);
    Object.keys(r.baseline).forEach((k) => { if (baseline[k] == null) baseline[k] = r.baseline[k]; });
  }
  const c = codeMetrics(); Object.assign(metrics, c.metrics); skipped.push(...c.skipped);
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
    Object.assign(metrics, { requests: s.requests, http5xxRate: s.http5xxRate, p95Ms: s.p95Ms, rate429: s.rate429, verifyFails: s.verifyFails, callbackOutcomes: s.callbackOutcomes });
    metrics.providerFailRate = {}; metrics.providerN = {};
    Object.keys(s.providerFinish).forEach((p) => { metrics.providerFailRate[p] = s.providerFinish[p].failRate; metrics.providerN[p] = s.providerFinish[p].n; });
  }
  const alerts = M.evaluate(metrics, baseline);
  if (metrics.healthDown) alerts.push({ id: 'health', value: 1, limit: 0, text: 'health endpoint down or database unreachable' });
  const sent = o.dry ? { logged: 0, posted: false } : await M.sendAlerts(alerts, { log: o.log, webhook: env.WTS_ALERT_WEBHOOK, email: env.WTS_ALERT_EMAIL, fetch: o.fetch, nowMs: o.nowMs });
  return { ok: true, metrics, skipped, alerts: alerts.map((a) => a.id), sent };
}

module.exports = { check, dbMetrics, codeMetrics, DB_METRICS, CEILINGS, limits };

if (require.main === module) {
  (async () => {
    const a = process.argv.slice(2);
    const li = a.indexOf('--lines');
    const lines = li !== -1 ? fs.readFileSync(a[li + 1], 'utf8').split('\n').filter(Boolean) : null;
    let db = null;
    if (process.env.WTS_JOBS_DB_URL) db = require('../core/db').createDb(process.env.WTS_JOBS_DB_URL, { max: 1, role: 'wts_jobs', sessionRole: true });
    try {
      const r = await check({ db, lines, dry: a.includes('--dry'), fetch: typeof fetch === 'function' ? fetch : null, log: { warn: (m) => console.error(m) } });
      process.stdout.write(JSON.stringify(r) + '\n');
    } finally { if (db) await db.close(); }
  })().catch((e) => { process.stderr.write(JSON.stringify({ ok: false, error: String(e.message || e) }) + '\n'); process.exitCode = 1; });
}
