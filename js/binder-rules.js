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
// pocket size is the grid; page_count follows the number of pockets, plus
// extra_pages, blank pages after the list (Eric, 2026-11-24; extraPagesOf).
//
// The copies picked by hand live in a list of their own in the document,
// binder_picks, one entry per pocket:
//   {id: '<binder id>|<key>', binder_id, key, entry_id, created_at,
//    updated_at, deleted_at}
// entry_id null means "back to the default". skipped, when present, lists
// the copies Eric does not want in that pocket ("Not this copy here", Eric,
// 2026-11-24): the pocket shows the best copy not skipped, else its
// placeholder, and a copy he gets later still fills it. Older apps ignore
// the field and show the default. Every app merges a top-level
// list it does not know entry by entry and saves it back (js/merge.js
// mergeDocuments, since the first sync), so two phones that pick copies for
// different pockets both keep theirs, and the later pick of one pocket wins,
// with no change to the merge. A pick follows its key, not its page, so it
// stays with its Pokémon or card when the order or the size changes.
//
// A generated binder is a view: it never places a copy. placements() in
// js/binders.js passes over it, so "Not in a binder", the copy sheet's
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

// The blank pages a binder from a list keeps after the list's pockets
// (Eric, 2026-11-24: "I want to be able to add pages"): a whole number from
// 0 to MAX_PAGES, 0 when the binder has none.
export function extraPagesOf(binder) {
	const n = Number(binder && binder.extra_pages);

	return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_PAGES) : 0;
}

// A binder from a list's pages: the list's pockets, then its extra pages,
// never more than MAX_PAGES. count: every pocket; added: how many of them
// are cards added by hand (extraKeysOf), which fill the extra pages first
// and add pages only once those are full.
export const listPageCount = (count, rows, cols, extra = 0, added = 0) => Math.min(MAX_PAGES, Math.max(pagesFor(count, rows, cols), pagesFor(count - added, rows, cols) + extra));

// ------------------------------------------------- cards added by hand
//
// A binder from a list can take cards the list does not have (Eric,
// 2026-11-24: "add a card to any binder"): extra_cards on the binder, one
// entry per card, {key, kind, at}, the latest per key kept:
//   add   the card (catalog|card_id, always one print) gets a pocket after
//         the list's pockets, in the order the cards were added
//   none  taken out again
// js/merge.js merges the field key by key, as list_edits, so two phones
// adding different cards both keep theirs. An older app keeps the field
// (it edits a clone of the binder) but lays its pages out without them.

export const EXTRA_KINDS = ['add', 'none'];

function cleanExtra(entry) {
	return isObject(entry) && typeof entry.key === 'string' && parseKey(entry.key) && parseKey(entry.key).kind === 'card' && EXTRA_KINDS.includes(entry.kind) && typeof entry.at === 'string'
		? {at: entry.at, key: entry.key, kind: entry.kind}
		: null;
}

// The latest entry per key, taken-out ones included, as the binder saves
// them: the later at, then the text that sorts last.
export function extraCardEntries(binder) {
	const latest = new Map();

	for (const entry of (binder && Array.isArray(binder.extra_cards) ? binder.extra_cards : []).map(cleanExtra).filter(Boolean)) {
		const there = latest.get(entry.key);

		if (!there || entry.at > there.at || (entry.at === there.at && JSON.stringify(entry) > JSON.stringify(there))) {
			latest.set(entry.key, entry);
		}
	}

	return [...latest.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// The cards added by hand, in the order added: their keys.
export const extraKeysOf = (binder) => extraCardEntries(binder).filter((entry) => entry.kind === 'add').map((entry) => entry.key);

// The entries with one put in place of its key's.
export const withExtraCard = (entries, entry) => [...entries.filter((one) => one.key !== entry.key), entry];

// The items with the cards added by hand after the list's, each once: a
// card the list has already keeps its list pocket. itemFor(key) builds the
// item (js/binder-sources.js cardItem with the card's copies).
export function withExtraItems(items, binder, itemFor) {
	const have = new Set((items || []).map((item) => item.key));

	return [...(items || []), ...extraKeysOf(binder).filter((key) => !have.has(key)).map(itemFor)];
}

// How many keys of a layout are cards added by hand.
export const addedCount = (keys, binder) => {
	const added = new Set(extraKeysOf(binder));

	return (keys || []).filter((key) => added.has(key)).length;
};

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

		const rank = copyRank(entry, rankOf);

		if (!best || beats(rank, entry, bestRank, best)) {
			best = entry;
			bestRank = rank;
		}
	}

	return best;
}

