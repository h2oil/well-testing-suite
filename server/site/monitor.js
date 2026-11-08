'use strict';
// server/site/monitor.js — monitoring and alert hooks of docs/ACCOUNTS-PLAN.md §13.6 (WP-OPS). Pure functions plus one
// sender; no timers (the hourly server/ops/monitor-check.js and the host's log alerting call them).
//
//   accessLine({rid, route, status, ms, ip, uid?, provider?, outcome?, err?}) → one JSON log line: the request id (made by
//        site/handler.js and returned to the client as X-WTS-Request-Id, so a user report can be matched), endpoint id
//        (never the raw path, which can hold project ids), status, latency, an IP PREFIX (IPv4 /24, IPv6 /48) and, from the
//        pipeline's res.meta, the user id, the provider, the callback outcome and the envelope error code. Never an address,
//        a code, a cookie, a body, a provider code, `state`, a token or a claim — the line has no field that could carry one.
//   redactLine(text) → a free-text log message with e-mail addresses, long tokens and query strings masked
//   summarise(lines) → metrics from access lines (requests, http5xxRate, p95Ms, rate429, verifyFails = codeVerify answered
//        invalid_or_expired, per-provider callback / finish failures, callback outcome counts)
//   RULES   the §13.6 alert table: {id, source, metric, op, limit, min?, text}. source says where the metric comes from:
//        'lines' summarise() of access lines (monitor-check --lines, or the host's log alerting on the same rule);
//        'db' ops/monitor-check.js DB_METRICS (jobs credential); 'export' the newest weekly export; 'code' computed by
//        monitor-check from the deployed code (provider pins); 'log' an "alert: <id>" line the site or a handler logs (the
//        host's log alerting forwards it; LOG_ALERTS); 'external' the e-mail service's own alerting (RUNBOOK §5).
//   evaluate(metrics, baseline?) → [{id, value, limit, text}]   (a metric that is absent is skipped, never alerted)
//   sendAlerts(alerts, {log, webhook, fetch, nowMs}) → Promise<{logged, posted}>  ("alert: …" log lines + one https POST)

const crypto = require('crypto');

function ipPrefix(ip) {
  const s = String(ip || '').trim().replace(/^::ffff:/i, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s.split('.').slice(0, 3).join('.') + '.0/24';
  if (s.indexOf(':') !== -1) {
    const full = s.split('%')[0];
    const head = full.split('::')[0].split(':').filter(Boolean);
    const tail = full.indexOf('::') !== -1 ? [] : full.split(':').slice(3);
    const parts = head.concat(tail).slice(0, 3);
    while (parts.length < 3) parts.push('0');
    return parts.map((p) => p.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/48';
  }
  return 'unknown';
}
const ROUTE_RE = /^[a-zA-Z][a-zA-Z0-9]{0,40}$/;
function accessLine(o) {
  const rec = {
    t: 'access',
    rid: /^[A-Za-z0-9_-]{6,64}$/.test(String(o.rid || '')) ? o.rid : crypto.randomBytes(8).toString('hex'),
    route: ROUTE_RE.test(String(o.route || '')) ? o.route : 'unmatched',
    status: Number(o.status) | 0,
    ms: Math.max(0, Math.round(Number(o.ms) || 0)),
    ipp: ipPrefix(o.ip),
  };
  if (o.uid && /^[0-9a-f-]{36}$/.test(String(o.uid))) rec.uid = o.uid;
  if (o.provider && /^(google|linkedin)$/.test(o.provider)) rec.provider = o.provider;
  if (o.outcome && /^[a-z_]{1,24}$/.test(String(o.outcome))) rec.outcome = o.outcome;
  if (o.err && /^[a-z_]{1,32}$/.test(String(o.err))) rec.err = o.err;
  return JSON.stringify(rec);
}
function redactLine(text) {
  return String(text == null ? '' : text)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\?[^\s]*/g, '?<query>')
    .replace(/\b[A-Za-z0-9+/_=-]{24,}\b/g, '<token>')
    .replace(/\b\d{6}\b/g, '<code>');
}

function pct(sorted, p) { if (!sorted.length) return 0; const i = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1); return sorted[Math.max(0, i)]; }
function summarise(lines, o) {
  o = o || {};
  const recs = [];
  (lines || []).forEach((l) => { try { const r = typeof l === 'string' ? JSON.parse(l) : l; if (r && r.t === 'access') recs.push(r); } catch (e) { /* not ours */ } });
  const n = recs.length;
  const ms = recs.map((r) => r.ms).sort((a, b) => a - b);
  const count = (f) => recs.filter(f).length;
  // a provider failure: a callback whose outcome is not ok (the callback is always a 303), or a finish that answered 5xx or
  // oauth_failed / oauth_state (a user-side refusal such as not_invited or consent_required is not a provider failure)
  const providerFail = (r) => (r.route === 'oauthCallback' ? r.outcome !== 'ok'
    : (r.status >= 500 || r.err === 'oauth_failed' || r.err === 'oauth_state'));
  const cb = {};
  ['google', 'linkedin'].forEach((p) => {
    const all = recs.filter((r) => (r.route === 'oauthFinish' || r.route === 'oauthCallback') && r.provider === p);
    if (all.length) cb[p] = { n: all.length, failRate: all.filter(providerFail).length / all.length };
  });
  const outcomes = {};
  recs.filter((r) => r.route === 'oauthCallback').forEach((r) => { const k = r.outcome || 'unknown'; outcomes[k] = (outcomes[k] || 0) + 1; });
  return {
    requests: n,
    http5xxRate: n ? count((r) => r.status >= 500) / n : 0,
    p95Ms: pct(ms, 0.95),
    rate429: count((r) => r.status === 429),
    verifyFails: count((r) => r.route === 'codeVerify' && r.err === 'invalid_or_expired'),
    codeStarts: count((r) => r.route === 'codeStart' && r.status < 400),
    providerFinish: cb,
    callbackOutcomes: outcomes,
  };
}

