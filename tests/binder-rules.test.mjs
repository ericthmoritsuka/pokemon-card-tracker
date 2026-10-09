// Tests for binders made from a list (js/binder-rules.js, the saves in
// js/binders.js, and js/binders-view.js). Invented data and names.
//
// The first part is plain Node: the rule, the order, the default copy, the
// refresh plan, picks and how they merge, and what an older app's save
// does to a generated binder. The browser part drives headless Chromium at
// phone width against tests/pages-server.mjs, with TCGdex faked and
// Supabase faked (tests/fake-supabase.mjs) or refused.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/binder-rules.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {
	checkBinderRule,
	checkFits,
	cleanBinderRule,
	defaultCopy,
	indexAt,
	isGenerated,
	ordersFor,
	pagesFor,
	parseKey,
	pickEntry,
	picksOf,
	planRefresh,
	pocketAt,
	rarityRank,
	refreshText,
	ruleKey,
	shownCopy,
	sortRuleItems,
} from '../js/binder-rules.js';
import {placeholderList, placements, resizedBinder, setPocket, unplaced} from '../js/binders.js';
import {mergeDocuments, mergeEntries, stampEntry} from '../js/merge.js';

const at = (minute) => `2026-10-05T10:${String(minute).padStart(2, '0')}:00.000Z`;

const copy = (id, cardId, fields = {}) => ({card_id: cardId, catalog: 'international', created_at: at(0), deleted_at: null, id, language: 'en', updated_at: at(0), ...fields});

const generated = (id, fields = {}) => ({
	art: [],
	cols: 3,
	cover_color: '#1d2e60',
	created_at: at(0),
	deleted_at: null,
	id,
	name: 'Kanto binder',
	notes: '',
	page_count: 1,
	rows: 3,
	rule: {order: 'dex', source: {id: 'list-1', kind: 'checklist'}},
	slots: [],
	snapshot: {at: at(0), keys: ['dex:1', 'dex:4', 'dex:7'], rule_key: 'checklist:list-1|dex', shown: {'dex:1': 'c1'}},
	updated_at: at(0),
	...fields,
});

const hand = (id, slots = [], fields = {}) => ({art: [], cols: 3, cover_color: '#1b1b1f', created_at: at(0), deleted_at: null, id, name: 'Hand binder', notes: '', page_count: 2, rows: 3, slots, updated_at: at(0), ...fields});

describe('the rule', () => {
	test('a rule names a list or a filter, and an order that suits it', () => {
		assert.deepEqual(cleanBinderRule({order: 'set', source: {id: ' col-1 ', kind: 'collection'}}), {order: 'set', source: {id: 'col-1', kind: 'collection'}});
		// A checklist's pockets are Pokémon: no set order, so Pokédex order.
		assert.deepEqual(cleanBinderRule({order: 'set', source: {id: 'list-1', kind: 'checklist'}}), {order: 'dex', source: {id: 'list-1', kind: 'checklist'}});
		assert.deepEqual(ordersFor('checklist').map((order) => order.value), ['dex', 'name']);
		assert.deepEqual(ordersFor('goal').map((order) => order.value), ['dex', 'set', 'name', 'release']);
		assert.deepEqual(cleanBinderRule({order: 'name', source: {filter: {language: 'pt', region: ['kanto', 'kanto'], set: [''], wrong: ['x']}, kind: 'filter'}}),
			{order: 'name', source: {filter: {language: ['pt'], region: ['kanto']}, kind: 'filter'}});
		assert.equal(cleanBinderRule({order: 'dex', source: {filter: {}, kind: 'filter'}}), null);
		assert.equal(cleanBinderRule({order: 'dex', source: {kind: 'checklist'}}), null);
		assert.equal(cleanBinderRule({order: 'dex', source: {id: 'x', kind: 'shoebox'}}), null);
		assert.throws(() => checkBinderRule({order: 'dex', source: {filter: {}, kind: 'filter'}}), /at least one filter/);
		assert.throws(() => checkBinderRule(null), /Choose the list/);
	});

	test('a binder is generated when it carries a rule; the rule key ignores the order of filter values', () => {
		assert.equal(isGenerated(generated('b1')), true);
		assert.equal(isGenerated(hand('b2')), false);
		assert.equal(isGenerated({...hand('b3'), rule: {source: {kind: 'nope'}}}), false);
		assert.equal(ruleKey({order: 'dex', source: {filter: {type: ['Fire', 'Water']}, kind: 'filter'}}), ruleKey({order: 'dex', source: {filter: {type: ['Water', 'Fire']}, kind: 'filter'}}));
		assert.notEqual(ruleKey({order: 'dex', source: {id: 'a', kind: 'goal'}}), ruleKey({order: 'set', source: {id: 'a', kind: 'goal'}}));
	});

	test('pages follow the pockets, and too many for 200 pages is refused', () => {
		assert.equal(pagesFor(0, 3, 3), 1);
		assert.equal(pagesFor(151, 3, 3), 17);
		assert.equal(pagesFor(1025, 3, 4), 86);
		assert.deepEqual(pocketAt(9, 3, 3), {page: 2, position: 1});
		assert.equal(indexAt(2, 1, 3, 3), 9);
		assert.doesNotThrow(() => checkFits(800, 2, 2));
		assert.throws(() => checkFits(1025, 2, 2), /more than 200 pages/);
		assert.deepEqual(parseKey('dex:25'), {dex: 25, kind: 'pokemon'});
		assert.deepEqual(parseKey('ja|SV1a-001'), {cardId: 'SV1a-001', catalog: 'ja', kind: 'card'});
		assert.equal(parseKey('nothing'), null);
	});
});

