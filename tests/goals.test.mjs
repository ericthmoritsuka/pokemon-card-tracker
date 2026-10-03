// Unit tests for set and artist goals (js/goals.js) and their GraphQL
// helpers in js/catalog.js: the cards of each set level, the finishes a
// master set counts (ball patterns, stamps, and the variants flags when a
// card has no variants_detailed), how owned copies are counted at each
// level and in a goal's languages, artist goals, and saving a goal and its
// level over an in-memory IndexedDB. Every set, card, and illustrator here
// is invented; nothing is requested.
//
// Run: node --test tests/goals.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {fakeIndexedDb} from './fake-indexeddb.mjs';

// js/collection.js and js/tile.js reach window when they load.
globalThis.window = globalThis.window || globalThis;
globalThis.addEventListener = globalThis.addEventListener || (() => {});
globalThis.indexedDB = fakeIndexedDb();
// No other tabs here, and an open channel would keep Node running.
globalThis.BroadcastChannel = undefined;
// Nothing in these tests may reach a server.
globalThis.fetch = async (url) => {
	throw new Error(`No requests in this test (${url}).`);
};

const goals = await import('../js/goals.js');
const catalog = await import('../js/catalog.js');
const {entryFinish} = await import('../js/tile.js');

const {
	artistGoalCards,
	artistSuggestions,
	cardVariants,
	findGoal,
	goalCatalogs,
	goalCopies,
	goalStates,
	goalTally,
	ownedVariantKey,
	passesGoalFilter,
	setLevelCards,
	variantKey,
	variantLabel,
} = goals;

// ------------------------------------------------------------ fixtures

const NORMAL = {size: 'standard', type: 'normal'};
const HOLO = {size: 'standard', type: 'holo'};
const REVERSE = {size: 'standard', type: 'reverse'};
const POKEBALL = {foil: 'pokeball', size: 'standard', type: 'reverse'};
const MASTERBALL = {foil: 'masterball', size: 'standard', type: 'reverse'};

// "Test Evolutions": 4 numbered cards and 2 secret rares. Card 004 has a
// set-logo stamped print and a jumbo one; card 005 has only the variants
// flags.
const SET = {
	cardCount: {official: 4, total: 6},
	cards: ['001', '002', '003', '004', '005', '006'].map((n) => ({id: `tev-${n}`, image: `https://assets.example/tev/${n}`, localId: n, name: `Card ${n}`})),
	id: 'tev',
	name: 'Test Evolutions',
	releaseDate: '2026-01-17',
};

const DETAILS = {
	'tev-001': {rarity: 'Common', variants_detailed: [NORMAL, REVERSE, POKEBALL, MASTERBALL]},
	'tev-002': {rarity: 'Common', variants_detailed: [NORMAL, REVERSE, POKEBALL, MASTERBALL]},
	'tev-003': {rarity: 'Rare', variants_detailed: [HOLO, REVERSE]},
	'tev-004': {rarity: 'Rare', variants_detailed: [NORMAL, REVERSE, {size: 'standard', stamp: ['set-logo'], type: 'normal'}, {size: 'jumbo', type: 'normal'}]},
	'tev-005': {rarity: 'Secret Rare', variants: {firstEdition: false, holo: true, normal: false, reverse: false}, variants_detailed: null},
	'tev-006': {rarity: 'Secret Rare', variants_detailed: [HOLO]},
};

// The full record of card 003 on the phone, whose variantIds tell a copy's
// finish exactly.
const RECORD_003 = {id: 'tev-003', variants_detailed: [{...HOLO, variantId: 'v3-holo'}, {...REVERSE, variantId: 'v3-rev'}]};

let seq = 0;

const copy = (cardId, language, extra = {}) => ({
	card_id: cardId,
	catalog: 'international',
	created_at: '2026-09-01T00:00:00.000Z',
	deleted_at: null,
	id: `c${++seq}`,
	language,
	updated_at: '2026-09-01T00:00:00.000Z',
	...extra,
});

const ENTRIES = [
	copy('tev-001', 'pt'),
	copy('tev-001', 'en', {finish: 'pokeball'}),
	copy('tev-003', 'en', {variant_id: 'v3-rev'}),
	copy('tev-005', 'de'),
	copy('tev-006', 'pt', {deleted_at: '2026-09-02T00:00:00.000Z'}),
	copy('other-001', 'pt'),
];

