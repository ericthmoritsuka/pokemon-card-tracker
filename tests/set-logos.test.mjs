// englishLogo (js/catalog.js): a Western set with no logo in its language
// shows the English one (2026-11-20: Fagulhas Impetuosas, Fogo Branco, Raio
// Preto have none in Portuguese on TCGdex).
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {englishLogo} from '../js/catalog.js';

describe('englishLogo', () => {
	test('a Portuguese, French, or other Western set gets the English logo address', () => {
		assert.equal(englishLogo('pt', 'sv', 'sv08'), 'https://assets.tcgdex.net/en/sv/sv08/logo');
		assert.equal(englishLogo('fr', 'sv', 'sv10.5w'), 'https://assets.tcgdex.net/en/sv/sv10.5w/logo');
	});

	test('English has no stand-in, nor do Japanese, Korean, or Chinese sets, whose IDs are their own', () => {
		assert.equal(englishLogo('en', 'sv', 'sv08'), null);
		assert.equal(englishLogo('ja', 'SV', 'SV8'), null);
		assert.equal(englishLogo('ko', 'SV', 'SV8'), null);
	});
});
