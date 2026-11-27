// The Shop audit (Eric, 2026-11-26; plans/roadmap.md, "Shop audit screen"):
// the live HOTARU single-card listings that break the listing invariant
// (js/listing-invariant.js listingProblems), so after any release Eric can
// see at a glance whether a copy that should stay home is on sale. Read
// only: it changes no listing and no copy. js/shop-audit-view.js draws it;
// this part runs without the page, so node can test it
// (tests/shop-audit.test.mjs).

import {copyKeyOf, keptByChoice, listingProblems, REASONS} from './listing-invariant.js';

// Each reason in plain words, in the order the screen lists them: the
// shared table's long forms (js/listing-invariant.js REASONS).
export const AUDIT_REASONS = Object.fromEntries(Object.entries(REASONS).map(([reason, text]) => [reason, text.long]));

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

// The copy ids in open orders, read as the Shop reads them
// (store_orders_open), so a reserved copy counts as out (v128 review M3).
// Throws when they cannot be read.
export async function readOpenOrderIds(client = null) {
	const supabase = client || await (await import('./auth.js')).getClient();
	const {data, error} = await supabase.rpc('store_orders_open');

	if (error) {
		throw new Error(error.message || 'HOTARU\'s open orders could not be read.');
	}

	const ids = new Set();

	for (const order of Array.isArray(data) ? data : []) {
		for (const item of (order && order.items) || []) {
			if (item && (item.kind || 'single') === 'single' && item.listing_id) {
				ids.add(item.listing_id);
			}
		}
	}

	return ids;
}

// The listings that break the invariant: [{listing, entry, reason, text}],
// entry being the copy in the document (null when missing), sorted by
// reason, then set and number as HOTARU sorts them. away: the copy ids in
// open orders, counted as out before any live listing.
export function auditRows(doc, listings, away = []) {
	const rows = (listings || []).filter((row) => row && row.id);
	const problems = listingProblems(doc, rows.map((row) => row.id), away);
	const kept = keptByChoice(doc);

	for (const row of rows) {
		if (!problems.has(row.id) && kept.has(row.id)) {
			problems.set(row.id, 'kept');
		}
	}
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

// The audit's rows grouped per card, language, and finish (v128 review M3:
// a breach belongs to the finish, not to whichever copy sorted second):
// [{key, listing, entry, reasons, rows, out, total, text}], where out is how
// many copies of the finish are on HOTARU or in an open order, total how
// many live copies the document has, and text the count in words ("2 of 2
// copies are out"). A listing whose copy is gone is its own group.
export function auditGroups(doc, listings, away = []) {
	const rows = auditRows(doc, listings, away);
	const keyOf = copyKeyOf(doc);
	const live = ((doc && doc.cards) || []).filter((entry) => entry && entry.id && !entry.deleted_at);
	const byId = new Map(live.map((entry) => [entry.id, entry]));
	const total = new Map();

	for (const entry of live) {
		total.set(keyOf(entry), (total.get(keyOf(entry)) || 0) + 1);
	}

	const outIds = new Map();
	const outOf = (id) => {
		const entry = byId.get(id);

		if (entry) {
			const key = keyOf(entry);

			outIds.set(key, new Set([...(outIds.get(key) || []), id]));
		}
	};

	(listings || []).filter((row) => row && row.id).forEach((row) => outOf(row.id));
	[...(away || [])].forEach(outOf);

	const groups = new Map();
	const order = Object.keys(AUDIT_REASONS);

	for (const row of rows) {
		const key = row.entry ? keyOf(row.entry) : `missing|${row.listing.id}`;

		if (!groups.has(key)) {
			groups.set(key, {entry: row.entry, key, listing: row.listing, reasons: [], rows: []});
		}

		const group = groups.get(key);

		group.rows.push(row);

		if (!group.reasons.includes(row.reason)) {
			group.reasons.push(row.reason);
		}
	}

	return [...groups.values()].map((group) => {
		const all = total.get(group.key) || 0;
		const out = group.entry ? (outIds.get(group.key) || new Set()).size : group.rows.length;

		group.reasons.sort((a, b) => order.indexOf(a) - order.indexOf(b));

		return {
			...group,
			out,
			text: group.entry
				? `${out} of ${all} ${all === 1 ? 'copy is' : 'copies are'} out.`
				: `${group.rows.length === 1 ? 'A copy no longer' : `${group.rows.length} copies no longer`} in your cards ${group.rows.length === 1 ? 'is' : 'are'} on sale.`,
			total: all,
		};
	});
}
