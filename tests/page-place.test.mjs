// "I already have these cards": a binder page read matched to the owner's
// copies and placed on a binder page (js/scan/page-place.js,
// js/binders.js placePage).

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {placePage, placements} from '../js/binders.js';
import {copyChoices, freePage, homePage, matchPage, pagePockets, pagesInUse, placePlan, placeSummary, whereText} from '../js/scan/page-place.js';

const AT = '2026-11-19T12:00:00.000Z';
const card = (id, name) => ({catalog: 'international', id, image: `https://assets.tcgdex.net/en/x/${id}`, name});
const item = (id, page, c, extra = {}) => ({card: c, id, page, ...extra});
const entry = (id, cardId, extra = {}) => ({card_id: cardId, catalog: 'international', created_at: `2026-10-0${extra.day || 1}T00:00:00.000Z`, deleted_at: null, id, language: 'pt', ...extra});
const binder = (id, name, slots = [], extra = {}) => ({cols: 3, created_at: AT, deleted_at: null, id, name, page_count: 2, rows: 3, slots, updated_at: AT, ...extra});

describe('the copies a pocket can be (copyChoices)', () => {
	const pikachu = card('basep-4', 'Pikachu');

	test('loose copies first, then the language read, then the oldest; deleted copies and other cards never', () => {
		const binders = [binder('b1', 'Binder A', [{entry_id: 'placed', page: 1, position: 2}])];
		const entries = [
			entry('placed', 'basep-4', {day: 1, language: 'en'}),
			entry('loose-pt', 'basep-4', {day: 2}),
			entry('loose-en', 'basep-4', {day: 3, language: 'en'}),
			entry('gone', 'basep-4', {deleted_at: AT}),
			entry('other', 'base1-58'),
		];
		const read = copyChoices(item('i1', 1, pikachu, {language: 'en', languageBy: 'stage'}), entries, placements(binders));

		assert.deepEqual(read.map((choice) => choice.entry.id), ['loose-en', 'loose-pt', 'placed']);
		assert.deepEqual(read[2].where, {binderId: 'b1', binderName: 'Binder A', page: 1, position: 2});
		assert.equal(whereText(read[2].where), 'Binder A, p. 1');
		assert.equal(whereText(read[0].where), 'Loose');
	});

	test('a language that was only a default does not order them', () => {
		const entries = [entry('older-en', 'basep-4', {day: 1, language: 'en'}), entry('newer-pt', 'basep-4', {day: 2})];
		const read = copyChoices(item('i1', 1, pikachu, {language: 'pt', languageBy: 'default'}), entries, new Map());

		assert.deepEqual(read.map((choice) => choice.entry.id), ['older-en', 'newer-pt']);
	});
});

describe('a page matched to the copies (matchPage, pagePockets, placeSummary)', () => {
	const pikachu = card('basep-4', 'Pikachu');
	const squirtle = card('base4-93', 'Squirtle');
	const items = [item('a', 1, pikachu), item('b', 2, pikachu), item('c', 3, squirtle)];
	const entries = [entry('p1', 'basep-4', {day: 1}), entry('p2', 'basep-4', {day: 2})];

	test('one copy is never placed twice, and a card he has none left of becomes a placeholder', () => {
		const matches = matchPage(items, entries, new Map());

		assert.equal(matches.get('a').entry.id, 'p1');
		assert.equal(matches.get('b').entry.id, 'p2');
		assert.equal(matches.get('c').entry, null);
		assert.deepEqual(placeSummary(items, matches), {copies: 2, kept: 0, moved: 0, placeholders: 1});

		const pockets = pagePockets(items, matches, 4);

		assert.deepEqual(pockets.map(({page, position}) => [page, position]), [[4, 1], [4, 2], [4, 3]]);
		assert.deepEqual(pockets[0].content, {entry_id: 'p1'});
		assert.deepEqual(pockets[2].content.want, {card_id: 'base4-93', catalog: 'international', image: squirtle.image, name: 'Squirtle', variant_id: null});
	});

	test('his own pick wins, the others go round it, and a pick of none leaves a placeholder', () => {
		const picked = matchPage(items, entries, new Map(), new Map([['b', 'p1']]));

		assert.equal(picked.get('b').entry.id, 'p1');
		assert.equal(picked.get('a').entry.id, 'p2');

		const none = matchPage(items, entries, new Map(), new Map([['a', null]]));

		assert.equal(none.get('a').entry, null);
		assert.equal(none.get('b').entry.id, 'p1');
	});

	test('a spread\'s right page goes on the next binder page', () => {
		const spread = [item('l', 9, pikachu), item('r', 10, squirtle)];
		const pockets = pagePockets(spread, matchPage(spread, [], new Map()), 2);

		assert.deepEqual(pockets.map(({page, position}) => [page, position]), [[2, 9], [3, 1]]);
	});
});

