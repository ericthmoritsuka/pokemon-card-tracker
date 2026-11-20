// Which copies a lower count removes (js/copy-sheet.js removalPlan): the
// copies in no binder pocket go first, newest first, and the person is asked
// only among the rest. Also the finish select (finishOptions, finishValue,
// finishFields): Normal, Holo, and Reverse holo offered beside the catalog's
// printings when it lists no plain print of that kind (Eric, 2026-11-18). Photos belong to the card's record in a language
// (js/card-info.js), so they survive any copy's removal and never decide
// which copy goes; only a copy still holding an older phone's photo that has
// not moved to the card yet is kept. No browser: tests/copies-browser.test.mjs
// and tests/main-image-browser.test.mjs play the sheet in the app.
//
// Run: node --test tests/copy-sheet.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.document = {addEventListener() {}, createElement: () => ({}), documentElement: {dataset: {}}};
globalThis.localStorage = {getItem: () => null, setItem() {}};

try {
	globalThis.navigator = {onLine: false};
}
catch {
	// Node 21 and later have a navigator of their own.
}

const {LOOSE, alikeKey, changes, finishFields, finishOptions, finishValue, photoCount, plainKind, rawFinishes, removalPlan, thisCopyChoices} = await import('../js/copy-sheet.js');
const {entryFinish} = await import('../js/tile.js');

const AT = '2026-10-01T00:00:00.000Z';
const copy = (id, language, created_at, fields = {}) => ({card_id: 'sv1-1', catalog: 'international', created_at, deleted_at: null, id, language, ...fields});
const ids = (plan) => ({ask: plan.ask && {count: plan.ask.count, from: plan.ask.from.map((entry) => entry.id)}, chosen: plan.chosen.map((entry) => entry.id)});

describe('removalPlan', () => {
	// Two English copies and a French one; the card's English record has
	// photos, which removalPlan does not read.
	const copies = [
		copy('en-old', 'en', '2026-01-01'),
		copy('fr', 'fr', '2026-02-01'),
		copy('en-new', 'en', '2026-03-01'),
	];

	test('the newest copy in no pocket goes, whatever photos its card\'s record has', () => {
		assert.deepEqual(ids(removalPlan(copies, 1)), {ask: null, chosen: ['en-new']});
		assert.deepEqual(ids(removalPlan(copies, 2)), {ask: null, chosen: ['en-new', 'fr']});

		// v54 first let a count of the record's photos keep the English
		// copies, so the French one went and a second minus asked. removalPlan
		// reads no such count: a stray one changes nothing.
		const photos = (entry) => (entry.language === 'en' ? 2 : 0);

		assert.deepEqual(ids(removalPlan(copies, 1, {photos})), {ask: null, chosen: ['en-new']});
		assert.deepEqual(ids(removalPlan(copies, 2, {photos})), {ask: null, chosen: ['en-new', 'fr']});
	});

	test('a copy in a pocket, or still holding a photo waiting to move to the card, goes last', () => {
		const waiting = copy('en-new', 'en', '2026-03-01', {photos: [{created_at: AT, deleted_at: null, id: 'old-phone', side: 'front'}]});
		const pool = [copies[0], copies[1], waiting];
		const places = new Map([['fr', {binder_id: 'b', binder_name: 'Vitrine', page: 1, position: 1}]]);

		assert.deepEqual(ids(removalPlan(pool, 1, {places})), {ask: null, chosen: ['en-old']});
		assert.deepEqual(ids(removalPlan(pool, 2, {places})), {ask: {count: 1, from: ['en-new', 'fr']}, chosen: ['en-old']});
	});

	test('the copy kept for the pocket a sheet is for never goes', () => {
		assert.deepEqual(ids(removalPlan(copies, 1, {keep: 'en-new'})), {ask: null, chosen: ['fr']});
	});
});

describe('thisCopyChoices', () => {
	const kanto = {binder_id: 'b', binder_name: 'Kanto 151', page: 9, position: 3};
	const vitrine = {binder_id: 'v', binder_name: 'Vitrine', page: 1, position: 2};
	const loose = copy('loose', 'en', '2026-03-01');
	const pocket = copy('pocket', 'en', '2026-01-01');

	test('a row naming a pocket means the copy in it first, and the copy in none can still be picked (QA, 2026-11-20)', () => {
		const choices = thisCopyChoices([loose, pocket], new Map([['pocket', kanto]]));

		assert.deepEqual(choices.map((choice) => [choice.value, choice.label, choice.entries.map((entry) => entry.id)]), [
			['pocket', 'Kanto 151, page 9, pocket 3', ['pocket']],
			[LOOSE, 'Not in a binder', ['loose']],
		]);

		// The minus still takes the copy in no pocket: only the sheet means
		// the pocket the row names.
		assert.deepEqual(ids(removalPlan([loose, pocket], 1, {places: new Map([['pocket', kanto]])})), {ask: null, chosen: ['loose']});
	});

	test('two pockets in the row\'s order, the copies in none as one choice; none in a pocket, nothing to choose', () => {
		const other = copy('other', 'en', '2026-02-01');
		const places = new Map([['other', vitrine], ['pocket', kanto]]);

		assert.deepEqual(thisCopyChoices([other, loose, pocket, copy('loose2', 'en', '2026-04-01')], places).map((choice) => [choice.value, choice.label, choice.entries.length]), [
			['other', 'Vitrine, page 1, pocket 2', 1],
			['pocket', 'Kanto 151, page 9, pocket 3', 1],
			[LOOSE, 'One of 2 not in a binder', 2],
		]);
		assert.deepEqual(thisCopyChoices([other, pocket], places).map((choice) => choice.value), ['other', 'pocket']);
		assert.equal(thisCopyChoices([loose, copy('loose2', 'en', '2026-04-01')], new Map()), null);
	});
});

