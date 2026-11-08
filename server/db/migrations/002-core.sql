-- server/db/migrations/002-core.sql — WP-S1: the server core (docs/ACCOUNTS-PLAN.md §3.4, §3.5, §4.1–4.9, §8.3, §8.5, §13.5).
-- Expand-only on top of 001: new nullable / defaulted columns, the audit hash chain and blob reference-count triggers, the
-- bodies of the definer functions of the e-mail code, session, address, rate, mail, deletion and support paths, and a few
-- new definers for tables that wts_api cannot write. The provider definers (user_by_identity, oauth_attempt_*,
-- identity_link / touch / unlink, oidc_key_*) stay with WP-O and are not touched here.
--
-- Conventions of every function below: SECURITY DEFINER, SET search_path = wts, pg_temp, owned by wts_definer (BYPASSRLS),
-- EXECUTE for one role only; every function that acts on one account takes p_user_id and refuses unless it equals the
-- transaction's app.user_id (wts.current_user_id()), so a handler can only ever act on the account of its own session.
-- Times come from the database clock (now()), never from the caller, so a skewed function instance cannot extend a code,
-- a revert window or a grace period.

SET LOCAL search_path = wts, pg_temp;

-- ── expand: columns ─────────────────────────────────────────────────────────────────────────────────────────────
-- users: the address waiting for its code (e-mail change, recovery add; encrypted with the user's data key), the library
-- save time
ALTER TABLE wts.users ADD COLUMN email_pending_enc bytea, ADD COLUMN recovery_pending_enc bytea, ADD COLUMN lib_saved_at timestamptz;
-- sessions: the export read-rate unlock (§8.3: 300 MB/h for 2 h in this session after an export step-up)
ALTER TABLE wts.sessions ADD COLUMN read_unlock_until timestamptz;
-- blobs: per-chunk SHA-256 (hex, index n+1) for the immutability check, bytes received so far, and when the reference count
-- last reached 0 (deleted by the daily job 7 days later)
ALTER TABLE wts.blobs ADD COLUMN chunk_sha text[] NOT NULL DEFAULT '{}', ADD COLUMN stored_bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN unref_at timestamptz;
-- revisions: a burst pin lasts 7 days
ALTER TABLE wts.revisions ADD COLUMN pinned_until timestamptz;
CREATE INDEX revisions_user ON wts.revisions (user_id);
-- e-mail codes: the 7-day revert code of an e-mail change (§4.3) is a code row like the others
ALTER TABLE wts.email_codes DROP CONSTRAINT email_codes_purpose_check;
ALTER TABLE wts.email_codes ADD CONSTRAINT email_codes_purpose_check
  CHECK (purpose IN ('signin','stepup','email_change','recovery_add','oauth_verify','link_confirm','email_revert'));

GRANT UPDATE (email_pending_enc, recovery_pending_enc, lib_saved_at) ON wts.users TO wts_api;

-- ── audit hash chain (§3.4 audit, §13.5 anchor) ─────────────────────────────────────────────────────────────────
-- hash = SHA-256(prev_hash ‖ canonical row text). user_id is NOT in the hashed text: a purge replaces it by a random tombstone
-- (§8.5) and the chain must still verify. One chain per user_id (NULL = the system chain). The insert takes a per-chain
-- advisory lock, then reads the chain head in a fresh snapshot, so concurrent inserts never fork a chain.
CREATE FUNCTION wts.audit_row_text(p_actor text, p_action text, p_target text, p_device_id uuid, p_ip_prefix inet,
                                   p_ua_family text, p_at timestamptz, p_detail jsonb)
  RETURNS text LANGUAGE sql IMMUTABLE SET search_path = wts, pg_temp
  AS $$ SELECT concat_ws('|', 'wts-audit-1', p_actor, p_action, coalesce(p_target, ''), coalesce(p_device_id::text, ''),
                         coalesce(p_ip_prefix::text, ''), coalesce(p_ua_family, ''),
                         to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), coalesce(p_detail::text, '')) $$;
CREATE FUNCTION wts.audit_row_hash(p_prev bytea, p_actor text, p_action text, p_target text, p_device_id uuid, p_ip_prefix inet,
                                   p_ua_family text, p_at timestamptz, p_detail jsonb)
  RETURNS bytea LANGUAGE sql IMMUTABLE SET search_path = wts, pg_temp
  AS $$ SELECT sha256(coalesce(p_prev, ''::bytea) || convert_to(wts.audit_row_text(p_actor, p_action, p_target, p_device_id,
                         p_ip_prefix, p_ua_family, p_at, p_detail), 'UTF8')) $$;
