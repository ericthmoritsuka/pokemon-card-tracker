// The names table beside the fingerprint index (js/vision/index-names.json,
// lab/fingerprints/build-names.mjs) must name every card the index holds:
// a card it lacks makes the scanner ask TCGdex for that card's set, which on
// a phone with mobile data costs seconds (js/scan/picture.js describe). A
// rebuilt index without a rebuilt table fails here. Node only.
//
// Run: node --test tests/index-names.test.mjs

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {describe, test} from 'node:test';

import {unpackIndex} from '../js/vision/pack.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url));

describe('the index names table', () => {
	test('names every card in js/vision/index.bin, with its set\'s name and official count', async () => {
		const bytes = await read('js/vision/index.bin');
		const index = unpackIndex(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
		const table = JSON.parse(await read('js/vision/index-names.json'));
		const missing = [];
		const setsMissing = new Set();

		for (let i = 0; i < index.count; i++) {
			const card = index.card(i);
			const key = `${card.catalog}|${card.set}`;

			if (!table.sets[key] || !table.sets[key][0]) {
				setsMissing.add(key);
			}

			if (!(table.cards[key] && table.cards[key][card.id])) {
				missing.push(`${key} ${card.id}`);
			}
		}

		assert.deepEqual([...setsMissing], [], 'every set has a name (rebuild with node lab/fingerprints/build-names.mjs)');
		assert.deepEqual(missing.slice(0, 20), [], `${missing.length} index cards have no name (rebuild with node lab/fingerprints/build-names.mjs)`);
	});

	test('the service worker precaches it beside the index', async () => {
		const sw = String(await read('sw.js'));

		assert.match(sw, /'js\/vision\/index\.bin',[\s\S]{0,200}'js\/vision\/index-names\.json',/);
	});
});

// The index cards whose artwork an image-less card shares
// (js/vision/index-twins.json, lab/fingerprints/build-twins.mjs): each is
// sure only by its number (js/scan/picture.js pictureVerdict).
describe('the index twins list', () => {
	test('lists only cards the index holds, each with twins the index does not', async () => {
		const bytes = await read('js/vision/index.bin');
		const index = unpackIndex(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
		const {count, pairs, twins} = JSON.parse(await read('js/vision/index-twins.json'));
		const held = new Set();

		for (let i = 0; i < index.count; i++) {
			const card = index.card(i);

			if (card.catalog !== 'ja') {
				held.add(card.id);
			}
		}

		const ids = Object.keys(twins);

		assert.equal(count, ids.length);
		assert.equal(pairs, ids.flatMap((id) => twins[id]).length);
		assert.deepEqual(ids.filter((id) => !held.has(id)).slice(0, 20), [], 'every key is an index card (rebuild with node lab/fingerprints/build-twins.mjs)');
		assert.deepEqual(ids.flatMap((id) => twins[id]).filter((id) => held.has(id)).slice(0, 20), [], 'no twin is in the index');
		assert.deepEqual(twins['sm3-18'], ['2021swsh-9'], 'Burning Shadows\' Charmander has the McDonald\'s Collection 2021 one');
		assert.deepEqual(twins['base1-4'], ['30th-c-001', 'cel25cc-CC002'], 'Base Set Charizard has its Classic Collection reprints');
		assert.equal(twins['me01-003'], undefined, 'Mega Venusaur ex: its MEP promo has no picture anywhere and promos seldom reprint artwork, so a shared name and illustrator alone do not list it');
	});

	test('the service worker precaches it beside the index', async () => {
		const sw = String(await read('sw.js'));

		assert.match(sw, /'js\/vision\/index-twins\.json',/);
	});
});
