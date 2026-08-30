# Occlara Backend Server

Express API server handling Stripe payments, license key generation and validation,
Stripe webhook processing, and the AI coaching routes the desktop client calls.

Accounts and sessions live in Supabase and are handled by the website, not here.
This server talks to Supabase with the service role key.

## Setup

### 1. Install dependencies

```bash
cd server
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in all values:

- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, required. Every license lookup goes
  through Supabase, so without these the server boots and then fails every request.
- `STRIPE_SECRET_KEY`, from the Stripe dashboard (test key starts with `sk_test_`)
- `STRIPE_WEBHOOK_SECRET`, generated when you configure the webhook endpoint
- `STRIPE_PRICE_WEEKLY`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_LIFETIME`, price IDs from Stripe
- `ADMIN_PASSWORD`, gates `/api/admin/*`. Unset means those routes always answer 401.
- `AI_API_KEY`, `AI_BASE_URL`, the OpenAI-compatible provider used for coaching

### 3. Create Stripe products and prices

Create the following in the [Stripe dashboard](https://dashboard.stripe.com/products) or via the Stripe CLI:

| Plan     | Amount  | Type        | Price ID env var         |
|----------|---------|-------------|--------------------------|
| Weekly   | $4.99   | Recurring (weekly)   | `STRIPE_PRICE_WEEKLY`   |
| Monthly  | $14.99  | Recurring (monthly)  | `STRIPE_PRICE_MONTHLY`  |
| Lifetime | $59.99  | One-time payment     | `STRIPE_PRICE_LIFETIME` |

**Via Stripe CLI:**

```bash
# Weekly subscription
stripe prices create \
  --unit-amount 499 \
  --currency usd \
  --recurring[interval]=week \
  --product-data[name]="Occlara Weekly"

# Monthly subscription
stripe prices create \
  --unit-amount 1499 \
  --currency usd \
  --recurring[interval]=month \
  --product-data[name]="Occlara Monthly"

# Lifetime one-time payment
stripe prices create \
  --unit-amount 5999 \
  --currency usd \
  --product-data[name]="Occlara Lifetime"
```

Copy the returned `price_xxx` IDs into your `.env` file.

### 4. Start the server

```bash
# Production
npm start

# Development (auto-reload)
npm run dev
```

Server runs on port `3000` by default (configurable via `PORT` in `.env`).

### 5. Configure Stripe webhooks

**For local development**, use the Stripe CLI to forward events:

```bash
stripe listen --forward-to localhost:3000/api/payments/webhook
```

Copy the webhook signing secret it prints (`whsec_...`) into `STRIPE_WEBHOOK_SECRET` in your `.env`.

**For production**, create a webhook endpoint in the Stripe dashboard pointing to:

```
https://your-server.com/api/payments/webhook
```

Subscribe to these events:
- `checkout.session.completed`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.deleted`

## API Endpoints

The `Gate` column is what the server actually enforces today, not what it ought to.

### Payments

| Method | Path                            | Gate | Description                        |
|--------|---------------------------------|------|------------------------------------|
| POST   | `/api/payments/create-checkout` | none | Create Stripe Checkout session URL |
| POST   | `/api/payments/cancel`          | none | Cancel a subscription by `userId`  |
| GET    | `/api/payments/success`         | none | Poll for license after payment     |
| POST   | `/api/payments/webhook`         | Stripe signature | Stripe webhook receiver |

### License

| Method | Path                      | Gate | Description                            |
|--------|---------------------------|------|----------------------------------------|
| POST   | `/api/license/activate`   | none, rate limited | Bind a key to a device   |
| POST   | `/api/license/deactivate` | none | Unbind the device for a `userId`       |
| POST   | `/api/license/validate`   | none | Validate a key, used by the client     |

### Account

| Method | Path                     | Gate | Description                              |
|--------|--------------------------|------|------------------------------------------|
| GET    | `/api/account/dashboard` | none | License and billing summary for a `userId` |
| POST   | `/api/account/portal`    | none | Stripe billing portal URL for a `userId` |

### Coach

Every `/api/coach/*` route requires an `X-License-Key` header holding an active,
unexpired key, and is rate limited. Routes cover `analyze`, `chat`, `frame-chat`,
`recap`, round and match summaries, session scoring, match and rank lookups,
`detect-agent`, and `match-review`. See `routes/coach.js`.

### Admin

| Method | Path                   | Gate                     | Description              |
|--------|------------------------|--------------------------|--------------------------|
| GET    | `/api/admin/coaching`  | `x-admin-password` header | Aggregate tip/reject counts |
| GET    | `/api/admin/costs`     | `x-admin-password` header | AI call and cost totals  |

### Health

| Method | Path          | Description                                  |
|--------|---------------|----------------------------------------------|
| GET    | `/health`     | Status plus the live AI model slugs           |
| GET    | `/api/health` | Same payload, for platforms that require /api |

## Database

Supabase (Postgres) is the only datastore. The server uses the service role key,
which bypasses row level security, so authorization has to be enforced here in
the route handlers.

Tables:
- `licenses`, license key, plan, status, expiry, bound device, deactivation quota,
  linked Stripe customer/subscription, and the owning Supabase `user_id`

## Authorization, still to do

Because the service role key bypasses row level security, these handlers are the
only place authorization can happen, and two pieces are not built yet:

- Routes marked `Gate: none` accept a `userId` from the caller. They need to verify
  a Supabase JWT and confirm it belongs to that `userId` before reading or writing
  anything.
- `/api/coach/*` checks that the license key is active but not that it is being
  used from the device it was activated on, so the one device per key rule that
  `/api/license/activate` enforces does not hold on the paid routes.

Treat both as required before any new route that takes a `userId` is added.

## License Key Format

`GC-XXXX-XXXX-XXXX-XXXX` (uppercase alphanumeric segments)

## Notes

- The webhook route (`/api/payments/webhook`) is registered **before** the global JSON body parser so Stripe signature verification works correctly (requires raw body).
- License keys are generated automatically when `checkout.session.completed` fires.
- Subscription renewals are handled via `invoice.paid` events, which extend the `expires_at` date.
- TODO: Integrate an email provider (Resend, SendGrid) to email license keys to users on purchase.
