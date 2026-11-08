-- Host can email an invite to a player who is already in the game history (a name typed
-- before the person had an account). The email is only a delivery address for the link:
-- accepting still signs the person up / in and links them to the player row (0012 renames
-- the placeholder name to the name they signed up with).

ALTER TABLE invites ADD COLUMN IF NOT EXISTS email text;
COMMENT ON COLUMN invites.email IS 'where the host emailed this invite; informational only';
