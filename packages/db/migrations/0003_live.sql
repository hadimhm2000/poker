-- Phase 3: live game, Telegram, game-night invites, debt reminders.

-- ---------------------------------------------------------------- live game

-- Client-generated key per queued change (weak-internet queue): a retried request applies once.
ALTER TABLE game_events ADD COLUMN op_key uuid UNIQUE;

-- A rebuy request is answered once: two taps, or two devices, cannot approve it twice.
CREATE UNIQUE INDEX game_events_answer_once ON game_events(request_id) WHERE type IN ('approve', 'reject');

-- A join link from a game's QR code: joining makes you a member of the home and lands on the game.
ALTER TABLE invites ADD COLUMN game_id uuid REFERENCES games(id);

-- Every change to a game wakes the live pages watching it. The payload is only the game id;
-- each page then re-reads through RLS, so nothing leaks through the channel.
CREATE FUNCTION app.notify_game() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  IF TG_TABLE_NAME = 'games' THEN
    PERFORM pg_notify('game_changed', r.id::text);
  ELSE
    PERFORM pg_notify('game_changed', r.game_id::text);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER games_notify AFTER INSERT OR UPDATE ON games FOR EACH ROW EXECUTE FUNCTION app.notify_game();
CREATE TRIGGER game_entries_notify AFTER INSERT OR UPDATE OR DELETE ON game_entries FOR EACH ROW EXECUTE FUNCTION app.notify_game();
CREATE TRIGGER game_events_notify AFTER INSERT ON game_events FOR EACH ROW EXECUTE FUNCTION app.notify_game();

-- Join a live game from its QR code. The token is hashed by the caller.
CREATE FUNCTION app.join_game(token_hash_in bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE uid uuid := app.require_user(); inv invites%ROWTYPE;
BEGIN
  SELECT * INTO inv FROM invites WHERE token_hash = token_hash_in AND game_id IS NOT NULL FOR UPDATE;
  IF NOT FOUND OR inv.revoked_at IS NOT NULL OR inv.expires_at < now() OR inv.uses >= inv.max_uses
     OR app.game_is_closed(inv.game_id) THEN
    RAISE EXCEPTION 'invite is not valid' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM home_members WHERE home_id = inv.home_id AND user_id = uid) THEN
    UPDATE invites SET uses = uses + 1 WHERE id = inv.id;
    INSERT INTO home_members(home_id, user_id, role) VALUES (inv.home_id, uid, 'member');
  END IF;
  RETURN inv.game_id;
END $$;

