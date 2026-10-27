# bKash for Shopify

Accept **bKash** payments in Shopify's own checkout using the bKash **Tokenized Checkout** API, with a
small **Cloudflare Worker** backend and two Shopify **checkout UI extensions**.

The customer picks *bKash* at checkout and places the order, then taps **Pay ৳X with bKash** on the
Thank-you page. The Worker confirms the payment with bKash server-to-server and marks the Shopify
order **Paid**.

[![CI](https://github.com/mahmudalsohan/bkash-shopify/actions/workflows/ci.yml/badge.svg)](https://github.com/mahmudalsohan/bkash-shopify/actions/workflows/ci.yml)

> **Using a custom order form instead of Shopify checkout?** COMFIQ's one-step order form takes
> bKash payment *before* the order is created, with no Thank-you-page button. That flow lives in the
> separate **comfiq-checkout** repository. This app covers Shopify's own checkout.

---

## Contents
- [How it works](#how-it-works)
- [What's in the repo](#whats-in-the-repo)
- [Setup](#setup)
- [Testing](#testing)
- [Going live](#going-live)
- [Operations](#operations)
- [Security](#security)
- [Development and releases](#development-and-releases)

---

## How it works

```
Checkout: customer picks the manual method "bKash" → order created, payment pending
  ↓
Thank-you / Order-status extension ──POST /api/pay-link──▶ Worker   (looks up the real order in Shopify)
  ↓  "Pay ৳X with bKash"
GET /pay/:orderId?exp&sig ──▶ Worker → bKash create payment → redirect to bKash
  ↓  customer enters wallet number, OTP, PIN
GET /bkash/callback ──▶ Worker → bKash execute (status query as fallback)
                                → checks amount + invoice → order marked Paid, tagged bkash-paid, bkash-trx-<TrxID>
```

**Money only moves when the Worker calls *execute*,** and that happens in the callback.

- If a customer leaves bKash before it sends them back, they are **not charged**. Their order stays
  unpaid, and they can pay later from the Order status page.
- Nothing is cancelled automatically.

A **cron every 10 minutes** handles only one case where money has already moved: bKash took the
payment, but marking the Shopify order paid failed (`unsynced`). The cron retries that until it works.

**In-app browsers (Facebook, Instagram).** Shopify extensions can only open links in a new tab, so
bKash opens there. The Thank-you tab polls the Worker and switches to "Payment received" by itself,
even if the payment finished in another browser.

---

## What's in the repo

```
bkash-shopify/
├── shopify.app.toml             Shopify app config (scopes: read_orders, write_orders)
├── shared/
│   ├── config.js                BACKEND_URL: the Worker URL
│   └── BkashPay.jsx             The pay banner + button (Preact)
├── extensions/
│   ├── bkash-thank-you/         purchase.thank-you.block.render
│   └── bkash-order-status/      customer-account.order-status.block.render
└── worker/                      Cloudflare Worker
    ├── wrangler.toml            Vars, D1 binding, cron
    ├── schema.sql               D1 tables (payments, kv)
    ├── src/
    │   ├── index.ts             Routes, callback state machine, cron
    │   ├── bkash.ts             bKash Tokenized Checkout client (token cached in D1)
    │   ├── shopify.ts           Admin GraphQL, client-credentials grant
    │   ├── auth.ts              Session-token JWT checks + signed pay links
    │   ├── db.ts                D1 helpers
    │   └── pages.ts             Result pages shown after bKash
    └── test/                    Vitest suite (fake Shopify + fake bKash + real SQLite)
```

---

## Setup

You need a Shopify store with currency **BDT**, a Cloudflare account (the free plan is enough), and
bKash Tokenized Checkout credentials (sandbox or live).

### 1. Shopify payment method
**Settings → Payments → Manual payment methods → Create custom payment method**
- **Name:** `bKash`. It must match `BKASH_GATEWAY_NAME` in `worker/wrangler.toml` (case-insensitive).
- **Additional details:** *Pay securely with your bKash account right after placing the order.*
- **Payment instructions:** *Tap **Pay with bKash** on this page to complete your payment. You can
  also pay later from the "View your order" link in your confirmation email.*

### 2. Worker
```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create bkash-shopify      # put the database_id in wrangler.toml
npm run db:init
```

Set `[vars]` in `worker/wrangler.toml`:

| Var | Value |
|---|---|
| `PUBLIC_URL` | Worker URL, e.g. `https://bkash-shopify.<subdomain>.workers.dev` |
| `SHOPIFY_SHOP` | `your-store.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | From the Dev Dashboard (step 3) |
| `BKASH_GATEWAY_NAME` | `bKash` |
| `BKASH_BASE_URL` | Sandbox `https://tokenized.sandbox.bka.sh/v1.2.0-beta` or live `https://tokenized.pay.bka.sh/v1.2.0-beta` |

Secrets (each command asks for the value):
```bash
npx wrangler secret put SHOPIFY_CLIENT_SECRET
npx wrangler secret put BKASH_APP_KEY
npx wrangler secret put BKASH_APP_SECRET
npx wrangler secret put BKASH_USERNAME
npx wrangler secret put BKASH_PASSWORD
npx wrangler secret put LINK_SECRET          # any long random string: openssl rand -hex 32
npm run deploy
```

### 3. Shopify app
The app must be in the **same Shopify organization** as the store. That lets the Worker get Admin
API tokens with the client-credentials grant, with no OAuth screens.

1. Create an app in the **Dev Dashboard** (dev.shopify.com). Copy its Client ID and secret.
2. Put the Worker URL in `shopify.app.toml` (`application_url`, `redirect_urls`) and in
   `shared/config.js`.
3. From the repo root:
   ```bash
   npm install
   ```
   ```bash
   npx shopify app config link
   ```
   ```bash
   npx shopify app deploy
   ```
4. In the Dev Dashboard, **allow network access** for the UI extensions.
5. **Install** the app on the store.
6. **Settings → Checkout → Customize:** add the **bKash pay button** block on both the **Thank you**
   page and the **Order status** page.

---

## Testing

```bash
npm run check          # typecheck + tests + bundle both extensions (same as CI)
npm test               # 53 worker tests: real Worker code, real SQLite, faked Shopify and bKash
npm run test:sandbox   # 6 live tests against the bKash sandbox (needs worker/.dev.vars)
```

The suite covers:
- session-token checks and signed links
- every callback outcome: success, cancel, failure, forged success, execute timeout, amount mismatch,
  order cancelled mid-payment, double payment, concurrent redirects, Shopify outage
- the cron: it retries `unsynced`, never executes abandoned payments, never cancels orders

**Manual test in the sandbox:**
- Wallet `01770618575` succeeds.
- Wallets `01823074817` / `01823074818` fail.
- OTP `123456`, PIN `12121`.

Place an order with bKash, pay from the Thank-you page, and check the order turns **Paid** with tags
`bkash-paid` and `bkash-trx-<TrxID>`.

---

## Going live
1. Set `BKASH_BASE_URL` to `https://tokenized.pay.bka.sh/v1.2.0-beta`.
2. `wrangler secret put` the **live** bKash credentials, then `npm run deploy`.
3. Ask bKash whether live access needs **server IP whitelisting**. Workers have no fixed outbound IP;
   if bKash insists, route bKash calls through a static-IP proxy.

---

## Operations

| `payments.status` | Meaning | Action |
|---|---|---|
| `initiated` | Customer is on the bKash page, or left it | None. Not charged unless they finish. |
| `processing` | Being confirmed right now | None. Reset by the cron if stuck for more than 15 min. |
| `completed` | Paid at bKash, order marked Paid | None |
| `cancelled` / `failed` | No money taken | None |
| `unsynced` | Paid at bKash, Shopify update failed | None. The cron retries every 10 min. |
| `needs_refund` | Paid, but the order was already cancelled/paid or the amount didn't match | **Refund manually** in the bKash merchant panel. The order is tagged `bkash-needs-refund` / `bkash-needs-review`. |

Recent payments:
```bash
npx wrangler d1 execute bkash-shopify --remote --command "SELECT * FROM payments ORDER BY created_at DESC LIMIT 20"
```
Is the cron alive? (should be under 10 minutes old)
```bash
npx wrangler d1 execute bkash-shopify --remote --command "SELECT value FROM kv WHERE key='cron_last_run'"
```
Live logs:
```bash
npm --prefix worker run logs
```

---

## Security
- The extensions send only an order id. Amount, payment method and paid status always come from
  Shopify's Admin API.
- `/api/pay-link` requires a valid Shopify session token, verified with the app secret (signature,
  `aud`, `dest`, expiry).
- `/pay/:id` links are HMAC-signed with `LINK_SECRET` and expire after 24 hours.
- The bKash redirect is never trusted on its own. The Worker confirms with bKash and checks the amount
  and invoice before marking an order paid.
- Each payment is claimed atomically in D1, so duplicate redirects can't settle it twice.

---

## Development and releases

```bash
npm install && npm install --prefix worker   # first time
npm run dev                                  # Shopify extension preview
npm --prefix worker run dev                  # Worker locally (needs worker/.dev.vars)
```

- **Branches:** `main` is always deployable. Work on `feat/…` / `fix/…` branches and open a pull
  request. CI must pass.
- **Versions:** [Semantic Versioning](https://semver.org/), history in [CHANGELOG.md](CHANGELOG.md).

**Release:**
1. Move the `[Unreleased]` notes in `CHANGELOG.md` under a new version heading.
2. Bump the version:
   ```bash
   npm version <patch|minor|major> --no-git-tag-version --workspaces --include-workspace-root && npm version <same> --no-git-tag-version --prefix worker
   ```
3. Commit with the message `chore(release): vX.Y.Z`.
4. Tag and push:
   ```bash
   git tag vX.Y.Z && git push --follow-tags
   ```
5. Deploy the Worker:
   ```bash
   npm run deploy:worker
   ```
6. Deploy the Shopify app:
   ```bash
   npm run deploy:shopify
   ```
