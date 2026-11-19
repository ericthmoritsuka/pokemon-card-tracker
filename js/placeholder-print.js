// Print placeholders (DESIGN.md section 11, Binders; from a survey of other
// binder apps, 2026-11-19): paper cards for a binder's pockets still to
// fill, so Eric can slip one into each pocket of the real binder until the
// card arrives. js/placeholder-print-view.js draws the sheets and prints
// them; this file is the part with no page: which pockets, in what order,
// and how they fall onto sheets. Node tests it (tests/placeholder-print.test.mjs).
//
//   - A pocket to fill is a placeholder (a card's or a Pokémon's), a Gone
//     pocket (its copy was deleted or traded, so the real pocket is empty),
//     or, in a binder from a list, a Pokémon or card not owned yet. A
//     pocket with nothing in it, one left empty on purpose, and art have
//     nothing to print, so they are skipped.
//   - A filled pocket (a copy you own) prints only when asked.
//   - Order is the binder's: page by page, pocket by pocket.
//   - Nine cards to a sheet, 3 x 3 at the real card size, 63 x 88 mm,
//     which fits A4 and US Letter.

import {plural} from './format.js';

export const CARD_MM = {height: 88, width: 63};
export const SHEET_COLS = 3;
export const SHEET_ROWS = 3;
export const PER_SHEET = SHEET_COLS * SHEET_ROWS;

// PokeAPI's official artwork, larger than the sprite the checklists show
// (js/checklists.js spriteUrl), so it prints sharp at 5 cm. Same host and
// folder, so the service worker keeps it as it keeps sprites.
export const artworkUrl = (n) => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${n}.png`;

// What a hand-made binder's pocket is to the print: 'want' (to fill),
// 'filled' (a copy you own), or null (nothing to print). live(entryId)
// says whether a copy is still owned.
export function handPocketStatus(slot, live) {
	if (!slot) {
		return null;
	}

	if (slot.entry_id) {
		return live(slot.entry_id) ? 'filled' : 'want';
	}

	return slot.want ? 'want' : null;
}

// The same for a binder from a list: a key '' is a pocket left out with its
// gap kept, and past the last key there is no pocket.
export function listPocketStatus(key, shown) {
	if (!key) {
		return null;
	}

	return shown ? 'filled' : 'want';
}

// Every pocket of the binder with something to print, in binder order:
// [{page, position, status}]. statusAt(page, position) gives
// handPocketStatus or listPocketStatus for one pocket.
export function printablePockets(binder, statusAt) {
	const per = binder.rows * binder.cols;
	const pockets = [];

	for (let page = 1; page <= binder.page_count; page++) {
		for (let position = 1; position <= per; position++) {
			const status = statusAt(page, position);

			if (status) {
				pockets.push({page, position, status});
			}
		}
	}

	return pockets;
}

// The pockets to print, from the choices: pages (a list of page numbers, or
// null for every page) and filled (true to print pockets already filled
// too). Sorted in binder order whatever order they came in.
export function choosePockets(pockets, {filled = false, pages = null} = {}) {
	const only = pages ? new Set(pages) : null;

	return pockets
		.filter((pocket) => (!only || only.has(pocket.page)) && (filled || pocket.status !== 'filled'))
		.sort((a, b) => a.page - b.page || a.position - b.position);
}

// The cards in sheets of nine, in order, the last one holding the rest.
export function sheetsOf(cards, per = PER_SHEET) {
	const sheets = [];

	for (let i = 0; i < cards.length; i += per) {
		sheets.push(cards.slice(i, i + per));
	}

	return sheets;
}

// "Page 3" or "Pages 2 and 3", for the choice of the pages on screen.
export const pagesText = (pages) => (pages.length > 1 ? `Pages ${pages.join(' and ')}` : `Page ${pages[0]}`);

// The line over the preview.
export function summaryText(count) {
	if (!count) {
		return 'No pockets to fill here.';
	}

	return `${plural(count, 'card')} on ${plural(Math.ceil(count / PER_SHEET), 'sheet')}.`;
}

// Where the card goes, printed on it.
export const pocketText = (page, position) => `Page ${page}, pocket ${position}`;
