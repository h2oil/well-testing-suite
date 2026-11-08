'use strict';
// server/site/monitor.js — monitoring and alert hooks of docs/ACCOUNTS-PLAN.md §13.6 (WP-OPS). Pure functions plus one
// sender; no timers (the hourly server/ops/monitor-check.js and the host's log alerting call them).
//
//   accessLine({rid, route, status, ms, ip}) → one JSON log line: request id, endpoint id (never the raw path, which can
//        hold project ids), status, latency and an IP PREFIX (IPv4 /24, IPv6 /48). Never an address, a code, a cookie, a
//        body, a provider code, `state`, a token or a claim — the line has no field that could carry one.
//   redactLine(text) → a free-text log message with e-mail addresses, long tokens and query strings masked
//   summarise(lines, {nowMs, windowMs}) → metrics from access lines (requests, http5xxRate, p95Ms, rate429, callback failures …)
//   RULES   the §13.6 alert table: {id, metric, op, limit, min?, text}
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
  const cb = {};
  ['google', 'linkedin'].forEach((p) => {
    const all = recs.filter((r) => r.route === 'oauthFinish' && r.provider === p);
    if (all.length) cb[p] = { n: all.length, failRate: all.filter((r) => r.status >= 400).length / all.length };
  });
  return {
    requests: n,
    http5xxRate: n ? count((r) => r.status >= 500) / n : 0,
    p95Ms: pct(ms, 0.95),
    rate429: count((r) => r.status === 429),
    verifyFails: count((r) => r.route === 'codeVerify' && r.status === 400),
    codeStarts: count((r) => r.route === 'codeStart' && r.status < 400),
    providerFinish: cb,
  };
}

// §13.6 — every alert the owner receives by mail / hook
const RULES = [
  { id: 'http5xx', metric: 'http5xxRate', op: '>', limit: 0.02, minMetric: 'requests', min: 50, text: '5xx above 2 % over 10 min' },
  { id: 'latency', metric: 'p95Ms', op: '>', limit: 2000, minMetric: 'requests', min: 20, text: 'p95 latency above 2 s' },
  { id: 'codeSends', metric: 'codeSendsHour', op: '>', limit: 300, text: 'code sends above 300 / h' },
  { id: 'verifyFails', metric: 'verifyFails', op: '>x', limit: 5, base: 'verifyFails', min: 10, text: 'failed verifies above 5 × baseline' },
  { id: 'rate429', metric: 'rate429', op: '>x', limit: 5, base: 'rate429', min: 20, text: '429 spike' },
  { id: 'ipSoft', metric: 'ipSoftHits', op: '>', limit: 0, text: 'per-IP soft limit reached' },
  { id: 'readAnomaly', metric: 'readAnomalies', op: '>', limit: 0, text: 'read anomaly notices' },
  { id: 'commitBurst', metric: 'commitBursts', op: '>', limit: 0, text: 'commit bursts' },
  { id: 'storage', metric: 'storageRatio', op: '>', limit: 0.8, text: 'storage above 80 % of the plan' },
  { id: 'bounce', metric: 'mailBounceRate', op: '>', limit: 0.05, text: 'mail bounce rate above 5 %' },
  { id: 'complaint', metric: 'mailComplaintRate', op: '>', limit: 0.001, text: 'mail complaint rate above 0.1 %' },
  { id: 'deletionLag', metric: 'deletionLagHours', op: '>', limit: 24, text: 'deletion job lagging more than a day' },
  { id: 'outboxAge', metric: 'outboxAgeMin', op: '>', limit: 5, text: 'mail outbox older than 5 min' },
  { id: 'providerGoogle', metric: 'providerFailRate.google', op: '>', limit: 0.2, minMetric: 'providerN.google', min: 10, text: 'Google callbacks / code exchanges failing above 20 % over 30 min' },
  { id: 'providerLinkedin', metric: 'providerFailRate.linkedin', op: '>', limit: 0.2, minMetric: 'providerN.linkedin', min: 10, text: 'LinkedIn callbacks / code exchanges failing above 20 % over 30 min' },
  { id: 'jwksFetch', metric: 'jwksFetchFailures', op: '>', limit: 0, text: 'signing-key fetch failures' },
  { id: 'unknownKid', metric: 'unknownKidRefetches', op: '>', limit: 3, text: 'unknown-kid refetches' },
  { id: 'breaker', metric: 'breakerOpen', op: '>', limit: 0, text: 'a provider breaker opened' },
  { id: 'ceiling', metric: 'ceilingReached', op: '>', limit: 0, text: 'per-prefix callback or attempt ceiling reached' },
  { id: 'linkSpike', metric: 'linksHour', op: '>x', limit: 5, base: 'linksHour', min: 10, text: 'link / unlink spike' },
  { id: 'subjectMulti', metric: 'subjectMultiLinked', op: '>', limit: 0, text: 'one provider subject linked to more than one account' },
  { id: 'pins', metric: 'pinsFailed', op: '>', limit: 0, text: 'production provider pins failed at start-up' },
  { id: 'isolation', metric: 'isolationProblems', op: '>', limit: 0, text: 'environment isolation check failed (site serves nothing)' },
  { id: 'auditChain', metric: 'auditChainBad', op: '>', limit: 0, text: 'audit hash chain check failed' },
  { id: 'exportAge', metric: 'exportAgeDays', op: '>', limit: 8, text: 'no weekly encrypted export in the last 8 days' },
];
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

module.exports = { ipPrefix, accessLine, redactLine, summarise, RULES, evaluate, sendAlerts };
