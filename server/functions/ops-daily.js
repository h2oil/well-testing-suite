'use strict';
// server/functions/ops-daily.js — POST /ops/daily (docs/ACCOUNTS-PLAN.md §3.2 exception, §3.5): no cookie; the HMAC over
// method, path, timestamp and nonce is checked by core/app.js before this runs (±5 min, nonce once in 10 min). The jobs of
// §3.5 run as wts_jobs with their own credential: the deployment passes `jobs` to createApp only in the scheduled function
// (loadJobsConfig + core/jobs.js); a request-handler instance has none and answers {ok, did:{skipped}} without touching data.

module.exports = {
  handlers: {
    async opsDaily(ctx) {
      if (!ctx.jobs || typeof ctx.jobs.run !== 'function') return { status: 200, body: { ok: true, did: { skipped: 'no jobs credential in this function' } } };
      const did = await ctx.jobs.run();
      return { status: 200, body: { ok: true, did } };
    },
  },
};
