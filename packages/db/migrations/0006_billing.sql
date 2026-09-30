-- Subscriptions with Paddle Billing (plan: "Plans", "Subscription, settings and support",
-- security checklist "payment webhook with signature check", phase 5).
--
--   * users.plan and homes.read_only change only through the billing functions below, which
--     run with definer rights. The web roles (app_user, app_auth, app_jobs) cannot set them, even
--     though app_auth may update other columns of users and an owner other columns of homes.
--   * The signed webhook calls app.billing_apply() as the narrow app_billing role; that role
--     has no table rights at all, only EXECUTE on these functions.
--   * Every processed Paddle event id is stored, so a redelivered event changes nothing.
--   * When Pro ends nothing is deleted: the owner's oldest home stays writable, the others
--     become read-only, and all become writable again when Pro comes back.

DO $$ BEGIN
  CREATE ROLE app_billing NOLOGIN NOBYPASSRLS;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;
GRANT USAGE ON SCHEMA public, app TO app_billing;

-- ---------------------------------------------------------------- tables

ALTER TABLE subscriptions
  ADD COLUMN customer_ref text,
  ADD COLUMN price_ref text,
  ADD COLUMN billing_interval text CHECK (billing_interval IN ('day', 'week', 'month', 'year')),
  ADD COLUMN cancel_at timestamptz,
  -- occurred_at of the event that set the status: Paddle may deliver events out of order,
  -- and an older event must not overwrite a newer state. NULL: set by a payment only.
  ADD COLUMN status_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT subscriptions_status_check CHECK (status IN ('active', 'trialing', 'past_due', 'paused', 'canceled'));
CREATE INDEX subscriptions_user_idx ON subscriptions(user_id);

-- Processed webhook events (idempotency). No payloads: they hold names and addresses.
CREATE TABLE billing_events (
  event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 100),
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  user_id uuid REFERENCES users(id),
  outcome text NOT NULL DEFAULT 'applied' CHECK (outcome IN ('applied', 'unmapped')),
  processed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON billing_events FROM PUBLIC;

CREATE TRIGGER subscriptions_audit AFTER INSERT OR UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION app.audit();

-- ---------------------------------------------------------------- who may set plan and read_only

-- True inside the definer functions (they run as the schema owner) and for a superuser at the
-- console; false for every application role.
CREATE FUNCTION app.is_privileged() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT r.rolsuper OR r.oid = c.relowner
    FROM pg_roles r, pg_class c
    WHERE r.rolname = current_user AND c.oid = 'public.users'::regclass
  ), false)
$$;

CREATE FUNCTION app.guard_user_plan() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.is_privileged() THEN RETURN NEW; END IF;
  IF (TG_OP = 'INSERT' AND NEW.plan <> 'free') OR (TG_OP = 'UPDATE' AND NEW.plan IS DISTINCT FROM OLD.plan) THEN
    RAISE EXCEPTION 'the plan changes only through billing' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER users_plan_guard BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION app.guard_user_plan();

-- A read-only home cannot be changed by its owner (only deleted or unlinked from Telegram),
-- and nobody but billing flips the flag.
CREATE FUNCTION app.guard_home_read_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.is_privileged() THEN RETURN NEW; END IF;
  IF NEW.read_only IS DISTINCT FROM OLD.read_only THEN
    RAISE EXCEPTION 'read_only changes only through billing' USING ERRCODE = '42501';
  END IF;
  IF OLD.read_only AND (
       (to_jsonb(NEW) - 'deleted_at' - 'telegram_chat_id') <> (to_jsonb(OLD) - 'deleted_at' - 'telegram_chat_id')
       OR (NEW.telegram_chat_id IS NOT NULL AND NEW.telegram_chat_id IS DISTINCT FROM OLD.telegram_chat_id)) THEN
    RAISE EXCEPTION 'home is read-only' USING ERRCODE = 'P0001', HINT = 'upgrade';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER homes_read_only_guard BEFORE UPDATE ON homes FOR EACH ROW EXECUTE FUNCTION app.guard_home_read_only();

-- ---------------------------------------------------------------- plan → homes

