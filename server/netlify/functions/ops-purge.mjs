// server/netlify/functions/ops-purge.mjs — hourly: the short jobs of core/jobs.js (purge of expired codes, attempts, sessions,
// counters and nonces; retry of unsent mail) as wts_jobs. Runs only on the published production deploy (UTC schedule).
import nf from '../../site/netlify.js';

export default nf.scheduledFunction('ops-purge');

export const config = { schedule: '23 * * * *', region: 'lhr' };
