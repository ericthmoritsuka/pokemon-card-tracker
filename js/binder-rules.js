// Binders made from a list (DESIGN.md section 11, "Binders from a list";
// Eric, 2026-10-05): the person picks the cards (a checklist, a collection,
// a goal, or a filter), an order, and a pocket size, and the app lays the
// binder out and works out the pages.
//
// A generated binder is an ordinary entry in the binders list with two more
// fields, and its slots stay empty:
//   rule      {source, order}: what fills it, merged as one field
//     source  {kind: 'checklist' | 'collection' | 'goal', id} or
//             {kind: 'filter', filter}, filter shaped like a rule
//             collection's rule (js/collections.js cleanRule: region, set,
//             type, language, rarity, each a list of values)
//     order   'dex' (Pokédex number), 'set' (set and number, oldest set
//             first), 'name', or 'release' (newest set first)
//   snapshot  {at, rule_key, keys, shown}: the layout of the last refresh
//     keys    the pockets in order, one key per Pokémon ("dex:25") or card
//             ("international|sv01-001"), so every phone and the family view
//             show the same pages
//     shown   key -> the copy shown by default (the most valuable, else the
//             rarest, else the newest), for the pockets with a copy
//     rule_key  the rule the layout was made for (ruleKey)
// rows, cols, preset, and page_count are the binder's own fields, so the
// pocket size is the grid; page_count follows the number of pockets.
//
// The copies picked by hand live in a list of their own in the document,
// binder_picks, one entry per pocket:
//   {id: '<binder id>|<key>', binder_id, key, entry_id, created_at,
//    updated_at, deleted_at}
// entry_id null means "back to the default". Every app merges a top-level
// list it does not know entry by entry and saves it back (js/merge.js
// mergeDocuments, since the first sync), so two phones that pick copies for
// different pockets both keep theirs, and the later pick of one pocket wins,
// with no change to the merge. A pick follows its key, not its page, so it
// stays with its Pokémon or card when the order or the size changes.
//
// A generated binder is a view: it never places a copy. placements() in
// js/binders.js passes over it, so "Not in a binder yet", the copy sheet's
// pocket line, and the scanner's placeholders are about hand-made binders
// only, and a copy shown here can also sit in a hand-made binder.
//
// Pure functions only, so Node can test them (tests/binder-rules.test.mjs).

export const SOURCE_KINDS = ['checklist', 'collection', 'goal', 'filter'];

export const ORDERS = [
	{label: 'Pokédex number', value: 'dex'},
	{label: 'Set and number', value: 'set'},
	{label: 'Name', value: 'name'},
	{label: 'Release date, newest first', value: 'release'},
];

// A checklist's pockets are Pokémon, which have no set or release date.
export const ordersFor = (kind) => (kind === 'checklist' ? ORDERS.filter((order) => order.value === 'dex' || order.value === 'name') : ORDERS);

export const FILTER_FIELDS = ['region', 'set', 'type', 'language', 'rarity'];

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const cleanId = (value) => {
	const id = String(value ?? '').trim();

	return id && id.length <= 128 ? id : null;
};

// The filter as stored: only the fields it names, values as lists. Null when
// it names nothing.
export function cleanFilter(filter) {
	const out = {};

	for (const kind of FILTER_FIELDS) {
		const raw = isObject(filter) ? (Array.isArray(filter[kind]) ? filter[kind] : [filter[kind]]) : [];
		const values = [...new Set(raw.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))].slice(0, 50);

		if (values.length) {
			out[kind] = values;
		}
	}

	return Object.keys(out).length ? out : null;
}

// A rule as it is stored, or null when it is not one: {source, order}.
export function cleanBinderRule(rule) {
	if (!isObject(rule) || !isObject(rule.source) || !SOURCE_KINDS.includes(rule.source.kind)) {
		return null;
	}

	const {kind} = rule.source;
	let source;

	if (kind === 'filter') {
		const filter = cleanFilter(rule.source.filter);

		if (!filter) {
			return null;
		}

		source = {filter, kind};
	}
	else {
		const id = cleanId(rule.source.id);

		if (!id) {
			return null;
		}

		source = {id, kind};
	}

	const orders = ordersFor(kind).map((order) => order.value);
	const order = orders.includes(rule.order) ? rule.order : orders[0];

	return {order, source};
}

