-- server/db/migrations/040-oauth.sql — WP-O: provider sign-in bodies (docs/ACCOUNTS-PLAN.md §3.4, §4.10–4.15, §8.3).
-- Fills the WP0 stubs of the identity, attempt and signing-key definer functions (signatures unchanged; CREATE OR REPLACE
-- keeps their owner wts_definer and their grants) and adds the few definers the flow needs beyond the frozen list:
--   oauth_attempt_drop(cookie_hash)        a new start replaces this browser's earlier attempt (§4.10 item 3)
--   oauth_attempt_close(id)                ends an attempt (signed in, linked or failed); the row stays for the daily purge
--   oauth_exchange_hit(ip_prefix)          30 callbacks per IP prefix per 10 min may reach a token endpoint (§8.3)
--   oauth_attempt_claim(id) / oauth_attempt_release(id)   one finish per attempt at a time (a 30 s claim; extend / close /
--                                          release clear it), so two finish calls with one cookie never both run a step
--   oauth_finish_fail(ip_prefix)           counts a failed finish: 10 per IP prefix per 10 min → soft delay (§8.3)
--   oidc_fetch_claim(provider)             at most one signing-key fetch per provider per 5-minute window, shared by every
--                                          instance of the functions host (§4.11)
--   _iso_ms(at)                            the audit time as JavaScript's toISOString() writes it (the audit hash input)
--   oauth_breaker_note(provider, bad) / oauth_breaker_open(provider)   the provider-side breaker (§8.3), fixed 10-min windows
--   session_revoke_presented(sid_hash)     a provider finish revokes the session id the request carried, whoever owns it
--                                          (§4.10 item 5; the caller holds that cookie)
--   support_retire_identities(actor, provider)   server/ops/retire-client.js (§4.14): removes every identity of a provider
--                                          (their sessions go with them), audits and queues a notice per user
-- Every function: SECURITY DEFINER, SET search_path = wts, pg_temp, owner wts_definer, EXECUTE for one role only.
-- Times are the database's (now()); the attempt lifetimes of §4.10 are enforced here, not by the caller.
-- The number 040 leaves room for WP-S1's migrations before it (they never touch these functions).

SET LOCAL search_path = wts, pg_temp;

-- ── identities ─────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION wts.user_by_identity(p_provider text, p_subject_bidx bytea)
  RETURNS TABLE (user_id uuid, identity_id uuid, status text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  RETURN QUERY SELECT i.user_id, i.id, u.status FROM wts.identities i JOIN wts.users u ON u.id = i.user_id
    WHERE i.provider = p_provider AND i.subject_bidx = p_subject_bidx;
END $$;

-- Runs inside the user's transaction (app.user_id = p_user_id). Raises WO001 identity_in_use (the subject is linked to any
-- account) or WO002 provider_linked (this account already has an identity of that provider).
CREATE OR REPLACE FUNCTION wts.identity_link(p_user_id uuid, p_provider text, p_issuer text, p_subject_bidx bytea, p_subject_enc bytea,
                                             p_email_link_enc bytea, p_email_verified_at_link boolean, p_linked_via text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  IF p_user_id IS NULL OR p_user_id IS DISTINCT FROM wts.current_user_id() THEN
    RAISE EXCEPTION 'identity_link: not the current user' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM wts.identities WHERE provider = p_provider AND subject_bidx = p_subject_bidx) THEN
    RAISE EXCEPTION 'identity_in_use' USING ERRCODE = 'WO001';
  END IF;
  IF EXISTS (SELECT 1 FROM wts.identities WHERE user_id = p_user_id AND provider = p_provider) THEN
    RAISE EXCEPTION 'provider_linked' USING ERRCODE = 'WO002';
  END IF;
  INSERT INTO wts.identities (id, user_id, provider, issuer, subject_bidx, subject_enc, email_link_enc, email_verified_at_link,
                              linked_at, linked_via)
    VALUES (v_id, p_user_id, p_provider, p_issuer, p_subject_bidx, p_subject_enc, p_email_link_enc, p_email_verified_at_link,
            now(), p_linked_via);
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION wts.identity_touch(p_identity_id uuid)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  UPDATE wts.identities SET last_used_at = now() WHERE id = p_identity_id AND user_id = wts.current_user_id();
END $$;

