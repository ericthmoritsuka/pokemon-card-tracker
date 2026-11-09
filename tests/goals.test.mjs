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

// ------------------------------------------------------- Pokémon goals
//
// A Pokémon goal (Eric, 2026-11-09) holds what the Pokémon screen shows,
// in the languages he picked: the real Jigglypuff (dex 39) answers recorded
// in tests/pokemon-cards-fixtures.mjs, served by a fetch that records what
// was asked, so the test can say which catalogs were read.

describe('Pokémon goals', async () => {
	const {FIXTURES} = await import('./pokemon-cards-fixtures.mjs');
	const {loadRuleItems} = await import('../js/binder-sources.js');
	const {planRefresh, sortRuleItems} = await import('../js/binder-rules.js');
	const {database} = await import('../js/idb.js');
	const {pokemonGoalCards} = goals;
	const asked = [];
	const body = (data) => ({json: async () => data, ok: true, status: 200});

	const answer = async (url, init) => {
		const path = String(url).replace('https://api.tcgdex.net/v2/', '');

		asked.push(path === 'graphql' ? `graphql ${JSON.parse(init.body).query}` : path);

		if (path === 'graphql') {
			const {query} = JSON.parse(init.body);

			if (query === '{ cards { id dexId } }') {
				return body({data: {cards: FIXTURES.bulk}});
			}

			if (/^\{ sets /.test(query)) {
				return body({data: {sets: FIXTURES.sets}});
			}

			if (/dexId: 39/.test(query)) {
				return body({data: {cards: FIXTURES.dexCards}});
			}
		}

		const list = /^([a-z-]+)\/cards\?dexId=eq:39$/.exec(path);

		if (list) {
			return body(FIXTURES.asian[list[1]] || []);
		}

		const set = /^ja\/sets\/(.+)$/.exec(path);

		if (set && FIXTURES.jaSets[decodeURIComponent(set[1])]) {
			return body(FIXTURES.jaSets[decodeURIComponent(set[1])]);
		}

		return {json: async () => ({}), ok: false, status: 404};
	};

	const jigglypuff = (languages) => ({id: 'p39', kind: 'pokemon', name: 'Jigglypuff', target: '39', ...(languages ? {languages} : {})});

	const noRequests = async (url) => {
		throw new Error(`No requests in this test (${url}).`);
	};

	// Forgets what an earlier test read into the phone's caches (js/idb.js),
	// so a test can start without a list on the phone.
	const forget = (name, store, key) => database(name, [store]).run(store, 'readwrite', (box) => box.delete(key));

	// Node's navigator, set offline for one test and put back.
	const NAVIGATOR = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

	function setOnline(on) {
		if (on) {
			if (NAVIGATOR) {
				Object.defineProperty(globalThis, 'navigator', NAVIGATOR);
			}
			else {
				delete globalThis.navigator;
			}

			return;
		}

		Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {onLine: false}});
	}

	// The card index of a phone that owns these copies: each card's Pokédex
	// numbers, which the index has for owned cards only.
	const indexOf = (entries) => new Map(entries.map((entry) => [`${entry.catalog || 'international'}|${entry.card_id}`, {dex_ids: [39]}]));

	test('it reads the catalogs of its languages only, and Any language reads the international one', () => {
		assert.deepEqual(goalCatalogs(jigglypuff(['pt', 'ja'])), ['international', 'ja']);
		assert.deepEqual(goalCatalogs(jigglypuff(['ja'])), ['ja'], 'Japanese alone needs no international list');
		assert.deepEqual(goalCatalogs(jigglypuff(['en', 'fr'])), ['international']);
		assert.deepEqual(goalCatalogs(jigglypuff(null)), ['international']);
	});

	test('it says its languages; it is named for the Pokémon and found by number', () => {
		assert.equal(goals.describeGoal(jigglypuff(['pt', 'en', 'ja'])), 'Every card in PT, EN, JA');
		assert.equal(goals.describeGoal(jigglypuff(['zh-tw', 'pt'])), 'Every card in PT, CHT', 'in the table\'s order');
		assert.equal(goals.describeGoal(jigglypuff(null)), 'Western prints, any language', 'Any language reads the international prints alone, and says so');
		assert.equal(goals.isGoal(jigglypuff(['pt'])), true);

		const list = [
			{id: 's1', kind: 'set', target: '39'},
			{deleted_at: '2026-09-01T00:00:00.000Z', id: 'p-old', kind: 'pokemon', target: '39'},
			jigglypuff(['pt']),
		];

		assert.equal(findGoal(list, {kind: 'pokemon', target: 39}).id, 'p39', 'a number or its text, never a set with that id, never a deleted one');
		assert.equal(findGoal(list, {kind: 'pokemon', target: '25'}), null);
	});

	test('a copy counts in one of its languages, or with no language recorded, as on the Pokémon screen\'s flags', () => {
		const cards = [
			{cardId: 'xy1-87', catalog: 'international'},
			{cardId: 'swsh3-67', catalog: 'international'},
			{cardId: 'SV2a-039', catalog: 'ja'},
		];
		const entries = [
			copy('xy1-87', null),
			copy('swsh3-67', 'en'),
			copy('SV2a-039', 'ja', {catalog: 'ja'}),
		];
		const states = goalStates({cards, copies: goalCopies(jigglypuff(['pt', 'ja']), entries)});

		assert.deepEqual(states.map((state) => state.owned), [1, 0, 1]);
		// A set goal that names languages still leaves a copy with no
		// language out (unchanged).
		assert.equal(goalCopies(setGoal('numbered', ['pt']), [copy('tev-001', null)]).size, 0);
	});

	test('its cards are the Pokémon screen\'s prints, newest first, TAG TEAM cards and rarity included', () => {
		const cards = pokemonGoalCards([
			{catalog: 'international', prints: [
				{cardId: 'base2-54', catalog: 'international', localId: '54', name: 'Jigglypuff', rarity: 'Common', releaseDate: '1999-06-16', setId: 'base2', setName: 'Jungle'},
				{cardId: 'sm12-165', catalog: 'international', localId: '165', name: 'Mega Lopunny & Jigglypuff GX', rarity: 'Ultra Rare', releaseDate: '2019-11-01', setId: 'sm12', setName: 'Cosmic Eclipse'},
			]},
			{catalog: 'ja', prints: [{cardId: 'SV2a-039', catalog: 'ja', localId: '039', name: 'プリン', releaseDate: '2023-06-16', setId: 'SV2a', setName: 'ポケモンカード151'}]},
		]);

		assert.deepEqual(cards.map((card) => card.cardId), ['SV2a-039', 'sm12-165', 'base2-54']);
		assert.deepEqual(cards[1], {
			cardId: 'sm12-165',
			catalog: 'international',
			finishes: null,
			image: null,
			localId: '165',
			name: 'Mega Lopunny & Jigglypuff GX',
			rarity: 'Ultra Rare',
			releaseDate: '2019-11-01',
			setId: 'sm12',
			setName: 'Cosmic Eclipse',
		});
	});

	test('it is saved once per Pokémon with the languages picked, and checked', async () => {
		const made = await goals.createGoal({kind: 'pokemon', languages: ['ja', 'pt', 'xx'], name: 'Jigglypuff', target: 39});

		assert.equal(made.kind, 'pokemon');
		assert.equal(made.target, '39');
		assert.equal(made.name, 'Jigglypuff');
		assert.deepEqual(made.languages, ['pt', 'ja'], 'list languages only, in the table\'s order');
		assert.equal(made.level, null);
		assert.equal(made.catalog, null);

		const again = await goals.createGoal({kind: 'pokemon', languages: ['en'], target: '39'});

		assert.equal(again.id, made.id, 'the same Pokémon gives the goal already kept');
		assert.deepEqual(again.languages, ['pt', 'ja']);

		const any = await goals.createGoal({kind: 'pokemon', languages: null, target: 35});

		assert.equal(Object.hasOwn(any, 'languages'), false, 'Any language saves no field');
		assert.equal(any.name, 'Pokémon #035', 'a name is never the bare number');
		assert.ok((await goals.listGoals()).some((goal) => goal.id === made.id));
		assert.equal((await goals.getGoal(made.id)).kind, 'pokemon');
		await assert.rejects(goals.createGoal({kind: 'pokemon', languages: [], target: 25}), /at least one language/);
		await assert.rejects(goals.createGoal({kind: 'pokemon', languages: ['pt'], target: 0}), /Pick a Pokémon/);
		await assert.rejects(goals.createGoal({kind: 'pokemon', languages: ['pt'], target: 'pikachu'}), /Pick a Pokémon/);
	});

	test('a binder made from it has a pocket per print, oldest set first, and a missing print fills once owned', async () => {
		asked.length = 0;
		globalThis.fetch = answer;

		try {
			const goal = jigglypuff(['pt', 'ja']);
			const cards = [
				copy('sv03.5-039', 'pt'),
				copy('xy1-87', null),
				copy('swsh3-67', 'en'),
				copy('SV2a-039', 'ja', {catalog: 'ja'}),
			];
			const doc = {binders: [], cards, collections: [], goals: [goal]};
			const rule = {order: 'set', source: {id: goal.id, kind: 'goal'}};
			const loaded = await loadRuleItems(rule, doc, {index: new Map()});

			assert.equal(loaded.gone, false);
			assert.equal(loaded.partial, false);
			assert.equal(loaded.items.length, 37 + 17, 'the 37 international prints and the 17 Japanese ones, as the Pokémon screen counts them');
			assert.deepEqual(loaded.items.filter((item) => item.copies.length).map((item) => item.key).sort(), ['international|sv03.5-039', 'international|xy1-87', 'ja|SV2a-039']);

			const dates = loaded.items.map((item) => item.releaseDate);

			assert.ok(dates.every(Boolean), 'every print dated, so none sorts last for want of a date');
			assert.deepEqual(dates, [...dates].sort(), 'oldest set first');
			assert.equal(loaded.items[0].key, 'ja|PMCG2-035', 'the Japanese Jungle of 1997 first');
			assert.equal(loaded.items.find((item) => item.catalog === 'international').key, 'international|base2-54', 'Jungle the first international pocket');
			assert.ok(!asked.some((path) => /^(ko|zh-cn|zh-tw|en)\//.test(path)), `only the international and Japanese catalogs: ${asked.join(', ')}`);

			const first = planRefresh({cols: 3, rows: 3, rule}, loaded.items, {at: '2026-11-09T00:00:00.000Z', rankOf: () => ({})});

			assert.equal(first.snapshot.keys.length, 54);
			assert.equal(Object.keys(first.snapshot.shown).length, 3, 'the other 51 pockets are placeholders');

			// A Portuguese Jungle copy bought later fills its placeholder.
			const later = await loadRuleItems(rule, {...doc, cards: [...cards, copy('base2-54', 'pt')]}, {index: new Map()});
			const next = planRefresh({cols: 3, rows: 3, rule, snapshot: first.snapshot}, later.items, {at: '2026-11-10T00:00:00.000Z', rankOf: () => ({})});

			assert.deepEqual(next.filled, ['international|base2-54']);
		}
		finally {
			globalThis.fetch = noRequests;
		}
	});

	// Eric, 2026-11-09: "languages I pick". Ticking all seven keeps all
	// seven, with their catalogs; Any language is the Western prints.
	test('every language ticked is kept as ticked and reads every catalog; Any language says it is the Western prints', async () => {
		const checklists = await import('../js/checklists.js');
		const all = ['pt', 'en', 'ja', 'ko', 'zh-cn', 'zh-tw', 'fr'];
		const made = await goals.createGoal({kind: 'pokemon', languages: [...all].reverse(), name: 'Pikachu', target: 25});

		assert.deepEqual(made.languages, all);
		assert.deepEqual(goalCatalogs(made), ['international', 'ja', 'ko', 'zh-cn', 'zh-tw']);
		assert.equal(goals.describeGoal(made), 'Every card in PT, EN, JA, KO, CHS, CHT, FR');

		// On the goal's screen too (the languages control).
		await checklists.setListLanguages(made.id, ['pt']);
		assert.deepEqual((await checklists.setListLanguages(made.id, all)).languages, all);

		const any = await checklists.setListLanguages(made.id, null);

		assert.equal(Object.hasOwn(any, 'languages'), false);
		assert.deepEqual(goalCatalogs(any), ['international']);
		assert.equal(goals.describeGoal(any), 'Western prints, any language');

		// A set goal (and a checklist) still saves every language as Any
		// language.
		const set = await goals.createGoal({catalog: 'international', kind: 'set', level: 'numbered', target: 'tev-all'});

		assert.equal(Object.hasOwn(await checklists.setListLanguages(set.id, all), 'languages'), false);
	});

	test('a Korean goal reads the Japanese prints Korean copies are saved on, and counts the Korean copies', async () => {
		assert.deepEqual(goalCatalogs(jigglypuff(['ko'])), ['ja', 'ko']);

		const counted = goalCopies(jigglypuff(['ko']), [copy('SV2a-039', 'ko', {catalog: 'ja'}), copy('SV2a-039', 'ja', {catalog: 'ja'})]);

		assert.deepEqual(counted.get('ja|SV2a-039').map((entry) => entry.language), ['ko'], 'the Korean copy, not the Japanese one');
		globalThis.fetch = answer;

		try {
			const loaded = await goals.loadGoalCards(jigglypuff(['ko']));

			assert.equal(loaded.cards.length, 17, 'the 17 Japanese prints');
			assert.equal(loaded.incomplete, false);
		}
		finally {
			globalThis.fetch = noRequests;
		}
	});

	// The reviewer's two cases (2026-11-09): a PT and JA goal whose Japanese
	// list is not on the phone, offline; and one Japanese set's details that
	// cannot be read. Either way the cards are not the whole list, and the
	// binder must be told (js/binders-view.js keeps its pages then:
	// tests/pokemon-cards-browser.test.mjs).
	test('a goal read only in part says which part, and its binder\'s list is incomplete', async () => {
		const goal = jigglypuff(['pt', 'ja']);
		const doc = {binders: [], cards: [copy('SV2a-039', 'ja', {catalog: 'ja'})], collections: [], goals: [goal]};
		const rule = {order: 'set', source: {id: goal.id, kind: 'goal'}};

		globalThis.fetch = answer;

		try {
			const whole = await loadRuleItems(rule, doc, {index: new Map()});

			assert.equal(whole.items.length, 54);
			assert.equal(whole.incomplete, false);
			assert.deepEqual(whole.gaps, []);

			await forget('card-tracker-pokemon-cards', 'cache', 'dex:ja:39');
			setOnline(false);

			const offline = await loadRuleItems(rule, doc, {index: new Map()});

			assert.equal(offline.items.length, 37, 'the international prints alone');
			assert.equal(offline.incomplete, true);
			assert.equal(offline.partial, true);
			assert.deepEqual(offline.gaps, [{catalog: 'ja', kind: 'list'}]);
			assert.equal(goals.gapText(offline.gaps, {online: false}), 'The Japanese prints are not on this phone yet.');
			assert.equal(goals.gapText(offline.gaps, {online: true}), 'The Japanese prints did not load.');
			setOnline(true);

			// Online, with one Japanese set's details refused.
			await forget('card-tracker-catalog', 'responses', 'set:ja:SV2a');
			globalThis.fetch = (url, init) => (/\/ja\/sets\/SV2a$/.test(String(url)) ? Promise.resolve({json: async () => ({}), ok: false, status: 403}) : answer(url, init));

			const unread = await loadRuleItems(rule, doc, {index: new Map()});

			assert.equal(unread.items.length, 54, 'every print, one set\'s undated');
			assert.equal(unread.items.find((item) => item.key === 'ja|SV2a-039').releaseDate, null);
			assert.equal(unread.incomplete, true);
			assert.deepEqual(unread.gaps, [{catalog: 'ja', count: 1, kind: 'sets'}]);
			assert.equal(goals.gapText(unread.gaps), '1 set of Japanese prints could not be read, so their cards have no set name or date yet.');
		}
		finally {
			setOnline(true);
			globalThis.fetch = noRequests;
		}
	});

	test('a binder from it keeps its pockets: new prints join at the end, and buying one moves none, in set or Pokédex order', async () => {
		globalThis.fetch = answer;

		try {
			const goal = jigglypuff(['pt', 'ja']);
			const owned = [copy('SV2a-039', 'ja', {catalog: 'ja'}), copy('sm12-165', 'pt')];
			const doc = {binders: [], cards: owned, collections: [], goals: [goal]};
			const when = '2026-11-09T00:00:00.000Z';
			const later = '2026-11-10T00:00:00.000Z';
			const rankOf = () => ({});

			// Set and number: a promo TCGdex adds later, dated 2023, and a
			// Japanese set from 1996 it adds late.
			const rule = {order: 'set', source: {id: goal.id, kind: 'goal'}};
			const loaded = await loadRuleItems(rule, doc, {index: indexOf(owned)});
			const first = planRefresh({cols: 3, rows: 3, rule}, loaded.items, {at: when, keepOrder: loaded.keepOrder, rankOf});
			const fresh = (key, releaseDate, setId) => ({cardId: key.split('|')[1], catalog: key.split('|')[0], copies: [], dex: null, dexIds: [39], key, kind: 'card', name: 'Jigglypuff', number: '1', releaseDate, setId});
			const promo = fresh('international|svp-999', '2023-03-31', 'svp');
			const oldSet = fresh('ja|PMCG1-001', '1996-10-20', 'PMCG1');
			const grown = sortRuleItems([...loaded.items, promo, oldSet], 'set');

			assert.equal(loaded.keepOrder, true, 'a Pokémon goal in set order keeps its pockets');
			assert.equal(grown[0].key, oldSet.key, 'by date, the old set would go first');
			assert.ok(grown.findIndex((item) => item.key === promo.key) < 50, 'and the promo into the middle');

			const next = planRefresh({cols: 3, rows: 3, rule, snapshot: first.snapshot}, grown, {at: later, keepOrder: loaded.keepOrder, rankOf});

			assert.deepEqual(next.snapshot.keys, [...first.snapshot.keys, oldSet.key, promo.key], 'every pocket where it was, the new prints at the end');
			assert.deepEqual(next.added, [oldSet.key, promo.key]);
			assert.notDeepEqual(planRefresh({cols: 3, rows: 3, rule, snapshot: first.snapshot}, grown, {at: later, rankOf}).snapshot.keys.slice(0, 54), first.snapshot.keys, 'without keepOrder they would move');

			// Pokédex order: every print carries its numbers owned or not, so
			// buying one moves nothing; a TAG TEAM card carries both.
			const dexRule = {order: 'dex', source: {id: goal.id, kind: 'goal'}};
			const before = await loadRuleItems(dexRule, doc, {index: indexOf(owned)});
			const dexFirst = planRefresh({cols: 3, rows: 3, rule: dexRule}, before.items, {at: when, rankOf});
			const bought = [...owned, copy('base2-54', 'pt')];
			const after = await loadRuleItems(dexRule, {...doc, cards: bought}, {index: indexOf(bought)});
			const dexNext = planRefresh({cols: 3, rows: 3, rule: dexRule, snapshot: dexFirst.snapshot}, after.items, {at: later, rankOf});

			assert.equal(before.keepOrder, false);
			assert.deepEqual(after.items.find((item) => item.key === 'international|sm12-165').dexIds, [39, 428]);
			assert.deepEqual(after.items.find((item) => item.key === 'ja|SV2a-039').dexIds, [39]);
			assert.deepEqual(dexNext.filled, ['international|base2-54']);
			assert.deepEqual(dexNext.snapshot.keys, dexFirst.snapshot.keys, 'buying a print moves no pocket');
		}
		finally {
			globalThis.fetch = noRequests;
		}
	});
});
