import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {BkashPay} from '../../../shared/BkashPay.jsx';

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  // gid://shopify/OrderIdentity/<id> — the numeric part is the Shopify order id
  const confirmation = shopify.orderConfirmation.value;

  // The custom "bKash" method is a `manualPayment`; Cash on Delivery is `paymentOnDelivery`,
  // cards are `creditCard`, etc. Knowing this up front lets the banner appear instantly.
  // (An empty list means "unknown" — then we just wait for the backend.)
  const selected = shopify.selectedPaymentOptions.value ?? [];
  const likelyBkash = selected.length ? selected.some((o) => o.type === 'manualPayment') : undefined;

  const hint = {
    likelyBkash,
    amount: shopify.cost.totalAmount.value?.amount,
    orderName: confirmation?.number ? `#${confirmation.number}` : undefined,
  };

  return <BkashPay orderId={confirmation?.order?.id} hint={hint} />;
}
