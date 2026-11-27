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
// A copy in an open HOTARU order (away: pending, or paid and not handed
// over; v128 review H1) is already leaving. It counts as gone before any
// other copy, and an away id in the batch is not judged again, since
// store_sync passes a reserved listing through untouched. The caller reads
// the orders and passes their copy ids, so this stays pure.
//
// Pure: no DOM, no network. The same doc and ids always give the same map.

import {heldCopies} from './binders.js';
import {printedCode} from './catalog.js';
import {catalogTwins} from './shop.js';
import {copyFinishKey, favoriteCards, favoriteKey} from './wishlist.js';

const isLive = (entry) => Boolean(entry) && !entry.deleted_at;

// The key the last-copy check counts by: card, language, and finish.
const lastKey = (entry) => `${entry.catalog || 'international'}|${entry.card_id}|${entry.language || ''}|${copyFinishKey(entry)}`;

// doc: {binders, binder_picks, cards}. entryIds: every copy id about to be
// listed (or live), read as one batch: a copy is 'last' when listing it
// with the others before it would leave no copy of its card, language, and
// finish at home. away: the copy ids in open HOTARU orders, counted as
// leaving first. Returns a Map of entry id to 'missing', 'held', or 'last'
// for each id that breaks the invariant; an id that keeps it is not in the
// map.
export function listingProblems(doc, entryIds, away = []) {
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
	const awayIds = new Set(away || []);
	const counted = new Set();
	const leave = (id) => {
		const entry = byId.get(id);

		if (entry && !counted.has(id)) {
			const key = lastKey(asCard(entry));

			counted.add(id);
			leaving.set(key, (leaving.get(key) || 0) + 1);
		}
	};

	// Copies in open orders first: they are on their way out.
	for (const id of awayIds) {
		leave(id);
	}

	for (const id of ids) {
		const entry = byId.get(id);

		if (entry && entry.for_sale === true) {
			leave(id);
		}
	}

	for (const id of ids) {
		const entry = byId.get(id);

		if (!entry) {
			problems.set(id, 'missing');

			continue;
		}

		if (entry.for_sale === true || awayIds.has(id)) {
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

// Each reason in one table, so the publish line, the guard sheet, and the
// audit use the same words (design review F7): short, after a card's name
// ("Charmander 004: in a binder pocket"); long, as a sentence on the audit.
export const REASONS = {
	missing: {long: 'Not in your cards: the copy was deleted, sold, or traded away.', short: 'no longer in your cards'},
	held: {long: 'In a binder pocket, so it should stay home.', short: 'in a binder pocket'},
	last: {long: 'The only copy of this card in this language and finish.', short: 'the only copy of its finish'},
	kept: {long: 'A favorite card, or a copy set Not for sale, so it should stay home.', short: 'a favorite or Not for sale'},
};

// The copies Eric keeps by choice: every copy of a favorite card and every
// copy set Not for sale, except a copy marked For sale (QA shop 5: the audit
// and the automatic publish did not see them). Pure.
export function keptByChoice(doc) {
	const live = ((doc && doc.cards) || []).filter((entry) => isLive(entry) && entry.id);
	const favorites = favoriteCards(live);

	return new Set(live.filter((entry) => entry.for_sale !== true && (entry.for_sale === false || favorites.has(favoriteKey(entry)))).map((entry) => entry.id));
}

// What the Shop says about a skipped copy.
export const PROBLEM_TEXT = Object.fromEntries(Object.entries(REASONS).map(([reason, text]) => [reason, text.short]));

// The key a copy counts under in doc (card, language, and finish, with a
// hand-made copy as its catalog twin), for grouping the audit's rows.
export function copyKeyOf(doc) {
	const live = ((doc && doc.cards) || []).filter((entry) => isLive(entry) && entry.id);
	const twins = catalogTwins(live, {codeOf: printedCode});

	return (entry) => lastKey(twins.has(entry.id) ? {...entry, ...twins.get(entry.id)} : entry);
}
