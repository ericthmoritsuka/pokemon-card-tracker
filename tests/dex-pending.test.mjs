// dexPending (js/catalog.js): a Pokémon read before TCGdex filled in its
// Pokédex number is read again (2026-11-20: 30th Celebration cards saved
// with none, so a 30th Mew was missing from the Kanto list).
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {dexPending, setsNeedingDetails} from '../js/catalog.js';

const record = (id, category, dexIds) => ({catalog: 'international', category, dex_ids: dexIds, id, illustrator: null, localizations: {}, set_id: '30th'});

describe('dexPending', () => {
	test('a Pokémon with no number is pending; with one, or a Trainer or Energy, it is not', () => {
		assert.equal(dexPending(record('30th-065', 'Pokemon', [])), true);
		assert.equal(dexPending(record('30th-065', 'Pokemon', [151])), false);
		assert.equal(dexPending(record('30th-100', 'Trainer', [])), false);
		assert.equal(dexPending(record('30th-160', 'Energy', [])), false);
		assert.equal(dexPending(null), false);
	});

	test('setsNeedingDetails asks again for a set whose owned Pokémon came with no number, not for its Trainers', () => {
		const index = new Map([
			['international|30th-065', record('30th-065', 'Pokemon', [])],
			['international|30th-100', record('30th-100', 'Trainer', [])],
			['international|sv03.5-151', {...record('sv03.5-151', 'Pokemon', [151]), set_id: 'sv03.5'}],
		]);
		const entries = ['30th-065', '30th-100', 'sv03.5-151'].map((id) => ({card_id: id, catalog: 'international'}));
		const sets = setsNeedingDetails(entries, index);

		assert.deepEqual(sets.map((set) => [set.setId, [...set.ids]]), [['30th', ['30th-065']]]);
	});
});
