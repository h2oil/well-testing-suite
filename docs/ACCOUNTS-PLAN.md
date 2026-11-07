# Accounts and cloud project sync (web version only) — implementation plan

**Status: plan — target v3.5 (web only)** (2026-11-07). No code yet; this file is the only repository file changed by the
planning step. The release number is provisional: DFIT is v3.4 (`docs/DFIT-PLAN.md`, a separate workstream that this plan
does not touch), so accounts ship in the release after it unless the owner and the DFIT lead agree otherwise (Q14).

> **Request (product owner, 2026-11-07).** *"Plan how we can create a login for user so it will save their work and database
> for inputted projects"*, then *"for webversion only"*.
>
> So: optional accounts and sign-in for the **web app at welltest.h2oil.co.uk only**. A signed-in user's work (every autosaved
> page input, PRiSM state, multi-well projects, the build-up surveillance store, report snapshots and templates, libraries, and
> historian data on request) is kept in a per-user cloud database of projects that they can open on any device. The **iOS app
> stays account-free and unchanged**: the account code is stripped from `ios-app/www` and is inert even if a strip were missed.

| | |
|---|---|
| Release | **v3.5 (web only)**, provisional. Shipped first as a beta behind the device pref `?cloud=1` (WP-C1), then on by default for the web (WP-I). Without signing in, the app behaves exactly as v3.4: nothing leaves the device |
| What | (1) **Passwordless sign-in**: an 8-digit e-mail code (base and recovery), passkeys as the fast path once added. (2) **Server-side sessions** in an HttpOnly `__Host-` cookie, never visible to page script. (3) **Cloud projects**: the existing `.h2oilproj` payload as the sync unit, split into a small *core document* plus content-addressed *parts* for the bulk data, committed with compare-and-swap on a revision number. (4) **Event-driven sync**: one debounced push, pulls on focus / online / visible; offline-first, no polling. (5) **Conflicts never lose work**: v1 keeps a conflict copy; a later work package merges by key and by field. (6) **Account page**: projects, history, devices, passkeys, export everything, delete account. (7) UK GDPR: export, deletion, retention, privacy-page text |
| Where | Client: three new Round-10 files `prism-build/66-account.js`, `67-cloud-sync.js`, `68-account-page.js` (auto-discovered; 60–65 are taken, DFIT owns Round-8 56–59). Small neutral host and shared-file edits (§5.4). Server: a new top-level `server/` folder (functions, shared core, database migrations, tests) that is never copied into `ios-app/www`. Build: `ios-app/scripts/sync-from-main.js` (strip step). Tests in `prism-build/tests/` and `server/test/` |
| Not touched | DFIT (`docs/DFIT-PLAN.md`, its branches, Round-8 files 56–59). The iOS native project. The simulator (31/32/38). Calculation engines. `sw.js` code (only its header comment changes) |
| Inputs | Session notes: the persistence map (every store, key, size, event and the `WTS_project` registry), the web delivery and security surface map (service worker, head, iOS strip, network calls, insertion points, test tooling), the options research, three candidate designs (lean, robust, private) and three judge reviews. All three judges chose the lean design as the base; this plan is that design with the grafts they agreed on. Vendor names, prices and links are kept out of the repository, in the owner's scratch vendor notes |

**Conventions.**
- No other company, product, vendor, cloud service or website is named in this plan, the code, the tests or the UI text.
  Services are described generically: "our static host", "its serverless functions", "a managed Postgres database", "the
  host's blob store", "a transactional e-mail service". The only web address is welltest.h2oil.co.uk; the only e-mail is
  software@h2oil.co.uk (user-facing) and no-reply@h2oil.co.uk (sender). Example data is neutral ('Operator Energy Ltd',
  'name@company.example'). The forbidden product name listed in CLAUDE.md is never written.
