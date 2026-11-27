// Copies with no finish set (js/unset-finish.js): which copies are unset,
// the tiles and sets they fall in, the select all of a set, the finishes to
// offer with a card's only printing first, and the reading of every card's
// printings in batches of FINISH_READS. No browser:
// tests/copy-cleanup-browser.test.mjs plays the screen.
//
// Run: node --test tests/unset-finish.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {FINISH_READS, finishPlan} from '../js/bulk-edit.js';
import {batchesOf, copyCount, finishOptions, groupBySet, isUnset, progressText, pruneSelection, readFinishes, savedText, selectState, setIdOf, toggleSet, unsetTiles} from '../js/unset-finish.js';

const copy = (id, cardId, fields = {}) => ({
	card_id: cardId,
	catalog: 'international',
	created_at: `2026-11-0${(Number(id.replace(/\D/g, '')) % 9) + 1}T10:00:00.000Z`,
	deleted_at: null,
	finish_raw: null,
	id,
	language: 'en',
	variant_id: null,
	...fields,
});

describe('isUnset and unsetTiles', () => {
	test('a copy with no printing and no word is unset, any other is not', () => {
		assert.equal(isUnset(copy('a', 'tsa1-001')), true);
		assert.equal(isUnset(copy('a', 'tsa1-001', {variant_id: 'tsa1-001-normal'})), false);
		assert.equal(isUnset(copy('a', 'tsa1-001', {finish_raw: 'HOLOFOIL'})), false, 'a word the catalog never matched is a finish');
		assert.equal(isUnset(copy('a', 'tsa1-001', {deleted_at: '2026-11-01T00:00:00.000Z'})), false);
		assert.equal(isUnset(null), false);
	});

	test('one tile per card and language, holding only the unset copies, oldest first', () => {
		const cards = [
			copy('c3', 'tsa1-004'),
			copy('c1', 'tsa1-004'),
			copy('c2', 'tsa1-004', {variant_id: 'tsa1-004-normal'}),
			copy('c4', 'tsa1-004', {language: 'pt'}),
			copy('c5', 'tsa1-006'),
		];
		const tiles = unsetTiles(cards);

		assert.deepEqual(tiles.map((tile) => [tile.cardId, tile.language, tile.entries.map((entry) => entry.id)]), [
			['tsa1-004', 'en', ['c1', 'c3']],
			['tsa1-004', 'pt', ['c4']],
			['tsa1-006', 'en', ['c5']],
		]);
		assert.equal(copyCount(tiles), 4);
		assert.ok(tiles.every((tile) => tile.catalog === 'international' && typeof tile.key === 'string'));
	});

	test('nothing unset gives no tiles', () => {
		assert.deepEqual(unsetTiles([copy('a', 'tsa1-001', {variant_id: 'v'})]), []);
		assert.deepEqual(unsetTiles(null), []);
	});
});

describe('groupBySet', () => {
	const tiles = unsetTiles([
		copy('a', 'tsb2-025'),
		copy('b', 'tsa1-006'),
		copy('c', 'tsa1-004'),
		copy('d', 'tsa1-004'),
		copy('e', 'hand_1', {catalog: 'custom', language: 'en'}),
		copy('f', 'zzz9-001'),
	]);
	const names = {'tsa1-004': 'Charmander', 'tsa1-006': 'Charizard ex', 'tsb2-025': 'Pikachu'};
	const setOf = (tile) => {
		if (tile.catalog === 'custom') {
			return {id: 'custom', last: true, name: 'Hand-made cards'};
		}

		const id = setIdOf(tile.cardId);

		return {id, name: {tsa1: 'Test Alpha', tsb2: 'Test Beta'}[id] || ''};
	};

	test('sets by name, an unnamed set after them, hand-made cards last', () => {
		const sets = groupBySet(tiles, {nameOf: (tile) => names[tile.cardId] || tile.cardId, setOf});

		assert.deepEqual(sets.map((set) => [set.id, set.name, set.copies]), [
			['tsa1', 'Test Alpha', 3],
			['tsb2', 'Test Beta', 1],
			['zzz9', '', 1],
			['custom', 'Hand-made cards', 1],
		]);
	});

	test('the cards of a set by name', () => {
		const sets = groupBySet(tiles, {nameOf: (tile) => names[tile.cardId] || tile.cardId, setOf});

		assert.deepEqual(sets[0].tiles.map((tile) => names[tile.cardId]), ['Charizard ex', 'Charmander']);
	});

	test('setIdOf cuts at the last dash', () => {
		assert.equal(setIdOf('sv8pt5-130'), 'sv8pt5');
		assert.equal(setIdOf('swsh12.5-GG01'), 'swsh12.5');
		assert.equal(setIdOf('nodash'), '');
	});
});

