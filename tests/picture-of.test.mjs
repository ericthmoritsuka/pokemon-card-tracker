// pictureOf (js/catalog.js): a tile's picture from the card index record,
// falling back to another language when the chosen one was saved with none
// (2026-11-20: a Kanto binder's Arcanine pocket stayed blank on the
// computer while its card page showed the picture).
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {pictureOf} from '../js/catalog.js';

describe('pictureOf', () => {
	const record = {localizations: {
		en: {image: 'https://assets.tcgdex.net/en/sv/sv03.5/059', lang: 'en', name: 'Arcanine'},
		pt: {image: null, lang: 'pt', name: 'Arcanine'},
	}};

	test('the first preferred language that has a picture', () => {
		assert.equal(pictureOf(record, ['en', 'pt']), 'https://assets.tcgdex.net/en/sv/sv03.5/059');
	});

	test('a preferred language saved with no picture falls back to one that has it', () => {
		assert.equal(pictureOf(record, ['pt', null, 'pt']), 'https://assets.tcgdex.net/en/sv/sv03.5/059');
	});

	test('none at all, or no record, is null', () => {
		assert.equal(pictureOf({localizations: {pt: {image: null}}}, ['pt']), null);
		assert.equal(pictureOf(null, ['en']), null);
	});
});
