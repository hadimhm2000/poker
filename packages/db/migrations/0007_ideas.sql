-- Special ideas #2 to #7 of the plan: companion referee log, verifiable fair draw,
-- cross-home debt netting, voice rebuys (no schema), good-payer index (homes.settings)
-- and the night story.

-- ---------------------------------------------------------------- helpers

-- The caller sits in this game (their player has an entry) or hosts its home.
CREATE FUNCTION app.in_game(g uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT app.is_member(app.game_home(g)) AND (
    app.is_owner(app.game_home(g))
    OR EXISTS (
      SELECT 1 FROM game_entries e JOIN players p ON p.id = e.player_id
      WHERE e.game_id = g AND p.user_id = app.current_user_id()
    )
  )
$$;
REVOKE ALL ON FUNCTION app.in_game(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.in_game(uuid) TO app_user;

-- Rows that are a record: nobody changes or removes them, not even the table owner.
CREATE FUNCTION app.append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001', HINT = 'frozen';
END $$;

-- ---------------------------------------------------------------- #2 companion referee
-- A disputed showdown, decided by the hand engine on the server and kept in the game's log.
-- Anyone in the game may add one while it is not closed; the log stays readable after close.
CREATE TABLE game_rulings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id),
  home_id uuid NOT NULL REFERENCES homes(id),
  variant text NOT NULL CHECK (variant IN ('holdem', 'omaha')),
  -- Input and verdict exactly as the engine saw and gave them (card codes like "As").
  board text[] NOT NULL CHECK (cardinality(board) = 5),
  hands jsonb NOT NULL CHECK (jsonb_typeof(hands) = 'array' AND jsonb_array_length(hands) BETWEEN 2 AND 10),
  winners text[] NOT NULL CHECK (cardinality(winners) >= 1),
  decided_by jsonb NOT NULL,
  situation text CHECK (situation ~ '^[A-Za-z]{1,40}$'),
  via text NOT NULL DEFAULT 'web' CHECK (via IN ('web', 'telegram')),
  actor_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX game_rulings_game_idx ON game_rulings(game_id, created_at);

ALTER TABLE game_rulings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON game_rulings TO app_user;
GRANT SELECT ON game_rulings TO app_jobs;
CREATE POLICY rulings_read ON game_rulings FOR SELECT TO app_user USING (app.is_member(home_id));
CREATE POLICY rulings_add ON game_rulings FOR INSERT TO app_user
  WITH CHECK (
    actor_id = app.current_user_id()
    AND home_id = app.game_home(game_id)
    AND app.in_game(game_id)
    AND NOT app.game_is_closed(game_id)
  );
CREATE POLICY rulings_jobs ON game_rulings FOR SELECT TO app_jobs USING (true);

CREATE TRIGGER game_rulings_append_only BEFORE UPDATE OR DELETE ON game_rulings
  FOR EACH ROW EXECUTE FUNCTION app.append_only();
CREATE TRIGGER game_rulings_audit AFTER INSERT ON game_rulings FOR EACH ROW EXECUTE FUNCTION app.audit();
CREATE TRIGGER game_rulings_notify AFTER INSERT ON game_rulings FOR EACH ROW EXECUTE FUNCTION app.notify_game();

-- ---------------------------------------------------------------- #3 verifiable fair draw
-- Commit-reveal. The web server makes a random seed; the database stores it with its
-- commitment sha256(seed). The seed column stays NULL (and the secret copy is unreadable to
-- app roles) until the host reveals, so nobody, the host included, knows the result early.
-- The result itself is not stored: it is recomputed from seed + contributions everywhere.
CREATE TABLE game_draws (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id),
  home_id uuid NOT NULL REFERENCES homes(id),
  "commit" text NOT NULL CHECK ("commit" ~ '^[0-9a-f]{64}$'),
  seed_secret text NOT NULL CHECK (seed_secret ~ '^[0-9a-f]{64}$'),
  seed text CHECK (seed IS NULL OR seed = seed_secret),
  -- The players taking part, sorted by id (the starting order of the shuffle).
  players uuid[] NOT NULL CHECK (cardinality(players) BETWEEN 2 AND 40),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revealed_at timestamptz,
  CHECK ((seed IS NULL) = (revealed_at IS NULL))
);
CREATE INDEX game_draws_game_idx ON game_draws(game_id, created_at);
-- One open draw per game at a time.
CREATE UNIQUE INDEX game_draws_one_open ON game_draws(game_id) WHERE revealed_at IS NULL;

