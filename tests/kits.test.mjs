// Kits' numbers and choices (js/kits.js, plans/hotaru-bundles-plan.md): the
// price from a typed price or a percent, rounded down to the centavo as
// supabase/store-bundles.sql does; the percent a typed price works out to;
// reading a percent; which copy a card gives a kit; the refill on Publish;
// and an order's cards grouped by kit. No browser.
//
// Run: node --test tests/kits.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {copiesInKits, groupOfItem, kitDefaultName, kitNamesHolding, kitNamesText, kitPrice, kitRecord, kitSum, orderGroups, parsePercent, percentOff, pickCopy, refillKit} from '../js/kits.js';

const copy = (id, condition, created = '2026-11-01') => ({condition, created_at: `${created}T00:00:00Z`, id});
const group = (cardId, listed, fields = {}) => ({card_id: cardId, catalog: 'international', key: `${cardId}|en|`, language: 'en', listed, price: 5, ...fields});

describe('kitPrice', () => {
	test('a percent off the sum, rounded down to the centavo', () => {
		assert.equal(kitPrice({discount_pct: 5, price_mode: 'percent'}, 15), 14.25);
		assert.equal(kitPrice({discount_pct: 7.5, price_mode: 'percent'}, 10), 9.25);
		// 3 × 3,33 = 9,99 at 5% is 9,4905: down to 9,49, never up.
		assert.equal(kitPrice({discount_pct: 5, price_mode: 'percent'}, kitSum([3.33, 3.33, 3.33])), 9.49);
		assert.equal(kitPrice({discount_pct: 90, price_mode: 'percent'}, 0.05), 0.01);
	});

	test('a typed price is the price, even above the sum', () => {
		assert.equal(kitPrice({price_brl: 12, price_mode: 'fixed'}, 15), 12);
		assert.equal(kitPrice({price_brl: 20, price_mode: 'fixed'}, 15), 20);
		assert.equal(kitPrice({price_brl: null, price_mode: 'fixed'}, 15), null);
	});

	test('the sum adds centavos without float drift', () => {
		assert.equal(kitSum([0.1, 0.2]), 0.3);
		assert.equal(kitSum([5, 5, 5]), 15);
	});
});

describe('percentOff and parsePercent', () => {
	test('the percent a typed price works out to, rounded down', () => {
		assert.equal(percentOff(14.25, 15), 5);
		assert.equal(percentOff(14, 15), 6);
		assert.equal(percentOff(9, 10), 10, 'no float drift');
		assert.equal(percentOff(15, 15), null);
		assert.equal(percentOff(16, 15), null);
	});

	test('a percent is 1 to 90 with one decimal', () => {
		assert.deepEqual(parsePercent('5'), {error: null, value: 5});
		assert.deepEqual(parsePercent(' 5 % '), {error: null, value: 5});
		assert.deepEqual(parsePercent('7,5'), {error: null, value: 7.5});
		assert.deepEqual(parsePercent(''), {error: null, value: null});
		assert.ok(parsePercent('0').error);
		assert.ok(parsePercent('91').error);
		assert.ok(parsePercent('7,55').error);
		assert.ok(parsePercent('abc').error);
	});
});

describe('pickCopy', () => {
	const spr = group('mep-001', [copy('a', 'Lightly Played'), copy('b', 'Near Mint', '2026-11-03'), copy('c', 'Near Mint', '2026-11-02')]);

	test('the best condition, then the oldest', () => {
		assert.equal(pickCopy(spr).id, 'c');
	});

	test('skips copies other kits hold and copies not for sale now', () => {
		assert.equal(pickCopy(spr, {skip: new Set(['c'])}).id, 'b');
		assert.equal(pickCopy(spr, {states: {b: {status: 'available'}, c: {status: 'reserved'}}}).id, 'b');
		assert.equal(pickCopy(spr, {skip: new Set(['a', 'b', 'c'])}), null);
	});

	test('keeps the condition asked for when refilling', () => {
		assert.equal(pickCopy(spr, {prefer: 'Lightly Played'}).id, 'a');
	});
});

