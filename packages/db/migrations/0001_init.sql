-- Poker Home: initial schema.
-- Security model (plan: "Security", "Roles and access"):
--   * The web app and bot connect as app_user. Every request runs in a transaction that
--     first does: SELECT set_config('app.user_id', '<uuid>', true). Row Level Security
--     then limits every table to homes the user belongs to. This is the second layer;
--     the first is the role check in the application.
--   * app_auth is used only by the sign-in code (users + sessions lookups).
--   * Closed games are frozen by triggers: no UPDATE/DELETE on them or their rows, for
--     anyone who has not disabled triggers. The per-home hash chain detects even that.
--   * audit_log is append-only.
--   * Money is bigint in the currency's smallest unit. Ids are UUIDs.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE SCHEMA IF NOT EXISTS app;

DO $$ BEGIN
  CREATE ROLE app_user NOLOGIN NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE app_auth NOLOGIN NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT USAGE ON SCHEMA public, app TO app_user, app_auth;

-- ---------------------------------------------------------------- helpers

CREATE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION app.require_user() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE uid uuid := app.current_user_id();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = '28000'; END IF;
  RETURN uid;
END $$;

-- ---------------------------------------------------------------- tables

CREATE TYPE plan AS ENUM ('free', 'pro');
CREATE TYPE member_role AS ENUM ('owner', 'member');
CREATE TYPE game_status AS ENUM ('draft', 'live', 'closed');
CREATE TYPE game_event_type AS ENUM ('buy_in', 'rebuy', 'cash_out', 'request', 'approve', 'reject', 'confirm', 'ruling');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE,
  email_verified_at timestamptz,
  password_hash text,
  display_name text NOT NULL DEFAULT '' CHECK (length(display_name) <= 80),
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('fa','en','ar','fr','it','ru','es')),
  telegram_id bigint UNIQUE,
  totp_secret_enc bytea,
  totp_enabled_at timestamptz,
  plan plan NOT NULL DEFAULT 'free',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  two_factor_passed boolean NOT NULL DEFAULT false,
  ip_hash bytea,
  user_agent text
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE homes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  unit_suffix text NOT NULL DEFAULT '' CHECK (length(unit_suffix) <= 8),
  unit_divisor integer NOT NULL DEFAULT 1 CHECK (unit_divisor > 0),
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('fa','en','ar','fr','it','ru','es')),
  telegram_chat_id bigint UNIQUE,
  require_confirmation boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Set when the owner's Pro lapses and this home is beyond the free quota. Nothing is deleted.
  read_only boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX homes_owner_idx ON homes(owner_id);

CREATE TABLE players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id uuid NOT NULL REFERENCES homes(id),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  user_id uuid REFERENCES users(id),
  avatar text,
  -- AES-256-GCM ciphertext; the key lives in KMS, never in the database.
  payment_info_enc bytea,
  merged_into uuid REFERENCES players(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (home_id, user_id)
);
CREATE UNIQUE INDEX players_home_name_idx ON players(home_id, lower(display_name)) WHERE merged_into IS NULL;

CREATE TABLE home_members (
  home_id uuid NOT NULL REFERENCES homes(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role member_role NOT NULL,
  player_id uuid REFERENCES players(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (home_id, user_id)
);
CREATE INDEX home_members_user_idx ON home_members(user_id);

CREATE TABLE games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id uuid NOT NULL REFERENCES homes(id),
  -- Sequential per home, assigned when the game closes.
  number integer,
  status game_status NOT NULL DEFAULT 'draft',
  default_buy_in bigint NOT NULL DEFAULT 0 CHECK (default_buy_in >= 0),
  started_at timestamptz,
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  close_key uuid UNIQUE,
  hash text CHECK (hash ~ '^[0-9a-f]{64}$'),
  prev_hash text CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (home_id, number),
  CHECK ((status = 'closed') = (number IS NOT NULL AND closed_at IS NOT NULL AND hash IS NOT NULL AND prev_hash IS NOT NULL))
);
CREATE INDEX games_home_idx ON games(home_id, status);

CREATE TABLE game_entries (
  game_id uuid NOT NULL REFERENCES games(id),
  player_id uuid NOT NULL REFERENCES players(id),
  total_in bigint NOT NULL DEFAULT 0 CHECK (total_in >= 0),
  cash_out bigint CHECK (cash_out >= 0),
  confirmed_at timestamptz,
  PRIMARY KEY (game_id, player_id)
);

CREATE TABLE game_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id),
  type game_event_type NOT NULL,
  player_id uuid REFERENCES players(id),
  amount bigint CHECK (amount >= 0),
  -- For approve/reject: the request being answered.
  request_id uuid REFERENCES game_events(id),
  details jsonb,
  actor_id uuid NOT NULL REFERENCES users(id),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX game_events_game_idx ON game_events(game_id, at);