// §13.6 — every alert the owner receives by mail / hook
const RULES = [
  { id: 'http5xx', source: 'lines', metric: 'http5xxRate', op: '>', limit: 0.02, minMetric: 'requests', min: 50, text: '5xx above 2 % over 10 min' },
  { id: 'latency', source: 'lines', metric: 'p95Ms', op: '>', limit: 2000, minMetric: 'requests', min: 20, text: 'p95 latency above 2 s' },
  { id: 'codeSends', source: 'db', metric: 'codeSendsHour', op: '>', limit: 300, text: 'code sends above 300 / h' },
  { id: 'verifyFails', source: 'lines', metric: 'verifyFails', op: '>x', limit: 5, base: 'verifyFails', min: 10, text: 'failed verifies above 5 × baseline' },
  { id: 'rate429', source: 'lines', metric: 'rate429', op: '>x', limit: 5, base: 'rate429', min: 20, text: '429 spike' },
  { id: 'ipSoft', source: 'db', metric: 'ipSoftHits', op: '>', limit: 0, text: 'per-IP soft limit reached' },
  { id: 'readAnomaly', source: 'db', metric: 'readAnomalies', op: '>', limit: 0, text: 'read anomaly notices' },
  { id: 'commitBurst', source: 'db', metric: 'commitBursts', op: '>', limit: 0, text: 'commit bursts' },
  { id: 'storage', source: 'db', metric: 'storageRatio', op: '>', limit: 0.8, text: 'storage above 80 % of the plan' },
  { id: 'bounce', source: 'db', metric: 'mailBounceRate', op: '>', limit: 0.05, minMetric: 'mailDay', min: 20, text: 'mail bounce rate above 5 % (outbox messages the e-mail service refused after every retry)' },
  { id: 'complaint', source: 'external', metric: 'mailComplaintRate', op: '>', limit: 0.001, text: 'mail complaint rate above 0.1 % (reported by the e-mail service; RUNBOOK §5)' },
  { id: 'deletionLag', source: 'db', metric: 'deletionLagHours', op: '>', limit: 24, text: 'deletion job lagging more than a day' },
  { id: 'outboxAge', source: 'db', metric: 'outboxAgeMin', op: '>', limit: 5, text: 'mail outbox older than 5 min' },
  { id: 'providerGoogle', source: 'lines', metric: 'providerFailRate.google', op: '>', limit: 0.2, minMetric: 'providerN.google', min: 10, text: 'Google callbacks / code exchanges failing above 20 % over 30 min' },
  { id: 'providerLinkedin', source: 'lines', metric: 'providerFailRate.linkedin', op: '>', limit: 0.2, minMetric: 'providerN.linkedin', min: 10, text: 'LinkedIn callbacks / code exchanges failing above 20 % over 30 min' },
  { id: 'jwksFetch', source: 'log', metric: 'jwksFetchFailures', op: '>', limit: 0, text: 'signing-key fetch failures' },
  { id: 'unknownKid', source: 'log', metric: 'unknownKidRefetches', op: '>', limit: 3, text: 'unknown-kid refetches' },
  { id: 'breaker', source: 'db', metric: 'breakerOpen', op: '>', limit: 0, text: 'a provider breaker opened' },
  { id: 'ceiling', source: 'db', metric: 'ceilingReached', op: '>', limit: 0, text: 'per-prefix callback or attempt ceiling reached' },
  { id: 'linkSpike', source: 'db', metric: 'linksHour', op: '>x', limit: 5, base: 'linksHour', min: 10, text: 'link / unlink spike' },
  { id: 'subjectMulti', source: 'db', metric: 'subjectMultiLinked', op: '>', limit: 0, text: 'one provider subject linked to more than one account' },
  { id: 'pins', source: 'code', metric: 'pinsFailed', op: '>', limit: 0, text: 'production provider pins failed at start-up' },
  { id: 'isolation', source: 'log', metric: 'isolationProblems', op: '>', limit: 0, text: 'environment isolation check failed (site serves nothing)' },
  { id: 'auditChain', source: 'db', metric: 'auditChainBad', op: '>', limit: 0, text: 'audit hash chain check failed' },
  { id: 'exportAge', source: 'export', metric: 'exportAgeDays', op: '>', limit: 8, text: 'no weekly encrypted export in the last 8 days' },
];
const SOURCES = ['lines', 'db', 'export', 'code', 'log', 'external'];
// "alert: <id> — text" log lines (the host's log alerting forwards every line starting "alert: "; RUNBOOK §5). Rules with
// source 'log' are listed here with the code that logs them; the other ids are extra log-only alerts of the site itself.
const LOG_ALERTS = {
  isolation: 'site/handler.js at start-up (site/isolation.js problems; the site then serves only /health)',
  pins: 'site/handler.js at start-up (core/config.js provider-pin alerts) — also computed hourly by monitor-check',
  jwksFetch: 'the provider signing-key cache (core/oidc.js) on a failed key fetch',
  unknownKid: 'the provider signing-key cache (core/oidc.js) above the unknown-kid refetch limit',
  breaker: 'functions/oauth.js when a provider breaker opens — also counted from the database by monitor-check',
  auditChain: 'the daily job (core/jobs.js anchor step) — also checked hourly by monitor-check',
  config: 'site/handler.js at start-up (other core/config.js alerts)',
  objects: 'site/handler.js at start-up (a configured blob store binding that cannot be loaded)',
  adapter: 'site/handler.js when the adapter itself fails (500)',
};
function getPath(o, p) { return p.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o); }
function evaluate(metrics, baseline) {
  metrics = metrics || {}; baseline = baseline || {};
  const out = [];
  RULES.forEach((r) => {
    const v = getPath(metrics, r.metric);
    if (typeof v !== 'number' || !isFinite(v)) return;
    if (r.minMetric) { const m = getPath(metrics, r.minMetric); if (!(typeof m === 'number' && m >= r.min)) return; }
    let limit = r.limit;
    if (r.op === '>x') {
      const b = getPath(baseline, r.base);
      limit = Math.max(r.min || 0, (typeof b === 'number' && b > 0 ? b : 0) * r.limit);
    }
    if (v > limit) out.push({ id: r.id, value: Math.round(v * 1000) / 1000, limit, text: r.text });
  });
  return out;
}

async function sendAlerts(alerts, o) {
  o = o || {};
  const log = o.log || { warn() {} };
  let posted = false;
  alerts.forEach((a) => log.warn('alert: ' + a.id + ' ' + a.value + ' > ' + a.limit + ' — ' + a.text));
  const hook = o.webhook ? String(o.webhook) : '';
  if (alerts.length && hook) {
    if (!/^https:\/\/[^\s]+$/.test(hook)) { log.warn('alert: WTS_ALERT_WEBHOOK is not an https URL — not sent'); return { logged: alerts.length, posted }; }
    const f = o.fetch || (typeof fetch === 'function' ? fetch : null);
    if (f) {
      try {
        const r = await f(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'wts-accounts', at: new Date(o.nowMs || Date.now()).toISOString(), to: o.email || undefined, alerts }) });
        posted = !!(r && r.ok);
        if (!posted) log.warn('alert: hook answered ' + (r && r.status));
      } catch (e) { log.warn('alert: hook unreachable'); }
    }
  }
  return { logged: alerts.length, posted };
}

module.exports = { ipPrefix, accessLine, redactLine, summarise, RULES, SOURCES, LOG_ALERTS, evaluate, sendAlerts };
