import type { Env } from "./env";
import { createPayment, executeOrQuery, type PaymentStatus as BkashStatus } from "./bkash";
import { signedPayUrl, verifyPayUrl, verifySessionToken } from "./auth";
import {
  claimPayment,
  getPayment,
  hasRecentAttempt,
  initiatedBetween,
  insertPayment,
  kvSet,
  paymentsByStatus,
  releaseStuck,
  updatePayment,
  type PaymentRow,
} from "./db";
import {
  addTags,
  cancelOrder,
  getOrder,
  isBkashOrder,
  markOrderPaid,
  numericOrderId,
  payability,
  pendingOrdersBefore,
} from "./shopify";
import { page } from "./pages";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

      if (request.method === "POST" && url.pathname === "/api/pay-link") return await apiPayLink(request, env);

      const pay = url.pathname.match(/^\/pay\/(\d+)$/);
      if (request.method === "GET" && pay) return await startPayment(env, pay[1], url);

      if (request.method === "GET" && url.pathname === "/bkash/callback") return await bkashCallback(env, url);

      if (url.pathname === "/") return new Response("bKash for Shopify is running.", { status: 200 });

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("Unhandled error", url.pathname, err);
      if (url.pathname.startsWith("/api/")) return json({ status: "error", message: "Server error" }, 500);
      return page({
        tone: "error",
        title: "Something went wrong",
        message: "We couldn't process your bKash payment right now. Please try again in a few minutes.",
        status: 500,
      });
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env));
  },
};

// ---------------------------------------------------------------------------
// POST /api/pay-link  — called by the Thank-you / Order-status extensions
// Body: { orderId: "gid://shopify/OrderIdentity/123" | "gid://shopify/Order/123" }
// ---------------------------------------------------------------------------
async function apiPayLink(request: Request, env: Env): Promise<Response> {
  const session = await verifySessionToken(env, request.headers.get("Authorization"));
  if (!session) {
    console.warn("pay-link: invalid session token");
    return json({ status: "error", message: "Unauthorized" }, 401);
  }

  const body = (await request.json().catch(() => ({}))) as { orderId?: string };
  const orderId = body.orderId ? numericOrderId(body.orderId) : null;
  if (!orderId) return json({ status: "error", message: "orderId required" }, 400);

  const result = payability(env, await getOrder(env, orderId));
  console.log("pay-link", orderId, result.status);
  // Brand-new orders take a few seconds to become visible in the Admin API. Don't make the
  // customer wait: hand out the signed link now — /pay re-checks the order when it's tapped.
  if (result.status === "not_found") return json({ status: "pending", url: await signedPayUrl(env, orderId) });
  if (result.status !== "payable") return json(result);

  return json({ ...result, url: await signedPayUrl(env, orderId) });
}

