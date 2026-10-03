// Browser tests for set and artist goals (js/goals.js, js/goals-view.js,
// css/goals.css): making a set goal from the set page and from New goal on
// the Lists tab, its ring and "N of M" at each level, All, Owned, and
// Missing with their counts, the search, one tap to the wishlist, the
// Missing list offline, an artist goal from card detail's illustrator line
// and from New goal with the suggestions, and the Goals section of the
// Lists tab. Headless Chromium against tests/pages-server.mjs, signed out,
// at 390 x 844.
//
// Every outside service is faked: TCGdex answers with an invented set
// ("Test Evolutions", 4 numbered cards and 2 secret rares, ball patterns
// and a stamp among the finishes) and an invented illustrator, PokeAPI with
// tests/fake-pokeapi.mjs. Supabase must never be contacted, and
// ligapokemon.com.br is never requested.
//
// Until app.js routes the goal screens and index.html links css/goals.css,
// the page is served with the integration lines added (INTEGRATION below,
// the lines the integrator adds), so the test sees the app as it will be.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/goals-browser.test.mjs
// Screenshots: $SHOTS (default /tmp)/goals-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const PHONE = {height: 844, width: 390};
const SHOTS = process.env.SHOTS || '/tmp';

// The lines the integrator adds to app.js and index.html.
export const INTEGRATION = {
	accountViews: ', ...goalAccountViews',
	import: 'import {goalAccountViews, goalRoutes} from \'./js/goals-view.js\';',
	routes: '\t...goalRoutes,',
	stylesheet: `<link rel="stylesheet" href="${BASE}css/goals.css">`,
};

function integrateApp(text) {
	if (text.includes('goalRoutes')) {
		return text;
	}

	return text
		.replace('import {importView} from \'./js/import-view.js\';', `${INTEGRATION.import}\nimport {importView} from './js/import-view.js';`)
		.replace('\t...pokemonCardsRoutes,\n', `\t...pokemonCardsRoutes,\n${INTEGRATION.routes}\n`)
		.replace(/(const ACCOUNT_ROUTES = new Set\(\[[^\]]*?)\]\);/, `$1${INTEGRATION.accountViews}]);`);
}

// ------------------------------------------------------------ fixtures

const NORMAL = {size: 'standard', type: 'normal'};
const HOLO = {size: 'standard', type: 'holo'};
const REVERSE = {size: 'standard', type: 'reverse'};
const POKEBALL = {foil: 'pokeball', size: 'standard', type: 'reverse'};
const MASTERBALL = {foil: 'masterball', size: 'standard', type: 'reverse'};
const ARTIST = 'Aiko Testa';

const SET = {cardCount: {official: 4, total: 6}, id: 'tev', logo: null, name: 'Test Evolutions', releaseDate: '2026-01-17', serie: {id: 'tst', name: 'Test Series'}};
const NUMBERS = ['001', '002', '003', '004', '005', '006'];
const FINISHES = {
	'001': [NORMAL, REVERSE, POKEBALL, MASTERBALL],
	'002': [NORMAL, REVERSE, POKEBALL, MASTERBALL],
	'003': [HOLO, REVERSE],
	'004': [NORMAL, REVERSE, {size: 'standard', stamp: ['set-logo'], type: 'normal'}, {size: 'jumbo', type: 'normal'}],
	'005': [HOLO],
	'006': [HOLO],
};
const NAMES = {'001': 'Testlet', '002': 'Testmon', '003': 'Testazor', '004': 'Professor Test', '005': 'Testmon ex', '006': 'Golden Test'};
const RARITIES = {'001': 'Common', '002': 'Common', '003': 'Rare', '004': 'Uncommon', '005': 'Special illustration rare', '006': 'Hyper rare'};
const ILLUSTRATORS = {'002': ARTIST, '005': ARTIST};

