// The HOTARU orders the Shop screen shows its owner (plans/hotaru-catalog-
// plan.md, step 5): the calls to supabase/store-orders.sql. Every one is for
// the family group's owner only; the database refuses anyone else.

import {getClient} from './auth.js';

export const RECEIPT_BUCKET = 'store-receipts';

// Said on window with {count, orders} whenever the Shop screen has the open
// orders, so the header's count (js/shell.js) follows a payment, a
// delivery, or a cancel at once, and a new order rings
// (js/order-alerts.js).
export const ORDERS_EVENT = 'card-tracker-shop-orders';

export function announceOrders(orders) {
	const list = Array.isArray(orders) ? orders : [];

	window.dispatchEvent(new CustomEvent(ORDERS_EVENT, {detail: {count: list.length, orders: list}}));
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

// The cards ticked off while putting an order together (Eric, 2026-11-26:
// a checklist beside the order's cards, to confirm the right ones go out).
// Kept on this device only, as {order code: [listing IDs ticked]}; an order
// no longer open (delivered or cancelled) is forgotten at the next read of
// the orders. Without storage (a private window), the ticks last while the
// app stays open.
const CHECKS_KEY = 'cardTracker.orderChecks';
let checksHeld = {};

function readChecks() {
	try {
		const value = JSON.parse(localStorage.getItem(CHECKS_KEY));

		checksHeld = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
	}
	catch {
		// Not readable: what this visit ticked is still held.
	}

	return checksHeld;
}

function writeChecks(all) {
	checksHeld = all;

	try {
		localStorage.setItem(CHECKS_KEY, JSON.stringify(all));
	}
	catch {
		// Not kept past this visit.
	}
}

// The listing IDs ticked in one order.
export function orderChecks(code) {
	const list = readChecks()[code];

	return new Set(Array.isArray(list) ? list : []);
}

export function setOrderCheck(code, listingId, on) {
	const all = {...readChecks()};
	const ticked = orderChecks(code);

	if (on) {
		ticked.add(listingId);
	}
	else {
		ticked.delete(listingId);
	}

	if (ticked.size) {
		all[code] = [...ticked];
	}
	else {
		delete all[code];
	}

	writeChecks(all);
}

// Forgets the ticks of every order not among the open ones.
export function keepOrderChecks(openCodes) {
	const all = readChecks();
	const open = new Set(openCodes);
	const kept = Object.fromEntries(Object.entries(all).filter(([code]) => open.has(code)));

	if (Object.keys(kept).length !== Object.keys(all).length) {
		writeChecks(kept);
	}
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
