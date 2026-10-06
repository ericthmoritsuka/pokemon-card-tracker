// Wishlists (DESIGN.md section 3, "Wishlists are explicit, and separate from
// goals"): a short, deliberate list of cards someone wants, each optionally
// naming a language and a finish, with a priority and a note.
//
// An item is an entry in the person's wishlist list (DESIGN.md section 4):
//   {id, card_id, catalog, variant_id, language, priority, note,
//    created_at, updated_at, deleted_at}
// catalog is carried as card entries carry it, because the Japanese and
// Korean catalogs reuse the same card IDs (both have S4a). variant_id is a
// TCGdex variantId from the card's variants_detailed, or null for any finish;
// language is null for any language.
//
// Also here: whether a person owns what an item asks for, how many spares
// they hold of it (the Trade rule, DESIGN.md section 3), which family members
// want a scanned card (section 6, "Wishlist alert on scan"), the family's
// wishlists kept on the phone for offline use, and the catalog search the add
// screen uses.
//
// No DOM here, so Node can load the pure parts (tests/wishlist.test.mjs).

import {LANGUAGES, catalogFor, catalogLanguage, compareNumbers, importApi, isLanguage, setList} from './catalog.js';
import {isLive, loadDocument, mergeIntoLocal, newId, nowIso} from './collection.js';
import {database, timedCache} from './idb.js';
import {nextStamp, stampEntry} from './merge.js';

export const PRIORITIES = ['high', 'normal', 'low'];

export const PRIORITY_LABELS = {high: 'High', low: 'Low', normal: 'Normal'};

export const NOTE_MAX = 500;

const CATALOGS = new Set(['international', 'ja', 'ko', 'zh-cn', 'zh-tw']);

const priorityRank = (priority) => {
	const rank = PRIORITIES.indexOf(priority);

	return rank < 0 ? 1 : rank;
};

const entryCatalog = (entry) => (entry && entry.catalog) || 'international';

// The languages a card in this catalog can be wished for in: English,
// Portuguese, and French share the international records; a Japanese,
// Korean, or Chinese card has only its own (DESIGN.md section 3).
export const languagesFor = (catalog) => LANGUAGES.filter((lang) => catalogFor(lang.code) === catalog);

// ------------------------------------------------------- finish labels
//
// The same wording the card detail view uses for a variants_detailed entry
// (js/catalog-views.js, variantText, which that module does not export).

const VARIANT_TYPES = {holo: 'Holo', normal: 'Normal', reverse: 'Reverse holo'};
const FOILS = {masterball: 'Master Ball pattern', pokeball: 'Poké Ball pattern'};
const STAMPS = {'1st-edition': '1st Edition stamp'};

const sentence = (text) => {
	const words = String(text).replace(/_+/g, ' ').replace(/-(?=\D)|(?<=\D)-/g, ' ');

	return words.charAt(0).toUpperCase() + words.slice(1);
};

export function variantLabel(variant) {
	if (!variant) {
		return 'Any finish';
	}

	const parts = [VARIANT_TYPES[String(variant.type).toLowerCase()] || sentence(variant.type || 'Unknown')];

	if (variant.subtype) {
		parts.push(sentence(variant.subtype));
	}

	if (variant.foil) {
		parts.push(FOILS[variant.foil] || `${sentence(variant.foil)} foil`);
	}

	for (const stamp of variant.stamp || []) {
		parts.push(STAMPS[stamp] || `${sentence(stamp)} stamp`);
	}

	if (variant.size && variant.size !== 'standard') {
		parts.push(sentence(variant.size));
	}

	return parts.join(', ');
}

// ------------------------------------------------------ pure builders

function cleanNote(note) {
	return String(note ?? '').trim().slice(0, NOTE_MAX);
}

function cleanFields(fields, catalog) {
	const out = {};

	if (fields.language !== undefined) {
		const language = fields.language || null;

		if (language && (!isLanguage(language) || catalogFor(language) !== catalog)) {
			throw new Error(`A card from the ${catalog} catalog cannot be wished for in ${language}.`);
		}

		out.language = language;
	}

	if (fields.variantId !== undefined || fields.variant_id !== undefined) {
		const variant = fields.variantId !== undefined ? fields.variantId : fields.variant_id;

		out.variant_id = variant ? String(variant) : null;
	}

	if (fields.priority !== undefined) {
		if (!PRIORITIES.includes(fields.priority)) {
			throw new Error(`Priority is high, normal, or low, not ${fields.priority}.`);
		}

		out.priority = fields.priority;
	}

	if (fields.note !== undefined) {
		out.note = cleanNote(fields.note);
	}

	return out;
}

