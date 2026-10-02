// Pokémon checklists (DESIGN.md section 11, "Pokémon checklists"): a goal
// over a list of National Dex numbers, ticked automatically from the owned
// cards and by hand.
//
// A checklist is an entry in the person's goals list (DESIGN.md section 4):
//   {id, kind, target, level, name, dex_list, hand_ticks,
//    created_at, updated_at, deleted_at}
// kind is region (target is a region id), every_pokemon, or custom_pokemon
// (dex_list holds the numbers). hand_ticks maps a dex number to the time it
// was ticked. Only the definition is stored; what is owned is computed.
//
// No DOM here, so Node can load the pure parts (regions, tallying).

import {LANGUAGES, cardIndex, catalogLanguage, importApi, indexKey, isLanguage} from './catalog.js';
import {isLive, loadDocument, mergeIntoLocal, newId, nowIso} from './collection.js';
import {nextStamp} from './merge.js';

export const MAX_DEX = 1025;

// National Dex ranges.
export const REGIONS = [
	{first: 1, id: 'kanto', last: 151, name: 'Kanto'},
	{first: 152, id: 'johto', last: 251, name: 'Johto'},
	{first: 252, id: 'hoenn', last: 386, name: 'Hoenn'},
	{first: 387, id: 'sinnoh', last: 493, name: 'Sinnoh'},
	{first: 494, id: 'unova', last: 649, name: 'Unova'},
	{first: 650, id: 'kalos', last: 721, name: 'Kalos'},
	{first: 722, id: 'alola', last: 809, name: 'Alola'},
	{first: 810, id: 'galar', last: 898, name: 'Galar'},
	{first: 899, id: 'hisui', last: 905, name: 'Hisui'},
	{first: 906, id: 'paldea', last: 1025, name: 'Paldea'},
];

export const CHECKLIST_KINDS = ['region', 'every_pokemon', 'custom_pokemon'];

const range = (first, last) => Array.from({length: last - first + 1}, (_, i) => first + i);

const validDex = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_DEX;

export const regionById = (id) => REGIONS.find((region) => region.id === id) || null;

export const isChecklist = (goal) => Boolean(goal) && CHECKLIST_KINDS.includes(goal.kind);

// The numbers a checklist covers, in Dex order.
export function checklistDex(goal) {
	if (!goal) {
		return [];
	}

	if (goal.kind === 'every_pokemon') {
		return range(1, MAX_DEX);
	}

	if (goal.kind === 'region') {
		const region = regionById(goal.target);

		return region ? range(region.first, region.last) : [];
	}

	if (goal.kind === 'custom_pokemon') {
		return [...new Set((goal.dex_list || []).map(Number).filter(validDex))].sort((a, b) => a - b);
	}

	return [];
}

// Hand ticks as a Set of numbers.
export function handTicks(goal) {
	return new Set(Object.keys((goal && goal.hand_ticks) || {}).map(Number).filter(validDex));
}

export const dexLabel = (n) => `#${String(n).padStart(3, '0')}`;

// owned and hand-ticked counts for one checklist. A number owned and also
// ticked by hand counts once, as owned.
export function progress(goal, byDex) {
	const dex = checklistDex(goal);
	const hand = handTicks(goal);
	let owned = 0;
	let byHand = 0;

	for (const n of dex) {
		if (byDex.has(n)) {
			owned++;
		}
		else if (hand.has(n)) {
			byHand++;
		}
	}

	return {byHand, missing: dex.length - owned - byHand, owned, ticked: owned + byHand, total: dex.length};
}

// ------------------------------------------------------------- saving
//
// js/collection.js has no generic save for lists other than cards, so a
// changed goal entry is merged in through mergeIntoLocal, the same entry by
// entry merge a sync uses: the entry carries a newer updated_at, so it wins.
// That save is marked as coming from the sync, which does not schedule a
// push, so this module asks the sync to run a moment later. The sync counts
// the entry as changed against what the server last held and pushes it;
// signed out or offline, it waits on the phone like any other edit.

const PUSH_DELAY_MS = 2000;

