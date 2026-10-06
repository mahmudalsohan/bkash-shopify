import {useEffect, useState} from 'preact/hooks';
import {BACKEND_URL} from './config.js';

/**
 * Shows a "Pay with bKash" button for unpaid bKash orders.
 * Renders nothing for orders that used another payment method.
 *
 * The backend decides everything (gateway, amount, paid/cancelled state) from the
 * real Shopify order — nothing sent from here is trusted except the order id.
 *
 * `hint` (Thank-you page only) lets the banner render instantly, before the backend answers:
 *   - likelyBkash: true/false from the payment method type the buyer selected, undefined if unknown
 *   - amount / orderName: shown until the backend's values arrive
 */
export function BkashPay({orderId, hint = {}}) {
  // In the checkout editor the page previews a sample/past order, which is never an unpaid
  // bKash order, so show a sample banner instead — otherwise the block looks empty.
  const inEditor = Boolean(shopify.extension?.editor);
  const skip = inEditor || hint.likelyBkash === false;
  const [state, setState] = useState({status: 'loading'});
  // Set once the customer taps Pay: bKash opens in a new tab (Shopify doesn't allow same-tab
  // navigation to other sites), so this tab watches for the payment and updates itself.
  const [waiting, setWaiting] = useState(false);

  async function fetchStatus() {
    const token = await shopify.sessionToken.get();
    const res = await fetch(`${BACKEND_URL}/api/pay-link`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({orderId}),
    });
    return res.json();
  }

  useEffect(() => {
    if (!orderId || skip) return;
    let cancelled = false;
    let rechecks = 0;
    let timer;

    async function load() {
      try {
        const data = await fetchStatus();
        if (cancelled) return;
        setState(data);
        // "pending": the order is so new that Shopify can't look it up yet. We already have a
        // working link; re-check a few times so the banner hides if it isn't a bKash order.
        if (data.status === 'pending' && rechecks++ < 5) timer = setTimeout(load, 2000);
      } catch (err) {
        console.error('bKash pay-link failed', err);
        if (!cancelled) setState({status: 'error'});
      }
    }

    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [orderId, skip]);

  // After Pay is tapped: poll every 4s (for up to 15 min) until the order is paid.
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    let cancelled = false;
    let timer;

    async function poll() {
      try {
        const data = await fetchStatus();
        if (cancelled) return;
        if (data.status === 'paid' || data.status === 'cancelled' || data.status === 'not_applicable') {
          setState(data);
          return;
        }
        // keep the latest link (it may have been refreshed) without flickering the banner
        if (data.url) setState((s) => ({...s, ...data}));
      } catch (err) {
        console.warn('bKash status poll failed', err);
      }
      if (!cancelled && Date.now() - started < 15 * 60 * 1000) timer = setTimeout(poll, 4000);
    }

    timer = setTimeout(poll, 4000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [waiting]);

  if (inEditor) {
    return <PayBanner orderName="#1001" amount="1250.00" preview />;
  }
  if (hint.likelyBkash === false) return null;

  if (state.status === 'payable' || state.status === 'pending') {
    return (
      <PayBanner
        orderName={state.orderName ?? hint.orderName}
        amount={state.amount ?? hint.amount}
        url={state.url}
        waiting={waiting}
        onPay={() => setWaiting(true)}
      />
    );
  }

  // Waiting for the backend, but we already know the buyer chose a manual payment method:
  // show the banner straight away with a loading button so customers don't leave.
  if (state.status === 'loading' && hint.likelyBkash) {
    return <PayBanner orderName={hint.orderName} amount={hint.amount} loading />;
  }

  if (state.status === 'paid') {
    return (
      <s-banner heading="Payment received · পেমেন্ট সম্পন্ন হয়েছে" tone="success">
        <s-paragraph>Thank you! Your bKash payment has been confirmed and your order is being processed.</s-paragraph>
      </s-banner>
    );
  }

  // loading (unknown method), not_applicable (paid another way), cancelled, error → show nothing
  return null;
}

/**
 * The "pay now" banner.
 * `loading`: link on its way · `preview`: checkout editor sample · `waiting`: bKash tab is open
 */
function PayBanner({orderName, amount, url, loading, preview, waiting, onPay}) {
  const taka = amount ? formatTaka(amount) : null;
  const order = orderName ? `Your order ${orderName}` : 'Your order';
  const orderBn = orderName ? `আপনার অর্ডার ${orderName}` : 'আপনার অর্ডার';
  return (
    <s-banner heading="One more step: pay with bKash · bKash দিয়ে পেমেন্ট করুন" tone="warning">
      <s-stack gap="base">
        {taka && <s-heading>Amount due: ৳{taka}</s-heading>}
        <s-paragraph>
          {order} is reserved but not confirmed yet. Tap the button below to pay with bKash.
        </s-paragraph>
        <s-paragraph>{orderBn} নিশ্চিত করতে নিচের বাটনে ট্যাপ করে bKash দিয়ে পেমেন্ট করুন।</s-paragraph>
        <s-button
          variant="primary"
          inlineSize="fill"
          href={url}
          onClick={onPay}
          loading={loading || undefined}
          disabled={!url || undefined}
        >
          {waiting ? 'Open bKash payment again' : taka ? `Pay ৳${taka} with bKash` : 'Pay with bKash'}
        </s-button>
        <s-text type="small" tone="neutral">
          {preview
            ? 'Preview: customers only see this for unpaid bKash orders.'
            : waiting
              ? 'Complete the payment in the bKash tab. This page updates automatically once it is done. · bKash ট্যাবে পেমেন্ট সম্পন্ন করুন, এই পেজটি নিজে থেকেই আপডেট হবে।'
              : "bKash's secure payment page opens in a new tab. Unpaid orders are cancelled automatically."}
        </s-text>
      </s-stack>
    </s-banner>
  );
}

/** "1250.00" → "1,250" · "1250.50" → "1,250.50" */
function formatTaka(amount) {
  const n = Number(amount);
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}