const copyRank = (entry, rankOf) => {
	const raw = rankOf(entry) || {};

	return {
		created: text(entry.created_at),
		rarity: rarityRank(raw.rarity),
		value: Number.isFinite(raw.value) ? raw.value : null,
	};
};

// The same order as a sort comparator, best copy first, for the copies that
// fill placeholders (js/placeholder-fill.js fillPlan; Eric, 2026-11-06).
// Each copy's rank is worked out once.
export function copyOrder(rankOf = () => ({})) {
	const ranks = new Map();
	const rankOfCopy = (entry) => {
		if (!ranks.has(entry)) {
			ranks.set(entry, copyRank(entry, rankOf));
		}

		return ranks.get(entry);
	};

	return (a, b) => {
		const rankA = rankOfCopy(a);
		const rankB = rankOfCopy(b);

		if (beats(rankA, a, rankB, b)) {
			return -1;
		}

		return beats(rankB, b, rankA, a) ? 1 : 0;
	};
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

// The copies skipped in one binder's pockets ("Not this copy here"): Map key
// -> Set of entry ids. A deleted entry skips nothing.
export function skipsOf(list, binderId) {
	const out = new Map();

	for (const pick of Array.isArray(list) ? list : []) {
		const ids = pick && !pick.deleted_at && pick.binder_id === binderId && typeof pick.key === 'string' ? cleanSkipped(pick.skipped) : [];

		if (ids.length) {
			out.set(pick.key, new Set(ids));
		}
	}

	return out;
}

// Skipped ids as stored: strings, once each, sorted, so two phones that
// compare entries as text agree.
const cleanSkipped = (ids) => (Array.isArray(ids) ? [...new Set(ids.filter((id) => typeof id === 'string' && id))].sort() : []);

const NO_SKIPS = new Set();

// ------------------------------------------------- copies in use elsewhere
//
// A copy is in one pocket at a time (Eric, 2026-11-24: the Cyndaquil in his
// 30th-anniversary binder kept showing in Johto's pocket too). Every pocket
// that holds or shows a copy claims it, and a pocket's default passes over
// a copy claimed by anything that outranks it, so it shows another copy,
// else its placeholder. Strongest first (Eric's order):
//   hand     a hand-made binder's pocket, where the copy really is
//   pick     a hand pick in a binder from a list (two picks of one copy both
//            stand: each was asked for)
//   card     the default in a card's pocket, which only that print fits
//   pokemon  the default in a Pokémon's pocket, which any print of it fits
// then the older binder (created_at, then id), then the earlier pocket.
// Each pocket looks only at claims above its own, so no two binders can
// take a copy back and forth. Nothing new is stored: the claims come from
// the binders, the picks, and each binder's last layout (js/binders.js
// copyClaims).
//
// A claim: {entryId, rank, age, binderId, binderName, index, key}; age is
// the binder's created_at, index the pocket's place in the binder.
export const CLAIM_RANK = {card: 2, hand: 0, pick: 1, pokemon: 3};

// The rank of a pocket's default: a card's, else a Pokémon's.
export const defaultRank = (key) => (parseKey(key) && parseKey(key).kind === 'card' ? CLAIM_RANK.card : CLAIM_RANK.pokemon);

// A binder not saved yet is the newest.
const NEWEST = '\uffff';

export function outranks(a, b) {
	if (a.rank !== b.rank) {
		return a.rank < b.rank;
	}

	if (a.binderId !== b.binderId) {
		const ageA = text(a.age) || NEWEST;
		const ageB = text(b.age) || NEWEST;

		return ageA !== ageB ? ageA < ageB : text(a.binderId) < text(b.binderId);
	}

	return a.index < b.index;
}

// Claims by copy: Map entry id -> [claim].
export function claimIndex(claims) {
	const out = new Map();

	for (const claim of claims || []) {
		if (claim && typeof claim.entryId === 'string') {
			out.set(claim.entryId, [...(out.get(claim.entryId) || []), claim]);
		}
	}

	return out;
}

// The copies a pocket's default passes over: Map entry id -> the claim that
// outranks it. index: claimIndex(); copies: the pocket's copies; pocket:
// {age, binderId, index, key}. The pocket's own pick never counts.
export function takenFor(index, copies, pocket) {
	const me = {...pocket, rank: defaultRank(pocket.key)};
	const out = new Map();

	for (const entry of copies || []) {
		const best = (index.get(entry.id) || [])
			.filter((claim) => !(claim.binderId === me.binderId && claim.key === me.key) && outranks(claim, me))
			.sort((a, b) => (outranks(a, b) ? -1 : outranks(b, a) ? 1 : 0))[0];

		if (best) {
			out.set(entry.id, best);
		}
	}

	return out;
}

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
// the stamp; previous the entry it replaces, if any (its created_at stays,
// and its skipped copies unless skipped is given). A copy picked by hand is
// no longer skipped there. skipped is left out when it lists nothing, so a
// pick without skips is the entry it always was.
export function pickEntry({at, binderId, entryId, key, previous = null, skipped = undefined}) {
	const skips = cleanSkipped(skipped === undefined ? previous && previous.skipped : skipped).filter((id) => id !== entryId);

	return {
		binder_id: binderId,
		created_at: (previous && previous.created_at) || at,
		deleted_at: null,
		entry_id: entryId || null,
		id: pickId(binderId, key),
		key,
		...(skips.length ? {skipped: skips} : {}),
		updated_at: at,
	};
}

// ------------------------------------------------- left out and moved
//
// A binder from a list can leave a Pokémon or card out, or move it, as an
// exception stored on the binder (Eric, 2026-11-06: "I should be able to
// remove cards in binders (even automatic ones)"). list_edits is a list of
// {key, kind, before, at}, one per key, the latest kept:
//   out     left out, and the pockets after it move back one
//   gap     left out, and its pocket stays empty (an empty key, '', in
//           snapshot.keys: every app since binders from a list draws a
//           pocket with no key as Empty)
//   end     moved to the end of the binder
//   before  moved to just before the key `before`; when that key is not in
//           the list, it keeps its list place
// They apply after the list's order, oldest first, on every refresh, so a
// card that joins the list later still takes its list place.

// none    the key's exception taken away (Undo, Put back), so taking it away
//         wins the merge over the exception it replaces
// blank   an empty pocket inserted (Eric, 2026-11-24: a third pocket after
//         Meowstic, for the female and the male): its key is its own,
//         "blank:<id>", and it goes just before the key `before`, or at the
//         end when before is '' or not in the list. It lays out as an
//         empty key, '', which every app draws as Empty; an older app, which
//         does not know the kind, leaves it out of its layout, and its merge
//         keeps the entry (js/merge.js keeps any edit with a key).
// js/merge.js merges the field key by key, the latest `at` standing.

export const LIST_EDIT_KINDS = ['out', 'gap', 'end', 'before', 'none', 'blank'];

export const BLANK = 'blank:';

// A new inserted pocket's edit: before the key `before` ('' for the end).
export const blankEdit = ({at, before = '', id}) => ({at, before: before || '', key: `${BLANK}${id}`, kind: 'blank'});

// One edit cleaned, or null. Its keys in sorted order, so two phones that
// compare edits as text agree (js/merge.js stableJson).
function cleanListEdit(edit) {
	if (!isObject(edit) || typeof edit.key !== 'string' || !edit.key || !LIST_EDIT_KINDS.includes(edit.kind) || typeof edit.at !== 'string') {
		return null;
	}

	if (edit.kind === 'before') {
		return typeof edit.before === 'string' && edit.before && edit.before !== edit.key ? {at: edit.at, before: edit.before, key: edit.key, kind: 'before'} : null;
	}

	if (edit.kind === 'blank') {
		return edit.key.startsWith(BLANK) && edit.key.length > BLANK.length ? {at: edit.at, before: typeof edit.before === 'string' ? edit.before : '', key: edit.key, kind: 'blank'} : null;
	}

	return {at: edit.at, key: edit.key, kind: edit.kind};
}

// Every key's latest edit, taken-away ones (none) included, as the binder
// saves them: the later `at`, then the one whose text sorts last.
export function listEditEntries(binder) {
	const raw = binder && Array.isArray(binder.list_edits) ? binder.list_edits : [];
	const latest = new Map();

	for (const edit of raw.map(cleanListEdit).filter(Boolean)) {
		const there = latest.get(edit.key);

		if (!there || edit.at > there.at || (edit.at === there.at && JSON.stringify(edit) > JSON.stringify(there))) {
			latest.set(edit.key, edit);
		}
	}

	return [...latest.values()];
}

// The binder's edits that apply, oldest first (then by key, so every phone
// applies them alike).
export function listEditsOf(binder) {
	return listEditEntries(binder)
		.filter((edit) => edit.kind !== 'none')
		.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : byKey(a, b)));
}

