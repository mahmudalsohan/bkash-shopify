// Test harness: runs the real Worker code in Node with
//  - D1 → an in-memory SQLite database (node:sqlite) loaded with schema.sql
//  - Shopify Admin API → an in-memory fake store
//  - bKash → an in-memory fake, or the real sandbox when `live: true`
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

export const SHOP = "test-shop.myshopify.com";
export const CLIENT_ID = "test-client-id";
export const CLIENT_SECRET = "test-client-secret";
export const PUBLIC_URL = "https://worker.test";
export const SANDBOX_URL = "https://tokenized.sandbox.bka.sh/v1.2.0-beta";

// ---------------------------------------------------------------------------
// D1 shim
// ---------------------------------------------------------------------------
export function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));

  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...p: unknown[]) => statement(sql, p),
    first: async <T>() => ((db.prepare(sql).get(...(params as any[])) as T) ?? null),
    all: async <T>() => ({ results: db.prepare(sql).all(...(params as any[])) as T[] }),
    run: async () => {
      const r = db.prepare(sql).run(...(params as any[]));
      return { meta: { changes: Number(r.changes) } };
    },
  });

  return { d1: { prepare: (sql: string) => statement(sql) } as unknown as D1Database, db };
}

// ---------------------------------------------------------------------------
// Fake Shopify store
// ---------------------------------------------------------------------------
export interface FakeOrder {
  id: string; // numeric
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string;
  paymentGatewayNames: string[];
  outstanding: string;
  currency: string;
  tags: string[];
}

export function makeOrder(id: string, o: Partial<FakeOrder> = {}): FakeOrder {
  return {
    id,
    name: `#${id}`,
    createdAt: new Date().toISOString(),
    cancelledAt: null,
    displayFinancialStatus: "PENDING",
    paymentGatewayNames: ["bKash"],
    outstanding: "1250.00",
    currency: "BDT",
    tags: [],
    ...o,
  };
}