describe('placing a page in one save (placePage)', () => {
	test('fills the pockets, and a copy taken from another binder leaves its old pocket', () => {
		const binders = [binder('target', 'New one'), binder('old', 'Binder A', [{entry_id: 'p1', page: 1, position: 5}])];
		const changed = placePage(binders, {at: AT, binderId: 'target', pockets: [
			{content: {entry_id: 'p1'}, page: 1, position: 1},
			{content: {want: {card_id: 'base4-93', catalog: 'international', image: null, name: 'Squirtle', variant_id: null}}, page: 1, position: 2},
		]});
		const byId = new Map(changed.map((one) => [one.id, one]));

		assert.deepEqual(byId.get('target').slots.map((slot) => [slot.position, slot.entry_id || slot.want.name]), [[1, 'p1'], [2, 'Squirtle']]);
		assert.ok(!byId.get('old').slots.some((slot) => slot.entry_id === 'p1'), 'the copy left Binder A (its pocket keeps a cleared mark for the sync)');
	});

	test('refuses a binder made from a list', () => {
		const binders = [binder('list', 'From a list', [], {rule: {order: 'dex', source: {id: 'kanto', kind: 'checklist'}}})];

		assert.throws(() => placePage(binders, {at: AT, binderId: 'list', pockets: [{content: {entry_id: 'p1'}, page: 1, position: 1}]}), /made from a list/);
	});
});

describe('the page it goes to (pagesInUse, freePage, placePlan)', () => {
	const full = binder('full', 'Binder A', [
		{entry_id: 'x1', page: 1, position: 1},
		{page: 1, position: 2, want: {card_id: 'base1-4', catalog: 'international', name: 'Charizard'}},
		{cleared: true, page: 2, position: 1},
		{entry_id: 'x2', page: 3, position: 9},
	], {page_count: 3});

	test('counts what each page holds, a cleared pocket as open, and offers the first free page or pages', () => {
		assert.deepEqual([...pagesInUse(full)], [[1, 2], [3, 1]]);
		assert.equal(freePage(full, 1), 2);
		assert.equal(freePage(full, 2), 4, 'no two free pages in a row: a new page at the end');
	});

	test('says which copies come out loose and which marks are written over, and how to put them back', () => {
		const binders = [full, binder('other', 'Binder B', [{entry_id: 'p1', page: 1, position: 4}])];
		const pockets = [
			{content: {entry_id: 'p1'}, page: 1, position: 1},
			{content: {entry_id: 'x1'}, page: 1, position: 2},
		];
		const plan = placePlan(binders, {binderId: 'full', pockets});

		assert.equal(plan.loose, 0, 'x1 is placed again, in pocket 2');
		assert.equal(plan.replaced, 1, 'the Charizard placeholder is written over');
		assert.deepEqual(plan.undo.target, [
			{content: {entry_id: 'x1'}, page: 1, position: 1},
			{content: {want: {card_id: 'base1-4', catalog: 'international', name: 'Charizard'}}, page: 1, position: 2},
		]);
		assert.deepEqual(plan.undo.moved, [
			{binderId: 'other', content: {entry_id: 'p1'}, page: 1, position: 4},
			{binderId: 'full', content: {entry_id: 'x1'}, page: 1, position: 1},
		]);

		const over = placePlan(binders, {binderId: 'full', pockets: [{content: {entry_id: 'p1'}, page: 1, position: 1}]});

		assert.equal(over.loose, 1, 'x1 leaves its pocket and is placed nowhere');
		assert.deepEqual(placePlan(binders, {binderId: null, pockets}).undo.target.map((one) => one.content), [null, null], 'a new binder has nothing to take out');
	});
});

