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

// Western-language prints share one international card record; Japanese,
// Korean, and Chinese prints have their own catalogs (DESIGN.md section 3).
const ASIAN = new Set(['ja', 'ko', 'zh-cn', 'zh-tw']);

export const catalogFor = (lang) => (ASIAN.has(lang) ? lang : 'international');

// The catalog language whose records a catalog's cards are listed in.
export const catalogLanguage = (catalog) => (catalog === 'international' ? 'en' : catalog);

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

// Retries a server error or a dropped connection after 1, then 3, then 8
// seconds: the API answered 503 now and then on 2026-10-01, and the set list
// needs up to 22 requests to all succeed. Views use two attempts; the import
// uses four, so a long run rides out a short outage.
const BACKOFF_MS = [1000, 3000, 8000];

async function getJson(path, attempts = 2) {
	for (let attempt = 1; ; attempt++) {
		let response;

		try {
			response = await fetch(API + path);
		}
		catch (err) {
			if (attempt < attempts && navigator.onLine) {
				await wait(BACKOFF_MS[attempt - 1] || 8000);

				continue;
			}

			throw err;
		}

		if (response.status >= 500 && attempt < attempts) {
			await wait(BACKOFF_MS[attempt - 1] || 8000);

			continue;
		}

		if (!response.ok) {
			const err = new Error(`TCGdex answered ${response.status} for ${path}.`);

			err.status = response.status;

			throw err;
		}

		return response.json();
	}
}

// Returns {data, at}. onUpdate(data) is called when a background refresh
// brings back something different from what was returned.
async function cached(key, load, onUpdate, {revalidate = true} = {}) {
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

	if (revalidate && navigator.onLine && Date.now() - hit.at > REVALIDATE_AFTER_MS) {
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
//
// Neither carries a set's release date, but the API sorts the set list by
// it, so one more request gives every set its place in release order
// (releaseRank 0 is the newest). Each series carries its own releaseDate.
async function loadSetList(lang) {
	const [series, newestFirst] = await Promise.all([
		getJson(`${lang}/series`),
		getJson(`${lang}/sets?sort:field=releaseDate&sort:order=DESC`).catch(() => []),
	]);
	const rank = new Map(newestFirst.map((set, i) => [set.id, i]));
	const details = await Promise.all(series.map((serie) => getJson(`${lang}/series/${encodeURIComponent(serie.id)}`)));

	return details.map((serie) => ({
		id: serie.id,
		name: serie.name,
		releaseDate: serie.releaseDate || null,
		sets: (serie.sets || []).map((set) => ({
			cardCount: set.cardCount || {},
			id: set.id,
			logo: set.logo || null,
			name: set.name,
			releaseRank: rank.has(set.id) ? rank.get(set.id) : null,
		})),
	}));
}

// The key carries a version: a list cached before series dates and ranks were
// added sorts wrongly, so a new key makes every device fetch the dated one.
export const setList = (lang, onUpdate) => cached(`setlist2:${lang}`, () => loadSetList(lang), onUpdate);

export const setDetail = (lang, setId, onUpdate) =>
	cached(`set:${lang}:${setId}`, () => getJson(`${lang}/sets/${encodeURIComponent(setId)}`), onUpdate);

export const cardDetail = (lang, cardId, onUpdate) =>
	cached(`card:${lang}:${cardId}`, () => getJson(`${lang}/cards/${encodeURIComponent(cardId)}`), onUpdate);

// Image URLs. TCGdex gives a base URL; the format and size are appended.
export const cardImage = (base, size) => (base ? `${base}/${size}.webp` : null);

export const logoImage = (base) => (base ? `${base}.webp` : null);

// ------------------------------------------------------- import lookups

// Cache first with no background refresh, so a rerun of the import sends no
// requests for what it already has. A 404 is remembered for a day as
// "missing" and returns null. Keys match the views' keys, so a set or card
// the import loaded opens offline in the catalog browser too.
const MISSING_FOR_MS = 24 * 60 * 60 * 1000;

async function fetchOnce(key, path) {
	const hit = await cacheGet(key);

	if (hit) {
		return hit.data;
	}

	const missing = await cacheGet(`missing:${key}`);

	if (missing && Date.now() - missing.at < MISSING_FOR_MS) {
		return null;
	}

	try {
		const data = await getJson(path, 4);

		await cachePut(key, data);

		return data;
	}
	catch (err) {
		if (err && err.status === 404) {
			await cachePut(`missing:${key}`, true);

			return null;
		}

		throw err;
	}
}

// The TCGdex calls the monprice matcher needs (js/monprice.js).
export const importApi = {
	cardDetail: (lang, cardId) => fetchOnce(`card:${lang}:${cardId}`, `${lang}/cards/${encodeURIComponent(cardId)}`),
	// An exact match on one field of the set list, such as
	// abbreviation.official=CRI.
	findSets: async (lang, field, value) =>
		(await fetchOnce(`find:${lang}:${field}:${value}`, `${lang}/sets?${field}=eq:${encodeURIComponent(value)}`)) || [],
	setDetail: (lang, setId) => fetchOnce(`set:${lang}:${setId}`, `${lang}/sets/${encodeURIComponent(setId)}`),
};

// Cache-first set detail for the views that only need names and images,
// such as My Cards filling in names in the viewing language.
export const setDetailOnce = (lang, setId) => importApi.setDetail(lang, setId);

// ---------------------------------------------------------- card index

// One record per card someone owns, shaped like the catalog card in
// DESIGN.md section 4: {id, catalog, set_id, collector_number, official,
// release_date, localizations: {lang: {name, set_name, image}}}. It is what
// lets My Cards draw names and images without a request per card. Keyed by
// "<catalog>|<card id>", because the Japanese and Korean catalogs reuse the
// same IDs (both have S4a).
const INDEX_KEY = 'index:cards';

export const indexKey = (catalog, cardId) => `${catalog}|${cardId}`;

export async function cardIndex() {
	const hit = await cacheGet(INDEX_KEY);

	return new Map(Object.entries((hit && hit.data) || {}));
}

export async function saveToCardIndex(records) {
	const index = await cardIndex();

	for (const record of records) {
		const key = indexKey(record.catalog, record.id);
		const old = index.get(key);

		index.set(key, old
			? {...old, ...record, localizations: {...old.localizations, ...record.localizations}}
			: record);
	}

	await cachePut(INDEX_KEY, Object.fromEntries(index));

	return index;
}
