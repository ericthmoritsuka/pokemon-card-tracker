// Unit tests for what the service worker remembers about each image folder
// (js/image-folders.js), the opaque cache's size, and the English stand-in
// the art falls back to (js/tile.js artFallback). Node only, no browser,
// no network. The browser side is in tests/my-cards-browser.test.mjs,
// "card images".
//
// Run: node --test tests/image-folders.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

// js/tile.js reaches js/dom.js, which listens for errors on window when it
// loads.
globalThis.window = globalThis.window || {addEventListener() {}};

await import('../js/image-folders.js');

const {ENGLISH_NOTE, artFallback, englishImage} = await import('../js/tile.js');
const {FLIP_AFTER, OPAQUE_MAX, OPAQUE_MIN, PROBE_AFTER_MS, PROBE_EVERY, englishOf, folderMemory, folderOf, opaqueLimit} = globalThis.imageFolders;

const PT = 'assets.tcgdex.net/pt';
const FR = 'assets.tcgdex.net/fr';
const EN = 'assets.tcgdex.net/en';

const GB = 1024 * 1024 * 1024;

// A clock the test moves by hand.
function clock(start = 1_000_000) {
	const at = {now: start};

	return {at, now: () => at.now};
}

describe('image folders', () => {
	test('a folder is the host and the language', () => {
		assert.equal(folderOf('https://assets.tcgdex.net/pt/me/me01/001/low.webp'), PT);
		assert.equal(folderOf('https://assets.tcgdex.net/fr/sv/sv01/001/high.webp'), FR);
		assert.equal(folderOf('https://assets.tcgdex.net/en/sv/sv01/logo.webp'), EN);
		assert.equal(folderOf('https://raw.githubusercontent.com/PokeAPI/sprites/master/1.png'), 'raw.githubusercontent.com/PokeAPI');
	});

	test('every folder starts on cors', () => {
		const memory = folderMemory();

		assert.equal(memory.plan(PT), 'cors');
		assert.equal(memory.mode(PT), 'cors');
		assert.equal(memory.recovered(PT), false);
	});

	test(`a folder goes to no-cors after ${FLIP_AFTER} doubled headers in a row, and not before`, () => {
		const memory = folderMemory();

		for (let i = 1; i < FLIP_AFTER; i++) {
			assert.equal(memory.record(PT, false), true);
			assert.equal(memory.plan(PT), 'cors', `still cors after ${i}`);
		}

		assert.equal(memory.record(PT, false), true);
		assert.equal(memory.mode(PT), 'no-cors');
		assert.equal(memory.plan(PT), 'no-cors');
	});

	test('a folder that doubles some images and not others stays on cors', () => {
		const memory = folderMemory();

		// As on 2026-10-15: 001 and 003 doubled, 002 not, again and again.
		for (let i = 0; i < 30; i++) {
			memory.record(PT, i % 3 === 1);
		}

		assert.equal(memory.mode(PT), 'cors');
		assert.equal(memory.record(PT, true), true, 'a success after a failure resets the count');
		assert.equal(memory.record(PT, true), false, 'and a second one changes nothing to save');
	});

	test('folders are remembered apart: Portuguese on no-cors leaves French and English on cors', () => {
		const memory = folderMemory();

		for (let i = 0; i < FLIP_AFTER; i++) {
			memory.record(PT, false);
		}

		memory.record(FR, false);
		assert.deepEqual([memory.mode(PT), memory.mode(FR), memory.mode(EN)], ['no-cors', 'cors', 'cors']);
	});

	test(`a folder on no-cors tries cors on every ${PROBE_EVERY}th image, and switches back when it works`, () => {
		const time = clock();
		const memory = folderMemory({}, time.now);

		for (let i = 0; i < FLIP_AFTER; i++) {
			memory.record(PT, false);
		}

		const plans = Array.from({length: PROBE_EVERY}, () => memory.plan(PT));

		assert.deepEqual(plans, [...Array(PROBE_EVERY - 1).fill('no-cors'), 'probe']);

		// The probe failed: still no-cors, and the count starts again.
		memory.record(PT, false);
		assert.equal(memory.mode(PT), 'no-cors');
		assert.deepEqual(Array.from({length: PROBE_EVERY}, () => memory.plan(PT)).at(-1), 'probe');

		// The next probe works: TCGdex fixed the header.
		assert.equal(memory.record(PT, true), true);
		assert.equal(memory.mode(PT), 'cors');
		assert.equal(memory.plan(PT), 'cors');
		assert.equal(memory.recovered(PT), true, 'its opaque images are worth fetching again');
	});

	test('a folder on no-cors also tries cors an hour after its last try', () => {
		const time = clock();
		const memory = folderMemory({}, time.now);

		for (let i = 0; i < FLIP_AFTER; i++) {
			memory.record(PT, false);
		}

		assert.equal(memory.plan(PT), 'no-cors');
		time.at.now += PROBE_AFTER_MS - 1;
		assert.equal(memory.plan(PT), 'no-cors');
		time.at.now += 1;
		assert.equal(memory.plan(PT), 'probe');
		assert.equal(memory.plan(PT), 'no-cors', 'once, not at every image after the hour');
	});

	test('the memory survives a new worker, and a folder that went back to no-cors is no longer recovered', () => {
		const time = clock();
		const memory = folderMemory({}, time.now);

		for (let i = 0; i < FLIP_AFTER; i++) {
			memory.record(PT, false);
		}

		memory.record(FR, false);

		const again = folderMemory(JSON.parse(JSON.stringify(memory)), time.now);

		assert.deepEqual([again.mode(PT), again.mode(FR)], ['no-cors', 'cors']);
		assert.equal(again.plan(PT), 'no-cors');

		// FR has one failure on record: two more flip it.
		again.record(FR, false);
		again.record(FR, false);
		assert.equal(again.mode(FR), 'no-cors');

		again.record(PT, true);
		assert.equal(again.recovered(PT), true);

		for (let i = 0; i < FLIP_AFTER; i++) {
			again.record(PT, false);
		}

		assert.equal(again.recovered(PT), false);
	});

	test('a saved memory that is not one is ignored', () => {
		for (const saved of [null, 'x', [], {[PT]: {mode: 'sideways'}}, {[PT]: null}]) {
			assert.equal(folderMemory(saved).mode(PT), 'cors', JSON.stringify(saved));
		}
	});
});

describe('the opaque cache size', () => {
	test('half the quota at 8 MiB an entry, between the floor and the ceiling', () => {
		assert.equal(opaqueLimit(10 * GB), 640, 'Eric\'s phone: 10 GB of quota, 5 GB of padded entries');
		assert.equal(opaqueLimit(10e9), 596);
		assert.equal(opaqueLimit(GB), OPAQUE_MIN, 'a small quota still keeps the floor');
		assert.equal(opaqueLimit(500 * GB), OPAQUE_MAX);
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
