// Browser tests for the Sets tab's card search (js/card-search.js): typing
// in the Sets search box shows the matching sets first, then card tiles
// grouped by set with the Owned mark and language flags, each opening the
// card page; online from a faked TCGdex card search, offline from the sets
// saved on the phone. Headless Chromium at 390 x 844 against
// tests/pages-server.mjs. Every outside service is faked; invented data only.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/sets-card-search-browser.test.mjs
// Screenshots: $SHOTS (default /tmp)/sets-card-search-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {BASE, CARDS, fakeServices, fullRecord, seed} from './my-cards-fixtures.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const SHOTS = process.env.SHOTS || '/tmp';
const TIMEOUT = {timeout: 20000};

const INTERNATIONAL = CARDS.filter((card) => card.catalog === 'international');
const localIdOf = (card) => card.id.slice(card.id.lastIndexOf('-') + 1);
const SET_CODES = {tsa1: 'TSA', tsb2: 'TSB'};

// The two invented international sets as the REST series record lists them.
const SERIE = {
	id: 'tst',
	name: 'Test Series',
	releaseDate: '2026-03-01',
	sets: ['tsa1', 'tsb2'].map((id) => {
		const {name, official} = INTERNATIONAL.find((card) => card.set.id === id).set;

		return {abbreviation: {official: SET_CODES[id]}, cardCount: {official, total: official}, id, logo: null, name};
	}),
};

// The set list js/catalog.js builds from it, for a phone that saved it.
const SET_LIST = [{id: 'tst', name: 'Test Series', releaseDate: '2026-03-01', sets: SERIE.sets.map(({abbreviation, ...set}, i) => ({...set, code: abbreviation.official, releaseRank: i}))}];

// The REST set record, cards included.
const setRecord = (id, lang = 'en') => {
	const cards = INTERNATIONAL.filter((card) => card.set.id === id);

	return {
		cardCount: {official: cards[0].set.official, total: cards[0].set.official},
		cards: cards.map((card) => ({id: card.id, image: null, localId: localIdOf(card), name: card.names[lang] || card.names.en})),
		id,
		name: cards[0].set.name,
		serie: {id: 'tst', name: 'Test Series'},
	};
};

let server;
let browser;

before(async () => {
	server = await startPagesServer();
	browser = await chromium.launch();
});

after(async () => {
	await browser.close();
	await server.close();
});

// The faked TCGdex: my-cards-fixtures answers card records and the details
// query; this adds the series list, set records, and the card search, which
// reads its filters and @locale from the query text. Returns the searches.
async function fakeCatalog(context) {
	const searches = [];

	await context.route('https://api.tcgdex.net/**', async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname.replace(/^\/v2\//, '');
		const json = (body) => route.fulfill({body: JSON.stringify(body), contentType: 'application/json'});

		if (path === 'en/series') {
			return json([{id: 'tst', name: 'Test Series'}]);
		}

		if (path === 'en/sets') {
			return json(SERIE.sets.map(({id}) => ({id})));
		}

		if (path === 'en/series/tst') {
			return json(SERIE);
		}

		const set = /^(en|pt)\/sets\/([^/]+)$/.exec(path);

		if (set && SET_CODES[set[2]]) {
			return json(setRecord(set[2], set[1]));
		}

		const query = path === 'graphql' ? String(JSON.parse(request.postData() || '{}').query || '') : '';

		if (!query.includes('cardCount { official }')) {
			return route.fallback();
		}

		const lang = (/@locale\(lang: "([^"]+)"\)/.exec(query) || [null, 'en'])[1];
		const filter = (key) => (new RegExp(`${key}: "([^"]*)"`).exec(query) || [])[1];
		const [name, localId, id] = [filter('name'), filter('localId'), filter('id')];

		searches.push(query);

		const cards = ['en', 'pt'].includes(lang) ? INTERNATIONAL : [];

		return json({data: {cards: cards
			.filter((card) => (!name || String(card.names[lang] || '').toLowerCase().includes(name.toLowerCase()))
				&& (!localId || localIdOf(card).replace(/^0+/, '').includes(localId))
				&& (!id || card.id.includes(id)))
			.map((card) => ({
				id: card.id,
				image: null,
				localId: localIdOf(card),
				name: card.names[lang] || card.names.en,
				rarity: card.rarity,
				set: {cardCount: {official: card.set.official}, id: card.set.id, name: card.set.name, serie: {id: 'tst'}},
			}))}});
	});

	return searches;
}

