// Shopify Admin GraphQL client using the client credentials grant
// (works for a Dev Dashboard app installed on a store in your own organization).

import type { Env } from "./env";
import { kvGet, kvSet } from "./db";

const TOKEN_KEY = "shopify_access_token";

export interface ShopifyOrder {
  id: string; // gid://shopify/Order/123
  name: string; // #1001
  createdAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  paymentGatewayNames: string[];
  statusPageUrl: string;
  totalOutstandingSet: { shopMoney: { amount: string; currencyCode: string } };
}

async function getAccessToken(env: Env): Promise<string> {
  const cached = await kvGet(env, TOKEN_KEY);
  if (cached) return cached;

  const res = await fetch(`https://${env.SHOPIFY_SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Shopify token request failed: HTTP ${res.status} ${await res.text()}`);
  const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in: number };
  await kvSet(env, TOKEN_KEY, access_token, (expires_in ?? 86399) - 600);
  return access_token;
}

export async function graphql<T>(env: Env, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`https://${env.SHOPIFY_SHOP}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await getAccessToken(env) },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify GraphQL HTTP ${res.status}: ${await res.text()}`);
  const { data, errors } = (await res.json()) as { data: T; errors?: unknown[] };
  if (errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(errors)}`);
  return data;
}

/** Accepts "123", "gid://shopify/Order/123" or "gid://shopify/OrderIdentity/123" and returns "123". */
export function numericOrderId(id: string): string | null {
  const m = String(id).match(/(\d+)$/);
  return m ? m[1] : null;
}

const ORDER_FIELDS = `
  id
  name
  createdAt
  cancelledAt
  displayFinancialStatus
  paymentGatewayNames
  statusPageUrl
  totalOutstandingSet { shopMoney { amount currencyCode } }
`;

export async function getOrder(env: Env, orderId: string): Promise<ShopifyOrder | null> {
  const data = await graphql<{ order: ShopifyOrder | null }>(
    env,
    `query GetOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`,
    { id: `gid://shopify/Order/${orderId}` },
  );
  return data.order;
}

export async function markOrderPaid(env: Env, orderId: string, trxId: string): Promise<void> {
  const data = await graphql<any>(
    env,
    `mutation MarkPaid($input: OrderMarkAsPaidInput!) {
      orderMarkAsPaid(input: $input) {
        order { id displayFinancialStatus }
        userErrors { field message }
      }
    }`,
    { input: { id: `gid://shopify/Order/${orderId}` } },
  );
  const errs = data.orderMarkAsPaid.userErrors;
  if (errs.length) throw new Error(`orderMarkAsPaid: ${JSON.stringify(errs)}`);
  await addTags(env, orderId, ["bkash-paid", `bkash-trx-${trxId}`]);
}

export async function addTags(env: Env, orderId: string, tags: string[]): Promise<void> {
  const data = await graphql<any>(
    env,
    `mutation AddTags($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
    }`,
    { id: `gid://shopify/Order/${orderId}`, tags },
  );
  const errs = data.tagsAdd.userErrors;
  if (errs.length) console.warn("tagsAdd failed", orderId, errs);
}

/** Open, unpaid orders created before `before`. Caller filters by payment gateway. */
export async function pendingOrdersBefore(env: Env, before: Date): Promise<ShopifyOrder[]> {
  const data = await graphql<{ orders: { nodes: ShopifyOrder[] } }>(
    env,
    `query StaleOrders($query: String!) { orders(first: 50, query: $query) { nodes { ${ORDER_FIELDS} } } }`,
    { query: `financial_status:pending status:open created_at:<'${before.toISOString()}'` },
  );
  return data.orders.nodes;
}

export async function cancelOrder(env: Env, orderId: string, staffNote: string): Promise<void> {
  const data = await graphql<any>(
    env,
    `mutation CancelOrder($orderId: ID!, $staffNote: String) {
      orderCancel(
        orderId: $orderId
        reason: OTHER
        restock: true
        notifyCustomer: true
        staffNote: $staffNote
        refundMethod: { originalPaymentMethodsRefund: false }
      ) {
        job { id }
        orderCancelUserErrors { field message code }
      }
    }`,
    { orderId: `gid://shopify/Order/${orderId}`, staffNote },
  );
  const errs = data.orderCancel.orderCancelUserErrors;
  if (errs.length) throw new Error(`orderCancel: ${JSON.stringify(errs)}`);
}

// ---------- order → bKash payability ----------

export type Payability =
  | { status: "payable"; amount: string; orderName: string }
  | { status: "paid" | "cancelled" | "not_applicable" | "not_found" }
  | { status: "error"; message: string };

export function isBkashOrder(env: Env, order: ShopifyOrder): boolean {
  const want = env.BKASH_GATEWAY_NAME.trim().toLowerCase();
  return order.paymentGatewayNames.some((g) => g.trim().toLowerCase() === want);
}

export function payability(env: Env, order: ShopifyOrder | null): Payability {
  if (!order) return { status: "not_found" };
  if (!isBkashOrder(env, order)) return { status: "not_applicable" };
  if (order.cancelledAt) return { status: "cancelled" };

  const { amount, currencyCode } = order.totalOutstandingSet.shopMoney;
  const outstanding = Number(amount);
  if (order.displayFinancialStatus === "PAID" || outstanding <= 0) return { status: "paid" };
  if (currencyCode !== "BDT") return { status: "error", message: `Store currency is ${currencyCode}, bKash needs BDT` };

  return { status: "payable", amount: outstanding.toFixed(2), orderName: order.name };
}
