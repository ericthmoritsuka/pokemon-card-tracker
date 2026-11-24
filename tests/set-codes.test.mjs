// printedSetCode (js/catalog.js): the code printed on an international set's
// cards, which the Shop's set filter shows before the set's name (Eric,
// 2026-11-24: "(CRI) Caos Ascendente"). Every code is TCGdex's
// abbreviation.official for that set ID.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {printedSetCode} from '../js/catalog.js';

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
