# server/RUNBOOK.md — operating the web accounts API

Operations handbook for the functions-only site in `server/` (docs/ACCOUNTS-PLAN.md §8, §13; WP-OPS). It covers the
owner's activation checklist, releases, monitoring, kill switches, incidents, the security reset, key rotation and
compromise, backups and restore, and support. Every script named here reads its credentials from the environment only and
prints ids, counts and dates — never an e-mail address, a code, a key or a body.

**v4.0: the host is Netlify** — §3N is the owner's click-by-click guide, §3P the Google and LinkedIn consoles, §3T a disposable
test backend (Free plan, Postmark); the generic §3 stays for any other host. **State today:** the code is ready to deploy but nothing is deployed. While no server answers, the static site behaves
exactly as v3.4: the page's cloud UI stays hidden unless `GET /api/v1/...` answers (and the `?cloud=1` beta flag is set
during the beta), both provider sign-ins are off unless configured (`OAUTH_GOOGLE` / `OAUTH_LINKEDIN` default `off`), and
the repository root carries no host configuration, so the static site's deploy is unchanged.

---

## 1. Map

| What | Where |
|---|---|
| Request pipeline, contract, config | `core/app.js`, `core/contract.js`, `core/config.js` |
| Functions-site adapter (the one function for `/api/v1/*`) | `site/handler.js`; bundle `node site/build.js` → `server/dist/` |
| Netlify site (v4.0) | `netlify.toml`, `netlify/functions/*.mjs`, `site/netlify.js` (functions, defaults, jobs, kick), `site/netlify-blobs.js`, `site/netlify-check.js` (build command), `site/proxy-rule.js` (main site rule), `ops/keygen.js` (secrets) |
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

**On Netlify (v4.0)** the functions site's variables are the table of §3N step 8; the database credential is the platform's
`NETLIFY_DB_URL` (never typed in), and the jobs and the weekly export run inside the site as scheduled / background functions
(no jobs host). The operations scripts on your computer take the production connection string in `WTS_SUPPORT_DB_URL` /
`WTS_JOBS_DB_URL` and run as `wts_support` / `wts_jobs`. The rest of this section describes the generic layout.

| Environment | Database | Secrets | Sign-in |
|---|---|---|---|
| production | UK (else EU) managed database, name without preview / test / drill / scratch | production only (below) | on |
| preview | its own empty database named `*_preview`, synthetic data | its own keys with **kid ≥ 9000**; no provider secrets; no mail credential unless `WTS_PREVIEW_SIGNIN=1` | off unless `WTS_PREVIEW_SIGNIN=1` |
| local / test | throwaway cluster (`server/test/run.js`) or the in-memory fake | generated at test time | fake providers only |

`site/isolation.js` enforces these rules at start-up: production refuses kids ≥ 9000, a preview-looking database name,
`WTS_PREVIEW_SIGNIN`, and the credentials that belong off the functions site (`WTS_DRILL_ADMIN_URL`, `WTS_MIGRATE_DB_URL`,
`WTS_SUPPORT_DB_URL`, `WTS_BACKUP_DB_URL`, `WTS_BACKUP_KEY`, `WTS_EXPORT_CREDENTIAL`); every other environment refuses
production kids (< 9000). On a failure the site serves only `/health` and logs `alert: isolation — …`. The API answers
`404` to any host other than `welltest.h2oil.co.uk` and to any request without the proxy signature in production — before
every other check, so a request sent straight to the functions site never sees `503` or `413`.

**Functions-site environment** (secrets marked \*): `WTS_ENV=production`, `WTS_DB_URL`\* (the `wts_api` role),
`WTS_MASTER_KEYS`\* (`kid:base64,…`), `WTS_MASTER_KID`, `WTS_INDEX_PEPPER`\*, `WTS_CODE_PEPPERS`\* (`kid:base64,…`),
`WTS_SESSION_PEPPER`\*, `WTS_PROXY_SIG`\* (`current[,previous]`), `WTS_OPS_HMAC`\*, `WTS_MAIL_API_URL`\*,
`WTS_MAIL_CREDENTIAL`\*, `WTS_MAIL_FROM`, `WTS_HOST_HEADER`, `WTS_CLIENT_IP_HEADER`, `WTS_TERMS_VERSION`,
`WTS_PRIVACY_VERSION`, `WTS_VERSION`, the kill switches (§6), `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET`\*,
`OAUTH_LINKEDIN_CLIENT_ID`, `OAUTH_LINKEDIN_CLIENT_SECRET`\*. **Never** set `WTS_OIDC_MODE` in production.

**Jobs host** (scheduled scripts; a separate credential set, D12): `WTS_JOBS_DB_URL`\* (`wts_jobs`), `WTS_BACKUP_DB_URL`\*
(`wts_backup`), `WTS_BACKUP_KEY`\*, `WTS_EXPORT_DIR` (separate storage in another region), the blob store binding (the same
module as the functions site, §3 step 6, with its own `WTS_OBJECTS_CREDENTIAL`\*) or `WTS_OBJECTS_DIR`, `WTS_ALERT_WEBHOOK`\*, `WTS_ALERT_EMAIL`, `WTS_HEALTH_URL`, `WTS_STORAGE_PLAN_BYTES`, `WTS_OPS_HMAC`\* (for
`call-daily.js`). **Support machine** (owner only, on demand): `WTS_SUPPORT_DB_URL`\*.

**Repository (release workflow)**: environment `server-migrations` → secret `WTS_MIGRATE_DB_URL`; environment
`server-production` → secret `WTS_DEPLOY_TOKEN`, variables `WTS_DEPLOY_SITE`, `WTS_DEPLOY_COMMAND`, `WTS_HEALTH_URL`. Both
environments require the owner as reviewer. These are **environment** secrets, never repository-level ones (§3 step 8).

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

## 3N. Switch it on with Netlify (v4.0) — follow this, not §3

This is the complete, ordered list for the owner. Each step says where to click, what to type and how to check it. Nothing
here puts a secret into the repository: every secret goes into a Netlify environment variable (tick **Contains secret
values**), a GitHub environment secret, or your password manager. Where a value is a secret it is marked \*.

**What you need before you start**
- The Netlify team that owns the main site (project **h2oil**, welltest.h2oil.co.uk), with your login as **Owner**.
- Admin rights on the GitHub repository.
- Someone who can add DNS records for `h2oil.co.uk`.
- A Google account for the Google Cloud console and a LinkedIn login that is an administrator of the H2Oil company Page (§3P).
- An account with an e-mail sending service (step 9).
- On your own computer: Node.js 22 LTS (the installer from the Node.js website) and a copy of this repository (GitHub
  Desktop is fine). Commands below are run in a terminal opened in the repository folder. On Windows PowerShell write
  `$env:NAME='value'; node …` where this page writes `NAME='value' node …`.

**Names used below**: the new site is called **h2oil-accounts-api** (its address is then
`https://h2oil-accounts-api.netlify.app`). If you pick another name, use it everywhere instead.

