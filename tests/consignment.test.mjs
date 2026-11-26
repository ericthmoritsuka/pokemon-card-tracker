// Consignment's numbers and words (js/consignment.js,
// plans/hotaru-consignment-plan.md): the commission rounded to the centavo
// as supabase/store-consignment.sql's private.commission rounds it, the
// terms a new card takes, reading a percent, the statement sent to a
// consignor, and the record save_consigned takes. No browser.
//
// Run: node --test tests/consignment.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {commission, consignedRecord, ownersByListing, parsePercent, split, statementText, termsFor, termsText, toCents} from '../js/consignment.js';
import {formatBrl} from '../js/prices.js';

describe('commission', () => {
	test('matches the SQL check, centavo for centavo', () => {
		// The same cases tests/store-consignment-sql-check.sql runs.
		assert.equal(commission(100, 15, 5), 15);
		assert.equal(commission(20, 15, 5), 5);
		assert.equal(commission(33.33, 15, 5), 5);
		assert.equal(commission(40, 15, 5), 6);
		assert.equal(commission(4, 15, 5), 4);
		assert.equal(commission(50, 15, 10), 10);
		assert.equal(commission(10.05, 15, 0), 1.51);
	});

	test('rounds half up where floating point would not', () => {
		// 333,33 × 15% is 49,9995, which a float rounds down.
		assert.equal(commission(333.33, 15, 0), 50);
		assert.equal(commission(0.1 + 0.2, 50, 0), 0.15);
		assert.equal(commission(99.99, 12.5, 0), 12.5);
	});

	test('nothing on no price', () => {
		assert.equal(commission(0, 15, 5), 0);
		assert.equal(commission(null, 15, 5), 0);
	});

	test('split adds up to the price', () => {
		assert.deepEqual(split(100, 15, 5), {commission: 15, payout: 85, price: 100});
		assert.deepEqual(split(20, 15, 5), {commission: 5, payout: 15, price: 20});
		assert.deepEqual(split(4, 15, 5), {commission: 4, payout: 0, price: 4});
	});

	test('toCents reads both decimal marks', () => {
		assert.equal(toCents('12,50'), 1250);
		assert.equal(toCents('12.5'), 1250);
		assert.equal(toCents(''), null);
		assert.equal(toCents('abc'), null);
	});
});

describe('terms', () => {
	const settings = {commission_pct: 15, min_commission_brl: 5};

	test('typed, else the consignor\'s, else the shop\'s', () => {
		assert.deepEqual(termsFor({commission_pct: null, min_commission_brl: null}, settings), {commission_pct: 15, min_commission_brl: 5});
		assert.deepEqual(termsFor({commission_pct: 10, min_commission_brl: 3}, settings), {commission_pct: 10, min_commission_brl: 3});
		assert.deepEqual(termsFor({commission_pct: 10, min_commission_brl: null}, settings, {commission_pct: 20}), {commission_pct: 20, min_commission_brl: 5});
		assert.deepEqual(termsFor(null, settings, {min_commission_brl: 0}), {commission_pct: 15, min_commission_brl: 0}, 'a typed zero is kept');
	});

	test('termsText', () => {
		const brl = (value) => `R$ ${value.toFixed(2).replace('.', ',')}`;

		assert.equal(termsText({commission_pct: 15, min_commission_brl: 5}, brl), '15%, at least R$ 5,00');
		assert.equal(termsText({commission_pct: 12.5, min_commission_brl: 0}, brl), '12,5%');
	});

	test('parsePercent', () => {
		assert.deepEqual(parsePercent('15'), {error: null, value: 15});
		assert.deepEqual(parsePercent('12,5%'), {error: null, value: 12.5});
		assert.deepEqual(parsePercent(''), {error: null, value: null});
		assert.equal(parsePercent('95').error, 'Type a percent from 0 to 90.');
		assert.equal(parsePercent('x').error, 'Type a percent from 0 to 90.');
	});
});