// The saved edits with `edit` in place of the key's: an exception, or
// {key, kind: 'none', at} to take it away.
export function withListEdit(entries, edit) {
	return [...(Array.isArray(entries) ? entries : []).filter((item) => item && item.key !== edit.key), edit];
}

// The pockets' keys in order after the edits: keys is the list's order.
// The empty pockets of a layout, by place: {index: 'blank:<id>' |
// 'gap:<key>'}, for snapshot.marks. keys: the list's order, as
// applyListEdits takes it.
export function listMarks(keys, edits) {
	const marked = applyListEdits(keys, edits, {mark: true});
	const out = {};

	marked.forEach((key, i) => {
		if (key.startsWith(BLANK) || key.startsWith('gap:')) {
			out[i] = key;
		}
	});

	return out;
}

const blankMarks = (marks) => Object.fromEntries(Object.entries(isObject(marks) ? marks : {}).filter(([, key]) => String(key).startsWith(BLANK)));

// mark: an inserted pocket lays out as its own key ("blank:<id>") and a
// pocket left empty on purpose as "gap:<key>", rather than '', so the screen
// can tell which empty pocket is which (listMarks).
export function applyListEdits(keys, edits, {mark = false} = {}) {
	const out = [...keys];

	for (const edit of edits) {
		if (edit.kind === 'blank') {
			const at = edit.before ? out.indexOf(edit.before) : -1;
			const blank = mark ? edit.key : '';

			if (at < 0) {
				out.push(blank);
			}
			else {
				out.splice(at, 0, blank);
			}

			continue;
		}

		const i = out.indexOf(edit.key);

		if (i < 0) {
			continue;
		}

		if (edit.kind === 'out') {
			out.splice(i, 1);
		}
		else if (edit.kind === 'gap') {
			out[i] = mark ? `gap:${edit.key}` : '';
		}
		else if (edit.kind === 'end') {
			out.splice(i, 1);
			out.push(edit.key);
		}
		else if (out.includes(edit.before)) {
			out.splice(i, 1);
			out.splice(out.indexOf(edit.before), 0, edit.key);
		}
	}

	return out;
}