let pushTimer = null;

function schedulePush() {
	clearTimeout(pushTimer);
	pushTimer = setTimeout(() => {
		import('./sync.js')
			.then((sync) => sync.syncNow())
			.catch(() => {
				// The next sync (opening the app, coming back online) pushes it.
			});
	}, PUSH_DELAY_MS);
}

async function saveGoal(entry) {
	await mergeIntoLocal({goals: [entry]});
	schedulePush();

	return entry;
}

export async function listChecklists() {
	const doc = await loadDocument();

	return doc.goals.filter((goal) => isLive(goal) && isChecklist(goal));
}

export async function getChecklist(id) {
	return (await listChecklists()).find((goal) => goal.id === id) || null;
}

// Changes run one at a time, each reading the entry the last one saved, so
// two quick taps cannot overwrite each other's tick.
let queue = Promise.resolve();

function serial(work) {
	const run = queue.then(work, work);

	queue = run.catch(() => {});

	return run;
}

const changeChecklist = (id, change) => serial(async () => {
	const goal = await getChecklist(id);

	if (!goal) {
		throw new Error('This list is not on this phone. It may have been deleted.');
	}

	// A copy: the merge compares versions, so the stored entry must not be
	// changed in place.
	const next = structuredClone(goal);

	change(next);
	next.updated_at = nextStamp(goal.updated_at);

	// A delete carries the same stamp, so it is never older than the version
	// it removed.
	if (next.deleted_at && !goal.deleted_at) {
		next.deleted_at = next.updated_at;
	}

	return saveGoal(next);
});

// kind region: {target}; custom_pokemon: {dex_list}; every_pokemon: nothing.
export async function createChecklist({dex_list = null, kind, name, target = null}) {
	if (!CHECKLIST_KINDS.includes(kind)) {
		throw new Error(`Unknown checklist kind ${kind}.`);
	}

	if (kind === 'region' && !regionById(target)) {
		throw new Error(`Unknown region ${target}.`);
	}

	const list = kind === 'custom_pokemon' ? [...new Set((dex_list || []).map(Number).filter(validDex))].sort((a, b) => a - b) : null;

	if (kind === 'custom_pokemon' && !list.length) {
		throw new Error('Pick at least one Pokémon.');
	}

	const at = nowIso();

	return serial(() => saveGoal({
		created_at: at,
		deleted_at: null,
		dex_list: list,
		hand_ticks: {},
		id: newId(),
		kind,
		level: null,
		name: String(name || '').trim() || defaultName(kind, target),
		target: kind === 'region' ? target : null,
		updated_at: at,
	}));
}

export function defaultName(kind, target) {
	if (kind === 'every_pokemon') {
		return 'Every Pokémon';
	}

	if (kind === 'region') {
		return (regionById(target) || {name: 'Region'}).name;
	}

	return 'My list';
}

export const renameChecklist = (id, name) => changeChecklist(id, (goal) => {
	const trimmed = String(name || '').trim();

	if (!trimmed) {
		throw new Error('A list needs a name.');
	}

	goal.name = trimmed;
});

export const setDexList = (id, dexList) => changeChecklist(id, (goal) => {
	const list = [...new Set((dexList || []).map(Number).filter(validDex))].sort((a, b) => a - b);

	if (!list.length) {
		throw new Error('Pick at least one Pokémon.');
	}

	goal.dex_list = list;
});

// Soft delete: the entry stays as a tombstone, so a phone holding an older
// copy cannot bring the list back.
export const deleteChecklist = (id) => changeChecklist(id, (goal) => {
	goal.deleted_at = nowIso();
});

export const setHandTick = (id, dex, on) => changeChecklist(id, (goal) => {
	const ticks = {...(goal.hand_ticks || {})};

	if (on) {
		ticks[dex] = nowIso();
	}
	else {
		delete ticks[dex];
	}

	goal.hand_ticks = ticks;
});

