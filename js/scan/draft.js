// The tray as a draft in IndexedDB, so closing the app (or the phone killing
// it) keeps every scanned card until the session is saved or discarded.
//
// Its own database, apart from the person's document: a draft is not
// ownership, is never synced, and goes when the session is saved.
//   session   the current session (js/scan/session.js), key "current", and
//             the Trade or sale tray (js/scan/trade.js), key "trade", so
//             switching modes keeps each tray as it was
//   photos    each tray card's photo as a JPEG Blob, key "<item id>", and
//             the full-size card for a re-read, key "<item id>:full"

const DB_NAME = 'card-tracker-scan';
const VERSION = 1;
const SESSION = 'session';
const PHOTOS = 'photos';
const CURRENT = 'current';
const TRADE = 'trade';

const keyOf = (session) => (session && session.mode === 'trade' ? TRADE : CURRENT);

let dbPromise = null;

function openDb() {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			if (!('indexedDB' in window)) {
				reject(new Error('IndexedDB is not available.'));

				return;
			}

			const request = indexedDB.open(DB_NAME, VERSION);

			request.onupgradeneeded = () => {
				for (const name of [SESSION, PHOTOS]) {
					if (!request.result.objectStoreNames.contains(name)) {
						request.result.createObjectStore(name);
					}
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		}).catch((err) => {
			dbPromise = null;

			throw err;
		});
	}

	return dbPromise;
}

async function run(storeName, mode, op) {
	const db = await openDb();

	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, mode);
		const request = op(tx.objectStore(storeName));

		tx.oncomplete = () => resolve(request && request.result);
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

// The Add tray, or with mode 'trade' the Trade or sale tray.
export const loadSession = (mode = 'add') => run(SESSION, 'readonly', (store) => store.get(mode === 'trade' ? TRADE : CURRENT));

// Saves are serialized, so a later state never lands before an earlier one.
let saving = Promise.resolve();

// Every save of the Add tray tells the page what the draft holds, as the
// event DRAFT_EVENT with detail {count, page} (draftWaiting), so the shell
// can put a count dot on the Scan tab (plans/design-review.md: "unsaved tray
// cards put a count dot on the Scan tab"). The Trade or sale tray adds
// nothing to the collection when saved, so it is not counted there.
export const DRAFT_EVENT = 'card-tracker:scan-draft';

// What waits in a tray: count, its cards; page, the cards of a binder page
// marked Already mine and not placed yet (view.js setPageMine), which are
// held on the page read, out of the tray (a review, 2026-11-20: the dot
// counted the tray alone, so Scan looked empty while a page waited).
export function draftWaiting(session) {
	const count = session && Array.isArray(session.items) ? session.items.length : 0;
	const run = session && session.pageRun;
	const page = run && run.mine && Array.isArray(run.held) ? run.held.length : 0;

	return {count, page};
}

export function saveSession(session) {
	const copy = JSON.parse(JSON.stringify(session));
	const key = keyOf(copy);
	const next = saving.then(() => run(SESSION, 'readwrite', (store) => store.put(copy, key))).then(() => {
		if (key === CURRENT) {
			window.dispatchEvent(new CustomEvent(DRAFT_EVENT, {detail: draftWaiting(copy)}));
		}
	});

	saving = next.catch(() => {});

	return next;
}

// Settles once every save asked for so far has landed or failed, so a
// reload for a new version waits for the tray's last save (js/auto-update.js).
export const draftSaved = () => saving;

// What waits in the draft tray (draftWaiting): {count: 0, page: 0} when
// there is none. Light to import (this file loads nothing else), for the
// Scan tab's count dot.
export async function draftCount() {
	try {
		return draftWaiting(await loadSession());
	}
	catch {
		return draftWaiting(null);
	}
}

export const savePhoto = (key, blob) => run(PHOTOS, 'readwrite', (store) => store.put(blob, key));

export const loadPhoto = (key) => run(PHOTOS, 'readonly', (store) => store.get(key));

export const deletePhoto = (key) => run(PHOTOS, 'readwrite', (store) => store.delete(key));

// Takes the cards a logged move saved out of the Trade or sale tray
// (js/moves-view.js): of the sides it saved ({out, in}, each true or
// false), only the cards handed over (handed: {out, in}, the item ids each
// side held when Log it was tapped, js/scan/trade.js tradeHandoff), never
// a whole side, so a card scanned after Log it stays. Nothing goes when a
// newer tray has taken its place (sessionId names the one handed over). A
// side the move's kind left out (a sale's cards coming in) stays for
// another move. The photos of the cards taken out go at the next prune.
export async function clearTrade(sessionId, sides = {in: true, out: true}, handed = {in: [], out: []}) {
	await saving;

	const kept = await run(SESSION, 'readonly', (store) => store.get(TRADE)).catch(() => null);

	if (kept && kept.id === sessionId) {
		const side = (item) => (item.side === 'in' ? 'in' : 'out');
		const saved = (item) => Boolean(sides[side(item)]) && ((handed && handed[side(item)]) || []).includes(item.id);

		await saveSession({...kept, items: kept.items.filter((item) => !saved(item)), updated_at: new Date().toISOString()});
	}
}

// Takes the cards a logged purchase saved out of the Add tray (Buy, or Log
// as a purchase; Eric, 2026-11-19): only the cards handed over (the item
// ids the tray held when it was handed over, js/scan/trade.js
// purchaseHandoff), so a card scanned since stays, and nothing when a newer
// tray has taken its place (sessionId names the one handed over). The
// photos of the cards taken out go at the next prune.
export async function clearPurchase(sessionId, handed = []) {
	await saving;

	const kept = await run(SESSION, 'readonly', (store) => store.get(CURRENT)).catch(() => null);

	if (kept && kept.id === sessionId) {
		const gone = new Set(handed);

		await saveSession({...kept, items: kept.items.filter((item) => !gone.has(item.id)), updated_at: new Date().toISOString()});
	}
}

// Deletes every photo whose item is in neither tray: `keepIds` (the tray on
// the screen, which may be ahead of its draft) and both trays kept here.
export async function prunePhotos(keepIds) {
	await saving;

	const kept = await Promise.all([CURRENT, TRADE].map((key) => run(SESSION, 'readonly', (store) => store.get(key)).catch(() => null)));
	const keep = new Set([...keepIds, ...kept.flatMap((one) => (one && Array.isArray(one.items) ? one.items.map((item) => item.id) : []))]);
	const keys = await run(PHOTOS, 'readonly', (store) => store.getAllKeys());

	await Promise.all((keys || [])
		.filter((key) => !keep.has(String(key).split(':')[0]))
		.map((key) => deletePhoto(key)));
}