// The edit that moves the key in pocket `from` to pocket `to` (indexes
// from 0 into keys, the pockets as shown): the cards between shift to make
// room. to past the last key, or 'end', is the end of the binder. Null
// when nothing would move.
export function moveEdit(keys, from, to, at) {
	const key = keys[from];

	if (!key) {
		return null;
	}

	const rest = keys.filter((_, i) => i !== from);
	const last = to === 'end' || to >= keys.length - 1;
	const place = last ? rest.length : Math.max(0, to);

	if (place === from && !last) {
		return null;
	}

	const after = rest.slice(place).find(Boolean);

	if (last || !after) {
		const real = keys.filter(Boolean);

		return real[real.length - 1] === key && keys[keys.length - 1] === key ? null : {at, key, kind: 'end'};
	}

	return {at, before: after, key, kind: 'before'};
}

// ------------------------------------------------------------ the layout

// A pocket's copies as different cards (Eric, 2026-11-25: a pocket said 4
// cards fit and all four were the same card). Copies of one card in one
// language are one card there, whatever their finish: the pocket counts
// the cards, its sheet and viewer show each card once, and the finishes
// show as badges on it. Groups keep the order of the copies given.
export const cardLanguageKey = (entry) => JSON.stringify([entry.catalog || 'international', entry.card_id, entry.language || null]);

