// Unit tests for js/photo-cleanup.js: which cards are offered once the
// catalog gains their official image, the ticks Review starts with, Not now,
// and Delete and Undo with fakes standing in for js/photos/store.js and
// js/collection.js. Invented cards only; no network.
//
// Run: node --test tests/photo-cleanup.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {
	cleanupCandidates,
	deletePhotos,
	indexImages,
	initialTicks,
	noticeText,
	readSeen,
	rememberSeen,
	shouldOffer,
	undoDelete,
} from '../js/photo-cleanup.js';
import {BUCKET_DELETE_GRACE_MS, bucketDeleteState, patchedPhotos} from '../js/photos/model.js';

const AT = '2026-10-20T10:00:00.000Z';
const IMAGE = 'https://assets.tcgdex.net/en/zz/zz1/001';

const photo = (id, extra = {}) => ({created_at: AT, deleted_at: null, id, path: `user-a/${id}/${id}.webp`, side: 'front', ...extra});

function record(cardId, photos, extra = {}) {
	return {card_id: cardId, catalog: 'international', created_at: AT, id: `international~${cardId}~en`, language: 'en', main_image: null, notes: null, photos, updated_at: AT, ...extra};
}

const indexed = (cardId, image = null) => [`international|${cardId}`, {catalog: 'international', id: cardId, localizations: {en: {image, lang: 'en', name: `Test ${cardId}`, set_name: 'Test Set'}}, set_id: 'zz1'}];

const saved = (cardId, image = `${IMAGE}`) => [`international|${cardId}`, {id: cardId, image, name: `Test ${cardId}`}];

function fakeStorage() {
	const map = new Map();

	return {getItem: (key) => (map.has(key) ? map.get(key) : null), map, setItem: (key, value) => map.set(key, String(value))};
}

describe('cards that gained an official image', () => {
	const records = [
		// Gained: the index had no image, the saved record has one.
		record('zz1-001', [photo('p1'), photo('p2', {side: 'back'})]),
		// Pinned photo: still offered, unticked.
		record('zz1-002', [photo('p3')], {main_image: 'p3'}),
		// Had its image all along: never offered.
		record('zz1-003', [photo('p4')]),
		// Still no image in the saved record.
		record('zz1-004', [photo('p5')]),
		// Only removed photos, or one not uploaded yet: nothing to delete.
		record('zz1-005', [photo('p6', {deleted_at: AT}), photo('p7', {path: null})]),
		// A card with no saved record yet.
		record('zz1-006', [photo('p8')]),
	];
	const index = new Map([indexed('zz1-001'), indexed('zz1-002'), indexed('zz1-003', `${IMAGE}x`), indexed('zz1-004'), indexed('zz1-005'), indexed('zz1-006')]);
	const savedRecords = new Map([saved('zz1-001'), saved('zz1-002'), saved('zz1-003'), saved('zz1-004', null), saved('zz1-005')]);

	test('only cards whose image is new and that still carry live uploaded photos', () => {
		const found = cleanupCandidates(records, index, savedRecords);

		assert.deepEqual(found.map((item) => item.card.card_id), ['zz1-001', 'zz1-002']);
		assert.deepEqual(found[0].photos.map((entry) => entry.photo.id), ['p1', 'p2']);
		assert.equal(found[0].image, IMAGE);
		assert.equal(found[0].name, 'Test zz1-001');
		assert.equal(noticeText(found), '2 cards now have official images. You can delete your 3 photos of them to save space.');
		assert.equal(noticeText(found.slice(1)), '1 card now has an official image. You can delete your photo of it to save space.');
	});

	test('a card the index never recorded is not offered', () => {
		assert.deepEqual(cleanupCandidates(records, new Map(), savedRecords), []);
	});

	test('pinned photos start unticked', () => {
		const ticks = initialTicks(cleanupCandidates(records, index, savedRecords));

		assert.deepEqual([...ticks].sort(), ['p1', 'p2']);
	});
});

describe('Not now', () => {
	const index = new Map([indexed('zz1-001'), indexed('zz1-002')]);
	const savedRecords = new Map([saved('zz1-001'), saved('zz1-002')]);

	test('remembers the cards offered and shows again only for a new one', () => {
		const storage = fakeStorage();
		const first = cleanupCandidates([record('zz1-001', [photo('p1')])], index, savedRecords);

		assert.equal(shouldOffer(first, readSeen(storage, 'user-a')), true);
		rememberSeen(storage, 'user-a', first.map((item) => item.key));
		assert.equal(shouldOffer(first, readSeen(storage, 'user-a')), false, 'not again on the next launch');

		const more = cleanupCandidates([record('zz1-001', [photo('p1')]), record('zz1-002', [photo('p2')])], index, savedRecords);

		assert.equal(shouldOffer(more, readSeen(storage, 'user-a')), true, 'again once another card gains an image');
		assert.equal(shouldOffer(first, readSeen(storage, 'user-b')), true, 'each person keeps their own');
	});

	test('unreadable storage reads as nothing seen', () => {
		const storage = {getItem: () => '{oops', setItem: () => {
			throw new Error('full');
		}};

		assert.equal(readSeen(storage, 'user-a').size, 0);
		assert.doesNotThrow(() => rememberSeen(storage, 'user-a', ['k']));
	});
});

