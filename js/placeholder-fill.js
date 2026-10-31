// Filling binder placeholders with copies the person owns (DESIGN.md
// section 11, Binders, "Fill placeholders"; Eric, 2026-10-31). A
// placeholder is a card he wants in that pocket, so whenever he has or adds
// a copy of that card, it goes there by itself.
//
// Two ways in:
//   - "Fill placeholders" on a binder screen or the Binders list: every
//     live copy that sits in no pocket of a hand-made binder and in no tray,
//     matched to the placeholders of one binder or of all of them, with a
//     preview and Undo.
//   - afterAdding, which every path that adds copies calls with the copies
//     it added (the monprice import, the app's own CSV, a share, the Add a
//     copy sheet, the copy steppers, hand-made cards, the scanner; and
//     Start over through planAfterAdding on its draft). It fills the
//     placeholders waiting for those copies, when "Fill binder placeholders
//     automatically" is on (Profile, on by default), and moves the wishlist
//     items they fit to Got it (js/wishlist.js). undoAdding takes both back.
//     A new path that adds copies (a trades log) calls addCopies, or
//     afterAdding after its own save, and gets the same.
//   - addToBinder, for "Add cards to the tray": copies picked for one binder
//     go into its placeholders first, with the setting on, and the rest into
//     its tray.
//
// Which copy goes where: a copy fits a placeholder of the same card (card
// id, and catalog when the placeholder names one). The placeholders that
// name a finish and a language choose first, then those naming a finish,
// then a language, then the rest, each taking the oldest copy that fits
// what it names; a placeholder whose finish or language no copy has takes
// another copy of the card. One copy per pocket; a copy already in a pocket
// or a tray is never moved. A binder made from a list is a view, not a
// place (js/binder-rules.js): its pockets are never filled here, and a copy
// it shows still counts as in no pocket.
//
// fillPlan is pure, so Node tests it (tests/placeholder-fill.test.mjs); the
// pockets are written by js/binders.js fillPlaceholders, one copy and one
// stamp per binder, and put back by restorePlaceholders, only where a
// pocket still holds the copy it was given.

import {addCards, isLive, loadDocument} from './collection.js';
import {addToTray, fillPlaceholders, isGenerated, liveBinders, placeScanned, placements, slotsOf, sortBinders, stagedOf, takeFromTray, unplaceScanned} from './binders.js';
import {gotWishes, planGot, ungotWishes} from './wishlist.js';
import {plural} from './format.js';

const catalogOf = (item) => (item && item.catalog) || 'international';

// "Fill binder placeholders automatically" (Profile): on unless turned off.
// It lives in the document's settings, so it follows the person.
export const autoFillOn = (doc) => !(doc && doc.settings && doc.settings.fill_placeholders === false);

const byAge = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id));

