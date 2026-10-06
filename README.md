# bKash for Shopify (Cloudflare Workers)

Customers choose **bKash** (a manual payment method) at checkout. After placing the order, they see a
**Pay with bKash** button on the Thank-you page and the Order status page. They pay through the bKash
Tokenized Checkout. The Worker then verifies the payment with bKash and marks the Shopify order **Paid**.

```
Checkout (manual method "bKash") → order created, payment pending
  → Thank-you / Order-status extension ──POST /api/pay-link──▶ Worker (checks the real order in Shopify)
  → customer clicks "Pay ৳X with bKash" ──GET /pay/:id──▶ Worker → bKash create → redirect to bKash
  → customer approves in bKash ──GET /bkash/callback──▶ Worker → execute/query → orderMarkAsPaid + tags
Hourly cron: retry failed Shopify syncs · recover payments whose callback never arrived · cancel stale unpaid orders
```

```
bkash-shopify/
├── shopify.app.toml                 Shopify app config (scopes: read_orders, write_orders)
├── shared/                          Code shared by both extensions
│   ├── config.js                    ← set BACKEND_URL
│   └── BkashPay.jsx                 The banner + button
├── extensions/
│   ├── bkash-thank-you/             target: purchase.thank-you.block.render
│   └── bkash-order-status/          target: customer-account.order-status.block.render
└── worker/                          Cloudflare Worker backend
    ├── wrangler.toml                ← set vars + D1 id
    ├── schema.sql                   D1 tables
    └── src/
        ├── index.ts                 Routes, callback state machine, cron
        ├── bkash.ts                 bKash Tokenized Checkout client (token cached in D1)
        ├── shopify.ts               Admin GraphQL (client credentials grant)
        ├── auth.ts                  Session-token JWT verify + signed pay links
        ├── db.ts                    D1 helpers
        └── pages.ts                 Result pages shown after bKash
```

## 1. Shopify store settings

1. **Settings → Store details → Store currency** must be **BDT**.
2. **Settings → Payments → Manual payment methods → Create custom payment method**:
   - Name: `bKash`. It must match `BKASH_GATEWAY_NAME` in `wrangler.toml` (case-insensitive).
   - Additional details (shown at checkout): *"Pay securely with your bKash account right after placing the order."*
   - Payment instructions (Thank-you page + confirmation email): *"Tap **Pay with bKash** on this page to
     complete your payment. You can also pay later from the 'View your order' link in your confirmation email."*

## 2. Deploy the Worker (Cloudflare, free plan)

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create bkash-shopify      # copy the database_id into wrangler.toml
npm run db:init                           # creates the tables in the remote D1
```

Edit `[vars]` in `worker/wrangler.toml`:

- `PUBLIC_URL`: your Worker URL, shown after the first deploy (`https://bkash-shopify.<subdomain>.workers.dev`).
- `SHOPIFY_SHOP`: `your-store.myshopify.com`.
- `SHOPIFY_CLIENT_ID`: from the Dev Dashboard (step 3).
- `AUTO_CANCEL_HOURS`: cancel unpaid bKash orders after this many hours. `0` disables it.

Set the secrets (each command prompts for the value):

```bash
npx wrangler secret put SHOPIFY_CLIENT_SECRET
npx wrangler secret put BKASH_APP_KEY
npx wrangler secret put BKASH_APP_SECRET
npx wrangler secret put BKASH_USERNAME
npx wrangler secret put BKASH_PASSWORD
npx wrangler secret put LINK_SECRET          # any long random string: openssl rand -hex 32
npm run deploy
```

## 3. Create and deploy the Shopify app

The app must be created in the **same Shopify organization** as your store. That's what allows the
Worker to get Admin API tokens with the client credentials grant, with no OAuth screens.

1. Create an app in the **Dev Dashboard** (dev.shopify.com) and copy the **Client ID** and **Client secret**.
2. Put your Worker URL in `shopify.app.toml` (`application_url`, `redirect_urls`) and in `shared/config.js`.
3. Run:

   ```bash
   npm install
   npx shopify app config link     # choose the app you just created
   npx shopify app deploy
   ```

4. In the Dev Dashboard, open the app's settings and **allow network access** for the UI extensions.
   The extensions call the Worker, and they won't load until this is approved.
5. **Install** the app on your store from the Dev Dashboard.
6. Place the blocks. Go to **Settings → Checkout → Customize**:
   - Switch the page selector to **Thank you** → *Add app block* → **bKash pay button – Thank you page**.
   - Switch to **Order status** → *Add app block* → **bKash pay button – Order status page**.

   The order confirmation email already links to the Order status page, so customers who close the tab can still pay.

## 4. Test with the bKash sandbox

`BKASH_BASE_URL` points at the sandbox by default. Put the sandbox API credentials in `worker/.dev.vars`
for local runs, and in `wrangler secret put` for the deployed Worker.

