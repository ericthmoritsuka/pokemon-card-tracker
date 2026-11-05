// Unit tests for what the service worker remembers about the images that
// fail in cors mode (js/image-folders.js), the opaque cache's size, and the
// English stand-in the art falls back to (js/tile.js artFallback). Node
// only, no browser, no network. The worker itself is in
// tests/image-worker.test.mjs, the browser side in
// tests/my-cards-browser.test.mjs, "card images".
//
// Run: node --test tests/image-folders.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

// js/tile.js reaches js/dom.js, which listens for errors on window when it
// loads.
globalThis.window = globalThis.window || {addEventListener() {}};

await import('../js/image-folders.js');

const {ENGLISH_NOTE, artFallback, englishImage} = await import('../js/tile.js');
const {IMAGES_MAX, OPAQUE_MAX, OPAQUE_MIN, PROBE_AFTER_MS, RETRY_AFTER_MS, englishOf, folderOf, imageMemory, opaqueLimit} = globalThis.imageFolders;

const PT = 'assets.tcgdex.net/pt';
const FR = 'assets.tcgdex.net/fr';
const EN = 'assets.tcgdex.net/en';

const GB = 1024 * 1024 * 1024;

// A clock the test moves by hand.
function clock(start = 1_000_000) {
	const at = {now: start};

	return {at, now: () => at.now};
}

const image = (folder, n) => `https://${folder}/me/me01/${String(n).padStart(3, '0')}/low.webp`;

describe('the image memory', () => {
	test('a folder is the host and the language', () => {
		assert.equal(folderOf('https://assets.tcgdex.net/pt/me/me01/001/low.webp'), PT);
		assert.equal(folderOf('https://assets.tcgdex.net/fr/sv/sv01/001/high.webp'), FR);
		assert.equal(folderOf('https://assets.tcgdex.net/en/sv/sv01/logo.webp'), EN);
		assert.equal(folderOf('https://raw.githubusercontent.com/PokeAPI/sprites/master/1.png'), 'raw.githubusercontent.com/PokeAPI');
	});

	test('every image starts on cors, and an image kept opaque with nothing remembered is worth one try', () => {
		const memory = imageMemory();

		assert.equal(memory.plan(image(PT, 1)), 'cors');
		assert.equal(memory.check(image(PT, 1)), true);
		assert.equal(memory.remembered(image(PT, 1)), false);
		assert.equal(memory.worked(image(PT, 1)), false, 'nothing to save');
	});

	test('a failed image goes straight to no-cors; the images around it in its folder stay on cors', () => {
		const memory = imageMemory();

		// Three in a row, as pt/me/me01/001 to 003 can be.
		for (const n of [1, 2, 3]) {
			assert.equal(memory.failed(image(PT, n)), true);
		}

		assert.deepEqual([1, 2, 3].map((n) => memory.plan(image(PT, n))), ['no-cors', 'no-cors', 'no-cors']);
		assert.deepEqual([4, 5].map((n) => memory.plan(image(PT, n))), ['cors', 'cors']);
		assert.equal(memory.check(image(PT, 1)), false);
		assert.equal(memory.remembered(image(PT, 1)), true);
	});

	test('a remembered image is tried again after a week', () => {
		const time = clock();
		const memory = imageMemory({}, time.now);

		memory.failed(image(PT, 1));
		// Another image's try keeps the folder's hourly one taken.
		time.at.now += RETRY_AFTER_MS - 1;
		memory.failed(image(PT, 2));
		assert.equal(memory.plan(image(PT, 1)), 'no-cors');
		time.at.now += 1;
		assert.equal(memory.plan(image(PT, 1)), 'retry');
		assert.equal(memory.check(image(PT, 1)), true);
	});

	test('a folder gets one try an hour, on the first remembered image shown, and only that one', () => {
		const time = clock();
		const memory = imageMemory({}, time.now);

		for (const n of [1, 2, 3]) {
			memory.failed(image(PT, n));
		}

		time.at.now += PROBE_AFTER_MS - 1;
		assert.equal(memory.check(image(PT, 2)), false);
		time.at.now += 1;
		assert.equal(memory.check(image(PT, 2)), true, 'the hour is up');
		assert.equal(memory.check(image(PT, 3)), false, 'the hour\'s try is taken');
		assert.equal(memory.plan(image(PT, 1)), 'no-cors');
		assert.equal(memory.check(image(FR, 1)), true, 'other folders keep their own');

		// It failed: the next try is an hour on.
		memory.failed(image(PT, 2));
		time.at.now += PROBE_AFTER_MS - 1;
		assert.equal(memory.check(image(PT, 1)), false);
	});

	test('when a remembered image works, each other one in its folder is worth one more try', () => {
		const time = clock();
		const memory = imageMemory({}, time.now);

		for (const n of [1, 2, 3]) {
			memory.failed(image(PT, n));
		}

		memory.failed(image(FR, 1));
		time.at.now += PROBE_AFTER_MS;
		assert.equal(memory.check(image(PT, 1)), true);
		assert.equal(memory.worked(image(PT, 1)), true);
		assert.equal(memory.plan(image(PT, 1)), 'cors', 'forgotten');
		assert.equal(memory.check(image(PT, 2)), true);
		assert.equal(memory.plan(image(PT, 3)), 'retry');
		assert.equal(memory.toJSON().folders[FR].fixedAt, 0, 'not in another folder');

		// One that still fails is left alone again.
		time.at.now += 1;
		memory.failed(image(PT, 2));
		assert.equal(memory.check(image(PT, 2)), false);
	});

	test('the memory survives a new worker, and a saved memory that is not one is ignored', () => {
		const time = clock();
		const memory = imageMemory({}, time.now);

		memory.failed(image(PT, 1));

		const again = imageMemory(JSON.parse(JSON.stringify(memory)), time.now);

		assert.equal(again.plan(image(PT, 1)), 'no-cors');
		assert.equal(again.check(image(PT, 1)), false, 'its folder\'s hourly try is remembered too');

		for (const saved of [null, 'x', [], {images: {[image(PT, 1)]: 'soon'}}, {folders: {[PT]: null}}, {[PT]: {mode: 'no-cors'}}]) {
			assert.equal(imageMemory(saved).plan(image(PT, 1)), 'cors', JSON.stringify(saved));
		}
	});

	test(`at most ${IMAGES_MAX} images are remembered, the ones that failed longest ago forgotten first`, () => {
		const time = clock();
		const memory = imageMemory({}, time.now);

		for (let n = 1; n <= IMAGES_MAX + 2; n++) {
			time.at.now += 1;
			memory.failed(image(PT, n));
		}

		assert.equal(Object.keys(memory.toJSON().images).length, IMAGES_MAX);
		assert.deepEqual([1, 2, 3].map((n) => memory.plan(image(PT, n))), ['cors', 'cors', 'no-cors']);
	});
});

