'use strict';
// server/functions/projects.js — Cloud projects (docs/ACCOUNTS-PLAN.md §3.3 Projects, D5, D6, §3.4 revisions): list,
// create, head, revisions, commit (compare-and-swap on the head revision under a row lock, pushId receipts, inline core,
// missing blobs, vhash no-op, quota, burst pin, in-transaction squash ≤ 10 rows), rename, trash, restore, purge (step-up),
// restore a revision, duplicate. WP-S1.
//
// The server never parses well data: it stores encrypted bodies, checks sizes, ownership, revisions and quotas, and keeps
// the project list metadata envelope-encrypted (projects.meta_enc). Every row is reached under RLS as the session's user;
// a project of another account answers exactly like a missing one (404).

const { fail, ApiError } = require('../core/errors');
const S = require('../core/service');
const SE = require('../core/session');
const R = require('../core/rate');
const B = require('../core/blobstore');
const { planPrune, BURST_PIN } = require('../core/revisions');

const META = 'project.meta';
const CORE = 'project.core';
const MAX_PROJECTS = 200;
const iso = (d) => (d == null ? null : new Date(d).toISOString());
const hex = (b) => (b == null ? null : Buffer.from(b).toString('hex'));

// X-WTS-App below the security minimum → 426 (only ever raised for a security fix, never for a format change; §3.2)
function verNum(v) { const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v || '')); return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null; }
function clientGate(ctx) {
  const got = verNum(require('../core/http').header(ctx.req, 'x-wts-app')); const min = verNum(ctx.config.minClient);
  if (!got || !min) return;
  for (let i = 0; i < 3; i++) { if (got[i] > min[i]) return; if (got[i] < min[i]) throw new ApiError('upgrade'); }
}

function openMeta(u, enc) {
  try { const m = JSON.parse(u.open(META, enc)); return { name: String(m.name || ''), meta: { client: m.client || '', well: m.well || '', field: m.field || '', operator: m.operator || '' } }; }
  catch (e) { return { name: '', meta: { client: '', well: '', field: '', operator: '' } }; }
}
const sealMeta = (u, name, meta) => u.seal(META, JSON.stringify({ name, client: meta.client || '', well: meta.well || '', field: meta.field || '', operator: meta.operator || '' }));

async function projectRow(unit, id, o) {
  o = o || {};
  if (!S.UUID_RE.test(String(id))) fail('not_found');
  const r = o.lock
    ? (await unit.sql`select * from wts.projects where id = ${id} and user_id = ${unit.userId} for update`)[0]
    : (await unit.sql`select * from wts.projects where id = ${id} and user_id = ${unit.userId}`)[0];
  if (!r) fail('not_found');
  if (r.deleted_at && !o.trash) fail('gone');
  return r;
}
function revBody(r, inline) {
  if (!r) return { rev: 0, savedAt: null, device: null, coreHash: null, vhash: null, parts: [], bytes: 0 };
  const b = { rev: Number(r.rev), savedAt: iso(r.saved_at), device: r.device_id || null, coreHash: hex(r.core_hash), vhash: hex(r.vhash),
    parts: (r.parts || []).map((p) => ({ name: p.name, hash: p.hash, bytes: Number(p.bytes) })), bytes: Number(r.bytes) };
  if (inline) b.coreInline = inline;
  return b;
}
async function headBody(unit, ctx, u, p) {
  if (!Number(p.head_rev)) return revBody(null);
  const r = (await unit.sql`select * from wts.revisions where project_id = ${p.id} and rev = ${p.head_rev}`)[0];
  // coreInline whenever the core is ≤ 48 kB gzip: committed inline, or uploaded as a one-chunk blob
  const inline = p.head_core ? u.open(CORE, p.head_core) : (r ? await B.inlineOf(unit, ctx, u, hex(r.core_hash)) : null);
  return revBody(r, inline);
}
const revHashes = (r) => [hex(r.core_hash)].concat((r.parts || []).map((p) => p && p.hash).filter((h) => /^[0-9a-f]{64}$/.test(String(h))));
const revItem = (r) => ({ rev: Number(r.rev), savedAt: iso(r.saved_at), device: r.device_id || null, reason: r.reason, bytes: Number(r.bytes), coreHash: hex(r.core_hash) });