// A new wishlist entry. options: {catalog, language, variantId, priority,
// note}. catalog defaults to the language's catalog, then international.
export function newWish(cardId, options = {}, at = nowIso(), id = newId()) {
	if (!cardId) {
		throw new Error('A wishlist item needs a card.');
	}

	const catalog = options.catalog || (options.language ? catalogFor(options.language) : 'international');

	if (!CATALOGS.has(catalog)) {
		throw new Error(`Unknown catalog ${catalog}.`);
	}

	return {
		card_id: String(cardId),
		catalog,
		created_at: at,
		deleted_at: null,
		id,
		language: null,
		note: '',
		priority: 'normal',
		updated_at: at,
		variant_id: null,
		...cleanFields(options, catalog),
	};
}

// The stamp every write uses (js/merge.js), kept as an export here too.
export {nextStamp};

// A changed copy of an entry; the entry passed in is left alone, because the
// merge compares versions. patch: {language, variantId, priority, note}.
// Stamped field by field (js/merge.js stampEntry), so a priority changed on
// one phone and a note on another both stay.
export function editedWish(entry, patch, now = Date.now()) {
	const next = {...entry, ...cleanFields(patch, entryCatalog(entry))};

	next.updated_at = nextStamp(entry.updated_at, now);

	return stampEntry(entry, next);
}

export function deletedWish(entry, now = Date.now()) {
	const at = nextStamp(entry.updated_at, now);

	return stampEntry(entry, {...entry, deleted_at: at, updated_at: at});
}

// Live items, high priority first, then newest added.
export function sortWishes(items) {
	return items.filter(isLive).sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority)
		|| String(b.created_at).localeCompare(String(a.created_at)));
}

// ------------------------------------------------------- matching

// True when a card entry is a copy of what the item asks for: the same card
// in the same catalog, and the item's language and finish when it names
// them.
export function copyFits(item, entry) {
	return isLive(entry)
		&& entry.card_id === item.card_id
		&& entryCatalog(entry) === entryCatalog(item)
		&& (!item.language || entry.language === item.language)
		&& (!item.variant_id || entry.variant_id === item.variant_id);
}

// The live card entries that satisfy an item: "You have this now".
export const ownedCopies = (item, cards) => (cards || []).filter((entry) => copyFits(item, entry));

// How many spares of an item the cards hold. A spare is every copy beyond
// the first of the same card in the same language, whatever its variant
// (DESIGN.md section 3, Trade). So in each language the item accepts, one
// copy is kept and the rest are spares; when the item names a finish, only
// copies in that finish count, and the copy kept is a different one where
// there is one (one normal and one reverse holo in PT: the reverse holo can
// go).
export function sparesFor(item, cards) {
	const byLanguage = new Map();

	for (const entry of cards || []) {
		if (!isLive(entry) || entry.card_id !== item.card_id || entryCatalog(entry) !== entryCatalog(item)) {
			continue;
		}

		if (item.language && entry.language !== item.language) {
			continue;
		}

		const group = byLanguage.get(entry.language) || {fits: 0, total: 0};

		group.total++;

		if (!item.variant_id || entry.variant_id === item.variant_id) {
			group.fits++;
		}

		byLanguage.set(entry.language, group);
	}

	let spares = 0;

	for (const {fits, total} of byLanguage.values()) {
		spares += Math.min(fits, total - 1);
	}

	return spares;
}

