// Unit tests for the pure parts of the filter and sort bar (js/filter-bar.js):
// the query parser, each filter, each sort, and the options offered. The
// bar itself is tested in the browser (tests/my-cards-browser.test.mjs).
//
// Run: node --test tests/filter-bar.test.mjs

import assert from 'node:assert/strict';
import {before, describe, test} from 'node:test';

let fb;

before(async () => {
	// js/dom.js listens for errors on window when it loads.
	globalThis.window = globalThis.window || {addEventListener() {}};
	fb = await import('../js/filter-bar.js');
});

const item = (fields) => ({
	category: 'Pokemon', dexIds: [], key: fields.name, language: 'en', newest: '', oldest: '', price: null, priced: true,
	rarity: 'Common', releaseDate: '', search: '', setKey: 'international|tsa1', types: [], unplaced: false, ...fields,
});

const ITEMS = () => [
	item({dexIds: [25], name: 'Pikachu', newest: '2026-09-05', number: '025', oldest: '2026-09-05', price: 40, releaseDate: '2025-01-01', search: fb.searchTextOf(['Pikachu', '025', 'tsb2-025']), setKey: 'international|tsb2', types: ['Lightning']}),
	item({dexIds: [6], name: 'Charizard', newest: '2026-09-09', number: '006', oldest: '2026-09-01', price: 900, rarity: 'Rare', releaseDate: '2026-03-01', search: fb.searchTextOf(['Charizard', 'リザードン', '006']), types: ['Fire']}),
	item({dexIds: [], name: 'Test Ball', category: 'Trainer', newest: '2026-09-07', number: '150', oldest: '2026-09-07', priced: false, releaseDate: '2026-03-01', search: fb.searchTextOf(['Test Ball', 'Bola de Teste', '150']), unplaced: true}),
	item({dexIds: [906, 1], language: 'ja', name: 'Tag Team', newest: '2026-09-08', number: '010', oldest: '2026-09-08', price: 5, releaseDate: '2025-06-01', search: fb.searchTextOf(['Tag Team', '010']), setKey: 'ja|TSJ1', types: ['Grass']}),
];

const names = (list) => list.map((one) => one.name);

describe('the query', () => {
	test('splits Pokédex numbers and ranges from words', () => {
		assert.deepEqual(fb.parseQuery('#25 pika #1-151 25/165 #TG10'), {dex: [{from: 25, to: 25}, {from: 1, to: 151}], words: ['pika', '25', 'tg10']});
		assert.deepEqual(fb.parseQuery('#151-1').dex, [{from: 1, to: 151}], 'a reversed range is turned round');
		assert.deepEqual(fb.parseQuery('#0').dex, [{from: 0, to: -1}], 'no Pokémon matches #0');
		assert.deepEqual(fb.parseQuery('  ').words, []);
	});

	test('finds names in any language, numbers, and Dex numbers', () => {
		const list = ITEMS();

		assert.deepEqual(names(fb.applyFilters(list, {query: 'bola'})), ['Test Ball']);
		assert.deepEqual(names(fb.applyFilters(list, {query: 'リザ'})), ['Charizard']);
		assert.deepEqual(names(fb.applyFilters(list, {query: '025'})), ['Pikachu'], 'a collector number');
		assert.deepEqual(names(fb.applyFilters(list, {query: '#25'})), ['Pikachu'], 'a Pokédex number');
		assert.deepEqual(names(fb.applyFilters(list, {query: '#025'})), ['Pikachu']);
		assert.deepEqual(names(fb.applyFilters(list, {query: '#1-151'})), ['Pikachu', 'Charizard', 'Tag Team'], 'any of a TAG TEAM\'s numbers');
		assert.deepEqual(names(fb.applyFilters(list, {query: '#1-1025'})).includes('Test Ball'), false, 'a Trainer never matches a Dex number');
		assert.deepEqual(names(fb.applyFilters(list, {query: 'pika #6'})), [], 'every part must match');
	});
});

