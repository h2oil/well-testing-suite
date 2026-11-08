# server/ — web accounts and cloud projects API

The functions-only site of docs/ACCOUNTS-PLAN.md (§2, §3, §13). It is never published as static content and never copied to
`ios-app/www`. Configuration comes only from environment variables (`core/config.js`; secrets never in the repository).
A missing or unknown `WTS_ENV` is treated as `production` (proxy signature required, production host only); `dev.js` and
the tests set it explicitly.

| Path | Contents |
|---|---|
| `core/contract.js` | the frozen API contract of §3 (endpoints, shapes, error codes, cookies) — shared with the client tests through `prism-build/tests/_acct-shapes.js` |
| `core/app.js`, `core/http.js` | the request pipeline and the §3.2 common rules, used by every adapter and by the fake server |
| `core/config.js`, `core/oidc-providers.js` | environment switches (`ACCOUNTS_SIGNUP`, `SYNC_MODE`, `ACCOUNTS_OFF`, `OAUTH_GOOGLE`, `OAUTH_LINKEDIN`) and the pinned provider configuration |
| `core/*.js` | canonical JSON, validation, errors, mail templates, the SQL adapter |
| `functions/` | one file per route group; WP0 stubs answer `501 not_implemented` |
| `db/migrations/` | `NNN-*.sql`, applied by `db/migrate.js`; `db/schema.sql` is a generated snapshot for review |
| `dev.js` | local runner on 127.0.0.1 (refuses `WTS_ENV=production`) |
| `test/` | `node test/run.js` boots a throwaway database cluster (port `WTS_TEST_DB_PORT`, default 54010), runs `node --test`, stops it; `--no-db` skips the database tests; `--schema` regenerates `db/schema.sql` |

```bash
cd server && npm ci && node test/run.js
```

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
