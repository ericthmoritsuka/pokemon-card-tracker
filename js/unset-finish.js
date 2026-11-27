// Copies with no finish set (Eric, 2026-11-26): the copies whose finish was
// never said, grouped by set, with a bulk Set finish. An unset finish never
// pairs with Normal (his 2026-11-26 decision, js/wishlist.js copyFinishKey),
// so real duplicates with no finish stay home and never reach the spares;
// setting the finish is what lets them count.
//
// The finish is set by the same code My Cards' bulk Finish uses
// (js/bulk-edit.js finishLabels and finishPlan), on the same reads of the
// card's printings. What is new here is the reading in batches: My Cards'
// Finish reads the first FINISH_READS cards and calls the rest unknown, so a
// selection of hundreds would leave most unset; this reads every card, one
// batch of FINISH_READS at a time, and says how far it is.
//
// Worked out without the page, so node can test it
// (tests/unset-finish.test.mjs).

import {FINISH_READS, finishLabels, tileKey} from './bulk-edit.js';
import {isLive} from './collection.js';
import {pool} from './tcgdex.js';

const collator = new Intl.Collator('en', {numeric: true, sensitivity: 'base'});

// A copy whose finish was never said: no printing and no monprice word.
// A copy with a word the catalog does not list has a finish, so it is not
// here.
export const isUnset = (entry) => Boolean(entry) && isLive(entry) && !entry.variant_id && !entry.finish_raw;

// The set a card belongs to by its id ("tsa1-004" is "tsa1"), for a card
// whose record this phone has not read.
export const setIdOf = (cardId) => {
	const cut = String(cardId).lastIndexOf('-');

	return cut > 0 ? String(cardId).slice(0, cut) : '';
};

// One tile per card in one language, holding that card's unset copies (the
// shape js/bulk-edit.js takes): [{key, catalog, cardId, language, entries}],
// the entries oldest first, the tiles in the order of their first copy.
export function unsetTiles(cards) {
	const tiles = new Map();

	for (const entry of cards || []) {
		if (!isUnset(entry)) {
			continue;
		}

		const catalog = entry.catalog || 'international';
		const key = tileKey({card_id: entry.card_id, catalog, language: entry.language});

		if (!tiles.has(key)) {
			tiles.set(key, {cardId: entry.card_id, catalog, entries: [], key, language: entry.language || null});
		}

		tiles.get(key).entries.push(entry);
	}

	for (const tile of tiles.values()) {
		tile.entries.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id)));
	}

	return [...tiles.values()];
}

export const copyCount = (tiles) => tiles.reduce((sum, tile) => sum + tile.entries.length, 0);

// The tiles by set: [{id, name, last, tiles, copies}], sets by name, a set
// with no name known after the others, and a set marked last (hand-made
// cards) at the very end; each set's tiles by name, then card number as the
// card's own id sorts. setOf(tile): {id, name, last?}, as the page knows them;
// nameOf(tile): the card's name, for the order inside a set.
export function groupBySet(tiles, {nameOf = (tile) => tile.cardId, setOf}) {
	const sets = new Map();

	for (const tile of tiles) {
		const set = setOf(tile);
		const id = String(set.id || '');

		if (!sets.has(id)) {
			sets.set(id, {copies: 0, id, last: Boolean(set.last), name: set.name || '', tiles: []});
		}

		const group = sets.get(id);

		group.tiles.push(tile);
		group.copies += tile.entries.length;

		if (!group.name && set.name) {
			group.name = set.name;
		}
	}

	const rank = (set) => (set.last ? 2 : set.name ? 0 : 1);

	return [...sets.values()]
		.map((set) => ({...set, tiles: [...set.tiles].sort((a, b) => collator.compare(nameOf(a), nameOf(b)) || collator.compare(a.cardId, b.cardId) || collator.compare(String(a.language), String(b.language)))}))
		.sort((a, b) => (rank(a) - rank(b)) || collator.compare(a.name, b.name) || collator.compare(a.id, b.id));
}

// ------------------------------------------------------------- selection
//
// The selection is a Set of tile keys. A set's select all ticks every tile
// of the set, and ticks none when every one is ticked already.

// 'all', 'some', or 'none' of a set's tiles ticked.
export function selectState(selected, set) {
	const ticked = set.tiles.filter((tile) => selected.has(tile.key)).length;

	return ticked === 0 ? 'none' : ticked === set.tiles.length ? 'all' : 'some';
}

// A new Set of keys with a set's select all applied.
export function toggleSet(selected, set) {
	const next = new Set(selected);
	const clear = selectState(selected, set) === 'all';

	for (const tile of set.tiles) {
		if (clear) {
			next.delete(tile.key);
		}
		else {
			next.add(tile.key);
		}
	}

	return next;
}