const setGoal = (level, languages = null) => ({catalog: 'international', id: `g-${level}`, kind: 'set', level, name: 'Test Evolutions', target: 'tev', ...(languages ? {languages} : {})});

function count(goal, entries = ENTRIES) {
	const cards = setLevelCards({catalog: 'international', details: DETAILS, level: goal.level, set: SET, setId: 'tev'});
	const states = goalStates({
		cards,
		copies: goalCopies(goal, entries),
		finishOf: entryFinish,
		master: goal.level === 'master',
		recordFor: (card) => (card.cardId === 'tev-003' ? RECORD_003 : null),
	});

	return {cards, states, tally: goalTally(states)};
}

// --------------------------------------------------------------- levels

describe('set levels', () => {
	test('numbered counts cards 1 to the official count, owned in any finish', () => {
		const {cards, tally} = count(setGoal('numbered'));

		assert.deepEqual(cards.map((card) => card.localId), ['001', '002', '003', '004']);
		assert.equal(tally.owned, 2, '001 and 003');
		assert.equal(tally.total, 4);
		assert.equal(tally.missing, 2);
	});

	test('with secrets counts every card in the set', () => {
		const {cards, tally} = count(setGoal('secrets'));

		assert.equal(cards.length, 6);
		assert.deepEqual([tally.owned, tally.total], [3, 6], '001, 003, and the German 005; the deleted 006 does not count');
	});

	test('master counts each card in each finish, ball patterns and stamps included, jumbo left out', () => {
		const {states, tally} = count(setGoal('master'));
		const byId = Object.fromEntries(states.map((state) => [state.card.cardId, state]));

		// 4 + 4 + 2 + 3 + 1 + 1
		assert.equal(tally.total, 15);
		assert.deepEqual(byId['tev-001'].finishes.filter((finish) => finish.owned).map((finish) => finish.label), ['Normal', 'Poké Ball pattern']);
		assert.deepEqual(byId['tev-003'].finishes.filter((finish) => finish.owned).map((finish) => finish.label), ['Reverse holo'], 'the variantId on the phone\'s record');
		assert.deepEqual(byId['tev-004'].finishes.map((finish) => finish.label), ['Normal', 'Reverse holo', 'Normal, Set logo stamp']);
		assert.deepEqual(byId['tev-005'].finishes.map((finish) => finish.label), ['Holo'], 'read from the variants flags');
		assert.equal(tally.owned, 4);
		assert.equal(tally.missing, 11);
		assert.equal(tally.cardsOwned, 3);
	});

	test('master counts a card whose finishes are unknown once, and says so', () => {
		const cards = setLevelCards({level: 'master', set: SET, setId: 'tev'});
		const states = goalStates({cards, copies: goalCopies(setGoal('master'), ENTRIES), master: true});
		const tally = goalTally(states);

		assert.deepEqual([tally.owned, tally.total, tally.unknown], [3, 6, 6]);
	});

	test('a goal\'s languages decide which copies count', () => {
		assert.equal(count(setGoal('secrets', ['pt'])).tally.owned, 1, 'only the Portuguese 001');
		assert.equal(count(setGoal('secrets', ['pt', 'en'])).tally.owned, 2);
		assert.equal(count(setGoal('master', ['en'])).tally.owned, 2, 'the Poké Ball 001 and the reverse 003');
	});

	test('a set numbered another way takes its first official cards', () => {
		const set = {cardCount: {official: 2, total: 3}, cards: [{id: 'tpr-SV003', localId: 'SV003'}, {id: 'tpr-SV001', localId: 'SV001'}, {id: 'tpr-SV002', localId: 'SV002'}], id: 'tpr', name: 'Test promos'};

		assert.deepEqual(setLevelCards({level: 'numbered', set, setId: 'tpr'}).map((card) => card.localId), ['SV001', 'SV002']);
	});

	test('cards GraphQL knows that the set record lacks are listed, with their rarity', () => {
		const cards = setLevelCards({details: {...DETAILS, 'tev-007': {id: 'tev-007', localId: '007', name: 'Card 007', rarity: 'Hyper Rare'}}, level: 'secrets', set: SET, setId: 'tev'});

		assert.equal(cards.length, 7);
		assert.equal(cards.at(-1).rarity, 'Hyper Rare');
		assert.equal(cards[0].setName, 'Test Evolutions');
	});

	test('All, Owned, and Missing: a master card part owned shows under both', () => {
		const {states} = count(setGoal('master'));
		const first = states.find((state) => state.card.cardId === 'tev-001');

		assert.ok(passesGoalFilter(first, 'owned'));
		assert.ok(passesGoalFilter(first, 'missing'));
		assert.equal(states.filter((state) => passesGoalFilter(state, 'missing')).length, 5, 'every card but the German 005, whose one finish is owned');
		assert.equal(states.filter((state) => passesGoalFilter(state, 'owned')).length, 3);
	});
});

