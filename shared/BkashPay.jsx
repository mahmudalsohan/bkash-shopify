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
    return (
      <s-banner heading="Complete your payment with bKash" tone="warning">
        <s-stack gap="base">
          <s-paragraph>
            Your order {state.orderName} is reserved. Pay ৳{state.amount} with bKash to confirm it.
          </s-paragraph>
          <s-button variant="primary" href={state.url}>
            Pay ৳{state.amount} with bKash
          </s-button>
        </s-stack>
      </s-banner>
    );
  }

  if (state.status === 'paid') {
    return (
      <s-banner heading="bKash payment received" tone="success">
        <s-paragraph>Thank you! Your payment has been confirmed.</s-paragraph>
      </s-banner>
    );
  }

  // loading, not_applicable (paid by another method), cancelled, error → show nothing
  return null;
}