CREATE TABLE settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games(id),
  from_player uuid NOT NULL REFERENCES players(id),
  to_player uuid NOT NULL REFERENCES players(id),
  amount bigint NOT NULL CHECK (amount > 0),
  CHECK (from_player <> to_player)
);
CREATE INDEX settlements_game_idx ON settlements(game_id);

-- The debt ledger is separate from games: marking a debt paid never touches a frozen game.
CREATE TABLE debt_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id uuid NOT NULL UNIQUE REFERENCES settlements(id),
  -- 'paid': someone marked it paid. 'carried': netted into a later game's settlement.
  kind text NOT NULL DEFAULT 'paid' CHECK (kind IN ('paid', 'carried')),
  carried_to_game uuid REFERENCES games(id),
  CHECK ((kind = 'carried') = (carried_to_game IS NOT NULL)),
  marked_by uuid NOT NULL REFERENCES users(id),
  marked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  home_id uuid NOT NULL REFERENCES homes(id),
  token_hash bytea NOT NULL UNIQUE,
  player_id uuid REFERENCES players(id),
  expires_at timestamptz NOT NULL,
  max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  uses integer NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  provider text NOT NULL,
  provider_ref text NOT NULL,
  status text NOT NULL,
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid,
  action text NOT NULL,
  target_table text NOT NULL,
  target_id text,
  home_id uuid,
  details jsonb,
  ip_hash bytea,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_home_idx ON audit_log(home_id, at);

-- ---------------------------------------------------------------- membership helpers
-- SECURITY DEFINER so policies can consult home_members without recursive RLS.

CREATE FUNCTION app.is_member(h uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM home_members m JOIN homes ho ON ho.id = m.home_id
    WHERE m.home_id = h AND m.user_id = app.current_user_id() AND ho.deleted_at IS NULL
  )
$$;

CREATE FUNCTION app.is_owner(h uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM homes ho
    WHERE ho.id = h AND ho.owner_id = app.current_user_id() AND ho.deleted_at IS NULL
  )
$$;

-- Owner who may still write: owner of a home that is not read-only.
CREATE FUNCTION app.can_write(h uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM homes ho
    WHERE ho.id = h AND ho.owner_id = app.current_user_id()
      AND ho.deleted_at IS NULL AND NOT ho.read_only
  )
$$;

