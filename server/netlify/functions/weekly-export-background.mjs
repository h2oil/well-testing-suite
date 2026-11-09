// server/netlify/functions/weekly-export-background.mjs — the weekly encrypted export (site/backup.js exportCopy as wts_backup,
// sealed to WTS_BACKUP_PUBLIC_KEY, written to the 'wts-exports' store, 28 days kept). The site holds only the PUBLIC key:
// it can write an export but never read one. A background function; only a signed call from weekly-export is run.
import nf from '../../site/netlify.js';

export default nf.backgroundFunction('weekly-export-background');

export const config = { region: 'lhr' };
