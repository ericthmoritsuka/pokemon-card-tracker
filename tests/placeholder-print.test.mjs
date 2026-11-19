// Unit tests for printing placeholders (js/placeholder-print.js; from a
// survey of other binder apps, 2026-11-19): which pockets print (a
// placeholder, a Gone pocket, a list pocket not owned; filled ones only when
// asked), in binder order, on the pages chosen, and nine to a sheet. Plain
// Node, invented data, nothing requested.
//
// Run: node --test tests/placeholder-print.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {
	PER_SHEET,
	artworkUrl,
	choosePockets,
	handPocketStatus,
	listPocketStatus,
	pagesText,
	pocketText,
	printablePockets,
	sheetsOf,
	summaryText,
} from '../js/placeholder-print.js';

const live = new Set(['c1', 'c2']);
const isLive = (id) => live.has(id);

describe('Which pockets print', () => {
	test('a hand-made pocket: placeholders and Gone pockets are to fill; a copy owned is filled; the rest print nothing', () => {
		assert.equal(handPocketStatus({entry_id: 'c1', page: 1, position: 1}, isLive), 'filled');
		assert.equal(handPocketStatus({entry_id: 'sold', page: 1, position: 2}, isLive), 'want', 'a Gone pocket is empty in the real binder');
		assert.equal(handPocketStatus({page: 1, position: 3, want: {card_id: 'tst9-001', name: 'Inventmon'}}, isLive), 'want');
		assert.equal(handPocketStatus({page: 1, position: 4, want: {card_id: null, dex: 25, name: 'Pikachu'}}, isLive), 'want');
		assert.equal(handPocketStatus({empty: true, page: 1, position: 5}, isLive), null, 'left empty on purpose');
		assert.equal(handPocketStatus({art: {id: 'a'}, page: 1, position: 6}, isLive), null, 'art');
		assert.equal(handPocketStatus(undefined, isLive), null, 'nothing in it');
	});

	test('a list pocket: a copy shown is filled, none is to fill, a gap or past the end prints nothing', () => {
		assert.equal(listPocketStatus('dex:25', {entry: {id: 'c1'}}), 'filled');
		assert.equal(listPocketStatus('dex:26', null), 'want');
		assert.equal(listPocketStatus('', null), null);
		assert.equal(listPocketStatus(undefined, null), null);
	});

	test('every pocket of every page, in binder order', () => {
		const binder = {cols: 2, page_count: 3, rows: 2};
		const wanted = new Set(['3|4', '1|2', '2|1', '1|1']);
		const pockets = printablePockets(binder, (page, position) => {
			const key = `${page}|${position}`;

			if (key === '1|1') {
				return 'filled';
			}

			return wanted.has(key) ? 'want' : null;
		});

		assert.deepEqual(pockets, [
			{page: 1, position: 1, status: 'filled'},
			{page: 1, position: 2, status: 'want'},
			{page: 2, position: 1, status: 'want'},
			{page: 3, position: 4, status: 'want'},
		]);
	});
});

describe('The choices', () => {
	const pockets = [
		{page: 3, position: 2, status: 'want'},
		{page: 1, position: 1, status: 'filled'},
		{page: 2, position: 9, status: 'want'},
		{page: 2, position: 1, status: 'filled'},
		{page: 2, position: 3, status: 'want'},
		{page: 1, position: 5, status: 'want'},
	];
	const where = (list) => list.map((pocket) => `${pocket.page}|${pocket.position}`);

	test('all pages, filled skipped, sorted in binder order', () => {
		assert.deepEqual(where(choosePockets(pockets)), ['1|5', '2|3', '2|9', '3|2']);
	});

	test('the pages on screen only', () => {
		assert.deepEqual(where(choosePockets(pockets, {pages: [2, 3]})), ['2|3', '2|9', '3|2']);
		assert.deepEqual(where(choosePockets(pockets, {pages: [1]})), ['1|5']);
	});

	test('pockets already filled too', () => {
		assert.deepEqual(where(choosePockets(pockets, {filled: true})), ['1|1', '1|5', '2|1', '2|3', '2|9', '3|2']);
		assert.deepEqual(where(choosePockets(pockets, {filled: true, pages: [2]})), ['2|1', '2|3', '2|9']);
	});

	test('does not reorder the list it was given', () => {
		const copy = [...pockets];

		choosePockets(pockets, {filled: true});
		assert.deepEqual(pockets, copy);
	});
});

describe('Sheets', () => {
	const cards = (n) => Array.from({length: n}, (_, i) => i + 1);

	test('nine to a sheet, in order, the last one holding the rest', () => {
		assert.equal(PER_SHEET, 9);
		assert.deepEqual(sheetsOf([]), []);
		assert.deepEqual(sheetsOf(cards(9)), [cards(9)]);
		assert.deepEqual(sheetsOf(cards(10)), [cards(9), [10]]);
		assert.deepEqual(sheetsOf(cards(20)).map((sheet) => sheet.length), [9, 9, 2]);
		assert.deepEqual(sheetsOf(cards(20)).flat(), cards(20));
	});

	test('the words', () => {
		assert.equal(summaryText(0), 'No pockets to fill here.');
		assert.equal(summaryText(1), '1 card on 1 sheet.');
		assert.equal(summaryText(9), '9 cards on 1 sheet.');
		assert.equal(summaryText(10), '10 cards on 2 sheets.');
		assert.equal(pagesText([1]), 'Page 1');
		assert.equal(pagesText([2, 3]), 'Pages 2 and 3');
		assert.equal(pocketText(7, 4), 'Page 7, pocket 4');
	});

	test('the official artwork comes from the sprites folder the service worker keeps', () => {
		assert.equal(artworkUrl(25), 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/25.png');
		assert.ok(new URL(artworkUrl(25)).pathname.startsWith('/PokeAPI/sprites/'));
	});
});