// ------------------------------------------------------ list languages
//
// Each list's languages (DESIGN.md section 11, "Every card of a Pokémon"):
// the prints a Pokémon's cards screen shows (js/pokemon-cards.js), and the
// languages a copy must be in to count as owned there. Stored on the goal
// as languages, a list of language codes. A list with none names no
// languages and counts a copy in any language, the way its checklist ticks:
// whether a list's languages decide its ticks is still open
// (plans/roadmap.md, "Open Decisions for Eric").

export const ALL_LIST_LANGUAGES = LANGUAGES.map((lang) => lang.code);

const cleanLanguages = (languages) => [...new Set((Array.isArray(languages) ? languages : []).filter(isLanguage))];

// Whether the list names its own languages.
export const namesLanguages = (goal) => cleanLanguages(goal && goal.languages).length > 0;

// The list's languages; every language for a list that names none.
export function listLanguages(goal) {
	const saved = cleanLanguages(goal && goal.languages);

	return saved.length ? saved : [...ALL_LIST_LANGUAGES];
}

export const setListLanguages = (id, languages) => changeChecklist(id, (goal) => {
	const list = cleanLanguages(languages);

	if (!list.length) {
		throw new Error('Pick at least one language.');
	}

	goal.languages = list;
});

// The live copies a list counts: those in one of its languages.
export const entriesInLanguages = (entries, languages) => {
	const allowed = new Set(languages);

	return (entries || []).filter((entry) => isLive(entry) && allowed.has(entry.language));
};

// ------------------------------------------------------------ the cache

const DB_NAME = 'card-tracker-checklists';
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
		// Not cached; the next open fetches again.
	}
}

// ----------------------------------------------------------- fetching

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BACKOFF_MS = [1000, 3000, 8000];

const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

// fetch with polite retries: TCGdex answers 503 now and then (DESIGN.md
// section 5), so a server error or a dropped connection is retried after 1,
// 3, then 8 seconds.
async function fetchJson(url, init, attempts = 4) {
	for (let attempt = 1; ; attempt++) {
		let response;

		try {
			response = await fetch(url, init);
		}
		catch (err) {
			if (attempt < attempts && online()) {
				await wait(BACKOFF_MS[attempt - 1] || 8000);

				continue;
			}

			throw err;
		}

		if ((response.status >= 500 || response.status === 429) && attempt < attempts) {
			await wait(BACKOFF_MS[attempt - 1] || 8000);

			continue;
		}

		if (!response.ok) {
			const err = new Error(`${new URL(url).hostname} answered ${response.status}.`);

			err.status = response.status;

			throw err;
		}

		return response.json();
	}
}

const postGraphql = (url, query) => fetchJson(url, {
	body: JSON.stringify({query}),
	headers: {'content-type': 'application/json'},
	method: 'POST',
});

// ------------------------------------------------ which Pokémon is owned
//
// Entries store card_id and catalog, not dex numbers, so each owned card is
// resolved to the National Dex numbers on its TCGdex record (dexId, a list:
// TAG TEAM cards hold several).
//
// The international catalog: one request. TCGdex's GraphQL endpoint returns
// the id and dexId of every card in one response ({cards {id dexId}}, about
// 24,000 cards and 750 KB on 2026-10-01), where the REST API needs one
// request per card or per Pokémon. It is kept in IndexedDB and fetched again
// only when an owned card is missing from it (a new set) and the copy is
// more than 12 hours old, or once it is 30 days old.
//
// GraphQL answers in English only, so Japanese, Korean, and Chinese cards are
// read one card at a time (cache first, shared with the card detail view),
// four at a time. So is any international card the bulk list lacks, up to
// SINGLE_CARD_LIMIT a visit.

const TCGDEX_GRAPHQL = 'https://api.tcgdex.net/v2/graphql';
const INTERNATIONAL_KEY = 'dexmap:international';
const REFETCH_FOR_NEW_AFTER_MS = 12 * 60 * 60 * 1000;
const REFETCH_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const SINGLE_CARD_LIMIT = 300;
const CONCURRENCY = 4;

