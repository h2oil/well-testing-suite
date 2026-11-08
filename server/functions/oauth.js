'use strict';
// server/functions/oauth.js — provider sign-in (docs/ACCOUNTS-PLAN.md §4.10–4.15): GET /auth/providers, start, callback,
// finish. WP-O builds start / callback / finish on core/oidc.js; the foundation already answers:
//   • GET /auth/providers from the kill switches (OAUTH_GOOGLE / OAUTH_LINKEDIN, off unless configured; both off on the
//     production host when the pins fail or WTS_OIDC_MODE is set — config.js),
//   • the callback with the constant 303 to <APP_URL>#acct-oauth whatever the query holds (core/app.js; no attempt is read),
//   • start: 503 provider_off for a provider that is off, else 501 not_implemented; finish: 501 not_implemented.

const { fail } = require('../core/errors');

module.exports = {
  handlers: {
    providers(ctx) { return { status: 200, body: ctx.config.providerSwitches() }; },
    oauthStart(ctx) {
      const p = ctx.params.provider;
      if (ctx.config.providerSwitches()[p] === 'off') fail('provider_off', { provider: p });
      fail('not_implemented');
    },
    oauthCallback() { return { status: 303 }; },
    oauthFinish() { fail('not_implemented'); },
  },
};
