// Check spares (Eric, 2026-11-25): card by card, the copies the app thinks
// he has, where each one is, and why each counts as free or not, so he can
// tell whether his spare counts are right. He often gives cards away or
// does not log a trade, so the app keeps copies he no longer has; the
// screen (js/spare-check-view.js) logs each one he cannot find as given
// away, through the trades log (js/moves.js), so the spares, the Shop, and
// HOTARU follow.
//
// The rules are the ones already in force, read here and never restated:
// a copy in a pocket is held (js/binders.js heldCopies), a favorite card
// keeps every copy (js/wishlist.js favoriteCards), one copy per card,
// language, and finish is kept, and the rest are spares (spareEntries); a spare taken
// off sale (for_sale false) stays his, and a copy marked For sale is offered
// wherever it is (js/shop.js freeCopyIds). A copy in a binder's tray is not
// in a pocket, so it is loose for this rule (Eric, 2026-11-24).
//
// Worked out without the page, so node can test it
// (tests/spare-check.test.mjs).

import {copyClaims, heldCopies, liveBinders, pageOfPocket, placements, stagedOf} from './binders.js';
import {cardGroups, cardLanguageKey} from './binder-rules.js';
import {isLive} from './collection.js';
import {formatCount, freeText} from './format.js';
import {copyState} from './held-free.js';
import {languageLabel} from './languages.js';
import {favoriteCards, favoriteKey} from './wishlist.js';

// Why a copy counts as it does, in the order the screen explains them.
export const REASONS = {
	spare: {free: true, label: 'Spare', text: 'Free to trade or sell.'},
	forSale: {free: true, label: 'For sale', text: 'Marked For sale, so it is offered wherever it is.'},
	// The copy's off-sale mark (for_sale false): a spare that stays home,
	// is not listed, and is not counted free, which is what Keep this one
	// too sets (Eric, 2026-11-27).
	offSale: {free: false, label: 'Kept extra', text: 'A spare you chose to keep, so it stays home and is not offered.'},
	pocket: {free: false, label: 'In a pocket', text: 'In a binder pocket, so it is not a spare.'},
	favorite: {free: false, label: 'Favorite', text: 'A favorite card: no copy is a spare.'},
	kept: {free: false, label: 'Kept', text: 'The one copy kept in this finish and language.'},
};

// A copy's plain status (Eric, 2026-11-27: "which copies are free, and
// why"): "Free", "Free, priced R$ 2,00", "Free, marked For sale", "Kept",
// "Kept: in Kalos, page 3", "Kept extra" (the off-sale mark), or
// "Favorite". money: a price formatter (js/prices.js formatBrl).
export function rowStatus(row, money = (value) => String(value)) {
	const pocket = (row.places || []).find((place) => place.kind === 'pocket');

	switch (row.reason) {
	case 'spare':
		return row.price === null || row.price === undefined ? 'Free' : `Free, priced ${money(row.price)}`;
	case 'forSale':
		return row.price === null || row.price === undefined ? 'Free, marked For sale' : `Free, marked For sale, priced ${money(row.price)}`;
	case 'offSale':
		return 'Kept extra';
	case 'pocket':
		return pocket ? `Kept: in ${pocket.binder_name}, page ${pocket.page}` : 'Kept: in a binder';
	case 'favorite':
		return 'Favorite';
	default:
		return 'Kept';
	}
}

// One line per finish of a group: [{finish, kept, free, where}], where
// naming the binders the kept copies are in. finishOf(entry): the finish's
// name. The kept and free add up to the group's copies and free.
export function finishLines(rows, finishOf) {
	const lines = new Map();

	for (const row of rows) {
		const finish = finishOf(row.entry);
		const line = lines.get(finish) || {finish, free: 0, kept: 0, where: []};

		if (row.free) {
			line.free++;
		}
		else {
			line.kept++;

			for (const place of row.places || []) {
				if (place.kind === 'pocket' && !line.where.includes(place.binder_name)) {
					line.where.push(place.binder_name);
				}
			}
		}

		lines.set(finish, line);
	}

	return [...lines.values()];
}

