'use strict';
// server/functions/health.js — GET /health (no auth): {ok, db, ver} (docs/ACCOUNTS-PLAN.md §3.3, §13.6 uptime check).

module.exports = {
  handlers: {
    async health(ctx) {
      let db = false;
      if (ctx.db && typeof ctx.db.ping === 'function') { try { db = (await ctx.db.ping()) === true; } catch (e) { db = false; } }
      return { status: 200, body: { ok: true, db, ver: String(ctx.config.version) } };
    },
  },
};
