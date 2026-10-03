// Every card of one Pokémon (DESIGN.md section 11, "Every card of a
// Pokémon"): for a checklist and a National Dex number, every print whose
// dexId includes that number (so TAG TEAM cards count), newest first, with
// what the person owns in the list's languages.
//
// Where the prints come from:
//   International (Portuguese, English, French, and the other Western
//   languages share one record): the bulk id and dexId list js/checklists.js
//   already keeps (internationalDexMap), so the list works offline. Two
//   small GraphQL requests dress it, each kept on the phone: every set's
//   name, release date, and series (about 40 KB, which also marks TCG Pocket
//   sets), and this Pokémon's card names and images (a few KB).
//   Japanese and Chinese: TCGdex's GraphQL answers in English only, so a list
//   with one of those languages asks that catalog's REST API for the
//   Pokémon's cards (one request, ?dexId=eq:<n>, which matches TAG TEAM
//   cards too), then each set they are in, one request per set, for its name
//   and release date. Set details are kept under the catalog browser's keys,
//   so a set loaded here also opens offline in Sets. On 2026-10-01 the
//   Korean and Simplified Chinese catalogs held no cards (their sets list
//   no cards and the dexId query answers an empty list), so those headings
//   say the catalog has none yet.
//   TCG Pocket is digital only and left out (DESIGN.md section 3).
//
// "Count every finish" counts each real finish a card is printed in, from
// its variants_detailed, read one card at a time through js/catalog.js under
// the card detail view's keys (cache first), only when the switch is on.
//
// No DOM here, so Node can test the pure parts (tests/pokemon-cards.test.mjs).

import {catalogFor, catalogLanguage, compareNumbers, importApi} from './catalog.js';
import {internationalDexMap} from './checklists.js';
import {isLive} from './collection.js';

export const ASIAN_CATALOGS = ['ja', 'ko', 'zh-cn', 'zh-tw'];

export const CATALOG_ORDER = ['international', ...ASIAN_CATALOGS];

export const CATALOG_HEADINGS = {
	international: 'International prints',
	ja: 'Japanese prints',
	ko: 'Korean prints',
	'zh-cn': 'Chinese (Simplified) prints',
	'zh-tw': 'Chinese (Traditional) prints',
};

export const POCKET_SERIES = 'tcgp';

const validDex = (n) => Number.isInteger(n) && n >= 1 && n <= 1025;

// The catalogs a list's languages need, in screen order: a Portuguese and
// Japanese list shows the international prints, then the Japanese ones.
export function catalogsFor(languages) {
	const wanted = new Set((languages || []).map(catalogFor));

	return CATALOG_ORDER.filter((catalog) => wanted.has(catalog));
}

// The language a missing card goes on the wishlist in: the list's language
// for that card's catalog when the list names exactly one, else any.
export function wishLanguage(languages, catalog) {
	const fits = [...new Set(languages || [])].filter((code) => catalogFor(code) === catalog);

	return fits.length === 1 ? fits[0] : null;
}

// ------------------------------------------------------ selecting prints

// The card IDs in a bulk map ({cardId: [dex, ...]}) whose dexId includes n,
// TAG TEAM cards (several numbers) included.
export function cardIdsForDex(dexMap, n) {
	const dex = Number(n);

	return Object.keys(dexMap || {}).filter((id) => Array.isArray(dexMap[id]) && dexMap[id].includes(dex));
}

// The set a card ID belongs to: the longest known set ID it starts with
// ("tk-xy-w-12" is in tk-xy-w, "sv03.5-039" in sv03.5), else everything
// before its last hyphen.
export function setIdOf(cardId, knownSets = null) {
	const id = String(cardId);
	let best = null;

	for (const setId of knownSets ? knownSets.keys() : []) {
		if (id.startsWith(`${setId}-`) && (!best || setId.length > best.length)) {
			best = setId;
		}
	}

	if (best) {
		return best;
	}

	const cut = id.lastIndexOf('-');

	return cut > 0 ? id.slice(0, cut) : id;
}

export const localIdOf = (cardId, setId) => (String(cardId).startsWith(`${setId}-`) ? String(cardId).slice(setId.length + 1) : String(cardId));