export function cardGroups(copies) {
	const groups = new Map();

	for (const entry of copies || []) {
		const key = cardLanguageKey(entry);

		if (!groups.has(key)) {
			groups.set(key, []);
		}

		groups.get(key).push(entry);
	}

	return [...groups.values()];
}

export const distinctCards = (copies) => cardGroups(copies).length;

// The copy that stands for a group of one card: the one the pocket shows
// when it is in the group, else the copy the default would pick among them
// (skipped and taken passed over), else the first.
export function groupFace(group, {rankOf, shownId = null, skipped = NO_SKIPS, taken = NO_SKIPS} = {}) {
	const shown = shownId ? group.find((entry) => entry.id === shownId) : null;

	if (shown) {
		return shown;
	}

	const best = shownCopy({copies: group}, {rankOf, skipped, taken});

	return best ? best.entry : group[0];
}

// The copy a pocket shows: a hand pick while it still fits, else the
// default the last refresh stored while it still fits, else the default
// now. skipped: the copies not wanted in this pocket (skipsOf), which only
// a hand pick shows. Returns {entry, picked} or null when nothing fits: the
// pocket's placeholder.
export function shownCopy(item, {pick = null, rankOf, skipped = NO_SKIPS, stored = null, taken = NO_SKIPS} = {}) {
	const copies = (item && item.copies) || [];
	const find = (id) => (id ? copies.find((entry) => entry.id === id && !entry.deleted_at) || null : null);
	const picked = find(pick);
	// taken: copies in use where they outrank this pocket (takenFor).
	const passed = (id) => skipped.has(id) || taken.has(id);

	if (picked) {
		return {entry: picked, picked: true};
	}

	const kept = passed(stored) ? null : find(stored);

	if (kept) {
		return {entry: kept, picked: false};
	}

	const fresh = defaultCopy(copies.filter((entry) => !passed(entry.id)), rankOf);

	return fresh ? {entry: fresh, picked: false} : null;
}

