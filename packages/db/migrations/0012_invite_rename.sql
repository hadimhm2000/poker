-- Player invites by email: when someone accepts an invite bound to a player row (a name the
-- host typed before the person had an account), the name they signed up with replaces the
-- placeholder name. If it is the same name, nothing changes. A collision with another player
-- of the same home (unique index on lower(display_name)) keeps the old name instead of failing
-- the whole accept.

CREATE OR REPLACE FUNCTION app.accept_invite(token_hash_in bytea) RETURNS uuid
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
    -- The name this person entered when creating their account replaces the placeholder name
    -- the host typed. Only when the player is now theirs, the name is usable, and no other
    -- player of this home already has it (case-insensitively).
    BEGIN
      UPDATE players p SET display_name = u.display_name
      FROM users u
      WHERE p.id = inv.player_id
        AND p.user_id = uid
        AND p.merged_into IS NULL
        AND u.id = uid
        AND u.display_name <> ''
        AND length(u.display_name) BETWEEN 1 AND 40
        AND p.display_name <> u.display_name
        AND NOT EXISTS (
          SELECT 1 FROM players q
          WHERE q.home_id = p.home_id
            AND q.id <> p.id
            AND q.merged_into IS NULL
            AND lower(q.display_name) = lower(u.display_name)
        );
    EXCEPTION WHEN unique_violation THEN
      NULL;  -- someone took the name meanwhile: keep the placeholder name
    END;
  END IF;
  RETURN inv.home_id;
END $$;

REVOKE ALL ON FUNCTION app.accept_invite(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_invite(bytea) TO app_user;