describe('the order', () => {
	const items = [
		{dexIds: [25], key: 'international|tsb-010', name: 'Test Pikachu', number: '10', releaseDate: '2024-05-01', setId: 'tsb'},
		{dexIds: [1], key: 'international|tsa-002', name: 'Test Bulbasaur', number: '2', releaseDate: '2023-01-01', setId: 'tsa'},
		{dexIds: [], key: 'international|tsa-100', name: 'Test Potion', number: '100', releaseDate: '2023-01-01', setId: 'tsa'},
		{dexIds: [4], key: 'international|tsb-003', name: 'Test Charmander', number: '3', releaseDate: '2024-05-01', setId: 'tsb'},
		{dexIds: [150], key: 'international|tsc-001', name: 'Test Mewtwo', number: '1', releaseDate: null, setId: 'tsc'},
	];
	const keys = (order) => sortRuleItems(items, order).map((item) => item.key.split('|')[1]);

	test('Pokédex number, with cards that have none last', () => {
		assert.deepEqual(keys('dex'), ['tsa-002', 'tsb-003', 'tsb-010', 'tsc-001', 'tsa-100']);
	});

	test('set and number: oldest set first, numbers in order, an undated set last', () => {
		assert.deepEqual(keys('set'), ['tsa-002', 'tsa-100', 'tsb-003', 'tsb-010', 'tsc-001']);
	});

	test('release date: newest set first', () => {
		assert.deepEqual(keys('release'), ['tsb-003', 'tsb-010', 'tsa-002', 'tsa-100', 'tsc-001']);
	});

	test('name', () => {
		assert.deepEqual(keys('name'), ['tsa-002', 'tsb-003', 'tsc-001', 'tsb-010', 'tsa-100']);
	});
});

describe('the default copy', () => {
	test('the most valuable, else the rarest, else the newest added', () => {
		const a = copy('a', 'tsa-001', {created_at: at(1)});
		const b = copy('b', 'tsa-002', {created_at: at(2)});
		const c = copy('c', 'tsa-003', {created_at: at(3)});
		const ranks = {a: {rarity: 'Common', value: 12}, b: {rarity: 'Special illustration rare', value: null}, c: {rarity: 'Rare', value: 3}};

		assert.equal(defaultCopy([a, b, c], (entry) => ranks[entry.id]).id, 'a');
		assert.equal(defaultCopy([b, c], (entry) => ({...ranks[entry.id], value: null})).id, 'b');
		assert.equal(defaultCopy([a, b, c], () => ({})).id, 'c');
		assert.equal(defaultCopy([{...c, deleted_at: at(4)}, a], () => ({})).id, 'a');
		assert.equal(defaultCopy([], () => ({})), null);
	});

	test('rarity ranks from TCGdex words, unknown lowest', () => {
		const order = ['Common', 'Uncommon', 'Rare', 'Rare Holo', 'Double rare', 'Ultra Rare', 'Illustration rare', 'Special illustration rare', 'Hyper rare'];

		for (let i = 1; i < order.length; i++) {
			assert.ok(rarityRank(order[i]) > rarityRank(order[i - 1]), `${order[i]} above ${order[i - 1]}`);
		}

		assert.equal(rarityRank(null), 0);
		assert.equal(rarityRank('None'), 0);
	});

	test('a hand pick shows while it still fits; else the stored default; else the default now', () => {
		const item = {copies: [copy('a', 'x', {created_at: at(1)}), copy('b', 'x', {created_at: at(2)})]};

		assert.deepEqual(shownCopy(item, {pick: 'a', stored: 'b'}), {entry: item.copies[0], picked: true});
		assert.deepEqual(shownCopy(item, {pick: 'gone', stored: 'a'}), {entry: item.copies[0], picked: false});
		assert.deepEqual(shownCopy(item, {pick: null, stored: 'gone'}), {entry: item.copies[1], picked: false});
		assert.equal(shownCopy({copies: []}, {pick: 'a'}), null);
	});
});

