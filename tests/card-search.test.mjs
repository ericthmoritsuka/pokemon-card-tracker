// Tests for the Sets tab's card search (js/card-search.js): the query
// parsing, the search over sets saved on the phone, and the TCGdex requests
// with a faked GraphQL. Node only, no browser and no network. Every set and
// card here is invented.
//
// Run: node --test tests/card-search.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {MAX_RESULTS, cardRequests, parseCardQuery, searchOnline, searchSaved} from '../js/card-search.js';

const SETS = [{catalog: 'international', code: 'TSA', id: 'tsa1'}, {catalog: 'international', code: null, id: 'tsb2'}];

// Species tables shaped as js/checklists.js speciesNames gives them.
const TABLES = {
	en: {25: 'Pikachu'},
	ja: {25: 'ピカチュウ'},
	'ja-roma': {25: 'Pikachu'},
	ko: {25: '피카츄'},
	'zh-hans': {25: '皮卡丘'},
	'zh-hant': {25: '皮卡丘'},
};

const set = (id, name, official, cards, serie = 'tst') => ({cardCount: {official}, cards, id, name, serie: {id: serie}});
const card = (setId, localId, name) => ({id: `${setId}-${localId}`, image: null, localId, name});

// Saved records as js/catalog.js savedCatalog returns them.
const SAVED = {
	cards: [{card: {id: 'tsa1-201', rarity: 'Special illustration rare'}, lang: 'en'}],
	sets: [
		{lang: 'en', set: set('tsa1', 'Test Alpha', 165, [card('tsa1', '025', 'Pikachu'), card('tsa1', '026', 'Raichu V'), card('tsa1', '150', 'Test Ball'), card('tsa1', '201', 'Pikachu ex')])},
		{lang: 'pt', set: set('tsa1', 'Teste Alfa', 165, [card('tsa1', '025', 'Pikachu'), card('tsa1', '150', 'Bola de Teste')])},
		{lang: 'en', set: set('tsb2', 'Test Beta', 120, [card('tsb2', '25', 'Pikachu VMAX'), card('tsb2', 'TG05', 'Test Gardener')])},
		{lang: 'en', set: set('tsbp', 'Test Black Star Promos', 50, [card('tsbp', '025', 'Pikachu')])},
		{lang: 'ja', set: set('TSJ1', 'テストパック', 100, [card('TSJ1', '025', 'ピカチュウ'), card('TSJ1', '030', 'ピカチュウex')])},
		{lang: 'en', set: set('TP1', 'Test Pocket', 80, [card('TP1', '025', 'Pikachu')], 'tcgp')},
	],
};

const ids = (found) => found.results.map((result) => `${result.lang}:${result.id}`).sort();

describe('parseCardQuery', () => {
	test('a name', () => {
		assert.deepEqual(parseCardQuery('  Pikachu  ', SETS), {kinds: [], name: 'pikachu', number: null, setCatalog: null, setId: null, total: null});
		assert.equal(parseCardQuery('Bola de Teste').name, 'bola de teste');
	});

	test('a number, and a number with the set size', () => {
		assert.deepEqual(parseCardQuery('025', SETS), {kinds: [], name: '', number: '025', setCatalog: null, setId: null, total: null});
		assert.deepEqual(parseCardQuery('025/165'), {kinds: [], name: '', number: '025', setCatalog: null, setId: null, total: '165'});
		assert.equal(parseCardQuery('TG05').number, 'tg05');
	});

	test('a set code with a number, by printed code or set ID', () => {
		assert.deepEqual(parseCardQuery('TSA 025', SETS), {kinds: [], name: '', number: '025', setCatalog: 'international', setId: 'tsa1', total: null});
		assert.equal(parseCardQuery('tsb2 25', SETS).setId, 'tsb2');
		// Without a number, a word that is also a set code stays a name.
		assert.equal(parseCardQuery('tsa', SETS).name, 'tsa');
		assert.equal(parseCardQuery('tsa', SETS).setId, null);
	});

	test('kinds, alone or with a name or number', () => {
		assert.deepEqual(parseCardQuery('Charizard ex').kinds, ['ex']);
		assert.equal(parseCardQuery('Charizard ex').name, 'charizard');
		assert.deepEqual(parseCardQuery('pikachu SIR').kinds, ['sir']);
		assert.deepEqual(parseCardQuery('full art 025').kinds, ['full art']);
		assert.deepEqual(parseCardQuery('fullart').kinds, ['full art']);
		assert.deepEqual(['gx', 'v', 'vmax', 'vstar', 'promo'].map((kind) => parseCardQuery(kind.toUpperCase()).kinds), [['gx'], ['v'], ['vmax'], ['vstar'], ['promo']]);
	});

	test('nothing to search: empty, or one letter', () => {
		assert.equal(parseCardQuery(''), null);
		assert.equal(parseCardQuery('  '), null);
		assert.equal(parseCardQuery('p'), null);
	});
});

