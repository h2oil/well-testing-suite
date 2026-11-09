// server/netlify/functions/ops-daily-background.mjs — the daily job (core/jobs.js runDaily: purges, mail retry, trash,
// revision pruning, blobs, account purge + ledger, inactivity, quota, audit check + anchor) as wts_jobs, and the weekly
// export age check. A background function (the "-background" name): 15 minutes; only a signed call from ops-daily is run.
import nf from '../../site/netlify.js';

export default nf.backgroundFunction('ops-daily-background');