// ------------------------------------------------------------- finishes

describe('finishes', () => {
	test('a finish is told by type, subtype, foil, and stamps; Portuguese foils read as English', () => {
		assert.equal(variantKey(POKEBALL), 'reverse||pokeball|');
		assert.equal(variantKey({foil: 'Poké Bola', type: 'Reverse'}), 'reverse||pokeball|');
		assert.equal(variantLabel({stamp: ['1st-edition'], type: 'normal'}), 'Normal, 1st Edition');
		assert.equal(variantLabel({subtype: 'shadowless', type: 'holo'}), 'Holo, Shadowless');
	});

	test('a copy\'s finish code finds its finish; an unknown one counts as the plain print', () => {
		const finishes = cardVariants({variants_detailed: [NORMAL, REVERSE, POKEBALL, MASTERBALL]});

		assert.equal(ownedVariantKey({code: 'masterball', entry: {}, finishes}), 'reverse||masterball|');
		assert.equal(ownedVariantKey({code: 'reverse', entry: {}, finishes}), 'reverse|||');
		assert.equal(ownedVariantKey({code: null, entry: {}, finishes}), 'normal|||');
		assert.equal(ownedVariantKey({code: 'first', entry: {}, finishes}), 'normal|||');
		assert.equal(cardVariants({}), null);
	});
});

// --------------------------------------------------------------- artist

describe('artist goals', () => {
	const RAW = [
		{id: 'tev-002', illustrator: 'Aiko Testa', image: 'https://assets.example/en/tev/002', localId: '002', name: 'Card 002', rarity: 'Common', set: {id: 'tev', name: 'Test Evolutions'}},
		{id: 'old1-010', illustrator: 'aiko  testá', localId: '010', name: 'Old card', set: {id: 'old1', name: 'Old Test Set'}},
		{id: 'P-A-001', illustrator: 'Aiko Testa', image: 'https://assets.example/en/tcgp/P-A/001', localId: '001', name: 'Pocket card', set: {id: 'P-A', name: 'Pocket'}},
		{id: 'tev-004', illustrator: 'Aiko Testarossa', localId: '004', name: 'Not hers', set: {id: 'tev', name: 'Test Evolutions'}},
	];
	const SETS = {old1: {id: 'old1', name: 'Old Test Set', releaseDate: '2001-05-01', serie: 'old'}, tev: {id: 'tev', name: 'Test Evolutions', releaseDate: '2026-01-17', serie: 'tst'}};

	test('only the exact illustrator, case, accents, and spacing aside', () => {
		const cards = catalog.illustratorCardsFrom(RAW, 'Aiko Testa');

		assert.deepEqual(cards.map((card) => card.id), ['tev-002', 'old1-010', 'P-A-001']);
	});

	test('TCG Pocket is left out, newest set first, and owned prints are counted once each', () => {
		const lists = [{catalog: 'international', cards: catalog.illustratorCardsFrom(RAW, 'Aiko Testa')}];
		const cards = artistGoalCards({lists, sets: SETS});
		const goal = {id: 'a1', kind: 'artist', target: 'Aiko Testa'};
		const states = goalStates({cards, copies: goalCopies(goal, [copy('old1-010', 'pt'), copy('old1-010', 'en'), copy('tev-004', 'pt')])});

		assert.deepEqual(cards.map((card) => card.cardId), ['tev-002', 'old1-010']);
		assert.equal(cards[1].releaseDate, '2001-05-01');
		assert.deepEqual(goalTally(states), {cards: 2, cardsOwned: 1, missing: 1, owned: 1, total: 2, unknown: 0});
	});

	test('an artist goal reads the international catalog, and an Asian one only when its languages name it', () => {
		assert.deepEqual(goalCatalogs({kind: 'artist', target: 'x'}), ['international']);
		assert.deepEqual(goalCatalogs({kind: 'artist', languages: ['pt', 'ja'], target: 'x'}), ['international', 'ja']);
		assert.deepEqual(goalCatalogs({catalog: 'ja', kind: 'set', target: 'SV1'}), ['ja']);
	});

	test('suggestions come from owned cards\' records, most owned first', () => {
		const records = new Map([
			['international|a', {illustrator: 'Kenji Test'}],
			['international|b', {illustrator: 'Aiko Testa'}],
			['international|c', {illustrator: 'aiko testa'}],
			['international|d', {}],
		]);

		assert.deepEqual(artistSuggestions(records), ['Aiko Testa', 'Kenji Test']);
	});

	test('findGoal matches an artist loosely and a set by catalog', () => {
		const list = [
			{catalog: 'ja', id: 's1', kind: 'set', target: 'SV1'},
			{id: 'a1', kind: 'artist', target: 'Aiko Testa'},
			{deleted_at: '2026-09-01T00:00:00.000Z', id: 'a2', kind: 'artist', target: 'Kenji Test'},
		];

		assert.equal(findGoal(list, {kind: 'artist', target: 'AIKO TESTA '}).id, 'a1');
		assert.equal(findGoal(list, {kind: 'artist', target: 'Kenji Test'}), null, 'a deleted goal is not found');
		assert.equal(findGoal(list, {catalog: 'international', kind: 'set', target: 'SV1'}), null);
		assert.equal(findGoal(list, {catalog: 'ja', kind: 'set', target: 'SV1'}).id, 's1');
	});
});