CREATE FUNCTION app.game_home(g uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT home_id FROM games WHERE id = g
$$;

CREATE FUNCTION app.game_is_closed(g uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT coalesce((SELECT status = 'closed' FROM games WHERE id = g), false)
$$;

-- ---------------------------------------------------------------- freeze

CREATE FUNCTION app.freeze_games() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'game % is closed and cannot be changed', OLD.id USING ERRCODE = 'P0001', HINT = 'frozen';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status = 'draft' AND OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'a started game cannot go back to draft' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.id <> OLD.id OR NEW.home_id <> OLD.home_id THEN
      RAISE EXCEPTION 'game identity cannot change' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER games_freeze BEFORE UPDATE OR DELETE ON games
  FOR EACH ROW EXECUTE FUNCTION app.freeze_games();

CREATE FUNCTION app.freeze_game_rows() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE gid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN gid := OLD.game_id; ELSE gid := NEW.game_id; END IF;
  IF app.game_is_closed(gid) OR (TG_OP = 'UPDATE' AND app.game_is_closed(OLD.game_id)) THEN
    RAISE EXCEPTION 'game % is closed and cannot be changed', gid USING ERRCODE = 'P0001', HINT = 'frozen';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER game_entries_freeze BEFORE INSERT OR UPDATE OR DELETE ON game_entries
  FOR EACH ROW EXECUTE FUNCTION app.freeze_game_rows();
CREATE TRIGGER game_events_freeze BEFORE INSERT OR UPDATE OR DELETE ON game_events
  FOR EACH ROW EXECUTE FUNCTION app.freeze_game_rows();
CREATE TRIGGER settlements_freeze BEFORE INSERT OR UPDATE OR DELETE ON settlements
  FOR EACH ROW EXECUTE FUNCTION app.freeze_game_rows();

-- Any change to a live game's numbers bumps its version, so a stale close request loses.
CREATE FUNCTION app.bump_game_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE gid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN gid := OLD.game_id; ELSE gid := NEW.game_id; END IF;
  UPDATE games SET version = version + 1 WHERE id = gid AND status <> 'closed';
  RETURN NULL;
END $$;

CREATE TRIGGER game_entries_version AFTER INSERT OR UPDATE OR DELETE ON game_entries
  FOR EACH ROW EXECUTE FUNCTION app.bump_game_version();

-- ---------------------------------------------------------------- append-only audit log

CREATE FUNCTION app.audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_append_only();

CREATE FUNCTION app.audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  row_new jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  row_old jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  r jsonb := coalesce(row_new, row_old);
  h uuid;
BEGIN
  -- Secrets never go into the log.
  row_new := row_new - 'payment_info_enc' - 'token_hash' - 'password_hash' - 'totp_secret_enc';
  row_old := row_old - 'payment_info_enc' - 'token_hash' - 'password_hash' - 'totp_secret_enc';
  h := CASE TG_TABLE_NAME
         WHEN 'homes' THEN (r->>'id')::uuid
         WHEN 'game_entries' THEN app.game_home((r->>'game_id')::uuid)
         WHEN 'game_events' THEN app.game_home((r->>'game_id')::uuid)
         WHEN 'settlements' THEN app.game_home((r->>'game_id')::uuid)
         WHEN 'debt_payments' THEN NULL
         ELSE (r->>'home_id')::uuid
       END;
  INSERT INTO audit_log(actor_id, action, target_table, target_id, home_id, details)
  VALUES (app.current_user_id(), lower(TG_OP), TG_TABLE_NAME, coalesce(r->>'id', r->>'game_id'), h,
          jsonb_build_object('old', row_old, 'new', row_new));
  RETURN NULL;
END $$;

CREATE TRIGGER homes_audit AFTER INSERT OR UPDATE OR DELETE ON homes FOR EACH ROW EXECUTE FUNCTION app.audit();
CREATE TRIGGER home_members_audit AFTER INSERT OR UPDATE OR DELETE ON home_members FOR EACH ROW EXECUTE FUNCTION app.audit();
CREATE TRIGGER players_audit AFTER INSERT OR UPDATE OR DELETE ON players FOR EACH ROW EXECUTE FUNCTION app.audit();
CREATE TRIGGER games_audit AFTER INSERT OR UPDATE OR DELETE ON games FOR EACH ROW EXECUTE FUNCTION app.audit();
CREATE TRIGGER game_entries_audit AFTER INSERT OR UPDATE OR DELETE ON game_entries FOR EACH ROW EXECUTE FUNCTION app.audit();
CREATE TRIGGER game_events_audit AFTER INSERT ON game_events FOR EACH ROW EXECUTE FUNCTION app.audit();
CREATE TRIGGER settlements_audit AFTER INSERT ON settlements FOR EACH ROW EXECUTE FUNCTION app.audit();
CREATE TRIGGER debt_payments_audit AFTER INSERT OR DELETE ON debt_payments FOR EACH ROW EXECUTE FUNCTION app.audit();
CREATE TRIGGER invites_audit AFTER INSERT OR UPDATE ON invites FOR EACH ROW EXECUTE FUNCTION app.audit();

-- ---------------------------------------------------------------- plan limits
-- Checked inside the inserting transaction with the owner's row locked, so two concurrent
-- requests cannot both slip under the limit.

CREATE FUNCTION app.enforce_home_quota() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE p plan; n integer;
BEGIN
  SELECT plan INTO p FROM users WHERE id = NEW.owner_id FOR UPDATE;
  SELECT count(*) INTO n FROM homes WHERE owner_id = NEW.owner_id AND deleted_at IS NULL;
  IF n >= (CASE p WHEN 'pro' THEN 5 ELSE 1 END) THEN
    RAISE EXCEPTION 'home limit reached for plan %', p USING ERRCODE = 'P0001', HINT = 'upgrade';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER homes_quota BEFORE INSERT ON homes FOR EACH ROW EXECUTE FUNCTION app.enforce_home_quota();

CREATE FUNCTION app.enforce_game_quota() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE p plan; owner uuid; ro boolean; n integer;
BEGIN
  SELECT owner_id, read_only INTO owner, ro FROM homes WHERE id = NEW.home_id;
  IF ro THEN
    RAISE EXCEPTION 'home is read-only' USING ERRCODE = 'P0001', HINT = 'upgrade';
  END IF;
  SELECT plan INTO p FROM users WHERE id = owner FOR UPDATE;
  IF p = 'free' THEN
    SELECT count(*) INTO n FROM games g JOIN homes ho ON ho.id = g.home_id WHERE ho.owner_id = owner;
    IF n >= 3 THEN
      RAISE EXCEPTION 'free plan allows 3 games' USING ERRCODE = 'P0001', HINT = 'upgrade';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER games_quota BEFORE INSERT ON games FOR EACH ROW EXECUTE FUNCTION app.enforce_game_quota();

-- The owner is always a member.
CREATE FUNCTION app.add_owner_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
BEGIN
  INSERT INTO home_members(home_id, user_id, role) VALUES (NEW.id, NEW.owner_id, 'owner');
  RETURN NULL;
END $$;

CREATE TRIGGER homes_owner_member AFTER INSERT ON homes FOR EACH ROW EXECUTE FUNCTION app.add_owner_membership();

-- ---------------------------------------------------------------- RLS

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE homes ENABLE ROW LEVEL SECURITY;
ALTER TABLE home_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE games ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE debt_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- users: see and edit only yourself (plus names of people you share a home with, via a view later)
GRANT SELECT, UPDATE (display_name, locale) ON users TO app_user;
CREATE POLICY users_self ON users FOR SELECT TO app_user USING (id = app.current_user_id());
CREATE POLICY users_self_update ON users FOR UPDATE TO app_user USING (id = app.current_user_id());

-- sign-in code
GRANT SELECT, INSERT, UPDATE ON users TO app_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO app_auth;
CREATE POLICY users_auth ON users TO app_auth USING (true) WITH CHECK (true);
CREATE POLICY sessions_auth ON sessions TO app_auth USING (true) WITH CHECK (true);
-- a signed-in user can list and revoke their own sessions
GRANT SELECT, DELETE ON sessions TO app_user;
CREATE POLICY sessions_self ON sessions TO app_user USING (user_id = app.current_user_id());

GRANT SELECT, INSERT, UPDATE ON homes TO app_user;
CREATE POLICY homes_read ON homes FOR SELECT TO app_user
  USING (app.is_member(id) OR (owner_id = app.current_user_id() AND deleted_at IS NULL));
CREATE POLICY homes_create ON homes FOR INSERT TO app_user WITH CHECK (owner_id = app.require_user() AND NOT read_only);
CREATE POLICY homes_update ON homes FOR UPDATE TO app_user
  USING (owner_id = app.current_user_id() AND deleted_at IS NULL)
  WITH CHECK (owner_id = app.current_user_id());

GRANT SELECT, DELETE ON home_members TO app_user;
CREATE POLICY members_read ON home_members FOR SELECT TO app_user USING (app.is_member(home_id));
CREATE POLICY members_remove ON home_members FOR DELETE TO app_user
  USING (app.is_owner(home_id) AND role = 'member');

GRANT SELECT, INSERT, UPDATE ON players TO app_user;
CREATE POLICY players_read ON players FOR SELECT TO app_user USING (app.is_member(home_id));
CREATE POLICY players_write ON players FOR INSERT TO app_user WITH CHECK (app.can_write(home_id));
CREATE POLICY players_update ON players FOR UPDATE TO app_user USING (app.can_write(home_id)) WITH CHECK (app.can_write(home_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON games TO app_user;
CREATE POLICY games_read ON games FOR SELECT TO app_user USING (app.is_member(home_id));
CREATE POLICY games_create ON games FOR INSERT TO app_user
  WITH CHECK (app.can_write(home_id) AND created_by = app.current_user_id() AND status <> 'closed');
CREATE POLICY games_update ON games FOR UPDATE TO app_user USING (app.can_write(home_id)) WITH CHECK (app.can_write(home_id));
CREATE POLICY games_delete ON games FOR DELETE TO app_user USING (app.can_write(home_id) AND status = 'draft');

GRANT SELECT, INSERT, UPDATE, DELETE ON game_entries TO app_user;
CREATE POLICY entries_read ON game_entries FOR SELECT TO app_user USING (app.is_member(app.game_home(game_id)));
CREATE POLICY entries_write ON game_entries FOR ALL TO app_user
  USING (app.can_write(app.game_home(game_id))) WITH CHECK (app.can_write(app.game_home(game_id)));

GRANT SELECT, INSERT ON game_events TO app_user;
CREATE POLICY events_read ON game_events FOR SELECT TO app_user USING (app.is_member(app.game_home(game_id)));
CREATE POLICY events_host ON game_events FOR INSERT TO app_user
  WITH CHECK (app.can_write(app.game_home(game_id)) AND actor_id = app.current_user_id());
-- A member may only ask for a rebuy, and only for their own player.
CREATE POLICY events_member_request ON game_events FOR INSERT TO app_user
  WITH CHECK (
    type = 'request' AND actor_id = app.current_user_id()
    AND app.is_member(app.game_home(game_id))
    AND EXISTS (SELECT 1 FROM players p WHERE p.id = player_id AND p.user_id = app.current_user_id())
  );

GRANT SELECT, INSERT ON settlements TO app_user;
CREATE POLICY settlements_read ON settlements FOR SELECT TO app_user USING (app.is_member(app.game_home(game_id)));
CREATE POLICY settlements_write ON settlements FOR INSERT TO app_user WITH CHECK (app.can_write(app.game_home(game_id)));

GRANT SELECT, INSERT, DELETE ON debt_payments TO app_user;
CREATE POLICY payments_read ON debt_payments FOR SELECT TO app_user
  USING (app.is_member(app.game_home((SELECT game_id FROM settlements s WHERE s.id = settlement_id))));
-- The host, or the creditor of that very debt. Only the host carries debts forward.
CREATE POLICY payments_mark ON debt_payments FOR INSERT TO app_user
  WITH CHECK (
    marked_by = app.current_user_id()
    AND (kind = 'paid' OR app.can_write(app.game_home(carried_to_game)))
    AND EXISTS (
      SELECT 1 FROM settlements s JOIN players p ON p.id = s.to_player
      WHERE s.id = settlement_id
        AND (app.is_owner(p.home_id) OR p.user_id = app.current_user_id())
    )
  );
CREATE POLICY payments_unmark ON debt_payments FOR DELETE TO app_user USING (marked_by = app.current_user_id() AND kind = 'paid');

GRANT SELECT, INSERT, UPDATE (revoked_at) ON invites TO app_user;
CREATE POLICY invites_owner ON invites TO app_user USING (app.is_owner(home_id)) WITH CHECK (app.can_write(home_id) AND created_by = app.current_user_id());

GRANT SELECT ON subscriptions TO app_user;
CREATE POLICY subscriptions_self ON subscriptions FOR SELECT TO app_user USING (user_id = app.current_user_id());

-- audit_log: no direct access for app roles; rows are written by SECURITY DEFINER triggers.
REVOKE ALL ON audit_log FROM PUBLIC;

-- ---------------------------------------------------------------- operations that need definer rights

-- A member confirms their own result before the host closes.
CREATE FUNCTION app.confirm_result(g uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE uid uuid := app.require_user(); n integer;
BEGIN
  UPDATE game_entries e SET confirmed_at = now()
  FROM players p
  WHERE e.game_id = g AND e.player_id = p.id AND p.user_id = uid AND app.is_member(p.home_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RAISE EXCEPTION 'nothing to confirm' USING ERRCODE = 'P0002'; END IF;
END $$;

-- Accept an invite: token is hashed by the caller (sha256) so the raw token never reaches SQL logs.
CREATE FUNCTION app.accept_invite(token_hash_in bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE uid uuid := app.require_user(); inv invites%ROWTYPE;
BEGIN
  SELECT * INTO inv FROM invites WHERE token_hash = token_hash_in FOR UPDATE;
  IF NOT FOUND OR inv.revoked_at IS NOT NULL OR inv.expires_at < now() OR inv.uses >= inv.max_uses THEN
    RAISE EXCEPTION 'invite is not valid' USING ERRCODE = 'P0002';
  END IF;
  UPDATE invites SET uses = uses + 1 WHERE id = inv.id;
  INSERT INTO home_members(home_id, user_id, role) VALUES (inv.home_id, uid, 'member')
  ON CONFLICT (home_id, user_id) DO NOTHING;
  -- Link the account-less player the host picked, so their history follows them.
  IF inv.player_id IS NOT NULL THEN
    UPDATE players SET user_id = uid WHERE id = inv.player_id AND user_id IS NULL;
    UPDATE home_members SET player_id = inv.player_id WHERE home_id = inv.home_id AND user_id = uid;
  END IF;
  RETURN inv.home_id;
END $$;

REVOKE ALL ON FUNCTION app.confirm_result(uuid), app.accept_invite(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.confirm_result(uuid), app.accept_invite(bytea) TO app_user;
GRANT EXECUTE ON FUNCTION app.current_user_id(), app.require_user(), app.is_member(uuid),
  app.is_owner(uuid), app.can_write(uuid), app.game_home(uuid), app.game_is_closed(uuid) TO app_user, app_auth;
