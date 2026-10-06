// Catalog data from TCGdex, with every response kept in IndexedDB.
//
// Reads are stale-while-revalidate: a response already on the phone is
// returned at once, and a fresh copy is fetched behind it (at most once an
// hour per key). A set opened once therefore opens again with no signal.

import {flagLanguageName} from './flags.js';
import {database, timedCache} from './idb.js';
import {API, fetchJson, graphql} from './tcgdex.js';

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

// German, Spanish, and Italian copies are not catalogs, but they have names
// (js/flags.js), so they never show a raw code.
export const languageLabel = (code) => (LANGUAGES.find((lang) => lang.code === code) || {label: flagLanguageName(code)}).label;

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

const cacheDb = database(DB_NAME, [STORE]);
const {get: cacheGet, put: cachePut} = timedCache(cacheDb, STORE);

// ------------------------------------------------------------- fetching

export class NotOnPhoneError extends Error {
	constructor(cause) {
		super('This is not saved on this phone yet. Open it once with a connection.');
		this.name = 'NotOnPhoneError';
		this.cause = cause;
	}
}

// A path under the TCGdex API, with js/tcgdex.js's retries: views use two
// attempts, the import four.
const getJson = (path, attempts = 2, init = undefined) => fetchJson(API + path, {attempts, init});

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
// The printed set codes of the international sets, which a set brief does
// not carry (TCGdex keeps abbreviation.official on the full set record, one
// request per set), so a collector can search "MEW" or "CRI". A brief that
// does carry the abbreviation wins over this table.
const PRINTED_CODES = {
	me01: 'MEG', me02: 'PFL', 'me02.5': 'ASC', me03: 'POR', me04: 'CRI',
	sv01: 'SVI', sv02: 'PAL', sv03: 'OBF', 'sv03.5': 'MEW', sv04: 'PAR', 'sv04.5': 'PAF', sv05: 'TEF', sv06: 'TWM', 'sv06.5': 'SFA', sv07: 'SCR', sv08: 'SSP', 'sv08.5': 'PRE', sv09: 'JTG', sv10: 'DRI', 'sv10.5b': 'BLK', 'sv10.5w': 'WHT',
	swsh1: 'SSH', swsh2: 'RCL', swsh3: 'DAA', 'swsh3.5': 'CPA', swsh4: 'VIV', 'swsh4.5': 'SHF', swsh5: 'BST', swsh6: 'CRE', swsh7: 'EVS', swsh8: 'FST', swsh9: 'BRS', swsh10: 'ASR', 'swsh10.5': 'PGO', swsh11: 'LOR', swsh12: 'SIT', 'swsh12.5': 'CRZ',
	sm1: 'SUM', sm2: 'GRI', sm3: 'BUS', 'sm3.5': 'SLG', sm4: 'CIN', sm5: 'UPR', sm6: 'FLI', sm7: 'CES', 'sm7.5': 'DRM', sm8: 'LOT', sm9: 'TEU', sm10: 'UNB', sm11: 'UNM', 'sm11.5': 'HIF', sm12: 'CEC',
};

async function loadSetList(lang) {
	const [series, newestFirst] = await Promise.all([
		getJson(`${lang}/series`),
		getJson(`${lang}/sets?sort:field=releaseDate&sort:order=DESC`).catch(() => []),
	]);
	const rank = new Map(newestFirst.map((set, i) => [set.id, i]));
	const details = await Promise.all(series.map((serie) => getJson(`${lang}/series/${encodeURIComponent(serie.id)}`)));

	// TCG Pocket is digital only; the app tracks physical cards (DESIGN.md section 3).
	return details.filter((serie) => serie.id !== 'tcgp').map((serie) => ({
		id: serie.id,
		name: serie.name,
		releaseDate: serie.releaseDate || null,
		sets: (serie.sets || []).map((set) => ({
			cardCount: set.cardCount || {},
			code: (set.abbreviation && set.abbreviation.official) || PRINTED_CODES[set.id] || null,
			id: set.id,
			logo: set.logo || null,
			name: set.name,
			releaseRank: rank.has(set.id) ? rank.get(set.id) : null,
		})),
	}));
}