const gqlCard = (n) => ({
	id: `tev-${n}`,
	illustrator: ILLUSTRATORS[n] || 'Kenji Test',
	image: null,
	localId: n,
	name: NAMES[n],
	rarity: RARITIES[n],
	variants: null,
	variants_detailed: FINISHES[n],
});

const OLD_CARD = {id: 'old1-010', illustrator: 'aiko testa', image: null, localId: '010', name: 'Old Testmon', rarity: 'Rare', set: {id: 'old1', name: 'Old Test Set'}, variants: {holo: true, normal: false, reverse: false}, variants_detailed: null};

// REST records, with variantIds.
const record = (n) => ({
	...gqlCard(n),
	category: 'Pokemon',
	set: {cardCount: SET.cardCount, id: 'tev', name: SET.name},
	variants_detailed: FINISHES[n].map((variant, i) => ({...variant, variantId: `tev${n}-v${i}`})),
});

const REST = {
	'en/cards/tev-001': record('001'),
	'en/cards/tev-002': record('002'),
	'en/series': [{id: 'tst', name: 'Test Series'}],
	'en/series/tst': {id: 'tst', name: 'Test Series', releaseDate: '2026-01-17', sets: [{cardCount: SET.cardCount, id: 'tev', logo: null, name: SET.name}]},
	'en/sets': [{id: 'tev', name: SET.name}],
	'en/sets/tev': {...SET, cards: NUMBERS.map((n) => ({id: `tev-${n}`, image: null, localId: n, name: NAMES[n]}))},
};

let server;
let browser;

before(async () => {
	server = await startPagesServer();
	browser = await chromium.launch();
});

after(async () => {
	await browser?.close();
	await server?.close();
});

const url = (path = '') => `${server.origin}${BASE}${path}`;

const json = (body, status = 200) => ({body: JSON.stringify(body), contentType: 'application/json', headers: {'Access-Control-Allow-Origin': '*'}, status});

