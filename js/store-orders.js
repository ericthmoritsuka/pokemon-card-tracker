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

// The orders handed over lately, newest first, each with its cards and
// delivered_at (supabase/store-order-stages.sql; Eric, 2026-11-26: a
// Delivered tab, to see which orders already happened; the full history is
// the sales in Trades).
export const DELIVERED_DAYS = 30;

export async function deliveredOrders(days = DELIVERED_DAYS) {
	const data = await call('store_orders_delivered', {days});

	return Array.isArray(data) ? data : [];
}

// The cards ticked off while putting an order together (Eric, 2026-11-26:
// a checklist beside the order's cards, to confirm the right ones go out).
// v122 keeps them on the server (store_order_items.checked_at, through
// store_order_checks and set_order_check), so the phone and the computer
// agree on which orders are still being separated and which are ready.
//
// This device keeps two things in localStorage: what it last knew,
// {order code: [listing IDs ticked]}, so the boxes draw at once and offline;
// and the ticks not on the server yet, [{code, listing_id, on}], sent in
// order and dropped once the server takes them or refuses them for good (an
// order no longer open, a card not in it). Until store-order-stages.sql is
// run, every tick waits on this device, as in v119. Without storage (a
// private window), both last while the app stays open.
const CHECKS_KEY = 'cardTracker.orderChecks';
const QUEUE_KEY = 'cardTracker.orderChecksQueue';
// Set once this device's v119 ticks have joined the queue, so they reach
// the server once.
const MOVED_KEY = 'cardTracker.orderChecksMoved';
let checksHeld = {};
let queueHeld = [];
let movedHeld = false;

function readStored(key, fallback, valid) {
	try {
		const value = JSON.parse(localStorage.getItem(key));

		return valid(value) ? value : fallback;
	}
	catch {
		return null;
	}
}

function store(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	}
	catch {
		// Not kept past this visit.
	}
}

const isMap = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function readChecks() {
	const value = readStored(CHECKS_KEY, {}, isMap);

	// Not readable: what this visit ticked is still held.
	if (value) {
		checksHeld = value;
	}

	return checksHeld;
}

function writeChecks(all) {
	checksHeld = all;
	store(CHECKS_KEY, all);
}

const isTick = (entry) => isMap(entry) && typeof entry.code === 'string' && typeof entry.listing_id === 'string' && typeof entry.on === 'boolean';

function readQueue() {
	const value = readStored(QUEUE_KEY, [], Array.isArray);

	if (value) {
		queueHeld = value.filter(isTick);
	}

	return queueHeld;
}

function writeQueue(list) {
	queueHeld = list;
	store(QUEUE_KEY, list);
}

// One entry per card: a later tick replaces a waiting one.
function enqueue(code, listingId, on) {
	writeQueue([...readQueue().filter((entry) => entry.code !== code || entry.listing_id !== listingId), {code, listing_id: listingId, on}]);
}

function applyTick(all, code, listingId, on) {
	const ticked = new Set(Array.isArray(all[code]) ? all[code] : []);

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

	return all;
}

// The listing IDs ticked in one order.
export function orderChecks(code) {
	const list = readChecks()[code];

	return new Set(Array.isArray(list) ? list : []);
}

// How many of one order's ticks are kept only on this device because the
// server could not take them yet, so the other devices do not see them.
export function unsavedChecks(code) {
	return stalled ? readQueue().filter((entry) => entry.code === code).length : 0;
}

// Ticks made since a read of the server began, laid over its answer, so a
// tick sent while the read was on its way is not undone.
let ticksDuring = null;

export function setOrderCheck(code, listingId, on) {
	writeChecks(applyTick({...readChecks()}, code, listingId, on));
	enqueue(code, listingId, on);

	if (ticksDuring) {
		ticksDuring.push({code, listing_id: listingId, on});
	}

	sendChecks();
}

// The server refuses this tick for good: the order is no longer open, or
// the card is not in it. Any other failure (no connection,
// store-order-stages.sql not run yet) leaves the ticks waiting.
const refused = (error) => Boolean(error) && (error.code === '22023' || error.code === 'P0002');

// Said on window with {refused: [{code, listing_id, on, message}]} once a
// run of sends ends, so the Shop redraws what is not saved yet and says
// which ticks the server refused (Eric, 2026-11-27: ticks made on one
// computer never reached the phone, and nothing said so).
export const ORDER_CHECKS_EVENT = 'card-tracker-order-checks';

