// Which copies a lower count removes (js/copy-sheet.js removalPlan): the
// copies in no binder pocket go first, newest first, and the person is asked
// only among the rest. Photos belong to the card's record in a language
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

const {photoCount, removalPlan} = await import('../js/copy-sheet.js');

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

describe('photoCount', () => {
	test('the card record\'s photos, with any still on the copy, each once', () => {
		const record = {deleted_at: null, photos: [{id: 'p1'}, {deleted_at: AT, id: 'gone'}, {id: 'p2'}]};

		assert.equal(photoCount(copy('a', 'en', AT), record), 2);
		assert.equal(photoCount(copy('a', 'en', AT, {photos: [{id: 'p1'}, {id: 'p3'}]}), record), 3);
		assert.equal(photoCount(copy('a', 'en', AT), {deleted_at: AT, photos: [{id: 'p1'}]}), 0);
		assert.equal(photoCount(copy('a', 'en', AT), null), 0);
	});
});
