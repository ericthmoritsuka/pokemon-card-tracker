// The finish corner of a card tile (js/tile.js): which finishes get one,
// and which one when a card could have several. Eric, 2026-11-24: holo cards
// show a HOLO corner as reverse holos show REV, so that a card bought as
// holo that turns out not to be one is noticed. The plain print still gets
// none. The TCGdex records below are the real variants_detailed entries
// checked on 2026-11-24 (type "holo" in lower case, ball patterns in foil).
//
// Run: node --test tests/tile-finish.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.document = {addEventListener() {}, createElement: () => ({}), documentElement: {dataset: {}}};
globalThis.localStorage = {getItem: () => null, setItem() {}};

const {FINISHES, entryFinish, groupFinish, printFinish, variantFinish} = await import('../js/tile.js');

// swsh3-19 Charizard V: holo is its only printing.
const HOLO_ONLY = {variants_detailed: [{size: 'standard', type: 'holo', variantId: 'v-holo'}]};
// dp3-1: normal, holo, and reverse.
const ALL_THREE = {variants_detailed: [
	{size: 'standard', type: 'holo', variantId: 'v-holo'},
	{size: 'standard', type: 'normal', variantId: 'v-normal'},
	{size: 'standard', type: 'reverse', variantId: 'v-rev'},
]};
// swsh3-25 Heatran: holo and reverse.
const HOLO_AND_REVERSE = {variants_detailed: [
	{size: 'standard', type: 'holo', variantId: 'v-holo'},
	{size: 'standard', type: 'reverse', variantId: 'v-rev'},
]};
const copy = (fields) => ({card_id: 'x-1', catalog: 'international', language: 'en', ...fields});

describe('the holo finish', () => {
	test('has a label and the text HOLO', () => {
		assert.deepEqual(FINISHES.holo, {label: 'Holo', text: 'HOLO'});
	});

	test('a holo printing is holo, and a normal one has no corner', () => {
		assert.equal(variantFinish({size: 'standard', type: 'holo'}), 'holo');
		assert.equal(variantFinish({size: 'standard', type: 'HOLO'}), 'holo');
		assert.equal(variantFinish({foil: 'rainbow', type: 'holo'}), 'holo', 'a special foil that is not a ball pattern');
		assert.equal(variantFinish({size: 'standard', type: 'normal'}), null);
		assert.equal(variantFinish({size: 'standard', type: 'normal', stamp: ['set-logo']}), null);
		assert.equal(variantFinish(null), null);
	});

	test('one corner names one finish: ball pattern, then 1st Edition, then reverse, then holo', () => {
		assert.equal(variantFinish({foil: 'pokeball', type: 'reverse'}), 'pokeball');
		assert.equal(variantFinish({foil: 'masterball', type: 'holo'}), 'masterball');
		assert.equal(variantFinish({stamp: ['1st-edition'], type: 'holo'}), 'first');
		assert.equal(variantFinish({type: 'reverse'}), 'reverse');
		assert.equal(variantFinish({type: 'holo'}), 'holo');
	});

	test('a copy reads it through its printing, then its word, then its import key', () => {
		assert.equal(entryFinish(copy({variant_id: 'v-holo'}), ALL_THREE.variants_detailed), 'holo');
		assert.equal(entryFinish(copy({variant_id: 'v-normal'}), ALL_THREE.variants_detailed), null);
		assert.equal(entryFinish(copy({variant_id: 'v-rev'}), ALL_THREE.variants_detailed), 'reverse');
		assert.equal(entryFinish(copy({finish_raw: 'HOLOFOIL'})), 'holo');
		assert.equal(entryFinish(copy({finish_raw: 'UNLIMITED_HOLOFOIL'})), 'holo', 'resolveFinish reads both holo words as the holo printing');
		assert.equal(entryFinish(copy({finish_raw: 'NORMAL'})), null);
		assert.equal(entryFinish(copy({finish_raw: 'UNLIMITED'})), null);
		assert.equal(entryFinish(copy({import_key: 'monprice|42|en|HOLOFOIL|0'})), 'holo');
		assert.equal(entryFinish(copy({import_key: 'monprice|42|en|NORMAL|0'})), null);
	});

	test('a word picked in the sheet stands over the import key, so a Normal pick loses the HOLO corner', () => {
		assert.equal(entryFinish(copy({finish_raw: 'NORMAL', import_key: 'monprice|42|en|HOLOFOIL|0'})), null);
		assert.equal(entryFinish(copy({finish_raw: 'HOLOFOIL', import_key: 'monprice|42|en|REVERSE_HOLOFOIL|0'})), 'holo');
	});

	test('a tile of several copies shows a finish only when every copy shares it', () => {
		const holo = copy({finish_raw: 'HOLOFOIL'});
		const reverse = copy({finish_raw: 'REVERSE_HOLOFOIL'});
		const normal = copy({finish_raw: 'NORMAL'});

		assert.equal(groupFinish([holo, copy({finish_raw: 'HOLOFOIL'})]), 'holo');
		assert.equal(groupFinish([holo, reverse]), null, 'holo and reverse');
		assert.equal(groupFinish([holo, normal]), null, 'holo and plain');
		assert.equal(groupFinish([normal, copy({finish_raw: 'NORMAL'})]), null, 'plain stays without a corner');
		assert.equal(groupFinish([reverse, copy({finish_raw: 'REVERSE_HOLOFOIL'})]), 'reverse');
	});
});

