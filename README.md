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
psql -d poker_dev -c "CREATE ROLE poker_web LOGIN PASSWORD 'devpass'; GRANT app_user, app_auth, app_jobs TO poker_web;"
cp apps/web/.env.example apps/web/.env.local   # fill FIELD_KEY and IP_HASH_SALT
pnpm dev
```

Tests: `pnpm test` (the db and bot tests need `TEST_DATABASE_URL`, default
`postgres://postgres@localhost:5432/postgres`; each test file creates and drops its own database).

## Telegram

The bot is another door into the same backend: every command runs as the linked site user
under the same Row Level Security as the website. Setup, once per environment:

1. Create a bot with @BotFather; put the token and username in `TELEGRAM_BOT_TOKEN` and
   `TELEGRAM_BOT_USERNAME`. Set `TELEGRAM_WEBHOOK_SECRET` and `CRON_SECRET` to random strings
   (16+ characters) and `APP_URL` to the public https address.
2. In @BotFather: `/setdomain` to the site's domain (Login Widget), and optionally `/newapp`
   for a Mini App link (`t.me/<bot>/<name>`, then set `TELEGRAM_APP_NAME`).
3. After deploying: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" $APP_URL/api/telegram/setup`
   (sets the webhook with its secret, the command menu in 7 languages and the Mini App menu button).
4. Schedule `POST /api/cron/tick` with the same bearer every 10 minutes (game-night and
   debt reminders).

Players link Telegram on the Security page (or just open the bot: the Mini App creates an
account from Telegram's signed data). Hosts connect a group from the home page; the bot then
posts results on close, game-night invites with answer buttons, and reminders.

Live updates use Postgres `LISTEN/NOTIFY` and Server-Sent Events (no extra service). Behind a
proxy, disable response buffering for `/api/games/*/live`.

## Status against the plan

Phase 0 (foundation) and phase 1 (game core) are in place, and both exit gates are automated
tests in `packages/db/test`:

* `isolation.test.ts`: user A reaches none of user B's data through any read or write.
* `freeze.test.ts`: a closed game does not change even with direct database access; two
  simultaneous closes create one record; plan limits hold under concurrent requests.

The hand engine and side pot calculator from phase 4 are also done (every example from the
rules table plus 200+ generated scenarios, and a full enumeration of all 2,598,960 hands).

Phase 2 (statistics and exports) is built: statistics page shaped like sheet 3 (cards, leaderboard with
medals, cumulative-profit and net charts, last 10 games, records), per-player page with head-to-head,
Excel export with two sheets (history and statistics, in the home's language, right-to-left for fa/ar),
CSV, a two-page landscape print view (browser Print to PDF), and spreadsheet import with preview,
Solar Hijri dates and duplicate detection. Its exit gate (importing Hadi's real workbook reproduces
sheet 3: abol +2,980k over 28 games) still needs that file.

Phase 3 (live game and Telegram) is built: players join a live game by QR code and see it change
in real time, ask for a rebuy from their phone and the host approves with one tap (on the site or
in Telegram), players confirm their own result, the host's changes queue on the phone while the
connection is down and are applied exactly once when it returns, game-night invites with
coming/maybe/not coming, and the Telegram bot (`/start`, `/link`, `/game`, `/rebuy`, `/stats`,
`/last`, `/debts`, `/next`, `/sidepot`), Mini App sign-in, Telegram Login, automatic result posts
to the group on close, and private debt reminders. Tests: `packages/db/test/live.test.ts` and
`apps/web/src/telegram/*.test.ts` (the bot runs end to end against a real database). Its exit gate
(a real game night of the group run entirely from Telegram) needs a bot token and a deployment.

Phase 4 rest and the result card are built:

* Rules section (`/rules`): hand rankings with cards and combination counts, Texas Hold'em, Omaha
  with a pot-limit calculator, every disputed situation from the plan's table (card examples are
  checked by the hand engine in `packages/domain/test/rules.test.ts`), search, question of the day,
  and each home's own house rules (edited by the host, shown with their own label). The bot's
  `/rules [topic]` searches the same texts in any language and adds the group's house rules.
  Rule texts outside English are a first translation and still need a human review.
* Seasons: named date ranges (or "this month", Solar Hijri for Persian) with their own leaderboard;
  all-time statistics are never reset. Badges (winning streak, biggest win, regular, comeback) are
  computed from the frozen results, per season or all time.
* Result card: a PNG in the home's language (post 4:5 and story 9:16) drawn as SVG and rendered with
  resvg (Persian and Arabic shaped right to left; fonts in `apps/web/assets/fonts`, SIL OFL). Its QR
  opens the public `/verify/<hash>` page, which rechecks the game and the whole hash chain behind it.
  On close the bot posts the card with the result as caption; `/last` does the same.

Account module is built: email confirmation and password reset by one-time links (hash stored,
bound to the address, reset ends every session), Google and Apple sign-in (OpenID Connect with
state, nonce and PKCE; an existing account is linked only when both sides verified the email) and
connecting or disconnecting them from Security, ten single-use recovery codes for two-step
verification, a Settings page (name, light/dark theme, notification choices, "download my data" as
JSON, and account deletion that keeps closed games for the others with the name replaced). Game-night
reminders also go by email to confirmed addresses. Tests: `packages/db/test/accounts.test.ts`,
`apps/web/src/lib/{oidc,recovery}.test.ts`.

Admin, legal and PDF: a limited support panel at `/admin` (ADMIN_EMAILS, confirmed email and two-step
verification required): counts, account lookup, plan change and "sign out everywhere" with a written
reason, and a home's history only through a one-hour support grant; every step is in the append-only
audit log (`packages/db/test/admin.test.ts`). Terms of use and privacy policy are drafts in English
and Persian (`apps/web/src/content/legal.ts`, placeholders for the operator and contact until the
company question is settled). The statistics page has a server-rendered two-page PDF when
PDF_CHROMIUM_PATH is set.

The in-memory rate limiter must move to Postgres or Redis before running more than one server instance.