-- Writable homes: all on Pro (at most 5 exist), the oldest one on Free. Soft-deleted homes
-- do not count, so deleting the writable home frees the next oldest.
CREATE FUNCTION app.apply_home_access(u uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE p plan;
BEGIN
  SELECT plan INTO p FROM users WHERE id = u;
  UPDATE homes h SET read_only = x.ro
  FROM (
    SELECT id, row_number() OVER (ORDER BY created_at, id) > (CASE p WHEN 'pro' THEN 5 ELSE 1 END) AS ro
    FROM homes WHERE owner_id = u AND deleted_at IS NULL
  ) x
  WHERE h.id = x.id AND h.read_only IS DISTINCT FROM x.ro;
END $$;

CREATE FUNCTION app.on_plan_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
BEGIN
  PERFORM app.apply_home_access(NEW.id);
  RETURN NULL;
END $$;

CREATE TRIGGER users_plan_homes AFTER UPDATE OF plan ON users
  FOR EACH ROW WHEN (OLD.plan IS DISTINCT FROM NEW.plan) EXECUTE FUNCTION app.on_plan_change();

CREATE FUNCTION app.on_home_deleted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
BEGIN
  PERFORM app.apply_home_access(NEW.owner_id);
  RETURN NULL;
END $$;

CREATE TRIGGER homes_deleted_access AFTER UPDATE OF deleted_at ON homes
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at) EXECUTE FUNCTION app.on_home_deleted();

-- ---------------------------------------------------------------- game quota, race-safe around plan changes
-- The first version read homes.read_only before locking the owner's row, so a game could
-- slip into a home that a concurrent downgrade had just made read-only. Lock first, then
-- read everything (each statement sees what committed before it got the lock).

CREATE OR REPLACE FUNCTION app.enforce_game_quota() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE p plan; owner uuid; ro boolean; n integer;
BEGIN
  SELECT owner_id INTO owner FROM homes WHERE id = NEW.home_id;
  SELECT plan INTO p FROM users WHERE id = owner FOR UPDATE;
  SELECT read_only INTO ro FROM homes WHERE id = NEW.home_id;
  IF ro THEN
    RAISE EXCEPTION 'home is read-only' USING ERRCODE = 'P0001', HINT = 'upgrade';
  END IF;
  IF p = 'free' THEN
    SELECT count(*) INTO n FROM games g JOIN homes ho ON ho.id = g.home_id WHERE ho.owner_id = owner;
    IF n >= 3 THEN
      RAISE EXCEPTION 'free plan allows 3 games' USING ERRCODE = 'P0001', HINT = 'upgrade';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- subscription → plan
-- Mirrors planForSubscriptions() in packages/domain/src/billing.ts (same cases are tested on both).
--   active / trialing: Pro, unless a scheduled cancel has already taken effect
--   canceled:          Pro until the paid period ends
--   past_due / paused: Free (nothing is deleted; Pro comes back with the next payment)

CREATE FUNCTION app.subscription_gives_pro(status text, period_end timestamptz, cancel_at timestamptz, at timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN status IN ('active', 'trialing') THEN cancel_at IS NULL OR cancel_at > at
    WHEN status = 'canceled' THEN coalesce(period_end > at, false)
    ELSE false
  END
$$;

CREATE FUNCTION app.plan_from_subscriptions(u uuid) RETURNS plan
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.user_id = u AND app.subscription_gives_pro(s.status, s.current_period_end, s.cancel_at, now())
  ) THEN 'pro'::plan ELSE 'free'::plan END
$$;

