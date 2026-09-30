-- Phase 4 rest: seasons, house rules, and public verification of a result card.

-- ---------------------------------------------------------------- house rules
-- Free text the host writes for their own table (e.g. "rebuy cap: 3"), shown next to the
-- official rules with its own label.
ALTER TABLE homes ADD COLUMN house_rules text NOT NULL DEFAULT '' CHECK (length(house_rules) <= 2000);

-- ---------------------------------------------------------------- seasons
-- A named date range with its own leaderboard. All-time statistics are never reset.
CREATE TABLE seasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id uuid NOT NULL REFERENCES homes(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  starts_on date NOT NULL,
  -- Last day included; NULL while the season is open.
  ends_on date CHECK (ends_on IS NULL OR ends_on >= starts_on),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX seasons_home_idx ON seasons(home_id, starts_on);

ALTER TABLE seasons ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE (name, starts_on, ends_on), DELETE ON seasons TO app_user;
CREATE POLICY seasons_read ON seasons FOR SELECT TO app_user USING (app.is_member(home_id));
CREATE POLICY seasons_create ON seasons FOR INSERT TO app_user
  WITH CHECK (app.can_write(home_id) AND created_by = app.current_user_id());
CREATE POLICY seasons_update ON seasons FOR UPDATE TO app_user
  USING (app.can_write(home_id)) WITH CHECK (app.can_write(home_id));
CREATE POLICY seasons_delete ON seasons FOR DELETE TO app_user USING (app.can_write(home_id));

CREATE TRIGGER seasons_audit AFTER INSERT OR UPDATE OR DELETE ON seasons FOR EACH ROW EXECUTE FUNCTION app.audit();

-- ---------------------------------------------------------------- verification
-- The QR on a result card links to /verify/<hash>. Knowing a closed game's hash is the
-- permission to see that one game; the 256-bit hash cannot be guessed. The function returns
-- the game with names, plus the home's chain up to it (amounts by player id only) so the
-- server can recheck every link. The page shows the verdict, never the earlier games.
CREATE INDEX games_hash_idx ON games(hash) WHERE hash IS NOT NULL;

CREATE FUNCTION app.verify_game(h text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT jsonb_build_object(
    'homeId', g.home_id,
    'homeName', ho.name,
    'locale', ho.locale,
    'currency', ho.currency,
    'unitSuffix', ho.unit_suffix,
    'unitDivisor', ho.unit_divisor,
    'number', g.number,
    'closedAt', g.closed_at,
    'hash', g.hash,
    'prevHash', g.prev_hash,
    'entries', (
      SELECT jsonb_agg(jsonb_build_object('playerId', e.player_id, 'name', p.display_name,
                                          'totalIn', e.total_in, 'cashOut', e.cash_out)
                       ORDER BY e.cash_out - e.total_in DESC, p.display_name)
      FROM game_entries e JOIN players p ON p.id = e.player_id WHERE e.game_id = g.id),
    'chain', (
      SELECT jsonb_agg(jsonb_build_object(
               'number', c.number, 'closedAt', c.closed_at, 'hash', c.hash, 'prevHash', c.prev_hash,
               'entries', (SELECT jsonb_agg(jsonb_build_object('playerId', e.player_id,
                                                                'totalIn', e.total_in, 'cashOut', e.cash_out))
                           FROM game_entries e WHERE e.game_id = c.id))
             ORDER BY c.number)
      FROM games c
      WHERE c.home_id = g.home_id AND c.status = 'closed' AND c.number <= g.number)
  )
  FROM games g JOIN homes ho ON ho.id = g.home_id
  WHERE g.hash = h AND g.status = 'closed' AND h ~ '^[0-9a-f]{64}$'
$$;
REVOKE ALL ON FUNCTION app.verify_game(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.verify_game(text) TO app_auth, app_user;