### Step 1 — Team plan and region
1. Netlify → your team → **Team settings → Billing**. The team must be on a **credit-based plan**: Netlify Database exists only
   on credit-based plans, and a team on a legacy plan (legacy Starter, legacy Pro or similar) gets "database feature not
   available for this account" at step 6. If Billing shows a legacy plan, switch the team's billing to credit-based first. Choose
   the credit-based **Pro** plan: it gives the London function region (UK data residency), per-scope environment variables,
   30-day database backups and a second team owner. On Personal the functions and the database run in the United States
   (Ohio); if you choose that, write the decision into PROJECT-NOTES.md and the privacy notice must name the transfer.
2. **Team settings → Members**: invite a second Owner (a lost owner login means nobody can rotate secrets or restore backups).
3. Download the Data Processing Agreement from Netlify's Trust Center and keep it with the company records (UK GDPR processor
   contract); note the sub-processor list date.

### Step 2 — Start the long-lead items now (they run in parallel)
- DNS access for `h2oil.co.uk` (Google domain proof, mail records).
- The Google and LinkedIn console set-up (§3P) — Google's brand verification can take 1–3 weeks.
- The e-mail service account (step 9).
- The privacy notice and terms pages on welltest.h2oil.co.uk (both consoles ask for their addresses).

### Step 3 — Generate the secrets on your computer
```
cd server
npm ci
node ops/keygen.js
```
It prints nine `NAME=value` lines. Put every one into your password manager under these exact names. Write
`WTS_MASTER_KEYS` and `WTS_BACKUP_PRIVATE_KEY` also to the offline escrow (a printed copy in the safe, or an encrypted USB key):
without the master key no user data can ever be read again; without the backup private key no weekly export can be opened.
`WTS_BACKUP_PRIVATE_KEY` never goes into Netlify. Close the terminal when done.

### Step 4 — Create the functions site
1. Netlify → **Add new project → Import an existing project → GitHub** → choose this repository.
2. **Branch to deploy**: `master` (or `Dev` while the accounts work is not yet on master).
3. **Base directory**: `server`. Leave **Build command**, **Publish directory** and **Functions directory** all EMPTY:
   server/netlify.toml sets them (`node site/netlify-check.js`, `public`, `netlify/functions`, relative to the base directory).
   Typing them here can double the prefix (`server/server/…`).
4. **Project name**: `h2oil-accounts-api` → **Deploy**. The first deploy is harmless: without its variables every API call
   answers 404 and the scheduled functions only log that nothing is configured.
5. Immediately: **Project configuration → Build & deploy → Continuous deployment → Branches and deploy contexts → Configure**:
   **Branch deploys: Deploy only the production branch**; **Deploy Previews: Don't deploy pull requests** → **Save**. A preview of
   a site with a database gets a copy of the production data and would run with the production secrets. Also turn **agent
   runs** off for this site (or limit them to team Owners) where the project or team settings offer it: every agent run gets its
   own database branch seeded from production, i.e. a copy of all user data running with the site's secrets. (The functions
   also refuse to run on anything but the published production deploy — `alert: isolation` — but a database branch is a data
   copy even if nothing serves it.)
6. Same page, **Build settings → Build status → Configure → Stopped builds** → Save. From now on the site is released only by
   the GitHub workflow from `server-v*` tags (step 12); a push to GitHub never changes it.
7. Do **not** add a custom domain to this site. Its `.netlify.app` address is only ever called by the main site's proxy rule.

### Step 5 — Function region London
**Project configuration → Build & deploy → Functions → Region** (in some layouts **Cloud compute → Functions → Region**) →
**EU (London) — lhr** → Save. Do this **before** step 6: the database is created in the functions region and never moves.

### Step 6 — Create the database
1. On the functions site: **Data & Storage → Database → Create database**. If a region is offered, choose London (or the
   closest EU region offered); write the region into PROJECT-NOTES.md.
2. Leave **sleep on inactivity** at the default (it wakes in well under a second).
3. **Connect → Production connection string → Copy** (team Owners **and Developers** can see it — keep Developer seats on this
   team to the minimum). Store it in the password manager as
   `WTS_MIGRATE_DB_URL`\*. It is the database's only login; the functions get it automatically as `NETLIFY_DB_URL` — never type it
   into the site's variables.
4. Backups: **Data & Storage → Database → Backups** shows the daily backups (Pro: 30 days) and one per published deploy.

### Step 7 — Probe and first migration (from your computer)
> **Superseded on Netlify by platform migrations** (README "Platform migrations", §3T last note): the server now depends on
> `@netlify/database`, so the production deploy provisions the database and applies `netlify/database/migrations/` itself.
> Do not run the command below against a Netlify database (it refuses one the platform migrated); it stays for a host
> without platform migrations. The capability check and the role-mode probe are then the deploy log and the smoke test's
> row 6 (`node ops/remote-smoke.js`, §3T step T6).
```
cd server
WTS_MIGRATE_DB_URL='<the connection string>' node db/migrate.js --platform
```
Expected, in this order: `login …: superuser false, createrole true, bypassrls true`, `roles ready (granted to the login: …)`,
`applied 001-schema.sql` … `applied 050-code-scope.sql`, `4 applied`, `export role ready`, then `start-up role ok`. Running it
again prints `0 applied`. The last line probes how the scheduled jobs switch to their role:
- `start-up role ok` — nothing to do.
- `start-up role refused (…); transaction role ok — set WTS_DB_ROLE_MODE=local on the functions site` — the connection
  endpoint refuses the start-up setting (a transaction pooler). Add the variable `WTS_DB_ROLE_MODE` = `local` in step 8; the jobs
  and the export then switch role inside each transaction instead. Without it every scheduled job and the weekly export fail
  (step 14) while the API works.
- both refused — stop and pass the line to the developer.
**If it stops with "cannot create roles" or "cannot create BYPASSRLS roles", stop here** and pass the message to the developer:
the platform login lacks a right the plan's role design needs, and the fallback migration (server/README.md, Hosting
deviation 1) has to be written first. Nothing was applied in that case.

### Step 8 — Environment variables of the functions site
**Project configuration → Environment variables → Add a variable → Add a single variable.** For each row: the exact key, the
value, **Scopes: Functions** only (Pro), **Deploy contexts: Production** only — never "Same value for all" (a branch or preview
deploy would get the production secrets) — and tick **Contains secret values** for every row marked \*. Changes take effect at
the next deploy (step 12, or step 16 "apply a change").

| Key | Value |
|---|---|
| `WTS_ENV` | `production` |
| `WTS_MASTER_KEYS`\* · `WTS_MASTER_KID` · `WTS_INDEX_PEPPER`\* · `WTS_CODE_PEPPERS`\* · `WTS_SESSION_PEPPER`\* · `WTS_OPS_HMAC`\* · `WTS_PROXY_SIG`\* · `WTS_BACKUP_PUBLIC_KEY` | from step 3 (`WTS_BACKUP_PUBLIC_KEY` is not secret; `WTS_BACKUP_PRIVATE_KEY` is **never** set here — the site refuses to start with it) |
| `WTS_MAIL_API_URL`\* · `WTS_MAIL_CREDENTIAL`\* | step 9 |
| `WTS_MAIL_FROM` | `no-reply@h2oil.co.uk` |
| `WTS_TERMS_VERSION` · `WTS_PRIVACY_VERSION` | `1` · `1` (raise when the published texts change; users then re-consent) |
| `ACCOUNTS_SIGNUP` | `invite` (beta: only allow-listed addresses can create an account) |
| `SYNC_MODE` | `on` |
| `OAUTH_GOOGLE` · `OAUTH_LINKEDIN` | leave unset (= off) until §3P is done |
| `OAUTH_GOOGLE_CLIENT_ID` · `OAUTH_GOOGLE_CLIENT_SECRET`\* · `OAUTH_LINKEDIN_CLIENT_ID` · `OAUTH_LINKEDIN_CLIENT_SECRET`\* | §3P |
| `WTS_DB_ROLE_MODE` | only if step 7 said so: `local` |