// Throws words for the form when the rule is not complete.
export function checkBinderRule(rule) {
	const clean = cleanBinderRule(rule);

	if (!clean) {
		throw new Error(rule && rule.source && rule.source.kind === 'filter'
			? 'Choose at least one filter: a region, a set, a type, a language, or a rarity.'
			: 'Choose the list the binder is made from.');
	}

	return clean;
}

export const isGenerated = (binder) => Boolean(binder) && cleanBinderRule(binder.rule) !== null;

// The rule in one string, to tell whether a layout was made for it.
export function ruleKey(rule) {
	const clean = cleanBinderRule(rule);

	if (!clean) {
		return '';
	}

	const {source} = clean;
	const what = source.kind === 'filter'
		? FILTER_FIELDS.filter((kind) => source.filter[kind]).map((kind) => `${kind}=${[...source.filter[kind]].sort().join(',')}`).join(';')
		: source.id;

	return `${source.kind}:${what}|${clean.order}`;
}

// ------------------------------------------------------------- pockets

export const dexKey = (n) => `dex:${n}`;

export const cardKey = (catalog, cardId) => `${catalog || 'international'}|${cardId}`;

// {kind: 'pokemon', dex} or {kind: 'card', catalog, cardId}, or null.
export function parseKey(key) {
	const text = String(key || '');
	const dex = /^dex:(\d+)$/.exec(text);

	if (dex) {
		return {dex: Number(dex[1]), kind: 'pokemon'};
	}

	const cut = text.indexOf('|');

	return cut > 0 && cut < text.length - 1 ? {cardId: text.slice(cut + 1), catalog: text.slice(0, cut), kind: 'card'} : null;
}

export const MAX_PAGES = 200;

// The pages for n pockets of rows x cols: at least one.
export const pagesFor = (count, rows, cols) => Math.max(1, Math.ceil(count / (rows * cols)));

// Pocket i (from 0) as {page, position}, both from 1.
export function pocketAt(index, rows, cols) {
	const per = rows * cols;

	return {page: Math.floor(index / per) + 1, position: (index % per) + 1};
}

// The index of {page, position} in the pocket order.
export const indexAt = (page, position, rows, cols) => ((page - 1) * rows * cols) + position - 1;

// Throws when n pockets do not fit in the most pages a binder can have.
export function checkFits(count, rows, cols) {
	if (pagesFor(count, rows, cols) > MAX_PAGES) {
		throw new Error(`${count} pockets need more than ${MAX_PAGES} pages of ${rows} × ${cols}. Pick a bigger pocket size, or a smaller list.`);
	}
}

// ------------------------------------------------------------- order

const collator = new Intl.Collator('en', {numeric: true, sensitivity: 'base'});
const text = (value) => String(value ?? '');
const firstDex = (item) => (Number.isInteger(item.dex) ? item.dex : (item.dexIds && item.dexIds.length ? Math.min(...item.dexIds) : Infinity));
const byNumber = (a, b) => collator.compare(text(a.number), text(b.number));
const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
// Unknown dates last, in either direction.
const byDate = (a, b, newest) => {
	if (text(a.releaseDate) === text(b.releaseDate)) {
		return 0;
	}

	if (!a.releaseDate) {
		return 1;
	}

	if (!b.releaseDate) {
		return -1;
	}

	return newest ? text(b.releaseDate).localeCompare(text(a.releaseDate)) : text(a.releaseDate).localeCompare(text(b.releaseDate));
};
const bySet = (newest) => (a, b) => byDate(a, b, newest) || collator.compare(text(a.setId), text(b.setId)) || byNumber(a, b);

const SORTERS = {
	dex: (a, b) => (firstDex(a) - firstDex(b)) || bySet(false)(a, b) || byKey(a, b),
	name: (a, b) => collator.compare(text(a.name), text(b.name)) || (firstDex(a) - firstDex(b)) || bySet(false)(a, b) || byKey(a, b),
	release: (a, b) => bySet(true)(a, b) || byKey(a, b),
	set: (a, b) => bySet(false)(a, b) || byKey(a, b),
};