// A QA pass (v94): all nine cards of Kanto page 3 read again, and the page
// was offered empty page 18; placing there took eight of them out of page 3.
describe('a page whose cards already sit in a binder page (homePage)', () => {
	const cards = Array.from({length: 9}, (_, i) => card(`sv03.5-${String(i + 19).padStart(3, '0')}`, `Card ${i + 1}`));
	const items = cards.map((one, i) => item(`i${i + 1}`, i + 1, one));
	// Each card's copy in its pocket on Kanto page 3, and a loose second
	// copy of the first, which a page elsewhere would take first.
	const entries = [...cards.map((one, i) => entry(`k${i + 1}`, one.id)), entry('loose', cards[0].id, {day: 2})];
	const kanto = binder('kanto', 'Kanto 151', cards.map((one, i) => ({entry_id: `k${i + 1}`, page: 3, position: i + 1})), {page_count: 18});
	const binders = [binder('other', 'Binder A'), kanto];

	test('is the binder page they are on, each in the pocket it would go in', () => {
		assert.deepEqual(homePage(items, entries, placements(binders)), {binderId: 'kanto', page: 3});
	});

	test('placing there takes the copies in their pockets, so nothing moves and nothing comes out', () => {
		const target = {binderId: 'kanto', page: 3};
		const matches = matchPage(items, entries, placements(binders), new Map(), target);

		assert.deepEqual(items.map((one) => matches.get(one.id).entry.id), cards.map((_, i) => `k${i + 1}`), 'the copy in pocket 1, not the loose one');
		assert.deepEqual(placeSummary(items, matches, target), {copies: 9, kept: 9, moved: 0, placeholders: 0});

		const plan = placePlan(binders, {binderId: 'kanto', pockets: pagePockets(items, matches, 3)});

		assert.deepEqual([plan.loose, plan.replaced, plan.undo.moved], [0, 0, []]);

		const changed = placePage(binders, {at: AT, binderId: 'kanto', pockets: pagePockets(items, matches, 3)});
		const after = changed.find((one) => one.id === 'kanto') || kanto;

		assert.deepEqual(after.slots.filter((slot) => !slot.cleared).map((slot) => [slot.page, slot.position, slot.entry_id]), cards.map((_, i) => [3, i + 1, `k${i + 1}`]), 'page 3 is as it was');
	});

	test('a card read that is not there leaves it the page, and that pocket is placed as on any page', () => {
		const misread = [...items.slice(0, 8), item('i9', 9, card('base1-58', 'Pikachu'))];
		const target = homePage(misread, entries, placements(binders));

		assert.deepEqual(target, {binderId: 'kanto', page: 3});

		const matches = matchPage(misread, entries, placements(binders), new Map(), target);

		assert.deepEqual(placeSummary(misread, matches, target), {copies: 8, kept: 8, moved: 0, placeholders: 1});
		assert.equal(placePlan(binders, {binderId: 'kanto', pockets: pagePockets(misread, matches, 3)}).loose, 1, 'the copy in pocket 9 comes out, and the sheet says so');
	});

	test('elsewhere, the copies are counted as taken from their pockets', () => {
		const target = {binderId: 'kanto', page: 18};
		const matches = matchPage(items, entries, placements(binders), new Map(), target);

		assert.equal(matches.get('i1').entry.id, 'loose', 'a loose copy first, as before');
		assert.deepEqual(placeSummary(items, matches, target), {copies: 9, kept: 0, moved: 8, placeholders: 0});
	});

	test('none when the cards are scattered, or under half of them share a page', () => {
		const scattered = binder('kanto', 'Kanto 151', cards.map((one, i) => ({entry_id: `k${i + 1}`, page: 3, position: ((i + 1) % 9) + 1})), {page_count: 18});

		assert.equal(homePage(items, entries, placements([scattered])), null, 'every copy one pocket off');

		const few = binder('kanto', 'Kanto 151', cards.slice(0, 4).map((one, i) => ({entry_id: `k${i + 1}`, page: 3, position: i + 1})), {page_count: 18});

		assert.equal(homePage(items, entries, placements([few])), null, '4 of 9');
	});

	test('a spread is at home on two pages in a row', () => {
		const spread = [item('l', 9, cards[0]), item('r', 10, cards[1])];
		const two = binder('kanto', 'Kanto 151', [{entry_id: 'k1', page: 5, position: 9}, {entry_id: 'k2', page: 6, position: 1}], {page_count: 18});

		assert.deepEqual(homePage(spread, entries, placements([two])), {binderId: 'kanto', page: 5});
	});
});