-- Deletes the identity of the current user and every session it created, in this transaction (§4.12 rule 6). Returns the
-- number of sessions revoked, or NULL when the identity is not the current user's.
CREATE OR REPLACE FUNCTION wts.identity_unlink(p_identity_id uuid)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
DECLARE v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM wts.identities WHERE id = p_identity_id AND user_id = wts.current_user_id()) THEN RETURN NULL; END IF;
  DELETE FROM wts.sessions WHERE identity_id = p_identity_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM wts.identities WHERE id = p_identity_id;
  RETURN v_n;
END $$;

-- ── provider sign-in attempts (pre-auth; reachable only through the hash of their own cookie) ────────────────────────
-- NULL when the per-prefix ceiling of 20 live attempts is reached (§8.3, 503 provider_off). An unknown prefix (NULL: no
-- client address; refused by the handler in production) is one shared 'unknown' bucket, the same way as oauth_exchange_hit.
CREATE OR REPLACE FUNCTION wts.oauth_attempt_create(p_cookie_hash bytea, p_provider text, p_purpose text, p_state_hash bytea,
                                                    p_nonce bytea, p_pkce_verifier_enc bytea, p_bound_sid bytea, p_bound_user uuid,
                                                    p_public_device boolean, p_fresh_login boolean, p_device_label_enc bytea,
                                                    p_expires_at timestamptz, p_ip_prefix inet)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  IF (SELECT count(*) FROM wts.oauth_attempts
      WHERE ip_prefix IS NOT DISTINCT FROM p_ip_prefix AND used_at IS NULL AND finished_at IS NULL AND expires_at > now()) >= 20 THEN
    RETURN NULL;
  END IF;
  INSERT INTO wts.oauth_attempts (id, cookie_hash, provider, purpose, state_hash, nonce, pkce_verifier_enc, bound_sid, bound_user,
                                  public_device, fresh_login, device_label_enc, created_at, expires_at, ip_prefix)
    VALUES (v_id, p_cookie_hash, p_provider, p_purpose, p_state_hash, p_nonce, p_pkce_verifier_enc, p_bound_sid, p_bound_user,
            p_public_device, p_fresh_login, p_device_label_enc, now(), LEAST(p_expires_at, now() + interval '10 minutes'), p_ip_prefix);
  RETURN v_id;
END $$;

CREATE FUNCTION wts.oauth_attempt_drop(p_cookie_hash bytea)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  UPDATE wts.oauth_attempts SET finished_at = now(), result_enc = NULL, pkce_verifier_enc = '\x'::bytea
    WHERE cookie_hash = p_cookie_hash AND finished_at IS NULL;
END $$;

