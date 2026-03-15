# GhostCoach Backend Server

Express API server handling authentication, Stripe payments, license key generation, and webhook processing.

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

- `JWT_SECRET` — generate a long random string (e.g. `openssl rand -hex 32`)
- `STRIPE_SECRET_KEY` — from the Stripe dashboard (test key starts with `sk_test_`)
- `STRIPE_WEBHOOK_SECRET` — generated when you configure the webhook endpoint
- `STRIPE_PRICE_WEEKLY`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_LIFETIME` — price IDs from Stripe

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
  --product-data[name]="GhostCoach Weekly"

# Monthly subscription
stripe prices create \
  --unit-amount 1499 \
  --currency usd \
  --recurring[interval]=month \
  --product-data[name]="GhostCoach Monthly"

# Lifetime one-time payment
stripe prices create \
  --unit-amount 5999 \
  --currency usd \
  --product-data[name]="GhostCoach Lifetime"
```

Copy the returned `price_xxx` IDs into your `.env` file.

### 4. Start the server

```bash
# Production
npm start

# Development (auto-reload)
npm run dev
```

Server runs on port `3001` by default (configurable via `PORT` in `.env`).

### 5. Configure Stripe webhooks

**For local development**, use the Stripe CLI to forward events:

```bash
stripe listen --forward-to localhost:3001/api/webhook/stripe
```

Copy the webhook signing secret it prints (`whsec_...`) into `STRIPE_WEBHOOK_SECRET` in your `.env`.

**For production**, create a webhook endpoint in the Stripe dashboard pointing to:

```
https://your-server.com/api/webhook/stripe
```

Subscribe to these events:
- `checkout.session.completed`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.deleted`

## API Endpoints

### Auth

| Method | Path                  | Auth | Description              |
|--------|-----------------------|------|--------------------------|
| POST   | `/api/auth/register`  | No   | Create account           |
| POST   | `/api/auth/login`     | No   | Login, receive JWT token |

### Payments

| Method | Path                           | Auth | Description                        |
|--------|--------------------------------|------|------------------------------------|
| POST   | `/api/payments/create-checkout`| Yes  | Create Stripe Checkout session URL |
| GET    | `/api/payments/success`        | No   | Poll for license after payment     |

### License

| Method | Path                    | Auth | Description                          |
|--------|-------------------------|------|--------------------------------------|
| GET    | `/api/license/my-key`   | Yes  | Get current user's license key       |
| POST   | `/api/license/validate` | No   | Validate a license key (Electron app)|

### Webhook

| Method | Path                    | Auth | Description               |
|--------|-------------------------|------|---------------------------|
| POST   | `/api/webhook/stripe`   | No   | Stripe webhook receiver   |

### Health

| Method | Path      | Description       |
|--------|-----------|-------------------|
| GET    | `/health` | Server health check |

## Database

SQLite database is stored at `server/ghostcoach.db` (auto-created on first run). Uses WAL mode for better concurrency.

Tables:
- `users` — email, hashed password, Stripe customer ID
- `licenses` — license keys, plan, status, expiry, linked Stripe session/subscription

## License Key Format

`GC-XXXX-XXXX-XXXX-XXXX` (uppercase alphanumeric segments)

## Notes

- The webhook route (`/api/webhook`) is registered **before** the global JSON body parser so Stripe signature verification works correctly (requires raw body).
- License keys are generated automatically when `checkout.session.completed` fires.
- Subscription renewals are handled via `invoice.paid` events, which extend the `expires_at` date.
- TODO: Integrate an email provider (Resend, SendGrid) to email license keys to users on purchase.