// Which family members want a card: the scanner's "<member> wants this card"
// (DESIGN.md section 6).
//
// cardId is the scanned card's TCGdex ID. scan: {language, variantId,
// catalog}, each optional; catalog defaults to the language's catalog. An
// item that names a language or a finish matches only a scan with the same
// one. When the scan does not say (no language read yet, no finish picked),
// the item still matches, and the field is listed in `unconfirmed`, so the
// caller can say "wants this card in PT" rather than claim a match.
//
// familyDocuments: [{user_id, name, wishlist}] as familyWishlists() returns
// them, or [{user_id, name, doc}] with whole documents. Returns
// [{userId, name, item, unconfirmed}], high priority first, one row per
// matching item.
export function wishedBy(cardId, scan = {}, familyDocuments = []) {
	const language = (scan && scan.language) || null;
	const variantId = (scan && (scan.variantId || scan.variant_id)) || null;
	const catalog = (scan && scan.catalog) || (language ? catalogFor(language) : null);
	const out = [];

	for (const member of familyDocuments || []) {
		if (!member) {
			continue;
		}

		const items = member.wishlist || (member.doc && member.doc.wishlist) || [];

		for (const item of items) {
			if (!item || !isLive(item) || item.card_id !== cardId) {
				continue;
			}

			if (catalog && entryCatalog(item) !== catalog) {
				continue;
			}

			const unconfirmed = [];

			if (item.language) {
				if (language && language !== item.language) {
					continue;
				}

				if (!language) {
					unconfirmed.push('language');
				}
			}

			if (item.variant_id) {
				if (variantId && variantId !== item.variant_id) {
					continue;
				}

				if (!variantId) {
					unconfirmed.push('variant');
				}
			}

			out.push({
				item,
				name: member.name || member.display_name || 'Family member',
				unconfirmed,
				userId: member.user_id || member.userId || null,
			});
		}
	}

	return out.sort((a, b) => priorityRank(a.item.priority) - priorityRank(b.item.priority) || a.name.localeCompare(b.name));
}

// ------------------------------------------------------------- saving
//
// js/collection.js has no save for lists other than cards, so an entry is
// merged in through mergeIntoLocal, as js/checklists.js does for goals: the
// entry carries a newer updated_at, so it wins. That save is marked as coming
// from the sync, which does not schedule a push, so the sync is asked to run
// a moment later. Signed out or offline, the entry waits on the phone.

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

async function saveWish(entry) {
	await mergeIntoLocal({wishlist: [entry]});
	schedulePush();

	return entry;
}

// Changes run one at a time, each reading what the last one saved.
let queue = Promise.resolve();

function serial(work) {
	const run = queue.then(work, work);

	queue = run.catch(() => {});

	return run;
}

export async function listWishlist() {
	const doc = await loadDocument();

	return sortWishes(doc.wishlist || []);
}

export async function getWish(id) {
	return (await listWishlist()).find((item) => item.id === id) || null;
}

const sameWish = (item, cardId, catalog, language, variantId) => item.card_id === cardId
	&& entryCatalog(item) === catalog
	&& (item.language || null) === (language || null)
	&& (item.variant_id || null) === (variantId || null);

// The live item asking for exactly this card, language, and finish, or null.
export async function wishFor(cardId, options = {}) {
	const catalog = options.catalog || (options.language ? catalogFor(options.language) : 'international');
	const variantId = options.variantId || options.variant_id || null;

	return (await listWishlist()).find((item) => sameWish(item, cardId, catalog, options.language || null, variantId)) || null;
}

// Adds a card to the wishlist: the one-tap "Add to wishlist" for card
// detail. options: {catalog, language, variantId, priority, note}, all
// optional. When the wishlist already holds this card with the same language
// and finish, that item is returned and nothing is added, so a second tap
// does not make a second item. Returns the entry.
export const addToWishlist = (cardId, options = {}) => serial(async () => {
	const entry = newWish(cardId, options);
	const existing = (await listWishlist()).find((item) => sameWish(item, entry.card_id, entry.catalog, entry.language, entry.variant_id));

	if (existing) {
		return existing;
	}

	return saveWish(entry);
});

const changeWish = (id, change) => serial(async () => {
	const item = await getWish(id);

	if (!item) {
		throw new Error('This item is not on the wishlist on this phone. It may have been removed.');
	}

	return saveWish(change(item));
});

// patch: {language, variantId, priority, note}; fields left out stay.
export const updateWish = (id, patch) => changeWish(id, (item) => editedWish(item, patch));

// Soft delete: the entry stays as a tombstone, so a phone holding an older
// copy cannot bring the item back.
export const removeWish = (id) => changeWish(id, (item) => deletedWish(item));