describe('refillKit', () => {
	const finishText = (one) => one.finish || null;
	const groups = [
		group('mep-001', [copy('s1', 'Near Mint'), copy('s2', 'Near Mint', '2026-11-05')]),
		group('mep-002', [copy('f2', 'Lightly Played')]),
		group('mep-003', [copy('q1', 'Near Mint')]),
	];
	const kit = {id: 'k', items: [
		{card_id: 'mep-001', condition: 'Near Mint', language: 'en', listing_id: 's1', name: 'Sprigatito', status: 'sold'},
		{card_id: 'mep-002', condition: 'Near Mint', language: 'en', listing_id: 'f1', name: 'Fuecoco', status: 'sold'},
		{card_id: 'mep-003', condition: 'Near Mint', language: 'en', listing_id: 'q1', name: 'Quaxly', status: 'available'},
	]};

	test('a sold copy takes another of the same card; an available one stays', () => {
		const result = refillKit(kit, groups, {finishText});

		assert.deepEqual(result, {changed: true, items: ['s2', 'f2', 'q1'], missing: []});
	});

	test('a card with no other copy keeps its old one and is named', () => {
		const result = refillKit(kit, groups, {finishText, skip: new Set(['f2'])});

		assert.deepEqual(result, {changed: true, items: ['s2', 'f1', 'q1'], missing: ['Fuecoco']});
	});

	test('an unpriced card is not listed, so it fills nothing', () => {
		const result = refillKit(kit, groups.map((one) => (one.card_id === 'mep-002' ? {...one, price: null} : one)), {finishText});

		assert.deepEqual(result.missing, ['Fuecoco']);
	});

	test('nothing to do when every copy is available', () => {
		const whole = {...kit, items: kit.items.map((item) => ({...item, status: 'available'}))};

		assert.deepEqual(refillKit(whole, groups, {finishText}), {changed: false, items: ['s1', 'f1', 'q1'], missing: []});
	});

	test('the group of a sold copy is found by card, language, and finish', () => {
		const foil = [group('mep-001', [copy('r1', 'Near Mint')], {finish: 'Reverse Holo'}), ...groups];

		assert.equal(groupOfItem({card_id: 'mep-001', finish: 'Reverse Holo', language: 'en', listing_id: 'gone'}, foil, finishText).listed[0].id, 'r1');
		assert.equal(groupOfItem({card_id: 'mep-001', finish: null, language: 'en', listing_id: 'gone'}, foil, finishText).listed[0].id, 's1');
		assert.equal(groupOfItem({card_id: 'mep-001', finish: null, language: 'ja', listing_id: 'gone'}, foil, finishText), null);
	});

	test('copiesInKits leaves out the kit named', () => {
		const other = {id: 'o', items: [{listing_id: 'x'}]};

		assert.deepEqual([...copiesInKits([kit, other], {except: 'k'})], ['x']);
	});
});

describe('kitRecord, kitDefaultName, orderGroups', () => {
	test('a record carries only its mode\'s number', () => {
		assert.deepEqual(kitRecord({discount: 5, items: ['a', 'b'], mode: 'percent', name: ' Trio ', price: 9}), {active: true, description: null, discount_pct: 5, id: null, items: ['a', 'b'], name: 'Trio', price_brl: null, price_mode: 'percent'});
		assert.equal(kitRecord({discount: 5, items: [], mode: 'fixed', name: 'T', price: 9}).discount_pct, null);
	});

	test('the default name joins the cards and fits 80 characters', () => {
		assert.equal(kitDefaultName(['Sprigatito', 'Fuecoco', 'Quaxly']), 'Sprigatito + Fuecoco + Quaxly');
		assert.equal(kitDefaultName(Array(20).fill('Charizard ex')).length, 80);
	});

	test('an order lists singles, and each kit\'s cards under it with the kit\'s price', () => {
		const groups = orderGroups([
			{listing_id: 'x', name: 'Pikachu', price_brl: 9},
			{bundle_id: 'k', bundle_name: 'Trio', listing_id: 's', price_brl: 4.75},
			{bundle_id: 'k', bundle_name: 'Trio', listing_id: 'f', price_brl: 4.75},
			{bundle_id: 'k', bundle_name: 'Trio', listing_id: 'q', price_brl: 4.75},
		]);

		assert.equal(groups.length, 2);
		assert.equal(groups[0].kind, 'single');
		assert.equal(groups[1].name, 'Trio');
		assert.equal(groups[1].price, 14.25);
		assert.equal(groups[1].items.length, 3);
	});
});

describe('kitNamesHolding and kitNamesText', () => {
	const kits = [
		{active: true, items: [{listing_id: 'a'}, {listing_id: 'b'}], name: 'Trio'},
		{active: false, items: [{listing_id: 'a'}], name: 'Off'},
		{active: true, items: [{listing_id: 'c'}], name: 'Duo'},
		{active: true, items: [{listing_id: 'b'}], name: 'Trio'},
	];

	test('only kits that are on and hold a copy asked about, each name once', () => {
		assert.deepEqual(kitNamesHolding(kits, ['a']), ['Trio']);
		assert.deepEqual(kitNamesHolding(kits, ['b', 'c']), ['Trio', 'Duo']);
		assert.deepEqual(kitNamesHolding(kits, ['z']), []);
		assert.deepEqual(kitNamesHolding(null, ['a']), []);
	});

	test('names read as a phrase', () => {
		assert.equal(kitNamesText([]), '');
		assert.equal(kitNamesText(['Trio']), 'kit Trio');
		assert.equal(kitNamesText(['Trio', 'Duo', 'Uno']), 'kits Trio, Duo and Uno');
	});
});