describe('searchSaved', () => {
	const search = (text, options) => searchSaved(parseCardQuery(text, SETS), SAVED, {tables: TABLES, ...options});

	test('by name in English, one print for both languages, never TCG Pocket', () => {
		assert.deepEqual(ids(search('raichu')), ['en:tsa1-026']);
		// Pikachu: tsa1-025 is saved in English and Portuguese but is one print.
		assert.deepEqual(ids(search('pikachu')), ['en:tsa1-025', 'en:tsa1-201', 'en:tsb2-25', 'en:tsbp-025', 'ja:TSJ1-025', 'ja:TSJ1-030']);
	});

	test('by Portuguese name, opened in Portuguese; the viewing language wins a shared print', () => {
		assert.deepEqual(ids(search('bola')), ['pt:tsa1-150']);
		assert.deepEqual(ids(search('test ball')), ['en:tsa1-150']);
		assert.deepEqual(ids(search('TSA 150', {viewing: 'pt'})), ['pt:tsa1-150']);
	});

	test('an Asian print by its English name, only once the species names are in', () => {
		assert.ok(ids(search('pikachu')).includes('ja:TSJ1-025'));
		assert.ok(!ids(searchSaved(parseCardQuery('pikachu'), SAVED, {tables: null})).includes('ja:TSJ1-025'));
	});

	test('by number, set size, and set code', () => {
		assert.deepEqual(ids(search('025')), ['en:tsa1-025', 'en:tsb2-25', 'en:tsbp-025', 'ja:TSJ1-025']);
		assert.deepEqual(ids(search('025/165')), ['en:tsa1-025']);
		assert.deepEqual(ids(search('TSA 025')), ['en:tsa1-025']);
		assert.deepEqual(ids(search('tg5')), ['en:tsb2-TG05']);
	});

	test('by kind', () => {
		assert.deepEqual(ids(search('pikachu ex')), ['en:tsa1-201', 'ja:TSJ1-030']);
		assert.deepEqual(ids(search('VMAX')), ['en:tsb2-25']);
		assert.deepEqual(ids(search('v')), ['en:tsa1-026']);
		assert.deepEqual(ids(search('pikachu promo')), ['en:tsbp-025']);
		// The rarity comes from a saved card record; unknown rarities do not match.
		assert.deepEqual(ids(search('SIR')), ['en:tsa1-201']);
		assert.deepEqual(ids(search('full art')), ['en:tsa1-201']);
	});

	test('more than MAX_RESULTS keeps the first and says so', () => {
		const many = {cards: [], sets: [{lang: 'en', set: set('tsz', 'Test Zeta', 200, Array.from({length: MAX_RESULTS + 5}, (_, i) => card('tsz', String(i + 1), 'Test Bug')))}]};
		const found = searchSaved(parseCardQuery('test bug'), many);

		assert.equal(found.results.length, MAX_RESULTS);
		assert.equal(found.more, true);
	});
});

