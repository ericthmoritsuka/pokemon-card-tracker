// Collections (DESIGN.md section 1 and section 11, "Collections"): named
// groups of the cards you own, hand-picked or filling themselves from a rule.
// Owning is the base set and a collection is a tag on top, so neither kind
// changes the totals, and a card can be in any number of them.
//
// A collection is an entry in the person's collections list (section 4):
//   {id, name, kind: 'hand' | 'rule', rule, entry_ids, removed_ids,
//    created_at, updated_at, deleted_at}
//   rule         null for a hand-picked collection. For a rule, filter-bar
//                shaped: {rarity: [..], set: [..], language: [..], type: [..],
//                region: [..], dex: '1-151' (a range), favorite: true}. A field holds
//                the values it accepts (any one of them matches), and every
//                field named must match. Values are the filter bar's own:
//                TCGdex's English rarity, "<catalog>|<set id>", a language
//                code, an energy name, a region id.
//   entry_ids    hand-picked: card entry id -> when it was added
//   removed_ids  hand-picked: card entry id -> when it was taken out
// The two maps merge id by id (js/merge.js mergeMembers), so two phones that
// add different cards both keep theirs, and a removal sticks.
//
// Also here: which entries a collection holds, the catalog details a rule
// needs, and the saves. No DOM, so Node can load the pure parts
// (tests/collections.test.mjs).

import {
	cardIndex,
	detailRecords,
	saveToCardIndex,
	setDetails,
	setIdOfCard,
	setsNeedingDetails,
} from './catalog.js';
import {isLive, loadDocument, mergeIntoLocal, newId, nowIso, resolveEntry} from './collection.js';
import {customRecord} from './custom-card.js';
import {applyFilters, dexRange, emptyFilters} from './filter-bar.js';
import {nextStamp, restoreEntry, stampEntry} from './merge.js';

export const KINDS = ['hand', 'rule'];

export const NAME_MAX = 60;

// The filter-bar fields a rule can name, each with several values.
export const RULE_FIELDS = ['rarity', 'set', 'language', 'type', 'region'];

// The Star preset (DESIGN.md section 3): every illustration rare.
export const STAR_RARITIES = ['Illustration rare', 'Special illustration rare'];

const VALUES_MAX = 200;

const time = (value) => {
	const ms = Date.parse(value);

	return Number.isNaN(ms) ? -Infinity : ms;
};

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// ------------------------------------------------------------ the rule

// A rule as it is stored: only the fields it names, values as arrays,
// duplicates gone. Throws with words for the screen when it names nothing.
export function cleanRule(rule) {
	const out = {};
	const source = isObject(rule) ? rule : {};

	for (const kind of RULE_FIELDS) {
		const raw = Array.isArray(source[kind]) ? source[kind] : [source[kind]];
		const values = [...new Set(raw.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))].slice(0, VALUES_MAX);

		if (values.length) {
			out[kind] = values;
		}
	}

	if (dexRange(source.dex)) {
		out.dex = String(source.dex);
	}

	if (source.favorite === true) {
		out.favorite = true;
	}

	if (!Object.keys(out).length) {
		throw new Error('Choose at least one condition for the rule.');
	}

	return out;
}

// What the filter bar reads of a card (js/filter-bar.js applyFilters), for
// one copy and its catalog record. A hand-made card stands in for a record
// with its own fields.
export function itemFor(entry, record) {
	const known = record || customRecord(entry);
	const catalog = entry.catalog || 'international';
	const setId = (known && known.set_id) || setIdOfCard(entry.card_id);

	return {
		category: (known && known.category) || null,
		dexIds: (known && known.dex_ids) || [],
		favorite: entry.is_favorite === true,
		language: entry.language,
		rarity: (known && known.rarity) || null,
		setKey: setId ? `${catalog}|${setId}` : null,
		types: (known && known.types) || [],
	};
}

// True when the card fits the rule, by the filter bar's own matching.
export function ruleMatches(rule, item) {
	if (!isObject(rule)) {
		return false;
	}

	for (const kind of RULE_FIELDS) {
		const values = Array.isArray(rule[kind]) ? rule[kind] : [];

		if (values.length && !values.some((value) => applyFilters([item], {filters: {...emptyFilters(), [kind]: value}}).length)) {
			return false;
		}
	}

	if (rule.dex && !applyFilters([item], {filters: {...emptyFilters(), dex: rule.dex}}).length) {
		return false;
	}

	return !rule.favorite || item.favorite === true;
}

