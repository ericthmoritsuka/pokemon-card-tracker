// The Shop audit (Eric, 2026-11-26; plans/roadmap.md, "Shop audit screen"):
// the live HOTARU single-card listings that break the listing invariant
// (js/listing-invariant.js listingProblems), so after any release Eric can
// see at a glance whether a copy that should stay home is on sale. Read
// only: it changes no listing and no copy. js/shop-audit-view.js draws it;
// this part runs without the page, so node can test it
// (tests/shop-audit.test.mjs).

import {listingProblems} from './listing-invariant.js';

// Each reason in plain words, in the order the screen lists them.
export const AUDIT_REASONS = {
	missing: 'Not in your cards: the copy was deleted, sold, or traded away.',
	held: 'In a binder pocket, so it should stay home.',
	last: 'The only copy of this card in this language and finish.',
};

// The live listings as HOTARU shows them: store_catalog (supabase/store.sql),
// the same read the store's pages make, which returns only the available
// ones. Only singles are the tracker's copies; sealed products and
// consigned cards are not. client: a Supabase client, for tests; else the
// app's own. Resolves to [{id, card_id, catalog, language, finish, name,
// set_name, number, image_path, price_brl}], or throws.
export async function readLiveListings(client = null) {
	// The app's client is read when needed, so node can load this module.
	const supabase = client || await (await import('./auth.js')).getClient();
	const {data, error} = await supabase.rpc('store_catalog');

	if (error) {
		throw new Error(error.message || 'HOTARU\'s listings could not be read.');
	}

	return (Array.isArray(data) ? data : []).filter((row) => row && row.id && (row.kind || 'single') === 'single');
}

// The listings that break the invariant: [{listing, entry, reason, text}],
// entry being the copy in the document (null when missing), sorted by
// reason, then set and number as HOTARU sorts them.
export function auditRows(doc, listings) {
	const rows = (listings || []).filter((row) => row && row.id);
	const problems = listingProblems(doc, rows.map((row) => row.id));
	const byId = new Map(((doc && doc.cards) || []).filter((entry) => entry && entry.id).map((entry) => [entry.id, entry]));
	const order = Object.keys(AUDIT_REASONS);

	return rows
		.filter((row) => problems.has(row.id))
		.map((row) => {
			const reason = problems.get(row.id);

			return {entry: reason === 'missing' ? null : byId.get(row.id) || null, listing: row, reason, text: AUDIT_REASONS[reason]};
		})
		.sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason)
			|| String(a.listing.set_name || '').localeCompare(String(b.listing.set_name || ''))
			|| String(a.listing.number || '').localeCompare(String(b.listing.number || ''), 'en', {numeric: true})
			|| String(a.listing.id).localeCompare(String(b.listing.id)));
}