**Sandbox test wallets** (on the bKash payment page):

| Wallet number | Result |
|---|---|
| `01770618575` | Successful payment |
| `01823074817` / `01823074818` | Failure cases (insufficient balance, debit block) |

Use OTP `123456` and PIN `12121` for every test wallet.
### Automated tests

```bash
npm test               # 54 tests: real Worker code + real SQLite, Shopify & bKash faked (runs in CI)
npm run test:sandbox   # 6 live tests against the real bKash sandbox (uses worker/.dev.vars)
```

They cover session-token checks, signed links, every callback outcome (success, cancel, failure,
forged success, execute timeout, amount mismatch, order cancelled mid-payment, double payment,
concurrent redirects, Shopify outage) and all three cron jobs.
The sandbox tests share one bKash token: the sandbox rate-limits token grants (HTTP 429 for about 8 minutes).

### Manual end-to-end test

`BKASH_BASE_URL` points at the sandbox by default. Use your sandbox credentials and bKash's sandbox test wallet.

1. Place an order and choose **bKash**. The Thank-you page should show **Pay ৳X with bKash**.
2. Pay. You land on the "Payment received" page, and the order becomes **Paid** with tags `bkash-paid` and `bkash-trx-<TrxID>`.
3. Also test cancelling on the bKash page, letting a payment fail, and paying from the Order status page.

Watch the logs with `npm run logs`. Check payments with:

```bash
npx wrangler d1 execute bkash-shopify --remote --command "SELECT * FROM payments ORDER BY created_at DESC LIMIT 20"
```

## 5. Go live

1. Set `BKASH_BASE_URL = "https://tokenized.pay.bka.sh/v1.2.0-beta"` in `wrangler.toml`.
2. Run `wrangler secret put` again with the **live** bKash credentials, then `npm run deploy`.
3. Ask bKash whether live access needs **server IP whitelisting**. Cloudflare Workers don't have a fixed
   outbound IP. If bKash requires one, route the bKash calls through a static-IP proxy.

## Operations

| `payments.status` | Meaning | Action |
|---|---|---|
| `initiated` | Customer is on the bKash page | none (the cron recovers it if the callback is lost) |
| `processing` | A request is confirming it right now | none (reset automatically if stuck > 15 min) |
| `completed` | Paid at bKash and marked paid in Shopify | none |
| `cancelled` / `failed` | No money taken | none |
| `unsynced` | Paid at bKash, Shopify update failed | none (the cron retries every hour) |
| `needs_refund` | Paid at bKash, but the order was already cancelled or paid, or the amount didn't match | **Refund manually** from the bKash merchant panel. The order is tagged `bkash-needs-refund` / `bkash-needs-review`. |

Find orders that need attention: in Shopify Admin, filter orders by tag `bkash-needs-refund`, or run:

```bash
npx wrangler d1 execute bkash-shopify --remote --command "SELECT * FROM payments WHERE status='needs_refund'"
```

## Security notes

- The extensions send only an order id. The amount, payment method and paid status always come from Shopify's Admin API.
- `/api/pay-link` requires a valid Shopify session token, verified with your client secret: signature, `aud`, `dest` and expiry.
- `/pay/:id` links are signed with HMAC (`LINK_SECRET`) and expire after 24 hours.
- The bKash callback is never trusted on its own. The Worker always confirms the payment with bKash
  (execute, falling back to a status query) and checks the amount and invoice before marking the order paid.
- Each payment is claimed atomically in D1, so duplicate redirects can't settle the same payment twice.

## Development & releases

```bash
npm install && npm install --prefix worker   # first time
npm run check                                # typecheck worker + bundle extensions (same as CI)
npm run dev                                  # Shopify extension dev preview
npm --prefix worker run dev                  # Worker locally (needs worker/.dev.vars)
```

**Branches:** `main` is always deployable. Do work on a feature branch (`feat/...`, `fix/...`) and
open a pull request. CI (`.github/workflows/ci.yml`) must pass before merging.

**Versioning:** [Semantic Versioning](https://semver.org/), with history in [CHANGELOG.md](CHANGELOG.md).
- `PATCH` (0.1.**x**): bug fixes
- `MINOR` (0.**x**.0): new features that stay backwards compatible
- `MAJOR` (**x**.0.0): breaking changes, such as a D1 schema change that needs a migration

**Cutting a release:**
1. Move the `[Unreleased]` notes in `CHANGELOG.md` under a new version heading.
2. Bump the version everywhere: `npm version <patch|minor|major> --no-git-tag-version --workspaces --include-workspace-root && npm version <same> --no-git-tag-version --prefix worker`
3. Commit with the message `chore(release): vX.Y.Z`, then tag and push: `git tag vX.Y.Z && git push --follow-tags`
4. Deploy: `npm run deploy:worker` and `npm run deploy:shopify`. The Shopify app version is created by the CLI.