// GraphQL cards -> {cardId: [dex, ...]}; a card with no dexId (a Trainer or
// an Energy) maps to an empty list, so it reads as known.
export function dexMapFrom(json) {
	const cards = (json && json.data && json.data.cards) || null;

	if (!Array.isArray(cards)) {
		throw new Error('TCGdex sent no card list.');
	}

	const map = {};

	for (const card of cards) {
		if (card && card.id) {
			map[card.id] = Array.isArray(card.dexId) ? card.dexId.filter(validDex) : [];
		}
	}

	return map;
}

export const fetchInternationalDexMap = async () => dexMapFrom(await postGraphql(TCGDEX_GRAPHQL, '{ cards { id dexId } }'));

// The map stays in memory for the visit after its first read: it is large,
// and every list view needs it.
let mapMemo = null;
let lastFailure = 0;
let download = null;

const RETRY_LIST_AFTER_MS = 5 * 60 * 1000;

async function internationalMap(ids, onProgress, force) {
	const hit = mapMemo || await cacheGet(INTERNATIONAL_KEY);

	mapMemo = hit || null;

	const age = hit ? Date.now() - hit.at : Infinity;
	const unknown = hit ? ids.filter((id) => !(id in hit.data)).length : ids.length;
	const due = !hit || age > REFETCH_AFTER_MS || (unknown > 0 && age > REFETCH_FOR_NEW_AFTER_MS);

	// After a failed download, wait a few minutes before the next try, so
	// moving between views does not download it again and again.
	if (!due || !online() || !ids.length || (!force && Date.now() - lastFailure < RETRY_LIST_AFTER_MS)) {
		return {error: null, map: hit ? hit.data : null};
	}

	onProgress({stage: 'list'});

	// Two screens asking at once share one download.
	if (!download) {
		download = (async () => {
			try {
				const map = await fetchInternationalDexMap();

				mapMemo = {at: Date.now(), data: map};
				await cachePut(INTERNATIONAL_KEY, map);

				return {error: null, map};
			}
			catch (err) {
				lastFailure = Date.now();

				return {error: err, map: null};
			}
		})().finally(() => {
			download = null;
		});
	}

	const result = await download;

	return result.map ? result : {error: result.error, map: hit ? hit.data : null};
}

// The bulk map itself, for the screen that lists every card of a Pokémon
// (js/pokemon-cards.js): the copy on the phone while it is under 30 days
// old, else a download, shared with any download already running. The
// copy on the phone is returned when the download fails. {error, map}
export async function internationalDexMap({force = false, onProgress = () => {}} = {}) {
	const hit = mapMemo || await cacheGet(INTERNATIONAL_KEY);

	mapMemo = hit || null;

	if (hit && Date.now() - hit.at <= REFETCH_AFTER_MS) {
		return {error: null, map: hit.data};
	}

	// No card ID is empty, so '' reads as a card the map lacks, which makes
	// internationalMap download it.
	return internationalMap([''], onProgress, force);
}

async function pool(items, size, work) {
	let next = 0;

	await Promise.all(Array.from({length: Math.min(size, items.length)}, async () => {
		while (next < items.length) {
			await work(items[next++]);
		}
	}));
}

const cardKey = (entry) => indexKey(entry.catalog, entry.card_id);

// One request per card even when two screens resolve at once.
const cardRequests = new Map();

function cardDetailShared(lang, cardId) {
	const key = `${lang}|${cardId}`;

	if (!cardRequests.has(key)) {
		cardRequests.set(key, importApi.cardDetail(lang, cardId).finally(() => cardRequests.delete(key)));
	}

	return cardRequests.get(key);
}

// Owned entries by dex number: Map dex -> [entry, ...]. dexOf(entry) returns
// the card's dex numbers, or null when it is not known.
export function tallyOwned(entries, dexOf) {
	const byDex = new Map();

	for (const entry of entries) {
		if (!isLive(entry)) {
			continue;
		}

		for (const n of new Set(dexOf(entry) || [])) {
			if (!byDex.has(n)) {
				byDex.set(n, []);
			}

			byDex.get(n).push(entry);
		}
	}

	return byDex;
}

