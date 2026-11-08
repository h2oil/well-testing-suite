# server/RUNBOOK.md — operating the web accounts API

Operations handbook for the functions-only site in `server/` (docs/ACCOUNTS-PLAN.md §8, §13; WP-OPS). It covers the
owner's activation checklist, releases, monitoring, kill switches, incidents, the security reset, key rotation and
compromise, backups and restore, and support. Every script named here reads its credentials from the environment only and
prints ids, counts and dates — never an e-mail address, a code, a key or a body.

**State today:** the code is ready to deploy but nothing is deployed. While no server answers, the static site behaves
exactly as v3.4: the page's cloud UI stays hidden unless `GET /api/v1/...` answers (and the `?cloud=1` beta flag is set
during the beta), both provider sign-ins are off unless configured (`OAUTH_GOOGLE` / `OAUTH_LINKEDIN` default `off`), and
the repository root carries no host configuration, so the static site's deploy is unchanged.

---

## 1. Map

| What | Where |
|---|---|
| Request pipeline, contract, config | `core/app.js`, `core/contract.js`, `core/config.js` |
| Functions-site adapter (the one function for `/api/v1/*`) | `site/handler.js`; bundle `node site/build.js` → `server/dist/` |
| Site description and the static site's rewrite | `site/site.json` |
| Preview isolation | `site/isolation.js` |
| Monitoring hooks and alert table | `site/monitor.js`, `ops/monitor-check.js` |
| Host bindings (blob store, e-mail service) | `site/adapters.js` |
| Weekly export and restore drill | `site/backup.js`, `ops/weekly-export.js`, `ops/restore-drill.js`, `ops/sql/backup-role.sql` |
| Daily job call (no host scheduler) | `ops/call-daily.js` |
| Support and incident scripts | `ops/` (lookup, allowlist-add, security-reset, recover, rewrap, ledger-replay, retire-client — WP-S1 / WP-O) |
| Release workflow | `.github/workflows/server-release.yml` (server-v* tags only) |
| Static publish allow-list and its check | `prism-build/publish-site.js` (`--check`) |
| Account-block digest | `prism-build/acct-hash.js` |
| Secret scan | `server/ci/secret-scan.js` |

---

## 2. Environments and secrets

| Environment | Database | Secrets | Sign-in |
|---|---|---|---|
| production | UK (else EU) managed database, name without preview / test / drill / scratch | production only (below) | on |
| preview | its own empty database named `*_preview`, synthetic data | its own keys with **kid ≥ 9000**; no provider secrets; no mail credential unless `WTS_PREVIEW_SIGNIN=1` | off unless `WTS_PREVIEW_SIGNIN=1` |
| local / test | throwaway cluster (`server/test/run.js`) or the in-memory fake | generated at test time | fake providers only |

`site/isolation.js` enforces these rules at start-up: production refuses kids ≥ 9000, a preview-looking database name,
`WTS_PREVIEW_SIGNIN`, a restore-drill or migration credential in the functions environment; every other environment refuses
production kids (< 9000). On a failure the site serves only `/health` and logs `alert: isolation — …`. The API also answers
`404` to any host other than `welltest.h2oil.co.uk` and to any request without the proxy signature in production.

**Functions-site environment** (secrets marked \*): `WTS_ENV=production`, `WTS_DB_URL`\* (the `wts_api` role),
`WTS_MASTER_KEYS`\* (`kid:base64,…`), `WTS_MASTER_KID`, `WTS_INDEX_PEPPER`\*, `WTS_CODE_PEPPERS`\* (`kid:base64,…`),
`WTS_SESSION_PEPPER`\*, `WTS_PROXY_SIG`\* (`current[,previous]`), `WTS_OPS_HMAC`\*, `WTS_MAIL_API_URL`\*,
`WTS_MAIL_CREDENTIAL`\*, `WTS_MAIL_FROM`, `WTS_HOST_HEADER`, `WTS_CLIENT_IP_HEADER`, `WTS_TERMS_VERSION`,
`WTS_PRIVACY_VERSION`, `WTS_VERSION`, the kill switches (§6), `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET`\*,
`OAUTH_LINKEDIN_CLIENT_ID`, `OAUTH_LINKEDIN_CLIENT_SECRET`\*. **Never** set `WTS_OIDC_MODE` in production.

