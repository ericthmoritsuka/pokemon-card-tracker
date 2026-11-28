// Catalog data from TCGdex, with every response kept in IndexedDB.
//
// Reads are stale-while-revalidate: a response already on the phone is
// returned at once, and a fresh copy is fetched behind it (at most once an
// hour per key). A set opened once therefore opens again with no signal.

import {database, timedCache} from './idb.js';
import {ASIAN_LANGUAGES, CATALOG_LANGUAGES, catalogFor, catalogLanguage, isCatalogLanguage, languageLabel} from './languages.js';
import {API, fetchJson, graphql} from './tcgdex.js';
import {recordCardPrices} from './value-history.js';

// The languages come from js/languages.js. These names stay exported here
// for the modules that still import them from the catalog.
export const LANGUAGES = CATALOG_LANGUAGES;

export const isLanguage = isCatalogLanguage;

export {catalogFor, catalogLanguage, languageLabel};

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
const {get: cacheGet, put: storePut} = timedCache(cacheDb, STORE);

// The full card records ("card:<lang>:<card id>") and their 404 marks
// ("missing:card:..."), as stored ({at, data}, or null when none is), read
// once per visit: savedCardRecords and pricesDue read up to two records per
// owned card each time a screen opens, and on a slow phone reading 1,500
// records took about 2.5 s at a cold start and again on every return to My
// Cards. Every write here forgets its key, and so does a write in another
// tab of this app (BroadcastChannel). A tab of an older app, or a browser
// with no BroadcastChannel, says nothing when it writes, so every kept read
// is dropped when the page comes back into view (visibilitychange,
// pageshow): such a write shows from then on, not at once. A read that a
// write of the same key, or a drop, overtook is not kept.
const SAVED_CHANNEL = 'card-tracker-catalog-records';
// From this many keys, readSaved lists the stored keys before reading.
const MANY_KEYS = 64;
const memoKey = (key) => typeof key === 'string' && (key.startsWith('card:') || key.startsWith('missing:card:'));
const savedMemo = new Map();
// Each forgotten key's turn, so a read that began before it is not kept.
const forgotAt = new Map();
let memoTurn = 0;
// The turn of the last drop of every kept read.
let droppedAt = 0;
let savedChannel = null;
let listening = false;

function forget(key) {
	savedMemo.delete(key);
	forgotAt.set(key, ++memoTurn);
}

function forgetAll() {
	savedMemo.clear();
	forgotAt.clear();
	droppedAt = ++memoTurn;
}

function listenForRecords() {
	if (listening) {
		return;
	}

	listening = true;

	if (typeof document !== 'undefined') {
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible') {
				forgetAll();
			}
		});
	}

	if (typeof window !== 'undefined') {
		// Back from the browser's page cache, after any time away.
		window.addEventListener('pageshow', (event) => {
			if (event.persisted) {
				forgetAll();
			}
		});
	}

	if (typeof BroadcastChannel !== 'function') {
		return;
	}

	savedChannel = new BroadcastChannel(SAVED_CHANNEL);
	// Node keeps a process alive while a channel is open; browsers have no
	// unref, so this only lets a test run (node --test) end.
	savedChannel.unref?.();
	savedChannel.onmessage = (event) => {
		for (const key of (event.data && event.data.keys) || []) {
			forget(key);
		}
	};
}

const keepRead = (key, value, began) => {
	if (!(forgotAt.get(key) > began) && !(droppedAt > began)) {
		savedMemo.set(key, value ?? null);
	}
};

async function cachePut(key, data) {
	await storePut(key, data);

	if (memoKey(key)) {
		forget(key);
		listenForRecords();

		if (savedChannel) {
			savedChannel.postMessage({keys: [key]});
		}
	}
}