CREATE TABLE draw_contributions (
  draw_id uuid NOT NULL REFERENCES game_draws(id),
  player_id uuid NOT NULL REFERENCES players(id),
  user_id uuid NOT NULL REFERENCES users(id),
  value text NOT NULL CHECK (value ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (draw_id, player_id)
);

CREATE FUNCTION app.draw_home(d uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT home_id FROM game_draws WHERE id = d
$$;

-- The caller's own player takes part in this draw and the seed is not revealed yet.
CREATE FUNCTION app.can_contribute(d uuid, p uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM game_draws dr JOIN players pl ON pl.id = p
    WHERE dr.id = d AND dr.revealed_at IS NULL AND p = ANY (dr.players)
      AND pl.user_id = app.current_user_id() AND app.is_member(dr.home_id)
  )
$$;

ALTER TABLE game_draws ENABLE ROW LEVEL SECURITY;
ALTER TABLE draw_contributions ENABLE ROW LEVEL SECURITY;
-- Every column except the secret seed.
GRANT SELECT (id, game_id, home_id, "commit", seed, players, created_by, created_at, revealed_at) ON game_draws TO app_user, app_jobs;
CREATE POLICY draws_read ON game_draws FOR SELECT TO app_user USING (app.is_member(home_id));
CREATE POLICY draws_jobs ON game_draws FOR SELECT TO app_jobs USING (true);
GRANT SELECT, INSERT ON draw_contributions TO app_user;
GRANT SELECT ON draw_contributions TO app_jobs;
CREATE POLICY contributions_read ON draw_contributions FOR SELECT TO app_user USING (app.is_member(app.draw_home(draw_id)));
CREATE POLICY contributions_add ON draw_contributions FOR INSERT TO app_user
  WITH CHECK (user_id = app.current_user_id() AND app.can_contribute(draw_id, player_id));
CREATE POLICY contributions_jobs ON draw_contributions FOR SELECT TO app_jobs USING (true);

CREATE TRIGGER draw_contributions_append_only BEFORE UPDATE OR DELETE ON draw_contributions
  FOR EACH ROW EXECUTE FUNCTION app.append_only();
CREATE TRIGGER draw_contributions_audit AFTER INSERT ON draw_contributions FOR EACH ROW EXECUTE FUNCTION app.audit();

-- Nothing about a draw may change except its one-time reveal.
CREATE FUNCTION app.guard_draw() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.revealed_at IS NOT NULL OR NEW.seed IS DISTINCT FROM NEW.seed_secret
     OR NEW.id <> OLD.id OR NEW.game_id <> OLD.game_id OR NEW.home_id <> OLD.home_id OR NEW."commit" <> OLD."commit"
     OR NEW.seed_secret <> OLD.seed_secret OR NEW.players <> OLD.players OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'a draw cannot be changed' USING ERRCODE = 'P0001', HINT = 'frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER game_draws_guard BEFORE UPDATE OR DELETE ON game_draws FOR EACH ROW EXECUTE FUNCTION app.guard_draw();

-- The host starts a draw among the players of a live game. The seed comes from the web
-- server's CSPRNG; the commitment is computed here so it always matches it.
CREATE FUNCTION app.start_draw(g uuid, seed_in text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE uid uuid := app.require_user(); h uuid := app.game_home(g); ps uuid[]; d uuid;
BEGIN
  IF h IS NULL OR NOT app.can_write(h) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  IF (SELECT status FROM games WHERE id = g) <> 'live' THEN
    RAISE EXCEPTION 'game % is closed and cannot be changed', g USING ERRCODE = 'P0001', HINT = 'frozen';
  END IF;
  IF seed_in !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid seed' USING ERRCODE = '22023'; END IF;
  SELECT array_agg(player_id ORDER BY player_id::text COLLATE "C") INTO ps FROM game_entries WHERE game_id = g;
  IF coalesce(cardinality(ps), 0) < 2 THEN
    RAISE EXCEPTION 'a draw needs at least two players' USING ERRCODE = 'P0001', HINT = 'draw_players';
  END IF;
  INSERT INTO game_draws(game_id, home_id, "commit", seed_secret, players, created_by)
  VALUES (g, h, encode(sha256(decode(seed_in, 'hex')), 'hex'), seed_in, ps, uid)
  RETURNING id INTO d;
  PERFORM pg_notify('game_changed', g::text);
  RETURN d;
END $$;

-- The host reveals: the seed becomes readable and contributions close.
CREATE FUNCTION app.reveal_draw(d uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE g uuid; h uuid; revealed timestamptz;
BEGIN
  PERFORM app.require_user();
  SELECT game_id, home_id, revealed_at INTO g, h, revealed FROM game_draws WHERE id = d FOR UPDATE;
  IF h IS NULL OR NOT app.can_write(h) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  IF revealed IS NOT NULL THEN RAISE EXCEPTION 'draw already revealed' USING ERRCODE = 'P0001', HINT = 'already_answered'; END IF;
  UPDATE game_draws SET seed = seed_secret, revealed_at = now() WHERE id = d;
  PERFORM pg_notify('game_changed', g::text);
  RETURN g;
END $$;

REVOKE ALL ON FUNCTION app.draw_home(uuid), app.can_contribute(uuid, uuid), app.start_draw(uuid, text), app.reveal_draw(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.draw_home(uuid), app.can_contribute(uuid, uuid), app.start_draw(uuid, text), app.reveal_draw(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION app.draw_home(uuid) TO app_jobs;

-- ---------------------------------------------------------------- #4 cross-home debt netting
-- If A owes B in one home and B owes A in another, both may agree to cancel the smaller
-- amount on both sides. The netted amount is recorded as payments of kind 'netted' against
-- both settlements; games and settlements (frozen) are never touched. A settlement is open
-- while it has no 'paid'/'carried' payment and netting has not covered all of it.

CREATE TABLE netting_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposer uuid NOT NULL REFERENCES users(id),
  responder uuid NOT NULL REFERENCES users(id),
  -- proposer owes responder here ...
  proposer_debt uuid NOT NULL REFERENCES settlements(id),
  -- ... and responder owes proposer here (another home).
  responder_debt uuid NOT NULL REFERENCES settlements(id),
  amount bigint NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'canceled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  CHECK (proposer <> responder),
  CHECK ((status = 'pending') = (answered_at IS NULL))
);
CREATE UNIQUE INDEX netting_one_pending ON netting_proposals(proposer_debt, responder_debt) WHERE status = 'pending';
CREATE INDEX netting_proposer_idx ON netting_proposals(proposer);
CREATE INDEX netting_responder_idx ON netting_proposals(responder);

ALTER TABLE debt_payments DROP CONSTRAINT debt_payments_settlement_id_key;
ALTER TABLE debt_payments DROP CONSTRAINT debt_payments_kind_check;
ALTER TABLE debt_payments ADD CONSTRAINT debt_payments_kind_check CHECK (kind IN ('paid', 'carried', 'netted'));
-- Only for 'netted': the part of the debt that was cancelled. 'paid' and 'carried' settle the rest.
ALTER TABLE debt_payments ADD COLUMN amount bigint CHECK (amount > 0);
ALTER TABLE debt_payments ADD COLUMN netting_id uuid REFERENCES netting_proposals(id);
ALTER TABLE debt_payments ADD CONSTRAINT debt_payments_netted_shape
  CHECK ((kind = 'netted') = (netting_id IS NOT NULL) AND (kind = 'netted') = (amount IS NOT NULL));
-- A debt is finally settled (paid or carried) once; netting may cover parts before that.
CREATE UNIQUE INDEX debt_payments_final_once ON debt_payments(settlement_id) WHERE kind IN ('paid', 'carried');
CREATE INDEX debt_payments_settlement_idx ON debt_payments(settlement_id);

-- Serialize payments per settlement and never net more than is still open.
CREATE FUNCTION app.guard_debt_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE total bigint; netted bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('settlement:' || NEW.settlement_id::text));
  IF EXISTS (SELECT 1 FROM debt_payments WHERE settlement_id = NEW.settlement_id AND kind IN ('paid', 'carried')) THEN
    RAISE EXCEPTION 'debt is already settled (duplicate key)' USING ERRCODE = '23505';
  END IF;
  SELECT amount INTO total FROM settlements WHERE id = NEW.settlement_id;
  SELECT coalesce(sum(amount), 0) INTO netted FROM debt_payments WHERE settlement_id = NEW.settlement_id AND kind = 'netted';
  IF NEW.kind <> 'netted' AND netted >= total THEN
    RAISE EXCEPTION 'debt is already settled (duplicate key)' USING ERRCODE = '23505';
  END IF;
  IF NEW.kind = 'netted' AND netted + NEW.amount > total THEN
    RAISE EXCEPTION 'netting is more than the open debt' USING ERRCODE = 'P0001', HINT = 'netting_stale';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER debt_payments_guard BEFORE INSERT ON debt_payments FOR EACH ROW EXECUTE FUNCTION app.guard_debt_payment();

-- Users may insert only 'paid' and 'carried' payments; 'netted' ones come from answer_netting().
ALTER POLICY payments_mark ON debt_payments
  WITH CHECK (
    marked_by = app.current_user_id()
    AND (kind = 'paid' OR (kind = 'carried' AND app.can_write(app.game_home(carried_to_game))))
    AND EXISTS (
      SELECT 1 FROM settlements s JOIN players p ON p.id = s.to_player
      WHERE s.id = settlement_id
        AND (app.is_owner(p.home_id) OR p.user_id = app.current_user_id())
    )
  );

-- Open debts with what is still owed. security_invoker: the caller's RLS applies.
CREATE VIEW open_debts WITH (security_invoker = true) AS
  SELECT s.id, s.game_id, g.home_id, g.number AS game_number, g.closed_at,
         s.from_player, s.to_player, s.amount,
         s.amount - coalesce((SELECT sum(p.amount) FROM debt_payments p WHERE p.settlement_id = s.id AND p.kind = 'netted'), 0)::bigint AS remaining
  FROM settlements s JOIN games g ON g.id = s.game_id
  WHERE g.status = 'closed'
    AND NOT EXISTS (SELECT 1 FROM debt_payments p WHERE p.settlement_id = s.id AND p.kind IN ('paid', 'carried'))
    AND s.amount > coalesce((SELECT sum(p.amount) FROM debt_payments p WHERE p.settlement_id = s.id AND p.kind = 'netted'), 0);
GRANT SELECT ON open_debts TO app_user, app_jobs;

ALTER TABLE netting_proposals ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON netting_proposals TO app_user;
-- Only the two people involved ever see a proposal.
CREATE POLICY netting_parties ON netting_proposals FOR SELECT TO app_user
  USING (app.current_user_id() IN (proposer, responder));
CREATE TRIGGER netting_proposals_audit AFTER INSERT OR UPDATE ON netting_proposals FOR EACH ROW EXECUTE FUNCTION app.audit();

-- What is still owed on a settlement right now (0 when settled).
CREATE FUNCTION app.debt_open_amount(s uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT coalesce((SELECT remaining FROM open_debts WHERE id = s), 0)
$$;

-- The debtor's and creditor's users of a settlement, and its home.
CREATE FUNCTION app.debt_parties(s uuid, OUT debtor uuid, OUT creditor uuid, OUT home uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT pf.user_id, pt.user_id, g.home_id
  FROM settlements st
  JOIN games g ON g.id = st.game_id
  JOIN players pf ON pf.id = st.from_player
  JOIN players pt ON pt.id = st.to_player
  WHERE st.id = s
$$;

CREATE FUNCTION app.propose_netting(mine uuid, theirs uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  uid uuid := app.require_user();
  a record; b record; amt bigint; p uuid;
BEGIN
  SELECT * INTO a FROM app.debt_parties(mine);
  SELECT * INTO b FROM app.debt_parties(theirs);
  IF a.debtor IS DISTINCT FROM uid OR a.creditor IS NULL OR a.creditor = uid
     OR b.creditor IS DISTINCT FROM uid OR b.debtor IS DISTINCT FROM a.creditor
     OR a.home = b.home OR NOT app.is_member(a.home) OR NOT app.is_member(b.home)
     OR NOT EXISTS (SELECT 1 FROM home_members m JOIN homes ho ON ho.id = m.home_id AND ho.deleted_at IS NULL
                    WHERE m.home_id = a.home AND m.user_id = a.creditor)
     OR NOT EXISTS (SELECT 1 FROM home_members m JOIN homes ho ON ho.id = m.home_id AND ho.deleted_at IS NULL
                    WHERE m.home_id = b.home AND m.user_id = a.creditor) THEN
    RAISE EXCEPTION 'netting is not possible for these debts' USING ERRCODE = 'P0001', HINT = 'netting_invalid';
  END IF;
  amt := least(app.debt_open_amount(mine), app.debt_open_amount(theirs));
  IF amt <= 0 THEN
    RAISE EXCEPTION 'netting is not possible for these debts' USING ERRCODE = 'P0001', HINT = 'netting_invalid';
  END IF;
  INSERT INTO netting_proposals(proposer, responder, proposer_debt, responder_debt, amount)
  VALUES (uid, a.creditor, mine, theirs, amt)
  RETURNING id INTO p;
  RETURN p;
END $$;

-- The other person accepts (both debts shrink by the amount) or declines. The proposal row
-- is locked, so two accepts at once record the netting once.
CREATE FUNCTION app.answer_netting(p uuid, accept boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE uid uuid := app.require_user(); n netting_proposals%ROWTYPE;
BEGIN
  SELECT * INTO n FROM netting_proposals WHERE id = p FOR UPDATE;
  IF NOT FOUND OR uid NOT IN (n.proposer, n.responder) THEN RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002'; END IF;
  IF n.status <> 'pending' THEN
    RAISE EXCEPTION 'netting already answered' USING ERRCODE = 'P0001', HINT = 'already_answered';
  END IF;
  IF uid <> n.responder THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  IF accept THEN
    IF app.debt_open_amount(n.proposer_debt) < n.amount OR app.debt_open_amount(n.responder_debt) < n.amount THEN
      RAISE EXCEPTION 'netting is more than the open debt' USING ERRCODE = 'P0001', HINT = 'netting_stale';
    END IF;
    INSERT INTO debt_payments(settlement_id, kind, amount, netting_id, marked_by)
    VALUES (n.proposer_debt, 'netted', n.amount, n.id, uid), (n.responder_debt, 'netted', n.amount, n.id, uid);
  END IF;
  UPDATE netting_proposals SET status = CASE WHEN accept THEN 'accepted' ELSE 'declined' END, answered_at = now()
  WHERE id = p;
END $$;

CREATE FUNCTION app.cancel_netting(p uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE uid uuid := app.require_user(); n integer;
BEGIN
  UPDATE netting_proposals SET status = 'canceled', answered_at = now()
  WHERE id = p AND proposer = uid AND status = 'pending';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RAISE EXCEPTION 'netting already answered' USING ERRCODE = 'P0001', HINT = 'already_answered'; END IF;
END $$;

REVOKE ALL ON FUNCTION app.debt_open_amount(uuid), app.debt_parties(uuid), app.propose_netting(uuid, uuid),
  app.answer_netting(uuid, boolean), app.cancel_netting(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.propose_netting(uuid, uuid), app.answer_netting(uuid, boolean), app.cancel_netting(uuid) TO app_user;

-- ---------------------------------------------------------------- #7 night story
-- A short story of the night, written once after close by the background role from the
-- game's own names and numbers. Not part of the frozen result or its hash.
CREATE TABLE game_stories (
  game_id uuid PRIMARY KEY REFERENCES games(id),
  home_id uuid NOT NULL REFERENCES homes(id),
  locale text NOT NULL CHECK (locale IN ('fa','en','ar','fr','it','ru','es')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  model text NOT NULL CHECK (length(model) <= 80),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE game_stories ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON game_stories TO app_user;
GRANT SELECT, INSERT ON game_stories TO app_jobs;
CREATE POLICY stories_read ON game_stories FOR SELECT TO app_user USING (app.is_member(home_id));
CREATE POLICY stories_jobs_read ON game_stories FOR SELECT TO app_jobs USING (true);
CREATE POLICY stories_jobs_write ON game_stories FOR INSERT TO app_jobs
  WITH CHECK (app.game_is_closed(game_id) AND home_id = app.game_home(game_id));
GRANT EXECUTE ON FUNCTION app.game_is_closed(uuid) TO app_jobs;

CREATE TRIGGER game_stories_append_only BEFORE UPDATE OR DELETE ON game_stories
  FOR EACH ROW EXECUTE FUNCTION app.append_only();
CREATE TRIGGER game_stories_audit AFTER INSERT ON game_stories FOR EACH ROW EXECUTE FUNCTION app.audit();
