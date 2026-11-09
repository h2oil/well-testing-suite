# Accounts and cloud project sync (web version only) — implementation plan

**Status: revision 4; Phase 1 built and integrated (ac/int: WP0 technical part, WP-H H1–H18, WP-S1, WP-O, WP-C1, WP-OPS, the end-to-end
test), its integration review fixed and the server prepared for our hosting platform — release v4.0 (2026-11-09; Phase 2 / 3
follow as v4.0.x / v4.1; web only)**
*Integration (2026-11-09).* Deliberate deviations: gauges and build-up travel as **job-level** parts `well/job/<module>`
(29-multiwell keeps those stores per job, not per well; well ids are `w\d+`, so they never collide with `job`); the
e-mail-revert proof is a **130-bit revert key** (26 of A–Z / 2–7, link `#account-revert=<key>`), not an 8-digit code;
e-mail-code send limits are hard **per address AND client range** (5/h, 20/day; per address only an alert), session-bound
codes are limited per session, wrong codes count toward the 1-hour pause only while a code is live and only for that range
(migration `050-code-scope.sql`), and provider address codes obey the same limits and the sign-up switch; `WTS_MIN_CLIENT` is
unset by default (no 426 gate until a security fix needs one); the iOS section-11 CSS is a recorded exception (§9).
*Hosting (2026-11-09).* The owner named the Phase 1 release **v4.0** (was v3.5; Phase 2 / 3 follow as v4.0.x / v4.1) and chose
our hosting platform for the functions-only site; `server/` now carries that platform's configuration, functions, database and
blob bindings, and `server/RUNBOOK.md` §3N / §3P is the owner's click-by-click guide (deviations: Appendix B.4).
Open: the owner items of WP0 / §13.10 (consoles, client ids and secrets, host plan, DNS, legal texts — draft `privacy.html` and
`terms.html` at the site root since 2026-11-09, linked from both consent ticks and the in-app Privacy page; company placeholders
and lawyer review still open), RUNBOOK §3 step 0 (publish allow-list before `server/` reaches master), WP-I1
(security review, invite beta, CSP enforce, RELEASE_NOTES 4.0 entry (written: v4.0, 2026-11-09)).
(2026-11-08; revision 2: 2026-11-07). Landed: the `server/` skeleton with the §3.4 schema and `server/core/contract.js`,
`prism-build/tests/_acct-shapes.js`, `_acct-fake-server.js`, `server/test/fake-oidc.js`, inert skeletons 66–68,
`acct-contract.test.js` and the §9 iOS strip steps 0c / 0d in `sync-from-main.js`. Refinements to §3 / §3.4: a `wts_definer`
role owns the definer functions; `email` is optional for a step-up code; `sharedBrowser` on oauth start; `mail_queue` /
`deletion_request` / `email_move` / `recovery_set` / `audit_system` / `ops_nonce_claim` definers (wts_api has no UPDATE on the
address index columns; ops-daily nonces live in `ops_nonces`); composite `(id, user_id)` project keys; `gone` on signed-in
routes; `501 not_implemented` for foundation stubs only; a missing or unknown `WTS_ENV` is production; `WTS_PROXY_SIG` takes
two comma-separated values during a rotation; the session cookie always carries Max-Age = seconds to `abs_expires_at`. Owner
items of WP0 / §13.10 are still open, and so is a naming exception for the server's pinned database-driver package (its name,
registry URL and lockfile links; confined to `server/package.json`, `server/package-lock.json` and `server/core/db.js`).
The planning step itself changed only this file and one CLAUDE.md line (the naming exception below). **Revision 3** adds two sign-in
methods, **Google** and **LinkedIn**, beside the e-mail code (D3, D4, D22–D24, §4.10–4.15, §13.10, Q24–Q30; Appendix B.3 lists
every changed section). **Revision 4** answers three reviews of revision 3 (provider security; product and operations;
consistency): a separate step-up timestamp that no provider sign-in sets, the iOS strip of the web privacy and release-note
text, Google's verified flag trusted only for Google-managed addresses, provider links removed by unlink, revert and
sign-out-all together with their sessions, a breaker that outside traffic cannot trip, attempts that outlive the code step,
the public-computer provider session, `GET /auth/providers`, and a calendar laid out on the contingency days (Appendix B.4). Revision 2 answers three reviews of revision 1 (security and privacy; architecture
against the code; product and operations). Every blocker and major is resolved in the body; Appendix B lists what was resolved
differently from the reviewers' suggestions, and why. The release numbers are provisional: DFIT is v3.4 (`docs/DFIT-PLAN.md`, a
separate workstream that this plan does not touch), so accounts ship in the releases after it unless the owner and the DFIT lead
agree otherwise (Q14).

> **Request (product owner, 2026-11-07).** *"Plan how we can create a login for user so it will save their work and database
> for inputted projects"*, then *"for webversion only"*.
>
> So: optional accounts and sign-in for the **web app at welltest.h2oil.co.uk only**. A signed-in user's work (every autosaved
> page input, PRiSM state, multi-well projects, the build-up surveillance store, report snapshots and templates, libraries, and
> historian data on request) is kept in a per-user cloud database of projects that they can open on any device. The **iOS app
> stays account-free and unchanged**: the account code is stripped from `ios-app/www` and is inert even if a strip were missed.
>
> **Request (product owner, 2026-11-08).** *"continue plan - create a email login also with google and linkedin login too"*.
>
> So: three sign-in methods on one account — the **e-mail one-time code** (the root method that every account has),
> **Sign in with Google** and **Sign in with LinkedIn** (OpenID Connect, full-page redirect, no provider script on the page).
> Web only; the iOS app stays unchanged.

**Naming exception (owner, 2026-11-08).** The repository never names other companies. For this feature the owner approved one
exception: the web accounts feature — this plan, `server/`, files 66–68, their tests, UI, help, privacy text, security e-mails
and commit messages — may name exactly two identity providers, **Google** and **LinkedIn**, as sign-in methods (their button
branding rules require the names). The names never ship in the iOS bundle (§9). No other company, vendor, product or
website is named; the host, database, e-mail service etc. stay generic. The providers' endpoint addresses will appear only in
the one provider configuration file (`server/core/oidc-providers.js`); console steps, links and brand colours stay in the owner's
scratch vendor notes, never in the repository. CLAUDE.md records the exception in its TL;DR naming rule.

