// The scanner's prints of the family's photos (js/scan/photo-prints.js):
// a card the catalog has no picture of is matched by the owner's photo of
// it, fingerprinted as build-index.mjs fingerprints a catalog image. Node
// only, on synthetic card pictures.
//
// Run: node --test tests/photo-prints.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {buildPhotoIndex, decodePrint, describeCard, encodePrint, mergePhotoMatches, photoPrintEntries} from '../js/scan/photo-prints.js';
import {queryFingerprints, thumbnail} from '../js/vision/fingerprint.js';
import {matchFingerprints} from '../js/vision/matcher.js';

const WEIGHTS = {framed: {art: 1, card: 0.5, color: 0.1}, full: {art: 0.6, card: 1, color: 0.1}};

// A card-shaped picture of coloured blocks, different for every seed.
function picture(seed, {width = 300, height = 420, dx = 0} = {}) {
	let s = seed * 9973 + 1;
	const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
	const blocks = Array.from({length: 40}, () => ({b: rand() * 255, g: rand() * 255, h: 0.05 + rand() * 0.3, r: rand() * 255, w: 0.05 + rand() * 0.3, x: rand(), y: rand()}));
	const data = new Uint8ClampedArray(width * height * 4);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const fx = (x + dx) / width;
			const fy = y / height;
			const i = (y * width + x) * 4;
			let [r, g, b] = [230, 220, 200];

			for (const k of blocks) {
				if (fx >= k.x && fx < k.x + k.w && fy >= k.y && fy < k.y + k.h) {
					[r, g, b] = [k.r, k.g, k.b];
				}
			}

			data[i] = r;
			data[i + 1] = g;
			data[i + 2] = b;
			data[i + 3] = 255;
		}
	}

	return {data, height, width};
}

const bits = {artBits: 128, cardBits: 128};
const queries = (img) => queryFingerprints(thumbnail(img), bits);

describe('the prints of the family\'s photos', () => {
	test('a print comes back from its cache text unchanged', () => {
		const print = describeCard(picture(1));
		const back = decodePrint(encodePrint(print));

		assert.deepEqual([...back.art], [...print.art]);
		assert.deepEqual([...back.card], [...print.card]);
		assert.deepEqual([...back.color], [...print.color]);
		assert.equal(decodePrint('not base64 of 48 bytes'), null);
	});

	test('a capture of the photographed card finds it, one card for its two photos', () => {
		const entries = [
			{...describeCard(picture(1)), catalog: 'en', id: 'mep-037', set: 'mep'},
			{...describeCard(picture(1, {dx: 3})), catalog: 'en', id: 'mep-037', set: 'mep'},
			{...describeCard(picture(2)), catalog: 'en', id: 'mep-038', set: 'mep'},
		];
		const index = buildPhotoIndex(entries, {weights: WEIGHTS});

		assert.equal(index.count, 3);
		assert.equal(index.card(0).id, 'mep-037');
		assert.equal(index.card(2).set, 'mep');

		const found = mergePhotoMatches({groups: []}, matchFingerprints(index, queries(picture(1, {dx: 6}))));

		assert.equal(found.groups[0].cards[0].id, 'mep-037');
		assert.equal(found.groups[0].cards.length, 1, 'two photos of one card are one card');
		assert.equal(found.groups[0].cards[0].photo, true);
		assert.equal(found.groups[0].cards[0].image, null, 'no catalog picture: the tray shows the photo');
		assert.ok(found.groups[0].score < found.groups[1].score);
	});

	test('the photo matches join the index\'s by score, the best five kept', () => {
		const main = {groups: [{cards: [{id: 'sv01-1'}], score: 40}, {cards: [{id: 'sv01-2'}], score: 50}, {cards: [{id: 'sv01-3'}], score: 60}, {cards: [{id: 'sv01-4'}], score: 62}, {cards: [{id: 'sv01-5'}], score: 64}], timings: {match: 3}};
		const merged = mergePhotoMatches(main, {groups: [{cards: [{id: 'mep-037', image: 'x'}], score: 30}, {cards: [{id: 'mep-038'}], score: 70}]});

		assert.deepEqual(merged.groups.map((g) => g.cards[0].id), ['mep-037', 'sv01-1', 'sv01-2', 'sv01-3', 'sv01-4']);
		assert.equal(merged.timings.match, 3);
		assert.equal(mergePhotoMatches(main, null), main);
	});

	test('only front photos of cards the index lacks count, each decoded once', async () => {
		const decoded = [];
		const imageOf = async (photo) => {
			decoded.push(photo.id);

			return photo.id === 'p-gone' ? null : picture(photo.id.length);
		};
		const records = [
			{card_id: 'mep-037', catalog: 'international', photos: [{id: 'p1', side: 'front'}, {id: 'p2', side: 'back'}, {deleted_at: '2026-11-01', id: 'p3', side: 'front'}]},
			{card_id: 'sv01-001', catalog: 'international', photos: [{id: 'p4', side: 'front'}]},
			{card_id: 'M6-012', catalog: 'ko', photos: [{id: 'p55', side: 'front'}, {id: 'p-gone', side: 'front'}]},
			{card_id: 'hand_x', catalog: 'custom', photos: [{id: 'p6', side: 'front'}]},
			{card_id: 'mep-040', catalog: 'international', deleted_at: '2026-11-02', photos: [{id: 'p7', side: 'front'}]},
		];
		const inIndex = (catalog, id) => catalog === 'en' && id === 'sv01-001';
		const first = await photoPrintEntries({imageOf, inIndex, records});

		assert.deepEqual(first.entries.map((e) => `${e.catalog} ${e.id} ${e.set} ${e.photoId}`), ['en mep-037 mep p1', 'ko M6-012 M6 p55']);
		assert.deepEqual(decoded, ['p1', 'p55', 'p-gone'], 'the back, the deleted, the indexed, and the hand-made card are not decoded');
		assert.deepEqual(Object.keys(first.cache).sort(), ['p1', 'p55'], 'a photo the phone could not get is tried again later');

		decoded.length = 0;

		const again = await photoPrintEntries({cache: first.cache, imageOf, inIndex, records});

		assert.equal(again.entries.length, 2);
		assert.deepEqual(decoded, ['p-gone'], 'kept prints are not decoded again');
	});
});
