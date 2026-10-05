import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {BkashPay} from '../../../shared/BkashPay.jsx';

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  // gid://shopify/Order/<id>
  const orderId = shopify.order.value?.id;
  return <BkashPay orderId={orderId} />;
}