| | |
|---|---|
| Releases | Three phases (§14). **v4.0** (Phase 1): sign-in (e-mail code, Google, LinkedIn; link and unlink), manual *Save to cloud* / *Open from cloud*, history, account page with export, delete, e-mail change and security notices — invite-only beta, then on for the web. **v4.0.x** (Phase 2): automatic sync and the key-level merge, after 4 weeks of Phase 1 telemetry. **v4.1** (Phase 3): passkeys, historian backup, live-data settings, field-level merge. Without signing in, the app behaves exactly as v3.4: nothing leaves the device |
| What | (1) **Passwordless sign-in, three ways into one account**: an 8-digit e-mail code (the root method: every account has a verified address; an optional second recovery address), **Sign in with Google** and **Sign in with LinkedIn** (OpenID Connect, full-page redirect, no stored provider token, never linked on an e-mail match alone), passkeys as the fast path in Phase 3. (2) **Server-side sessions** in an HttpOnly `__Host-` cookie, never visible to page script. (3) **Cloud projects**: the existing `.h2oilproj` payload, normalised per well, as the sync unit: a small *core document* plus content-addressed *parts*, committed with compare-and-swap on a revision number. (4) **Event-driven sync** (Phase 2): one coalescing debounced push, pulls on focus / online / visible and before the first edit; offline-first, no polling. (5) **Conflicts never lose work and never move it off the screen**: disjoint keys merge; an overlap keeps the local version on screen as a conflict copy. (6) **Account page**: projects, history, devices, security, export everything, delete account. (7) UK GDPR: export, deletion with a 7-day grace, retention, privacy-page text |
| Where | Client: three new Round-10 files `prism-build/66-account.js`, `67-cloud-sync.js`, `68-account-page.js` (auto-discovered; 60–65 are taken, DFIT owns Round-8 56–59). Neutral host and shared-file edits H1–H18 (§5.4). Server: a new top-level `server/` folder (functions, shared core, ops scripts, migrations, tests) that is never published as static content and never copied into `ios-app/www`. Build: `ios-app/scripts/sync-from-main.js` (strip step, extended to `www/help/**`), a publish allow-list (§13.2). Tests in `prism-build/tests/` and `server/test/` |
| Not touched | DFIT (`docs/DFIT-PLAN.md`, its branches, Round-8 files 56–59). The iOS native project. The simulator (31/32/38): its one direct write (`wts_sim_rigup`) is detected by the key-hash check instead of an edit (§5.4 H2). Calculation engines. `sw.js` code (only its header comment changes) |
| Inputs | Session notes: the persistence map, the web delivery and security surface map, the options research, three candidate designs and three judge reviews (revision 1); three reviews of revision 1 (revision 2); the provider research of 2026-11-08 (both providers' live discovery documents and documentation; revision 3). Vendor names, prices and links are kept out of the repository, in the owner's scratch vendor notes |

**Conventions.**
- No other company, product, vendor, cloud service or website is named in this plan, the code, the tests or the UI text,
  except the two identity providers Google and LinkedIn under the naming exception above. Open standards and protocols
  (SQL, OpenID Connect, OAuth, WebAuthn, JWT) are named; no vendor, host, service or product is (owner to confirm, Q1).
  Services are described generically: "our static host", "its serverless functions", "a managed SQL database", "the
  host's blob store", "a transactional e-mail service", "the spreadsheet library", "the analytics tag". The only web address is
  welltest.h2oil.co.uk; the only e-mails are software@h2oil.co.uk (user-facing) and no-reply@h2oil.co.uk (sender). Example data
  is neutral ('Operator Energy Ltd', 'name@company.example'). The forbidden product name listed in CLAUDE.md is never written.
- MoSCoW tags: **M** must, **S** should (drop only with the lead's agreement), **C** could.
- Client code follows CLAUDE.md: single outer IIFE, public symbols on `window`, no external runtime dependency (native
  passkey API, `crypto.subtle`, `CompressionStream`), **no polling, no `setInterval`, no function wrapping**, nothing pending
  after 5 s idle.
- Line numbers are from the current `Dev` tree (built `well-testing-app.html`, `prism-build/*.js`).
- Sizes: kB = 1,000 bytes, MB = 10⁶ bytes. Times are UTC on the server, local in the UI.

---

## 0. Decisions at a glance

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Scope | Web only. The account code is wrapped in `ACCT:START/END` markers that `sync-from-main.js` strips; every reference to account identifiers lives inside those markers (static test); a load-time guard (https or http only, host name, native bridge, frame) makes it inert anywhere else; the API refuses any Origin but `https://welltest.h2oil.co.uk` (§9) | Owner: "for webversion only". The iOS app stays free, local and unchanged (CLAUDE.md iOS rules) |
| D2 | Backend | **Our own minimal API** in serverless functions, reached at same-origin `/api/v1/*` (UK region). A **managed SQL database** (UK, else EU) holds accounts, sessions, devices, the project index, revisions, blob index, rate counters, the mail outbox and the audit log. Project bodies go to the **host's blob store** in its EU region (set explicitly on every call). A **transactional e-mail service** sends codes and notices | Same origin: first-party cookies, no CORS. Standard SQL with row-level security and WebAuthn keep lock-in low; we own the sync protocol an offline-first app needs. Alternatives (Q1): a managed identity service of the host (no passkeys or codes, data region not stated) or a hosted auth-plus-database service (large client SDK, free tier pauses when idle) |
| D3 | Sign-in | **Passwordless, three methods on one account.** (a) **E-mail code** — the root method: 8 digits, 15 min, at most two live codes per address and purpose, 5 tries each, stored as an HMAC bound to purpose and, for step-up, to the session; every account has a verified primary address; an optional verified **recovery address** can receive sign-in codes. (b) **Sign in with Google** and (c) **Sign in with LinkedIn** (OpenID Connect; D22–D24, §4.10–4.15). Passkeys (discoverable, user verification required) in Phase 3. No passwords, no magic links, no other identity provider | Nothing to steal or reset; a code in the mail body cannot be burnt by a link-scanning gateway; the recovery address covers a lost work mailbox (contractors change employer); the two provider buttons (owner request of 2026-11-08) save the code mail on **every Google sign-in** for a Google-managed address and on **every LinkedIn sign-in after the first** — the first LinkedIn sign-in, and a Google sign-in on an address Google does not manage, costs one code, once (friction table, §11.2); the e-mail code still works when a provider is down or lost |
| D4 | Session | Opaque 32-byte id in `__Host-wts_sid` (Secure, HttpOnly, **SameSite=Strict**, Path=/); the database stores SHA-256(id). Rotated on sign-in and step-up (the previous id stays valid for 30 s). **Trusted device**: 35 days idle / 180 days absolute (covers a 28-day rotation offline). **Public or shared computer** (tick box): 12 h idle / 7 days absolute; the local working set is wiped on sign-out and at the first load after expiry (§10.8). A 401 never drops queued changes (§6.9). Step-up for delete, purge, add / remove passkey, change e-mail or recovery address, sign out everywhere, link / unlink a provider, and to unlock the export read rate: **`sessions.stepup_at` within 10 min**, a timestamp set **only** by a successful e-mail code or UV passkey check — never by a provider sign-in, so a session created by Google or LinkedIn starts with `stepup_at` NULL and must enter a code before any of these (Q29; `auth_at` records only when the session was created). **Provider sign-in leaves the session cookie Strict**: the provider's return is a cross-site navigation that carries only the short-lived Lax attempt cookie `__Host-wts_oa`; the callback never reads or sets the session cookie, and the session is issued by a same-origin `POST /auth/oauth/finish` from the page (§4.13) | No token is ever reachable from script (the page cannot run a strict CSP today). Strict works because every API call is a same-origin fetch. Rig and office PCs are often shared; rigs are offline for weeks |
| D5 | Sync unit | The existing **`.h2oilproj` payload**, **normalised per well**: every well, the active one included, is a part `well/<id>` built by a new `WTS_wells.captureWell(id)`; its bulk data (`prism_gauges`, `buildup_raw`, `buildup_analysis`, any key over 64 kB) are sub-parts `well/<id>/<name>`. The **core** holds the well list `{id, name, created}`, the job keys and the part hashes; which well is active is device-local. Parts are **content-addressed** (SHA-256 of canonical JSON), gzip, uploaded in **4 MB chunks only when missing**, deduplicated within the account, immutable once complete. A core-only commit carries the core **inline** (≤ 48 kB gzip) | Reuses the tested project format. Two devices on different wells no longer touch each other's data. A page edit uploads kilobytes; pagehide becomes one request; conflict copies only reference blobs |
| D6 | Write rule | A **commit** `{pushId, baseRev, core, parts}` to `/api/v1/projects/:id/commit` is accepted only if `baseRev == head_rev` (compare-and-swap, row lock), else `409 stale`. `pushId` makes a retry idempotent. A commit whose normalised core hash (`vhash`) equals the head is a no-op. **Pull before push** | Changes are never silently overwritten; a retry after a timeout cannot fork a revision |
| D7 | Conflicts | **Phase 1** (manual): Save to cloud that hits a 409 asks *Overwrite (old head kept in history) / Save as a new project / Cancel*. **Phase 2 (WP-C2)**: a **key-level three-way merge** against the base stored on the device (each key changed on one side only goes through; the PRiSM bundle is atomic; wells merge independently). An **overlap** keeps the local version **on screen**, uploads it as a conflict copy and links this device to the copy; the cloud head is unchanged; the bar offers *Show differences / Use cloud / Keep both*. **Phase 3 (WP-M, S)**: field-level rules for `wts_page_<route>`, client info, PVT provenance, report templates, libraries; true clashes become a copied well or a PRiSM workspace branch | The most common two-device case (different pages) merges silently; offline work never disappears from the screen |
| D8 | Apply | Key-only changes: **`WTS_project.applyChanges(diff, {source:'cloud'})`**, which fires the new **`wts:project-changed`** event — never `wts:project-loaded`, whose listeners prune the build-up store and reset the simulator. A changed parked well: `WTS_wells.applyRemote(id, blob)` (blob rewrite, no load). A changed active well or Open from cloud: the switch / load path with `source:'cloud'`, the `keep` option for parts left local, and `await res.ready` before the base moves. A change to the focused input waits for its `blur`. A **safety snapshot** (last 2 payloads) is taken before any apply that replaces more than one key; a **pinned pre-account snapshot** never rotates | `loadFromObject` clears every project key and re-renders; build-up raw data must never be pruned by a sync |
| D9 | Change detection | Host `__lsSet` / `WTS_lsSet` / new `WTS_lsRemove` dispatch document **`wts:ls-write {key, removed?}`**; direct `setItem` / `removeItem` sites move onto them, enforced by a **static scan test** with an explicit allow-list. Plus the existing events (`wts:autosaved`, `prism:*`, `wts:buildup-updated`, `wts:well-changed`). A key-hash check on `visibilitychange→hidden` and at each snapshot catches writes outside the scan (the simulator's rig-up key). The snapshot's own writes are ignored (`_snapshotting`), as are writes during an apply (`_applying`). **Derived keys** (`wts_report_snapshots`, `wts_mw_results`) travel but never make a project dirty | C7 forbids polling and wrapping; half of today's writes fire no event; snapshots must not re-trigger themselves |
| D10 | Sync state | Device-local IndexedDB **`wts-sync`** (binding, active well, base, outbox with a format version, safety and pre-account snapshots, device ownership record, per-user local stash, conflicts), outside the `wts_` / `h2oil_` namespace; one non-secret hint `wtsacct_hint` in localStorage. `PREF_RE` gains `^wts_acct_|^wts_sync_` | Project files, New and well switches never see sync state; nothing account-related travels in an exported file |
| D11 | Encryption at rest | Platform encryption **plus** envelope encryption: a per-user AES-256-GCM data key wrapped by a versioned master key in host secrets. AAD binds `userId \| hash \| chunk n \| kid`; the header `{v, alg, kid, dkv, iv}` allows dual reads during re-encryption and a later opt-in end-to-end vault (Q4). Rotation **re-wraps every data key before an old master key is retired**; a compromise re-keys and re-encrypts (§13.4). The client verifies the SHA-256 of every part | A bucket, backup or preview copy alone exposes no well data; rotation can never orphan data |
| D12 | Database isolation | Row-level security **enabled and forced** on every user table. Request handlers connect as `wts_api` (no `BYPASSRLS`, no DDL) and run `SET LOCAL app.user_id` per transaction; the pre-auth lookups go only through named `SECURITY DEFINER` functions (`resolve_session`, `user_by_email`, `user_by_credential`, `create_user`, code and challenge functions) with a fixed `search_path`, minimal columns and `EXECUTE` for `wts_api` only. Cross-user jobs run as **`wts_jobs`**, a separate credential loaded only by the scheduled function. Support uses **audited ops scripts** as `wts_support` | Gives the pre-auth path a defined way in, so nobody adds a bypass role |
| D13 | What syncs | Everything a project file carries (§7), minus device preferences and the units module, minus `wts_modbus_config` (opt-in), minus the library keys (they live only in the account **library document** and are put back when a file is assembled). The **historian** is a manual opt-in backup (Phase 3) | The historian is device-wide and large; libraries must not make every project dirty |
| D14 | UI | A header **account chip** (`#wts_account_host`, first in `.page-actions`); a **`☁ ▾` toolbar button** after Save As in the project toolbar (*Save to cloud / Save to cloud as… / Open from cloud… / Import files to cloud…*) through `WTS_project.registerToolbarItems`; **Ctrl+S** saves to the cloud while linked; an **`account` page with a route but no sidebar row** (`navHidden:true`) holding its own help; a bottom status bar for conflicts, sign-out, offline and outages; a sign-in dialog with the e-mail code first, then *Sign in with Google* and *Sign in with LinkedIn* at equal size (official assets, unmodified, inline); a *Sign-in methods* card on the account page. Overview stays at 5 rows | Sidebar must fit 1280×800; nothing account-related appears on iOS |
| D15 | First sign-in and hand-over | Ask, never assume. The device records **which user its local work belongs to**; work from another account (or from an unknown session after a sign-out) is never uploaded by default (§10). Own work: *Upload as a new cloud project* (default) / *Open a cloud project instead* (local work uploaded first with `reason:'migrate'`, plus the pinned pre-account snapshot) / *Not now* | Existing users have months of work in browser storage; shared office PCs must not leak one user's client data into another's account |
| D16 | Free accounts | Free; default quota **250 MB** per user, project ≤ 64 MB compressed, historian backup ≤ 100 MB (Q5). No payments | The app is free; a quota caps cost and abuse |
| D17 | Hosting plan | **Leave the host's free plan before the beta** | On the free plan, running out of monthly credits pauses the whole public site |
| D18 | Admin and support | No admin console. Support works through audited ops scripts (`server/ops/`, actor `support:<id>`, one audit row per lookup); ad-hoc production console sessions only in a declared incident. A documented recovery path for a lost mailbox (§13.7, Q20) | Less attack surface; every support access is logged |
| D19 | Delivery hygiene | Server functions deploy as a **separate functions-only site** of the same team, reached through a same-origin rewrite, **only from `server-v*` tags** with an owner-signed checklist; migrations are applied by a manual tagged job, never by an ordinary master push; the static site keeps auto-deploying from master (CLAUDE.md branch rule unchanged). Previews get no production database or secrets. Kill switches `ACCOUNTS_SIGNUP=open\|invite\|off`, `SYNC_MODE=readonly\|off`, `ACCOUNTS_OFF`, and per provider `OAUTH_GOOGLE` / `OAUTH_LINKEDIN` `=on\|signin\|off` (`signin`: identities already linked still sign in; no new account or link); the page reads them from `GET /auth/providers` when the sign-in dialog opens, so a switched-off provider shows no button and a `signin` one is labelled "existing accounts only". Independent review of `server/` and 66–68 (Q19). SHA-384 of the account block in the release notes (S) | One owner plus an assistant cannot meet a two-person, tagged-master rule as first written; this keeps server risk off the auto-merge path |
| D20 | Third-party scripts | Every external script loads through a hash-pinned loader (the spreadsheet library joins the historian and 3D loaders); **the analytics tag is not loaded while signed in** (a head guard reads `wtsacct_hint`; a page that loaded it reloads once after sign-in) (Q18). **No identity-provider script**: no provider SDK, one-tap prompt, iframe or popup; provider sign-in is a full-page redirect and its buttons are inline assets | Third-party code runs in the session's origin and can make credentialed API calls |
| D21 | Abuse limits | Per user **and** per session, never per client-supplied id: blob reads 100 MB/h and 300 MB/day per user (export after step-up: 300 MB/h), commits 120/h and 600/day per user, 60/h per session; per IP prefix soft limits (delay, alert) so a rig or an office behind one address is never locked out (§8.3) | Limits must be below the quota and not bypassable by rotating a header |
| D22 | Provider protocol | **OpenID Connect authorization-code flow with a confidential server-side client** per provider. The page `POST`s `/auth/oauth/:provider/start`; the server stores an **attempt** (state, nonce, PKCE verifier, provider, purpose; 10 min to the callback, extended to cover a code step, at most 30 min in all) behind a `__Host-wts_oa` cookie (HttpOnly, Secure, Path=/, **SameSite=Lax** from start to callback, re-issued **Strict** by `finish`) and returns the authorization URL; the page navigates there (full page, never a popup); the provider returns to `GET /auth/oauth/:provider/callback`, which checks cookie and `state`, burns the attempt, exchanges the code server to server with the client secret, validates the id_token and 303s to a **constant** app URL; the page completes with `POST /auth/oauth/finish`. Scopes: Google `openid email`; LinkedIn `openid profile email` (it requires the three together; only `sub` and the e-mail are kept). **No provider access or refresh token is stored** (discarded after the exchange; no offline access asked). Production issuers and key addresses are **pinned in code**; the server refuses to start on the production host if any is not the pinned https value | Smallest surface: no provider code in the page's origin, no token to steal, no redirect parameter to abuse, and the Strict session cookie needs no change |
| D23 | Identity model | Table **`identities`**: one user, many identities; **`UNIQUE (provider, subject)`**; looked up **only** by provider + subject (`sub`), never by e-mail; the provider e-mail and its verified flag are recorded **at link time** as information, with `linked_at` and `last_used_at`. Every account keeps a verified primary e-mail (the root method), so losing a provider never loses the account | Provider e-mails change and are not always verified; keying on them is the classic account takeover |
| D24 | Linking | **Never link on an e-mail match alone.** A known (provider, subject) signs its user in. A new identity creates an account only with a verified e-mail — the provider's flag only where the provider also **manages** the address (Google: its own consumer mail domain, or a hosted-domain claim equal to the address's domain), else our e-mail code (LinkedIn always; Google on any other domain; any missing or unverified address). If an account already uses that address, the identity is linked only after the user **proves control of that account** with an e-mail code sent to its address. Linking from the account page needs step-up at start **and** a link-confirm code entered after the provider return. Unlink needs step-up, is refused if it would leave no method (the e-mail code always remains) and **revokes every session that identity created**. Every link and unlink is audited (identity id and subject index) and mailed to the account address (§4.12) | Stops pre-registration, stale-verified-address and unverified-claim takeovers, and keeps a link from outliving its removal; the common case costs at most one extra code, once |

---

## 1. Goal and scope

### 1.1 In scope
1. Sign-up / sign-in with an e-mail code, **Sign in with Google** or **Sign in with LinkedIn** (one account, several methods; link and
   unlink on the account page); optional recovery address; passkeys (Phase 3); sign-out, sign out everywhere, device list,
   security notices for every security change, e-mail change with a 7-day revert.
2. Cloud projects: create, save, open, rename, duplicate, move to trash (30 days), restore, purge, revision history and restore a
   revision, download as `.h2oilproj`, import several `.h2oilproj` files at once.
3. Phase 2: automatic sync of the open project while signed in and linked; offline queue; key-level merge; conflict copies;
   multi-tab safety; a small offline cache of recently opened cloud projects.
4. Account library (user curves, presets, mappings) shared by all the user's projects and devices.
5. Phase 3: opt-in historian backup / restore and opt-in live-data connection settings.
6. Account page; export everything; delete account (7-day grace); privacy-page and help updates; Terms of Use acceptance; a
   standard data processing agreement offered to business users.
7. Server: API, schema, rate limits, audit log, encryption, backups, deletion ledger, monitoring, runbook, support scripts.

### 1.2 Out of scope
- The iOS app (no account, no sync, no UI change; §9).
- Sharing a project with a colleague, team accounts, roles (later; `projects.user_id` is the owner).
- End-to-end-encrypted vault (later, opt-in; D11, Q4).
- Server-side search of content, previews or server-side reports.
- Continuous historian streaming, Modbus data to the cloud.
- Passwords, identity providers other than Google and LinkedIn, provider sign-in on iOS, provider re-authentication as step-up
  (Q29), SMS codes, payments, an admin console.
- Any use of provider data beyond sign-in: no contacts, no profile import, no posting, no stored provider token, no account merge
  tool for two accounts created by mistake (prevention in the consent step and a support macro instead, §11.2, §13.7; Q31).

### 1.3 User stories
| # | As a … | I want to … | So that … | Acceptance |
|---|---|---|---|---|
| U1 | well-test engineer | sign in with my work e-mail and a code | I can use the cloud without a password | Code arrives within 1 min; "Didn't get the code?" help in the dialog; wrong / expired code gives one generic message |
| U2 | engineer with a laptop and an office PC | open the same project on both | I continue where I stopped | Phase 1: Open from cloud shows the latest save. Phase 2: change on A; on B the first focus, click or key press pulls before the edit is pushed; disjoint edits merge with no conflict |
| U3 | engineer on a rig for 28 days | keep working offline | nothing blocks or is lost | Offline edits stay local; chip "n changes waiting"; still signed in after 28 days; queued changes upload on reconnect, also after a re-sign-in or an app upgrade |
| U4 | engineer | not lose edits made on two devices | both versions are kept | Different pages merge (Phase 2); an overlap keeps my version on screen as a conflict copy; never a silent overwrite |
| U5 | engineer with months of local work | put it into my account once | it is safe if the browser is cleared | First sign-in offers an upload preview with size and well count; a pinned pre-account snapshot stays on the device |
| U6 | engineer on a shared rig PC | sign in for a shift and leave nothing behind | the next person cannot see the client's data | "Public computer": 12 h session; sign-out and session expiry wipe the local working set; waiting changes are kept only in a form only I can unlock; after a provider sign-in the sign-out asks me to sign out of Google / LinkedIn too (a blocking step), and this browser is remembered as shared, so every later provider sign-in on it asks the provider for a fresh login (T30) |
| U7 | engineer | see and restore older versions | I can undo a bad change from yesterday | History lists revisions (10-minute points for 24 h, daily for 30 days, every named save); restore makes a new head |
| U8 | user | export everything and delete my account | I control my data (UK GDPR) | Export = zip of `.h2oilproj` files + account JSON; deletion hides everything at once and purges after 7 days (or at once with a second step-up) |
| U9 | iOS user | notice nothing | the app stays simple and local | `ios-app/www` (and `www/help`) contains no account code, text or screenshot; privacy page unchanged on iOS |
| U10 | owner | switch sync off in an incident | users keep working locally | `SYNC_MODE=off` → chip "Cloud sync paused — your work is saved on this device" |
| U11 | contractor who changed employer | get back into my account | my projects are not lost with the old mailbox | A recovery address receives sign-in codes; without one, the documented support recovery path (§13.7) |
| U12 | engineer on a shared office PC | sign in after a colleague used the browser | their client data never lands in my account | "This browser holds work from another account" — *Start empty (keep it local)* / *Sign out*; upload only after an explicit confirmation naming the client and wells |
| U13 | engineer with a Google work or personal account | sign up and sign in with *Sign in with Google* | I skip the code mail | First time with a Google-managed address (Google's consumer mail or a Google-hosted work domain): Google → back on the page → consent step (which names the new account's address) → signed in; with any other address one e-mail code first. Later one click. No Google script loads on the page |
| U14 | engineer who uses LinkedIn | sign up and sign in with *Sign in with LinkedIn* | I use the account I already have | First time: one e-mail code to the LinkedIn address (or to an address I type when LinkedIn sends none), then consent; afterwards LinkedIn alone signs me in |
| U15 | existing e-mail-code user | press *Sign in with Google* with the same address | I don't get a second account | "An account already uses n•••@company.example. Enter the code we sent to it to add Google." After the code Google is linked and I am signed in; it is never linked without that code. The new session still needs a code for any step-up action |
| U16 | user | see, link and unlink my sign-in methods | I control how I get in | Account → *Sign-in methods*: e-mail (always on), recovery address, Google, LinkedIn, passkeys (Phase 3), each with linked date and last use; link and unlink need step-up; every change is mailed to my account address |
| U17 | user whose Google or LinkedIn account was deleted or locked | still get into my account | my projects are not lost with it | The e-mail code always works; the dead method shows its last use and can be unlinked; a new provider account is linked from Account → *Sign-in methods* after an e-mail-code sign-in (§4.12 rule 2) |
| U18 | user who changed the e-mail address at Google or LinkedIn | keep signing in with that provider | nothing breaks | Sign-in follows the provider's subject, not the address; my account e-mail never changes by itself; the dialog notes each new provider address once and offers *Change account e-mail* (the normal step-up flow) or *Keep my account e-mail*, which stops the note for that address |
| U19 | user during a provider outage | sign in anyway | work is not blocked | The button reports "Google sign-in is not available right now — use the e-mail code"; the code path is unchanged; the owner can switch a provider off (`OAUTH_*=off`) without a release, and the dialog then shows no button for it (`GET /auth/providers`) |

---

## 2. Architecture

```
 Browser (web app, offline-first)                    welltest.h2oil.co.uk            functions-only site (same team,
 ┌───────────────────────────────────────────┐   ┌───────────────────────────┐    deployed from server-v* tags only)
 │ well-testing-app.html                       │   │ static site (auto-deploys │    ┌──────────────────────────────┐
 │  host: __lsSet/WTS_lsRemove → wts:ls-write  │──▶│ from master; publish      │───▶│ serverless functions (server/) │
 │  29-project-save: _buildPayload,            │   │ allow-list §13.2)         │ re-│  auth · sessions · projects ·  │
 │   loadFromObject(obj,{source,keep}) → ready,│   │ /api/v1/* → rewrite to the│ write│ blobs · library · account ·  │
 │   applyChanges → wts:project-changed,       │   │ functions site (proxied,  │    │  rate limits · audit · mail    │
 │   registerGuard, registerToolbarItems       │   │ same origin for the       │    │  outbox · envelope encryption  │
 │  29-multiwell: captureWell, applyRemote,    │   │ browser)                  │    └───────┬─────────────┬──────────┘
 │   importWell                                │   └───────────────────────────┘            │             │
 │ ── ACCT:START (stripped from iOS) ──        │                                   managed SQL DB     host blob store
 │  66-account   WTS_account                   │                                   (UK, else EU)      (EU region):
 │  67-cloud-sync WTS_cloudSync                │                                   roles wts_api /    u/<uid>/b/<sha>/<n>
 │  68-account-page  route 'account' + help    │                                   wts_jobs /         (encrypted chunks);
 │ ── ACCT:END ──                              │                                   wts_support        ledger/, chain/ objects
 │ IndexedDB 'wts-sync' (device-local state)   │                                         │
 └───────────────────────────────────────────┘                                   transactional e-mail service
 sw.js: /api/* bypasses the worker; the API sends Cache-Control: no-store            (queued through mail_outbox)
```

- **Local storage stays the primary copy.** The cloud is a replica per project. Without a session, nothing changes from v3.4.
- **One project is linked per device at a time** (the one open in the browser). Phase 2 keeps the last 3 opened cloud projects
  (≤ 50 MB) cached in `wts-sync`, so switching between them works offline.
- **The server never parses well data.** It stores encrypted bodies, checks sizes, ownership, revisions and quotas, and keeps
  small metadata for the project list; the name and client are envelope-encrypted too (`projects.meta_enc`).
- **The functions site is reachable only through the rewrite.** The rewrite adds a proxy-signature header (a secret shared by
  the two sites); requests without it get `404`, and the functions read the client address and the original host only from the
  host's trusted forwarding headers (§3.2). Whether the host's rewrite can add a header is a WP0 check (vendor notes); the
  fallback is one site with functions deployed from the same tags through a protected deploy branch.
- **Identity providers (Google, LinkedIn)** sit outside this picture. The browser visits them only by a full-page redirect and
  comes back to `/api/v1/auth/oauth/<provider>/callback`; the functions talk to them server to server (code exchange, signing
  keys) with client secrets held in the functions' environment. The page loads nothing from them, and nothing in the database
  depends on them being reachable: the e-mail code is the root method (§4.10–4.15).

---

## 3. Server

### 3.1 Folder layout (new, top level)
```
server/
  functions/            one file per route group (auth, oauth, me, projects, blobs, library, account, health, csp-report, ops-daily)
  core/                 pure logic shared with the test fake server: validate.js, rate.js, revisions.js (CAS, squash, prune),
                        quota.js, envelope.js (AES-GCM wrap/unwrap, AAD, dual read by kid), canon.js (canonical JSON + SHA-256),
                        merge.js (key-level merge in Phase 2, field rules in Phase 3), mail.js (templates, plain text only), errors.js,
                        oidc.js (authorization URL, PKCE, code exchange, id_token checks, signing-key cache), oidc-providers.js
                        (the two provider configurations: endpoints, accepted issuers, scopes, nonce / PKCE behaviour,
                        trustEmailVerified — the only file with provider addresses)
  ops/                  audited support and incident scripts (lookup, recover, security-reset, rewrap, rekey, ledger-replay)
  db/migrations/        NNN-*.sql, applied by the manual tagged migration job in order, never edited after release
  db/schema.sql         generated snapshot for review
  test/                 node tests: core units, API against an in-memory adapter, fake-oidc.js (a fake OpenID provider: test-time
                        RSA keys, JWKS, token endpoint, fault modes), rls.test.js against a local server of the same database engine (CI)
  RUNBOOK.md            incidents, security reset, restore and ledger replay, key rotation and compromise, support macros
```
Dependencies: one well-maintained server-side WebAuthn verification library (Phase 3) and one driver for the database engine, pinned with a
lockfile, reviewed monthly. Provider sign-in adds **no** dependency: RS256 id_token verification uses the runtime's built-in
crypto (`crypto.verify` with the provider's JWK imported as a public key) under the full check list of §4.11; if the
independent review prefers a library, one pinned, maintained JOSE library is the only alternative. The browser bundle gets no
dependency. `server/` is never in the published static set (§13.2).

### 3.2 Common rules for every endpoint
- Base path **`/api/v1`**. No path has a file extension (the service worker's static pattern must never match it).
- Every response: `Cache-Control: no-store`, `Vary: Cookie`, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'`, `Content-Type: application/json` (blob GETs: `application/octet-stream`).
  No CORS headers.
- Every non-GET request must carry `Origin: https://welltest.h2oil.co.uk` exactly (missing Origin refused), `X-WTS-Req: 1`
  and `Content-Type: application/json` (or `application/octet-stream` for a chunk PUT); else `403 origin`. **Exceptions**, each
  with its own rule: `POST /csp-report` (no auth, no cookie read, `application/csp-report` or `application/reports+json`,
  body ≤ 16 kB, strict per-IP limit, stored only as aggregate counts per directive and blocked host); `POST /ops/daily`
  (no cookie; HMAC over method, path, timestamp and nonce with a key used only for this call; ±5 min window; nonce kept 10 min);
  `GET /auth/oauth/:provider/callback` (the provider's cross-site top-level return, so no Origin or custom header can be
  required: it reads only the Lax `__Host-wts_oa` cookie, never the session cookie; it changes only the attempt that cookie and
  `state` name; it always answers `303` to the constant app URL with `Referrer-Policy: no-referrer` and no data in the URL;
  §4.10).
- The original host (from the trusted forwarding header) must be the production host; otherwise `404`.
- **Client address**: taken only from the host's trusted client-address header; client-supplied `X-Forwarded-For` is ignored
  (server test). Stored as a prefix (IPv4 /24, IPv6 /48).
- Clients send `X-WTS-App: <app version>`. **Version policy**: the server accepts commits from any client released in the last
  90 days; `426 upgrade` is used only for a security fix, never for a format change. On 426 the client keeps its outbox and
  pushes it after the reload (§6.9).
- **Device id**: issued by the server at sign-in (`device.id`), stored in `wts-sync`, sent back as `X-WTS-Device`. The server
  resolves it only against `(user_id, device_id)` of the session's user; an unknown or foreign id is ignored (treated as "no
  device"), never an error. Rate limits never use it.
- GET never changes state (sibling subdomains are same-site, §8.1 T3), except the provider callback above, which changes only
  its own attempt. Bodies over the route's limit get `413` before parsing.
- Error envelope: `{"error":"<code>", "message":"<plain text>", "retryAfter":<s>?, ...extra}`.

| HTTP | `error` | Meaning | Client reaction |
|---|---|---|---|
| 400 | `bad_request` | schema check failed (`field` names it) | log, show "Sync error", keep dirty |
| 401 | `signed_out` | no / expired / revoked session — **the only 401 the API sends** | re-read `/me` once (step-up rotation race), then chip "Signed out — sign in"; outbox kept (§6.9); public device: wipe (§10.8) |
| 400 | `invalid_or_expired` | wrong or expired code / passkey | generic message in the dialog; the session state is untouched |
| 400 | `oauth_state` | `finish` without a valid attempt cookie, or with an attempt of another provider or purpose | dialog "Sign-in was interrupted — try again"; never retried automatically |
| 400 | `oauth_failed` (`reason`: `cancelled` \| `expired` \| `provider` \| `token` \| `reauth_stale`) | the provider leg failed: cancelled at the provider, attempt expired, code exchange failed, id_token refused (also a public attempt without a fresh provider login, §4.11) | one plain message per reason; the e-mail field stays offered; a signed-in session (a failed link) stays signed in |
| 403 | `not_invited` | invite beta: a provider sign-up whose address (provider-managed or proved by our code) is not on the allow-list | "The beta is invite-only. Sign in with the address you were invited with, or use the e-mail code." |
| 403 | `signup_closed` | `ACCOUNTS_SIGNUP=off`: a provider sign-up for a new account | "New accounts are not open right now. Existing accounts can still sign in." |
| 409 | `identity_in_use` | the provider identity is linked to another account | "This Google / LinkedIn account is linked to another Well Testing Suite account" (no address shown) |
| 409 | `provider_linked` | the account already has an identity of that provider (one per provider; unlink first) | message on the account page |
| 409 | `last_method` | unlink would leave no sign-in method | guard; the UI never offers it |
| 503 | `provider_off` (`provider`) | `OAUTH_<P>=off`, `signin` mode for a new account or link, the provider breaker open, or the hard per-prefix attempt / callback ceiling reached (§8.3) | "<Provider> sign-in is not available right now — use the e-mail code" |
| 403 | `origin` | Origin / header / content-type check failed | developer error; never retried |
| 403 | `reauth` | step-up needed | code / passkey in place, then repeat |
| 403 | `locked` | account locked by support | message with contact address |
| 404 | `not_found` | not owned or absent (same answer for both) | unlink, offer Save to cloud as… |
| 409 | `stale` | `baseRev` ≠ head (`headRev`, `head` included) | merge / conflict path (§6.5–6.6) |
| 409 | `consent_required` | a `{consent}` body (code/verify or finish) carried stale Terms / Privacy versions; the normal provider consent step is `next:'consent'` | consent step with the current versions |
| 409 | `immutable` | PUT to a complete blob, or a different body for a stored chunk | client error; report |
| 410 | `gone` | project in trash or purged; account deleting | unlink; offer restore or Save as new |
| 413 | `too_large` / `quota` | body over cap / account over quota (`limit`, `used`) | chip "Storage full"; nothing lost locally |
| 422 | `missing_blobs` | commit references parts not uploaded (`missing:[hash]`) | upload them, commit again |
| 426 | `upgrade` | security minimum not met | Reload bar; outbox kept |
| 429 | `rate` | rate limit (`retryAfter`) | set `nextRetryAt`, no timer |
| 503 | `paused` | `SYNC_MODE=off` / `ACCOUNTS_OFF` | chip "Cloud sync paused" |
| 503 | `readonly` | `SYNC_MODE=readonly` (pulls and export still work) | chip "Cloud read-only"; keep dirty |

**Outage rule (client).** Only `401 signed_out` changes the state to signed out or runs a wipe; the client keys on the `error`
code, not the status alone, and the API sends no other 401 (a failed code, passkey or provider leg is a 400 and never signs out
or wipes; `acct-oauth` case: a signed-in public device whose link is cancelled stays signed in with nothing wiped). A network error or a 5xx keeps the hint state and shows
"Cloud unavailable — your work is saved on this device" with the time of the last successful sync, in the chip, the sign-in
dialog, Open from cloud and the account page.

### 3.3 Endpoints

**Auth**

| Method, path | Request | Response | Notes |
|---|---|---|---|
| `POST /auth/code/start` | `{email, purpose:'signin'\|'stepup'\|'email_change'\|'recovery_add', to?:'primary'\|'recovery'}` | `202 {"ok":true}` always | The send is **queued** (a `mail_outbox` row, sent after the response by the function's background facility), so response time never depends on the mail call; padded to a fixed floor; throttled, paused, unknown and invite-refused addresses take the same path. A third start for the same address and purpose invalidates the oldest live code. `signin` to an address found as a recovery address sends the code there. `stepup` with `to:'recovery'` sends the step-up code to the session user's verified recovery address (a provider-only user who lost the primary mailbox can still step up and change the address; §13.7) |
| `POST /auth/code/verify` | `{email, code, deviceLabel?, publicDevice:bool, consent?:{terms, privacy}}` | `200 {user:{id, emailMasked, created}, firstSignIn, device:{id, label}, session:{publicDevice, idleExpires, absExpires}}` + cookie | Checks the HMAC over purpose ‖ email ‖ code (‖ user ‖ session for step-up and e-mail change). New account: `ACCOUNTS_SIGNUP=invite` checks the allow-list here; without the current consent → `409 consent_required` (the code is not burnt). Issues a new device id unless the client's id is one of this user's devices |
| `POST /auth/email/change` | `{newEmail}` (step-up) | `202 {"ok":true}` | Sends a code (purpose `email_change`) to the new address; the reply is the same whether or not the address has an account |
| `POST /auth/email/confirm` | `{code}` | `200 {emailMasked}` | Moves the address (refused with the same uniform reply if it is any other account's primary or recovery address — one address, one role, one account); signs out every other session; the old address gets a notice with a **7-day revert code** |
| `POST /auth/email/revert` | `{email (old), code}` | `200 {ok, sessions, passkeysRemoved, identitiesRemoved}` + cookie | Restores the old address; revokes every session; removes every passkey, recovery address and **Google / LinkedIn identity linked since the change** (`linked_at > email_changed_at`) together with every session those identities created; audits `email_revert` |
| `POST /auth/recovery/set` / `remove` | `{email}` → code to that address, then `{code}` (step-up) | `200 {ok}` | Notice to the primary address. The address may not be any account's primary or recovery address (the check runs on both indexes; uniform reply) |
| `POST /auth/passkey/options` | `{purpose:'signin'\|'stepup'}` | `200 {publicKey:{challenge, rpId:'welltest.h2oil.co.uk', userVerification:'required', allowCredentials:[] (signin) \| the session user's credentials (stepup)}}` + `__Host-wts_chal` (5 min, single use) | Phase 3 |
| `POST /auth/passkey/verify` | `{credential, publicDevice}` | as code/verify | Origin exactly `https://welltest.h2oil.co.uk`, rpId, signature, **UV=1**; step-up: the credential must belong to `app.user_id`. Counter: 0 = no counter; only a counter that goes backwards is flagged (audit + notice) |
| `POST /auth/passkey/register/options` | `{}` (step-up) | `{publicKey:{…, user:{id:<random user id>}, excludeCredentials, authenticatorSelection:{residentKey:'required', requireResidentKey:true, userVerification:'required'}, attestation:'none'}}` | ≤ 10 passkeys; user handle never the e-mail |
| `POST /auth/passkey/register/verify` | `{credential, name}` | `201 {id, name, created}` | Notice mail |
| `POST /auth/passkey/rename` / `remove` | `{id, name?}` (remove: step-up) | `200 {ok}` | Remove: notice mail |
| `POST /auth/signout` | `{}` | `200 {ok}` + cookie cleared | |
| `POST /auth/signout-all` | `{alsoRecentMethodsDays?:n}` (step-up) | `200 {ok, sessions, passkeysRemoved, identitiesRemoved}` | Notice mail; optionally removes passkeys and provider links added in the last n days (and so the sessions of those links) |
| `GET /auth/providers` | — (no auth, no cookie read, `no-store`) | `200 {google:'on'\|'signin'\|'off', linkedin:'on'\|'signin'\|'off'}` | Fetched when the sign-in dialog or the *Sign-in methods* card opens (a user action, so a signed-out first visit still makes no request, §5.5). `off` (switch, breaker open or the production pins failing, §4.11) hides the button; `signin` labels it "existing accounts only" and hides it on the *Sign-in methods* card. On a network error the buttons show and `start` decides |
| `POST /auth/oauth/:provider/start` | `{purpose:'signin'\|'link', publicDevice:bool, deviceLabel?}`; `:provider` = `google` \| `linkedin`; `link` needs a session with **step-up** (`stepup_at` within 10 min) — the only step-up check of a link | `200 {url}` + `__Host-wts_oa` (HttpOnly, Secure, Path=/, SameSite=Lax, Max-Age=600) | Creates the attempt (§4.10). `url` = the provider's authorization URL with `response_type=code`, `client_id`, the fixed `redirect_uri`, `scope`, `state`, `nonce`, `code_challenge` (S256) and, for Google, `prompt=select_account` — or `prompt=login` with `max_age=0` when the attempt is **fresh-login** (public tick, or this browser is marked shared; §4.11, T30); LinkedIn with fresh-login uses the forced-login parameter WP0 confirms, else `start` answers `400 oauth_failed {reason:'reauth_stale'}` and the button is hidden while the tick is set. Normal Origin / header rules. A new start replaces this browser's earlier attempt. Hard ceiling: 20 live attempts per IP prefix (`503 provider_off`, §8.3) |
| `GET /auth/oauth/:provider/callback` | `?code&state[&iss]` or `?error&state` from the provider | always `303 Location: <APP_URL>#acct-oauth` | §3.2 exception. Finds the attempt by its cookie hash, checks `state` (constant time) and provider, marks it used **before** the exchange, exchanges the code (at most 30 exchanges per IP prefix per 10 min; beyond that the attempt fails with `provider` without contacting the provider), validates the id_token (§4.11), stores the outcome `{sub, email, emailVerified, hd?, authTime?}` or the failure reason in the attempt; never sets the session cookie. A provider `error` is mapped to the fixed reason enum through an allow-list of known codes; `error_description` and unknown codes are never stored, logged or shown |
| `POST /auth/oauth/finish` | `{}` first; then, when asked, `{email}`, `{code}` and / or `{consent:{terms, privacy}}` | see below | Same origin, normal header rules; needs the `__Host-wts_oa` cookie; a `link` attempt also needs the session that started it (`bound_sid`) and an attempt at most 10 min old at the callback — **no step-up re-check here**. When it answers `next:'email'`, `'code'` or `'consent'` it **re-issues the attempt cookie** as SameSite=**Strict**, Max-Age=1200, and moves the attempt's `result_expires_at` to cover the live code (15 min) plus 5 min, capped at 30 min from start (§4.10 item 3). A finish that signs in **revokes any session id the request carried** (same user: rotated; another user: revoked, then the §10 hand-over check runs) and always issues a fresh id. Clears the attempt cookie when it ends (signed in, linked or failed) |
| `GET /auth/methods` | — (signed in) | `{email:{masked}, recovery?:{masked}, identities:[{id, provider, emailMasked, linkedAt, lastUsedAt}], passkeys:[{id, name, created, lastUsed}]}` | |
| `POST /auth/methods/unlink` | `{id}` (step-up) | `200 {ok, methods, sessionsRevoked}` / `409 last_method` | In one transaction: deletes the identity and **revokes every session it created** (`sessions.identity_id`; the current session too when it is one of them, which then gets `401 signed_out` on its next call); notice mail; audit `identity_unlink {identity_id, subject_bidx}` |

`finish` answers (one per call; the dialog follows `next`):
```json
{ "next": "done", "user": {…}, "firstSignIn": false, "device": {…}, "session": {…}, "method": "google",
  "providerEmailDiffers": false }                 // + __Host-wts_sid (Strict); a link ends {"next":"done","linked":{…}}
{ "next": "email", "reason": "missing" }        // or "unverified" / "unmanaged": ask for an address (prefilled), then {email}
{ "next": "code", "emailMasked": "n•••@company.example", "reason": "verify" }
                                                 // or "link_existing" / "link_confirm" / "cancel_deletion"; a code was sent,
                                                 // bound to the attempt (purpose oauth_verify, or link_confirm for a link)
{ "next": "consent", "newAccountEmailMasked": "x•••@personal.example" }   // new account: Terms / Privacy, then {consent}
```
Errors: `400 oauth_state` (no valid attempt, or past its expiry), `400 oauth_failed {reason}`, `400 invalid_or_expired` (wrong
code; 5 tries), `403 locked`, `403 not_invited`, `403 signup_closed`, `409 identity_in_use`, `409 provider_linked`,
`409 consent_required` (only for a `{consent}` body with stale versions; the normal step is `next:'consent'`), `503 provider_off`,
`503 paused` (`ACCOUNTS_OFF`). The `{email}` step always answers `next:"code"` whether or not an account uses that address (no
enumeration); `link_existing` is said only when the provider vouched for, **and manages**, an address that an account uses (the
user controls that address already). `not_invited` and `signup_closed` leak nothing: they come only after the provider vouched
for the address or our code proved it.

**Me, devices, library**

| Method, path | Request | Response |
|---|---|---|
| `GET /me` | — | `{user:{id, emailMasked, recoveryMasked?, created, status, deleteAt?, terms, privacy}, session:{publicDevice, authAt, authMethod, stepupAt, idleExpires, absExpires}, quota:{limit, used}, opts:{historian, liveCfg}, projects:n, passkeys:[…], identities:[{id, provider, linkedAt, lastUsedAt}], devices:[{id, label, lastSeen, current}], minClient}` |
| `GET /me/outbox-key` | — | `{k}` — 32 random bytes per user, used only to encrypt a public device's waiting changes (§10.8) |
| `POST /me/opts` | `{historian?:bool, liveCfg?:bool}` | `{opts}` |
| `POST /devices/rename` / `revoke` | `{id, label?}` | `{ok}` (revoke deletes that device's sessions; notice mail) |
| `GET /library` | — | `{rev, hash, savedAt}`; `GET /library/body` → gzip JSON |
| `POST /library/commit` | `{pushId, baseRev, hash, body(base64 gzip, ≤ 2 MB)}` | `200 {rev}` / `409 stale {rev, hash}` |

`deviceLabel` is at most 40 characters from letters, digits, space and `-_.()`; it is shown escaped in the UI and **never put in
an e-mail** (mails name the server-derived browser and OS family only).

**Projects**

| Method, path | Request | Response |
|---|---|---|
| `GET /projects` | `?trash=0\|1` | `[{id, name, meta:{client, well, field, operator}, wells:n, headRev, savedAt, savedBy:{device}, bytes, conflictOf?}]` |
| `POST /projects` | `{name, meta}` | `201 {id, headRev:0}` (≤ 200 projects) |
| `GET /projects/:id/head` | — | `{rev, savedAt, device, coreHash, vhash, parts:[{name, hash, bytes}], bytes, coreInline?}` (`coreInline` when ≤ 48 kB gzip) |
| `GET /projects/:id/revs` | `?limit=50` | `[{rev, savedAt, device, reason, bytes, coreHash}]` |
| `GET /projects/:id/rev/:rev` | — | the commit record of that revision (as `head`) |
| `POST /projects/:id/commit` | see below | `200 {rev, savedAt}` / `409 stale` / `422 missing_blobs` / `413` |
| `POST /projects/:id/rename` | `{name, meta?}` | `{ok}` |
| `POST /projects/:id/trash` / `restore` / `purge` | `{}` (purge: step-up) | `{ok}` |
| `POST /projects/:id/restore-rev` | `{rev, pushId}` | `200 {rev}` (a new head, `reason:'restore'`) |
| `POST /projects/:id/duplicate` | `{name}` | `201 {id, headRev:1}` (references the same blobs) |

Commit request:
```json
{
  "pushId": "6f1c…uuid",
  "baseRev": 41,
  "reason": "auto",                       // auto | save | migrate | conflict | restore | overwrite | import
  "core":  { "hash": "<sha256 of the canonical stored core>", "vhash": "<sha256 of the normalised view>",
             "zsha": "<sha256 of gzip>", "bytes": 48213, "inline": "<base64 gzip, optional, ≤ 48 kB gzip>" },
  "parts": [ { "name": "well/w1",              "hash": "…", "bytes": 61230 },
             { "name": "well/w1/prism_gauges", "hash": "…", "bytes": 9120344 },
             { "name": "well/w2",              "hash": "…", "bytes": 512004 } ],
  "meta":  { "name": "Example-1 DST", "client": "Operator Energy Ltd", "well": "Example-1", "field": "", "operator": "" },
  "wells": [ { "id": "w1", "name": "Example-1" }, { "id": "w2", "name": "Example-2" } ],
  "fmt": 2, "appVer": "4.0"
}
```
With `core.inline` the server checks `zsha` and stores the bytes as the core blob in the same transaction (one request for every
core-only push, and the pagehide form). Without it, the core is a blob uploaded before the commit. `overwrite` is accepted only
with `baseRev` equal to the head the client was shown in the 409; the replaced revision stays in history.

**Blobs** (content-addressed per user, immutable once complete)

| Method, path | Request | Response |
|---|---|---|
| `POST /blobs/has` | `{hashes:[…≤ 200]}` | `{missing:[…]}` |
| `PUT /blobs/:hash/:n?of=N` | raw gzip chunk ≤ 4 MB; headers `X-WTS-Zsha`, `X-WTS-Chunk-Sha` | `204`; complete when all N chunks are in and `zsha` matches. A PUT to a complete blob, or a different body for a stored chunk, is `409 immutable` (a byte-identical repeat is `204`) |
| `GET /blobs/:hash/:n` | — | raw gzip chunk (`X-WTS-Of: N`, `X-WTS-Zsha`) |

The client decompresses through `DecompressionStream` and stops at the declared `bytes` plus 1 %; a larger stream is refused as
corrupt (gzip-bomb guard). Read limits: §8.3.

**Account**

| Method, path | Request | Response |
|---|---|---|
| `POST /account/export` | `{}` (step-up) | `{user, consents, devices, passkeys:[names, dates], identities:[provider, subject, email (in full, as received at link time), emailVerifiedAtLink, linkedAt, lastUsedAt], audit:[own rows, 12 months], projects:[{id, name, meta, headRev, revs}]}`; also raises **this session's** blob read limit to 300 MB/h for 2 h and sends a security notice. The client adds the bodies (§8.5) |
| `POST /account/delete` | `{confirm:'DELETE', immediate?:bool}` (step-up; `immediate` needs a second step-up) | `200 {ok, deleteAt}`; status `deleting`, every session revoked, everything hidden; purge after 7 days unless cancelled |
| `POST /account/delete/cancel` | `{}` (a sign-in during the grace period offers it) | `200 {ok}` |
| `GET /health` | — | `{ok:true, db:true, ver}` (no auth) |

### 3.4 Data model (SQL DDL, abridged)

All user tables: `user_id uuid NOT NULL`, `ENABLE` and `FORCE ROW LEVEL SECURITY`, policy
`USING (user_id = current_setting('app.user_id', true)::uuid) WITH CHECK (same)`. With no `app.user_id` set the setting is NULL
and no row matches. `enc` columns hold envelope-encrypted bytes.

**Roles and the pre-auth path.**

| Role | Used by | Rights |
|---|---|---|
| `wts_owner` | migrations only (manual tagged job) | owns tables and definer functions; never used by a function at run time |
| `wts_api` | request handlers | DML on user tables under RLS; `EXECUTE` on the definer functions below; nothing else |
| `wts_jobs` | the scheduled daily function only (own credential, never loaded by request handlers) | `BYPASSRLS` limited by grants to: purge, prune, quota recompute, deletion purge, mail outbox send, ledger write |
| `wts_support` | `server/ops/*` scripts | `EXECUTE` on the audited support functions only (each writes an audit row with actor `support:<id>`) |

| Definer function (`SECURITY DEFINER`, `SET search_path = wts, pg_temp`) | Returns |
|---|---|
| `resolve_session(sid_hash)` | `user_id, device_id, public_device, auth_at, stepup_at, auth_method, identity_id, idle_expires_at, abs_expires_at, status` (also accepts a `replaced` hash within 30 s) |
| `user_by_email(email_bidx)` | `user_id, status, role` (`primary` \| `recovery`; matches the primary or the recovery index) |
| `user_by_credential(credential_id)` | `user_id, passkey_id, public_key, sign_count` |
| `create_user(email_bidx, email_enc, signup_method, consent…, data_key_wrapped, kid)` | `user_id`; refuses an `email_bidx` that is any account's primary or recovery index |
| `user_by_identity(provider, subject_bidx)` | `user_id, identity_id, status` |
| `oauth_attempt_create(…)`, `oauth_attempt_take(cookie_hash, state_hash, provider)`, `oauth_attempt_result(…)`, `oauth_attempt_extend(cookie_hash, new_cookie_hash, until)`, `oauth_attempt_finish(cookie_hash, sid_hash?)`, `identity_link(user_id, …)`, `identity_touch(identity_id)`, `identity_unlink(identity_id)` (deletes it and its sessions) | the minimum each step needs; an attempt is reachable only through the hash of its own cookie |
| `oidc_key_get(provider, kid)`, `oidc_key_put(provider, kid, jwk, expires_at)` | the cached public key; `wts_api` has no other access to `oidc_keys` (not a user table: public keys only, no RLS) |
| `code_issue(…)`, `code_check(…)`, `challenge_issue(…)`, `challenge_take(…)`, `rate_hit(bucket, window, limit)`, `allowlist_has(email_bidx)` | the minimum each flow needs |

`rls.test.js` (CI, local database server): `wts_api` cannot `SELECT` from `sessions` or `users` without `app.user_id`; user A cannot read
or write B's rows; every user table has FORCE RLS; `wts_api` has no `BYPASSRLS` and no DDL;
`current_setting('app.user_id', true)` is NULL at the start of every pooled transaction; each definer function returns only its
listed columns; `wts_api` cannot read `oauth_attempts` or `oidc_keys` directly at all, nor `identities` of another user, nor look
an identity up except through `user_by_identity`.

```sql
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid GENERATED ALWAYS AS (id) STORED,          -- uniform RLS column
  email_bidx bytea UNIQUE NOT NULL,                      -- HMAC-SHA256(index_pepper, email_norm); no plaintext address
  email_enc bytea NOT NULL,                              -- display form, encrypted; decrypted only to send mail
  recovery_bidx bytea UNIQUE, recovery_enc bytea,        -- optional recovery address
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','deleting')),
  created_at timestamptz NOT NULL DEFAULT now(), last_sign_in_at timestamptz,
  signup_method text NOT NULL DEFAULT 'code' CHECK (signup_method IN ('code','google','linkedin')),  -- primary always verified
  terms_version text NOT NULL, privacy_version text NOT NULL, consented_at timestamptz NOT NULL,
  quota_bytes bigint NOT NULL DEFAULT 250000000, used_bytes bigint NOT NULL DEFAULT 0,
  opt_historian boolean NOT NULL DEFAULT false, opt_livecfg boolean NOT NULL DEFAULT false,
  data_key_wrapped bytea NOT NULL, data_key_kid int NOT NULL, data_key_ver int NOT NULL DEFAULT 1,
  outbox_key_enc bytea,                                  -- §10.8
  lib_rev bigint NOT NULL DEFAULT 0, lib_hash bytea,
  delete_requested_at timestamptz, delete_at timestamptz, inactivity_warned_at timestamptz,
  email_changed_at timestamptz, email_prev_bidx bytea, email_prev_enc bytea, email_revert_until timestamptz
);
CREATE TABLE passkeys (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  credential_id bytea UNIQUE NOT NULL, public_key bytea NOT NULL, sign_count bigint NOT NULL,
  transports text[], backup_eligible boolean, backup_state boolean, aaguid uuid,
  name_enc bytea, created_at timestamptz NOT NULL, last_used_at timestamptz);
CREATE TABLE identities (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google','linkedin')),
  issuer text NOT NULL,                                  -- the accepted iss at link time
  subject_bidx bytea NOT NULL,                           -- HMAC-SHA256(index_pepper, provider ‖ sub): the lookup key
  subject_enc bytea NOT NULL,                            -- sub itself, encrypted (index re-computation at pepper rotation)
  email_link_enc bytea,                                  -- the provider's e-mail at link time (shown masked)
  email_verified_at_link boolean NOT NULL,               -- the flag as received (LinkedIn: recorded, never trusted)
  linked_at timestamptz NOT NULL, linked_via text NOT NULL CHECK (linked_via IN ('signup','code_confirm','account_page')),
  last_used_at timestamptz,
  email_ack_bidx bytea,                                  -- last provider e-mail the user saw the "differs" note for (U18)
  UNIQUE (provider, subject_bidx), UNIQUE (user_id, provider));   -- one user, many identities; one per provider
CREATE TABLE oauth_attempts (id uuid PRIMARY KEY, cookie_hash bytea UNIQUE NOT NULL,   -- SHA-256 of the __Host-wts_oa value
  provider text NOT NULL, purpose text NOT NULL CHECK (purpose IN ('signin','link')),
  state_hash bytea NOT NULL, nonce bytea NOT NULL, pkce_verifier_enc bytea NOT NULL,
  bound_sid bytea, bound_user uuid,                      -- link only: the session and user that started it
  public_device boolean NOT NULL, fresh_login boolean NOT NULL, device_label_enc bytea,  -- fresh_login: §4.11 auth_time
  created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,             -- callback by start + 10 min
  used_at timestamptz, result_enc bytea, result_expires_at timestamptz,          -- {sub, email, emailVerified, hd} | {fail};
                                                         -- callback + 5 min, moved by finish to cover a code (≤ start + 30 min)
  finished_at timestamptz, ip_prefix inet);             -- pre-auth: no user_id; reached only through definer functions
CREATE TABLE oidc_keys (provider text, kid text, jwk jsonb NOT NULL, fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL, PRIMARY KEY (provider, kid));                 -- signing-key cache, public keys only
CREATE TABLE email_codes (id uuid PRIMARY KEY, email_bidx bytea NOT NULL, code_hmac bytea NOT NULL, pepper_kid int NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('signin','stepup','email_change','recovery_add','oauth_verify','link_confirm')),
  bound_user uuid, bound_sid bytea, bound_attempt uuid,  -- oauth_verify / link_confirm: bound to the attempt (and session)
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0, used_at timestamptz, invalidated_at timestamptz, ip_prefix inet);
CREATE TABLE webauthn_challenges (id uuid PRIMARY KEY, challenge bytea NOT NULL, purpose text NOT NULL,
  user_id uuid, expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE TABLE devices (user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE, device_id uuid NOT NULL,
  label_enc bytea, ua_family text, first_seen timestamptz, last_seen timestamptz, last_sync_at timestamptz,
  last_base_rev jsonb,                                   -- {projectId: rev}: never pruned (§3.5)
  revoked_at timestamptz, PRIMARY KEY (user_id, device_id));
CREATE TABLE sessions (sid_hash bytea PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  device_id uuid, public_device boolean NOT NULL, created_at timestamptz NOT NULL,
  auth_at timestamptz NOT NULL,                          -- when the session was created (any method); never a step-up proof
  stepup_at timestamptz,                                 -- last successful code / UV passkey check; NULL after a provider sign-in
  last_seen_at timestamptz NOT NULL, idle_expires_at timestamptz NOT NULL,
  abs_expires_at timestamptz NOT NULL,
  auth_method text NOT NULL DEFAULT 'code' CHECK (auth_method IN ('code','google','linkedin','passkey')),
  identity_id uuid REFERENCES identities ON DELETE CASCADE,   -- the identity that created it; unlink revokes its sessions
  replaced_by bytea, replaced_at timestamptz, ip_prefix inet, ua_family text);
CREATE TABLE projects (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  meta_enc bytea NOT NULL, well_count int NOT NULL DEFAULT 0,
  head_rev bigint NOT NULL DEFAULT 0, head_core bytea, head_vhash bytea, head_bytes bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL, modified_at timestamptz NOT NULL, deleted_at timestamptz,
  is_conflict_of uuid REFERENCES projects);
CREATE TABLE revisions (project_id uuid REFERENCES projects ON DELETE CASCADE, user_id uuid NOT NULL,
  rev bigint NOT NULL, core_hash bytea NOT NULL, vhash bytea NOT NULL, parts jsonb NOT NULL,
  bytes bigint NOT NULL, device_id uuid, session_hash bytea, reason text NOT NULL, app_ver text,
  saved_at timestamptz NOT NULL, pinned boolean NOT NULL DEFAULT false, squashed_into bigint,
  PRIMARY KEY (project_id, rev));
CREATE TABLE blobs (user_id uuid NOT NULL, hash bytea NOT NULL, zsha bytea NOT NULL, bytes bigint NOT NULL,
  chunks int NOT NULL, complete boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL,
  refcount int NOT NULL DEFAULT 0, dkv int NOT NULL DEFAULT 1, PRIMARY KEY (user_id, hash));
CREATE TABLE push_receipts (user_id uuid NOT NULL, push_id uuid NOT NULL, result jsonb NOT NULL,
  at timestamptz NOT NULL, PRIMARY KEY (user_id, push_id));                    -- kept 24 h
CREATE TABLE historian_backups (id uuid PRIMARY KEY, user_id uuid NOT NULL, blob_hash bytea NOT NULL,
  bytes bigint, t_from timestamptz, t_to timestamptz, saved_at timestamptz);
CREATE TABLE mail_outbox (id uuid PRIMARY KEY, to_enc bytea NOT NULL, template text NOT NULL, params_enc bytea,
  created_at timestamptz NOT NULL, sent_at timestamptz, tries int NOT NULL DEFAULT 0);   -- kept 24 h after sending
CREATE TABLE signup_allowlist (email_bidx bytea PRIMARY KEY, added_at timestamptz NOT NULL, note text);
CREATE TABLE deletion_ledger (user_id uuid PRIMARY KEY, requested_at timestamptz NOT NULL, purge_at timestamptz NOT NULL,
  purged_at timestamptz);                                 -- no e-mail; mirrored outside the database (§13.5)
CREATE TABLE rate_counters (bucket text, window_start timestamptz, n bigint NOT NULL, PRIMARY KEY (bucket, window_start));
CREATE TABLE audit (id bigserial PRIMARY KEY, user_id uuid, actor text NOT NULL,   -- user | system | support:<id>
  action text NOT NULL, target text, device_id uuid, ip_prefix inet, ua_family text, at timestamptz NOT NULL,
  detail jsonb,                    -- never content, never an e-mail; identity rows: {provider, via, identity_id, subject_bidx}
  prev_hash bytea, hash bytea NOT NULL);                                          -- hash chain per user, heads anchored daily
```
- **Blob object key**: `u/<user_id>/b/<hex hash>/<n>`, built from the session's user id. Chunk ciphertext:
  `header {v:1, alg:'A256GCM', kid, dkv, iv}` ‖ AES-256-GCM(data key `dkv`, iv, chunk, AAD =
  `"wts1|" + userId + "|" + hash + "|" + n + "|" + kid`).
- **Revisions kept**: every non-`auto` revision (save, migrate, restore, overwrite, conflict, import) for 30 days; `auto`
  revisions squashed to **one per 10-minute bucket for the last 24 h**; one per day for 30 days; every revision referenced by a
  conflict copy or by any `devices.last_base_rev`; and the last revision before a **burst** (> 10 commits in 10 minutes) is
  `pinned` for 7 days. Squash and prune run in the commit transaction (≤ 10 rows per request) and in the daily job. A blob whose
  `refcount` reaches 0 is deleted after 7 days.
- **Quota**: `used_bytes` = Σ compressed bytes of the user's blobs (deduplicated). Checked in the chunk PUT and in the commit.
- **Provider columns in the first schema**: `sessions.auth_method` (default `'code'`), `sessions.stepup_at`,
  `sessions.identity_id`, `users.signup_method` (default `'code'`), `email_codes.bound_attempt` and `identities.email_ack_bidx`
  are all in the first v4.0 schema, so a provider release after v4.0 needs no migration of existing rows (at most an
  expand-only migration with these defaults).

### 3.5 Server jobs
One daily scheduled function, running as `wts_jobs` (server-side scheduling does not touch the client's no-timer rule): purge
used / expired codes, challenges and provider sign-in attempts (24 h), signing-key cache rows past their expiry, expired sessions, rate counters (7 days), push receipts (24 h), sent mail (24 h),
unreferenced blobs (7 days), trashed projects (30 days); purge accounts whose `delete_at` has passed and stamp the ledger; squash
and prune revisions; send inactivity warnings; recompute `used_bytes`; write the day's audit chain heads to the anchor object
(§13.5). The mail outbox is drained after each request by the background facility and re-tried by the daily job. If the host plan
has no scheduler, the CI workflow calls `POST /api/v1/ops/daily` (HMAC rule, §3.2).

---

## 4. Sign-in and sessions (detail)

1. **Code start.** Normalise the address (trim, lower-case, NFKC); refuse anything that is not a plausible single address
   (≤ 254 characters). Generate 8 random digits; store `HMAC-SHA256(pepper[kid], purpose ‖ email_norm ‖ code [‖ user_id ‖
   sid_hash])`; queue the mail. Text: *"Your Well Testing Suite sign-in code is 1234 5678. It expires in 15 minutes. Only enter
   this code at welltest.h2oil.co.uk — we will never ask you for it. Requested from <browser family> on <OS family> at <time
   UTC>. If you did not ask for it, ignore this e-mail."* Sender no-reply@h2oil.co.uk with SPF, DKIM and DMARC (quarantine,
   then reject). Up to two codes per address and purpose are live at once ("Send again" does not kill a slow first mail); a
   third invalidates the oldest.
2. **Verify.** Constant-time compare against the live codes for that address and purpose (and, for step-up, the session);
   attempts + 1; on success mark used and invalidate the other live code; create the user if new, consented and allowed (invite
   mode); create or reuse the device row `(user_id, device_id)`; create a session (new id, `auth_at = stepup_at = now`,
   `auth_method:'code'`); set the cookie; audit `signin`. A sign-in from a new device sends a notice ("New sign-in on <browser family, OS family> at <time>").
3. **E-mail change.** Step-up → `POST /auth/email/change` sends a code to the new address (uniform reply) → confirm moves the
   address, keeps the old index for 7 days, signs out every other session, and mails the **old** address: *"The e-mail address
   of your Well Testing Suite account was changed on <date>. If this was not you, enter code 1234 5678 at
   welltest.h2oil.co.uk/#account-revert within 7 days."* Revert restores the old address, revokes every session, and removes every
   passkey, recovery address and Google / LinkedIn identity added since the change (with the sessions those identities
   created), so a session holder who linked their own provider account during a step-up window keeps no way in (T18).
4. **Recovery address.** Optional, verified by a code, step-up to set or remove, notices to both addresses. A sign-in or step-up
   code can be sent to it ("Send the code to my recovery address"). The profile card suggests adding a personal address. **One
   address, one role, one account**: a primary or recovery address may not equal any other account's primary or recovery address
   (checked in `create_user`, `recovery/set` and `email/confirm` against both indexes, with the uniform reply).
5. **Passkeys** (Phase 3). Registration with `residentKey:'required'` and UV required; the user handle is the random user id.
   The e-mail field has `autocomplete="username webauthn"` and starts `navigator.credentials.get({mediation:'conditional'})`.
   Sign-in and step-up need UV=1; without UV the dialog falls back to a code. Step-up passes `allowCredentials` with the session
   user's credentials. After a code sign-in the dialog offers "Add a passkey for faster sign-in".
6. **Session lifetime.** Each authenticated request slides `idle_expires_at` (written at most every 10 minutes). Expired →
   `401 signed_out`. No client refresh timer exists.
7. **Step-up.** `stepup_at` within 10 minutes, else `403 reauth`; the client runs a code (purpose `stepup`, to the primary or the
   recovery address) or a UV passkey check in place and repeats the call. `stepup_at` is set by `code/verify`, `passkey/verify`, a
   `stepup` code, and the `oauth_verify` code of §4.12 rules 4 and 5 (a code to the account's own address, the same proof as a code
   sign-in); **never** by a provider sign-in alone (rules 1 and 3 leave it NULL) or by a `link_confirm` code. Server tests: a
   Google sign-in followed at once by `email/change`, `methods/unlink`, `signout-all`, `account/delete`, `account/export`,
   `recovery/set` and `oauth/start {purpose:'link'}` each answer `403 reauth`. Step-up rotates the session id; the old hash stays valid for 30 s (`replaced_at`), and a client
   401 re-reads `/me` once before it shows "Signed out".
8. **Public computer.** 12 h idle / 7 days absolute; device row labelled "public"; the wipe rules of §10.8; new-device notices as
   usual.
9. **Security notices** (plain text, no client-supplied text): new-device sign-in, passkey added / removed, Google or LinkedIn
   linked / unlinked, e-mail change (to
   both), recovery address set / removed, sign out everywhere, device revoked, export started, deletion requested / cancelled /
   done, a counter going backwards, a read burst (§8.3), a commit burst. *Sign out everywhere* can also remove passkeys and Google /
   LinkedIn links added in the last 14 days (a tick box); removing a link always revokes the sessions it created.


### 4.10 Sign in with Google or LinkedIn — the flow

```
 page (welltest.h2oil.co.uk)               our API (/api/v1)                          provider (Google | LinkedIn)
 1 flush autosave; hint.oauth = {p, route, at}
 2 POST /auth/oauth/p/start ─────────────▶ attempt {state, nonce, PKCE, p, purpose}, 10 min
   ◀── 200 {url} + __Host-wts_oa (Lax)
 3 location.assign(url) ──────────────────────────────────────────────────────────▶ sign-in and consent there
 4                                         GET /auth/oauth/p/callback?code&state ◀── 303 (cross-site top-level GET:
                                           cookie + state + provider checked           the Lax cookie is sent,
                                           attempt marked used; code exchange ──────▶  a Strict one would not be)
                                           id_token checks (§4.11) ◀──────────────── id_token (access token dropped)
                                           outcome kept 5 min in the attempt
   ◀── 303 <APP_URL>#acct-oauth  (constant; nothing in the URL)
 5 page loads (same origin), sees #acct-oauth and hint.oauth, history.replaceState
 6 POST /auth/oauth/finish ──────────────▶ linking rules (§4.12) → next: done | email | code | consent
   ◀── done: __Host-wts_sid (Strict) set on this same-origin response; attempt cookie cleared
 7 restore hint.oauth.route (a known route key, else home); hand-over and migration (§10)
```

1. **Before leaving** (steps 1–3): `WTS_pageAutosave.flush()`; in Phase 2 the outbox entry is prepared as on
   `visibilitychange→hidden`. The hint records `oauth {provider, route, at}` so that the returning page knows to finish and the
   head guard skips the analytics tag on it (D20, H17). Offline: the provider buttons are disabled ("needs a connection").
2. **`fetch` then `location.assign`, never a form**: the CSP keeps `form-action 'self'`, and browsers that apply `form-action` to
   the redirect after a form post would block the jump to the provider. A top-level navigation is not governed by the CSP, so no
   CSP change is needed (§8.2).
3. **Attempt** (`oauth_attempts`): a random 32-byte cookie value (the database keeps its SHA-256), `state` of 32 random bytes
   (hash kept), `nonce` of 32 random bytes, a PKCE verifier (43–128 characters, challenge S256, stored encrypted), provider,
   purpose, the dialog's public-computer tick, the `fresh_login` flag (the tick, or the browser's `wtspref_shared_browser`
   flag, T30), the device label and, for `link`, the session hash and user. One live attempt per browser (a new start replaces
   it). **Lifetime**: the callback must come within 10 minutes of the start; the outcome is then readable for 5 minutes. When
   `finish` answers `next:'email'`, `'code'` or `'consent'`, it re-issues the cookie with a new value (old hash dropped) as
   **SameSite=Strict**, Max-Age=1200 — Lax is needed only for the cross-site hop to the callback — and moves `result_expires_at` to
   the live code's expiry plus 5 minutes, never beyond 30 minutes from the start. A slow code mail or a slow provider login
   therefore does not end the attempt while the 15-minute code is still valid (test: a code entered 12 minutes after the
   callback finishes; one entered 31 minutes after the start gets `oauth_state`).
4. **Callback**: refuse unless the cookie's attempt exists, is unused and unexpired, belongs to this provider path, and `state`
   matches; mark it used first (a replayed callback or code finds it used). A provider `error` is mapped through an allow-list
   (Google `access_denied`, LinkedIn `user_cancelled_login` / `user_cancelled_authorize` → `cancelled`; any other known code →
   `provider`; an unknown code → `provider`, logged only as `unknown`); `error_description` is never stored, logged or shown.
   When the provider sends `iss` on the callback (Google does), it must equal the configured issuer (mix-up defence). The
   per-prefix exchange limit (§8.3) is checked before the token endpoint is called. Exchange the code at the configured token
   endpoint with `client_id`, `client_secret`, the fixed `redirect_uri` and the PKCE verifier. **PKCE is required for both
   providers if it is enforced**: Google enforces it; for LinkedIn WP0 sends a deliberately wrong `code_verifier` and records
   whether the exchange is refused. If LinkedIn refuses it, a verifier mismatch is treated as a failure like Google's; if it
   enforces neither PKCE nor nonce, the code-injection residual is written into T23 and LinkedIn ships only on the owner's
   decision (Q32), behind `OAUTH_LINKEDIN`. Validate the id_token (§4.11) and drop the access token. Then `303` to the constant `APP_URL` (`https://welltest.h2oil.co.uk` plus the app path confirmed in WP0) with the
   fragment `#acct-oauth` (a fragment never reaches the server or the service worker's cache key). **There is no return-path
   parameter at all**: the page keeps the route in its own hint and checks it against the route table on return, so no open
   redirect can exist.
5. **Finish** applies the linking rules of §4.12; when it ends signed in it behaves like `code/verify` (consent, invite allow-list —
   `403 not_invited` / `403 signup_closed` for a refused new account, device row, new session with `auth_method` and
   `identity_id`, audit `signin {method}`, new-device notice), with two differences: `stepup_at` stays NULL unless an `oauth_verify`
   code was entered in this attempt (§4 item 7), and any session id the request carried is revoked first (same user: rotated
   into the new one; another user: revoked, then the §10 hand-over check runs before anything is uploaded). Test: a browser with a
   live session for user A finishes a Google sign-in as user B → A's session is gone, B's is fresh, and the hand-over dialog shows.
6. **Redirect URIs**: exactly `https://welltest.h2oil.co.uk/api/v1/auth/oauth/google/callback` and
   `https://welltest.h2oil.co.uk/api/v1/auth/oauth/linkedin/callback` in production; a separate **development client** per
   provider with the localhost URI where the provider accepts one (Google does; LinkedIn is checked in WP0). The development
   clients serve **local server runs and the WP0 live tests only**, selected by the server setting `WTS_OIDC_MODE=dev` (never
   accepted on the production host); the acceptance tests and the GUI sweep use the fake provider only. Deploy previews get no
   client: on any host but production the provider buttons are not shown, and DEV mode on localhost shows them only against the
   fake or development provider (§12.1).

### 4.11 id_token checks (`server/core/oidc.js`)
**Pinned configuration.** `oidc-providers.js` hard-codes the production issuers, authorization, token and signing-key (JWKS)
addresses; nothing in the environment can replace them on the production host. At start-up on the production host the server
refuses to serve any provider route (`GET /auth/providers` reports both `off`, and an alert fires) if any of them is not https or
not the pinned value, or if `WTS_OIDC_MODE` is set; the fake provider's localhost issuer and test keys can therefore never be
accepted in production (server test; a line in the §13.8 publish checklist).

The token comes from our own back-channel exchange over TLS, and it is still fully verified:
- **Algorithm and signature**: RS256 only — `none`, `HS256` or anything else is refused before any key lookup; the key is chosen
  by `kid` from the provider's signing keys (JWKS), cached in memory and in `oidc_keys` for the response's cache lifetime; an
  unknown `kid` causes at most **one refetch per provider per 5 minutes**; still unknown → `oauth_failed {reason:'token'}`.
- **`iss`**: exactly one configured value. Google: its two documented forms of the same issuer (with and without the `https://` scheme; the exact strings live in
  `oidc-providers.js`). LinkedIn: its live
  discovery document and its documentation page give different values; the accepted value is fixed in `oidc-providers.js`
  after the WP0 test with a real token, and any other value is refused.
- **`aud`** contains our client id (a list with any other unknown audience is refused); **`azp`**, when present, equals our
  client id.
- **`exp`** in the future and **`iat`** not in the future, each with **60 s** clock skew; `iat` at most 10 minutes old.
- **`nonce`** equals the attempt's nonce (constant time). Google: required. LinkedIn does not advertise nonce support: it is
  always sent and required whenever it comes back; if WP0 shows that LinkedIn never returns it, its absence is accepted for
  LinkedIn only and recorded in `oidc-providers.js`. The client secret and the cookie-bound `state` do **not** stop an
  authorization code leaked before we redeem it from being injected into an attacker's own attempt; only PKCE or a nonce does.
  So LinkedIn without either carries the T23 residual and ships only on the owner's decision (Q32).
- **`auth_time`** (fresh-login attempts only, §4.10 item 3): required and at most 60 s before the attempt's start (with the 60 s
  skew); Google is asked with `prompt=login` and `max_age=0`. Missing or older → `oauth_failed {reason:'reauth_stale'}`. A
  provider that cannot force a fresh login (LinkedIn unless WP0 finds a parameter that does and an `auth_time` to prove it) is
  not offered on a fresh-login attempt.
- **`sub`**: a non-empty string of at most 255 characters. Google's subject is the same for every app; LinkedIn's is **pairwise**
  (per app), so re-creating the LinkedIn app would change every LinkedIn user's subject (§4.14, §13.10).
- **`email` / `email_verified`**: `email` normalised as in §4.1; `email_verified` counts as true only for the boolean `true` or the
  string `"true"`; anything else, or no `email`, is unverified. **Trusted** (the address counts as proved without our code) only
  when `trustEmailVerified` holds for the provider **and** the provider manages the address: Google's flag is trusted when the
  address is on Google's own consumer mail domain (the exact string is pinned in `oidc-providers.js`), or when the id_token has a
  hosted-domain claim `hd` equal to the address's domain (a domain whose accounts its administrator controls). For any other
  domain the flag only says the address was verified once, at registration: a former employee keeps a Google account made on
  `name@company.example` after the mailbox is reassigned, so such addresses follow rule 5 (our e-mail code, `reason:'unmanaged'`).
  LinkedIn: `trustEmailVerified` **false** (it documents both claims as optional and states that it does not verify user
  identities) (Q27). Fake-provider test: a Google token with `email_verified:true`, no `hd` and a third-party domain gives
  `next:'email'` or `'code'`, never an account straight away.
- Nothing else is read (`hd` and `auth_time` only for the two checks above). LinkedIn's `name`, `given_name`, `family_name`,
  `picture` and `locale` arrive (its scope set requires `profile`) and are dropped in memory; Google is asked only for
  `openid email` (Q30). Codes, `state`, tokens, claims and provider error descriptions are never logged.

### 4.12 Linking and takeover rules (in `finish`)
Let *I* = (provider, subject) from the callback and *E* = the provider's e-mail, *trusted* when §4.11 says so (verified **and**
managed by the provider). In every rule, the account found is first checked for its status: `locked` → `403 locked`; `deleting`
→ `next:'code'` (`reason:'cancel_deletion'`) to the account's primary address, and only after that code does the dialog offer
*Cancel deletion* (a provider account alone can never undo a deletion the owner asked for); `ACCOUNTS_OFF` → `503 paused`.
1. **Known identity**: *I* is linked to user U → sign U in (`auth_method` = the provider, `identity_id`, **`stepup_at` NULL**) and
   update `last_used_at`. If *E* differs from the address recorded at link time **and** from `email_ack_bidx`, the answer carries
   `providerEmailDiffers:true` and the dialog offers *Change account e-mail* (the normal step-up flow) or *Keep my account
   e-mail*; either choice stores *E*'s index in `email_ack_bidx`, so the note shows once per new provider address. The account
   e-mail never follows the provider by itself (U18). A `link` attempt with a known *I*: same user → `done`; another user →
   `409 identity_in_use`.
2. **Link from the account page** (`purpose:'link'`): `start` needs a step-up in the last 10 minutes; `finish` needs the same
   session (`bound_sid`) and a callback within 10 minutes of the start, with no second step-up check. *I* is then linked only
   after a **link-confirm code** (purpose `link_confirm`, bound to the attempt and the session) sent to the account's primary
   address and entered in the dialog after the return; the mail names the provider and the masked provider e-mail: *"Someone
   asked to add Google (x•••@personal.example) as a way to sign in to your Well Testing Suite account. Enter this code only if
   that was you, only at welltest.h2oil.co.uk."* This stops a script injected during a step-up window from consenting with the
   attacker's own provider account in another browser and steering the victim's tab to the callback (T2, T28). *I* is linked
   whatever *E* is (`linked_via:'account_page'`); one identity per provider (`409 provider_linked`). The code does not set
   `stepup_at`.
3. **New identity, *E* trusted, no account uses *E*** (primary or recovery) → `next:'consent'` with the new account's masked
   address and the two-accounts warning (§11.2) → create the account with *E* as its verified primary address and link *I*
   (`signup_method` = the provider, `linked_via:'signup'`; `stepup_at` NULL). Invite mode: *E* must be on the allow-list, else
   `403 not_invited`; `ACCOUNTS_SIGNUP=off` → `403 signup_closed`; `OAUTH_<P>=signin` → `503 provider_off` (Q26).
4. **New identity, *E* trusted, an account uses *E*** → **never linked automatically**: an e-mail code (purpose `oauth_verify`,
   bound to the attempt) goes to ***E* itself** — the matched address, primary or recovery, which the account already trusts for
   sign-in codes (`next:'code', reason:'link_existing'`, address masked); after the code, *I* is linked
   (`linked_via:'code_confirm'`) and the user is signed in with `stepup_at` = now (U15, Q28).
5. **New identity, *E* missing, unverified or unmanaged** (LinkedIn always; Google without a verified address or on a domain
   Google does not manage) → `next:'email'`, prefilled with *E* when present: the user confirms or types an address, a code goes
   to it (uniform reply); after the code, an account using that address gets *I* linked and is signed in (`stepup_at` = now);
   otherwise consent, then a new account with that address and *I* linked (invite and sign-up switches as in rule 3). An
   unverified or unmanaged provider e-mail never links or creates anything on its own.
6. **Unlink**: step-up; refused (`409 last_method`) if it would leave the account with no method. The e-mail code cannot be removed
   (only changed), so in practice a provider can always be unlinked; the rule guards a later passkey-only mode. Unlink — and every
   other removal of an identity (sign out everywhere with recent links, e-mail revert, the security reset) — **revokes every
   session with that `identity_id` in the same transaction** and reports the count (server test).
7. **Audit and notices**: `identity_link {provider, via, identity_id, subject_bidx}` and `identity_unlink {provider, identity_id,
   subject_bidx}` rows — the subject only as its keyed index, never the subject or the provider e-mail — kept 12 months like other
   audit rows, so an incident can tell which external account was attached and whether one attacker identity was linked to
   several victims (the security-reset and link-spike queries use it, §13.6). A mail to the account address: *"Google was added
   as a way to sign in to your Well Testing Suite account on <date> from <browser family> on <OS family>. If this was not you,
   sign in with an e-mail code and remove it under Account → Sign-in methods — that also signs out every session it opened."* A
   mail also goes out when a provider is unlinked.
8. **Codes in these flows** follow §4.1–4.2 (8 digits, 15 min, 5 tries, at most two live) and are bound to their attempt, so a
   code requested in one attempt cannot finish another. The `oauth_verify` mail, which grants a lasting link and is therefore a
   better phishing target than a sign-in code, reads: *"Someone pressed Sign in with LinkedIn (or Google) and asked to add it to
   your Well Testing Suite account. Your code is 1234 5678. Enter it only if that was you, only at welltest.h2oil.co.uk. It
   expires in 15 minutes."*

### 4.13 Session cookie and attempt cookie
| Cookie | Attributes | Why |
|---|---|---|
| `__Host-wts_sid` (session) | Secure, HttpOnly, **SameSite=Strict**, Path=/ | unchanged (D4): every API call is a same-origin fetch, so Strict costs nothing and keeps the session off every cross-site request |
| `__Host-wts_oa` (attempt, start → callback) | Secure, HttpOnly, **SameSite=Lax**, Path=/, Max-Age=600 | the provider sends the browser back with a **cross-site top-level GET**; browsers send Lax cookies on such a navigation but **not** Strict ones, so a Strict attempt cookie would never reach the callback. `response_mode=form_post` is not used: a cross-site POST would not carry even a Lax cookie |
| `__Host-wts_oa` (attempt, re-issued by `finish` for a code / e-mail / consent step) | Secure, HttpOnly, **SameSite=Strict**, Path=/, Max-Age=1200, new value | from here every call is a same-origin POST, so Lax is no longer needed; the longer life covers the 15-minute code (capped at 30 min from start on the server) |

The callback therefore never sees the session cookie, by design: it issues no session (a Strict cookie set on the response to a
cross-site navigation would also be withheld from the page load that the redirect starts, so the page could look signed out).
The session is issued by `finish`, a same-origin POST from the page, under the normal Origin and header checks, and a link is
bound to the session that started it. The `__Host-` prefix stops sibling subdomains from planting or overwriting an attempt
cookie (T3). The round trip is tested in the three main browser engines (WP-I1).

### 4.14 Recovery when a provider is lost
- Every account has a verified primary address, so the e-mail code (and the recovery address, §4.4) always opens it; the dialog
  shows "Can't use Google or LinkedIn? Use the e-mail code."
- A deleted, locked or suspended provider account just fails at the provider; nothing changes on our side; the user unlinks the
  dead method, whose *last used* date shows it is stale (U17).
- A provider outage or a provider switched off: `start` answers `503 provider_off`; the e-mail code is untouched (U19).
- **LinkedIn app re-created** (a new client means new pairwise subjects): every LinkedIn sign-in then looks like a new identity.
  Because `UNIQUE (user_id, provider)` would answer `provider_linked`, the ops script `server/ops/retire-client` removes the
  orphaned LinkedIn rows (and their sessions; audited, users mailed) **before** the new client goes live; rule 5 then re-links each
  user after one e-mail code (server test). Avoided by never re-creating the app (§13.10).
- **Lost work mailbox**: step-up codes can go to the recovery address, so a user with one changes the primary address themselves;
  else the audited support recovery (§13.7), where a sign-in by a still-working linked provider counts as one of the
  identity-check items. A provider sign-in alone never changes the account address.

### 4.15 Provider settings (`server/core/oidc-providers.js`)
| | Google | LinkedIn |
|---|---|---|
| Protocol | OpenID Connect code flow, confidential web client | same |
| Scopes | `openid email` (`profile` not asked, Q30) | `openid profile email` (required together) |
| PKCE | S256, together with the client secret; a mismatch fails | sent (S256); required (mismatch fails) if WP0's wrong-verifier test is refused, else the T23 residual and Q32 |
| `nonce` | required | sent; required when returned (WP0) |
| `iss` on the callback | checked | not sent |
| Prompt | `select_account`; fresh-login attempts `prompt=login`, `max_age=0`, `auth_time` checked; no `access_type=offline`, so no refresh token | default; fresh-login only with a forced-login parameter and `auth_time` confirmed in WP0, else not offered on a fresh-login attempt |
| `trustEmailVerified` | true, only for Google's consumer mail domain or a matching `hd` claim; other domains use our code | false (always our e-mail code) |
| `sub` | the same for every app | pairwise (per app) |
| Tokens kept | none | none (its 60-day access token is dropped at once) |
| At account deletion | nothing to revoke; the user removes the grant in their Google Account | nothing to revoke; the user removes the app in LinkedIn's settings |
| Development | test-user list while the consent screen is in testing mode (grants expire after 7 days); a development client | no test-user list; a development client or app |

---

## 5. Client

### 5.1 Files
| File | Contents | ≈ LOC |
|---|---|---|
| `prism-build/66-account.js` | `WTS_account`: guard, `configure`, API client (one `call()` with headers, error mapping, `retryAfter`, outage rule), session state machine, sign-in dialog (with "Didn't get the code?"), consent step, step-up helper, passkey ceremonies (Phase 3), header chip and menu, toolbar items, Ctrl+S, status bar, analytics reload after sign-in, **provider sign-in** (`GET /auth/providers` on dialog open, Google / LinkedIn buttons as inline official assets, start → `location.assign`, the `#acct-oauth` return and the finish steps incl. link-confirm and cancel-deletion codes, return-route restore, the shared-browser flag and the blocking provider sign-out step) | 1,500 |
| `prism-build/67-cloud-sync.js` | `WTS_cloudSync`: `wts-sync` store, ownership record, snapshot (normalised, per well), canonical hash with a per-part hash cache, gzip, chunked upload, commit (inline core), pull, apply, key-level merge (Phase 2, from `server/core/merge.js`), safety / pre-account snapshots, conflicts, migration and hand-over, bulk import, library document, wipe, encrypted public outbox, historian backup (Phase 3) | 1,400 |
| `prism-build/68-account-page.js` | Registry page `account` (`navHidden:true`, group Overview): profile and security, projects (list, history, trash), devices, **sign-in methods** (e-mail, recovery, Google, LinkedIn, passkeys; link / unlink), sync options, storage, data (export, delete), activity, **account help** (the web-only guide and FAQ, kept here so it is stripped with the page) | 1,000 |

Every file:
```js
// ── ACCT:START — web only; sync-from-main.js strips this block ──
(function () {
  'use strict';
  var G = (typeof window !== 'undefined') ? window : globalThis;
  var L = G.location || {};
  var DEV = G.WTS_ACCOUNT_DEV === 1 && /^https?:$/.test(L.protocol || '')
    && /^(localhost|127\.0\.0\.1)$/.test(L.hostname || '');
  var ELIGIBLE = (L.protocol === 'https:' && L.hostname === 'welltest.h2oil.co.uk' || DEV)
    && !nativeShell(G)   // true when the iOS wrapper's native bridge object reports isNativePlatform()
    && (function () { try { return G.top === G; } catch (e) { return false; } })();
  if (!ELIGIBLE) { if (!G.WTS_account) G.WTS_account = { eligible: false }; return; }
  // … module body …
})();
// ── ACCT:END ──
// === SELF-TEST ===
(function () { /* pure checks only; stripped by concat */ })();
```
The markers sit **outside** the self-test tail so `stripSelfTest` keeps them; a concat test asserts both markers survive in
`combined-round10.js` and in the built HTML. `window.isIOSApp` is not used for the guard (it is set after the modules load).

### 5.2 Client API

```js
WTS_account = {
  eligible: true, VERSION: '1.0.0',
  configure(o),                 // {fetch, now, base:'/api/v1', idb, crypto, gzip, gunzip, locks, minDelayMs} — test seams
  state(),                      // {status:'signedOut'|'signingIn'|'signedIn'|'unavailable', user, publicDevice, device, needsConsent, opts}
  refresh(),                    // Promise<state>: GET /me
  openSignIn(opts), signOut({everywhere, clearLocal}), stepUp(),
  changeEmail(), setRecovery(email), addPasskey(name), removePasskey(id), renamePasskey(id, name),
  providers(),                  // Promise<{google, linkedin}>: 'on' | 'signin' | 'off' (GET /auth/providers; no cache across opens)
  signInWith(provider, {publicDevice}),  // 'google' | 'linkedin': flush, hint, start, location.assign
  finishProviderSignIn(),       // on a load with #acct-oauth: POST finish and drive the next steps in the dialog
  methods(), linkProvider(provider), unlinkMethod(id),  // account page; link and unlink run a step-up first
  call(method, path, body, opts),// Promise<{status, json|bytes}>; errors → WTS_account.Error {code, status, retryAfter}
  on(evt, fn), off(evt, fn)     // 'state' | 'error' — plain listener list, no wrapping
};
WTS_cloudSync = {
  status(),                     // {state:'off'|'idle'|'dirty'|'syncing'|'offline'|'unavailable'|'conflict'|'quota'|'paused'|'readonly'|'signedOut',
                                //  projectId, name, baseRev, lastSyncAt, pending:n, error}
  link(projectId), unlink(),
  saveToCloud({as, name}),      // Promise<{rev}>
  openFromCloud(projectId),     // guard → safety snapshot → download → load (source 'cloud')
  importFiles(fileList),        // each .h2oilproj → its own cloud project (reason 'import')
  syncNow(),                    // pull then push (Phase 2 runs it from triggers)
  listProjects({trash}), history(projectId), restoreRevision(projectId, rev),
  conflicts(), resolve(id, choice), diff(projectId),  // 'cloud' | 'both'; diff = changed wells / pages / keys
  snapshot(),                   // Promise<{core, vhash, parts}> — also used by tests
  migrateLocal(choice), wipeDevice({historian}),
  historianBackup(), historianRestore(id, {mode}), exportAll()
};
```
Events on `document` (plain data): `wts:account-changed {status}`, `wts:sync-status {state,…}`,
`wts:sync-applied {projectId, rev, wells, keys}`, `wts:sync-conflict {projectId, copyId?}`.

### 5.3 Storage keys and stores (client)
| Name | Where | Contents | In project files? |
|---|---|---|---|
| `wts-sync` | IndexedDB (device) | `device {deviceId (server-issued), lastUserId, workOwner: userId\|'unowned'\|null, workOwnerAt, signedOutAfterOwner:bool}`; `binding {userId, projectId, baseRev, boundAt, activeWell}`; `base` (last-synced core, `vhash` and part hashes per well: the merge base); `outbox {fmt, pushId, userId, entry}` (plain on a trusted device, AES-GCM with the server outbox key on a public one); `safety[]` (last 2 payloads); `preAccount` (pinned, never rotated); `stash {userId: payload}` (work kept local at a hand-over); `recent[]` (≤ 3 cached cloud projects, ≤ 50 MB, Phase 2); `conflicts[]`; `retry {nextRetryAt, step}`; `lastPullAt`; `migratedFor:[userId]`; `hashCache {part: {gen, hash}}` | no |
| `wtsacct_hint` | localStorage | `{signedIn, initial, public, absExpires, lastSeenAt, oauth?:{provider, route, at}, v:3}` — paints the chip, drives the analytics guard (also skipped while `oauth` is under 10 minutes old), the provider return and the public expiry wipe; no token, no e-mail | no |
| `wtspref_cloud_beta` | localStorage | `1` after `?cloud=1` (shows the chip during the invite beta; the server enforces who may sign up) | no |
| `wtspref_cloud_open` | localStorage | "Open as a new cloud project" without asking (*Don't ask again*) | no |
| `wtspref_shared_browser` | localStorage | `1` once any public-computer session has been used in this browser; **kept by the wipe** (it identifies no one); every later provider attempt from this browser is a fresh-login attempt (T30) | no |
| `__Host-wts_sid` | cookie | session (HttpOnly, Strict) | — |
| `__Host-wts_oa` | cookie | provider sign-in attempt: Lax, 10 min to the callback; re-issued Strict, 20 min, for a code step (HttpOnly; §4.13) | — |
| `PREF_RE` | 29-project-save.js:151 | adds `^wts_acct_|^wts_sync_` | — |

Outbox format: `fmt` is a version number; each release reads the outbox of at least the two previous formats (`acct-sync`
fixture written by N−1 and N−2).

### 5.4 Host and shared-file edits (neutral; they stay in the iOS bundle and do nothing there)
| # | File | Edit | Phase |
|---|---|---|---|
| H1 | host `__lsSet` / `WTS_lsSet` (l.945-957) | dispatch `document` `wts:ls-write {key}` after a successful write; new `WTS_lsRemove(key)` dispatches `{key, removed:true}` | 1 |
| H2 | every direct `setItem` / `removeItem` on a `wts_` / `h2oil_` key outside H1 and `storage.write` | move onto `WTS_lsSet` / `WTS_lsRemove` (fallback to raw calls when absent, for the smoke stub). Known so far: 01, 04, 07, 10, 12, 16, 19 (`wts_prism_rec_*` l.282/333/408), 22 (`_lsSet` for `wts_base_conditions` l.1929, legacy-list canonicalisation l.1701), 27 (l.910), 29-multiwell (l.303 and `_rawSet`), 33, 35, 36, 37, 39, 47, 49-calc-buildup-store (l.414), 51, 54, 61, 63, host clientinfo / logo / clear, `wts_report_snapshots`, `wts_report_templates`. The list is **enforced by `acct-lswrite-scan.test.js`**, which scans `prism-build/[0-9][0-9]-*.js` and the host and fails on any raw call not in its allow-list. **31/32/38 are allow-listed** (simulator workstream): `wts_sim_rigup` is caught by the key-hash check (D9) | 1 |
| H3 | 29-project-save `loadFromObject(obj, opts)` | `opts.source` into the `wts:project-loaded` detail; `opts.keep:[module names]` leaves those local modules untouched; returns `{…, ready: Promise}` (all module writes); the `prism_gauges` module (19) and the build-up store `_modWrite` return promises; the build-up `_onProjectLoaded` and the gauge module honour `keep` | 1 |
| H4 | 29-project-save | `WTS_project.applyChanges({set:{key:raw}, remove:[keys], modules:{prism?, prism_dataset?, pvt?}}, {source})`: cancel the pending autosave for the affected page only, write with `WTS_lsSet` / `WTS_lsRemove`, refuse `LIBRARY_RE` and device-pref keys, write listed modules, `_prismSync` only if PRiSM / PVT / dataset changed, fire **`wts:project-changed {source, keys}`** (new; listeners added in 22-units for base conditions and in the host for the open page), `WTS_rerender({discardPending:false})`. Returns `{applied, skipped}` | 2 |
| H5 | 29-project-save toolbar (l.1162-1165) | `WTS_project.registerToolbarItems([{id, label, run, when?}])` rendered after Save As (the `☁ ▾` button is registered by 66; header checked at 390 px) | 1 |
| H6 | 29-project-save `PREF_RE` (l.151) | `|^wts_acct_|^wts_sync_` | 1 |
| H7 | host plug-in registry | `navHidden:true`: route and title, no sidebar button, no home tile; `calc-registry.test.js` case | 1 |
| H8 | host `.page-actions` (~l.810) | `<!-- ACCT:START --><div id="wts_account_host"></div><!-- ACCT:END -->` as the first child | 1 |
| H9 | host sidebar footer (l.803) | `<!-- ACCT:START --><div id="sbAccountLine"></div><!-- ACCT:END -->`; the privacy link text becomes "Privacy — how your data is stored" | 1 |
| H10 | skip tables | host `PAGE_AUTOSAVE_SKIP` (l.1028), `_REPORT_SKIP` (l.3240), `__UI_NOT_TILE` (l.1535); **`NO_COPY` in `prism-build/29-multiwell.js:510`** (Round 6 rebuild) | 1 |
| H11 | host `renderPrivacy` (l.11620-11670) | web / iOS branches (§8.6). **The web-only cards (accounts, providers) and the web banner sit between `// ── ACCT:START` / `// ── ACCT:END ──` markers inside the function**, so they exist only in the web build and the iOS branch is today's text; the neutral branch switch stays outside the markers | 1 |
| H12 | host RELEASE_NOTES array and renderer | web-only **items** (inside an entry) sit between ACCT markers, one item per line, so the iOS build never carries their text; the entry itself is never wrapped, so `RELEASE_NOTES[0].ver` (the version label and the app store stamp in `ci_post_clone.sh`) is the same on iOS, and every entry keeps at least one neutral item. The field `platform:'web'`, hidden when `window.isIOSApp`, stays as a second layer | 1 |
| H13 | 29-multiwell | `WTS_wells.captureWell(id)` (the `_capture` output for any well, the active one from live storage), `applyRemote(id, blob, {source})` (parked: rewrite the blob; active: the switch path's load half with source `'well'` and `origin:'cloud'`), `importWell(blob, meta)` (keep-both copy) | 1 (capture) / 2 |
| H14 | 29-project-save | `WTS_project.registerGuard(fn)`: New, Open and Open-from-file call `fn({action})` **before** changing anything; it returns `Promise<'proceed'\|'cancel'>` and may push or snapshot first. With no guard registered the behaviour is exactly today's | 1 |
| H15 | host autosave | `WTS_pageAutosave.flushIfDirty()` (writes only when a page has unsaved control changes; no `t` rewrite otherwise) | 1 |
| H16 | 07 `PRiSM_loadXLSX` (l.395; built l.25062) | load the spreadsheet library through the hash-pinned loader pattern of 47 (fetch → SHA-384 → blob URL), pinned version and hash; `acct-thirdparty.test.js` asserts every external script load in the built HTML goes through a pinned loader, the analytics tag being the only exception | 1 |
| H17 | host head GA block (inside `GA:START/END`, so stripped on iOS) | skip loading the analytics tag when `wtsacct_hint.signedIn` is true or `wtsacct_hint.oauth` is under 10 minutes old (a provider return); expose `window.__wtsGaLoaded` so 66 can reload once after sign-in | 1 |
| H18 | any file the sink audit flags | escape fixes from the storage-to-HTML sink audit (§8.7) | 1 |

Edits on the CRLF host file use node scripts or the Edit tool, never `sed -i` (CLAUDE.md). H2 and H18 touch many files; each moved
site gets one `acct-host` assertion that `wts:ls-write` fires.

### 5.5 Module wiring
- **Mount**: 66 mounts the chip into `#wts_account_host` like the project toolbar (`data-mounted`, on DOMContentLoaded or a
  one-shot `setTimeout(0)`), registers its toolbar items (H5) and guard (H14), and calls `refresh()` only when
  `wtsacct_hint.signedIn` (a signed-out first visit makes **no** network request). A load whose URL fragment is `#acct-oauth`
  **and** whose hint holds a fresh `oauth` entry removes the fragment (`history.replaceState`), opens the dialog at its finish
  step and calls `finishProviderSignIn()`; the fragment without that hint entry is ignored (no request). Opening the sign-in
  dialog (a user action) calls `providers()` before the buttons are drawn.
- **Public expiry check at load** (no timer): when the hint says `public` and `now > absExpires` or `now > lastSeenAt + 12 h`,
  run the expiry wipe before anything paints (§10.8); a `/me` 401 on a public device does the same.
- **First sync after restore**: the first `sync()` runs only after DOMContentLoaded and, where they apply, the first
  `prism:dataset-loaded` of the restore commit and a resolved `WTS_buildup.store.init()` — so neither a fast-forward nor a
  snapshot races `PRiSM_restoreState` / `PRiSM_restorePersistedCrop` or reads cold mirrors.
- **Listeners** are attached only while signed in **and** linked, and removed on sign-out / unlink.
- **Beta gate**: without `wtspref_cloud_beta` the chip is not mounted and nothing is registered (Phase 1 beta only).

---

## 6. Sync algorithm

Phase 1 uses §6.1 (snapshot), §6.3 PUSH for *Save to cloud*, §6.4 for *Open from cloud*, and the Phase 1 rule of §6.6. Phase 2
adds the triggers, automatic pulls, the merge and the full conflict path.

### 6.1 Snapshot (`WTS_cloudSync.snapshot()`)
1. Warm the mirrors: `await WTS_buildup.store.init()` and the gauge store init.
2. Set `_snapshotting = true` (every `wts:ls-write` / `wts:autosaved` raised until step 9 is ignored).
   `WTS_pageAutosave.flushIfDirty()` (H15); `PRiSM_saveState()` **only** if a `prism:*` event marked the PRiSM bundle dirty.
3. `payload = WTS_project._buildPayload(meta)` (meta from `h2oil_client_info`).
4. **Strip what does not sync**: the `units` module (and any `system` field of `wts`) — the unit system is a device pref; every
   `LIBRARY_RE` key (they live in the library document); `wts_modbus_config` unless `opts.liveCfg`; any key `isProjectKey` now
   rejects. `skipped[]` is kept as information.
5. **Normalise per well**: for every well in `wts_wells` (active included) build `captureWell(id)` (H13); the active well's keys
   and modules leave the top level. The core keeps the well list `{id, name, created}` only — `active` goes to
   `binding.activeWell`. Job keys (`wts_report_templates`, `wts_base_conditions`, `wts_base_auto`) stay in the core.
6. **Lift parts**: each well → part `well/<id>`; its `prism_gauges`, `buildup_raw`, `buildup_analysis` and any key over 64 kB
   (logo, paste text, snapshots) → `well/<id>/<name>`; the parent keeps `{"$part":"<name>","hash":"…"}` placeholders.
7. **Canonical JSON** (sorted keys, no whitespace, numbers as `JSON.stringify` writes them) → SHA-256 = `hash` (integrity of the
   stored body). A part whose owning store's change generation is unchanged reuses `hashCache` (an 18 MB gauge mirror is not
   re-hashed per edit).
8. **Normalised view** → SHA-256 = `vhash`: the same JSON without payload `savedAt` / `generator`, `wts_page_*.t`,
   `wts_prism_state.savedAt`, well blob `savedAt` / `modified`, and without the **derived** keys `wts_report_snapshots` and
   `wts_mw_results` (still carried in the body).
9. `_snapshotting = false`. **Dirty** = core `vhash` ≠ `base.vhash` or any part `vhash` differs. Unchanged → nothing to push.

`assemble(core, parts)` replaces the placeholders, re-inserts the library keys from the library document and the active well at
the top level (the device's active well, else the first), and yields an ordinary `.h2oilproj` v1.0 payload that v3.4 opens.

### 6.2 Triggers (Phase 2)
| Trigger | Action |
|---|---|
| a change event (D9) while linked and not `_snapshotting` / `_applying` | mark dirty; (re)arm the single **20 s** quiet `setTimeout`; if **2 min** have passed since the first dirty mark, push on this event |
| quiet timer fires | `sync()` |
| `☁` Save to cloud, Ctrl+S while linked, Sync now | `sync()` at once (`reason:'save'`) |
| capture-phase `pointerdown` / `keydown` on `#pgBody` while linked and `now − lastPullAt > 60 s` | `sync()` (pull) at once; edits continue locally, and no push starts before that pull settles |
| `visibilitychange→hidden` | build the outbox entry (async work is allowed here), then send it with `fetch(commit, {keepalive:true})` when it is core-only and the inline core ≤ 48 kB gzip |
| `pagehide` | send the **ready** outbox entry with keepalive (no hashing or gzip here); none ready → stay dirty, the next load pushes |
| `visibilitychange→visible`, `focus`, `online` | if `now − lastPullAt > 30 s`: `sync()` |
| load, signed in and linked | `sync()` once the restore has settled (§5.5) |
| `wts:project-loaded` with `origin:'cloud'` or `source:'cloud'` | ignored (echo guard) |
| `wts:project-loaded` with `source:'well'` | a well switch: update `binding.activeWell`; the changed parts are pushed as usual; never a prompt |
| New / Open / Open from file | the H14 guard asks first (§6.8) |
| window `storage` event for `wts_*` from another tab | mark this tab stale; next `sync()` re-snapshots |

After a failed push: `nextRetryAt = now + [30 s, 2 min, 10 min, 30 min][step]`; `sync()` is skipped until then. **No timer is
armed for retries.** Signed out or unlinked: no listener, no timer, no fetch. At most one timer is ever pending.

### 6.3 `sync()` — one run, under a lock
```
sync():
  navigator.locks.request('wts-sync', {ifAvailable:true}) → not granted: return (another tab is syncing)
  (fallback without locks: lease key 'wtsacct_lease' {tab, until:now+20 s}; tests drive both through the locks seam)
  if offline or signedOut or unlinked or outbox owned by another user: status, return
  1. PULL  head = GET /projects/:id/head;  lastPullAt = now
     head.vhash == base.vhash            → PUSH
     head moved, local clean             → fastForward(head); return
     head moved, local dirty             → merge(head) (§6.5); return
  2. PUSH  snap = snapshot(); if not dirty: return
     core-only change → one commit with core.inline
     else missing = POST /blobs/has [part hashes]; PUT missing chunks; commit
       200 → base = snap; outbox cleared; devices.last_base_rev updated server-side; status 'idle'
       409 → merge(r.head)
       422 → upload r.missing, commit again once with the same pushId
       413 → status 'quota'; 429 / 5xx / network → nextRetryAt; status 'dirty' / 'unavailable' / 'offline'
       401 → keep the outbox (§6.9)
```
The `pushId` is created once per outbox entry, so a retry after a timeout returns the stored receipt.

### 6.4 Fast-forward and apply
1. Download the core (inline when small) and every part whose hash is not already local; verify every SHA-256; decompress with
   the size cap; **check the type and shape of every module** against the project registry before apply (unexpected types are
   refused and reported, never applied).
2. Set `_applying = true`. Per well, compare the remote part with the local one:
   - a **parked** well changed → `WTS_wells.applyRemote(id, blob)` (rewrite the parked blob; no load);
   - the **active** well changed in keys only → `applyChanges` with those keys (and the `prism` / `pvt` modules when PRiSM keys
     changed) → `wts:project-changed`;
   - the active well changed in a module or a sub-part → safety snapshot, then `applyRemote` on the active well (switch path
     load, `origin:'cloud'`, `keep` for any part the remote marks `skipped`), `await res.ready`;
   - wells added / removed / renamed → the well list (a well deleted remotely but edited locally is kept);
   - core job keys → `applyChanges`.
3. If a changed key is the `wts_page_<route>` of the open page and the focused element's id is one of the changed fields, defer
   that page's apply until the element's `blur` (one `{once:true}` listener; no timer).
4. After every write promise resolves: `_applying = false`, `base = remote` (re-baselined), toast "Updated from <device> at
   14:20".

### 6.5 Key-level merge (Phase 2, WP-C2)
`merge(head)`: base = the core and part hashes stored on the device (`wts-sync.base`) — **no server revision is needed**, so a
pruned base never blocks a merge. Remote = head. Local = a fresh snapshot.
- Per well and for the core: each storage key changed on one side only → take it; same value both sides → take it; deleted on one
  side and unchanged on the other → delete; changed on both sides differently → **overlap**.
- The PRiSM bundle (`wts_prism`, `wts_prism_state`, `wts_prism_*` keys, the `prism` / `prism_dataset` modules) is atomic: changed
  on both sides → overlap. Parts by hash: changed on one side → take it; both → overlap. Derived keys: newer `at` wins, never an
  overlap.
- No overlap → apply the remote side's changes (§6.4) and push the merged result with `baseRev = head.rev` (E3).
- Overlap → §6.6.

`merge` lives in `server/core/merge.js`, concatenated into 67 at build time by `concat-round10.js` (generated like 64, never
edited in place) and used by the fake server tests.

### 6.6 Conflicts
**Phase 1 (manual Save to cloud hits 409).** *"The cloud copy changed on <device> at <time>. [Overwrite cloud with this version]
[Save as a new project] [Cancel]"*. Overwrite commits `reason:'overwrite'`, `baseRev = head.rev`; the replaced revision stays
in history.

**Phase 2 (overlap in an automatic sync).**
1. Safety snapshot of the local payload.
2. Upload the local snapshot as a **new project** "<name> (conflict — <device label> <dd Mon hh:mm>)", `is_conflict_of = id`,
   `reason:'conflict'` (shared blobs: only changed parts upload). **This device is linked to the copy; the local version stays
   on screen; the cloud head is unchanged.**
3. Bar: *"The cloud has a newer version of '<name>' from <device> at <time>. [Show differences] [Use cloud] [Keep both]"*.
   *Show differences* lists the wells, pages and keys that differ (from the diff of step 2 of §6.4). *Use cloud* links back to the
   original and fast-forwards (safety snapshot first; the copy stays in the list, with an offer to move it to the trash).
   *Keep both* closes the bar; the copy is a normal project.
4. An explicit Save to cloud on an overlap offers the Phase 1 choices.

### 6.7 Field-level merge (Phase 3, WP-M, S)
Extends `merge.js` with per-kind rules; everything not listed stays at key level.

| Item | Rule |
|---|---|
| `wts_page_<route>` `{v,t,f,tabs,x}` | per field id in `f`; `tabs` / `x` follow local; `t` = max; a field changed differently → clash of that field |
| `h2oil_client_info` | per field; `clientLogo` atomic |
| `wts_prism_pvt` | per field with its `provenance` entry; `user` / `correlation` beats `default` / `sample` without a clash |
| `wts_report_templates` | per template id; `defaultId` follows local |
| `wts_buildup_audit` (hash chain) | one chain a prefix of the other → the longer; else clash (never spliced) |
| PRiSM bundle | atomic; *Keep both* saves the local fit as a PRiSM workspace branch (51) |
| well list | union by id; rename → later `modified` wins; delete vs edit → keep the well |
| library document | union per entry; same name, different value → keep both ("<name> (other device)") |

A clash is resolved per item: *Keep mine / Keep cloud / Keep both* (for a page or part: a copied well "<well> (this device,
hh:mm)" via `importWell`). Unclashed items apply at once.

### 6.8 Project lifecycle while signed in (through the H14 guard)
| Local action | Behaviour |
|---|---|
| New | Phase 2: unpushed changes are pushed first (or kept in the outbox when offline). *"Start a new cloud project, or a local-only one?"* → create + link, or unlink. The linked cloud project is never changed by New |
| Open file | default **Open as a new cloud project** (one click; *Don't ask again* sets `wtspref_cloud_open`); also *Local only* and *Replace the linked project's contents* (`reason:'save'`) |
| Import files to cloud | several `.h2oilproj` files → one cloud project each (`reason:'import'`), progress list; nothing local changes |
| Switch well | a part change (§6.2), never a prompt |
| Open from cloud while dirty | push first; offline: *"Save this project to a file first"* or keep it in the outbox; never discard silently. A project in `recent[]` opens offline |
| Sign out | §10.8 |

### 6.9 Offline, expiry and upgrades
- **401** (session expired, revoked or signed out elsewhere): the outbox, base and binding are **kept**, owned by
  `binding.userId`. After a sign-in by the **same** user, `sync()` runs at once with the stored base (merge rules apply). After a
  sign-in by a **different** user, the outbox is never pushed: the bar offers *Download the waiting changes as .h2oilproj* and the
  hand-over rules of §10 apply.
- **426** or a new app version: the outbox has a format version; the new release reads it (two formats back) and pushes after the
  reload. The server accepts any client of the last 90 days (§3.2).
- **Trusted device offline for a rotation**: 35 days idle covers 28 days away; past it, the 401 rule keeps everything.
- **Public device**: §10.8.

### 6.10 Worked examples
**E1 — fast-forward (Phase 2).** A and B are linked to P at rev 41. A edits the Hydrate page; 20 s after the last key press A
pushes one commit with the core inline (12 kB gzip) → rev 42. B gets focus 10 min later: head moved, B is clean → the active
well's part differs in one key `wts_page_hydrate` → `applyChanges` → `wts:project-changed`; Hydrate re-renders; toast.

**E2 — 28 days offline.** B is on a rig. Edits ESD Hi pilot and the PRiSM fit; pushes fail → `nextRetryAt`; chip "○ 2 changes
waiting". Day 28, the link returns: the session (35 d idle) is still valid; `online` → `sync()` → head still 42 → push → rev 43.
Had the session expired, the outbox would have survived the 401 and been pushed after B signed in again.

**E3 — different pages (Phase 2).** A (base 42) edits Liquid Line offline; B edits Pipe Service Life and pushes rev 43. A comes
online: head moved, A is dirty → merge: `wts_page_pipelife` changed only remotely, `wts_page_liquidline` only locally → A applies
B's key, pushes the merged core with `baseRev 43` → rev 44. No copy, no bar.

**E4 — overlap (Phase 2).** Both changed `wts_page_hydrate` (A: `hy_T` 38 °F, B: 41 °F). Key-level overlap → A uploads its
version as "P (conflict — Laptop 07 Nov 14:02)", links to it and keeps 38 °F on screen; the bar offers *Show differences*
(Hydrate page, one field) / *Use cloud* / *Keep both*. In Phase 3 only that field clashes.

**E5 — PRiSM overlap.** A refit the build-up, B changed the model on the same well → the bundle is atomic → overlap (Phase 2: E4
path; Phase 3: *Keep both* saves A's fit as a workspace branch under B's state).

**E6 — gauge import.** A imports a 9 MB gauge file into well w1 (gzip 3.1 MB). Snapshot: part `well/w1/prism_gauges` is new →
one 3.1 MB chunk PUT, then a commit with the core inline. The next ten edits push cores only; the gauge hash comes from the cache.

**E7 — timeout and retry.** A's commit for rev 45 lands but the response is lost. The next trigger resends the same outbox entry
and `pushId` → the stored receipt `{rev:45}`; no rev 46, no false conflict.

**E8 — two tabs.** T1 and T2 share localStorage and `wts-sync`. T1 gets the lock and pushes rev 46; T2's lock fails; on its next
trigger T2 pulls, sees head 46 = the shared base, and its `vhash` equals the base → nothing to push.

**E9 — two devices on two wells.** A works on well w1, B on well w2 of the same project. A's commit changes part `well/w1` only;
B's pull applies it with `applyRemote('w1')` to B's **parked** copy (no load, B stays on w2); B's push changes `well/w2` only and
merges with A's commit without an overlap. Neither device is moved to the other's well.

**E10 — snapshot stability.** With no edit, two snapshots give the same `vhash` (savedAt, `t` and derived keys are outside it), no
commit is sent and no timer is armed by the snapshot's own writes.

---

## 7. Inventory: what syncs and what stays on the device

| Store / key pattern | Owner | Typical → max | Class | Cloud |
|---|---|---|---|---|
| `wts_page_<route>` | host autosave | 0.2–5 kB per page | well work | well part (`t` outside `vhash`) |
| legacy `wts_<key>` lists (esdhi*, esdlo*, hydrate*, ll_*, pl_*, pipelife, fluid_*, prv_*, flare, oilgas …) | host, 27 | < 5 kB | well work | well part |
| `h2oil_client_info` (incl. `clientLogo` data URL) | host | 1 kB; logo 0.1–1 MB | well work, sensitive | well part; sub-part when > 64 kB |
| `wts_report_snapshots` | host Quick Report | 5–50 kB | **derived** | carried, never makes the project dirty |
| `wts_prism` (paste text) | 01, 07, 33 | 1 kB → MBs (> 2 MB skipped by the project layer) | well work | well part / sub-part |
| `wts_prism_state`, `wts_prism_pvt`, `wts_prism_mrate`, `_crop`, `_rta`, `_dca`, `_units`, `_report_notes`, `_skincheck` | 33, 16, 37, 51, 12, 35, 07, 36, 54 | 5–100 kB | well work | well part (PRiSM bundle; `savedAt` outside `vhash`) |
| module states `prism` (schema 2), `prism_dataset`, `pvt` | 29-project-save | 10 kB–MBs | well work | well part / sub-part |
| `wts_prism_rec_*` | 19 | MBs | well work | well part / sub-part |
| IndexedDB `wts_prism` gauges (≤ 18 MB mirror) | 19 | MBs | well work | **sub-part `well/<id>/prism_gauges`** |
| `wts_buildup_state` (≤ 300 kB), `wts_buildup_audit` (≤ 200 kB, chain-hashed) | 49-calc-buildup-store | 10 kB per test | well work, sign-off names | well part |
| IndexedDB `wts_buildup` raw / tests (≤ 16 MB) | 49-calc-buildup-store | MBs | well work | **sub-parts `buildup_raw`, `buildup_analysis`** (never pruned by a sync: `wts:project-changed` / `keep`) |
| `wts_sim_rigup` | 38 | < 1 kB | work | well part (detected by the key-hash check) |
| `wts_historian_settings`, `wts_historian_view`, `wts_wellos_ui` | 47, 63 | < 1 kB | settings | core |
| `wts_mw_results` | 29-multiwell | < 5 kB | **derived** | carried, never makes the project dirty |
| `wts_wells` list | 29-multiwell | small | work | core: `{id, name, created}`; **`active` is device-local** |
| `wts_well_<id>` parked wells | 29-multiwell | tens of kB → MBs | work | part `well/<id>` (same shape as the active well's capture) |
| `wts_report_templates`, `wts_base_conditions`, `wts_base_auto` | host, 22 | < 20 kB | job work | core |
| in-memory modules `wts`, `esdhi`, `esdlo`, `hydrate`, `liquidline`, `pipelife`, `clientinfo` | 29-project-save | small | derived | well part (kept: the payload is the only consistent copy) |
| module `units` (`{system}`) | 29-project-save | tiny | **device pref** | **stripped; never applied** |
| `wts_prism_user_curves`, `wts_prism_presets`, `wts_prism_mapping_<sig>` | 10, 04, 07 | 1–100 kB | user library | **library document only** (stripped from the core; re-inserted in `assemble`) |
| `wts_modbus_config` | 61 | 1–30 kB | config, sensitive | **opt-in** (`opts.liveCfg`, Phase 3), stripped otherwise |
| historian (OPFS / sql snapshot / IndexedDB) | 47 | up to hundreds of MB | live data, device-wide | **opt-in manual backup** (Phase 3) |
| `wts_unit_system`, `wts_ui_*`, `wts_prism_sample_suppress`, `wts_prism_migrated` | 22, host | < 1 kB | device prefs | never |
| `wtspref_*`, `h2viz3d_prefs`, `wtshist_home`, `wtshist_spool`, sessionStorage `wts3d_*` | 50, help, 38, 47 | < 5 kB | device prefs | never |
| IndexedDB `h2oil-wts3d`, service-worker caches | 32, sw.js | app code | cache | never |
| `wts_buildup_audit_corrupt_<ms>` | buildup store | ≤ 200 kB | forensic | never |
| `wts-sync`, `wtsacct_hint`, `wtspref_cloud_*`, the session cookie | 66–67 | small | sync state | never |

**Size guard**: a project's compressed total over **64 MB** is refused with a list of the largest parts and the choice to keep
gauges and build-up raw data local; those sub-parts are then marked `skipped` in the core, and every apply passes them in `keep`
so the local copies are never removed. The project layer's 2 MB per-key skip still applies.

---

## 8. Security, privacy and UK GDPR

### 8.1 Threat model
| # | Threat | Likelihood / impact | Mitigation | Residual |
|---|---|---|---|---|
| T1 | Session theft through XSS (no strict CSP today) | medium / high | HttpOnly `__Host-` cookie, SameSite=Strict; no token in script, storage or memory; escaping audit (§8.7) | an injected script can act as the user while the page is open → T2 |
| T2 | Script on the page abuses a live session | low / high | blob reads 100 MB/h and 300 MB/day per user and per session, anomaly notice and audit; step-up for delete, purge, passkeys, e-mail and recovery changes, sign out everywhere, and for the faster export rate; 7-day deletion grace; revert of e-mail changes; security notices | **a script on the page can read what the read limit allows (about 100 MB an hour) and can run any non-step-up action**; the CSP does not prevent exfiltration (§8.2). During a step-up window it could also start a provider link, but the link needs a link-confirm code from the account's mailbox (§4.12 rule 2), so it cannot attach the attacker's own provider account silently |
| T3 | CSRF and same-site siblings | low / high | SameSite=Strict, exact Origin (missing refused), `X-WTS-Req`, JSON content type, GET never mutates, `frame-ancestors 'none'`. Other `h2oil.co.uk` subdomains count as **same-site**: they can send cookie-bearing GETs but cannot read the responses (no CORS) and cannot pass the Origin check; they can set parent-domain cookies, so the server reads only the `__Host-` names | a sibling subdomain taken over could make GETs that change nothing |
| T4 | Account enumeration | high / low | uniform 202 through the queued send and a fixed floor (also for throttled, paused and invite-refused addresses); e-mail change replies the same for taken addresses; empty `allowCredentials` at sign-in; generic verify errors | — |
| T5 | Code guessing / mail bombing | medium / medium | 10⁸ space, 5 tries per code, ≤ 2 live codes, per-address limits, soft per-IP limits, site-wide breaker | — |
| T6 | Lockout used against a user | medium / medium | no hard account lock; only the code channel is throttled; passkeys, linked providers and the recovery address keep working | — |
| T7 | Cross-tenant access through a bug | low / high | forced RLS, named definer functions, `wts_jobs` separate, server-built blob keys, `(user_id, device_id)` keys, same 404 for absent and foreign | — |
| T8 | Database / bucket / backup leak | low / high | envelope encryption of bodies and `meta`; e-mail stored only as an HMAC index plus an encrypted display form; hashes for codes and session ids; master key only in host secrets | sizes and times; addresses need the index pepper and the master key |
| T9 | Blob swap, replay or overwrite | low / medium | AES-GCM AAD; client SHA-256 check; blobs immutable once complete; decompression size cap | — |
| T10 | Deploy-preview copies of production data | medium / high | previews get no production database or secrets; the API refuses any non-production host | — |
| T11 | Malicious or broken deploy of our code | low / critical | server deploys only from `server-v*` tags with an owner-signed checklist, independent review, published SHA-384 of the account block, kill switches | a web app trusts the code it is served |
| T12 | iOS bundle ships account code | low / medium | four layers incl. `www/help` (§9) | — |
| T13 | Stolen unlocked device | medium / high | public mode, sign out everywhere, device revoke | the local copy is plaintext, as today |
| T14 | Decompression bomb / oversized body | medium / low | size caps before parse; the server never gunzips; client stream cap | — |
| T15 | Data loss by sync | medium / high | CAS, pushId, pull-before-push and pull-before-edit, key merge, conflict copies, safety and pre-account snapshots, outbox kept on 401 / 426, history, trash | — |
| T16 | **Third-party script supply chain** (analytics tag, CDN libraries) | low / critical | every external script hash-pinned (H16, test); analytics not loaded while signed in (H17, Q18) | the analytics tag while signed out (no session to abuse) |
| T17 | **Stored script injection that spreads by sync** (a malicious string in a synced value reaches an HTML sink on every device) | medium / high | the sink audit and fixes (§8.7); a fuzz acceptance test; type and shape checks on apply | a sink missed by the audit; covered by the fuzz test per route |
| T18 | **Takeover persistence** (a short-lived session holder changes the e-mail, adds a passkey or links their own provider account) | low / high | step-up from `stepup_at` (never a provider sign-in); e-mail change confirmed at the new address, notice and 7-day revert at the old; the revert removes passkeys, recovery addresses **and provider identities** added since the change, with their sessions; a link needs a link-confirm code; notices for every security change; sign out everywhere can remove recent passkeys and provider links; unlink revokes the link's sessions; security reset in the runbook | 7 days after an unnoticed change |
| T19 | **Device hand-over** (one user's client data uploaded into another's account) | medium / high | device ownership record, no default upload of foreign or unowned work, explicit confirmation naming client and wells (§10) | — |
| T20 | **Publish leak** (`server/`, `docs/`, fixtures or keys served as static files) | medium / high | publish allow-list, CI check of the published set, `.env*` ignored, secret scan, fixtures generate fake keys at test time (§13.2) | — |
| T21 | **Login CSRF through a provider** (an attacker feeds the victim a callback URL with the attacker's code, so the victim works inside the attacker's account) | medium / high | `state` bound to the victim's own `__Host-wts_oa` attempt; a callback without the matching cookie fails; the session is issued only by the page's own `finish` | — |
| T22 | **Takeover by e-mail linking** (an attacker makes a provider account with the victim's address, unverified or pre-registered, and signs in) | medium / critical | identities keyed by (provider, subject) only; never linked on an e-mail match; an existing account is linked only after an e-mail code to its address; LinkedIn's verified flag never trusted; link notices | — |
| T23 | **Authorization-code interception, replay or injection** (callback URL in history, a malicious extension, a proxy or platform access log, a referrer, a shoulder-surfed URL; an attacker pastes a leaked code into their own attempt) | low / high | attempt marked used before the exchange; redeemable only with our client secret; **PKCE required wherever the provider enforces it** (Google; LinkedIn if WP0's wrong-verifier test is refused) and the nonce checked; `Referrer-Policy: no-referrer` on the callback; codes never logged; WP0 checks whether the host's platform access logs record the callback query string and for how long, and turns query logging off for that path where the host allows it | Google: —. **LinkedIn, if WP0 finds neither PKCE nor nonce enforced: a LinkedIn code leaked before we redeem it can be injected into the attacker's attempt and sign them in as the victim**; LinkedIn then ships only on the owner's decision (Q32) |
| T24 | **id_token forgery or substitution** (`alg:none`, HS256 with the public key, wrong audience, another app's token, an old token) | low / critical | RS256 only, key by `kid` from the provider's JWKS, exact `iss`, `aud` / `azp`, `exp` / `iat` with 60 s skew, ≤ 10 min age, `nonce`; a fake-provider test for each (§12.4) | — |
| T25 | **Provider mix-up** (a response meant for one provider presented at the other) | low / high | one callback path per provider; the attempt records its provider; callback `iss` checked where sent; issuers and keys per provider | — |
| T26 | **Open redirect after sign-in** | medium / medium | the callback redirects only to one constant URL; the route to return to is held by the page and checked against the route table | — |
| T27 | **Client secret leak** | low / high | secrets only in the functions' environment, never in the bundle, logs, previews or the repository (publish check and secret scan know their names, §13.2); rotation (§13.3); a secret alone cannot sign anyone in without that user's own sign-in at the provider | — |
| T28 | **Provider account compromise** | medium / medium | the provider is one way in, not the account: a provider session has **no step-up** (`stepup_at` NULL), so it cannot change the e-mail, add methods, sign out everywhere, export fast or delete; link notices; unlink revokes its sessions; *Sign out everywhere* also removes recent links; a link needs a link-confirm code; per-provider kill switch; `sessions.auth_method` / `identity_id` let an incident revoke one method's sessions | a compromised provider account can read and edit the linked user's projects (within the read limits) until it is unlinked; it cannot lock the owner out |
| T29 | **Provider script in the page** | — | none is loaded (D20); the buttons are inline assets; no popup or iframe | — |
| T30 | **Provider session left on a shared browser** (user A signs in with Google or LinkedIn on a rig or office PC and signs out of our app only; the next person presses the button and lands in A's account — Google lists A in its account picker, LinkedIn may return with no interaction) | medium / high | a public-computer session marks the browser shared (`wtspref_shared_browser`, kept by the wipe); every later provider attempt from that browser, and every attempt with the public tick, asks for a fresh provider login (Google `prompt=login`, `max_age=0`, `auth_time` checked; LinkedIn hidden on such attempts unless WP0 confirms a forced login); public sign-out after a provider sign-in shows a **blocking** step "Sign out of Google / LinkedIn too" with a link to the provider's sign-out page (address in `oidc-providers.js`) and an "I have signed out" confirmation | **until the user signs out at the provider, on a browser never used with the public tick**, the next person can use A's provider session |

### 8.2 Headers and CSP (host headers config)
Report-Only first (WP-OPS, reports to `/api/v1/csp-report`), enforced at the end of Phase 1:
```
default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: <analytics loader host> <the CDN hosts>;
worker-src 'self' blob:; connect-src 'self' <CDN hosts> <analytics hosts> ws://127.0.0.1:* ws://localhost:*
http://localhost:* http://127.0.0.1:*; img-src 'self' data: blob: <analytics hosts>; style-src 'self' 'unsafe-inline';
font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```
(The exact host list is in the owner's vendor notes. The localhost entries keep the Modbus bridge working.) **Provider sign-in
needs no CSP change**: the page talks only to `/api/v1` (`connect-src 'self'`), the buttons are inline images, and the jump to
the provider is a top-level navigation by `location.assign`, which the CSP does not govern; `form-action 'self'` stays, which is
why `start` is a fetch and not a form (§4.10). **This CSP limits
only casual exfiltration**: `'unsafe-inline'` and `'unsafe-eval'` remain, analytics collection endpoints accept arbitrary
parameters, and top-level navigation is not governed by CSP. Neither the privacy text nor the release notes may imply that
script injection is contained. The planned fix is the **hardening track** — remove the six direct `eval` uses, `new Function`
and the 103 inline handlers, then a nonce-based `script-src` with no analytics hosts in `connect-src` — targeted for **v4.1**
(Q23). Also `Referrer-Policy: same-origin`, `Permissions-Policy: publickey-credentials-get=(self),
publickey-credentials-create=(self)`, `Cache-Control: no-cache` on the page and `sw.js`, and HSTS confirmed at
`max-age=31536000` (with `includeSubDomains` once every `h2oil.co.uk` subdomain is HTTPS, checked in WP0).

### 8.3 Rate limits (database counters, fixed windows, no timers)
| Action | Limit |
|---|---|
| code start | 5/h and 20/day per address; per IP prefix **300/h soft** (responses padded, owner alerted, never refused); site-wide 1,000/h → sending pauses for unknown addresses, owner alerted |
| code verify | 5 tries per code; 10 failures per address per 24 h → codes for that address paused 1 h (notice mail) |
| passkey verify | 30/min per IP prefix (soft above 10) |
| provider start | 60/h per IP prefix **soft** (delayed); **hard ceiling 20 live attempts per IP prefix** (`503 provider_off`, alert); one live attempt per browser |
| provider callback | **hard: 30 callbacks per IP prefix per 10 min that reach the token endpoint**; beyond it the attempt fails with `provider` and our server sends nothing to the provider (so our client cannot be rate-limited by the provider through us) |
| provider finish | 10 failed finishes per IP prefix per 10 min → soft delay; `oauth_verify` and `link_confirm` codes count in the code start / verify limits of their address |
| provider breaker | counts **provider-side failures only** — token endpoint 5xx, timeouts, TLS errors and signing-key fetch failures, never a 4xx or `invalid_grant` (which a junk code produces) — and opens only with **at least 20 exchanges** in the window and > 50 % of them failing over 10 min → that provider answers `503 provider_off` for 10 min (checked on the next request, no timer); owner alerted. Server test: 100 junk-code callbacks from one prefix never open the breaker |
| commit | 120/h and 600/day per user; 60/h per session; a burst (> 10 in 10 min) pins the previous revision and sends one notice per day |
| chunk PUT | 2 GB/day per user |
| blob GET | **100 MB/h and 300 MB/day per user; 100 MB/h per session**; 300 MB/h for 2 h in one session after an export step-up. A session that reads > 10 distinct projects or > 50 % of the account's used bytes in a day → security notice + audit row |
| export | 5/day |

A rig on one satellite address or an office behind one proxy shares the per-IP buckets; they only slow down, and the per-address
limits do the real work (§15).

### 8.4 Roles, lawful basis and requests
- **Roles**: for individual users H2Oil is the controller. When an engineer stores their employer's or a client's data for a
  business, H2Oil acts as a **processor** for that business: a standard data processing agreement is offered on request
  (software@h2oil.co.uk) and the controller / processor split is recorded (Q21). Processors: the static host (functions,
  database, blob store) and the e-mail service, each with a DPA and a contractual breach-notice time; a record of processing; a
  DPIA (commercially confidential well data, client and engineer contact data); data-protection fee registration checked. Data
  stays in the UK or the EU (UK adequacy); any transfer outside needs the UK transfer addendum.
- **Identity providers**: Google and LinkedIn are **independent controllers** of their own sign-in, not our processors. Per
  provider sign-in we receive the provider's identifier for the user and the e-mail claims (LinkedIn also sends name,
  profile-picture link and locale, which we drop at once) and keep only the identifier and the e-mail at link time. The record
  of processing, the DPIA and the privacy notice list both; the lawful basis is **contract** (the user chooses the method to
  use the account service). The provider learns that the user signed in to the Well Testing Suite.
- **Lawful basis**: contract (the account service under the Terms of Use); **legitimate interests** (security, fraud and abuse
  prevention) for the audit log, IP prefixes, new-device and security notices and rate limits, with a balancing note in the DPIA;
  explicit opt-in for historian backups and live-data settings. No marketing mail. No use of project data for analytics,
  advertising or model training.
- **Consent record**: `terms_version`, `privacy_version`, `consented_at`; a version bump asks again at the next sign-in.
- **Data subject requests** are handled through the signed-in account page (export, delete, correct the e-mail). A request by
  e-mail is acted on only after an e-mail code check against the account address (an ops script).
- **Analytics**: the tag is not loaded while signed in (Q18); no account events are sent at all.

### 8.5 Export, deletion and retention
- **Export everything** (step-up) = a zip built in the browser with the 65 zip writer: one `.h2oilproj` per cloud project
  (assembled), `library.json`, `account.json` (profile, consents, devices, passkey names and dates, linked providers with masked e-mail and dates, own
  audit rows). The writer is
  store-only with no ZIP64 and builds in memory, so **above 200 MB in total the export is offered as one download per project**
  (plus the account file).
- **Deletion**: step-up → status `deleting`, every session revoked, everything hidden at once, a confirmation mail with a cancel
  code; signing in during the 7 days offers *Cancel deletion*; after 7 days (or at once with *Delete immediately* and a second
  step-up) the daily job purges rows and blobs and stamps the **deletion ledger**. Audit rows are kept 12 months with `user_id`
  replaced by a random tombstone. Backups age out within 30 days of the purge; after any database restore the ledger is replayed
  (§13.5). Local data on devices is not touched; the dialog offers "Also clear this browser" (the wipe of §10.8). Linked Google / LinkedIn identities are **removed
  in the deletion-request transaction** (audit rows keep their identity id and subject index), so the provider can be linked to
  another account during the 7 days — the "two accounts" support case (§13.7) — and a provider sign-in can never cancel the
  deletion: a sign-in during the grace period reaches the account only through an e-mail code (§4.12), which offers *Cancel
  deletion*; a cancelled deletion does not bring the links back (the user links again; the cancel mail says so). We hold no
  provider token, so nothing is revoked at the provider — the deletion mail tells the user where to remove the app's access in
  their Google Account and in LinkedIn's settings.

| Data | Kept |
|---|---|
| account | while active; warning mails at 23 and 23.5 months without sign-in, deletion (with the 7-day grace) at 24 months |
| revisions | named saves 30 days; automatic: 10-minute points for 24 h, one per day for 30 days; those behind conflict copies and device bases |
| trash | 30 days |
| codes, challenges, sent mail | 24 h |
| provider sign-in attempts | 24 h (the outcome readable for 5 min after the callback, up to 30 min from the start while a code step is live) |
| linked identities (provider, subject, e-mail at link time) | while linked; removed on unlink, revert, sign out everywhere with recent links, or at the deletion request |
| sessions | until expiry |
| rate counters | 7 days |
| push receipts | 24 h |
| audit | 12 months (chain heads in the weekly export) |
| deletion ledger | 12 months after the purge (ids and dates only) |
| historian backups | until replaced or deleted by the user |
| backups | platform ≤ 30 days; our weekly export **28 days** |

### 8.6 Privacy page text (`renderPrivacy`, web branch; the iOS branch keeps today's text unchanged)
Banner (web): **"Your well data stays on this device unless you sign in to the cloud."**

New card *"Accounts and cloud projects (web version, optional)"*:
> You can use the Well Testing Suite without an account: everything then stays in this browser on this device, as before.
> If you create an account, the projects you save to the cloud — page inputs, PRiSM analyses, wells, build-up surveillance
> data, report snapshots and templates, your curve and preset library, and, only if you turn them on, historian backups and
> live-data connection settings — are stored in our cloud database in the UK / EU, encrypted at rest with a key for your
> account. We store your e-mail address (and a recovery address if you add one), the public keys of any passkeys you add (never
> a password), the identifier and the e-mail address that Google or LinkedIn gave when you linked it (if you use them), the
> devices you sign in on and a security log (shortened IP address, browser type) for 12 months, which we keep
> to protect your account. We do not load the analytics tag while you are signed in. We never use your project data for
> analytics, advertising or training, and we do not share it. You can export everything or delete your account at any time from
> Account; a deletion can be cancelled for 7 days, then removes your data from our live systems, and from backups within 30 days
> after that. Data on your devices stays until you clear it. If you store data for your employer or a client, a data processing
> agreement is available. The iOS app has no accounts and keeps everything on your device.
> Questions and data requests: software@h2oil.co.uk.

New card *"Signing in with Google or LinkedIn (web version, optional)"*:
> If you choose *Sign in with Google*, Google sends us an identifier for your Google account, your e-mail address and whether
> Google has verified it; we ask for nothing else. If you choose *Sign in with LinkedIn*, LinkedIn sends us an identifier, your
> name, profile-photo link, language setting, e-mail address and whether it is verified; we keep only the identifier and the
> e-mail address and discard the rest at once. We use them only to sign you in: we never post, read your contacts or keep
> access to your Google or LinkedIn account (we store no access token). Google or LinkedIn learns that you signed in to the
> Well Testing Suite, under its own privacy policy. You can unlink either under Account → Sign-in methods; your e-mail address
> always still works. Deleting your account removes these links; to remove the app from your Google or LinkedIn account too,
> use that account's security or data-privacy settings. On a shared computer, also sign out of Google or LinkedIn in the
> browser when you finish.

Both cards and the web banner are **web-only text inside ACCT markers** in `renderPrivacy` (H11), so neither the account
wording nor the provider names reach `ios-app/www`. Also updated, with **neutral** wording that is true on both platforms and
names no provider and no account: `48-calc-help-start.js:16` ("Nothing is sent to a server…" → "Nothing is sent to a server
unless you choose to send it."), the `privacy` help guide (re-review, new `reviewedSrc` via `--hash privacy`; it points to the
Privacy page and contains neither "Sign in", "account" wording nor a provider name, because it is printed into
`user-guide.html` and copied to `www/help`). Any web-only sentence in the host "Where your data is" text (~l.104102) goes inside
ACCT markers. Also `privacy-analytics.test.js:297` and the `sw.js` header comment. Terms of Use are a new owner document linked
from the consent step.
**Legal texts (2026-11-09, drafts for review by a qualified lawyer, not legal advice):** `privacy.html` (Privacy notice
version 1) and `terms.html` (Terms of Use version 1) at the repository root, static (no script, no external request), published
by the `publish-site.js` allow-list at `https://welltest.h2oil.co.uk/privacy.html` and `/terms.html` (the URLs for the Google
consent screen, the LinkedIn app form and the iOS store listing). The operator is a company licensed in Dubai (UAE); its name,
licence, licensing authority and address are placeholders. The consent ticks of 66 link both pages; the in-app Privacy page and
the Release Notes meta line link them (the iOS app uses the absolute web URLs; `sync-from-main.js` does not copy them).
**Versions:** the server's `WTS_TERMS_VERSION` and `WTS_PRIVACY_VERSION` stay at their default `1`, matching the pages. When a
page's version changes, set the matching variable to the same value in the same release (users are then asked to accept again at
sign-in); a new Privacy notice version also bumps `VER` of the analytics consent (`WTS_consent.version`, head GA block of
`well-testing-app.html`), so the banner asks again.
**Analytics consent (web only, 2026-11-09):** the analytics tag loads only after Accept in the consent banner (GA block at the
`<body>` right before the main script, stripped from iOS; the skip link stays first in `<body>` and the main script must stay
last before `</body>`, the iOS bridge anchor); the choice is the device preference `wtspref_analytics_consent` `{choice, v, at}` (never
synced — 67 skips `wtspref_*`; never in project files — 29 `PREF_RE`), re-asked after 12 months or a new `v`; H17 still applies
(no tag and no banner while signed in). Privacy → Cookie settings reopens the banner. No analytics event is queued before Accept
(the head gtag wrapper drops events while `__wtsGaLoaded` is not true, and Accept removes any queued event), so nothing from
before the choice is sent. **Ship the banner and the two pages as their own web release now, not with v4.0** (review 2026-11-09:
the tag loading for every visitor without consent breaks the ePrivacy rules for EU visitors; if that release cannot go out, remove
the analytics tag from the live site until it can). **Terms of Use notice (web and iOS):** `#wtsTermsNote` above the page header,
shown until OK per terms version (`wtspref_terms_seen` {v, at}, device preference; `TERMS_NOTE_V` = `WTS_TERMS_VERSION`); the
sidebar footer has static Privacy notice / Terms of Use links (brand verification needs them on the home page; `sync-from-main.js`
points every relative privacy / terms link at the web address in the iOS bundle); PDF / PNG / job reports carry
`REPORT_DISCLAIMER` (aids to judgement, competent person, the terms address).

### 8.7 Storage-to-HTML sink audit (WP-H, M)
Sync applies content on other devices with no Open by the user, so a value that reaches `innerHTML` / `insertAdjacentHTML`
unescaped would run on every device after every pull. WP-H lists every such sink fed from localStorage, project modules or
server strings (page autosave values, client info, report templates, PRiSM notes, well names, device labels, project names),
checks `_rEsc` / `_safeImgSrc` on each and fixes the misses (H18). `acct-fuzz.test.js` loads a project whose every string
field is `<img src=x onerror=…>` (and a `javascript:` logo URL), opens every route, and asserts nothing runs; then fast-forwards
it from the fake server into a second app and asserts the same.

---

## 9. iOS exclusion (four layers)

1. **Text strip** in `ios-app/scripts/sync-from-main.js`, after the GA (step 0) and SW (step 0b) strips:
   - step 0c (JS): `/\/\/ ── ACCT:START[\s\S]*?\/\/ ── ACCT:END ──/g` → `// (accounts and cloud sync: web only — stripped from the iOS bundle)`;
   - step 0d (HTML): `/<!--\s*ACCT:START[\s\S]*?ACCT:END\s*-->/g` → `<!-- account control: web only -->`;
   - the sync **fails** if the start / end marker counts differ, or if `WTS_account`, `WTS_cloudSync`, `/api/v1`,
     `wts_account_host`, `wtsacct_`, `/auth/oauth`, `wts_oa`, "Continue with Google", "Sign in with Google",
     "Sign in with LinkedIn" or **"LinkedIn" anywhere** remain in `www/index.html`, or if "Google" appears there other than in
     the one analytics sentence of today's privacy text (a pinned baseline of exactly one occurrence, checked in WP-H), **or**
     if `www/help/**` contains an account chapter, an `account` shot folder, "Google", "LinkedIn", or the strings "Sign in" /
     `wts_account_host` in `user-guide.html`.
   - A static test asserts that those identifiers appear **only between ACCT markers** in the built HTML (the GA block's
     `wtsacct_hint` read is inside `GA:START/END`, also stripped), so neutral code (a11y rules, CSS, help text) cannot break the
     iOS sync. Chip and bar CSS is injected by 66, not added to host CSS. **Recorded exception (integration review):**
     `ios-app/ios-additions/ios-styles.css` section 11 keeps neutral `html.ios-app .acct-*` safe-area rules for the account
     overlays, bar, menus and toast. They never match in the app (the client is stripped and inert there); they exist because
     CLAUDE.md asks every fixed overlay for its safe-area rule, and they name no account identifier (`acct-ios` IO8 / IO10).
2. **Runtime guard** (§5.1): exact host over https, or DEV over http(s) on localhost only (never `capacitor:` or `file:`); no
   native bridge; not framed.
3. **Server**: refuses every Origin other than `https://welltest.h2oil.co.uk`.
4. **Neutral host edits** (H1–H7, H10, H13–H16, H18) exist in the iOS bundle but nothing registers against them. The privacy
   page and the release notes are split: their **web-only text** (the account and provider cards, the web banner, web-only
   release-note items) sits inside ACCT markers and is stripped (H11, H12); only the neutral branch switch on `window.isIOSApp`
   stays in both builds.

**Help.** The account guide and FAQ live on the account page (68), not in `WTS_helpContent`, so `help-content.test.js` and the
printed guide never see an `account` route. `help-shots.js` hides `#wts_account_host` and `#sbAccountLine` with an injected style
in every shot, so the screenshots copied to `ios-app/www/help` show no account control. `server/` is never copied by
`sync-from-main.js` and `ios-sync.yml` does not watch it. Tests: §12.2 `acct-ios`.

**Provider sign-in** is excluded like the rest: the buttons, their inline assets and the finish handler are inside the ACCT
blocks; the redirect URIs and `APP_URL` name the production web host only, so a provider can never return into the app shell.
Third-party sign-in in the iOS app would also bring the app store's rules for apps that offer it — one more reason the app
stays account-free (D1).

---

## 10. Migration of local data and device hand-over

1. **Ownership record** (`wts-sync.device`): `lastUserId` (the last user signed in on this browser, kept through a trusted
   sign-out) and `workOwner` — set to the user when the working set is created, opened from the cloud or linked while signed in;
   set to `'unowned'` on a device that has never had a signed-in user; marked `signedOutAfterOwner` when work is edited after a
   sign-out.
2. **When**: after a successful sign-in by any method (e-mail code, Google, LinkedIn, passkey), if `migratedFor` lacks the user id or the working set is not linked.
3. **Classify**:
   - *empty* (no project key, no wells) → offer to open the most recently saved cloud project;
   - *own work* (`workOwner` = this user) → Phase 1/2 flow below;
   - *unowned* and `lastUserId` null (pre-account work on a personal device) → the flow below;
   - **foreign** (`workOwner` = another user) or **unknown** (`'unowned'` with a `lastUserId`, or edited after another user's
     sign-out) → *"This browser holds work from another account."* **[Start empty (keep it local)] [Sign out]**. *Start empty*
     moves the working set into `stash[workOwner]` (restored when that user signs in again) and starts an empty project. Upload is
     only behind *More…* with a confirmation that lists the client and well names: *"Upload 'Operator Energy Ltd — Example-1,
     Example-2' into name@company.example's account?"* (`acct-migrate` cases).
4. **Own or unowned work, account empty** → *"Put the work on this device into your account?"* with a preview: name, wells,
   pages with inputs, PRiSM analyses, build-up tests, compressed size. Default **Upload as a new cloud project**
   (`reason:'migrate'`, progress, resumable through the outbox). The **pinned pre-account snapshot** is taken first. Libraries go
   to the account library (union).
5. **Account has projects** → *Upload as a new project* (default) / *Open a cloud project instead* (the local work is first
   uploaded as a project with `reason:'migrate'` when online and within quota, and always kept in the pinned pre-account
   snapshot) / *Not now* (signed in, unlinked; chip "This device's project isn't in the cloud").
6. **Many local files** → *Import files to cloud…* (§6.8).
7. **Over the size cap** → the preview lists the large parts and offers to upload without gauges / build-up raw data (`keep`).
8. **Sign out** — trusted device: *"Keep a copy of the open project in this browser?"* default *Keep*.
   **Public device**: the wipe, guarded:
   - if the outbox is not empty or the state is not `idle`, the wipe is **blocked**: *[Try to upload now] [Download .h2oilproj]
     [Keep the waiting changes locked for 7 days]*. The last choice stores only the outbox, encrypted with the per-user server
     outbox key (`GET /me/outbox-key`, never stored on the device), so only the same user can unlock and push it after signing in
     again; everything else is wiped;
   - **`WTS_cloudSync.wipeDevice()`** deletes the whole `wts-sync` store (except a locked outbox), every project key and parked
     well, the gauge and build-up IndexedDB stores, report snapshots, `wtsacct_hint`, and the historian (ticked by default on a
     public device). It keeps only the non-identifying `wtspref_shared_browser` flag (T30). It runs on public sign-out, on load
     when the hint says public and the session has passed its expiry, and on a public device's `401 signed_out` — a load-time
     check, no timer. On a public device the outbox is always encrypted, so an expiry
     wipe never has to choose between privacy and work.
   - The pre-account snapshot and stashes are wiped too on a public device; the account page lists them on a trusted device with
     *Restore* / *Discard*.

---

## 11. UI

### 11.1 Header chip (`#wts_account_host`, first in `.page-actions`) and toolbar
| State | Desktop | Phone (390 px) |
|---|---|---|
| signed out | button "Sign in" | icon button (44 × 44 px, `aria-label="Sign in"`) |
| synced | initial + "● Synced 14:02" | initial with a green dot |
| changed since cloud save (Phase 1) / waiting (Phase 2) | "○ Not saved to cloud" / "○ 3 changes waiting" | amber dot |
| syncing | "⟳ Syncing" | spinner dot (CSS animation only while syncing) |
| offline | "○ Offline — saved on this device" | grey dot |
| cloud unavailable | "○ Cloud unavailable — saved on this device" | grey dot |
| conflict | "⚠ Newer version in the cloud" | red dot |
| over quota | "⚠ Storage full" | red dot |
| paused / read-only | "Cloud sync paused" / "Cloud read-only" | grey dot |
| unlinked | initial + "Not in cloud" | initial, hollow dot |

Chip menu: masked e-mail (with "via Google" / "via LinkedIn" when this session came from a provider, from `/me`
`session.authMethod`) · Sync now (Phase 2) · Save to cloud · Open from cloud… · Account & projects · Sign out · Sign out
everywhere. Status text is `aria-live="polite"`; 66 labels its own controls (no a11y-file reference). The project toolbar gets the
`☁ ▾` button (Save to cloud / Save to cloud as… / Open from cloud… / Import files to cloud…), checked at 390 px.

### 11.2 Sign-in dialog
`<dialog>` with `role=dialog`, `aria-modal`, focus return, Escape closes; `.rp-skip data-rp-nosnap`. Steps: (1) e-mail
(`autocomplete="username webauthn"`, `inputmode=email`) + "Send code" (+ "Use a passkey" in Phase 3), then an "or" divider and
the two provider buttons (below), then the tick box "This is a public or shared computer" (it applies to every method); (2) code (`autocomplete="one-time-code"`, `inputmode=numeric`, 8 digits, paste-friendly) + "Send again"
(enabled from the server's reply, no countdown timer) + **"Didn't get the code?"**: check spam / quarantine, allow-list
no-reply@h2oil.co.uk, codes last 15 minutes and the previous one still works, "Send the code to my recovery address"; (3) consent
for a new account; (4) Phase 3: "Add a passkey"; (5) migration / hand-over (§10); (6) if the analytics tag ran in this page: "Finishing
sign-in…" and one reload after the autosave flush. Offline or outage: "Sign-in needs a connection. Your work keeps saving on this
device." At 390 px a full-width sheet with 16 px gutters; controls ≥ 16 px.

**Provider buttons.** *Sign in with Google* and *Sign in with LinkedIn* — the same verb on both, if both official asset sets
offer it (checked in WP0; otherwise the nearest matching pair of approved labels) — stacked, the full width of the dialog, the
**same size** and weight (Google's rules want its button at least as prominent as any other third-party button; the e-mail field
stays first because it is the root method). Drawn only for a provider that `GET /auth/providers` reports `on` or `signin`
(`signin`: the button carries "existing accounts only"). Each is the provider's **official button asset, unmodified** (Google:
the full-colour "G" with an approved label; LinkedIn: its "in" mark in its own colour), embedded **inline** as SVG in 66 — the
page loads no outside font, image or script, so the label is part of the asset rather than drawn in a provider font. **One
fixed variant** of each is used, the one that suits the dialog's own background colour (the dialog does not follow the OS colour
setting, and the host barely uses `prefers-color-scheme`); WP-HC checks it against the dialog's computed background, and the
asset file names and versions are recorded in the vendor notes. At least 40 px high (44 px on coarse pointers), 16 px
gutters at 390 px, `aria-label` equal to the visible text, the focus ring outside the asset. The exact assets and the current
rules are checked in WP0 and WP-HC (vendor notes). Pressing one shows "Taking you to Google…" and navigates; the return shows
"Finishing sign-in…", then the same consent, code, hand-over and analytics steps as above.

**Consent step for a provider sign-up** (rules 3 and 5): *"You are creating a new account for x•••@personal.example. Already
have an account with another address? Sign in with it, then add Google under Account → Sign-in methods."* **[Create account]**
**[Cancel]** — Cancel is the second button and leaves nothing behind (no account, no link). This is the main guard against two
accounts by mistake (Q31).

**Public or shared computer.** With the tick, or on a browser marked shared (T30), Google asks for a fresh login and LinkedIn's
button is hidden unless WP0 confirms a forced login; the dialog says: "You will also be signed in to Google / LinkedIn in this
browser — sign out of it too when you finish." At public sign-out after a provider sign-in a **blocking** step follows: "Now sign
out of Google / LinkedIn in this browser" with a link to the provider's sign-out page and **[I have signed out]**; only then does
the dialog close.

Errors use the reasons in plain words: "Sign-in with LinkedIn was cancelled", "That took too long — try again", "Google
sign-in is not available right now — use the e-mail code", "Please sign in to Google again on this shared computer"
(`reauth_stale`), "The beta is invite-only. Sign in with the address you were invited with, or use the e-mail code."
(`not_invited`), "New accounts are not open right now. Existing accounts can still sign in." (`signup_closed`), "This account is
being deleted. Enter the code we sent to its address to cancel the deletion." (`cancel_deletion`). The buttons are hidden off the
production host (previews) and absent on iOS.

**Friction per method** (mails and steps a user sees):

| Method | First sign-in (new account) | Later sign-ins | Any step-up action |
|---|---|---|---|
| E-mail code | 1 code mail + consent | 1 code mail every time | 1 code (or none within 10 min of a code sign-in) |
| Google, Google-managed address | 0 mails; Google + consent | 0 mails, one click | 1 code mail |
| Google, other address | 1 code mail + consent | 0 mails, one click | 1 code mail |
| LinkedIn | 1 code mail + consent | 0 mails, one click | 1 code mail |
| Existing account adds a provider (U15 / account page) | 1 code mail (link-existing or link-confirm) | 0 mails | 1 code mail |

### 11.3 Account page (route `account`, `#acct_root`, `navHidden`)
Cards (plain `.card` markup; the route is in every skip table):
1. **Profile and security** — masked e-mail, change e-mail (step-up), how this session signed in (method, time), created, Terms / Privacy
   versions, a pending deletion with *Cancel*.
2. **Cloud projects** — `table.dtable`: name, client / well, wells, last saved (device, time), size; Open, Rename, Duplicate,
   History (*Restore*), Download `.h2oilproj`, Move to trash; Import files…; Trash (Restore, Delete forever with step-up);
   conflict copies flagged. Client-side filter box.
3. **Devices** — label, last seen, "this device", public flag; Rename, Sign out device; Sign out everywhere (with "also remove
   passkeys and Google / LinkedIn links added in the last 14 days").
4. **Sign-in methods** — *E-mail code* (always on; the masked primary address; *Change e-mail*); *Recovery address* (add /
   remove); *Google* and *LinkedIn* (linked: the masked provider e-mail at link time, linked date, last used, *Unlink*; not linked:
   the provider's official button for linking, shown only when `GET /auth/providers` says `on`, which runs a step-up, the redirect
   with `purpose:'link'`, and the link-confirm code on return; *Unlink* says how many sessions it will sign out); *Passkeys*
   (Phase 3: name, created, last used; Add, Rename, Remove). A note: "Your e-mail address always works as a way in, even if you
   lose your Google or LinkedIn account." At 390 px each method is one stacked row with full-width buttons.
5. **On this device** — the pre-account snapshot and any stash: *Restore* / *Discard*.
6. **Sync options** (Phase 3) — historian backup (*Back up now*, *Restore…* merge / replace); live-data settings (opt-in).
7. **Storage** — used / quota bar.
8. **Data** — Export everything; Delete account.
9. **Activity** — the user's own audit rows (90 days).
10. **Help** — how cloud projects work, conflicts, public computers, the code-mail FAQ, data requests.

Every server string is shown as text (`_rEsc`). At 390 px tables become stacked rows. Outage: the cards show the outage rule text
and the last successful sync time.

### 11.4 Bars
`#wts_sync_bar`, modelled on `#wts_sw_bar` (fixed bottom, z-index 10040, block layout): conflict, signed out ("Signed out — sign in
to keep syncing [Sign in]", with "n changes waiting" when the outbox is not empty), offline with waiting changes (once per offline
period, dismissible), unavailable, paused, deletion pending. Stripped on iOS; a test asserts the bar does not exist in `www`.

---

## 12. Tests

### 12.1 Fake server and harness use (`prism-build/tests/_acct-fake-server.js`)
The real `server/core` logic plus an in-memory adapter: users, codes (a captured mail outbox the test reads), passkey ceremony
with a key pair generated at test time, sessions and a cookie jar per app, Origin / header checks, devices by `(user, id)`,
projects, revisions (squash, pins), blobs and chunks (immutability), pushId receipts, quotas, rate counters, kill switches, fault
modes (401, 403 reauth, 404, 409, 410, 413, 422, 426, 429, 5xx, network error, lost response, slow mailer). Latency through the
harness manual timers. Use:
```js
loadApp({ globals: { fetch: fake.fetch, location: { href: 'https://welltest.h2oil.co.uk/well-testing-app.html',
  origin: 'https://welltest.h2oil.co.uk', protocol: 'https:', hostname: 'welltest.h2oil.co.uk',
  host: 'welltest.h2oil.co.uk', pathname: '/well-testing-app.html' } } })
WTS_account.configure({ idb: fakeIdb, gzip: nodeZlibGzip, gunzip: nodeZlibGunzip, locks: fakeLocks, minDelayMs: 0 })
```
The harness replaces the whole `location` object, so every field is given. Its Blob is text-only and it has no
`CompressionStream`, `navigator.locks` or IndexedDB, so gzip runs through node zlib, the lock path and the lease path both run
through the fake lock manager, and IndexedDB through the fake (extending `_buildup-idb-fake.js`). **The real `navigator.locks`
branch is tested only through the seam** (and in the GUI sweep). Two apps with separate storage = two devices; two apps sharing
storage = two tabs.

**Fake OpenID provider** (`server/test/fake-oidc.js`, shared by the fake server and the server tests): an RSA key pair generated
at test time, a JWKS document, an authorization step that the harness "visits" by reading the URL given to `location.assign`
and answering with a callback URL, a token endpoint that checks client id, secret, redirect URI, code and PKCE, and fault modes
(wrong `iss`, `aud`, `azp` or `nonce`, `alg:none`, HS256 signed with the public key, unknown `kid`, expired or future token,
stale `iat`, missing / string / false `email_verified`, no e-mail, user cancelled, token endpoint 5xx, slow key fetch). Two
profiles, `google` and `linkedin`, follow §4.15 (pairwise subjects, no callback `iss` and optional nonce for the latter).

### 12.2 New acceptance files (budget = test count / wall time)
| File | Phase | Covers | Budget |
|---|---|---|---|
| `acct-host.test.js` | 1 | `wts:ls-write` from every moved site and `WTS_lsRemove`; `applyChanges` → `wts:project-changed` (build-up `hasRaw` still true, simulator state unchanged); `loadFromObject` source / `keep` / `ready`; `registerToolbarItems`; `registerGuard` (no guard = today's behaviour); `flushIfDirty`; `captureWell`; `navHidden`; `PREF_RE`; RELEASE_NOTES `platform:'web'`; Client Info import guarded; open-page legacy keys; keep rule | 30 / 7 s (measured at WP-H: 34 tests ≈ 11 s — over budget) |
| `acct-lswrite-scan.test.js` | 1 | static scan: no raw `setItem` / `removeItem` on `wts_` / `h2oil_` keys outside the allow-list | 2 / 1 s |
| `acct-thirdparty.test.js` | 1 | every external script load in the built HTML goes through a pinned loader (analytics excepted); the analytics guard skips the tag when the hint says signed in; the bundled iOS spreadsheet copy | 3 / 1 s (measured at WP-H: 4 tests ≈ 5 s with the app loads) |
| `acct-fuzz.test.js` | 1 | §8.7 on every route, then through a fast-forward; shape checks refuse a wrong module type (load and `applyChanges`) | 4 / 8 s (measured at WP-H: ≈ 19 s — over budget; FZ3 drives `applyChanges` directly until WP-C2 replaces it with the real fast-forward through `tests/_acct-fake-server.js`) |
| `acct-signin.test.js` | 1 | code flow, two live codes, consent, invite allow-list, uniform responses (with a slow mailer), generic errors, rate reply, step-up and the 30 s rotation grace, step-up code to the recovery address, sign-out, everywhere (incl. recent provider links removed), e-mail change and revert (**revert removes identities linked since the change and their sessions**), recovery address (refused when it is another account's address), outage rule (5xx and network error on `/me`), only `401 signed_out` → signed-out chip (a `400 invalid_or_expired` changes nothing) | 25 / 7 s |
| `acct-cloud.test.js` | 1 | Save to cloud (inline core), Open from cloud (guard, safety snapshot, refusal when dirty and offline), Phase 1 409 choices, list, rename, trash, history, restore revision, download, import files, export contents (incl. the identities section with full provider e-mail and subject) and split above 200 MB, delete with grace and cancel (identities removed at the request; a provider sign-in during the grace reaches *Cancel deletion* only after a code), escape of names, outage on list / open | 22 / 8 s |
| `acct-migrate.test.js` | 1 | §10: empty, own, unowned, **foreign** (A signs out keeping the copy, B signs in → no default upload, stash, confirmation naming client and wells), size cap, pre-account snapshot pinned after many applies, public sign-out while offline (blocked; locked outbox), **public expiry at load** (after expiry and reload no key, IndexedDB record or store with client data is left; only the encrypted outbox), same user unlocks and pushes | 14 / 6 s |
| `acct-ios.test.js` | 1 | sync into `WTS_SYNC_OUT_DIR`: no ACCT code, identifiers, `/api/v1` or account help in `www` and `www/help`; strip comments present; unbalanced markers fail; identifiers only between markers; no provider strings or assets; **no "LinkedIn" in `www/index.html` or `www/help`, "Google" only at its one pinned baseline (the analytics sentence) and nowhere in `www/help`**; the web privacy cards and web-only release-note items absent while `RELEASE_NOTES[0].ver` is unchanged; `capacitor:` (also with `WTS_ACCOUNT_DEV = 1`), `file:`, framed, other host → `eligible === false`, no DOM, no fetch; iOS privacy text unchanged; web-only release note hidden on iOS | 13 / 8 s |
| `acct-privacy.test.js` | 1 | web / iOS privacy texts, help start text, no account analytics events | 5 / 2 s |
| `acct-oauth.test.js` | 1 | buttons only on the production host (hidden on a preview host, on iOS and in the vm stub; DEV shows them only with the fake provider); `GET /auth/providers` on dialog open (`off` hides, `signin` labels; no request before the dialog opens); same size and verb, inline assets, no external request on render; start → `location.assign` with the fake URL; `#acct-oauth` return with and without the hint (ignored without); analytics guard skipped on the return; finish steps `done` / `email` / `code` / `consent`; consent step names the new address with Cancel second; U15 (code to the matched address); a Google address on an unmanaged domain asks for a code; LinkedIn always asks for a code; a code entered 12 min after the callback still finishes; `identity_in_use`, `provider_linked`, `not_invited`, `signup_closed`, `locked`, `cancel_deletion`; a provider session's first step-up action asks for a code; link needs the link-confirm code; a signed-in public device whose link is cancelled stays signed in, nothing wiped; a pre-existing session for user A finishing as user B → A revoked, hand-over shown; `providerEmailDiffers` once per address; public tick or shared-browser flag → fresh-login attempt, LinkedIn hidden, blocking provider sign-out step; return route restored only for a known route key; *Sign-in methods* card (link and unlink need step-up, unlink reports signed-out sessions, notices); provider e-mails escaped; 390 px layout | 32 / 9 s |
| `acct-sync.test.js` | 2 | snapshot split / assemble round trip (= v3.4 opens it); **E10** (two snapshots, same `vhash`; after one edit and 10 s of manual time no timer pending); units module stripped (a Metric device pulls an Imperial commit and stays Metric with correct values); library keys outside the core hash; derived keys never dirty; debounce (one timer, settles), 2 min cap, pull-before-edit gate (two apps, A pushes, B types without a focus event, B merges with no conflict), triggers, echo guard, `source:'well'` never prompts, keepalive rule, `nextRetryAt`, pushId replay, 422 path, chunking, dedup, hash cache, focus-deferred apply, first sync after restore, outbox kept on 401 and pushed after the same user signs in, never pushed for another user, outbox format N−1 / N−2 read | 34 / 12 s |
| `acct-conflict.test.js` | 2 | E3 (merge), E4 (overlap: local stays on screen, linked to the copy, head unchanged, *Show differences*, *Use cloud*, *Keep both*), E5, E7, E8, E9 (two wells, no overlap, no well switch), pruned server base still merges from the device base | 12 / 6 s |
| `acct-account.test.js` | 3 | passkey add / remove (stub; resident key required, UV), passkey step-up sets `stepupAt`, account page cards, devices, historian backup / restore, `wts_modbus_config` opt-in (export and deletion moved to `acct-cloud`, Phase 1) | 10 / 5 s |
| `acct-merge.test.js` | 3 | field rules of §6.7, audit-chain prefix, PVT provenance, library union | 14 / 4 s |

About **220 tests, under 85 s** (Phase 1: 150; Phase 2: 46; Phase 3: 24). Existing tests that change: `privacy-analytics.test.js` (l.297, strip regex list),
`platform-export.test.js` (ACCT beside SW), `calc-registry.test.js` (`navHidden`), `sidebar-nav.test.js` (count unchanged),
`help-shots` `--check` (chip hidden); `help-content.test.js` does **not** change (no account guide in `WTS_helpContent`).

### 12.3 Smoke test additions (`smoke-test.js`)
1. In the vm stub (http location): `WTS_account.eligible === false`, no `WTS_cloudSync`, no listener added, no timer.
2. With an https production location stub and `fetch` rejecting: loads, `eligible === true`, signed-out state makes **no** fetch
   and leaves **no** timer after 5 s.
3. Signed in and linked (fake fetch), one change event: exactly one pending timer, none after 25 s of idle manual time; a snapshot
   with no edit arms none.
4. `WTS_calcRegistry.account` is well-formed with `navHidden:true`.
5. No provider button is rendered in the vm stub or on a non-production https host; a `#acct-oauth` fragment without the hint
   makes no fetch.
Counts: 339 → 344 smoke checks; 1615 → about 1835 acceptance tests (+220; about 1765 after Phase 1) (CLAUDE.md updated
at each phase's integration).

### 12.4 Server tests (`server/test/`)
Core units (validation, canonical hash, envelope round trip, AAD tamper, dual read by kid, rate windows, revision CAS, squash and
pins, pushId, pruning never dropping a device base, quota, merge); API against the in-memory adapter (every endpoint and error
code, inline core, blob immutability, e-mail change and revert, deletion grace and cancel, ledger replay after a simulated
restore); Origin / header refusal and the csp-report / ops-daily exceptions (replayed nonce refused); spoofed `X-Forwarded-For`
ignored; enumeration timing with a slow mailer; `rls.test.js` (§3.4). Test keys are generated at test time; no key material is
committed. About 110 tests.

**Provider sign-in** (`oidc.test.js`, `oauth-api.test.js`, with `fake-oidc.js`): start (Origin rules; cookie `__Host-`, Lax,
HttpOnly, Secure, Max-Age; one live attempt; `link` needs step-up); callback — missing or foreign cookie, bad `state`, the other
provider's path, expired attempt, **replayed callback and replayed code**, provider `error`, callback `iss` mismatch, token
endpoint failure; id_token — wrong `iss` / `aud` / `azp` / `nonce`, missing nonce (Google refused, LinkedIn per config),
`alg:none`, HS256, unknown `kid` (one refetch, then refused; refetch limit), `exp` past or `iat` future beyond 60 s, `iat` older
than 10 min, every `email_verified` form; linking rules 1–8 incl. U15 (never linked without the code), an unverified e-mail
never links or creates without a code, `identity_in_use`, `provider_linked`, `last_method`, a code bound to its attempt; the
callback never sets `__Host-wts_sid`; the 303 `Location` is the constant whatever the query holds (open-redirect payloads);
breaker and `OAUTH_*` switches; no token, code or claim in the logs; account deletion removes identities; `rls.test.js` gains
`identities`, `oauth_attempts` and `oidc_keys` (definer functions only). Revision 4 adds: **step-up** — a provider sign-in
followed at once by `email/change`, `methods/unlink`, `signout-all`, `account/delete`, `account/export`, `recovery/set` and
`oauth/start {link}` each give `403 reauth`, while an `oauth_verify` code sets `stepup_at`; unlink, revert and signout-all revoke
the identity's sessions; **breaker** — 100 junk-code callbacks from one prefix never open it, the callback exchange limit and
the live-attempt ceiling; a Google token with `email_verified:true`, no `hd` and a third-party domain never creates an account,
with a matching `hd` it does; LinkedIn's wrong-verifier behaviour per the WP0 setting; fresh-login `auth_time`; the attempt
extended to 30 min and refused after; link-confirm code; a sign-in finish revokes the presented session; `locked`, `deleting`,
`not_invited`, `signup_closed`, `paused`; one address per role across accounts; provider `error_description` never stored or
logged; the production pins (a localhost issuer or a non-https key address refuses start-up); `GET /auth/providers`; the
retire-client script. About 25 more tests (≈ 180 in all).

### 12.5 GUI sweep and help
`gui-sweep.js`: `serve()` answers `/api/v1/me` with `401` and other `/api/v1/*` with a minimal fake so the signed-out and sign-in
paths are swept (`/auth/providers` answers both `on`; provider `start` answers with a fake URL that the sweep records as a
navigation and blocks); the destructive regex gains `sign out|log out|delete account|revoke|delete forever`; `account` is added to the
routes (with `WTS_ACCOUNT_DEV = 1`). Help screenshots: re-shot with the chip hidden (§9) in the Linux container, then Round 9,
the user guide and sync (CLAUDE.md 4f).

---

## 13. Operations and cost

### 13.1 Environments
Production (functions UK, database UK/EU, blobs EU, production secrets only here); preview (separate empty database with
synthetic data, no production secrets, sign-in disabled unless a preview flag is set); local (fake server). Restore drills only
into an **isolated scratch database that is destroyed afterwards**, never into production.

### 13.2 Publish allow-list (WP-OPS, M)
The static site publishes an explicit allow-list — `well-testing-app.html`, `sw.js`, `help/**`, the icons and manifest, the
privacy and legal pages — from a publish directory built by `prism-build/publish-site.js`, or through the host configuration's
publish setting; functions are never part of the static output. A CI check fails if the published set contains `server/`,
`docs/`, `tools/`, `prism-build/`, `*.sql`, `.env*`, PEM / JWK keys, or any of the environment-variable names of the master key,
peppers, outbox key, proxy signature, e-mail credential or provider client secrets. `.env*` is added to `.gitignore`; a secret scan runs on `server/` in
CI. WP0 checks what the host publishes today (it may already serve the whole tree).

### 13.3 Secrets
Host environment secrets, never in the repository: master key(s) with key ids, index pepper, code pepper(s), session pepper, the
proxy-signature secret, the ops-job HMAC key, the e-mail sending credential, and the **Google and LinkedIn client secrets**
(client ids are non-secret configuration in the same environment; separate production and development clients). Provider secrets
rotate every 12 months, on any suspected leak and when someone with console access leaves: where the console allows two live
secrets, add the new one, deploy, check sign-ins, then delete the old one; otherwise rotate in an announced few-minute window in
which that provider's sign-in fails and the e-mail code is unaffected. They never reach the browser bundle, logs, previews or the
repository. Peppers and the proxy and ops keys rotate every 12
months with one previous version accepted until the next rotation (codes live 15 min, so nothing is lost). Master-key escrow kept
offline by the owner. The functions site and the jobs credential are separate (D12).

### 13.4 Master-key rotation and compromise (in `RUNBOOK.md`, tested in the quarterly drill)
- **Rotation**: add the new kid → batch job re-wraps every `users.data_key_wrapped` with it (touches only `users`) → check that
  no row remains on the old kid → only then retire the old kid. A kid is never retired while any row uses it.
- **Compromise**: new master key; **new per-user data keys** (`data_key_ver + 1`); re-encrypt blobs in the background (the chunk
  header's `dkv` and `kid` allow dual reads until done); rotate peppers; force sign-out everywhere; incident steps of §13.6.

### 13.5 Backups, deletion ledger and audit anchor
- Platform daily database backups (target 30 days); our own weekly logical export of the database plus a blob manifest,
  encrypted with a separate key, to separate storage in another region, kept **28 days**; blob store copy kept 30 days.
- **Deletion ledger**: each purge also writes an append-only object `ledger/<user_id>` (ids and dates only, no e-mail) to the
  blob store, outside the restorable database set, and the ledger travels in the weekly export. **After any restore** the runbook
  replays the ledger (`server/ops/ledger-replay`) before the API is re-opened, so deleted accounts never come back.
- **Audit anchor**: the daily job writes each user's chain head (and a global Merkle root) to `chain/<date>` in the blob store
  and into the weekly export, so a database-level attacker cannot rewrite the chain unnoticed.

### 13.6 Monitoring, kill switches and incidents
- **Monitoring**: `/api/v1/health` by an external uptime check; alerts by mail to the owner for 5xx > 2 % over 10 min, p95 > 2 s,
  code sends above 300/h, failed verifies > 5 × baseline, 429 spikes, per-IP soft-limit hits, read anomalies, commit bursts,
  storage > 80 % of plan, mail bounce / complaint rates, deletion-job lag, mail outbox age > 5 min, per-provider failed callbacks or code exchanges > 20 % over 30 min,
  signing-key fetch failures, unknown-`kid` refetches, a provider breaker opening, the per-prefix callback or attempt ceiling
  reached, link / unlink spikes (and one `subject_bidx` linked to more than one account), the production provider pins failing
  at start-up. Logs hold request id, user id,
  route, status, latency and an IP prefix — never e-mail addresses, codes, cookies, bodies, provider codes, `state`, tokens or claims.
- **Kill switches**: `ACCOUNTS_SIGNUP=open|invite|off`, `SYNC_MODE=readonly|off`, `ACCOUNTS_OFF`,
  `OAUTH_GOOGLE=on|signin|off`, `OAUTH_LINKEDIN=on|signin|off`.
- **Incident runbook** (`server/RUNBOOK.md`):
  1. **Severity** S1 (data exposure or takeover), S2 (integrity or loss), S3 (outage); detection signals = the alerts above.
  2. **Preserve logs** within 24 h (export the host's function and database logs before they roll over).
  3. **Contain**: kill switch; sign everyone out; for affected users the **security reset** script (`server/ops/security-reset`,
     per user or bulk): revoke sessions, list and remove passkeys, provider links (with every session they created) and recovery
     addresses added in the incident window, revert e-mail changes made in the window (audit rows `passkey_add`, `identity_link`,
     `email_change`, `recovery_set`, `signin` from a new device); a query by `subject_bidx` finds every account one attacker
     identity was linked to, also after unlink;
     rotate peppers and, if exposed, the master key (§13.4). For a provider-side incident or a leaked provider secret:
     `OAUTH_<P>=off`, rotate that secret, revoke the sessions with that `auth_method` created in the window.
  4. **Assess**: what personal data (e-mails need the index pepper and master key; bodies are encrypted).
  5. **Notify**: a decision tree for the ICO (72 h when a risk to people is likely); pre-drafted user and ICO notices; the
     processors' contractual notice times on file; affected business customers under their DPA.
  6. **Post-mortem** in PROJECT-NOTES.md.

### 13.7 Support (in `RUNBOOK.md`)
- **Lost mailbox**: the recovery address first — it receives sign-in **and step-up** codes, so the user changes the primary
  address themselves (also a provider-only user, whose step-up codes would otherwise go to the lost mailbox). Otherwise a one-off audited ops function (`server/ops/recover`, actor
  `support:<id>`) after a documented identity check: control of a new address (a code) **and** two of — a sign-in by a linked Google or LinkedIn identity during the recovery, the account's creation
  month, the names of two projects (checked by the ops function against the encrypted metadata, which returns only match / no
  match), the masked old address's domain confirmed by the employer. A recovery adds the new address with the 7-day revert notice
  to the old one, never silently (Q20).
- **"I didn't get the code"** is expected to be the main ticket: macros for quarantine, allow-listing no-reply@h2oil.co.uk, the
  15-minute validity and the recovery address.
- Other macros: "I can't sign in with Google / LinkedIn" (use the e-mail code; a deleted provider account; link again after
  a code), "I have two accounts" (no merge tool in v4.0, Q31: in the first account export everything, **unlink its Google / LinkedIn
  identity**, then delete it — deletion also releases identities at the request, §8.5 — sign in to the second, import the
  projects with *Import files to cloud…* and link the provider there; revision history, the account library document and
  devices do not travel, and the user is told so), conflict copies, a public-computer locked outbox, storage full, deletion cancel, export of a large account, a DPA
  request.

### 13.8 Releases and deploys
- Static site: auto-deploys from master as today (CLAUDE.md Dev → master rule unchanged).
- Server: the functions-only site deploys only from `server-v*` tags; the owner signs a checklist (tests green, `rls.test.js`
  green, independent review done, migration reviewed, SHA-384 of the account block noted, the provider pins in
  `oidc-providers.js` unchanged or reviewed, `WTS_OIDC_MODE` unset in production); migrations `server/db/migrations/NNN-*.sql`
  run in a manual tagged job, expand-then-contract so the previous server tag keeps working; API versioned `/api/v1`.
- The client code (66–68) ships with the static site, so a merge to master ships it: it is gated by the beta flag and the server
  kill switches, and its review happens before the merge (Q19).

### 13.9 Load and cost model
Assumptions (revised): an **active user commits up to ~250 times a day** (the 20 s / 2 min coalescing allows at most ~30 an hour
while typing, plus saves), ~15 kB per core commit, one large part a week; head pulls ~200 bytes on focus / before edits (~100 a
day); about 30 % of users are active on a working day (22 a month); sensitivity ×2 for 500 commits.

| Users | Stored (compressed, dedup.) | Requests / month | Function compute | Database | Expected running cost (USD / month, order of magnitude) |
|---|---|---|---|---|---|
| 10 | ~50 MB | ~25 k | < 1 GB-h | asleep most of the day | **≈ $10–20**: the host's entry paid tier (free plan ruled out by D17); e-mail within a free allowance |
| 1,000 | ~5 GB | ~2.5 M | ~35 GB-h | awake in working hours (~300 h) | **≈ $35–70**: standard tier plus extra usage; e-mail within a free or entry allowance |
| 10,000 | ~50 GB | ~25 M | ~350 GB-h | always awake, 1–2 compute units | **≈ $180–300**: team-level usage; e-mail entry tier; storage at the platform rate |

Revision rows stay small (squashing caps automatic revisions at ~144 a day per project, pruned to 24 h); the database holds
metadata only (< 1 GB at 10,000 users). Cost levers: inline core (one request per push), head-only checks, `vhash`
short-circuit, coalescing and server squash, gzip, dedup, pulls only on events, the database sleeping when idle, quotas. Set a
spend alert at 80 % of the plan. Per-tier figures are in the owner's vendor notes. Provider sign-in adds no running cost (both providers are free for this use; one
code exchange and an occasional key fetch per sign-in).


### 13.10 Owner's setup checklist for Google and LinkedIn (WP0; console steps and links in the vendor notes)
**First, for both (week 1)**
0. **DNS**: confirm who can add records on `h2oil.co.uk` (domain proof for Google, SPF / DKIM / DMARC for the code mail) and book
   the changes in week 1 — the zone may be held by an outside party.
1. (a) **Interim privacy notice and About view live by week 1–2**: a short privacy notice (what the sign-in methods receive and
   keep, §8.6) and a home / About view on welltest.h2oil.co.uk that describes the app and links that notice (Google's brand
   check does not accept a page that only signs people in). Enough for both consoles and to submit Google's verification.
   (b) **Final privacy notice and Terms of Use** (legal, week ≤ 10) replace it before the invite beta.
2. Use an owner-controlled company login for both consoles and add a second administrator (a lost console login means no secret
   rotation); the developer-contact and support addresses are **monitored mailboxes** (verification mail goes there); record the
   client ids, where the secrets live and the console owners in `RUNBOOK.md`.

**Google**
3. Create the project and the consent screen: external, app name **Well Testing Suite**, support e-mail software@h2oil.co.uk —
   which the console accepts only as a group or account the console owner controls, so set it up that way first (vendor
   notes) — logo, home page, the interim privacy URL (1a) and terms URL, authorised domain `h2oil.co.uk` (ownership proven by
   DNS, step 0), developer contact.
4. Scopes `openid` and `email` only (non-sensitive: no security assessment, only brand verification).
5. A web client with the production redirect URI `https://welltest.h2oil.co.uk/api/v1/auth/oauth/google/callback` (exact, https,
   no wildcard); a separate development client with the localhost URI (local server runs and WP0 only, §4.10 item 6).
6. **Submit brand verification in week 3–4** (allow 1–3 weeks; a critical-path milestone in §14). Testing mode while building
   (at most 100 named test users; their grants expire after 7 days). WP0 confirms whether a published app with only
   non-sensitive scopes signs users in before brand verification completes. **Fallback** if verification is not done by the beta:
   run the 5–10 invited testers in testing mode as named test users (they re-consent weekly), or ship Google dark (Q24).
7. Client ids and secrets into the functions' environment (production and development separately).

**LinkedIn**
8. A company Page for H2Oil with a Page administrator — create the Page first if none exists; Page-admin approval can wait on
   another person, so plan it in week 1. Create the app under that Page: the form asks for the **privacy policy URL (the interim
   notice, 1a) and an app logo at creation**; the Page administrator approves the app's verification request.
9. Add the self-serve product **Sign In with LinkedIn using OpenID Connect**; scopes `openid profile email`.
10. Redirect URL `https://welltest.h2oil.co.uk/api/v1/auth/oauth/linkedin/callback`; check whether a localhost URL is accepted for
    development (else a second, development app).
11. Client id and secret into the environment. **Never delete and re-create the production app**: LinkedIn subjects are per app,
    so a new app breaks every LinkedIn link (§4.14).
12. Read the current API terms (we keep only the subject and the e-mail and delete on request) and the current button rules;
    record both in the vendor notes.

**Then, for both**
13. WP0 live tests with a real account per provider: the LinkedIn issuer value; **LinkedIn with a deliberately wrong
    `code_verifier`** (refused or not) and whether a nonce ever comes back (Q32 if neither); a forced-login parameter and
    `auth_time` for LinkedIn (T30); Google's `hd` claim on a hosted-domain account; the `email_verified` forms; the matching button
    labels; the round trip with the Lax attempt cookie and the Strict re-issue in the three main browser engines; and whether the
    host's platform access logs record the callback query string (turn it off for that path if possible, T23). Results fixed in
    `oidc-providers.js` and the vendor notes.
14. Update the record of processing and the DPIA for the two providers (§8.4).

---

## 14. Delivery: phases, work packages, estimate

Roles: **owner** (decisions, provider accounts, legal texts, server release sign-off), **lead** (integrator: host edits, build,
CLAUDE.md, release), **server**, **client**, **reviewer** (an independent review pass for `server/` and 66–68: a separate review
session from the author's, plus the owner's sign-off; Q19). Branch `accounts` off `Dev`; work packages merge there; `Dev` at each
phase's integration. DFIT branches and `docs/DFIT-PLAN.md` are never touched; the lead agrees release numbers with the DFIT lead.

| WP | Phase | Content | Days (base) |
|---|---|---|---|
| WP0 | 1 | answer §16; leave the free host plan; regions; publish check; HSTS check; rewrite-header check; e-mail sender + SPF / DKIM / DMARC; **Google and LinkedIn apps** (§13.10: consent screen and brand verification, company Page
verification, redirect URIs, development clients, live tests incl. the LinkedIn wrong-verifier, forced-login and access-log checks); DNS access; interim privacy notice and About view (week 1–2); processor DPAs; DPIA; Terms of Use, final privacy notice, business DPA template; spend alert. **Legal items take 6–10 calendar weeks with outside parties and start now** | 5 + owner time |
| WP-H | 1 | H1–H18: ls-write and scan test, `loadFromObject` source / keep / ready, `registerGuard`, `registerToolbarItems`, `flushIfDirty`, `captureWell`, `NO_COPY` in 29-multiwell, privacy branches, pinned spreadsheet loader, analytics guard, sink audit and fixes; `acct-host`, `acct-lswrite-scan`, `acct-thirdparty`, `acct-fuzz` | 8 |
| WP-S1 | 1 | schema, migrations, roles and definer functions, forced RLS and `rls.test.js`; envelope encryption with kid / dkv; code auth (queued mail, two live codes, binding), sessions with rotation grace, devices `(user, id)`, e-mail change and revert, recovery address, invite allow-list; rate limits; audit chain and anchor; projects, revisions (CAS, squash, pins), blobs (immutable), inline-core commit, pushId, quotas; library; export with read-rate unlock; delete with grace, ledger; security notices; health, csp-report, ops-daily; kill switches; `server/test` | 16 |
| WP-O | 1 | provider sign-in: `oidc.js` and `oidc-providers.js` (pinned production configuration and start-up check, authorization URL, PKCE, code exchange, RS256 checks on built-in crypto, signing-key cache and refetch limit, `hd` / `auth_time`), `identities` / `oauth_attempts` / `oidc_keys`, `sessions.auth_method` / `stepup_at` / `identity_id`, definer functions, start / callback / finish (attempt extension, link-confirm, session revocation, status outcomes) / providers / methods / unlink with session revocation, linking rules 1–8, notices, per-prefix ceilings, provider-side breaker and `OAUTH_*` switches, retire-client script; client buttons and assets, `GET /auth/providers`, the return hand-off, finish steps, consent warning, shared-browser flag and blocking provider sign-out, *Sign-in methods* card; `fake-oidc.js`; `acct-oauth`, `oidc.test.js`, `oauth-api.test.js` | 12 |
| WP-C1 | 1 | 66 (guard, API client, outage rule, dialog with FAQ, consent, step-up, chip, toolbar, Ctrl+S, bar, analytics reload), 67 Phase-1 part (snapshot, assemble, push, open, ownership, migration, hand-over, wipe, locked outbox, import files), 68 (profile and security, projects, devices, on this device, storage, data, activity, help), `sync-from-main` strip 0c / 0d and `www/help` check, help-shots chip hiding, fake server; `acct-signin`, `acct-cloud`, `acct-migrate`, `acct-ios`, `acct-privacy` | 9 |
| WP-OPS | 1 | publish allow-list and CI check, secret scan, functions-only site and rewrite, tagged server deploy and migration job, CSP Report-Only → report endpoint, headers, preview isolation, weekly encrypted export, ledger and anchor objects, monitoring and alerts, RUNBOOK (incidents, security reset, rotation, compromise, support), first restore drill, `acct-hash.js` | 5 |
| WP-HC | 1 | privacy page (with the provider card) and help-start texts, `privacy` hash, account help on providers, button assets checked against the providers' current rules, screenshots re-shot, GUI-sweep fake API | 4 |
| WP-I1 | 1 | security review against the session / authentication / access-control chapters of a recognised application-security verification standard; abuse and load test; the provider round trip in the three main browser engines; invite beta (5–10 users, 2 weeks); CSP enforce; RELEASE_NOTES (`platform:'web'`); CLAUDE.md; full rebuild, smoke, acceptance, sync; merge; `server-v1` tag | 6 |
| WP-C2 | 2 | automatic sync: triggers, coalescing, pull-before-edit gate, `applyChanges` path and `wts:project-changed`, `applyRemote`, `_applying` / `_snapshotting`, focus deferral, locks, outbox format, 401 / 426 rules, key-level merge (`merge.js` + concat step, ≈ 2 d), overlap conflict UX with *Show differences*, recent-project cache, library document sync; `acct-sync`, `acct-conflict` | 12 |
| WP-I2 | 2 | after **4 weeks of Phase 1 telemetry**: beta of auto sync (2 weeks), review, release v4.0.x | 3 |
| WP-C3 | 3 | passkeys (register, sign-in, conditional UI, UV step-up), historian backup / restore, live-config opt-in; `acct-account` | 8 |
| WP-M (S) | 3 | field-level rules (§6.7), clash UI, `importWell`, PRiSM branch keep-both; `acct-merge` | 5 |
| WP-I3 | 3 | review, CSP hardening track checkpoint (Q23), release v4.1 | 2 |

| Phase | Release | Scope | Estimate (base → with 30 % contingency) |
|---|---|---|---|
| 1 | **v4.0** (invite beta, then on for the web) | sign-in (e-mail codes, recovery address, **Google, LinkedIn**; link / unlink), sessions, manual Save / Open from cloud, history and restore, import files, account page, export, delete with grace, e-mail change, security notices, migration and hand-over, public-computer wipe, ops (publish allow-list, separate server deploys, backups, ledger, runbook) | 65 → **≈ 85 person-days** (≈ 17 weeks for one full-time builder; revision 2 without providers: 49 → ≈ 64, ≈ 13 weeks), plus 6–10 calendar weeks of legal work and 1–3 weeks of Google verification in parallel |
| 2 | **v4.0.x** | automatic sync, pull-before-edit, key-level merge, overlap conflicts kept on screen, offline outbox rules, recent-project cache | 15 → **≈ 20 person-days** (≈ 4 weeks), shipped no earlier than 4 weeks after v4.0 |
| 3 | **v4.1** | passkeys, historian backup, live-data settings, field-level merge, CSP hardening checkpoint | 15 → **≈ 20 person-days** (≈ 4 weeks) |
| | | **Total** | 95 → **≈ 124 person-days** (≈ 117 without WP-M; the providers add 16 → ≈ 21 over revision 2's 79 → ≈ 103) |

**If the providers move out of v4.0** (Q24 alternative): v4.0 keeps the revision-2 estimate and date (≈ week 15), and the
providers follow in **a separate provider release before v4.0.x** (numbered when scheduled; WP-O plus a day each of WP0, WP-HC
and WP-I1, 16 → ≈ 21 person-days, ≈ week 20). No data migration: every account already has the e-mail root method, and the
provider columns and tables are in the first v4.0 schema with defaults (§3.4).

**Calendar** — laid out on the **contingency days** (× 1.3), one full-time builder, **no two work packages at once**; weeks from
the owner's go. Owner and legal work runs beside the build because it is not the builder's time.

| Weeks | Builder | Owner / outside parties | Critical path |
|---|---|---|---|
| 1–2 | WP0 technical checks (≈ 6.5 d) | DNS access booked; interim privacy notice + About view live (§13.10 1a); both consoles, Google consent screen, LinkedIn Page + app, development clients; legal work starts (DPAs, DPIA, Terms, final notice; weeks 1–10) | yes |
| 2–4 | WP-H (≈ 10.5 d) | **milestone: Google brand verification submitted (week 3–4)**; LinkedIn Page-admin approval | yes (verification) |
| 4–8 | WP-S1 (≈ 21 d) | | yes |
| 8–11 | WP-O (≈ 15.5 d; needs the development clients) | **milestone: Google verified (week 5–7)**, else the testing-mode fallback | yes |
| 11–13 | WP-C1 (≈ 11.5 d) | final privacy notice and Terms (by week 10) | yes |
| 14–15 | WP-OPS, WP-HC (≈ 11.5 d) | | yes |
| 16–17 | WP-I1: review, load test, provider round trip in three browser engines (≈ 5 d) | | yes |
| 18–19 | WP-I1: invite beta (2 weeks, all three methods), fixes, **v4.0 ≈ week 19** | | yes |
| 20–23 | WP-C2 (≈ 15.5 d) during the 4 weeks of Phase 1 telemetry | | |
| 24–25 | auto-sync beta and WP-I2, **v4.0.x ≈ week 25** | | |
| 26–29 | WP-C3, WP-M, WP-I3, **v4.1 ≈ week 29** | | |

For comparison: revision 2 (e-mail code only) on the same basis gives **v4.0 ≈ week 15**; revision 3's table (base days, with
overlaps) showed week 13–15. The providers therefore cost about **4 calendar weeks** before v4.0. With a second builder taking
WP-O beside WP-S1, v4.0 would move back to about week 16.

Each WP ends with the build incantation, smoke and acceptance green and the iOS strip test green.

---

## 15. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| localStorage quota (~5 MB) when a large cloud project is opened | apply fails part-way | size check before apply; parts stay in IndexedDB-backed stores; refuse with "open as file" and the safety snapshot intact |
| Function request / response limits | large uploads fail | 4 MB chunks; blob GETs per chunk |
| Database cold start | first sync of the day ~1 s slower | acceptable; chip shows "Syncing" |
| Raw writes missed | changes upload only at the next event | static scan test; key-hash check on hidden and at each snapshot |
| `loadFromObject` side effects | lost focus, flicker, pruned build-up data | `applyChanges` + `wts:project-changed`; `applyRemote` for parked wells; `keep`; focus deferral |
| Snapshot instability | endless pushes, timers left pending | normalised `vhash`, `flushIfDirty`, `_snapshotting`, E10 test, smoke check 3 |
| Conflict copies pile up | confusing list | key-level merge in Phase 2; "conflict copy of …" badge; *Use cloud* offers to trash the copy |
| Hash-chained build-up audit across devices | broken chain | never splice; prefix rule; keep both |
| Shared rig and office PCs | data left behind or uploaded into the wrong account | public wipe at sign-out and expiry; ownership record; no default upload of foreign work |
| Rig or office behind one IP address | sign-in blocked for a whole site | per-IP limits soft (delay, alert); per-address limits do the real work; site breaker at 1,000/h |
| Mail deliverability, corporate quarantine | users cannot sign in | dedicated sender with SPF / DKIM / DMARC; two live codes, 15 min; FAQ; recovery address; passkeys in Phase 3 |
| Lost work mailbox | lost account | recovery address; audited support recovery |
| Free-plan pause | the whole site offline | D17 before the beta |
| Abuse (sign-up spam, storage, scraping) | cost, data exposure | invite mode, rate limits, read limits, breaker, quotas, `ACCOUNTS_SIGNUP=off` |
| Estimate | late delivery | 30 % contingency built into the calendar (§14), no overlapping work packages for one builder; three phases; interim privacy notice and Google verification submitted in weeks 1–4 |
| DFIT in the same window | merge conflicts in host and CLAUDE.md | separate branches; small isolated host edits; release numbers agreed (Q14) |
| Regulator or client asks for UK-only storage | blob store has no UK region | Q6: database UK, bodies EU by default; a UK object store later (the key scheme does not change) |
| Host rewrite cannot add the proxy header | functions reachable directly | fallback of §2 (one site, functions deployed from tags via a protected deploy branch) |
| Provider verification or app review late or refused | a provider not ready for the beta | interim privacy notice in week 1–2 and verification submitted in week 3–4 (§13.10); for the 5–10 beta testers Google can run in testing mode with them as named test users (re-consent weekly); else ship it dark (`OAUTH_<P>=off`, the dialog hides the button through `GET /auth/providers`) and switch it on later without a client release (Q24) |
| LinkedIn's e-mail claims unreliable; its issuer, nonce or PKCE behaviour differs from its documents | wrong links or failed sign-ins | its e-mail is never trusted (always our code); behaviour fixed by WP0 live tests in one config file; a test profile per provider |
| LinkedIn app re-created | every LinkedIn link breaks (pairwise subjects) | never re-create (§13.10); re-link by one e-mail code (§4.14) |
| Button branding refused, or the rules change | verification refused | official assets unmodified; checked in WP0 and WP-HC |
| A second account by mistake (code with one address, a provider with another) | work split over two accounts | the provider sign-up consent step names the new address and points to *Sign-in methods*, with Cancel second (§11.2); the account page lists every method; support macro (export, unlink, delete — identities released at the deletion request — import, link); no merge tool in v4.0 (Q31) |
| Provider sign-in leaves the user signed in to the provider on a shared PC | the next person can use their provider account (T30) | shared-browser flag and public tick force a fresh provider login (LinkedIn hidden unless a forced login exists); blocking provider sign-out step at public sign-out; residual recorded in T30 |
| LinkedIn enforces neither PKCE nor nonce | a leaked LinkedIn code can be injected (T23) | WP0 wrong-verifier test; LinkedIn behind `OAUTH_LINKEDIN`; ship only on the owner's decision (Q32) |
| Cookie SameSite behaviour differs in a browser | the callback or finish fails | the design never needs a Strict cookie on a cross-site request; three-engine round trip (WP-I1); the e-mail code still works |

---

## 16. Decisions for the owner (each has a recommended default; work proceeds on the default unless changed)

| # | Question | Recommended default | Alternatives |
|---|---|---|---|
| Q1 | Backend option | **Own minimal API in serverless functions + managed SQL database + the host's blob store** (D2). Also confirm the naming convention: open standards (SQL, OpenID Connect, WebAuthn) are named, no vendor, host, service or product | a managed identity service of the host (no passkeys or codes, data region not stated); a hosted auth-plus-database service (large client SDK, free tier pauses when idle) |
| Q2 | Sign-in methods | **E-mail code (root, on every account) + optional recovery address + Sign in with Google + Sign in with LinkedIn in v4.0; passkeys in v4.1**; no passwords (owner request of 2026-11-08) | e-mail code only (revision 2); passwords (more support, credential stuffing); more providers (each adds a console, a secret and a branding review) |
| Q3 | Sessions | **trusted 35 d idle / 180 d absolute; public 12 h / 7 d; "public computer" unticked by default** | 14 d / 90 d (signs out rig users after a hitch); public ticked by default |
| Q4 | Encryption level | **server-side envelope encryption** now; optional end-to-end vault later (format ready) | end-to-end from day one (a lost key loses data for good; ~+25 days; no support recovery) |
| Q5 | Free vs paid accounts | **free**, 250 MB quota, 64 MB per project, 100 MB historian backup | paid tiers (needs payments and terms; not planned) |
| Q6 | Data region | functions UK, **database UK (else EU), bodies EU** | everything EU; UK-only when a UK object store is available |
| Q7 | Retention | named saves 30 d; automatic revisions 10-minute points for 24 h + daily for 30 d; trash 30 d; audit 12 months; inactive accounts deleted after 24 months with two warnings; **deletion with a 7-day grace** | longer history (cost); 36-month inactivity; immediate deletion only |
| Q8 | Live-data connection settings | **opt-in, off** (v4.1) | sync by default (exposes site network addresses) |
| Q9 | Historian | **manual opt-in backup / restore** (v4.1) | automatic backup on Save to cloud (cost, bandwidth) |
| Q10 | Account page placement | **header chip only (`navHidden`)** | Overview sidebar row 6 (web only) |
| Q11 | Admin console | **none**; audited ops scripts | a minimal console (more attack surface) |
| Q12 | Conflict policy | **key-level auto-merge (v4.0.x); an overlap keeps the local version on screen as a conflict copy**; field-level merge in v4.1 | conflict copy for every concurrent change (frequent, confusing); last writer wins (loses work) |
| Q13 | Beta | **invite allow-list on the server (`ACCOUNTS_SIGNUP=invite`) + `?cloud=1` to show the chip, 2 weeks; auto sync after 4 weeks of telemetry** | open sign-up at release |
| Q14 | Release numbers | **v4.0 / v4.0.x / v4.1 after DFIT v3.4**; agree with the DFIT lead | v3.4.x if DFIT slips |
| Q15 | Terms of Use | **new short Terms for the account service**, consent recorded per version | LICENSE §3 only (not enough) |
| Q16 | Security notices | **every new device and every security change** (§4.9) | new devices only; weekly digest |
| Q17 | Release-notes item on iOS | **hidden on iOS** (`platform:'web'`) | shown with "web version only" |
| Q18 | Analytics and third-party scripts while signed in | **analytics tag not loaded while signed in (one reload after sign-in); every CDN script hash-pinned; no account analytics events** | keep analytics while signed in and record the supply-chain risk as accepted |
| Q19 | Review and server deploys | **independent review pass (a separate review session) + owner-signed checklist; functions-only site deployed from `server-v*` tags; migrations by a manual tagged job; static site keeps auto-deploying from master** | a human second reviewer (none available today); server deployed with every master merge (conflicts with the CLAUDE.md auto-merge rule; not recommended) |
| Q20 | Account recovery policy | **recovery address + audited support recovery with the documented identity check (§13.7) and a 7-day revert notice** | no support recovery (a lost mailbox loses the account) |
| Q21 | Business users' data | **offer a standard data processing agreement; H2Oil as processor for business data, controller for accounts** | controller only, no DPA (may block business use) |
| Q22 | Waiting changes on a public computer at expiry | **wipe everything except the outbox encrypted with the server-held per-user key, kept 7 days** | wipe everything (loses a shift's unsynced work); keep local data until the next sign-in (exposes it) |
| Q23 | CSP hardening track | **remove `eval` / `new Function` / inline handlers and move to a nonce-based `script-src` in v4.1** | leave the CSP as allow-list only (accepted residual risk) |
| Q24 | Which methods ship when | **all three in v4.0 (≈ week 19)**, each provider behind its own switch read by the page (`GET /auth/providers`): Google in testing mode for the beta testers if its verification is late; a provider not ready at release ships dark and is switched on later without a client release | e-mail code in v4.0 (≈ week 15, the revision-2 date) and the providers in a separate provider release before v4.0.x (≈ 21 person-days later, ≈ week 20, §14); providers in v4.1 with passkeys |
| Q25 | Passkeys | **still follow in v4.1** (fastest, phishing-resistant, no third party; the provider buttons do not replace them) | drop passkeys now that providers exist (less work, the strongest method lost); bring them into v4.0 (+8 days) |
| Q26 | Sign-up through a provider during the invite beta | **allowed under the same allow-list**: the account address (provider-managed and verified, or confirmed by our code) must be on it; otherwise `403 not_invited` with "Sign in with the address you were invited with, or use the e-mail code" | providers sign in only to existing accounts during the beta (`OAUTH_*=signin`); providers hidden during the beta |
| Q27 | Trusting a provider's "e-mail verified" for a new account | **Google trusted only for addresses Google manages** (its consumer mail domain, or a hosted-domain claim matching the address's domain); every other Google address and **every LinkedIn address get our e-mail code** — so a first LinkedIn sign-in costs one code mail, once (§11.2 friction table) | our code for both always (one more step for every new Google user, one rule); trust Google for any domain (not recommended: a former employee's Google account on a reassigned work address); trust both (not recommended: LinkedIn's claim is optional and it does not verify identities) |
| Q28 | Provider e-mail matches an existing account | **link only after an e-mail code to that account's address** (D24, §4.12 rule 4) | refuse and ask the user to link from the account page (safest, more friction); auto-link on a verified e-mail (not recommended: the classic takeover) |
| Q29 | Step-up through the provider | **no**: step-up is `stepup_at`, set only by an e-mail code (to the primary or recovery address) or, from v4.1, a UV passkey; a provider only signs in, and its session starts with no step-up | a fresh Google re-authentication as step-up (a forced re-login and a second redirect in the middle of an action) |
| Q30 | Provider profile data | **none kept**: Google asked only for `openid email`; LinkedIn's name and photo dropped | ask Google for `profile` and keep a display name for the chip (more personal data, little benefit) |
| Q31 | Two accounts created by mistake | **no merge tool in v4.0**: prevention in the provider sign-up consent step plus the support macro (export, unlink, delete, import, link; history, library and devices do not travel) | a server-side merge tool (≈ +5 days; moves projects, history, library and identities; audited) |
| Q32 | LinkedIn if WP0 finds neither PKCE nor nonce enforced | **ship it behind `OAUTH_LINKEDIN` with the T23 residual recorded** (a code leaked before we redeem it could be injected), callback query logging off, and reassess at each review; decided by the owner after WP0 | keep LinkedIn dark until it enforces PKCE; drop LinkedIn |

---

## Appendix A. Facts the builders must keep exact (from the code at the planning date)

- `WTS_project._buildPayload(meta)` is synchronous; `storage.read()` flushes the autosave; payload `{format:'h2oilproj',
  version:'1.0', generator, savedAt: _nowISO() (29-project-save.js:746), meta, modules}`; `storage.read()` includes
  `LIBRARY_RE` keys (it filters only on `isProjectKey` / `isWellsKey`, l.670) and `storage.write` keeps the local library (l.703);
  the `units` module carries `{system}` and sets `G.WTS_unitsSystem` on load (l.630-641).
- `loadFromObject(obj)` cancels the autosave, nulls the dataset when `prism` arrives without `prism_dataset`, resets the well
  list when `storage` arrives without `wells`, writes every module (`storage.write` removes **all** project keys first), runs
  `_prismSync`, fires `wts:project-loaded {loaded, skipped}`, calls `WTS_rerender({discardPending:true})`; gauge and build-up
  IndexedDB writes finish asynchronously afterwards with no promise today.
- `wts:project-loaded` listeners: `49-calc-buildup-store.js:728-735` `_onProjectLoaded` prunes every raw / tests record not
  listed by the preceding module write (source `'well'` exempt); `38-wts-live.js:836` resets a running simulator and its alarm
  map.
- `WTS_pageAutosave.flush()` = `__flushPageState(true)` (host l.1361): always rewrites the current page record with
  `t: Date.now()` and fires `wts:autosaved`. `PRiSM_saveState` writes `savedAt: Date.now()` (33-pta-core.js:1499).
- `PREF_KEYS` = `{wts_unit_system, wts_prism_sample_suppress, wts_prism_migrated}`; `PREF_RE` at 29-project-save.js:151;
  `LIBRARY_RE` = `/^wts_prism_(user_curves|presets|mapping_)/`; `MAX_KEY_CHARS` 2 MB; job keys `wts_report_templates`,
  `wts_base_conditions`. The project UI is a toolbar New | Open | Save | Save As (l.1162-1165), no menu; New confirms and calls
  `newProject()` (l.1231-1240); nothing binds Ctrl+S.
- `WTS_wells`: the active well lives in the storage keys and modules and `active` in `wts_wells` (29-multiwell.js:9, 560-568);
  `switchTo` parks the active well into `wts_well_<from>` with `WTS_lsSet`, removes the target's parked blob (l.403), writes the
  target's keys raw and fires `wts:project-loaded {source:'well'}` (l.356) and `wts:well-changed`; parked blobs carry `savedAt`
  (`_capture`); `wts_mw_results` is rewritten on every `wts:autosaved` and on pagehide (l.935); `NO_COPY` is at l.510.
- `__lsSet` / `WTS_lsSet` (host l.945-957) evicts `wts_report_snapshots` first on quota errors and fires `wts:storage-full`.
- The spreadsheet library is lazy-loaded with a plain script element and no integrity check (07-data-enhancements.js:395; built
  l.25061); the historian (47) and 3D (32) loaders already check a pinned SHA-384. The analytics tag loads in the head inside
  `GA:START/END`.
- `sw.js` bypasses non-GET requests, other origins, Range requests and same-origin paths that are not app assets; it never
  caches `no-store` responses. It needs no code change.
- Harness: `fetch` rejects unless `opts.globals.fetch` is given; `opts.globals.location` replaces the whole object
  (`_harness.js:646`); Blob is text-only (l.417); no `CompressionStream`, `navigator.locks` or IndexedDB; `crypto.subtle` and
  `randomUUID` exist.
- Round-10 discovers every `prism-build/6N-*.js` (60–65 taken; 64 generated); `stripSelfTest` removes only the self-test tail.
  The 65 zip writer is store-only, in memory, no ZIP64 (65-modbus-bridge-setup.js:357).
- `sync-from-main.js` strips `<!-- GA:START … GA:END -->` (step 0) and `// ── SW:START … // ── SW:END ──` (step 0b), and copies
  `help/` verbatim to `ios-app/www/help`.
- The repository has no publish configuration at its root; the app is served from the repository root.

---

## Appendix B. Review notes (revisions 2–4)

All blockers and majors of the three reviews, and the minors listed below, are resolved in the body. This appendix records the
items resolved **differently** from the reviewer's suggestion, and why; then a short map from each finding to where it is
answered.

### B.1 Resolved differently
1. **Public mode in sessionStorage or memory only** (security, blocker 1, "better still"). Not adopted: hundreds of reads in
   every module expect localStorage, and a tab crash would lose a shift's work. Instead `wipeDevice()` at sign-out, at the first
   load after expiry and on a public 401, plus an outbox encrypted with a server-held per-user key so the wipe never has to
   choose between privacy and unsynced work (§10.8, Q22).
2. **Step-up on export** (security, major). The claim that it protects the data is dropped (T2 states the residual plainly). The
   step-up is kept with a narrower, true purpose: it unlocks a higher read rate (300 MB/h for 2 h) for one session and always
   sends a notice; without it a script can read only 100 MB/h.
3. **Earlier codes** (security minor: a new start invalidates earlier codes; operations: "Send again" keeps the previous code).
   Reconciled: at most **two** live codes per address and purpose, each 15 minutes; a third start invalidates the oldest.
4. **"Stay signed in while unpushed changes exist"** (operations, blocker 1, option). Not adopted: the server cannot see the
   outbox, and the rule would weaken idle expiry for any device. Instead 35 days idle (covers a 28-day rotation) and the outbox
   survives a 401 and is replayed after the same user's sign-in.
5. **Pull-before-edit: "mark dirty only after the pull returns"** (operations, major). Edits are recorded at once (nothing typed
   is held back); the guarantee is that **no push starts before the pull settles**, and the key-level merge handles a concurrent
   remote change to another key.
6. **v1 conflict path** (operations, blocker 2 and major D7). Both fixes adopted together: the key-level merge moved into
   Phase 2 (WP-C2, ≈ 2 days), and only a real overlap creates a conflict copy — which stays on screen with the device linked to
   it. The Phase 1 manual release has no automatic conflicts at all (only the Save-to-cloud 409 choice).
7. **Commit coalescing** (operations, major). Both options adopted: a 20 s quiet / 2 min cap client debounce **and** server
   squashing of `auto` revisions to 10-minute buckets. This also answers the security finding on bursts pushing good revisions
   out of a "last 20" window, replacing its "newest revision older than one hour" rule: buckets keep the history, and the revision
   before a burst is pinned.
8. **Inline core size** (architecture 48 kB, operations 60 kB). 48 kB of gzip (≈ 64 kB base64) keeps the whole keepalive body
   within the browsers' keepalive budget.
9. **`410 resync`** (operations, major). Removed: the merge base is read from the device's `wts-sync`; the server also never
   prunes a revision named in `devices.last_base_rev`.
10. **Help on iOS** (architecture, major; two options). The account guide lives on the account page (68), not in
    `WTS_helpContent`; no `platform` field is added to the help system. Screenshots are taken with the chip hidden rather than in
    web-only folders.
11. **38 (`wts_sim_rigup`)** (architecture, major). Left out of the edits (the simulator workstream owns 31/32/38) and caught by
    the key-hash check, as the reviewer allowed.
12. **Two public steps** (operations, major). Adopted as three phases; Phase 1 includes export, deletion, e-mail change and
    security notices because UK GDPR and the takeover findings need them before any real user data is stored; passkeys move to
    Phase 3.
13. **Analytics while signed in** (security, majors on CSP and supply chain). The default is to not load the tag while signed in,
    using the existing hint in the head; a page that already loaded it reloads once after sign-in. The three allow-listed account
    analytics events of revision 1 are therefore dropped. Keeping analytics is the Q18 alternative.
14. **Per-IP sign-in limit** (operations 300/h soft). Adopted; the site-wide breaker is raised from 500/h to 1,000/h and pauses
    sending only to unknown addresses, so a crew change cannot stop existing users signing in.
15. **Two-person review and tagged deploys** (operations, major). Resolved by splitting server deploys from the static site (a
    functions-only site behind a same-origin rewrite, `server-v*` tags), so the CLAUDE.md auto-merge rule stays as it is; the
    "second person" is an independent review session plus the owner's sign-off (Q19). The rewrite's proxy header is a WP0 check
    with a stated fallback.
16. **Deletion ledger "outside the restorable set"** (security, major). Implemented as append-only objects in the blob store plus
    a copy in the weekly export; the audit-chain anchor uses the same place.
17. **Support recovery identity check** (operations, major). The check is specified (§13.7) but its exact evidence list is an
    owner decision (Q20), because it trades support effort against takeover risk.
18. **Device id** (security, major). The header remains for convenience, but it is server-issued, scoped to `(user_id,
    device_id)` and ignored when unknown or foreign; no limit uses it.
19. **Recent cloud projects offline** (operations, minor). Adopted in Phase 2 with the suggested limit (last 3, 50 MB).
20. **Export above 200 MB** (architecture, minor). One download per project rather than a streaming zip writer change, to keep
    the shared 65 writer unchanged.

### B.2 Where each finding is answered
| Review | Finding | Answered in |
|---|---|---|
| Security | public-computer clear incomplete (blocker) | §10.8, §5.5, D4, `acct-migrate` |
| Security | device hand-over leaks work (blocker) | §10.1–10.3, D15, T19, U12 |
| Security | RLS bootstrap | D12, §3.4 roles and definer functions, `rls.test.js` |
| Security | read and commit limits; client-supplied device id | D21, §8.3, §3.2, §3.4 `devices`, revisions squash and pins |
| Security | e-mail change and takeover persistence | §3.3, §4.3–4.4, §4.9, T18 |
| Security | CSP overclaims; third-party scripts | §8.2, T2, T16, H16, H17, Q18, Q23 |
| Security | stored injection spread by sync | §8.7, T17, §6.4 step 1, `acct-fuzz` |
| Security | passkey settings | §3.3 passkey rows, §4.5 |
| Security | key rotation and compromise | D11, §13.4 |
| Security | deletion vs backups; 30 vs 35 days | §8.5, §13.5 (28-day export), privacy text |
| Security | publish root | §13.2, T20 |
| Security | incident runbook | §13.6 |
| Security | minors: `email_bidx`; code binding; queued send; csp-report and ops-daily; trusted IP header; rotation race; blob immutability and gzip cap; device label; deletion grace; support audit; lawful basis and DPA; invite gate; sibling subdomains and HSTS | §3.4; §4.1; §3.3; §3.2; §3.2; §4.7; §3.3; §3.3; §8.5; D18, §3.4 roles; §8.4, Q21; §3.3, Q13; T3, §8.2 |
| Architecture | unstable core hash (blocker) | §6.1 steps 2, 7–9, H15, E10, smoke check 3 |
| Architecture | `wts:project-loaded` prunes build-up data (blocker) | D8, H3, H4, §6.4, §7 size guard |
| Architecture | per-device multi-well model (blocker) | D5, §6.1 step 5, H13, §6.4, E9 |
| Architecture | no pre-hook before New / Open | H14, §6.8 |
| Architecture | `source:'well'`; `_applying`; write promises | §6.2, §6.4, H3 |
| Architecture | library keys synced twice | D13, §6.1 step 4, H4 |
| Architecture | pagehide keepalive not feasible | §3.3 inline core, §6.2 |
| Architecture | setItem list incomplete; removals | H1, H2, `acct-lswrite-scan` |
| Architecture | Help leaks to iOS | §9 Help, §12.2 `acct-ios` |
| Architecture | `NO_COPY` in the wrong file | H10 |
| Architecture | minors: harness location and seams; units module; toolbar and Ctrl+S; DEV protocol; derived keys; first-sync ordering; identifiers only inside markers; export size | §12.1; §6.1 step 4, §7; H5, D14; §5.1; D9, §6.1 step 8; §5.5; §9 layer 1; §8.5 |
| Operations | session lifetime and offline queue (blocker) | D4, §6.9, Q3, E2 |
| Operations | conflict swaps work off screen (blocker) | D7, §6.6, Q12, E4 |
| Operations | key merge deferred | §6.5, WP-C2 |
| Operations | office PC never focused | §6.2 pull-before-edit gate |
| Operations | per-IP limit locks out rigs and offices | §8.3, §15 |
| Operations | sign-out loses unpushed work | §10.8 |
| Operations | migration safeguard not durable | D8 pre-account snapshot, §10.4–10.6, import files |
| Operations | 426 strands the outbox | §3.2 version policy, §5.3 outbox format, §6.9 |
| Operations | cost and retention assume 20 saves a day | §6.2 coalescing, §3.4 squash, §13.9 |
| Operations | pruned merge base | §6.5, §3.4 `last_base_rev` |
| Operations | pagehide PUT then commit | §3.3 inline core |
| Operations | estimate | §14 (WP-S1 16 d, 30 % contingency, calendar, phases) |
| Operations | two-person review vs the branch model | D19, §13.8, Q19 |
| Operations | lost mailbox, support | D3, §4.4, §13.7, Q20, U11 |
| Operations | minors: invite gate; backend down; deletion grace; one linked project friction; neutral vendor wording | Q13, §3.3; §3.2 outage rule, §11; §8.5; §6.8, §2; D2, Q1 |

### B.3 Revision 3 (Google and LinkedIn sign-in, 2026-11-08)
Owner request of 2026-11-08 (header). Changed: the header (request, naming exception), D3, D4, D14, D19, D20 and new D22–D24;
§1.1–1.3 (U13–U19); §2; §3.1–3.5 (endpoints with `finish` answers, error codes, `identities`, `oauth_attempts`, `oidc_keys`,
`users.signup_method`, `sessions.auth_method`, `email_codes.bound_attempt`, definer functions, jobs); §4.9 and new §4.10–4.15;
§5.1–5.5 (incl. H17); §8.1 (T6, T21–T29), §8.2–8.6; §9; §10; §11.1–11.3; §12.1–12.5; §13.2, §13.3, §13.6, §13.7, §13.9 and new
§13.10; §14; §15; §16 (Q2, Q24–Q30). Points decided differently from the provider research notes, and why:
1. **Return path.** The research proposed a validated relative return path kept in the attempt. Here the server keeps none: the
   callback always redirects to one constant URL and the page restores its own route after checking it against the route table,
   so the open-redirect class is removed rather than filtered.
2. **Where the session is issued.** The research left open whether the session cookie should become Lax or the callback should
   finish on a same-origin page. The session stays **Strict** and is issued by `POST /auth/oauth/finish` from the page; the
   callback only records the outcome. This also gives the dialog a place for the consent, e-mail and code steps without more
   redirects, and binds a link to the session that started it, which the callback cannot see.
3. **Start by fetch, not by form**: a form post to `start` that redirects to the provider could be blocked by `form-action 'self'`.
4. **Google's verified e-mail is trusted for a new account; LinkedIn's never is** — not only when absent — because LinkedIn
   documents the claim as optional and says it does not verify identities (Q27). Narrowed in revision 4: Google's flag only for addresses Google manages (B.4).
5. **No JWT library**: RS256 checks on the runtime's built-in crypto keep the server's dependency list as in revision 2; one
   pinned library is the review's alternative.
6. **Subjects** are stored as an HMAC index plus an encrypted copy, like e-mail addresses (T8); uniqueness is on (provider,
   subject index), which is (provider, subject).
7. **Step-up stays the e-mail code** (and passkeys later); provider re-authentication is an owner alternative (Q29), because it
   would need a second redirect in the middle of an action.

### B.4 Revision 4 (three reviews of revision 3, 2026-11-08)
Reviews: provider security (1 blocker, 5 majors, 9 minors), product and operations (7 majors, 6 minors), consistency (2 blockers,
7 majors, 13 minors). Every blocker and major and every minor that was right is resolved in the body. Resolved **differently**
from a reviewer's suggestion, or beyond it, and why:
1. **Step-up** (blocker in two reviews): adopted as `sessions.stepup_at`. The `oauth_verify` code of rules 4 and 5 sets it (it
   is a code to the account's own address, the same proof as a code sign-in); the new `link_confirm` code does not, so a link
   never yields step-up powers. `auth_at` stays as the creation time only.
2. **Error statuses** (consistency major): both suggestions adopted — the client keys on `signed_out`, and the API sends no other
   401: `oauth_failed` **and** `invalid_or_expired` become 400, because a wrong code during a step-up has the same wipe risk.
3. **Locked and deleting accounts** (security minor; consistency major): `locked` answers the existing `403 locked`, not
   `401 oauth_failed` (no 401 except `signed_out`, item 2). `deleting` answers `next:'code'` with `cancel_deletion`, not `410`,
   so the user can still cancel in the same dialog — but only after a code. **Identities are removed at the deletion request**
   (product major offered this or an unlink in the macro; both are in): a provider can then never cancel a deletion, and the
   "two accounts" macro is not blocked for 7 days by `identity_in_use`.
4. **Refused sign-ups**: two codes, `403 not_invited` (invite beta, the product review's case) and `403 signup_closed`
   (`ACCOUNTS_SIGNUP=off`, the consistency review's), because the dialog text differs; `ACCOUNTS_OFF` answers the existing
   `503 paused`.
5. **Attempt lifetime** (major in two reviews): the security review's Strict re-issue and the product review's 20-minute life and
   30-minute cap are combined; the attempt's `expires_at` keeps the 10-minute callback limit and `result_expires_at` is what moves.
6. **Public computer and the provider session** (security minor, consistency major): beyond the suggested `prompt=login` /
   `max_age=0` on a ticked attempt, the browser is remembered as shared (`wtspref_shared_browser`, kept by the wipe), because —
   as the security review noted — the *next* person chooses the tick, so only a flag left by the earlier public session protects
   them. LinkedIn is hidden on such attempts unless WP0 finds a forced login; the residual is T30.
7. **LinkedIn without PKCE or nonce**: the owner question is a separate Q32 rather than text inside Q24 / Q27, so it can be
   answered after WP0 on its own.
8. **Link from the account page**: step-up checked at `start` only, plus the suggested `link_confirm` code after the return; the
   finish check is `bound_sid` and a callback within 10 minutes, so a normal link no longer fails as `reauth`.
9. **Button assets** (product minor): one fixed variant suited to the dialog's own background instead of computing the colour at
   run time — the assets are inline and the dialog does not follow the OS setting, so a fixed choice can be checked once.
10. **Help and privacy text on iOS** (consistency blocker): the privacy cards are wrapped in ACCT markers as suggested; the help
   start text and the `privacy` help guide get **neutral** wording instead of a wrapped branch, because help content is printed
   into `user-guide.html` and copied verbatim to `www/help`, where markers are not stripped. Beyond the review: **web-only
   release-note items** are wrapped too (their text would otherwise ship in `www/index.html`), item by item rather than whole
   entries, so `RELEASE_NOTES[0].ver` — the version label and the app store stamp — stays the same on iOS.
11. **"No Google in www"** (consistency blocker test): today's bundle already contains "Google" once (the analytics sentence of the
   web privacy branch), so the check pins that one occurrence as a baseline; "LinkedIn" must be absent everywhere.
12. **Calendar** (major in two reviews): re-laid on the contingency days for one builder with no overlap (v4.0 ≈ week 19), with the
   revision-2 date (≈ week 15) beside it and the second-builder option noted, rather than assuming a second builder.
13. **Database name** (product minor): the prose uses "the SQL database"; open standards stay named; Q1 asks the owner to confirm.
14. **Re-created LinkedIn app** (consistency minor): an ops script (`retire-client`) removes the orphaned rows before the new
   client goes live, rather than storing a client id per identity and replacing it in rule 5 — fewer moving parts for an event
   that should never happen.
15. **Estimates**: WP0 4 → 5 and WP-O 10 → 12 days for the added checks and flows; Phase 1 65 → ≈ 85 person-days, total 95 →
   ≈ 124; acceptance tests 201 → about 220 (export and deletion client tests moved into Phase 1), server tests ≈ 155 → ≈ 180;
   smoke and acceptance baselines corrected to 339 / 1615.

| Finding | Answered in |
|---|---|
| step-up through a provider sign-in (blocker) | D4, §3.4 `sessions.stepup_at`, §4 item 7, §4.12 rules 1–5, T18, T28, Q29, §12.4 |
| iOS strip of the privacy and provider text (blocker) | H11, H12, §8.6, §9 layers 1 and 4, `acct-ios` |
| Google's verified flag on unmanaged domains | D24, §4.11, §4.12 rule 5, §4.15, Q27, U13, §12.4 |
| unlink leaves sessions | D24, §3.3 unlink, §3.4 `identity_id`, §4.12 rule 6, §11.3 |
| revert leaves identities | §3.3 revert, §4 item 3, T18, `acct-signin` |
| breaker tripped from outside; no callback limit | §3.3 start / callback, §8.3, §13.6, §12.4 |
| LinkedIn code injection | §4.10 item 4, §4.11 nonce, §4.15, T23, §13.10 step 13, Q32 |
| attempt shorter than the code step | D22, §3.3 finish, §3.4 `oauth_attempts`, §4.10 item 3, §4.13, §8.5 retention |
| 401 `oauth_failed` vs the outage rule | §3.2 table and outage rule |
| deleting / locked / not invited / sign-up off | §3.2, §3.3 finish errors, §4.12 preamble and rule 3, §8.5, §11.2, Q26 |
| two accounts by mistake | §11.2 consent step, §8.5, §13.7, §15, Q31 |
| provider session on a shared browser | U6, §4.11 `auth_time`, §4.15, §5.3, §10.8, §11.2, T30, §15 |
| client cannot see provider switches | D19, §3.3 `GET /auth/providers`, §5.2, §5.5, §11.2, §11.3, §12.5 |
| calendar vs estimate; checklist order; verification on the critical path | §13.10 steps 0–8, §14, §15, Q24 |
| D3 "saves a mail" for LinkedIn | D3, §11.2 friction table, Q27 |
| minors: link step-up and link backdoor; session fixation; `oauth_verify` mail and recipient; one address per role; audit identity ids; production pins; provider error text; CLAUDE.md wording; `/me` auth method; U17 and retire-client; rule 4 recipient; `oidc_keys` access, `create_user`, CHECKs; consent mechanisms; release naming and columns; test counts; export and deletion tests in Phase 1; full provider e-mail in the export; development clients; step-up to the recovery address; support e-mail and DNS; LinkedIn form and Page; button wording; database name; `providerEmailDiffers` once | §4.12 rule 2, T2; §3.3 finish, §4.10 item 5; §4.12 rule 8 and rule 4; §4 item 4, §3.3; §4.12 rule 7, §13.6; §4.11, §13.8; §3.3 callback, §4.10 item 4; CLAUDE.md; §3.3 `/me`, §3.4; U17, §4.14; §4.12 rule 4; §3.4; §3.2, §3.3; §14, §3.4; §12.2–12.4; §12.2; §3.3 export; §4.10 item 6; §3.3 code start, §4 item 7, §13.7; §13.10 steps 0, 2, 3; §13.10 step 8; §11.2; conventions, Q1; §4.12 rule 1, §3.4 |

### B.4 Hosting on the chosen platform (v4.0, 2026-11-09) — recorded deviations
Details and the tests are in `server/README.md` ("Hosting"); the owner's steps in `server/RUNBOOK.md` §3N.
1. **D12, one login.** The platform's managed database hands out one login (the database owner), so `wts_api`, `wts_jobs` and
   `wts_support` cannot have their own credentials. The roles, grants, forced RLS and the `wts_definer` functions are unchanged;
   every request transaction starts with `SET LOCAL ROLE wts_api` (transaction-scoped, safe behind a pooler) and the jobs, the
   weekly export and the support scripts connect with the start-up role `wts_jobs` / `wts_backup` / `wts_support` (or, where the
   endpoint refuses start-up settings, switch per transaction: `WTS_DB_ROLE_MODE=local`, probed by the migration runner).
   **Residual, in full:** every function of the functions site holds the platform's login, which is the same value as the
   migration credential — the database owner with BYPASSRLS, inheriting `wts_owner` and `wts_definer`. So the functions site now
   holds the migration, support and export credential, and neither the D12 / §13.3 credential separation nor the export role's
   read-only property is enforced by credentials on this platform: SQL running there could leave the request role, switch to any
   wts_* role (the job and export connections can switch back to the login or to `wts_owner`) or disable row-level security.
   The only barrier is that SQL is never built from input (tagged templates; role names checked). `site/isolation.js` logs this
   as a standing `config: one-login database` warning in production instead of passing it silently. **Go-live check (open):** if
   the platform lets the owner override the login variable for the functions, `wts_api` and `wts_jobs` get their own passwords
   (the login has CREATEROLE) and dedicated request / job connection strings, which the site then prefers; outcome to be
   recorded here. The migration
   runner (`db/migrate.js --platform`) grants the roles to the login and refuses to start unless it can create roles and
   BYPASSRLS roles; if the platform refuses BYPASSRLS, the fallback is permissive policies for `wts_definer` / `wts_jobs` in a new
   migration (written only if the go-live probe fails).
2. **Unreleased migrations 001 / 002 / 040** lend `CREATE ON SCHEMA wts` to `wts_definer` around each ownership change (a
   non-superuser may only give a function to a role that can create in its schema) and take it back; no effect for a superuser.
3. **§13.5 weekly export.** A function has no dump tool and must not hold a key that can read an export: the export is a `COPY` of
   every table in one REPEATABLE READ, READ ONLY transaction as `wts_backup`, with the same manifest, sealed with an ephemeral
   X25519 agreement to the owner's public key (only the offline private key opens it). It is kept in a separate store in the
   **same** EU region (the platform's blob store has one EU region), not "another region"; the owner copies one export a month
   offline and the platform's daily database backups add a second copy.
4. **Regions.** Functions in London need the platform's credit-based paid team plan (its managed database exists only on
   credit-based plans; else the United States); each function also pins London in its own configuration. The blob store's
   nearest region is Frankfurt, set on every call.
5. **D19 previews.** A deploy preview, a branch deploy or an agent run of a site with a database gets a database branch seeded
   with the production data, so all three are off and automatic builds are stopped; releases come only from `server-v*` tags
   through the workflow's CLI deploy (the CLI's whole tree pinned by a lockfile, the token passed through the environment). At run
   time every function refuses to run unless it is the published production deploy, so older deploys' permanent addresses and
   any preview stay dark.
6. **§2 proxy signature.** The platform sets request headers on a proxy rule only in a configuration file that cannot read
   variables: the main site's build fills the signature into its (unpublished) copy of that file. The original host travels as
   the fixed header `X-WTS-Host`, trusted only with a valid signature; the main site's signature variable is limited to the
   production context, so its previews answer 404. The deployed rule is checked for the header before the first server release
   (RUNBOOK §3N step 10.4); if it is missing, an edge-function fallback in the repository adds the headers at run time. Which
   client address reaches the functions site behind the rewrite, and that a client-sent copy of the address header is not
   trusted (the last value of a list is used), is checked live at go-live (RUNBOOK §3N step 12.5).
7. **§3.2 client gate.** `WTS_MIN_CLIENT` defaults to 4.0 on the platform (the first release with accounts); the version parser now
   accepts the page's leading "v" (before, "v3.4" switched the gate off).
