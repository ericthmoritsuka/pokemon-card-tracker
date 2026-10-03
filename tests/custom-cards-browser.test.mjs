// Browser tests for hand-made cards and the re-import of the app's own CSV:
// adding a card by hand from My Cards, its tile and card page, editing and
// removing it, its copies' sheets and stepper, the binders' list of loose
// cards, the offer to link it once the catalog has the card, Add by hand on
// an unmatched import row, and the round trip of the CSV export through
// Import (export, a wiped phone, import, the same collection; again, nothing
// added; a deleted copy stays deleted unless ticked). Headless Chromium
// against tests/pages-server.mjs, signed out, at 390 x 844.
//
// Every outside service is faked: TCGdex answers with a few invented
// records (404 otherwise), PokeAPI with tests/fake-pokeapi.mjs. Supabase
// must never be contacted, and ligapokemon.com.br is never requested.
//
// Until index.html links css/custom-card.css, the page is served with the
// link added, so the test sees the layout the app will have.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/custom-cards-browser.test.mjs
// Screenshots: $SHOTS (default /tmp)/custom-*.png

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
const STYLESHEET = `<link rel="stylesheet" href="${BASE}css/custom-card.css">`;

// An invented Portuguese set the catalog lists, with card 007 in it.
const SET = {cardCount: {official: 147, total: 170}, id: 'tst1', name: 'Conjunto de teste'};
const CARD = {id: 'tst1-007', localId: '007', name: 'Carta de teste', set: SET, variants_detailed: [{type: 'Normal', variantId: 'v-normal'}]};
const RECORDS = {
	'pt/cards/tst1-007': CARD,
	'pt/series': [{id: 'tst', name: 'Test series'}],
	'pt/series/tst': {id: 'tst', name: 'Test series', sets: [{cardCount: SET.cardCount, id: 'tst1', name: SET.name}]},
	'pt/sets': [],
	'pt/sets/tst1': {...SET, cards: [{id: 'tst1-007', localId: '007', name: 'Carta de teste'}]},
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

const url = (path = '') => `${server.origin}${BASE}${path}`;

// catalog.full false answers 404 for the set lists, as for a phone that
// never reached them.
async function phone({catalog = {full: true}} = {}) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: PHONE});
	const seen = {liga: [], supabase: [], tcgdex: []};

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route(/ligapokemon\.com\.br/, (route) => {
		seen.liga.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://*.supabase.co/**', (route) => {
		seen.supabase.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://api.frankfurter.dev/**', (route) => route.fulfill({body: '[]', contentType: 'application/json', headers: {'Access-Control-Allow-Origin': '*'}, status: 200}));
	await context.route('https://api.tcgdex.net/**', (route) => {
		const path = new URL(route.request().url()).pathname.replace(/^\/v2\//, '');
		const record = catalog.full || path.includes('/cards/') ? RECORDS[path] : null;

		seen.tcgdex.push(path);

		return route.fulfill(record
			? {body: JSON.stringify(record), contentType: 'application/json', headers: {'Access-Control-Allow-Origin': '*'}, status: 200}
			: {body: '{}', contentType: 'application/json', headers: {'Access-Control-Allow-Origin': '*'}, status: 404});
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await context.route((target) => target.pathname === BASE, async (route) => {
		const response = await route.fetch();
		const body = await response.text();

		return route.fulfill({
			body: body.includes('css/custom-card.css') ? body : body.replace('</head>', `\t${STYLESHEET}\n</head>`),
			contentType: 'text/html; charset=utf-8',
			status: response.status(),
		});
	});
	await fakePokeApi(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	const done = async () => {
		assert.deepEqual(errors.map(String), []);
		assert.deepEqual(await page.locator('#errors .error').allTextContents(), []);
		assert.deepEqual(seen.liga, [], 'Liga Pokémon is never requested');
		assert.deepEqual(seen.supabase, [], 'Supabase is never contacted');
		assert.ok(!seen.tcgdex.some((path) => /hand_|custom\//.test(path)), 'a hand-made card is never asked of TCGdex');
		await context.close();
	};

	await page.goto(url('cards'));
	await page.waitForSelector('#cards-empty');

	return {context, done, page, seen};
}

const collection = (page, call, ...args) => page.evaluate(async ([name, list]) => {
	const module = await import('/pokemon-card-tracker/js/collection.js');

	return module[name](...list);
}, [call, args]);

const liveEntries = async (page) => (await collection(page, 'loadDocument')).cards.filter((entry) => !entry.deleted_at);

async function fillHandSheet(page, {count = null, language = null, name, number = '', setCode = '', setName = ''}) {
	await page.waitForSelector('#hand-sheet[open]');
	await page.fill('#hand-name', name);
	await page.fill('#hand-set', setName);
	await page.fill('#hand-code', setCode);
	await page.fill('#hand-number', number);

	if (language) {
		await page.selectOption('#hand-language', language);
	}

	if (count) {
		await page.fill('#hand-count', String(count));
	}
}

describe('hand-made cards', () => {
	test('added from My Cards: its page, tile, copies, edit, and removal with Undo', async () => {
		const {done, page} = await phone();

		await page.click('#cards-empty-hand');
		assert.equal(await page.locator('#hand-sheet-title').textContent(), 'Add a card by hand');
		await page.click('#hand-save');
		assert.equal(await page.locator('#hand-error').textContent(), 'Give the card a name.');

		await fillHandSheet(page, {count: 2, language: 'ko', name: '테스트 에너지', number: 'R', setCode: 'XYZ', setName: 'Invented set'});
		await page.selectOption('#hand-finish', 'HOLOFOIL');
		await page.selectOption('#hand-condition', 'Near Mint');
		await page.screenshot({path: `${SHOTS}/custom-sheet.png`});
		await page.click('#hand-save');

		// Its page: the name, set, code, number, and two alike copies.
		await page.waitForSelector('#custom-detail .copies .copy-row');
		assert.match(page.url(), /\/cards\/ko\/hand_[0-9a-f]{32}$/);
		assert.equal(await page.locator('#custom-name').textContent(), '테스트 에너지');
		assert.deepEqual(await page.locator('#custom-detail .facts dd').allTextContents(), ['Invented set', 'XYZ', 'R', 'Hand-made card']);
		assert.equal(await page.locator('.copies-head h3').textContent(), 'Your copies (2)');
		assert.deepEqual(await page.locator('.copies .copy-text').allTextContents(), ['Holo · Near Mint']);
		assert.equal(await page.locator('.copies .step-count').inputValue(), '2');
		assert.equal(await page.locator('#card-liga, #card-price').count(), 0, 'no Liga, US, or EU prices');
		assert.ok(await page.locator('#custom-detail .ph-card').isVisible(), 'the photo block, for Add photo');
		assert.equal(await page.locator('#custom-link-offer').count(), 0, 'no catalog card to link');
		await page.screenshot({fullPage: true, path: `${SHOTS}/custom-page.png`});

		const entries = await liveEntries(page);

		assert.equal(entries.length, 2);
		assert.ok(entries.every((entry) => entry.catalog === 'custom' && entry.card_id === entries[0].card_id && entry.language === 'ko' && entry.finish_raw === 'HOLOFOIL' && entry.number_local === 'R'));

		// + adds a copy alike; the row's sheet edits notes.
		await page.click('.copies .step-more');
		await page.waitForFunction(() => document.querySelector('.copies .step-count').value === '3');
		await page.click('.copies .copy-row');
		await page.waitForSelector('#copy-sheet[open]');
		assert.ok((await page.locator('#copy-language option').allTextContents()).includes('Korean'));
		assert.deepEqual(await page.locator('#copy-finish option').allTextContents(), ['Not set', '1st Edition', 'Holo', 'Normal', 'Reverse holo', 'Unlimited', 'Unlimited holo']);
		assert.equal(await page.locator('#copy-finish').inputValue(), 'HOLOFOIL');
		await page.check('input[name="copy-scope"][value="all"]');
		await page.fill('#copy-notes', 'From a trade');
		await page.click('#copy-save');
		await page.waitForSelector('.copies .copy-note');
		assert.equal(await page.locator('.copies .copy-note').textContent(), 'From a trade');
		assert.ok((await liveEntries(page)).every((entry) => entry.notes === 'From a trade' && !entry.fallback));

		// Edit card renames every copy.
		await page.click('#custom-edit');
		await page.waitForSelector('#hand-sheet[open]');
		assert.equal(await page.locator('#hand-name').inputValue(), '테스트 에너지');
		assert.equal(await page.locator('#hand-language').count(), 0, 'copies are edited on their rows');
		await page.fill('#hand-name', 'Test energy');
		await page.click('#hand-save');
		await page.waitForFunction(() => document.querySelector('#custom-name').textContent === 'Test energy');
		assert.ok((await liveEntries(page)).every((entry) => entry.name_local === 'Test energy'));

		// My Cards: one tile with the name, the card back, and the route.
		await page.click('a.back');
		await page.waitForSelector('.card-grid .tile');
		assert.equal(await page.locator('.card-grid .tile').count(), 1);
		assert.match(await page.locator('.card-grid .tile').first().textContent(), /Test energy/);
		assert.match(await page.locator('.card-grid .tile a, .card-grid a.tile').first().getAttribute('href'), /\/cards\/ko\/hand_/);
		assert.ok(await page.locator('#cards-add-hand').isVisible());
		await page.screenshot({path: `${SHOTS}/custom-my-cards.png`});

		// Not in a binder yet: listed with its name, ready to place.
		await page.goto(url('binders/unplaced'));
		await page.waitForSelector('#unplaced-grid .tile');
		assert.match(await page.locator('#unplaced-grid').textContent(), /Test energy/);

		// Remove card takes every copy, and Undo brings them back.
		await page.goto(url('cards'));
		await page.click('.card-grid .tile a, .card-grid a.tile');
		await page.waitForSelector('#custom-remove');
		await page.click('#custom-remove');
		await page.waitForSelector('#custom-gone');
		assert.equal((await liveEntries(page)).length, 0);
		await page.click('.toast button');
		await page.waitForSelector('#custom-detail .copies .copy-row');
		assert.equal((await liveEntries(page)).length, 3);
		await done();
	});

	test('a catalog card with the same set and number is offered, and linking keeps the copies', async () => {
		const {done, page} = await phone();

		await page.click('#cards-empty-hand');
		await fillHandSheet(page, {language: 'pt', name: 'Carta feita à mão', number: '7', setCode: 'tst1', setName: 'Conjunto de teste'});
		await page.click('#hand-save');
		await page.waitForSelector('#custom-link-offer');
		assert.match(await page.locator('#custom-link-offer').textContent(), /Carta de teste, number 007, in Conjunto de teste/);

		const [before] = await liveEntries(page);

		await page.click('#custom-link');
		await page.waitForURL(/\/cards\/pt\/tst1-007$/);
		await page.waitForSelector('.copies .copy-row');

		const [linked] = await liveEntries(page);

		assert.equal(linked.id, before.id, 'the same copy');
		assert.deepEqual([linked.catalog, linked.card_id, linked.fallback, linked.number_local, linked.set_code], ['international', 'tst1-007', false, null, null]);
		await done();
	});

	test('Add by hand on an unmatched import row, prefilled from it', async () => {
		const {done, page} = await phone({catalog: {full: false}});
		const csv = 'Name;Set;Number;Language;Finish Type;Count;ID;Release Date\r\nInvented energy;Invented set;R;PT;HOLOFOIL;2;zzz_int_R;2026-01-01\r\n';

		await page.goto(url('import'));
		await page.setInputFiles('#monprice-file', {buffer: Buffer.from(csv), mimeType: 'text/csv', name: 'monprice.csv'});
		await page.waitForSelector('.report-hand');
		await page.screenshot({fullPage: true, path: `${SHOTS}/custom-import-report.png`});
		await page.click('.report-hand');
		await page.waitForSelector('#hand-sheet[open]');
		assert.equal(await page.locator('#hand-name').inputValue(), 'Invented energy');
		assert.equal(await page.locator('#hand-set').inputValue(), 'Invented set');
		assert.equal(await page.locator('#hand-code').inputValue(), 'zzz');
		assert.equal(await page.locator('#hand-number').inputValue(), 'R');
		assert.equal(await page.locator('#hand-language').inputValue(), 'pt');
		assert.equal(await page.locator('#hand-finish').inputValue(), 'HOLOFOIL');
		assert.equal(await page.locator('#hand-count').inputValue(), '2');
		await page.click('#hand-save');
		await page.waitForSelector('.report-hand-done');
		assert.match(page.url(), /\/import$/, 'the report stays open for the next row');

		const entries = await liveEntries(page);

		assert.equal(entries.length, 2);
		assert.ok(entries.every((entry) => entry.catalog === 'custom' && entry.name_local === 'Invented energy'));
		await done();
	});
});

describe('the app\'s own CSV through Import', () => {
	test('export, a wiped phone, import: the same collection; again: nothing added; deleted stays deleted unless ticked', async () => {
		const first = await phone();
		const at = '2026-09-01T10:00:00.000Z';

		await collection(first.page, 'addCard', {card_id: 'tst1-007', catalog: 'international', condition: 'Lightly Played', created_at: at, language: 'pt', language_source: 'scan', notes: 'Bought; at a "fair"', price_manual: {avg: 12, currency: 'BRL', date: '2026-10-01', low_nm: 9.5, source: 'Liga Pokémon'}, variant_id: 'v-normal'});
		await collection(first.page, 'addCard', {card_id: 'M6-012', catalog: 'ja', created_at: '2026-09-02T10:00:00.000Z', fallback: true, finish_raw: 'HOLOFOIL', import_key: 'monprice|M6_kr_12|ko|HOLOFOIL|0', language: 'ko', language_source: 'import', name_local: '테스트', set_name_local: '세트', variant_id: null});
		await collection(first.page, 'addCards', [{card_id: `hand_${'a'.repeat(32)}`, catalog: 'custom', created_at: '2026-09-03T10:00:00.000Z', finish_raw: 'REVERSE_HOLOFOIL', language: 'zh-cn', language_source: 'manual', name_local: 'Hand card, with comma', number_local: '001', set_code: 'CBB4C', set_name_local: 'Gem pack', variant_id: null}]);

		const text = await first.page.evaluate(async () => {
			const [{collectionCsv}, {listCards}, {cardIndex}] = await Promise.all([
				import('/pokemon-card-tracker/js/cards-view.js'),
				import('/pokemon-card-tracker/js/collection.js'),
				import('/pokemon-card-tracker/js/catalog.js'),
			]);
			const entries = await listCards();

			return collectionCsv([...entries].sort((a, b) => a.created_at.localeCompare(b.created_at)), await cardIndex());
		});
		const original = await liveEntries(first.page);

		await first.done();

		// A wiped phone: a new browser profile.
		const second = await phone();
		const {page} = second;

		await page.goto(url('import'));
		await page.setInputFiles('#monprice-file', {buffer: Buffer.from(text), mimeType: 'text/csv', name: 'card-tracker-2026-10-03.csv'});
		await page.waitForSelector('#import-save');
		assert.match(await page.locator('.report-line summary').first().textContent(), /New on this phone: 3 copies/);
		await page.waitForSelector('text=a Card Tracker export, 3 rows, one per copy');
		await page.screenshot({fullPage: true, path: `${SHOTS}/custom-own-report.png`});
		await page.click('#import-save');
		await page.waitForSelector('text=Saved. 3 added');

		const KEYS = ['id', 'card_id', 'catalog', 'variant_id', 'finish_raw', 'fallback', 'language', 'import_key', 'name_local', 'set_name_local', 'condition', 'notes', 'number_local', 'set_code', 'created_at'];
		const shape = (list) => list
			.map((entry) => Object.fromEntries(KEYS.map((key) => [key, key === 'fallback' ? Boolean(entry[key]) : entry[key] ?? null]).concat([['price', entry.price_manual ? [entry.price_manual.low_nm, entry.price_manual.avg, entry.price_manual.currency] : null]])))
			.sort((a, b) => a.id.localeCompare(b.id));
		const restored = await liveEntries(page);

		assert.deepEqual(shape(restored), shape(original), 'the same collection');

		// The same file again: nothing to save.
		await page.goto(url('import'));
		await page.setInputFiles('#monprice-file', {buffer: Buffer.from(text), mimeType: 'text/csv', name: 'card-tracker-2026-10-03.csv'});
		await page.waitForSelector('#import-save');
		assert.equal(await page.locator('#import-save').textContent(), 'Nothing to save');
		assert.ok(await page.locator('#import-save').isDisabled());

		// One copy deleted here stays deleted, unless ticked.
		await collection(page, 'deleteCard', original.find((entry) => entry.catalog === 'custom').id);
		await page.goto(url('import'));
		await page.setInputFiles('#monprice-file', {buffer: Buffer.from(text), mimeType: 'text/csv', name: 'card-tracker-2026-10-03.csv'});
		await page.waitForSelector('#import-deleted');
		assert.equal(await page.locator('#import-save').textContent(), 'Nothing to save');
		await page.check('#import-revive');
		assert.equal(await page.locator('#import-save').textContent(), 'Save 1 copy');
		await page.click('#import-save');
		await page.waitForSelector('text=1 brought back');
		assert.equal((await liveEntries(page)).length, 3);

		// The hand-made card shows in My Cards with its own name.
		await page.goto(url('cards'));
		await page.waitForSelector('.card-grid .tile');
		assert.match(await page.locator('.card-grid').textContent(), /Hand card, with comma/);
		await second.done();
	});
});