// ------------------------------------------------------------ the cache
//
// The family's wishlists, kept on the phone so the scanner can say who wants
// a card in a shop with no signal (DESIGN.md section 6). One record per
// signed-in account, so another account on this phone never sees them.

const DB_NAME = 'card-tracker-wishlists';
const STORE = 'cache';
const REFRESH_AFTER_MS = 10 * 60 * 1000;

const cacheDb = database(DB_NAME, [STORE]);
const {get: cacheGet, put: cachePut} = timedCache(cacheDb, STORE);

const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

async function me() {
	const auth = await import('./auth.js');

	return auth.currentUser();
}

const familyKey = (userId) => `family:${userId}`;

// The family's wishlists as last saved on this phone:
// {at, members: [{user_id, name, wishlist}]}, wishlist holding live items
// only. Empty when signed out or never fetched.
export async function cachedFamilyWishlists() {
	const user = await me();

	if (!user) {
		return {at: null, members: []};
	}

	const hit = await cacheGet(familyKey(user.id));

	return hit ? {at: hit.at, members: hit.data} : {at: null, members: []};
}

// Card details for every family item, cache first, so their names and
// images show offline too. Bounded, four at a time.
const WARM_LIMIT = 200;

async function warmCards(members) {
	const cards = new Map();

	for (const member of members) {
		for (const item of member.wishlist) {
			const lang = item.language || catalogLanguage(entryCatalog(item));

			cards.set(`${lang}|${item.card_id}`, {cardId: item.card_id, catalog: entryCatalog(item), lang});
		}
	}

	const list = [...cards.values()].slice(0, WARM_LIMIT);
	let next = 0;

	await Promise.all(Array.from({length: Math.min(4, list.length)}, async () => {
		while (next < list.length) {
			const {cardId, catalog, lang} = list[next++];

			try {
				await cardRecord(cardId, lang, catalog);
			}
			catch {
				// Shown with its card ID until a visit with a connection.
			}
		}
	}));
}

let refreshing = null;

// {members, fresh}: fresh is false when the saved copy was returned instead.
function refresh({warm = true} = {}) {
	if (!refreshing) {
		refreshing = (async () => {
			const user = await me();

			if (!user || !online()) {
				return {fresh: false, members: (await cachedFamilyWishlists()).members};
			}

			const sync = await import('./sync.js');
			const {memberName} = await import('./account-views.js');
			const overview = await sync.familyOverview({fresh: true});
			const others = ((overview && overview.members) || []).filter((member) => member.user_id !== user.id);
			// Each member's wishlist alone, never their whole document.
			const members = await Promise.all(others.map(async (member) => {
				const items = await sync.memberWishes(member.user_id);

				return {
					name: memberName(member),
					user_id: member.user_id,
					wishlist: sortWishes((items || []).filter((item) => item && item.id)),
				};
			}));

			await cachePut(familyKey(user.id), members);

			if (warm) {
				warmCards(members).catch(() => {});
			}

			return {fresh: true, members};
		})().catch(async () => ({fresh: false, members: (await cachedFamilyWishlists()).members})).finally(() => {
			refreshing = null;
		});
	}

	return refreshing;
}

// Reads every other family member's wishlist from the server and keeps them
// on the phone: [{user_id, name, wishlist}]. Returns the saved
// copy when the phone is offline, signed out, or the server did not answer.
export const refreshFamilyWishlists = async (options) => (await refresh(options)).members;

// One member's wishlist: from the server when online, so the view is
// current, and from the phone otherwise. Returns {member, fromCache, at},
// member null when this phone has never seen them.
export async function memberWishlist(userId) {
	const {fresh, members} = await refresh();
	const saved = fresh ? null : await cachedFamilyWishlists();

	return {
		at: saved ? saved.at : Date.now(),
		fromCache: !fresh,
		member: members.find((item) => item.user_id === userId) || null,
	};
}

// The family's wishlists for matching, from the phone, refreshed behind
// when they are more than ten minutes old and there is signal. Pass the
// result to wishedBy.
export async function familyWishlists() {
	const saved = await cachedFamilyWishlists();

	if (online() && (!saved.at || Date.now() - saved.at > REFRESH_AFTER_MS)) {
		refreshFamilyWishlists().catch(() => {});
	}

	return saved.members;
}

