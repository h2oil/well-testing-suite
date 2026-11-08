'use strict';
// server/test/_s1-shim.js — TEST-ONLY stand-ins for WP-S1 definer bodies that the WP-O tests need while WP-S1 is built in
// parallel (docs/ACCOUNTS-PLAN.md §3.4). WP-O SHIM — remove once WP-S1 has landed (see the WP-O merge note).
//
//   applyS1Shim(admin) → Promise<[names replaced]>
// Replaces a function ONLY while its body is still the WP0 stub (prosrc mentions _not_implemented), so once WP-S1's real
// bodies are migrated this file does nothing and the WP-O tests run against them. Never part of a migration.

const BODIES = {
  resolve_session: `
CREATE OR REPLACE FUNCTION wts.resolve_session(p_sid_hash bytea)
  RETURNS TABLE (user_id uuid, device_id uuid, public_device boolean, auth_at timestamptz, stepup_at timestamptz,
                 auth_method text, identity_id uuid, idle_expires_at timestamptz, abs_expires_at timestamptz, status text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp AS $$
BEGIN
  RETURN QUERY SELECT s.user_id, s.device_id, s.public_device, s.auth_at, s.stepup_at, s.auth_method, s.identity_id,
                      s.idle_expires_at, s.abs_expires_at, u.status
    FROM wts.sessions s JOIN wts.users u ON u.id = s.user_id
    WHERE s.sid_hash = p_sid_hash AND (s.replaced_at IS NULL OR s.replaced_at > now() - interval '30 seconds')
      AND s.idle_expires_at > now() AND s.abs_expires_at > now();
END $$;`,
  user_by_email: `
CREATE OR REPLACE FUNCTION wts.user_by_email(p_email_bidx bytea)
  RETURNS TABLE (user_id uuid, status text, role text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp AS $$
BEGIN
  RETURN QUERY SELECT u.id, u.status, CASE WHEN u.email_bidx = p_email_bidx THEN 'primary' ELSE 'recovery' END
    FROM wts.users u WHERE u.email_bidx = p_email_bidx OR u.recovery_bidx = p_email_bidx;
END $$;`,
  create_user: `
CREATE OR REPLACE FUNCTION wts.create_user(p_email_bidx bytea, p_email_enc bytea, p_signup_method text, p_terms_version text,
                                p_privacy_version text, p_consented_at timestamptz, p_data_key_wrapped bytea, p_kid int)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp AS $$
DECLARE v uuid := gen_random_uuid();
BEGIN
  IF EXISTS (SELECT 1 FROM wts.users WHERE email_bidx = p_email_bidx OR recovery_bidx = p_email_bidx) THEN RETURN NULL; END IF;
  INSERT INTO wts.users (id, email_bidx, email_enc, signup_method, terms_version, privacy_version, consented_at, data_key_wrapped, data_key_kid)
    VALUES (v, p_email_bidx, p_email_enc, p_signup_method, p_terms_version, p_privacy_version, p_consented_at, p_data_key_wrapped, p_kid);
  RETURN v;
END $$;`,
  code_issue: `
CREATE OR REPLACE FUNCTION wts.code_issue(p_email_bidx bytea, p_code_hmac bytea, p_pepper_kid int, p_purpose text, p_bound_user uuid,
                               p_bound_sid bytea, p_bound_attempt uuid, p_expires_at timestamptz, p_ip_prefix inet)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp AS $$
DECLARE v uuid := gen_random_uuid();
BEGIN
  UPDATE wts.email_codes SET invalidated_at = now() WHERE id IN (
    SELECT id FROM wts.email_codes WHERE email_bidx = p_email_bidx AND purpose = p_purpose
      AND bound_attempt IS NOT DISTINCT FROM p_bound_attempt AND used_at IS NULL AND invalidated_at IS NULL AND expires_at > now()
    ORDER BY expires_at DESC OFFSET 1);
  INSERT INTO wts.email_codes (id, email_bidx, code_hmac, pepper_kid, purpose, bound_user, bound_sid, bound_attempt, expires_at, ip_prefix)
    VALUES (v, p_email_bidx, p_code_hmac, p_pepper_kid, p_purpose, p_bound_user, p_bound_sid, p_bound_attempt, p_expires_at, p_ip_prefix);
  RETURN v;
END $$;`,
  code_check: `
CREATE OR REPLACE FUNCTION wts.code_check(p_email_bidx bytea, p_purpose text, p_code_hmacs bytea[], p_bound_user uuid, p_bound_sid bytea,
                               p_bound_attempt uuid)
  RETURNS TABLE (ok boolean, code_id uuid, attempts_left int) LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp AS $$
DECLARE v_hit uuid;
BEGIN
  SELECT c.id INTO v_hit FROM wts.email_codes c
    WHERE (p_email_bidx IS NULL OR c.email_bidx = p_email_bidx) AND c.purpose = p_purpose
      AND c.bound_user IS NOT DISTINCT FROM p_bound_user AND c.bound_sid IS NOT DISTINCT FROM p_bound_sid
      AND c.bound_attempt IS NOT DISTINCT FROM p_bound_attempt
      AND c.used_at IS NULL AND c.invalidated_at IS NULL AND c.expires_at > now() AND c.code_hmac = ANY (p_code_hmacs)
    LIMIT 1;
  IF v_hit IS NOT NULL THEN
    UPDATE wts.email_codes SET used_at = now() WHERE id = v_hit;
    UPDATE wts.email_codes c SET invalidated_at = now()
      WHERE c.id <> v_hit AND c.purpose = p_purpose AND c.bound_attempt IS NOT DISTINCT FROM p_bound_attempt
        AND (p_email_bidx IS NULL OR c.email_bidx = p_email_bidx) AND c.used_at IS NULL AND c.invalidated_at IS NULL;
    RETURN QUERY SELECT true, v_hit, 0;
    RETURN;
  END IF;
  UPDATE wts.email_codes c SET attempts = c.attempts + 1,
      invalidated_at = CASE WHEN c.attempts + 1 >= 5 THEN now() ELSE NULL END
    WHERE (p_email_bidx IS NULL OR c.email_bidx = p_email_bidx) AND c.purpose = p_purpose
      AND c.bound_attempt IS NOT DISTINCT FROM p_bound_attempt AND c.used_at IS NULL AND c.invalidated_at IS NULL AND c.expires_at > now();
  RETURN QUERY SELECT false, NULL::uuid, 0;
END $$;`,
  allowlist_has: `
CREATE OR REPLACE FUNCTION wts.allowlist_has(p_email_bidx bytea) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp AS $$
BEGIN RETURN EXISTS (SELECT 1 FROM wts.signup_allowlist WHERE email_bidx = p_email_bidx); END $$;`,
  rate_hit: `
CREATE OR REPLACE FUNCTION wts.rate_hit(p_bucket text, p_window interval, p_limit bigint)
  RETURNS TABLE (allowed boolean, n bigint, retry_after int) LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp AS $$
DECLARE v bigint; w timestamptz := date_bin(p_window, now(), timestamptz '2000-01-01 00:00:00+00');
BEGIN
  INSERT INTO wts.rate_counters AS r (bucket, window_start, n) VALUES (p_bucket, w, 1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET n = r.n + 1 RETURNING r.n INTO v;
  RETURN QUERY SELECT v <= p_limit, v, GREATEST(1, ceil(extract(epoch FROM (w + p_window - now())))::int);
END $$;`,
  mail_queue: `
CREATE OR REPLACE FUNCTION wts.mail_queue(p_to_enc bytea, p_template text, p_params_enc bytea) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp AS $$
DECLARE v uuid := gen_random_uuid();
BEGIN INSERT INTO wts.mail_outbox (id, to_enc, template, params_enc, created_at) VALUES (v, p_to_enc, p_template, p_params_enc, now()); RETURN v; END $$;`,
};

async function applyS1Shim(admin) {
  const sql = admin.sql || admin;
  const replaced = [];
  for (const name of Object.keys(BODIES)) {
    const r = await sql`select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'wts' and p.proname = ${name}`;
    if (!r.length || !/_not_implemented/.test(r[0].prosrc)) continue;
    await sql.unsafe(BODIES[name]);
    replaced.push(name);
  }
  return replaced;
}

module.exports = { applyS1Shim, BODIES };