// keep ≤ max rows per call (§3.4): the plan of core/revisions.js over this project's revisions
async function prune(unit, pid, head, max) {
  const revs = (await unit.sql`select rev, reason, saved_at, pinned_until from wts.revisions where project_id = ${pid} and user_id = ${unit.userId}`)
    .map((r) => ({ rev: Number(r.rev), reason: r.reason, savedAt: +r.saved_at, pinnedUntil: r.pinned_until ? +r.pinned_until : null }));
  const bases = new Set((await unit.sql`select (last_base_rev->>${pid}::text)::bigint as rev from wts.devices where user_id = ${unit.userId} and last_base_rev ? ${pid}::text`)
    .map((r) => Number(r.rev)));
  const drop = planPrune(revs, { now: Date.now(), head: Number(head), protect: bases, max });
  if (drop.length) await unit.sql`delete from wts.revisions where project_id = ${pid} and rev = any(${unit.sql.array(drop)}::bigint[])`;
  return drop;
}
async function noteBase(unit, s, pid, rev) {
  if (!s.deviceId) return;
  await unit.sql`update wts.devices set last_sync_at = now(), last_base_rev = coalesce(last_base_rev, '{}'::jsonb) || jsonb_build_object(${pid}::text, ${rev}::bigint)
    where user_id = ${unit.userId} and device_id = ${s.deviceId}`;
}
async function receipt(unit, pushId) {
  const r = (await unit.sql`select result from wts.push_receipts where user_id = ${unit.userId} and push_id = ${pushId}`)[0];
  return r ? r.result : null;
}
async function keepReceipt(unit, pushId, result) {
  await unit.sql`insert into wts.push_receipts (user_id, push_id, result, at) values (${unit.userId}, ${pushId}, ${unit.sql.json(result)}, now()) on conflict do nothing`;
}
async function commitRateLimits(unit, s) {
  await R.enforce(unit.sql, 'commitUserHour', s.userId);
  await R.enforce(unit.sql, 'commitUserDay', s.userId);
  await R.enforce(unit.sql, 'commitSessionHour', s.hash.toString('hex').slice(0, 32));
}
// a burst (> 10 commits in 10 min on a project) pins the previous revision for 7 days; one notice per day
async function burst(unit, ctx, u, pid, prevRev) {
  const b = await R.hit(unit.sql, 'commitBurst', pid);
  if (!b.over || !prevRev) return;
  await unit.sql`update wts.revisions set pinned = true, pinned_until = greatest(coalesce(pinned_until, now()), now() + ${BURST_PIN / 1000 + ' seconds'}::interval)
    where project_id = ${pid} and rev = ${prevRev}`;
  const once = await R.hit(unit.sql, 'noticeOnceDay', 'burst:' + unit.userId);
  if (once.n === 1) {
    await unit.mail(u.open('user.address', u.row.email_enc), 'notice_commit_burst', { at: S.whenText(Date.now()) });
    await unit.audit('commit_burst', { target: pid });
  }
}

async function projectList(ctx) {
  S.syncGate(ctx, false);
  const trash = ctx.query.trash === '1';
  const body = await SE.withSession(ctx, {}, async (unit) => {
    const u = await unit.user();
    const rows = await unit.sql`select p.*, r.saved_at as head_saved, r.device_id as head_device from wts.projects p
      left join wts.revisions r on r.project_id = p.id and r.rev = p.head_rev
      where p.user_id = ${unit.userId} and (p.deleted_at is not null) = ${trash} order by p.modified_at desc limit ${MAX_PROJECTS}`;
    return rows.map((p) => {
      const m = openMeta(u, p.meta_enc);
      const it = { id: p.id, name: m.name, meta: m.meta, wells: p.well_count, headRev: Number(p.head_rev), savedAt: iso(p.head_saved),
        savedBy: { device: p.head_device || null }, bytes: Number(p.head_bytes) };
      if (p.is_conflict_of) it.conflictOf = p.is_conflict_of;
      return it;
    });
  });
  return { status: 200, body };
}

