// Live integration tests against the real bKash SANDBOX (Shopify is still faked).
// Run with:  npm run test:sandbox     (reads credentials from worker/.dev.vars)
//
// The sandbox can't approve a payment without a human entering wallet/OTP/PIN on the
// bKash page, so these cover everything up to that point plus all the "customer did
// not pay" paths. The happy path is covered by the manual end-to-end test in the README.
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callback, makeOrder, setup, startPayment } from "./helpers";

const devVars = new URL("../.dev.vars", import.meta.url);
const vars: Record<string, string> = existsSync(devVars)
  ? Object.fromEntries(
      readFileSync(devVars, "utf8")
        .split("\n")
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
    )
  : {};

const enabled = process.env.BKASH_SANDBOX === "1" && !!vars.BKASH_APP_KEY;

let sharedToken: string | undefined;

describe.runIf(enabled)("bKash sandbox (live)", { timeout: 30_000 }, () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup({
      live: true,
      envOverrides: {
        // bKash validates the callback domain, so use the real deployed Worker URL
        PUBLIC_URL: "https://bkash-shopify.comfiqbd.workers.dev",
        BKASH_APP_KEY: vars.BKASH_APP_KEY,
        BKASH_APP_SECRET: vars.BKASH_APP_SECRET,
        BKASH_USERNAME: vars.BKASH_USERNAME,
        BKASH_PASSWORD: vars.BKASH_PASSWORD,
      },
    });
    h.orders.set("5001", makeOrder("5001", { outstanding: "10.00" }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // bKash rate-limits token grants (HTTP 429), so share one token across tests,
    // exactly like the Worker does in production via its D1 cache.
    if (sharedToken) {
      h.db.prepare("INSERT INTO kv (key, value, expires_at) VALUES ('bkash_id_token', ?, ?)").run(sharedToken, 4102444800);
    }
  });
  afterEach(() => {
    const row = h.db.prepare("SELECT value FROM kv WHERE key = 'bkash_id_token'").get() as { value: string } | undefined;
    sharedToken ??= row?.value;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("grants a token, creates a payment and redirects to a working bKash checkout page", async () => {
    const { paymentId, bkashURL } = await startPayment(h, "5001");
    expect(paymentId).toBeTruthy();
    expect(new URL(bkashURL).hostname).toMatch(/(bkash\.com|bka\.sh)$/);

    const page = await fetch(bkashURL);
    expect(page.status).toBe(200);
    expect(h.payment(paymentId)).toMatchObject({ status: "initiated", amount: "10.00" });
  });

  it("reuses the cached bKash token across payments", async () => {
    await startPayment(h, "5001");
    await startPayment(h, "5001");
    expect(h.calls.filter((c) => c.op === "token/grant")).toHaveLength(0); // seeded from the first test
    expect(h.calls.filter((c) => c.op === "checkout/create")).toHaveLength(2);
  });

  it("reports a freshly created payment as Initiated", async () => {
    const { paymentId } = await startPayment(h, "5001");
    const res = await fetch(`${h.env.BKASH_BASE_URL}/tokenized/checkout/payment/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: h.calls.find((c) => c.op === "checkout/create")!.headers.authorization,
        "X-App-Key": h.env.BKASH_APP_KEY,
      },
      body: JSON.stringify({ paymentID: paymentId }),
    });
    const body: any = await res.json();
    expect(body.transactionStatus).toBe("Initiated");
    expect(Number(body.amount)).toBe(10);
  });

  it("a forged status=success for an unpaid payment is rejected by bKash → failed, order untouched", async () => {
    const { paymentId } = await startPayment(h, "5001");
    const page = await (await callback(h, paymentId, "success")).text();
    expect(page).toContain("<h1>Payment not completed</h1>");
    expect(h.payment(paymentId).status).toBe("failed");
    expect(h.orders.get("5001")!.displayFinancialStatus).toBe("PENDING");
    expect(h.calls.some((c) => c.op === "MarkPaid")).toBe(false);
  });

  it("cancel and failure callbacks don't touch bKash or the order", async () => {
    const a = await startPayment(h, "5001");
    const b = await startPayment(h, "5001");
    expect(await (await callback(h, a.paymentId, "cancel")).text()).toContain("Payment cancelled");
    expect(await (await callback(h, b.paymentId, "failure")).text()).toContain("Payment failed");
    expect(h.payment(a.paymentId).status).toBe("cancelled");
    expect(h.payment(b.paymentId).status).toBe("failed");
    expect(h.calls.some((c) => c.op === "checkout/execute")).toBe(false);
  });

  it("cron reconciliation of an abandoned payment: keeps it, then expires it after 2h", async () => {
    const { paymentId } = await startPayment(h, "5001");
    h.ageRow(paymentId, 15 * 60);
    await h.runCron();
    expect(h.payment(paymentId).status).toBe("initiated");

    h.ageRow(paymentId, 2 * 3600);
    await h.runCron();
    expect(h.payment(paymentId).status).toBe("failed");
  });
});
