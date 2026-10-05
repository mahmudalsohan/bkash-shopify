import {useEffect, useState} from 'preact/hooks';
import {BACKEND_URL} from './config.js';

/**
 * Shows a "Pay with bKash" button for unpaid bKash orders.
 * Renders nothing for orders that used another payment method.
 *
 * The backend decides everything (gateway, amount, paid/cancelled state) from the
 * real Shopify order — nothing sent from here is trusted except the order id.
 */
export function BkashPay({orderId}) {
  // In the checkout editor the page previews a sample/past order, which is never an unpaid
  // bKash order, so show a sample banner instead — otherwise the block looks empty.
  const inEditor = Boolean(shopify.extension?.editor);
  const [state, setState] = useState({status: 'loading'});

  useEffect(() => {
    if (!orderId || inEditor) return;
    let cancelled = false;
    let attempts = 0;
    let timer;

    async function load() {
      try {
        const token = await shopify.sessionToken.get();
        const res = await fetch(`${BACKEND_URL}/api/pay-link`, {
          method: 'POST',
          headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
          body: JSON.stringify({orderId}),
        });
        // Right after checkout the order can take a few seconds to become visible in the Admin API.
        if (res.status === 404 && attempts++ < 6) {
          timer = setTimeout(load, 2500);
          return;
        }
        const data = await res.json();
        if (!cancelled) setState(data);
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
  }, [orderId, inEditor]);

  if (inEditor) {
    return <PayBanner orderName="#1001" amount="1250.00" />;
  }

  if (state.status === 'payable') {
    return <PayBanner orderName={state.orderName} amount={state.amount} url={state.url} />;
  }

  if (state.status === 'paid') {
    return (
      <s-banner heading="Payment received · পেমেন্ট সম্পন্ন হয়েছে" tone="success">
        <s-paragraph>Thank you! Your bKash payment has been confirmed and your order is being processed.</s-paragraph>
      </s-banner>
    );
  }

  // loading, not_applicable (paid by another method), cancelled, error → show nothing
  return null;
}

/** The "pay now" banner. Without a `url` (editor preview) the button is shown disabled. */
function PayBanner({orderName, amount, url}) {
  const taka = formatTaka(amount);
  return (
    <s-banner heading="One more step: pay with bKash · bKash দিয়ে পেমেন্ট করুন" tone="warning">
      <s-stack gap="base">
        <s-heading>Amount due: ৳{taka}</s-heading>
        <s-paragraph>
          Your order {orderName} is reserved but not confirmed yet. Tap the button below to pay with bKash.
        </s-paragraph>
        <s-paragraph>
          আপনার অর্ডার {orderName} নিশ্চিত করতে নিচের বাটনে ট্যাপ করে bKash দিয়ে পেমেন্ট করুন।
        </s-paragraph>
        <s-button variant="primary" inlineSize="fill" href={url} disabled={!url}>
          Pay ৳{taka} with bKash
        </s-button>
        <s-text type="small" tone="neutral">
          {url
            ? "You'll be taken to bKash's secure payment page. Unpaid orders are cancelled automatically."
            : 'Preview: customers only see this for unpaid bKash orders.'}
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