describe('searchOnline', () => {
	// A fake GraphQL over invented cards: reads the filters and the locale
	// from the query text, as TCGdex does (name and id match any part).
	const CARDS = {
		en: [
			{id: 'tsa1-025', localId: '025', name: 'Pikachu', rarity: 'Common', set: {cardCount: {official: 165}, id: 'tsa1', name: 'Test Alpha', serie: {id: 'tst'}}},
			{id: 'tsa1-201', localId: '201', name: 'Pikachu ex', rarity: 'Special illustration rare', set: {cardCount: {official: 165}, id: 'tsa1', name: 'Test Alpha', serie: {id: 'tst'}}},
			{id: 'TP1-025', localId: '025', name: 'Pikachu', rarity: 'One Diamond', set: {cardCount: {official: 80}, id: 'TP1', name: 'Test Pocket', serie: {id: 'tcgp'}}},
			{id: 'tsa1-150', localId: '150', name: 'Test Ball', rarity: 'Uncommon', set: {cardCount: {official: 165}, id: 'tsa1', name: 'Test Alpha', serie: {id: 'tst'}}},
		],
		ja: [{id: 'TSJ1-025', localId: '025', name: 'ピカチュウ', rarity: 'Common', set: {cardCount: {official: 100}, id: 'TSJ1', name: 'テストパック', serie: {id: 'tsj'}}}],
		pt: [{id: 'tsa1-150', localId: '150', name: 'Bola de Teste', rarity: 'Uncommon', set: {cardCount: {official: 165}, id: 'tsa1', name: 'Teste Alfa', serie: {id: 'tst'}}}],
	};

	function fakeGraphql(log, fail = () => false) {
		return async (text) => {
			const lang = (/@locale\(lang: "([^"]+)"\)/.exec(text) || [null, 'en'])[1];
			const filter = (key) => (new RegExp(`${key}: "([^"]*)"`).exec(text) || [])[1];
			const [name, localId, id] = [filter('name'), filter('localId'), filter('id')];

			log.push(`${lang} ${text.slice(0, text.indexOf('pagination'))}`);

			if (fail(lang)) {
				throw Object.assign(new Error('TCGdex answered 503.'), {network: true});
			}

			return {cards: (CARDS[lang] || []).filter((row) =>
				(!name || row.name.toLowerCase().includes(name.toLowerCase()))
				&& (!localId || row.localId.replace(/^0+/, '').includes(localId))
				&& (!id || row.id.includes(id)))};
		};
	}

	test('a name asks English, Portuguese, and the Asian catalogs by species name', async () => {
		const log = [];
		const found = await searchOnline(parseCardQuery('pikachu'), {graphql: fakeGraphql(log), tables: TABLES});

		assert.deepEqual(ids(found), ['en:tsa1-025', 'en:tsa1-201', 'ja:TSJ1-025']);
		assert.deepEqual(log.map((line) => line.split(' ')[0]), ['en', 'pt', 'ja', 'ko', 'zh-cn', 'zh-tw']);
		assert.match(log[2], /name: "ピカチュウ"/);
	});

	test('a Portuguese name finds the print in Portuguese', async () => {
		assert.deepEqual(ids(await searchOnline(parseCardQuery('bola'), {graphql: fakeGraphql([]), tables: TABLES})), ['pt:tsa1-150']);
	});

	test('number, set size, set code, and kind filter what TCGdex sends back', async () => {
		const run = (text) => searchOnline(parseCardQuery(text, SETS), {graphql: fakeGraphql([]), tables: TABLES});

		assert.deepEqual(ids(await run('025/165')), ['en:tsa1-025']);
		assert.deepEqual(ids(await run('pikachu SIR')), ['en:tsa1-201']);
		assert.deepEqual(ids(await run('pikachu ex')), ['en:tsa1-201']);

		const log = [];

		assert.deepEqual(ids(await searchOnline(parseCardQuery('TSA 025', SETS), {graphql: fakeGraphql(log)})), ['en:tsa1-025']);
		assert.deepEqual(log, ['en { cards(filters: {localId: "25", id: "tsa1-"}, ']);
	});

	test('one failing catalog is left out; all failing rejects, for the offline search', async () => {
		assert.deepEqual(ids(await searchOnline(parseCardQuery('pikachu'), {graphql: fakeGraphql([], (lang) => lang === 'ja'), tables: TABLES})), ['en:tsa1-025', 'en:tsa1-201']);
		await assert.rejects(searchOnline(parseCardQuery('pikachu'), {graphql: fakeGraphql([], () => true)}), /503/);
	});

	test('promo or full art alone sends nothing and asks to narrow', async () => {
		assert.deepEqual(cardRequests(parseCardQuery('promo')), []);

		const found = await searchOnline(parseCardQuery('full art'), {graphql: () => assert.fail('no request')});

		assert.equal(found.narrow, true);
		assert.deepEqual(cardRequests(parseCardQuery('SIR')).map((request) => /rarity: "Special illustration rare"/.test(request.text)), [true]);
	});
});