describe('statement', () => {
	const ana = {id: 'a', name: 'Ana'};
	const data = {
		cards: [
			{consignor_id: 'a', id: 'cons-1', name: 'Charizard', number: '4', price_brl: 100, status: 'sold'},
			{consignor_id: 'a', id: 'cons-2', name: 'Pikachu', number: '58', price_brl: 20, status: 'sold'},
			{consignor_id: 'a', id: 'cons-3', name: 'Venusaur', number: '15', price_brl: 40, status: 'available'},
			{consignor_id: 'a', id: 'cons-4', name: 'Mew', number: null, price_brl: 30, returned_at: '2026-11-20T12:00:00Z', status: 'withdrawn'},
			{consignor_id: 'b', id: 'cons-5', name: 'Blastoise', number: '2', price_brl: 50, status: 'available'},
		],
		consignors: [ana, {id: 'b', name: 'Bia'}],
		payouts: [
			{consignor_id: 'a', listing_id: 'cons-1', paid_at: '2026-11-26T15:00:00Z', payout_brl: 85, sale_brl: 100, state: 'paid'},
			{consignor_id: 'a', listing_id: 'cons-2', paid_at: null, payout_brl: 15, sale_brl: 20, state: 'due'},
		],
	};

	test('lists each kind of card and the balances, in Portuguese', () => {
		const text = statementText(ana, data, {brl: formatBrl, now: new Date('2026-11-26T18:00:00Z')});

		assert.equal(text, [
			'HOTARU · Extrato de Ana · 26/11/2026',
			'À venda (1): Venusaur #15 R$ 40,00',
			'Vendidas (2): Charizard #4 R$ 100,00, repasse R$ 85,00 (pago 26/11); Pikachu #58 R$ 20,00, repasse R$ 15,00 (a pagar)',
			'Devolvidas (1): Mew',
			'A receber: R$ 15,00',
			'Já recebido: R$ 85,00',
		].join('\n'));
		assert.doesNotMatch(text, /[  ]/, 'plain spaces only');
		assert.doesNotMatch(text, /Blastoise/, 'only Ana\'s cards');
	});

	test('ownersByListing names each card\'s consignor', () => {
		const owners = ownersByListing(data);

		assert.equal(owners.get('cons-1'), 'Ana');
		assert.equal(owners.get('cons-5'), 'Bia');
		assert.equal(owners.get('nope'), undefined);
	});
});

describe('consignedRecord', () => {
	test('takes the print and what was typed, trimmed and capped', () => {
		const record = consignedRecord(
			{card_id: 'base1-4', catalog: 'international', language: 'en', name: ' Charizard ', number: '4', rarity: 'Rare Holo', set_name: 'Base'},
			{commission_pct: 15, condition: 'Near Mint', consignor_id: 'a', finish: 'Holo', min_commission_brl: 5, note: '', price_brl: 100}
		);

		assert.deepEqual(record, {
			card_id: 'base1-4',
			catalog: 'international',
			commission_pct: 15,
			condition: 'Near Mint',
			consignor_id: 'a',
			finish: 'Holo',
			language: 'en',
			min_commission_brl: 5,
			name: 'Charizard',
			note: null,
			number: '4',
			price_brl: 100,
			rarity: 'Rare Holo',
			set_name: 'Base',
		});
	});

	test('an edit keeps the ID, and a picture path only when given', () => {
		const record = consignedRecord({card_id: 'x', id: 'cons-1', name: 'X'}, {consignor_id: 'a', image_path: 'tcgdex/en/a/b/1.webp', price_brl: 5});

		assert.equal(record.id, 'cons-1');
		assert.equal(record.image_path, 'tcgdex/en/a/b/1.webp');
		assert.equal('image_path' in consignedRecord({card_id: 'x', name: 'X'}, {price_brl: 5}), false);
	});
});