// ---------------------------------------------------------------------------
// Fake bKash
// ---------------------------------------------------------------------------
export type BkashOutcome = "completed" | "not_completed" | "execute_throws" | "wrong_amount";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
export function setup(opts: { live?: boolean; envOverrides?: Partial<Env> } = {}) {
  const { d1, db } = makeD1();
  const orders = new Map<string, FakeOrder>();
  const calls: { service: "shopify" | "bkash"; op: string; body: any; headers: Record<string, string> }[] = [];
  const shopifyFail = { markPaid: false };
  const hidden = new Map<string, number>(); // order id → number of lookups that return null
  const bkash = {
    outcome: new Map<string, BkashOutcome>(), // per paymentID; default "completed"
    payments: new Map<string, { amount: string; invoice: string; executed: boolean }>(),
    seq: 0,
  };

  const env: Env = {
    DB: d1,
    PUBLIC_URL,
    SHOPIFY_SHOP: SHOP,
    SHOPIFY_CLIENT_ID: CLIENT_ID,
    SHOPIFY_CLIENT_SECRET: CLIENT_SECRET,
    SHOPIFY_API_VERSION: "2026-07",
    BKASH_GATEWAY_NAME: "bKash",
    BKASH_BASE_URL: opts.live ? SANDBOX_URL : "https://bkash.fake",
    BKASH_APP_KEY: "app-key",
    BKASH_APP_SECRET: "app-secret",
    BKASH_USERNAME: "user",
    BKASH_PASSWORD: "pass",
    LINK_SECRET: "link-secret",
    AUTO_CANCEL_HOURS: "24",
    ORDER_LOOKUP_RETRY_MS: "10",
    ...opts.envOverrides,
  };

  const realFetch = globalThis.fetch;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const toGraphql = (o: FakeOrder) => ({
    id: `gid://shopify/Order/${o.id}`,
    name: o.name,
    createdAt: o.createdAt,
    cancelledAt: o.cancelledAt,
    displayFinancialStatus: o.displayFinancialStatus,
    paymentGatewayNames: o.paymentGatewayNames,
    statusPageUrl: `https://${SHOP}/orders/${o.id}/status`,
    totalOutstandingSet: { shopMoney: { amount: o.outstanding, currencyCode: o.currency } },
  });
  const idOf = (gid: string) => gid.split("/").pop()!;

  async function shopifyGraphql(query: string, v: any) {
    if (query.includes("query GetOrder")) {
      const left = hidden.get(idOf(v.id)) ?? 0;
      if (left > 0) {
        hidden.set(idOf(v.id), left - 1);
        return json({ data: { order: null } });
      }
      const o = orders.get(idOf(v.id));
      return json({ data: { order: o ? toGraphql(o) : null } });
    }
    if (query.includes("mutation MarkPaid")) {
      if (shopifyFail.markPaid) return json({ errors: [{ message: "Internal error" }] }, 500);
      const o = orders.get(idOf(v.input.id))!;
      o.displayFinancialStatus = "PAID";
      o.outstanding = "0.00";
      return json({ data: { orderMarkAsPaid: { order: { id: v.input.id, displayFinancialStatus: "PAID" }, userErrors: [] } } });
    }
    if (query.includes("mutation AddTags")) {
      orders.get(idOf(v.id))?.tags.push(...v.tags);
      return json({ data: { tagsAdd: { userErrors: [] } } });
    }
    if (query.includes("query StaleOrders")) {
      const before = new Date(String(v.query).match(/created_at:<'([^']+)'/)![1]);
      const nodes = [...orders.values()]
        .filter((o) => o.displayFinancialStatus === "PENDING" && !o.cancelledAt && new Date(o.createdAt) < before)
        .map(toGraphql);
      return json({ data: { orders: { nodes } } });
    }
    if (query.includes("mutation CancelOrder")) {
      orders.get(idOf(v.orderId))!.cancelledAt = new Date().toISOString();
      return json({ data: { orderCancel: { job: { id: "job" }, orderCancelUserErrors: [] } } });
    }
    throw new Error(`Unhandled Shopify query: ${query.slice(0, 80)}`);
  }

  function fakeBkash(path: string, body: any) {
    if (path.endsWith("/token/grant")) return json({ id_token: "bkash-token", expires_in: 3600, statusCode: "0000" });
    if (path.endsWith("/checkout/create")) {
      const paymentID = `PAY${++bkash.seq}`;
      bkash.payments.set(paymentID, { amount: body.amount, invoice: body.merchantInvoiceNumber, executed: false });
      return json({ statusCode: "0000", statusMessage: "Successful", paymentID, bkashURL: `https://pay.fake/${paymentID}`, transactionStatus: "Initiated" });
    }
    const p = bkash.payments.get(body.paymentID);
    const outcome = bkash.outcome.get(body.paymentID) ?? "completed";
    const done = {
      paymentID: body.paymentID,
      transactionStatus: "Completed",
      trxID: `TRX${body.paymentID}`,
      amount: outcome === "wrong_amount" ? "1.00" : p?.amount,
      merchantInvoiceNumber: p?.invoice,
      statusCode: "0000",
      statusMessage: "Successful",
    };
    if (path.endsWith("/checkout/execute")) {
      if (outcome === "execute_throws") return new Response("upstream timeout", { status: 504 });
      if (outcome === "not_completed") return json({ statusCode: "2056", statusMessage: "Invalid Payment State" });
      if (p) p.executed = true;
      return json(done);
    }
    if (path.endsWith("/payment/status")) {
      if (outcome === "not_completed") return json({ ...done, transactionStatus: "Initiated", trxID: undefined });
      return json(done);
    }
    throw new Error(`Unhandled bKash path ${path}`);
  }

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = init?.body;
    const body = typeof raw === "string" ? (raw.startsWith("{") ? JSON.parse(raw) : raw) : raw?.toString();

    if (url.host === SHOP) {
      if (url.pathname === "/admin/oauth/access_token") {
        calls.push({ service: "shopify", op: "token", body, headers });
        return json({ access_token: "shopify-token", expires_in: 86399 });
      }
      calls.push({ service: "shopify", op: body.query.match(/(query|mutation) (\w+)/)[2], body, headers });
      return shopifyGraphql(body.query, body.variables);
    }
    if (url.href.startsWith(env.BKASH_BASE_URL)) {
      const op = url.pathname.split("/").slice(-2).join("/");
      calls.push({ service: "bkash", op, body, headers });
      return opts.live ? realFetch(input, init) : fakeBkash(url.pathname, body);
    }
    return realFetch(input, init);
  });

  const request = (path: string, init?: RequestInit) => worker.fetch(new Request(`${PUBLIC_URL}${path}`, init), env);

  const runCron = async () => {
    const waits: Promise<unknown>[] = [];
    await worker.scheduled({} as ScheduledController, env, { waitUntil: (p: Promise<unknown>) => waits.push(p) } as any);
    await Promise.all(waits);
  };

  const payment = (id: string) => db.prepare("SELECT * FROM payments WHERE payment_id = ?").get(id) as any;
  const ageRow = (id: string, seconds: number) =>
    db.prepare("UPDATE payments SET created_at = created_at - ?, updated_at = updated_at - ? WHERE payment_id = ?").run(seconds, seconds, id);

  /** Make the next `times` lookups of an order return null (not indexed yet). */
  const hideOrder = (id: string, times: number) => hidden.set(id, times);

  return { env, db, orders, calls, bkash, shopifyFail, request, runCron, payment, ageRow, hideOrder };
}

// ---------------------------------------------------------------------------
// Session tokens (what Shopify UI extensions send)
// ---------------------------------------------------------------------------
export function sessionToken(claims: Record<string, unknown> = {}, secret = CLIENT_SECRET, alg = "HS256") {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg, typ: "JWT" });
  const payload = b64({ dest: SHOP, aud: CLIENT_ID, exp: now + 300, nbf: now - 1, iat: now, ...claims });
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

export const payLinkRequest = (orderId: string, token = sessionToken()) => ({
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ orderId }),
});

/** Gets a signed /pay URL for an order via the public API, returns its path. */
export async function payPath(h: ReturnType<typeof setup>, orderId: string) {
  const res = await h.request("/api/pay-link", payLinkRequest(`gid://shopify/OrderIdentity/${orderId}`));
  const data: any = await res.json();
  if (data.status !== "payable") throw new Error(`order ${orderId} not payable: ${JSON.stringify(data)}`);
  return new URL(data.url).pathname + new URL(data.url).search;
}

/** Starts a payment for an order (→ bKash create) and returns the paymentID and bKash redirect URL. */
export async function startPayment(h: ReturnType<typeof setup>, orderId: string) {
  const res = await h.request(await payPath(h, orderId), { redirect: "manual" });
  if (res.status !== 302) throw new Error(`expected redirect, got ${res.status}: ${await res.text()}`);
  const row = h.db
    .prepare("SELECT payment_id FROM payments WHERE order_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(orderId) as { payment_id: string };
  return { paymentId: row.payment_id, bkashURL: res.headers.get("Location")! };
}

export const callback = (h: ReturnType<typeof setup>, paymentId: string, status: string) =>
  h.request(`/bkash/callback?paymentID=${encodeURIComponent(paymentId)}&status=${status}`);
