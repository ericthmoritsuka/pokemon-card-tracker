// Held and free, worked out in one place (Eric, 2026-11-26: the binders
// showed Illumise 30th and Cherrim as held while the Shop counted the same
// copy free and listed it). Trade, Check spares, the tile's ×N | M badge,
// the binders, and the Shop all read a copy's state from copyState, so they
// can never disagree again (tests/held-free.test.mjs checks the five on
// tests/fixtures/collection-shape.mjs).
//
// held: the copies in use in a pocket (js/binders.js heldCopies).
// spare: the copies the spare rule frees (js/wishlist.js spareEntries, run
// by js/shop.js shopGroups, which also pairs a hand-made copy with its
// catalog twin).
// free: the copies free to trade or sell (js/shop.js freeCopyIds): every
// spare not taken off sale, plus every copy marked For sale.
// groups: shopGroups' rows, for a caller that prices or lists them.
//
// Worked out without the page, so node can test it.

import {heldCopies} from './binders.js';
import {printedCode} from './catalog.js';
import {isLive} from './collection.js';
import {freeCopyIds, listedOf, shopGroups} from './shop.js';

// doc: {binders, binder_picks, cards}. cards: the copies to count, when the
// caller read them apart from the document (the Shop's listCards); else the
// document's. codeOf: the set's printed code, for pairing hand-made twins.
export function copyState(doc, {cards = null, codeOf = printedCode} = {}) {
	const held = heldCopies(doc);
	const live = (cards || (doc && doc.cards) || []).filter((entry) => entry && isLive(entry));
	const groups = shopGroups(live, {codeOf, held});

	return {
		free: freeCopyIds(null, {groups}),
		groups,
		held,
		spare: new Set(groups.flatMap((group) => group.spares || []).map((entry) => entry.id)),
	};
}

// The copies free to trade or sell, in the order the spare rule gives them
// (each finish's spares, best kept last, then the copies marked For sale):
// what Trade lists.
export function freeEntries(doc, options = {}) {
	const {groups} = copyState(doc, options);
	const byId = new Map(((doc && doc.cards) || []).filter(Boolean).map((entry) => [entry.id, entry]));
	const seen = new Set();

	return groups.flatMap(listedOf).filter((entry) => !seen.has(entry.id) && seen.add(entry.id)).map((entry) => byId.get(entry.id) || entry);
}
