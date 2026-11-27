// The listing invariant (plans/roadmap.md, "Backlog: preventing wrong
// listings"): never list a copy that is gone, a held copy, or the last copy
// of a card, language, and finish. Minimal version for the Shop audit
// screen (js/shop-audit.js); the publish-explicit branch owns this file.
//
// listingProblems(doc, entryIds): a Map from each listed entry id that
// breaks the invariant to its reason:
//   'missing'  no owned, undeleted copy has that id
//   'held'     the copy is in a pocket (js/binders.js heldCopies)
//   'last'     the only live copy of its card, language, and finish; a copy
//              with no finish set is its own finish and never pairs with
//              Normal (js/wishlist.js copyFinishKey)
// A copy marked For sale (for_sale true) is offered wherever it is, even
// the last one or one in a binder (js/shop.js), so it is only ever missing.

import {heldCopies} from './binders.js';
import {isLive} from './collection.js';
import {copyFinishKey} from './wishlist.js';

const finishGroup = (entry) => `${entry.catalog || 'international'}|${entry.card_id}|${entry.language || ''}|${copyFinishKey(entry)}`;

export function listingProblems(doc, entryIds) {
	const live = ((doc && doc.cards) || []).filter((entry) => entry && entry.id && isLive(entry));
	const byId = new Map(live.map((entry) => [entry.id, entry]));
	const held = heldCopies(doc);
	const counts = new Map();

	for (const entry of live) {
		const key = finishGroup(entry);

		counts.set(key, (counts.get(key) || 0) + 1);
	}

	const problems = new Map();

	for (const id of entryIds || []) {
		const entry = byId.get(id);

		if (!entry) {
			problems.set(id, 'missing');
		}
		else if (entry.for_sale === true) {
			continue;
		}
		else if (held.has(id)) {
			problems.set(id, 'held');
		}
		else if (counts.get(finishGroup(entry)) === 1) {
			problems.set(id, 'last');
		}
	}

	return problems;
}
