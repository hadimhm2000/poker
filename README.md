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
* The plan changes only through the signed payment webhook (a narrow `app_billing` role that
  may only call two definer functions); the app's own roles cannot set `users.plan` or a home's
  read-only flag.
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
psql -d poker_dev -c "CREATE ROLE poker_web LOGIN PASSWORD 'devpass'; GRANT app_user, app_auth, app_jobs, app_billing TO poker_web;"
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

## Payments

Paddle Billing is the merchant of record (it handles VAT/sales tax, invoices and refunds). The app
never sees card details. Setup, once per environment (do it all in the sandbox first:
[sandbox-vendors.paddle.com](https://sandbox-vendors.paddle.com)):

1. **Product and prices:** Catalog > Products: one product "Poker Home Pro" with two recurring
   prices, monthly ($3.99) and yearly ($29) as a starting point. A free trial, if wanted, is set on
   the prices; put its length in `PRO_TRIAL_DAYS` so the pricing page mentions it. Copy the price
   ids (`pri_...`) into `PADDLE_PRICE_MONTHLY` and `PADDLE_PRICE_YEARLY`. The prices shown on the
   pricing page come from `PRICING_*` (display only).
2. **Checkout:** Developer tools > Authentication: create a client-side token for
   `PADDLE_CLIENT_TOKEN`. Checkout settings: set the default payment link to the site
   (`https://<domain>/en/pricing`) and approve the domain. Discount codes are created in Paddle
   (Catalog > Discounts) and entered by the buyer in the checkout; there is no coupon system here.
3. **Webhook:** Developer tools > Notifications: new destination `https://<domain>/api/billing/webhook`,
   events `subscription.created`, `.updated`, `.activated`, `.trialing`, `.canceled`, `.past_due`,
   `.paused`, `.resumed` and `transaction.completed`. Put its secret key in `PADDLE_WEBHOOK_SECRET`.
   Every request is checked (`Paddle-Signature` HMAC over the raw body, at most 5 minutes old) and
   each event id is applied once.
4. **Customer portal (optional):** an API key allowed to create customer portal sessions in
   `PADDLE_API_KEY`. The billing page then shows "Cancel subscription" and "Invoices and payment
   method"; without it those buttons are hidden.
5. `PADDLE_ENV=sandbox` until going live, then `production` with live token, prices, secret and key.

Sandbox testing: pay with Paddle's test card `4242 4242 4242 4242` (any future date, CVC `100`).
To replay or send sample events, use Notifications > "Send test event" or the simulator, and
watch the delivery log. Locally, expose the dev server with a tunnel so Paddle can reach the
webhook.

Plan rules: Pro while a subscription is active or trialing, and after a cancel until the paid
period ends (the cron tick drops it if no webhook arrives); `past_due` and `paused` fall back to
Free. When Pro ends nothing is deleted: the owner's oldest home stays writable, the others become
read-only (past games stay visible), and all become writable again on the next payment.

**Still open (plan, open questions):** Paddle, Stripe and the app stores usually do not accept
sellers resident in Iran because of sanctions. Selling internationally needs a company and a bank
account outside Iran; which country that is has not been decided. Nothing above works until a
Paddle seller account for that company is approved.

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

Phase 5 (subscription) is built with Paddle Billing: pricing page (linked from the menu and every
"limit reached" message), overlay checkout, signed and idempotent webhook, billing page with the
Paddle customer portal, and read-only homes after a downgrade. Its exit gate is
`packages/db/test/billing.test.ts`: limits hold under concurrent requests, also while a downgrade
or upgrade webhook races with game creation. Taking real payments needs the company question
in "Payments" answered first.

Not yet built: server-side PDF, Google/Apple login, email verification and password reset (need a
mail provider), TOTP recovery codes, voice rebuys, the "companion referee" log. The in-memory rate limiter must move to
Postgres or Redis before running more than one server instance.
