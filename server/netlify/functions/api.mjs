// server/netlify/functions/api.mjs — every /api/v1/* request (site/netlify.js apiFunction → site/handler.js → core/app.js).
// The config below is read by the platform at deploy time and must stay a literal (test/netlify.test.js compares it).
import nf from '../../site/netlify.js';

export default nf.apiFunction();

export const config = { path: '/api/v1/*', region: 'lhr' };
