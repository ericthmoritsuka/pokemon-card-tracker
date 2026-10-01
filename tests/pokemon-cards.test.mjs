// Unit tests for every card of a Pokémon (js/pokemon-cards.js) and the list
// languages in js/checklists.js, over the real TCGdex responses recorded in
// tests/pokemon-cards-fixtures.mjs (Jigglypuff, dex 39).
//
// Run: node --test tests/pokemon-cards.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {FIXTURES} from './pokemon-cards-fixtures.mjs';

// js/tile.js reaches js/dom.js, which listens for errors on window when it
// loads; the finish rules are tile.js's own, so they are tested through it.
globalThis.window = globalThis.window || {addEventListener() {}};

const cards = await import('../js/pokemon-cards.js');
const checklists = await import('../js/checklists.js');
const {entryFinish, variantFinish} = await import('../js/tile.js');

const {
	asianPrints,
	cardFinishes,
	cardIdsForDex,
	catalogsFor,
	copiesByPrint,
	dexCardsFrom,
	dexFromParam,
	internationalPrints,
	isPocket,
	newestFirst,
	ownedFinishes,
	passesFilter,
	printCounts,
	setIdOf,
	setsIndexFrom,
	tally,
	wishLanguage,
} = cards;

const bulkMap = checklists.dexMapFrom({data: {cards: FIXTURES.bulk}});
const setsIndex = setsIndexFrom({data: {sets: FIXTURES.sets}});
const dexCards = dexCardsFrom({data: {cards: FIXTURES.dexCards}});
const POCKET = ['A1-193', 'A2b-060', 'A3-228', 'P-A-022'];
const record = (path) => FIXTURES.cards[path];

const copy = (id, fields) => ({created_at: '2026-09-01T00:00:00.000Z', deleted_at: null, id, updated_at: '2026-09-01T00:00:00.000Z', ...fields});

describe('selecting the prints', () => {
	test('every card whose dexId includes the number, TAG TEAM cards too', () => {
		const ids = cardIdsForDex(bulkMap, 39);

		assert.equal(ids.length, 41);
		assert.ok(ids.includes('sm12-165'), 'Mega Lopunny & Jigglypuff GX');
		assert.deepEqual(bulkMap['sm12-165'], [39, 428]);
		assert.ok(cardIdsForDex(bulkMap, 428).includes('sm12-165'), 'the same card lists under Lopunny');
		assert.ok(ids.every((id) => bulkMap[id].includes(39)));

		// An exact number, never a digit match; a Trainer has no numbers.
		assert.deepEqual(cardIdsForDex({'a-1': [391], 'b-2': [39, 428], 'c-3': [], 'd-4': [139]}, 39), ['b-2']);
		assert.deepEqual(cardIdsForDex({'b-2': [39]}, '39'), ['b-2']);
	});

	test('the set of a card ID is the longest known set it starts with', () => {
		const known = new Map(Object.entries(setsIndex));

		assert.equal(setIdOf('tk-xy-w-12', known), 'tk-xy-w');
		assert.equal(setIdOf('sv03.5-039', known), 'sv03.5');
		assert.equal(setIdOf('P-A-022', known), 'P-A');
		assert.equal(setIdOf('bwp-BW65', known), 'bwp');
		assert.equal(setIdOf('sv08.5-001', new Map([['sv08', {}], ['sv08.5', {}]])), 'sv08.5');
		// Unknown sets fall back to everything before the last hyphen.
		assert.equal(setIdOf('tk-xy-w-12'), 'tk-xy-w');
	});

	test('TCG Pocket is left out, by its series or by its image path', () => {
		const all = internationalPrints({cards: dexCards, ids: cardIdsForDex(bulkMap, 39), sets: setsIndex});

		assert.equal(all.length, 37);
		assert.ok(POCKET.every((id) => !all.some((print) => print.cardId === id)));

		// The set list alone, and the images alone, each tell Pocket apart.
		assert.equal(internationalPrints({cards: {}, ids: cardIdsForDex(bulkMap, 39), sets: setsIndex}).length, 37);
		assert.equal(internationalPrints({cards: dexCards, ids: cardIdsForDex(bulkMap, 39), sets: {}}).length, 37);
		assert.equal(isPocket({serie: 'tcgp'}), true);
		assert.equal(isPocket(null, 'https://assets.tcgdex.net/en/tcgp/A1/193'), true);
		assert.equal(isPocket({serie: 'sv'}, 'https://assets.tcgdex.net/en/sv/sv03.5/039'), false);

		// Asian catalogs too.
		const pocketBrief = {id: 'A1-001', image: 'https://assets.tcgdex.net/ja/tcgp/A1/001', localId: '001', name: 'フシギダネ'};

		assert.equal(asianPrints({briefs: [pocketBrief], catalog: 'ja', sets: new Map([['A1', {serie: {id: 'tcgp'}}]])}).length, 0);
	});

	test('a print carries its name, image, set, and date', () => {
		const prints = internationalPrints({cards: dexCards, ids: ['sm12-165', 'tk-xy-w-12'], sets: setsIndex});

		assert.deepEqual(prints[0], {
			cardId: 'sm12-165',
			catalog: 'international',
			image: 'https://assets.tcgdex.net/en/sm/sm12/165',
			localId: '165',
			name: 'Mega Lopunny & Jigglypuff GX',
			releaseDate: '2019-11-01',
			setId: 'sm12',
			setName: 'Cosmic Eclipse',
		});
		assert.equal(prints[1].localId, '12');
		assert.equal(prints[1].setId, 'tk-xy-w');
	});

	test('Japanese prints come from the dexId list and each set\'s details', () => {
		const sets = new Map(Object.entries(FIXTURES.jaSets));
		const prints = asianPrints({briefs: FIXTURES.asian.ja, catalog: 'ja', sets});

		assert.equal(prints.length, 17);
		assert.ok(prints.some((print) => print.name === 'メガミミロップ&プリンGX'), 'the TAG TEAM card');

		const sv2a = prints.find((print) => print.cardId === 'SV2a-039');

		assert.equal(sv2a.setName, 'ポケモンカード151');
		assert.equal(sv2a.releaseDate, '2023-06-16');
		assert.equal(sv2a.catalog, 'ja');

		// A set that could not be read lists its cards without a name.
		const unread = asianPrints({briefs: FIXTURES.asian.ja, catalog: 'ja', sets: new Map([...sets].map(([id, set]) => [id, id === 'SV2a' ? null : set]))});

		assert.equal(unread.find((print) => print.cardId === 'SV2a-039').setName, null);
		assert.deepEqual(FIXTURES.asian.ko, [], 'the Korean catalog has no cards (2026-10-01)');
	});

	test('newest first: by release date, then the higher number, undated last', () => {
		const sorted = newestFirst(internationalPrints({cards: dexCards, ids: cardIdsForDex(bulkMap, 39), sets: setsIndex}));

		assert.equal(sorted[0].cardId, 'me02-076');
		assert.equal(sorted[0].releaseDate, '2025-11-14');
		assert.equal(sorted[1].cardId, '2024sv-4');

		for (let i = 1; i < sorted.length; i++) {
			assert.ok(!sorted[i].releaseDate || sorted[i - 1].releaseDate >= sorted[i].releaseDate, `${sorted[i - 1].cardId} before ${sorted[i].cardId}`);
		}

		const cosmic = sorted.filter((print) => print.setId === 'sm12').map((print) => print.cardId);

		assert.deepEqual(cosmic, ['sm12-261', 'sm12-226', 'sm12-225', 'sm12-165']);

		const mixed = newestFirst([
			{cardId: 'x-1', localId: '1', releaseDate: null, setId: 'x'},
			{cardId: 'y-TG2', localId: 'TG2', releaseDate: '2020-01-01', setId: 'y'},
			{cardId: 'y-TG10', localId: 'TG10', releaseDate: '2020-01-01', setId: 'y'},
		]);

		assert.deepEqual(mixed.map((print) => print.cardId), ['y-TG10', 'y-TG2', 'x-1']);
	});
});

