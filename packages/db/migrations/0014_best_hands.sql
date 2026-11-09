-- Best hand (بهترین دست): the host records, per game, which player hit a royal flush,
-- straight flush or four of a kind, and how many times. Members of the home can read the
-- records; only the host may add or change them — also after the game is closed, because
-- the record is not part of the frozen game result or its hash.

CREATE TABLE best_hands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id),
  home_id uuid NOT NULL REFERENCES homes(id),
  player_id uuid NOT NULL REFERENCES players(id),
  hand text NOT NULL CHECK (hand IN ('royal_flush', 'straight_flush', 'four_of_a_kind')),
  -- How many times that player hit this hand in this game.
  times integer NOT NULL DEFAULT 1 CHECK (times BETWEEN 1 AND 99),
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One row per player and hand type per game: recording again overwrites the count.
  UNIQUE (game_id, player_id, hand)
);
CREATE INDEX best_hands_home_idx ON best_hands(home_id, created_at);

ALTER TABLE best_hands ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON best_hands TO app_user;
-- Everyone of the home sees the records; only the host may change them, and a record must
-- belong to a player and a game of that same home.
CREATE POLICY best_hands_read ON best_hands FOR SELECT TO app_user USING (app.is_member(home_id));
CREATE POLICY best_hands_change ON best_hands FOR ALL TO app_user
  USING (app.can_write(home_id))
  WITH CHECK (
    app.can_write(home_id)
    AND home_id = app.game_home(game_id)
    AND EXISTS (SELECT 1 FROM players p WHERE p.id = player_id AND p.home_id = home_id)
  );

CREATE TRIGGER best_hands_audit AFTER INSERT OR UPDATE OR DELETE ON best_hands
  FOR EACH ROW EXECUTE FUNCTION app.audit();
