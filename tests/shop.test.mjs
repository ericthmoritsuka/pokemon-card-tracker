// The Shop's numbers (js/shop.js): which cards it lists, the sale price kept
// on every copy of a card, the suggestion and its rounding, the price
// filters, and the totals. No browser.
//
// Run: node --test tests/shop.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {
	groupMark,
	groupPrice,
	listingRows,
	priceFilter,
	pricePatches,
	roundUpToStep,
	salePrice,
	shopGroups,
	shopTotals,
	storePicturePath,
	suggestion,
	undoPricePatches,
} from '../js/shop.js';

const copy = (id, fields = {}) => ({card_id: 'sv10-001', catalog: 'international', created_at: `2026-11-0${id.length}T00:00:00Z`, deleted_at: null, id, language: 'pt', ...fields});
const RATES = {brlPerUsd: 5};
const EURO = {brlPerEur: 6};
const priced = (usd, eur) => ({
	id: 'sv10-001',
	variants_detailed: [{
		pricing: {
			cardmarket: eur === null ? undefined : {avg: eur, idProduct: 1, trend: eur, unit: 'EUR', updated: '2026-11-20T00:00:00Z'},
			tcgplayer: usd === null ? undefined : {normal: {marketPrice: usd, productId: 1}, unit: 'USD', updated: '2026-11-20T00:00:00Z'},
		},
		type: 'normal',
		variantId: 'n1',
	}],
});

describe('shopGroups', () => {
	test('lists only cards with spares, one group per card and language, keeper among the copies', () => {
		const cards = [
			copy('a'), copy('bb'), copy('ccc'),
			copy('d', {language: 'en'}),
			copy('e', {card_id: 'sv10-002'}),
			copy('f', {deleted_at: '2026-11-10T00:00:00Z'}),
		];
		const groups = shopGroups(cards);

		assert.equal(groups.length, 1, 'one EN copy and one sv10-002 copy are keepers only');
		assert.equal(groups[0].key, 'international|sv10-001|pt');
		assert.equal(groups[0].spares.length, 2);
		assert.deepEqual(groups[0].copies.map((entry) => entry.id).sort(), ['a', 'bb', 'ccc'], 'a removed copy is left out');
		assert.equal(groups[0].set_id, 'sv10');
	});

	test('the price is the spares\' first, else any copy\'s', () => {
		const [group] = shopGroups([copy('a', {sale_price: 3}), copy('bb'), copy('ccc')]);

		assert.equal(group.price, 3, 'the keeper holds it while the spares do not yet');
		assert.equal(groupPrice({copies: [], spares: [copy('x', {sale_price: 0})]}), null, 'zero is no price');
	});
});

describe('salePrice and roundUpToStep', () => {
	test('reads a positive amount to the cent only', () => {
		assert.equal(salePrice({sale_price: 2.345}), 2.35);
		assert.equal(salePrice({sale_price: '2'}), null);
		assert.equal(salePrice({sale_price: -1}), null);
		assert.equal(salePrice(null), null);
	});

	test('rounds up to the next R$ 0,50, never below it', () => {
		assert.deepEqual([2.1, 2.5, 2.5000000001, 0.2, 10.01].map((brl) => roundUpToStep(brl)), [2.5, 2.5, 2.5, 0.5, 10.5]);
		assert.equal(roundUpToStep(null), null);
		assert.equal(roundUpToStep(0), null);
	});
});

describe('pricePatches and undoPricePatches', () => {
	test('prices every copy, keeper included, and skips copies already right', () => {
		const groups = shopGroups([copy('a', {sale_price: 5}), copy('bb'), copy('ccc')]);
		const patches = pricePatches(groups, 5);

		assert.deepEqual(patches.map((patch) => patch.id).sort(), ['bb', 'ccc']);
		assert.deepEqual(patches[0].patch, {sale_price: 5});
	});

	test('clears with null, and Undo puts each copy back', () => {
		const groups = shopGroups([copy('a', {sale_price: 5}), copy('bb', {sale_price: 4}), copy('ccc')]);
		const patches = pricePatches(groups, null);

		assert.deepEqual(patches.map((patch) => [patch.id, patch.patch.sale_price]).sort(), [['a', null], ['bb', null]]);
		assert.deepEqual(undoPricePatches(groups, patches).map((patch) => [patch.id, patch.patch.sale_price]).sort(), [['a', 5], ['bb', 4]]);
	});
});