// Items in the rule's order. An item: {key, kind, dex, dexIds, name, setId,
// number, releaseDate, ...}. A Pokémon with no number (never: checklists
// hold numbers) or a Trainer goes last in Pokédex order.
export function sortRuleItems(items, order) {
	const sorter = SORTERS[order] || SORTERS.dex;

	return [...items].sort((a, b) => {
		const result = sorter(a, b);

		return Number.isNaN(result) ? byKey(a, b) : result;
	});
}

// ------------------------------------------------------------ default copy

// Rarity as a rank, higher is rarer, from TCGdex's English rarity words. An
// unknown rarity ranks 0, below Common.
const RARITY_WORDS = [
	[/mega hyper/i, 15],
	[/hyper|gold|secret/i, 14],
	[/special illustration/i, 13],
	[/shiny ultra/i, 12],
	[/illustration/i, 11],
	[/ultra|full art|vmax|vstar|crown/i, 10],
	[/ace spec|radiant|amazing|shiny|prime|legend|lv\.x|star/i, 9],
	[/double|holo rare v|rare holo v|\bv\b|\bex\b|\bgx\b/i, 8],
	[/holo/i, 6],
	[/rare/i, 5],
	[/uncommon/i, 3],
	[/common/i, 2],
	[/promo/i, 1],
];

export function rarityRank(rarity) {
	const words = text(rarity).trim();

	if (!words || /^none$/i.test(words)) {
		return 0;
	}

	for (const [pattern, rank] of RARITY_WORDS) {
		if (pattern.test(words)) {
			return rank;
		}
	}

	return 4;
}

// The copy a pocket shows by default: the most valuable (value in reais),
// else the rarest, else the newest added; ties go to the lowest id, so every
// phone picks the same one. rankOf(entry) -> {value, rarity}; value null when
// unknown, which loses to any known value.
export function defaultCopy(copies, rankOf = () => ({})) {
	let best = null;
	let bestRank = null;

	for (const entry of copies || []) {
		if (!entry || entry.deleted_at) {
			continue;
		}

		const raw = rankOf(entry) || {};
		const rank = {
			created: text(entry.created_at),
			rarity: rarityRank(raw.rarity),
			value: Number.isFinite(raw.value) ? raw.value : null,
		};

		if (!best || beats(rank, entry, bestRank, best)) {
			best = entry;
			bestRank = rank;
		}
	}

	return best;
}

function beats(a, entryA, b, entryB) {
	if (a.value !== b.value) {
		if (a.value === null || b.value === null) {
			return b.value === null;
		}

		return a.value > b.value;
	}

	if (a.rarity !== b.rarity) {
		return a.rarity > b.rarity;
	}

	if (a.created !== b.created) {
		return a.created > b.created;
	}

	return text(entryA.id) < text(entryB.id);
}

// ------------------------------------------------------------ hand picks

export const pickId = (binderId, key) => `${binderId}|${key}`;

// The hand picks of one binder: Map key -> entry id. A pick set back to the
// default (entry_id null) or deleted is not one.
export function picksOf(list, binderId) {
	const out = new Map();

	for (const pick of Array.isArray(list) ? list : []) {
		if (pick && !pick.deleted_at && pick.binder_id === binderId && typeof pick.key === 'string' && typeof pick.entry_id === 'string' && pick.entry_id) {
			out.set(pick.key, pick.entry_id);
		}
	}

	return out;
}

// A new version of a pocket's pick: entryId, or null for the default. at is
// the stamp; previous the entry it replaces, if any (its created_at stays).
export function pickEntry({at, binderId, entryId, key, previous = null}) {
	return {
		binder_id: binderId,
		created_at: (previous && previous.created_at) || at,
		deleted_at: null,
		entry_id: entryId || null,
		id: pickId(binderId, key),
		key,
		updated_at: at,
	};
}

// ------------------------------------------------------------ the layout

// The copy a pocket shows: a hand pick while it still fits, else the
// default the last refresh stored while it still fits, else the default
// now. Returns {entry, picked} or null when nothing fits.
export function shownCopy(item, {pick = null, rankOf, stored = null} = {}) {
	const copies = (item && item.copies) || [];
	const find = (id) => (id ? copies.find((entry) => entry.id === id && !entry.deleted_at) || null : null);
	const picked = find(pick);

	if (picked) {
		return {entry: picked, picked: true};
	}

	const kept = find(stored);

	if (kept) {
		return {entry: kept, picked: false};
	}

	const fresh = defaultCopy(copies, rankOf);

	return fresh ? {entry: fresh, picked: false} : null;
}

