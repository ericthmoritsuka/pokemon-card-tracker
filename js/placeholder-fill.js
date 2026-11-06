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
//     A new path that adds copies calls addCopies, or afterAdding after its
//     own save, and gets the same; the trades log (js/moves.js) adds its
//     copies in one save with its removals, through planAfterAdding.
//   - addToBinder, for "Add cards to the tray": copies picked for one binder
//     go into its placeholders first, with the setting on, and the rest into
//     its tray.
//
// Which copy goes where: a copy fits a placeholder of the same card (card
// id, and catalog when the placeholder names one); card placeholders
// choose before Pokémon placeholders. The placeholders that
// name a finish and a language choose first, then those naming a finish,
// then a language, then the rest, each taking the best copy that fits
// what it names; a placeholder whose finish or language no copy has takes
// another copy of the card. The best copy (Eric, 2026-11-06) is the most
// valuable, else the rarest, else the newest added, ties to the lowest id:
// the order a binder from a list picks its copy by (js/binder-rules.js
// copyOrder, with js/binder-sources.js rankerFor's prices and rarities).
// Start over and the trades log plan inside one save with no prices at
// hand, so there the oldest copy fills, as before. A placeholder that names no language (v51's
// Start over made hundreds) wants the language of the copy Start over
// removed from it (pocketLanguages); when none is found and copies in
// several languages fit, it prefers the language most of its binder's
// cards have, and the plan counts it as a guess (unknownLanguage), which
// the preview says. One copy per pocket; a copy already in a pocket
// or a tray is never moved. A binder made from a list is a view, not a
// place (js/binder-rules.js): its pockets are never filled here, and a copy
// it shows still counts as in no pocket.
//
// A Pokémon's placeholder (laid out from a list, js/binder-layout.js) is
// filled by any copy of a card showing that Pokémon, in one of the list's
// languages when it names some (want.languages). Which Pokémon a card shows
// comes from the Pokédex numbers the checklists read (js/checklists.js
// resolveOwned), passed to fillPlan as dexOf; they are read only when a
// binder holds such a placeholder, so nothing changes for anyone else.
// planAfterAdding, which Start over and the trades log run inside one
// save, has no Pokédex numbers at hand: their copies fill those
// placeholders at the next Fill placeholders or the next copy added.
//
// fillPlan is pure, so Node tests it (tests/placeholder-fill.test.mjs); the
// pockets are written by js/binders.js fillPlaceholders, one copy and one
// stamp per binder, and put back by restorePlaceholders, only where a
// pocket still holds the copy it was given.

import {addCards, isLive, loadDocument, readMeta} from './collection.js';
import {addToTray, fillPlaceholders, handBinders, isGenerated, isPokemonWant, liveBinders, placeScanned, placements, slotsOf, sortBinders, stagedOf, takeFromTray, unplaceScanned} from './binders.js';
import {copyOrder} from './binder-rules.js';
import {rankerFor} from './binder-sources.js';
import {resolveOwned} from './checklists.js';
import {gotWishes, planGot, ungotWishes} from './wishlist.js';
import {plural} from './format.js';

const catalogOf = (item) => (item && item.catalog) || 'international';

// "Fill binder placeholders automatically" (Profile): on unless turned off.
// It lives in the document's settings, so it follows the person.
export const autoFillOn = (doc) => !(doc && doc.settings && doc.settings.fill_placeholders === false);

// The last Start over's undo is kept beside the document under this key
// (js/start-over.js applyStartOver). Its pockets name the copy each
// placeholder it made held, which tells the language that pocket wants.
export const START_OVER_META = 'start-over-undo';

// Saved: the undo kept by the last Start over on this phone, for this
// account, or null.
export async function keptStartOver(doc) {
	const kept = await readMeta(START_OVER_META).catch(() => null);

	return kept && kept.undo && (kept.user_id || null) === ((doc && doc.user_id) || null) ? kept.undo : null;
}

const pocketKey = (binderId, {page, position}) => `${binderId}|${page}|${position}`;