// ------------------------------------------------------------- queries

describe('GraphQL helpers', () => {
	test('a set\'s query asks for its cards with finishes; an Asian catalog adds @locale', () => {
		assert.match(catalog.setCardsQuery('international', 'tev'), /cards\(filters: \{id: "tev-"\}.*variants_detailed \{ type subtype foil stamp size \}/);
		assert.match(catalog.setCardsQuery('ja', 'SV1'), /@locale\(lang: "ja"\)/);
		assert.match(catalog.illustratorQuery('international', 'Aiko "A" Testa', 2), /illustrator: "Aiko \\"A\\" Testa"\}, pagination: \{page: 2, itemsPerPage: 500\}/);
	});

	test('a set\'s answer keeps only that set\'s cards (tev- also matches tev2-)', () => {
		const out = catalog.setCardsFrom([{id: 'tev-001', localId: '001', rarity: 'None'}, {id: 'tev2-001', localId: '001'}], 'tev');

		assert.deepEqual(Object.keys(out), ['tev-001']);
		assert.equal(out['tev-001'].rarity, null);
	});
});

// -------------------------------------------------------------- saving

describe('saving', () => {
	test('a goal is saved once per set or illustrator, and its level and languages change field by field', async () => {
		const made = await goals.createGoal({catalog: 'international', kind: 'set', level: 'numbered', name: 'Test Evolutions', target: 'tev'});
		const again = await goals.createGoal({catalog: 'international', kind: 'set', level: 'master', target: 'tev'});

		assert.equal(again.id, made.id, 'the same set gives the goal already kept');
		assert.equal(made.level, 'numbered');

		const raised = await goals.setGoalLevel(made.id, 'master');

		assert.equal(raised.level, 'master');
		assert.ok(raised.updated_at > made.updated_at);

		const checklists = await import('../js/checklists.js');
		const named = await checklists.setListLanguages(made.id, ['pt']);

		assert.deepEqual(named.languages, ['pt']);
		assert.equal(named.level, 'master');

		const artist = await goals.createGoal({kind: 'artist', target: '  Aiko Testa '});

		assert.equal(artist.target, 'Aiko Testa');
		assert.equal(artist.name, 'Aiko Testa');
		assert.deepEqual((await goals.listGoals()).map((goal) => goal.kind).sort(), ['artist', 'set']);
		assert.deepEqual(await checklists.listChecklists(), [], 'goals are not checklists');

		await checklists.deleteChecklist(artist.id);
		assert.deepEqual((await goals.listGoals()).map((goal) => goal.id), [made.id]);
		await assert.rejects(goals.createGoal({kind: 'set', level: 'everything', target: 'tev2'}), /Unknown level/);
		await assert.rejects(goals.createGoal({kind: 'artist', target: ' '}), /illustrator/);
	});
});