CREATE FUNCTION wts.audit_chain_trg() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
DECLARE v_prev bytea;
BEGIN
  IF NEW.actor IS NULL OR NEW.actor !~ '^(user|system|support:[a-z0-9_-]{1,32})$' THEN
    RAISE EXCEPTION 'audit: bad actor' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wts.audit:' || coalesce(NEW.user_id::text, 'system'), 0));
  SELECT a.hash INTO v_prev FROM wts.audit a WHERE a.user_id IS NOT DISTINCT FROM NEW.user_id
    AND NOT EXISTS (SELECT 1 FROM wts.audit b WHERE b.prev_hash = a.hash AND b.user_id IS NOT DISTINCT FROM NEW.user_id)
    ORDER BY a.id DESC LIMIT 1;
  NEW.at := coalesce(NEW.at, now());
  NEW.prev_hash := v_prev;
  NEW.hash := wts.audit_row_hash(v_prev, NEW.actor, NEW.action, NEW.target, NEW.device_id, NEW.ip_prefix, NEW.ua_family, NEW.at, NEW.detail);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_chain BEFORE INSERT ON wts.audit FOR EACH ROW EXECUTE FUNCTION wts.audit_chain_trg();
-- the chain is append-only for request handlers (wts_api has SELECT, INSERT only); the hashed columns never change
CREATE FUNCTION wts.audit_guard_trg() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  IF NEW.actor IS DISTINCT FROM OLD.actor OR NEW.action IS DISTINCT FROM OLD.action OR NEW.target IS DISTINCT FROM OLD.target
     OR NEW.device_id IS DISTINCT FROM OLD.device_id OR NEW.ip_prefix IS DISTINCT FROM OLD.ip_prefix
     OR NEW.ua_family IS DISTINCT FROM OLD.ua_family OR NEW.at IS DISTINCT FROM OLD.at OR NEW.detail IS DISTINCT FROM OLD.detail
     OR NEW.prev_hash IS DISTINCT FROM OLD.prev_hash OR NEW.hash IS DISTINCT FROM OLD.hash THEN
    RAISE EXCEPTION 'audit: rows are append-only (only the purge tombstone may change user_id)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_guard BEFORE UPDATE ON wts.audit FOR EACH ROW EXECUTE FUNCTION wts.audit_guard_trg();

-- ── blob reference counts (§3.4: a blob whose refcount reaches 0 is deleted after 7 days) ──────────────────────────
-- Every revision references its core and its parts once each (deduplicated within the revision).
CREATE FUNCTION wts.revisions_refs_trg() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
DECLARE r record; d int; h bytea;
BEGIN
  IF TG_OP = 'INSERT' THEN r := NEW; d := 1; ELSE r := OLD; d := -1; END IF;
  FOR h IN SELECT DISTINCT x FROM (SELECT r.core_hash AS x
             UNION SELECT decode(p->>'hash', 'hex') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.parts) = 'array' THEN r.parts ELSE '[]'::jsonb END) p
             WHERE jsonb_typeof(p) = 'object' AND p->>'hash' ~ '^[0-9a-f]{64}$') s LOOP
    UPDATE wts.blobs b SET refcount = greatest(0, b.refcount + d),
      unref_at = CASE WHEN b.refcount + d <= 0 THEN now() ELSE NULL END
      WHERE b.user_id = r.user_id AND b.hash = h;
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER revisions_refs AFTER INSERT OR DELETE ON wts.revisions FOR EACH ROW EXECUTE FUNCTION wts.revisions_refs_trg();

