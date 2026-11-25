// Unit tests for Add to binder on a binder made from a list (js/binder-add.js;
// Eric, 2026-11-24): a card's own pocket or a checklist's Pokémon pocket takes
// a hand pick, any other card joins after the list, the page each lands on,
// the copy chosen, and one copy per card and one card per pocket for a bulk
// add. Plain Node; invented data only.
//
// Run: node --test tests/binder-add.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

// js/dom.js reaches window when it loads.
globalThis.window = globalThis.window || globalThis;
globalThis.addEventListener = globalThis.addEventListener || (() => {});

const {copyToShow, listTarget, planListAdds, targetText} = await import('../js/binder-add.js');

const at = (minute) => `2026-11-24T10:${String(minute).padStart(2, '0')}:00.000Z`;
const copy = (id, cardId, fields = {}) => ({card_id: cardId, catalog: 'international', created_at: at(0), deleted_at: null, id, language: 'pt', ...fields});
// Johto from a checklist, 2 × 2: Chikorita, Cyndaquil, Totodile, then one
// card added by hand.
const johto = {cols: 2, id: 'johto', name: 'Johto', rows: 2, rule: {order: 'dex', source: {id: 'list-j', kind: 'checklist'}}, snapshot: {keys: ['dex:152', 'dex:155', 'dex:158', 'international|sv01-001'], shown: {}}};
// The 30th-anniversary set goal, card pockets.
const thirty = {cols: 3, id: 'thirty', name: '30 anos', rows: 3, rule: {order: 'set', source: {id: 'goal-30', kind: 'goal'}}, snapshot: {keys: ['international|cel25-001', 'international|cel25-155'], shown: {}}};

describe('where a card goes in a binder from a list', () => {
	test('its own card pocket, a checklist\'s Pokémon pocket, or after the list', () => {
		assert.deepEqual(listTarget(thirty, {catalog: 'international', cardId: 'cel25-155', dexIds: [155]}), {key: 'international|cel25-155', kind: 'pick', page: 1});
		assert.deepEqual(listTarget(johto, {catalog: 'international', cardId: 'cel25-155', dexIds: [155]}), {key: 'dex:155', kind: 'pick', page: 1});
		assert.deepEqual(listTarget(johto, {catalog: 'international', cardId: 'sv01-001', dexIds: [906]}), {key: 'international|sv01-001', kind: 'pick', page: 1}, 'a card added by hand before');
		assert.deepEqual(listTarget(johto, {catalog: 'international', cardId: 'sv03-025', dexIds: [25]}), {key: 'international|sv03-025', kind: 'add', page: 2}, 'after the four pockets: page 2');
		assert.deepEqual(listTarget(thirty, {catalog: 'international', cardId: 'neo1-155', dexIds: [155]}), {key: 'international|neo1-155', kind: 'add', page: 1}, 'a goal\'s pockets are cards: another print is added');
	});

	test('a checklist that counts some languages takes only a copy in one of them; other copies join after the list', () => {
		const card = {catalog: 'international', cardId: 'cel25-155', dexIds: [155]};

		assert.equal(listTarget(johto, {...card, language: 'pt'}, {languages: ['pt']}).kind, 'pick');
		assert.equal(listTarget(johto, {...card, language: 'en'}, {languages: ['pt']}).kind, 'add');
		assert.equal(listTarget(johto, {...card, language: 'en'}).kind, 'pick', 'a list that names no language counts any');
	});

	test('the sheet says which before the tap', () => {
		assert.equal(targetText({kind: 'pick', page: 3}), 'Shows your copy in its pocket, page 3.');
		assert.equal(targetText({kind: 'add', page: 12}), 'Adds it after the list, page 12.');
	});
});

describe('which copies go', () => {
	test('a copy not in use in another pocket first, then the newest', () => {
		const copies = [copy('a', 'x', {created_at: at(1)}), copy('b', 'x', {created_at: at(3)}), copy('c', 'x', {created_at: at(2)})];

		assert.equal(copyToShow(copies, new Map()).id, 'b');
		assert.equal(copyToShow(copies, new Map([['b', [{rank: 0}]]])).id, 'c');
		assert.equal(copyToShow(copies.slice(1, 2), new Map([['b', [{rank: 0}]]])).id, 'b', 'all in use: the newest still');
	});

	test('a bulk add: one copy per card, one card per pocket, the rest stay where they are', () => {
		const index = new Map([['international|cel25-155', {dex_ids: [155]}], ['international|neo1-155', {dex_ids: [155]}], ['international|sv03-025', {dex_ids: [25]}]]);
		const copies = [
			copy('c30', 'cel25-155', {created_at: at(2)}),
			copy('c30b', 'cel25-155', {created_at: at(1)}),
			copy('neo', 'neo1-155'),
			copy('pika', 'sv03-025'),
			copy('gone', 'sv03-025', {deleted_at: at(5)}),
		];
		const plan = planListAdds(johto, copies, {index});

		assert.deepEqual(plan.picks, [{entryId: 'c30', key: 'dex:155'}]);
		assert.deepEqual(plan.adds, [{entryId: 'pika', key: 'international|sv03-025'}]);
		assert.equal(plan.skipped, 2, 'the second 30th copy, and the Neo Cyndaquil whose pocket the 30th one took');
		assert.deepEqual(plan.targets.map((target) => [target.kind, target.page]), [['pick', 1], ['add', 2]]);
	});
});
