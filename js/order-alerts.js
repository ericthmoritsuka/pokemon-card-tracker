// New-order alerts (Eric, 2026-11-26: a HOTARU sale showed up in the Shop,
// but nothing told him one had come). Each time the open orders are read
// (js/shell.js every minute, and the Shop screen), the codes are compared
// with the ones already seen on this phone: a new order, or a receipt sent
// for one, shows a toast, plays a short chime, and, once Eric allows it, a
// Chrome notification that opens the Shop's Orders tab.
//
// It works while the Card Tracker is open, in front or in a tab behind
// others on the computer. A phone with the app closed or in the background
// runs no code, so it hears nothing until the app comes back; that would
// need Web Push from the server, which Eric did not want (2026-11-26).
//
// The first read on a phone only remembers what is open, so turning the
// feature on, or a new phone, never rings for old orders.

import {currentUser} from './auth.js';
import {BASE, go} from './dom.js';
import {formatCount, plural} from './format.js';
import {setShopTab} from './shop-owner.js';

const ON_KEY = 'cardTracker.orderAlerts';
const SEEN_KEY = 'cardTracker.orderAlerts.seen';

// Said on window with {orders, receipts} (the order records) when a read
// finds something new, so an open Shop reads its orders again.
export const NEW_ORDERS_EVENT = 'card-tracker-new-orders';

// The address a notification opens.
export const ORDERS_URL = `${BASE}shop?tab=orders`;

function readJson(key, fallback) {
	try {
		const value = JSON.parse(localStorage.getItem(key));

		return value === null || value === undefined ? fallback : value;
	}
	catch {
		return fallback;
	}
}

function writeJson(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	}
	catch {
		// Not kept: the next read compares with what this visit saw.
	}
}

// Whether the chime and the notification are on for this phone. Off until
// Eric turns them on in the Orders tab, because the browser lets a page
// ask to notify, and start its sound, only from a tap.
export function alertsOn() {
	return readJson(ON_KEY, false) === true;
}

// What the browser lets this page do: 'granted', 'denied', 'default', or
// 'unsupported'.
export function notifyPermission() {
	return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

// -------------------------------------------------------------- the diff

// Pure: what is new in `orders` against `seen` ({orders: [code], receipts:
// [code]}, or null on a phone that never read them). Returns the new
// orders, the orders whose receipt is new, and what to remember. A receipt
// on an order seen for the first time is part of that order's alert, not a
// second one. Codes of orders no longer open are forgotten: a code is never
// used again.
export function diffOrders(orders, seen) {
	const open = Array.isArray(orders) ? orders.filter((order) => order && order.code) : [];
	const next = {
		orders: open.map((order) => order.code),
		receipts: open.filter((order) => order.receipt_path).map((order) => order.code),
	};

	if (!seen || !Array.isArray(seen.orders)) {
		return {fresh: [], receipts: [], seen: next};
	}

	const knownOrders = new Set(seen.orders);
	const knownReceipts = new Set(Array.isArray(seen.receipts) ? seen.receipts : []);
	const fresh = open.filter((order) => !knownOrders.has(order.code));
	const receipts = open.filter((order) => order.receipt_path && knownOrders.has(order.code) && !knownReceipts.has(order.code));

	return {fresh, receipts, seen: next};
}

const BRL = new Intl.NumberFormat('pt-BR', {currency: 'BRL', style: 'currency'});

const brl = (value) => (Number.isFinite(Number(value)) ? BRL.format(Number(value)) : null);

// Pure: the words of one alert. One order names its code, buyer, and
// total; several are counted.
export function alertText({fresh, receipts}, money = brl) {
	const lines = [];

	if (fresh.length === 1) {
		const [order] = fresh;
		const cards = Array.isArray(order.items) ? order.items.length : 0;

		lines.push(`New order ${order.code} from ${order.name}: ${[cards ? plural(cards, 'item', 'items') : null, money(order.total)].filter(Boolean).join(', ')}`);
	}
	else if (fresh.length > 1) {
		lines.push(`${formatCount(fresh.length)} new orders: ${fresh.map((order) => order.code).join(', ')}`);
	}

	if (receipts.length === 1) {
		lines.push(`${receipts[0].name} sent the receipt for ${receipts[0].code}`);
	}
	else if (receipts.length > 1) {
		lines.push(`Receipts sent for ${receipts.map((order) => order.code).join(', ')}`);
	}

	return {
		body: lines.slice(1).join('\n'),
		title: lines[0] || '',
		whole: lines.join('. '),
	};
}

// ------------------------------------------------------------- the sound

let audio = null;

function audioContext() {
	const Context = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);

	if (!Context) {
		return null;
	}

	if (!audio) {
		try {
			audio = new Context();
		}
		catch {
			return null;
		}
	}

	return audio;
}