// Pure: the language each placeholder that names none wants, Map
// "binderId|page|position" -> language, for the placeholders of hand-made
// binders. The copy Start over removed from the pocket says it: the one the
// saved undo (undo, as kept by Start over) names for that pocket, whose
// tombstone is still in doc.cards; without a record, the copies of that
// card deleted at the moment the pocket was written (Start over stamps
// both with the same time), when they share one language. A pocket neither
// tells is left out, as is a placeholder made by hand.
export function pocketLanguages(doc, {undo = null} = {}) {
	const cards = (doc && doc.cards) || [];
	const binders = (doc && doc.binders) || [];
	const byId = new Map(cards.filter((entry) => entry && entry.id).map((entry) => [entry.id, entry]));
	const named = new Map();

	for (const item of (undo && Array.isArray(undo.binders) ? undo.binders : [])) {
		for (const pocket of (item && Array.isArray(item.pockets) ? item.pockets : [])) {
			const entry = pocket && byId.get(pocket.entry_id);

			if (entry && entry.language) {
				named.set(pocketKey(item.id, pocket), entry);
			}
		}
	}

	// Removed copies by card and the time they were removed.
	const removedAt = new Map();

	for (const entry of cards) {
		if (entry && entry.deleted_at && !entry.merged_into && entry.card_id && entry.language) {
			const key = `${entry.card_id}|${entry.deleted_at}`;

			removedAt.set(key, [...(removedAt.get(key) || []), entry]);
		}
	}

	const fits = (want, entry) => entry.card_id === want.card_id
		&& (!want.catalog || catalogOf(entry) === want.catalog)
		&& (!want.variant_id || !entry.variant_id || entry.variant_id === want.variant_id);
	const placed = placements(binders);
	const out = new Map();

	for (const binder of binders) {
		if (!binder || !isLive(binder) || isGenerated(binder)) {
			continue;
		}

		for (const slot of slotsOf(binder, placed)) {
			const want = slot.want;

			if (!want || !want.card_id || want.language) {
				continue;
			}

			const key = pocketKey(binder.id, slot);
			const entry = named.get(key);

			if (entry && fits(want, entry)) {
				out.set(key, entry.language);
				continue;
			}

			const languages = new Set((removedAt.get(`${want.card_id}|${slot.placed_at}`) || []).filter((item) => fits(want, item)).map((item) => item.language));

			if (languages.size === 1) {
				out.set(key, [...languages][0]);
			}
		}
	}

	return out;
}

// The language most of a binder's cards have: its live copies, and its
// placeholders whose language is known. null on a tie or with none.
function mainLanguage(languages) {
	const counts = new Map();

	for (const language of languages) {
		if (language) {
			counts.set(language, (counts.get(language) || 0) + 1);
		}
	}

	const sorted = [...counts].sort((a, b) => b[1] - a[1]);

	return sorted.length && (sorted.length === 1 || sorted[0][1] > sorted[1][1]) ? sorted[0][0] : null;
}

const byAge = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id));

