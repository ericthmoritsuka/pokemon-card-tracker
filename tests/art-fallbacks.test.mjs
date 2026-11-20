// artFallbacks (js/tile.js): the stand-ins a tile tries in turn when its
// picture fails. 2026-11-20: TCGdex had the Kanto binder's Arcanine
// (sv10-028) only in its large size, so its pocket stayed blank.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

// js/tile.js reaches js/dom.js, which listens for errors on window when it
// loads.
globalThis.window = globalThis.window || {addEventListener() {}};

const {ENGLISH_NOTE, artFallbacks} = await import('../js/tile.js');

describe('artFallbacks', () => {
	test('an English small image falls back to the large one', () => {
		assert.deepEqual(artFallbacks('https://assets.tcgdex.net/en/sv/sv10/028/low.webp'), [
			{note: null, src: 'https://assets.tcgdex.net/en/sv/sv10/028/high.webp'},
		]);
	});

	test('a Portuguese small image tries the English small one, then its own large one, then the English large one', () => {
		assert.deepEqual(artFallbacks('https://assets.tcgdex.net/pt/sv/sv06/100/low.webp'), [
			{note: ENGLISH_NOTE, src: 'https://assets.tcgdex.net/en/sv/sv06/100/low.webp'},
			{note: null, src: 'https://assets.tcgdex.net/pt/sv/sv06/100/high.webp'},
			{note: ENGLISH_NOTE, src: 'https://assets.tcgdex.net/en/sv/sv06/100/high.webp'},
		]);
	});

	test('a large image or another address has nothing more to try', () => {
		assert.deepEqual(artFallbacks('https://assets.tcgdex.net/en/sv/sv10/028/high.webp'), []);
		assert.deepEqual(artFallbacks(null), []);
	});
});