// Resolves the cards in `entries` to dex numbers. Returns
// {byDex, unresolved, error}: unresolved counts distinct cards whose numbers
// are not known yet (offline before the first visit, or past the per-visit
// limit). force skips the wait after a failed download (Try again).
// onProgress({stage: 'list'}) runs before the bulk download and
// onProgress({stage: 'cards', done, total}) as single cards come in.
export async function resolveOwned(entries, {force = false, isAlive = () => true, onProgress = () => {}} = {}) {
	const live = entries.filter((entry) => isLive(entry) && entry.card_id);
	const cards = new Map();

	for (const entry of live) {
		cards.set(cardKey(entry), {cardId: entry.card_id, catalog: entry.catalog, language: entry.language});
	}

	const known = new Map();
	const international = [...cards.values()].filter((card) => card.catalog === 'international').map((card) => card.cardId);
	const {error, map} = await internationalMap(international, onProgress, force);

	if (map) {
		for (const id of international) {
			if (id in map) {
				known.set(indexKey('international', id), map[id]);
			}
		}
	}

	const singles = [...cards.entries()].filter(([key]) => !known.has(key));
	const wanted = singles.slice(0, SINGLE_CARD_LIMIT);
	let done = 0;

	if (wanted.length) {
		onProgress({done, stage: 'cards', total: wanted.length});
	}

	await pool(wanted, CONCURRENCY, async ([key, card]) => {
		if (!isAlive()) {
			return;
		}

		// A Western card the English list lacks may exist only in its own
		// language (a Brazilian promo), so that is tried second.
		const languages = card.catalog === 'international'
			? [...new Set(['en', card.language].filter((lang) => lang && !['ja', 'ko', 'zh-cn', 'zh-tw'].includes(lang)))]
			: [catalogLanguage(card.catalog)];

		for (const lang of languages) {
			try {
				// Cache first. Offline, a card not saved yet fails at once:
				// the catalog retries only while the phone is online.
				const detail = await cardDetailShared(lang, card.cardId);

				if (detail) {
					known.set(key, Array.isArray(detail.dexId) ? detail.dexId.filter(validDex) : []);
					break;
				}
			}
			catch {
				// Unresolved for this visit.
			}
		}

		done++;
		onProgress({done, stage: 'cards', total: wanted.length});
	});

	const byDex = tallyOwned(live, (entry) => known.get(cardKey(entry)) || null);
	const unresolved = [...cards.keys()].filter((key) => !known.has(key)).length;

	return {byDex, error, unresolved};
}

// ------------------------------------------------------- Pokémon names
//
// Species names in every language the app shows, in one request: PokeAPI's
// GraphQL endpoint gives the official names of all 1,025 species in
// English, Japanese, Japanese romaji (ja-roma), Korean, and Simplified and
// Traditional Chinese (about 460 KB, 7,175 rows, checked 2026-10-01). The
// English ones are display names ("Mr. Mime", "Nidoran♀"); the others give
// Asian prints their English name and reading (js/names.js). When the
// request fails, the REST species list gives the English names as slugs in
// one request too ("mr-mime"), which read well enough capitalized. Kept in
// IndexedDB; names do not change, so it is read once a device, and works
// offline after that.

const POKEAPI_GRAPHQL = 'https://graphql.pokeapi.co/v1beta2';
const POKEAPI_SPECIES = `https://pokeapi.co/api/v2/pokemon-species?limit=${MAX_DEX}`;
const NAMES_KEY = 'names:v2';

// The English-only list an earlier version kept, read while offline.
const OLD_NAMES_KEY = 'names:en';

// PokeAPI's language IDs (its language table, 2026-10-01).
const NAME_LANGUAGES = {2: 'ja-roma', 3: 'ko', 4: 'zh-hant', 9: 'en', 11: 'ja', 12: 'zh-hans'};

const emptyNames = () => Array(MAX_DEX + 1).fill(null);

const emptyTables = () => Object.fromEntries(Object.values(NAME_LANGUAGES).map((language) => [language, emptyNames()]));