// The rule in words, such as "Rarity: Illustration rare, Special illustration
// rare. Language: EN". labels maps a field to {value: text} for the values
// whose stored form is not readable (sets, languages, regions).
export function ruleText(rule, labels = {}) {
	if (!isObject(rule)) {
		return '';
	}

	const names = {language: 'Language', rarity: 'Rarity', region: 'Region', set: 'Set', type: 'Type'};
	const parts = RULE_FIELDS.filter((kind) => Array.isArray(rule[kind]) && rule[kind].length)
		.map((kind) => `${names[kind]}: ${rule[kind].map((value) => (labels[kind] && labels[kind][value]) || value).join(', ')}`);

	if (rule.dex) {
		parts.push(`Pokédex: ${rule.dex}`);
	}

	if (rule.favorite) {
		parts.push('Favorites only');
	}

	return parts.join('. ');
}

// ------------------------------------------------------------ entries

const cleanName = (name) => String(name || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

export function newCollection({kind = 'hand', name, rule = null} = {}, at = nowIso(), id = newId()) {
	if (!KINDS.includes(kind)) {
		throw new Error(`Unknown collection kind ${kind}.`);
	}

	const title = cleanName(name);

	if (!title) {
		throw new Error('A collection needs a name.');
	}

	return {
		created_at: at,
		deleted_at: null,
		entry_ids: {},
		id,
		kind,
		name: title,
		rule: kind === 'rule' ? cleanRule(rule) : null,
		updated_at: at,
	};
}

// patch: {name, rule}; a field left out stays. The kind never changes.
export function editedCollection(entry, patch = {}, now = Date.now()) {
	const next = {...entry};

	if (patch.name !== undefined) {
		next.name = cleanName(patch.name);

		if (!next.name) {
			throw new Error('A collection needs a name.');
		}
	}

	if (patch.rule !== undefined && entry.kind === 'rule') {
		next.rule = cleanRule(patch.rule);
	}

	next.updated_at = nextStamp(entry.updated_at, now);

	return stampEntry(entry, next);
}

export function deletedCollection(entry, now = Date.now()) {
	const at = nextStamp(entry.updated_at, now);

	return stampEntry(entry, {...entry, deleted_at: at, updated_at: at});
}

const newestOf = (stamps) => stamps.reduce((a, b) => (time(b) > time(a) ? b : a), null);

// The stamp a membership change takes: after the collection's own, and after
// whatever it replaces for these ids, whatever the clock says.
function memberStamp(entry, ids, now) {
	const held = ids.flatMap((id) => [(entry.entry_ids || {})[id], (entry.removed_ids || {})[id]]).filter(Boolean);

	return nextStamp(newestOf([entry.updated_at, ...held]), now);
}

// The hand-picked collection with these entries added; the same object when
// every one is in already.
export function withMembers(entry, ids, now = Date.now()) {
	const wanted = [...new Set(ids)].filter((id) => id && !isMember(entry, id));

	if (!wanted.length) {
		return entry;
	}

	const at = memberStamp(entry, wanted, now);
	const added = {...(entry.entry_ids || {})};
	const removed = {...(entry.removed_ids || {})};

	for (const id of wanted) {
		added[id] = at;
		delete removed[id];
	}

	const next = {...entry, entry_ids: added, updated_at: at};

	if (Object.keys(removed).length) {
		next.removed_ids = removed;
	}
	else {
		delete next.removed_ids;
	}

	return stampEntry(entry, next);
}

// The collection with these entries taken out; the same object when none of
// them was in.
export function withoutMembers(entry, ids, now = Date.now()) {
	const wanted = [...new Set(ids)].filter((id) => id && isMember(entry, id));

	if (!wanted.length) {
		return entry;
	}

	const at = memberStamp(entry, wanted, now);
	const added = {...(entry.entry_ids || {})};
	const removed = {...(entry.removed_ids || {})};

	for (const id of wanted) {
		delete added[id];
		removed[id] = at;
	}

	return stampEntry(entry, {...entry, entry_ids: added, removed_ids: removed, updated_at: at});
}

// True when the card entry is added to this hand-picked collection and not
// taken out since.
export function isMember(entry, id) {
	const added = isObject(entry.entry_ids) ? entry.entry_ids[id] : undefined;
	const removed = isObject(entry.removed_ids) ? entry.removed_ids[id] : undefined;

	return added !== undefined && (removed === undefined || time(added) > time(removed));
}

export const memberIds = (entry) => Object.keys(isObject(entry.entry_ids) ? entry.entry_ids : {}).filter((id) => isMember(entry, id));

// The live copies a collection holds now. cards is the whole document's
// cards; index is the card index (Map "<catalog>|<card id>" -> record),
// which a rule reads rarity, set, types, and the Pokédex number from. A
// hand-picked id that the merge folded into another copy follows it.
export function collectionEntries(collection, cards, index = new Map()) {
	const live = (cards || []).filter((entry) => entry && isLive(entry));

	if (collection.kind === 'rule') {
		return live.filter((entry) => ruleMatches(collection.rule, itemFor(entry, index.get(`${entry.catalog || 'international'}|${entry.card_id}`))));
	}

	const byId = new Map(live.map((entry) => [entry.id, entry]));
	const out = new Map();

	for (const id of memberIds(collection)) {
		const found = byId.get(id) || resolveEntry(cards, id);

		if (found && isLive(found)) {
			out.set(found.id, found);
		}
	}

	return [...out.values()];
}

export const liveCollections = (collections) => (collections || []).filter((item) => item && isLive(item) && KINDS.includes(item.kind));

const collator = new Intl.Collator('en', {numeric: true, sensitivity: 'base'});

// Live collections by name.
export const sortCollections = (collections) => liveCollections(collections)
	.sort((a, b) => collator.compare(a.name, b.name) || String(a.created_at).localeCompare(String(b.created_at)));

// ------------------------------------------------------------- details

// Reads the catalog details a rule needs (rarity, types, Pokédex numbers)
// for cards whose sets this phone has not read, and saves them to the card
// index. Returns the new index, or null when there was nothing to read.
// isAlive lets a screen that closed stop the pass.
export async function fillDetails(cards, index, isAlive = () => true) {
	const sets = setsNeedingDetails((cards || []).filter(isLive), index);
	const records = [];
	let next = 0;

	await Promise.all(Array.from({length: Math.min(2, sets.length)}, async () => {
		while (next < sets.length && isAlive()) {
			const set = sets[next++];

			records.push(...detailRecords(set, await setDetails(set).catch(() => null)));
		}
	}));

	return records.length && isAlive() ? saveToCardIndex(records) : null;
}

// ------------------------------------------------------------- saving
//
// As js/wishlist.js does: an entry is merged in through mergeIntoLocal, which
// is marked as coming from the sync, so the sync is asked to run a moment
// later. Signed out or offline, the entry waits on the phone.

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

async function save(entry) {
	await mergeIntoLocal({collections: [entry]});
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

export async function listCollections() {
	const doc = await loadDocument();

	return sortCollections(doc.collections || []);
}

export async function getCollection(id) {
	return (await listCollections()).find((item) => item.id === id) || null;
}

export const createCollection = (fields) => serial(() => save(newCollection(fields)));

const change = (id, work) => serial(async () => {
	const item = await getCollection(id);

	if (!item) {
		throw new Error('This collection is not on this phone. It may have been deleted.');
	}

	const next = work(item);

	return next === item ? item : save(next);
});

export const updateCollection = (id, patch) => change(id, (item) => editedCollection(item, patch));

// Soft delete: the entry stays as a tombstone, so a phone holding an older
// copy cannot bring the collection back. Undo is restoreCollection.
export const removeCollection = (id) => change(id, (item) => deletedCollection(item));

// Brings a deleted collection back on purpose (js/merge.js restoreEntry), for
// Undo after a delete.
export const restoreCollection = (id) => serial(async () => {
	const doc = await loadDocument();
	const item = (doc.collections || []).find((one) => one.id === id);

	if (!item || !item.deleted_at) {
		return item || null;
	}

	return save(restoreEntry(item));
});

// Adds card entries to a hand-picked collection, or takes them out.
export const addToCollection = (id, entryIds) => change(id, (item) => {
	if (item.kind !== 'hand') {
		throw new Error('A collection that fills itself from a rule takes no cards by hand.');
	}

	return withMembers(item, entryIds);
});

export const removeFromCollection = (id, entryIds) => change(id, (item) => withoutMembers(item, entryIds));

// The index and the live cards and collections together, as the screens
// read them.
export async function loadCollections() {
	const [doc, index] = await Promise.all([loadDocument(), cardIndex()]);

	return {cards: doc.cards || [], collections: sortCollections(doc.collections || []), index};
}
