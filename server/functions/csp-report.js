'use strict';
// server/functions/csp-report.js — POST /csp-report (docs/ACCOUNTS-PLAN.md §3.2 exception, §8.2): no auth, no cookie read,
// application/csp-report or application/reports+json, body ≤ 16 kB (core/http.js caps it). WP-OPS stores only aggregate
// counts per directive and blocked host; the foundation accepts and drops the report.

module.exports = {
  handlers: {
    cspReport() { return { status: 204 }; },
  },
};
