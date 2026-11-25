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
// keeps every copy (js/wishlist.js favoriteCards), one copy per card and
// language is kept, and the rest are spares (spareEntries); a spare taken
// off sale (for_sale false) stays his, and a copy marked For sale is offered
// wherever it is (js/shop.js freeCopyIds). A copy in a binder's tray is not
// in a pocket, so it is loose for this rule (Eric, 2026-11-24).
//
// Worked out without the page, so node can test it
// (tests/spare-check.test.mjs).

import {copyClaims, heldCopies, liveBinders, pageOfPocket, placements, stagedOf} from './binders.js';
import {tileKey} from './bulk-edit.js';
import {isLive} from './collection.js';
import {freeText} from './format.js';
import {freeCopyIds, shopGroups} from './shop.js';
import {favoriteCards, favoriteKey} from './wishlist.js';

// Why a copy counts as it does, in the order the screen explains them.
export const REASONS = {
	spare: {free: true, label: 'Spare', text: 'Free to trade or sell.'},
	forSale: {free: true, label: 'For sale', text: 'Marked For sale, so it is offered wherever it is.'},
	offSale: {free: false, label: 'Not for sale', text: 'A spare you took off sale, so it stays yours.'},
	pocket: {free: false, label: 'In a pocket', text: 'In a binder pocket, so it is not a spare.'},
	favorite: {free: false, label: 'Favorite', text: 'A favorite card: no copy is a spare.'},
	kept: {free: false, label: 'Kept', text: 'The one copy kept in this language.'},
};

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

// The copies of a card and language: [{entry, free, places, reason}], the
// free ones first, then the order REASONS lists, then the oldest first.
// ids: {free, held, spare} Sets; favorites: favoriteCards' Set.
function copyRows(entries, {favorites, ids, places}) {
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

		return {entry, free: REASONS[reason].free, places: places.get(entry.id) || [], reason};
	});

	return rows.sort((a, b) => (order.indexOf(a.reason) - order.indexOf(b.reason))
		|| String(a.entry.created_at || '').localeCompare(String(b.entry.created_at || ''))
		|| String(a.entry.id).localeCompare(String(b.entry.id)));
}

// What Check spares shows: one group per card and language that has more
// than one live copy, [{key, catalog, card_id, language, copies, free,
// rows}], copies and free being counts. only: {catalog, card_id} narrows it
// to one card, every language, even a language with one copy (the card
// page's Check). Groups with free copies come first, the most first.
// codeOf: the set's printed code, as the Shop takes it (js/shop.js
// shopGroups), so a hand-made twin counts as the Shop counts it.
export function spareCheck(doc, {codeOf = () => null, only = null} = {}) {
	const cards = ((doc && doc.cards) || []).filter((entry) => entry && isLive(entry));
	const held = heldCopies(doc);
	const groups = shopGroups(cards, {codeOf, held});
	const ids = {
		free: freeCopyIds(null, {groups}),
		held,
		spare: new Set(groups.flatMap((group) => group.spares || []).map((entry) => entry.id)),
	};
	const context = {favorites: favoriteCards(cards), ids, places: placesOf(doc)};
	const byKey = new Map();

	for (const entry of cards) {
		const catalog = entry.catalog || 'international';

		if (only && (only.card_id !== entry.card_id || (only.catalog || 'international') !== catalog)) {
			continue;
		}

		const key = tileKey({...entry, catalog});

		byKey.set(key, [...(byKey.get(key) || []), entry]);
	}

	return [...byKey.entries()]
		.filter(([, entries]) => only || entries.length > 1)
		.map(([key, entries]) => {
			const rows = copyRows(entries, context);

			return {
				card_id: entries[0].card_id,
				catalog: entries[0].catalog || 'international',
				copies: rows.length,
				free: rows.filter((row) => row.free).length,
				key,
				language: entries[0].language || null,
				rows,
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