// What a refresh changes, without saving it. items: the source's pockets,
// sorted (sortRuleItems), each with its copies. picks: picksOf(). rankOf
// ranks a copy for the default. partial: the source could not tell every
// copy (offline, or Pokédex numbers still unknown), so a pocket whose stored
// default is still a live copy keeps it rather than going empty (liveIds).
//
// A checklist that names languages fills its pockets only from copies in
// them (js/binder-sources.js checklistItems), while a v56 phone fills them
// from any language. anyItems: the pockets as a v56 phone reads them
// (checklistAnyItems), and languages: the list's languages (listLanguagesKey),
// both from loadRuleItems. With them, languageOnly is true when the stored
// layout is what a v56 phone would save and the only difference is the
// list's languages, which that phone would undo on its next opening, and
// the binder last recorded these same languages (list_languages): the
// screen then leaves the stored layout alone on opening and saves only on
// Refresh, so two phones never save the binder back and forth (DESIGN.md,
// "Binders from a list").
//
// edits: the binder's list_edits (listEditsOf), applied after the order.
// skips: skipsOf(), the copies a pocket's default passes over.
// claims: the copies in use (js/binders.js copyClaims), passed over where
// they outrank the pocket; this binder's own last defaults are worked out
// again here, its pockets in rank order. inUse: pockets that show another
// copy, or their placeholder, because their copy is in use elsewhere.
// The pages are the pockets' and the binder's extra pages (extraPagesOf).
//
// keepOrder: the stored pockets keep their places and keys new to the list
// go at the end (keptOrder), when the stored layout was made for this rule;
// a Pokémon goal in set order (js/binder-sources.js POKEMON_GOAL_ORDER).
// An older phone does not know that goal, so languageOnly and editsOnly,
// which are about what an older phone saves, are not worked out for it.
//
// Returns {snapshot, page_count, added, removed, filled, emptied, updated,
// changed, languageOnly, editsOnly, languages}:
//   added, removed  keys that joined or left the list
//   filled          keys that had no copy and have one now
//   emptied         keys that had a copy and have none now (sold, or no
//                   copy in the list's languages)
//   updated         keys whose default moved to another copy (pockets
//                   picked by hand never count: their pick stays)
//   changed         anything to save
//   languageOnly    see above; false without anyItems
//   editsOnly       the stored layout is the list's own order without the
//                   binder's list_edits, as a phone on v64 or older saves
//                   it: the screen leaves it alone on opening, as for
//                   languageOnly (DESIGN.md, "Left out and moved")
//   languages       as given, for saveRefresh to record on the binder
export function planRefresh(binder, items, {anyItems = null, at, claims = [], edits = listEditsOf(binder), keepOrder = false, languages = undefined, liveIds = null, partial = false, picks = new Map(), rankOf, skips = new Map()} = {}) {
	const before = isObject(binder.snapshot) ? binder.snapshot : {};
	const oldKeys = Array.isArray(before.keys) ? before.keys : [];
	const oldShown = isObject(before.shown) ? before.shown : {};
	const oldSet = new Set(oldKeys);
	const listOrder = items.map((item) => item.key);
	const kept = keepOrder && oldKeys.length > 0 && before.rule_key === ruleKey(binder.rule);
	const base = kept ? keptOrder(listOrder, oldKeys, listEditEntries(binder)) : listOrder;
	const keys = applyListEdits(base, edits);
	// Which empty pocket is which: an inserted one or one left empty.
	const marks = listMarks(base, edits);
	const newSet = new Set(keys);
	const shown = {};
	const filled = [];
	const emptied = [];
	const updated = [];
	const inUse = [];
	// Others' claims, and this binder's picks; its own last defaults are
	// replaced by the ones worked out below, card pockets first, then in
	// pocket order, each claiming its copy for the pockets after it.
	const index = claimIndex((claims || []).filter((claim) => !(claim.binderId === binder.id && claim.rank >= CLAIM_RANK.card)));
	const place = new Map(keys.map((key, i) => [key, i]));
	const order = items.filter((item) => newSet.has(item.key))
		.sort((a, b) => (defaultRank(a.key) - defaultRank(b.key)) || (place.get(a.key) - place.get(b.key)));

	for (const item of order) {
		const skipped = skips.get(item.key) || NO_SKIPS;
		const pocket = {age: binder.created_at, binderId: binder.id, index: place.get(item.key), key: item.key};
		const taken = takenFor(index, item.copies, pocket);
		const open = item.copies.filter((entry) => !skipped.has(entry.id));
		const fresh = defaultCopy(open.filter((entry) => !taken.has(entry.id)), rankOf);
		const unclaimed = taken.size ? defaultCopy(open, rankOf) : fresh;
		let id = fresh ? fresh.id : null;
		const kept = oldShown[item.key];

		if (!id && partial && kept && !skipped.has(kept) && !taken.has(kept) && (!liveIds || liveIds.has(kept))) {
			id = kept;
		}

		if (id) {
			shown[item.key] = id;

			// A pocket picked by hand claims its pick (in claims), not this.
			if (!picks.has(item.key)) {
				index.set(id, [...(index.get(id) || []), {...pocket, entryId: id, rank: defaultRank(item.key)}]);
			}
		}

		if (!oldSet.has(item.key)) {
			continue;
		}

		const had = oldShown[item.key] || null;
		const elsewhere = Boolean(unclaimed) && (!fresh || fresh.id !== unclaimed.id) && had !== id && !picks.has(item.key);

		if (elsewhere) {
			inUse.push(item.key);
		}
		else if (!had && id) {
			filled.push(item.key);
		}
		else if (had && !id) {
			emptied.push(item.key);
		}
		else if (had && id && had !== id && !picks.has(item.key)) {
			updated.push(item.key);
		}
	}

	// In pocket order, as the other lists are.
	inUse.sort((a, b) => place.get(a) - place.get(b));
	filled.sort((a, b) => place.get(a) - place.get(b));
	emptied.sort((a, b) => place.get(a) - place.get(b));
	updated.sort((a, b) => place.get(a) - place.get(b));

	const added = keys.filter((key) => key && !oldSet.has(key));
	const removed = oldKeys.filter((key) => key && !newSet.has(key));
	const pageCount = listPageCount(keys.length, binder.rows, binder.cols, extraPagesOf(binder), addedCount(keys, binder));
	const snapshot = {at, keys, rule_key: ruleKey(binder.rule), shown, ...(Object.keys(marks).length ? {marks} : {})};
	const same = before.rule_key === snapshot.rule_key
		&& oldKeys.length === keys.length && oldKeys.every((key, i) => key === keys[i])
		&& sameShown(oldShown, shown)
		// Only the inserted pockets: marks of pockets left empty ride along
		// with the next change, so a binder saved before marks existed is
		// not saved again just to gain them.
		&& JSON.stringify(blankMarks(before.marks)) === JSON.stringify(blankMarks(marks));

	const changed = !same || binder.page_count !== pageCount;
	let languageOnly = false;
	let editsOnly = false;

	// What an older phone saves: the list's own order, without the edits it
	// does not know (v57 to v64), and from any language (v56).
	if (changed && edits.length && !keepOrder) {
		editsOnly = !planRefresh(binder, items, {at, claims, edits: [], liveIds, partial, picks, rankOf, skips}).changed;
	}

	if (changed && !keepOrder && Array.isArray(anyItems) && typeof languages === 'string' && binder.list_languages === languages) {
		languageOnly = !planRefresh(binder, anyItems, {at, claims, edits: [], liveIds, partial, picks, rankOf, skips}).changed;
	}

	return {
		added,
		changed,
		editsOnly,
		emptied,
		filled,
		inUse,
		languageOnly,
		languages,
		page_count: pageCount,
		removed,
		snapshot,
		updated,
	};
}

