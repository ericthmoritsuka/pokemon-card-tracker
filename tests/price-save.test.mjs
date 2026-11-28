// js/price-save.js: one finish's sale price saved the Shop's way from
// Check spares (Eric, 2026-11-27), with the Shop's parsing, cap, patches,
// Undo, and suggestion words. No browser.
//
// Run: node --test tests/price-save.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

// js/moves.js reaches window and document when its imports load.
globalThis.window = globalThis.window || globalThis;
globalThis.addEventListener = globalThis.addEventListener || (() => {});

const {PRICE_FORM_TEXT, PRICE_MAX_TEXT} = await import('../js/moves.js');
const {priceSave, suggestionWords} = await import('../js/price-save.js');
const {shopGroups} = await import('../js/shop.js');

const at = (minute) => `2026-11-27T10:${String(minute).padStart(2, '0')}:00.000Z`;
const card = (id, fields = {}) => ({card_id: 'zz1-001', catalog: 'international', created_at: at(Number(id.replace(/\D/g, ''))), deleted_at: null, id, language: 'pt', ...fields});

describe('priceSave', () => {
	const [group] = shopGroups([card('c1'), card('c2', {sale_price: 2}), card('c3')]);

	test('a price goes on every copy of the finish, keeper included, with an Undo to what each had', () => {
		const result = priceSave(group, '3,50');

		assert.equal(result.error, null);
		assert.equal(result.value, 3.5);
		assert.deepEqual(result.patches.map((patch) => patch.id).sort(), ['c1', 'c2', 'c3']);
		assert.deepEqual(result.undo.find((patch) => patch.id === 'c2').patch, {sale_price: 2});
		assert.deepEqual(result.undo.find((patch) => patch.id === 'c1').patch, {sale_price: null});
	});

	test('empty clears it; unreadable and above the cap are refused with the Shop\'s words', () => {
		assert.equal(priceSave(group, '').value, null);
		assert.equal(priceSave(group, '').patches.length, 1);
		assert.equal(priceSave(group, 'abc').error, PRICE_FORM_TEXT);
		assert.equal(priceSave(group, '100.000,00').error, PRICE_MAX_TEXT);
		assert.equal(priceSave(group, '99.999,99').value, 99999.99);
	});
});

describe('suggestionWords', () => {
	test('the markets the Shop names, or nothing', () => {
		assert.equal(suggestionWords({cardmarket: 1.8, tcgplayer: 2.1, use: 2.5}).replace(/\s/g, ' '), 'TCGplayer ≈ R$ 2,10 · Cardmarket ≈ R$ 1,80');
		assert.equal(suggestionWords({cardmarket: null, tcgplayer: null, use: null}), '');
	});
});