// TCG Pocket: its series, or, for a set the set list does not know yet, its
// image path (assets.tcgdex.net/en/tcgp/...).
export const isPocket = (set, image = null) => Boolean((set && set.serie === POCKET_SERIES) || /\/tcgp\//.test(String(image || '')));

// GraphQL sets -> Map setId -> {id, name, releaseDate, serie}.
export function setsIndexFrom(json) {
	const sets = (json && json.data && json.data.sets) || null;

	if (!Array.isArray(sets)) {
		throw new Error('TCGdex sent no set list.');
	}

	const index = {};

	for (const set of sets) {
		if (set && set.id) {
			index[set.id] = {id: set.id, name: set.name || set.id, releaseDate: set.releaseDate || null, serie: (set.serie && set.serie.id) || null};
		}
	}

	return index;
}

// GraphQL cards of one Pokémon -> {cardId: {name, image, localId}}.
export function dexCardsFrom(json) {
	const cards = (json && json.data && json.data.cards) || null;

	if (!Array.isArray(cards)) {
		throw new Error('TCGdex sent no card list.');
	}

	const out = {};

	for (const card of cards) {
		if (card && card.id) {
			out[card.id] = {image: card.image || null, localId: card.localId || null, name: card.name || null, rarity: card.rarity || null};
		}
	}

	return out;
}

// The international prints of one Pokémon. ids from the bulk map; sets the
// set index ({setId: {...}}); cards this Pokémon's names and images, either
// may be empty. A print: {catalog, cardId, setId, localId, name, image,
// setName, releaseDate}.
export function internationalPrints({cards = {}, ids, sets = {}}) {
	const known = new Map(Object.entries(sets || {}));
	const prints = [];

	for (const cardId of ids) {
		const setId = setIdOf(cardId, known);
		const set = known.get(setId) || null;
		const card = (cards && cards[cardId]) || {};

		if (isPocket(set, card.image)) {
			continue;
		}

		prints.push({
			cardId,
			catalog: 'international',
			image: card.image || null,
			localId: card.localId || localIdOf(cardId, setId),
			name: card.name || null,
			releaseDate: (set && set.releaseDate) || null,
			setId,
			setName: (set && set.name) || null,
		});
	}

	return prints;
}

// The prints of one Pokémon in an Asian catalog. briefs from the REST card
// list ([{id, localId, name, image}]); sets: Map setId -> set detail (null
// for a set that could not be read).
export function asianPrints({briefs, catalog, sets}) {
	const known = sets instanceof Map ? sets : new Map(Object.entries(sets || {}));
	const prints = [];

	for (const brief of briefs || []) {
		if (!brief || !brief.id) {
			continue;
		}

		const setId = setIdOf(brief.id, known);
		const set = known.get(setId) || null;

		if (isPocket(set && {serie: set.serie && set.serie.id}, brief.image)) {
			continue;
		}

		prints.push({
			cardId: brief.id,
			catalog,
			image: brief.image || null,
			localId: brief.localId || localIdOf(brief.id, setId),
			name: brief.name || null,
			releaseDate: (set && set.releaseDate) || null,
			setId,
			setName: (set && set.name) || null,
		});
	}

	return prints;
}

// Newest first: by the set's release date, then the higher number first
// (a set's secret rares after its main run). A set with no date sorts last.
export function newestFirst(prints) {
	return [...prints].sort((a, b) => {
		if (a.releaseDate !== b.releaseDate) {
			if (!a.releaseDate) {
				return 1;
			}

			if (!b.releaseDate) {
				return -1;
			}

			return a.releaseDate < b.releaseDate ? 1 : -1;
		}

		return compareNumbers(b.setId, a.setId) || compareNumbers(b.localId, a.localId);
	});
}

// ---------------------------------------------------------- ownership

export const printKey = (catalog, cardId) => `${catalog}|${cardId}`;

// The live copies that count for a list, by printKey: those in one of the
// list's languages. A Portuguese-only list counts a card only for a
// Portuguese copy; null languages (a list that names none) count every
// copy, as its checklist does.
export function copiesByPrint(entries, languages) {
	const allowed = languages ? new Set(languages) : null;
	const out = new Map();

	for (const entry of entries || []) {
		if (!entry || !isLive(entry) || !entry.card_id || (allowed && !allowed.has(entry.language))) {
			continue;
		}

		const key = printKey(entry.catalog || 'international', entry.card_id);

		if (!out.has(key)) {
			out.set(key, []);
		}

		out.get(key).push(entry);
	}

	return out;
}

// copiesByPrint, worked out once per entries array and set of languages:
// the Pokémon screen draws many times over the same collection while its
// cards and finishes arrive. A new collection is a new array (a save loads
// it again), so it is never served an old answer.
const ownedMemo = new WeakMap();

export function copiesByPrintOnce(entries, languages) {
	if (!Array.isArray(entries)) {
		return copiesByPrint(entries, languages);
	}

	const key = languages ? [...languages].join(',') : '*';
	let byLanguages = ownedMemo.get(entries);

	if (!byLanguages) {
		byLanguages = new Map();
		ownedMemo.set(entries, byLanguages);
	}

	if (!byLanguages.has(key)) {
		byLanguages.set(key, copiesByPrint(entries, languages));
	}

	return byLanguages.get(key);
}

// ----------------------------------------------------------- finishes

// The plain print (normal, or holo on a holo rare) has no finish code in
// js/tile.js; here it is counted as 'normal'.
export const PLAIN = 'normal';

export const FINISH_ORDER = [PLAIN, 'reverse', 'pokeball', 'masterball', 'first'];

const finishRank = (code) => {
	const i = FINISH_ORDER.indexOf(code);

	return i < 0 ? FINISH_ORDER.length : i;
};

// A variant that is a finish of the card itself, not another product: the
// standard size, and no stamp but the 1st Edition one (a prerelease or staff
// stamp is a promo of its own).
const isFinishVariant = (variant) => Boolean(variant)
	&& (!variant.size || variant.size === 'standard')
	&& (variant.stamp || []).every((stamp) => stamp === '1st-edition');

// The finishes a card is printed in, from its TCGdex record, as codes in
// FINISH_ORDER. variantFinish is js/tile.js variantFinish. A record with no
// variants_detailed is read from its variants flags; one with neither has
// the plain print alone.
export function cardFinishes(detail, variantFinish) {
	const codes = new Set();
	const detailed = detail && Array.isArray(detail.variants_detailed) ? detail.variants_detailed : [];

	for (const variant of detailed.filter(isFinishVariant)) {
		codes.add(variantFinish(variant) || PLAIN);
	}

	if (!codes.size && detail && detail.variants) {
		const flags = detail.variants;

		if (flags.normal || flags.holo) {
			codes.add(PLAIN);
		}

		if (flags.reverse) {
			codes.add('reverse');
		}

		if (flags.firstEdition) {
			codes.add('first');
		}
	}

	if (!codes.size) {
		codes.add(PLAIN);
	}

	return [...codes].sort((a, b) => finishRank(a) - finishRank(b));
}

// The finishes the copies are in. entryFinish is js/tile.js entryFinish;
// a copy whose finish is not known counts as the plain print.
export function ownedFinishes(copies, variants, entryFinish) {
	return new Set((copies || []).map((entry) => entryFinish(entry, variants) || PLAIN));
}

// One print's counts. finishes: the card's finish codes, or null when its
// record is not on the phone (it then counts once, as with the switch off).
// A finish owned that the record does not list still counts: the copy is
// real.
export function printCounts({copies = [], finishes = null, owned = null}, everyFinish) {
	if (!everyFinish || !finishes) {
		const has = copies.length > 0;

		return {missing: has ? 0 : 1, owned: has ? 1 : 0, total: 1, unknown: Boolean(everyFinish && !finishes)};
	}

	const all = new Set([...finishes, ...(owned || [])]);
	const have = [...all].filter((code) => owned && owned.has(code)).length;

	return {missing: all.size - have, owned: have, total: all.size, unknown: false};
}

// The header's counts over every print shown.
export function tally(states, everyFinish) {
	const out = {missing: 0, owned: 0, total: 0, unknown: 0};

	for (const state of states) {
		const counts = printCounts(state, everyFinish);

		out.owned += counts.owned;
		out.total += counts.total;
		out.missing += counts.missing;
		out.unknown += counts.unknown ? 1 : 0;
	}

	return out;
}

// The All, Owned, and Missing filter. With every finish counted, a card
// with some finishes owned shows under both.
export function passesFilter(state, filter, everyFinish) {
	if (filter === 'all') {
		return true;
	}

	const counts = printCounts(state, everyFinish);

	return filter === 'owned' ? counts.owned > 0 : counts.missing > 0;
}

// ------------------------------------------------------------ the cache

const DB_NAME = 'card-tracker-pokemon-cards';
const STORE = 'cache';

let dbPromise = null;

function openDb() {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			if (typeof indexedDB === 'undefined') {
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
		// Not kept; the next visit asks again.
	}
}

// ----------------------------------------------------------- fetching

const TCGDEX = 'https://api.tcgdex.net/v2/';
const GRAPHQL = `${TCGDEX}graphql`;
const DAY_MS = 24 * 60 * 60 * 1000;
const REFETCH_FOR_NEW_AFTER_MS = DAY_MS / 2;
const REFETCH_AFTER_MS = 30 * DAY_MS;
const CONCURRENCY = 4;

const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// TCGdex answers 503 now and then (DESIGN.md section 5): one retry after a
// second, the way the catalog views retry.
async function fetchJson(url, init) {
	for (let attempt = 1; ; attempt++) {
		let response;

		try {
			response = await fetch(url, init);
		}
		catch (err) {
			if (attempt < 2 && online()) {
				await wait(1000);

				continue;
			}

			throw err;
		}

		if ((response.status >= 500 || response.status === 429) && attempt < 2) {
			await wait(1000);

			continue;
		}

		if (!response.ok) {
			const err = new Error(`TCGdex answered ${response.status}.`);

			err.status = response.status;

			throw err;
		}

		return response.json();
	}
}

const graphql = (query) => fetchJson(GRAPHQL, {
	body: JSON.stringify({query}),
	headers: {'content-type': 'application/json'},
	method: 'POST',
});

export const SETS_QUERY = '{ sets { id name releaseDate serie { id } } }';

export const dexCardsQuery = (n) => `{ cards(filters: {dexId: ${Number(n)}}) { id localId name image rarity } }`;

// A cached value: the copy on the phone, fetched again when it is older than
// maxAge (or older than newAge while `stale` says it lacks something), and
// online. A failed fetch keeps the copy. {data, error}
async function kept(key, load, {force = false, maxAge = REFETCH_AFTER_MS, newAge = REFETCH_FOR_NEW_AFTER_MS, stale = () => false} = {}) {
	const hit = await cacheGet(key);
	const age = hit ? Date.now() - hit.at : Infinity;
	const due = !hit || age > maxAge || (age > newAge && stale(hit.data)) || (force && age > newAge);

	if (!due || !online()) {
		return {data: hit ? hit.data : null, error: null};
	}

	try {
		const data = await load();

		await cachePut(key, data);

		return {data, error: null};
	}
	catch (err) {
		return {data: hit ? hit.data : null, error: err};
	}
}

// The international prints of Pokémon n. {prints, error, missingList}:
// missingList when the bulk list is not on the phone (offline before the
// first visit, or its download failed); error is the first failure.
export async function loadInternational(n, {force = false, onProgress = () => {}} = {}) {
	const bulk = await internationalDexMap({force, onProgress});
	const ids = bulk.map ? cardIdsForDex(bulk.map, n) : [];
	const lacks = (index) => ids.some((id) => !Object.hasOwn(index || {}, setIdOf(id, new Map(Object.entries(index || {})))));
	const [sets, cards] = await Promise.all([
		kept('sets:international', async () => setsIndexFrom(await graphql(SETS_QUERY)), {force, stale: lacks}),
		kept(`dex:international:${n}`, async () => dexCardsFrom(await graphql(dexCardsQuery(n))), {
			force,
			maxAge: 7 * DAY_MS,
			stale: (data) => ids.some((id) => !Object.hasOwn(data || {}, id)),
		}),
	]);

	// The set list is what tells a TCG Pocket card apart, so without it
	// (and without this Pokémon's images, which say it too) nothing is
	// listed rather than Pocket cards with the rest.
	if (!bulk.map || (!sets.data && !cards.data)) {
		return {error: bulk.error || sets.error || cards.error || null, missingList: true, prints: []};
	}

	return {
		error: bulk.error || sets.error || cards.error || null,
		missingList: false,
		prints: internationalPrints({cards: cards.data || {}, ids, sets: sets.data || {}}),
	};
}

async function pool(items, size, work) {
	let next = 0;

	await Promise.all(Array.from({length: Math.min(size, items.length)}, async () => {
		while (next < items.length) {
			await work(items[next++]);
		}
	}));
}

// The prints of Pokémon n in an Asian catalog. {prints, error, missingList,
// unreadSets}: unreadSets counts sets whose details are not on the phone
// (their cards are listed without a set name or date).
export async function loadAsian(catalog, n, {force = false} = {}) {
	const lang = catalogLanguage(catalog);
	const briefs = await kept(`dex:${catalog}:${n}`, async () => {
		const list = await fetchJson(`${TCGDEX}${lang}/cards?dexId=eq:${Number(n)}`);

		if (!Array.isArray(list)) {
			throw new Error('TCGdex sent no card list.');
		}

		return list.map((card) => ({id: card.id, image: card.image || null, localId: card.localId || null, name: card.name || null}));
	}, {force, maxAge: 7 * DAY_MS});

	if (!briefs.data) {
		return {error: briefs.error, missingList: true, prints: [], unreadSets: 0};
	}

	const setIds = [...new Set(briefs.data.map((brief) => setIdOf(brief.id)))];
	const sets = new Map();
	let unreadSets = 0;
	let error = briefs.error;

	await pool(setIds, CONCURRENCY, async (setId) => {
		try {
			// Cache first, under the set view's key (js/catalog.js).
			// A set TCGdex no longer has answers null (404): its cards say so
			// rather than show no set name at all (E-12).
			sets.set(setId, (await importApi.setDetail(lang, setId)) || {name: SET_GONE});
		}
		catch (err) {
			sets.set(setId, null);
			unreadSets++;
			error = error || err;
		}
	});

	return {error, missingList: false, prints: asianPrints({briefs: briefs.data, catalog, sets}), unreadSets};
}

// The finish part of the records read so far ({variants,
// variants_detailed}), by printKey, kept for as long as the app is open:
// leaving the Pokémon screen and coming back, or opening another list with
// the same Pokémon, finds them here without reading IndexedDB again. A
// record that could not be read is not kept, so a later visit online tries
// again. Capped, oldest out first, so a long session stays small.
export const SET_GONE = 'Set not found';

const RECORD_CACHE_LIMIT = 5000;
const finishRecords = new Map();

const finishPart = (record) => ({
	variants: (record && record.variants) || null,
	variants_detailed: record && Array.isArray(record.variants_detailed) ? record.variants_detailed : null,
});

// A print's finish record already read in this session, or undefined.
export const knownRecord = (print) => finishRecords.get(printKey(print.catalog, print.cardId));

// A print's TCGdex record, cache first under the card detail view's keys,
// for its finishes (only the variants are kept). Null when it is not on the
// phone and cannot be read.
export async function printRecord(print) {
	const key = printKey(print.catalog, print.cardId);

	if (finishRecords.has(key)) {
		return finishRecords.get(key);
	}

	let record;

	try {
		record = await importApi.cardDetail(catalogLanguage(print.catalog), print.cardId);
	}
	catch {
		return null;
	}

	if (!record) {
		return null;
	}

	const part = finishPart(record);

	finishRecords.set(key, part);

	if (finishRecords.size > RECORD_CACHE_LIMIT) {
		finishRecords.delete(finishRecords.keys().next().value);
	}

	return part;
}

// Validates a dex route parameter.
export const dexFromParam = (value) => {
	const n = Number(value);

	return validDex(n) && String(n) === String(value).replace(/^0+(?=\d)/, '') ? n : null;
};