// Whether a binder must wait for the whole list before a layout of it is
// made or saved. loaded: js/binder-sources.js loadRuleItems; binder: the
// binder as stored, or as the form would save it ({rule, snapshot}). A list
// read only in part (incomplete) waits: a layout from it would drop the
// pockets of the cards not read, or put undated ones last. One exception:
// when the binder keeps its pockets in place (keepOrder, its stored layout
// made for this rule) and the only gap is sets not read (js/goals.js gapText
// 'sets'), every card is there and only dates are missing, which matter
// only to where a card new to the layout goes. It waits then only while a
// card new to the layout is undated in a set not read (DESIGN.md, "Binders
// from a list").
export function layoutWaits(binder, loaded) {
	if (!loaded || !loaded.incomplete) {
		return false;
	}

	const gaps = Array.isArray(loaded.gaps) ? loaded.gaps : [];
	const before = binder && isObject(binder.snapshot) ? binder.snapshot : {};
	const stored = Array.isArray(before.keys) ? before.keys : [];
	const kept = Boolean(loaded.keepOrder) && stored.length > 0 && before.rule_key === ruleKey(binder.rule);

	if (!kept || !gaps.length || !gaps.every((gap) => gap.kind === 'sets')) {
		return true;
	}

	const had = new Set(stored);
	const unread = (item) => gaps.some((gap) => gap.catalog === item.catalog && (!Array.isArray(gap.setIds) || !gap.setIds.length || gap.setIds.includes(item.setId)));

	return (loaded.items || []).some((item) => !had.has(item.key) && !item.releaseDate && unread(item));
}

