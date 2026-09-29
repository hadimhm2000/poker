# Poker Home

Scorekeeping and settle-up for home poker nights: website, installable web app (PWA) and,
later, a Telegram bot, all on one backend and one database. Seven languages (fa, en, ar, fr,
it, ru, es; Persian and Arabic right-to-left). The app never holds or moves money.

## Layout

| Path | What |
| --- | --- |
| `packages/domain` | All game rules, shared by site and bot: integer money, close checks, minimum-transfer settlement with carried debts, SHA-256 result chain, hand evaluator (Hold'em and Omaha), side pot calculator. No I/O. |
| `packages/db` | PostgreSQL schema (`migrations/*.sql` is the source of truth), Row Level Security, freeze triggers, append-only audit log, plan limits, and the repository functions (`closeGame`, `history`, ...). |
| `apps/web` | Next.js 16 app: sign-in with Argon2id and optional TOTP, homes, players, invites, live game entry, close and freeze, ledger, history search, side pot and "who wins?" tools. |

## Security model (short)

* Every request runs in a transaction as the `app_user` role with `app.user_id` set, so RLS
  limits every query to the user's homes. The app checks roles too; RLS is the second layer.
* A closed game is frozen by triggers: `UPDATE`/`DELETE` on the game, its entries, events and
  settlements fail for everyone, including the database owner. Each closed game stores a hash
  chained to the previous one, so even tampering with triggers disabled is detected.
* Closing uses a row lock, a client idempotency key and a version check: double clicks and
  two devices produce one record.
* Free-plan limits (1 home, 3 games) are enforced in triggers under a row lock, so concurrent
  requests cannot slip past them.
* `audit_log` is append-only. Secrets (password hashes, TOTP secrets, payment details) never
  enter it. Payment details and TOTP secrets are AES-256-GCM encrypted per field.
* CSP with per-request nonce, HSTS, frame denial and other headers; server actions check
  Origin (CSRF); sign-in is rate limited without revealing whether an email exists; new
  passwords are checked against Have I Been Pwned (k-anonymity).

## Running locally

```sh
pnpm install
# Postgres 16. As a superuser:
createdb poker_dev
DATABASE_URL_ADMIN=postgres://postgres@localhost:5432/poker_dev pnpm migrate
psql -d poker_dev -c "CREATE ROLE poker_web LOGIN PASSWORD 'devpass'; GRANT app_user, app_auth TO poker_web;"
cp apps/web/.env.example apps/web/.env.local   # fill FIELD_KEY and IP_HASH_SALT
pnpm dev
```

Tests: `pnpm test` (the db tests need `TEST_DATABASE_URL`, default
`postgres://postgres@localhost:5432/postgres`; each test file creates and drops its own database).

## Status against the plan

Phase 0 (foundation) and phase 1 (game core) are in place, and both exit gates are automated
tests in `packages/db/test`:

* `isolation.test.ts`: user A reaches none of user B's data through any read or write.
* `freeze.test.ts`: a closed game does not change even with direct database access; two
  simultaneous closes create one record; plan limits hold under concurrent requests.

The hand engine and side pot calculator from phase 4 are also done (every example from the
rules table plus 200+ generated scenarios, and a full enumeration of all 2,598,960 hands).

Not yet built: Google/Apple/Telegram login, email verification and password reset (need a
mail provider), TOTP recovery codes, statistics page and exports (phase 2), live game over
WebSocket, Telegram bot and Mini App (phase 3), seasons and badges, rules section, payments
(phase 5). The in-memory rate limiter must move to Postgres or Redis before running more than
one server instance.
