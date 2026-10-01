// Catalog data from TCGdex, with every response kept in IndexedDB.
//
// Reads are stale-while-revalidate: a response already on the phone is
// returned at once, and a fresh copy is fetched behind it (at most once an
// hour per key). A set opened once therefore opens again with no signal.

const API = 'https://api.tcgdex.net/v2/';

export const LANGUAGES = [
	{code: 'en', label: 'English'},
	{code: 'pt', label: 'Portuguese'},
	{code: 'fr', label: 'French'},
	{code: 'ja', label: 'Japanese'},
	{code: 'ko', label: 'Korean'},
	{code: 'zh-cn', label: 'Chinese (Simplified)'},
	{code: 'zh-tw', label: 'Chinese (Traditional)'},
];

export const isLanguage = (code) => LANGUAGES.some((lang) => lang.code === code);

export const languageLabel = (code) => (LANGUAGES.find((lang) => lang.code === code) || {label: code}).label;

const VIEWING_KEY = 'cardTracker.viewingLanguage';

export function viewingLanguage() {
	try {
		const saved = localStorage.getItem(VIEWING_KEY);

		return isLanguage(saved) ? saved : 'en';
	}
	catch {
		return 'en';
	}
}

export function setViewingLanguage(code) {
	try {
		localStorage.setItem(VIEWING_KEY, code);
	}
	catch {
		// The choice lasts for this visit only.
	}
}

// "001" before "010", and "TG2" before "TG10".
const collator = new Intl.Collator('en', {numeric: true, sensitivity: 'base'});

export const compareNumbers = (a, b) => collator.compare(String(a), String(b));

// ------------------------------------------------------------ IndexedDB

const DB_NAME = 'card-tracker-catalog';
const STORE = 'responses';
const REVALIDATE_AFTER_MS = 60 * 60 * 1000;

let dbPromise = null;

function openDb() {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			if (!('indexedDB' in window)) {
				reject(new Error('IndexedDB is not available.'));

				return;
			}

			const request = indexedDB.open(DB_NAME, 1);

			request.onupgradeneeded = () => request.result.createObjectStore(STORE);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		}).catch((err) => {
			dbPromise = null;

			throw err;
		});
	}

	return dbPromise;
}

async function idb(mode, op) {
	const db = await openDb();

	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, mode);
		const request = op(tx.objectStore(STORE));

		tx.oncomplete = () => resolve(request.result);
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

async function cacheGet(key) {
	try {
		return await idb('readonly', (store) => store.get(key));
	}
	catch {
		return undefined;
	}
}

async function cachePut(key, data) {
	try {
		await idb('readwrite', (store) => store.put({at: Date.now(), data}, key));
	}
	catch {
		// Not cached; the next open fetches again.
	}
}

// ------------------------------------------------------------- fetching

export class NotOnPhoneError extends Error {
	constructor(cause) {
		super('This is not saved on this phone yet. Open it once with a connection.');
		this.name = 'NotOnPhoneError';
		this.cause = cause;
	}
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One retry after a second for a server error or a dropped connection: the
// API answered 503 now and then on 2026-10-01, and the set list needs up to
// 22 requests to all succeed.
async function getJson(path, retry = true) {
	let response;

	try {
		response = await fetch(API + path);
	}
	catch (err) {
		if (retry && navigator.onLine) {
			await wait(1000);

			return getJson(path, false);
		}

		throw err;
	}

	if (response.status >= 500 && retry) {
		await wait(1000);

		return getJson(path, false);
	}

	if (!response.ok) {
		const err = new Error(`TCGdex answered ${response.status} for ${path}.`);

		err.status = response.status;

		throw err;
	}

	return response.json();
}

// Returns {data, at}. onUpdate(data) is called when a background refresh
// brings back something different from what was returned.
async function cached(key, load, onUpdate) {
	const hit = await cacheGet(key);

	const refresh = async () => {
		const data = await load();

		await cachePut(key, data);

		return data;
	};

	if (!hit) {
		try {
			return {at: Date.now(), data: await refresh()};
		}
		catch (err) {
			throw navigator.onLine ? err : new NotOnPhoneError(err);
		}
	}

	if (navigator.onLine && Date.now() - hit.at > REVALIDATE_AFTER_MS) {
		refresh()
			.then((data) => {
				if (onUpdate && JSON.stringify(data) !== JSON.stringify(hit.data)) {
					onUpdate(data);
				}
			})
			.catch(() => {
				// Keep showing the saved copy.
			});
	}

	return hit;
}

// The REST set list has no series or logo, so the list is built from the
// series index plus one request per series. All of them cover every set.
async function loadSetList(lang) {
	const series = await getJson(`${lang}/series`);
	const details = await Promise.all(series.map((serie) => getJson(`${lang}/series/${encodeURIComponent(serie.id)}`)));

	return details.map((serie) => ({
		id: serie.id,
		name: serie.name,
		sets: (serie.sets || []).map((set) => ({
			cardCount: set.cardCount || {},
			id: set.id,
			logo: set.logo || null,
			name: set.name,
		})),
	}));
}

export const setList = (lang, onUpdate) => cached(`setlist:${lang}`, () => loadSetList(lang), onUpdate);

export const setDetail = (lang, setId, onUpdate) =>
	cached(`set:${lang}:${setId}`, () => getJson(`${lang}/sets/${encodeURIComponent(setId)}`), onUpdate);

export const cardDetail = (lang, cardId, onUpdate) =>
	cached(`card:${lang}:${cardId}`, () => getJson(`${lang}/cards/${encodeURIComponent(cardId)}`), onUpdate);

// Image URLs. TCGdex gives a base URL; the format and size are appended.
export const cardImage = (base, size) => (base ? `${base}/${size}.webp` : null);

export const logoImage = (base) => (base ? `${base}.webp` : null);