describe('select all per set', () => {
	const tiles = unsetTiles([copy('a', 'tsa1-001'), copy('b', 'tsa1-004'), copy('c', 'tsb2-025')]);
	const [alpha, beta] = groupBySet(tiles, {setOf: (tile) => ({id: setIdOf(tile.cardId), name: setIdOf(tile.cardId)})});

	test('ticks every card of the set and only that set', () => {
		const selected = toggleSet(new Set(), alpha);

		assert.equal(selectState(selected, alpha), 'all');
		assert.equal(selectState(selected, beta), 'none');
		assert.equal(selected.size, 2);
	});

	test('a second tap clears the set, and a half ticked set is ticked whole', () => {
		const all = toggleSet(new Set(), alpha);

		assert.equal(toggleSet(all, alpha).size, 0);

		const some = new Set([alpha.tiles[0].key]);

		assert.equal(selectState(some, alpha), 'some');
		assert.equal(selectState(toggleSet(some, alpha), alpha), 'all');
	});

	test('toggleSet leaves the Set it was given alone', () => {
		const before = new Set();

		toggleSet(before, alpha);
		assert.equal(before.size, 0);
	});

	test('pruneSelection drops the ticks of a card no longer listed', () => {
		const kept = pruneSelection(new Set([alpha.tiles[0].key, 'gone']), tiles);

		assert.deepEqual([...kept], [alpha.tiles[0].key]);
	});
});

describe('finishOptions', () => {
	const choice = (label) => ({label, value: `v-${label}`});
	const tilesOf = (...ids) => unsetTiles(ids.map((id, i) => copy(`c${i}`, id)));

	test('the only printing of a selected card comes first', () => {
		const tiles = tilesOf('one-1', 'many-1', 'many-2');
		const choices = new Map([
			[tiles[0].key, [choice('Holo')]],
			[tiles[1].key, [choice('Normal'), choice('Reverse Holo'), choice('Holo')]],
			[tiles[2].key, [choice('Normal'), choice('Reverse Holo')]],
		]);
		const options = finishOptions(tiles, (tile) => choices.get(tile.key) || null);

		assert.deepEqual(options.map((option) => [option.label, option.fits, option.only]), [
			['Holo', 2, 1],
			['Normal', 2, 0],
			['Reverse Holo', 2, 0],
		]);
	});

	test('more cards with that only printing come first, then the finish most come in, then the name', () => {
		const tiles = tilesOf('a-1', 'a-2', 'b-1', 'c-1', 'c-2');
		const choices = new Map([
			[tiles[0].key, [choice('Normal')]],
			[tiles[1].key, [choice('Normal')]],
			[tiles[2].key, [choice('Holo')]],
			[tiles[3].key, [choice('Reverse Holo'), choice('Holo')]],
			[tiles[4].key, [choice('Reverse Holo'), choice('Holo')]],
		]);

		assert.deepEqual(finishOptions(tiles, (tile) => choices.get(tile.key)).map((option) => option.label), ['Normal', 'Holo', 'Reverse Holo']);
	});

	test('a card whose finishes are not known adds no option', () => {
		const tiles = tilesOf('a-1', 'b-1');

		assert.deepEqual(finishOptions(tiles, () => null), []);
	});

	test('the choice goes through the same plan My Cards uses', () => {
		const tiles = tilesOf('a-1', 'b-1');
		const choices = new Map([[tiles[0].key, [choice('Holo')]], [tiles[1].key, [choice('Normal')]]]);
		const plan = finishPlan(tiles, 'Holo', (tile) => choices.get(tile.key));

		assert.deepEqual(plan.patches, [{id: 'c0', patch: {variant_id: 'v-Holo'}}], 'an unset copy has no word to clear');
		assert.equal(plan.missing, 1);
		assert.equal(plan.unknown, 0);
	});
});

