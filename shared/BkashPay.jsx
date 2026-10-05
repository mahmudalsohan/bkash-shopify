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
  const [state, setState] = useState({status: 'loading'});

  useEffect(() => {
    if (!orderId) return;
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
  }, [orderId]);

  if (state.status === 'payable') {
    const amount = formatTaka(state.amount);
    return (
      <s-banner heading="One more step: pay with bKash · bKash দিয়ে পেমেন্ট করুন" tone="warning">
        <s-stack gap="base">
          <s-heading>Amount due: ৳{amount}</s-heading>
          <s-paragraph>
            Your order {state.orderName} is reserved but not confirmed yet. Tap the button below to pay with bKash.
          </s-paragraph>
          <s-paragraph>
            আপনার অর্ডার {state.orderName} নিশ্চিত করতে নিচের বাটনে ট্যাপ করে bKash দিয়ে পেমেন্ট করুন।
          </s-paragraph>
          <s-button variant="primary" inlineSize="fill" href={state.url}>
            Pay ৳{amount} with bKash
          </s-button>
          <s-text type="small" tone="neutral">
            You'll be taken to bKash's secure payment page. Unpaid orders are cancelled automatically.
          </s-text>
        </s-stack>
      </s-banner>
    );
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

/** "1250.00" → "1,250" · "1250.50" → "1,250.50" */
function formatTaka(amount) {
  const n = Number(amount);
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}