describe('photoCount', () => {
	test('the card record\'s photos, with any still on the copy, each once', () => {
		const record = {deleted_at: null, photos: [{id: 'p1'}, {deleted_at: AT, id: 'gone'}, {id: 'p2'}]};

		assert.equal(photoCount(copy('a', 'en', AT), record), 2);
		assert.equal(photoCount(copy('a', 'en', AT, {photos: [{id: 'p1'}, {id: 'p3'}]}), record), 3);
		assert.equal(photoCount(copy('a', 'en', AT), {deleted_at: AT, photos: [{id: 'p1'}]}), 0);
		assert.equal(photoCount(copy('a', 'en', AT), null), 0);
	});
});

describe('the finish select', () => {
	// As js/catalog-views.js finishChoices gives them.
	const choice = (variant, label) => ({label, value: variant.variantId, variant});
	const FIRST = {stamp: ['1st-edition'], type: 'Holo', variantId: 'v-first'};
	const NORMAL = {size: 'Padrão', type: 'Normal', variantId: 'v-normal'};
	const REVERSE = {type: 'Reverse', variantId: 'v-reverse'};
	const BALL = {foil: 'pokeball', type: 'Reverse', variantId: 'v-ball'};
	const SHADOWLESS = {subtype: 'shadowless', type: 'Holo', variantId: 'v-shadowless'};
	const UNLIMITED = {subtype: 'unlimited', type: 'Holo', variantId: 'v-unlimited'};
	const JUMBO = {size: 'Jumbo', type: 'Holo', variantId: 'v-jumbo'};
	const values = (options) => options.map((option) => option.value);
	const labels = (options) => options.map((option) => option.label);

	test('a plain print is its type with no stamp, special foil, other size, or Shadowless', () => {
		assert.equal(plainKind(NORMAL), 'normal', 'Padrão is the standard size');
		assert.equal(plainKind(REVERSE), 'reverse');
		assert.equal(plainKind(UNLIMITED), 'holo');
		assert.equal(plainKind(FIRST), null);
		assert.equal(plainKind(BALL), null);
		assert.equal(plainKind(SHADOWLESS), null);
		assert.equal(plainKind(JUMBO), null);
		assert.equal(plainKind({stamp: ['set-logo'], type: 'Normal', variantId: 'v-logo'}), null);
		assert.equal(plainKind(null), null);
	});

	test('a card listed only as 1st Edition also offers Normal, Holo, and Reverse holo, marked not listed', () => {
		const options = finishOptions([choice(FIRST, 'Holo, 1st Edition stamp')], 'v-first');

		assert.deepEqual(labels(options), ['Not set', 'Holo, 1st Edition stamp', 'Normal (not listed)', 'Holo (not listed)', 'Reverse holo (not listed)']);
		assert.deepEqual(values(options), ['', 'v-first', 'raw:NORMAL', 'raw:HOLOFOIL', 'raw:REVERSE_HOLOFOIL']);
	});

	test('a finish the catalog lists as a plain print is not offered twice', () => {
		const options = finishOptions([choice(NORMAL, 'Normal'), choice(REVERSE, 'Reverse holo'), choice(BALL, 'Reverse holo, Poké Ball pattern')]);

		assert.deepEqual(labels(options), ['Not set', 'Normal', 'Reverse holo', 'Reverse holo, Poké Ball pattern', 'Holo (not listed)']);
		assert.deepEqual(labels(finishOptions([choice(SHADOWLESS, 'Holo, Shadowless'), choice(UNLIMITED, 'Holo, Unlimited')])).slice(3), ['Normal (not listed)', 'Reverse holo (not listed)']);
	});

	test('the current finish is kept when it is not offered', () => {
		const list = [choice(UNLIMITED, 'Holo, Unlimited')];

		assert.deepEqual(finishOptions(list, 'raw:FIRST_EDITION').at(-1), {label: '1st Edition (not listed)', value: 'raw:FIRST_EDITION'});
		assert.deepEqual(finishOptions(list, 'raw:HOLOFOIL').at(-1), {label: 'Holo (not listed)', value: 'raw:HOLOFOIL'}, 'an import from before TCGdex listed a plain holo');
		assert.deepEqual(finishOptions(list, 'gone').at(-1), {label: 'Current finish (not in the catalog list)', value: 'gone'});
		assert.equal(finishOptions(list, 'raw:NORMAL').filter((option) => option.value === 'raw:NORMAL').length, 1);
	});

	test('with the catalog offline and no saved printings, the words say the catalog is offline', () => {
		const options = finishOptions([], 'v-normal', 'international', true);

		assert.deepEqual(labels(options), ['Not set', 'Normal (catalog offline)', 'Holo (catalog offline)', 'Reverse holo (catalog offline)', 'Current finish (catalog offline)']);
		assert.deepEqual(values(options), ['', 'raw:NORMAL', 'raw:HOLOFOIL', 'raw:REVERSE_HOLOFOIL', 'v-normal']);
		assert.deepEqual(finishOptions([], 'raw:FIRST_EDITION', 'international', true).at(-1), {label: '1st Edition (catalog offline)', value: 'raw:FIRST_EDITION'});
	});

	test('an empty list alone is not offline: a Japanese card with no variants still says not listed', () => {
		assert.deepEqual(labels(finishOptions([], null, 'japanese')), ['Not set', 'Normal (not listed)', 'Holo (not listed)', 'Reverse holo (not listed)']);
	});

	test('offline with the printings the phone saved, not listed still holds', () => {
		const options = finishOptions([choice(FIRST, 'Holo, 1st Edition stamp')], 'gone', 'international', true);

		assert.deepEqual(labels(options), ['Not set', 'Holo, 1st Edition stamp', 'Normal (not listed)', 'Holo (not listed)', 'Reverse holo (not listed)', 'Current finish (catalog offline)'], 'the copy\'s printing, as its row says');
	});

	test('a hand-made card offers monprice\'s words alone, as before', () => {
		assert.deepEqual(labels(finishOptions(rawFinishes(), 'HOLOFOIL', 'custom')), ['Not set', '1st Edition', 'Holo', 'Normal', 'Reverse holo', 'Unlimited', 'Unlimited holo']);
	});

	test('a copy reads into the select by its variant, else its word', () => {
		assert.equal(finishValue({finish_raw: null, variant_id: 'v-first'}, 'international'), 'v-first');
		assert.equal(finishValue({finish_raw: 'HOLOFOIL', variant_id: null}, 'international'), 'raw:HOLOFOIL');
		assert.equal(finishValue({finish_raw: 'NORMAL', variant_id: 'v-normal'}, 'international'), 'v-normal', 'the variant wins');
		assert.equal(finishValue({}, 'international'), '');
		assert.equal(finishValue({finish_raw: 'HOLOFOIL'}, 'custom'), 'HOLOFOIL');
	});

	test('a finish not listed is stored as an unmatched import stores it; a printing clears the word', () => {
		assert.deepEqual(finishFields('raw:HOLOFOIL', 'international'), {finish_raw: 'HOLOFOIL', variant_id: null});
		assert.deepEqual(finishFields('v-first', 'international'), {finish_raw: null, variant_id: 'v-first'});
		assert.deepEqual(finishFields('', 'international'), {finish_raw: null, variant_id: null});
		assert.deepEqual(finishFields('HOLOFOIL', 'custom'), {finish_raw: 'HOLOFOIL'});
	});

	test('the patch changes only what differs, and the copy moves to its own row', () => {
		const first = {card_id: 'base1-4', catalog: 'international', fallback: false, id: 'a', language: 'en', variant_id: 'v-first'};
		const holo = changes(first, 'international', {language: 'en', ...finishFields('raw:HOLOFOIL', 'international')});

		assert.deepEqual(holo, {finish_raw: 'HOLOFOIL', variant_id: null});
		assert.notEqual(alikeKey({...first, ...holo}), alikeKey(first), 'two rows');

		const unmatched = {...first, finish_raw: 'HOLOFOIL', variant_id: null};

		assert.deepEqual(changes(unmatched, 'international', {language: 'en', ...finishFields('v-first', 'international')}), {finish_raw: null, variant_id: 'v-first'});
		assert.deepEqual(changes(unmatched, 'international', {language: 'en', ...finishFields('raw:HOLOFOIL', 'international')}), {});
	});

	test('a word picked in the sheet names the copy\'s corner over the word its import key keeps', () => {
		const imported = {import_key: 'monprice|BS_int_4|en|FIRST_EDITION|0', variant_id: null};

		assert.equal(entryFinish({...imported, finish_raw: 'FIRST_EDITION'}), 'first');
		assert.equal(entryFinish({...imported, finish_raw: 'HOLOFOIL'}), null, 'no 1st corner');
		assert.equal(entryFinish({...imported, finish_raw: 'REVERSE_HOLOFOIL'}), 'reverse');
		assert.equal(entryFinish(imported), 'first', 'with no word of its own, the key\'s');
	});
});
