// The listing invariant, client half (plans/roadmap.md, "Backlog:
// preventing wrong listings", Eric 2026-11-26): a copy goes on HOTARU only
// when it is an owned, live copy that no binder holds and that is not the
// last copy of its card, language, and finish. The Shop checks it right
// before every store_sync upsert (js/shop-view.js), fails closed (the copy
// is skipped and reported), and the read-only audit screen reads it too.
//
// The finish key is the spare rules' (js/wishlist.js copyFinishKey, which
// the Shop's per-finish groups use as js/shop.js finishKey): an unset
// finish is its own key and never pairs with Normal (Eric, 2026-11-26).
// Hand-made copies count as the catalog card they match, as the Shop
// counts them (js/shop.js catalogTwins).
//
// A copy explicitly marked For sale (for_sale true) is exempt from 'held'
// and 'last': js/shop.js shopGroups already lists such a copy even when it
// is the last one, in a binder, or the keeper (its "marked" copies), since
// the mark is Eric's consent and beats the favorite star (js/wishlist.js
// markedForSale). It is never exempt from 'missing'.
//
// Pure: no DOM, no network. The same doc and ids always give the same map.

import {heldCopies} from './binders.js';
import {printedCode} from './catalog.js';
import {catalogTwins} from './shop.js';
import {copyFinishKey} from './wishlist.js';

const isLive = (entry) => Boolean(entry) && !entry.deleted_at;

// The key the last-copy check counts by: card, language, and finish.
const lastKey = (entry) => `${entry.catalog || 'international'}|${entry.card_id}|${entry.language || ''}|${copyFinishKey(entry)}`;

// doc: {binders, binder_picks, cards}. entryIds: every copy id about to be
// listed (or live), read as one batch: a copy is 'last' when listing it
// with the others before it would leave no copy of its card, language, and
// finish at home. Returns a Map of entry id to 'missing', 'held', or 'last' for each
// id that breaks the invariant; an id that keeps it is not in the map.
export function listingProblems(doc, entryIds) {
	const problems = new Map();
	const live = ((doc && doc.cards) || []).filter((entry) => isLive(entry) && entry.id);
	const twins = catalogTwins(live, {codeOf: printedCode});
	const asCard = (entry) => (twins.has(entry.id) ? {...entry, ...twins.get(entry.id)} : entry);
	const byId = new Map(live.map((entry) => [entry.id, entry]));
	const counts = new Map();
	let held = null;

	for (const entry of live) {
		const key = lastKey(asCard(entry));

		counts.set(key, (counts.get(key) || 0) + 1);
	}

	const ids = [...new Set(entryIds || [])];
	// Copies of each key this batch takes out of the house: every copy
	// marked For sale first (Eric's consent), then the others in order, so
	// one copy of each card, language, and finish always stays home.
	const leaving = new Map();

	for (const id of ids) {
		const entry = byId.get(id);

		if (entry && entry.for_sale === true) {
			const key = lastKey(asCard(entry));

			leaving.set(key, (leaving.get(key) || 0) + 1);
		}
	}

	for (const id of ids) {
		const entry = byId.get(id);

		if (!entry) {
			problems.set(id, 'missing');

			continue;
		}

		if (entry.for_sale === true) {
			continue;
		}

		held = held || heldCopies(doc);

		if (held.has(id)) {
			problems.set(id, 'held');

			continue;
		}

		const key = lastKey(asCard(entry));

		if ((leaving.get(key) || 0) + 1 >= (counts.get(key) || 0)) {
			problems.set(id, 'last');
		}
		else {
			leaving.set(key, (leaving.get(key) || 0) + 1);
		}
	}

	return problems;
}

// What the Shop says about a skipped copy.
export const PROBLEM_TEXT = {
	held: 'held in a binder',
	last: 'the last copy of its finish',
	missing: 'no longer in your cards',
};
