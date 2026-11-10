-- Host: delete a game that is NOT closed yet (started by mistake, or numbers beyond repair).
--
-- The app role cannot DELETE from the append-only tables (game_events, settlements, game_rulings,
-- draw_contributions, game_draws, game_stories, invites), by design. This one function is the only
-- door: it checks the caller is the home's host, refuses a closed game (closed games are frozen
-- history, their hash chain stays verifiable), then removes every row of that game in one
-- transaction. The guard triggers are switched off only inside this transaction and only for the
-- tables that block it; if anything fails the whole thing rolls back and they are back on.

CREATE FUNCTION app.delete_open_game(g uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  h uuid;
  st text;
  trg record;
BEGIN
  PERFORM app.require_user();

  SELECT home_id, status::text INTO h, st FROM games WHERE id = g FOR UPDATE;
  IF h IS NULL OR NOT app.can_write(h) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF st = 'closed' THEN
    RAISE EXCEPTION 'game % is closed and cannot be changed', g USING ERRCODE = 'P0001', HINT = 'frozen';
  END IF;

  FOR trg IN
    SELECT tgrelid::regclass AS rel, tgname FROM pg_trigger
    WHERE NOT tgisinternal
      AND tgfoid IN ('app.append_only'::regproc, 'app.guard_draw'::regproc)
      AND tgrelid IN ('game_rulings'::regclass, 'game_draws'::regclass,
                      'draw_contributions'::regclass, 'game_stories'::regclass)
  LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', trg.rel, trg.tgname);
  END LOOP;

  DELETE FROM draw_contributions WHERE draw_id IN (SELECT id FROM game_draws WHERE game_id = g);
  DELETE FROM game_draws WHERE game_id = g;
  DELETE FROM game_rulings WHERE game_id = g;
  DELETE FROM game_stories WHERE game_id = g;
  DELETE FROM invites WHERE game_id = g;
  DELETE FROM game_events WHERE game_id = g;
  DELETE FROM game_entries WHERE game_id = g;
  DELETE FROM settlements WHERE game_id = g;
  DELETE FROM games WHERE id = g AND status <> 'closed';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'game % is closed and cannot be changed', g USING ERRCODE = 'P0001', HINT = 'frozen';
  END IF;

  FOR trg IN
    SELECT tgrelid::regclass AS rel, tgname FROM pg_trigger
    WHERE NOT tgisinternal
      AND tgfoid IN ('app.append_only'::regproc, 'app.guard_draw'::regproc)
      AND tgrelid IN ('game_rulings'::regclass, 'game_draws'::regclass,
                      'draw_contributions'::regclass, 'game_stories'::regclass)
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE TRIGGER %I', trg.rel, trg.tgname);
  END LOOP;

  RETURN h;
END $$;

REVOKE ALL ON FUNCTION app.delete_open_game(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_open_game(uuid) TO app_user;
