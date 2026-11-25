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
	CLAIM_RANK,
	checkBinderRule,
	claimIndex,
	outranks,
	takenFor,
	checkFits,
	cleanBinderRule,
	defaultCopy,
	extraCardEntries,
	extraKeysOf,
	extraPagesOf,
	indexAt,
	isGenerated,
	keptOrder,
	layoutWaits,
	listPageCount,
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
	skipsOf,
	sortRuleItems,
	withExtraItems,
} from '../js/binder-rules.js';
import {placeholderList, placements, resizedBinder, setPocket, unplaced} from '../js/binders.js';
import {mergeDocuments, mergeEntries, stampEntry} from '../js/merge.js';
import {fakeRates} from './fake-rates.mjs';
import {untilInPage} from './poll.mjs';

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

describe('not this copy here (Eric, 2026-11-24)', () => {
	// Johto's Cyndaquil pocket: the copy he owns belongs in his
	// 30th-anniversary binder.
	const cyndaquil = (copies) => ({copies, dex: 155, key: 'dex:155', name: 'Cyndaquil'});
	const pick = (fields = {}) => ({binder_id: 'johto', created_at: at(1), deleted_at: null, entry_id: null, id: 'johto|dex:155', key: 'dex:155', updated_at: at(1), ...fields});

	test('a skipped copy is passed over: the next best shows, else the placeholder, and a hand pick still shows it', () => {
		const item = cyndaquil([copy('c30', 'cel25-001', {created_at: at(2)}), copy('c2', 'neo1-001', {created_at: at(1)})]);
		const skipped = new Set(['c30']);

		assert.equal(shownCopy(item, {stored: 'c30'}).entry.id, 'c30');
		assert.deepEqual(shownCopy(item, {skipped, stored: 'c30'}), {entry: item.copies[1], picked: false});
		assert.equal(shownCopy(cyndaquil([item.copies[0]]), {skipped, stored: 'c30'}), null, 'his only copy skipped: the placeholder');
		assert.deepEqual(shownCopy(item, {pick: 'c30', skipped}), {entry: item.copies[0], picked: true});
	});

	test('a copy he gets later fills the pocket: the skip names copies, not the pocket', () => {
		const later = cyndaquil([copy('c30', 'cel25-001'), copy('new', 'sv08-020', {created_at: at(9)})]);

		assert.equal(shownCopy(later, {skipped: new Set(['c30'])}).entry.id, 'new');
	});

	test('skips are read per binder and pocket, and a deleted entry or an empty list skips nothing', () => {
		const list = [
			pick({skipped: ['c30']}),
			pick({binder_id: 'other', id: 'other|dex:155', skipped: ['x']}),
			pick({id: 'johto|dex:152', key: 'dex:152', skipped: []}),
			pick({deleted_at: at(3), id: 'johto|dex:158', key: 'dex:158', skipped: ['y']}),
		];

		assert.deepEqual([...skipsOf(list, 'johto')].map(([key, ids]) => [key, [...ids]]), [['dex:155', ['c30']]]);
		assert.equal(picksOf(list, 'johto').size, 0, 'a skip is not a pick');
		assert.equal(skipsOf(null, 'johto').size, 0);
	});

	test('pickEntry keeps the skips, leaves the field out when there are none, and a copy picked is no longer skipped', () => {
		const previous = pick({skipped: ['c30', 'c2']});

		assert.deepEqual(pickEntry({at: at(5), binderId: 'johto', entryId: null, key: 'dex:155', previous}).skipped, ['c2', 'c30']);
		assert.deepEqual(pickEntry({at: at(5), binderId: 'johto', entryId: 'c2', key: 'dex:155', previous}).skipped, ['c30']);
		assert.equal('skipped' in pickEntry({at: at(5), binderId: 'johto', entryId: 'c9', key: 'dex:155'}), false);
		assert.equal('skipped' in pickEntry({at: at(5), binderId: 'johto', entryId: null, key: 'dex:155', previous, skipped: []}), false);
		assert.deepEqual(pickEntry({at: at(5), binderId: 'johto', entryId: null, key: 'dex:155', skipped: ['b', 'a', 'b', '', 3]}).skipped, ['a', 'b']);
	});

	test('a refresh stores a default that is not skipped, and a partial read never keeps a skipped one', () => {
		const binder = generated('johto', {snapshot: {at: at(0), keys: ['dex:155'], rule_key: 'checklist:list-1|dex', shown: {'dex:155': 'c30'}}});
		const skips = new Map([['dex:155', new Set(['c30'])]]);
		const only = planRefresh(binder, [cyndaquil([copy('c30', 'cel25-001')])], {at: at(10), rankOf: () => ({}), skips});

		assert.equal(only.snapshot.shown['dex:155'], undefined, 'the placeholder');
		assert.deepEqual(only.emptied, ['dex:155']);

		const two = planRefresh(binder, [cyndaquil([copy('c30', 'cel25-001'), copy('c2', 'neo1-001')])], {at: at(10), rankOf: () => ({}), skips});

		assert.equal(two.snapshot.shown['dex:155'], 'c2');

		const partial = planRefresh(binder, [cyndaquil([])], {at: at(10), liveIds: new Set(['c30']), partial: true, rankOf: () => ({}), skips});

		assert.equal(partial.snapshot.shown['dex:155'], undefined);
	});
});

describe('a copy is in one pocket at a time (Eric, 2026-11-24)', () => {
	// Johto (a checklist, older) and the 30th-anniversary binder both want
	// the 30th print of Cyndaquil, c30.
	const johto = (fields = {}) => generated('johto', {created_at: at(1), snapshot: {at: at(1), keys: ['dex:155', 'dex:158'], rule_key: 'checklist:list-1|dex', shown: {'dex:155': 'c30'}}, ...fields});
	const cyndaquil = (copies) => ({copies, dex: 155, key: 'dex:155', name: 'Cyndaquil'});
	const totodile = {copies: [], dex: 158, key: 'dex:158', name: 'Totodile'};
	const c30 = copy('c30', 'cel25-155', {created_at: at(3)});
	const neo = copy('neo', 'neo1-155', {created_at: at(2)});
	const claim = (fields) => ({age: at(5), binderId: 'b30', binderName: '30 anos', entryId: 'c30', index: 4, key: 'international|cel25-155', rank: CLAIM_RANK.card, ...fields});

	test('the order: a hand-made binder, a hand pick, a card pocket, a Pokémon pocket; then the older binder; then the earlier pocket', () => {
		const pokemon = claim({key: 'dex:155', rank: CLAIM_RANK.pokemon});

		assert.equal(outranks(claim({rank: CLAIM_RANK.hand}), claim({rank: CLAIM_RANK.pick})), true);
		assert.equal(outranks(claim({rank: CLAIM_RANK.pick}), claim({age: at(0), rank: CLAIM_RANK.card})), true);
		assert.equal(outranks(claim({age: at(9)}), {...pokemon, age: at(0), binderId: 'johto'}), true, 'a card pocket beats an older Pokémon pocket');
		assert.equal(outranks({...pokemon, age: at(1), binderId: 'johto'}, {...pokemon, age: at(5)}), true, 'the older binder');
		assert.equal(outranks({...pokemon, age: at(1), binderId: 'a'}, {...pokemon, age: at(1), binderId: 'b'}), true, 'same age: the lower id');
		assert.equal(outranks({...pokemon, index: 1}, {...pokemon, index: 7}), true, 'same binder: the earlier pocket');
		assert.equal(outranks(pokemon, pokemon), false);
		assert.equal(outranks({...pokemon, age: undefined, binderId: 'new'}, pokemon), false, 'a binder not saved yet is the newest');
	});

	test('a set goal\'s card pocket takes the print: Johto shows another Cyndaquil, else its placeholder', () => {
		const claims = [claim({})];
		const withNeo = planRefresh(johto(), [cyndaquil([c30, neo]), totodile], {at: at(10), claims, rankOf: () => ({})});

		assert.equal(withNeo.snapshot.shown['dex:155'], 'neo');
		assert.deepEqual(withNeo.inUse, ['dex:155']);
		assert.deepEqual(withNeo.updated, []);
		assert.equal(refreshText(withNeo, () => 'Cyndaquil'), '1 pocket no longer shows a copy in use in another binder or pocket (Cyndaquil).');

		const only = planRefresh(johto(), [cyndaquil([c30]), totodile], {at: at(10), claims, rankOf: () => ({})});

		assert.equal(only.snapshot.shown['dex:155'], undefined, 'the placeholder');
		assert.deepEqual(only.inUse, ['dex:155']);
		assert.deepEqual(only.emptied, [], 'not "no copy you own fits it"');
	});

	test('two Pokémon pockets: the older binder keeps the copy, so an older Johto needs Not this copy here', () => {
		const younger = claim({age: at(5), key: 'dex:155', rank: CLAIM_RANK.pokemon});
		const older = claim({age: at(0), key: 'dex:155', rank: CLAIM_RANK.pokemon});

		assert.equal(planRefresh(johto(), [cyndaquil([c30]), totodile], {at: at(10), claims: [younger], rankOf: () => ({})}).snapshot.shown['dex:155'], 'c30');
		assert.equal(planRefresh(johto(), [cyndaquil([c30]), totodile], {at: at(10), claims: [older], rankOf: () => ({})}).snapshot.shown['dex:155'], undefined);
	});

	test('a hand-made binder and a hand pick elsewhere both outrank a default; this pocket\'s own pick always shows', () => {
		const hand = claim({binderName: 'Favorites', index: 0, key: null, rank: CLAIM_RANK.hand});
		const pickThere = claim({rank: CLAIM_RANK.pick});

		assert.equal(planRefresh(johto(), [cyndaquil([c30, neo]), totodile], {at: at(10), claims: [hand], rankOf: () => ({})}).snapshot.shown['dex:155'], 'neo');
		assert.equal(planRefresh(johto(), [cyndaquil([c30, neo]), totodile], {at: at(10), claims: [pickThere], rankOf: () => ({})}).snapshot.shown['dex:155'], 'neo');

		const item = cyndaquil([c30, neo]);
		const taken = takenFor(claimIndex([hand]), item.copies, {age: at(1), binderId: 'johto', index: 0, key: 'dex:155'});

		assert.deepEqual([...taken.keys()], ['c30']);
		assert.equal(shownCopy(item, {pick: 'c30', taken}).entry.id, 'c30', 'his own pick stands');
		assert.equal(shownCopy(item, {stored: 'c30', taken}).entry.id, 'neo');
	});

	test('this binder\'s own last defaults are worked out again, and within it a copy fills one pocket: card pockets first, then the earlier pocket', () => {
		// A tag team fits #155 and #158; the binder last showed it in both.
		const tag = copy('tag', 'sm12-155', {created_at: at(4)});
		const own = [
			{age: at(1), binderId: 'johto', entryId: 'tag', index: 0, key: 'dex:155', rank: CLAIM_RANK.pokemon},
			{age: at(1), binderId: 'johto', entryId: 'tag', index: 1, key: 'dex:158', rank: CLAIM_RANK.pokemon},
		];
		const binder = johto({snapshot: {at: at(1), keys: ['dex:155', 'dex:158'], rule_key: 'checklist:list-1|dex', shown: {'dex:155': 'tag', 'dex:158': 'tag'}}});
		const plan = planRefresh(binder, [cyndaquil([tag]), {...totodile, copies: [tag]}], {at: at(10), claims: own, rankOf: () => ({})});

		assert.deepEqual(plan.snapshot.shown, {'dex:155': 'tag'});
		assert.deepEqual(plan.inUse, ['dex:158']);
	});

	test('no claims: the layout is today\'s', () => {
		const plan = planRefresh(johto(), [cyndaquil([c30, neo]), totodile], {at: at(10), rankOf: () => ({})});

		assert.equal(plan.snapshot.shown['dex:155'], 'c30');
		assert.deepEqual(plan.inUse, []);
		assert.equal(plan.changed, false);
	});
});