// The ticks that still name a tile, so a redraw after a save leaves no tick
// on a card that has no unset copy left.
export const pruneSelection = (selected, tiles) => {
	const keys = new Set(tiles.map((tile) => tile.key));

	return new Set([...selected].filter((key) => keys.has(key)));
};

// ----------------------------------------------------------------- finish

// The batches a selection is read in: the pending cards, FINISH_READS at a
// time.
export function batchesOf(items, size = FINISH_READS) {
	const batches = [];

	for (let i = 0; i < items.length; i += size) {
		batches.push(items.slice(i, i + size));
	}

	return batches;
}

// The finishes to offer for the selected tiles, [{label, fits, only}], in the
// order of the select: a finish that is the only printing of some selected
// card first (the most such cards first), since for that card it is the one
// answer; then the finish most of the cards come in; then by name. only is
// how many of the selected cards come in no other. choicesOf(tile): the
// card's [{label, value}], or null when not known.
export function finishOptions(tiles, choicesOf) {
	const only = new Map();

	for (const tile of tiles) {
		const choices = choicesOf(tile);

		if (choices && choices.length === 1) {
			only.set(choices[0].label, (only.get(choices[0].label) || 0) + 1);
		}
	}

	return finishLabels(tiles, choicesOf)
		.map(({fits, label}) => ({fits, label, only: only.get(label) || 0}))
		.sort((a, b) => (b.only - a.only) || (b.fits - a.fits) || collator.compare(a.label, b.label));
}

// Reads the finishes of every tile not yet known, FINISH_READS cards at a
// time with `concurrency` requests at once, and leaves what it finds in
// `known` (tile key -> [{label, value}]). A tile local(tile) can answer with
// no request (a hand-made card, a record saved on the phone) costs none; the
// rest go through read(tile), which gives the card's choices or null, and
// whose failure leaves that card unknown, to be tried again at the next Set
// finish. onProgress({done, total, batch, batches}) runs before the first
// batch and after each, so the screen can say how far it is. isAlive
// returning false stops it between batches. Resolves with the tiles that are
// still unknown.
export async function readFinishes(tiles, {concurrency = 4, isAlive = () => true, known, local = () => null, onProgress = () => {}, read, size = FINISH_READS}) {
	const pending = [];

	for (const tile of tiles) {
		if (known.has(tile.key)) {
			continue;
		}

		const here = local(tile);

		if (here) {
			known.set(tile.key, here);
		}
		else {
			pending.push(tile);
		}
	}

	const batches = batchesOf(pending, size);
	let done = 0;

	onProgress({batch: 0, batches: batches.length, done, total: pending.length});

	for (const [i, batch] of batches.entries()) {
		if (!isAlive()) {
			break;
		}

		await pool(batch, concurrency, async (tile) => {
			try {
				const choices = await read(tile);

				if (choices && choices.length) {
					known.set(tile.key, choices);
				}
			}
			catch {
				// Not known, then: the card is left as it is.
			}
		});

		done += batch.length;
		onProgress({batch: i + 1, batches: batches.length, done, total: pending.length});
	}

	return tiles.filter((tile) => !known.has(tile.key));
}

// ---------------------------------------------------------------- words

// "Reading finishes: 60 of 130 cards." from onProgress's report.
export const progressText = ({done, total}) => `Reading finishes: ${done} of ${total} ${total === 1 ? 'card' : 'cards'}.`;

// The cards a finish plan left as they were, in words: "2 cards were left as
// they were: they do not come in Holo." Empty when it left none. plan:
// finishPlan's result.
export function leftText(label, plan) {
	const cards = (n) => (n === 1 ? '1 card was' : `${n} cards were`);
	const one = (n) => n === 1;

	return [
		plan.missing ? `${cards(plan.missing)} left as ${one(plan.missing) ? 'it was' : 'they were'}: ${one(plan.missing) ? 'it does' : 'they do'} not come in ${label}.` : '',
		plan.unknown ? `${cards(plan.unknown)} left as ${one(plan.unknown) ? 'it was' : 'they were'}: ${one(plan.unknown) ? 'its finishes' : 'their finishes'} could not be read.` : '',
	].filter(Boolean).join(' ');
}

// What Set finish did, for the toast: "Holo set on 5 copies. 2 cards were
// left as they were: they do not come in Holo."; with no copy changed, "No
// copy changed." and why.
export function savedText(label, plan, copies) {
	const first = copies ? `${label} set on ${copies === 1 ? '1 copy' : `${copies} copies`}.` : 'No copy changed.';

	return [first, leftText(label, plan)].filter(Boolean).join(' ');
}
