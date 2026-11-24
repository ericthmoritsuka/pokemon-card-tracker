// The HOTARU orders the Shop screen shows its owner (plans/hotaru-catalog-
// plan.md, step 5): the calls to supabase/store-orders.sql. Every one is for
// the family group's owner only; the database refuses anyone else.

import {getClient} from './auth.js';

export const RECEIPT_BUCKET = 'store-receipts';

// Said on window with {count} whenever the Shop screen has the open orders,
// so the header's count (js/shell.js) follows a payment, a delivery, or a
// cancel at once.
export const ORDERS_EVENT = 'card-tracker-shop-orders';

export function announceOrders(count) {
	window.dispatchEvent(new CustomEvent(ORDERS_EVENT, {detail: {count}}));
}

async function call(name, args = {}) {
	const client = await getClient();
	const {data, error} = await client.rpc(name, args);

	if (error) {
		throw error;
	}

	return data;
}

// Every order waiting for payment and every paid one not handed over yet,
// oldest first, each with its cards.
export async function openOrders() {
	const data = await call('store_orders_open');

	return Array.isArray(data) ? data : [];
}

export const markPaid = (code) => call('mark_paid', {order_code: code});

export const markDelivered = (code) => call('mark_delivered', {order_code: code});

export const cancelOrder = (code) => call('cancel_order', {order_code: code});

// A link to the buyer's receipt that works for five minutes.
export async function receiptLink(path) {
	const client = await getClient();
	const {data, error} = await client.storage.from(RECEIPT_BUCKET).createSignedUrl(path, 300);

	if (error) {
		throw error;
	}

	return data.signedUrl;
}

// Why an order call failed, for the Shop screen.
export function orderErrorText(error) {
	const code = error && error.code;
	const message = String((error && error.message) || '');

	if (code === 'PGRST202' || code === '42883' || /store_orders_open|mark_paid/.test(message)) {
		return 'Orders are not set up yet: run supabase/store-orders.sql in the Supabase SQL Editor.';
	}

	return message || 'The server did not answer.';
}
