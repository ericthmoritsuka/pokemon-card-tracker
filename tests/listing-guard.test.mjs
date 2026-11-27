// The listing guard (js/listing-guard.js, QA shop 4): which priced copies
// stop being free to sell after a change. Invented cards; no network.
//
// Run: node --test tests/listing-guard.test.mjs

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {leftSale, sellableIds} from '../js/listing-guard.js';

const copy = (id, fields = {}) => ({card_id: 'zz1-001', catalog: 'international', created_at: `2026-11-0${id.slice(-1)}T00:00:00Z`, id, language: 'en', sale_price: 2, ...fields});
const doc = (cards, binders = []) => ({binder_picks: [], binders, cards});

test('sold, deleted, held, starred, or Not for sale: each copy leaves sale', () => {
	const before = sellableIds(doc([copy('c1'), copy('c2'), copy('c3'), copy('c4')]));

	assert.deepEqual([...before].sort(), ['c2', 'c3', 'c4']);
	assert.deepEqual(leftSale(before, sellableIds(doc([copy('c1'), copy('c2', {deleted_at: '2026-11-27T00:00:00Z'}), copy('c3'), copy('c4')]))), ['c2'], 'deleted or sold');
	assert.deepEqual(leftSale(before, sellableIds(doc([copy('c1'), copy('c2'), copy('c3', {for_sale: false}), copy('c4')]))), ['c3'], 'Not for sale');
	assert.deepEqual(leftSale(before, sellableIds(doc([copy('c1', {is_favorite: true}), copy('c2', {is_favorite: true}), copy('c3', {is_favorite: true}), copy('c4', {is_favorite: true})]))).sort(), ['c2', 'c3', 'c4'], 'starred');

	const pocket = [{cols: 3, id: 'b', name: 'B', page_count: 1, rows: 3, slots: [{entry_id: 'c4', page: 1, position: 1}]}];

	assert.deepEqual(leftSale(before, sellableIds(doc([copy('c1'), copy('c2'), copy('c3'), copy('c4')], pocket))), ['c4'], 'in a pocket (the pocket copy is now kept)');
});

test('an unpriced copy is never asked about', () => {
	assert.deepEqual([...sellableIds(doc([copy('c1', {sale_price: null}), copy('c2', {sale_price: null})]))], []);
});