// Keeps the cache fresh while the app runs: now, whenever the connection
// comes back, and when someone signs in, each time only when the saved copy
// is more than ten minutes old, as for the scanner (E-18). Returns the stop
// function.
export function keepFamilyWishlistsCached() {
	let stopUser = () => {};
	const refresh = () => {
		cachedFamilyWishlists()
			.then((saved) => {
				if (!saved.at || Date.now() - saved.at > REFRESH_AFTER_MS) {
					return refreshFamilyWishlists();
				}

				return null;
			})
			.catch(() => {});
	};

	window.addEventListener('online', refresh);
	import('./auth.js').then((auth) => {
		stopUser = auth.onUser((user) => user && refresh());
	}).catch(() => {});
	refresh();

	return () => {
		window.removeEventListener('online', refresh);
		stopUser();
	};
}

// ------------------------------------------------------- the catalog
//
// Card details come through js/catalog.js, cache first, under the same keys
// the card detail view uses, so a card shown once shows again offline.

// The TCGdex card for an item, in the item's language when it names an
// international one, else the catalog's language. Falls back to English for
// a Portuguese or French record TCGdex lacks. Null when not found.
export async function cardRecord(cardId, lang, catalog = catalogFor(lang)) {
	const tries = [...new Set([lang, catalogLanguage(catalog)].filter(Boolean))];
	let failure = null;

	for (const code of tries) {
		try {
			const card = await importApi.cardDetail(code, cardId);

			if (card) {
				return {card, lang: code};
			}
		}
		catch (err) {
			failure = failure || err;
		}
	}

	if (failure) {
		throw failure;
	}

	return null;
}

// The language to show an item's card in.
export const displayLanguage = (item, viewing) => item.language
	|| (catalogFor(viewing) === entryCatalog(item) ? viewing : catalogLanguage(entryCatalog(item)));

// --------------------------------------------------------- the search

const API = 'https://api.tcgdex.net/v2/';
const SEARCH_LIMIT = 60;
const SEARCH_FOR_MS = 24 * 60 * 60 * 1000;

// TCG Pocket is a phone game: its cards are not printed, so they are left
// out of the search.
const isPocket = (brief) => /\/tcgp\//.test(String(brief.image || ''));

// "001" and "1" are the same number; "TG10" stays as written.
export const sameNumber = (a, b) => compareNumbers(String(a).replace(/^0+(?=\d)/, ''), String(b).replace(/^0+(?=\d)/, '')) === 0;

const setIdOf = (cardId) => {
	const cut = String(cardId).lastIndexOf('-');

	return cut > 0 ? cardId.slice(0, cut) : null;
};

// What a search box holds: a card ID ("sv08.5-003"), a collector number with
// or without the set total ("3", "#003", "3/131", "TG10"), a name, or a name
// and a number.
export function parseQuery(text) {
	const query = String(text || '').trim().replace(/\s+/g, ' ');

	if (!query) {
		return {name: '', number: null, total: null};
	}

	if (/^[a-z0-9.]+-[a-z]*\d+[a-z]?$/i.test(query)) {
		return {cardId: query, name: '', number: null, total: null};
	}

	const match = /(?:^|\s)#?([a-z]{0,3}\d+[a-z]?)(?:\s*\/\s*(\d+))?$/i.exec(query) || /^#?([a-z]{0,3}\d+[a-z]?)(?:\s*\/\s*(\d+))?(?=\s)/i.exec(query);

	if (!match) {
		return {name: query, number: null, total: null};
	}

	const name = (query.slice(0, match.index) + query.slice(match.index + match[0].length)).trim();

	return {name, number: match[1], total: match[2] ? Number(match[2]) : null};
}

async function fetchSearch(path) {
	const key = `search:${path}`;
	const hit = await cacheGet(key);

	if (hit && (Date.now() - hit.at < SEARCH_FOR_MS || !online())) {
		return hit.data;
	}

	try {
		const response = await fetch(API + path);

		if (!response.ok) {
			const err = new Error(`TCGdex answered ${response.status}.`);

			err.status = response.status;

			throw err;
		}

		const data = await response.json();

		await cachePut(key, data);

		return data;
	}
	catch (err) {
		if (hit) {
			return hit.data;
		}

		throw err;
	}
}