describe('languages and ownership', () => {
	test('a list reads Portuguese only until it names its languages', () => {
		assert.deepEqual(checklists.listLanguages({}), ['pt']);
		assert.deepEqual(checklists.listLanguages(null), ['pt']);
		assert.deepEqual(checklists.listLanguages({languages: []}), ['pt']);
		assert.deepEqual(checklists.listLanguages({languages: ['pt', 'en', 'pt', 'xx']}), ['pt', 'en']);
		assert.deepEqual(checklists.listLanguages({languages: ['ja']}), ['ja']);
	});

	test('the catalogs a list needs, international first', () => {
		assert.deepEqual(catalogsFor(['pt']), ['international']);
		assert.deepEqual(catalogsFor(['pt', 'en', 'fr']), ['international']);
		assert.deepEqual(catalogsFor(['ja']), ['ja']);
		assert.deepEqual(catalogsFor(['zh-tw', 'pt', 'ja']), ['international', 'ja', 'zh-tw']);
	});

	test('a card counts only for a live copy in one of the list\'s languages', () => {
		const entries = [
			copy('a', {card_id: 'sv03.5-039', catalog: 'international', language: 'pt'}),
			copy('b', {card_id: 'sv03.5-039', catalog: 'international', language: 'en'}),
			copy('c', {card_id: 'swsh3-67', catalog: 'international', language: 'en'}),
			copy('d', {card_id: 'xy1-87', catalog: 'international', deleted_at: '2026-09-02T00:00:00.000Z', language: 'pt'}),
			copy('e', {card_id: 'SV2a-039', catalog: 'ja', language: 'ja'}),
		];
		const ptOnly = copiesByPrint(entries, ['pt']);

		assert.deepEqual([...ptOnly.keys()], ['international|sv03.5-039']);
		assert.deepEqual(ptOnly.get('international|sv03.5-039').map((entry) => entry.id), ['a']);

		const ptEn = copiesByPrint(entries, ['pt', 'en']);

		assert.deepEqual(ptEn.get('international|sv03.5-039').map((entry) => entry.id), ['a', 'b']);
		assert.ok(ptEn.has('international|swsh3-67'));
		assert.ok(!ptEn.has('international|xy1-87'), 'a deleted copy never counts');
		assert.ok(copiesByPrint(entries, ['ja']).has('ja|SV2a-039'));
		assert.deepEqual(checklists.entriesInLanguages(entries, ['en']).map((entry) => entry.id), ['b', 'c']);
	});

	test('the wishlist language is the list\'s one language for that catalog', () => {
		assert.equal(wishLanguage(['pt'], 'international'), 'pt');
		assert.equal(wishLanguage(['pt', 'en'], 'international'), null);
		assert.equal(wishLanguage(['pt', 'ja'], 'ja'), 'ja');
		assert.equal(wishLanguage(['pt', 'ja'], 'international'), 'pt');
		assert.equal(wishLanguage(['pt'], 'ja'), null);
	});
});