// "Reverse Holo, Portuguese: 1 kept (in Kalos), 1 free".
export function finishLineText(line, language) {
	const name = [line.finish, language ? languageLabel(language) : null].filter(Boolean).join(', ');
	const kept = line.kept ? `${formatCount(line.kept)} kept${line.where.length ? ` (in ${line.where.join(', ')})` : ''}` : null;
	const free = line.free ? `${formatCount(line.free)} free` : null;

	return `${name}: ${[kept, free].filter(Boolean).join(', ')}`;
}

// A pile's count, the copies kept first: "2 kept, 3 free", "3 free", or
// "2 kept" (Eric, 2026-11-27).
export function pileText(rows) {
	const free = rows.filter((row) => row.free).length;
	const kept = rows.length - free;

	return [kept ? `${formatCount(kept)} kept` : null, free ? `${formatCount(free)} free` : null].filter(Boolean).join(', ');
}

// "Hoenn, page 3, pocket 4", "Tray of Hoenn", or "Loose".
export function placeLabel(place) {
	if (!place || place.kind === 'loose') {
		return 'Loose';
	}

	if (place.kind === 'tray') {
		return `Tray of ${place.binder_name}`;
	}

	return `${place.binder_name}, page ${place.page}, pocket ${place.position}`;
}

// Every place a copy is, as the binders say: [{kind, binder_id,
// binder_name, page, position}], kind 'pocket' or 'tray'. A copy a hand-made
// binder places is where placements puts it; the copy on top of a binder
// made from a list is in that pocket (copyClaims, the same picks and
// defaults heldCopies reads). A copy two binders both claim lists both, so
// the screen shows the clash rather than hiding it. A copy in no pocket but
// in a tray is in the tray; else it has no place (loose).
export function placesOf(doc) {
	const binders = liveBinders((doc && doc.binders) || []);
	const byId = new Map(binders.map((binder) => [binder.id, binder]));
	const held = heldCopies(doc);
	const out = new Map();
	const add = (entryId, place) => out.set(entryId, [...(out.get(entryId) || []), place]);

	for (const [entryId, {binder, slot}] of placements(binders)) {
		add(entryId, {binder_id: binder.id, binder_name: binder.name, kind: 'pocket', page: slot.page, position: slot.position});
	}

	for (const claim of copyClaims(doc)) {
		const binder = byId.get(claim.binderId);

		// Hand placements are above; a list's claim counts only while
		// heldCopies holds it, so the two never disagree.
		if (claim.key === null || !binder || !held.has(claim.entryId)) {
			continue;
		}

		add(claim.entryId, {binder_id: binder.id, binder_name: binder.name, kind: 'pocket', ...pageOfPocket(binder, claim.index + 1)});
	}

	for (const binder of binders) {
		for (const entryId of stagedOf(binder)) {
			if (!out.has(entryId) || out.get(entryId).every((place) => place.kind === 'tray')) {
				add(entryId, {binder_id: binder.id, binder_name: binder.name, kind: 'tray', page: null, position: null});
			}
		}
	}

	return out;
}