let sending = null;
// True while ticks wait because the last try to send them failed; a tick
// on its way is not counted, so the line does not flicker on every tap.
let stalled = false;
let refusedHeld = [];

// Sends the waiting ticks, oldest first. True once the queue is empty;
// false when the server could not take one, which waits for the next try.
// A refused tick is undone here, unless the card was ticked the other way
// since, and is told to the Shop rather than dropped in silence.
async function drainChecks() {
	while (readQueue().length && navigator.onLine) {
		const entry = readQueue()[0];

		try {
			await call('set_order_check', {checked: entry.on, listing: entry.listing_id, order_code: entry.code});
		}
		catch (err) {
			if (!refused(err)) {
				return false;
			}

			const later = readQueue().some((each) => each.code === entry.code && each.listing_id === entry.listing_id && each.on !== entry.on);

			if (!later) {
				writeChecks(applyTick({...readChecks()}, entry.code, entry.listing_id, !entry.on));
			}

			refusedHeld.push({...entry, message: String(err.message || '')});
		}

		// Dropped unless the card was ticked the other way while this went.
		writeQueue(readQueue().filter((each) => !(each.code === entry.code && each.listing_id === entry.listing_id && each.on === entry.on)));
	}

	return !readQueue().length;
}

// One run at a time: a tick made during a run is sent by it, or by the run
// that follows when it came in as the run ended.
export function sendChecks() {
	if (!sending) {
		sending = drainChecks()
			.catch(() => false)
			.then((done) => {
				sending = null;

				if (done && readQueue().length) {
					return sendChecks();
				}

				stalled = !done && readQueue().length > 0;

				const refusedNow = refusedHeld;

				refusedHeld = [];
				window.dispatchEvent(new CustomEvent(ORDER_CHECKS_EVENT, {detail: {refused: refusedNow}}));

				return done;
			});
	}

	return sending;
}

// Reads every open order's ticks from the server, after sending this
// device's, and keeps them here. True when the server answered; false when
// it could not (offline, or store-order-stages.sql not run yet), and the
// ticks this device knows stay. Never throws.
export async function syncOrderChecks() {
	if (!movedHeld) {
		const moved = readStored(MOVED_KEY, false, (value) => value === true);

		if (!moved) {
			const waiting = new Set(readQueue().map((entry) => `${entry.code}\u0000${entry.listing_id}`));

			for (const [code, list] of Object.entries(readChecks())) {
				for (const listingId of Array.isArray(list) ? list : []) {
					if (!waiting.has(`${code}\u0000${listingId}`)) {
						enqueue(code, listingId, true);
					}
				}
			}

			store(MOVED_KEY, true);
		}

		movedHeld = true;
	}

	try {
		await sendChecks();
		ticksDuring = [];

		const data = await call('store_order_checks');
		const all = isMap(data) ? Object.fromEntries(Object.entries(data).filter(([, list]) => Array.isArray(list))) : {};

		for (const entry of [...readQueue(), ...ticksDuring]) {
			applyTick(all, entry.code, entry.listing_id, entry.on);
		}

		writeChecks(all);

		return true;
	}
	catch {
		// Offline, a server error, or the script not run: the next read of
		// the orders tries again.
		return false;
	}
	finally {
		ticksDuring = null;
	}
}

// Forgets the ticks of every order not among the open ones, the waiting
// ones too.
export function keepOrderChecks(openCodes) {
	const all = readChecks();
	const open = new Set(openCodes);
	const kept = Object.fromEntries(Object.entries(all).filter(([code]) => open.has(code)));

	if (Object.keys(kept).length !== Object.keys(all).length) {
		writeChecks(kept);
	}

	const queue = readQueue();
	const waiting = queue.filter((entry) => open.has(entry.code));

	if (waiting.length !== queue.length) {
		writeQueue(waiting);
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

// Why the delivered orders could not be read, for the Delivered filter.
export function deliveredErrorText(error) {
	const code = error && error.code;
	const message = String((error && error.message) || '');

	if (code === 'PGRST202' || code === '42883' || /store_orders_delivered/.test(message)) {
		return 'Delivered orders show once supabase/store-order-stages.sql is run in the Supabase SQL Editor.';
	}

	return `Delivered orders could not be read. ${message || 'The server did not answer.'}`;
}
