// The Shop audit (js/shop-audit.js) and the listing invariant it reads
// (js/listing-invariant.js listingProblems), on the invented collection of
// tests/fixtures/collection-shape.mjs. No browser, no network: the
// listings come from a stand-in client.
//
// Run: node --test tests/shop-audit.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {listingProblems} from '../js/listing-invariant.js';
import {AUDIT_REASONS, auditGroups, auditRows, readLiveListings, readOpenOrderIds} from '../js/shop-audit.js';
import {collectionShape} from './fixtures/collection-shape.mjs';

const listing = (id, fields = {}) => ({card_id: 'zz1-001', catalog: 'international', finish: '', id, image_path: null, kind: 'single', language: 'pt', name: `Card ${id}`, number: '001', price_brl: 2, set_name: 'Invented Set', ...fields});

describe('listingProblems', () => {
	test('missing, held, and last, each by its own rule', () => {
		const doc = collectionShape();
		const problems = listingProblems(doc, ['m2', 'm4', 'u1', 'u2', 't1', 't2', 'h1', 'h2', 'p2', 'r1', 'r2', 'gone', 'nowhere', 'o2']);

		assert.deepEqual(Object.fromEntries(problems), {
			gone: 'missing',
			h1: 'held',
			m4: 'last',
			nowhere: 'missing',
			p2: 'held',
			// r1 and r2 are the card's only copies, both in a tray: listing
			// both would leave none at home.
			r2: 'last',
			t1: 'held',
			t2: 'held',
			u1: 'last',
			u2: 'last',
		});
	});

	test('a copy marked For sale is offered wherever it is, so only missing counts', () => {
		const doc = collectionShape();

		assert.deepEqual([...listingProblems(doc, ['s1'])], [], 'the last copy, marked For sale');
		doc.cards.find((entry) => entry.id === 'h1').for_sale = true;
		assert.deepEqual([...listingProblems(doc, ['h1'])], [], 'in a pocket, marked For sale');
	});

	test('an empty or missing document leaves every listing missing', () => {
		assert.deepEqual(Object.fromEntries(listingProblems(null, ['a'])), {a: 'missing'});
		assert.deepEqual([...listingProblems(collectionShape(), [])], []);
	});
});

describe('auditRows', () => {
	test('lists only the listings that break the rule, missing first, with the copy and the reason', () => {
		const rows = auditRows(collectionShape(), [listing('m2'), listing('m4'), listing('t1', {card_id: 'zz1-004', number: '004'}), listing('gone', {card_id: 'zz1-005', number: '005'})]);

		assert.deepEqual(rows.map((row) => [row.listing.id, row.reason, row.entry && row.entry.id]), [['gone', 'missing', null], ['t1', 'held', 't1'], ['m4', 'last', 'm4']]);
		assert.equal(rows[0].text, AUDIT_REASONS.missing);
		assert.equal(rows[2].text, 'The only copy of this card in this language and finish.');
	});

	test('every listing passes on spares alone', () => {
		assert.deepEqual(auditRows(collectionShape(), [listing('m2'), listing('m3'), listing('i2'), listing('s1')]), []);
	});
});

describe('readLiveListings', () => {
	test('reads store_catalog and keeps the singles', async () => {
		const calls = [];
		const client = {rpc: async (name) => {
			calls.push(name);

			return {data: [listing('m2'), listing('kit', {kind: 'sealed'}), listing('c', {kind: 'consigned'})], error: null};
		}};

		assert.deepEqual((await readLiveListings(client)).map((row) => row.id), ['m2']);
		assert.deepEqual(calls, ['store_catalog']);
	});

	test('a failed read throws with the server\'s words', async () => {
		await assert.rejects(readLiveListings({rpc: async () => ({data: null, error: {message: 'offline'}})}), /offline/);
	});
});

describe('auditGroups (v128 review M3)', () => {
	const two = () => ({binder_picks: [], binders: [], cards: [
		{card_id: 'zz9-001', catalog: 'international', created_at: '2026-11-01T00:00:00Z', id: 'x1', language: 'en'},
		{card_id: 'zz9-001', catalog: 'international', created_at: '2026-11-02T00:00:00Z', id: 'x2', language: 'en'},
		{card_id: 'zz9-001', catalog: 'international', created_at: '2026-11-03T00:00:00Z', id: 'x3', language: 'en'},
	]});

	test('a reserved copy counts as out, so the breach shows, once per finish', () => {
		const listings = [listing('x1', {card_id: 'zz9-001', language: 'en'}), listing('x3', {card_id: 'zz9-001', language: 'en'})];

		assert.deepEqual(auditGroups(two(), listings), [], 'without the orders, the defect: every listing passes');

		const groups = auditGroups(two(), listings, ['x2']);

		assert.equal(groups.length, 1);
		assert.deepEqual(groups[0].reasons, ['last']);
		assert.equal(groups[0].text, '3 of 3 copies are out.');
	});

	test('two listed copies of a pair are one row: "2 of 2 copies are out"', () => {
		const doc = two();

		doc.cards.pop();

		const groups = auditGroups(doc, [listing('x1', {card_id: 'zz9-001', language: 'en'}), listing('x2', {card_id: 'zz9-001', language: 'en'})]);

		assert.equal(groups.length, 1);
		assert.equal(groups[0].text, '2 of 2 copies are out.');
	});

	test('a live copy of a favorite card, or one set Not for sale, is flagged (QA shop 5)', () => {
		const doc = two();
		const listings = [listing('x2', {card_id: 'zz9-001', language: 'en'})];

		assert.deepEqual(auditGroups(doc, listings), []);
		doc.cards[0].is_favorite = true;
		assert.deepEqual(auditGroups(doc, listings).map((group) => group.reasons), [['kept']]);
		doc.cards[0].is_favorite = false;
		doc.cards[1].for_sale = false;
		assert.deepEqual(auditGroups(doc, listings).map((group) => group.reasons), [['kept']]);
	});

	test('reads the copy ids of open orders, cards only', async () => {
		const client = {rpc: async (name) => ({data: name === 'store_orders_open' ? [{items: [{kind: 'single', listing_id: 'x2'}, {kind: 'sealed', listing_id: 's1'}]}] : null, error: null})};

		assert.deepEqual([...await readOpenOrderIds(client)], ['x2']);
		await assert.rejects(readOpenOrderIds({rpc: async () => ({data: null, error: {message: 'nope'}})}), /nope/);
	});
});
