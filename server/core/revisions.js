'use strict';
// server/core/revisions.js — revision retention (docs/ACCOUNTS-PLAN.md §3.4 "Revisions kept", §8.5): pure planning, shared by
// the commit transaction (≤ 10 rows per request) and the daily job. The SQL side only deletes what the plan names.
//
//   planPrune(revs, {now, head, protect:Set<rev>, max}) → [rev to delete], oldest first
//     revs: [{rev, reason, savedAt (ms), pinnedUntil (ms|null)}]
//   Kept: the head; every revision a device still uses as its base (devices.last_base_rev — never pruned); a pinned one
//   (burst pin, 7 days); every non-'auto' revision (save, migrate, restore, overwrite, conflict, import) for 30 days;
//   'auto' revisions: the newest of each 10-minute bucket for the last 24 h, the newest of each UTC day for 30 days.

const MIN = 60 * 1000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
const KEEP_NAMED = 30 * DAY; const KEEP_TEN_MIN = DAY; const KEEP_DAILY = 30 * DAY;
const BURST_PIN = 7 * DAY;

function planPrune(revs, o) {
  const now = o.now; const head = o.head; const protect = o.protect || new Set(); const max = o.max == null ? Infinity : o.max;
  const keep = new Set();
  const autos = [];
  for (const r of revs) {
    if (r.rev === head || protect.has(r.rev) || (r.pinnedUntil && r.pinnedUntil > now)) { keep.add(r.rev); continue; }
    const age = now - r.savedAt;
    if (r.reason !== 'auto') { if (age <= KEEP_NAMED) keep.add(r.rev); continue; }
    if (age <= KEEP_DAILY) autos.push(r);
  }
  // newest per bucket: walk newest first
  const seen = new Set();
  autos.slice().sort((a, b) => b.savedAt - a.savedAt || b.rev - a.rev).forEach((r) => {
    const age = now - r.savedAt;
    const b = age <= KEEP_TEN_MIN ? 't' + Math.floor(r.savedAt / (10 * MIN)) : 'd' + Math.floor(r.savedAt / DAY);
    if (!seen.has(b)) { seen.add(b); keep.add(r.rev); }
  });
  return revs.filter((r) => !keep.has(r.rev)).map((r) => r.rev).sort((a, b) => a - b).slice(0, max);
}

module.exports = { planPrune, BURST_PIN, KEEP_NAMED, KEEP_DAILY, KEEP_TEN_MIN };
