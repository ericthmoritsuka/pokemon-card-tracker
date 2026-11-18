// The stack hint (js/scan/session.js stackSet, js/scan/picture.js stackPick
// and pictureMatch's stack): a reprint shares its artwork with the original,
// so the picture alone finds a group of prints; when most of the last cards
// added are from one set and exactly one print of the group is from it, that
// print is the card, with no number read. In Eric's 2026-11-18 report the
// rule applied 33 times (13 of them cards that read their number for 9 s)
// and named the card he kept every time. Node only.
//
// Run: node --test tests/scan-stack.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {pictureMatch, stackPick} from '../js/scan/picture.js';
import {stackSet} from '../js/scan/session.js';

const item = (id, setId, fields = {}) => ({card: setId ? {id: `${setId}-1`, setId} : null, id, sure: true, ...fields});
const session = (...sets) => ({items: sets.map((set, i) => item(`i${i}`, set))});

// Charizard's artwork, in Base Set and reprinted in 30th Celebration.
const card = (id, set, score) => ({catalog: 'en', id, image: `https://assets/${id}`, score, set});
const shared = {gap: 40, groups: [{cards: [card('base1-4', 'base1', 20), card('30th-4', '30th', 21)], score: 20}, {cards: [card('sv01-089', 'sv01', 60)], score: 60}]};
const table = {
	cards: {'en|30th': {'30th-4': 'Charizard'}, 'en|base1': {'base1-4': 'Charizard'}, 'en|sv01': {'sv01-089': 'Drifloon'}},
	sets: {'en|30th': ['30th Celebration', 128, '2026-02-27'], 'en|base1': ['Base', 102, '1999-01-09'], 'en|sv01': ['Scarlet & Violet', 198, '2023-03-31']},
};
const api = {indexNames: async () => table, setDetail: async () => null};
const number = (n, total) => ({number: {confidence: 0.9, number: n, numberPrinted: n, side: 'left', total, totalPrinted: total}});

describe('the stack a card is scanned from', () => {
	test('stackSet is the set of at least three of the last five cards before this one', () => {
		assert.equal(stackSet(session('30th', '30th', 'sv01', '30th', 'base1', null), 'i5'), '30th');
		assert.equal(stackSet(session('30th', '30th', 'sv01', 'base1', null), 'i4'), null, 'two of five: no stack');
		assert.equal(stackSet(session('30th', '30th', '30th', 'sv01', 'sv01', 'sv01', 'sv01', null), 'i7'), 'sv01', 'only the last five count');
		assert.equal(stackSet(session('30th', '30th', '30th', null, 'sv01'), 'i3'), '30th', 'cards after this one do not count');
		assert.equal(stackSet({items: []}, 'x'), null);
	});

	test('only cards settled without the stack count: not unsure guesses, not the stack\'s own picks', () => {
		const items = [item('a', '30th'), item('b', '30th', {sure: false}), item('c', '30th', {stacked: true}), item('d', '30th', {confirmed: true, sure: false}), item('e', null)];

		assert.equal(stackSet({items}, 'e'), null, 'two settled 30th cards (a, d): no stack');
		assert.equal(stackSet({items: [...items.slice(0, 4), item('f', '30th'), item('g', null)]}, 'g'), '30th');
	});

	test('stackPick takes the one print of the first group from the stack\'s set', () => {
		assert.equal(stackPick(shared, '30th').id, '30th-4');
		assert.equal(stackPick(shared, 'base1').id, 'base1-4');
		assert.equal(stackPick(shared, 'sv01'), null, 'a set only in a later group does not count');
		assert.equal(stackPick(shared, null), null);
		assert.equal(stackPick({gap: 40, groups: [{cards: [card('30th-4', '30th', 20), card('30th-4a', '30th', 21)], score: 20}]}, '30th'), null, 'two prints from the set: not settled');
		assert.equal(stackPick({...shared, gap: 4}, '30th'), null, 'a picture that is not clear: a card the index lacks finds some unrelated nearest group');
		assert.equal(stackPick({gap: 40, groups: [{cards: [card('30th-9', '30th', 62)], score: 62}]}, '30th'), null, 'too far to be this artwork');
	});

	test('pictureMatch with a stack makes the stack\'s print the card, sure, with no number read', async () => {
		const found = await pictureMatch(shared, null, 'pt', {api, stack: '30th'});

		assert.equal(found.card.id, '30th-4');
		assert.equal(found.card.name, 'Charizard');
		assert.equal(found.sure, true);
		assert.equal(found.stack, true);
		assert.deepEqual(found.candidates.map((c) => c.id), ['30th-4', 'base1-4', 'sv01-089']);
	});

	test('a number read that names the other print wins over the stack', async () => {
		const found = await pictureMatch(shared, number('4', '102'), 'pt', {api, stack: '30th'});

		assert.equal(found.stack, undefined);
		assert.equal(found.card.id, 'base1-4');
	});

	test('a card the index lacks, near nothing, is not taken from the stack', async () => {
		const unknown = {gap: 3, groups: [{cards: [card('30th-50', '30th', 52)], score: 52}, {cards: [card('sv01-089', 'sv01', 55)], score: 55}]};
		const found = await pictureMatch(unknown, null, 'pt', {api, stack: '30th'});

		assert.equal(found.stack, undefined);
		assert.equal(found.sure, false);
	});

	test('without a stack the shared artwork is not settled by the picture', async () => {
		const found = await pictureMatch(shared, null, 'pt', {api});

		assert.equal(found.sure, false);
		assert.equal(found.stack, undefined);
	});
});