describe('readFinishes in batches', () => {
	const manyTiles = (n) => unsetTiles(Array.from({length: n}, (_, i) => copy(`c${i}`, `tsa1-${String(i + 1).padStart(3, '0')}`)));
	const choices = (tile) => [{label: 'Holo', value: `v-${tile.cardId}`}];

	test('batchesOf cuts at FINISH_READS and keeps the rest', () => {
		assert.equal(FINISH_READS, 60);
		assert.deepEqual(batchesOf([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
		assert.deepEqual(batchesOf([], 60), []);
		assert.deepEqual(batchesOf(Array.from({length: 130}, (_, i) => i)).map((batch) => batch.length), [60, 60, 10]);
	});

	test('130 cards are read in batches of 60, every one, with progress after each', async () => {
		const tiles = manyTiles(130);
		const known = new Map();
		const reads = [];
		const progress = [];
		let inFlight = 0;
		let widest = 0;

		const unknown = await readFinishes(tiles, {
			known,
			onProgress: (report) => progress.push(report),
			read: async (tile) => {
				inFlight++;
				widest = Math.max(widest, inFlight);
				reads.push(tile.key);
				await new Promise((resolve) => setTimeout(resolve, 0));
				inFlight--;

				return choices(tile);
			},
		});

		assert.deepEqual(unknown, [], 'no card left unknown');
		assert.equal(known.size, 130);
		assert.equal(reads.length, 130);
		assert.ok(widest <= 4, `at most four requests at once, saw ${widest}`);
		assert.deepEqual(progress.map(({batch, batches, done, total}) => [batch, batches, done, total]), [[0, 3, 0, 130], [1, 3, 60, 130], [2, 3, 120, 130], [3, 3, 130, 130]]);
	});

	test('a batch finishes before the next starts', async () => {
		const tiles = manyTiles(125);
		const order = [];

		await readFinishes(tiles, {
			known: new Map(),
			read: async (tile) => {
				order.push(tiles.indexOf(tile));

				return choices(tile);
			},
		});

		for (let i = 0; i < order.length; i++) {
			assert.equal(Math.floor(order[i] / FINISH_READS), Math.floor(i / FINISH_READS), 'a read of the next batch never began early');
		}
	});

	test('cards known, or answered locally, cost no request', async () => {
		const tiles = manyTiles(4);
		const known = new Map([[tiles[0].key, choices(tiles[0])]]);
		const reads = [];
		const progress = [];

		await readFinishes(tiles, {
			known,
			local: (tile) => (tile === tiles[1] ? choices(tile) : null),
			onProgress: (report) => progress.push(report.total),
			read: async (tile) => {
				reads.push(tile.cardId);

				return choices(tile);
			},
		});

		assert.deepEqual(reads, ['tsa1-003', 'tsa1-004']);
		assert.equal(known.size, 4);
		assert.equal(progress[0], 2);
	});

	test('a failed read, or a card with no printings, stays unknown for another try, and the rest are read', async () => {
		const tiles = manyTiles(5);
		const known = new Map();
		const unknown = await readFinishes(tiles, {
			known,
			read: async (tile) => {
				if (tile.cardId === 'tsa1-002') {
					throw new Error('offline');
				}

				return tile.cardId === 'tsa1-004' ? null : choices(tile);
			},
		});

		assert.deepEqual(unknown.map((tile) => tile.cardId), ['tsa1-002', 'tsa1-004']);
		assert.equal(known.size, 3);

		const again = await readFinishes(tiles, {known, read: async (tile) => choices(tile)});

		assert.deepEqual(again, []);
		assert.equal(known.size, 5);
	});

	test('it stops between batches once the screen is gone', async () => {
		const tiles = manyTiles(130);
		const known = new Map();
		let alive = true;

		const unknown = await readFinishes(tiles, {
			isAlive: () => alive,
			known,
			onProgress: ({batch}) => {
				if (batch === 1) {
					alive = false;
				}
			},
			read: async (tile) => choices(tile),
		});

		assert.equal(known.size, 60);
		assert.equal(unknown.length, 70);
	});

	test('nothing to read reports zero and finishes', async () => {
		const progress = [];

		assert.deepEqual(await readFinishes([], {known: new Map(), onProgress: (report) => progress.push(report), read: async () => null}), []);
		assert.deepEqual(progress, [{batch: 0, batches: 0, done: 0, total: 0}]);
	});
});

describe('words', () => {
	test('progressText says how far it is', () => {
		assert.equal(progressText({done: 60, total: 130}), 'Reading finishes: 60 of 130 cards.');
		assert.equal(progressText({done: 0, total: 1}), 'Reading finishes: 0 of 1 card.');
	});

	test('savedText names what was set and what was left as it was', () => {
		assert.equal(savedText('Holo', {missing: 0, unknown: 0}, 5), 'Holo set on 5 copies.');
		assert.equal(savedText('Holo', {missing: 2, unknown: 0}, 1), 'Holo set on 1 copy. 2 cards were left as they were: they do not come in Holo.');
		assert.equal(savedText('Holo', {missing: 2, unknown: 0}, 0), 'No copy changed. 2 cards were left as they were: they do not come in Holo.');
		assert.equal(savedText('Holo', {missing: 0, unknown: 0}, 0), 'No copy changed.');
		assert.equal(savedText('Holo', {missing: 1, unknown: 3}, 4), 'Holo set on 4 copies. 1 card was left as it was: it does not come in Holo. 3 cards were left as they were: their finishes could not be read.');
	});
});