describe('refresh', () => {
	const item = (n, copies = []) => ({copies, dex: n, key: `dex:${n}`, name: `Test mon ${n}`});

	test('new pockets follow the list in order, gone ones leave, owned cards fill in, and hand picks keep their pocket', () => {
		const binder = generated('b1');
		const items = [item(1, [copy('c1', 'p1'), copy('c9', 'p9', {created_at: at(5)})]), item(2, [copy('c2', 'p2')]), item(4), item(5)];
		const plan = planRefresh(binder, items, {at: at(10), picks: new Map([['dex:1', 'c1']]), rankOf: () => ({})});

		assert.deepEqual(plan.snapshot.keys, ['dex:1', 'dex:2', 'dex:4', 'dex:5']);
		assert.deepEqual(plan.added, ['dex:2', 'dex:5']);
		assert.deepEqual(plan.removed, ['dex:7']);
		// dex:1 had a default and a hand pick: the default moves, but a
		// picked pocket never counts as updated.
		assert.deepEqual(plan.updated, []);
		assert.equal(plan.snapshot.shown['dex:1'], 'c9');
		assert.equal(plan.snapshot.shown['dex:2'], 'c2');
		assert.equal(plan.changed, true);
		assert.equal(plan.page_count, 1);
		assert.equal(refreshText(plan, (key) => key.replace('dex:', 'Mon ')), '2 pockets added (Mon 2 and Mon 5); 1 pocket removed (Mon 7).');
	});

	test('a pocket filled for the first time and a default that moves are both told', () => {
		const binder = generated('b1');
		const items = [item(1, [copy('c5', 'p5')]), item(4, [copy('c4', 'p4')]), item(7)];
		const plan = planRefresh(binder, items, {at: at(10), rankOf: () => ({})});

		assert.deepEqual(plan.filled, ['dex:4']);
		assert.deepEqual(plan.updated, ['dex:1']);
		assert.match(refreshText(plan, (key) => key), /1 pocket filled with a card you own now \(dex:4\); 1 pocket shows another copy by default\./);
	});

	test('nothing changed: nothing to save', () => {
		const binder = generated('b1');
		const plan = planRefresh(binder, [item(1, [copy('c1', 'p1')]), item(4), item(7)], {at: at(10), rankOf: () => ({})});

		assert.equal(plan.changed, false);
		assert.equal(refreshText(plan), '');
	});

	test('with part of the list unknown (offline), a stored default that is still owned stays', () => {
		const binder = generated('b1');
		const plan = planRefresh(binder, [item(1), item(4), item(7)], {at: at(10), liveIds: new Set(['c1']), partial: true, rankOf: () => ({})});

		assert.equal(plan.snapshot.shown['dex:1'], 'c1');
		assert.equal(plan.changed, false);

		const sold = planRefresh(binder, [item(1), item(4), item(7)], {at: at(10), liveIds: new Set(), partial: true, rankOf: () => ({})});

		assert.equal(sold.snapshot.shown['dex:1'], undefined);
	});

	test('a new rule or grid always saves', () => {
		const binder = generated('b1', {rule: {order: 'name', source: {id: 'list-1', kind: 'checklist'}}});
		const plan = planRefresh(binder, [item(1, [copy('c1', 'p1')]), item(4), item(7)], {at: at(10), rankOf: () => ({})});

		assert.equal(plan.changed, true);
		assert.equal(plan.snapshot.rule_key, 'checklist:list-1|name');
		assert.equal(planRefresh({...generated('b1'), rows: 1, cols: 1}, [item(1, [copy('c1', 'p1')]), item(4), item(7)], {at: at(10), rankOf: () => ({})}).page_count, 3);
	});
});