async function projectCreate(ctx) {
  S.syncGate(ctx, true);
  const b = ctx.body;
  const body = await SE.withSession(ctx, {}, async (unit) => {
    const u = await unit.user();
    const n = (await unit.sql`select count(*)::int as n from wts.projects where user_id = ${unit.userId}`)[0].n;
    if (n >= MAX_PROJECTS) fail('quota', { limit: MAX_PROJECTS, used: n });
    const id = (await unit.sql`insert into wts.projects (id, user_id, meta_enc, created_at, modified_at)
      values (gen_random_uuid(), ${unit.userId}, ${sealMeta(u, b.name.trim(), b.meta)}, now(), now()) returning id`)[0].id;
    return { id, headRev: 0 };
  });
  return { status: 201, body };
}

async function projectHead(ctx) {
  S.syncGate(ctx, false);
  const body = await SE.withSession(ctx, {}, async (unit, s) => {
    const u = await unit.user();
    const p = await projectRow(unit, ctx.params.id);
    // distinct projects read by this session today (§8.3 read anomaly: > 10 → notice + audit)
    const first = await R.hit(unit.sql, 'projectReadSessionDay', s.hash.toString('hex').slice(0, 24) + ':' + p.id);
    if (first.n === 1) {
      const d = await R.hit(unit.sql, 'projectsReadSessionDay', s.hash.toString('hex').slice(0, 24));
      if (d.n === d.limit + 1) await readNotice(unit, u, s, 'projects');
    }
    // GET never changes state (§3.2): the device base is recorded by commit / restore-rev (§6.5: 200 → last_base_rev), and
    // a base pruned before the next commit still merges from the device's own copy
    return headBody(unit, ctx, u, p);
  });
  return { status: 200, body };
}
async function readNotice(unit, u, s, kind) {
  const once = await R.hit(unit.sql, 'noticeOnceDay', 'read:' + unit.userId);
  await unit.audit('read_burst', { deviceId: s.deviceId, detail: { kind } });
  if (once.n === 1) await unit.mail(u.open('user.address', u.row.email_enc), 'notice_read_burst', { at: S.whenText(Date.now()) });
}

async function projectRevs(ctx) {
  S.syncGate(ctx, false);
  const lim = Math.max(1, Math.min(200, Number(ctx.query.limit) || 50));
  const body = await SE.withSession(ctx, {}, async (unit) => {
    const p = await projectRow(unit, ctx.params.id);
    return (await unit.sql`select * from wts.revisions where project_id = ${p.id} order by rev desc limit ${lim}`).map(revItem);
  });
  return { status: 200, body };
}

async function projectRev(ctx) {
  S.syncGate(ctx, false);
  if (!/^\d{1,15}$/.test(ctx.params.rev)) fail('not_found');
  const body = await SE.withSession(ctx, {}, async (unit) => {
    const u = await unit.user();
    const p = await projectRow(unit, ctx.params.id);
    const r = (await unit.sql`select * from wts.revisions where project_id = ${p.id} and rev = ${Number(ctx.params.rev)}`)[0];
    if (!r) fail('not_found');
    return revBody(r, await B.inlineOf(unit, ctx, u, hex(r.core_hash)));
  });
  return { status: 200, body };
}

