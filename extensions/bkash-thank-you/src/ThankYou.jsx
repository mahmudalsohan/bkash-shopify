import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {BkashPay} from '../../../shared/BkashPay.jsx';

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  // gid://shopify/OrderIdentity/<id> — the numeric part is the Shopify order id
  const orderId = shopify.orderConfirmation.value?.order?.id;
  return <BkashPay orderId={orderId} />;
}