describe('the filters', () => {
	const only = (filters) => names(fb.applyFilters(ITEMS(), {filters: {...fb.emptyFilters(), ...filters}}));

	test('each filter', () => {
		assert.deepEqual(only({region: 'kanto'}), ['Pikachu', 'Charizard', 'Tag Team']);
		assert.deepEqual(only({region: 'paldea'}), ['Tag Team']);
		assert.deepEqual(only({dex: '1-10'}), ['Charizard', 'Tag Team']);
		assert.deepEqual(only({dex: '25-25'}), ['Pikachu']);
		assert.deepEqual(only({dex: 'nonsense'}), []);
		assert.deepEqual(only({type: 'Fire'}), ['Charizard']);
		assert.deepEqual(only({category: 'Trainer'}), ['Test Ball']);
		assert.deepEqual(only({set: 'ja|TSJ1'}), ['Tag Team']);
		assert.deepEqual(only({language: 'ja'}), ['Tag Team']);
		assert.deepEqual(only({rarity: 'Rare'}), ['Charizard']);
		assert.deepEqual(only({price: 'unpriced'}), ['Test Ball']);
		assert.deepEqual(only({unplaced: true}), ['Test Ball']);
		assert.deepEqual(only({region: 'kanto', type: 'Grass'}), ['Tag Team'], 'filters combine');
	});

	test('the Pokédex range from two typed numbers', () => {
		assert.equal(fb.dexRangeValue('1', '151'), '1-151');
		assert.equal(fb.dexRangeValue('25', ''), '25-25');
		assert.equal(fb.dexRangeValue('', '9'), '9-9');
		assert.equal(fb.dexRangeValue('906', '800'), '800-906');
		assert.equal(fb.dexRangeValue('0', '2000'), '');
		assert.equal(fb.dexLabel({from: 1, to: 151}), 'Pokédex #1 to #151');
		assert.equal(fb.dexLabel({from: 25, to: 25}), 'Pokédex #25');
	});

	test('regions carry their generation', () => {
		assert.equal(fb.regionOf(899).label, 'Hisui (Gen 8)');
		assert.deepEqual(fb.regionsOf([906, 1, 4]), ['paldea', 'kanto']);
		assert.equal(fb.regionOf(2000), null);
	});

	test('the options offered, with counts, only for what the list holds', () => {
		const options = fb.filterOptions(ITEMS());

		assert.deepEqual(options.region.map((option) => [option.value, option.count]), [['kanto', 3], ['paldea', 1]]);
		assert.deepEqual(options.type.map((option) => option.value), ['Grass', 'Fire', 'Lightning'], 'in the energy order');
		assert.deepEqual(options.category.map((option) => option.label), ['Pokémon', 'Trainer']);
		assert.deepEqual(options.set.map((option) => option.value), ['international|tsa1', 'ja|TSJ1', 'international|tsb2'], 'newest set first');
		assert.equal(options.unplaced, 1);
		assert.deepEqual(fb.activeFilters({...fb.emptyFilters(), dex: '1-5', unplaced: true}), ['dex', 'unplaced']);
	});
});

describe('the sorts', () => {
	const sorted = (sort) => names(fb.sortItems(ITEMS(), sort));

	test('each sort', () => {
		assert.deepEqual(sorted('name'), ['Charizard', 'Pikachu', 'Tag Team', 'Test Ball']);
		assert.deepEqual(sorted('dex'), ['Tag Team', 'Charizard', 'Pikachu', 'Test Ball'], 'by the lowest number; none last');
		assert.deepEqual(sorted('set'), ['Charizard', 'Test Ball', 'Tag Team', 'Pikachu'], 'newest set, then number');
		assert.deepEqual(sorted('newest'), ['Charizard', 'Tag Team', 'Test Ball', 'Pikachu']);
		assert.deepEqual(sorted('oldest'), ['Charizard', 'Pikachu', 'Test Ball', 'Tag Team']);
		assert.deepEqual(sorted('price'), ['Charizard', 'Pikachu', 'Tag Team', 'Test Ball'], 'unknown last');
		assert.deepEqual(sorted('nonsense'), sorted('newest'));
	});
});