**Node version of the functions**: the release deploys without a platform build, so also open **Project configuration → Build &
deploy → Dependency management → Node.js version** and choose **22.x** → Save (the functions then run on Node 22 whatever
machine runs the deploy). If your layout shows no such setting, tell the developer before step 12.

Do **not** set `WTS_DB_URL`, `WTS_DB_ROLE`, `WTS_OIDC_MODE`, `WTS_PREVIEW_SIGNIN`, `WTS_MIGRATE_DB_URL`, `WTS_SUPPORT_DB_URL`,
`WTS_BACKUP_KEY` or `WTS_BACKUP_PRIVATE_KEY` here (the site refuses to start, or ignores them). Set automatically on Netlify and
only changed on purpose: `WTS_MIN_CLIENT` (default `4.0`), `WTS_VERSION` (default the server package version, 4.0.0),
`WTS_HOST_HEADER` (default `x-wts-host`), `WTS_CLIENT_IP_HEADER` (default `x-nf-client-connection-ip`), `WTS_CODE_FLOOR_MS`
(default 400).

### Step 9 — E-mail service and DNS
1. Choose an e-mail sending service with a UK/EU data option and an HTTPS API that accepts a POST with the header
   `Authorization: Bearer <key>` and a JSON body `{"from","to","subject","text"}` (plain text only). If the chosen service needs
   a different body, the developer changes `site/adapters.js httpMail` (one function) before go-live.
2. In the service: add and verify the sending domain `h2oil.co.uk` (or a sub-domain such as `mail.h2oil.co.uk`); create an API
   key limited to sending. `WTS_MAIL_API_URL`\* = the service's send endpoint (https); `WTS_MAIL_CREDENTIAL`\* = the key.