describe('cards added by hand (Eric, 2026-11-24)', () => {
	const extra = (key, kind, minute) => ({at: at(minute), key, kind});

	test('the latest entry per card stands, in the order added, and only card keys count', () => {
		const binder = {extra_cards: [extra('international|b', 'add', 2), extra('international|a', 'add', 1), extra('international|b', 'none', 3), extra('international|c', 'add', 4), extra('dex:25', 'add', 5), {key: 'international|d', kind: 'odd', at: at(6)}]};

		assert.deepEqual(extraCardEntries(binder).map((entry) => [entry.key, entry.kind]), [['international|a', 'add'], ['international|b', 'none'], ['international|c', 'add']]);
		assert.deepEqual(extraKeysOf(binder), ['international|a', 'international|c']);
		assert.deepEqual(extraKeysOf({}), []);
	});

	test('they join after the list\'s items, once, and a card the list has keeps its list pocket', () => {
		const binder = {extra_cards: [extra('international|x', 'add', 1), extra('international|l', 'add', 2)]};
		const items = withExtraItems([{key: 'international|l'}], binder, (key) => ({added: true, key}));

		assert.deepEqual(items, [{key: 'international|l'}, {added: true, key: 'international|x'}]);
	});

	test('they fill the extra pages first, and add pages only once those are full', () => {
		// 2 × 2: four list pockets (one page) and two extra pages.
		assert.equal(listPageCount(4, 2, 2, 2, 0), 3);
		assert.equal(listPageCount(9, 2, 2, 2, 5), 3, 'five added cards fit the two extra pages');
		assert.equal(listPageCount(13, 2, 2, 2, 9), 4, 'nine do not: one page more');
		assert.equal(listPageCount(6, 2, 2, 0, 2), 2, 'no extra pages: the added cards make their own');
	});

	test('a refresh lays them out after the list and counts their pages that way', () => {
		const binder = generated('b1', {cols: 2, extra_cards: [extra('international|tst1-150', 'add', 1)], extra_pages: 1, page_count: 2, rows: 2, snapshot: {at: at(0), keys: ['dex:1', 'dex:4', 'dex:7', 'dex:25', 'international|tst1-150'], rule_key: 'checklist:list-1|dex', shown: {}}});
		const items = withExtraItems([1, 4, 7, 25].map((n) => ({copies: [], dex: n, key: `dex:${n}`, name: `Mon ${n}`})), binder, (key) => ({copies: [copy('m1', 'tst1-150')], key, kind: 'card', name: 'Mewtwo'}));
		const plan = planRefresh(binder, items, {at: at(10), rankOf: () => ({})});

		assert.deepEqual(plan.snapshot.keys, ['dex:1', 'dex:4', 'dex:7', 'dex:25', 'international|tst1-150']);
		assert.equal(plan.snapshot.shown['international|tst1-150'], 'm1');
		assert.equal(plan.page_count, 2, 'the added card sits on the extra page');
		assert.deepEqual(plan.added, []);
	});

	test('two phones adding different cards both keep theirs', () => {
		const base = generated('g1');
		const a = {...base, extra_cards: [extra('international|a', 'add', 1)], updated_at: at(1)};
		const b = {...base, extra_cards: [extra('international|b', 'add', 2)], updated_at: at(2)};

		for (const [left, right] of [[a, b], [b, a]]) {
			const [merged] = mergeDocuments({binders: [left], cards: []}, {binders: [right], cards: []}).binders;

			assert.deepEqual(extraKeysOf(merged), ['international|a', 'international|b']);
		}
	});
});

