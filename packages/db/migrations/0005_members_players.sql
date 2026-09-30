-- Home and player modules: member list and removal, avatars, payment details, merging duplicates.

-- ---------------------------------------------------------------- members

-- Members cannot read each other's users rows (users_self), so the member list comes from a
-- definer function that exposes only a name, never an email. Empty for non-members.
CREATE FUNCTION app.home_member_list(h uuid)
RETURNS TABLE (user_id uuid, name text, role member_role, joined_at timestamptz, player_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT m.user_id, coalesce(nullif(u.display_name, ''), p.display_name, ''), m.role, m.joined_at, m.player_id
  FROM home_members m
  JOIN users u ON u.id = m.user_id
  LEFT JOIN players p ON p.home_id = m.home_id AND p.user_id = m.user_id AND p.merged_into IS NULL
  WHERE m.home_id = h AND app.is_member(h)
  ORDER BY m.role, m.joined_at
$$;
REVOKE ALL ON FUNCTION app.home_member_list(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_member_list(uuid) TO app_user;

-- Removal itself is the existing members_remove policy (host only, never the owner row).

-- ---------------------------------------------------------------- avatars
-- Keep in sync with AVATARS in packages/db/src/players.ts (a test checks both).
ALTER TABLE players ADD CONSTRAINT players_avatar_check CHECK (avatar IS NULL OR avatar IN (
  '🦊', '🐻', '🐼', '🦁', '🐯', '🐸', '🐵', '🦉', '🦈', '🐙', '🐺', '🦄', '🐲', '🤠', '😎', '🤖', '👑', '🎩', '🍀', '🔥', '💎', '🃏', '🎲', '🚀'
));
-- Ciphertext only; the plaintext is short (card number, IBAN, PayPal address).
ALTER TABLE players ADD CONSTRAINT players_payment_len CHECK (octet_length(payment_info_enc) <= 1024);

-- The host edits any player of the home (players_update). The player's own linked user may set
-- their own avatar and payment details, and nothing else, through these functions.
CREATE FUNCTION app.can_edit_player(pid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM players p
    WHERE p.id = pid AND p.merged_into IS NULL
      AND (app.can_write(p.home_id) OR (p.user_id = app.current_user_id() AND app.is_member(p.home_id)))
  )
$$;

CREATE FUNCTION app.set_player_avatar(pid uuid, a text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
BEGIN
  PERFORM app.require_user();
  IF NOT app.can_edit_player(pid) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  UPDATE players SET avatar = a WHERE id = pid;
END $$;

CREATE FUNCTION app.set_player_payment(pid uuid, enc bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
BEGIN
  PERFORM app.require_user();
  IF NOT app.can_edit_player(pid) THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  UPDATE players SET payment_info_enc = enc WHERE id = pid;
END $$;

REVOKE ALL ON FUNCTION app.can_edit_player(uuid), app.set_player_avatar(uuid, text), app.set_player_payment(uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_edit_player(uuid), app.set_player_avatar(uuid, text), app.set_player_payment(uuid, bytea) TO app_user;

-- ---------------------------------------------------------------- merging duplicates
-- A merged player never sits at a table again: its rows in open games move to the kept player.
CREATE FUNCTION app.refuse_merged_player() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM players WHERE id = NEW.player_id AND merged_into IS NOT NULL) THEN
    RAISE EXCEPTION 'player was merged into another player' USING ERRCODE = 'P0001', HINT = 'merged';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER game_entries_not_merged BEFORE INSERT OR UPDATE OF player_id ON game_entries
  FOR EACH ROW EXECUTE FUNCTION app.refuse_merged_player();

-- Merge `dup` into `keep` (host only, same home). Only open games change: the duplicate's entries
-- and events there move to the kept player. Closed games are frozen and keep the duplicate's id;
-- statistics map it to the kept player when reading (repo.resultRows). The freeze triggers still
-- guard every row this touches.
CREATE FUNCTION app.merge_players(keep uuid, dup uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE k players%ROWTYPE; d players%ROWTYPE;
BEGIN
  PERFORM app.require_user();
  IF keep = dup THEN RAISE EXCEPTION 'cannot merge a player into itself' USING ERRCODE = '22023'; END IF;
  -- Lock both in id order so two concurrent merges cannot deadlock.
  PERFORM 1 FROM players WHERE id IN (keep, dup) ORDER BY id FOR UPDATE;
  SELECT * INTO k FROM players WHERE id = keep;
  SELECT * INTO d FROM players WHERE id = dup;
  IF k.id IS NULL OR d.id IS NULL OR k.home_id <> d.home_id OR NOT app.can_write(k.home_id) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF k.merged_into IS NOT NULL OR d.merged_into IS NOT NULL THEN
    RAISE EXCEPTION 'player was merged into another player' USING ERRCODE = 'P0001', HINT = 'merged';
  END IF;
  IF k.user_id IS NOT NULL AND d.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'both players are linked to accounts' USING ERRCODE = 'P0001', HINT = 'merge_linked';
  END IF;
  IF EXISTS (
    SELECT 1 FROM game_entries a JOIN game_entries b ON b.game_id = a.game_id
    WHERE a.player_id = keep AND b.player_id = dup AND NOT app.game_is_closed(a.game_id)
  ) THEN
    RAISE EXCEPTION 'both players are in the same open game' USING ERRCODE = 'P0001', HINT = 'merge_same_game';
  END IF;

  UPDATE game_entries SET player_id = keep WHERE player_id = dup AND NOT app.game_is_closed(game_id);
  UPDATE game_events SET player_id = keep WHERE player_id = dup AND NOT app.game_is_closed(game_id);
  UPDATE invites SET player_id = keep WHERE player_id = dup;
  -- Earlier merges into the duplicate now point at the kept player: chains stay one step deep.
  UPDATE players SET merged_into = keep WHERE merged_into = dup;
  UPDATE players SET merged_into = keep, user_id = NULL WHERE id = dup;
  UPDATE players SET
    user_id = coalesce(k.user_id, d.user_id),
    avatar = coalesce(k.avatar, d.avatar),
    payment_info_enc = coalesce(k.payment_info_enc, d.payment_info_enc)
  WHERE id = keep;
  UPDATE home_members SET player_id = keep WHERE home_id = k.home_id AND player_id = dup;
END $$;

REVOKE ALL ON FUNCTION app.merge_players(uuid, uuid), app.refuse_merged_player() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.merge_players(uuid, uuid) TO app_user;
