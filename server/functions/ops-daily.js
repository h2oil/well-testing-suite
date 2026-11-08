'use strict';
// server/functions/ops-daily.js — POST /ops/daily (docs/ACCOUNTS-PLAN.md §3.2 exception, §3.5): no cookie; the HMAC over
// method, path, timestamp and nonce is checked by core/app.js before this runs (±5 min, nonce once in 10 min). The jobs of
// §3.5 run as wts_jobs with their own credential (loadJobsConfig) — WP-S1 / WP-OPS. Foundation: 501 not_implemented.

const { fail } = require('../core/errors');

module.exports = {
  handlers: {
    opsDaily() { fail('not_implemented'); },
  },
};