-- ── definer bodies: sessions and accounts ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION wts.resolve_session(p_sid_hash bytea)
  RETURNS TABLE (user_id uuid, device_id uuid, public_device boolean, auth_at timestamptz, stepup_at timestamptz,
                 auth_method text, identity_id uuid, idle_expires_at timestamptz, abs_expires_at timestamptz, status text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
#variable_conflict use_column
DECLARE s wts.sessions%ROWTYPE;
BEGIN
  IF p_sid_hash IS NULL OR length(p_sid_hash) <> 32 THEN RETURN; END IF;
  SELECT * INTO s FROM wts.sessions x WHERE x.sid_hash = p_sid_hash;
  IF NOT FOUND THEN RETURN; END IF;
  IF s.replaced_by IS NOT NULL THEN                       -- a rotated id stays valid for 30 s (§4.7)
    IF s.replaced_at IS NULL OR s.replaced_at < now() - interval '30 seconds' THEN RETURN; END IF;
    SELECT * INTO s FROM wts.sessions x WHERE x.sid_hash = s.replaced_by;
    IF NOT FOUND OR s.replaced_by IS NOT NULL THEN RETURN; END IF;
  END IF;
  IF s.idle_expires_at <= now() OR s.abs_expires_at <= now() THEN RETURN; END IF;
  RETURN QUERY SELECT s.user_id, s.device_id, s.public_device, s.auth_at, s.stepup_at, s.auth_method, s.identity_id,
    s.idle_expires_at, s.abs_expires_at, u.status FROM wts.users u WHERE u.id = s.user_id;
END $$;

CREATE OR REPLACE FUNCTION wts.user_by_email(p_email_bidx bytea)
  RETURNS TABLE (user_id uuid, status text, role text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
#variable_conflict use_column
BEGIN
  IF p_email_bidx IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT u.id, u.status, 'primary'::text FROM wts.users u WHERE u.email_bidx = p_email_bidx
    UNION ALL SELECT u.id, u.status, 'recovery'::text FROM wts.users u WHERE u.recovery_bidx = p_email_bidx
    LIMIT 1;
END $$;

-- an address is "in use" when it is any account's primary or recovery address, or an old address still inside its 7-day
-- revert window (so nobody can take it and block the revert). p_except: the account asking (its own addresses don't count).
CREATE FUNCTION wts.address_in_use(p_bidx bytea, p_except uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$ SELECT EXISTS (SELECT 1 FROM wts.users u WHERE u.id IS DISTINCT FROM p_except AND (u.email_bidx = p_bidx OR u.recovery_bidx = p_bidx
                        OR (u.email_prev_bidx = p_bidx AND u.email_revert_until > now()))) $$;

CREATE OR REPLACE FUNCTION wts.create_user(p_email_bidx bytea, p_email_enc bytea, p_signup_method text, p_terms_version text,
                                           p_privacy_version text, p_consented_at timestamptz, p_data_key_wrapped bytea, p_kid int)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('wts.addr:' || encode(p_email_bidx, 'hex'), 0));
  IF wts.address_in_use(p_email_bidx, NULL) THEN RETURN NULL; END IF;
  INSERT INTO wts.users (email_bidx, email_enc, signup_method, terms_version, privacy_version, consented_at, data_key_wrapped,
                         data_key_kid, data_key_ver, last_sign_in_at)
    VALUES (p_email_bidx, p_email_enc, p_signup_method, p_terms_version, p_privacy_version, now(), p_data_key_wrapped, p_kid, 1, now())
    RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN unique_violation THEN RETURN NULL;
END $$;

-- one-address-one-role moves (§3.3): the caller's own account only
CREATE OR REPLACE FUNCTION wts.email_move(p_user_id uuid, p_new_bidx bytea, p_new_enc bytea)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  IF p_user_id IS NULL OR p_user_id IS DISTINCT FROM wts.current_user_id() THEN RAISE EXCEPTION 'email_move: not this account' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wts.addr:' || encode(p_new_bidx, 'hex'), 0));
  IF wts.address_in_use(p_new_bidx, p_user_id) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM wts.users u WHERE u.id = p_user_id AND (u.email_bidx = p_new_bidx OR u.recovery_bidx = p_new_bidx)) THEN RETURN false; END IF;
  UPDATE wts.users SET email_prev_bidx = email_bidx, email_prev_enc = email_enc, email_bidx = p_new_bidx, email_enc = p_new_enc,
    email_changed_at = now(), email_revert_until = now() + interval '7 days', email_pending_enc = NULL WHERE id = p_user_id;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION wts.recovery_set(p_user_id uuid, p_bidx bytea, p_enc bytea)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  IF p_user_id IS NULL OR p_user_id IS DISTINCT FROM wts.current_user_id() THEN RAISE EXCEPTION 'recovery_set: not this account' USING ERRCODE = '42501'; END IF;
  IF p_bidx IS NULL THEN
    UPDATE wts.users SET recovery_bidx = NULL, recovery_enc = NULL, recovery_pending_enc = NULL WHERE id = p_user_id;
    RETURN FOUND;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wts.addr:' || encode(p_bidx, 'hex'), 0));
  IF wts.address_in_use(p_bidx, p_user_id) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM wts.users u WHERE u.id = p_user_id AND u.email_bidx = p_bidx) THEN RETURN false; END IF;
  UPDATE wts.users SET recovery_bidx = p_bidx, recovery_enc = p_enc, recovery_pending_enc = NULL WHERE id = p_user_id;
  RETURN FOUND;
END $$;

-- §4.3 revert, pre-auth: the old address and its 7-day revert code. Restores the address, clears the recovery address,
-- removes every passkey and provider identity added since the change (their sessions go with them: sessions.identity_id
-- cascades) and revokes every session. Returns nothing for a wrong / expired code (one try counted).
CREATE FUNCTION wts.email_revert(p_prev_bidx bytea, p_code_hmacs bytea[])
  RETURNS TABLE (user_id uuid, sessions int, passkeys int, identities int)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
#variable_conflict use_column
DECLARE c wts.email_codes%ROWTYPE; u wts.users%ROWTYPE; n_s int; n_p int; n_i int;
BEGIN
  IF p_prev_bidx IS NULL OR p_code_hmacs IS NULL THEN RETURN; END IF;
  SELECT * INTO c FROM wts.email_codes x WHERE x.email_bidx = p_prev_bidx AND x.purpose = 'email_revert' AND x.used_at IS NULL
    AND x.invalidated_at IS NULL AND x.expires_at > now() AND x.code_hmac = ANY (p_code_hmacs) ORDER BY x.expires_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE wts.email_codes x SET attempts = x.attempts + 1, invalidated_at = CASE WHEN x.attempts + 1 >= 5 THEN now() END
      WHERE x.email_bidx = p_prev_bidx AND x.purpose = 'email_revert' AND x.used_at IS NULL AND x.invalidated_at IS NULL AND x.expires_at > now();
    RETURN;
  END IF;
  SELECT * INTO u FROM wts.users x WHERE x.id = c.bound_user FOR UPDATE;
  IF NOT FOUND OR u.email_prev_bidx IS DISTINCT FROM p_prev_bidx OR u.email_revert_until IS NULL OR u.email_revert_until <= now() THEN RETURN; END IF;
  UPDATE wts.email_codes SET used_at = now() WHERE id = c.id;
  SELECT count(*) INTO n_s FROM wts.sessions s WHERE s.user_id = u.id;
  WITH d AS (DELETE FROM wts.passkeys p WHERE p.user_id = u.id AND p.created_at > u.email_changed_at RETURNING 1) SELECT count(*) INTO n_p FROM d;
  WITH d AS (DELETE FROM wts.identities i WHERE i.user_id = u.id AND i.linked_at > u.email_changed_at RETURNING 1) SELECT count(*) INTO n_i FROM d;
  DELETE FROM wts.sessions s WHERE s.user_id = u.id;
  UPDATE wts.users x SET email_bidx = u.email_prev_bidx, email_enc = u.email_prev_enc, email_prev_bidx = NULL, email_prev_enc = NULL,
    email_revert_until = NULL, email_changed_at = NULL, email_pending_enc = NULL,
    recovery_bidx = NULL, recovery_enc = NULL, recovery_pending_enc = NULL WHERE x.id = u.id;
  RETURN QUERY SELECT u.id, n_s, n_p, n_i;
END $$;

-- remove provider identities linked at or after p_since (NULL = all) together with every session they created
-- (sessions.identity_id cascades). Used by sign-out-everywhere with recent links and by the support reset.
CREATE FUNCTION wts.identities_remove_since(p_user_id uuid, p_since timestamptz)
  RETURNS TABLE (identities int, sessions int)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
#variable_conflict use_column
DECLARE n_i int; n_s int;
BEGIN
  IF p_user_id IS NULL OR p_user_id IS DISTINCT FROM wts.current_user_id() THEN RAISE EXCEPTION 'identities_remove_since: not this account' USING ERRCODE = '42501'; END IF;
  SELECT count(*) INTO n_s FROM wts.sessions s JOIN wts.identities i ON i.id = s.identity_id
    WHERE i.user_id = p_user_id AND (p_since IS NULL OR i.linked_at >= p_since);
  WITH d AS (DELETE FROM wts.identities i WHERE i.user_id = p_user_id AND (p_since IS NULL OR i.linked_at >= p_since) RETURNING 1)
    SELECT count(*) INTO n_i FROM d;
  RETURN QUERY SELECT n_i, n_s;
END $$;

-- §8.5 deletion request: status deleting, every session revoked, identities released at once, the ledger row written.
-- The grace is p_purge_at − p_requested_at measured on the database clock (0 = immediate).
CREATE OR REPLACE FUNCTION wts.deletion_request(p_user_id uuid, p_requested_at timestamptz, p_purge_at timestamptz)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
DECLARE v_grace interval := greatest(interval '0', least(coalesce(p_purge_at - p_requested_at, interval '7 days'), interval '7 days'));
BEGIN
  IF p_user_id IS NULL OR p_user_id IS DISTINCT FROM wts.current_user_id() THEN RAISE EXCEPTION 'deletion_request: not this account' USING ERRCODE = '42501'; END IF;
  UPDATE wts.users SET status = 'deleting', delete_requested_at = now(), delete_at = now() + v_grace WHERE id = p_user_id AND status <> 'locked';
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion_request: account not active' USING ERRCODE = '42501'; END IF;
  DELETE FROM wts.identities WHERE user_id = p_user_id;
  DELETE FROM wts.sessions WHERE user_id = p_user_id;
  INSERT INTO wts.deletion_ledger (user_id, requested_at, purge_at) VALUES (p_user_id, now(), now() + v_grace)
    ON CONFLICT (user_id) DO UPDATE SET requested_at = EXCLUDED.requested_at, purge_at = EXCLUDED.purge_at, purged_at = NULL;
END $$;

CREATE FUNCTION wts.deletion_cancel(p_user_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  IF p_user_id IS NULL OR p_user_id IS DISTINCT FROM wts.current_user_id() THEN RAISE EXCEPTION 'deletion_cancel: not this account' USING ERRCODE = '42501'; END IF;
  UPDATE wts.users SET status = 'active', delete_requested_at = NULL, delete_at = NULL
    WHERE id = p_user_id AND status = 'deleting' AND delete_at > now();
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM wts.deletion_ledger WHERE user_id = p_user_id AND purged_at IS NULL;
  RETURN true;
END $$;

-- ── definer bodies: e-mail codes (§4.1–4.2) ─────────────────────────────────────────────────────────────────────
-- At most two live codes per address, purpose and attempt: a third invalidates the oldest. Lifetime 15 min (the revert
-- code: 7 days); a caller may ask for less, never more.
CREATE OR REPLACE FUNCTION wts.code_issue(p_email_bidx bytea, p_code_hmac bytea, p_pepper_kid int, p_purpose text, p_bound_user uuid,
                                          p_bound_sid bytea, p_bound_attempt uuid, p_expires_at timestamptz, p_ip_prefix inet)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
DECLARE v_id uuid := gen_random_uuid();
        v_max timestamptz := now() + CASE WHEN p_purpose = 'email_revert' THEN interval '7 days' ELSE interval '15 minutes' END;
BEGIN
  IF p_email_bidx IS NULL OR p_code_hmac IS NULL OR p_purpose IS NULL THEN RAISE EXCEPTION 'code_issue: missing argument' USING ERRCODE = '22023'; END IF;
  IF p_purpose IN ('stepup', 'email_change', 'recovery_add') AND (p_bound_user IS NULL OR p_bound_sid IS NULL) THEN
    RAISE EXCEPTION 'code_issue: % needs a user and a session', p_purpose USING ERRCODE = '22023';
  END IF;
  IF p_purpose = 'email_revert' AND p_bound_user IS NULL THEN RAISE EXCEPTION 'code_issue: email_revert needs a user' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wts.code:' || encode(p_email_bidx, 'hex') || ':' || p_purpose, 0));
  UPDATE wts.email_codes SET invalidated_at = now() WHERE id IN (
    SELECT c.id FROM wts.email_codes c WHERE c.email_bidx = p_email_bidx AND c.purpose = p_purpose
      AND c.bound_attempt IS NOT DISTINCT FROM p_bound_attempt AND c.used_at IS NULL AND c.invalidated_at IS NULL AND c.expires_at > now()
      ORDER BY c.expires_at DESC OFFSET 1);
  INSERT INTO wts.email_codes (id, email_bidx, code_hmac, pepper_kid, purpose, bound_user, bound_sid, bound_attempt, expires_at, ip_prefix)
    VALUES (v_id, p_email_bidx, p_code_hmac, p_pepper_kid, p_purpose, p_bound_user, p_bound_sid, p_bound_attempt,
            least(coalesce(p_expires_at, v_max), v_max), p_ip_prefix);
  RETURN v_id;
END $$;

-- Check a code: p_code_hmacs = the HMAC of the entered code under every live pepper (and every candidate address for a
-- step-up). Bindings match exactly (IS NOT DISTINCT FROM). p_email_bidx NULL matches by binding only and needs a user and a
-- session (a step-up whose address the page did not send). A hit marks the code used and invalidates the other live codes
-- of that address, purpose and binding; a miss counts one try on each live code (5 tries each).
CREATE OR REPLACE FUNCTION wts.code_check(p_email_bidx bytea, p_purpose text, p_code_hmacs bytea[], p_bound_user uuid, p_bound_sid bytea,
                                          p_bound_attempt uuid)
  RETURNS TABLE (ok boolean, code_id uuid, attempts_left int)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
#variable_conflict use_column
DECLARE v_hit wts.email_codes%ROWTYPE; v_left int;
BEGIN
  IF p_purpose IS NULL OR p_code_hmacs IS NULL OR (p_email_bidx IS NULL AND (p_bound_user IS NULL OR p_bound_sid IS NULL)) THEN
    RETURN QUERY SELECT false, NULL::uuid, 0; RETURN;
  END IF;
  SELECT * INTO v_hit FROM wts.email_codes c
    WHERE (p_email_bidx IS NULL OR c.email_bidx = p_email_bidx) AND c.purpose = p_purpose
      AND c.bound_user IS NOT DISTINCT FROM p_bound_user AND c.bound_sid IS NOT DISTINCT FROM p_bound_sid
      AND c.bound_attempt IS NOT DISTINCT FROM p_bound_attempt
      AND c.used_at IS NULL AND c.invalidated_at IS NULL AND c.expires_at > now() AND c.code_hmac = ANY (p_code_hmacs)
    ORDER BY c.expires_at DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    UPDATE wts.email_codes SET used_at = now() WHERE id = v_hit.id;
    UPDATE wts.email_codes c SET invalidated_at = now() WHERE c.id <> v_hit.id AND c.email_bidx = v_hit.email_bidx AND c.purpose = p_purpose
      AND c.bound_user IS NOT DISTINCT FROM p_bound_user AND c.bound_sid IS NOT DISTINCT FROM p_bound_sid
      AND c.bound_attempt IS NOT DISTINCT FROM p_bound_attempt AND c.used_at IS NULL AND c.invalidated_at IS NULL;
    RETURN QUERY SELECT true, v_hit.id, 5 - v_hit.attempts; RETURN;
  END IF;
  WITH u AS (
    UPDATE wts.email_codes c SET attempts = c.attempts + 1, invalidated_at = CASE WHEN c.attempts + 1 >= 5 THEN now() END
      WHERE (p_email_bidx IS NULL OR c.email_bidx = p_email_bidx) AND c.purpose = p_purpose
        AND c.bound_user IS NOT DISTINCT FROM p_bound_user AND c.bound_sid IS NOT DISTINCT FROM p_bound_sid
        AND c.bound_attempt IS NOT DISTINCT FROM p_bound_attempt
        AND c.used_at IS NULL AND c.invalidated_at IS NULL AND c.expires_at > now()
      RETURNING c.attempts)
  SELECT max(5 - u.attempts) INTO v_left FROM u;
  RETURN QUERY SELECT false, NULL::uuid, greatest(coalesce(v_left, 0), 0);
END $$;

-- ── definer bodies: passkey challenges and lookup (Phase 3 uses them; bodies are final and small) ─────────────────
CREATE OR REPLACE FUNCTION wts.user_by_credential(p_credential_id bytea)
  RETURNS TABLE (user_id uuid, passkey_id uuid, public_key bytea, sign_count bigint)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY SELECT p.user_id, p.id, p.public_key, p.sign_count FROM wts.passkeys p WHERE p.credential_id = p_credential_id;
END $$;
CREATE OR REPLACE FUNCTION wts.challenge_issue(p_challenge bytea, p_purpose text, p_user_id uuid, p_expires_at timestamptz)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  IF p_user_id IS NOT NULL AND p_user_id IS DISTINCT FROM wts.current_user_id() THEN RAISE EXCEPTION 'challenge_issue: not this account' USING ERRCODE = '42501'; END IF;
  INSERT INTO wts.webauthn_challenges (id, challenge, purpose, user_id, expires_at)
    VALUES (v_id, p_challenge, p_purpose, p_user_id, least(coalesce(p_expires_at, now() + interval '5 minutes'), now() + interval '5 minutes'));
  RETURN v_id;
END $$;
CREATE OR REPLACE FUNCTION wts.challenge_take(p_id uuid, p_purpose text)
  RETURNS TABLE (challenge bytea, user_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY UPDATE wts.webauthn_challenges c SET used_at = now()
    WHERE c.id = p_id AND c.purpose = p_purpose AND c.used_at IS NULL AND c.expires_at > now() RETURNING c.challenge, c.user_id;
END $$;

-- ── definer bodies: rate counters (§8.3; fixed windows, no timers) ──────────────────────────────────────────────
-- rate_add: add p_amount (0 = peek) to the bucket's current fixed window; allowed = the total stays within p_limit.
CREATE FUNCTION wts.rate_add(p_bucket text, p_window interval, p_limit bigint, p_amount bigint)
  RETURNS TABLE (allowed boolean, n bigint, retry_after int)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
#variable_conflict use_column
DECLARE v_w double precision := extract(epoch FROM p_window); v_start timestamptz; v_n bigint;
BEGIN
  IF p_bucket IS NULL OR length(p_bucket) > 200 OR v_w IS NULL OR v_w < 1 THEN RAISE EXCEPTION 'rate_add: bad bucket or window' USING ERRCODE = '22023'; END IF;
  v_start := to_timestamp(floor(extract(epoch FROM now()) / v_w) * v_w);
  IF coalesce(p_amount, 0) = 0 THEN
    SELECT r.n INTO v_n FROM wts.rate_counters r WHERE r.bucket = p_bucket AND r.window_start = v_start;
    v_n := coalesce(v_n, 0);
  ELSE
    INSERT INTO wts.rate_counters AS r (bucket, window_start, n) VALUES (p_bucket, v_start, p_amount)
      ON CONFLICT (bucket, window_start) DO UPDATE SET n = r.n + EXCLUDED.n RETURNING r.n INTO v_n;
  END IF;
  RETURN QUERY SELECT v_n <= p_limit, v_n, greatest(1, ceil(extract(epoch FROM (v_start + p_window - now())))::int);
END $$;
CREATE OR REPLACE FUNCTION wts.rate_hit(p_bucket text, p_window interval, p_limit bigint)
  RETURNS TABLE (allowed boolean, n bigint, retry_after int)
  LANGUAGE sql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$ SELECT * FROM wts.rate_add(p_bucket, p_window, p_limit, 1) $$;

CREATE OR REPLACE FUNCTION wts.allowlist_has(p_email_bidx bytea)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$ SELECT EXISTS (SELECT 1 FROM wts.signup_allowlist a WHERE a.email_bidx = p_email_bidx) $$;

-- ── definer bodies: mail outbox (§4.1: queued, sent after the response, retried by the daily job) ──────────────
CREATE OR REPLACE FUNCTION wts.mail_queue(p_to_enc bytea, p_template text, p_params_enc bytea)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  IF p_to_enc IS NULL OR p_template IS NULL OR p_template !~ '^(code|notice)_[a-z_]{1,40}$' THEN RAISE EXCEPTION 'mail_queue: bad message' USING ERRCODE = '22023'; END IF;
  INSERT INTO wts.mail_outbox (id, to_enc, template, params_enc, created_at) VALUES (v_id, p_to_enc, p_template, p_params_enc, now());
  RETURN v_id;
END $$;
-- after the send: sent → sent_at; failed → one more try (the daily job retries rows with tries < 5)
CREATE FUNCTION wts.mail_mark(p_id uuid, p_sent boolean)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$ UPDATE wts.mail_outbox SET sent_at = CASE WHEN p_sent THEN now() ELSE sent_at END, tries = tries + 1
        WHERE id = p_id AND sent_at IS NULL $$;

CREATE OR REPLACE FUNCTION wts.audit_system(p_action text, p_target text, p_device_id uuid, p_ip_prefix inet, p_ua_family text, p_detail jsonb)
  RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
DECLARE v_id bigint;
BEGIN
  IF p_action IS NULL OR p_action !~ '^[a-z_]{1,40}$' THEN RAISE EXCEPTION 'audit_system: bad action' USING ERRCODE = '22023'; END IF;
  INSERT INTO wts.audit (user_id, actor, action, target, device_id, ip_prefix, ua_family, at, detail, hash)
    VALUES (NULL, 'system', p_action, p_target, p_device_id, p_ip_prefix, p_ua_family, now(), p_detail, ''::bytea) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ── definer bodies: audited support functions (wts_support; actor support:<id>; one audit row per call) ─────────
CREATE FUNCTION wts._support_actor(p_actor text) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = wts, pg_temp
  AS $$ BEGIN
    IF p_actor IS NULL OR p_actor !~ '^support:[a-z0-9_-]{1,32}$' THEN RAISE EXCEPTION 'support: actor must be support:<id>' USING ERRCODE = '22023'; END IF;
    RETURN p_actor; END $$;
CREATE OR REPLACE FUNCTION wts.support_lookup(p_actor text, p_email_bidx bytea)
  RETURNS TABLE (user_id uuid, status text, created_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
#variable_conflict use_column
DECLARE v_u uuid; v_s text; v_c timestamptz;
BEGIN
  PERFORM wts._support_actor(p_actor);
  SELECT u.id, u.status, u.created_at INTO v_u, v_s, v_c FROM wts.users u WHERE u.email_bidx = p_email_bidx OR u.recovery_bidx = p_email_bidx LIMIT 1;
  INSERT INTO wts.audit (user_id, actor, action, at, detail, hash) VALUES (v_u, p_actor, 'support_lookup', now(), jsonb_build_object('found', v_u IS NOT NULL), ''::bytea);
  IF v_u IS NOT NULL THEN RETURN QUERY SELECT v_u, v_s, v_c; END IF;
END $$;
-- §13.7 recovery: the new (code-checked) address becomes the primary, the old one keeps its 7-day revert window
CREATE OR REPLACE FUNCTION wts.support_recover(p_actor text, p_user_id uuid, p_new_email_bidx bytea, p_new_email_enc bytea)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  PERFORM wts._support_actor(p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('wts.addr:' || encode(p_new_email_bidx, 'hex'), 0));
  IF wts.address_in_use(p_new_email_bidx, p_user_id) THEN RAISE EXCEPTION 'support_recover: address in use' USING ERRCODE = '23505'; END IF;
  UPDATE wts.users SET email_prev_bidx = email_bidx, email_prev_enc = email_enc, email_bidx = p_new_email_bidx, email_enc = p_new_email_enc,
    email_changed_at = now(), email_revert_until = now() + interval '7 days' WHERE id = p_user_id AND status <> 'deleting';
  IF NOT FOUND THEN RAISE EXCEPTION 'support_recover: no such active account' USING ERRCODE = '02000'; END IF;
  DELETE FROM wts.sessions WHERE user_id = p_user_id;
  INSERT INTO wts.audit (user_id, actor, action, at, detail, hash) VALUES (p_user_id, p_actor, 'support_recover', now(), '{}'::jsonb, ''::bytea);
END $$;
-- §13.6 security reset: revoke every session; remove passkeys, provider links (with their sessions) and the recovery address
-- added at or after p_since; revert an e-mail change made in the window. Returns the counts.
CREATE OR REPLACE FUNCTION wts.support_security_reset(p_actor text, p_user_id uuid, p_since timestamptz)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
DECLARE u wts.users%ROWTYPE; n_s int; n_p int; n_i int; v_rev boolean := false; v_out jsonb;
BEGIN
  PERFORM wts._support_actor(p_actor);
  SELECT * INTO u FROM wts.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'support_security_reset: no such account' USING ERRCODE = '02000'; END IF;
  SELECT count(*) INTO n_s FROM wts.sessions WHERE user_id = p_user_id;
  WITH d AS (DELETE FROM wts.passkeys WHERE user_id = p_user_id AND created_at >= p_since RETURNING 1) SELECT count(*) INTO n_p FROM d;
  WITH d AS (DELETE FROM wts.identities WHERE user_id = p_user_id AND linked_at >= p_since RETURNING 1) SELECT count(*) INTO n_i FROM d;
  DELETE FROM wts.sessions WHERE user_id = p_user_id;
  IF u.email_changed_at IS NOT NULL AND u.email_changed_at >= p_since AND u.email_prev_bidx IS NOT NULL AND u.email_revert_until > now() THEN
    UPDATE wts.users SET email_bidx = email_prev_bidx, email_enc = email_prev_enc, email_prev_bidx = NULL, email_prev_enc = NULL,
      email_revert_until = NULL, email_changed_at = NULL WHERE id = p_user_id;
    v_rev := true;
  END IF;
  UPDATE wts.users SET recovery_bidx = NULL, recovery_enc = NULL, recovery_pending_enc = NULL, email_pending_enc = NULL WHERE id = p_user_id;
  v_out := jsonb_build_object('sessions', n_s, 'passkeys', n_p, 'identities', n_i, 'emailReverted', v_rev);
  INSERT INTO wts.audit (user_id, actor, action, at, detail, hash) VALUES (p_user_id, p_actor, 'support_security_reset', now(), v_out, ''::bytea);
  RETURN v_out;
END $$;
-- the invite beta allow-list (§3.3 code/verify, ACCOUNTS_SIGNUP=invite); the note is free text for the owner, never an address
CREATE FUNCTION wts.support_allowlist_add(p_actor text, p_email_bidx bytea, p_note text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  PERFORM wts._support_actor(p_actor);
  INSERT INTO wts.signup_allowlist (email_bidx, added_at, note) VALUES (p_email_bidx, now(), left(p_note, 200)) ON CONFLICT DO NOTHING;
  INSERT INTO wts.audit (user_id, actor, action, at, detail, hash) VALUES (NULL, p_actor, 'support_allowlist_add', now(), jsonb_build_object('added', FOUND), ''::bytea);
  RETURN FOUND;
END $$;

-- ── ownership and privileges of the new functions ───────────────────────────────────────────────────────────────
DO $own$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'wts' AND p.prosecdef LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO wts_definer', f.sig);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'wts' AND NOT p.prosecdef AND pg_get_userbyid(p.proowner) <> 'wts_owner' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO wts_owner', f.sig);
  END LOOP;
END
$own$;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA wts FROM PUBLIC;
-- helpers (invoker rights, no data)
GRANT EXECUTE ON FUNCTION wts.current_user_id(), wts.audit_row_text(text, text, text, uuid, inet, text, timestamptz, jsonb),
  wts.audit_row_hash(bytea, text, text, text, uuid, inet, text, timestamptz, jsonb), wts._support_actor(text)
  TO wts_definer, wts_api, wts_jobs, wts_support;
GRANT EXECUTE ON FUNCTION wts.address_in_use(bytea, uuid) TO wts_definer;
GRANT EXECUTE ON FUNCTION wts.rate_add(text, interval, bigint, bigint), wts.mail_mark(uuid, boolean),
  wts.email_revert(bytea, bytea[]), wts.identities_remove_since(uuid, timestamptz), wts.deletion_cancel(uuid) TO wts_api;
GRANT EXECUTE ON FUNCTION wts.support_allowlist_add(text, bytea, text) TO wts_support;

-- the daily job (§3.5): tombstone audit rows of a purged account, release identities of an inactive account, delete the
-- rows of a purge that do not cascade from users, start the inactivity deletion
GRANT UPDATE (user_id) ON wts.audit TO wts_jobs;
GRANT UPDATE (delete_requested_at, delete_at) ON wts.users TO wts_jobs;
GRANT DELETE ON wts.identities, wts.historian_backups, wts.deletion_ledger, wts.signup_allowlist TO wts_jobs;
GRANT SELECT ON wts.identities, wts.historian_backups TO wts_jobs;
GRANT UPDATE (refcount, unref_at) ON wts.blobs TO wts_jobs;
GRANT UPDATE (is_conflict_of) ON wts.projects TO wts_jobs;
