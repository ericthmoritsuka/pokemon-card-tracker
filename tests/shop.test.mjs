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
	hasCards,
	listingRows,
	orderCheck,
	priceFilter,
	pricePatches,
	roundUpToStep,
	saleFields,
	salePrice,
	shopGroups,
	shopTotals,
	storePicturePath,
	suggestion,
	timeLeft,
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

	test('a copy in a binder is never listed (Eric, 2026-11-24)', () => {
		const cards = [copy('a'), copy('bb'), copy('ccc')];
		const [group] = shopGroups(cards, {held: new Set(['a', 'ccc'])});

		assert.deepEqual(group.spares.map((entry) => entry.id), ['bb'], 'three copies, two in binders: one for sale');
		assert.deepEqual(group.copies.map((entry) => entry.id).sort(), ['a', 'bb', 'ccc'], 'the price still goes on every copy');
		assert.deepEqual(shopGroups(cards, {held: new Set(['a', 'bb', 'ccc'])}), [], 'all in binders: nothing for sale');
		assert.deepEqual(shopGroups([copy('a'), copy('bb', {is_favorite: true}), copy('ccc')]), [], 'a favorite card: nothing for sale (Eric, 2026-11-24)');
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

describe('orders', () => {
	const order = {code: 'HTR-0007', id: 'order-uuid', items: [{listing_id: 'a', price_brl: 2}, {listing_id: 'bb', price_brl: 3}], name: 'Ana', total: '5.00'};

	test('time left rounds up to the minute, and says Expired past it', () => {
		const now = Date.parse('2026-11-24T12:00:00Z');

		assert.equal(timeLeft('2026-11-26T11:30:00Z', now), '47 h left');
		assert.equal(timeLeft('2026-11-24T12:35:00Z', now), '35 min left');
		assert.equal(timeLeft('2026-11-24T12:00:30Z', now), '1 min left');
		assert.equal(timeLeft('2026-11-24T11:59:00Z', now), 'Expired');
		assert.equal(timeLeft('nonsense', now), 'Expired');
	});

	test('an order names the copies no longer live here, and whether its sale is logged', () => {
		const doc = {cards: [copy('a'), copy('bb', {deleted_at: '2026-11-20T00:00:00Z'})], moves: []};

		assert.deepEqual(orderCheck(order, doc), {logged: false, missing: ['bb']});
		assert.equal(orderCheck(order, {...doc, moves: [{id: 'order-uuid'}]}).logged, true);
		assert.equal(orderCheck(order, {...doc, moves: [{deleted_at: 'x', id: 'order-uuid'}]}).logged, false, 'an undone sale is not logged');
		assert.deepEqual(orderCheck(order, null), {logged: false, missing: ['a', 'bb']});
	});

	test('the sale takes the order\'s copies, buyer, total, and code', () => {
		assert.deepEqual(saleFields(order, {now: new Date(2026, 10, 24, 15)}), {
			currency: 'BRL', date: '2026-11-24', kind: 'sold', note: 'HOTARU HTR-0007', out: ['a', 'bb'], price: 5, who: 'Ana',
		});
	});
});

describe('orders with sealed products', () => {
	const mixed = {code: 'HTR-0009', id: 'o9', items: [
		{kind: 'single', listing_id: 'a', price_brl: 2},
		{card_id: 'p1', kind: 'sealed', listing_id: 'sealed-1', name: 'Booster Box', price_brl: 900},
		{card_id: 'p1', kind: 'sealed', listing_id: 'sealed-2', name: 'Booster Box', price_brl: 900},
		{card_id: 'p2', kind: 'sealed', listing_id: 'sealed-3', name: 'ETB', price_brl: 300},
	], name: 'Gil', total: 2102};
	const sealedOnly = {code: 'HTR-0010', id: 'o10', items: [{card_id: 'p2', kind: 'sealed', listing_id: 'sealed-4', name: 'ETB', price_brl: 300}], name: 'Rui', total: 300};

	test('a sealed product is never missing from the collection, and an order of them alone counts as logged', () => {
		const doc = {cards: [copy('a')], moves: []};

		assert.deepEqual(orderCheck(mixed, doc), {logged: false, missing: []});
		assert.deepEqual(orderCheck(sealedOnly, doc), {logged: true, missing: []});
		assert.equal(hasCards(mixed), true);
		assert.equal(hasCards(sealedOnly), false);
	});

	test('the sale of a mixed order takes the cards only, at their price, and names the sealed products', () => {
		const fields = saleFields(mixed, {now: new Date(2026, 10, 24)});

		assert.deepEqual([fields.out, fields.price, fields.note], [['a'], 2, 'HOTARU HTR-0009, with 2× Booster Box, ETB']);
	});

	test('an item with no kind, from an older order call, is a card', () => {
		assert.deepEqual(orderCheck({id: 'x', items: [{listing_id: 'gone'}]}, {cards: [], moves: []}).missing, ['gone']);
	});
});