// Set names, official counts, and release order, from the set list the Sets
// tab keeps (cache first). Null when it is not available.
// waitMs: give up waiting after this long (the list keeps downloading and
// is saved for next time), so a first search is not held up by it.
async function setsById(lang, waitMs = Infinity) {
	try {
		const loading = setList(lang);
		const timeout = Number.isFinite(waitMs) ? new Promise((resolve) => setTimeout(() => resolve(null), waitMs)) : null;
		const answer = await (timeout ? Promise.race([loading, timeout]) : loading);

		loading.catch(() => {});

		if (!answer) {
			return null;
		}

		const {data} = answer;
		const map = new Map();

		for (const serie of data || []) {
			for (const set of serie.sets || []) {
				map.set(set.id, {
					name: set.name,
					official: (set.cardCount && set.cardCount.official) || null,
					pocket: serie.id === 'tcgp',
					rank: set.releaseRank ?? null,
				});
			}
		}

		return map;
	}
	catch {
		return null;
	}
}

function result(brief, lang, sets) {
	const setId = setIdOf(brief.id);
	const set = sets && setId ? sets.get(setId) : null;

	return {
		catalog: catalogFor(lang),
		id: brief.id,
		image: brief.image || null,
		lang,
		localId: brief.localId,
		name: brief.name,
		official: set ? set.official : null,
		rank: set ? set.rank : null,
		setId,
		setName: set ? set.name : null,
	};
}

export class SearchHint extends Error {
	constructor(message) {
		super(message);
		this.name = 'SearchHint';
	}
}

// Searches the catalog of `lang` by name, number, or both. Returns
// {results, more}: up to SEARCH_LIMIT cards, newest set first when the set
// list is on the phone, and how many more matched. Searches are kept on the
// phone for a day, so one made once works offline.
export async function searchCards(text, lang) {
	const query = parseQuery(text);
	const catalog = catalogFor(lang);

	if (query.cardId) {
		const found = await cardRecord(query.cardId, lang, catalog).catch(() => null);

		if (found) {
			const {card} = found;
			const sets = new Map([[card.set && card.set.id, {name: card.set && card.set.name, official: card.set && card.set.cardCount && card.set.cardCount.official}]]);

			return {more: 0, results: [result(card, lang, sets)]};
		}

		return {more: 0, results: []};
	}

	if (!query.name && !query.number) {
		throw new SearchHint('Type a card name or a number.');
	}

	if (!query.name && !query.total) {
		throw new SearchHint('Add the name or the set total to a number, for example "Pinsir 3" or "3/131".');
	}

	let briefs;
	let sets = null;

	if (query.name) {
		const params = new URLSearchParams({name: query.name});

		if (query.number) {
			params.set('localId', query.number);
		}

		[briefs, sets] = await Promise.all([fetchSearch(`${lang}/cards?${params}`), setsById(lang, 2500)]);
		briefs = (Array.isArray(briefs) ? briefs : []).filter((brief) => brief && brief.id && !isPocket(brief));

		if (query.number) {
			briefs = briefs.filter((brief) => sameNumber(brief.localId, query.number));
		}
	}
	else {
		// A number and a set total: the sets with that many official cards,
		// read one by one (cache first), and the card with that number in each.
		sets = await setsById(lang);

		if (!sets) {
			throw new SearchHint('Searching by number needs the set list. Open Sets once with a connection, or search by name.');
		}

		const candidates = [...sets.entries()].filter(([, set]) => !set.pocket && set.official === query.total).slice(0, 12);

		briefs = [];

		for (const [setId] of candidates) {
			try {
				const set = await importApi.setDetail(lang, setId);

				for (const card of (set && set.cards) || []) {
					if (sameNumber(card.localId, query.number)) {
						briefs.push(card);
					}
				}
			}
			catch {
				// A set not on the phone offline is skipped.
			}
		}
	}

	let results = briefs.map((brief) => result(brief, lang, sets));

	if (query.total) {
		results = results.filter((card) => card.official === null || card.official === query.total);
	}

	results.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || compareNumbers(a.localId, b.localId));

	return {more: Math.max(0, results.length - SEARCH_LIMIT), results: results.slice(0, SEARCH_LIMIT)};
}