// What filling would do now, without changing anything. doc: {cards,
// binders}. binderId: only that binder's placeholders (null for every
// hand-made binder). only: a Set of entry ids, the only copies that may go
// in (the copies just added); null for every copy in no pocket and no tray.
// Returns {rows, waiting, binders}: rows [{binderId, binderName, page,
// position, entryId, cardId, catalog, want}] in binder, page, and pocket
// order, ready for fillPlaceholders; waiting, the placeholders left with no
// copy; binders, how many binders the rows fill.
export function fillPlan(doc, {binderId = null, only = null} = {}) {
	const binders = (doc && doc.binders) || [];
	const placed = placements(binders);
	const staged = new Set(liveBinders(binders).flatMap((binder) => stagedOf(binder)));
	const pool = new Map();

	for (const entry of (doc && doc.cards) || []) {
		if (!entry || !isLive(entry) || !entry.card_id || placed.has(entry.id) || staged.has(entry.id) || (only && !only.has(entry.id))) {
			continue;
		}

		if (!pool.has(entry.card_id)) {
			pool.set(entry.card_id, []);
		}

		pool.get(entry.card_id).push(entry);
	}

	for (const list of pool.values()) {
		list.sort(byAge);
	}

	const spots = [];

	for (const binder of sortBinders(binders)) {
		if (isGenerated(binder) || (binderId && binder.id !== binderId)) {
			continue;
		}

		for (const slot of slotsOf(binder, placed)) {
			if (slot.want && slot.want.card_id) {
				spots.push({binder, slot, want: slot.want});
			}
		}
	}

	// Each pass lets the placeholders that ask for more choose first.
	const finish = (spot, entry) => Boolean(spot.want.variant_id) && entry.variant_id === spot.want.variant_id;
	const language = (spot, entry) => Boolean(spot.want.language || spot.binder.language) && entry.language === (spot.want.language || spot.binder.language);
	const passes = [
		(spot, entry) => finish(spot, entry) && language(spot, entry),
		finish,
		language,
		() => true,
	];
	const used = new Set();
	const chosen = new Map();

	for (const fits of passes) {
		for (const spot of spots) {
			if (chosen.has(spot)) {
				continue;
			}

			const copy = (pool.get(spot.want.card_id) || []).find((entry) => !used.has(entry.id)
				&& (!spot.want.catalog || catalogOf(entry) === spot.want.catalog)
				&& fits(spot, entry));

			if (copy) {
				used.add(copy.id);
				chosen.set(spot, copy);
			}
		}
	}

	const rows = [];

	for (const spot of spots) {
		const copy = chosen.get(spot);

		if (copy) {
			rows.push({
				binderId: spot.binder.id,
				binderName: spot.binder.name,
				cardId: copy.card_id,
				catalog: catalogOf(copy),
				entryId: copy.id,
				page: spot.slot.page,
				position: spot.slot.position,
				want: spot.want,
			});
		}
	}

	return {binders: new Set(rows.map((row) => row.binderId)).size, rows, waiting: spots.length - rows.length};
}

// The rows a fill or Undo saves, kept small: what restorePlaceholders needs.
const doneRow = (row) => ({binderId: row.binderId, cardId: row.cardId, catalog: row.catalog, entryId: row.entryId, page: row.page, position: row.position, want: row.want});

// ------------------------------------------------- Fill placeholders

// Saved: the preview of "Fill placeholders" for one binder (binderId) or
// all. Resolves fillPlan's result.
export async function previewFill({binderId = null} = {}) {
	return fillPlan(await loadDocument(), {binderId});
}

// Saved: fills them, planned again now so a copy placed since is left
// alone. Resolves {done, passed, waiting}; done is what undoFill takes.
export async function fillNow({binderId = null} = {}) {
	const plan = fillPlan(await loadDocument(), {binderId});

	if (!plan.rows.length) {
		return {done: [], passed: [], waiting: plan.waiting};
	}

	const result = await placeScanned(plan.rows);

	return {done: result.done.map(doneRow), passed: result.passed, waiting: plan.waiting};
}

// Saved: Undo of fillNow. Only pockets that still hold the copy put there
// get their placeholder back. Resolves how many did.
export async function undoFill(done) {
	if (!done || !done.length) {
		return 0;
	}

	return (await unplaceScanned(done)).done.length;
}

// ------------------------------------------------- copies just added

// What a path that adds copies says about it: "3 cards went into binders.",
// "1 wish moved to Got it."; empty when nothing happened.
export function afterText(result) {
	const parts = [];
	const placed = (result && result.placed && result.placed.length) || 0;
	const got = (result && result.got && result.got.length) || 0;

	if (placed) {
		parts.push(placed === 1 ? '1 card went into a binder.' : `${placed} cards went into binders.`);
	}

	if (got) {
		parts.push(`${plural(got, 'wish', 'wishes')} moved to Got it.`);
	}

	return parts.join(' ');
}

