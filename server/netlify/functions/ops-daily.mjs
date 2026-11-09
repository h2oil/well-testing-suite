// server/netlify/functions/ops-daily.mjs — daily 03:17 UTC: starts ops-daily-background (the whole daily job of
// core/jobs.js may need more than the 30 s a scheduled function has) with a signed one-time call.
import nf from '../../site/netlify.js';

export default nf.scheduledFunction('ops-daily');

export const config = { schedule: '17 3 * * *', region: 'lhr' };
