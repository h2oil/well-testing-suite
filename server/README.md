# server/ — web accounts and cloud projects API

The functions-only site of docs/ACCOUNTS-PLAN.md (§2, §3, §13). It is never published as static content and never copied to
`ios-app/www`. Configuration comes only from environment variables (`core/config.js`; secrets never in the repository).
A missing or unknown `WTS_ENV` is treated as `production` (proxy signature required, production host only); `dev.js` and
the tests set it explicitly. Without a database, keys or a blob store every data route answers `503 paused`, so a site with
no server configured behaves exactly as v3.4 (the page's cloud UI stays hidden unless the server answers).

| Path | Contents |
|---|---|
| `core/contract.js` | the frozen API contract of §3 (endpoints, shapes, error codes, cookies) — shared with the client tests through `prism-build/tests/_acct-shapes.js` |
| `core/app.js`, `core/http.js` | the request pipeline and the §3.2 common rules, used by every adapter and by the fake server; `ctx.after(fn)` runs after the response (queued mail) through the host's background facility |
| `core/config.js`, `core/oidc-providers.js` | environment switches (`ACCOUNTS_SIGNUP`, `SYNC_MODE`, `ACCOUNTS_OFF`, `OAUTH_GOOGLE`, `OAUTH_LINKEDIN`) and the pinned provider configuration |
| `core/keys.js`, `core/envelope.js` | key material from the environment (master keys by kid, index and code peppers); envelope encryption: per-user key ring (kid / dkv), fields, system values, blob chunks with the §3.4 AAD |
| `core/session.js` | sessions for every sign-in method: resolve (30 s rotation grace), idle slide, `withSession` with step-up (`stepup_at` only from an e-mail code), `issue`, `rotate`, `revokePresented` — WP-O issues provider sessions through `issue({method, identityId, stepup:false})` |
| `core/mail.js` | mail templates and their plain-text bodies (`render` / `compose`: the §4.1 code text, the §4.3 revert notice, the §8.5 deletion notice; generic browser / OS words only, never a client string); the memory transport for tests — the host transport (WP-OPS) receives `{to, subject, text, template, params}` |
| `core/service.js` | one transaction per request as `wts_api` with `app.user_id`; mail queued in it (outbox row) and sent after the commit; devices by `(user, id)` |
| `core/rate.js`, `core/revisions.js`, `core/blobstore.js`, `core/objects.js` | §8.3 limits in fixed windows; revision retention; content-addressed immutable chunks and quota; the blob store seam (memory and folder stores; the host adapter is WP-OPS) |
| `core/jobs.js`, `core/ops.js` | the daily job (§3.5: purges, outbox retry, trash, blobs, account purge + ledger, inactivity, quota, audit check + anchor), ledger replay; audited support operations and master-key rewrap |
| `core/oidc.js`, `core/oauth-store.js` | provider sign-in (WP-O): authorization URL, PKCE, code exchange, RS256 id_token checks on built-in crypto, signing-key cache, breaker policy; the definer calls for attempts, identities, keys, ceilings and the breaker |
| `functions/` | one file per route group (provider sign-in in `functions/oauth.js`); passkeys (Phase 3) still answer `501 not_implemented` |
| `ops/` | audited support / incident scripts (`lookup`, `allowlist-add`, `security-reset`, `recover`, `rewrap`, `ledger-replay`, `retire-client` — remove every identity of a provider before a new client goes live, §4.14) — credentials from the environment only, output ids and counts only |
| `db/migrations/` | `NNN-*.sql`, applied by `db/migrate.js` (`001-schema.sql` WP0, `002-core.sql` WP-S1, `040-oauth.sql` WP-O, `050-code-scope.sql`; `--platform` for a one-login host); `db/schema.sql` is a generated snapshot for review |
| `dev.js` | local runner on 127.0.0.1 (refuses `WTS_ENV=production`; a local database when `WTS_DB_URL` is set) |
| `test/` | `node test/run.js` boots a throwaway database cluster (port `WTS_TEST_DB_PORT`, default 54010), runs `node --test`, stops it; `--no-db` skips the database tests; `--schema` regenerates `db/schema.sql`; `test/e2e.test.js` runs the real page (built in memory by the acceptance harness) against the real pipeline on the database with the fake providers and mail (sign-up, cloud save / open / history / restore / export, Google and LinkedIn sign-in, link / unlink, public-computer wipe, deletion grace and purge, the dev server over HTTP, no-server behaviour and the iOS strip) |

Environment (secrets marked *): `WTS_DB_URL`*, `WTS_JOBS_DB_URL`* (the scheduled function only), `WTS_MASTER_KEYS`*
(`kid:base64,…`), `WTS_MASTER_KID`, `WTS_INDEX_PEPPER`*, `WTS_CODE_PEPPERS`* (`kid:base64,…`, the previous one kept during a
rotation), `WTS_PROXY_SIG`*, `WTS_OPS_HMAC`*, `WTS_MAIL_CREDENTIAL`*, `WTS_CODE_FLOOR_MS` (code/start floor, 400 ms in
production), the kill switches and the provider client ids / secrets* (WP-O). The ops scripts also read `WTS_SUPPORT_DB_URL`*.
v4.0 adds `WTS_DB_ROLE` (only `wts_api`; forced on Netlify), `WTS_BACKUP_PUBLIC_KEY` (the export is sealed to it; not secret),
`WTS_BACKUP_PRIVATE_KEY`* (off every site: offline and the drill machine), `WTS_BLOBS_SITE_ID` / `WTS_BLOBS_STORE` (scripts
outside the site) and reads the platform's `NETLIFY_DB_URL` (see "Hosting").

```bash
cd server && npm ci && node test/run.js
```

## Hosting (v4.0: Netlify)

The functions-only site runs on Netlify as a **second site** of the same team as the static site, with base directory
`server` (`netlify.toml` here; the repository root carries no configuration for it). Owner steps: `RUNBOOK.md`, "Switch it on
with Netlify".

| Piece | Where |
|---|---|
| Site configuration | `netlify.toml` (publish `public/` = robots.txt only, functions `netlify/functions`, Node 22, `nft` bundler); the build command `node site/netlify-check.js` refuses a bundle that breaks the rules |
| Functions | `netlify/functions/*.mjs`, one line each around `site/netlify.js`: `api` (`/api/v1/*` → `site/handler.js`), `ops-purge` (hourly, purges + mail retry), `ops-daily` → `ops-daily-background` (the daily job, 15 min), `weekly-export` → `weekly-export-background`; the scheduled ones start their background function with a signed one-time call (`WTS_OPS_HMAC`, nonce in `ops_nonces`) |
| Database | Netlify Database through the existing `core/db.js` seam and the same driver (`NETLIFY_DB_URL`, TLS verify-full, `channel_binding` dropped); migrations by `node db/migrate.js --platform` from the tagged release workflow (`WTS_MIGRATE_DB_URL` = the production connection string) — the platform's own migrations folder is not used |
| Blob store | Netlify Blobs (`site/netlify-blobs.js`): stores `wts-objects` and `wts-exports`, region `eu-central-1` on every call, strong consistency, behind `site/adapters.js hostObjects()` |
| Proxy rule | the MAIN site's `netlify.toml` from `node site/proxy-rule.js --snippet <functions-site>.netlify.app`; its build fills the signature in from the main site's `WTS_PROXY_SIG` |
| Secrets | `node ops/keygen.js` prints every value in the form `core/config.js` reads; all live only in the sites' environment variables |
| Defaults on the platform | `WTS_MIN_CLIENT` 4.0, `WTS_VERSION` = `package.json` version (4.0.0), `WTS_HOST_HEADER` x-wts-host, `WTS_CLIENT_IP_HEADER` x-nf-client-connection-ip (`site/netlify.js platformEnv`) |
| Tests | `test/netlify.test.js` (entries, configs, blobs region / consistency, kick, proxy rule, keygen, URL rules — no network) and `test/netlify-db.test.js` (a non-superuser owner login on the throwaway cluster: migration, role switching under forced RLS, jobs, COPY export and restore drill) |

### Deviations from the plan (recorded in docs/ACCOUNTS-PLAN.md, Appendix B.4)

1. **One database login, separate roles kept by switching.** The platform hands out one login (the database owner); it cannot
   give `wts_api`, `wts_jobs` and `wts_support` their own credentials (D12). The roles, grants, `FORCE ROW LEVEL SECURITY` and
   the `wts_definer` functions are unchanged; instead every request transaction starts with `SET LOCAL ROLE wts_api`
   (`core/db.js`, transaction-scoped, so a pooled connection never keeps it), and the jobs, the export and the support scripts
   connect with the start-up role `wts_jobs` / `wts_backup` / `wts_support` (a login that is not a member cannot connect). What
   is lost: a stolen request credential is now the owner credential (it could `RESET ROLE`); the code never builds SQL from
   input (tagged templates only) and the role name is checked against `^wts_[a-z]+$`. `db/migrate.js --platform` grants the
   roles to the login (owner and definer inherited, as a superuser migrator would act; the run-time roles SET only) and
   refuses to start unless the login can create roles and BYPASSRLS roles (`loginReport`). **Probe before go-live** (RUNBOOK
   step 7): if the platform login cannot create BYPASSRLS roles, the fallback is permissive policies `TO wts_definer` /
   `TO wts_jobs` instead of the BYPASSRLS attribute — a new migration, written only if the probe fails.
2. **Ownership changes need CREATE.** A non-superuser may give a function to `wts_definer` only while that role can create in
   the schema: 001, 002 and 040 lend `CREATE ON SCHEMA wts` to `wts_definer` around the ownership change and take it back
   (unreleased migrations; a superuser migrator sees no difference).
3. **Weekly export without a dump tool, sealed to a public key.** A function has no `pg_dump`, and `isolation.js` keeps every
   key that can READ an export off the functions site. The export there is a `COPY` of every table in one REPEATABLE READ,
   READ ONLY transaction as `wts_backup`, packed with the same manifest (row counts, audit digest, migrations, ledger and anchor
   objects, blob manifest) and sealed with an ephemeral X25519 key agreement to `WTS_BACKUP_PUBLIC_KEY` (format `WTSX2`). Only
   `WTS_BACKUP_PRIVATE_KEY` (offline, and on the drill machine) opens it; `ops/restore-drill.js` restores either format
   (`--from-store` reads the newest export). The export lives in the `wts-exports` store in the **same** region
   (`eu-central-1`; there is no other EU region for Blobs), not "another region": the owner downloads one export a month to
   offline storage (RUNBOOK §9) and the platform's own database backups add a second copy.
4. **Regions.** Functions in London (`lhr`) need the Pro plan; on Personal they and the database run in the United States
   (Ohio) — an owner decision recorded in RUNBOOK step 1. Blobs have no London region: `eu-central-1` (Frankfurt).
5. **Previews.** A deploy preview of a site with a database gets a copy of the production data: deploy previews and branch
   deploys are off and builds are stopped; releases come only from `server-v*` tags (`WTS_DEPLOY_COMMAND` = the pinned CLI).
6. **Proxy signature through a build-time substitution.** Netlify sets request headers on a proxy rule only in `netlify.toml`,
   which cannot read variables; the main site's build writes the value into its (unpublished) `netlify.toml`. The original host
   travels as the fixed header `X-WTS-Host`, trusted only together with a valid signature. Unverified until the live check of
   RUNBOOK step 11: which client address the functions site sees behind the rewrite (`x-nf-client-connection-ip`).
7. **Client version.** `functions/projects.js` now reads a leading "v" ("v4.0", as the page sends `RELEASE_NOTES[0].ver`); before,
   such a header switched the 426 gate off.

## Provider sign-in open items (lead decisions, kept at the integration)

- **Provider sign-out link (§11.2)**: the blocking provider sign-out step gives text instructions only. A link needs a
  `signOutUrl` per provider in `core/oidc-providers.js` carried in `GET /auth/providers` (a contract change), or §11.2 is
  amended to accept the text.
- **Resend in the provider code step**: there is no "Send again" (the finish contract has no resend body). The step shows the
  "Didn't get the code?" help and a Close; a new code comes from a new provider start.
- **Finish dialog host**: the provider finish steps keep their own `#acct_oauth_dlg` (focus move, Tab trap, focus return; the
  blocking sign-out step ignores Escape). A done sign-in closes it and completes through WP-C1's `completeSignIn`, whose
  dialog asks the hand-over question; the `providerEmailDiffers` note reopens it afterwards.
- **Settled at the integration**: one audit hash — the `audit_chain` trigger of `002-core.sql` (every writer, also
  `support_retire_identities`, inserts an empty hash and the trigger chains it); the retire-client notices are queued by
  `ops/retire-client.js` with the jobs credential (`keys.system.seal('mail.to', …)`, the one outbox format) and sent by the
  daily job; the signing-key refetch limit is one fetch per provider per fixed 5-minute window across instances
  (`oidc_fetch_claim`) plus each instance's in-memory limit (§4.11).

## Operations (WP-OPS)

`RUNBOOK.md` is the operations handbook (owner's activation checklist, releases, alerts, kill switches, incidents, security
reset, key rotation and compromise, backups and restore, support). `site/` holds the functions-only site: `handler.js` (the
host adapter for `/api/v1/*`), `isolation.js` (preview isolation), `monitor.js` (access lines and the §13.6 alert table),
`adapters.js` (blob store and e-mail bindings), `objects-loader.js` (the one blob-store choice for the API, the weekly
export and the ledger replay), `backup.js` (weekly encrypted export and restore drill), `build.js`
(`server/dist`, one function in `dist/entry/`) and `site.json`. `ops/` adds `weekly-export.js`, `restore-drill.js`, `monitor-check.js`,
`call-daily.js` and `sql/backup-role.sql`; `ci/secret-scan.js` is the secret scan. The release workflow
`.github/workflows/server-release.yml` runs only on `server-v*` tags and skips its migration and deploy steps until the owner
adds their secrets. The static site's allow-list is `prism-build/publish-site.js` (`--check`), the account-block digest
`prism-build/acct-hash.js`.