describe('the opaque cache size', () => {
	test('a tenth of the quota at 8 MiB an entry, 100 to 1,000 entries (Eric, 2026-10-15 and 2026-11-05)', () => {
		assert.equal(OPAQUE_MIN, 100);
		assert.equal(OPAQUE_MAX, 1000);
		assert.equal(opaqueLimit(10 * GB), 128, 'Eric\'s phone: 10 GB of quota, 1 GB of padded entries');
		assert.equal(opaqueLimit(10e9), 119);
		assert.equal(opaqueLimit(GB), OPAQUE_MIN, 'a small quota still keeps the floor');
		assert.equal(opaqueLimit(100 * GB), OPAQUE_MAX);
		assert.equal(opaqueLimit(0), OPAQUE_MIN);
		assert.equal(opaqueLimit(undefined), OPAQUE_MIN);
		assert.equal(opaqueLimit(Number.NaN), OPAQUE_MIN);
	});
});

describe('the English stand-in', () => {
	const IMAGES = [
		['https://assets.tcgdex.net/pt/me/me01/001/low.webp', 'https://assets.tcgdex.net/en/me/me01/001/low.webp'],
		['https://assets.tcgdex.net/fr/sv/sv03.5/025/high.webp', 'https://assets.tcgdex.net/en/sv/sv03.5/025/high.webp'],
		['https://assets.tcgdex.net/en/me/me01/001/low.webp', null],
		['https://assets.tcgdex.net/ja/SV/SV2a/025/low.webp', null],
		['https://assets.tcgdex.net/de/sv/sv01/001/low.webp', null],
		['https://example.com/pt/me/me01/001/low.webp', null],
		['', null],
		[null, null],
	];

	test('a Portuguese or French image falls back to the same card\'s English image, with a note; nothing else does', () => {
		for (const [src, english] of IMAGES) {
			assert.deepEqual(artFallback(src), english ? {note: ENGLISH_NOTE, src: english} : null, String(src));
		}

		assert.equal(ENGLISH_NOTE, 'English image');
	});

	test('the worker keeps the stand-in the page asks for', () => {
		for (const [src] of IMAGES) {
			assert.equal(englishOf(src), englishImage(src), String(src));
		}
	});
});
