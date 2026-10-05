CREATE TABLE IF NOT EXISTS payments (
  payment_id TEXT PRIMARY KEY,      -- bKash paymentID
  order_id   TEXT NOT NULL,         -- numeric Shopify order id
  order_name TEXT NOT NULL,         -- e.g. #1001
  invoice    TEXT NOT NULL,         -- merchantInvoiceNumber sent to bKash
  amount     TEXT NOT NULL,         -- e.g. 1250.00 (BDT)
  status     TEXT NOT NULL,         -- see PaymentStatus in src/db.ts
  trx_id     TEXT,                  -- bKash trxID once completed
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
