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
| `core/oidc.js`, `core/oauth-store.js` | provider sign-in (WP-O): authorization URL, PKCE, code exchange, RS256 id_token checks on built-in crypto, signing-key cache, breaker policy; the definer calls for attempts, identities, keys, ceilings and the breaker |
| `core/wpo-s1.js` | WP-O shim for the WP-S1 helpers it needs (sessions, codes, account lookups, audit, mail, envelope); replaced by WP-S1's modules at the merge |
| `ops/retire-client.js` | audited support script: remove every identity of a provider before a new client goes live (§4.14) |
| `core/*.js` | canonical JSON, validation, errors, mail templates, the SQL adapter |
| `functions/` | one file per route group; WP0 stubs answer `501 not_implemented` |
| `db/migrations/` | `NNN-*.sql`, applied by `db/migrate.js`; `db/schema.sql` is a generated snapshot for review |
| `dev.js` | local runner on 127.0.0.1 (refuses `WTS_ENV=production`) |
| `test/` | `node test/run.js` boots a throwaway database cluster (port `WTS_TEST_DB_PORT`, default 54010), runs `node --test`, stops it; `--no-db` skips the database tests; `--schema` regenerates `db/schema.sql` |

```bash
cd server && npm ci && node test/run.js
```
