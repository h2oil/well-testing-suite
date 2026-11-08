'use strict';
// server/functions/csp-report.js — POST /csp-report (docs/ACCOUNTS-PLAN.md §3.2 exception, §8.2): no auth, no cookie read,
// application/csp-report or application/reports+json, body ≤ 16 kB (core/http.js caps it), a strict per-prefix limit
// (429). Only AGGREGATE counts per directive and blocked host are kept (rate counters of one day, kept 7 days) — never the
// page URL, the full blocked URL, a sample, an address or a cookie. Without a database the report is accepted and dropped.

const { ApiError } = require('../core/errors');
const R = require('../core/rate');

const DIRECTIVE = /^[a-z-]{1,40}$/;
function hostOf(u) {
  const s = String(u || '').trim().toLowerCase();
  if (!s) return 'none';
  if (/^(inline|eval|wasm-eval|data|blob|self|trusted-types-policy|trusted-types-sink)$/.test(s)) return s;
  try { const h = new URL(s).host; return /^[a-z0-9.:[\]-]{1,100}$/.test(h) ? h : 'other'; } catch (e) { return /^[a-z-]{1,20}:?$/.test(s) ? s.replace(/:$/, '') : 'other'; }
}
function reports(body) {
  const out = [];
  const add = (dir, blocked) => { const d = String(dir || '').toLowerCase().split(' ')[0]; out.push({ d: DIRECTIVE.test(d) ? d : 'other', h: hostOf(blocked) }); };
  if (Array.isArray(body)) body.slice(0, 20).forEach((r) => { const b = r && r.body; if (r && r.type === 'csp-violation' && b) add(b.effectiveDirective || b.violatedDirective, b.blockedURL); });
  else if (body && body['csp-report']) { const r = body['csp-report']; add(r['effective-directive'] || r['violated-directive'], r['blocked-uri']); }
  return out;
}

module.exports = {
  handlers: {
    async cspReport(ctx) {
      if (!ctx.db) return { status: 204 };
      let body = null;
      try { body = ctx.raw && ctx.raw.length ? JSON.parse(ctx.raw.toString('utf8')) : null; } catch (e) { body = null; }
      const list = reports(body);
      await ctx.db.anon(async (tx) => {
        const ip = await R.hit(tx, 'cspIpHour', ctx.ipPrefix || 'unknown');
        if (!ip.allowed) throw new ApiError('rate', { retryAfter: ip.retryAfter });
        for (const r of list) await R.hit(tx, 'cspCountDay', r.d + '|' + r.h);
      });
      return { status: 204 };
    },
  },
  _internal: { reports, hostOf },
};