// What filling would do now, without changing anything. doc: {cards,
// binders}. binderId: only that binder's placeholders (null for every
// hand-made binder). only: a Set of entry ids, the only copies that may go
// in (the copies just added); null for every copy in no pocket and no tray.
// undo: the kept Start over undo (keptStartOver), for pocketLanguages.
// dexOf: Map entry id -> the Pokédex numbers of its card (dexOfCopies),
// for Pokémon placeholders; without it they wait and count as waiting.
// rankOf: entry -> {value, rarity} (rankWhenNeeded), so the most valuable
// copy fills; without it, the oldest.
// Returns {rows, waiting, binders, unknownLanguage}: rows [{binderId,
// binderName, page, position, entryId, cardId, catalog, want}, and dex for
// a Pokémon's placeholder] in binder, page, and pocket order, ready for
// fillPlaceholders; waiting, the placeholders left with no copy; binders,
// how many binders the rows fill; unknownLanguage, how many rows fill a
// card's pocket whose language is not known while copies in several
// languages fitted it.
export function fillPlan(doc, {binderId = null, dexOf = null, only = null, rankOf = null, undo = null} = {}) {
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

	const order = rankOf ? copyOrder(rankOf) : byAge;

	for (const list of pool.values()) {
		list.sort(order);
	}

	const spots = [];
	const known = pocketLanguages(doc, {undo});
	const languageOf = new Map(((doc && doc.cards) || []).filter((entry) => entry && entry.id && isLive(entry)).map((entry) => [entry.id, entry.language]));

	for (const binder of sortBinders(binders)) {
		if (isGenerated(binder) || (binderId && binder.id !== binderId)) {
			continue;
		}

		const own = [];
		const held = [];

		for (const slot of slotsOf(binder, placed)) {
			if (slot.want && (slot.want.card_id || isPokemonWant(slot.want))) {
				own.push({binder, language: slot.want.language || known.get(pocketKey(binder.id, slot)) || null, slot, want: slot.want});
			}
			else if (slot.entry_id) {
				held.push(languageOf.get(slot.entry_id));
			}
		}

		// A pocket whose language is not known leans to the binder's.
		const main = mainLanguage([...held, ...own.map((spot) => spot.language)]);

		spots.push(...own.map((spot) => ({...spot, guess: spot.language ? null : main})));
	}

	// Each pass lets the placeholders that ask for more choose first; a
	// pocket's known language before its binder's.
	const finish = (spot, entry) => Boolean(spot.want.variant_id) && entry.variant_id === spot.want.variant_id;
	const language = (spot, entry) => Boolean(spot.language) && entry.language === spot.language;
	const guess = (spot, entry) => Boolean(spot.guess) && entry.language === spot.guess;
	const passes = [
		(spot, entry) => finish(spot, entry) && language(spot, entry),
		(spot, entry) => finish(spot, entry) && guess(spot, entry),
		finish,
		language,
		guess,
		() => true,
	];
	const used = new Set();
	const chosen = new Map();

	// A Pokémon's copies: every pooled copy whose card shows it, in the
	// list's languages when its placeholder names some, best first.
	const byDex = new Map();

	if (dexOf) {
		for (const list of pool.values()) {
			for (const entry of list) {
				for (const n of dexOf.get(entry.id) || []) {
					byDex.set(n, [...(byDex.get(n) || []), entry]);
				}
			}
		}

		for (const list of byDex.values()) {
			list.sort(order);
		}
	}

	const candidates = (want) => {
		if (isPokemonWant(want)) {
			const languages = Array.isArray(want.languages) && want.languages.length ? want.languages : null;

			return (byDex.get(want.dex) || []).filter((entry) => !languages || languages.includes(entry.language));
		}

		return (pool.get(want.card_id) || []).filter((entry) => !want.catalog || catalogOf(entry) === want.catalog);
	};

	// Card placeholders choose first, through every pass, then the
	// Pokémon's: a copy fits its own card's placeholder before any
	// placeholder that takes every card of its Pokémon, in any binder.
	const groups = [spots.filter((spot) => !isPokemonWant(spot.want)), spots.filter((spot) => isPokemonWant(spot.want))];

	for (const group of groups) {
		for (const fits of passes) {
			for (const spot of group) {
				if (chosen.has(spot)) {
					continue;
				}

				const copy = candidates(spot.want).find((entry) => !used.has(entry.id) && fits(spot, entry));

				if (copy) {
					used.add(copy.id);
					chosen.set(spot, copy);
				}
			}
		}
	}

	const rows = [];
	let unknownLanguage = 0;

	for (const spot of spots) {
		const copy = chosen.get(spot);

		if (copy) {
			const pokemon = isPokemonWant(spot.want);

			if (!pokemon && !spot.language && new Set(candidates(spot.want).map((entry) => entry.language || '')).size > 1) {
				unknownLanguage++;
			}

			rows.push({
				binderId: spot.binder.id,
				binderName: spot.binder.name,
				cardId: copy.card_id,
				catalog: catalogOf(copy),
				...(pokemon ? {dex: spot.want.dex} : {}),
				entryId: copy.id,
				page: spot.slot.page,
				position: spot.slot.position,
				want: spot.want,
			});
		}
	}

	return {binders: new Set(rows.map((row) => row.binderId)).size, rows, unknownLanguage, waiting: spots.length - rows.length};
}

// The rows a fill or Undo saves, kept small: what restorePlaceholders needs.
const doneRow = (row) => ({binderId: row.binderId, cardId: row.cardId, catalog: row.catalog, entryId: row.entryId, page: row.page, position: row.position, want: row.want});

// True when a hand-made binder holds a Pokémon's placeholder.
export const hasPokemonWants = (binders) => handBinders(binders).some((binder) => slotsOf(binder).some((slot) => isPokemonWant(slot.want)));