describe('counting every finish', () => {
	test('the finishes come from variants_detailed', () => {
		assert.deepEqual(cardFinishes(record('ja/cards/SV2a-039'), variantFinish), ['normal', 'pokeball', 'masterball']);
		assert.deepEqual(cardFinishes(record('en/cards/sv03.5-039'), variantFinish), ['normal', 'reverse']);
		assert.deepEqual(cardFinishes(record('en/cards/base2-54'), variantFinish), ['normal', 'first']);
		assert.deepEqual(cardFinishes(record('en/cards/sv04.5-198'), variantFinish), ['normal'], 'a holo rare\'s plain print');
	});

	test('a stamped promo or a jumbo is another product, not a finish', () => {
		const detail = {variants_detailed: [
			{type: 'normal', variantId: 'n'},
			{stamp: ['pre-release'], type: 'holo', variantId: 'p'},
			{size: 'jumbo', type: 'holo', variantId: 'j'},
			{foil: 'masterball', type: 'reverse', variantId: 'm'},
		]};

		assert.deepEqual(cardFinishes(detail, variantFinish), ['normal', 'masterball']);
		assert.deepEqual(cardFinishes({variants: {firstEdition: true, holo: true, reverse: true}}, variantFinish), ['normal', 'reverse', 'first']);
		assert.deepEqual(cardFinishes({}, variantFinish), ['normal']);
		assert.deepEqual(cardFinishes(null, variantFinish), ['normal']);
	});

	test('the finishes owned, the counts, and the filter', () => {
		const ja = record('ja/cards/SV2a-039');
		const master = ja.variants_detailed.find((variant) => variant.foil === 'masterball').variantId;
		const copies = [copy('a', {card_id: 'SV2a-039', catalog: 'ja', language: 'ja', variant_id: master}), copy('b', {card_id: 'SV2a-039', catalog: 'ja', language: 'ja'})];
		const owned = ownedFinishes(copies, ja.variants_detailed, entryFinish);

		assert.deepEqual([...owned].sort(), ['masterball', 'normal']);

		const finishes = cardFinishes(ja, variantFinish);
		const state = {copies, finishes, owned};

		assert.deepEqual(printCounts(state, false), {missing: 0, owned: 1, total: 1, unknown: false});
		assert.deepEqual(printCounts(state, true), {missing: 1, owned: 2, total: 3, unknown: false});
		assert.equal(passesFilter(state, 'owned', true), true);
		assert.equal(passesFilter(state, 'missing', true), true, 'the Poké Ball finish is still missing');
		assert.equal(passesFilter(state, 'missing', false), false);

		// A record not on the phone counts once; a finish the record does not
		// list but a copy is in still counts.
		const unknown = {copies: [], finishes: null, owned: new Set()};

		assert.deepEqual(printCounts(unknown, true), {missing: 1, owned: 0, total: 1, unknown: true});
		assert.deepEqual(printCounts({copies: [copies[0]], finishes: ['normal'], owned: new Set(['reverse'])}, true), {missing: 1, owned: 1, total: 2, unknown: false});

		const sum = tally([state, unknown, {copies: [], finishes: ['normal', 'reverse'], owned: new Set()}], true);

		assert.deepEqual(sum, {missing: 4, owned: 2, total: 6, unknown: 1});
		assert.deepEqual(tally([state, unknown], false), {missing: 1, owned: 1, total: 2, unknown: 0});
	});

	test('every recorded Jigglypuff card has at least one finish', () => {
		for (const [path, detail] of Object.entries(FIXTURES.cards)) {
			assert.ok(cardFinishes(detail, variantFinish).length >= 1, path);
		}
	});
});

describe('parsing', () => {
	test('responses that are not lists fail loudly', () => {
		assert.throws(() => setsIndexFrom({data: null}), /no set list/);
		assert.throws(() => dexCardsFrom({errors: []}), /no card list/);
		assert.equal(setsIndex['P-A'].serie, 'tcgp');
	});

	test('a dex route parameter', () => {
		assert.equal(dexFromParam('39'), 39);
		assert.equal(dexFromParam('039'), 39);
		assert.equal(dexFromParam('0'), null);
		assert.equal(dexFromParam('1026'), null);
		assert.equal(dexFromParam('3x'), null);
	});
});
