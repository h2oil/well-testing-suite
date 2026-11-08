'use strict';
// server/core/rate.js — the rate limits of docs/ACCOUNTS-PLAN.md §8.3 / D21: database counters in fixed windows (definer
// wts.rate_add), no timers. Per user AND per session, never per client-supplied id; per IP prefix only SOFT (alert, never a
// refusal), so a rig or an office behind one address is never locked out. Buckets carry keyed indexes (never an address).
//
//   LIMITS            {name: {window (s), limit, soft?}}
//   hit(sql, name, key, amount=1) → {allowed, n, retryAfter, limit}   (soft limits: allowed is always true, over = n > limit)
//   peek(sql, name, key)          → the same without counting
//   enforce(sql, name, key, amount) → throws 429 rate {retryAfter} when a hard limit is exceeded

const { ApiError } = require('./errors');

const H = 3600; const D = 86400;
const MB = 1000 * 1000;
const LIMITS = {
  codeStartAddrHour: { window: H, limit: 5 },
  codeStartAddrDay: { window: D, limit: 20 },
  codeStartIpHour: { window: H, limit: 300, soft: true },
  codeStartSiteHour: { window: H, limit: 1000, soft: true },        // above it: no sends to unknown addresses (breaker)
  codeVerifyFailDay: { window: D, limit: 10, soft: true },          // reached → codes for the address paused 1 h
  codePauseHour: { window: H, limit: 0, soft: true },               // n > 0 = paused
  commitUserHour: { window: H, limit: 120 },
  commitUserDay: { window: D, limit: 600 },
  commitSessionHour: { window: H, limit: 60 },
  commitBurst: { window: 600, limit: 10, soft: true },              // > 10 in 10 min pins the previous revision
  chunkPutUserDay: { window: D, limit: 2000 * MB },
  blobReadUserHour: { window: H, limit: 100 * MB },
  blobReadUserHourUnlocked: { window: H, limit: 300 * MB },        // the session that ran an export step-up (2 h)
  blobReadUserDay: { window: D, limit: 300 * MB },
  blobReadSessionHour: { window: H, limit: 100 * MB },
  blobReadSessionHourUnlocked: { window: H, limit: 300 * MB },
  blobReadSessionDay: { window: D, limit: 1e15, soft: true },       // only for the read-anomaly notice (§8.3)
  projectReadSessionDay: { window: D, limit: 1, soft: true },       // first read of a project today (distinct count)
  projectsReadSessionDay: { window: D, limit: 10, soft: true },     // > 10 distinct projects → notice
  exportUserDay: { window: D, limit: 5 },
  noticeOnceDay: { window: D, limit: 1, soft: true },               // one security notice of a kind per user per day
  cspIpHour: { window: H, limit: 120 },
  cspCountDay: { window: D, limit: 1e15, soft: true },              // aggregate counts per directive and blocked host
  mailEmailChangeHour: { window: H, limit: 5 },
};

async function call(sql, name, key, amount) {
  const L = LIMITS[name];
  if (!L) throw new Error('rate: unknown limit ' + name);
  const bucket = name + ':' + key;
  const r = (await sql`select * from wts.rate_add(${bucket}, ${L.window + ' seconds'}::interval, ${L.limit}, ${amount})`)[0];
  const n = Number(r.n);
  return { allowed: L.soft ? true : r.allowed, over: n > L.limit, n, retryAfter: r.retry_after, limit: L.limit };
}
function hit(sql, name, key, amount) { return call(sql, name, key, amount == null ? 1 : amount); }
function peek(sql, name, key) { return call(sql, name, key, 0); }
async function enforce(sql, name, key, amount) {
  const r = await hit(sql, name, key, amount);
  if (!r.allowed) throw new ApiError('rate', { retryAfter: r.retryAfter });
  return r;
}

module.exports = { LIMITS, hit, peek, enforce, MB };
