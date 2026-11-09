-- server/db/migrations/050-code-scope.sql — review fixes of the Phase 1 integration (docs/ACCOUNTS-PLAN.md §4.1–4.2, §8.3):
-- a stranger must not be able to cancel or burn another person's e-mail codes from another client address range.
--
--   code_issue  (signature unchanged) — the two-live-codes cap of a sign-in code ('signin') and of a provider address code
--               ('oauth_verify') counts per address, purpose AND client address range (ip_prefix): a start from another range
--               never invalidates the owner's live code. 'oauth_verify' counts across attempts in that range (one browser
--               cannot hold more than two live codes for an address by opening parallel attempts). Every other purpose keeps
--               the cap per address, purpose and binding.
--   code_check  (signature unchanged) — when the caller names its client address range in the transaction setting
--               wts.ip_prefix, a wrong unbound sign-in code counts a try only on the live codes issued to that range (a
--               stranger's guesses no longer burn the owner's code; the caller bounds guesses per address and range). The
--               reply's attempts_left is -1 when no live code of that address and purpose existed at all (the caller then
--               does not count the failure towards the address pause). Without the setting, the behaviour is unchanged.
-- Both stay SECURITY DEFINER, owner wts_definer, EXECUTE for wts_api only (CREATE OR REPLACE keeps owner and grants).

SET LOCAL search_path = wts, pg_temp;

CREATE OR REPLACE FUNCTION wts.code_issue(p_email_bidx bytea, p_code_hmac bytea, p_pepper_kid int, p_purpose text, p_bound_user uuid,
                                          p_bound_sid bytea, p_bound_attempt uuid, p_expires_at timestamptz, p_ip_prefix inet)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
DECLARE v_id uuid := gen_random_uuid();
        v_max timestamptz := now() + CASE WHEN p_purpose = 'email_revert' THEN interval '7 days' ELSE interval '15 minutes' END;
        v_ranged boolean := p_purpose IN ('signin', 'oauth_verify');
BEGIN
  IF p_email_bidx IS NULL OR p_code_hmac IS NULL OR p_purpose IS NULL THEN RAISE EXCEPTION 'code_issue: missing argument' USING ERRCODE = '22023'; END IF;
  IF p_purpose IN ('stepup', 'email_change', 'recovery_add') AND (p_bound_user IS NULL OR p_bound_sid IS NULL) THEN
    RAISE EXCEPTION 'code_issue: % needs a user and a session', p_purpose USING ERRCODE = '22023';
  END IF;
  IF p_purpose = 'email_revert' AND p_bound_user IS NULL THEN RAISE EXCEPTION 'code_issue: email_revert needs a user' USING ERRCODE = '22023'; END IF;
  IF p_bound_user IS NOT NULL AND p_bound_user IS DISTINCT FROM wts.current_user_id() THEN
    RAISE EXCEPTION 'code_issue: not this account' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wts.code:' || encode(p_email_bidx, 'hex') || ':' || p_purpose, 0));
  UPDATE wts.email_codes SET invalidated_at = now() WHERE id IN (
    SELECT c.id FROM wts.email_codes c WHERE c.email_bidx = p_email_bidx AND c.purpose = p_purpose
      AND CASE WHEN v_ranged THEN c.ip_prefix IS NOT DISTINCT FROM p_ip_prefix
               ELSE c.bound_attempt IS NOT DISTINCT FROM p_bound_attempt END
      AND c.used_at IS NULL AND c.invalidated_at IS NULL AND c.expires_at > now()
      ORDER BY c.expires_at DESC OFFSET 1);
  INSERT INTO wts.email_codes (id, email_bidx, code_hmac, pepper_kid, purpose, bound_user, bound_sid, bound_attempt, expires_at, ip_prefix)
    VALUES (v_id, p_email_bidx, p_code_hmac, p_pepper_kid, p_purpose, p_bound_user, p_bound_sid, p_bound_attempt,
            least(coalesce(p_expires_at, v_max), v_max), p_ip_prefix);
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION wts.code_check(p_email_bidx bytea, p_purpose text, p_code_hmacs bytea[], p_bound_user uuid, p_bound_sid bytea,
                                          p_bound_attempt uuid)
  RETURNS TABLE (ok boolean, code_id uuid, attempts_left int)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
#variable_conflict use_column
DECLARE v_hit wts.email_codes%ROWTYPE; v_left int; v_any boolean;
        v_prefix inet := NULLIF(current_setting('wts.ip_prefix', true), '')::inet;
        v_scoped boolean := p_purpose = 'signin' AND p_bound_user IS NULL AND p_bound_attempt IS NULL
                            AND NULLIF(current_setting('wts.ip_prefix', true), '') IS NOT NULL;
BEGIN
  IF p_purpose IS NULL OR p_code_hmacs IS NULL OR (p_email_bidx IS NULL AND (p_bound_user IS NULL OR p_bound_sid IS NULL)) THEN
    RETURN QUERY SELECT false, NULL::uuid, 0; RETURN;
  END IF;
  IF p_bound_user IS NOT NULL AND p_bound_user IS DISTINCT FROM wts.current_user_id() THEN
    RAISE EXCEPTION 'code_check: not this account' USING ERRCODE = '42501';
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
  SELECT EXISTS (SELECT 1 FROM wts.email_codes c
    WHERE (p_email_bidx IS NULL OR c.email_bidx = p_email_bidx) AND c.purpose = p_purpose
      AND c.bound_user IS NOT DISTINCT FROM p_bound_user AND c.bound_sid IS NOT DISTINCT FROM p_bound_sid
      AND c.bound_attempt IS NOT DISTINCT FROM p_bound_attempt
      AND c.used_at IS NULL AND c.invalidated_at IS NULL AND c.expires_at > now()) INTO v_any;
  IF NOT v_any THEN RETURN QUERY SELECT false, NULL::uuid, -1; RETURN; END IF;
  WITH u AS (
    UPDATE wts.email_codes c SET attempts = c.attempts + 1, invalidated_at = CASE WHEN c.attempts + 1 >= 5 THEN now() END
      WHERE (p_email_bidx IS NULL OR c.email_bidx = p_email_bidx) AND c.purpose = p_purpose
        AND c.bound_user IS NOT DISTINCT FROM p_bound_user AND c.bound_sid IS NOT DISTINCT FROM p_bound_sid
        AND c.bound_attempt IS NOT DISTINCT FROM p_bound_attempt
        AND c.used_at IS NULL AND c.invalidated_at IS NULL AND c.expires_at > now()
        AND (NOT v_scoped OR c.ip_prefix IS NOT DISTINCT FROM v_prefix)
      RETURNING c.attempts)
  SELECT max(5 - u.attempts) INTO v_left FROM u;
  RETURN QUERY SELECT false, NULL::uuid, greatest(coalesce(v_left, 0), 0);
END $$;
