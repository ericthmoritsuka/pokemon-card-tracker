// "I already have these cards" (Eric, 2026-11-19: "One: I already have the
// cards, they are just organized in a binder now. This way, we just need to
// fetch the existing information on the cards (we have already set the
// language etc.)"): a binder page read is matched to the owner's own
// copies, and the page is placed, as the photo has it, on a page of one of
// his binders (an existing one, or one made there). Nothing new is added:
// a card he does not own becomes that card's placeholder in its pocket.
//
// This file is the part with no page, so Node tests it
// (tests/page-place.test.mjs); js/scan/sheets.js pageSheet shows it and
// js/scan/view.js places it (js/binders.js placePage).

// A page read's pockets per binder page; a spread's pockets 10 to 18 are the
// right page's.
export const PER_PAGE = 9;

const keyOf = (catalog, cardId) => `${catalog || 'international'}|${cardId}`;

// Where a placed copy is now, in words: "Loose", or "Binder A, p. 3".
export function whereText(where) {
	return where ? `${where.binderName || 'A binder'}, p. ${where.page}` : 'Loose';
}

// The owner's live copies of a pocket's card, best first: loose copies
// (in no binder pocket) before placed ones, since a copy already filed
// would be taken from its pocket; then the language and finish the scan
// read, when it read them; then the oldest. entries: his live copies;
// placed: js/binders.js placements (Map entry_id -> {binder, slot}).
// Returns [{entry, where}], where null for a loose copy, else {binderId,
// binderName, page, position}.
export function copyChoices(item, entries, placed) {
	if (!item || !item.card) {
		return [];
	}

	const wanted = keyOf(item.card.catalog, item.card.id);
	const language = item.languageBy && item.languageBy !== 'default' ? item.language : null;
	const choices = (entries || [])
		.filter((entry) => entry && !entry.deleted_at && keyOf(entry.catalog, entry.card_id) === wanted)
		.map((entry) => {
			const at = placed && placed.get(entry.id);

			return {entry, where: at ? {binderId: at.binder.id, binderName: at.binder.name, page: at.slot.page, position: at.slot.position} : null};
		});
	const score = ({entry, where}) => [
		where ? 1 : 0,
		language && entry.language !== language ? 1 : 0,
		item.variantId && entry.variant_id && entry.variant_id !== item.variantId ? 1 : 0,
	];

	return choices.sort((a, b) => {
		const [x, y] = [score(a), score(b)];

		return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]) || String(a.entry.created_at || '').localeCompare(String(b.entry.created_at || ''));
	});
}

// Each pocket's copy, in pocket order, so one copy is never placed twice:
// Map item id -> {choices, entry, where}, entry null when he owns none left.
// picks: Map item id -> entry id he chose (or null for "not this one: a
// placeholder"), kept over the automatic choice while that copy is free.
export function matchPage(items, entries, placed, picks = new Map()) {
	const taken = new Set();
	const out = new Map();
	const ordered = [...items].sort((a, b) => a.page - b.page);

	// His own picks first, so the automatic choices go round them.
	for (const item of ordered) {
		const picked = picks.get(item.id);

		if (picked) {
			taken.add(picked);
		}
	}

	for (const item of ordered) {
		const choices = copyChoices(item, entries, placed);
		const picked = picks.has(item.id) ? picks.get(item.id) : undefined;
		let chosen = null;

		if (picked) {
			chosen = choices.find((choice) => choice.entry.id === picked) || null;
		}
		else if (picked === undefined) {
			chosen = choices.find((choice) => !taken.has(choice.entry.id)) || null;
		}

		if (chosen) {
			taken.add(chosen.entry.id);
		}

		out.set(item.id, {choices, entry: chosen ? chosen.entry : null, where: chosen ? chosen.where : null});
	}

	return out;
}

// What goes in each binder pocket: [{page, position, content}], the left
// page's pockets on `page` and a spread's right page's on the next one.
// content is {entry_id} for a copy he owns, or the card's placeholder
// ({want}, js/binders.js placePlaceholder's fields) when he has none left.
export function pagePockets(items, matches, page) {
	return [...items]
		.sort((a, b) => a.page - b.page)
		.filter((item) => item.card)
		.map((item) => {
			const match = matches.get(item.id);
			const content = match && match.entry
				? {entry_id: match.entry.id}
				: {want: {card_id: item.card.id, catalog: item.card.catalog || 'international', image: item.card.image || null, name: item.card.name || null, variant_id: item.variantId || null}};

			return {content, page: page + Math.floor((item.page - 1) / PER_PAGE), position: ((item.page - 1) % PER_PAGE) + 1};
		});
}

// What placing will do, in numbers, for the sheet's line: {copies, moved,
// placeholders}: copies placed, how many of them leave another pocket, and
// placeholders for cards he does not own.
export function placeSummary(items, matches) {
	const out = {copies: 0, moved: 0, placeholders: 0};

	for (const item of items) {
		if (!item.card) {
			continue;
		}

		const match = matches.get(item.id);

		if (match && match.entry) {
			out.copies++;

			if (match.where) {
				out.moved++;
			}
		}
		else {
			out.placeholders++;
		}
	}

	return out;
}
