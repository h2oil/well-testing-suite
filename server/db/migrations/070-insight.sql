-- server/db/migrations/070-insight.sql — richer admin insight (v4.0 follow-up; server/RUNBOOK.md "Admin dashboard").
-- Expand-only on top of 060:
--   users.profile_enc     the optional profile the account holder gives at sign-up or on the Account page (full name, company,
--                         job title, country, phone) as JSON sealed with the account's own data key (envelope field
--                         'user.profile'); NULL = none. wts_api may update it on its own row only (forced RLS, own_rows).
--   projects.summary_enc  the latest summary the page sent with a Save to cloud (well names, client, operator, company, field,
--   projects.summary_at   rig, country, job reference, modules used, project name) as JSON sealed with the owner's data key
--                         (envelope field 'project.summary'), and when it was stored. The table grant of 001 already covers
--                         the new columns for wts_api (own rows only).
--   Definer functions for the admin routes (functions/admin.js), each guarded by _admin_check(admins) of 060:
--     admin_insight(admins, ids)          → per account: data_key_wrapped, profile_enc, the summaries of its live projects
--                                           (newest first, ≤ 200), the time of its newest live project and the Privacy
--                                           notice version it accepted (the handler shows profile / summaries only under the
--                                           current one); ids NULL = every
--                                           account (the summary page), else only those (one page of the users list)
--     admin_user_get(admins, id)          → the admin_users row of one account (+ profile_enc, privacy_version), or no row
--     admin_user_projects(admins, id)     → that account's live projects: id, meta_enc, summary_enc, summary_at, modified_at,
--                                           head_bytes (≤ 200, newest first); the handler opens them with the account's key ring
-- Every function: SECURITY DEFINER, SET search_path = wts, pg_temp, owner wts_definer, EXECUTE for wts_api only.

SET LOCAL search_path = wts, pg_temp;

-- ── expand: columns ─────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE wts.users ADD COLUMN profile_enc bytea;
ALTER TABLE wts.users ADD CONSTRAINT users_profile_enc_check CHECK (octet_length(profile_enc) BETWEEN 1 AND 4096);
GRANT UPDATE (profile_enc) ON wts.users TO wts_api;
ALTER TABLE wts.projects ADD COLUMN summary_enc bytea, ADD COLUMN summary_at timestamptz;
ALTER TABLE wts.projects ADD CONSTRAINT projects_summary_enc_check CHECK (octet_length(summary_enc) BETWEEN 1 AND 32768);

-- ── admin definers ──────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION wts.admin_insight(p_admins bytea[], p_ids uuid[])
  RETURNS TABLE (user_id uuid, data_key_wrapped bytea, profile_enc bytea, summaries bytea[], last_project_at timestamptz, privacy_version text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  PERFORM wts._admin_check(p_admins);
  RETURN QUERY
    SELECT u.id, u.data_key_wrapped, u.profile_enc,
           coalesce((SELECT array_agg(x.summary_enc ORDER BY x.modified_at DESC)
                       FROM (SELECT p.summary_enc, p.modified_at FROM wts.projects p
                              WHERE p.user_id = u.id AND p.deleted_at IS NULL AND p.summary_enc IS NOT NULL
                              ORDER BY p.modified_at DESC LIMIT 200) x), '{}'::bytea[]),
           (SELECT max(p.modified_at) FROM wts.projects p WHERE p.user_id = u.id AND p.deleted_at IS NULL),
           u.privacy_version::text
      FROM wts.users u
     WHERE p_ids IS NULL OR u.id = ANY (p_ids)
     ORDER BY u.created_at DESC, u.id DESC
     LIMIT 10000;
END $$;

CREATE FUNCTION wts.admin_user_get(p_admins bytea[], p_id uuid)
  RETURNS TABLE (id uuid, email_enc bytea, data_key_wrapped bytea, signup_method text, status text, created_at timestamptz,
                 last_sign_in_at timestamptz, signup_country text, last_country text, last_city text, projects bigint, used_bytes bigint,
                 profile_enc bytea, privacy_version text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  PERFORM wts._admin_check(p_admins);
  RETURN QUERY
    SELECT u.id, u.email_enc, u.data_key_wrapped, u.signup_method, u.status, u.created_at, u.last_sign_in_at,
           u.signup_country::text, u.last_country::text, u.last_city,
           (SELECT count(*) FROM wts.projects p WHERE p.user_id = u.id AND p.deleted_at IS NULL), u.used_bytes, u.profile_enc,
           u.privacy_version::text
      FROM wts.users u
     WHERE u.id = p_id;
END $$;

CREATE FUNCTION wts.admin_user_projects(p_admins bytea[], p_id uuid)
  RETURNS TABLE (id uuid, meta_enc bytea, summary_enc bytea, summary_at timestamptz, modified_at timestamptz, head_bytes bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  PERFORM wts._admin_check(p_admins);
  RETURN QUERY
    SELECT p.id, p.meta_enc, p.summary_enc, p.summary_at, p.modified_at, p.head_bytes::bigint
      FROM wts.projects p
     WHERE p.user_id = p_id AND p.deleted_at IS NULL
     ORDER BY p.modified_at DESC, p.id DESC
     LIMIT 200;
END $$;

RESET search_path;

-- owner and grants for the new functions (as in 060: CREATE is lent to wts_definer for the ownership change only)
GRANT CREATE ON SCHEMA wts TO wts_definer;
ALTER FUNCTION wts.admin_insight(bytea[], uuid[]) OWNER TO wts_definer;
ALTER FUNCTION wts.admin_user_get(bytea[], uuid) OWNER TO wts_definer;
ALTER FUNCTION wts.admin_user_projects(bytea[], uuid) OWNER TO wts_definer;
REVOKE CREATE ON SCHEMA wts FROM wts_definer;
REVOKE EXECUTE ON FUNCTION wts.admin_insight(bytea[], uuid[]), wts.admin_user_get(bytea[], uuid), wts.admin_user_projects(bytea[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wts.admin_insight(bytea[], uuid[]), wts.admin_user_get(bytea[], uuid), wts.admin_user_projects(bytea[], uuid) TO wts_api;
