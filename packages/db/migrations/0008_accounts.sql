-- Account module: 2FA recovery codes, email verification and password reset, Google and
-- Apple sign-in, notification settings, and account deletion (GDPR).

-- ---------------------------------------------------------------- recovery codes
-- Ten single-use codes shown once when 2FA is turned on. Only a SHA-256 of each is kept
-- (the codes are random, 50 bits each, so a fast hash is enough). Sign-in code only.
CREATE TABLE recovery_codes (
  user_id uuid NOT NULL REFERENCES users(id),
  code_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  PRIMARY KEY (user_id, code_hash)
);
ALTER TABLE recovery_codes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE (used_at), DELETE ON recovery_codes TO app_auth;
CREATE POLICY recovery_codes_auth ON recovery_codes TO app_auth USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- email links
-- One-time links sent by email: confirm the address, or reset the password. Only the hash
-- of the token is stored; `email` is the address the link was sent to, so a link for an old
-- address never verifies a new one.
CREATE TABLE email_tokens (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose IN ('verify', 'reset')),
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_tokens_user_idx ON email_tokens(user_id, purpose);
ALTER TABLE email_tokens ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE (used_at), DELETE ON email_tokens TO app_auth;
CREATE POLICY email_tokens_auth ON email_tokens TO app_auth USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- Google and Apple
CREATE TABLE user_identities (
  provider text NOT NULL CHECK (provider IN ('google', 'apple')),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  user_id uuid NOT NULL REFERENCES users(id),
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject),
  UNIQUE (user_id, provider)
);
ALTER TABLE user_identities ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON user_identities TO app_auth;
CREATE POLICY identities_auth ON user_identities TO app_auth USING (true) WITH CHECK (true);
GRANT SELECT ON user_identities TO app_user;
CREATE POLICY identities_self ON user_identities FOR SELECT TO app_user USING (user_id = app.current_user_id());

-- ---------------------------------------------------------------- settings
-- Notification choices: {"debtReminders": bool, "nightReminders": bool, "nightEmails": bool}.
ALTER TABLE users ADD COLUMN settings jsonb NOT NULL DEFAULT '{}';
GRANT UPDATE (settings) ON users TO app_user;
GRANT SELECT (settings, email, email_verified_at) ON users TO app_jobs;

-- ---------------------------------------------------------------- account deletion
-- Right to erasure. Frozen games stay (other people's results depend on them) but the
-- person's name is replaced; their private data, logins and sessions are removed; homes
-- they own are closed for everyone. The frozen hash chain uses player ids, not names, so
-- every result card still verifies. Runs as the sign-in role after a fresh password or
-- second-factor check in the app.
CREATE FUNCTION app.delete_account(uid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = uid AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'account not found' USING ERRCODE = 'P0002';
  END IF;
  -- The audit trigger records who did it.
  PERFORM set_config('app.user_id', uid::text, true);

  UPDATE players
     SET display_name = 'Deleted ' || substr(replace(id::text, '-', ''), 1, 6),
         user_id = NULL, payment_info_enc = NULL, avatar = NULL
   WHERE user_id = uid;
  UPDATE homes SET deleted_at = now() WHERE owner_id = uid AND deleted_at IS NULL;
  DELETE FROM home_members WHERE user_id = uid;
  DELETE FROM night_rsvps WHERE user_id = uid;
  DELETE FROM sessions WHERE user_id = uid;
  DELETE FROM recovery_codes WHERE user_id = uid;
  DELETE FROM email_tokens WHERE user_id = uid;
  DELETE FROM user_identities WHERE user_id = uid;
  DELETE FROM telegram_link_codes WHERE user_id = uid;
  UPDATE users
     SET email = NULL, email_verified_at = NULL, password_hash = NULL, display_name = '',
         telegram_id = NULL, totp_secret_enc = NULL, totp_enabled_at = NULL,
         settings = '{}', deleted_at = now()
   WHERE id = uid;
END $$;
REVOKE ALL ON FUNCTION app.delete_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_account(uuid) TO app_auth;
