// printedSetCode (js/catalog.js): the code printed on an international set's
// cards, which the Shop's set filter shows before the set's name (Eric,
// 2026-11-24: "(CRI) Caos Ascendente"). Every code is TCGdex's
// abbreviation.official for that set ID.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {parseCardQuery} from '../js/card-search.js';
import {printedSetCode, setFacts, shopSetCode, shopSetMark} from '../js/catalog.js';

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

// shopSetMark (js/catalog.js): the Shop's filter shows what a set's cards
// print (Eric, 2026-11-24): a pictorial symbol up to Sword & Shield, a code
// from Scarlet & Violet on, and the code when no symbol is known.
describe('shopSetMark', () => {
	const symbol = (path) => `https://assets.tcgdex.net/univ/${path}/symbol`;
	const facts = setFacts([
		{id: 'me', sets: [{id: 'me04', symbol: symbol('me/me04')}]},
		{id: 'sv', sets: [{id: 'sv03.5', symbol: symbol('sv/sv03.5')}]},
		{id: 'swsh', sets: [{id: 'swsh9', symbol: symbol('swsh/swsh9')}, {id: 'swsh9tg', symbol: null}, {id: 'swsh12.5', symbol: symbol('swsh/swsh12.5')}, {id: 'swsh4.5', symbol: symbol('swsh/swsh4.5')}]},
		{id: 'sm', sets: [{id: 'sm115', symbol: symbol('sm/sm115')}]},
		{id: 'xy', sets: [{id: 'xy12', symbol: symbol('xy/xy12')}]},
		{id: 'base', sets: [{id: 'base1', symbol: null}, {id: 'base2', symbol: symbol('base/base2')}]},
	]);

	test('setFacts keeps each set\'s series and symbol', () => {
		assert.deepEqual(facts.get('xy12'), {serie: 'xy', symbol: symbol('xy/xy12')});
		assert.deepEqual(facts.get('base1'), {serie: 'base', symbol: null});
		assert.equal(setFacts(null).size, 0);
	});

	test('an older Western set shows its symbol, as a cached .webp, with its code kept for a failed image', () => {
		assert.deepEqual(shopSetMark('international', 'xy12', facts), {code: 'EVO', symbol: 'https://assets.tcgdex.net/univ/xy/xy12/symbol.webp'});
		assert.deepEqual(shopSetMark('international', 'swsh9', facts), {code: 'BRS', symbol: 'https://assets.tcgdex.net/univ/swsh/swsh9/symbol.webp'});
		assert.deepEqual(shopSetMark('international', 'sm115', facts), {code: 'HIF', symbol: 'https://assets.tcgdex.net/univ/sm/sm115/symbol.webp'});
		assert.deepEqual(shopSetMark('international', 'base2', facts), {code: 'JU', symbol: 'https://assets.tcgdex.net/univ/base/base2/symbol.webp'});
	});

	test('a Scarlet & Violet or Mega Evolution set keeps its code, its symbol unused', () => {
		assert.deepEqual(shopSetMark('international', 'me04', facts), {code: 'CRI', symbol: null});
		assert.deepEqual(shopSetMark('international', 'sv03.5', facts), {code: 'MEW', symbol: null});
	});

	test('a gallery subset shows its main set\'s symbol', () => {
		assert.equal(shopSetMark('international', 'swsh9tg', facts).symbol, 'https://assets.tcgdex.net/univ/swsh/swsh9/symbol.webp');
		assert.equal(shopSetMark('international', 'swsh12.5gg', facts).symbol, 'https://assets.tcgdex.net/univ/swsh/swsh12.5/symbol.webp');
		assert.equal(shopSetMark('international', 'swsh4.5sv', facts).symbol, 'https://assets.tcgdex.net/univ/swsh/swsh4.5/symbol.webp');
		assert.equal(shopSetMark('international', 'swsh9tg', facts).code, 'BRS:TG');
	});

	test('no symbol known: the code, or nothing; never for an Asian set', () => {
		assert.deepEqual(shopSetMark('international', 'base1', facts), {code: 'BS', symbol: null}, 'Base Set prints no symbol');
		assert.deepEqual(shopSetMark('international', 'xy12'), {code: 'EVO', symbol: null}, 'no set list read');
		assert.deepEqual(shopSetMark('international', 'tsa1', facts), {code: null, symbol: null});
		assert.deepEqual(shopSetMark('ja', 'SV6', facts), {code: null, symbol: null});
		assert.deepEqual(shopSetMark('international', null, facts), {code: null, symbol: null});
	});
});
