-- Hosts could never actually delete a game. The web action showed the button and then
-- tried to remove the child rows itself, but the database never allowed any of it:
-- app roles hold no DELETE grant on draw_contributions, game_draws, game_rulings,
-- game_stories, invites, game_events or settlements, the games_delete policy only
-- covered draft games, and the append-only triggers freeze those tables anyway.
-- Every attempt died on the very first statement ("permission denied for table
-- draw_contributions"), which the app translates into the FORBIDDEN banner.
--
-- Fix follows the app.delete_account pattern: one SECURITY DEFINER function checks the
-- host's rights itself and removes the game with everything that points at it — including
-- the best-hand records of that game (0014), which would otherwise both block the delete
-- on their FK and keep counting towards the home's totals. The append-only guards stand
-- aside only while this very function runs, signalled by a transaction-local setting.
-- App roles cannot abuse that hatch: without DELETE grants they cannot even reach those
-- triggers, and the games / game_entries policies stay exactly as strict as before.

-- 1) The append-only guards let a whole-game deletion pass. Anything else still freezes.
CREATE OR REPLACE FUNCTION app.append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('app.deleting_game', true), '') <> '' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001', HINT = 'frozen';
END $$;

CREATE OR REPLACE FUNCTION app.guard_draw() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.deleting_game', true), '') <> '' THEN
    RETURN OLD;  -- app.delete_game is removing the whole game, draws included
  END IF;
  IF TG_OP = 'DELETE' OR OLD.revealed_at IS NOT NULL OR NEW.seed IS DISTINCT FROM NEW.seed_secret
     OR NEW.id <> OLD.id OR NEW.game_id <> OLD.game_id OR NEW.home_id <> OLD.home_id OR NEW."commit" <> OLD."commit"
     OR NEW.seed_secret <> OLD.seed_secret OR NEW.players <> OLD.players OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'a draw cannot be changed' USING ERRCODE = 'P0001', HINT = 'frozen';
  END IF;
  RETURN NEW;
END $$;

-- 2) The bomb-squad function the web action calls. It checks the host's rights itself
-- (definer rights bypass RLS, so the checks live here), then removes the game with
-- everything that points at it. A closed game is frozen history and never goes; if a
-- close slips in between the check and the delete, the games_freeze trigger still stops
-- the last statement and the whole transaction rolls back.
CREATE FUNCTION app.delete_game(g uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE h uuid; st text;
BEGIN
  SELECT home_id, status INTO h, st FROM games WHERE id = g FOR UPDATE;
  IF h IS NULL THEN RETURN; END IF;  -- already gone; the action's pre-checks said their piece
  IF NOT app.can_write(h) THEN
    RAISE EXCEPTION 'deleting this game is not allowed' USING ERRCODE = '42501', HINT = 'not allowed';
  END IF;
  IF st = 'closed' THEN
    RAISE EXCEPTION 'game % is closed and cannot be changed', g USING ERRCODE = 'P0001', HINT = 'frozen';
  END IF;

  PERFORM set_config('app.deleting_game', 'on', true);
  DELETE FROM draw_contributions WHERE draw_id IN (SELECT id FROM game_draws WHERE game_id = g);
  DELETE FROM game_draws WHERE game_id = g;
  DELETE FROM game_rulings WHERE game_id = g;
  DELETE FROM game_stories WHERE game_id = g;
  DELETE FROM best_hands WHERE game_id = g;
  DELETE FROM invites WHERE game_id = g;
  -- A never-closed game has no settlements of its own; carried_to_game links are the old
  -- debt-folding leftovers. Removing them re-opens those debts, which is the honest
  -- state once the game itself is declared a mistake.
  DELETE FROM debt_payments WHERE carried_to_game = g
     OR settlement_id IN (SELECT id FROM settlements WHERE game_id = g);
  DELETE FROM game_events WHERE game_id = g;
  DELETE FROM settlements WHERE game_id = g;
  DELETE FROM game_entries WHERE game_id = g;
  DELETE FROM games WHERE id = g;
  PERFORM set_config('app.deleting_game', '', true);
END $$;
REVOKE ALL ON FUNCTION app.delete_game(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_game(uuid) TO app_user;
