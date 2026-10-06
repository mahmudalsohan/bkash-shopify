export interface Env {
  DB: D1Database;

  // Public URL of this Worker, e.g. https://bkash-shopify.<you>.workers.dev (no trailing slash)
  PUBLIC_URL: string;

  // Shopify
  SHOPIFY_SHOP: string; // your-store.myshopify.com
  SHOPIFY_CLIENT_ID: string;
  SHOPIFY_CLIENT_SECRET: string; // secret
  SHOPIFY_API_VERSION: string; // e.g. 2026-07
  BKASH_GATEWAY_NAME: string; // name of the manual payment method, e.g. "bKash"

  // bKash Tokenized Checkout
  BKASH_BASE_URL: string; // sandbox: https://tokenized.sandbox.bka.sh/v1.2.0-beta
  BKASH_APP_KEY: string; // secret
  BKASH_APP_SECRET: string; // secret
  BKASH_USERNAME: string; // secret
  BKASH_PASSWORD: string; // secret

  // Signs the /pay links so they can't be forged
  LINK_SECRET: string; // secret

  // Cancel unpaid bKash orders older than this many hours ("0" disables)
  AUTO_CANCEL_HOURS: string;

  // Delay between order lookups while a brand-new order isn't visible yet (default 1000)
  ORDER_LOOKUP_RETRY_MS?: string;
}