-- Apply one verified webhook event. Returns 'applied', 'duplicate' or 'unmapped'.
-- p_status is NULL for transaction.completed (a payment: it extends the period and, when the
-- subscription event has not arrived yet, starts it as active).
CREATE FUNCTION app.billing_apply(
  p_event_id text, p_event_type text, p_occurred_at timestamptz, p_user uuid,
  p_subscription text, p_customer text, p_status text, p_price text, p_interval text,
  p_period_end timestamptz, p_cancel_at timestamptz
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE uid uuid; sub subscriptions%ROWTYPE; n integer;
BEGIN
  IF p_event_id IS NULL OR p_occurred_at IS NULL OR p_subscription IS NULL THEN
    RAISE EXCEPTION 'incomplete billing event' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('active', 'trialing', 'past_due', 'paused', 'canceled') THEN
    RAISE EXCEPTION 'unknown subscription status' USING ERRCODE = '22023';
  END IF;

  INSERT INTO billing_events(event_id, event_type, occurred_at) VALUES (p_event_id, p_event_type, p_occurred_at)
  ON CONFLICT (event_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RETURN 'duplicate'; END IF;

  -- Whose subscription: a known subscription keeps its user (custom_data cannot move it),
  -- then the user id passed at checkout, then a customer we already know.
  SELECT user_id INTO uid FROM subscriptions WHERE provider = 'paddle' AND provider_ref = p_subscription;
  IF uid IS NULL AND p_user IS NOT NULL THEN
    SELECT id INTO uid FROM users WHERE id = p_user AND deleted_at IS NULL;
  END IF;
  IF uid IS NULL AND p_customer IS NOT NULL THEN
    SELECT user_id INTO uid FROM subscriptions WHERE provider = 'paddle' AND customer_ref = p_customer
    ORDER BY created_at DESC LIMIT 1;
  END IF;
  IF uid IS NULL THEN
    UPDATE billing_events SET outcome = 'unmapped' WHERE event_id = p_event_id;
    RETURN 'unmapped';
  END IF;
  UPDATE billing_events SET user_id = uid WHERE event_id = p_event_id;

  -- Same lock order as the quota triggers: the user row first.
  PERFORM 1 FROM users WHERE id = uid FOR UPDATE;
  SELECT * INTO sub FROM subscriptions WHERE provider = 'paddle' AND provider_ref = p_subscription FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO subscriptions(user_id, provider, provider_ref, customer_ref, status, price_ref, billing_interval,
                              current_period_end, cancel_at, status_at)
    VALUES (uid, 'paddle', p_subscription, p_customer, coalesce(p_status, 'active'), p_price, p_interval,
            p_period_end, p_cancel_at, CASE WHEN p_status IS NOT NULL THEN p_occurred_at END);
  ELSIF p_status IS NULL THEN
    UPDATE subscriptions SET
      customer_ref = coalesce(customer_ref, p_customer),
      current_period_end = greatest(current_period_end, p_period_end),
      price_ref = coalesce(price_ref, p_price),
      billing_interval = coalesce(billing_interval, p_interval),
      updated_at = now()
    WHERE id = sub.id;
  ELSIF sub.status_at IS NULL OR sub.status_at <= p_occurred_at THEN
    UPDATE subscriptions SET
      customer_ref = coalesce(p_customer, customer_ref),
      status = p_status,
      price_ref = coalesce(p_price, price_ref),
      billing_interval = coalesce(p_interval, billing_interval),
      -- A canceled subscription has no current period in the payload: keep the one we know.
      current_period_end = coalesce(p_period_end, current_period_end),
      cancel_at = p_cancel_at,
      status_at = p_occurred_at,
      updated_at = now()
    WHERE id = sub.id;
  ELSE
    -- An older event arrived late: only fill in what is still missing.
    UPDATE subscriptions SET
      customer_ref = coalesce(customer_ref, p_customer),
      price_ref = coalesce(price_ref, p_price),
      billing_interval = coalesce(billing_interval, p_interval),
      updated_at = now()
    WHERE id = sub.id;
  END IF;

  UPDATE users SET plan = app.plan_from_subscriptions(uid)
  WHERE id = uid AND plan IS DISTINCT FROM app.plan_from_subscriptions(uid);
  RETURN 'applied';
END $$;

-- Periodic sweep (cron): a canceled subscription's paid period ran out, or a scheduled
-- cancel took effect without a webhook yet. Only users with a subscription record are touched,
-- so accounts given Pro by hand stay Pro.
CREATE FUNCTION app.billing_expire() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE n integer := 0; u uuid;
BEGIN
  FOR u IN
    SELECT us.id FROM users us
    WHERE us.plan = 'pro' AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = us.id)
      AND app.plan_from_subscriptions(us.id) = 'free'
  LOOP
    UPDATE users SET plan = 'free' WHERE id = u AND plan = 'pro' AND app.plan_from_subscriptions(u) = 'free';
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION app.is_privileged(), app.apply_home_access(uuid), app.plan_from_subscriptions(uuid),
  app.subscription_gives_pro(text, timestamptz, timestamptz, timestamptz),
  app.billing_apply(text, text, timestamptz, uuid, text, text, text, text, text, timestamptz, timestamptz),
  app.billing_expire() FROM PUBLIC;
-- The guard triggers run as the calling role and need this one.
GRANT EXECUTE ON FUNCTION app.is_privileged() TO app_user, app_auth, app_jobs, app_billing;
GRANT EXECUTE ON FUNCTION app.billing_apply(text, text, timestamptz, uuid, text, text, text, text, text, timestamptz, timestamptz),
  app.billing_expire() TO app_billing;

-- A user reads only their own subscriptions (policy from 0001); now also nothing else.
REVOKE ALL ON subscriptions FROM app_user;
GRANT SELECT ON subscriptions TO app_user;