describe('suggestion', () => {
	const group = () => shopGroups([copy('a', {variant_id: 'n1'}), copy('bb', {variant_id: 'n1'})])[0];

	test('converts both markets and Use takes the higher, rounded up', () => {
		const found = suggestion(group(), priced(1, 0.5), {euroRates: EURO, rates: RATES});

		assert.deepEqual(found, {cardmarket: 3, tcgplayer: 5, use: 5});
		assert.equal(suggestion(group(), priced(0.42, 0.5), {euroRates: EURO, rates: RATES}).use, 3, 'R$ 2,10 against R$ 3,00');
		assert.equal(suggestion(group(), priced(0.43, null), {rates: RATES}).use, 2.5, 'R$ 2,15 is R$ 2,50');
	});

	test('gives none without a record, without a rate, or for an Asian print', () => {
		assert.deepEqual(suggestion(group(), null, {rates: RATES}), {cardmarket: null, tcgplayer: null, use: null});
		assert.deepEqual(suggestion(group(), priced(1, null), {}), {cardmarket: null, tcgplayer: null, use: null});

		const japanese = shopGroups([copy('a', {catalog: 'ja', language: 'ja'}), copy('bb', {catalog: 'ja', language: 'ja'})])[0];

		assert.equal(suggestion(japanese, priced(1, 1), {euroRates: EURO, rates: RATES}).use, null);
	});
});

describe('priceFilter and shopTotals', () => {
	const groups = [
		{copies: [], price: 2, spares: [{}, {}]},
		{copies: [], price: null, spares: [{}]},
		{copies: [], price: 1.5, spares: [{}]},
	];

	test('filters priced and not priced', () => {
		assert.equal(priceFilter(groups, 'all').length, 3);
		assert.equal(priceFilter(groups, 'unpriced').length, 1);
		assert.equal(priceFilter(groups, 'priced').length, 2);
	});

	test('counts cards, spares, and what the priced spares bring', () => {
		assert.deepEqual(shopTotals(groups), {groups: 3, priced: 2, spares: 4, value: 5.5});
	});
});

describe('publishing', () => {
	test('a picture path is the TCGdex path under tcgdex/, and nothing else is one', () => {
		assert.equal(storePicturePath('https://assets.tcgdex.net/pt/sv/sv10/001'), 'tcgdex/pt/sv/sv10/001.webp');
		assert.equal(storePicturePath('https://assets.tcgdex.net/zh-tw/sv/sv10/001/'), 'tcgdex/zh-tw/sv/sv10/001.webp');
		assert.equal(storePicturePath('https://example.test/pt/sv/sv10/001'), null);
		assert.equal(storePicturePath('https://assets.tcgdex.net/pt/sv10/001'), null);
		assert.equal(storePicturePath('https://assets.tcgdex.net/pt/sv/../001/x'), null);
		assert.equal(storePicturePath(null), null);
	});

	test('rows are the spares of priced cards only, never the keeper', () => {
		const [group] = shopGroups([copy('a', {condition: 'Near Mint'}), copy('bb', {condition: 'Played'}), copy('ccc')]);
		const priced = {...group, info: {name: 'Bulbasaur', number: '001', setName: 'Rivais'}, picturePath: 'tcgdex/pt/sv/sv10/001.webp', price: 2.5, rarity: 'Common'};

		assert.deepEqual(listingRows([{...group, price: null}]), []);

		const rows = listingRows([priced], {finishOf: (entry) => (entry.id === 'bb' ? 'Reverse Holo' : null)});

		assert.deepEqual(rows.map((row) => row.id).sort(), ['bb', 'ccc']);
		assert.deepEqual(rows.find((row) => row.id === 'bb'), {
			card_id: 'sv10-001', catalog: 'international', condition: 'Played', finish: 'Reverse Holo', id: 'bb', image_path: 'tcgdex/pt/sv/sv10/001.webp',
			language: 'pt', name: 'Bulbasaur', number: '001', price_brl: 2.5, rarity: 'Common', set_name: 'Rivais',
		});
		assert.equal('image_path' in listingRows([{...priced, picturePath: null}])[0], false, 'left out, so the stored picture is kept');
		assert.equal(listingRows([{...priced, info: {}}])[0].name, 'sv10-001', 'a name is never empty');
	});

	test('a card is published, reserved, or pending by its spares', () => {
		const group = {price: 2, spares: [{id: 'x'}, {id: 'y'}]};

		assert.equal(groupMark({...group, price: null}, {}), null);
		assert.equal(groupMark(group, {}), 'pending');
		assert.equal(groupMark(group, {x: {status: 'available'}, y: {status: 'available'}}), 'published');
		assert.equal(groupMark(group, {x: {status: 'available'}}), 'pending');
		assert.equal(groupMark(group, {x: {status: 'reserved'}, y: {status: 'available'}}), 'reserved');
	});
});