// The list's order for a binder that keeps its pockets in place, before
// its edits (applyListEdits) apply. listOrder: the keys in the rule's
// order; stored: the last layout's keys; edits: the binder's edit entries
// (listEditEntries), a taken-away one (none) too.
//   - a stored key still in the list keeps its place among the others
//   - a stored empty key ('', a gap's pocket) keeps its place too: each key
//     kept as a gap and missing from the layout takes one, the gaps in the
//     list's order into the empty pockets in the layout's, so the gap never
//     moves and the pockets after it never shift
//   - any other key not stored that has an edit (left out, Put back, Undo,
//     or a gap with no empty pocket left) takes its list place: just after
//     the nearest key before it in the rule's order whose pocket still sits
//     in the rule's order, so a card that joined at the end or was moved
//     is never the anchor, and Put back returns a card where it was
//   - any other key is new to the list and goes at the end, in the rule's
//     order
// An empty pocket no gap takes (its card left the list, or was put back)
// goes, and the pockets after it move back one.
export function keptOrder(listOrder, stored, edits = []) {
	const live = new Set(listOrder);
	const rank = new Map(listOrder.map((key, i) => [key, i]));
	const kinds = new Map((Array.isArray(edits) ? edits : []).filter((edit) => edit && edit.key).map((edit) => [edit.key, edit.kind]));
	const HOLE = null;
	const out = stored.filter((key) => key === '' || live.has(key)).map((key) => (key === '' ? HOLE : key));
	const placed = new Set(out.filter((key) => key !== HOLE));
	const waiting = listOrder.filter((key) => !placed.has(key) && kinds.has(key));

	// Each gap missing from the layout into an empty pocket.
	for (const key of waiting.filter((one) => kinds.get(one) === 'gap')) {
		const hole = out.indexOf(HOLE);

		if (hole < 0) {
			break;
		}

		out[hole] = key;
		placed.add(key);
	}

	// The anchors: the pockets that still sit in the rule's order. A key
	// moved, or about to leave, is never one, and of the longest run in the
	// rule's order the earliest pockets are, so a card added at the end is
	// not taken for one in place.
	const anchors = inOrder(out.filter((key) => key !== HOLE && !['out', 'end', 'before'].includes(kinds.get(key))), rank);

	for (const key of waiting.filter((one) => !placed.has(one))) {
		const i = rank.get(key);
		let at = -1;

		for (let j = i - 1; j >= 0 && at < 0; j--) {
			if (anchors.has(listOrder[j])) {
				at = out.indexOf(listOrder[j]) + 1;
			}
		}

		for (let j = i + 1; j < listOrder.length && at < 0; j++) {
			if (anchors.has(listOrder[j])) {
				at = out.indexOf(listOrder[j]);
			}
		}

		if (at < 0) {
			continue;
		}

		out.splice(at, 0, key);
		placed.add(key);
		anchors.add(key);
	}

	return [...out.filter((key) => key !== HOLE), ...listOrder.filter((key) => !placed.has(key))];
}

// The keys of the longest run of `keys` in the rule's order (rank), the
// earliest positions taken where two runs are as long.
function inOrder(keys, rank) {
	const n = keys.length;
	const longest = new Array(n).fill(1);

	for (let i = n - 1; i >= 0; i--) {
		for (let j = i + 1; j < n; j++) {
			if (rank.get(keys[j]) > rank.get(keys[i]) && longest[j] + 1 > longest[i]) {
				longest[i] = longest[j] + 1;
			}
		}
	}

	const out = new Set();
	let need = Math.max(0, ...longest);
	let last = -1;

	for (let i = 0; i < n && need > 0; i++) {
		if (longest[i] === need && (last < 0 || rank.get(keys[i]) > rank.get(keys[last]))) {
			out.add(keys[i]);
			last = i;
			need--;
		}
	}

	return out;
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

	if (plan.emptied && plan.emptied.length) {
		parts.push(`${plan.emptied.length === 1 ? '1 pocket' : `${plan.emptied.length} pockets`} emptied: no copy you own fits ${plan.emptied.length === 1 ? 'it' : 'them'} now (${named(plan.emptied)})`);
	}

	if (plan.updated.length) {
		parts.push(`${plan.updated.length === 1 ? '1 pocket shows' : `${plan.updated.length} pockets show`} another copy by default`);
	}

	if (plan.inUse && plan.inUse.length) {
		parts.push(`${plan.inUse.length === 1 ? '1 pocket no longer shows a copy' : `${plan.inUse.length} pockets no longer show copies`} in use in another binder or pocket (${named(plan.inUse)})`);
	}

	return parts.length ? `${parts.join('; ')}.` : '';
}