describe('a generated binder places nothing', () => {
	test('a copy shown in a generated binder is still not in a binder, and can sit in a hand binder too', () => {
		const cards = [copy('c1', 'p1'), copy('c2', 'p2')];
		const binders = [
			generated('g1', {slots: [{entry_id: 'c2', page: 1, placed_at: at(1), position: 1}]}),
			hand('h1', [{entry_id: 'c1', page: 1, placed_at: at(1), position: 2}]),
		];

		// The stray slot an older app put in the generated binder counts for
		// nothing here.
		assert.deepEqual([...placements(binders).keys()], ['c1']);
		assert.deepEqual(unplaced(cards, binders).map((entry) => entry.id), ['c2']);
	});

	test('a placeholder an older app left in a generated binder is not offered to the scanner', () => {
		const want = {card_id: 'tst-001', catalog: 'international'};
		const binders = [generated('g1', {slots: [{page: 1, placed_at: at(1), position: 3, want}]}), hand('h1', [{page: 1, placed_at: at(1), position: 1, want}])];

		assert.deepEqual(placeholderList(binders).map((row) => row.binder_id), ['h1']);
	});

	test('its pockets are not filled by hand', () => {
		assert.throws(() => setPocket([generated('g1')], {at: at(2), binderId: 'g1', content: {entry_id: 'c1'}, page: 1, position: 1}), /made from a list/);
	});
});

describe('sync and older apps', () => {
	test('picks for different pockets on two phones both stay; the later pick of one pocket wins', () => {
		const phoneA = [pickEntry({at: at(3), binderId: 'g1', entryId: 'c1', key: 'dex:1'}), pickEntry({at: at(5), binderId: 'g1', entryId: 'c7', key: 'dex:7'})];
		const phoneB = [pickEntry({at: at(4), binderId: 'g1', entryId: 'c4', key: 'dex:4'}), pickEntry({at: at(6), binderId: 'g1', entryId: 'c8', key: 'dex:7'})];
		const merged = mergeDocuments({binder_picks: phoneA, binders: [generated('g1')], cards: []}, {binder_picks: phoneB, binders: [generated('g1')], cards: []});
		const picks = picksOf(merged.binder_picks, 'g1');

		assert.deepEqual(Object.fromEntries(picks), {'dex:1': 'c1', 'dex:4': 'c4', 'dex:7': 'c8'});
		// Back to the default: entry_id null, newer.
		const back = mergeEntries(merged.binder_picks, [pickEntry({at: at(9), binderId: 'g1', entryId: null, key: 'dex:1', previous: phoneA[0]})]);

		assert.equal(picksOf(back, 'g1').has('dex:1'), false);
		assert.equal(back.find((pick) => pick.id === 'g1|dex:1').created_at, at(3));
	});

	test('a rule changed on one phone and a refresh saved on the other both survive the field merge', () => {
		const base = generated('g1');
		const ruled = stampEntry(base, {...base, rule: {order: 'name', source: {id: 'list-1', kind: 'checklist'}}, updated_at: at(5)});
		const refreshed = stampEntry(base, {...base, snapshot: {...base.snapshot, at: at(6), shown: {'dex:1': 'c9'}}, updated_at: at(6)});
		const [merged] = mergeEntries([ruled], [refreshed]);

		assert.equal(merged.rule.order, 'name');
		assert.equal(merged.snapshot.shown['dex:1'], 'c9');
	});

	test('an older app editing a generated binder keeps its rule and snapshot (it clones the entry), and stray pockets it adds are ignored', () => {
		const binder = generated('g1');
		// What every app since the first does for Edit binder: a clone of
		// the entry with the form's fields over it.
		const {binder: edited} = resizedBinder(binder, {cols: 3, cover_color: '#dc0a2d', name: 'Renamed on an old phone', notes: '', page_count: 1, rows: 3}, {at: at(7)});

		assert.deepEqual(edited.rule, binder.rule);
		assert.deepEqual(edited.snapshot, binder.snapshot);
		assert.equal(isGenerated(edited), true);

		// An older app's whole-entry save (no field stamps) still carries the
		// rule, since it started from a clone.
		const oldSave = {...structuredClone(binder), name: 'Old app', updated_at: at(8)};
		const [merged] = mergeEntries([binder], [oldSave]);

		assert.equal(merged.name, 'Old app');
		assert.deepEqual(merged.rule, binder.rule);
	});

	test('an unknown top-level list survives a merge with a document that lacks it', () => {
		const picks = [pickEntry({at: at(3), binderId: 'g1', entryId: 'c1', key: 'dex:1'})];
		const merged = mergeDocuments({binders: [], cards: []}, {binder_picks: picks, binders: [], cards: []});

		assert.deepEqual(merged.binder_picks, picks);
	});
});