-- "This is me": a member links themselves to an account-less player sitting in a live game.
-- Only players without an account, and only if the member has no player in this home yet.
-- The host sees who claimed whom and can undo it (players UPDATE is the host's).
CREATE FUNCTION app.claim_player(g uuid, p uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE uid uuid := app.require_user(); h uuid := app.game_home(g); n integer;
BEGIN
  IF h IS NULL OR NOT app.is_member(h) OR app.game_is_closed(g) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM players WHERE home_id = h AND user_id = uid) THEN
    RAISE EXCEPTION 'you already have a player in this home' USING ERRCODE = 'P0001', HINT = 'already_linked';
  END IF;
  UPDATE players SET user_id = uid
  WHERE id = p AND home_id = h AND user_id IS NULL AND merged_into IS NULL
    AND EXISTS (SELECT 1 FROM game_entries e WHERE e.game_id = g AND e.player_id = p);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RAISE EXCEPTION 'player cannot be claimed' USING ERRCODE = 'P0002'; END IF;
  UPDATE home_members SET player_id = p WHERE home_id = h AND user_id = uid;
END $$;

REVOKE ALL ON FUNCTION app.join_game(bytea), app.claim_player(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.join_game(bytea), app.claim_player(uuid, uuid) TO app_user;

-- ---------------------------------------------------------------- game nights

CREATE TABLE game_nights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id uuid NOT NULL REFERENCES homes(id),
  starts_at timestamptz NOT NULL,
  place text NOT NULL DEFAULT '' CHECK (length(place) <= 120),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  canceled_at timestamptz,
  reminded_at timestamptz,
  -- The group message with the RSVP buttons, so it can be edited as answers come in.
  telegram_message_id bigint
);
CREATE INDEX game_nights_home_idx ON game_nights(home_id, starts_at);

CREATE TABLE night_rsvps (
  night_id uuid NOT NULL REFERENCES game_nights(id),
  user_id uuid NOT NULL REFERENCES users(id),
  answer text NOT NULL CHECK (answer IN ('yes', 'no', 'maybe')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (night_id, user_id)
);

CREATE FUNCTION app.night_home(n uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT home_id FROM game_nights WHERE id = n
$$;
GRANT EXECUTE ON FUNCTION app.night_home(uuid) TO app_user;

ALTER TABLE game_nights ENABLE ROW LEVEL SECURITY;
ALTER TABLE night_rsvps ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE (starts_at, place, note, canceled_at, telegram_message_id) ON game_nights TO app_user;
CREATE POLICY nights_read ON game_nights FOR SELECT TO app_user USING (app.is_member(home_id));
CREATE POLICY nights_create ON game_nights FOR INSERT TO app_user
  WITH CHECK (app.can_write(home_id) AND created_by = app.current_user_id() AND canceled_at IS NULL);
CREATE POLICY nights_update ON game_nights FOR UPDATE TO app_user
  USING (app.can_write(home_id)) WITH CHECK (app.can_write(home_id));

GRANT SELECT, INSERT, UPDATE (answer, updated_at) ON night_rsvps TO app_user;
CREATE POLICY rsvps_read ON night_rsvps FOR SELECT TO app_user USING (app.is_member(app.night_home(night_id)));
CREATE POLICY rsvps_own ON night_rsvps FOR INSERT TO app_user
  WITH CHECK (user_id = app.current_user_id() AND app.is_member(app.night_home(night_id)));
CREATE POLICY rsvps_own_update ON night_rsvps FOR UPDATE TO app_user
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id() AND app.is_member(app.night_home(night_id)));

CREATE TRIGGER game_nights_audit AFTER INSERT OR UPDATE ON game_nights FOR EACH ROW EXECUTE FUNCTION app.audit();

-- ---------------------------------------------------------------- Telegram linking

-- One-time codes carried in t.me deep links: ?start=<code> links a Telegram account to a site
-- account; ?startgroup=<code> links a group to a home. Only the hash is stored.
CREATE TABLE telegram_link_codes (
  code_hash bytea PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('account', 'group')),
  user_id uuid NOT NULL REFERENCES users(id),
  home_id uuid REFERENCES homes(id),
  CHECK ((purpose = 'group') = (home_id IS NOT NULL)),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE telegram_link_codes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE (used_at) ON telegram_link_codes TO app_auth;
CREATE POLICY link_codes_auth ON telegram_link_codes TO app_auth USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- background jobs
-- Reminders run outside any request, so they get their own narrow role: read what a reminder
-- needs across homes, write only the reminder bookkeeping. Never used for request handling.

DO $$ BEGIN
  CREATE ROLE app_jobs NOLOGIN NOBYPASSRLS;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;
GRANT USAGE ON SCHEMA public, app TO app_jobs;

CREATE TABLE debt_reminders (
  id bigserial PRIMARY KEY,
  settlement_id uuid NOT NULL REFERENCES settlements(id),
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX debt_reminders_settlement_idx ON debt_reminders(settlement_id, sent_at);
ALTER TABLE debt_reminders ENABLE ROW LEVEL SECURITY;

GRANT SELECT (id, locale, display_name, telegram_id, deleted_at) ON users TO app_jobs;
GRANT SELECT ON homes, home_members, players, games, game_entries, game_events, settlements, debt_payments,
  game_nights, night_rsvps TO app_jobs;
GRANT UPDATE (reminded_at, telegram_message_id) ON game_nights TO app_jobs;
GRANT SELECT, INSERT ON debt_reminders TO app_jobs;
GRANT USAGE ON SEQUENCE debt_reminders_id_seq TO app_jobs;

CREATE POLICY users_jobs ON users FOR SELECT TO app_jobs USING (true);
CREATE POLICY homes_jobs ON homes FOR SELECT TO app_jobs USING (true);
CREATE POLICY members_jobs ON home_members FOR SELECT TO app_jobs USING (true);
CREATE POLICY players_jobs ON players FOR SELECT TO app_jobs USING (true);
CREATE POLICY games_jobs ON games FOR SELECT TO app_jobs USING (true);
CREATE POLICY entries_jobs ON game_entries FOR SELECT TO app_jobs USING (true);
CREATE POLICY events_jobs ON game_events FOR SELECT TO app_jobs USING (true);
CREATE POLICY settlements_jobs ON settlements FOR SELECT TO app_jobs USING (true);
CREATE POLICY payments_jobs ON debt_payments FOR SELECT TO app_jobs USING (true);
CREATE POLICY nights_jobs ON game_nights FOR SELECT TO app_jobs USING (true);
CREATE POLICY nights_jobs_update ON game_nights FOR UPDATE TO app_jobs USING (true) WITH CHECK (true);
CREATE POLICY rsvps_jobs ON night_rsvps FOR SELECT TO app_jobs USING (true);
CREATE POLICY debt_reminders_jobs ON debt_reminders TO app_jobs USING (true) WITH CHECK (true);
GRANT EXECUTE ON FUNCTION app.current_user_id(), app.game_home(uuid), app.night_home(uuid) TO app_jobs;

-- A game's join link must belong to that game's home.
ALTER POLICY invites_owner ON invites
  WITH CHECK (app.can_write(home_id) AND created_by = app.current_user_id()
              AND (game_id IS NULL OR app.game_home(game_id) = home_id));