const complete = (names) => Boolean(names) && names.filter(Boolean).length >= MAX_DEX;

const titleCase = (slug) => slug.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');

export const speciesNamesQuery = () =>
	`{ pokemonspeciesname(where: {language_id: {_in: [${Object.keys(NAME_LANGUAGES).join(', ')}]}, pokemon_species_id: {_lte: ${MAX_DEX}}}) { language_id name pokemon_species_id } }`;

// GraphQL rows -> tables. A row with no language the app reads is skipped.
export function speciesTablesFrom(json, tables = emptyTables()) {
	for (const row of (json && json.data && json.data.pokemonspeciesname) || []) {
		const language = NAME_LANGUAGES[row && row.language_id];

		if (language && validDex(row.pokemon_species_id) && row.name) {
			tables[language][row.pokemon_species_id] = row.name;
		}
	}

	return tables;
}

// {tables, final}: final when GraphQL answered with every English name, so
// the set is kept for good. A species PokeAPI has no name for in some
// language stays null there; it does not make the phone ask again.
async function fetchNames() {
	const tables = emptyTables();
	let answered = false;

	try {
		speciesTablesFrom(await postGraphql(POKEAPI_GRAPHQL, speciesNamesQuery()), tables);
		answered = true;
	}
	catch {
		// Fall back to the slugs below.
	}

	const final = answered && complete(tables.en);

	if (!complete(tables.en)) {
		try {
			const json = await fetchJson(POKEAPI_SPECIES);

			for (const row of (json && json.results) || []) {
				const n = Number((/\/(\d+)\/?$/.exec(row.url) || [])[1]);

				if (validDex(n) && !tables.en[n]) {
					tables.en[n] = titleCase(row.name);
				}
			}
		}
		catch {
			// Numbers only until the next visit with a connection.
		}
	}

	return {final, tables};
}

const known = (tables) => Object.values(tables).reduce((sum, names) => sum + names.filter(Boolean).length, 0);

let namesPromise = null;
let namesFinal = false;

// {en, ja, 'ja-roma', ko, 'zh-hans', 'zh-hant'}, each an array indexed by
// dex number; a name not known yet is null.
export function speciesNames() {
	if (!namesPromise) {
		namesPromise = (async () => {
			const hit = await cacheGet(NAMES_KEY);

			if (hit && hit.data.final) {
				namesFinal = true;

				return hit.data.tables;
			}

			if (!online()) {
				if (hit) {
					return hit.data.tables;
				}

				const old = await cacheGet(OLD_NAMES_KEY);

				return {...emptyTables(), en: old ? old.data : emptyNames()};
			}

			const {final, tables} = await fetchNames();

			// A copy no better than the saved one is not kept.
			if (hit && !final && known(hit.data.tables) >= known(tables)) {
				return hit.data.tables;
			}

			if (known(tables)) {
				await cachePut(NAMES_KEY, {final, tables});
			}

			namesFinal = final;

			return tables;
		})().catch(() => emptyTables());

		// A partial set is tried again on the next view.
		namesPromise.then(() => {
			if (!namesFinal) {
				namesPromise = null;
			}
		});
	}

	return namesPromise;
}

// The English names alone: an array indexed by dex number.
export const pokemonNames = async () => (await speciesNames()).en || emptyNames();

export const nameOf = (names, n) => (names && names[n]) || `Pokémon ${dexLabel(n)}`;

// Sprites from the PokeAPI sprite repository.
export const spriteUrl = (n) => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${n}.png`;

// The catalog records for the owned cards of one Pokémon, for the list a
// tap opens: [{entries, record, catalog, cardId}], one per card.
export async function ownedCards(entries) {
	const index = await cardIndex();
	const byCard = new Map();

	for (const entry of entries) {
		const key = cardKey(entry);

		if (!byCard.has(key)) {
			byCard.set(key, {cardId: entry.card_id, catalog: entry.catalog, entries: [], record: index.get(key) || null});
		}

		byCard.get(key).entries.push(entry);
	}

	return [...byCard.values()];
}
