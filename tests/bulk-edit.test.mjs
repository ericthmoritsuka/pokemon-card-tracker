// What My Cards' bulk actions change (js/bulk-edit.js): patches that touch
// only the fields that differ, Undo's patches back to what each copy had,
// the languages and finishes offered and the cards left as they were, and
// which copies Add to binder takes. No browser:
// tests/bulk-select-browser.test.mjs plays the bar and the sheets.
//
// Run: node --test tests/bulk-edit.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {
	binderCopies,
	fieldPatches,
	finishField,
	finishLabels,
	finishPlan,
	languageChoices,
	languagePlan,
	tileKey,
	undoPatches,
} from '../js/bulk-edit.js';

const copy = (id, fields = {}) => ({card_id: 'tsa1-001', catalog: 'international', deleted_at: null, id, language: 'en', ...fields});
const tile = (entries) => ({catalog: entries[0].catalog, entries, key: tileKey(entries[0])});

describe('fieldPatches and undoPatches', () => {
	test('a patch holds only the fields that change, and copies already right get none', () => {
		const entries = [copy('a', {condition: 'Near Mint'}), copy('b'), copy('c', {condition: 'Damaged', storage: 'Box A'})];

		assert.deepEqual(fieldPatches(entries, {condition: 'Near Mint'}), [
			{id: 'b', patch: {condition: 'Near Mint'}},
			{id: 'c', patch: {condition: 'Near Mint'}},
		]);
		assert.deepEqual(fieldPatches(entries, {condition: null}), [
			{id: 'a', patch: {condition: null}},
			{id: 'c', patch: {condition: null}},
		], 'clearing touches only the copies that had one');
	});

	test('a missing favorite and false are both not a favorite', () => {
		const entries = [copy('a', {is_favorite: true}), copy('b'), copy('c', {is_favorite: false})];

		assert.deepEqual(fieldPatches(entries, {is_favorite: false}), [{id: 'a', patch: {is_favorite: false}}]);
		assert.deepEqual(fieldPatches(entries, {is_favorite: true}).map((item) => item.id), ['b', 'c']);
	});

	test('Undo puts back what each copy had, a field it lacked as null', () => {
		const entries = [copy('a', {condition: 'Damaged', variant_id: 'v-normal'}), copy('b', {fallback: true, language: 'ko', language_source: 'scan'})];
		const patches = [
			{id: 'a', patch: {condition: 'Near Mint', is_favorite: true}},
			{id: 'b', patch: {fallback: false, language: 'en', language_source: 'manual'}},
			{id: 'gone', patch: {condition: 'Near Mint'}},
		];

		assert.deepEqual(undoPatches(entries, patches), [
			{id: 'a', patch: {condition: 'Damaged', is_favorite: null}},
			{id: 'b', patch: {fallback: true, language: 'ko', language_source: 'scan'}},
		]);
	});
});

describe('languages', () => {
	const western = tile([copy('a'), copy('b')]);
	const japanese = tile([copy('j', {card_id: 'TSJ1-025', catalog: 'ja', language: 'ja'})]);

	test('every language some card can be in, counted by the cards that can', () => {
		const choices = languageChoices([western, japanese]);
		const fits = Object.fromEntries(choices.map((choice) => [choice.code, choice.fits]));

		assert.equal(fits.en, 1);
		assert.equal(fits.pt, 1);
		assert.equal(fits.ja, 1);
		assert.equal(fits.ko, 1, 'a Japanese record holds Korean copies');
		assert.ok(choices.every((choice) => choice.fits <= 2));
	});

	test('a card that cannot be in the language is left as it was, and the selection follows the rest', () => {
		const plan = languagePlan([western, japanese], 'pt');

		assert.deepEqual(plan.patches, [
			{id: 'a', patch: {language: 'pt', language_source: 'manual'}},
			{id: 'b', patch: {language: 'pt', language_source: 'manual'}},
		]);
		assert.equal(plan.skipped, 1);
		assert.deepEqual([...plan.keys], [['international|tsa1-001|en', 'international|tsa1-001|pt']]);
	});

	test('Korean on a Japanese record is a fallback match, and going back clears it', () => {
		assert.deepEqual(languagePlan([japanese], 'ko').patches, [{id: 'j', patch: {fallback: true, language: 'ko', language_source: 'manual'}}]);

		const korean = tile([copy('k', {card_id: 'TSJ1-025', catalog: 'ja', fallback: true, language: 'ko'})]);

		assert.deepEqual(languagePlan([korean], 'ja').patches, [{id: 'k', patch: {fallback: false, language: 'ja', language_source: 'manual'}}]);
	});

	test('copies already in the language get no patch', () => {
		assert.deepEqual(languagePlan([western], 'en'), {keys: new Map(), patches: [], skipped: 0});
	});
});

describe('finishes', () => {
	const reverse = {label: 'Reverse holo', value: 'v-rev'};
	const one = tile([copy('a', {variant_id: 'v-1'}), copy('b')]);
	const two = tile([copy('c', {card_id: 'tsa1-004'})]);
	const three = tile([copy('d', {card_id: 'tsa1-006'})]);
	const hand = tile([copy('h', {card_id: 'hand_1', catalog: 'custom'})]);
	const choices = new Map([
		[one.key, [{label: 'Normal', value: 'v-1'}, reverse]],
		[two.key, [{label: 'Normal', value: 'v-2'}]],
		[hand.key, [{label: 'Reverse holo', value: 'REVERSE_HOLOFOIL'}]],
	]);
	const choicesOf = (item) => choices.get(item.key) || null;

	test('each finish named once, counted by the cards that come in it', () => {
		assert.deepEqual(finishLabels([one, two, three], choicesOf), [{fits: 2, label: 'Normal'}, {fits: 1, label: 'Reverse holo'}]);
	});

	test('set only on the cards that come in it; the rest are counted as missing or unknown', () => {
		const plan = finishPlan([one, two, three, hand], 'Reverse holo', choicesOf);

		assert.deepEqual(plan.patches, [
			{id: 'a', patch: {variant_id: 'v-rev'}},
			{id: 'b', patch: {variant_id: 'v-rev'}},
			{id: 'h', patch: {finish_raw: 'REVERSE_HOLOFOIL'}},
		]);
		assert.equal(plan.missing, 1);
		assert.equal(plan.unknown, 1);
	});

	test('a copy already in the finish gets no patch', () => {
		assert.deepEqual(finishPlan([one], 'Normal', choicesOf).patches, [{id: 'b', patch: {variant_id: 'v-1'}}]);
	});

	test('a hand-made card keeps its finish in finish_raw', () => {
		assert.equal(finishField('custom'), 'finish_raw');
		assert.equal(finishField('international'), 'variant_id');
	});
});

describe('binderCopies', () => {
	test('takes the copies in no pocket and no tray, and counts the rest', () => {
		const tiles = [tile([copy('a'), copy('b')]), tile([copy('c', {card_id: 'tsa1-004'})])];

		assert.deepEqual(binderCopies(tiles, new Set(['a']), new Set(['c'])), {ids: ['b'], kept: 2});
	});
});