**Jobs host** (scheduled scripts; a separate credential set, D12): `WTS_JOBS_DB_URL`\* (`wts_jobs`), `WTS_BACKUP_DB_URL`\*
(`wts_backup`), `WTS_BACKUP_KEY`\*, `WTS_EXPORT_DIR` (separate storage in another region), `WTS_OBJECTS_DIR` or the blob
store binding, `WTS_ALERT_WEBHOOK`\*, `WTS_ALERT_EMAIL`, `WTS_HEALTH_URL`, `WTS_STORAGE_PLAN_BYTES`, `WTS_OPS_HMAC`\* (for
`call-daily.js`). **Support machine** (owner only, on demand): `WTS_SUPPORT_DB_URL`\*.

**Repository (release workflow)**: environment `server-migrations` → secret `WTS_MIGRATE_DB_URL`; environment
`server-production` → secret `WTS_DEPLOY_TOKEN`, variables `WTS_DEPLOY_SITE`, `WTS_DEPLOY_COMMAND`, `WTS_HEALTH_URL`. Both
environments require the owner as reviewer.

Secrets never go into the repository, the static bundle, logs, previews or chat. `.env*` is git-ignored; the publish check
and the secret scan refuse files that contain key material or name a secret variable in published content.

### Records (fill in; no secret values here)
| Item | Value |
|---|---|
| Google client id (production / development) | |
| LinkedIn client id (production / development) | |
| Console owners and second administrators | |
| Where each secret is kept (vault entry names) | |
| Master-key escrow location (offline) | |
| Backup-key escrow location (offline) | |
| Processors' breach-notice times (contracts) | |

---

## 3. Activation checklist (the owner)

Do these in order; each step is reversible until step 14. Plan §13.10 has the provider-console steps (WP0).

1. **Decide and sign up**: the hosting plan with functions and a scheduler (D17), the database in the UK (else EU), the blob
   store (EU), the e-mail service (sender `no-reply@h2oil.co.uk`, SPF / DKIM / DMARC on `h2oil.co.uk`), the uptime check.
2. **Database**: create the production database. As the administrator run the migration job once (step 9) — it creates the
   roles `wts_owner`, `wts_definer`, `wts_api`, `wts_jobs`, `wts_support`. Set passwords for `wts_api`, `wts_jobs`,
   `wts_support` out of band. Apply `server/ops/sql/backup-role.sql` and set the `wts_backup` password.