// ---------------------------------------------------------------------------
// GET /pay/:orderId?exp=&sig=  — creates a bKash payment and redirects to bKash
// ---------------------------------------------------------------------------
async function startPayment(env: Env, orderId: string, url: URL): Promise<Response> {
  if (!(await verifyPayUrl(env, orderId, url.searchParams.get("exp"), url.searchParams.get("sig")))) {
    return page({
      tone: "error",
      title: "Link expired",
      message: "This payment link is invalid or has expired. Open your order status page to get a new one.",
      status: 403,
    });
  }

  const order = await getOrderWithRetry(env, orderId);
  const p = payability(env, order);
  const back = order ? { href: order.statusPageUrl, label: "View your order" } : undefined;

  if (p.status === "paid") {
    return page({ tone: "success", title: "Already paid", message: "This order has already been paid. Thank you!", action: back });
  }
  if (p.status !== "payable") {
    return page({
      tone: "error",
      title: "Payment not available",
      message:
        p.status === "cancelled"
          ? "This order has been cancelled."
          : p.status === "error"
            ? p.message
            : "This order can't be paid with bKash.",
      action: back,
    });
  }

  const invoice = `${orderId}-${Date.now().toString(36)}`;
  const { paymentID, bkashURL } = await createPayment(env, {
    amount: p.amount,
    invoice,
    payerReference: p.orderName.replace(/^#/, ""),
    callbackURL: `${env.PUBLIC_URL}/bkash/callback`,
  });
  await insertPayment(env, { payment_id: paymentID, order_id: orderId, order_name: p.orderName, invoice, amount: p.amount });

  return Response.redirect(bkashURL, 302);
}

/** A just-placed order can take a few seconds to show up in the Admin API. */
async function getOrderWithRetry(env: Env, orderId: string, attempts = 5) {
  const delayMs = Number(env.ORDER_LOOKUP_RETRY_MS ?? 1000);
  for (let i = 0; ; i++) {
    const order = await getOrder(env, orderId);
    if (order || i >= attempts - 1) return order;
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

// ---------------------------------------------------------------------------
// GET /bkash/callback?paymentID=&status=success|failure|cancel
// ---------------------------------------------------------------------------
async function bkashCallback(env: Env, url: URL): Promise<Response> {
  const paymentID = url.searchParams.get("paymentID");
  const status = url.searchParams.get("status");
  const row = paymentID ? await getPayment(env, paymentID) : null;
  if (!row) {
    return page({ tone: "error", title: "Unknown payment", message: "We couldn't find this payment.", status: 404 });
  }

  const order = await getOrder(env, row.order_id).catch(() => null);
  const back = order ? { href: order.statusPageUrl, label: "Back to your order" } : undefined;
  const details: [string, string][] = [
    ["Order", row.order_name],
    ["Amount", `৳${row.amount}`],
  ];

  // Already handled (customer refreshed the page, or bKash redirected twice).
  if (row.status === "completed" || row.status === "unsynced" || row.status === "needs_refund") {
    return successPage(row, row.trx_id, back);
  }

  const retry = async (title: string, message: string) =>
    page({
      tone: "error",
      title,
      message,
      details,
      action: { href: await signedPayUrl(env, row.order_id), label: "Try again with bKash" },
      secondary: back,
    });

  if (row.status === "cancelled" || row.status === "failed") {
    return retry("Payment not completed", "No money was taken. You can try again.");
  }

  // Only one request may execute a payment (guards against duplicate redirects / double refresh).
  if (!(await claimPayment(env, row.payment_id))) {
    return page({
      tone: "info",
      title: "Confirming your payment…",
      message: "We're confirming your payment with bKash. Refresh this page in a few seconds.",
      details,
      action: { href: url.toString(), label: "Refresh" },
    });
  }

  if (status !== "success") {
    await updatePayment(env, row.payment_id, { status: status === "cancel" ? "cancelled" : "failed", error: status });
    return retry(status === "cancel" ? "Payment cancelled" : "Payment failed", "No money was taken. You can try again.");
  }

  // Never trust the redirect alone — confirm with bKash server-to-server.
  const result = await executeOrQuery(env, row.payment_id);
  if (result.transactionStatus !== "Completed" || !result.trxID) {
    await updatePayment(env, row.payment_id, { status: "failed", error: result.statusMessage ?? result.transactionStatus });
    return retry("Payment not completed", result.statusMessage ?? "bKash did not confirm the payment. No money was taken.");
  }

  await settle(env, row, result);
  return successPage((await getPayment(env, row.payment_id))!, result.trxID, back);
}

function successPage(row: PaymentRow, trxId: string | null, back?: { href: string; label: string }) {
  return page({
    tone: "success",
    title: "Payment received",
    message:
      row.status === "needs_refund"
        ? "We received your payment, but there's an issue with this order. Our team will contact you shortly."
        : "Thank you! Your bKash payment was successful and your order is confirmed. You can return to the store.",
    details: [
      ["Order", row.order_name],
      ["Amount", `৳${row.amount}`],
      ["bKash TrxID", trxId ?? "—"],
    ],
    action: back,
  });
}

/**
 * Money has been received at bKash. Verify it matches what we asked for, then mark the Shopify order paid.
 * Safe to call more than once.
 */
async function settle(env: Env, row: PaymentRow, result: BkashStatus): Promise<void> {
  const trxId = result.trxID!;

  const amountOk = Number(result.amount) === Number(row.amount);
  const invoiceOk = !result.merchantInvoiceNumber || result.merchantInvoiceNumber === row.invoice;
  if (!amountOk || !invoiceOk) {
    const error = `Mismatch: bKash amount=${result.amount} invoice=${result.merchantInvoiceNumber}`;
    console.error(error, row);
    await updatePayment(env, row.payment_id, { status: "needs_refund", trx_id: trxId, error });
    await addTags(env, row.order_id, ["bkash-needs-review"]).catch(() => {});
    return;
  }

  try {
    const order = await getOrder(env, row.order_id);
    const p = payability(env, order);
    if (p.status === "payable") {
      await markOrderPaid(env, row.order_id, trxId);
      await updatePayment(env, row.payment_id, { status: "completed", trx_id: trxId });
    } else {
      // Order was cancelled or already paid by another attempt — money must go back to the customer.
      const error = `Order not payable (${p.status}) when payment completed`;
      await updatePayment(env, row.payment_id, { status: "needs_refund", trx_id: trxId, error });
      await addTags(env, row.order_id, ["bkash-needs-refund", `bkash-trx-${trxId}`]);
    }
  } catch (err) {
    console.error("Failed to update Shopify, will retry from cron", row.payment_id, err);
    await updatePayment(env, row.payment_id, { status: "unsynced", trx_id: trxId, error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Cron (every 10 minutes, see wrangler.toml)
// ---------------------------------------------------------------------------
async function runScheduled(env: Env) {
  // Heartbeat: `SELECT value FROM kv WHERE key = 'cron_last_run'` shows the cron is alive.
  await kvSet(env, "cron_last_run", new Date().toISOString(), 30 * 24 * 3600);
  await releaseStuck(env, 15 * 60);

  // 1. Retry Shopify updates that failed after a successful bKash payment.
  for (const row of await paymentsByStatus(env, "unsynced")) {
    await settle(env, row, { paymentID: row.payment_id, transactionStatus: "Completed", trxID: row.trx_id!, amount: row.amount });
  }

  // 2. Recover payments where the customer paid but never came back to our callback
  //    (closed the browser, lost connection). Execute succeeds only if they authorised it.
  for (const row of await initiatedBetween(env, 10 * 60, 48 * 3600)) {
    if (!(await claimPayment(env, row.payment_id))) continue;
    try {
      const result = await executeOrQuery(env, row.payment_id);
      if (result.transactionStatus === "Completed" && result.trxID) {
        await settle(env, row, result);
      } else if (row.created_at < Date.now() / 1000 - 2 * 3600) {
        await updatePayment(env, row.payment_id, { status: "failed", error: `expired (${result.transactionStatus})` });
      } else {
        await updatePayment(env, row.payment_id, { status: "initiated" });
      }
    } catch (err) {
      console.warn("Reconcile failed", row.payment_id, err);
      await updatePayment(env, row.payment_id, { status: "initiated", error: String(err) });
    }
  }

  // 3. Cancel bKash orders that stayed unpaid too long (releases reserved stock).
  const hours = Number(env.AUTO_CANCEL_HOURS || "0");
  if (hours > 0) {
    const stale = await pendingOrdersBefore(env, new Date(Date.now() - hours * 3600 * 1000));
    for (const order of stale) {
      if (!isBkashOrder(env, order)) continue;
      const id = numericOrderId(order.id)!;
      if (await hasRecentAttempt(env, id, 60 * 60)) continue; // customer is paying right now
      try {
        await cancelOrder(env, id, `Auto-cancelled: bKash payment not received within ${hours}h`);
        console.log("Cancelled unpaid order", order.name);
      } catch (err) {
        console.warn("Cancel failed", order.name, err);
      }
    }
  }
}
