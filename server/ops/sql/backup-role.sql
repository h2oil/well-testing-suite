-- server/ops/sql/backup-role.sql — the read-only export role of the weekly encrypted export (docs/ACCOUNTS-PLAN.md §13.5;
-- server/RUNBOOK.md "Backups"). Applied ONCE by the owner as the database administrator, after the migrations; it is not a
-- migration (the role is an operations credential, its password is set out of band and stored only as WTS_BACKUP_DB_URL in
-- the jobs host's environment). The role reads every table (BYPASSRLS, so the dump is complete under forced row-level
-- security) and can change nothing — as its OWN login (generic host). On a one-login host (v4.0, server/README.md "Hosting")
-- the export connects as the platform's owner login with the start-up role wts_backup: that connection can SET ROLE back to
-- the login or to wts_owner, so there "read-only" is a property of the code, not enforced by the credential (plan B.4 item 1).
-- Idempotent.

DO $backup$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wts_backup') THEN
    CREATE ROLE wts_backup LOGIN BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$backup$;

GRANT USAGE ON SCHEMA wts TO wts_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA wts TO wts_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA wts TO wts_backup;
GRANT SELECT ON public.wts_schema_migrations TO wts_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE wts_owner IN SCHEMA wts GRANT SELECT ON TABLES TO wts_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE wts_owner IN SCHEMA wts GRANT SELECT ON SEQUENCES TO wts_backup;
