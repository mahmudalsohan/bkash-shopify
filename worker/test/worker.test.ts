import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callback,
  makeOrder,
  payLinkRequest,
  payPath,
  PUBLIC_URL,
  sessionToken,
  setup,
  startPayment,
} from "./helpers";

let h: ReturnType<typeof setup>;
beforeEach(() => {
  h = setup();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const html = (res: Response) => res.text();
const h1 = async (res: Response) => (await html(res)).match(/<h1>([^<]*)<\/h1>/)?.[1];

// ===========================================================================
describe("routing", () => {
  it("health check on /", async () => {
    const res = await h.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("running");
  });

  it("answers CORS preflight for the extensions", async () => {
    const res = await h.request("/api/pay-link", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("404s unknown routes", async () => {
    expect((await h.request("/nope")).status).toBe(404);
  });
});

// ===========================================================================
describe("POST /api/pay-link — session token verification", () => {
  beforeEach(() => h.orders.set("1001", makeOrder("1001")));

  it("rejects a missing token", async () => {
    const res = await h.request("/api/pay-link", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it.each([
    ["signed with the wrong secret", sessionToken({}, "wrong-secret")],
    ["expired", sessionToken({ exp: Math.floor(Date.now() / 1000) - 60 })],
    ["not yet valid", sessionToken({ nbf: Math.floor(Date.now() / 1000) + 600 })],
    ["for another app (aud)", sessionToken({ aud: "other-app" })],
    ["for another shop (dest)", sessionToken({ dest: "evil.myshopify.com" })],
    ["using alg=none", sessionToken({}, "x", "none")],
    ["malformed", "not.a.jwt.at.all"],
  ])("rejects a token %s", async (_label, token) => {
    const res = await h.request("/api/pay-link", payLinkRequest("1001", token));
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*"); // extension can read the error
  });

  it("accepts dest with an https:// prefix", async () => {
    const res = await h.request("/api/pay-link", payLinkRequest("1001", sessionToken({ dest: "https://test-shop.myshopify.com" })));
    expect(res.status).toBe(200);
  });

  it("400s without an orderId", async () => {
    const res = await h.request("/api/pay-link", { ...payLinkRequest("x"), body: "{}" });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
describe("POST /api/pay-link — order states", () => {
  const ask = async (orderId: string) => {
    const res = await h.request("/api/pay-link", payLinkRequest(orderId));
    return { status: res.status, body: (await res.json()) as any };
  };

  it("payable bKash order → amount + signed link (OrderIdentity gid from Thank-you page)", async () => {
    h.orders.set("1001", makeOrder("1001", { outstanding: "1250.00" }));
    const { status, body } = await ask("gid://shopify/OrderIdentity/1001");
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "payable", amount: "1250.00", orderName: "#1001" });
    expect(body.url).toMatch(new RegExp(`^${PUBLIC_URL}/pay/1001\\?exp=\\d+&sig=[\\w-]+$`));
  });

  it("accepts the Order gid from the Order status page", async () => {
    h.orders.set("1001", makeOrder("1001"));
    expect((await ask("gid://shopify/Order/1001")).body.status).toBe("payable");
  });

  it("charges only the outstanding amount on partially paid orders", async () => {
    h.orders.set("1001", makeOrder("1001", { outstanding: "500.5", displayFinancialStatus: "PARTIALLY_PAID" }));
    expect((await ask("1001")).body.amount).toBe("500.50");
  });

  it("matches the gateway name case-insensitively", async () => {
    h.orders.set("1001", makeOrder("1001", { paymentGatewayNames: [" BKASH "] }));
    expect((await ask("1001")).body.status).toBe("payable");
  });

  it("not_applicable for orders paid another way (e.g. Cash on Delivery)", async () => {
    h.orders.set("1001", makeOrder("1001", { paymentGatewayNames: ["Cash on Delivery (COD)"] }));
    expect((await ask("1001")).body).toEqual({ status: "not_applicable" });
  });

  it("paid for already-paid orders", async () => {
    h.orders.set("1001", makeOrder("1001", { displayFinancialStatus: "PAID", outstanding: "0.00" }));
    expect((await ask("1001")).body.status).toBe("paid");
  });

  it("cancelled for cancelled orders", async () => {
    h.orders.set("1001", makeOrder("1001", { cancelledAt: new Date().toISOString() }));
    expect((await ask("1001")).body.status).toBe("cancelled");
  });

  it("error when the order isn't in BDT", async () => {
    h.orders.set("1001", makeOrder("1001", { currency: "USD" }));
    expect((await ask("1001")).body).toMatchObject({ status: "error" });
  });

  it("order not visible yet → 'pending' with a signed link right away (no waiting)", async () => {
    const { status, body } = await ask("gid://shopify/OrderIdentity/999");
    expect(status).toBe(200);
    expect(body.status).toBe("pending");
    expect(body.url).toMatch(new RegExp(`^${PUBLIC_URL}/pay/999\\?exp=\\d+&sig=`));
  });
});

// ===========================================================================
describe("GET /pay/:orderId — signed link → bKash", () => {
  it("creates a bKash payment with the right request and redirects to bKash", async () => {
    h.orders.set("1001", makeOrder("1001", { outstanding: "1250.00" }));
    const { paymentId, bkashURL } = await startPayment(h, "1001");

    expect(bkashURL).toBe(`https://pay.fake/${paymentId}`);
    const create = h.calls.find((c) => c.op === "checkout/create")!;
    expect(create.headers.authorization).toBe("bkash-token");
    expect(create.headers["x-app-key"]).toBe("app-key");
    expect(create.body).toMatchObject({
      mode: "0011",
      amount: "1250.00",
      currency: "BDT",
      intent: "sale",
      payerReference: "1001",
      callbackURL: `${PUBLIC_URL}/bkash/callback`,
    });
    expect(create.body.merchantInvoiceNumber).toMatch(/^1001-/);

    expect(h.payment(paymentId)).toMatchObject({ order_id: "1001", order_name: "#1001", amount: "1250.00", status: "initiated" });
  });

  it("grants the bKash token once and reuses it (cached in D1)", async () => {
    h.orders.set("1001", makeOrder("1001"));
    await startPayment(h, "1001");
    await startPayment(h, "1001");
    expect(h.calls.filter((c) => c.op === "token/grant")).toHaveLength(1);
    expect(h.calls.filter((c) => c.op === "checkout/create")).toHaveLength(2);
  });

  it("caches the Shopify access token too", async () => {
    h.orders.set("1001", makeOrder("1001"));
    await startPayment(h, "1001");
    await startPayment(h, "1001");
    expect(h.calls.filter((c) => c.service === "shopify" && c.op === "token")).toHaveLength(1);
  });

  it("sends a unique invoice number per attempt", async () => {
    h.orders.set("1001", makeOrder("1001"));
    await startPayment(h, "1001");
    await new Promise((r) => setTimeout(r, 2));
    await startPayment(h, "1001");
    const invoices = h.calls.filter((c) => c.op === "checkout/create").map((c) => c.body.merchantInvoiceNumber);
    expect(new Set(invoices).size).toBe(2);
  });

  it.each([
    ["a tampered order id", (p: string) => p.replace("/pay/1001", "/pay/1002")],
    ["a tampered signature", (p: string) => p.replace(/sig=.{4}/, "sig=AAAA")],
    ["a tampered expiry", (p: string) => p.replace(/exp=\d+/, "exp=9999999999")],
    ["no signature", (p: string) => p.split("?")[0]],
  ])("refuses %s (403, no bKash call)", async (_label, tamper) => {
    h.orders.set("1001", makeOrder("1001"));
    h.orders.set("1002", makeOrder("1002"));
    const res = await h.request(tamper(await payPath(h, "1001")), { redirect: "manual" });
    expect(res.status).toBe(403);
    expect(h.calls.some((c) => c.service === "bkash")).toBe(false);
  });

  it("refuses an expired link", async () => {
    h.orders.set("1001", makeOrder("1001"));
    const path = await payPath(h, "1001");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25 * 3600 * 1000);
    const res = await h.request(path, { redirect: "manual" });
    vi.useRealTimers();
    expect(res.status).toBe(403);
  });

  it("tapping the link before Shopify has indexed the order waits for it, then pays", async () => {
    // pay-link handed out a link while the order was still invisible...
    const res1 = await h.request("/api/pay-link", payLinkRequest("1001"));
    const { url } = (await res1.json()) as any;
    // ...and the order shows up ~2s later
    h.orders.set("1001", makeOrder("1001"));
    h.hideOrder("1001", 2);
    const res = await h.request(new URL(url).pathname + new URL(url).search, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(h.calls.filter((c) => c.op === "GetOrder").length).toBeGreaterThanOrEqual(3);
  });

  it("gives up after ~5s if the order never appears", async () => {
    const res1 = await h.request("/api/pay-link", payLinkRequest("4040"));
    const { url } = (await res1.json()) as any;
    const res = await h.request(new URL(url).pathname + new URL(url).search, { redirect: "manual" });
    expect(await h1(res)).toBe("Payment not available");
    expect(h.calls.filter((c) => c.op === "GetOrder" && c.body.variables.id.endsWith("/4040"))).toHaveLength(6); // pay-link + 5 tries
    expect(h.calls.some((c) => c.op === "checkout/create")).toBe(false);
  });

  it("shows 'Already paid' instead of charging twice", async () => {
    h.orders.set("1001", makeOrder("1001"));
    const path = await payPath(h, "1001");
    h.orders.get("1001")!.displayFinancialStatus = "PAID";
    const res = await h.request(path, { redirect: "manual" });
    expect(await h1(res)).toBe("Already paid");
    expect(h.calls.some((c) => c.op === "checkout/create")).toBe(false);
  });

  it("refuses to charge a cancelled order", async () => {
    h.orders.set("1001", makeOrder("1001"));
    const path = await payPath(h, "1001");
    h.orders.get("1001")!.cancelledAt = new Date().toISOString();
    const res = await h.request(path, { redirect: "manual" });
    expect(await html(res)).toContain("cancelled");
    expect(h.calls.some((c) => c.op === "checkout/create")).toBe(false);
  });
});

// ===========================================================================
describe("GET /bkash/callback", () => {
  beforeEach(() => h.orders.set("1001", makeOrder("1001", { outstanding: "1250.00" })));

  it("success → executes, marks the Shopify order paid, tags it, shows TrxID", async () => {
    const { paymentId } = await startPayment(h, "1001");
    const res = await callback(h, paymentId, "success");
    const page = await html(res);

    expect(page).toContain("<h1>Payment received</h1>");
    expect(page).toContain(`TRX${paymentId}`);
    expect(page).toContain("৳1250.00");
    expect(page).toContain("/orders/1001/status"); // back to order link
    expect(h.payment(paymentId)).toMatchObject({ status: "completed", trx_id: `TRX${paymentId}` });
    expect(h.orders.get("1001")).toMatchObject({ displayFinancialStatus: "PAID" });
    expect(h.orders.get("1001")!.tags).toEqual(["bkash-paid", `bkash-trx-TRX${paymentId}`]);
  });

  it("refreshing the success page doesn't execute or mark paid again", async () => {
    const { paymentId } = await startPayment(h, "1001");
    await callback(h, paymentId, "success");
    const res = await callback(h, paymentId, "success");
    expect(await h1(res)).toBe("Payment received");
    expect(h.calls.filter((c) => c.op === "checkout/execute")).toHaveLength(1);
    expect(h.calls.filter((c) => c.op === "MarkPaid")).toHaveLength(1);
  });

  it("concurrent duplicate redirects: only one request settles the payment", async () => {
    const { paymentId } = await startPayment(h, "1001");
    const results = await Promise.all([1, 2, 3].map(() => callback(h, paymentId, "success").then(h1)));
    expect(results.filter((t) => t === "Payment received").length).toBeGreaterThanOrEqual(1);
    expect(h.calls.filter((c) => c.op === "checkout/execute")).toHaveLength(1);
    expect(h.calls.filter((c) => c.op === "MarkPaid")).toHaveLength(1);
    expect(h.payment(paymentId).status).toBe("completed");
  });

  it("cancel → marked cancelled, no money moved, offers a working retry link", async () => {
    const { paymentId } = await startPayment(h, "1001");
    const page = await html(await callback(h, paymentId, "cancel"));
    expect(page).toContain("<h1>Payment cancelled</h1>");
    expect(h.payment(paymentId).status).toBe("cancelled");
    expect(h.calls.some((c) => c.op === "checkout/execute")).toBe(false);
    expect(h.orders.get("1001")!.displayFinancialStatus).toBe("PENDING");

    const retry = page.match(/href="([^"]*\/pay\/1001[^"]*)"/)![1].replace(/&amp;/g, "&");
    const res = await h.request(new URL(retry).pathname + new URL(retry).search, { redirect: "manual" });
    expect(res.status).toBe(302); // retry link creates a fresh bKash payment
  });

  it("failure → marked failed, order untouched", async () => {
    const { paymentId } = await startPayment(h, "1001");
    expect(await h1(await callback(h, paymentId, "failure"))).toBe("Payment failed");
    expect(h.payment(paymentId).status).toBe("failed");
    expect(h.orders.get("1001")!.displayFinancialStatus).toBe("PENDING");
  });

  it("a forged status=success is verified with bKash and rejected if not completed", async () => {
    const { paymentId } = await startPayment(h, "1001");
    h.bkash.outcome.set(paymentId, "not_completed");
    expect(await h1(await callback(h, paymentId, "success"))).toBe("Payment not completed");
    expect(h.payment(paymentId).status).toBe("failed");
    expect(h.orders.get("1001")!.displayFinancialStatus).toBe("PENDING");
  });

  it("execute times out but payment went through → falls back to status query and completes", async () => {
    const { paymentId } = await startPayment(h, "1001");
    h.bkash.outcome.set(paymentId, "execute_throws");
    expect(await h1(await callback(h, paymentId, "success"))).toBe("Payment received");
    expect(h.calls.some((c) => c.op === "payment/status")).toBe(true);
    expect(h.payment(paymentId).status).toBe("completed");
  });

  it("amount mismatch → needs_refund, order NOT marked paid, tagged for review", async () => {
    const { paymentId } = await startPayment(h, "1001");
    h.bkash.outcome.set(paymentId, "wrong_amount");
    const page = await html(await callback(h, paymentId, "success"));
    expect(page).toContain("our team will contact you".replace("our", "Our"));
    expect(h.payment(paymentId).status).toBe("needs_refund");
    expect(h.orders.get("1001")!.displayFinancialStatus).toBe("PENDING");
    expect(h.orders.get("1001")!.tags).toContain("bkash-needs-review");
  });

  it("order cancelled while the customer was paying → needs_refund + tags", async () => {
    const { paymentId } = await startPayment(h, "1001");
    h.orders.get("1001")!.cancelledAt = new Date().toISOString();
    await callback(h, paymentId, "success");
    expect(h.payment(paymentId).status).toBe("needs_refund");
    expect(h.orders.get("1001")!.tags).toEqual(expect.arrayContaining(["bkash-needs-refund", `bkash-trx-TRX${paymentId}`]));
    expect(h.calls.some((c) => c.op === "MarkPaid")).toBe(false);
  });

  it("two payments for the same order: second one is flagged for refund", async () => {
    const a = await startPayment(h, "1001");
    const b = await startPayment(h, "1001"); // customer opened the link twice
    await callback(h, a.paymentId, "success");
    await callback(h, b.paymentId, "success");
    expect(h.payment(a.paymentId).status).toBe("completed");
    expect(h.payment(b.paymentId).status).toBe("needs_refund");
    expect(h.calls.filter((c) => c.op === "MarkPaid")).toHaveLength(1);
  });

  it("Shopify down after bKash success → unsynced, customer still sees success", async () => {
    const { paymentId } = await startPayment(h, "1001");
    h.shopifyFail.markPaid = true;
    expect(await h1(await callback(h, paymentId, "success"))).toBe("Payment received");
    expect(h.payment(paymentId).status).toBe("unsynced");
  });

  it("unknown paymentID → 404", async () => {
    expect((await callback(h, "does-not-exist", "success")).status).toBe(404);
  });

  it("escapes HTML in result pages", async () => {
    h.orders.set("1002", makeOrder("1002", { name: "#<script>x</script>" }));
    const { paymentId } = await startPayment(h, "1002");
    const page = await html(await callback(h, paymentId, "cancel"));
    expect(page).not.toContain("<script>x");
    expect(page).toContain("&lt;script&gt;");
  });
});

// ===========================================================================
describe("hourly cron", () => {
  beforeEach(() => h.orders.set("1001", makeOrder("1001")));

  it("retries unsynced payments until Shopify is marked paid", async () => {
    const { paymentId } = await startPayment(h, "1001");
    h.shopifyFail.markPaid = true;
    await callback(h, paymentId, "success");
    expect(h.payment(paymentId).status).toBe("unsynced");

    h.shopifyFail.markPaid = false;
    await h.runCron();
    expect(h.payment(paymentId).status).toBe("completed");
    expect(h.orders.get("1001")!.displayFinancialStatus).toBe("PAID");
  });

  it("recovers a payment whose callback never arrived (customer closed the tab)", async () => {
    const { paymentId } = await startPayment(h, "1001");
    h.ageRow(paymentId, 15 * 60);
    await h.runCron();
    expect(h.payment(paymentId).status).toBe("completed");
    expect(h.orders.get("1001")!.displayFinancialStatus).toBe("PAID");
  });

  it("leaves fresh (< 10 min) payments alone — customer may still be paying", async () => {
    const { paymentId } = await startPayment(h, "1001");
    await h.runCron();
    expect(h.payment(paymentId).status).toBe("initiated");
    expect(h.calls.some((c) => c.op === "checkout/execute")).toBe(false);
  });

  it("keeps retrying unauthorised payments for 2h, then marks them failed", async () => {
    const { paymentId } = await startPayment(h, "1001");
    h.bkash.outcome.set(paymentId, "not_completed");
    h.ageRow(paymentId, 30 * 60);
    await h.runCron();
    expect(h.payment(paymentId).status).toBe("initiated");

    h.ageRow(paymentId, 2 * 3600);
    await h.runCron();
    expect(h.payment(paymentId).status).toBe("failed");
  });

  it("releases payments stuck in 'processing' (worker crashed) and recovers them", async () => {
    const { paymentId } = await startPayment(h, "1001");
    h.db.prepare("UPDATE payments SET status='processing' WHERE payment_id=?").run(paymentId);
    h.ageRow(paymentId, 20 * 60);
    await h.runCron();
    expect(h.payment(paymentId).status).toBe("completed");
  });

  it("auto-cancels stale unpaid bKash orders only", async () => {
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    h.orders.set("2001", makeOrder("2001", { createdAt: old })); // stale bKash → cancel
    h.orders.set("2002", makeOrder("2002", { createdAt: old, paymentGatewayNames: ["Cash on Delivery (COD)"] })); // keep
    h.orders.set("2003", makeOrder("2003")); // fresh bKash → keep
    await h.runCron();
    expect(h.orders.get("2001")!.cancelledAt).not.toBeNull();
    expect(h.orders.get("2002")!.cancelledAt).toBeNull();
    expect(h.orders.get("2003")!.cancelledAt).toBeNull();
  });

  it("doesn't cancel a stale order whose customer started paying in the last hour", async () => {
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    h.orders.set("2001", makeOrder("2001", { createdAt: old }));
    const { paymentId } = await startPayment(h, "2001");
    h.bkash.outcome.set(paymentId, "not_completed");
    await h.runCron();
    expect(h.orders.get("2001")!.cancelledAt).toBeNull();
  });

  it("records a heartbeat on every run", async () => {
    await h.runCron();
    const row = h.db.prepare("SELECT value FROM kv WHERE key = 'cron_last_run'").get() as { value: string };
    expect(Date.now() - Date.parse(row.value)).toBeLessThan(5000);
  });

  it("AUTO_CANCEL_HOURS=0 disables auto-cancel", async () => {
    h = setup({ envOverrides: { AUTO_CANCEL_HOURS: "0" } });
    h.orders.set("2001", makeOrder("2001", { createdAt: new Date(Date.now() - 99 * 3600 * 1000).toISOString() }));
    await h.runCron();
    expect(h.orders.get("2001")!.cancelledAt).toBeNull();
    expect(h.calls.some((c) => c.op === "StaleOrders")).toBe(false);
  });
});