describe('extra pages (Eric, 2026-11-24)', () => {
	test('blank pages after the list: a whole number, never past 200 pages in all', () => {
		assert.equal(extraPagesOf({}), 0);
		assert.equal(extraPagesOf({extra_pages: 5}), 5);
		assert.equal(extraPagesOf({extra_pages: -2}), 0);
		assert.equal(extraPagesOf({extra_pages: 2.5}), 0);
		assert.equal(extraPagesOf({extra_pages: '3'}), 3);
		assert.equal(listPageCount(10, 3, 3, 0), 2);
		assert.equal(listPageCount(10, 3, 3, 5), 7);
		assert.equal(listPageCount(1700, 3, 3, 50), 200);
	});

	test('a refresh keeps the extra pages, and a change of them is a change to save', () => {
		const binder = generated('b1', {extra_pages: 3, page_count: 4});
		// The stored layout: dex:1 shows c1, the others none.
		const items = [1, 4, 7].map((n) => ({copies: n === 1 ? [copy('c1', 'p1')] : [], dex: n, key: `dex:${n}`, name: `Mon ${n}`}));
		const plan = planRefresh(binder, items, {at: at(10), rankOf: () => ({})});

		assert.equal(plan.page_count, 4);
		assert.equal(plan.changed, false);
		assert.equal(planRefresh({...binder, extra_pages: 1}, items, {at: at(10), rankOf: () => ({})}).changed, true);
		assert.equal(planRefresh({...binder, extra_pages: 1}, items, {at: at(10), rankOf: () => ({})}).page_count, 2);
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

	test('a pocket that had a copy and has none now is told as emptied', () => {
		const binder = generated('b1', {snapshot: {at: at(0), keys: ['dex:1', 'dex:4', 'dex:7'], rule_key: 'checklist:list-1|dex', shown: {'dex:1': 'c1', 'dex:4': 'c4'}}});
		const plan = planRefresh(binder, [item(1, [copy('c1', 'p1')]), item(4), item(7)], {at: at(10), rankOf: () => ({})});

		assert.deepEqual(plan.emptied, ['dex:4']);
		assert.deepEqual([plan.filled, plan.updated], [[], []]);
		assert.equal(plan.changed, true);
		assert.equal(refreshText(plan, (key) => key.replace('dex:', 'Mon ')), '1 pocket emptied: no copy you own fits it now (Mon 4).');

		const two = planRefresh(binder, [item(1), item(4), item(7)], {at: at(10), rankOf: () => ({})});

		assert.deepEqual(two.emptied, ['dex:1', 'dex:4']);
		assert.equal(refreshText(two, (key) => key.replace('dex:', 'Mon ')), '2 pockets emptied: no copy you own fits them now (Mon 1 and Mon 4).');
	});

	// A list that counts Portuguese only: #25 is owned only in English, #26
	// in both. An older phone (v56) fills a binder made from it from any
	// language, this one from the list's languages.
	describe('a list\'s languages and an older phone', () => {
		const en25 = copy('en25', 'x25');
		const pt26 = copy('pt26', 'x26', {language: 'pt'});
		const en26 = copy('en26', 'x26', {created_at: at(5)});
		const listItems = [item(25), item(26, [pt26])];
		const anyItems = [item(25, [en25]), item(26, [pt26, en26])];
		const base = generated('b1', {snapshot: {at: at(0), keys: ['dex:25', 'dex:26'], rule_key: 'checklist:list-1|dex', shown: {}}});
		const older = (binder) => planRefresh(binder, anyItems, {at: at(10), rankOf: () => ({})});
		const opened = (binder) => planRefresh(binder, listItems, {anyItems, at: at(10), languages: 'pt', rankOf: () => ({})});
		const saved = (binder, plan) => ({...binder, ...(plan.languages === undefined ? {} : {list_languages: plan.languages}), page_count: plan.page_count, snapshot: plan.snapshot});

		test('a refresh that differs from the older phone\'s only by the list\'s languages is not saved on opening, once the binder records those languages', () => {
			const v56 = saved(base, older(base));

			assert.deepEqual(v56.snapshot.shown, {'dex:25': 'en25', 'dex:26': 'en26'});

			const plan = opened({...v56, list_languages: 'pt'});

			assert.equal(plan.changed, true);
			assert.equal(plan.languageOnly, true, 'the older phone would put it back');
			assert.deepEqual(plan.emptied, ['dex:25']);
			assert.equal(plan.languages, 'pt');
			assert.equal(opened(v56).languageOnly, false, 'the binder never recorded the list\'s languages: save, and record them');
			assert.equal(opened({...v56, list_languages: 'en,pt'}).languageOnly, false, 'the list\'s languages changed since');
			assert.equal(planRefresh({...v56, list_languages: 'pt'}, listItems, {at: at(10), languages: 'pt', rankOf: () => ({})}).languageOnly, false, 'no any-language reading to compare with');

			// Something the older phone would save too (a new copy) is saved.
			const more = [item(25, [en25, copy('en25b', 'x25', {created_at: at(6)})]), item(26, [pt26, en26])];

			assert.equal(planRefresh({...v56, list_languages: 'pt'}, listItems, {anyItems: more, at: at(10), languages: 'pt', rankOf: () => ({})}).languageOnly, false);
		});

		test('two phones opening the binder in turn stop saving after one round', () => {
			let binder = base;
			const saves = [];

			for (const who of ['v57', 'v56', 'v57', 'v56', 'v57', 'v56']) {
				const plan = who === 'v57' ? opened(binder) : older(binder);
				const save = plan.changed && !(who === 'v57' && plan.languageOnly);

				saves.push(`${who}:${save}`);

				if (save) {
					binder = who === 'v57' ? saved(binder, plan) : {...binder, page_count: plan.page_count, snapshot: plan.snapshot};
				}
			}

			assert.deepEqual(saves, ['v57:true', 'v56:true', 'v57:false', 'v56:false', 'v57:false', 'v56:false']);
			assert.equal(binder.list_languages, 'pt', 'the older phone keeps the field it does not know');
		});
	});

	test('a new rule or grid always saves', () => {
		const binder = generated('b1', {rule: {order: 'name', source: {id: 'list-1', kind: 'checklist'}}});
		const plan = planRefresh(binder, [item(1, [copy('c1', 'p1')]), item(4), item(7)], {at: at(10), rankOf: () => ({})});

		assert.equal(plan.changed, true);
		assert.equal(plan.snapshot.rule_key, 'checklist:list-1|name');
		assert.equal(planRefresh({...generated('b1'), rows: 1, cols: 1}, [item(1, [copy('c1', 'p1')]), item(4), item(7)], {at: at(10), rankOf: () => ({})}).page_count, 3);
	});
});

// A Pokémon goal in set order keeps its pockets in place (keepOrder,
// js/binder-sources.js POKEMON_GOAL_ORDER): new cards at the end, and a
// card left out, kept as a gap, or put back where its list place is.
describe('keeping the pockets in place', () => {
	const cards = (...ids) => ids.map((id) => ({copies: [], key: `international|${id}`, kind: 'card', name: id, number: id.split('-')[1], releaseDate: `20${id.split('-')[1]}-01-01`, setId: id.split('-')[0]}));
	const keys = (...ids) => ids.map((id) => (id ? `international|${id}` : ''));
	const rule = {order: 'set', source: {id: 'g1', kind: 'goal'}};
	const binder = (stored, edits = []) => generated('b1', {list_edits: edits, rule, snapshot: {at: at(0), keys: keys(...stored), rule_key: 'goal:g1|set', shown: {}}});
	const plan = (stored, list, edits = []) => planRefresh(binder(stored, edits), cards(...list), {at: at(10), keepOrder: true, rankOf: () => ({})}).snapshot.keys;

	test('keptOrder: the stored keys keep their places, edited ones take their list places, new ones go last', () => {
		assert.deepEqual(keptOrder(['a', 'b', 'c', 'd'], ['c', 'a', 'b']), ['c', 'a', 'b', 'd']);
		assert.deepEqual(keptOrder(['a', 'b', 'c'], ['a', '', 'c'], [{key: 'b', kind: 'gap'}]), ['a', 'b', 'c'], 'a gap\'s key takes its empty pocket');
		assert.deepEqual(keptOrder(['a', 'b', 'c', 'd'], ['', 'c', 'a', ''], [{key: 'b', kind: 'gap'}, {key: 'd', kind: 'gap'}]), ['b', 'c', 'a', 'd'], 'gaps take the empty pockets in order');
		assert.deepEqual(keptOrder(['a', 'b', 'c'], ['a', '', 'c'], [{key: 'b', kind: 'none'}]), ['a', 'b', 'c'], 'a gap put back returns to its place');
		assert.deepEqual(keptOrder(['a', 'c'], ['a', '', 'c'], []), ['a', 'c'], 'an empty pocket no gap takes goes');
		assert.deepEqual(keptOrder(['a', 'b', 'c'], ['a', 'c'], []), ['a', 'c', 'b'], 'a key never edited is new');
		assert.deepEqual(keptOrder(['a', 'c'], ['a', 'b', 'c']), ['a', 'c'], 'a key that left the list leaves');
	});

	test('a card new to the list joins at the end, whatever its date', () => {
		assert.deepEqual(plan(['s-10', 's-20', 's-30'], ['s-05', 's-10', 's-20', 's-25', 's-30']), keys('s-10', 's-20', 's-30', 's-05', 's-25'));
	});

	test('a gap stays where it is, a card left out stays out, Put back returns a card to its place, and a move to the end stays last', () => {
		const gap = {at: at(1), key: 'international|s-20', kind: 'gap'};

		assert.deepEqual(plan(['s-10', '', 's-30'], ['s-10', 's-20', 's-30', 's-40'], [gap]), keys('s-10', '', 's-30', 's-40'));
		assert.deepEqual(plan(['s-10', 's-30'], ['s-10', 's-20', 's-30', 's-40'], [{...gap, kind: 'out'}]), keys('s-10', 's-30', 's-40'));
		assert.deepEqual(plan(['s-10', 's-30'], ['s-10', 's-20', 's-30', 's-40'], [{...gap, at: at(2), kind: 'none'}]), keys('s-10', 's-20', 's-30', 's-40'));
		assert.deepEqual(plan(['s-20', 's-30', 's-10'], ['s-10', 's-20', 's-30', 's-40'], [{at: at(1), key: 'international|s-10', kind: 'end'}]), keys('s-20', 's-30', 's-40', 's-10'));
	});

	// The stored order drifts from the rule's once a card joins at the end
	// or one is moved: a gap keeps its pocket, the pockets after it stay,
	// and Put back anchors on a pocket still in the rule's order.
	test('with the stored order off the rule\'s, a gap stays, nothing shifts, and Put back returns a card where it was', () => {
		const gap = {at: at(1), key: 'international|s-20', kind: 'gap'};
		const run = (stored, list, edits) => planRefresh(binder(stored, edits), cards(...list), {at: at(10), keepOrder: true, rankOf: () => ({})});

		// A late print joins at the end; the next refresh, with nothing new,
		// changes nothing and saves nothing.
		const first = run(['s-10', '', 's-30'], ['s-10', 's-15', 's-20', 's-30'], [gap]);

		assert.deepEqual(first.snapshot.keys, keys('s-10', '', 's-30', 's-15'));

		const second = run(['s-10', '', 's-30', 's-15'], ['s-10', 's-15', 's-20', 's-30'], [gap]);

		assert.deepEqual(second.snapshot.keys, keys('s-10', '', 's-30', 's-15'), 'the gap does not jump and s-30 does not move');
		assert.equal(second.changed, false, 'nothing to save');

		// Put back of a card left out, after the late print joined: where
		// it was, not after the print added at the end.
		assert.deepEqual(run(['s-10', 's-30', 's-15'], ['s-10', 's-15', 's-20', 's-30'], [{...gap, at: at(2), kind: 'none'}]).snapshot.keys, keys('s-10', 's-20', 's-30', 's-15'));
		// And of the gap itself, into its pocket.
		assert.deepEqual(run(['s-10', '', 's-30', 's-15'], ['s-10', 's-15', 's-20', 's-30'], [{...gap, at: at(2), kind: 'none'}]).snapshot.keys, keys('s-10', 's-20', 's-30', 's-15'));

		// The card before the gap moved to the end: the gap stays first, and
		// the first opening saves nothing.
		const moved = run(['', 's-30', 's-40', 's-10'], ['s-10', 's-20', 's-30', 's-40'], [gap, {at: at(2), key: 'international|s-10', kind: 'end'}]);

		assert.deepEqual(moved.snapshot.keys, keys('', 's-30', 's-40', 's-10'));
		assert.equal(moved.changed, false);
	});

	// A set of an Asian catalog not read leaves its cards undated, never
	// missing: a binder in place waits only while a card new to it is
	// undated in such a set. A catalog not read still waits.
	test('a set not read holds the binder only while a card new to it is undated', () => {
		const ja = (id, releaseDate = null) => ({copies: [], key: `ja|${id}`, kind: 'card', catalog: 'ja', cardId: id, releaseDate, setId: id.split('-')[0]});
		const stored = generated('b1', {rule, snapshot: {at: at(0), keys: ['ja|SV2a-039', '', 'ja|S4a-001'], rule_key: 'goal:g1|set', shown: {}}});
		const setsGap = [{catalog: 'ja', count: 1, kind: 'sets', setIds: ['SV2a']}];
		const loaded = (items, gaps = setsGap, extra = {}) => ({gaps, incomplete: true, items, keepOrder: true, ...extra});
		const read = [ja('SV2a-039'), ja('S4a-001', '2020-01-01')];

		assert.equal(layoutWaits(stored, {gaps: [], incomplete: false, items: read, keepOrder: true}), false, 'the whole list');
		assert.equal(layoutWaits(stored, loaded(read)), false, 'every card is in the binder already');
		assert.equal(layoutWaits(stored, loaded([...read, ja('S5a-002', '2021-01-01')])), false, 'a new card from a set read');
		assert.equal(layoutWaits(stored, loaded([...read, ja('SV2a-100')])), true, 'a new card undated in the set not read');
		assert.equal(layoutWaits(stored, loaded([...read, ja('SV9-001')])), false, 'a new card undated in a set read (no date in TCGdex)');
		assert.equal(layoutWaits(stored, loaded(read, [{catalog: 'ja', kind: 'list'}])), true, 'a catalog not read');
		assert.equal(layoutWaits(stored, loaded(read, [...setsGap, {catalog: 'international', kind: 'index'}])), true, 'the set index not read');
		assert.equal(layoutWaits(stored, loaded(read, setsGap, {keepOrder: false})), true, 'a binder that does not keep its pockets');
		assert.equal(layoutWaits({rule}, loaded(read)), true, 'a new binder');
		assert.equal(layoutWaits(null, loaded(read)), true, 'no binder');
		assert.equal(layoutWaits({...stored, rule: {order: 'release', source: {id: 'g1', kind: 'goal'}}}, loaded(read)), true, 'another rule lays it out again');
	});

	test('a new rule lays the list out in its own order', () => {
		const other = planRefresh({...binder(['s-30', 's-10']), rule: {order: 'release', source: {id: 'g1', kind: 'goal'}}}, cards('s-10', 's-30'), {at: at(10), keepOrder: true, rankOf: () => ({})});

		assert.deepEqual(other.snapshot.keys, keys('s-10', 's-30'), 'not the stored s-30, s-10');
		assert.deepEqual(planRefresh(binder([]), cards('s-30', 's-10'), {at: at(10), keepOrder: true, rankOf: () => ({})}).snapshot.keys, keys('s-30', 's-10'), 'a first layout is the list\'s order');
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

// ------------------------------------------------------ browser tests

let chromium = null;

try {
	({chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT || 'playwright'));
}
catch {
	// No Playwright: the browser tests are skipped below.
}

const BASE = '/pokemon-card-tracker/';
const AT = '2026-09-01T00:00:00.000Z';
const SHOTS = '/tmp/binder-from-list';

const card = (id, cardId, fields = {}) => ({card_id: cardId, catalog: 'international', created_at: AT, deleted_at: null, id, language: 'pt', language_source: 'import', updated_at: AT, ...fields});

// Made-up cards. Test mon 1 has three copies: c1 carries a Liga price, so
// it is the most valuable; c3 is the rarest; c2 is a plain copy.
const CARDS = [
	card('c1', 'tst1-001', {created_at: '2026-09-01T00:00:00.000Z', price_manual: {avg: 40, currency: 'BRL', date: '2026-09-02'}}),
	card('c2', 'tst1-001', {created_at: '2026-09-03T00:00:00.000Z', language: 'en'}),
	card('c3', 'tst2-001', {created_at: '2026-09-02T00:00:00.000Z'}),
	card('c4', 'tst1-004'),
	card('c5', 'tst1-007'),
	card('c6', 'tst1-090'),
];

const record = (id, number, name, fields = {}) => ({
	catalog: 'international',
	category: 'Pokemon',
	collector_number: number,
	id,
	// The v46 record shape: a record without illustrator is read again
	// (js/catalog.js hasDetails).
	illustrator: null,
	localizations: {en: {image: null, lang: 'en', name, set_name: id.startsWith('tst2') ? 'Test set two' : 'Test set one'}},
	rarity: 'Common',
	release_date: id.startsWith('tst2') ? '2025-03-01' : '2024-01-01',
	set_id: id.split('-')[0],
	types: ['Grass'],
	...fields,
});

const RECORDS = [
	record('tst1-001', '001', 'Test Sprout', {dex_ids: [1]}),
	record('tst2-001', '001', 'Test Sprout ex', {dex_ids: [1], rarity: 'Special illustration rare'}),
	record('tst1-004', '004', 'Test Ember', {dex_ids: [4], types: ['Fire']}),
	record('tst1-007', '007', 'Test Splash', {dex_ids: [7], types: ['Water']}),
	record('tst1-025', '025', 'Test Spark', {dex_ids: [25], types: ['Lightning']}),
	record('tst1-090', '090', 'Test Potion', {category: 'Trainer', dex_ids: [], types: []}),
];

const DEX = [
	{dexId: [1], id: 'tst1-001'},
	{dexId: [1], id: 'tst2-001'},
	{dexId: [4], id: 'tst1-004'},
	{dexId: [6], id: 'tst1-006'},
	{dexId: [7], id: 'tst1-007'},
	{dexId: [25], id: 'tst1-025'},
	{dexId: null, id: 'tst1-090'},
	// Eric's Kalos cats (2026-11-24): Espurr, and Meowstic male and female.
	{dexId: [677], id: 'tst3-077'},
	{dexId: [678], id: 'tst3-078'},
	{dexId: [678], id: 'tst3-079'},
];

const CAT_RECORDS = [
	record('tst3-077', '077', 'Test Espurr', {dex_ids: [677], set_id: 'tst3', types: ['Psychic']}),
	record('tst3-078', '078', 'Test Meowstic', {dex_ids: [678], set_id: 'tst3', types: ['Psychic']}),
	record('tst3-079', '079', 'Test Meowstic F', {dex_ids: [678], set_id: 'tst3', types: ['Psychic']}),
];

// Set tst1 for a set goal: four cards, one of them not owned.
const SET_CARDS = [
	{id: 'tst1-001', localId: '001', name: 'Test Sprout', rarity: 'Common'},
	{id: 'tst1-004', localId: '004', name: 'Test Ember', rarity: 'Common'},
	{id: 'tst1-007', localId: '007', name: 'Test Splash', rarity: 'Common'},
	{id: 'tst1-025', localId: '025', name: 'Test Spark', rarity: 'Rare'},
];

// Portuguese picked by hand, stamped as js/checklists.js setListLanguages
// saves it, so it is no old default for js/merge.js planDefaultListLanguages
// to take off.
const PICKED_PT = {field_stamps: {at: '2026-09-02T00:00:00.000Z', languages: '2026-09-02T00:00:00.000Z', since: AT}, languages: ['pt'], updated_at: '2026-09-02T00:00:00.000Z'};

const CHECKLIST = {created_at: AT, deleted_at: null, dex_list: [1, 4, 7, 25], hand_ticks: {}, id: 'list-1', kind: 'custom_pokemon', name: 'Test starters', target: null, updated_at: AT};
const COLLECTION = {created_at: AT, deleted_at: null, entry_ids: {c4: AT, c5: AT}, id: 'col-1', kind: 'hand', name: 'Test favorites', rule: null, updated_at: AT};
const SET_GOAL = {catalog: 'international', created_at: AT, deleted_at: null, id: 'goal-1', kind: 'set', level: 'secrets', name: 'Test set one', target: 'tst1', updated_at: AT};

const documentWith = (extra = {}) => ({
	binders: [],
	cards: CARDS,
	collections: [COLLECTION],
	goals: [CHECKLIST, SET_GOAL],
	openings: [],
	person: 'local',
	updated_at: AT,
	user_id: null,
	version: 1,
	wishlist: [],
	...extra,
});

let browser;
let pages;
let origin;

const url = (path = '') => `${origin}${BASE}${path}`;

async function fakeServices(context, net) {
	const {fakePokeApi} = await import('./fake-pokeapi.mjs');

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await fakePokeApi(context, {offline: () => net.offline});
	await context.route('https://api.tcgdex.net/**', (route) => {
		if (net.offline) {
			return route.abort('internetdisconnected');
		}

		const request = route.request();
		const path = new URL(request.url()).pathname.replace('/v2/', '');
		const json = (body) => route.fulfill({body: JSON.stringify(body), contentType: 'application/json', status: 200});

		if (path === 'graphql') {
			const {query} = JSON.parse(request.postData() || '{}');

			if (/cards\s*\{\s*id\s+dexId/.test(query)) {
				return json({data: {cards: DEX}});
			}

			if (query.includes('"tst1-"')) {
				return json({data: {cards: SET_CARDS}});
			}

			return json({data: {cards: []}});
		}

		// Single cards, for a phone whose card index lacks them (a family
		// member's).
		const single = /^en\/cards\/(.+)$/.exec(path);
		const known = single && RECORDS.find((item) => item.id === single[1]);

		if (known) {
			return json({id: known.id, image: null, localId: known.collector_number, name: known.localizations.en.name, set: {id: known.set_id, name: known.localizations.en.set_name}});
		}

		if (path === 'en/sets/tst1') {
			return json({cardCount: {official: 4, total: 4}, cards: SET_CARDS, id: 'tst1', name: 'Test set one', releaseDate: '2024-01-01'});
		}

		return route.fulfill({body: '{}', contentType: 'application/json', status: 404});
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await context.route(/githubusercontent/, (route) => route.abort());
}

async function device(fake, name, {viewport = {height: 740, width: 360}} = {}) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport});
	await fakeRates(context);
	const net = {offline: false};

	await fakeServices(context, net);
	// css/reorder.css, as the binder tests add it until index.html links it.
	await context.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
		if (!document.querySelector('link[href$="css/reorder.css"]')) {
			document.head.append(Object.assign(document.createElement('link'), {href: '/pokemon-card-tracker/css/reorder.css', rel: 'stylesheet'}));
		}
	}));

	if (fake) {
		await fake.attach(context, name);
	}
	else {
		await context.route('https://*.supabase.co/**', (route) => {
			throw new Error(`Unexpected Supabase request: ${route.request().url()}`);
		});
	}

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	return {context, errors, net, page};
}

async function seedLocal(page, doc, records = RECORDS) {
	await page.goto(url('cards'));
	await page.evaluate(async ({stored, cards}) => {
		await new Promise((resolve, reject) => {
			const open = indexedDB.open('card-tracker-collection', 1);

			open.onupgradeneeded = () => open.result.createObjectStore('documents');
			open.onsuccess = () => {
				const tx = open.result.transaction('documents', 'readwrite');

				tx.objectStore('documents').put(stored, 'local');
				tx.oncomplete = () => {
					open.result.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
			open.onerror = () => reject(open.error);
		});
		await (await import('/pokemon-card-tracker/js/catalog.js')).saveToCardIndex(cards);
	}, {cards: records, stored: doc});
	await page.reload();
}

const localDoc = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).loadDocument());

const zoomPocket = (n) => `#bs-zoom-sheet .pocket[data-position="${n}"]`;
// A pocket of page pg as shown: in the spread, or upright, on the page
// open alone (design review, 2026-11-19).
const spreadPocket = (pg, n) => `#bs-spread:not([hidden]) .bs-page[data-page="${pg}"] .pocket[data-position="${n}"], #bs-zoom:not([hidden]) .bs-page[data-page="${pg}"] .pocket[data-position="${n}"]`;

async function waitForPocket(page, selector, check) {
	await page.waitForFunction(({selector: sel, check: wanted}) => {
		const el = document.querySelector(sel);

		return Boolean(el) && Object.entries(wanted).every(([key, value]) => (key === 'label' ? new RegExp(value).test(el.getAttribute('aria-label')) : el.dataset[key] === value));
	}, {check, selector}, {timeout: 15000});
}

// Close takes back the history entry the sheet added; wait for that
// before navigating on.
async function closeSheet(page) {
	await page.click('#sheet-close');
	await page.waitForFunction(() => !document.querySelector('#pocket-sheet[open]'));
	await page.waitForTimeout(300);
}

async function openPage(page, pg) {
	// Upright, a binder opens on one page (design review, 2026-11-19): a
	// tap on the page in the spread, else the page slider steps to it.
	const open = page.locator(`.bs-open[data-open="${pg}"]`);

	if (await open.isVisible()) {
		await open.click();
	}
	else {
		await page.waitForSelector('#binder-spread[data-view="page"]');
		await page.locator('#bs-zoom #bs-slider').evaluate((node, to) => {
			node.value = String(to);
			node.dispatchEvent(new Event('change', {bubbles: true}));
		}, pg);
	}

	await page.waitForFunction((wanted) => {
		const root = document.getElementById('binder-spread');

		return root && root.dataset.zoom === wanted;
	}, String(pg), {timeout: 10000});
}

async function signIn(page, fake, email) {
	await page.goto(url('signin'));
	await page.fill('#signin-email', email);
	await page.click('button:has-text("Send link")');
	await page.waitForSelector('#check-email');

	const code = fake.issueCode(email);

	await page.goto(`${url()}?code=${code}`);
	await page.waitForSelector('#account.avatar');
}

async function waitForStatus(page, text) {
	await page.waitForFunction((expected) => {
		const line = document.getElementById('sync-status');

		return line && !line.hidden && line.textContent === expected;
	}, text, {timeout: 15000});
}

async function until(check, timeout = 15000) {
	const end = Date.now() + timeout;

	while (!check()) {
		if (Date.now() > end) {
			throw new Error('Timed out waiting.');
		}

		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

describe('binders from a list in the browser', {skip: chromium ? false : 'Playwright is not installed; set PLAYWRIGHT'}, () => {
	before(async () => {
		const {mkdir} = await import('node:fs/promises');
		const {startPagesServer} = await import('./pages-server.mjs');

		await mkdir(SHOTS, {recursive: true});
		pages = await startPagesServer();
		origin = pages.origin;
		browser = await chromium.launch();
	});

	after(async () => {
		await browser?.close();
		await pages?.close();
	});

	test('a copy in use in an older binder from a list leaves a younger one\'s pocket to another copy or its placeholder (Eric, 2026-11-24)', async () => {
		const {context, errors, page} = await device(null, 'phone');
		const makeFromList = async (name) => {
			await page.click('.tabs a[data-tab="binders"]');
			await page.click('#new-binder');
			await page.check('#new-binder-list');
			await page.waitForSelector('#rule-section');
			await page.check('#rule-kind input[value="checklist"]');
			await page.selectOption('#rule-list', 'list-1');
			await page.click('.binder-preset[data-preset="4-pocket"]');
			await page.fill('#binder-name', name);
			await page.waitForFunction(() => /4 pockets/.test((document.getElementById('rule-count') || {}).textContent), null, {timeout: 15000});
			await page.click('#binder-save');
			await page.waitForSelector('#binder-spread .bs-page');
		};

		await seedLocal(page, documentWith());
		await makeFromList('Older');
		await makeFromList('Younger');

		// Bulbasaur has three copies: the older binder shows the best, the
		// younger the next. Charmander and Squirtle have one each, so the
		// younger binder shows their placeholders.
		let doc = await localDoc(page);
		const [older, younger] = [...doc.binders].sort((a, b) => a.created_at.localeCompare(b.created_at));

		assert.deepEqual(older.snapshot.shown, {'dex:1': 'c1', 'dex:4': 'c4', 'dex:7': 'c5'});
		assert.equal(younger.snapshot.shown['dex:4'], undefined);
		assert.equal(younger.snapshot.shown['dex:7'], undefined);
		assert.ok(younger.snapshot.shown['dex:1'] && younger.snapshot.shown['dex:1'] !== 'c1', `another Bulbasaur: ${younger.snapshot.shown['dex:1']}`);

		await openPage(page, 1);
		await waitForPocket(page, zoomPocket(2), {kind: 'want'});
		await page.click(zoomPocket(2));
		await page.waitForSelector('#list-copies .list-copy[data-entry="c4"] .list-in-use-tag');
		assert.equal(await page.locator('#list-copies .list-copy[data-entry="c4"] .list-in-use-tag').textContent(), 'In use in Older');

		// A hand pick is his say: it shows here too.
		await page.click('#list-copies .list-copy[data-entry="c4"]');
		await waitForPocket(page, zoomPocket(2), {kind: 'card', picked: 'true'});
		doc = await localDoc(page);
		assert.deepEqual(doc.binder_picks.map((pick) => [pick.binder_id, pick.key, pick.entry_id]), [[younger.id, 'dex:4', 'c4']]);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Meowstic: a pocket inserted after #678 takes the female, which shows there though #678 fits her too (Eric, 2026-11-24)', async () => {
		const {context, errors, page} = await device(null, 'phone');
		const cats = [
			card('e1', 'tst3-077', {created_at: '2026-09-01T00:00:00.000Z'}),
			card('m1', 'tst3-078', {created_at: '2026-09-02T00:00:00.000Z'}),
			card('f1', 'tst3-079', {created_at: '2026-09-03T00:00:00.000Z'}),
		];

		await seedLocal(page, documentWith({cards: cats, goals: [{...CHECKLIST, dex_list: [677, 678], id: 'list-cats', name: 'Kalos cats'}]}), [...RECORDS, ...CAT_RECORDS]);
		await page.click('.tabs a[data-tab="binders"]');
		await page.click('#new-binder');
		await page.check('#new-binder-list');
		await page.waitForSelector('#rule-section');
		await page.check('#rule-kind input[value="checklist"]');
		await page.selectOption('#rule-list', 'list-cats');
		await page.click('.binder-preset[data-preset="4-pocket"]');
		await page.waitForFunction(() => /2 pockets/.test((document.getElementById('rule-count') || {}).textContent), null, {timeout: 15000});
		await page.click('#binder-save');
		await page.waitForSelector('#binder-spread .bs-page');

		let doc = await localDoc(page);

		// The newest Meowstic, the female, shows in #678 by default.
		assert.deepEqual(doc.binders[0].snapshot.keys, ['dex:677', 'dex:678']);
		assert.equal(doc.binders[0].snapshot.shown['dex:678'], 'f1');

		// Insert a pocket after Meowstic's.
		await openPage(page, 1);
		await page.click(zoomPocket(2));
		await page.waitForFunction(() => document.getElementById('pocket-viewer')?.dataset.state === 'open');
		await page.click('#pv-details');
		await page.waitForSelector('#list-insert-after');
		await page.click('#list-insert-after');
		await page.waitForFunction(() => import('/pokemon-card-tracker/js/collection.js').then((m) => m.loadDocument()).then((d) => d.binders[0].snapshot.keys.length === 3), null, {timeout: 15000});
		doc = await localDoc(page);
		assert.deepEqual(doc.binders[0].snapshot.keys, ['dex:677', 'dex:678', '']);
		assert.match(doc.binders[0].snapshot.marks[2], /^blank:/);
		await page.waitForFunction(() => !document.querySelector('#pocket-sheet[open]'));
		await waitForPocket(page, zoomPocket(3), {kind: 'open'});

		// Add a card here: the female Meowstic.
		await page.click(zoomPocket(3));
		await page.waitForSelector('#list-add-here');
		assert.deepEqual(await page.locator('#list-sheet-actions, .list-arrange button').evaluateAll((nodes) => nodes.map((node) => node.id)), ['list-add-here', 'list-insert-before', 'list-insert-after', 'list-close']);
		await page.click('#list-add-here');
		await page.waitForSelector('#owned-results .pick[data-entry="f1"]');
		await page.click('#owned-results .pick[data-entry="f1"]');
		await waitForPocket(page, zoomPocket(3), {kind: 'card', label: 'Test Meowstic F.*picked by hand', picked: 'true'});
		// #678 shows the male now: the female is his pick in the new pocket.
		await waitForPocket(page, zoomPocket(2), {kind: 'card', label: 'Test Meowstic,'});
		await page.screenshot({path: `${SHOTS}/meowstic-360.png`});

		doc = await localDoc(page);
		assert.deepEqual(doc.binders[0].snapshot.keys, ['dex:677', 'dex:678', 'international|tst3-079']);
		assert.deepEqual(doc.binders[0].extra_cards.map((entry) => [entry.key, entry.kind]), [['international|tst3-079', 'add']]);
		assert.deepEqual(doc.binder_picks.filter((pick) => pick.entry_id).map((pick) => [pick.key, pick.entry_id]), [['international|tst3-079', 'f1']]);

		// A refresh keeps it all where it is, and stores the male as #678's.
		await page.click('#binder-refresh');
		await page.waitForFunction(() => import('/pokemon-card-tracker/js/collection.js').then((m) => m.loadDocument()).then((d) => d.binders[0].snapshot.shown['dex:678'] === 'm1'), null, {timeout: 15000});
		doc = await localDoc(page);
		assert.deepEqual(doc.binders[0].snapshot.keys, ['dex:677', 'dex:678', 'international|tst3-079']);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('extra pages after the list, Not this copy here, and Keep the placeholder (Eric, 2026-11-24)', async () => {
		const {context, errors, page} = await device(null, 'phone');

		await seedLocal(page, documentWith());
		await page.click('.tabs a[data-tab="binders"]');
		await page.click('#new-binder');
		await page.check('#new-binder-list');
		await page.waitForSelector('#rule-section');
		await page.check('#rule-kind input[value="checklist"]');
		await page.selectOption('#rule-list', 'list-1');
		await page.click('.binder-preset[data-preset="4-pocket"]');
		await page.fill('#rule-extra-pages', '2');
		await page.waitForFunction(() => /4 pockets \(3 with a card you own\): 1 page of 2 × 2, then 2 blank pages\./.test((document.getElementById('rule-count') || {}).textContent), null, {timeout: 15000});
		await page.click('#binder-save');
		await page.waitForSelector('#binder-spread .bs-page');

		let doc = await localDoc(page);
		const made = doc.binders[0];

		assert.equal(made.page_count, 3, 'the list\'s page, then two blank ones');
		assert.equal(made.extra_pages, 2);

		// Squirtle's pocket (#007) shows his only copy, c5. Not this copy
		// here: the pocket keeps Squirtle and shows its placeholder.
		await openPage(page, 1);
		await waitForPocket(page, zoomPocket(3), {kind: 'card', label: 'Squirtle: Test Splash'});
		await page.click(zoomPocket(3));
		await page.waitForFunction(() => document.getElementById('pocket-viewer')?.dataset.state === 'open');
		await page.click('#pv-details');
		await page.waitForSelector('#list-skip');
		await page.click('#list-skip');
		await waitForPocket(page, zoomPocket(3), {kind: 'want', label: '#007 Squirtle, placeholder: your copies are kept out of this pocket'});
		assert.equal(await page.locator(`${zoomPocket(3)} .pocket-tag`).textContent(), 'Placeholder');
		await page.waitForFunction(() => document.getElementById('pocket-viewer')?.dataset.state !== 'open' && !document.querySelector('#pocket-sheet[open]'));
		await page.waitForTimeout(400);
		await page.screenshot({path: `${SHOTS}/keep-placeholder-360.png`});

		doc = await localDoc(page);
		assert.deepEqual(doc.binder_picks.map((pick) => [pick.id, pick.entry_id, pick.skipped]), [[`${made.id}|dex:7`, null, ['c5']]]);
		await page.waitForFunction(() => import('/pokemon-card-tracker/js/collection.js').then((m) => m.loadDocument()).then((d) => !d.binders[0].snapshot.shown['dex:7']), null, {timeout: 15000});
		assert.equal((await localDoc(page)).binders[0].page_count, 3, 'a refresh keeps the extra pages');

		// The sheet says so, tags the copy, and shows it here again.
		await page.click(zoomPocket(3));
		await page.waitForSelector('#list-unskip');
		assert.match(await page.locator('#list-sheet-count').textContent(), /^No copy shows here: the pocket keeps its placeholder\./);
		assert.equal(await page.locator('#list-copies .list-copy[data-entry="c5"] .list-skipped-tag').textContent(), 'Not shown here');
		await page.click('#list-unskip');
		await waitForPocket(page, zoomPocket(3), {kind: 'card', label: 'Squirtle: Test Splash'});

		// Remove from this binder offers Keep the placeholder beside the two
		// ways to leave it out.
		await page.click(zoomPocket(3));
		await page.waitForFunction(() => document.getElementById('pocket-viewer')?.dataset.state === 'open');
		await page.click('#pv-remove');
		await page.waitForSelector('#remove-placeholder');
		assert.deepEqual(await page.locator('#remove-panel button').evaluateAll((nodes) => nodes.map((node) => node.id)), ['remove-placeholder', 'remove-empty', 'remove-shift']);
		await page.click('#remove-placeholder');
		await waitForPocket(page, zoomPocket(3), {kind: 'want'});

		doc = await localDoc(page);
		assert.deepEqual(doc.binders[0].snapshot.keys, ['dex:1', 'dex:4', 'dex:7', 'dex:25'], 'Squirtle stays on the list');
		assert.deepEqual(doc.binders[0].list_edits || [], []);

		// Bulbasaur's three copies: skipping the one shown shows the next.
		await waitForPocket(page, zoomPocket(1), {kind: 'card', label: 'Bulbasaur: Test Sprout, .*3 copies fit'});
		await page.click(zoomPocket(1));
		await page.waitForFunction(() => document.getElementById('pocket-viewer')?.dataset.state === 'open');
		await page.click('#pv-details');
		await page.waitForSelector('#list-skip');
		await page.click('#list-skip');
		await page.waitForFunction(() => import('/pokemon-card-tracker/js/collection.js').then((m) => m.loadDocument()).then((d) => {
			const shown = d.binders[0].snapshot.shown['dex:1'];

			return Boolean(shown) && shown !== 'c1';
		}), null, {timeout: 15000});
		await waitForPocket(page, zoomPocket(1), {kind: 'card'});
		assert.deepEqual(errors, []);
		await context.close();
	});

	// Eric, 2026-11-24: choosing the copy for a pocket, the copies of one
	// card could not be told apart, because the picture was all there was.
	// Each copy's finish corner (js/tile.js finishBadge) shows in the list
	// pocket's sheet, and over the copy in the tray.
	test('the copies a pocket can show, and the tray, name each copy\'s finish: REV on the reverse copy, HOLO on the holo one, nothing on the plain one', async () => {
		const {context, errors, page} = await device(null, 'phone');
		const cards = [
			card('c1', 'tst1-001', {created_at: '2026-09-01T00:00:00.000Z', price_manual: {avg: 40, currency: 'BRL', date: '2026-09-02'}}),
			card('c2', 'tst1-001', {created_at: '2026-09-03T00:00:00.000Z', finish_raw: 'REVERSE_HOLOFOIL', language: 'en'}),
			card('c3', 'tst2-001', {created_at: '2026-09-02T00:00:00.000Z', finish_raw: 'HOLOFOIL'}),
			card('c4', 'tst1-004'),
			card('c5', 'tst1-007', {finish_raw: 'REVERSE_HOLOFOIL'}),
			card('c6', 'tst1-090', {finish_raw: 'HOLOFOIL'}),
		];
		const list = generated('b-list', {cols: 2, rows: 2, snapshot: {at: AT, keys: ['dex:1', 'dex:4', 'dex:7', 'dex:25'], rule_key: 'checklist:list-1|dex', shown: {'dex:1': 'c1'}}});
		const tray = hand('b-hand', [], {name: 'Hand with a tray', page_count: 1, staged: ['c1', 'c2', 'c3'], rows: 2, cols: 2});

		await seedLocal(page, documentWith({binders: [list, tray], cards}));

		// The list pocket's sheet: three copies fit, a corner on two of them.
		await page.goto(url('binders/b-list'));
		await page.waitForSelector('#binder-spread .bs-page');
		await openPage(page, 1);
		await page.click(zoomPocket(1));
		await page.waitForFunction(() => document.getElementById('pocket-viewer')?.dataset.state === 'open');
		await page.click('#pv-details');
		await page.waitForSelector('#list-copies .list-copy[data-entry="c3"]');

		const corners = (selector) => page.locator(selector).evaluateAll((nodes) => Object.fromEntries(nodes.map((node) => {
			const badge = node.querySelector('.badge-finish');

			return [node.dataset.entry, badge ? [badge.textContent, badge.getAttribute('aria-label')] : null];
		})));

		assert.deepEqual(await corners('#list-copies .list-copy'), {c1: null, c2: ['REV', 'Reverse holo'], c3: ['HOLO', 'Holo']});
		await page.screenshot({path: `${SHOTS}/copies-finish-360.png`});
		await closeSheet(page);

		// The tray of a hand-made binder: the same corners, small, over the
		// cards, and the finish in each card's name.
		await page.goto(url('binders/b-hand'));
		await page.waitForSelector('#binder-tray:not([hidden]) .bt-card');
		assert.deepEqual(await corners('#bt-strip .bt-card'), {c1: null, c2: ['REV', 'Reverse holo'], c3: ['HOLO', 'Holo']});
		assert.deepEqual(await page.locator('#bt-strip .bt-card').evaluateAll((nodes) => nodes.map((node) => /Reverse holo|Holo$/.exec(node.getAttribute('aria-label') || '')?.[0] || null)), [null, 'Reverse holo', 'Holo']);

		const inside = await page.locator('#bt-strip .bt-card[data-entry="c3"]').evaluate((card) => {
			const box = card.getBoundingClientRect();
			const badge = card.querySelector('.badge-finish').getBoundingClientRect();

			return badge.left >= box.left && badge.right <= box.right && badge.bottom <= box.bottom && badge.top >= box.top;
		});

		assert.ok(inside, 'the HOLO corner fits inside the 56 px card');
		await page.screenshot({path: `${SHOTS}/tray-finish-360.png`});

		// The corner keeps the badge colors in the dark theme: white with
		// near-black text, never the page's own colors.
		await page.emulateMedia({colorScheme: 'dark'});
		assert.deepEqual(await page.locator('#bt-strip .bt-card[data-entry="c3"] .badge-finish').evaluate((node) => {
			const style = getComputedStyle(node);

			return [style.backgroundColor, style.color];
		}), ['rgb(255, 255, 255)', 'rgb(17, 17, 24)']);
		await page.screenshot({path: `${SHOTS}/tray-finish-dark-360.png`});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('from a checklist: the default copy, a count, a placeholder, a pick that sticks, refresh, edit with a preview, nothing placed, and delete with Undo', async () => {
		const {context, errors, page} = await device(null, 'phone');

		await seedLocal(page, documentWith());
		await page.click('.tabs a[data-tab="binders"]');
		await page.click('#new-binder');
		await page.check('#new-binder-list');
		await page.waitForSelector('#rule-section');
		await page.check('#rule-kind input[value="checklist"]');
		await page.selectOption('#rule-list', 'list-1');
		await page.click('.binder-preset[data-preset="4-pocket"]');
		await page.waitForFunction(() => /4 pockets \(3 with a card you own\): 1 page of 2 × 2\./.test((document.getElementById('rule-count') || {}).textContent), null, {timeout: 15000});
		await page.screenshot({fullPage: true, path: `${SHOTS}/form-360.png`});
		await page.click('#binder-save');
		await page.waitForSelector('#binder-spread .bs-page');

		// Named after the list, laid out in Pokédex order, 1 page.
		assert.equal(await page.locator('#binder-title').textContent(), 'Test starters');
		assert.equal(await page.locator('#binder-meta').textContent(), 'Test starters (checklist), Pokédex order');
		assert.equal(await page.locator('#bs-spread .bs-shape').textContent(), ' · 2×2');
		assert.match(await page.locator('#binder-spread .bs-caption:visible').textContent(), /^Page 1 of 1 · 2×2$/);

		// Pocket 1: three copies fit, the priced one shows; pocket 4 (#025)
		// is not owned.
		await waitForPocket(page, spreadPocket(1, 1), {kind: 'card', label: 'Bulbasaur: Test Sprout, .*3 copies fit'});
		assert.equal(await page.locator(`${spreadPocket(1, 1)} .badge-qty`).textContent(), '×3');
		await waitForPocket(page, spreadPocket(1, 4), {item: 'pokemon', kind: 'want', label: '#025 Pikachu, not owned yet'});
		await page.screenshot({path: `${SHOTS}/binder-360.png`});

		let doc = await localDoc(page);
		const made = doc.binders[0];

		assert.deepEqual(made.rule, {order: 'dex', source: {id: 'list-1', kind: 'checklist'}});
		assert.deepEqual(made.snapshot.keys, ['dex:1', 'dex:4', 'dex:7', 'dex:25']);
		assert.deepEqual(made.snapshot.shown, {'dex:1': 'c1', 'dex:4': 'c4', 'dex:7': 'c5'});
		assert.deepEqual(made.slots, []);
		assert.equal(made.page_count, 1);

		// Pick the rarer copy by hand: the copy shown comes out of its
		// pocket with Details, Move to..., Remove from this binder, and Card
		// page, and Details are the sheet.
		await openPage(page, 1);
		await page.click(zoomPocket(1));
		await page.waitForFunction(() => document.getElementById('pocket-viewer')?.dataset.state === 'open');
		// Several copies fit, so Show this one here leads (js/pocket-viewer.js).
		assert.deepEqual(await page.locator('#pv-actions > *').evaluateAll((nodes) => nodes.map((node) => node.id)), ['pv-pick', 'pv-details', 'pv-move', 'pv-card-page', 'pv-remove']);
		await page.click('#pv-details');
		await page.waitForSelector('#list-copies .list-copy[data-entry="c3"]');
		assert.equal(await page.locator('#list-copies .list-copy').count(), 3);
		assert.equal(await page.locator('#list-copies .list-copy[aria-pressed="true"]').getAttribute('data-entry'), 'c1');
		await page.screenshot({path: `${SHOTS}/copies-sheet-360.png`});
		await page.click('#list-copies .list-copy[data-entry="c3"]');
		await waitForPocket(page, zoomPocket(1), {kind: 'card', label: 'Test Sprout ex.*picked by hand', picked: 'true'});

		doc = await localDoc(page);
		assert.deepEqual(doc.binder_picks.map((pick) => [pick.id, pick.entry_id]), [[`${made.id}|dex:1`, 'c3']]);

		// The missing Pokémon: a link to its cards to pick one for the
		// wishlist.
		await page.click(zoomPocket(4));
		await page.waitForSelector('#list-sheet-missing');
		assert.equal(await page.locator('#list-wish').getAttribute('href'), `${BASE}lists/list-1/pokemon/25`);
		await closeSheet(page);

		// A generated binder places nothing: every copy is still "not in a
		// binder".
		await page.goto(url('binders'));
		await page.waitForSelector('#unplaced-link');
		assert.equal(await page.locator('#unplaced-link').textContent(), '6 owned cards not in any binder');
		assert.equal(await page.locator('.binder-cover .binder-from').textContent(), 'From a list');
		assert.equal(await page.locator('.binder-fill').textContent(), '3 / 4');

		// A new card for #025 and #006 added to the list on another screen:
		// opening the binder fills and adds, keeping the hand pick.
		await page.evaluate(async () => {
			const collection = await import('/pokemon-card-tracker/js/collection.js');
			const stored = await collection.loadDocument();
			const list = stored.goals.find((goal) => goal.id === 'list-1');
			const now = new Date().toISOString();

			await collection.mergeIntoLocal({
				cards: [{card_id: 'tst1-025', catalog: 'international', created_at: now, deleted_at: null, id: 'c7', language: 'pt', updated_at: now}],
				goals: [{...list, dex_list: [1, 4, 6, 7, 25], updated_at: now}],
			});
		});
		await page.click(`.binder-cover[data-binder="${made.id}"]`);
		await page.waitForFunction(() => /1 pocket added \(Charizard\); 1 pocket filled with a card you own now \(Pikachu\)\./.test((document.getElementById('binder-list-note') || {}).textContent), null, {timeout: 15000});
		await waitForPocket(page, spreadPocket(1, 3), {item: 'pokemon', kind: 'want', label: '#006 Charizard'});
		await waitForPocket(page, spreadPocket(1, 1), {picked: 'true'});
		doc = await localDoc(page);
		assert.equal(doc.binders[0].page_count, 2);
		await page.screenshot({path: `${SHOTS}/refreshed-360.png`});
		await waitForPocket(page, spreadPocket(1, 4), {kind: 'card', label: 'Squirtle: Test Splash'});
		await page.click('#bs-zoom-next');
		await waitForPocket(page, spreadPocket(2, 1), {kind: 'card', label: 'Pikachu: Test Spark'});
		await page.click('#bs-zoom-prev');

		// Refresh with nothing new says so.
		await page.click('#binder-refresh');
		await page.waitForFunction(() => (document.getElementById('binder-list-note') || {}).textContent === 'Up to date.', null, {timeout: 15000});

		// Edit: name order and 3 x 3, with the first page shown first.
		await page.click('#edit-binder');
		await page.waitForSelector('#rule-section');
		await page.selectOption('#rule-order', 'name');
		await page.click('.binder-preset[data-preset="9-pocket-zip"]');
		await page.waitForFunction(() => /5 pockets .*1 page of 3 × 3/.test((document.getElementById('rule-count') || {}).textContent), null, {timeout: 15000});
		await page.click('#binder-save');
		await page.waitForSelector('#relayout-sheet[open]');
		assert.match(await page.locator('#relayout-lines').textContent(), /5 pockets on 1 page of 3 × 3, was 2 pages of 2 × 2\..*picked by hand stay/);
		assert.equal(await page.locator('#relayout-preview .pocket').count(), 9);
		assert.match(await page.locator('#relayout-preview .pocket').first().getAttribute('aria-label'), /^Bulbasaur: Test Sprout ex/);
		await page.screenshot({path: `${SHOTS}/relayout-360.png`});
		await page.click('#relayout-save');
		await page.waitForFunction(() => (document.getElementById('binder-meta') || {}).textContent === 'Test starters (checklist), name order' && (document.querySelector('#bs-spread .bs-shape') || {}).textContent === ' · 3×3', null, {timeout: 15000});
		// Name order: Bulbasaur, Charizard, Pikachu, Squirtle, Testmon 4.
		await waitForPocket(page, spreadPocket(1, 3), {label: 'Pikachu: Test Spark'});
		doc = await localDoc(page);
		assert.equal(doc.binders[0].layout, 1);
		assert.deepEqual(doc.binders[0].snapshot.keys, ['dex:1', 'dex:6', 'dex:25', 'dex:7', 'dex:4']);

		// Delete with Undo brings it back with its pick.
		await page.click('#delete-binder');
		await page.waitForSelector('.toast button');
		await page.click('.toast button');
		await page.waitForSelector(`.binder-cover[data-binder="${made.id}"]`);
		await page.click(`.binder-cover[data-binder="${made.id}"]`);
		await waitForPocket(page, spreadPocket(1, 1), {picked: 'true'});

		assert.deepEqual(errors, []);
		await context.close();
	});

	test('from a set goal, a collection screen\'s route, and a filter; spreads held sideways at 360 and 390', async () => {
		const {context, errors, page} = await device(null, 'phone', {viewport: {height: 844, width: 390}});

		await seedLocal(page, documentWith());

		// The goal: four cards, one not owned, with Add to wishlist.
		await page.goto(url('binders/new/goal/goal-1'));
		await page.waitForSelector('#rule-section');
		assert.equal(await page.locator('#rule-kind input:checked').getAttribute('value'), 'goal');
		await page.selectOption('#rule-order', 'set');
		await page.click('.binder-preset[data-preset="4-pocket"]');
		await page.waitForFunction(() => /4 pockets \(3 with a card you own\)/.test((document.getElementById('rule-count') || {}).textContent), null, {timeout: 15000});
		await page.click('#binder-save');
		await page.waitForSelector('#binder-spread .bs-page');
		await waitForPocket(page, spreadPocket(1, 4), {item: 'card', kind: 'want', label: 'Test Spark, not owned yet'});
		await page.screenshot({path: `${SHOTS}/goal-390.png`});
		await openPage(page, 1);
		await page.click(zoomPocket(4));
		await page.click('#list-wish');
		await page.waitForFunction(() => (document.getElementById('list-wish') || {}).textContent === 'On your wishlist', null, {timeout: 10000});

		let doc = await localDoc(page);

		assert.deepEqual(doc.wishlist.filter((wish) => !wish.deleted_at).map((wish) => wish.card_id), ['tst1-025']);
		await closeSheet(page);

		// The collection: its two cards. Test Ember's one copy is in use in
		// the older goal binder's pocket for that card, so here it is a
		// placeholder (a copy is in one pocket at a time, Eric, 2026-11-24).
		await page.goto(url('binders/new/collection/col-1'));
		await page.waitForSelector('#rule-section');
		await page.waitForFunction(() => /2 pockets \(2 with a card you own\)/.test((document.getElementById('rule-count') || {}).textContent), null, {timeout: 15000});
		await page.click('#binder-save');
		await page.waitForSelector('#binder-spread .bs-page');
		await waitForPocket(page, spreadPocket(1, 1), {kind: 'want', label: 'Test Ember, placeholder: your copies are kept out of this pocket'});

		// A filter: Fire type, from the Binders tab.
		await page.goto(url('binders'));
		await page.click('#new-binder');
		await page.check('#new-binder-list');
		await page.check('#rule-kind input[value="filter"]');
		await page.selectOption('#rule-filter-type', 'Fire');
		await page.waitForFunction(() => /^1 pocket \(1 with a card you own\)/.test((document.getElementById('rule-count') || {}).textContent), null, {timeout: 15000});
		await page.fill('#binder-name', 'Fire cards');
		await page.click('#binder-save');
		await page.waitForSelector('#binder-spread .bs-page');
		assert.match(await page.locator('#binder-meta').textContent(), /^Filter: Fire, Pokédex order/);

		doc = await localDoc(page);
		assert.deepEqual(doc.binders.map((binder) => binder.rule.source.kind).sort(), ['collection', 'filter', 'goal']);

		// Sideways: the spread of the goal binder at 390 and 360 wide.
		const goal = doc.binders.find((binder) => binder.rule.source.kind === 'goal');

		for (const size of [{height: 390, width: 844}, {height: 360, width: 740}]) {
			await page.setViewportSize(size);
			await page.goto(url(`binders/${goal.id}`));
			await page.waitForSelector('#binder-spread[data-mode="direct"]');
			await waitForPocket(page, spreadPocket(1, 1), {kind: 'card'});
			await page.screenshot({path: `${SHOTS}/goal-landscape-${size.width}.png`});
		}

		// Portrait at 360: the list binder screen.
		await page.setViewportSize({height: 740, width: 360});
		await page.goto(url(`binders/${goal.id}`));
		await waitForPocket(page, spreadPocket(1, 1), {kind: 'card'});
		await page.screenshot({fullPage: true, path: `${SHOTS}/goal-portrait-360.png`});

		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a list that counts Portuguese only: opening saves once and records the languages, an older phone\'s any-language layout is then left alone on opening, and Refresh saves', async () => {
		const {context, errors, page} = await device(null, 'phone');
		const rule = {order: 'dex', source: {id: 'list-1', kind: 'checklist'}};
		// What a v56 phone saves: Pikachu filled with the English copy.
		const older = {at: AT, keys: ['dex:1', 'dex:4', 'dex:7', 'dex:25'], rule_key: ruleKey(rule), shown: {'dex:1': 'c1', 'dex:25': 'c8', 'dex:4': 'c4', 'dex:7': 'c5'}};
		const binder = {art: [], cols: 2, cover_color: '#1d2e60', created_at: AT, deleted_at: null, id: 'gen-1', name: 'Test starters', notes: '', page_count: 1, rows: 2, rule, slots: [], snapshot: older, updated_at: AT};

		await seedLocal(page, documentWith({binders: [binder], cards: [...CARDS, card('c8', 'tst1-025', {language: 'en'})], goals: [{...CHECKLIST, ...PICKED_PT}, SET_GOAL]}));

		// The first opening empties Pikachu, says so, and records the languages.
		await page.goto(url('binders/gen-1'));
		await page.waitForFunction(() => /^1 pocket emptied: no copy you own fits it now \(Pikachu\)\.$/.test((document.getElementById('binder-list-note') || {}).textContent), null, {timeout: 15000});
		await waitForPocket(page, spreadPocket(1, 4), {kind: 'want'});

		let doc = await localDoc(page);

		assert.equal(doc.binders[0].list_languages, 'pt');
		assert.equal(doc.binders[0].snapshot.shown['dex:25'], undefined);

		// The v56 phone opens it and saves its own layout back, keeping the
		// field it does not know.
		await page.goto(url('binders'));
		await page.evaluate(async (snapshot) => {
			const {saveRefresh} = await import('/pokemon-card-tracker/js/binders.js');

			await saveRefresh('gen-1', {page_count: 1, snapshot});
		}, older);
		doc = await localDoc(page);
		assert.equal(doc.binders[0].snapshot.shown['dex:25'], 'c8');
		assert.equal(doc.binders[0].list_languages, 'pt');

		const stamp = doc.binders[0].updated_at;

		// Opening it here again shows Pikachu empty but saves nothing and says nothing.
		await page.click('.binder-cover[data-binder="gen-1"]');
		await waitForPocket(page, spreadPocket(1, 4), {kind: 'want'});
		await page.waitForTimeout(800);
		doc = await localDoc(page);
		assert.equal(doc.binders[0].updated_at, stamp, 'not saved on opening');
		assert.equal(await page.locator('#binder-list-note').isHidden(), true);

		// Refresh saves it, and says what it did.
		await page.click('#binder-refresh');
		await page.waitForFunction(() => /^1 pocket emptied: no copy you own fits it now \(Pikachu\)\.$/.test((document.getElementById('binder-list-note') || {}).textContent), null, {timeout: 15000});
		for (let tries = 0; tries < 50 && (doc = await localDoc(page)).binders[0].updated_at === stamp; tries++) {
			await page.waitForTimeout(100);
		}

		assert.notEqual(doc.binders[0].updated_at, stamp, 'saved by Refresh');
		assert.equal(doc.binders[0].snapshot.shown['dex:25'], undefined);
		assert.deepEqual(errors, []);
		await context.close();
	});

	// Eric, 2026-11-24: his Hoenn list binder refused his only Latias, the
	// Japanese SV7a-019 ラティアスex, which TCGdex gives no Pokédex number,
	// and his hand-made Chinese Relicanth (Gem Pack Vol.4, a set TCGdex lists
	// with no cards); his list also still carried the old Portuguese default.
	test('a Hoenn list binder takes a Japanese print with no Pokédex number and a hand-made card, the old Portuguese default gone at start', async () => {
		const {context, errors, page} = await device(null, 'phone');
		const hoenn = {created_at: AT, deleted_at: null, dex_list: [369, 380], hand_ticks: {}, id: 'list-hoenn', kind: 'custom_pokemon', languages: ['pt'], name: 'Hoenn', target: null, updated_at: AT};
		const latias = card('j1', 'SV7a-019', {catalog: 'ja', language: 'ja'});
		const relicanth = card('h1', 'hand_0123456789abcdef0123456789abcdef', {catalog: 'custom', language: 'zh-cn', name_local: '古空棘鱼', number_local: '0703/07', set_code: 'CBB4C', set_name_local: 'Gem Pack Vol.4'});

		await page.route('https://api.tcgdex.net/v2/ja/cards/SV7a-019', (route) => route.fulfill({
			body: JSON.stringify({category: 'Pokemon', dexId: null, id: 'SV7a-019', image: null, localId: '019', name: 'ラティアスex', set: {id: 'SV7a', name: '楽園ドラゴーナ'}}),
			contentType: 'application/json',
			status: 200,
		}));
		await seedLocal(page, documentWith({cards: [latias, relicanth], collections: [], goals: [hoenn]}));
		await untilInPage(page, 'the Hoenn list opened to every language', async () => {
			const doc = await (await import('/pokemon-card-tracker/js/collection.js')).loadDocument();

			return !('languages' in doc.goals.find((goal) => goal.id === 'list-hoenn'));
		});

		await page.click('.tabs a[data-tab="binders"]');
		await page.click('#new-binder');
		await page.check('#new-binder-list');
		await page.waitForSelector('#rule-section');
		await page.check('#rule-kind input[value="checklist"]');
		await page.selectOption('#rule-list', 'list-hoenn');
		await page.click('.binder-preset[data-preset="4-pocket"]');
		await page.waitForFunction(() => /2 pockets \(2 with a card you own\)/.test((document.getElementById('rule-count') || {}).textContent), null, {timeout: 15000});
		await page.click('#binder-save');
		await page.waitForSelector('#binder-spread .bs-page');

		const doc = await localDoc(page);

		assert.deepEqual(doc.binders[0].snapshot.shown, {'dex:369': 'h1', 'dex:380': 'j1'});
		assert.equal(doc.binders[0].list_languages, undefined, 'the list counts every language');
		await waitForPocket(page, spreadPocket(1, 2), {kind: 'card'});

		// The Latias pocket's sheet offers the Japanese copy.
		await openPage(page, 1);
		await page.click(zoomPocket(2));
		await page.waitForFunction(() => document.getElementById('pocket-viewer')?.dataset.state === 'open');
		await page.click('#pv-details');
		await page.waitForSelector('#list-copies .list-copy[data-entry="j1"]');
		assert.equal(await page.locator('#list-copies .list-copy').count(), 1);
		await page.screenshot({path: `${SHOTS}/hoenn-latias-360.png`});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a binder from a list syncs with its picks, and a family member sees it read only', async () => {
		const {FakeSupabase} = await import('./fake-supabase.mjs');
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const member = fake.addUser('member@example.test');
		const ownerDevice = await device(fake, 'owner');
		const {page: ownerPage} = ownerDevice;

		await seedLocal(ownerPage, documentWith());
		await signIn(ownerPage, fake, owner.email);
		await waitForStatus(ownerPage, 'Synced');
		await ownerPage.goto(url('binders/new/checklist/list-1'));
		await ownerPage.waitForSelector('#rule-section');
		await ownerPage.click('.binder-preset[data-preset="4-pocket"]');
		await ownerPage.waitForFunction(() => /4 pockets/.test((document.getElementById('rule-count') || {}).textContent), null, {timeout: 15000});
		await ownerPage.click('#binder-save');
		await ownerPage.waitForSelector('#binder-spread .bs-page');
		await openPage(ownerPage, 1);
		await ownerPage.click(zoomPocket(1));
		await ownerPage.click('#pv-details');
		await ownerPage.click('#list-copies .list-copy[data-entry="c2"]');
		await waitForPocket(ownerPage, zoomPocket(1), {picked: 'true'});

		const pushed = () => ((fake.documents.get(owner.id) || {}).doc || {});

		await until(() => (pushed().binders || []).length === 1 && (pushed().binder_picks || []).length === 1);
		assert.equal(pushed().binder_picks[0].entry_id, 'c2');
		assert.deepEqual(pushed().binders[0].slots, []);

		fake.members.push({group_id: fake.groups[0].id, role: 'member', user_id: member.id});
		fake.profiles.set(owner.id, {display_name: 'Member A', user_id: owner.id});

		const {context, errors, page} = await device(fake, 'member');

		await signIn(page, fake, member.email);
		await waitForStatus(page, 'Synced');
		await page.goto(url(`family/${owner.id}/binders/${pushed().binders[0].id}`));
		await page.waitForSelector('#binder-spread .bs-page');
		await waitForPocket(page, spreadPocket(1, 1), {kind: 'card', label: 'Bulbasaur: Test Sprout, English'});
		await waitForPocket(page, spreadPocket(1, 4), {kind: 'want', label: 'Pikachu, not owned yet'});
		assert.equal(await page.locator('#bs-zoom-sheet button.pocket').count(), 3, 'owned pockets take their card out, with its card page');
		assert.equal(await page.locator('#bs-zoom-sheet button.pocket[data-kind="card"]').count(), 3);
		assert.equal(await page.locator('#binder-refresh, #edit-binder, #delete-binder, #pocket-sheet').count(), 0);
		await page.screenshot({path: `${SHOTS}/family-360.png`});
		assert.equal((await localDoc(page)).binders.length, 0, 'viewing changes nothing on this phone');
		assert.deepEqual(errors, []);
		assert.deepEqual(ownerDevice.errors, []);
		await context.close();
		await ownerDevice.context.close();
	});
});