// The copies of a card and language: [{entry, free, places, reason, shop,
// price}], the free ones first, then the order REASONS lists, then the
// oldest first. shop: the Shop's row for the copy's finish (js/shop.js
// shopGroups), which its price is saved through, or null when the finish
// has no spare; price: that row's sale price or null.
// ids: {free, held, spare} Sets; favorites: favoriteCards' Set; shops: the
// Shop rows by copy id.
function copyRows(entries, {favorites, ids, places, shops}) {
	const order = Object.keys(REASONS);
	const rows = entries.map((entry) => {
		let reason = 'kept';

		if (ids.free.has(entry.id)) {
			reason = ids.spare.has(entry.id) ? 'spare' : 'forSale';
		}
		else if (ids.spare.has(entry.id)) {
			reason = 'offSale';
		}
		else if (ids.held.has(entry.id)) {
			reason = 'pocket';
		}
		else if (favorites.has(favoriteKey(entry))) {
			reason = 'favorite';
		}

		const shop = shops.get(entry.id) || null;

		return {entry, free: REASONS[reason].free, places: places.get(entry.id) || [], price: shop ? shop.price : null, reason, shop};
	});

	return rows.sort((a, b) => (order.indexOf(a.reason) - order.indexOf(b.reason))
		|| String(a.entry.created_at || '').localeCompare(String(b.entry.created_at || ''))
		|| String(a.entry.id).localeCompare(String(b.entry.id)));
}

// What Check spares shows: one group per card and language that has more
// than one live copy, [{key, catalog, card_id, language, copies, favorite,
// free, rows}], copies and free being counts. only: {catalog, card_id} narrows it
// to one card, every language, even a language with one copy (the card
// page's Check). Groups with free copies come first, the most first.
// codeOf: the set's printed code, as the Shop takes it (js/shop.js
// shopGroups), so a hand-made twin counts as the Shop counts it; left out,
// js/held-free.js copyState's (js/catalog.js printedCode).
export function spareCheck(doc, {codeOf, only = null} = {}) {
	const cards = ((doc && doc.cards) || []).filter((entry) => entry && isLive(entry));
	// Held, spare, and free from the one place every screen reads them
	// (js/held-free.js copyState).
	const {free, groups: shopRows, held, spare} = copyState(doc, codeOf ? {codeOf} : {});
	const ids = {free, held, spare};
	const shops = new Map();

	for (const row of shopRows) {
		for (const entry of [...row.copies, ...row.marked]) {
			shops.set(entry.id, row);
		}
	}

	const context = {favorites: favoriteCards(cards), ids, places: placesOf(doc), shops};
	const wanted = only ? cards.filter((entry) => only.card_id === entry.card_id && (only.catalog || 'international') === (entry.catalog || 'international')) : cards;

	// One card in one language, as a binder pocket counts cards
	// (js/binder-rules.js cardGroups), so the two always agree.
	return cardGroups(wanted)
		.filter((entries) => only || entries.length > 1)
		.map((entries) => {
			const rows = copyRows(entries, context);

			return {
				card_id: entries[0].card_id,
				catalog: entries[0].catalog || 'international',
				copies: rows.length,
				// The star covers the card in every language and finish
				// (js/wishlist.js favoriteCards), so an unstarred copy of a
				// starred card makes its group a favorite too.
				favorite: entries.some((entry) => context.favorites.has(favoriteKey(entry))),
				free: rows.filter((row) => row.free).length,
				key: cardLanguageKey(entries[0]),
				language: entries[0].language || null,
				rows,
				// The free copies with no sale price, for Show: No price.
				unpriced: rows.filter((row) => row.free && row.price === null).length,
			};
		})
		.sort((a, b) => (b.free - a.free) || (b.copies - a.copies) || a.key.localeCompare(b.key));
}

// The badge's and the group's words live in js/format.js, so the tile
// reads them without this module's imports.
export {freeText};

// The fields of the trades log entry that says a copy is gone (js/moves.js
// planMove): a gift, no money, today, with a note naming where it was
// logged, so History tells it apart from a gift he logged himself.
export function goneFields(entryId, {date}) {
	return {date, kind: 'gift', note: 'Not found in Check spares', out: [entryId], who: null};
}

// ------------------------------------------------- narrowing and order
//
// Eric, 2026-11-26: he keeps the cards to check in separate piles, so he
// narrows the list to one pile and walks it in his own order. The bar's
// search and filters (js/filter-bar.js) read an item per group; Where,
// Show, and the sort below are Check spares' own.

