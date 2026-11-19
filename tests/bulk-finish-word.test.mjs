// Review of v81 (2026-11-19): bulk Finish on a copy that holds a monprice
// word in finish_raw (an unmatched import, or a finish picked in the copy
// sheet as "Reverse holo (not listed)") must clear that word when it sets a
// catalog printing, as js/copy-sheet.js finishFields does for one copy.
// Otherwise the tile keeps the old word's corner (js/tile.js entryFinish
// reads finish_raw before anything else when no variants are passed, which
// is how every tile is drawn) and Undo cannot be exact about a field it
// never touched.
//
// Run: node --test tests/bulk-finish-word.test.mjs

import assert from 'node:assert/strict';
import {test} from 'node:test';

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.document = {addEventListener() {}, createElement: () => ({}), documentElement: {dataset: {}}};
globalThis.localStorage = {getItem: () => null, setItem() {}};

const {finishPlan, tileKey} = await import('../js/bulk-edit.js');
const {groupFinish} = await import('../js/tile.js');

test('bulk Finish to a catalog printing clears a word left in finish_raw', () => {
	const copy = {card_id: 'sv01-001', catalog: 'international', deleted_at: null, finish_raw: 'REVERSE_HOLOFOIL', id: 'a', language: 'en', variant_id: null};
	const tile = {catalog: 'international', entries: [copy], key: tileKey(copy)};
	const choices = [{label: 'Normal', value: 'v-normal'}, {label: 'Reverse holo', value: 'v-rev'}];
	const plan = finishPlan([tile], 'Normal', () => choices);

	assert.deepEqual(plan.patches, [{id: 'a', patch: {finish_raw: null, variant_id: 'v-normal'}}]);
	assert.equal(groupFinish([{...copy, ...plan.patches[0].patch}]), null, 'a Normal copy shows no REV corner');
});

// Review of v81 (2026-11-19): a matched 1st Edition import set to the listed
// Holo keeps "1st" in its import key; with the card's printings at hand
// (js/cards-view.js variantsOf), the tile names the printing it holds now.
test('a tile with the card\'s printings names the copy by its printing, not its import word', () => {
	const copy = {card_id: 'base1-4', catalog: 'international', deleted_at: null, finish_raw: null, id: 'b', import_key: 'monprice|base1-4|FIRST_EDITION|0', language: 'en', variant_id: 'v-holo'};
	const variants = [{type: 'holo', variantId: 'v-holo'}, {stamp: ['1st-edition'], type: 'holo', variantId: 'v-first'}];

	assert.equal(groupFinish([copy]), 'first', 'without the printings, the import word decides, as before');
	assert.equal(groupFinish([copy], variants), null, 'with them, the Holo printing shows no 1st corner');
	assert.equal(groupFinish([{...copy, variant_id: 'v-first'}], variants), 'first');
});
