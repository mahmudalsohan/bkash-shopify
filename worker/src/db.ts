import type { Env } from "./env";

export type PaymentStatus =
  | "initiated" // created at bKash, customer hasn't finished
  | "processing" // a request is currently executing/settling this payment
  | "cancelled" // customer cancelled on the bKash page
  | "failed" // bKash reported failure
  | "unsynced" // money received, but marking the Shopify order paid failed (cron retries)
  | "completed" // money received and Shopify order marked paid
  | "needs_refund"; // money received for an order that was already cancelled/paid — refund manually

export interface PaymentRow {
  payment_id: string;
  order_id: string; // numeric Shopify order id
  order_name: string;
  invoice: string;
  amount: string;
  status: PaymentStatus;
  trx_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const now = () => Math.floor(Date.now() / 1000);

export async function insertPayment(
  env: Env,
  p: Pick<PaymentRow, "payment_id" | "order_id" | "order_name" | "invoice" | "amount">,
) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO payments (payment_id, order_id, order_name, invoice, amount, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'initiated', ?, ?)`,
  )
    .bind(p.payment_id, p.order_id, p.order_name, p.invoice, p.amount, t, t)
    .run();
}

export async function getPayment(env: Env, paymentId: string): Promise<PaymentRow | null> {
  return env.DB.prepare(`SELECT * FROM payments WHERE payment_id = ?`).bind(paymentId).first<PaymentRow>();
}

export async function updatePayment(
  env: Env,
  paymentId: string,
  fields: { status: PaymentStatus; trx_id?: string | null; error?: string | null },
) {
  await env.DB.prepare(
    `UPDATE payments SET status = ?, trx_id = COALESCE(?, trx_id), error = ?, updated_at = ? WHERE payment_id = ?`,
  )
    .bind(fields.status, fields.trx_id ?? null, fields.error ?? null, now(), paymentId)
    .run();
}

export async function paymentsByStatus(env: Env, status: PaymentStatus): Promise<PaymentRow[]> {
  const res = await env.DB.prepare(`SELECT * FROM payments WHERE status = ?`).bind(status).all<PaymentRow>();
  return res.results;
}

/**
 * Atomically moves a payment from "initiated" to "processing".
 * Returns false if another request already claimed it (e.g. duplicate bKash redirect).
 */
export async function claimPayment(env: Env, paymentId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE payments SET status = 'processing', updated_at = ? WHERE payment_id = ? AND status = 'initiated'`,
  )
    .bind(now(), paymentId)
    .run();
  return res.meta.changes === 1;
}

/** Puts payments stuck in "processing" (worker crashed mid-request) back to "initiated". */
export async function releaseStuck(env: Env, olderThanSeconds: number) {
  await env.DB.prepare(`UPDATE payments SET status = 'initiated' WHERE status = 'processing' AND updated_at < ?`)
    .bind(now() - olderThanSeconds)
    .run();
}

/** Payments still "initiated" that were created between `minAge` and `maxAge` seconds ago. */
export async function initiatedBetween(env: Env, minAge: number, maxAge: number): Promise<PaymentRow[]> {
  const t = now();
  const res = await env.DB.prepare(
    `SELECT * FROM payments WHERE status = 'initiated' AND created_at < ? AND created_at > ?`,
  )
    .bind(t - minAge, t - maxAge)
    .all<PaymentRow>();
  return res.results;
}

/** True if a bKash payment for this order was started recently (customer may be mid-payment). */
export async function hasRecentAttempt(env: Env, orderId: string, withinSeconds: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM payments WHERE order_id = ? AND created_at > ? LIMIT 1`,
  )
    .bind(orderId, now() - withinSeconds)
    .first();
  return row !== null;
}

// Tiny key/value cache with expiry (used for API tokens).
export async function kvGet(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM kv WHERE key = ? AND expires_at > ?`)
    .bind(key, now())
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function kvSet(env: Env, key: string, value: string, ttlSeconds: number) {
  await env.DB.prepare(
    `INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
  )
    .bind(key, value, now() + ttlSeconds)
    .run();
}
