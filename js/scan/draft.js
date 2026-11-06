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

// Every save of the Add tray tells the page how many cards the draft holds,
// as the event DRAFT_EVENT with detail {count}, so the shell can put a count
// dot on the Scan tab (plans/design-review.md: "unsaved tray cards put a
// count dot on the Scan tab"). The Trade or sale tray adds nothing to the
// collection when saved, so it is not counted there.
export const DRAFT_EVENT = 'card-tracker:scan-draft';

export function saveSession(session) {
	const copy = JSON.parse(JSON.stringify(session));
	const key = keyOf(copy);
	const next = saving.then(() => run(SESSION, 'readwrite', (store) => store.put(copy, key))).then(() => {
		if (key === CURRENT) {
			window.dispatchEvent(new CustomEvent(DRAFT_EVENT, {detail: {count: copy.items.length}}));
		}
	});

	saving = next.catch(() => {});

	return next;
}

// How many cards wait in the draft tray: 0 when there is none. Light to
// import (this file loads nothing else), for the Scan tab's count dot.
export async function draftCount() {
	try {
		const session = await loadSession();

		return session && Array.isArray(session.items) ? session.items.length : 0;
	}
	catch {
		return 0;
	}
}

export const savePhoto = (key, blob) => run(PHOTOS, 'readwrite', (store) => store.put(blob, key));

export const loadPhoto = (key) => run(PHOTOS, 'readonly', (store) => store.get(key));

export const deletePhoto = (key) => run(PHOTOS, 'readwrite', (store) => store.delete(key));

// Empties the Trade or sale tray once its move is logged (js/moves-view.js),
// unless a newer tray has taken its place (sessionId names the one handed
// over). Its photos go at the next prune.
export async function clearTrade(sessionId, emptied) {
	await saving;

	const kept = await run(SESSION, 'readonly', (store) => store.get(TRADE)).catch(() => null);

	if (kept && kept.id === sessionId) {
		await saveSession(emptied);
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