async function phone() {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: PHONE});
	const seen = {graphql: [], liga: [], rest: [], supabase: []};

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route(/ligapokemon\.com\.br/, (route) => {
		seen.liga.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://*.supabase.co/**', (route) => {
		seen.supabase.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://api.frankfurter.dev/**', (route) => route.fulfill(json([])));
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await context.route('https://api.tcgdex.net/**', (route) => {
		const request = route.request();
		const target = new URL(request.url());
		const path = target.pathname.replace(/^\/v2\//, '');

		if (request.method() === 'OPTIONS') {
			return route.fulfill({headers: {'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Origin': '*'}, status: 204});
		}

		if (path === 'graphql') {
			const {query} = JSON.parse(request.postData() || '{}');

			seen.graphql.push(query);

			if (query.includes('id: "tev-"')) {
				// A substring match: another set's card comes back too.
				return route.fulfill(json({data: {cards: [...NUMBERS.map(gqlCard), {...gqlCard('001'), id: 'tev2-001'}]}}));
			}

			if (query.includes('illustrator: ')) {
				const cards = [gqlCard('002'), gqlCard('005')].map((card) => ({...card, set: {id: 'tev', name: SET.name}}));

				return route.fulfill(json({data: {cards: [...cards, OLD_CARD, {...gqlCard('004'), illustrator: 'Aiko Testarossa', set: {id: 'tev', name: SET.name}}]}}));
			}

			if (/^\{ sets /.test(query)) {
				return route.fulfill(json({data: {sets: [{id: 'tev', name: SET.name, releaseDate: SET.releaseDate, serie: {id: 'tst'}}, {id: 'old1', name: 'Old Test Set', releaseDate: '2001-05-01', serie: {id: 'old'}}]}}));
			}

			return route.fulfill(json({data: {cards: []}}));
		}

		seen.rest.push(path);

		const body = REST[decodeURIComponent(path)] || (path === 'en/sets' ? REST['en/sets'] : null);

		return route.fulfill(body ? json(body) : json({}, 404));
	});
	await context.route((target) => target.pathname === BASE || target.pathname === `${BASE}app.js`, async (route) => {
		const response = await route.fetch();
		const body = await response.text();
		const isApp = route.request().url().endsWith('app.js');

		return route.fulfill({
			body: isApp ? integrateApp(body) : body.includes('css/goals.css') ? body : body.replace('</head>', `\t${INTEGRATION.stylesheet}\n</head>`),
			contentType: isApp ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
			status: response.status(),
		});
	});
	await fakePokeApi(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));
	page.on('dialog', (dialog) => dialog.accept());

	const done = async () => {
		assert.deepEqual(errors.map(String), []);
		assert.deepEqual(await page.locator('#errors .error').allTextContents(), []);
		assert.deepEqual(seen.liga, [], 'Liga Pokémon is never requested');
		assert.deepEqual(seen.supabase, [], 'Supabase is never contacted');
		await context.close();
	};

	await page.goto(url('cards'));
	await page.waitForSelector('#cards-empty');

	// Invented copies: 001 plain in Portuguese and its Poké Ball reverse in
	// English, 003 in English, and the German secret rare 005.
	await page.evaluate(async () => {
		const collection = await import('/pokemon-card-tracker/js/collection.js');
		const catalog = await import('/pokemon-card-tracker/js/catalog.js');

		await catalog.importApi.cardDetail('en', 'tev-001');
		await collection.addCards([
			{card_id: 'tev-001', catalog: 'international', language: 'pt', language_source: 'manual'},
			{card_id: 'tev-001', catalog: 'international', language: 'en', language_source: 'manual', variant_id: 'tev001-v2'},
			{card_id: 'tev-003', catalog: 'international', language: 'en', language_source: 'manual'},
			{card_id: 'tev-005', catalog: 'international', language: 'de', language_source: 'manual'},
		]);
	});

	return {context, done, page, seen};
}

const go = (page, route) => page.evaluate(async (path) => (await import('/pokemon-card-tracker/js/dom.js')).go(path), route);

const ringText = (page) => page.locator('#goal-meta .goal-ring').textContent();

const filterTexts = (page) => page.locator('#goal-filter span[data-label]').allTextContents();

async function noSideScroll(page, where) {
	const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

	assert.ok(wide <= 0, `${where}: no sideways scroll (${wide} px)`);
}

// ---------------------------------------------------------------- tests

describe('set goals', () => {
	test('from the set page: each level counts, filters, searches, wishes, and works offline', async () => {
		const {context, done, page, seen} = await phone();

		await page.goto(url('sets/en/tev'));
		await page.waitForSelector('#set-make-goal');
		await page.click('#set-make-goal');
		await page.check('#set-goal-level-secrets');
		await page.screenshot({path: `${SHOTS}/goals-set-page.png`});
		await page.click('#set-goal-create');
		await page.waitForURL(/\/goals\/[^/]+$/);
		await page.waitForFunction(() => document.querySelector('#goal-meta .goal-ring'));

		assert.equal(await page.locator('#goal-title').textContent(), 'Test Evolutions');
		assert.equal(await ringText(page), '3 of 6');
		assert.match(await page.locator('#goal-meta').textContent(), /^With secrets/);
		assert.deepEqual(await filterTexts(page), ['All 6', 'Owned 3', 'Missing 3']);
		assert.equal(await page.locator('#goal-grid .goal-cell').count(), 6);
		assert.equal(await page.locator('#goal-grid .pc-missing').count(), 3);
		assert.equal(await page.locator('#goal-grid .pc-missing .tile.unowned').count(), 3, 'missing cards are dimmed');

		// Numbered: cards 1 to 4.
		await page.selectOption('#goal-level', 'numbered');
		await page.waitForFunction(() => document.querySelector('#goal-meta .goal-ring')?.textContent === '2 of 4');
		assert.equal(await page.locator('#goal-grid .goal-cell').count(), 4);

		// Master: every finish, the jumbo print left out.
		await page.selectOption('#goal-level', 'master');
		await page.waitForFunction(() => document.querySelector('#goal-meta .goal-ring')?.textContent === '4 of 15');
		assert.match(await page.locator('#goal-summary').textContent(), /4 of 15 finishes owned, 11 missing/);
		assert.match(await page.locator('#goal-tile-international-tev-001 .tile-meta').textContent(), /2 of 4 finishes/);
		assert.equal(await page.locator('#goal-tile-international-tev-001').getAttribute('title'), 'Normal (owned), Reverse holo, Poké Ball pattern (owned), Master Ball pattern');
		assert.deepEqual(await filterTexts(page), ['All 6', 'Owned 3', 'Missing 5']);
		await noSideScroll(page, 'goal screen');
		await page.screenshot({fullPage: true, path: `${SHOTS}/goals-master.png`});

		// Missing, then a search.
		await page.click('#goal-filter label:has-text("Missing")');
		await page.waitForFunction(() => document.querySelectorAll('#goal-grid .goal-cell').length === 5);
		await page.fill('#goal-search', 'testmon');
		await page.waitForFunction(() => document.querySelectorAll('#goal-grid .goal-cell').length === 1);
		assert.equal(await page.locator('#goal-grid .goal-cell').getAttribute('data-card'), 'tev-002');
		await page.fill('#goal-search', '');
		await page.waitForFunction(() => document.querySelectorAll('#goal-grid .goal-cell').length === 5);

		// One tap to the wishlist, with the finishes still missing on a part-owned card.
		await page.click('.goal-cell[data-card="tev-001"] .pc-wish');
		await page.waitForSelector('.goal-cell[data-card="tev-001"] .pc-wished');

		const wishes = await page.evaluate(async () => (await import('/pokemon-card-tracker/js/wishlist.js')).listWishlist());

		assert.equal(wishes.length, 1);
		assert.equal(wishes[0].card_id, 'tev-001');
		assert.equal(wishes[0].note, 'Missing: Reverse holo, Master Ball pattern');

		// Offline in a card shop: the Lists tab and the goal open from the phone.
		const before = seen.graphql.length + seen.rest.length;

		await context.setOffline(true);
		await go(page, 'lists');
		await page.waitForSelector('#goals-list .goal-tile .goal-ring');
		assert.equal(await page.locator('#goals-list .goal-tile .goal-ring').textContent(), '4 of 15');
		await page.click('#goals-list .goal-tile');
		await page.waitForFunction(() => document.querySelector('#goal-meta .goal-ring')?.textContent === '4 of 15');
		assert.equal(await page.locator('#goal-grid .goal-cell').count(), 5, 'the Missing list, offline');
		assert.equal(seen.graphql.length + seen.rest.length, before, 'nothing was asked of TCGdex offline');
		await context.setOffline(false);

		// The set page now links to the goal.
		await go(page, 'sets/en/tev');
		await page.waitForSelector('#set-goal-link');
		assert.equal(await page.locator('#set-goal-link').textContent(), 'Your goal: Master set');

		await done();
	});

	test('from New goal on the Lists tab', async () => {
		const {done, page} = await phone();

		await page.goto(url('lists'));
		await page.waitForSelector('#goals-section');
		assert.equal(await page.locator('#goals-empty').isVisible(), true);
		await page.click('#goals-new');
		await page.waitForSelector('#goal-set-results .goal-set');
		await page.fill('#goal-set-search', 'evol');
		await page.click('#goal-set-results .goal-set[data-set="tev"]');
		assert.match(await page.locator('#goal-set-chosen').textContent(), /Test Evolutions/);
		await page.check('#goal-level-numbered');
		await noSideScroll(page, 'New goal');
		await page.screenshot({fullPage: true, path: `${SHOTS}/goals-new.png`});
		await page.click('#goal-create-set');
		await page.waitForFunction(() => document.querySelector('#goal-meta .goal-ring')?.textContent === '2 of 4');

		// Languages: Portuguese only counts the Portuguese 001.
		await page.click('#list-languages-edit');
		await page.click('#list-languages-editor input[value="pt"]');
		await page.click('#list-languages-save');
		await page.waitForFunction(() => document.querySelector('#goal-meta .goal-ring')?.textContent === '1 of 4');

		// Rename, then delete.
		await page.evaluate(() => {
			window.prompt = () => 'Numbered run';
		});
		await page.click('#goal-rename');
		await page.waitForFunction(() => document.querySelector('#goal-title').textContent === 'Numbered run');
		await page.click('#goal-delete');
		await page.waitForURL(/\/lists$/);
		await page.waitForSelector('#goals-empty');
		assert.equal(await page.locator('#goals-list .goal-tile').count(), 0);

		await done();
	});
});

describe('artist goals', () => {
	test('from card detail\'s illustrator line, kept as a goal, and from New goal with suggestions', async () => {
		const {done, page, seen} = await phone();

		await page.goto(url('cards/en/tev-002'));
		await page.waitForSelector('#card-artist-goal');
		await page.click('#card-artist-goal');
		await page.waitForURL(/\/goals\/artist\/Aiko%20Testa$/);
		await page.waitForFunction(() => document.querySelector('#goal-meta .goal-ring')?.textContent === '1 of 3');
		assert.equal(await page.locator('#goal-title').textContent(), ARTIST);
		assert.ok(seen.graphql.some((query) => query.includes('illustrator: "Aiko Testa"')), 'the illustrator is asked of GraphQL');

		// Newest set first; the Testarossa card is someone else's.
		assert.deepEqual(await page.locator('#goal-grid .goal-cell').evaluateAll((cells) => cells.map((cell) => cell.dataset.card)), ['tev-002', 'tev-005', 'old1-010']);
		assert.equal(await page.locator('#goal-grid .pc-owned').getAttribute('data-card'), 'tev-005');
		assert.equal(await page.locator('#list-languages').count(), 0, 'not kept yet, so no languages to set');
		await page.screenshot({fullPage: true, path: `${SHOTS}/goals-artist.png`});

		await page.click('#goal-keep');
		await page.waitForURL(/\/goals\/(?!artist)[^/]+$/);
		await page.waitForSelector('#goal-delete');

		// The same link now opens the kept goal.
		await go(page, 'cards/en/tev-002');
		await page.waitForSelector('#card-artist-goal');
		await page.click('#card-artist-goal');
		await page.waitForSelector('#goal-delete');
		assert.match(page.url(), /\/goals\/(?!artist)[^/]+$/);

		// New goal, Artist: the owned cards' illustrators are suggested
		// (card 001's record is on the phone; 002 is not owned).
		await go(page, 'goals/new');
		await page.check('#goal-kind-artist');
		await page.waitForSelector('#goal-artist-chips .chip');
		assert.deepEqual(await page.locator('#goal-artist-chips .chip').allTextContents(), ['Kenji Test']);
		await page.click('#goal-artist-chips .chip');
		assert.equal(await page.inputValue('#goal-artist'), 'Kenji Test');
		await page.click('#goal-create-artist');
		await page.waitForSelector('#goal-title:text("Kenji Test")');

		await go(page, 'lists');
		await page.waitForFunction(() => document.querySelectorAll('#goals-list .goal-tile .goal-ring').length === 2);
		assert.deepEqual(await page.locator('#goals-list .goal-tile .list-name').allTextContents(), [ARTIST, 'Kenji Test']);
		await noSideScroll(page, 'Lists tab');
		await page.screenshot({fullPage: true, path: `${SHOTS}/goals-lists.png`});

		await done();
	});
});
