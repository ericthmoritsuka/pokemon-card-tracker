// Shared family photos (js/photos/model.js, "Shared family photos"): the
// photo_index list each document keeps, which family photo a card with no
// image shows, and that an older app keeps the list. Pure functions, no
// browser. tests/family-photos-browser.test.mjs plays it in the app.
//
// Run: node --test tests/family-photos.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {mergeDocuments, syncDelta, stamps} from '../js/merge.js';
import {PHOTO_INDEX, familyPhotos, gallerySlides, mainImage, photoIndexKey, refreshPhotoIndex} from '../js/photos/model.js';

import * as v21 from './merge-v21.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const AT = '2026-10-01T00:00:00.000Z';

const photo = (id, owner, entryId, fields = {}) => ({created_at: AT, deleted_at: null, id, path: `${owner}/${entryId}/${id}.webp`, side: 'front', ...fields});

const entry = (id, fields = {}) => ({card_id: 'tst1-001', catalog: 'international', created_at: AT, deleted_at: null, id, language: 'en', updated_at: AT, ...fields});

describe('photo_index', () => {
	test('one entry per card and language, uploaded fronts only, oldest first', () => {
		const doc = {cards: [
			entry('c1', {photos: [
				photo('p2', A, 'c1', {created_at: '2026-10-02T00:00:00.000Z'}),
				photo('p1', A, 'c1'),
				photo('back', A, 'c1', {side: 'back'}),
				photo('gone', A, 'c1', {deleted_at: AT}),
				{...photo('waiting', A, 'c1'), path: null},
			]}),
			entry('c2', {language: 'pt', photos: [photo('p3', A, 'c2')]}),
			entry('c3', {card_id: 'tst1-002'}),
		]};

		assert.equal(refreshPhotoIndex(doc, Date.parse(AT)), true);

		const byId = new Map(doc[PHOTO_INDEX].map((item) => [item.id, item]));

		assert.equal(byId.size, 2);
		assert.deepEqual(byId.get('international~tst1-001~en').photos, [{id: 'p1', path: `${A}/c1/p1.webp`}, {id: 'p2', path: `${A}/c1/p2.webp`}]);
		assert.equal(byId.get('international~tst1-001~pt').language, 'pt');
		assert.equal(photoIndexKey({card_id: 'x', language: 'ja'}), 'international~x~ja');

		// Nothing changed: no new stamps.
		const before = JSON.stringify(doc[PHOTO_INDEX]);

		assert.equal(refreshPhotoIndex(doc), false);
		assert.equal(JSON.stringify(doc[PHOTO_INDEX]), before);
	});

	test('the last photo going leaves a tombstone; a document with no photos gets no list', () => {
		const empty = {cards: [entry('c1')]};

		assert.equal(refreshPhotoIndex(empty), false);
		assert.equal(PHOTO_INDEX in empty, false);

		const doc = {cards: [entry('c1', {photos: [photo('p1', A, 'c1')]})]};

		refreshPhotoIndex(doc, Date.parse(AT));
		doc.cards[0].photos[0].deleted_at = AT;
		assert.equal(refreshPhotoIndex(doc, Date.parse(AT) + 5000), true);
		assert.equal(doc[PHOTO_INDEX].length, 1);
		assert.ok(doc[PHOTO_INDEX][0].deleted_at);
		assert.deepEqual(doc[PHOTO_INDEX][0].photos, []);
	});

	test('merges entry by entry, travels in the sync delta, and an older app keeps it', () => {
		const mine = {cards: [entry('c1', {photos: [photo('p1', A, 'c1')]})], version: 1};

		refreshPhotoIndex(mine, Date.parse(AT));

		const server = {cards: [entry('c1')], version: 1};
		const merged = mergeDocuments(server, mine);

		assert.deepEqual(merged[PHOTO_INDEX], mine[PHOTO_INDEX]);

		const delta = syncDelta(mine, stamps(server), AT);

		assert.deepEqual(delta.lists[PHOTO_INDEX], mine[PHOTO_INDEX]);

		// A phone on v21's merge rules, which knows nothing of photo_index,
		// merges it like any other top-level list and writes it back.
		const old = v21.mergeDocuments({cards: [entry('c1', {notes: 'edited', updated_at: '2026-10-03T00:00:00.000Z'})]}, mine);

		assert.deepEqual(old[PHOTO_INDEX], mine[PHOTO_INDEX]);
	});
});

describe('choosing a family photo', () => {
	const index = (owner, language, ids) => [{card_id: 'tst1-001', catalog: 'international', deleted_at: null, id: `international~tst1-001~${language}`, language, photos: ids.map((id) => ({id, path: `${owner}/m/${id}.webp`})), updated_at: AT}];
	const members = [
		{index: index(A, 'pt', ['a-pt']), name: 'Member A', user_id: A},
		{index: index(B, 'en', ['b-en']), name: 'Member B', user_id: B},
	];
	const card = {card_id: 'tst1-001', catalog: 'international', language: 'en'};

	test('the same language first, then any other; paths outside the member\'s folder never count', () => {
		assert.deepEqual(familyPhotos(members, card).map((item) => item.photo.id), ['b-en', 'a-pt']);
		assert.deepEqual(familyPhotos(members, {...card, language: 'pt'}).map((item) => item.photo.id), ['a-pt', 'b-en']);
		assert.deepEqual(familyPhotos(members, {...card, card_id: 'tst1-002'}), []);
		assert.deepEqual(familyPhotos([{index: index(B, 'en', ['x']), name: 'Member A', user_id: A}], card), []);
	});

	test('shown only when there is no official image, no twin, and no own photo', () => {
		const family = familyPhotos(members, card);
		const own = entry('c1', {photos: [photo('mine', A, 'c1')]});

		assert.deepEqual(gallerySlides({entries: [entry('c1')], family}).map((slide) => [slide.kind, slide.label]),
			[['family', 'Photo by Member B'], ['family', 'Photo by Member A']]);
		assert.equal(mainImage([entry('c1')], null, {family}).kind, 'family');
		assert.equal(mainImage([entry('c1')], null, {family}).by, 'Member B');
		assert.equal(mainImage([entry('c1')], 'https://example.test/official.webp', {family}).kind, 'official');
		assert.equal(mainImage([entry('c1')], null, {family, twins: [{src: 'https://example.test/twin.webp'}]}).kind, 'twin');
		assert.equal(mainImage([own], null, {family}).kind, 'photo');
		assert.deepEqual(gallerySlides({entries: [own], family}).map((slide) => slide.kind), ['photo']);
	});
});
