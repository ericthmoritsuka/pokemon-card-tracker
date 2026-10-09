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
];

// Set tst1 for a set goal: four cards, one of them not owned.
const SET_CARDS = [
	{id: 'tst1-001', localId: '001', name: 'Test Sprout', rarity: 'Common'},
	{id: 'tst1-004', localId: '004', name: 'Test Ember', rarity: 'Common'},
	{id: 'tst1-007', localId: '007', name: 'Test Splash', rarity: 'Common'},
	{id: 'tst1-025', localId: '025', name: 'Test Spark', rarity: 'Rare'},
];

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
const spreadPocket = (pg, n) => `#bs-spread .bs-page[data-page="${pg}"] .pocket[data-position="${n}"]`;

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
	await page.click(`.bs-open[data-open="${pg}"]`);
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
		assert.match(await page.locator('#binder-meta').textContent(), /2 × 2 · 1 page · Test starters \(checklist\), Pokédex order/);

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

		// Pick the rarer copy by hand.
		await openPage(page, 1);
		await page.click(zoomPocket(1));
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
		await page.click('#bs-next');
		await waitForPocket(page, spreadPocket(2, 1), {kind: 'card', label: 'Pikachu: Test Spark'});
		await page.click('#bs-prev');

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
		await page.waitForFunction(() => /3 × 3 · 1 page · Test starters \(checklist\), name order/.test((document.getElementById('binder-meta') || {}).textContent), null, {timeout: 15000});
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

		// The collection: its two cards.
		await page.goto(url('binders/new/collection/col-1'));
		await page.waitForSelector('#rule-section');
		await page.waitForFunction(() => /2 pockets \(2 with a card you own\)/.test((document.getElementById('rule-count') || {}).textContent), null, {timeout: 15000});
		await page.click('#binder-save');
		await page.waitForSelector('#binder-spread .bs-page');
		await waitForPocket(page, spreadPocket(1, 1), {kind: 'card', label: 'Test Ember'});

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
		assert.match(await page.locator('#binder-meta').textContent(), /Filter: Fire, Pokédex order/);

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
		assert.equal(await page.locator('#bs-spread a.pocket').count(), 3, 'owned pockets open their card pages');
		assert.equal(await page.locator('#binder-refresh, #edit-binder, #delete-binder, #pocket-sheet').count(), 0);
		await page.screenshot({path: `${SHOTS}/family-360.png`});
		assert.equal((await localDoc(page)).binders.length, 0, 'viewing changes nothing on this phone');
		assert.deepEqual(errors, []);
		assert.deepEqual(ownerDevice.errors, []);
		await context.close();
		await ownerDevice.context.close();
	});
});

