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

## WP-O open items (for the lead; recorded at the WP-O fix round)

- **Provider sign-out link (§11.2)**: the blocking provider sign-out step gives text instructions only. A link needs a
  `signOutUrl` per provider in `core/oidc-providers.js` carried in `GET /auth/providers` (a contract change), or §11.2 is
  amended to accept the text. Lead decision.
- **Resend in the provider code step**: there is no "Send again" (the finish contract has no resend body). The step shows the
  "Didn't get the code?" help and a Close; a new code comes from a new provider start. A resend needs a lead-approved finish body.
- **Finish dialog host**: 66 keeps its own focus move, Tab trap and focus return on the `#acct_oauth_dlg` div until WP-C1's
  `<dialog>` lands; then these steps move into it (WP-C1 owns focus handling). The A → B hand-over dialog, the 390 px layout
  check beyond style strings and "analytics guard skipped on the return" (the guard is WP-C1 / WP-H code) are asserted then.
- **Audit chain at the WP-S1 merge**: the one hash is `sha256(prev ‖ action|canonical(detail)|toISOString(at))`
  (`core/wpo-s1.js` `auditHash` / `verifyAuditChain`; `support_retire_identities` writes the same form). WP-S1's audit writer
  must use it, or both move to WP-S1's definer; `oauth-api.test.js` verifies a chain across the SQL and JS writers.
- **Outbox contract at the WP-S1 merge**: `support_retire_identities` queues its notice through `wts.mail_queue` with
  `to_enc` = the account's `users.email_enc` envelope; WP-S1's drainer must open `to_enc` with that AAD (tested against the shim).
- **Signing-key refetch limit**: one fetch per provider per fixed 5-minute window across instances (`oidc_fetch_claim`, a
  `rate_counters` row), plus each instance's in-memory limit (§4.11).
