// What each bulk action on My Cards changes (Eric, 2026-11-18: select many
// tiles and change them at once), worked out without the page, so node can
// test it. js/bulk-select.js draws the bar and the sheets and saves these
// plans with js/collection.js updateCards, one write for the whole batch.
//
// A tile is one card in one language holding one or more copies,
// {catalog, entries}; every action applies to every copy of each selected
// tile. A patch holds only the fields that change on that copy, so a field
// left alone is never stamped as edited and a copy keeps fields it never had
// (js/copy-sheet.js changes does the same for one row).

import {catalogFor, copyLanguageCodes} from './languages.js';

// A tile's key: one card in one language. js/cards-view.js groups copies
// into tiles by it, and js/stats.js counts cards by it, so My Cards' count
// and Stats' Cards are one number.
export const tileKey = (entry) => `${entry.catalog}|${entry.card_id}|${entry.language}`;

// is_favorite is true or missing on most copies, and false only once a star
// was taken off: both missing and false mean not a favorite.
const same = (key, a, b) => (key === 'is_favorite' ? Boolean(a) === Boolean(b) : (a ?? null) === (b ?? null));

// [{id, patch}] setting `fields` on every copy where one of them differs.
export function fieldPatches(entries, fields) {
	const patches = [];

	for (const entry of entries) {
		const patch = {};

		for (const [key, value] of Object.entries(fields)) {
			if (!same(key, entry[key], value)) {
				patch[key] = value;
			}
		}

		if (Object.keys(patch).length) {
			patches.push({id: entry.id, patch});
		}
	}

	return patches;
}

// Undo's patches: each field a patch changes, back to what the copy has
// now. Taken before the write, because saving changes the entries in place.
// As the copy sheet's Undo: a field the copy did not have goes back as
// null, and fallback as true or false.
export function undoPatches(entries, patches) {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));

	return patches.filter(({id}) => byId.has(id)).map(({id, patch}) => {
		const entry = byId.get(id);

		return {id, patch: Object.fromEntries(Object.keys(patch).map((key) => [key, key === 'fallback' ? Boolean(entry.fallback) : entry[key] ?? null]))};
	});
}

const copiesOf = (tiles) => tiles.flatMap((tile) => tile.entries);

// --------------------------------------------------------------- language

// The languages a copy in this catalog can be in, as the copy sheet offers
// them (js/copy-sheet.js copyLanguages): a Japanese record also holds Korean
// copies, and a hand-made card can be in any language.
export function tileLanguages(catalog) {
	const known = copyLanguageCodes(catalog);

	return known.length ? known : [catalog];
}

// Every language some selected card can be in, with how many of the tiles
// can take it (fits), in the order of the languages table.
export function languageChoices(tiles) {
	const fits = new Map();

	for (const tile of tiles) {
		for (const code of tileLanguages(tile.catalog)) {
			fits.set(code, (fits.get(code) || 0) + 1);
		}
	}

	return [...fits].map(([code, count]) => ({code, fits: count}));
}

// Sets the language on the copies of every tile whose catalog can hold it;
// the rest are left as they were (skipped, counted in tiles). keys maps each
// changed tile's key to the key it has after, so a selection can follow it.
export function languagePlan(tiles, code) {
	const patches = [];
	const keys = new Map();
	let skipped = 0;

	for (const tile of tiles) {
		if (!tileLanguages(tile.catalog).includes(code)) {
			skipped++;

			continue;
		}

		// A copy whose language belongs to another catalog (a Korean copy
		// on a Japanese record) is a fallback match (DESIGN.md section 5);
		// a hand-made card belongs to no catalog, so it never is.
		const fallback = tile.catalog !== 'custom' && catalogFor(code) !== tile.catalog;

		for (const entry of tile.entries) {
			const patch = {};

			if (entry.language !== code) {
				patch.language = code;
				patch.language_source = 'manual';
				keys.set(tileKey(entry), tileKey({...entry, language: code}));
			}

			if (fallback !== Boolean(entry.fallback)) {
				patch.fallback = fallback;
			}

			if (Object.keys(patch).length) {
				patches.push({id: entry.id, patch});
			}
		}
	}

	return {keys, patches, skipped};
}

// ----------------------------------------------------------------- finish

// The field a finish is kept in: a hand-made card has no catalog printings,
// so its finish is one of monprice's words in finish_raw.
export const finishField = (catalog) => (catalog === 'custom' ? 'finish_raw' : 'variant_id');

// Every finish some selected card comes in, by its name, with how many of
// the tiles come in it (fits). choicesOf(tile) gives the card's finishes,
// [{label, value}], or null when they are not known on this phone.
export function finishLabels(tiles, choicesOf) {
	const fits = new Map();

	for (const tile of tiles) {
		const labels = new Set((choicesOf(tile) || []).map((choice) => choice.label));

		for (const label of labels) {
			fits.set(label, (fits.get(label) || 0) + 1);
		}
	}

	return [...fits].map(([label, count]) => ({fits: count, label}));
}

// Sets the finish named `label` on the copies of every tile whose card comes
// in it. The rest are left as they were, counted in tiles: missing, the card
// does not come in that finish; unknown, its finishes are not known.
export function finishPlan(tiles, label, choicesOf) {
	const patches = [];
	let missing = 0;
	let unknown = 0;

	for (const tile of tiles) {
		const choices = choicesOf(tile);
		const choice = choices && choices.find((item) => item.label === label);

		if (!choices) {
			unknown++;
		}
		else if (!choice) {
			missing++;
		}
		else {
			// A catalog printing is its variant ID with no word, as
			// js/copy-sheet.js finishFields sets it for one copy: a word left
			// from an import or a "(not listed)" pick would keep its corner on
			// the tile (review, 2026-11-19).
			patches.push(...fieldPatches(tile.entries, tile.catalog === 'custom' ? {finish_raw: choice.value} : {finish_raw: null, variant_id: choice.value}));
		}
	}

	return {missing, patches, unknown};
}

// ----------------------------------------------------------------- binder

// The copies Add to binder takes: those in no pocket and no tray, as the
// binder's own Add cards to the tray offers, so Undo takes each one back out
// to where it was. placed and trayed are Sets of entry ids.
export function binderCopies(tiles, placed, trayed) {
	const ids = [];
	let kept = 0;

	for (const entry of copiesOf(tiles)) {
		if (placed.has(entry.id) || trayed.has(entry.id)) {
			kept++;
		}
		else {
			ids.push(entry.id);
		}
	}

	return {ids, kept};
}