// The key carries a version: a list cached before series dates and ranks were
// added sorts wrongly, so a new key makes every device fetch the dated one.
export const setList = (lang, onUpdate) => cached(`setlist4:${lang}`, () => loadSetList(lang), onUpdate);

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

// Callers asking for the same key at once (twins checking a card in the
// background while a checklist opens) share one request instead of each
// sending it; each still gets its own copy, so none can change another's.
const inFlight = new Map();

function fetchOnce(key, path) {
	if (!inFlight.has(key)) {
		inFlight.set(key, readOnce(key, path).finally(() => inFlight.delete(key)));
	}

	return inFlight.get(key).then((data) => (data && typeof data === 'object' ? structuredClone(data) : data));
}

async function readOnce(key, path) {
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

// The full TCGdex records already saved on this phone (opened on card
// detail, or read by the import) for some copies, keyed "<catalog>|<card
// id>", with no request. The prices read their US and EU prices from them
// (js/prices.js); a copy whose record is not saved has no market price, and
// a card index record stands in for its name. An international card's
// pricing is the same in every language, so the English record is tried
// first and then the copy's own language.
export async function savedCardRecords(entries) {
	const wanted = new Map();

	for (const entry of entries || []) {
		const catalog = entry.catalog || 'international';
		const key = indexKey(catalog, entry.card_id);

		if (!wanted.has(key)) {
			wanted.set(key, new Set([catalogLanguage(catalog)]));
		}

		if (catalog === 'international' && entry.language) {
			wanted.get(key).add(entry.language);
		}
	}

	if (!wanted.size) {
		return new Map();
	}

	const cardId = (key) => key.slice(key.indexOf('|') + 1);
	let hits;

	try {
		const db = await cacheDb.open();

		hits = await new Promise((resolve, reject) => {
			const tx = db.transaction(STORE, 'readonly');
			const store = tx.objectStore(STORE);
			const found = new Map();

			for (const [key, langs] of wanted) {
				for (const lang of langs) {
					const request = store.get(`card:${lang}:${cardId(key)}`);

					request.onsuccess = () => {
						const record = request.result && request.result.data;

						if (record && record.id && (!found.has(key) || lang === 'en')) {
							found.set(key, record);
						}
					};
				}
			}

			tx.oncomplete = () => resolve(found);
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	}
	catch {
		return new Map();
	}

	return hits;
}

// The records the price statistics take for some copies: the saved full
// records, else the card index records, which carry names but no prices.
export async function priceRecords(entries) {
	const [index, saved] = await Promise.all([cardIndex(), savedCardRecords(entries)]);

	return new Map([...index, ...saved]);
}

// ---------------------------------------------------------- card index

// One record per card someone owns, shaped like the catalog card in
// DESIGN.md section 4: {id, catalog, set_id, collector_number, official,
// release_date, localizations: {lang: {name, set_name, image}}}, and once
// the background pass below has read the card's set, {dex_ids, types,
// category, rarity} for the filters (js/filter-bar.js). It is what
// lets My Cards draw names and images without a request per card. Keyed by
// "<catalog>|<card id>", because the Japanese and Korean catalogs reuse the
// same IDs (both have S4a).
const INDEX_KEY = 'index:cards';

export const indexKey = (catalog, cardId) => `${catalog}|${cardId}`;

const readIndex = async () => {
	const hit = await cacheGet(INDEX_KEY);

	return new Map(Object.entries((hit && hit.data) || {}));
};

// The index is read from IndexedDB once per page and kept here, since
// parsing it whole took about 200 ms at 1,600 records on a slow phone and
// several screens read it per load (E-28). saveToCardIndex, the only
// writer, replaces the kept copy with what it wrote. An empty read is not
// kept, so a failed read is tried again. Each caller gets its own Map, so
// none can change the kept one.
let indexMemo = null;

export async function cardIndex() {
	if (!indexMemo) {
		const reading = readIndex();

		indexMemo = reading;
		reading.then((index) => {
			if (!index.size && indexMemo === reading) {
				indexMemo = null;
			}
		});
	}

	return new Map(await indexMemo);
}

// Saves run one after another: each reads, changes, and writes the whole
// index, so two fills at once would otherwise lose one's records (E-28).
let indexWrites = Promise.resolve();

export function saveToCardIndex(records) {
	const write = indexWrites.then(async () => {
		// Read from IndexedDB, not the kept copy, so records another tab
		// saved are kept too.
		const index = await readIndex();

		for (const record of records) {
			const key = indexKey(record.catalog, record.id);
			const old = index.get(key);

			index.set(key, old
				? {...old, ...record, localizations: {...old.localizations, ...record.localizations}}
				: record);
		}

		await cachePut(INDEX_KEY, Object.fromEntries(index));
		indexMemo = Promise.resolve(index);

		return new Map(index);
	});

	indexWrites = write.catch(() => {});

	return write;
}

// ------------------------------------------------- background details

// What the filters need and the card index lacks: each card's National Dex
// numbers, energy types, category, and rarity. One GraphQL request per
// owned set reads them for the whole set (DESIGN.md section 11, "Filters
// and Sorting"); Japanese, Korean, and Chinese sets are read in their own
// catalog with the @locale directive, and their types and rarities come in
// English like the international ones. A set's answer is kept on the phone
// and asked again after a week only when an owned card was missing from it
// (TCGdex fills a new set in over a few weeks).
const DETAILS_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const DETAIL_FIELDS = 'id dexId types category rarity';

export const hasDetails = (record) => Boolean(record) && typeof record.category === 'string';

export const setIdOfCard = (cardId) => {
	const cut = String(cardId).lastIndexOf('-');

	return cut > 0 ? String(cardId).slice(0, cut) : null;
};

export function cardDetailsQuery(catalog, setId) {
	const locale = catalog === 'international' ? '' : ` @locale(lang: ${JSON.stringify(catalogLanguage(catalog))})`;

	return `{ cards(filters: {id: ${JSON.stringify(`${setId}-`)}}, pagination: {page: 1, itemsPerPage: 1000})${locale} { ${DETAIL_FIELDS} } }`;
}

// {cardId: {dex_ids, types, category, rarity}} from a set's GraphQL answer.
// The id filter matches a substring, so "base1-" would also find "base10-"
// were it not for the exact set check.
export function detailsFrom(cards, setId) {
	const out = {};

	for (const card of cards || []) {
		if (!card || typeof card.id !== 'string' || setIdOfCard(card.id) !== setId) {
			continue;
		}

		out[card.id] = {
			category: typeof card.category === 'string' ? card.category : null,
			dex_ids: Array.isArray(card.dexId) ? card.dexId.filter(Number.isInteger) : [],
			rarity: typeof card.rarity === 'string' && card.rarity !== 'None' ? card.rarity : null,
			types: Array.isArray(card.types) ? card.types.filter((type) => typeof type === 'string') : [],
		};
	}

	return out;
}

// The sets whose owned cards lack details, as [{catalog, setId, ids}].
export function setsNeedingDetails(entries, index) {
	const sets = new Map();

	for (const entry of entries || []) {
		const catalog = entry.catalog || 'international';
		const record = index.get(indexKey(catalog, entry.card_id));

		if (!entry.card_id || hasDetails(record)) {
			continue;
		}

		const setId = (record && record.set_id) || setIdOfCard(entry.card_id);

		if (!setId) {
			continue;
		}

		const key = `${catalog}|${setId}`;

		if (!sets.has(key)) {
			sets.set(key, {catalog, ids: new Set(), setId});
		}

		sets.get(key).ids.add(entry.card_id);
	}

	return [...sets.values()];
}

// One set's details: the saved answer, or a fresh one when there is none,
// or when it is over a week old and lacks one of the owned cards asked for.
// Null when neither is to be had (offline, or TCGdex failing).
export async function setDetails({catalog, ids = new Set(), setId}, {now = Date.now()} = {}) {
	const key = `details:${catalog}:${setId}`;
	const hit = await cacheGet(key);
	const lacks = hit && [...ids].some((id) => !Object.hasOwn(hit.data || {}, id));

	if (hit && (!lacks || now - hit.at < DETAILS_RECHECK_MS || !navigator.onLine)) {
		return hit.data;
	}

	if (!navigator.onLine) {
		return null;
	}

	try {
		const data = await graphql(cardDetailsQuery(catalog, setId));
		const details = detailsFrom(data.cards, setId);

		await cachePut(key, details);

		return details;
	}
	catch {
		return hit ? hit.data : null;
	}
}

// The index records a set's details add for the owned cards in it.
export const detailRecords = ({catalog, ids}, details) => [...ids]
	.filter((id) => details && details[id])
	.map((id) => ({catalog, id, ...details[id]}));

// ------------------------------------------------------- goal lookups
//
// Set and artist goals (js/goals.js) read a whole set, or an illustrator's
// cards, through GraphQL, one request each, kept on the phone under their
// own keys, so a goal's missing list opens offline in a card shop.
// GraphQL's variants_detailed has no variantId (checked 2026-10-03), so
// each finish is told by its type, foil, and stamps. Asian catalogs are
// read with @locale, as for the card details above; the illustrator
// filter works there too (checked on the Japanese catalog, 2026-10-03).

const GOAL_CARD_FIELDS = 'id localId name image rarity illustrator variants { normal reverse holo firstEdition } variants_detailed { type subtype foil stamp size }';

const localeOf = (catalog) => (catalog === 'international' ? '' : ` @locale(lang: ${JSON.stringify(catalogLanguage(catalog))})`);

// One set's cards with their finishes. The id filter matches a substring,
// so setCardsFrom keeps only the set's own cards.
export const setCardsQuery = (catalog, setId) =>
	`{ cards(filters: {id: ${JSON.stringify(`${setId}-`)}}, pagination: {page: 1, itemsPerPage: 1000})${localeOf(catalog)} { ${GOAL_CARD_FIELDS} } }`;

// TCGdex's illustrator filter matches any part of the name, in any case;
// illustratorCardsFrom keeps the exact name. Pages of ILLUSTRATOR_PAGE.
export const ILLUSTRATOR_PAGE = 500;

export const illustratorQuery = (catalog, name, page = 1) =>
	`{ cards(filters: {illustrator: ${JSON.stringify(String(name))}}, pagination: {page: ${Number(page)}, itemsPerPage: ${ILLUSTRATOR_PAGE}})${localeOf(catalog)} { ${GOAL_CARD_FIELDS} set { id name } } }`;

// An illustrator's name compared loosely: case, accents, and spacing aside.
export const artistKey = (name) => String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const goalCard = (card) => ({
	id: card.id,
	illustrator: typeof card.illustrator === 'string' ? card.illustrator : null,
	image: card.image || null,
	localId: card.localId || null,
	name: card.name || null,
	rarity: typeof card.rarity === 'string' && card.rarity !== 'None' ? card.rarity : null,
	setId: (card.set && card.set.id) || null,
	setName: (card.set && card.set.name) || null,
	variants: card.variants || null,
	variants_detailed: Array.isArray(card.variants_detailed) ? card.variants_detailed : null,
});

// {cardId: card} for one set from its GraphQL answer.
export function setCardsFrom(cards, setId) {
	const out = {};

	for (const card of cards || []) {
		if (card && typeof card.id === 'string' && setIdOfCard(card.id) === setId) {
			out[card.id] = goalCard(card);
		}
	}

	return out;
}

// [card] by one illustrator, the exact name only.
export function illustratorCardsFrom(cards, name) {
	const wanted = artistKey(name);

	return (cards || []).filter((card) => card && typeof card.id === 'string' && artistKey(card.illustrator) === wanted).map(goalCard);
}

// One set's cards with their finishes: {data, at}, from the phone first
// (refreshed behind it at most once an hour, like the set views).
export const setCards = (catalog, setId, onUpdate) =>
	cached(`goalset:${catalog}:${setId}`, async () => setCardsFrom((await graphql(setCardsQuery(catalog, setId))).cards, setId), onUpdate);

async function loadIllustrator(catalog, name) {
	const all = [];

	for (let page = 1; page <= 20; page++) {
		const cards = (await graphql(illustratorQuery(catalog, name, page))).cards || [];

		all.push(...cards);

		if (cards.length < ILLUSTRATOR_PAGE) {
			break;
		}
	}

	return illustratorCardsFrom(all, name);
}

// Every card by one illustrator in one catalog: {data, at}, as setCards.
export const illustratorCards = (catalog, name, onUpdate) =>
	cached(`goalartist:${catalog}:${artistKey(name)}`, () => loadIllustrator(catalog, name), onUpdate);

// ---------------------------------------------------- background prices

// The US estimate on a tile comes from the full TCGdex record card detail
// saves ("card:<lang>:<id>"). The background pass reads the records of owned
// international cards the phone lacks, and refreshes those older than a
// week, a few at a time, saved under the same key and shape as card detail
// saves them, so card detail and the tiles read the same record. GraphQL
// carries no pricing (checked 2026-10-02), so this is the REST card
// endpoint. Japanese, Korean, and Chinese prints have no market price and
// are never asked for.
export const PRICE_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

// The cards due, as [{cardId, langs, at}]: the ones never read first, in the
// order given (the list order on screen), then the oldest saved ones. A card
// that answered 404 within the last day is left alone.
export async function pricesDue(entries, {now = Date.now(), maxAge = PRICE_REFRESH_MS} = {}) {
	const wanted = new Map();

	for (const entry of entries || []) {
		if ((entry.catalog || 'international') !== 'international' || !entry.card_id) {
			continue;
		}

		if (!wanted.has(entry.card_id)) {
			wanted.set(entry.card_id, new Set(['en']));
		}

		if (entry.language && !ASIAN.has(entry.language)) {
			wanted.get(entry.card_id).add(entry.language);
		}
	}

	if (!wanted.size) {
		return [];
	}

	let found;

	try {
		const db = await cacheDb.open();

		found = await new Promise((resolve, reject) => {
			const tx = db.transaction(STORE, 'readonly');
			const store = tx.objectStore(STORE);
			const ages = new Map();

			for (const [cardId, langs] of wanted) {
				for (const lang of langs) {
					const request = store.get(`card:${lang}:${cardId}`);

					request.onsuccess = () => {
						const hit = request.result;

						if (hit && hit.data && hit.data.id) {
							ages.set(cardId, Math.max(ages.get(cardId) || 0, hit.at || 0));
						}
					};
				}

				const missing = store.get(`missing:card:en:${cardId}`);

				missing.onsuccess = () => {
					if (missing.result && now - missing.result.at < MISSING_FOR_MS && !ages.has(cardId)) {
						ages.set(cardId, -1);
					}
				};
			}

			tx.oncomplete = () => resolve(ages);
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	}
	catch {
		return [];
	}

	const never = [];
	const stale = [];

	for (const [cardId, langs] of wanted) {
		const at = found.get(cardId);

		if (at === undefined) {
			never.push({at: 0, cardId, langs: [...langs]});
		}
		else if (at > 0 && now - at > maxAge) {
			stale.push({at, cardId, langs: [...langs]});
		}
	}

	return [...never, ...stale.sort((a, b) => a.at - b.at)];
}

// Reads one card's full record and saves it the way card detail does. The
// English record first; a print TCGdex lists only in its own language (a
// Portuguese-only card) falls back to that. Resolves to the record, or null
// when TCGdex has none. Throws when TCGdex cannot be reached.
export async function readPriceRecord({cardId, langs = ['en']}) {
	for (const lang of langs) {
		try {
			const record = await getJson(`${lang}/cards/${encodeURIComponent(cardId)}`, 2);

			if (record && record.id) {
				await cachePut(`card:${lang}:${cardId}`, record);

				return record;
			}
		}
		catch (err) {
			if (!err || err.status !== 404) {
				throw err;
			}

			if (lang === 'en') {
				await cachePut(`missing:card:en:${cardId}`, true);
			}
		}
	}

	return null;
}