// Starts the sound while a tap counts. The browser keeps it allowed for
// the rest of the visit, so a chime can play later from the timer.
export function unlockSound() {
	const context = audioContext();

	if (context && context.state === 'suspended') {
		context.resume().catch(() => {});
	}
}

// Two short rising notes, made here so there is no file to fetch or cache.
export function chime() {
	const context = audioContext();

	if (!context || context.state !== 'running') {
		return false;
	}

	const start = context.currentTime + 0.02;

	[[880, 0], [1318.5, 0.16]].forEach(([frequency, offset]) => {
		const tone = context.createOscillator();
		const gain = context.createGain();
		const at = start + offset;

		tone.type = 'sine';
		tone.frequency.value = frequency;
		gain.gain.setValueAtTime(0.0001, at);
		gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
		tone.connect(gain).connect(context.destination);
		tone.start(at);
		tone.stop(at + 0.4);
	});

	return true;
}

// ------------------------------------------------------ the notification

// Through the service worker, the only way Chrome on Android shows one;
// the page's own Notification where there is no worker.
async function notify({body, title}, tag) {
	if (notifyPermission() !== 'granted') {
		return false;
	}

	const options = {body, data: {url: ORDERS_URL}, icon: `${BASE}icons/icon-192.png`, renotify: true, tag};

	try {
		const registration = navigator.serviceWorker ? await navigator.serviceWorker.getRegistration(BASE) : null;

		if (registration) {
			await registration.showNotification(title, options);

			return true;
		}

		const shown = new Notification(title, options);

		shown.onclick = () => {
			window.focus();
			openOrdersTab();
			shown.close();
		};

		return true;
	}
	catch {
		return false;
	}
}

// ------------------------------------------------------------- switching

// The tap on Turn on alerts: starts the sound, asks to notify, and plays
// the chime so Eric hears what it sounds like. Resolves the permission.
export async function turnOn() {
	unlockSound();
	writeJson(ON_KEY, true);

	let permission = notifyPermission();

	if (permission === 'default') {
		try {
			permission = await Notification.requestPermission();
		}
		catch {
			permission = notifyPermission();
		}
	}

	setTimeout(chime, 150);

	return permission;
}

export function turnOff() {
	writeJson(ON_KEY, false);
}

// Opens the Shop on its Orders tab, from a notification or a toast.
export function openOrdersTab() {
	setShopTab('orders');
	go('shop');
}

// ---------------------------------------------------------- the checking

function seenFor(userId) {
	const all = readJson(SEEN_KEY, {});

	return all && typeof all === 'object' && !Array.isArray(all) ? (all[userId] || null) : null;
}

function keepSeen(userId, seen) {
	const all = readJson(SEEN_KEY, {});

	writeJson(SEEN_KEY, {...(all && typeof all === 'object' && !Array.isArray(all) ? all : {}), [userId]: seen});
}

// Compares a fresh read of the open orders with what this phone has seen,
// and alerts on anything new. Returns the diff.
export function checkOrders(orders, {toast} = {}) {
	const user = currentUser();

	if (!user || !Array.isArray(orders)) {
		return null;
	}

	const found = diffOrders(orders, seenFor(user.id));

	keepSeen(user.id, found.seen);

	if (!found.fresh.length && !found.receipts.length) {
		return found;
	}

	const text = alertText(found);

	window.dispatchEvent(new CustomEvent(NEW_ORDERS_EVENT, {detail: {orders: found.fresh, receipts: found.receipts}}));

	if (toast) {
		toast(text.whole, {action: openOrdersTab, actionLabel: 'Open', key: 'new-order', timeout: 0});
	}

	if (alertsOn()) {
		chime();
		notify(text, `order-${[...found.fresh, ...found.receipts].map((order) => order.code).join('-')}`);
	}

	return found;
}

// Keeps the sound allowed: the first tap of each visit starts it again, as
// a reload ends what the Turn on tap allowed.
if (typeof document !== 'undefined') {
	document.addEventListener('pointerdown', () => {
		if (alertsOn()) {
			unlockSound();
		}
	}, {capture: true, passive: true});
}