describe('the finish of a card nobody owns', () => {
	test('is HOLO when holo is the card\'s only printing', () => {
		assert.equal(printFinish(HOLO_ONLY), 'holo');
	});

	test('is none when the card also has a normal or a reverse printing', () => {
		assert.equal(printFinish(ALL_THREE), null);
		assert.equal(printFinish(HOLO_AND_REVERSE), null);
		assert.equal(printFinish({variants_detailed: [{type: 'normal'}, {type: 'holo'}]}), null);
		assert.equal(printFinish({variants_detailed: [{type: 'holo'}, {foil: 'pokeball', type: 'reverse'}]}), null);
	});

	test('is none for a card with only a normal printing, no printings, or no record', () => {
		assert.equal(printFinish({variants_detailed: [{type: 'normal'}]}), null);
		assert.equal(printFinish({variants_detailed: []}), null);
		assert.equal(printFinish({variants_detailed: null}), null);
		assert.equal(printFinish({}), null);
		assert.equal(printFinish(null), null);
		assert.equal(printFinish(undefined), null);
	});

	test('does not count a stamped or a jumbo printing as another print of the card', () => {
		// base1-4 Charizard: unlimited, shadowless, and 1999-2000 holos, and a 1st Edition one.
		assert.equal(printFinish({variants_detailed: [
			{size: 'standard', subtype: 'unlimited', type: 'holo'},
			{size: 'standard', stamp: ['1st-edition'], subtype: 'shadowless', type: 'holo'},
			{size: 'standard', subtype: 'shadowless', type: 'holo'},
		]}), 'holo');
		// A holo with a normal prerelease stamp or a jumbo normal one.
		assert.equal(printFinish({variants_detailed: [{type: 'holo'}, {stamp: ['staff'], type: 'normal'}]}), 'holo');
		assert.equal(printFinish({variants_detailed: [{type: 'holo'}, {size: 'jumbo', type: 'normal'}]}), 'holo');
		assert.equal(printFinish({variants_detailed: [{size: 'Padrão', type: 'holo'}]}), 'holo', 'a Portuguese record');
	});

	test('is none when every printing is stamped, because the stamp makes them other products', () => {
		assert.equal(printFinish({variants_detailed: [{stamp: ['1st-edition'], type: 'holo'}]}), null);
	});
});