async function projectCommit(ctx) {
  S.syncGate(ctx, true);
  clientGate(ctx);
  const b = ctx.body;
  const body = await SE.withSession(ctx, {}, async (unit, s) => {
    const done = await receipt(unit, b.pushId);
    if (done) return done;                                     // a retry after a lost response: the same answer, no new revision
    await commitRateLimits(unit, s);
    const u = await unit.user();
    const p = await projectRow(unit, ctx.params.id, { lock: true });
    const headRev = Number(p.head_rev);
    if (b.baseRev !== headRev) fail('stale', { headRev, head: await headBody(unit, ctx, u, p) });
    if (headRev && b.reason === 'auto' && hex(p.head_vhash) === b.core.vhash) {
      const h = (await unit.sql`select saved_at from wts.revisions where project_id = ${p.id} and rev = ${headRev}`)[0];
      return { rev: headRev, savedAt: iso(h && h.saved_at) };          // nothing changed in the normalised view: a no-op
    }
    let inline = null; let z = null;
    if (b.core.inline !== undefined) {
      z = Buffer.from(b.core.inline, 'base64');
      if (z.length > B.INLINE_MAX || B.sha(z) !== b.core.zsha) fail('bad_request', { field: 'core' });
      inline = b.core.inline;
    }
    // the referenced blobs are locked FOR SHARE, so the daily clean-up cannot delete one under this revision (T15)
    const miss = await B.missing(unit, unit.userId, (z ? [] : [b.core.hash]).concat(b.parts.map((x) => x.hash)), { lock: true });
    if (miss.length) fail('missing_blobs', { missing: miss.slice(0, 200) });
    await B.quotaCheck(unit, unit.userId, 0);
    // the inline core last among the refusals: no object is written for a commit that is refused
    if (z) await B.putInline(unit, ctx, u, { hash: b.core.hash, zsha: b.core.zsha, z });
    const parts = b.parts.map((x) => ({ name: x.name, hash: x.hash, bytes: x.bytes }));
    const bytes = parts.reduce((n, x) => n + x.bytes, b.core.bytes);
    const rev = headRev + 1;
    const r = (await unit.sql`insert into wts.revisions (project_id, user_id, rev, core_hash, vhash, parts, bytes, device_id, session_hash, reason, app_ver, saved_at)
      values (${p.id}, ${unit.userId}, ${rev}, ${Buffer.from(b.core.hash, 'hex')}, ${Buffer.from(b.core.vhash, 'hex')}, ${unit.sql.json(parts)}, ${bytes},
              ${s.deviceId || null}, ${s.hash}, ${b.reason}, ${String(b.appVer).slice(0, 20)}, now()) returning saved_at`)[0];
    await unit.sql`update wts.projects set head_rev = ${rev}, head_vhash = ${Buffer.from(b.core.vhash, 'hex')}, head_bytes = ${bytes},
      head_core = ${inline ? u.seal(CORE, inline) : null}, meta_enc = ${sealMeta(u, b.meta.name || openMeta(u, p.meta_enc).name, b.meta)},
      well_count = ${b.wells.length}, modified_at = now() where id = ${p.id} and user_id = ${unit.userId}`;
    await burst(unit, ctx, u, p.id, headRev);
    await noteBase(unit, s, p.id, rev);
    await prune(unit, p.id, rev, 10);
    const res = { rev, savedAt: iso(r.saved_at) };
    await keepReceipt(unit, b.pushId, res);
    return res;
  });
  return { status: 200, body };
}