3. **Keys**: generate 32-byte random values (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`)
   for the master key (kid 1), index pepper, code pepper (kid 1), session pepper, proxy signature, ops HMAC and backup key
   (kid 1). Store each in the vault; write the master key and the backup key to the offline escrow too.
4. **Functions site**: create a second site of the same team for `server/` only (`site/site.json`): build command
   `node site/build.js` in `server/`, function entry `dist/functions/api.js` for `/api/v1/*`, **no static publish
   directory** beyond `dist/static` (robots.txt only), UK region if offered. Disable deploy previews and branch deploys for
   this site (it deploys only from the release workflow).
5. **Environment**: set the functions-site variables of §2. Leave `OAUTH_GOOGLE` / `OAUTH_LINKEDIN` unset (= off) and
   `ACCOUNTS_SIGNUP=invite` until the beta.
6. **Blob store binding**: write `server/dist/functions/objects-binding.js` (generated bundles keep it if the deploy command
   copies it) exporting `createStore()` that returns the host's blob store with `get / set / delete / list({prefix})`;
   `site/adapters.js hostObjects()` validates every key. Without it data routes answer `503 paused`.
7. **Rewrite on the static site** (host settings of the existing static site, not this repository's root):
   `/api/v1/*` → `https://<functions-site-host>/api/v1/:splat`, status 200, proxied, adding the request header
   `X-WTS-Proxy-Sig: <WTS_PROXY_SIG current value>`; pass `Cookie`, `Origin`, `Content-Type` and the `X-WTS-*` headers through.
   Set `WTS_HOST_HEADER` / `WTS_CLIENT_IP_HEADER` to the trusted forwarding headers the host adds. Check: the functions-site
   URL answered directly gives `404`; through the static site `GET /api/v1/health` gives `{"ok":true,"db":true,…}`. If the
   host's rewrite cannot add a header, use the fallback of plan §2 (one site, functions deployed from the same tags through a
   protected deploy branch) — ask for a plan update first.
8. **Repository**: create the environments `server-migrations` and `server-production` (required reviewer: owner), add the
   secret and variables of §2. `WTS_DEPLOY_COMMAND` is the host CLI's deploy call for the functions site, run inside
   `server/dist`, reading `WTS_DEPLOY_TOKEN` and `WTS_DEPLOY_SITE` from the environment (pin the CLI version in it).
9. **First release**: follow §4 with tag `server-v1`.
10. **Schedules** (jobs host or the host scheduler): daily `node server/ops/call-daily.js` (or the host scheduler calling
    `POST /api/v1/ops/daily` with the same HMAC), hourly `node server/ops/monitor-check.js`, weekly
    `node server/ops/weekly-export.js` (`site/site.json` lists the times).
11. **Monitoring**: the uptime check on `https://welltest.h2oil.co.uk/api/v1/health` (alert when not `ok` or `db:false`); the
    host's log alerting on `alert:` lines and on the access-line rules of §5; `WTS_ALERT_WEBHOOK` / `WTS_ALERT_EMAIL`; a spend
    alert at 80 % of the plan.
12. **First restore drill** (§9.3) before any real user signs in; note the result in PROJECT-NOTES.md.
13. **Static site headers**: switch the static site's publish directory to the output of
    `node prism-build/publish-site.js --api` (the allow-list, `_headers` with HSTS, `Referrer-Policy`, `Permissions-Policy`,
    no-cache on the page and `sw.js`, and the CSP in **Report-Only** mode reporting to `/api/v1/csp-report`; collection hosts
    of the analytics tag via `--extra-connect` / `--extra-img` from the vendor notes). Confirm the published set with
    `node prism-build/publish-site.js --check --dir <published folder>` and that `server/`, `docs/`, `tools/` and
    `prism-build/` URLs now answer 404. The CSP is enforced only at the end of Phase 1 (WP-I1), after the reports are clean.
14. **Providers and beta**: complete plan §13.10 (consoles, verification, live tests), put the pinned values into
    `core/oidc-providers.js` through a reviewed server release, then set `OAUTH_GOOGLE` / `OAUTH_LINKEDIN` (`signin` or `on`)
    and add the invited addresses (`ops/allowlist-add.js`). Testers use `?cloud=1`.

---

## 4. Releases and deploys

- The static site auto-deploys from master as before. The client account code (66–68) ships with it, gated by the beta flag
  and the server's switches.
- The server deploys **only** from a `server-v*` tag on a master commit:
  1. Merge the reviewed server change to master (independent review, plan Q19).
  2. Sign the checklist in the release's PR or issue: tests green (incl. `rls.test.js`), independent review done, migration
     reviewed (expand-then-contract: the previous tag keeps working), the account-block SHA-384 noted
     (`node prism-build/acct-hash.js --release` on the built page; the release notes carry it), the provider pins in
     `oidc-providers.js` unchanged or reviewed, `WTS_OIDC_MODE` unset in production.
  3. `git tag server-vN <master commit> && git push origin server-vN`.
  4. The workflow verifies (tag format, master ancestry, server tests on a throwaway cluster, secret scan, publish check,
     digest and pin diff in the run summary, bundle), then waits for approval of `server-migrations` (migrations) and
     `server-production` (deploy, then the health check).
- **Rollback**: re-run the deploy job of the previous tag (migrations are additive, so the old code still works). Never edit
  a released migration; correct it with a new `NNN-*.sql`.

---

## 5. Monitoring and alerts

Access lines (`{"t":"access","rid","route","status","ms","ipp"}`) are the only per-request log; handlers log no addresses,
codes, cookies, bodies, provider codes, `state`, tokens or claims (`site/monitor.js redactLine` masks free text). Alerts are
log lines starting `alert:` plus one POST per run to `WTS_ALERT_WEBHOOK`.

| Alert id | Rule (plan §13.6) | First response |
|---|---|---|
| http5xx / latency | 5xx > 2 % over 10 min; p95 > 2 s | function and database logs; database awake? recent deploy → roll back |
| health | `/health` not ok or `db:false` | database status; credentials rotated? |
| codeSends / verifyFails / rate429 / ipSoft | > 300 code sends / h; failed verifies > 5 × baseline; 429 spike; per-IP soft limit | abuse? `ACCOUNTS_SIGNUP=invite` or `off`; check the site breaker |
| readAnomaly / commitBurst | read anomalies; commit bursts | look up the account's audit rows; security reset if not the user |
| storage | > 80 % of the plan | raise the plan or quotas |
| bounce / complaint / outboxAge | bounce > 5 %, complaint > 0.1 %, outbox older than 5 min | e-mail service status; DNS records; credential |
| deletionLag | deletion job late by > 1 day | run `call-daily.js`; check the jobs logs |
| providerGoogle / providerLinkedin / jwksFetch / unknownKid / breaker / ceiling | provider failures > 20 % over 30 min; key fetch failures; unknown-kid refetches; breaker open; per-prefix ceiling | provider status page; `OAUTH_<P>=signin` or `off`; the e-mail code still works |
| linkSpike / subjectMulti | link / unlink spike; one subject on several accounts | incident (§7), query by `subject_bidx` |
| pins / isolation | provider pins failed at start-up; isolation check failed | fix the environment; the site serves only `/health` until then |
| auditChain | the daily audit-chain check failed | S1 incident: preserve logs, compare with the `chain/<date>` anchors and the weekly export |
| exportAge | no weekly export for 8 days | run `weekly-export.js`; check the export storage |

---

## 6. Kill switches (functions-site environment; take effect on the next request after the host applies them)

| Switch | Values | Effect |
|---|---|---|
| `ACCOUNTS_OFF` | `1` | every route except health, providers, csp-report, ops-daily, callback, sign-out answers `503 paused`; the page shows "Cloud sync paused" |
| `ACCOUNTS_SIGNUP` | `open` / `invite` / `off` | new accounts open / invite list only / none (existing accounts still sign in) |
| `SYNC_MODE` | `on` / `readonly` / `off` | commits allowed / refused with `503 readonly` (pulls and export work) / everything paused |
| `OAUTH_GOOGLE`, `OAUTH_LINKEDIN` | `on` / `signin` / `off` | provider sign-in for all / existing links only / hidden (the dialog reads `GET /auth/providers`) |

An unknown value always means the "off" value (fail closed).

---

## 7. Incident runbook (plan §13.6)

1. **Severity**: S1 data exposure or takeover; S2 integrity or loss; S3 outage. Open an incident note with times (UTC).
2. **Preserve logs within 24 h**: export the functions' and the database's logs for the window before they roll over; keep
   the latest weekly export and the `chain/` and `ledger/` objects untouched.
3. **Contain**: the matching kill switch (§6); sign everyone out if sessions may be exposed (rotate `WTS_SESSION_PEPPER` —
   every session hash stops matching); for affected accounts run the **security reset** (§8); for a provider-side incident or
   a leaked provider secret: `OAUTH_<P>=off`, rotate that secret (§10.2), security reset with `--since` = start of the
   window for accounts whose sessions came from that provider; rotate peppers and, if exposed, the master key (§10.3).
4. **Assess**: which personal data — addresses need the index pepper and the master key; bodies are envelope-encrypted per
   user; list affected accounts by audit rows, by `subject_bidx` for one attacker identity (also after unlink).
5. **Notify**: if a risk to people is likely, the ICO within 72 h of awareness (pre-drafted notice in the vendor notes);
   affected users (pre-drafted plain-text notice); business customers under their DPA; processors per their contracts.
   Record the decision either way.
6. **Post-mortem** in PROJECT-NOTES.md (timeline, cause, data, fixes, tests added).

---

## 8. Security reset (per account or in bulk)

`node server/ops/security-reset.js --actor support:<id> --user <uuid> --since <ISO time>` (credential `WTS_SUPPORT_DB_URL`).
It revokes every session; removes passkeys, provider links (with every session they created) and the recovery address added
since `--since`; reverts an e-mail change made in the window; writes an audit row with actor `support:<id>`. For bulk use,
run it per account id from the incident's affected list. Afterwards tell the user (security notice) and log the run in the
incident note.

---

## 9. Backups, ledger, anchor and restore (plan §13.5)

### 9.1 What exists
- The platform's daily database backups (30 days).
- The **weekly encrypted export** (`ops/weekly-export.js`): dump + blob manifest + `ledger/` + `chain/` objects + manifest,
  AES-256-GCM under `WTS_BACKUP_KEY` (not a master key; header authenticated; `kid` for rotation), in separate storage in
  another region, kept **28 days**.
- **Deletion ledger** objects `ledger/<user id>` (ids and dates only) written by the daily job outside the restorable database.
- **Audit anchor** objects `chain/<date>` (each user's chain head and a Merkle root) written daily.

### 9.2 Real restore (after data loss)
1. `ACCOUNTS_OFF=1` (the API must not serve restored data before step 4).
2. Restore the platform backup (or `pg_restore` of the newest weekly export's `db.dump` after decrypting with
   `site/backup.js open`) into a **new** database; never over the damaged one.
3. Point `WTS_DB_URL` / `WTS_JOBS_DB_URL` at it.
4. **Replay the ledger before re-opening**: `WTS_OBJECTS_DIR=… node server/ops/ledger-replay.js` (credential
   `WTS_JOBS_DB_URL`) — deleted accounts never come back. Also replay the ledger objects inside the export if the blob store
   was lost.
5. Compare the audit chain heads with the newest `chain/<date>` anchor.
6. `ACCOUNTS_OFF` unset; incident note (§7).

### 9.3 Restore drill (first before the beta, then quarterly)
On a machine with the engine's tools and a **scratch** cluster on loopback (never production):
```bash
WTS_BACKUP_KEY=… WTS_DRILL_ADMIN_URL=<scratch administrator URL> WTS_PG_BIN=<tools folder> \
  node server/ops/restore-drill.js --latest <export folder>
```
It decrypts and verifies the newest export, creates `wts_drill_<random>`, restores, replays the ledger, compares row counts,
migrations and the audit digest with the manifest, and **drops** the scratch database. Paste the JSON report and the measured
`restoreMs` into PROJECT-NOTES.md. A failing drill is an S2 incident. The test `server/test/ops-backup.test.js` runs the same
drill end to end on a throwaway cluster.

---

## 10. Key rotation and compromise

### 10.1 Peppers, proxy signature, ops HMAC (every 12 months; one previous version accepted until the next rotation)
- Code pepper: add `kid:new` **first** in `WTS_CODE_PEPPERS`, deploy, keep the old one listed; codes live 15 min, so the
  old one can go at the next rotation.
- Proxy signature: set `WTS_PROXY_SIG=new,old` on the functions site, then change the static site's rewrite header to
  `new`, check `/api/v1/health` through the site, then set `WTS_PROXY_SIG=new`.
- Ops HMAC: change it on the functions site and the jobs host together (one daily run may be refused; re-run it).
- Session pepper: changing it signs everyone out — only in an incident or with a notice.
- Backup key: add `kid:new` first in `WTS_BACKUP_KEY` (new exports use it), keep the old one until no export older than
  28 days uses it; escrow the new one offline.

### 10.2 Provider client secrets (every 12 months, on a suspected leak, when someone with console access leaves)
Where the console allows two live secrets: add the new one, put it in `OAUTH_<P>_CLIENT_SECRET`, deploy, check a sign-in,
delete the old one. Otherwise announce a few-minute window: that provider's sign-in fails, the e-mail code is unaffected.
Never delete and re-create the LinkedIn app (its subjects are per app — every link would break).

### 10.3 Master key (plan §13.4)
- **Rotation**: add `kid:new` to `WTS_MASTER_KEYS`, set `WTS_MASTER_KID=new`, deploy; run
  `node server/ops/rewrap.js --to-kid <new>` (credential `WTS_JOBS_DB_URL`) until it reports no row left on the old kid;
  only then remove the old kid. A kid is never retired while any row uses it.
- **Compromise**: new master key; new per-user data keys (`data_key_ver + 1`) and background re-encryption of blobs (the
  chunk header's `dkv` / `kid` allow dual reads until done); rotate all peppers; sign everyone out; incident steps of §7.

---

## 11. Support (plan §13.7)

- **"I didn't get the code"** (most common): check quarantine / spam; allow-list `no-reply@h2oil.co.uk`; codes are valid
  15 minutes and two can be live; the recovery address receives codes too.
- **Lost mailbox**: the recovery address first (the user changes the primary address themselves). Otherwise
  `ops/recover.js` (actor `support:<id>`) after the documented identity check: control of the new address (a code) **and**
  two of — a sign-in by a linked Google or LinkedIn identity during the recovery, the account's creation month, the names of
  two projects (the ops function answers match / no match only), the old address's domain confirmed by the employer. The old
  address gets the 7-day revert notice.
- **"I can't sign in with Google / LinkedIn"**: use the e-mail code; a deleted provider account cannot sign in; link again
  after a code.
- **"I have two accounts"** (no merge tool in v3.5): in the first account export everything, unlink its Google / LinkedIn
  identity, delete it; sign in to the second, *Import files to cloud…*, link the provider there. Revision history, the
  library document and devices do not travel.
- Other macros: conflict copies, a public computer's locked outbox, storage full, deletion cancel (sign in with the e-mail
  code within 7 days), export of a large account (one download per project above 200 MB), a DPA request.
- Every support action runs through an audited `ops/` script with actor `support:<id>`; never query user tables by hand.
