# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Deployed to Cloudflare (`bkash-shopify.comfiqbd.workers.dev`) with D1 database and store `fab336-57.myshopify.com`.
- Shopify app `bKash Payments` (client id `74fab2cd…`) with extensions released as app version v0.1.0.

### Fixed
- Extensions failed to bundle in the Shopify CLI (`react/jsx-runtime` not found): added `tsconfig.json` with `jsxImportSource: preact`.

## [0.1.0] - 2026-10-05

### Added
- Cloudflare Worker backend: bKash Tokenized Checkout client (create / execute / status query, token cached in D1).
- `POST /api/pay-link` for the UI extensions, protected by Shopify session-token verification.
- Signed, expiring `/pay/:orderId` links that create a bKash payment and redirect to bKash.
- `/bkash/callback` that confirms payments server-to-server, checks amount and invoice, and marks the Shopify order paid with `bkash-paid` / `bkash-trx-<id>` tags.
- Atomic payment claiming in D1 so duplicate redirects can't settle a payment twice.
- Hourly cron: retries failed Shopify syncs, recovers payments whose callback never arrived, auto-cancels stale unpaid bKash orders.
- Thank-you page and Order-status page UI extensions (Preact, API 2026-07) showing the "Pay with bKash" button.
