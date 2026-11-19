// Unit tests for the typo forgiving search (js/search-match.js) and its use
// by My Cards (js/filter-bar.js applyFilters) and the offline card search
// (js/card-search.js searchSaved).
//
// Run: node --test tests/search-match.test.mjs

import assert from 'node:assert/strict';
import {before, describe, test} from 'node:test';

let sm;
let fb;
let cs;

before(async () => {
	globalThis.window = globalThis.window || {addEventListener() {}};
	sm = await import('../js/search-match.js');
	fb = await import('../js/filter-bar.js');
	cs = await import('../js/card-search.js');
});

describe('folding and splitting', () => {
	test('case and accents fold', () => {
		assert.equal(sm.fold('Pokémon'), 'pokemon');
		assert.equal(sm.fold('FLABÉBÉ'), 'flabebe');
	});

	test('words split on spaces', () => {
		assert.deepEqual(sm.splitTerms('  Eevee   133 '), ['eevee', '133']);
		assert.deepEqual(sm.splitTerms('Pikachu VMAX'), ['pikachu', 'vmax']);
	});

	test('kana and hangul stay as typed', () => {
		assert.deepEqual(sm.splitTerms('リザードン 피카츄'), ['リザードン', '피카츄']);
	});
});

describe('edits allowed', () => {
	test('by length, letters only', () => {
		assert.equal(sm.maxEdits('mew'), 0);
		assert.equal(sm.maxEdits('ekans'), 1);
		assert.equal(sm.maxEdits('charzard'), 2);
		assert.equal(sm.maxEdits('025'), 0);
		assert.equal(sm.maxEdits('tg05'), 0);
		assert.equal(sm.maxEdits('リザードン'), 0);
	});

	test('edit distance with swaps', () => {
		assert.equal(sm.withinEdits('charzard', 'charizard', 1), true);
		assert.equal(sm.withinEdits('pikahcu', 'pikachu', 1), true);
		assert.equal(sm.withinEdits('pikachu', 'raichu', 1), false);
	});

	test('a typo of a word start counts', () => {
		assert.equal(sm.fuzzyWord('charz', 'charizard'), true);
		assert.equal(sm.fuzzyWord('mew', 'mewtwo'), false);
	});
});

const item = (name, texts) => ({category: 'Pokemon', dexIds: [], name, search: fb.searchTextOf(texts)});
const ITEMS = () => [
	item('Charizard', ['Charizard', 'リザードン', '006', 'Base Set']),
	item('Charmander', ['Charmander', '004']),
	item('Pikachu VMAX', ['Pikachu VMAX', '044', 'Vivid Voltage']),
	item('Eevee', ['Eevee', '133', 'Pokémon GO']),
	item('Mew', ['Mew', '025/102']),
];
const names = (query) => fb.applyFilters(ITEMS(), {query}).map((one) => one.name);

describe('My Cards search', () => {
	test('exact first: a typo-free search shows no fuzzy extras', () => {
		assert.deepEqual(names('char'), ['Charizard', 'Charmander']);
		assert.deepEqual(names('charizard'), ['Charizard']);
	});

	test('a typo finds the card when nothing matches as typed', () => {
		assert.deepEqual(names('charzard'), ['Charizard']);
		assert.deepEqual(names('pikahcu vmax'), ['Pikachu VMAX']);
	});

	test('several words, accents, and numbers', () => {
		assert.deepEqual(names('pikachu vmax'), ['Pikachu VMAX']);
		assert.deepEqual(names('eevee 133'), ['Eevee']);
		assert.deepEqual(names('pokemon'), ['Eevee']);
		assert.deepEqual(names('25/102'), ['Mew']);
		assert.deepEqual(names('eevee 134'), []);
	});

	test('short words and CJK are never forgiven', () => {
		assert.deepEqual(names('mwe'), []);
		assert.deepEqual(names('リザードン'), ['Charizard']);
		assert.deepEqual(names('リザードソ'), []);
	});
});

describe('offline card search', () => {
	const saved = {cards: [], sets: [{lang: 'en', set: {cardCount: {official: 102}, cards: [
		{id: 'base1-4', localId: '4', name: 'Charizard'},
		{id: 'base1-58', localId: '58', name: 'Pikachu'},
	], id: 'base1', name: 'Base Set', serie: {id: 'base'}}}]};
	const found = (text) => cs.searchSaved(cs.parseCardQuery(text), saved).results.map((card) => card.name);

	test('exact, then a typo', () => {
		assert.deepEqual(found('chari'), ['Charizard']);
		assert.deepEqual(found('charzard'), ['Charizard']);
		assert.deepEqual(found('pikachuu 58'), ['Pikachu']);
	});

	test('numbers stay exact', () => {
		assert.deepEqual(found('charzard 5'), []);
	});
});