// What a refresh changes, without saving it. items: the source's pockets,
// sorted (sortRuleItems), each with its copies. picks: picksOf(). rankOf
// ranks a copy for the default. partial: the source could not tell every
// copy (offline, or Pokédex numbers still unknown), so a pocket whose stored
// default is still a live copy keeps it rather than going empty (liveIds).
// Returns {snapshot, page_count, added, removed, filled, updated, changed}:
//   added, removed  keys that joined or left the list
//   filled          keys that had no copy and have one now
//   updated         keys whose default moved to another copy (pockets
//                   picked by hand never count: their pick stays)
//   changed         anything to save
export function planRefresh(binder, items, {at, liveIds = null, partial = false, picks = new Map(), rankOf} = {}) {
	const before = isObject(binder.snapshot) ? binder.snapshot : {};
	const oldKeys = Array.isArray(before.keys) ? before.keys : [];
	const oldShown = isObject(before.shown) ? before.shown : {};
	const oldSet = new Set(oldKeys);
	const keys = items.map((item) => item.key);
	const newSet = new Set(keys);
	const shown = {};
	const filled = [];
	const updated = [];

	for (const item of items) {
		const fresh = defaultCopy(item.copies, rankOf);
		let id = fresh ? fresh.id : null;

		if (!id && partial && oldShown[item.key] && (!liveIds || liveIds.has(oldShown[item.key]))) {
			id = oldShown[item.key];
		}

		if (id) {
			shown[item.key] = id;
		}

		if (!oldSet.has(item.key)) {
			continue;
		}

		const had = oldShown[item.key] || null;

		if (!had && id) {
			filled.push(item.key);
		}
		else if (had && id && had !== id && !picks.has(item.key)) {
			updated.push(item.key);
		}
	}

	const added = keys.filter((key) => !oldSet.has(key));
	const removed = oldKeys.filter((key) => !newSet.has(key));
	const pageCount = pagesFor(keys.length, binder.rows, binder.cols);
	const snapshot = {at, keys, rule_key: ruleKey(binder.rule), shown};
	const same = before.rule_key === snapshot.rule_key
		&& oldKeys.length === keys.length && oldKeys.every((key, i) => key === keys[i])
		&& sameShown(oldShown, shown);

	return {
		added,
		changed: !same || binder.page_count !== pageCount,
		filled,
		page_count: pageCount,
		removed,
		snapshot,
		updated,
	};
}

function sameShown(a, b) {
	const keysA = Object.keys(a);

	return keysA.length === Object.keys(b).length && keysA.every((key) => a[key] === b[key]);
}

// A refresh in words, or '' when nothing worth saying changed. nameOf(key)
// gives a pocket's name; the first three are named.
export function refreshText(plan, nameOf = (key) => key) {
	const named = (keys) => {
		const names = keys.slice(0, 3).map(nameOf);
		const rest = keys.length - names.length;

		return rest > 0 ? `${names.join(', ')}, and ${rest} more` : names.join(', ').replace(/, ([^,]*)$/, ' and $1');
	};
	const parts = [];

	if (plan.added.length) {
		parts.push(`${plan.added.length === 1 ? '1 pocket' : `${plan.added.length} pockets`} added (${named(plan.added)})`);
	}

	if (plan.removed.length) {
		parts.push(`${plan.removed.length === 1 ? '1 pocket' : `${plan.removed.length} pockets`} removed (${named(plan.removed)})`);
	}

	if (plan.filled.length) {
		parts.push(`${plan.filled.length === 1 ? '1 pocket' : `${plan.filled.length} pockets`} filled with a card you own now (${named(plan.filled)})`);
	}

	if (plan.updated.length) {
		parts.push(`${plan.updated.length === 1 ? '1 pocket shows' : `${plan.updated.length} pockets show`} another copy by default`);
	}

	return parts.length ? `${parts.join('; ')}.` : '';
}