-- The callback: the attempt named by its cookie, unused, unexpired, of this provider path, whose state matches; marked used
-- BEFORE the exchange (a replayed callback or code finds it used); the outcome is then readable for 5 minutes.
CREATE OR REPLACE FUNCTION wts.oauth_attempt_take(p_cookie_hash bytea, p_state_hash bytea, p_provider text)
  RETURNS TABLE (id uuid, purpose text, nonce bytea, pkce_verifier_enc bytea, public_device boolean, fresh_login boolean,
                 created_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  RETURN QUERY UPDATE wts.oauth_attempts a SET used_at = now(), result_expires_at = now() + interval '5 minutes'
    WHERE a.cookie_hash = p_cookie_hash AND a.state_hash = p_state_hash AND a.provider = p_provider
      AND a.used_at IS NULL AND a.finished_at IS NULL AND a.expires_at > now()
    RETURNING a.id, a.purpose, a.nonce, a.pkce_verifier_enc, a.public_device, a.fresh_login, a.created_at;
END $$;

-- Stores the (encrypted) outcome or the finish step state of a used, unfinished attempt. p_result_expires_at NULL keeps the
-- current expiry; any value is capped at 30 minutes from the start.
CREATE OR REPLACE FUNCTION wts.oauth_attempt_result(p_id uuid, p_result_enc bytea, p_result_expires_at timestamptz)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  UPDATE wts.oauth_attempts SET result_enc = p_result_enc, pkce_verifier_enc = '\x'::bytea,
      result_expires_at = CASE WHEN p_result_expires_at IS NULL THEN result_expires_at
                               ELSE LEAST(p_result_expires_at, created_at + interval '30 minutes') END
    WHERE id = p_id AND used_at IS NOT NULL AND finished_at IS NULL;
END $$;

-- finish → next email | code | consent: a new cookie value (the old hash stops working) and a later result expiry, never
-- beyond 30 minutes from the start (§4.10 item 3).
CREATE OR REPLACE FUNCTION wts.oauth_attempt_extend(p_cookie_hash bytea, p_new_cookie_hash bytea, p_until timestamptz)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  IF p_new_cookie_hash IS NULL OR p_until IS NULL THEN RETURN false; END IF;
  UPDATE wts.oauth_attempts SET cookie_hash = p_new_cookie_hash,
      result_expires_at = LEAST(p_until, created_at + interval '30 minutes')
    WHERE cookie_hash = p_cookie_hash AND used_at IS NOT NULL AND finished_at IS NULL
      AND result_expires_at > now() AND created_at > now() - interval '30 minutes';
  RETURN FOUND;
END $$;

-- finish reads its attempt: used, outcome stored, unexpired, within 30 minutes of the start. A link attempt is returned only
-- to the session that started it (p_sid_hash = bound_sid); presented by any other request it is ended.
CREATE OR REPLACE FUNCTION wts.oauth_attempt_finish(p_cookie_hash bytea, p_sid_hash bytea)
  RETURNS TABLE (id uuid, provider text, purpose text, result_enc bytea, result_expires_at timestamptz, bound_sid bytea,
                 bound_user uuid, public_device boolean, device_label_enc bytea, created_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  UPDATE wts.oauth_attempts a SET finished_at = now(), result_enc = NULL
    WHERE a.cookie_hash = p_cookie_hash AND a.purpose = 'link' AND a.finished_at IS NULL
      AND (p_sid_hash IS NULL OR a.bound_sid IS DISTINCT FROM p_sid_hash);
  RETURN QUERY SELECT a.id, a.provider, a.purpose, a.result_enc, a.result_expires_at, a.bound_sid, a.bound_user, a.public_device,
                      a.device_label_enc, a.created_at
    FROM wts.oauth_attempts a
    WHERE a.cookie_hash = p_cookie_hash AND a.used_at IS NOT NULL AND a.finished_at IS NULL AND a.result_enc IS NOT NULL
      AND a.result_expires_at > now() AND a.created_at > now() - interval '30 minutes';
END $$;

-- One finish at a time per attempt: a 30-second claim (a crashed request frees it by expiry). Returns false while another
-- finish of the same attempt holds it, or when the attempt has ended.
ALTER TABLE wts.oauth_attempts ADD COLUMN busy_until timestamptz;

CREATE FUNCTION wts.oauth_attempt_claim(p_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  UPDATE wts.oauth_attempts SET busy_until = now() + interval '30 seconds'
    WHERE id = p_id AND finished_at IS NULL AND (busy_until IS NULL OR busy_until <= now());
  RETURN FOUND;
END $$;

CREATE FUNCTION wts.oauth_attempt_release(p_id uuid)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  UPDATE wts.oauth_attempts SET busy_until = NULL WHERE id = p_id;
END $$;

CREATE FUNCTION wts.oauth_attempt_close(p_id uuid)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  UPDATE wts.oauth_attempts SET finished_at = now(), result_enc = NULL, pkce_verifier_enc = '\x'::bytea, busy_until = NULL
    WHERE id = p_id AND finished_at IS NULL;
END $$;

-- ── per-prefix exchange ceiling and the provider breaker (rate_counters, fixed windows, no timers) ─────────────────────
CREATE FUNCTION wts._window10() RETURNS timestamptz LANGUAGE sql STABLE
  AS $$ SELECT date_bin(interval '10 minutes', now(), timestamptz '2000-01-01 00:00:00+00') $$;

CREATE FUNCTION wts.oauth_exchange_hit(p_ip_prefix inet)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
DECLARE v_n bigint;
BEGIN
  INSERT INTO wts.rate_counters AS r (bucket, window_start, n)
    VALUES ('oauth_ex:' || COALESCE(host(p_ip_prefix) || '/' || masklen(p_ip_prefix), 'unknown'), wts._window10(), 1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET n = r.n + 1
    RETURNING r.n INTO v_n;
  RETURN v_n <= 30;
END $$;

-- A failed provider finish (ended with an error, or a wrong code): true once the prefix has more than 10 in the window (the
-- handler then delays its answer — soft, never refused). NULL prefix = the shared 'unknown' bucket.
CREATE FUNCTION wts.oauth_finish_fail(p_ip_prefix inet)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
DECLARE v_n bigint;
BEGIN
  INSERT INTO wts.rate_counters AS r (bucket, window_start, n)
    VALUES ('oauth_finfail:' || COALESCE(host(p_ip_prefix) || '/' || masklen(p_ip_prefix), 'unknown'), wts._window10(), 1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET n = r.n + 1
    RETURNING r.n INTO v_n;
  RETURN v_n > 10;
END $$;

-- The signing-key refetch limit across instances (§4.11): true for the first caller in a fixed 5-minute window per
-- provider, false for every later one (each instance also keeps its own in-memory limit).
CREATE FUNCTION wts.oidc_fetch_claim(p_provider text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  IF p_provider NOT IN ('google', 'linkedin') THEN RETURN false; END IF;
  INSERT INTO wts.rate_counters (bucket, window_start, n)
    VALUES ('oidc_fetch:' || p_provider, date_bin(interval '5 minutes', now(), timestamptz '2000-01-01 00:00:00+00'), 1)
    ON CONFLICT DO NOTHING;
  RETURN FOUND;
END $$;

CREATE FUNCTION wts.oauth_breaker_open(p_provider text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM wts.rate_counters WHERE bucket = 'oauth_brk_open:' || p_provider AND window_start > now());
END $$;

-- One exchange (or signing-key fetch) of a provider; p_bad = a provider-side failure (5xx, timeout, TLS, key fetch), never a
-- 4xx. Opens the breaker for 10 minutes with ≥ 20 exchanges in the window and > 50 % bad. Returns whether it is open.
CREATE FUNCTION wts.oauth_breaker_note(p_provider text, p_bad boolean)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
DECLARE v_total bigint; v_bad bigint := 0; v_w timestamptz := wts._window10();
BEGIN
  IF p_provider NOT IN ('google', 'linkedin') THEN RETURN false; END IF;
  INSERT INTO wts.rate_counters AS r (bucket, window_start, n) VALUES ('oauth_brk_total:' || p_provider, v_w, 1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET n = r.n + 1 RETURNING r.n INTO v_total;
  IF p_bad THEN
    INSERT INTO wts.rate_counters AS r (bucket, window_start, n) VALUES ('oauth_brk_bad:' || p_provider, v_w, 1)
      ON CONFLICT (bucket, window_start) DO UPDATE SET n = r.n + 1 RETURNING r.n INTO v_bad;
  ELSE
    SELECT COALESCE((SELECT n FROM wts.rate_counters WHERE bucket = 'oauth_brk_bad:' || p_provider AND window_start = v_w), 0) INTO v_bad;
  END IF;
  IF v_total >= 20 AND v_bad * 2 > v_total THEN
    INSERT INTO wts.rate_counters (bucket, window_start, n) VALUES ('oauth_brk_open:' || p_provider, now() + interval '10 minutes', 1)
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN wts.oauth_breaker_open(p_provider);
END $$;

-- ── signing-key cache (public keys only) ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION wts.oidc_key_get(p_provider text, p_kid text)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  RETURN (SELECT jwk FROM wts.oidc_keys WHERE provider = p_provider AND kid = p_kid AND expires_at > now());
END $$;

CREATE OR REPLACE FUNCTION wts.oidc_key_put(p_provider text, p_kid text, p_jwk jsonb, p_expires_at timestamptz)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
BEGIN
  IF p_provider NOT IN ('google', 'linkedin') OR p_kid IS NULL OR length(p_kid) > 256 THEN RETURN; END IF;
  -- public RSA keys only: any private member (d, p, q, dp, dq, qi) or another key type is refused
  IF p_jwk->>'kty' IS DISTINCT FROM 'RSA' OR p_jwk ?| ARRAY['d','p','q','dp','dq','qi','k'] THEN
    RAISE EXCEPTION 'oidc_key_put: public RSA keys only' USING ERRCODE = '22023';
  END IF;
  INSERT INTO wts.oidc_keys (provider, kid, jwk, fetched_at, expires_at)
    VALUES (p_provider, p_kid, p_jwk, now(), LEAST(p_expires_at, now() + interval '24 hours'))
    ON CONFLICT (provider, kid) DO UPDATE SET jwk = EXCLUDED.jwk, fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at;
END $$;

-- ── sessions ───────────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION wts.session_revoke_presented(p_sid_hash bytea)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
DECLARE v_user uuid;
BEGIN
  IF p_sid_hash IS NULL THEN RETURN NULL; END IF;
  DELETE FROM wts.sessions WHERE sid_hash = p_sid_hash RETURNING user_id INTO v_user;
  RETURN v_user;
END $$;

-- ── support: retire a provider client (§4.14, server/ops/retire-client.js) ─────────────────────────────────────────
-- The audit time as JavaScript's Date.prototype.toISOString() writes it (UTC, milliseconds, 'Z').
CREATE FUNCTION wts._iso_ms(p_at timestamptz) RETURNS text LANGUAGE sql IMMUTABLE
  AS $$ SELECT to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

-- The audit rows use the ONE hash of the per-user chain (core/wpo-s1.js auditHash; WP-S1's audit writer at the merge):
--   hash = sha256(prev_hash ‖ action ‖ '|' ‖ canonical(detail) ‖ '|' ‖ toISOString(at)), at in whole milliseconds,
-- canonical() = core/canon.js (keys sorted, no whitespace). The detail here has a fixed shape whose values need no escaping
-- (an allowed provider, a uuid, hex, an integer, a constant), so its canonical text is written out in sorted key order;
-- oauth-api.test.js verifies the chain across this writer and the JavaScript one.
-- The notice is queued through WP-S1's own outbox writer wts.mail_queue (not a direct insert), with to_enc = the account's
-- users.email_enc envelope as it is and params_enc = UTF-8 JSON {provider} (no personal data). This relies on the outbox
-- drainer opening to_enc with the users.email_enc AAD — WP-S1's outbox contract; checked at the WP-S1 merge (oauth-api.test.js
-- opens the queued row with that AAD).
CREATE FUNCTION wts.support_retire_identities(p_actor text, p_provider text)
  RETURNS TABLE (user_id uuid, identities integer, sessions integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = wts, pg_temp
  AS $$
DECLARE r record; v_s integer; v_prev bytea; v_canon text; v_at timestamptz := date_trunc('milliseconds', now());
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^support:[A-Za-z0-9_.-]{1,64}$' THEN
    RAISE EXCEPTION 'support_retire_identities: actor support:<id> required' USING ERRCODE = '22023';
  END IF;
  IF p_provider NOT IN ('google', 'linkedin') THEN RAISE EXCEPTION 'unknown provider' USING ERRCODE = '22023'; END IF;
  FOR r IN SELECT i.id, i.user_id AS uid, i.subject_bidx FROM wts.identities i WHERE i.provider = p_provider ORDER BY i.user_id LOOP
    SELECT count(*) INTO v_s FROM wts.sessions s WHERE s.identity_id = r.id;
    DELETE FROM wts.sessions s WHERE s.identity_id = r.id;
    DELETE FROM wts.identities i WHERE i.id = r.id;
    v_canon := '{"identity_id":"' || r.id::text || '","provider":"' || p_provider || '","reason":"retire_client","sessions":' || v_s::text
               || ',"subject_bidx":"' || encode(r.subject_bidx, 'hex') || '"}';
    SELECT a.hash INTO v_prev FROM wts.audit a WHERE a.user_id = r.uid ORDER BY a.id DESC LIMIT 1;
    INSERT INTO wts.audit (user_id, actor, action, target, at, detail, prev_hash, hash)
      VALUES (r.uid, p_actor, 'identity_unlink', p_provider, v_at, v_canon::jsonb, v_prev,
              sha256(COALESCE(v_prev, '\x'::bytea) || convert_to('identity_unlink|' || v_canon || '|' || wts._iso_ms(v_at), 'UTF8')));
    PERFORM wts.mail_queue(u.email_enc, 'notice_identity_unlinked', convert_to('{"provider":"' || p_provider || '"}', 'UTF8'))
      FROM wts.users u WHERE u.id = r.uid;
    user_id := r.uid; identities := 1; sessions := v_s;
    RETURN NEXT;
  END LOOP;
END $$;

RESET search_path;

-- owner and grants for the new functions (the replaced ones keep theirs)
ALTER FUNCTION wts.oauth_attempt_drop(bytea) OWNER TO wts_definer;
ALTER FUNCTION wts.oauth_attempt_close(uuid) OWNER TO wts_definer;
ALTER FUNCTION wts.oauth_exchange_hit(inet) OWNER TO wts_definer;
ALTER FUNCTION wts.oauth_breaker_open(text) OWNER TO wts_definer;
ALTER FUNCTION wts.oauth_breaker_note(text, boolean) OWNER TO wts_definer;
ALTER FUNCTION wts.session_revoke_presented(bytea) OWNER TO wts_definer;
ALTER FUNCTION wts.support_retire_identities(text, text) OWNER TO wts_definer;
ALTER FUNCTION wts.oauth_attempt_claim(uuid) OWNER TO wts_definer;
ALTER FUNCTION wts.oauth_attempt_release(uuid) OWNER TO wts_definer;
ALTER FUNCTION wts.oauth_finish_fail(inet) OWNER TO wts_definer;
ALTER FUNCTION wts.oidc_fetch_claim(text) OWNER TO wts_definer;
ALTER FUNCTION wts._window10() OWNER TO wts_owner;
ALTER FUNCTION wts._iso_ms(timestamptz) OWNER TO wts_owner;
REVOKE EXECUTE ON FUNCTION wts.oauth_attempt_drop(bytea), wts.oauth_attempt_close(uuid), wts.oauth_exchange_hit(inet),
  wts.oauth_breaker_open(text), wts.oauth_breaker_note(text, boolean), wts.session_revoke_presented(bytea),
  wts.support_retire_identities(text, text), wts._window10(), wts.oauth_attempt_claim(uuid), wts.oauth_attempt_release(uuid),
  wts.oauth_finish_fail(inet), wts.oidc_fetch_claim(text), wts._iso_ms(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wts._window10(), wts._iso_ms(timestamptz) TO wts_definer;
GRANT EXECUTE ON FUNCTION wts.oauth_attempt_drop(bytea), wts.oauth_attempt_close(uuid), wts.oauth_exchange_hit(inet),
  wts.oauth_breaker_open(text), wts.oauth_breaker_note(text, boolean), wts.session_revoke_presented(bytea),
  wts.oauth_attempt_claim(uuid), wts.oauth_attempt_release(uuid), wts.oauth_finish_fail(inet), wts.oidc_fetch_claim(text) TO wts_api;
GRANT EXECUTE ON FUNCTION wts.support_retire_identities(text, text) TO wts_support;
