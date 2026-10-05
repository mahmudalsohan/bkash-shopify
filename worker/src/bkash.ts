// bKash Tokenized Checkout (PGW) client.
// Docs: https://developer.bka.sh  — endpoints below are for v1.2.0-beta.

import type { Env } from "./env";
import { kvGet, kvSet } from "./db";

export interface CreatePaymentResult {
  paymentID: string;
  bkashURL: string;
}

export interface PaymentStatus {
  paymentID: string;
  transactionStatus: string; // "Completed" | "Initiated" | "Failed" | ...
  trxID?: string;
  amount?: string;
  merchantInvoiceNumber?: string;
  statusCode?: string;
  statusMessage?: string;
}

export class BkashError extends Error {
  constructor(message: string, public readonly code?: string, public readonly body?: unknown) {
    super(message);
  }
}

const TOKEN_KEY = "bkash_id_token";

async function call<T>(env: Env, path: string, body: unknown, headers: Record<string, string>): Promise<T> {
  const res = await fetch(`${env.BKASH_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BkashError(`bKash ${path} returned non-JSON (HTTP ${res.status})`, undefined, text);
  }
  if (!res.ok) {
    throw new BkashError(`bKash ${path} HTTP ${res.status}`, json?.statusCode ?? json?.errorCode, json);
  }
  return json as T;
}

/** Returns a cached id_token, granting a new one when expired (tokens live 1 hour). */
export async function getToken(env: Env): Promise<string> {
  const cached = await kvGet(env, TOKEN_KEY);
  if (cached) return cached;

  const res = await call<any>(
    env,
    "/tokenized/checkout/token/grant",
    { app_key: env.BKASH_APP_KEY, app_secret: env.BKASH_APP_SECRET },
    { username: env.BKASH_USERNAME, password: env.BKASH_PASSWORD },
  );
  if (!res.id_token) {
    throw new BkashError(`bKash grant token failed: ${res.statusMessage ?? res.msg ?? "unknown"}`, res.statusCode, res);
  }
  const ttl = Number(res.expires_in ?? 3600);
  await kvSet(env, TOKEN_KEY, res.id_token, ttl - 300); // refresh 5 min early
  return res.id_token;
}

async function authed<T>(env: Env, path: string, body: unknown): Promise<T> {
  const token = await getToken(env);
  return call<T>(env, path, body, { Authorization: token, "X-App-Key": env.BKASH_APP_KEY });
}

export async function createPayment(
  env: Env,
  p: { amount: string; invoice: string; payerReference: string; callbackURL: string },
): Promise<CreatePaymentResult> {
  const res = await authed<any>(env, "/tokenized/checkout/create", {
    mode: "0011", // checkout URL flow (no agreement)
    payerReference: p.payerReference,
    callbackURL: p.callbackURL,
    amount: p.amount,
    currency: "BDT",
    intent: "sale",
    merchantInvoiceNumber: p.invoice,
  });
  if (res.statusCode !== "0000" || !res.bkashURL) {
    throw new BkashError(`bKash create failed: ${res.statusMessage ?? "unknown"}`, res.statusCode, res);
  }
  return { paymentID: res.paymentID, bkashURL: res.bkashURL };
}

export async function executePayment(env: Env, paymentID: string): Promise<PaymentStatus> {
  return authed<PaymentStatus>(env, "/tokenized/checkout/execute", { paymentID });
}

export async function queryPayment(env: Env, paymentID: string): Promise<PaymentStatus> {
  return authed<PaymentStatus>(env, "/tokenized/checkout/payment/status", { paymentID });
}

/**
 * Execute the payment, and fall back to a status query if execute errors or times out
 * (bKash recommends this — execute can fail even though the money moved).
 */
export async function executeOrQuery(env: Env, paymentID: string): Promise<PaymentStatus> {
  try {
    const res = await executePayment(env, paymentID);
    if (res.statusCode === "0000" && res.transactionStatus) return res;
  } catch (err) {
    console.warn("bKash execute failed, querying status", paymentID, err);
  }
  return queryPayment(env, paymentID);
}