- MoSCoW tags: **M** must, **S** should (drop only with the lead's agreement), **C** could.
- Client code follows CLAUDE.md: single outer IIFE, public symbols on `window`, no external runtime dependency (native
  passkey API, `crypto.subtle`, `CompressionStream`), **no polling, no `setInterval`, no function wrapping**, nothing pending
  after 5 s idle.
- Line numbers are from the current `Dev` tree (built `well-testing-app.html`, `prism-build/29-project-save.js`).
- Sizes: kB = 1,000 bytes, MB = 10⁶ bytes. Times are UTC on the server, local in the UI.

---

## 0. Decisions at a glance

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Scope | Web only. The account code is wrapped in `ACCT:START/END` markers that `sync-from-main.js` strips; a load-time guard (host name, native bridge, frame) makes it inert anywhere else; the API refuses any Origin but `https://welltest.h2oil.co.uk` (§9) | Owner: "for webversion only". The iOS app stays free, local and unchanged (CLAUDE.md iOS rules) |
| D2 | Backend | **Our own minimal API** in the static host's serverless functions under same-origin `/api/v1/*`, in a UK region. A **managed Postgres** (UK, else EU) holds accounts, sessions, devices, the project index, revisions, blob index, rate counters and the audit log. Project bodies go to the **host's blob store** in its EU region (set explicitly on every call). A **transactional e-mail service** sends codes | Same origin means first-party cookies and no CORS. Lowest lock-in (standard Postgres, standard WebAuthn), cheapest at scale, and we own the sync protocol, which an offline-first app needs. The host's own identity service has no passkeys or codes and an undocumented data region; a separate auth-plus-database service needs a large client SDK (against the no-dependency rule) and its free tier pauses idle projects |
| D3 | Sign-in | **Passwordless.** E-mail code first (8 digits, 10 min, single use, 5 tries, stored as an HMAC); passkeys (discoverable, conditional UI) added from the account page (WP-C3). No passwords, no magic links, no social sign-in | Nothing to steal or reset. A code in the mail body cannot be burnt by a link-scanning mail gateway. Passkeys need the native API only |
| D4 | Session | Opaque 32-byte id in `__Host-wts_sid` (Secure, HttpOnly, **SameSite=Strict**, Path=/); the database stores SHA-256(id). Rotated on sign-in and step-up. **Trusted device**: 14 days idle / 90 days absolute. **Public or shared computer** (a tick box at sign-in): 12 h idle / 7 days absolute, and sign-out clears the local working set by default. Step-up (a code or passkey within 10 min) for export, delete, add / remove passkey, change e-mail, sign out everywhere | The page cannot run a strict CSP (it uses `eval`, `new Function`, 103 inline handlers, blob workers), so no token may ever be reachable from script. Strict works because every API call is a same-origin fetch and no flow enters from another site. Rig and office PCs are often shared |
| D5 | Sync unit | The existing **`.h2oilproj` payload** (`WTS_project._buildPayload()`, 29-project-save.js:731) split into a **core document** and **parts**. Parts are the bulk data: `prism_gauges`, `buildup_raw`, `buildup_analysis`, every parked well blob, and any storage key over 64 kB (client logo, paste text, snapshots). Parts are **content-addressed** (SHA-256 of their canonical JSON), gzip-compressed, uploaded in **4 MB chunks only when missing**, and deduplicated within the user's account. The core carries their hashes. Applying a full snapshot is `WTS_project.loadFromObject(payload, {source:'cloud'})` | Reuses the tested project format, so every module that travels in a project file syncs with no new mapping layer. Splitting out the bulk data means a page edit uploads kilobytes, not the 18 MB gauge mirror; the `pagehide` keepalive (≤ 60 kB) becomes realistic; conflict copies only reference blobs; and 4 MB chunks stay under the functions' request-body limit |
| D6 | Write rule | A **commit** is a small JSON `{pushId, baseRev, core, parts}` to `/api/v1/projects/:id/commit`. The server accepts it only if `baseRev == head_rev` (compare-and-swap in one transaction, row lock on the project), else `409 stale`. `pushId` makes a retry idempotent. A commit whose core hash equals the head is a no-op. **Pull before push** | Changes are never silently overwritten; a retry after a timeout cannot fork a revision |
| D7 | Conflicts | **v1 (WP-C2)**: the device that hits a conflict keeps its version as a **conflict copy** (a new cloud project linked to the original, `is_conflict_of`), then fast-forwards to the cloud head; a bar offers *Open my version / Keep cloud / Decide later*. An explicit Save to cloud offers *Overwrite cloud* (the replaced revision stays in history). **v2 (WP-M, S)**: a **three-way merge by key** against a stored base, by field for `wts_page_<route>`, `h2oil_client_info`, `wts_prism_pvt` (provenance kept) and report templates (by id); libraries by union; the PRiSM bundle atomic; a true clash keeps both as a **copied well** or a **PRiSM workspace branch**, never a whole duplicate project | Safe first, smarter later. Two devices editing different pages should not fork the project once WP-M lands |
| D8 | Apply | Fast-forward with only key changes uses a new **`WTS_project.applyChanges(diff, {source:'cloud'})`** that writes the changed keys through `WTS_lsSet` and re-runs the PRiSM sync only when the PRiSM bundle, PVT or dataset changed. A change to the well list or a part, and Open from cloud, use `loadFromObject(payload, {source:'cloud'})`. A change to the input that has focus waits for its `blur`. A **safety snapshot** (the last 2 local payloads, device IndexedDB) is taken before any apply that replaces more than one key | `loadFromObject` clears every project key and re-renders, which would disturb a user editing on the device that pulls |
| D9 | Change detection | A host edit makes `__lsSet` / `WTS_lsSet` dispatch document **`wts:ls-write {key}`**, and the ~20 direct `setItem` sites move onto `WTS_lsSet` (§5.4). The sync module also listens to the existing events (`wts:autosaved`, `prism:*`, `wts:buildup-updated`, `wts:well-changed`, …). One debounced one-shot `setTimeout` (4 s, re-armed per event; a burst that has run 30 s pushes on the next event). Pulls on `focus` / `visibilitychange→visible` / `online`, throttled by a stored timestamp. Retries only on the next trigger, gated by a `nextRetryAt` timestamp | C7 forbids polling and wrapping; half of today's writes fire no event; the smoke test fails on any timer left after 5 s idle |
| D10 | Sync state | Device-local IndexedDB **`wts-sync`** (binding, base, outbox, safety snapshots, conflicts), outside the `wts_` / `h2oil_` namespace; one non-secret paint hint `wtsacct_hint` in localStorage. `PREF_RE` (29-project-save.js:151) also gains `^wts_acct_|^wts_sync_` as a second guard | Project files, New and well switches never see sync state; nothing account-related travels in an exported file |
| D11 | Encryption at rest | Platform encryption **plus** server-side envelope encryption: a per-user AES-256-GCM data key wrapped by a master key held in the host's environment secrets (versioned key id). Each chunk's AAD binds `userId \| hash \| chunk n \| kid`; the blob header carries `{v, alg, kid, iv}` so an **optional end-to-end-encrypted vault** (passkey PRF or passphrase, client-held keys) can be added later without migrating data (Q4). The client verifies the SHA-256 of every downloaded part against the commit | A bucket leak, a backup or a deploy-preview copy alone exposes no well data. Full end-to-end encryption is deferred: XSS or a malicious deploy defeats it anyway on a web app, and a lost key loses field records for good |
| D12 | Database isolation | Row-level security **enabled and forced** on every user table; the API connects as `wts_api` (no `BYPASSRLS`, no DDL) and every transaction runs `SET LOCAL app.user_id`. Blob keys are built on the server from the session's user id, never from client input | Cheap defence in depth: a bug in a query cannot leak another user's data |
| D13 | What syncs | Everything a project file carries (§7), minus device preferences, minus `wts_modbus_config` (site network addresses; opt-in), plus an account-level **library document** (user curves, presets, column mappings). The **historian** is a manual, opt-in encrypted backup / restore of its existing JSON backup, never continuous (WP-C3) | The historian can reach hundreds of MB and is device-wide, not per project |
| D14 | UI | A header **account chip** (`#wts_account_host`, first in `.page-actions`) with the sync status; Project-menu items *Open from cloud… / Save to cloud / Save to cloud as…* through a new `WTS_project.registerMenuItems`; an **`account` page with a route but no sidebar row** (new registry flag `navHidden:true`), reached from the chip; a bottom status bar modelled on `#wts_sw_bar` for conflicts, sign-out and offline. Overview stays at 5 rows | Sidebar must fit 1280×800 (`sidebar-nav.test.js`); nothing account-related appears on iOS |
| D15 | First sign-in | Ask, never assume: *Upload this device's work as a new cloud project* (default), *Open a cloud project instead* (local work saved to a file and a safety snapshot first), or *Not now*. Nothing local is overwritten without a choice | Existing users have months of work in browser storage |
| D16 | Free accounts | Accounts are free; default quota **250 MB** per user, project body ≤ 64 MB compressed, historian backup ≤ 100 MB (Q5). No payments, no subscription code | The app is free on the web and on iOS; a quota caps cost and abuse |
| D17 | Hosting plan | **Leave the host's free plan before the beta.** On the free plan, running out of monthly credits pauses the whole public site | A sign-in burst or abuse must not take the calculators offline |
| D18 | Admin | No admin console in v3.5. Support uses the database console under the audit log, with read access to metadata only (never content). A console is a later item (Q11) | Less attack surface for a small team |
| D19 | Delivery hygiene | Two-person review on `server/` and files 66–68; production deploys only from tagged commits on master; deploy previews get **no production database or secrets**; kill switches `ACCOUNTS_SIGNUP=off`, `SYNC_MODE=readonly|off`; the SHA-384 of the account block is printed by `prism-build/acct-hash.js` and listed in the release notes (S) | Code delivery is the main remaining risk for any web app |

---

## 1. Goal and scope

### 1.1 In scope (v3.5)
1. Sign-up / sign-in with an e-mail code; passkeys (WP-C3); sign-out, sign out everywhere, device list.
2. Cloud projects: create, save, open, rename, duplicate, move to trash (30 days), restore, purge, revision history and
   restore a revision, download as `.h2oilproj`.
3. Automatic sync of the open project while signed in and linked; offline queue; conflict copies; multi-tab safety.
4. Account library (user curves, presets, mappings) shared by all the user's projects and devices.
5. Opt-in historian backup / restore and opt-in live-data connection settings.
6. Account page; export everything; delete account; privacy-page and help updates; Terms of Use acceptance.
7. Server: API, schema, rate limits, audit log, encryption, backups, monitoring, runbook.

### 1.2 Out of scope (v3.5)
- The iOS app (no account, no sync, no UI change; §9).
- Sharing a project with a colleague, team accounts, roles (later; the data model leaves room: `projects.user_id` is the owner).
- End-to-end-encrypted vault (later, opt-in; D11, Q4).
- Field-level merge beyond the kinds listed in D7 (WP-M covers those; everything else stays atomic).
- Server-side search of content, previews or server-side reports.
- Continuous historian streaming, Modbus data to the cloud.
- Passwords, social sign-in, SMS codes.
- An admin console (D18).
- Payments of any kind.

### 1.3 User stories
| # | As a … | I want to … | So that … | Acceptance |
|---|---|---|---|---|
| U1 | well-test engineer | sign in with my work e-mail and a code | I can use the cloud without a password | Code arrives within 1 min; wrong / expired code gives one generic message |
| U2 | engineer with a laptop and an office PC | open the same project on both | I continue where I stopped | Change on A, focus B → B shows it within one pull (≤ 5 s after focus) |
| U3 | engineer on a rig with a poor link | keep working offline | nothing blocks or is lost | Offline edits stay local; chip shows "n changes waiting"; they upload on `online` |
| U4 | engineer | not lose my edits when I forgot to sync the other device | both versions are kept | A conflict creates a conflict copy (v1) or merges different pages (v2); never a silent overwrite |
| U5 | engineer with months of local work | put it into my account once | it is safe if the browser is cleared | First sign-in offers an upload preview with size and well count |
| U6 | engineer on a shared rig PC | sign in for a shift and leave nothing behind | the next person cannot see the client's data | "Public computer" gives a 12 h session and clears local data on sign-out |
| U7 | engineer | see and restore older versions | I can undo a bad change from yesterday | History lists revisions with device and time; restore makes a new head |
| U8 | user | export everything and delete my account | I control my data (UK GDPR) | Export = zip of `.h2oilproj` files + account JSON; deletion immediate from live systems |
| U9 | iOS user | notice nothing | the app stays simple and local | `ios-app/www` contains no account code; privacy page unchanged on iOS |
| U10 | owner | switch sync off in an incident | users keep working locally | `SYNC_MODE=off` → chip "Cloud sync paused — your work is saved on this device" |

---

## 2. Architecture

```
 Browser (web app, offline-first)                                Our static host (UK region)
 ┌───────────────────────────────────────────┐   same origin   ┌──────────────────────────────────┐
 │ well-testing-app.html                       │  /api/v1/* JSON │ serverless functions (server/)   │
 │  host: __lsSet → 'wts:ls-write'             │ ───────────────▶│  auth · sessions · projects ·    │
 │  29-project-save: _buildPayload,            │  cookie         │  blobs · library · account       │
 │   loadFromObject(obj,{source}),             │  __Host-wts_sid │  rate limits · audit · envelope   │
 │   applyChanges, registerMenuItems           │◀─────────────── │  encryption · kill switches      │
 │  29-multiwell: WTS_wells (unchanged API +   │  no-store       └────────┬─────────────┬───────────┘
 │   applyRemote / importWell in WP-M)         │                          │             │
 │ ── ACCT:START (stripped from iOS) ──        │                 managed Postgres   host blob store
 │  66-account   WTS_account (API client,      │                 (UK, else EU):     (EU region):
 │               sign-in dialog, chip)         │                 users, sessions,   u/<uid>/b/<sha>/<n>
 │  67-cloud-sync WTS_cloudSync (snapshot,     │                 projects, revs,    (encrypted chunks)
 │               push/pull, apply, conflicts)  │                 blobs index, audit
 │  68-account-page  route 'account' (navHidden)│                       │
 │ ── ACCT:END ──                              │                 transactional e-mail service
 │ IndexedDB 'wts-sync' (device-local state)   │                 (codes, notices; EU option)
 └───────────────────────────────────────────┘
 sw.js: /api/* bypasses the worker (non-GET, or GET with no static extension); API sends Cache-Control: no-store
```

- **Local storage stays the primary copy.** The cloud is a replica per project. Without a session, nothing changes from v3.4.
- **One project is linked per device at a time** (the one open in the browser). Other cloud projects are fetched when opened.
- **The server never parses well data.** It stores encrypted bodies, checks sizes, ownership, revisions and quotas, and keeps
  small plaintext metadata for the project list (name, client, well count, sizes, times). The project name and client are
  personal / confidential, so `projects.meta` is envelope-encrypted too and decrypted only in the API response (§3.4).

---

## 3. Server

### 3.1 Folder layout (new, top level)
```
server/
  functions/            one file per route group (auth, me, projects, blobs, library, account, health); the deploy step maps
                        this folder to the host's functions directory
  core/                 pure logic shared with the test fake server: validate.js, rate.js, revisions.js, quota.js,
                        envelope.js (AES-GCM wrap/unwrap, AAD), canon.js (canonical JSON + SHA-256), errors.js
  db/migrations/        NNN-*.sql, applied by the deploy step in order, never edited after release
  db/schema.sql         generated snapshot for review
  test/                 node tests: core units, API against an in-memory adapter, optional RLS test against a local Postgres
  RUNBOOK.md            incidents, restore, key rotation, kill switches (generic)
```
Dependencies: one well-maintained server-side WebAuthn verification library and one Postgres driver, pinned with a lockfile,
reviewed monthly. The browser bundle gets no dependency.

### 3.2 Common rules for every endpoint
- Base path **`/api/v1`**. No path has a file extension (the service worker's static pattern must never match it).
- Every response: `Cache-Control: no-store`, `Vary: Cookie`, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'`, `Content-Type: application/json` (except blob GETs:
  `application/octet-stream`). No CORS headers at all.
- Every non-GET request must carry: `Origin: https://welltest.h2oil.co.uk` exactly (a **missing Origin is refused**),
  `X-WTS-Req: 1`, and `Content-Type: application/json` (or `application/octet-stream` for a chunk PUT). Otherwise
  `403 {"error":"origin"}`.
- The request `Host` must be the production host; any other host (preview deploys) gets `404`.
- Clients send `X-WTS-App: <app version>` and `X-WTS-Device: <device uuid>`. A version below the server's minimum gets
  `426 {"error":"upgrade"}` → the client shows the existing Reload bar.
- GET never changes state. Bodies over the route's limit get `413` before parsing.
- Error envelope: `{"error":"<code>", "message":"<plain text>", "retryAfter":<s>?, ...extra}`.

| HTTP | `error` | Meaning | Client reaction |
|---|---|---|---|
| 400 | `bad_request` | schema check failed (`field` names it) | log, show "Sync error", keep dirty |
| 401 | `signed_out` | no / expired / revoked session | chip "Signed out — sign in"; local work untouched |
| 401 | `invalid_or_expired` | wrong or expired code / passkey | generic message in the dialog |
| 403 | `origin` | Origin / header / content-type check failed | developer error; never retried |
| 403 | `reauth` | step-up needed | re-run code / passkey in place, then repeat |
| 403 | `locked` | account locked by support | message with contact address |
| 404 | `not_found` | project / blob / revision not owned or absent (same answer for both) | unlink, offer Save to cloud as… |
| 409 | `stale` | `baseRev` ≠ head (`headRev`, `head` included) | conflict path §6.5 |
| 409 | `consent_required` | new account needs current Terms / Privacy versions (`terms`, `privacy`) | show consent step |
| 410 | `gone` | project in trash or purged | unlink; offer restore (trash) or Save as new |
| 410 | `resync` | the merge base revision was pruned (WP-M) | full compare, then conflict-copy rules |
| 413 | `too_large` / `quota` | body over cap / account over quota (`limit`, `used`) | chip "Storage full"; nothing lost locally |
| 422 | `missing_blobs` | commit references parts not uploaded (`missing:[hash]`) | upload them, commit again |
| 426 | `upgrade` | client too old | Reload bar |
| 429 | `rate` | rate limit (`retryAfter`) | set `nextRetryAt`, no timer |
| 503 | `paused` | `SYNC_MODE=off` / `ACCOUNTS_OFF` | chip "Cloud sync paused" |
| 503 | `readonly` | `SYNC_MODE=readonly` (pulls and export still work) | chip "Cloud read-only"; keep dirty |

### 3.3 Endpoints

**Auth**

| Method, path | Request | Response | Notes |
|---|---|---|---|
| `POST /auth/code/start` | `{email, purpose:'signin'\|'stepup'\|'email_change'}` | `202 {"ok":true}` always | Padded to ~400 ms; same body and timing for known and unknown addresses; limits §8.4. Unknown address: the mail says "create your account", the row is created only at verify |
| `POST /auth/code/verify` | `{email, code, deviceId, deviceLabel?, publicDevice:bool, consent?:{terms, privacy}}` | `200 {user:{id, emailMasked, created}, firstSignIn, device:{id,label}}` + cookie | New account without the current `consent` → `409 consent_required` (only after a correct code, so the mailbox owner learns nothing new). The code is not burnt by a 409 |
| `POST /auth/passkey/options` | `{}` | `200 {publicKey:{challenge, rpId:'welltest.h2oil.co.uk', userVerification:'preferred', allowCredentials:[]}}` + `__Host-wts_chal` (HttpOnly, 5 min, single use) | Discoverable credentials only, so no enumeration |
| `POST /auth/passkey/verify` | `{credential, deviceId, publicDevice}` | as code/verify | Checks origin, rpId, signature, counter, UV flag |
| `POST /auth/passkey/register/options` | `{}` (step-up) | `200 {publicKey:{…, excludeCredentials, authenticatorSelection:{residentKey:'preferred', userVerification:'preferred'}, attestation:'none'}}` | ≤ 10 passkeys |
| `POST /auth/passkey/register/verify` | `{credential, name}` | `201 {id, name, created}` | |
| `POST /auth/passkey/rename` / `remove` | `{id, name?}` (remove: step-up) | `200 {ok}` | Removing the last passkey is allowed (codes always work) |
| `POST /auth/signout` | `{}` | `200 {ok}` + cookie cleared | |
| `POST /auth/signout-all` | `{}` (step-up) | `200 {ok, sessions:n}` | |

**Me, devices, library**

| Method, path | Request | Response |
|---|---|---|
| `GET /me` | — | `{user:{id, emailMasked, created, status, terms, privacy}, session:{publicDevice, authAt, idleExpires, absExpires}, quota:{limit, used}, opts:{historian, liveCfg}, projects:n, passkeys:[{id,name,created,lastUsed}], devices:[{id,label,lastSeen,current}]}` |
| `POST /me/opts` | `{historian?:bool, liveCfg?:bool}` | `{opts}` |
| `POST /devices/rename` / `revoke` | `{id, label?}` | `{ok}` (revoke deletes that device's sessions) |
| `GET /library` | — | `{rev, hash, savedAt}` + `GET /library/body` → gzip JSON |
| `POST /library/commit` | `{pushId, baseRev, hash, body(base64 gzip, ≤ 2 MB)}` | `200 {rev}` / `409 stale {rev, hash}` |

**Projects**

| Method, path | Request | Response |
|---|---|---|
| `GET /projects` | `?trash=0\|1` | `[{id, name, meta:{client, well, field, operator}, wells:n, headRev, savedAt, savedBy:{device}, bytes, conflictOf?}]` |
| `POST /projects` | `{name, meta}` | `201 {id, headRev:0}` (≤ 200 projects) |
| `GET /projects/:id/head` | — | `{rev, savedAt, device, coreHash, parts:[{name, hash, bytes}], bytes}` (~ 200 bytes + parts) |
| `GET /projects/:id/revs` | `?limit=50` | `[{rev, savedAt, device, reason, bytes, coreHash}]` |
| `GET /projects/:id/rev/:rev` | — | the commit record of that revision (as `head`) |
| `POST /projects/:id/commit` | see below | `200 {rev, savedAt}` / `409 stale` / `422 missing_blobs` / `413` |
| `POST /projects/:id/rename` | `{name, meta?}` | `{ok}` |
| `POST /projects/:id/trash` / `restore` / `purge` | `{}` (purge: step-up) | `{ok}` |
| `POST /projects/:id/restore-rev` | `{rev, pushId}` | `200 {rev}` (a new head whose `reason` is `restore`) |
| `POST /projects/:id/duplicate` | `{name}` | `201 {id, headRev:1}` (references the same blobs) |

Commit request:
```json
{
  "pushId": "6f1c…uuid",
  "baseRev": 41,
  "reason": "auto",                       // auto | save | migrate | conflict | restore | overwrite
  "core":  { "hash": "<sha256 hex of canonical JSON>", "zsha": "<sha256 of gzip>", "bytes": 48213 },
  "parts": [ { "name": "prism_gauges", "hash": "…", "bytes": 9120344 },
             { "name": "well/w2",      "hash": "…", "bytes": 512004 },
             { "name": "key/h2oil_client_info", "hash": "…", "bytes": 221930 } ],
  "meta":  { "name": "Example-1 DST", "client": "Operator Energy Ltd", "well": "Example-1", "field": "", "operator": "" },
  "wells": [ { "id": "w1", "name": "Example-1" }, { "id": "w2", "name": "Example-2" } ],
  "appVer": "3.5"
}
```
`overwrite` is accepted only with `baseRev` equal to the head the client was shown in the 409 (the user confirmed); the
replaced revision stays in history. The core document itself is uploaded as a blob (`hash` = core hash) before the commit.

**Blobs** (content-addressed per user)

| Method, path | Request | Response |
|---|---|---|
| `POST /blobs/has` | `{hashes:[…≤ 200]}` | `{missing:[…]}` |
| `PUT /blobs/:hash/:n?of=N` | raw gzip chunk ≤ 4 MB; headers `X-WTS-Zsha` (whole gzip), `X-WTS-Chunk-Sha` | `204`; the blob becomes complete when all N chunks are in and the whole `zsha` matches |
| `GET /blobs/:hash/:n` | — | raw gzip chunk (`X-WTS-Of: N`, `X-WTS-Zsha`) |

Blob GETs are rate-limited (500 MB per hour per user) so a hostile script on the page cannot bulk-download an account.

**Account**

| Method, path | Request | Response |
|---|---|---|
| `POST /account/export` | `{}` (step-up) | `{user, consents, devices, passkeys:[names, dates], audit:[own rows, 12 months], projects:[{id, name, meta, headRev, revs}]}` (metadata; the client adds the project bodies, §8.3) |
| `POST /account/delete` | `{confirm:'DELETE'}` (step-up) | `200 {ok}`; sessions revoked, cookie cleared |
| `GET /health` | — | `{ok:true, db:true, ver}` (no auth) |

### 3.4 Data model (Postgres DDL, abridged)

All user tables: `user_id uuid NOT NULL`, `ALTER TABLE … ENABLE ROW LEVEL SECURITY; ALTER TABLE … FORCE ROW LEVEL SECURITY;`
policy `USING (user_id = current_setting('app.user_id')::uuid) WITH CHECK (user_id = current_setting('app.user_id')::uuid)`.
Pre-auth tables (`email_codes`, `webauthn_challenges`, `rate_counters`) are reached only through `SECURITY DEFINER` functions
owned by a separate role, never by direct `wts_api` access. `enc` columns hold envelope-encrypted bytes.

```sql
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid GENERATED ALWAYS AS (id) STORED,          -- uniform RLS column
  email_norm text UNIQUE NOT NULL,                       -- lower-case, NFKC
  email_enc bytea NOT NULL,                              -- display form, encrypted
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','deleting')),
  created_at timestamptz NOT NULL DEFAULT now(), last_sign_in_at timestamptz,
  terms_version text NOT NULL, privacy_version text NOT NULL, consented_at timestamptz NOT NULL,
  quota_bytes bigint NOT NULL DEFAULT 250000000, used_bytes bigint NOT NULL DEFAULT 0,
  opt_historian boolean NOT NULL DEFAULT false, opt_livecfg boolean NOT NULL DEFAULT false,
  data_key_wrapped bytea NOT NULL, data_key_kid int NOT NULL,
  lib_rev bigint NOT NULL DEFAULT 0, lib_hash bytea,
  delete_requested_at timestamptz, inactivity_warned_at timestamptz
);
CREATE TABLE passkeys (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  credential_id bytea UNIQUE NOT NULL, public_key bytea NOT NULL, sign_count bigint NOT NULL,
  transports text[], backup_eligible boolean, backup_state boolean, aaguid uuid,
  name_enc bytea, created_at timestamptz NOT NULL, last_used_at timestamptz);
CREATE TABLE email_codes (id uuid PRIMARY KEY, email_hash bytea NOT NULL, code_hmac bytea NOT NULL, pepper_kid int NOT NULL,
  purpose text NOT NULL, expires_at timestamptz NOT NULL, attempts int NOT NULL DEFAULT 0, used_at timestamptz,
  ip_prefix inet);
CREATE TABLE webauthn_challenges (id uuid PRIMARY KEY, challenge bytea NOT NULL, purpose text NOT NULL,
  user_id uuid, expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE TABLE devices (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  label_enc bytea, ua_family text, first_seen timestamptz, last_seen timestamptz, last_sync_at timestamptz,
  revoked_at timestamptz);
CREATE TABLE sessions (sid_hash bytea PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  device_id uuid REFERENCES devices, public_device boolean NOT NULL, created_at timestamptz NOT NULL,
  auth_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL, idle_expires_at timestamptz NOT NULL,
  abs_expires_at timestamptz NOT NULL, ip_prefix inet, ua_family text);
CREATE TABLE projects (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  meta_enc bytea NOT NULL, well_count int NOT NULL DEFAULT 0,
  head_rev bigint NOT NULL DEFAULT 0, head_core bytea, head_bytes bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL, modified_at timestamptz NOT NULL, deleted_at timestamptz,
  is_conflict_of uuid REFERENCES projects);
CREATE TABLE revisions (project_id uuid REFERENCES projects ON DELETE CASCADE, user_id uuid NOT NULL,
  rev bigint NOT NULL, core_hash bytea NOT NULL, parts jsonb NOT NULL,          -- [{name, hash, bytes}]
  bytes bigint NOT NULL, device_id uuid, reason text NOT NULL, app_ver text, saved_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, rev));
CREATE TABLE blobs (user_id uuid NOT NULL, hash bytea NOT NULL, zsha bytea NOT NULL, bytes bigint NOT NULL,
  chunks int NOT NULL, complete boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL,
  refcount int NOT NULL DEFAULT 0, PRIMARY KEY (user_id, hash));
CREATE TABLE push_receipts (user_id uuid NOT NULL, push_id uuid NOT NULL, result jsonb NOT NULL,
  at timestamptz NOT NULL, PRIMARY KEY (user_id, push_id));                    -- kept 24 h
CREATE TABLE historian_backups (id uuid PRIMARY KEY, user_id uuid NOT NULL, blob_hash bytea NOT NULL,
  bytes bigint, t_from timestamptz, t_to timestamptz, saved_at timestamptz);
CREATE TABLE rate_counters (bucket text, window_start timestamptz, n int NOT NULL, PRIMARY KEY (bucket, window_start));
CREATE TABLE audit (id bigserial PRIMARY KEY, user_id uuid, actor text NOT NULL,   -- user | system | support:<id>
  action text NOT NULL, target text, device_id uuid, ip_prefix inet, ua_family text, at timestamptz NOT NULL,
  detail jsonb,                                                                   -- never content, never an e-mail
  prev_hash bytea, hash bytea NOT NULL);                                          -- hash chain per user
```
- **Blob object key**: `u/<user_id>/b/<hex hash>/<n>`, built from the session's user id. Chunk ciphertext:
  `header {v:1, alg:'A256GCM', kid, iv}` ‖ AES-256-GCM(data key, iv, chunk, AAD = `"wts1|" + userId + "|" + hash + "|" + n + "|" + kid`).
- **Revisions kept**: the last 20, plus one per day for 30 days, plus every revision referenced by a conflict copy. Pruning runs
  inside the commit transaction (≤ 10 old revisions per request) and in the daily server job; blob `refcount` reaching 0 marks
  a blob for deletion after 7 days.
- **Quota**: `used_bytes` = Σ compressed bytes of the user's blobs (deduplicated). Checked in the chunk PUT and in the commit.

### 3.5 Server jobs
One daily scheduled server function (server-side scheduling does not touch the client's no-timer rule): purge used / expired
codes and challenges (24 h), expired sessions, rate counters (7 days), push receipts (24 h), unreferenced blobs (7 days),
trashed projects (30 days), deleted accounts (≤ 24 h after the request); send inactivity warnings; recompute `used_bytes`.
If the host plan has no scheduler, the repository's CI workflow calls an authenticated `POST /api/v1/ops/daily` once a day
(secret-signed request; the endpoint is not reachable from browsers: no cookie auth, Origin refused).

---

## 4. Sign-in and sessions (detail)

1. **Code start.** Normalise the address (trim, lower-case, NFKC); refuse anything that is not a plausible single address
   (≤ 254 characters). Generate 8 random digits; store `HMAC-SHA256(pepper[kid], email_norm ‖ code)`; send. Mail text:
   *"Your Well Testing Suite sign-in code is 1234 5678. It expires in 10 minutes. If you did not ask for it, ignore this
   e-mail."* Sender no-reply@h2oil.co.uk with SPF, DKIM and DMARC (quarantine, then reject).
2. **Verify.** Constant-time compare; attempts + 1; on success mark used, create the user if new and consented, create or
   update the device row, create a session (new id), set the cookie, audit `signin`. A sign-in from a new device sends a
   notice e-mail ("New sign-in on <browser family, OS family> at <time>").
3. **Passkeys** (WP-C3). The sign-in dialog's e-mail field has `autocomplete="username webauthn"` and starts
   `navigator.credentials.get({mediation:'conditional'})` when the browser supports it, so the passkey is offered by autofill.
   After a code sign-in the dialog offers "Add a passkey for faster sign-in" (one tap; a fresh session counts as step-up).
4. **Session lifetime.** Each authenticated request slides `idle_expires_at` (written at most every 10 minutes). Expired →
   `401 signed_out`. No client refresh timer exists.
5. **Step-up.** `auth_at` within 10 minutes, else `403 reauth`; the client runs a code (purpose `stepup`) or passkey check in
   place and repeats the call. Step-up rotates the session id.
6. **Public computer.** Short lifetimes; the device row is labelled "public"; sign-out runs the local clear (§10.4) unless the
   user unticks it; no "new device" notice suppression.

---

## 5. Client

### 5.1 Files
| File | Contents | ≈ LOC |
|---|---|---|
| `prism-build/66-account.js` | `WTS_account`: guard, `configure`, API client (one `call()` with headers, error mapping, `retryAfter`), session state machine, sign-in dialog, consent step, step-up helper, passkey ceremonies, header chip and menu, status bar | 1,000 |
| `prism-build/67-cloud-sync.js` | `WTS_cloudSync`: `wts-sync` IndexedDB store, snapshot / split into core + parts, canonical hash, gzip, chunked upload, commit, pull, apply (`applyChanges` / `loadFromObject`), safety snapshots, conflicts, migration, library document, historian backup | 1,100 |
| `prism-build/68-account-page.js` | Registry page `account` (`navHidden:true`, group Overview): profile, projects (list, history, trash), devices, passkeys, sync options, data (export, delete), activity | 700 |

Every file:
```js
// ── ACCT:START — web only; sync-from-main.js strips this block ──
(function () {
  'use strict';
  var G = (typeof window !== 'undefined') ? window : globalThis;
  var L = G.location || {};
  var DEV = G.WTS_ACCOUNT_DEV === 1 && /^(localhost|127\.0\.0\.1)$/.test(L.hostname || '');
  var ELIGIBLE = (L.protocol === 'https:' && L.hostname === 'welltest.h2oil.co.uk' || DEV)
    && !(G.Capacitor && typeof G.Capacitor.isNativePlatform === 'function' && G.Capacitor.isNativePlatform())
    && (function () { try { return G.top === G; } catch (e) { return false; } })();
  if (!ELIGIBLE) { if (!G.WTS_account) G.WTS_account = { eligible: false }; return; }
  // … module body …
})();
// ── ACCT:END ──
// === SELF-TEST ===
(function () { /* pure checks only; stripped by concat */ })();
```
The markers sit **outside** the self-test tail so `stripSelfTest` keeps them; a concat test asserts both markers survive in
`combined-round10.js` and in the built HTML. `window.isIOSApp` is **not** used for the guard (it is set at the end of the main
script, after the modules load).

### 5.2 Client API

```js
WTS_account = {
  eligible: true,
  VERSION: '1.0.0',
  configure(o),                 // {fetch, now, base:'/api/v1', idb, crypto, minDelayMs} — test seam, like checkBridge / T.fetchBytes
  state(),                      // {status:'signedOut'|'signingIn'|'signedIn', user:{id,emailMasked}|null,
                                //  publicDevice, device:{id,label}, needsConsent, opts}
  refresh(),                    // Promise<state>: GET /me (on load when the hint says signed in, on focus after 401)
  openSignIn(opts),             // shows the dialog; resolves {ok, firstSignIn}
  signOut({everywhere, clearLocal}), // Promise
  stepUp(),                     // Promise<boolean>: code or passkey in place
  addPasskey(name), removePasskey(id), renamePasskey(id, name),
  call(method, path, body, opts),// Promise<{status, json|bytes}>; maps errors to WTS_account.Error {code, status, retryAfter}
  on(evt, fn), off(evt, fn)     // 'state' | 'error' — plain listener list, no wrapping
};
WTS_cloudSync = {
  status(),                     // {state:'off'|'idle'|'dirty'|'syncing'|'offline'|'conflict'|'quota'|'paused'|'readonly'|'signedOut',
                                //  projectId, name, baseRev, lastSyncAt, pending:n, error}
  link(projectId), unlink(),    // binding of this device to a cloud project
  saveToCloud({as, name}),      // Promise<{rev}>: create if unlinked / as, else immediate push
  openFromCloud(projectId),     // Promise: safety snapshot → download → loadFromObject(payload, {source:'cloud'})
  syncNow(),                    // pull then push
  listProjects({trash}), history(projectId), restoreRevision(projectId, rev),
  conflicts(), resolve(id, choice), // 'mine' | 'cloud' | 'both'
  snapshot(),                   // Promise<{core, parts:{name:{hash,bytes,json}}}> — also used by tests
  migrateLocal(choice),         // first sign-in, §10
  historianBackup(), historianRestore(id, {mode:'merge'|'replace'}),
  exportAll()                   // Promise<Blob zip> via the 65 zip writer
};
```
Events dispatched on `document` (detail objects are plain data): `wts:account-changed {status}`, `wts:sync-status {state,…}`,
`wts:sync-applied {projectId, rev, changed:[keys]}`, `wts:sync-conflict {projectId, copyId?}`.

### 5.3 Storage keys and stores (client)
| Name | Where | Contents | In project files? |
|---|---|---|---|
| `wts-sync` | IndexedDB (device) | `binding {userId, projectId, deviceId, baseRev, baseCoreHash, boundAt}`; `base` (last-synced core document and part hashes; the WP-M merge base); `outbox` (gzip core + missing parts waiting to upload, survives reload); `safety[]` (last 2 full local payloads); `conflicts[]`; `retry {nextRetryAt, backoffStep}`; `lastPullAt`; `migratedFor:[userId]` | no (outside localStorage) |
| `wtsacct_hint` | localStorage | `{signedIn:bool, initial:'N', v:1}` — paints the chip before `/me` returns; no token, no e-mail | no (prefix outside `wts_`/`h2oil_`) |
| `wtspref_cloud_beta` | localStorage | `1` when `?cloud=1` was used (beta, WP-C1–C2) | no |
| `h2viz3d_prefs`, `wtspref_*` | localStorage | unchanged device prefs | no |
| `__Host-wts_sid` | cookie | session (HttpOnly; script cannot read it) | — |
| `PREF_RE` guard | 29-project-save.js:151 | adds `^wts_acct_|^wts_sync_` so any future key with those prefixes is a preference | — |

The device id is a random UUID made on first sign-in, kept in `wts-sync`; clearing site data makes a new device.

### 5.4 Host and shared-file edits (neutral; they stay in the iOS bundle and do nothing there)
| # | File | Edit | Test |
|---|---|---|---|
| H1 | host `__lsSet` / `WTS_lsSet` (l.945-957) | dispatch `document` `wts:ls-write {key}` after a successful write (and on remove through a new `WTS_lsRemove`) | `acct-host.test.js` |
| H2 | 01, 04, 07, 10, 12, 16, 33, 35, 36, 37, 38, 39, 47, 51, 54, 61, 63 and host clientinfo Save / logo upload / clear, `wts_report_snapshots`, `wts_report_templates` | replace direct `localStorage.setItem` with `WTS_lsSet` (falls back to `setItem` when absent, for the smoke stub) | one assertion per site that `wts:ls-write` fires |
| H3 | 29-project-save `loadFromObject(obj, opts)` | pass `opts.source` into the `wts:project-loaded` detail | yes |
| H4 | 29-project-save | `WTS_project.applyChanges({set:{key:raw}, remove:[keys], modules:{prism?, prism_dataset?, pvt?}}, {source})`: cancel the pending autosave for the affected page only, write with `WTS_lsSet`, write the listed modules, `_prismSync` only if PRiSM / PVT / dataset changed, fire `wts:project-loaded {source, changed}`, `WTS_rerender({discardPending:false})`. Returns `{applied, skipped}` | yes |
| H5 | 29-project-save | `WTS_project.registerMenuItems(group, [{id, label, run, when?}])` rendered after Save As in the Project menu | yes |
| H6 | 29-project-save `PREF_RE` (l.151) | `|^wts_acct_|^wts_sync_` | yes |
| H7 | host plug-in registry | `navHidden:true`: route and title, no sidebar button, no home tile; `calc-registry.test.js` gains the case | yes |
| H8 | host `.page-actions` (~l.810) | `<!-- ACCT:START --><div id="wts_account_host"></div><!-- ACCT:END -->` as the first child | platform test |
| H9 | host sidebar footer (l.803) | `<!-- ACCT:START --><div id="sbAccountLine"></div><!-- ACCT:END -->`; the privacy link text becomes "Privacy — how your data is stored" (true on both platforms) | privacy test |
| H10 | host skip tables | `account` in `PAGE_AUTOSAVE_SKIP` (l.1028), `_REPORT_SKIP` (l.3240), `NO_COPY` (~l.59540), `__UI_NOT_TILE` (l.1535) | yes |
| H11 | host `renderPrivacy` (l.11620-11670) | web / iOS branches (§8.6) | privacy test |
| H12 | host RELEASE_NOTES renderer | optional item field `platform:'web'`; such items are hidden when `window.isIOSApp` (render time, which is correct) | yes |
| H13 | 29-multiwell (WP-M only) | `WTS_wells.applyRemote(id, {keys, modules})` (rewrite a parked blob), `WTS_wells.importWell(blob, meta)` (keep-both copy) | yes |

The edits are applied with node scripts or the Edit tool on the CRLF host file, never `sed -i` (CLAUDE.md).

### 5.5 Module wiring
- **Mount**: `WTS_account` mounts the chip into `#wts_account_host` like the project toolbar (`data-mounted`, on
  DOMContentLoaded or a one-shot `setTimeout(0)`), registers its menu items through H5, and calls `refresh()` only when
  `wtsacct_hint.signedIn` is true (a signed-out first visit makes **no** network request).
- **Listeners** are attached only while signed in **and** linked, and removed on sign-out / unlink.
- **Beta gate** (WP-C1–C2): without `wtspref_cloud_beta` the chip is not mounted and nothing is registered.

---

## 6. Sync algorithm

### 6.1 Snapshot (`WTS_cloudSync.snapshot()`)
1. `await WTS_buildup.store.init()` and the gauge store init (warm mirrors; otherwise `buildup` is omitted and gauges truncate).
2. `WTS_pageAutosave.flush()`; `PRiSM_saveState()`.
3. `payload = WTS_project._buildPayload(meta)` (meta from `h2oil_client_info`).
4. **Strip device-only data**: `modules.storage.keys` loses `wts_modbus_config` unless `opts.liveCfg`, and any key that
   `isProjectKey` would now reject; `skipped[]` is kept as information.
5. **Lift parts**: `modules.prism_gauges`, `buildup_raw`, `buildup_analysis` → parts with those names; each parked well blob in
   the `wells` module → part `well/<id>`; any `storage.keys` value over 64 kB → part `key/<name>`. The core keeps
   `{"$part":"<name>","hash":"…"}` placeholders in their place, plus `cloud:{v:1}`.
6. **Canonical JSON** (sorted keys, no whitespace, numbers as `JSON.stringify` writes them) → SHA-256 for the core and each part.
7. Dirty test: the core hash ≠ `base.coreHash` or a part hash differs. Unchanged → nothing to push.

The inverse (`assemble(core, parts)`) replaces the placeholders and yields an ordinary `.h2oilproj` v1.0 payload; a downloaded
cloud project can therefore always be saved as a file and opened by v3.4.

### 6.2 Triggers
| Trigger | Action |
|---|---|
| any change event (§D9 list) while linked | mark dirty; (re)arm the single 4 s `setTimeout`; if 30 s have passed since the first dirty mark, push now |
| debounce fires | `sync()` |
| Project menu Save to cloud, Ctrl+S when linked, Sync now | `sync()` at once |
| `visibilitychange→hidden`, `pagehide` | if the outbox body is ready and ≤ 60 kB: `fetch(commit, {keepalive:true})`; else leave dirty (next load pushes) |
| `visibilitychange→visible`, `focus`, `online` | if `now − lastPullAt > 30 s` (stored timestamp): `sync()` |
| load, signed in and linked | `sync()` |
| `wts:project-loaded` with `detail.source === 'cloud'` | ignored (echo guard) |
| `wts:project-loaded` from a file Open, or `wts:project-new` | ask (§6.7), never sync silently |
| window `storage` event for `wts_*` from another tab | mark this tab stale; next `sync()` re-snapshots |

After a failed push: `nextRetryAt = now + [30 s, 2 min, 10 min, 30 min][step]`; `sync()` is skipped until then. **No timer is
armed for retries.** Signed out or unlinked: no listener, no timer, no fetch.

### 6.3 `sync()` — one run, under a lock
```
sync():
  navigator.locks.request('wts-sync', {ifAvailable:true}) → if not granted: return (another tab is syncing)
  (fallback without locks: lease key 'wtsacct_lease' {tab, until:now+20 s} in localStorage)
  if offline or signedOut or unlinked: status, return
  1. PULL  head = GET /projects/:id/head
     if head.rev == base.rev:                      → go to PUSH
     if head.rev >  base.rev and local not dirty:  → fastForward(head); return
     if head.rev >  base.rev and local dirty:      → conflict(head)  (§6.5); return
  2. PUSH  snap = snapshot(); if not dirty: return
     missing = POST /blobs/has [snap part hashes + core hash]
     upload each missing blob in 4 MB chunks (PUT), core last
     r = POST /projects/:id/commit {pushId, baseRev: base.rev, core, parts, meta, wells}
       200     → base = snap (store core + hashes), outbox cleared, status 'idle'
       409     → conflict(r.head)
       422     → upload r.missing, commit again once with the same pushId
       413     → status 'quota'; 429 / 5xx / network → nextRetryAt; status 'dirty' / 'offline'
```
The `pushId` is created once per outbox entry, so a retry of the same snapshot after a timeout returns the stored receipt.

### 6.4 Fast-forward (`fastForward(head)`)
1. Download the core and every part whose hash is not already local (local part hashes come from `base` and the safety
   snapshot); verify every SHA-256; refuse and report on a mismatch.
2. Diff the remote assembled payload against the current local payload:
   - only `storage.keys` changed (and not the well list, a part, or `prism_dataset`) → `applyChanges` with the changed keys
     (and `prism` / `pvt` modules when PRiSM keys changed);
   - otherwise → safety snapshot, then `loadFromObject(payload, {source:'cloud'})`.
3. If a changed key is the `wts_page_<route>` of the open page and the focused element's id is one of the changed fields,
   defer the apply until that element's `blur` (one `{once:true}` listener; no timer).
4. Await the gauge and build-up IndexedDB writes, then set `base = remote`, toast "Updated from <device> at 14:20".

### 6.5 Conflicts (v1, WP-C2)
Conflict = the cloud head moved and this device has unpushed changes.
1. Safety snapshot of the local payload.
2. Upload the local snapshot as a **new project** "<name> (conflict — <device label> <dd Mon hh:mm>)", `is_conflict_of = id`,
   `reason:'conflict'`. Blobs are shared, so only changed parts upload.
3. Fast-forward the linked project to the cloud head (§6.4); this device stays linked to the original.
4. Bar: *"This project was also changed on <device> at <time>. Your version was kept as '<name> (conflict…)'.
   [Open my version] [Keep cloud] [Decide later]"*. *Open my version* links the copy; *Keep cloud* offers to trash the copy.
5. **Explicit Save to cloud** hitting a 409 first asks: *"The cloud copy changed on <device> at <time>. [Overwrite cloud with
   this version] [Keep both] [Cancel]"*. Overwrite commits with `reason:'overwrite'` and `baseRev = head.rev`.

### 6.6 Merge (v2, WP-M, S)
`merge3(base, local, remote)` is a pure function in `server/core/merge.js`, concatenated into 67 at build time by
`concat-round10.js` (the same way 64 is generated; never edited in place) and used by the fake server tests.

| Item | Rule |
|---|---|
| `storage.keys` (any key) | changed on one side only → take it; same value both sides → take it; deleted on one side and unchanged on the other → delete; both changed differently → the per-kind rule below, else **clash** |
| `wts_page_<route>` `{v,t,f,tabs,x}` | per field id in `f` as above; `tabs` / `x` follow local; `t` = max; a field changed differently on both sides → clash of that field only |
| `h2oil_client_info` | per field; `clientLogo` atomic |
| `wts_prism_pvt` | per field with its `provenance` entry; a `user` / `correlation` value beats a `default` / `sample` one without a clash |
| `wts_report_templates` | per template id; `defaultId` follows local |
| `wts_report_snapshots` | per page; newer `at` wins; never a clash (derived) |
| `wts_buildup_audit` (hash chain) | one chain a prefix of the other → the longer; else clash (never spliced) |
| PRiSM bundle (`wts_prism`, `wts_prism_state`, `wts_prism_*` keys, the `prism` and `prism_dataset` modules) | atomic: any difference on both sides → clash of the bundle |
| parts | by hash: changed on one side → take it; both → clash of that part |
| well list | union by id; rename → later `modified` wins; delete vs edit → keep the well |
| library document | union per entry; same name, different value → keep both ("<name> (other device)") |

A **clash** is resolved per item by the user: *Keep mine*, *Keep cloud*, or *Keep both*: for the PRiSM bundle, the local fit
is saved as a PRiSM workspace branch (51 already has branches); for a page or a part, the local well is added as a copied
well "<well> (this device, hh:mm)" via `WTS_wells.importWell`. Unclashed items are applied at once. If the base revision was
pruned (`410 resync`), the v1 conflict copy rule applies.

### 6.7 Project lifecycle while signed in
| Local action | Behaviour |
|---|---|
| New | *"Start a new cloud project, or a local-only one?"* → create + link, or unlink. The cloud project is never changed by New |
| Open file | *"Open as a new cloud project / local only / replace the linked cloud project's contents"* (the last commits `reason:'save'`) |
| Switch well | not a cloud change by itself: the parked blob of the old well becomes a changed part on the next push |
| Open from cloud while dirty | push first; if offline: *"Save this project to a file first"* with the existing Save; never discard silently |
| Sign out | §10.4 |

### 6.8 Worked examples
**E1 — fast-forward.** Laptop A and PC B are linked to project P at rev 41. A edits the Hydrate page; 4 s later A pushes:
`has` → missing = [core]; PUT core (12 kB gzip); commit `baseRev 41` → rev 42. B gets focus 10 min later: head 42 > 41,
B is clean → download core, diff = one key `wts_page_hydrate` → `applyChanges` → Hydrate re-renders; toast. Bytes: ~12 kB
each way.

**E2 — offline then online.** B is on a rig with no link. Edits ESD Hi pilot and the PRiSM fit. Pushes fail →
`nextRetryAt`; chip "○ 2 changes waiting". The link returns: `online` → `sync()` → head still 42 → push → rev 43.

**E3 — conflict, different pages (v1 / v2).** A (rev 42) edits Liquid Line offline; B edits Pipe Service Life and pushes
rev 43. A comes online: head 43 > base 42 and A is dirty →
v1: A uploads its snapshot as "P (conflict — Laptop 07 Nov 14:02)" (only its core uploads: parts unchanged), fast-forwards P
to 43, shows the bar. v2: `merge3` takes `wts_page_pipelife` from cloud and `wts_page_liquidline` from local → applies 43,
pushes the merged core as rev 44; no copy, no bar.

**E4 — same field (v2).** Both changed `wts_page_hydrate.f.hy_T` (A 38 °F, B 41 °F): only that field clashes; other fields
merge. The bar offers *Keep mine (38) / Keep cloud (41) / Keep both* (both → a copied well holding A's page).

**E5 — PRiSM clash (v2).** A refit the build-up (new `lastFit`), B changed the model on the same well. The bundle is atomic →
clash. *Keep both* saves A's fit as a PRiSM workspace branch "this device 14:02" under B's state.

**E6 — gauge import.** A imports a 9 MB gauge file (gzip 3.1 MB). Snapshot: part `prism_gauges` hash h1 is new → one 3.1 MB
chunk PUT, then a 14 kB core and the commit. The next ten page edits upload only the core. B pulls once: downloads h1 (3.1 MB)
and later only cores.

**E7 — timeout and retry.** A's commit for rev 45 reaches the server but the response is lost. On the next event A sends the
same outbox entry with the same `pushId` → the server returns the stored receipt `{rev:45}`; no rev 46, no false conflict.

**E8 — two tabs.** Tabs T1 and T2 on one device share localStorage. Both arm a debounce. T1 gets the lock and pushes rev 46;
T2's `ifAvailable` lock fails, it returns; on its next trigger T2 pulls, sees head 46 = what T1 stored in the shared `wts-sync`
base, and its snapshot hash equals the base → nothing to push.

---

## 7. Inventory: what syncs and what stays on the device

| Store / key pattern | Owner | Typical → max | Class | Cloud |
|---|---|---|---|---|
| `wts_page_<route>` | host autosave | 0.2–5 kB per page | well work | **core** |
| legacy `wts_<key>` lists (esdhi*, esdlo*, hydrate*, ll_*, pl_*, pipelife, fluid_*, prv_*, flare, oilgas …) | host, 27 | < 5 kB | well work | core |
| `h2oil_client_info` (incl. `clientLogo` data URL) | host | 1 kB; logo 0.1–1 MB | well work, sensitive | core; part `key/h2oil_client_info` when > 64 kB |
| `wts_report_snapshots` | host Quick Report | 5–50 kB | derived work | core / part |
| `wts_prism` (paste text) | 01, 07, 33 | 1 kB → MBs (> 2 MB skipped by the project layer) | well work | core / part |
| `wts_prism_state`, `wts_prism_pvt`, `wts_prism_mrate`, `_crop`, `_rta`, `_dca`, `_units`, `_report_notes`, `_skincheck` | 33, 16, 37, 51, 12, 35, 07, 36, 54 | 5–100 kB | well work | core (PRiSM bundle in WP-M) |
| module states `prism` (schema 2), `prism_dataset`, `pvt` | 29-project-save | 10 kB–MBs | well work | core / part |
| `wts_prism_rec_*` (localStorage fallback) | 19 | MBs | well work | core / part (via the storage module) |
| IndexedDB `wts_prism` gauges (`prism_gauges`, ≤ 18 MB mirror) | 19 | MBs | well work | **part `prism_gauges`** |
| `wts_buildup_state` (≤ 300 kB), `wts_buildup_audit` (≤ 200 kB, chain-hashed) | 49-calc-buildup-store | 10 kB per test | well work, sign-off names | core |
| IndexedDB `wts_buildup` raw / tests (≤ 16 MB) | 49-calc-buildup-store | MBs | well work | **parts `buildup_raw`, `buildup_analysis`** |
| `wts_sim_rigup` | 38 | < 1 kB | work | core |
| `wts_historian_settings`, `wts_historian_view`, `wts_wellos_ui` | 47, 63 | < 1 kB | settings | core |
| `wts_mw_results` | 29-multiwell | < 5 kB | derived | core (cheap; rebuilt anyway) |
| `wts_wells` + `wts_well_<id>` parked wells | 29-multiwell | tens of kB → MBs each | work | core (list) + **part `well/<id>`** each |
| `wts_report_templates`, `wts_base_conditions`, `wts_base_auto` | host, 22 | < 20 kB | job work | core |
| in-memory modules `wts`, `esdhi`, `esdlo`, `hydrate`, `liquidline`, `pipelife`, `units`, `clientinfo` | 29-project-save | small | derived | core (kept: the payload is the only consistent copy; a round-trip test may later allow dropping them) |
| `wts_prism_user_curves`, `wts_prism_presets`, `wts_prism_mapping_<sig>` | 10, 04, 07 | 1–100 kB | user library | **account library document** (also stays in project files as today) |
| `wts_modbus_config` | 61 | 1–30 kB | config, sensitive (device IPs, bridge URL) | **opt-in** (`opts.liveCfg`), stripped otherwise |
| historian (OPFS database / sql snapshot / IndexedDB) | 47 | up to hundreds of MB | live data, device-wide | **opt-in manual backup** (gzip of its JSON backup, ≤ 100 MB) |
| `wts_unit_system`, `wts_ui_*`, `wts_prism_sample_suppress`, `wts_prism_migrated` | 22, host | < 1 kB | device prefs | **never** |
| `wtspref_*`, `h2viz3d_prefs`, `wtshist_home`, `wtshist_spool`, sessionStorage `wts3d_*` | 50, help, 38, 47 | < 5 kB | device prefs / bookkeeping | never |
| IndexedDB `h2oil-wts3d`, service-worker caches | 32, sw.js | library / app code | cache | never |
| `wts_buildup_audit_corrupt_<ms>` | buildup store | ≤ 200 kB | forensic | never |
| `wts-sync`, `wtsacct_hint`, `wtspref_cloud_beta`, the session cookie | 66–67 | small | sync state | never |

Size guard: a project's compressed total over **64 MB** is refused with a list of the largest parts and the choice to keep
gauges and build-up raw data local (the upload then marks them `skipped`); the project layer's 2 MB per-key skip still applies.

---

## 8. Security, privacy and UK GDPR

### 8.1 Threat model
| # | Threat | Likelihood / impact | Mitigation | Residual |
|---|---|---|---|---|
| T1 | Session theft through XSS (no strict CSP possible) | medium / high | HttpOnly `__Host-` cookie, SameSite=Strict; no token in script, storage or memory; escape every server and payload string (`_rEsc`, `_safeImgSrc`) | an injected script can act as the user while the page is open → T2 |
| T2 | Script on the page abuses a live session (bulk download, delete) | low / high | step-up for export, delete, passkey and e-mail changes, sign out everywhere; blob GET rate limit 500 MB/h; audit and "new device" mails; CSP blocks exfiltration to foreign hosts | reads within the rate limit |
| T3 | CSRF | low / high | SameSite=Strict, exact Origin (missing refused), `X-WTS-Req`, JSON content type (forces a preflight that is never answered), GET never mutates, `frame-ancestors 'none'` | — |
| T4 | Account enumeration | high / low | uniform 202 with padded timing; empty `allowCredentials`; generic verify errors | — |
| T5 | Code guessing / mail bombing | medium / medium | 10⁸ space, 5 tries per code, per-address / per-IP / global send limits, circuit breaker; soft throttle only | — |
| T6 | Lockout used against a user | medium / medium | no hard account lock; only the code channel is throttled; passkeys keep working | — |
| T7 | Cross-tenant data access through a bug | low / high | forced RLS, `wts_api` without BYPASSRLS, `SET LOCAL app.user_id`, server-built blob keys, same 404 for absent and foreign ids | — |
| T8 | Database / bucket / backup leak | low / high | envelope encryption of bodies and `meta`, e-mail display form encrypted, hashes for codes and session ids; master key only in host secrets | e-mail addresses (normalised, needed for sign-in), sizes and times |
| T9 | Blob swap or replay by a storage-level attacker | low / medium | AES-GCM AAD binds user, hash, chunk and key id; the client verifies part SHA-256 against the commit | — |
| T10 | Deploy-preview copies of production data | medium / high | previews get no production database or secrets; the API refuses any non-production Host | — |
| T11 | Malicious or broken deploy of the app code | low / critical | two-person review of `server/` and 66–68, tagged deploys from master, published SHA-384 of the account block, kill switches | a web app trusts the code it is served |
| T12 | iOS bundle ships account code | low / medium | text strip + hard-fail check + runtime guard + Origin refusal (§9) | — |
| T13 | Stolen unlocked device | medium / high | public-computer mode, sign out everywhere, device revoke | local copy is plaintext, as today |
| T14 | Decompression bomb / oversized body | medium / low | size caps before parse; the server never gunzips user content | — |
| T15 | Data loss by sync | medium / high | CAS, pushId, pull-before-push, conflict copies, safety snapshots, 20 revisions + 30 daily, trash 30 days | — |

### 8.2 Headers and CSP (host headers config)
Report-Only first (WP-OPS, reports to `/api/v1/csp-report`, rate-limited), enforced in WP-I:
```
default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: <analytics loader host> <the two CDN hosts>;
worker-src 'self' blob:; connect-src 'self' <CDN hosts> <analytics hosts> ws://127.0.0.1:* ws://localhost:*
http://localhost:* http://127.0.0.1:*; img-src 'self' data: blob: <analytics hosts>; style-src 'self' 'unsafe-inline';
font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```
(The exact host list is in the owner's vendor notes, not here. The localhost entries keep the Modbus bridge working.) Also
`Referrer-Policy: same-origin`, `Permissions-Policy: publickey-credentials-get=(self), publickey-credentials-create=(self)`,
`Cache-Control: no-cache` on the page and `sw.js` (already a documented requirement), HSTS unchanged. Removing the six direct
`eval` uses and the inline handlers (to allow a nonce-based `script-src`) is a separate hardening track, not this release.

### 8.3 Rate limits (Postgres counters, fixed windows, no timers)
| Action | Limit |
|---|---|
| code start | 5/h and 20/day per address; 20/h per IPv4 /24 or IPv6 /48; 500/h site-wide → sending pauses, owner alerted |
| code verify | 5 tries per code; 10 failures per address per 24 h → codes for that address paused 1 h (notice mail) |
| passkey verify | 30/min per IP |
| commit | 120/h per device |
| chunk PUT | 2 GB/day per user |
| blob GET | 500 MB/h per user |
| export | 5/day |

### 8.4 Privacy and UK GDPR
- **Roles**: H2Oil is the controller. Processors: the static host (functions, database, blob store) and the e-mail service;
  data processing agreements on file; a record of processing; a short DPIA (commercially confidential well data, client and
  engineer contact data); check the data-protection fee registration. Data stays in the UK or the EU (UK adequacy); any
  processor transfer outside them needs the UK transfer addendum.
- **Lawful basis**: contract (the account service under Terms of Use). Explicit opt-in for historian backups and live-data
  connection settings. No marketing mail. No use of project data for analytics, advertising or model training.
- **Consent record**: `terms_version`, `privacy_version`, `consented_at`; a version bump asks again at the next sign-in.
- **Analytics**: only allow-listed anonymous events `account_signin`, `cloud_save`, `cloud_open` with no parameters outside
  the allow-list, never an e-mail or user id (`privacy-analytics.test.js` extended).
- **Export (portability)**: *Export everything* (step-up) = a zip built in the browser with the 65 zip writer: one
  `.h2oilproj` per cloud project (assembled from core + parts), `library.json`, `account.json` (the server export: profile,
  consents, devices, passkey names and dates, own audit rows). Works offline from nothing; needs the network once.
- **Deletion**: step-up → status `deleting`, every session revoked, projects hidden at once; rows and blobs purged by the daily
  job within 24 h; audit rows kept 12 months with `user_id` replaced by a random tombstone and no e-mail hash; a confirmation
  mail. Backups age out within the platform retention (≤ 30 days) and our own weekly export (35 days). Local data on devices
  is not touched; the dialog offers "Also clear this browser".
- **Retention**:

| Data | Kept |
|---|---|
| account | while active; warning mails at 23 and 23.5 months without sign-in, deletion at 24 months |
| revisions | last 20 + one per day for 30 days + those behind conflict copies |
| trash | 30 days |
| codes, challenges | 24 h |
| sessions | until expiry |
| rate counters | 7 days |
| push receipts | 24 h |
| audit | 12 months |
| historian backups | until replaced or deleted by the user |
| backups | platform ≤ 30 days; weekly export 35 days |

### 8.5 Privacy page text (`renderPrivacy`, web branch; the iOS branch keeps today's text unchanged)
Banner (web): **"Your well data stays on this device unless you sign in to the cloud."**

New card *"Accounts and cloud projects (web version, optional)"*:
> You can use the Well Testing Suite without an account: everything then stays in this browser on this device, as before.
> If you create an account, the projects you save to the cloud — page inputs, PRiSM analyses, wells, build-up surveillance
> data, report snapshots and templates, your curve and preset library, and, only if you turn them on, historian backups and
> live-data connection settings — are stored in our cloud database in the UK / EU, encrypted at rest with a key for your
> account. We store your e-mail address, the public keys of any passkeys you add (never a password), the devices you sign in
> on and a security log (shortened IP address, browser type) for 12 months. We never use your project data for analytics,
> advertising or training, and we do not share it. You can export everything or delete your account at any time from
> Account; deletion removes your data from our live systems within 24 hours and from backups within 30 days. Data on your
> devices stays until you clear it. The iOS app has no accounts and keeps everything on your device.
> Questions and data requests: software@h2oil.co.uk.

Also updated (with web / iOS variants where the text is shared): `48-calc-help-start.js:16` ("Nothing is sent to a server…" →
"Nothing leaves your device unless you sign in and save to the cloud (web version)"), the host "Where your data is" text
(~l.104102), the release-notes UX wording, the `privacy` help guide (re-review, new `reviewedSrc` via `--hash privacy`),
`privacy-analytics.test.js:297`, the `sw.js` header comment ("User data … never goes over HTTP" → "… except the optional
signed-in cloud sync on /api, which this worker never caches"). Terms of Use are a new owner document linked from the
consent step; LICENSE §3 may mention the account service (owner).

---

## 9. iOS exclusion (four layers)

1. **Text strip** in `ios-app/scripts/sync-from-main.js`, after the existing GA (step 0) and SW (step 0b) strips:
   - step 0c (JS): `/\/\/ ── ACCT:START[\s\S]*?\/\/ ── ACCT:END ──/g` → `// (accounts and cloud sync: web only — stripped from the iOS bundle)`;
   - step 0d (HTML): `/<!--\s*ACCT:START[\s\S]*?ACCT:END\s*-->/g` → `<!-- account control: web only -->`;
   - the sync **fails** if the start / end marker counts differ before stripping, or if `WTS_account`, `WTS_cloudSync`,
     `/api/v1` or `wts_account_host` remain in the output.
2. **Runtime guard** (§5.1): exact host name, no native bridge, not framed; dev only with `WTS_ACCOUNT_DEV = 1` on localhost.
3. **Server**: the API refuses every Origin other than `https://welltest.h2oil.co.uk`, so `capacitor://localhost` and
   `file:` cannot use it.
4. **Neutral host edits** (H1–H7, H12) exist in the iOS bundle but nothing registers against them; the privacy page and
   release notes branch on `window.isIOSApp` at render time.

`server/` is never copied by `sync-from-main.js` and `ios-sync.yml` does not watch it. Tests: §11.4.

---

## 10. Migration of local data

1. **When**: after the first successful sign-in on a device for a given user (`wts-sync.migratedFor` lacks the user id).
2. **Classify** the local store: *empty* (no project key, no wells); *has work*; *linked to another account* (refuse: offer
   sign-out or "Unlink this device").
3. **Account empty, device has work** → dialog *"Put the work on this device into your account?"* with a preview: name
   (client / well from client info), wells, pages with inputs, PRiSM analyses, build-up tests, compressed size. Default
   **Upload as a new cloud project** (`reason:'migrate'`, progress bar, resumable through the outbox). Libraries go to the
   account library (union). Historian and live-data settings are asked separately (opt-in).
4. **Account has projects, device has work** → *Upload as a new project* (default) / *Open a cloud project instead* (local
   work first saved as a downloaded `.h2oilproj` and a safety snapshot) / *Not now* (signed in, unlinked; the chip says
   "This device's project isn't in the cloud").
5. **Device empty, account has projects** → offer to open the most recently saved project.
6. **Over the size cap** → the preview lists the large parts and offers to upload without gauges / build-up raw data.
7. **Multi-well**: one local project with N wells becomes one cloud project with N well parts.
8. **Sign out** (§10.4): *"Keep a copy of the open project in this browser?"* — default *Keep* on a trusted device, *Remove* on
   a public one. Remove = `WTS_project.newProject()` plus library clear; the historian stays unless the user also ticks it.

---

## 11. UI

### 11.1 Header chip (`#wts_account_host`, first in `.page-actions`)
| State | Desktop | Phone (390 px) |
|---|---|---|
| signed out | button "Sign in" | icon button (44 × 44 px, `aria-label="Sign in"`) |
| synced | initial + "● Synced 14:02" | initial with a green dot |
| dirty / waiting | "○ 3 changes waiting" | amber dot |
| syncing | "⟳ Syncing" | spinner dot (CSS animation only while syncing; no timer) |
| offline | "○ Offline — saved on this device" | grey dot |
| conflict | "⚠ Conflict" | red dot |
| over quota | "⚠ Storage full" | red dot |
| paused / read-only | "Cloud sync paused" / "Cloud read-only" | grey dot |
| unlinked | initial + "Not in cloud" | initial, hollow dot |

Menu: masked e-mail · Sync now · Save to cloud · Open from cloud… · Account & projects · Sign out · Sign out everywhere.
Status text is `aria-live="polite"`. `WTS_a11y.apply` labels the controls.

### 11.2 Sign-in dialog
`<dialog>` with `role=dialog`, `aria-modal`, focus return, Escape closes; `.rp-skip data-rp-nosnap` (not in reports or
autosave). Steps: (1) e-mail (`autocomplete="username webauthn"`, `inputmode=email`) + "Send code" (+ "Use a passkey" when
supported) + tick box "This is a public or shared computer"; (2) code (`autocomplete="one-time-code"`, `inputmode=numeric`,
8 digits, paste-friendly) + "Send again" (disabled until the server's limit allows, computed from the reply, no countdown timer);
(3) consent for a new account (Terms of Use and Privacy links, required tick box); (4) after a code sign-in on a device that
supports passkeys: "Add a passkey for faster sign-in" / "Not now"; (5) migration (§10). Offline: "Sign-in needs a connection.
Your work keeps saving on this device." At 390 px the dialog is a full-width sheet with 16 px gutters; form controls stay
≥ 16 px.

### 11.3 Account page (route `account`, `#acct_root`, `navHidden`)
Cards (plain `.card` markup, but the route is in every skip table):
1. **Profile** — masked e-mail, created, change e-mail (step-up), Terms / Privacy versions.
2. **Cloud projects** — `table.dtable`: name, client / well, wells, last saved (device, time), size; Open, Rename, Duplicate,
   History (revisions with device, time, reason; *Restore*), Download `.h2oilproj`, Move to trash; Trash section with Restore
   and Delete forever (step-up); conflict copies flagged "conflict copy of …". Client-side filter box.
3. **Devices** — label, last seen, "this device", public flag; Rename, Sign out device; Sign out everywhere.
4. **Passkeys** — name, created, last used; Add, Rename, Remove.
5. **Sync options** — historian backup (opt-in; *Back up now*, *Restore…* merge / replace, last backup size and time);
   live-data connection settings (opt-in).
6. **Storage** — used / quota bar.
7. **Data** — Export everything; Delete account.
8. **Activity** — the user's own audit rows (90 days).

Every server string is shown as text (`_rEsc`). At 390 px tables become stacked rows (the existing `.dtable` phone rules).

### 11.4 Bars
`#wts_sync_bar`, modelled on `#wts_sw_bar` (fixed bottom, z-index 10040, block layout): conflict, signed out ("Signed out —
sign in to keep syncing [Sign in]"), offline with waiting changes (shown once per offline period, dismissible), paused. No
`html.ios-app` rule is needed (stripped on iOS); a test asserts the bar does not exist in `www`.

---

## 12. Tests

### 12.1 Fake server (`prism-build/tests/_acct-fake-server.js`)
The real `server/core` logic plus an in-memory adapter: users, codes (a captured outbox the test reads), passkey ceremony
with a test key pair, sessions and a cookie jar per app, Origin / header checks, projects, revisions, blobs and chunks,
pushId receipts, quotas, rate counters, kill switches, and fault modes (401, 403 reauth, 404, 409, 410, 413, 422, 426, 429,
5xx, network error, lost response). Latency through the harness manual timers. Use:
`loadApp({globals:{fetch: fake.fetch, location: {href:'https://welltest.h2oil.co.uk/well-testing-app.html'}}})` plus
`WTS_account.configure({idb: fakeIdb, minDelayMs: 0})` (the IndexedDB fake extends `_buildup-idb-fake.js`). Two apps with
separate storage on one fake server = two devices; two apps sharing storage = two tabs.

### 12.2 New acceptance files (budget = test count / wall time)
| File | WP | Covers | Budget |
|---|---|---|---|
| `acct-host.test.js` | WP-H | `wts:ls-write` from every moved site; `applyChanges`; `registerMenuItems`; `navHidden`; `loadFromObject` source; `PREF_RE`; RELEASE_NOTES `platform:'web'` | 24 / 6 s |
| `acct-signin.test.js` | WP-C1 | code flow, consent, uniform responses, generic errors, rate limit reply, step-up, sign-out, everywhere, public mode, 401 → signed-out chip | 16 / 5 s |
| `acct-cloud.test.js` | WP-C1 | Save to cloud, Open from cloud (safety snapshot, refusal when dirty and offline), list, rename, trash, history, restore revision, download file, escape of names (`<img onerror>`) | 14 / 6 s |
| `acct-sync.test.js` | WP-C2 | snapshot split / assemble round trip (= `.h2oilproj` v3.4 opens it), canonical hash, debounce (one timer, settles), burst cap, no timer signed out, triggers, echo guard, keepalive size rule, `nextRetryAt` without timers, pushId replay, 422 path, chunking, dedup, fast-forward via `applyChanges`, focus-deferred apply, multi-well parts, gauges and build-up through the IDB fake | 26 / 10 s |
| `acct-conflict.test.js` | WP-C2 | E3 v1, E7, E8, overwrite path, conflict copy links, safety snapshots kept (2) | 10 / 5 s |
| `acct-migrate.test.js` | WP-C2 | §10 cases 2–8 | 9 / 4 s |
| `acct-merge.test.js` | WP-M | `merge3` table rows, E3 v2, E4, E5 (branch), audit-chain prefix, pvt provenance, library union, 410 resync | 18 / 5 s |
| `acct-account.test.js` | WP-C3 | account page cards, passkey add / remove (stub), devices, export zip contents, delete flow, historian backup / restore (merge / replace), opt-in stripping of `wts_modbus_config` | 14 / 6 s |
| `acct-ios.test.js` | WP-C1 | sync into `WTS_SYNC_OUT_DIR`: no ACCT code, markers, ids or `/api/v1` in `www`; strip comment present; unbalanced markers fail; `capacitor:` / `file:` / framed / other host → `WTS_account.eligible === false`, no DOM, no fetch; iOS privacy text unchanged; web-only release note hidden on iOS | 9 / 8 s |
| `acct-privacy.test.js` | WP-HC | web / iOS privacy texts, analytics allow-list for the three events, help texts | 6 / 2 s |

About **146 tests, under 60 s** in total. Existing tests that change: `privacy-analytics.test.js` (strings at l.297, strip
regex list), `platform-export.test.js` (ACCT checks beside SW), `calc-registry.test.js` (`navHidden`), `help-content.test.js`
(new `account` guide, `privacy` hash), `sidebar-nav.test.js` (unchanged count asserted).

### 12.3 Smoke test additions (`smoke-test.js`)
1. In the vm stub (http location): `WTS_account.eligible === false`, no `WTS_cloudSync`, no listener added, no timer.
2. With an https production location stub and `fetch` rejecting: loads, `eligible === true`, signed-out state makes **no**
   fetch and leaves **no** timer after 5 s.
3. Signed in and linked (fake fetch), one change event: exactly one pending timer, none after 5 s idle.
4. `WTS_calcRegistry.account` is well-formed with `navHidden:true`.
Counts move from 330 to 334 smoke checks and from 1369 to about 1515 acceptance tests (CLAUDE.md updated at WP-I).

### 12.4 Server tests (`server/test/`)
Core units (validation, canonical hash, envelope round trip and AAD tamper, rate windows, revision CAS, pushId, pruning,
quota); API against the in-memory adapter (every endpoint and error code in §3.2); Origin / header refusal; enumeration
timing pad; deletion purge; optional `rls.test.js` against a local Postgres (user A cannot read or write B's rows through
`wts_api`; FORCE RLS on every table; no BYPASSRLS). About 80 tests.

### 12.5 GUI sweep and help
`gui-sweep.js`: `serve()` answers `/api/v1/me` with `401` and other `/api/v1/*` with a minimal fake (a canned code) so the
signed-out and sign-in paths are swept; the destructive regex gains `sign out|log out|delete account|revoke|delete forever`;
`account` is added to the routes (with `WTS_ACCOUNT_DEV = 1` injected). Help: a web-only `account` guide (hidden on iOS),
header screenshots re-shot with `help-shots.js` in the Linux container, then Round 9, the user guide and sync (CLAUDE.md 4f).

---

## 13. Operations and cost

### 13.1 Operations
- **Environments**: production (functions UK, database UK/EU, blobs EU, production secrets only here); preview (separate empty
  database with synthetic data, no production secrets, sign-in disabled unless a preview flag is set); local (fake server).
- **Secrets** (host environment secrets, never in the repository): master key(s) with key ids, code pepper(s), session pepper,
  e-mail sending credential, ops-job signing key. Rotated every 12 months; one old version accepted for one rotation.
  Master-key escrow kept offline by the owner.
- **Backups**: platform daily database backups (longest retention the plan offers, target 30 days); our own weekly logical
  export of the database plus a blob manifest, encrypted with a separate key, to separate storage in another region, kept 35
  days; blob store versioning or copy kept 30 days; a restore drill every quarter into a scratch database (`server/RUNBOOK.md`).
- **Monitoring**: `/api/v1/health` checked by an external uptime check; alerts by mail to the owner for 5xx > 2 % over 10 min,
  p95 latency > 2 s, code sends above the breaker, failed verifies > 5 × baseline, 429 spikes, storage > 80 % of plan, mail
  bounce / complaint rates, deletion-job lag. Logs hold request id, user id, route, status, latency and a truncated IP —
  never e-mail addresses, codes, cookies or bodies.
- **Kill switches** (environment flags): `ACCOUNTS_SIGNUP=off` (existing users only), `SYNC_MODE=readonly` (pull and export
  only), `SYNC_MODE=off` (503 paused), `ACCOUNTS_OFF` (whole API 503).
- **Incident runbook**: triage → contain (kill switch; truncate `sessions` to sign everyone out; rotate peppers / master key) →
  assess (what personal data: e-mails and metadata are readable, bodies are encrypted) → notify the ICO within 72 h when
  required and affected users without undue delay → post-mortem in PROJECT-NOTES.md.
- **Releases**: migrations `server/db/migrations/NNN-*.sql` applied by the deploy step; API versioned `/api/v1`; a minimum client
  version (`426`); production deploys only from tagged commits on master after two-person review.

### 13.2 Load and cost model (prices in the owner's vendor notes, not here)
| Users | Stored (compressed, deduplicated) | Requests / month | What it needs |
|---|---|---|---|
| 10 | ~50 MB | ~30 k | the host's entry paid tier (the free plan is ruled out by D17); e-mail within a free allowance |
| 1,000 | ~5 GB | ~3 M | entry or standard tier; database storage at the platform rate; e-mail ≤ a few thousand a month |
| 10,000 | ~50 GB | ~30 M | team tier; database mostly metadata (< 1 GB) because bodies sit in the blob store |

Assumptions: an active user saves ~20 times a day, ~15 kB per core commit (gzip), one large part upload a week; pulls are
head-only (~200 bytes) unless something changed. Cost levers: head-only checks, hash short-circuit, gzip, dedup, 4 s debounce,
pulls only on events, the database sleeping when idle (a cold start of ~1 s is acceptable for sync), revision pruning, quotas.
Set a spend alert at 80 % of the plan.

---

## 14. Work packages

Roles: **owner** (product owner: decisions, accounts with providers, legal texts), **lead** (integrator: host edits, build,
CLAUDE.md, release), **server** (server developer), **client** (client developer), **reviewer** (second person for
`server/` and 66–68). One person may hold several roles, but never both author and reviewer of the same change.
Branch `accounts` off `Dev`; work packages merge there; `Dev` only at WP-I. DFIT branches and `docs/DFIT-PLAN.md` are never
touched; the lead agrees the release number with the DFIT lead.

| WP | Owner | Content | Files | Days | Needs |
|---|---|---|---|---|---|
| WP0 | owner + lead | answer §16; leave the free host plan; regions; e-mail sender + SPF / DKIM / DMARC; DPAs; Terms of Use and privacy notice drafts; spend alert | (outside the repo); `server/RUNBOOK.md` skeleton | 2 + owner | — |
| WP-H | lead | host edits H1–H12, setItem moves, tests `acct-host` | host, 29-project-save, 01/04/07/10/12/16/33/35/36/37/38/39/47/51/54/61/63 | 5 | — |
| WP-S1 | server | schema + migrations + RLS + roles; envelope encryption; code auth, sessions, devices; rate limits; audit chain; projects, revisions, blobs, commit CAS, pushId, quotas; library; health; headers; kill switches; `server/test` | `server/**` | 9 | WP0 |
| WP-C1 | client | 66-account (guard, markers, API client, dialog, consent, chip, bar), manual Save / Open from cloud in 67, project list in 68, `sync-from-main` strip 0c / 0d, fake server, tests `acct-signin`, `acct-cloud`, `acct-ios`; beta flag | 66, 67, 68, `ios-app/scripts/sync-from-main.js`, tests | 7 | WP-H, WP-S1 |
| WP-C2 | client | automatic sync (§6.1–6.5), parts and chunks, applyChanges path, focus deferral, locks, outbox, migration, library document; tests `acct-sync`, `acct-conflict`, `acct-migrate` | 67, tests | 8 | WP-C1 |
| WP-C3 | client + server | passkeys (register, sign-in, conditional UI), step-up UI, account page complete, export everything, delete account + purge job, historian backup / restore, live-config opt-in; `acct-account` | 66, 68, 67, `server/**` | 6 | WP-C2 |
| WP-OPS | server + lead | CSP Report-Only → report endpoint, headers config, preview isolation, weekly encrypted export, monitoring and alerts, restore drill, `acct-hash.js` | `server/**`, host headers config, `prism-build/acct-hash.js` | 4 | WP-S1 |
| WP-HC | lead | privacy page branches, help `account` guide and text updates, `privacy` hash, screenshots, `acct-privacy`, GUI-sweep fake API | host, 48-calc-help-*.js, gui-sweep.js, help/** | 3 | WP-C3 |
| WP-M (S) | client | `server/core/merge.js` + concat step, three-way merge §6.6, clash UI, `WTS_wells.applyRemote` / `importWell`, `acct-merge` | `server/core`, 67, 29-multiwell, concat-round10.js | 6 | WP-C2 |
| WP-I | lead + reviewer | security review against the session / authentication / access-control chapters of a recognised application-security verification standard; abuse and load test; 5–10 user beta for 2 weeks; CSP enforce; RELEASE_NOTES (`platform:'web'`); CLAUDE.md (Round-10 files, ACCT rule, counts); full rebuild, smoke, acceptance, sync; merge to `Dev` then master | all | 5 | all |

**Total ≈ 55 person-days including WP-M** (≈ 49 without it). First usable beta (sign-in, manual Save / Open from cloud):
WP0 + WP-H + WP-S1 + WP-C1 ≈ 23 days. Automatic sync: + WP-C2 ≈ 31 days. Each WP ends with the build incantation, smoke and
acceptance green and the iOS strip test green.

---

## 15. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| localStorage quota (~5 MB) when a large cloud project is opened | apply fails part-way | check size before apply; parts stay in IndexedDB-backed stores; refuse with "open as file" and the safety snapshot intact |
| Function request / response limits | large uploads fail | 4 MB chunks; blob GETs per chunk |
| Database cold start | first sync of the day ~1 s slower | acceptable; chip shows "Syncing" |
| Setitem sites missed in WP-H | some changes upload only at the next other event | key-hash diff on every existing event and on `pagehide`; `acct-host` asserts each site |
| `loadFromObject` side effects on fast-forward | lost focus, re-render flicker | `applyChanges` for key-only diffs; focus deferral |
| Conflict copies pile up before WP-M | confusing project list | "conflict copy of …" badge; *Keep cloud* offers to trash the copy; WP-M early |
| Hash-chained build-up audit across devices | broken chain | never splice; prefix rule; keep both |
| Shared rig PCs | data left behind | public mode default prompts; sign-out clear |
| Mail deliverability | users cannot sign in | dedicated sender with SPF / DKIM / DMARC; passkeys as the second path |
| Free-plan pause | the whole site offline | D17 before the beta |
| Abuse (sign-up spam, storage) | cost | rate limits, breaker, quotas, `ACCOUNTS_SIGNUP=off` |
| DFIT and accounts in the same release window | merge conflicts in host and CLAUDE.md | separate branches; host edits small and isolated; release number agreed (Q14) |
| Regulator or client asks for UK-only storage | blob store has no UK region | Q6: database UK, bodies EU by default; a UK object store is a later switch (the blob key scheme does not change) |

---

## 16. Decisions for the owner (each has a recommended default; work proceeds on the default unless changed)

| # | Question | Recommended default | Alternatives |
|---|---|---|---|
| Q1 | Backend option | **Own minimal API in the host's functions + managed Postgres + blob store** (D2) | the host's own identity service (cheapest, no passkeys or codes, unknown data region, already deprecated once); a separate auth-plus-database service (less own code, large client SDK, idle-pause on its free tier) |
| Q2 | Sign-in methods | **E-mail code + passkeys**, no passwords | add passwords (more support, credential stuffing); add social sign-in (third-party dependency, not wanted) |
| Q3 | Sessions | trusted 14 d idle / 90 d absolute; public 12 h / 7 d; "public computer" unticked by default | public ticked by default on every sign-in |
| Q4 | Encryption level | **server-side envelope encryption** now; optional end-to-end vault later (format ready) | end-to-end from day one (a lost key loses data for good; ~+25 days; no support recovery) |
| Q5 | Free vs paid accounts | **free**, 250 MB quota, 64 MB per project, 100 MB historian backup | paid tiers for larger quotas (needs payments and terms; not planned) |
| Q6 | Data region | functions UK, **database UK (else EU), bodies EU** | everything EU; UK-only when a UK object store is available |
| Q7 | Retention | revisions 20 + 30 daily; trash 30 d; audit 12 months; inactive accounts deleted after 24 months with two warnings | longer history (cost), 36-month inactivity |
| Q8 | Live-data connection settings | **opt-in, off** | sync by default (exposes site network addresses) |
| Q9 | Historian | **manual opt-in backup / restore** | automatic backup on Save to cloud (cost, bandwidth) |
| Q10 | Account page placement | **header chip only (`navHidden`)** | Overview sidebar row 6 (visible on web; must stay hidden on iOS) |
| Q11 | Admin console | **none in v3.5**; database console + audit | a minimal console (more attack surface) |
| Q12 | Conflict policy in v1 | **conflict copy + bar**; merge in WP-M | last writer wins without a copy (loses work — not recommended) |
| Q13 | Beta | **`?cloud=1` for invited users for 2 weeks**, then on for the web | on for everyone at release |
| Q14 | Release number | **v3.5 (web only), after DFIT v3.4**; agree with the DFIT lead | v3.4.x if DFIT slips |
| Q15 | Terms of Use | **new short Terms for the account service**, consent recorded per version | rely on LICENSE §3 only (not enough for accounts) |
| Q16 | Sign-in from new device notice | **e-mail on every new device** | none / weekly digest |
| Q17 | Release-notes item on iOS | **hidden on iOS** (`platform:'web'`) | shown with "web version only" |

---

## Appendix A. Facts the builders must keep exact (from the code at the planning date)

- `WTS_project._buildPayload(meta)` is synchronous; `storage.read()` flushes the autosave; payload `{format:'h2oilproj',
  version:'1.0', generator, savedAt, meta, modules}`; modules applied in registry order, unknown ones to `skipped[]`.
- `loadFromObject(obj)` cancels the autosave, nulls the dataset when `prism` arrives without `prism_dataset`, resets the well
  list when `storage` arrives without `wells`, writes every module (`storage.write` removes **all** project keys first), runs
  `_prismSync`, fires `wts:project-loaded {loaded, skipped}`, calls `WTS_rerender({discardPending:true})`; gauge and build-up
  IndexedDB writes finish asynchronously afterwards.
- `PREF_KEYS` = `{wts_unit_system, wts_prism_sample_suppress, wts_prism_migrated}`; `PREF_RE` at 29-project-save.js:151;
  `LIBRARY_RE` = `/^wts_prism_(user_curves|presets|mapping_)/`; `MAX_KEY_CHARS` 2 MB; job keys `wts_report_templates`,
  `wts_base_conditions`.
- `WTS_wells.switchTo` parks the active well into `wts_well_<from>` with the quota-safe `WTS_lsSet`, then writes the target's
  keys raw and fires `wts:project-loaded {source:'well'}` and `wts:well-changed`.
- `__lsSet` / `WTS_lsSet` (host l.945-957) evicts `wts_report_snapshots` first on quota errors and fires `wts:storage-full`.
- `sw.js` bypasses non-GET requests, other origins, Range requests and same-origin paths that are not app assets; it never
  caches `no-store` responses. It needs no code change.
- The harness `fetch` always rejects unless `opts.globals.fetch` is given (merged after the defaults); `location` defaults to
  `http://localhost:8080/well-testing-app.html`; `crypto.subtle` and `randomUUID` exist; there is no IndexedDB (use the fake).
- Round-10 discovers every `prism-build/6N-*.js` (60–65 taken; 64 is generated); `stripSelfTest` removes only the self-test
  tail.
- `sync-from-main.js` strips `<!-- GA:START … GA:END -->` (step 0) and `// ── SW:START … // ── SW:END ──` (step 0b).
