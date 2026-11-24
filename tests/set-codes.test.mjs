// printedSetCode (js/catalog.js): the code printed on an international set's
// cards, which the Shop's set filter shows before the set's name (Eric,
// 2026-11-24: "(CRI) Caos Ascendente"). Every code is TCGdex's
// abbreviation.official for that set ID.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {parseCardQuery} from '../js/card-search.js';
import {printedSetCode, shopSetCode} from '../js/catalog.js';

describe('printedSetCode', () => {
	test('an international set gets its printed code, the newest ones included', () => {
		assert.equal(printedSetCode('international', 'me04'), 'CRI');
		assert.equal(printedSetCode('international', 'me05'), 'PBL');
		assert.equal(printedSetCode('international', 'me06'), 'DLR');
		assert.equal(printedSetCode('international', 'sv03.5'), 'MEW');
	});

	test('Hidden Fates is keyed by TCGdex\'s ID, sm115', () => {
		assert.equal(printedSetCode('international', 'sm115'), 'HIF');
		assert.equal(printedSetCode('international', 'sm11.5'), null);
	});

	test('an unknown set, a Japanese set, or an inherited key has none', () => {
		assert.equal(printedSetCode('international', 'tsa1'), null);
		assert.equal(printedSetCode('ja', 'SV6'), null);
		assert.equal(printedSetCode('ja', 'me04'), null);
		assert.equal(printedSetCode('international', 'toString'), null);
		assert.equal(printedSetCode('international', null), null);
	});
});

// shopSetCode (js/catalog.js): the Shop's filter also names the older
// Western sets (Eric, 2026-11-24), from a table card search never reads.
describe('shopSetCode', () => {
	test('a newer set keeps the shared code, and an older Western set gets its own', () => {
		assert.equal(shopSetCode('international', 'me04'), 'CRI');
		assert.equal(shopSetCode('international', 'xy12'), 'EVO');
		assert.equal(shopSetCode('international', 'base1'), 'BS');
		assert.equal(shopSetCode('international', 'ecard1'), 'EX');
		assert.equal(shopSetCode('international', 'pl3'), 'SV');
		assert.equal(shopSetCode('international', 'dp1'), 'DP');
		assert.equal(shopSetCode('international', 'tk-xy-latia'), 'TK8A');
	});

	test('a set with no official code, a Japanese set, or an inherited key has none', () => {
		assert.equal(shopSetCode('international', 'tsa1'), null);
		assert.equal(shopSetCode('ja', 'base1'), null);
		assert.equal(shopSetCode('ja', 'SV6'), null);
		assert.equal(shopSetCode('international', 'constructor'), null);
	});
});

// Card search reads a word equal to a set code, typed with a number, as the
// set. Its codes come from the set list, which takes them from the table
// printedSetCode reads, so the Shop's older codes must stay out of it.
describe('card search and the Shop-only codes', () => {
	const ids = ['ecard1', 'pl3', 'dp1', 'me04'];
	const searchSets = ids.map((id) => ({catalog: 'international', code: printedSetCode('international', id), id}));

	test('the older sets have no code where card search looks', () => {
		for (const id of ['ecard1', 'pl3', 'dp1']) {
			assert.equal(printedSetCode('international', id), null, id);
		}
	});

	test('"ex", "SV", and "DP" beside a number name no set', () => {
		const ex = parseCardQuery('Pikachu ex 25', searchSets);

		assert.equal(ex.setId, null);
		assert.deepEqual(ex.kinds, ['ex']);

		for (const text of ['Pikachu SV 25', 'Pikachu DP 25', 'sv 12', 'dp 7']) {
			const query = parseCardQuery(text, searchSets);

			assert.equal(query.setId, null, text);
			assert.equal(query.setCatalog, null, text);
		}

		assert.equal(parseCardQuery('Pikachu SV 25', searchSets).name, 'pikachu sv');
	});

	test('a shared code still names its set, so the check above can fail', () => {
		assert.equal(parseCardQuery('Pikachu CRI 25', searchSets).setId, 'me04');

		const withShopCodes = ids.map((id) => ({catalog: 'international', code: shopSetCode('international', id), id}));

		assert.equal(parseCardQuery('Pikachu SV 25', withShopCodes).setId, 'pl3', 'what the Shop table would do to search');
	});
});