async function projectRename(ctx) {
  S.syncGate(ctx, true);
  await SE.withSession(ctx, {}, async (unit) => {
    const u = await unit.user();
    const p = await projectRow(unit, ctx.params.id);
    const m = openMeta(u, p.meta_enc);
    await unit.sql`update wts.projects set meta_enc = ${sealMeta(u, ctx.body.name, ctx.body.meta || m.meta)}, modified_at = now() where id = ${p.id}`;
  });
  return { status: 200, body: { ok: true } };
}
async function projectTrash(ctx) {
  S.syncGate(ctx, true);
  await SE.withSession(ctx, {}, async (unit) => {
    const p = await projectRow(unit, ctx.params.id);
    await unit.sql`update wts.projects set deleted_at = now() where id = ${p.id}`;
  });
  return { status: 200, body: { ok: true } };
}
async function projectRestore(ctx) {
  S.syncGate(ctx, true);
  await SE.withSession(ctx, {}, async (unit) => {
    const p = await projectRow(unit, ctx.params.id, { trash: true });
    await unit.sql`update wts.projects set deleted_at = null, modified_at = now() where id = ${p.id}`;
  });
  return { status: 200, body: { ok: true } };
}
async function projectPurge(ctx) {
  S.syncGate(ctx, true);
  await SE.withSession(ctx, { stepup: true }, async (unit, s) => {
    const p = await projectRow(unit, ctx.params.id, { trash: true });
    // revisions first (their trigger releases the blob references), then the project; conflict copies lose the link
    await unit.sql`update wts.projects set is_conflict_of = null where user_id = ${unit.userId} and is_conflict_of = ${p.id}`;
    await unit.sql`delete from wts.revisions where project_id = ${p.id}`;
    await unit.sql`delete from wts.projects where id = ${p.id}`;
    await unit.audit('project_purge', { deviceId: s.deviceId, target: p.id });
  });
  return { status: 200, body: { ok: true } };
}
async function projectRestoreRev(ctx) {
  S.syncGate(ctx, true);
  const b = ctx.body;
  const body = await SE.withSession(ctx, {}, async (unit, s) => {
    const done = await receipt(unit, b.pushId);
    if (done) return done;
    await commitRateLimits(unit, s);
    const u = await unit.user();
    const p = await projectRow(unit, ctx.params.id, { lock: true });
    const src = (await unit.sql`select * from wts.revisions where project_id = ${p.id} and rev = ${b.rev}`)[0];
    if (!src) fail('not_found');
    await B.missing(unit, unit.userId, revHashes(src), { lock: true });        // FOR SHARE: no clean-up under the new revision
    const rev = Number(p.head_rev) + 1;
    await unit.sql`insert into wts.revisions (project_id, user_id, rev, core_hash, vhash, parts, bytes, device_id, session_hash, reason, app_ver, saved_at)
      values (${p.id}, ${unit.userId}, ${rev}, ${src.core_hash}, ${src.vhash}, ${unit.sql.json(src.parts)}, ${src.bytes}, ${s.deviceId || null}, ${s.hash}, 'restore', ${src.app_ver}, now())`;
    const inline = await B.inlineOf(unit, ctx, u, hex(src.core_hash));
    await unit.sql`update wts.projects set head_rev = ${rev}, head_vhash = ${src.vhash}, head_bytes = ${src.bytes}, head_core = ${inline ? u.seal(CORE, inline) : null},
      modified_at = now() where id = ${p.id}`;
    await noteBase(unit, s, p.id, rev);
    const res = { rev };
    await keepReceipt(unit, b.pushId, res);
    return res;
  });
  return { status: 200, body };
}
async function projectDuplicate(ctx) {
  S.syncGate(ctx, true);
  const body = await SE.withSession(ctx, {}, async (unit, s) => {
    const u = await unit.user();
    const p = await projectRow(unit, ctx.params.id);
    const n = (await unit.sql`select count(*)::int as n from wts.projects where user_id = ${unit.userId}`)[0].n;
    if (n >= MAX_PROJECTS) fail('quota', { limit: MAX_PROJECTS, used: n });
    const m = openMeta(u, p.meta_enc);
    const head = Number(p.head_rev) ? (await unit.sql`select * from wts.revisions where project_id = ${p.id} and rev = ${p.head_rev}`)[0] : null;
    const id = (await unit.sql`insert into wts.projects (id, user_id, meta_enc, well_count, head_rev, head_core, head_vhash, head_bytes, created_at, modified_at)
      values (gen_random_uuid(), ${unit.userId}, ${sealMeta(u, ctx.body.name, m.meta)}, ${p.well_count}, ${head ? 1 : 0}, ${head ? p.head_core : null},
              ${head ? p.head_vhash : null}, ${head ? p.head_bytes : 0}, now(), now()) returning id`)[0].id;
    if (head) {
      await B.missing(unit, unit.userId, revHashes(head), { lock: true });     // FOR SHARE: no clean-up under the copy
      await unit.sql`insert into wts.revisions (project_id, user_id, rev, core_hash, vhash, parts, bytes, device_id, session_hash, reason, app_ver, saved_at)
        values (${id}, ${unit.userId}, 1, ${head.core_hash}, ${head.vhash}, ${unit.sql.json(head.parts)}, ${head.bytes}, ${s.deviceId || null}, ${s.hash}, ${head.reason}, ${head.app_ver}, now())`;
    }
    return { id, headRev: head ? 1 : 0 };
  });
  return { status: 201, body };
}

module.exports = {
  handlers: {
    projectList, projectCreate, projectHead, projectRevs, projectRev, projectCommit, projectRename, projectTrash, projectRestore,
    projectPurge, projectRestoreRev, projectDuplicate,
  },
  _internal: { openMeta, revItem, clientGate, prune },
};