3. DNS records on `h2oil.co.uk` (exact values come from the service's domain page):
   - **SPF**: one TXT record on the sending domain, `v=spf1 include:<the service's SPF host> ~all` — merge it into the existing
     SPF record if there is one (only one SPF record per name is allowed).
   - **DKIM**: the CNAME or TXT records the service lists (usually `<selector>._domainkey…`).
   - **Return-path / bounce domain**: the CNAME the service lists, if any.
   - **DMARC**: TXT on `_dmarc.h2oil.co.uk`: start with `v=DMARC1; p=none; rua=mailto:<a monitored address>`; after two clean
     weeks change `p=none` to `p=quarantine`.
4. Wait until the service shows the domain as verified. In the service's console turn on complaint and bounce alerts to your
   address.
5. Check (after step 13): the code e-mail arrives, and its headers show `spf=pass`, `dkim=pass`, `dmarc=pass`.

### Step 10 — The main site: publish allow-list and the proxy rule
This also completes §3 step 0 (the main site publishes only the allow-list). `server/`, `docs/` and `prism-build/` are already
on master; today's main-site set-up already hides them — confirm `https://welltest.h2oil.co.uk/server/RUNBOOK.md` answers 404
**before** and **after** this step.
0. **Check how the main site deploys today** (change nothing yet): main site **h2oil → Project configuration → Build & deploy →
   Continuous deployment**. Write into PROJECT-NOTES.md the linked repository, the **production branch**, the **Build command**
   and the **Publish directory** shown there, so you can put them back. Go on only if the site is linked to THIS repository and
   builds the branch `master`. If it is not linked to this repository (for example it is deployed by uploading files), or builds
   another branch, **stop and ask the developer**: committing netlify.toml would then do nothing, or change the wrong branch.
1. In a terminal in the repository folder: `node server/site/proxy-rule.js --snippet h2oil-accounts-api.netlify.app > netlify.toml`.
   Commit this one root file on `Dev` and merge Dev → master like any other batch (CLAUDE.md branch model). It sets the main
   site's build to
   `node prism-build/publish-site.js --api` with publish directory `dist-site`, and the rule
   `/api/v1/*` → `https://h2oil-accounts-api.netlify.app/api/v1/:splat` (status 200, forced) with the headers
   `X-WTS-Proxy-Sig` (a placeholder) and `X-WTS-Host: welltest.h2oil.co.uk`. The value is never in the file in the repository.
2. Main site **h2oil → Project configuration → Environment variables**: add `WTS_PROXY_SIG`\* with the **same** value as on the
   functions site, **Scopes: Builds**, **Deploy contexts: Production** only (deploy previews and branch deploys of the main site
   run pull-request code and must never get the signature; they then build with "unset" and their /api/v1 answers 404), tick
   **Contains secret values**. The main site's build fills it into its own copy of
   `netlify.toml` (`server/site/proxy-rule.js --apply`); that file is not published, and `SECRETS_SCAN_OMIT_PATHS` keeps the
   platform's secret scan from failing the build on it.
3. Main site **Build settings**: if the UI still shows an old publish directory or command, clear them (the file's values win).
4. Deploy the main site (the merge to master starts it). Checks:
   - `https://welltest.h2oil.co.uk/` and `https://welltest.h2oil.co.uk/index.html` open the app as before (the publish step
     always writes index.html as a copy of the app page); `https://welltest.h2oil.co.uk/server/RUNBOOK.md` answers 404.
     If the home page answers 404, roll back at once (step 16, "Rollback of the main site") and tell the developer.
   - The deploy log shows `[proxy-rule] proxy signature filled in`. If it shows "WTS_PROXY_SIG is not set", step 2 is missing:
     the site still deploys, the API answers 404 and accounts stay hidden.
   - **The deployed rule carries the header** (no server release needed): open the deploy → **Deploy summary** → the redirect
     rules processed (or **Deploy log → processed redirects / headers**). The `/api/v1/*` rule must list a header
     `X-WTS-Proxy-Sig` (the value is not shown) and `X-WTS-Host`. If the rule is listed without `X-WTS-Proxy-Sig`, the
     platform did not re-read the filled-in file: use the fallback in 10.5 now.
   - Later, once a deploy preview of the main site exists: its `/api/v1/health` answers 404 (no signature in previews).
5. **Fallback (only if 10.4 shows the rule without its header)** — an edge function on the main site adds the headers at run
   time; it is in the repository already (`server/site/edge/wts-api-proxy.js`):
   1. `node server/site/proxy-rule.js --snippet h2oil-accounts-api.netlify.app --edge > netlify.toml`, commit on Dev, merge.
   2. Main site variables: keep `WTS_PROXY_SIG`\* but change its **Scopes** to **Functions** (edge functions read it at run time;
      Deploy contexts: Production only), and add `WTS_API_HOST` = `h2oil-accounts-api.netlify.app` (Scopes: Functions).
   3. Functions site variables: add `WTS_CLIENT_IP_HEADER` = `x-wts-client-ip` (the edge function sends the visitor's address
      there; set it ONLY with the fallback — with the proxy rule a visitor could send that header themselves), then apply the
      change (step 16).
   4. Redeploy the main site; the deploy summary lists the edge function `wts-api-proxy` on `/api/v1/*`. Do step 12 as written.

### Step 11 — GitHub release environments
GitHub → repository **Settings → Environments**:
1. **New environment** `server-migrations` → **Required reviewers**: you → Save → **Add environment secret**
   `WTS_MIGRATE_DB_URL`\* = the connection string of step 6.
2. **New environment** `server-production` → **Required reviewers**: you → Save →
   - secret `WTS_DEPLOY_TOKEN`\*: Netlify → your avatar → **User settings → Applications → Personal access tokens → New access
     token** (description "server releases", expiry 1 year; put a renewal date in the calendar — a password reset also cancels
     it);
   - variable `WTS_DEPLOY_SITE`: the functions site's **Project ID** (Project configuration → General → Project details);
   - variable `WTS_DEPLOY_COMMAND` (exactly; the token reaches the CLI through its environment, never its command line):
     `NETLIFY_AUTH_TOKEN="$WTS_DEPLOY_TOKEN" NETLIFY_SITE_ID="$WTS_DEPLOY_SITE" netlify deploy --prod --no-build --dir public --functions netlify/functions --message "$GITHUB_REF_NAME"`
   The workflow installs the CLI (netlify-cli 27.16.2, its whole dependency tree pinned by `server/ci/deploy-cli/package-lock.json`,
   no install scripts) on Node 22, puts the bundle at `<runner temp>/rel/server` with `<runner temp>/rel` as the repository root
   (so the site's base directory `server` exists there) and runs the command inside `rel/server`. Before the first tag, the
   developer can check the layout once with the same command and `--prod` replaced by `--draft`: the log must name
   `server/netlify.toml` and six functions.
   - variable `WTS_HEALTH_URL`: `https://welltest.h2oil.co.uk/api/v1/health`.
   These must be **environment** secrets and variables, never repository-level ones.

### Step 12 — First server release
1. Make sure the accounts work and this runbook's version are on master (after step 10).
2. GitHub → **Releases → Draft a new release → Choose a tag**: `server-v4.0.0` (new tag, target `master`) → **Publish release**
   (or `git tag server-v4.0.0 <master commit> && git push origin server-v4.0.0`).
3. GitHub → **Actions → Server release** → the run for the tag: `verify` runs the tests (about 5 minutes); then **Review
   deployments → server-migrations → Approve** (prints `0 applied` after step 7); then approve **server-production** (the
   deploy, then the health check).
4. Checks:
   - `https://welltest.h2oil.co.uk/api/v1/health` → `{"ok":true,"db":true,"ver":"4.0.0"}`.
   - `https://h2oil-accounts-api.netlify.app/api/v1/health` (the functions site directly) → 404. If it answers 200, the
     signature check is not active — stop and set `WTS_PROXY_SIG` / `WTS_ENV`.
   - Functions site → **Logs → Functions → api**: one `{"t":"access",…}` line per request, no `alert:` lines. An
     `alert: isolation` or `alert: config` line names the variable to fix.
5. **Check the client address** (unverified on the platform until now): call the health address once from your computer, then
   find its access line: `"ipp"` must be the start of **your** public address (your router's address, shown in its admin page).
   If every line shows the same platform address instead, tell the developer before step 15: provider sign-in refuses to run
   without a real client address, and the per-address code limits would treat all users as one. Then try a **forged** address:
   ```
   curl -H 'X-Nf-Client-Connection-Ip: 203.0.113.9' -H 'X-Forwarded-For: 203.0.113.9' https://welltest.h2oil.co.uk/api/v1/health
   ```
   Its access line must still show **your** prefix. If it shows `203.0.113`, **stop before step 15** and tell the developer:
   anyone could then pick an address per request (rate limits stop working, other people's addresses could be locked out).

### Step 13 — The v4.0 page and the first sign-in
1. The page must be the v4.0 release (the version under the logo reads **v4.0**): the server refuses project saves from older
   pages (`WTS_MIN_CLIENT` 4.0).
2. Put yourself on the invite list (from your computer; the four key values are the same as on the site — `WTS_MASTER_KID` is
   `1` as keygen printed — and the connection string is the one from step 6; the script runs as `wts_support`):
   ```
   cd server
   WTS_SUPPORT_DB_URL='<connection string>' WTS_MASTER_KEYS='…' WTS_MASTER_KID='1' WTS_INDEX_PEPPER='…' WTS_CODE_PEPPERS='…' \
     node ops/allowlist-add.js --actor support:owner --email name@company.example --note beta
   ```
   Output: `{"ok":true,…}` — no address is printed. Repeat for each beta tester.
3. Smoke test: open `https://welltest.h2oil.co.uk/?cloud=1` in a private window → the account chip → **Sign in** → your address
   → the code e-mail arrives within a minute (check its SPF / DKIM / DMARC, step 9.5) → enter the code → accept the terms →
   signed in. Then **Save to cloud** on a small project; open the page in another browser, sign in, **Open from cloud**: the
   project opens with the same values. On the functions site **Data & Storage → Blobs** now lists the store `wts-objects`.
4. Sign out; sign in again; on the account page check the devices list and the export.

### Step 14 — Scheduled jobs
Functions site → **Logs → Functions**: `ops-purge` (hourly), `ops-daily` (03:17 UTC) and `weekly-export` (Sundays 04:41 UTC)
show as scheduled. They run only on the published production deploy.
1. `ops-daily` → **Run now** → its log shows `jobs: ops-daily started ops-daily-background`; the `ops-daily-background` log then
   shows `jobs: ops-daily-background {"ok":true,…}` (and, until the first export, `alert: exportAge`). A line
   `alert: jobs — … platform retry ignored …` means the platform repeated a run that had failed (it retries background runs
   after 1 and 2 minutes with the same signed call, which is never run twice): read the failure line just before it, fix it, and
   start the job again with **Run now** on `ops-daily` (or `weekly-export`). `alert: jobs — … refused an unsigned or badly signed
   call` is a call that did not come from the scheduled function — check that `WTS_OPS_HMAC` is set.
2. `weekly-export` → **Run now** → `weekly-export-background` logs `{"ok":true,"name":"wts-export-….wtsx",…}`; **Blobs** lists
   the store `wts-exports`.
3. The **first restore drill** (§9.3) before any real user signs in — with the developer, on a computer that has the
   **PostgreSQL 16 tools** installed (set `WTS_PG_BIN` to their `bin` folder if they are not on PATH) and a **scratch database
   server the developer sets up** for the drill:
   `WTS_BLOBS_SITE_ID=<Project ID> WTS_OBJECTS_CREDENTIAL='<a personal access token>' WTS_BACKUP_PRIVATE_KEY='…'
   WTS_DRILL_ADMIN_URL='<scratch administrator URL>' node ops/restore-drill.js --from-store`. `WTS_DRILL_ADMIN_URL` is the
   administrator connection of that scratch server — **never** the production connection string. Record the report in
   PROJECT-NOTES.md.
4. Once a month: copy the newest export to offline storage —
   `WTS_BLOBS_SITE_ID=<Project ID> WTS_OBJECTS_CREDENTIAL='<personal access token>' node ops/export-fetch.js <folder>` (the file
   stays sealed; the private key is not needed to copy it). The quarterly drill can then use `node ops/restore-drill.js <file>`.

### Step 15 — Switch the providers on (after §3P)
- **Google**: set `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET`\* and `OAUTH_GOOGLE=on` (new accounts, links and
  sign-ins) — or `signin` (only identities already linked may sign in; no new account, no new link) — then apply the change
  (step 16).
- **LinkedIn**: set `OAUTH_LINKEDIN_CLIENT_ID`, `OAUTH_LINKEDIN_CLIENT_SECRET`\*, `OAUTH_LINKEDIN=on`. LinkedIn stays **off in
  production** — whatever the switch says, with an `alert: config` line — until the live tests of plan §13.10 step 13 are
  recorded in `server/core/oidc-providers.js` (the issuer value, PKCE, nonce and forced-login behaviour; `pending` emptied) and
  released with a new server tag. The developer does that with you and one real LinkedIn account.
- Check: the sign-in dialog shows the provider's button; sign in once with it; the account page lists the linked identity.
- Never set `WTS_OIDC_MODE` on this site.

### Step 16 — Everyday operations on Netlify
- **Apply a changed variable**: variables are frozen into each deploy, and builds are stopped. GitHub → **Actions → Server
  release** → the latest run → **Re-run all jobs** (approve the two environments again). The kill switches of §6 work the same
  way (`ACCOUNTS_OFF=1`, `SYNC_MODE=readonly`, `ACCOUNTS_SIGNUP=off`, `OAUTH_<P>=off`).
- **Rollback of the server code**: functions site → **Deploys** → the previous published deploy → **Publish deploy**
  (instant; that deploy also brings back the variable values it was built with). Migrations are additive, so the older code
  works on the newer schema. A rollback never restores the database.
- **Rollback of the main site**: main site → **Deploys** → previous deploy → **Publish deploy**. Removing the proxy rule (a new
  main-site deploy without the `[[redirects]]` block) takes accounts offline for everyone without touching any data.
- **Restore the database**: Data & Storage → Database → Backups → choose a backup → Restore (Owner only; a fail-safe branch is
  kept). Then, BEFORE re-opening the API (keep `ACCOUNTS_OFF=1` until then), run on your computer
  `WTS_JOBS_DB_URL='<connection string>' WTS_BLOBS_SITE_ID=<Project ID> WTS_OBJECTS_CREDENTIAL='<personal access token>'
  WTS_OBJECTS_BINDING=site/netlify-blobs.js node ops/ledger-replay.js` (§9) so deleted accounts stay deleted; it runs as
  `wts_jobs`.
- **Rotate a secret**: §10; after changing it on the site, apply the change (above). `WTS_PROXY_SIG`: set `new,old` on the
  functions site, apply, change the main site to `new`, redeploy it, then set `new` alone on the functions site.
- **Database branches**: keep them limited to production. Deploy previews, branch deploys and agent runs each get a database
  branch seeded with a copy of production data — all three stay off on the functions site (step 4.5).
- **Older deploys**: every earlier deploy keeps a permanent `<deploy id>--h2oil-accounts-api.netlify.app` address. The functions
  refuse to run there (`alert: isolation — … not the published deploy`), so old code stays dark after a security release; a
  rollback (above) publishes the old deploy and makes it run again on purpose.
- **Never**: turn deploy previews, branch deploys or agent runs on, start builds again, add `WTS_BACKUP_PRIVATE_KEY` to a site,
  or paste a connection string into a variable of the functions site (except a dedicated login, below).

### Security notes for this platform (plan Appendix B.4)
- **One login = administrator-equivalent on the site.** `NETLIFY_DB_URL`, which every function holds, is the same value as
  `WTS_MIGRATE_DB_URL`: the database owner, with BYPASSRLS and the migration, support and export roles. The plan's credential
  separation (D12 / §13.3) and the read-only property of the export role are **not enforced by credentials** here: code that
  ran arbitrary SQL on the site could leave the request role (RESET ROLE), switch to any role or disable row-level security. The
  barriers that remain: no SQL is ever built from input, every request transaction runs as `wts_api` under forced row-level
  security, and the proxy signature keeps the site unreachable except through the main site. The site logs this residual on
  every start as `config: one-login database: …` — expected, not an error.
- **Go-live check (optional, record the outcome in plan B.4):** if the platform lets you override `NETLIFY_DB_URL` for the
  functions, the developer can give `wts_api` and `wts_jobs` their own passwords (the login has CREATEROLE) and you set
  `WTS_DB_URL`\* / `WTS_JOBS_DB_URL`\* (Scopes: Functions, Production) to those dedicated logins: the site then uses them
  instead of `NETLIFY_DB_URL` and the `config: one-login database` line disappears. The export still needs the owner login.

## 3T. Test backend (disposable, Netlify Free plan, Postmark)

A throwaway copy of the functions site for trying the API end to end before the production set-up of §3N. **No real users,
no real data**: it is deleted afterwards and production is built fresh on the Pro plan (§3N) with NEW secrets. Nothing of the
test backend — secrets, database, Postmark token — is ever reused for production (the key ids make that checkable: the test
keys carry kid 9001, which production refuses, and production's kid 1 is refused here).

**How it differs from production**: `WTS_ENV=staging`. Every security rule of production applies unchanged (proxy signature,
production host, production origin only, cookies, providers, code floor, the published-production-deploy rule); only the key
ids differ and `ACCOUNTS_SIGNUP=open` lets any address create an account. On the Free plan the functions, the database and the
blob store are not in London (the database and functions run in the platform's default US region; Blobs stay `eu-central-1`) —
acceptable only because no personal data goes in. There is no main-site proxy rule for it: the page on welltest.h2oil.co.uk
keeps talking to nothing, and the backend is exercised with `ops/remote-smoke.js` (and API calls that send the signature).

**Names**: site **h2oil-accounts-test** (`https://h2oil-accounts-test.netlify.app`); branch: the accounts branch the developer
names (today `ac/test`).

### Step T1 — Secrets (your computer)
```
cd server && npm ci
node ops/keygen.js --preview
```
Keep the printed values in the password manager under a separate "TEST backend" entry. `WTS_BACKUP_PRIVATE_KEY` is not set on
the site (keep it with the test entry or discard it with the backend).

### Step T2 — Postmark
1. Create a Postmark account and a **Server** named "WTS test"; its **Default Transactional Stream** is `outbound` (the code
   sends to that stream).
2. **Sender Signatures**: add the From address (`no-reply@h2oil.co.uk`, or a test address you can receive at) and confirm it,
   or verify the domain (DKIM + Return-Path records). Until Postmark approves the account, it only delivers to addresses on the
   sender's own domain — test with an `@h2oil.co.uk` address.
3. Server → **API Tokens** → copy the **Server API token** → `WTS_MAIL_CREDENTIAL`\* (never the Account token).

### Step T3 — Create the site
As §3N step 4 with these changes: project name `h2oil-accounts-test`; base directory `server`; build command, publish and
functions directories EMPTY (netlify.toml sets them); branch = the test branch; **Branch deploys: production branch only;
Deploy Previews: off**; agent runs off; no custom domain. Do not start a deploy before step T4 (if one starts, it is harmless:
without variables every call answers 404).

### Step T4 — Environment variables (before the first real deploy)
Deploy context **Production** (on Free all scopes; tick **Contains secret values** for every \*):

| Key | Value |
|---|---|
| `WTS_ENV` | `staging` |
| `WTS_MASTER_KEYS`\* · `WTS_MASTER_KID` (`9001`) · `WTS_INDEX_PEPPER`\* · `WTS_CODE_PEPPERS`\* · `WTS_SESSION_PEPPER`\* · `WTS_OPS_HMAC`\* · `WTS_PROXY_SIG`\* · `WTS_BACKUP_PUBLIC_KEY` | step T1 |
| `WTS_MAIL_PROVIDER` | `postmark` |
| `WTS_MAIL_CREDENTIAL`\* | the Postmark Server API token (step T2) |
| `WTS_MAIL_FROM` | the confirmed sender (step T2), e.g. `no-reply@h2oil.co.uk` |
| `ACCOUNTS_SIGNUP` | `open` |
| `SYNC_MODE` | `on` |
| `WTS_TERMS_VERSION` · `WTS_PRIVACY_VERSION` | the values production will use (today `1` · `1`) |
| `WTS_DB_ROLE_MODE` | only if step T6 says so: `local` |

Do **not** set: `WTS_DB_URL`, `WTS_JOBS_DB_URL`, `WTS_DB_ROLE`, `WTS_OIDC_MODE`, `WTS_PREVIEW_SIGNIN`, `WTS_DEV_ORIGIN`,
`WTS_MIGRATE_DB_URL`, `WTS_SUPPORT_DB_URL`, `WTS_BACKUP_PRIVATE_KEY`, `WTS_MAIL_API_URL`, any `OAUTH_*` (providers stay off on
the test backend). Set by the platform or the site's defaults: `NETLIFY_DB_URL` (the database login), `WTS_HOST_HEADER`,
`WTS_CLIENT_IP_HEADER`, `WTS_MIN_CLIENT`, `WTS_VERSION`.

### Step T5 — Deploy (the database comes with it)
A **production** deploy of the test branch (Deploys → Trigger deploy, or the developer's CLI deploy). Because `package.json`
depends on `@netlify/database`, the platform provisions the database on this deploy and applies
`netlify/database/migrations/` (server/README.md "Platform migrations"): `0000_platform_roles.sql`, `0010_schema.sql` … `0500_code_scope.sql`,
`0501_platform_export_role.sql`. A failing migration blocks the publish — read the deploy log:
- "cannot create BYPASSRLS roles" / "cannot create roles" / "PostgreSQL 16 or newer" → stop and pass the line to the developer
  (README "Platform migrations", fallback). Nothing was applied.
- Never "fix" the database by hand or with `db/migrate.js` (it refuses a platform-migrated database), never edit or delete a
  file in `netlify/database/migrations/`: a correction is a new `db/migrations/NNN-*.sql` + `node db/platform-migrations.js --write`.
- If the function region pin (`lhr`) is refused on the Free plan, stop and tell the developer.

### Step T6 — Smoke test (from the developer's container or your computer)
```
cd server
WTS_SMOKE_BASE='https://h2oil-accounts-test.netlify.app' WTS_PROXY_SIG='<value>' WTS_OPS_HMAC='<value>' node ops/remote-smoke.js
WTS_SMOKE_BASE=… WTS_PROXY_SIG=… WTS_OPS_HMAC=… node ops/remote-smoke.js --mail-to you@h2oil.co.uk
```
(PowerShell: `$env:WTS_SMOKE_BASE='…'; …`; the values never go on the command line.) Expected: every row `PASS` — 1 health
signed (`db true`, `ver 4.0.0`), 2 / 3 no or wrong signature → 404, 4 write without Origin → 403 origin, 5 self-test without
the HMAC → 404, 6 self-test signed (isolation true, keys true, db true, request role `wts_api`, jobs role `session` or `local`,
mail transport `postmark`), 7 (with `--mail-to`) test e-mail `sent` — and the "Well Testing Suite e-mail delivery test" mail
arrives. Failures:
- 1 fails with `db false` → the database was not provisioned or migrated: check the deploy log (T5).
- 6 `isolation false (… problem(s): …)` → the listed variable is wrong (a production key id, an off-site credential …).
- 6 `jobs role local` (row 6.1) → add `WTS_DB_ROLE_MODE` = `local` (T4) and redeploy; `refused` → tell the developer.
- 7 `mail_sender` → the From address is not a confirmed sender signature; `mail_auth` → wrong token (use the Server token);
  `mail_rejected` → the address is invalid / inactive, or the account is still pending and the address is off-domain.

### Step T7 — Tear down
Delete the site (its database and blob stores go with it), delete the Postmark server (or revoke its token), delete the "TEST
backend" password-manager entry. Production is then set up from §3N with `node ops/keygen.js` (no `--preview`) and
`WTS_ENV=production`.

**Note for production (§3N):** with `@netlify/database` as a dependency the production deploy applies the migrations itself,
so §3N step 7 (`migrate.js --platform` from your computer) and the release workflow's migrate job must NOT run against the
Netlify database (`migrate.js` refuses a database the platform migrated; the opposite order — `migrate.js` first — makes the
platform's `0010_schema.sql` fail and blocks the deploy). The workflow's migration gate has to be adapted before the first
production tag (developer item).

## 3P. Google and LinkedIn console set-up (plan §13.10)

The exact callback addresses the server builds (`core/oidc.js redirectUri`: the production origin + `/api/v1/auth/oauth/` +
provider + `/callback`) — type them exactly, https, no trailing slash, no wildcard:

| Provider | Redirect URI | Variables |
|---|---|---|
| Google | `https://welltest.h2oil.co.uk/api/v1/auth/oauth/google/callback` | `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET`\*, switch `OAUTH_GOOGLE` |
| LinkedIn | `https://welltest.h2oil.co.uk/api/v1/auth/oauth/linkedin/callback` | `OAUTH_LINKEDIN_CLIENT_ID`, `OAUTH_LINKEDIN_CLIENT_SECRET`\*, switch `OAUTH_LINKEDIN` |

Use an owner-controlled company login for both consoles and add a second administrator. Record the client ids (not the
secrets) in §2 "Records".

**Google** (Google Cloud console)
1. **Domain proof**: in Google Search Console add the domain `h2oil.co.uk` and add the TXT record it shows to the DNS (step 2).
2. Google Cloud console → project picker → **New project** → name `Well Testing Suite` → Create, and select it.
3. Menu → **Google Auth Platform** (older layouts: **APIs & Services → OAuth consent screen**) → **Get started**: App name
   **Well Testing Suite**; user support e-mail (a group or address the console owner controls, e.g. software@h2oil.co.uk);
   Audience **External**; developer contact address → Create.
4. **Branding**: application home page `https://welltest.h2oil.co.uk/`, privacy policy and terms of service addresses on
   welltest.h2oil.co.uk, **Authorised domains**: `h2oil.co.uk`; logo (a logo requires brand verification).
5. **Data access → Add or remove scopes**: `openid` and `.../auth/userinfo.email` only → Update → Save. (Non-sensitive: no
   security assessment.)
6. **Audience**: while testing, add the beta testers as **Test users** (at most 100; their grants expire after 7 days). When the
   branding is ready, **Publish app** (In production) and submit brand verification if asked.
7. **Clients → Create client** → Application type **Web application** → name `WTS production` → **Authorised JavaScript
   origins**: none → **Authorised redirect URIs → Add URI**: `https://welltest.h2oil.co.uk/api/v1/auth/oauth/google/callback`
   → **Create**. Copy the **Client ID** into `OAUTH_GOOGLE_CLIENT_ID` and the **Client secret** into
   `OAUTH_GOOGLE_CLIENT_SECRET`\* straight away (the secret is shown in full only once).
8. A second client `WTS development` with the developer's local page address + `/api/v1/auth/oauth/google/callback` (the
   `WTS_DEV_ORIGIN` of `dev.js`, a `http://localhost:…` address) is only for local runs; its id and secret never go onto the
   production site.
9. Switch on: step 15.

**LinkedIn** (LinkedIn Developer portal)
1. The company Page for H2Oil must exist with you as a Page administrator.
2. Developer portal → **My apps → Create app**: app name `Well Testing Suite`; **LinkedIn Page**: the H2Oil Page; **Privacy policy
   URL**: the privacy page on welltest.h2oil.co.uk; **App logo**; accept the legal agreement → **Create app**.
3. **Settings** tab → **Verify** → send the verification link to the Page administrator, who approves it.
4. **Products** tab → **Sign In with LinkedIn using OpenID Connect** → **Request access** (self-serve). The **Auth** tab then lists
   the scopes `openid`, `profile`, `email`.
5. **Auth** tab → **OAuth 2.0 settings → Authorized redirect URLs for your app → Add redirect URL**:
   `https://welltest.h2oil.co.uk/api/v1/auth/oauth/linkedin/callback` → Update. Copy **Client ID** into `OAUTH_LINKEDIN_CLIENT_ID`
   and the **Primary Client Secret** into `OAUTH_LINKEDIN_CLIENT_SECRET`\*.
6. **Never delete and re-create this app**: LinkedIn gives each app its own user ids, so a new app breaks every LinkedIn link
   (`ops/retire-client.js` exists only for that emergency).
7. The live tests with a real LinkedIn account (plan §13.10 step 13) and the pin update in `core/oidc-providers.js` come before
   `OAUTH_LINKEDIN` can take effect in production (step 15).


---

## 3. Activation checklist (generic host — on Netlify follow §3N above; kept for any other host)

Do these in order; each step is reversible until step 14. Plan §13.10 has the provider-console steps (WP0).

0. **PRECONDITION — before `server/` reaches master** (integration review): if the static site publishes the repository
   tree from master, merging the accounts branch would make `server/` (core, migrations, schema, this runbook, ops scripts),
   `docs/` and `prism-build/` downloadable as static files. No secret is in them (secrets come only from the environment),
   but plan §1 / §13.2 says `server/` is never published as static content. So **first** switch the static site's publish
   directory to the output of `node prism-build/publish-site.js` (step 13 without `--api` until the API is live: the
   allow-list and `_headers`), or add an equivalent host-side exclusion of `server/`, `docs/`, `tools/` and `prism-build/`,
   deploy, and confirm `https://welltest.h2oil.co.uk/server/RUNBOOK.md` answers 404. (Status at v4.0: `server/` is already on
   master and the live main site already answers 404 there; §3N step 10 replaces that set-up with the allow-list, and
   publish-site.js always writes index.html as a copy of the app page so `/` keeps working.)

1. **Decide and sign up**: the hosting plan with functions and a scheduler (D17), the database in the UK (else EU), the blob
   store (EU), the e-mail service (sender `no-reply@h2oil.co.uk`, SPF / DKIM / DMARC on `h2oil.co.uk`), the uptime check.
2. **Database**: create the production database. As the administrator run the migration job once (step 9) — it creates the
   roles `wts_owner`, `wts_definer`, `wts_api`, `wts_jobs`, `wts_support`. Set passwords for `wts_api`, `wts_jobs`,
   `wts_support` out of band. Apply `server/ops/sql/backup-role.sql` and set the `wts_backup` password.
3. **Keys**: generate 32-byte random values (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`)
   for the master key (kid 1), index pepper, code pepper (kid 1), session pepper, proxy signature, ops HMAC and backup key
   (kid 1). Store each in the vault; write the master key and the backup key to the offline escrow too.
4. **Functions site**: create a second site of the same team for `server/` only (`site/site.json`): build command
   `node site/build.js` in `server/`, functions folder `dist/entry` with its single function `dist/entry/api.js` for
   `/api/v1/*` (never point the host at `dist/functions/`: those are route-table modules, not host functions, and a host that
   deploys every file of its functions folder would publish them as broken functions), **no static publish directory**
   beyond `dist/static` (robots.txt only), UK region if offered. Disable deploy previews and branch deploys for this site (it
   deploys only from the release workflow).
5. **Environment**: set the functions-site variables of §2. Leave `OAUTH_GOOGLE` / `OAUTH_LINKEDIN` unset (= off) and
   `ACCOUNTS_SIGNUP=invite` until the beta.
6. **Blob store binding**: commit `server/site/objects-binding.js` through a reviewed server release, exporting
   `createStore(env)` that returns the host's blob store with `get / set / delete / list({prefix})` and reads its credential
   from the environment (`WTS_OBJECTS_CREDENTIAL`, never a literal — the secret scan and the bundle build refuse one). Every
   build copies it into `dist/site/`, so it survives each release; a different module path can be named with the non-secret
   variable `WTS_OBJECTS_BINDING` (a `.js` path inside `server/`). `site/objects-loader.js` loads it for the API entry, the
   weekly export and the ledger replay alike; `site/adapters.js hostObjects()` validates every key. Without it data routes
   answer `503 paused` and the weekly export fails (unless run with `--no-objects`).
7. **Rewrite on the static site** (host settings of the existing static site, not this repository's root):
   `/api/v1/*` → `https://<functions-site-host>/api/v1/:splat`, status 200, proxied, adding the request header
   `X-WTS-Proxy-Sig: <WTS_PROXY_SIG current value>`; pass `Cookie`, `Origin`, `Content-Type` and the `X-WTS-*` headers through.
   Set `WTS_HOST_HEADER` / `WTS_CLIENT_IP_HEADER` to the trusted forwarding headers the host adds — **both are required in
   production**: without `WTS_CLIENT_IP_HEADER` every user shares the proxy's address, so the config raises an alert and
   provider sign-in is refused (no client range), and the per-range code limits cannot tell people apart. Check: the functions-site
   URL answered directly gives `404`; through the static site `GET /api/v1/health` gives `{"ok":true,"db":true,…}`. If the
   host's rewrite cannot add a header, use the fallback of plan §2 (one site, functions deployed from the same tags through a
   protected deploy branch) — ask for a plan update first.
8. **Repository**: BEFORE the first tag, create the environments `server-migrations` and `server-production` with the owner
   as **required reviewer**, then add the secrets and variables of §2 **to those environments** (environment secrets, not
   repository secrets: a repository-level secret, or an environment the first workflow run creates on its own without
   reviewers, would let the jobs run without the manual approval). The deploy job refuses to run when the migrate job was
   skipped (no `WTS_MIGRATE_DB_URL` in its environment) while `server/db/migrations` changed since the previous server tag. `WTS_DEPLOY_COMMAND` is the host CLI's deploy call for the functions site, run inside
   `server/dist`, reading `WTS_DEPLOY_TOKEN` and `WTS_DEPLOY_SITE` from the environment (pin the CLI version in it).
9. **First release**: follow §4 with tag `server-v1`.
10. **Schedules** (jobs host or the host scheduler): daily `node server/ops/call-daily.js` (or the host scheduler calling
    `POST /api/v1/ops/daily` with the same HMAC), hourly `node server/ops/monitor-check.js`, weekly
    `node server/ops/weekly-export.js` (`site/site.json` lists the times).
11. **Monitoring**: the uptime check on `https://welltest.h2oil.co.uk/api/v1/health` (alert when not `ok` or `db:false`); the
    host's log alerting on `alert:` lines and on the access-line rules of §5; `WTS_ALERT_WEBHOOK` / `WTS_ALERT_EMAIL`; a spend
    alert at 80 % of the plan.
12. **First restore drill** (§9.3) before any real user signs in; note the result in PROJECT-NOTES.md.
13. **Static site headers** (the publish directory itself was already switched in step 0): rebuild it with
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

- The static site auto-deploys from master as before — **once step 0 of §3 is done** (the publish allow-list or a host-side
  exclusion of `server/`, `docs/`, `tools/`, `prism-build/`); before that, do not merge the accounts commits to master. The
  client account code (66–68) ships with it, gated by the beta flag and the server's switches.
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

Access lines (`{"t":"access","rid","route","status","ms","ipp"}` plus, when known, `uid`, `provider`, `outcome` (the
provider callback: `ok` / `state` / `exchange_failed`) and `err` (the envelope error code)) are the only per-request log;
handlers log no addresses, codes, cookies, bodies, provider codes, `state`, tokens or claims (`site/monitor.js redactLine`
masks free text). `rid` is also returned to the browser as the `X-WTS-Request-Id` response header: ask a user who reports a
problem for it and search the access lines by it. Alerts are log lines `alert: <id> — <text>` plus one POST per
`monitor-check.js` run to `WTS_ALERT_WEBHOOK`.

**Where each alert comes from** (`site/monitor.js` RULES `source`; the test `ops-site.test.js` checks every rule has one):
- **monitor-check (database, jobs credential)**: codeSends, ipSoft, readAnomaly, commitBurst (rate counters; thresholds from
  `core/rate.js` LIMITS), outboxAge and bounce (outbox messages of the last 24 h still unsent after every retry), deletionLag,
  storage (`WTS_STORAGE_PLAN_BYTES`), subjectMulti, linkSpike (audit `identity_link` / `identity_unlink`, baseline = mean per
  hour over 7 days), ceiling (provider exchange counters at the per-prefix ceiling and prefixes at the live-attempt ceiling),
  breaker (breakers opened in the last hour), auditChain (the daily job's chain check re-run read-only).
- **monitor-check (code / export)**: pins (`core/oidc-providers.js checkPins()`), exportAge (`WTS_EXPORT_DIR`).
- **Access lines** (the host's log alerting with the same thresholds, or `monitor-check.js --lines <exported log>`):
  http5xx, latency, verifyFails (`codeVerify` answered `invalid_or_expired`), rate429, providerGoogle / providerLinkedin
  (callbacks with an outcome other than `ok`, and finishes answering 5xx, `oauth_failed` or `oauth_state`).
- **Log lines only** (set the host's log alerting on lines starting `alert: `): isolation and pins (`site/handler.js` at
  start-up), jwksFetch and unknownKid (the provider signing-key cache), breaker (when it opens), auditChain (the daily job),
  plus the site's own `alert: config`, `alert: objects` (a configured blob store binding that cannot be loaded) and
  `alert: adapter`.
- **The e-mail service's own alerting**: complaint (and asynchronous bounces after acceptance) — enable it in the service's
  console with the owner's address.

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
  another region, kept **28 days**. The dump and the manifest's row counts, audit digest and migration list come from one
  exported database snapshot (a read-only repeatable-read transaction held open while the dump runs), so the drill compares
  like with like even though production writes all the time.
- **Deletion ledger** objects `ledger/<user id>` (ids and dates only) written by the daily job outside the restorable database.
- **Audit anchor** objects `chain/<date>` (each user's chain head and a Merkle root) written daily.

### 9.2 Real restore (after data loss)
1. `ACCOUNTS_OFF=1` (the API must not serve restored data before step 4).
2. Restore the platform backup (or `pg_restore` of the newest weekly export's `db.dump` after decrypting with
   `site/backup.js open`) into a **new** database; never over the damaged one.
3. Point `WTS_DB_URL` / `WTS_JOBS_DB_URL` at it.
4. **Replay the ledger before re-opening**: `node server/ops/ledger-replay.js` (credential `WTS_JOBS_DB_URL`) on the jobs
   host, where `site/objects-loader.js` reaches the production blob store through the same binding as the API
   (`site/objects-binding.js` or `WTS_OBJECTS_BINDING`, with `WTS_OBJECTS_CREDENTIAL`) — deleted accounts never come back.
   If the blob store was lost, decrypt the newest weekly export, write its `objects/ledger/*` entries into a folder as
   `ledger/<id>` and run the replay with `WTS_OBJECTS_DIR=<that folder>` (no binding configured) as well. Every weekly
   export carries the ledger and the anchors: `weekly-export.js` fails when no object store is configured, unless it is run
   with `--no-objects` on purpose (its manifest then says `objects: "none"` and it is not a complete §13.5 export).
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
- **"I have two accounts"** (no merge tool in v4.0): in the first account export everything, unlink its Google / LinkedIn
  identity, delete it; sign in to the second, *Import files to cloud…*, link the provider there. Revision history, the
  library document and devices do not travel.
- Other macros: conflict copies, a public computer's locked outbox, storage full, deletion cancel (sign in with the e-mail
  code within 7 days), export of a large account (one download per project above 200 MB), a DPA request.
- Every support action runs through an audited `ops/` script with actor `support:<id>`; never query user tables by hand.