describe('Delete and Undo', () => {
	// A stand-in for the document and js/photos/store.js removePhotoFromEntry:
	// a tombstone, the pin cleared, and a delete row queued with the grace
	// period, the way the real one does.
	function fakeStore(records) {
		const queue = new Map();
		const blobs = new Map(records.flatMap((item) => item.photos.map((p) => [p.id, `blob-${p.id}`])));
		let ids = 0;

		const remove = async (recordId, photoId) => {
			const holder = records.find((item) => item.id === recordId);
			const target = holder.photos.find((p) => p.id === photoId);

			holder.photos = patchedPhotos(holder, photoId, {deleted_at: '2026-10-30T12:00:00.000Z'});

			if (holder.main_image === photoId) {
				holder.main_image = null;
			}

			queue.set(photoId, {at: Date.now(), entry_id: recordId, list: 'card_info', not_before: Date.now() + BUCKET_DELETE_GRACE_MS, op: 'delete', path: target.path, photo_id: photoId});
			blobs.delete(photoId);
		};

		const update = async (cards, change) => {
			for (const card of cards) {
				const holder = records.find((item) => item.card_id === card.card_id && item.language === card.language);

				Object.assign(holder, change(holder) || {});
			}
		};

		return {blobs, newId: () => `new-${++ids}`, queue, readBlob: async (id) => blobs.get(id) || null, remove, saveBlob: async (id, blob) => blobs.set(id, blob), update};
	}

	const fresh = () => [
		record('zz1-001', [photo('p1'), photo('p2', {side: 'back'})]),
		record('zz1-002', [photo('p3')], {main_image: 'p3'}),
	];
	const index = new Map([indexed('zz1-001'), indexed('zz1-002')]);
	const savedRecords = new Map([saved('zz1-001'), saved('zz1-002')]);

	test('removes exactly the ticked photos, each through the normal removal', async () => {
		const records = fresh();
		const store = fakeStore(records);
		const candidates = cleanupCandidates(records, index, savedRecords);
		const ticks = initialTicks(candidates);

		ticks.delete('p2');

		const removed = await deletePhotos(candidates, ticks, store);
		const live = (item) => item.photos.filter((p) => !p.deleted_at).map((p) => p.id);

		assert.deepEqual(removed.map((item) => item.photo.id), ['p1']);
		assert.deepEqual(live(records[0]), ['p2']);
		assert.deepEqual(live(records[1]), ['p3'], 'the pinned photo stays');
		assert.deepEqual([...store.queue.keys()], ['p1']);

		const doc = {card_info: records, cards: []};
		const row = store.queue.get('p1');

		assert.equal(bucketDeleteState(row, doc, () => true, Date.now() + BUCKET_DELETE_GRACE_MS - 60000), 'wait', 'the bucket file waits out the 14 days');
		assert.equal(bucketDeleteState(row, doc, () => true, Date.now() + BUCKET_DELETE_GRACE_MS + 60000), 'go');
	});

	test('Undo brings them back on the same files, the pin too, and cancels the bucket delete', async () => {
		const records = fresh();
		const store = fakeStore(records);
		const candidates = cleanupCandidates(records, index, savedRecords);
		const ticks = new Set(['p1', 'p3']);
		const removed = await deletePhotos(candidates, ticks, store);

		assert.equal(records[1].main_image, null);

		const restored = await undoDelete(removed, store);
		const live = (item) => item.photos.filter((p) => !p.deleted_at);

		assert.deepEqual(restored, ['new-1', 'new-2']);
		assert.deepEqual(live(records[0]).map((p) => [p.id, p.path]), [['p2', 'user-a/p2/p2.webp'], ['new-1', 'user-a/p1/p1.webp']]);
		assert.deepEqual(live(records[1]).map((p) => [p.id, p.path]), [['new-2', 'user-a/p3/p3.webp']]);
		assert.equal(records[1].main_image, 'new-2', 'pinned again');
		assert.equal(store.blobs.get('new-1'), 'blob-p1', 'the phone copy comes back');

		const doc = {card_info: records, cards: []};

		assert.equal(bucketDeleteState(store.queue.get('p1'), doc, () => true, Date.now() + 2 * BUCKET_DELETE_GRACE_MS), 'cancel');
		assert.equal(bucketDeleteState(store.queue.get('p3'), doc, () => true, Date.now() + 2 * BUCKET_DELETE_GRACE_MS), 'cancel');
	});

	test('the deleted cards take their official image in the card index', () => {
		const candidates = cleanupCandidates(fresh(), index, savedRecords);
		const records = indexImages(candidates, index, [candidates[0].card]);

		assert.deepEqual(records, [{catalog: 'international', id: 'zz1-001', localizations: {en: {image: IMAGE, lang: 'en', name: 'Test zz1-001', set_name: 'Test Set'}}}]);
	});
});