// Pure, for a path that changes a draft of the whole document in one save
// (Start over): fills the placeholders waiting for the copies `added` and
// marks the wishes they fit, in `doc` itself. Returns {placed, got} for
// Undo, as afterAdding resolves. fill: whether to fill (the setting);
// skipWish as planGot's skip.
export function planAfterAdding(doc, added, {at, fill = autoFillOn(doc), now = Date.parse(at), skipWish = null} = {}) {
	let placed = [];

	if (fill && added.length) {
		const plan = fillPlan(doc, {only: new Set(added.map((entry) => entry.id))});

		if (plan.rows.length) {
			const result = fillPlaceholders(doc.binders || [], plan.rows, {at});
			const changed = new Map(result.changed.map((binder) => [binder.id, binder]));

			doc.binders = (doc.binders || []).map((binder) => (binder && changed.get(binder.id)) || binder);
			placed = result.done.map(doneRow);
		}
	}

	const {changed, marks} = planGot(doc.wishlist || [], added, {now, skip: skipWish});

	if (changed.length) {
		const byId = new Map(changed.map((item) => [item.id, item]));

		doc.wishlist = (doc.wishlist || []).map((item) => (item && byId.get(item.id)) || item);
	}

	return {got: marks, placed};
}

// Saved: what every path that adds copies calls after its save, with the
// entries it added. Fills the placeholders waiting for them when the
// setting is on (fill overrides it; place: rows a path chose itself, such
// as the scanner's Place it there, used instead of a plan), and moves the
// wishlist items they fit to Got it. Never throws: the copies are saved
// either way, and error says what did not happen. Resolves {placed, got,
// error}, which undoAdding takes and afterText describes.
export async function afterAdding(entries, {fill = null, place = null} = {}) {
	const added = (entries || []).filter((entry) => entry && entry.id);
	const out = {error: null, got: [], placed: []};

	if (!added.length) {
		return out;
	}

	try {
		const doc = await loadDocument();
		let rows = place;

		if (!rows && (fill === null ? autoFillOn(doc) : fill)) {
			rows = fillPlan(doc, {only: new Set(added.map((entry) => entry.id))}).rows;
		}

		if (rows && rows.length) {
			out.placed = (await placeScanned(rows)).done.map(doneRow);
		}
	}
	catch (err) {
		out.error = err;
	}

	try {
		out.got = await gotWishes(added);
	}
	catch (err) {
		out.error = out.error || err;
	}

	return out;
}

// Saved: Undo of afterAdding, before the copies themselves are taken back:
// placeholders come back where the pocket still holds the copy, and wishes
// go back to wanted while the same copy still marks them.
export async function undoAdding(result) {
	if (!result) {
		return;
	}

	await unplaceScanned(result.placed || []).catch(() => null);
	await ungotWishes(result.got || []).catch(() => 0);
}

// Saved: adds copies (js/collection.js addCards) and runs afterAdding on
// them. Resolves {added, placed, got, error}.
export async function addCopies(list, options = {}) {
	const added = await addCards(list);

	return {added, ...(await afterAdding(added, options))};
}

// Saved: "Add cards to the tray" (js/binders-view.js). The copies picked for
// a binder (in no pocket and no tray) go into its own placeholders first
// when the setting is on, and the rest into its tray, in the order given.
// Resolves {placed, staged}, which undoAddToBinder takes.
export async function addToBinder(binderId, entryIds, {fill = null} = {}) {
	const doc = await loadDocument();
	let placed = [];

	if (fill === null ? autoFillOn(doc) : fill) {
		const plan = fillPlan(doc, {binderId, only: new Set(entryIds)});

		if (plan.rows.length) {
			placed = (await placeScanned(plan.rows)).done.map(doneRow);
		}
	}

	const inPockets = new Set(placed.map((row) => row.entryId));
	const staged = entryIds.filter((id) => !inPockets.has(id));

	if (staged.length) {
		await addToTray(binderId, staged);
	}

	return {placed, staged};
}

// Saved: Undo of addToBinder.
export async function undoAddToBinder(binderId, {placed = [], staged = []} = {}) {
	await unplaceScanned(placed);

	if (staged.length) {
		await takeFromTray(binderId, staged);
	}
}