const collator = new Intl.Collator('en', {numeric: true, sensitivity: 'base'});

// Where filter values: 'pocket:<binder id>' for a binder's pockets,
// 'tray:<binder id>' for its tray, LOOSE for a copy in neither, and ANY.
export const ANY = 'any';
export const LOOSE = 'loose';

const whereOf = (place) => (place && place.kind !== 'loose' ? `${place.kind}:${place.binder_id}` : LOOSE);
const placesOrLoose = (row) => (row.places.length ? row.places : [null]);

// The places a copy is, as Where values.
export const rowWheres = (row) => placesOrLoose(row).map(whereOf);

// The Where choices the groups offer, with how many copies are at each:
// [{value, label, count}], each binder's pockets by binder name, then each
// tray, then Loose.
export function whereOptions(groups) {
	const options = new Map();

	for (const group of groups) {
		for (const row of group.rows) {
			for (const place of placesOrLoose(row)) {
				const value = whereOf(place);
				const old = options.get(value);
				const kind = value === LOOSE ? LOOSE : place.kind;

				options.set(value, {
					count: (old ? old.count : 0) + 1,
					kind,
					label: kind === LOOSE ? 'Loose' : kind === 'tray' ? `Tray of ${place.binder_name}` : String(place.binder_name || ''),
					name: kind === LOOSE ? '' : String(place.binder_name || ''),
					value,
				});
			}
		}
	}

	const rank = {loose: 2, pocket: 0, tray: 1};

	return [...options.values()]
		.sort((a, b) => (rank[a.kind] - rank[b.kind]) || collator.compare(a.name, b.name) || a.value.localeCompare(b.value))
		.map(({count, label, value}) => ({count, label, value}));
}

// Show: every group, the ones with a free copy, the ones with none, the
// ones with a free copy that has no sale price (Eric, 2026-11-27), the
// favorite cards, whose copies all stay (they are never spares), or the
// cards marked Checked, which every other choice leaves out.
export const SHOWS = [
	{label: 'All cards', value: 'all'},
	{label: 'With free copies', value: 'free'},
	{label: 'None free', value: 'nofree'},
	{label: 'No price', value: 'noprice'},
	{label: 'Favorites', value: 'favorite'},
	{label: 'Checked', value: 'checked'},
];

const showMatches = {
	all: () => true,
	checked: () => true,
	favorite: (group) => group.favorite === true,
	free: (group) => group.free > 0,
	nofree: (group) => group.free === 0,
	noprice: (group) => group.unpriced > 0,
};

// ------------------------------------------------------------- Checked
//
// Eric, 2026-11-26: a card whose copies are all where the list says leaves
// the list once he marks it Checked, so the next card comes up. The mark
// is only a note on this phone, {group key: signature}: it changes no copy,
// so a favorite stays a favorite and nothing turns free or for sale. The
// signature is each copy's ID and the finish it has stored (variant_id and
// finish_raw, as js/copy-sheet.js finishFields writes them), so a card
// comes back when a copy is added or goes, or when a copy's finish is set
// or changed (2026-11-26: the list it was checked against no longer holds).
// The stored fields, not a finish rule's key, so a later change to how
// finishes pair (js/wishlist.js copyFinishKey) leaves every mark standing.

// By ID in Array.prototype.sort's own order, which v122's marks used.
const byId = (a, b) => {
	const x = String(a.entry.id);
	const y = String(b.entry.id);

	return x < y ? -1 : x > y ? 1 : 0;
};
const rowsById = (group) => [...group.rows].sort(byId);

export const checkedSignature = (group) => JSON.stringify(rowsById(group).map(({entry}) => [String(entry.id), entry.variant_id || null, entry.finish_raw || null]));

// v122's marks were the IDs alone, joined by commas.
const idsSignature = (group) => rowsById(group).map((row) => String(row.entry.id)).join(',');

export const isChecked = (group, checked) => Boolean(checked) && Object.hasOwn(checked, group.key) && checked[group.key] === checkedSignature(group);

