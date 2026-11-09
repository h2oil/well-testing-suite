// server/netlify/functions/weekly-export.mjs — Sundays 04:41 UTC: starts weekly-export-background with a signed one-time call.
import nf from '../../site/netlify.js';

export default nf.scheduledFunction('weekly-export');

export const config = { schedule: '41 4 * * 0' };