// Saved: Map entry id -> the Pokédex numbers of its card, for the copies
// given, read as the checklists read them (js/checklists.js resolveOwned:
// the saved map and card records first). An empty map when they cannot be
// read; the placeholders then wait.
export async function dexOfCopies(entries) {
	const out = new Map();

	if (!entries || !entries.length) {
		return out;
	}

	try {
		const {byDex} = await resolveOwned(entries);

		for (const [n, copies] of byDex || []) {
			for (const entry of copies) {
				out.set(entry.id, [...(out.get(entry.id) || []), n]);
			}
		}
	}
	catch {
		// Offline with nothing saved: nothing is told.
	}

	return out;
}

// Saved: dexOf for fillPlan, only when some binder holds a Pokémon's
// placeholder: for `entries`, or every live copy in no pocket and no tray.
async function dexWhenNeeded(doc, entries = null) {
	const binders = (doc && doc.binders) || [];

	if (!hasPokemonWants(binders)) {
		return null;
	}

	const placed = placements(binders);
	const staged = new Set(liveBinders(binders).flatMap((binder) => stagedOf(binder)));

	return dexOfCopies((entries || (doc.cards || [])).filter((entry) => entry && isLive(entry) && entry.card_id && !placed.has(entry.id) && !staged.has(entry.id)));
}

// Saved: rankOf for fillPlan, only when some hand-made binder holds a
// placeholder: the prices and rarities saved on this phone for `entries`,
// or every live copy in no pocket and no tray. null when they cannot be
// read; the oldest copy then fills.
async function rankWhenNeeded(doc, entries = null) {
	const binders = (doc && doc.binders) || [];

	if (!handBinders(binders).some((binder) => slotsOf(binder).some((slot) => slot.want && (slot.want.card_id || isPokemonWant(slot.want))))) {
		return null;
	}

	const placed = placements(binders);
	const staged = new Set(liveBinders(binders).flatMap((binder) => stagedOf(binder)));

	try {
		return await rankerFor((entries || (doc.cards || [])).filter((entry) => entry && isLive(entry) && entry.card_id && !placed.has(entry.id) && !staged.has(entry.id)));
	}
	catch {
		return null;
	}
}

// ------------------------------------------------- Fill placeholders

// Saved: the preview of "Fill placeholders" for one binder (binderId) or
// all. Resolves fillPlan's result.
export async function previewFill({binderId = null} = {}) {
	const doc = await loadDocument();

	return fillPlan(doc, {binderId, dexOf: await dexWhenNeeded(doc), rankOf: await rankWhenNeeded(doc), undo: await keptStartOver(doc)});
}

// Saved: fills them, planned again now so a copy placed since is left
// alone. Resolves {done, passed, waiting}; done is what undoFill takes.
export async function fillNow({binderId = null} = {}) {
	const doc = await loadDocument();
	const plan = fillPlan(doc, {binderId, dexOf: await dexWhenNeeded(doc), rankOf: await rankWhenNeeded(doc), undo: await keptStartOver(doc)});

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
// skipWish as planGot's skip; undo: the kept Start over undo, for the
// languages of the placeholders it made (fillPlan, as afterAdding passes);
// rankOf as fillPlan's, which Start over and the trades log do not pass,
// so the oldest copy fills there.
export function planAfterAdding(doc, added, {at, fill = autoFillOn(doc), now = Date.parse(at), rankOf = null, skipWish = null, undo = null} = {}) {
	let placed = [];

	if (fill && added.length) {
		const plan = fillPlan(doc, {only: new Set(added.map((entry) => entry.id)), rankOf, undo});

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
			rows = fillPlan(doc, {dexOf: await dexWhenNeeded(doc, added), only: new Set(added.map((entry) => entry.id)), rankOf: await rankWhenNeeded(doc, added), undo: await keptStartOver(doc)}).rows;
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
		const picked = new Set(entryIds);
		const pickedCopies = (doc.cards || []).filter((entry) => entry && picked.has(entry.id));
		const plan = fillPlan(doc, {binderId, dexOf: await dexWhenNeeded(doc, pickedCopies), only: picked, rankOf: await rankWhenNeeded(doc, pickedCopies), undo: await keptStartOver(doc)});

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