// The marks that still hold for the groups of a whole list, so a mark on
// a card whose copies changed is forgotten. Only for the whole list: one
// card's check has the groups of that card alone. A v122 mark whose IDs
// still match takes today's signature, so the cards checked before this
// release stay checked.
export function keepChecked(groups, checked) {
	const kept = {};

	for (const group of groups) {
		if (isChecked(group, checked)) {
			kept[group.key] = checked[group.key];
		}
		else if (checked && Object.hasOwn(checked, group.key) && checked[group.key] === idsSignature(group)) {
			kept[group.key] = checkedSignature(group);
		}
	}

	return kept;
}

// The groups Checked or not, as Show picks: the Where choices count these.
export const checkedPool = (groups, {checked = null, show = 'all'} = {}) => groups.filter((group) => isChecked(group, checked) === (show === 'checked'));

// The sorts, the bar's (js/filter-bar.js sortItems) and two of Check
// spares' own: the most free copies first, as the screen opened before
// 2026-11-26, and Where, which walks each binder page by page and pocket
// by pocket, then the trays, then the loose copies, so the list follows a
// pile as it lies.
export const CHECK_SORTS = [
	{label: 'Most free', long: 'Most free copies first', value: 'free'},
	{label: 'Where', long: 'Where they are: binder, page, and pocket, then trays, then loose', value: 'where'},
	{label: 'Set, oldest', long: 'Set and number, oldest set first', value: 'setOld'},
	{label: 'Set, newest', long: 'Set and number, newest set first', value: 'set'},
	{label: 'Name', long: 'Name, A to Z', value: 'name'},
	{label: 'Pokédex', long: 'Pokédex number', value: 'dex'},
];

const byFree = (a, b) => (b.group.free - a.group.free) || (b.group.copies - a.group.copies) || a.group.key.localeCompare(b.group.key);

// A group's first place in Where order, among the places Where keeps.
function firstPlace(group, where) {
	const rank = {pocket: 0, tray: 1};
	let best = null;

	for (const row of group.rows) {
		for (const place of placesOrLoose(row)) {
			if (where !== ANY && whereOf(place) !== where) {
				continue;
			}

			const key = place ? [rank[place.kind], String(place.binder_name || ''), place.binder_id, place.page || 0, place.position || 0] : [2, '', '', 0, 0];

			if (!best || comparePlaces(key, best) < 0) {
				best = key;
			}
		}
	}

	return best || [3, '', '', 0, 0];
}

function comparePlaces(a, b) {
	return (a[0] - b[0]) || collator.compare(a[1], b[1]) || String(a[2]).localeCompare(String(b[2])) || (a[3] - b[3]) || (a[4] - b[4]);
}

// The items Show and Where leave, in the sort's order. items: [{group}],
// as the bar's search and filters left them (the view applies those, so
// this module needs no page). sortItems: the bar's sort
// (js/filter-bar.js), for the sorts that are not Check spares' own.
// checked: the marks (see Checked above); a card marked Checked shows
// under Show: Checked only.
export function narrowChecks(items, {checked = null, show = 'all', sort = 'free', sortItems = null, where = ANY} = {}) {
	const kept = items
		.filter((item) => isChecked(item.group, checked) === (show === 'checked'))
		.filter((item) => (showMatches[show] || showMatches.all)(item.group))
		.filter((item) => where === ANY || item.group.rows.some((row) => rowWheres(row).includes(where)));

	if (sort === 'where') {
		return kept.map((item) => ({item, place: firstPlace(item.group, where)}))
			.sort((a, b) => comparePlaces(a.place, b.place) || byFree(a.item, b.item))
			.map(({item}) => item);
	}

	return sort === 'free' || !sortItems || !CHECK_SORTS.some((option) => option.value === sort) ? [...kept].sort(byFree) : sortItems(kept, sort);
}