// Saves a response just fetched from TCGdex. A full card record
// ("card:<lang>:<card id>") also leaves a weekly point of its prices on the
// phone (js/value-history.js), whichever screen read it: card detail, the
// import, or My Cards' background pass. Japanese, Korean, and Chinese
// records are left out, since their prices are not known to be theirs
// (DESIGN.md section 10, "The language gap").
async function putFetched(key, data) {
	await cachePut(key, data);

	const [kind, lang, cardId] = String(key).split(':');

	if (kind === 'card' && cardId && data && data.id && !ASIAN_LANGUAGES.includes(lang)) {
		recordCardPrices(cardId, data).catch(() => {
			// Only a gap in the card's history.
		});
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

// A path under the TCGdex API, with js/tcgdex.js's retries: views use two
// attempts, the import four.
const getJson = (path, attempts = 2, init = undefined) => fetchJson(API + path, {attempts, init});

// Returns {data, at}. onUpdate(data) is called when a background refresh
// brings back something different from what was returned.
async function cached(key, load, onUpdate, {revalidate = true} = {}) {
	const hit = await cacheGet(key);

	const refresh = async () => {
		const data = await load();

		await putFetched(key, data);

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
// does carry the abbreviation wins over this table. Every code here is
// TCGdex's abbreviation.official for that ID (checked 2026-11-24). Card
// search reads a word equal to a code as the set, so a short code that is
// also a common word (EX, SV, DP, XY) stays out of it.
const PRINTED_CODES = {
	me01: 'MEG', me02: 'PFL', 'me02.5': 'ASC', me03: 'POR', me04: 'CRI', me05: 'PBL', me06: 'DLR',
	sv01: 'SVI', sv02: 'PAL', sv03: 'OBF', 'sv03.5': 'MEW', sv04: 'PAR', 'sv04.5': 'PAF', sv05: 'TEF', sv06: 'TWM', 'sv06.5': 'SFA', sv07: 'SCR', sv08: 'SSP', 'sv08.5': 'PRE', sv09: 'JTG', sv10: 'DRI', 'sv10.5b': 'BLK', 'sv10.5w': 'WHT',
	swsh1: 'SSH', swsh2: 'RCL', swsh3: 'DAA', 'swsh3.5': 'CPA', swsh4: 'VIV', 'swsh4.5': 'SHF', swsh5: 'BST', swsh6: 'CRE', swsh7: 'EVS', swsh8: 'FST', swsh9: 'BRS', swsh10: 'ASR', 'swsh10.5': 'PGO', swsh11: 'LOR', swsh12: 'SIT', 'swsh12.5': 'CRZ',
	sm1: 'SUM', sm2: 'GRI', sm3: 'BUS', 'sm3.5': 'SLG', sm4: 'CIN', sm5: 'UPR', sm6: 'FLI', sm7: 'CES', 'sm7.5': 'DRM', sm8: 'LOT', sm9: 'TEU', sm10: 'UNB', sm11: 'UNM', sm115: 'HIF', sm12: 'CEC',
};

// The code printed on an international set's cards ("CRI" for me04), or
// null. Offline-safe: it needs no set list. The Japanese, Korean, and
// Chinese catalogs have none here.
export const printedSetCode = (catalog, setId) => (catalog === 'international' && Object.hasOwn(PRINTED_CODES, setId) && PRINTED_CODES[setId]) || null;

// The codes the Shop's set filter shows before a set's name as well (Eric,
// 2026-11-24: he keeps his cards apart by set), for the older Western sets,
// their promos, and the trainer kits. Only the Shop reads this table: several
// codes are short words ("EX" for Expedition, "SV" for Supreme Victors,
// "DP"), and card search, whose set list takes PRINTED_CODES alone, would
// read such a word typed beside a number as the set. Every value is TCGdex's
// abbreviation.official for that set ID, checked 2026-11-24 against
// https://api.tcgdex.net/v2/en/sets/<id>. A set TCGdex has none for, and
// every Japanese, Korean, or Chinese set, shows its name alone.
const OLDER_CODES = {
	'2011bw': 'MCD11', '2012bw': 'MCD12', '2014xy': 'MCD14', '2015xy': 'MCD15', '2016xy': 'MCD16',
	'2017sm': 'MCD17', '2018sm': 'MCD18', '2019sm': 'MCD19', '2021swsh': 'MCD21', '2022swsh': 'MCD22',
	'2023sv': 'MCD23', '2024sv': 'MCD24', '30th': '30C', '30th-c': '30C', base1: 'BS', base2: 'JU',
	base3: 'FO', base4: 'B2', base5: 'RO', bw1: 'BLW', bw10: 'PLB', bw11: 'LTR', bw2: 'EP', bw3: 'NVI',
	bw4: 'NXD', bw5: 'DEX', bw6: 'DRX', bw7: 'BCR', bw8: 'PLS', bw9: 'PLF', bwp: 'BWP', cel25: 'CEL',
	cel25cc: 'CEL:CC', col1: 'COL', dc1: 'DCR', det1: 'DET', dp1: 'DP', dp2: 'MT', dp3: 'SW', dp4: 'GE',
	dp5: 'MD', dp6: 'LA', dp7: 'SF', dv1: 'DRV', ecard1: 'EX', ecard2: 'AQ', ecard3: 'SK', ex1: 'RS',
	ex10: 'UF', ex11: 'DS', ex12: 'LM', ex13: 'HP', ex14: 'CG', ex15: 'DF', ex16: 'PK', ex2: 'SS',
	ex3: 'DR', ex4: 'MA', ex5: 'HL', ex6: 'RG', ex7: 'TR', ex8: 'DX', ex9: 'EM', fut2020: 'FUT20',
	g1: 'GEN', gym1: 'G1', gym2: 'G2', hgss1: 'HS', hgss2: 'UL', hgss3: 'UND', hgss4: 'TRI', lc: 'LC',
	mee: 'MEE', mep: 'MEP', mfb: 'MFB', neo1: 'N1', neo2: 'N2', neo3: 'N3', neo4: 'N4', pl1: 'PL',
	pl2: 'RR', pl3: 'SV', pl4: 'AR', pop1: 'P1', pop2: 'P2', pop3: 'P3', pop4: 'P4', pop5: 'P5',
	pop6: 'P6', pop7: 'P7', pop8: 'P8', pop9: 'P9', ru1: 'RM', si1: 'SI', smp: 'SMP', sve: 'SVE',
	svp: 'SVP', swsh10tg: 'ASR:TG', swsh11tg: 'LOR:TG', 'swsh12.5gg': 'CRZ:GG', swsh12tg: 'SIT:TG',
	'swsh4.5sv': 'SHF:SV', swsh9tg: 'BRS:TG', 'tk-bw-e': 'TK5E', 'tk-bw-z': 'TK5Z', 'tk-dp-l': 'TK3L',
	'tk-dp-m': 'TK3M', 'tk-ex-latia': 'TK1A', 'tk-ex-latio': 'TK1O', 'tk-ex-m': 'TK2M',
	'tk-ex-p': 'TK2P', 'tk-hs-g': 'TK4G', 'tk-hs-r': 'TK4R', 'tk-sm-l': 'TK10L', 'tk-sm-r': 'TK10A',
	'tk-xy-b': 'TK7A', 'tk-xy-latia': 'TK8A', 'tk-xy-latio': 'TK8O', 'tk-xy-n': 'TK6N',
	'tk-xy-p': 'TK9P', 'tk-xy-su': 'TK9S', 'tk-xy-sy': 'TK6S', 'tk-xy-w': 'TK7B', xy0: 'KSS', xy1: 'XY',
	xy10: 'FCO', xy11: 'STS', xy12: 'EVO', xy2: 'FLF', xy3: 'FFI', xy4: 'PHF', xy5: 'PRC', xy6: 'ROS',
	xy7: 'AOR', xy8: 'BKT', xy9: 'BKP', xyp: 'XYP',
};

export const shopSetCode = (catalog, setId) => printedSetCode(catalog, setId)
	|| (catalog === 'international' && Object.hasOwn(OLDER_CODES, setId) && OLDER_CODES[setId])
	|| null;

// The Shop's set filter marks a set the way its cards do (Eric, 2026-11-24:
// he sorts his cards by what is printed on them). English cards print only a
// pictorial set symbol up to Sword & Shield, and a code ("SVI EN") from
// Scarlet & Violet on (Pokebeach, 2023). So a Scarlet & Violet or Mega
// Evolution set shows its code, and an older Western set its symbol, from
// the set list (setFacts). A gallery subset (swsh9tg, swsh12.5gg, the
// swsh4.5sv Shiny Vault) has no symbol of its own on TCGdex; its cards carry
// the main set's. With no symbol known, the code shows, as it does when the
// symbol's image fails to load. Japanese, Korean, and Chinese sets get none.
const CODE_SERIES = new Set(['me', 'sv']);
const GALLERY = /^(swsh\d+(?:\.5)?)(?:gg|sv|tg)$/;

// {id: {serie, symbol}} from a set list (setList data), for shopSetMark.
export const setFacts = (series) => new Map((series || []).flatMap((serie) => (serie.sets || []).map((set) => [set.id, {serie: serie.id, symbol: set.symbol || null}])));

// {code, symbol}: the code to show, and the symbol's image address, each or
// null. facts is setFacts of the English set list, or an empty Map.
export function shopSetMark(catalog, setId, facts = new Map()) {
	if (catalog !== 'international' || !setId) {
		return {code: null, symbol: null};
	}

	const gallery = GALLERY.exec(setId);
	const own = facts.get(setId) || null;
	const host = gallery ? facts.get(gallery[1]) || null : own;
	const serie = (own && own.serie) || (host && host.serie) || null;
	const symbol = host && host.symbol && !CODE_SERIES.has(serie) ? logoImage(host.symbol) : null;

	return {code: shopSetCode(catalog, setId), symbol};
}

// A set's printed code (printedSetCode), or null: js/shop.js matches a
// hand-made copy's set code with it.
export const printedCode = (setId) => printedSetCode('international', setId);

// A Western set's English logo, for a language TCGdex has no logo for
// (2026-11-20: Fagulhas Impetuosas, Fogo Branco, Raio Preto, and EX O
// Retorno da Equipe Rocket have none in Portuguese). TCGdex's English logos
// sit at en/<series>/<set>/logo; when that is missing too (the 30th
// Celebration has none in either), the tile's image fails and shows the
// set's name, as for any set with no logo. Japanese, Korean, and Chinese
// sets have their own IDs, so they get none.
export const englishLogo = (lang, serieId, setId) => (lang === 'en' || ASIAN_LANGUAGES.includes(lang) ? null : `https://assets.tcgdex.net/en/${serieId}/${setId}/logo`);

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
			logo: set.logo || englishLogo(lang, serie.id, set.id),
			name: set.name,
			releaseRank: rank.has(set.id) ? rank.get(set.id) : null,
			// The set symbol's base address (logoImage adds .webp), for the
			// Shop's set filter. A list saved before this field gains it
			// when it is next refreshed.
			symbol: set.symbol || null,
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

// What this phone holds, with no request, for Phone check's set check
// (js/set-check.js): the saved set list in `lang` ({at, data}), and the
// saved set record under the key setDetail and importApi.setDetail share
// ({at, data}, or {at, missing: true} when TCGdex last answered 404). Null
// when nothing is saved.
export const savedSetList = async (lang) => (await cacheGet(`setlist4:${lang}`)) || null;

export async function savedSetRecord(lang, setId) {
	const hit = await cacheGet(`set:${lang}:${setId}`);

	if (hit) {
		return hit;
	}

	const missing = await cacheGet(`missing:set:${lang}:${setId}`);

	return missing ? {at: missing.at, missing: true} : null;
}

// The set records and full card records saved on this phone, as {sets:
// [{lang, set}], cards: [{lang, card}]}, read with no request: what the Sets
// tab's card search looks through offline (js/card-search.js). Empty when
// the store cannot be read.
export async function savedCatalog() {
	const read = async (prefix) => {
		const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
		const [keys, values] = await Promise.all([
			cacheDb.run(STORE, 'readonly', (s) => s.getAllKeys(range)),
			cacheDb.run(STORE, 'readonly', (s) => s.getAll(range)),
		]);

		// "set:<lang>:<set id>" and "card:<lang>:<card id>".
		return (keys || []).map((key, i) => ({data: values[i] && values[i].data, lang: String(key).split(':')[1]})).filter((row) => row.data);
	};

	try {
		const [sets, cards] = await Promise.all([read('set:'), read('card:')]);

		return {cards: cards.map(({data, lang}) => ({card: data, lang})), sets: sets.map(({data, lang}) => ({lang, set: data}))};
	}
	catch {
		return {cards: [], sets: []};
	}
}

// Image URLs. TCGdex gives a base URL; the format and size are appended.
export const cardImage = (base, size) => (base ? `${base}/${size}.webp` : null);

export const logoImage = (base) => (base ? `${base}.webp` : null);

// A card's picture from its index record (cardIndex): the first language in
// `preferred` that has one, then any language that has one. A localization
// saved with no picture (TCGdex had none yet, or the print has none in that
// language) never leaves a tile blank while another language has one, as
// the card page, which reads the card fresh, already shows.
export function pictureOf(record, preferred) {
	const localizations = (record && record.localizations) || {};

	for (const lang of preferred) {
		if (lang && localizations[lang] && localizations[lang].image) {
			return localizations[lang].image;
		}
	}

	const any = Object.values(localizations).find((local) => local && local.image);

	return any ? any.image : null;
}

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
const readAgain = new Set();

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

		await putFetched(key, data);

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
	// A set's list read again from TCGdex and saved over the old one, for a
	// saved list that lacks cards someone owns: a new set saved before
	// TCGdex listed all its cards is otherwise never read again here (the
	// Sets views refresh only the language they browse in). At most once
	// per set per visit, and never offline; null when not read.
	setDetailAgain: async (lang, setId) => {
		const key = `set:${lang}:${setId}`;

		if (readAgain.has(key) || !navigator.onLine) {
			return null;
		}

		readAgain.add(key);

		const data = await getJson(`${lang}/sets/${encodeURIComponent(setId)}`, 4);

		await putFetched(key, data);

		return data;
	},
};

// Whether TCGdex lists the set `setId` in `lang`: true, false (it answered
// 404, now or when last asked, so a phone with no signal still knows from
// what it has), or null when that is not known (never asked, and no
// signal). Portuguese, for one, has Base Set to Fossil but not Base Set 2,
// Team Rocket, or Legendary Collection (2026-11-19), so a Portuguese copy
// of a Spearow whose artwork those share is offered as the Jungle print
// first (js/scan/picture.js pictureMatch heldIn). A 404 is not proof the
// print does not exist in that language, as TCGdex leaves many old sets
// out of its Portuguese, so it only orders.
export async function setHeldIn(lang, setId) {
	try {
		return Boolean(await importApi.setDetail(lang, setId));
	}
	catch {
		const missing = await cacheGet(`missing:set:${lang}:${setId}`).catch(() => null);

		return missing ? false : null;
	}
}

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
	const stored = await readSaved([...wanted].flatMap(([key, langs]) => [...langs].map((lang) => `card:${lang}:${cardId(key)}`)));

	if (!stored) {
		return new Map();
	}

	const found = new Map();

	// In the order the reads were asked: the English record wins, else the
	// first language that has one.
	for (const [key, langs] of wanted) {
		for (const lang of langs) {
			const hit = stored.get(`card:${lang}:${cardId(key)}`);
			const record = hit && hit.data;

			if (record && record.id && (!found.has(key) || lang === 'en')) {
				found.set(key, record);
			}
		}
	}

	return found;
}

// The stored values of `keys` (card records and their 404 marks), from
// this visit's reads where it has them and from IndexedDB in one
// transaction otherwise: a Map of key to {at, data} or null. Null when the
// store cannot be read.
async function readSaved(keys) {
	const out = new Map();
	const asked = [];

	for (const key of keys) {
		if (savedMemo.has(key)) {
			out.set(key, savedMemo.get(key));
		}
		else if (!out.has(key)) {
			out.set(key, null);
			asked.push(key);
		}
	}

	if (!asked.length) {
		return out;
	}

	listenForRecords();

	const began = memoTurn;

	try {
		const db = await cacheDb.open();

		await new Promise((resolve, reject) => {
			const tx = db.transaction(STORE, 'readonly');
			const store = tx.objectStore(STORE);
			const read = (list) => {
				for (const key of list) {
					const request = store.get(key);

					request.onsuccess = () => {
						out.set(key, request.result ?? null);
					};
				}
			};

			// Many keys at once (a screen over every owned card): the keys
			// stored under each prefix are listed first, in the same
			// transaction, and only the ones there are read. Each read is a
			// round trip of its own, about 0.8 ms on a slow phone, and most
			// cards have no 404 mark and no record in a second language.
			if (asked.length < MANY_KEYS) {
				read(asked);
			}
			else {
				const prefixes = ['card:', 'missing:card:'];
				const other = asked.filter((key) => !prefixes.some((prefix) => key.startsWith(prefix)));

				read(other);

				for (const prefix of prefixes) {
					const mine = asked.filter((key) => key.startsWith(prefix));

					if (!mine.length) {
						continue;
					}

					const listing = store.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`));

					listing.onsuccess = () => {
						const held = new Set(listing.result || []);

						read(mine.filter((key) => held.has(key)));
					};
				}
			}

			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	}
	catch {
		return null;
	}

	for (const key of asked) {
		keepRead(key, out.get(key), began);
	}

	return out;
}

// The full TCGdex records saved on this phone in each copy's own language,
// keyed "card:<lang>:<card id>" (the key importApi.cardDetail saves under),
// with no request: the photo cleanup (js/photo-cleanup.js) judges a French
// copy by its French record, never the English one. A copy on another
// catalog's record (a Korean copy on a Japanese one) has none.
export async function savedOwnRecords(entries) {
	const found = new Map();

	for (const entry of entries || []) {
		const catalog = entry.catalog || 'international';
		const lang = entry.language || catalogLanguage(catalog);
		const key = `card:${lang}:${entry.card_id}`;

		if (catalogFor(lang) !== catalog || found.has(key)) {
			continue;
		}

		const hit = await cacheGet(key).catch(() => null);

		if (hit && hit.data && hit.data.id) {
			found.set(key, hit.data);
		}
	}

	return found;
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
// numbers, energy types, category, rarity, and illustrator. One GraphQL request per
// owned set reads them for the whole set (DESIGN.md section 11, "Filters
// and Sorting"); Japanese, Korean, and Chinese sets are read in their own
// catalog with the @locale directive, and their types and rarities come in
// English like the international ones. A set's answer is kept on the phone
// and asked again after a week only when an owned card was missing from it
// (TCGdex fills a new set in over a few weeks).
const DETAILS_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const DETAIL_FIELDS = 'id dexId types category rarity illustrator';

// A record read before the artist was asked for (v46) is read once more.
export const hasDetails = (record) => Boolean(record) && typeof record.category === 'string' && Object.hasOwn(record, 'illustrator');

// A Pokémon read with no Pokédex number: TCGdex lists a new set's cards
// before it fills in their dexId (30th Celebration, 2026-11-20: 147 owned
// Pokémon saved with none, so a 30th Mew was missing from the Kanto list).
// Its details, and the checklists' dex map, are read again after
// DEX_PENDING_RECHECK_MS rather than a week or a month. A Trainer or Energy
// has no number by nature and is never pending.
export const dexPending = (record) => Boolean(record) && record.category === 'Pokemon' && !(Array.isArray(record.dex_ids) && record.dex_ids.length);

export const DEX_PENDING_RECHECK_MS = 12 * 60 * 60 * 1000;

export const setIdOfCard = (cardId) => {
	const cut = String(cardId).lastIndexOf('-');

	return cut > 0 ? String(cardId).slice(0, cut) : null;
};

export function cardDetailsQuery(catalog, setId) {
	const locale = catalog === 'international' ? '' : ` @locale(lang: ${JSON.stringify(catalogLanguage(catalog))})`;

	return `{ cards(filters: {id: ${JSON.stringify(`${setId}-`)}}, pagination: {page: 1, itemsPerPage: 1000})${locale} { ${DETAIL_FIELDS} } }`;
}

// {cardId: {dex_ids, types, category, rarity, illustrator}} from a set's GraphQL answer.
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
			illustrator: typeof card.illustrator === 'string' && card.illustrator.trim() ? card.illustrator.trim() : null,
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

		if (!entry.card_id || (hasDetails(record) && !dexPending(record))) {
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
	// details2: the answers saved before the artist was asked for are not kept.
	const key = `details2:${catalog}:${setId}`;
	const hit = await cacheGet(key);
	const lacks = hit && [...ids].some((id) => !Object.hasOwn(hit.data || {}, id));
	// An owned Pokémon the saved answer gave no Pokédex number (dexPending).
	const pending = hit && [...ids].some((id) => dexPending((hit.data || {})[id]));
	const stale = hit && ((lacks && now - hit.at >= DETAILS_RECHECK_MS) || (pending && now - hit.at >= DEX_PENDING_RECHECK_MS));

	if (hit && (!stale || !navigator.onLine)) {
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
	catch (err) {
		// TCGdex answered that it has no such set (a 404, or another refusal
		// a later try would not change): that is an answer, with no card in it,
		// not a failed read. It is kept like any answer, and asked again after
		// a week (above). A failed read (no connection, a server error, a 429)
		// gives the saved answer, else null.
		if (!hit && err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500 && !err.network) {
			await cachePut(key, {});

			return {};
		}

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

		if (entry.language && !ASIAN_LANGUAGES.includes(entry.language)) {
			wanted.get(entry.card_id).add(entry.language);
		}
	}

	if (!wanted.size) {
		return [];
	}

	const stored = await readSaved([...wanted].flatMap(([cardId, langs]) => [...[...langs].map((lang) => `card:${lang}:${cardId}`), `missing:card:en:${cardId}`]));

	if (!stored) {
		return [];
	}

	const found = new Map();

	for (const [cardId, langs] of wanted) {
		for (const lang of langs) {
			const hit = stored.get(`card:${lang}:${cardId}`);

			if (hit && hit.data && hit.data.id) {
				found.set(cardId, Math.max(found.get(cardId) || 0, hit.at || 0));
			}
		}

		const missing = stored.get(`missing:card:en:${cardId}`);

		if (missing && now - missing.at < MISSING_FOR_MS && !found.has(cardId)) {
			found.set(cardId, -1);
		}
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
				await putFetched(`card:${lang}:${cardId}`, record);

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
