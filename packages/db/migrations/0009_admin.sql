-- Limited site admin for support. The plan: a site admin never browses people's games; a
-- home's history is opened only for a support request, for one hour, with a written reason,
-- and every admin step is in the append-only audit log. Admins are chosen in the app
-- (ADMIN_EMAILS, two-step verification required); these functions run as the sign-in role.

CREATE TABLE support_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES users(id),
  home_id uuid NOT NULL REFERENCES homes(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_grants_idx ON support_grants(admin_id, home_id, expires_at);
ALTER TABLE support_grants ENABLE ROW LEVEL SECURITY;
-- Only through the functions below.

CREATE FUNCTION app.admin_note(actor uuid, act text, target text, h uuid, info jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, app AS $$
  INSERT INTO audit_log(actor_id, action, target_table, target_id, home_id, details)
  VALUES (actor, 'admin:' || act, 'admin', target, h, info);
$$;
REVOKE ALL ON FUNCTION app.admin_note(uuid, text, text, uuid, jsonb) FROM PUBLIC;

CREATE FUNCTION app.admin_overview(actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE r jsonb;
BEGIN
  SELECT jsonb_build_object(
    'users', (SELECT count(*) FROM users WHERE deleted_at IS NULL),
    'usersNew30d', (SELECT count(*) FROM users WHERE deleted_at IS NULL AND created_at > now() - interval '30 days'),
    'pro', (SELECT count(*) FROM users WHERE deleted_at IS NULL AND plan = 'pro'),
    'homes', (SELECT count(*) FROM homes WHERE deleted_at IS NULL),
    'gamesClosed', (SELECT count(*) FROM games WHERE status = 'closed'),
    'gamesClosed30d', (SELECT count(*) FROM games WHERE status = 'closed' AND closed_at > now() - interval '30 days'),
    'twoFactor', (SELECT count(*) FROM users WHERE deleted_at IS NULL AND totp_enabled_at IS NOT NULL),
    'telegram', (SELECT count(*) FROM users WHERE deleted_at IS NULL AND telegram_id IS NOT NULL)
  ) INTO r;
  RETURN r;
END $$;

-- Find an account by email (prefix) for a support request. Counts only, no game data.
CREATE FUNCTION app.admin_find_users(actor uuid, q text)
RETURNS TABLE (id uuid, email text, display_name text, created_at timestamptz, plan text,
               two_factor boolean, telegram boolean, homes_owned int, memberships int, deleted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE clean text := replace(replace(replace(coalesce(q, ''), '\', ''), '%', ''), '_', '\_');
BEGIN
  IF length(replace(clean, '\_', '_')) < 3 THEN RETURN; END IF;
  PERFORM app.admin_note(actor, 'find_users', NULL, NULL, jsonb_build_object('q', q));
  RETURN QUERY
    SELECT u.id, u.email::text, u.display_name, u.created_at, u.plan::text, u.totp_enabled_at IS NOT NULL,
           u.telegram_id IS NOT NULL,
           (SELECT count(*)::int FROM homes h WHERE h.owner_id = u.id AND h.deleted_at IS NULL),
           (SELECT count(*)::int FROM home_members m WHERE m.user_id = u.id),
           u.deleted_at IS NOT NULL
      FROM users u
     WHERE u.email ILIKE clean || '%' OR u.id::text = q
     ORDER BY u.created_at DESC
     LIMIT 20;
END $$;

CREATE FUNCTION app.admin_set_plan(actor uuid, uid uuid, p text, reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
BEGIN
  IF length(coalesce(reason, '')) < 5 THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = '22023'; END IF;
  UPDATE users SET plan = p::plan WHERE id = uid AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'account not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.admin_note(actor, 'set_plan', uid::text, NULL, jsonb_build_object('plan', p, 'reason', reason));
END $$;

CREATE FUNCTION app.admin_end_sessions(actor uuid, uid uuid, reason text) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE n int;
BEGIN
  IF length(coalesce(reason, '')) < 5 THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = '22023'; END IF;
  DELETE FROM sessions WHERE user_id = uid;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM app.admin_note(actor, 'end_sessions', uid::text, NULL, jsonb_build_object('reason', reason, 'count', n));
  RETURN n;
END $$;

-- Open one home's history for a support request: one hour, reason required, logged.
CREATE FUNCTION app.admin_open_home(actor uuid, h uuid, reason text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE until timestamptz := now() + interval '1 hour';
BEGIN
  IF length(coalesce(reason, '')) < 5 THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM homes WHERE id = h) THEN RAISE EXCEPTION 'home not found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO support_grants(admin_id, home_id, reason, expires_at) VALUES (actor, h, reason, until);
  PERFORM app.admin_note(actor, 'open_home', h::text, h, jsonb_build_object('reason', reason, 'until', until));
  RETURN until;
END $$;

-- Read-only view of a home under an open grant. Every view is logged.
CREATE FUNCTION app.admin_view_home(actor uuid, h uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE r jsonb; until timestamptz;
BEGIN
  SELECT max(expires_at) INTO until FROM support_grants
   WHERE admin_id = actor AND home_id = h AND expires_at > now();
  IF until IS NULL THEN RAISE EXCEPTION 'no open support access' USING ERRCODE = '42501'; END IF;
  PERFORM app.admin_note(actor, 'view_home', h::text, h, NULL);
  SELECT jsonb_build_object(
    'id', ho.id, 'name', ho.name, 'createdAt', ho.created_at, 'deletedAt', ho.deleted_at, 'until', until,
    'owner', (SELECT email::text FROM users WHERE id = ho.owner_id),
    'members', (SELECT count(*) FROM home_members WHERE home_id = ho.id),
    'players', (SELECT count(*) FROM players WHERE home_id = ho.id),
    'games', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'number', g.number, 'status', g.status, 'closedAt', g.closed_at, 'hash', g.hash,
               'entries', (SELECT coalesce(jsonb_agg(jsonb_build_object('player', p.display_name, 'in', e.total_in, 'out', e.cash_out)
                                                     ORDER BY p.display_name), '[]')
                             FROM game_entries e JOIN players p ON p.id = e.player_id WHERE e.game_id = g.id))
             ORDER BY g.created_at DESC)
        FROM (SELECT * FROM games WHERE home_id = ho.id ORDER BY created_at DESC LIMIT 50) g), '[]')
  ) INTO r FROM homes ho WHERE ho.id = h;
  RETURN r;
END $$;

CREATE FUNCTION app.admin_recent(actor uuid, n int)
RETURNS TABLE (at timestamptz, actor_email text, action text, target text, details jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path = public, app AS $$
  SELECT a.at, u.email::text, a.action, a.target_id, a.details
    FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
   WHERE a.action LIKE 'admin:%'
   ORDER BY a.id DESC
   LIMIT least(greatest(n, 1), 200);
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'app.admin_overview(uuid)', 'app.admin_find_users(uuid, text)', 'app.admin_set_plan(uuid, uuid, text, text)',
    'app.admin_end_sessions(uuid, uuid, text)', 'app.admin_open_home(uuid, uuid, text)',
    'app.admin_view_home(uuid, uuid)', 'app.admin_recent(uuid, int)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_auth', f);
  END LOOP;
END $$;