async function phone(records = {}) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: {height: 844, width: 390}});

	await fakeServices(context);
	await fakePokeApi(context);

	const searches = await fakeCatalog(context);
	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err.message));
	await seed(page, server.origin, {binders: [], records});
	await page.goto(`${server.origin}${BASE}sets`);
	await page.locator('.set-tile').first().waitFor(TIMEOUT);

	return {context, errors, page, searches};
}

const cardTiles = (page) => page.locator('#sets-card-results .tile .tile-name').allTextContents();

// Whether the set list comes before the card results on the page.
const setsFirst = (page) => page.evaluate(() => Boolean(document.querySelector('.set-list').compareDocumentPosition(document.getElementById('sets-card-results')) & Node.DOCUMENT_POSITION_FOLLOWING));

describe('card search in the Sets tab', () => {
	test('online: sets first, then card tiles with the Owned mark that open the card page', async () => {
		const {context, errors, page, searches} = await phone();

		await page.fill('.toolbar input.search', 'test');
		await page.locator('#sets-card-results .tile').first().waitFor(TIMEOUT);

		// Both test sets still match by name, above the cards.
		assert.deepEqual(await page.locator('.set-list .set-name').allTextContents(), ['Test Alpha', 'Test Beta']);
		assert.ok(await setsFirst(page));
		// Test Ball, found in English and in Portuguese ("Bola de Teste"), is one tile.
		assert.deepEqual(await cardTiles(page), ['Test Ball']);
		assert.equal(await page.locator('#sets-card-results h4').textContent(), 'Test Alpha');
		assert.match(await page.locator('#sets-card-results .tile.owned .tile-meta').textContent(), /^#150 · Owned in PT$/);
		assert.equal(await page.locator('#sets-card-results .tile .badge-lang').count(), 1, 'the Portuguese copy shows its flag');
		// English and Portuguese only: no species is named "test". The search
		// runs again once the species names are in, for the Asian prints.
		assert.deepEqual([...new Set(searches.map((query) => (/@locale\(lang: "([^"]+)"\)/.exec(query) || [null, 'en'])[1]))], ['en', 'pt']);
		await page.screenshot({path: `${SHOTS}/sets-card-search-online.png`});

		// A number with the set size, and a set code with a number.
		await page.fill('.toolbar input.search', '025/120');
		await page.waitForFunction(() => /^1 card\.$/.test((document.getElementById('sets-card-status') || {}).textContent || ''), null, TIMEOUT);
		assert.deepEqual(await cardTiles(page), ['Pikachu']);
		await page.fill('.toolbar input.search', 'TSA 4');
		await page.waitForFunction(() => [...document.querySelectorAll('#sets-card-results .tile-name')].map((node) => node.textContent).join() === 'Charmander', null, TIMEOUT);

		await page.click('#sets-card-results .tile');
		await page.waitForURL(/\/cards\/en\/tsa1-004$/, TIMEOUT);
		await page.locator('#copies-title').waitFor(TIMEOUT);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('offline: the sets saved on the phone are searched, and a saved card opens', async () => {
		const testBall = INTERNATIONAL.find((card) => card.id === 'tsa1-150');
		const saved = (data) => ({at: Date.now(), data});
		const {context, errors, page, searches} = await phone({
			'card:en:tsa1-150': saved(fullRecord(testBall, 'en')),
			'set:en:tsa1': saved(setRecord('tsa1')),
			'setlist4:en': saved(SET_LIST),
		});

		await context.setOffline(true);
		await page.fill('.toolbar input.search', 'ball');
		await page.waitForFunction(() => /saved on this phone/.test((document.getElementById('sets-card-status') || {}).textContent || ''), null, TIMEOUT);
		assert.equal(await page.locator('#sets-card-status').textContent(), '1 card saved on this phone.');
		assert.deepEqual(await cardTiles(page), ['Test Ball']);
		assert.ok(await setsFirst(page));
		assert.deepEqual(searches, [], 'no card search sent offline');
		await page.screenshot({path: `${SHOTS}/sets-card-search-offline.png`});

		// A set code with a number, from the saved set.
		await page.fill('.toolbar input.search', 'TSA 001');
		await page.waitForFunction(() => [...document.querySelectorAll('#sets-card-results .tile-name')].map((node) => node.textContent).join() === 'Bulbasaur', null, TIMEOUT);

		await page.fill('.toolbar input.search', 'ball');
		await page.waitForFunction(() => [...document.querySelectorAll('#sets-card-results .tile-name')].map((node) => node.textContent).join() === 'Test Ball', null, TIMEOUT);
		await page.click('#sets-card-results .tile');
		await page.waitForURL(/\/cards\/en\/tsa1-150$/, TIMEOUT);
		await page.locator('#copies-title').waitFor(TIMEOUT);
		assert.deepEqual(errors, []);
		await context.close();
	});
});
