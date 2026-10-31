// Browser tests for filling binder placeholders (js/placeholder-fill.js,
// js/fill-view.js; Eric, 2026-10-31): a binder full of placeholders and
// copies in no binder, Fill placeholders with its preview, then Undo, on the
// binder and on the Binders list; and an import of the app's own CSV that
// fills a placeholder by itself and moves a wish to Got it, with Undo, and
// the setting off. Headless Chromium against tests/pages-server.mjs,
// signed out, on a wide screen.
//
// Every outside service is faked: TCGdex answers 404 (pockets show card
// ids), PokeAPI with tests/fake-pokeapi.mjs. Supabase must never be
// contacted, and ligapokemon.com.br is never requested. Cards and binders
// are invented.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/placeholder-fill-browser.test.mjs
// Screenshots: /tmp/placeholder-fill-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const WIDE = {height: 900, width: 1100};

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

async function open() {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: WIDE});
	const seen = {liga: [], supabase: []};

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route(/ligapokemon\.com\.br/, (route) => {
		seen.liga.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://*.supabase.co/**', (route) => {
		seen.supabase.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://api.frankfurter.dev/**', (route) => route.abort('blockedbyclient'));
	await context.route('https://api.tcgdex.net/**', (route) => route.fulfill({body: '{}', contentType: 'application/json', status: 404}));
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await fakePokeApi(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	const done = async () => {
		assert.deepEqual(errors.map(String), []);
		assert.deepEqual(await page.locator('#errors .error').allTextContents(), []);
		assert.deepEqual(seen.liga, [], 'Liga Pokémon is never requested');
		assert.deepEqual(seen.supabase, [], 'Supabase is never contacted');
		await context.close();
	};

	await page.goto(url('cards'));
	await page.waitForSelector('#cards-empty');

	return {done, page};
}

// Album: placeholders for tst9-001 in pockets 1 to 3 and tst9-002 in
// pocket 4, and a tst9-002 copy already in pocket 9. Copies in no binder:
// two of tst9-001 (the older one Portuguese) and one tst9-003, which no
// placeholder waits for. Added with collection.addCard, which fills
// nothing by itself.
const seed = (page) => page.evaluate(async () => {
	const collection = await import('/pokemon-card-tracker/js/collection.js');
	const binders = await import('/pokemon-card-tracker/js/binders.js');
	const add = async (cardId, language = 'en') => (await collection.addCard({card_id: cardId, catalog: 'international', language, language_source: 'manual'})).id;
	const first = await add('tst9-001', 'pt');
	const second = await add('tst9-001');
	const other = await add('tst9-003');
	const placed = await add('tst9-002');
	const album = await binders.createBinder({cols: 3, cover_color: '#1d2e60', name: 'Album', page_count: 2, rows: 3});

	for (const position of [1, 2, 3]) {
		await binders.placePlaceholder(album.id, 1, position, {card_id: 'tst9-001', catalog: 'international', name: 'Inventmon'});
	}

	await binders.placePlaceholder(album.id, 1, 4, {card_id: 'tst9-002', catalog: 'international', name: 'Fakeachu'});
	await binders.placeCard(album.id, 1, 9, placed);

	return {album: album.id, first, other, placed, second};
});

const kinds = (page, positions) => page.evaluate((list) => list.map((position) => {
	const node = document.querySelector(`#binder-spread button.pocket[data-page="1"][data-position="${position}"]`);

	return node ? node.dataset.kind : null;
}), positions);

const waitKinds = (page, positions, expected) => page.waitForFunction(({list, want}) => JSON.stringify(list.map((position) => {
	const node = document.querySelector(`#binder-spread button.pocket[data-page="1"][data-position="${position}"]`);

	return node ? node.dataset.kind : null;
})) === JSON.stringify(want), {list: positions, want: expected});

const where = (page, entryId) => page.evaluate(async (id) => (await import('/pokemon-card-tracker/js/binders.js')).binderLocation(id), entryId);

const undoOn = (page, text) => page.locator('#toasts .toast', {hasText: text}).locator('button', {hasText: 'Undo'});

describe('Fill placeholders', () => {
	test('on a binder: the preview, the fill, and Undo; placed copies stay where they are', async () => {
		const {done, page} = await open();
		const ids = await seed(page);

		await page.goto(url(`binders/${ids.album}`));
		await page.waitForSelector('#fill-placeholders-binder:not([hidden])');
		assert.deepEqual(await kinds(page, [1, 2, 3, 4, 9]), ['want', 'want', 'want', 'want', 'card']);

		await page.click('#fill-placeholders-binder');
		await page.waitForSelector('#fill-preview-binder');
		assert.equal(await page.locator('#fill-preview-binder').textContent(), '2 cards go into this binder; 2 placeholders have no copy yet. 2 pockets have no language saved, so the language of their copies is a guess (the binder\'s most common language, when it has one).');
		await page.screenshot({fullPage: true, path: '/tmp/placeholder-fill-preview.png'});

		await page.click('#fill-go-binder');
		await undoOn(page, '2 cards went into this binder.').waitFor();
		await waitKinds(page, [1, 2, 3, 4, 9], ['card', 'card', 'want', 'want', 'card']);
		// The placeholders name no language, and the binder's one copy is
		// English, so the English copy goes first, though the Portuguese one
		// is older.
		assert.equal((await where(page, ids.second)).position, 1, 'the binder\'s language first');
		assert.equal((await where(page, ids.first)).position, 2);
		assert.equal((await where(page, ids.placed)).position, 9, 'a copy already in a pocket never moves');
		assert.equal(await where(page, ids.other), null);
		await page.screenshot({fullPage: true, path: '/tmp/placeholder-fill-filled.png'});

		await undoOn(page, '2 cards went into this binder.').click();
		await waitKinds(page, [1, 2, 3, 4, 9], ['want', 'want', 'want', 'want', 'card']);
		assert.equal(await where(page, ids.first), null);
		await done();
	});

	test('on the Binders list, for every binder, and nothing to fill says so', async () => {
		const {done, page} = await open();
		const ids = await seed(page);

		await page.goto(url('binders'));
		await page.waitForSelector('#fill-placeholders-all:not([hidden])');
		await page.click('#fill-placeholders-all');
		await page.waitForSelector('#fill-preview-all');
		assert.equal(await page.locator('#fill-preview-all').textContent(), '2 cards go into 1 binder; 2 placeholders have no copy yet. 2 pockets have no language saved, so the language of their copies is a guess (the binder\'s most common language, when it has one).');
		await page.click('#fill-go-all');
		await undoOn(page, '2 cards went into binders.').waitFor();
		assert.equal((await where(page, ids.second)).binder_id, ids.album);

		// Again: no card you own is left for the two still waiting.
		await page.click('#fill-placeholders-all');
		await page.waitForSelector('#fill-preview-all');
		assert.equal(await page.locator('#fill-preview-all').textContent(), 'No card you own waits for these placeholders. 2 placeholders have no copy yet.');
		assert.equal(await page.locator('#fill-go-all').count(), 0);
		await page.click('#fill-cancel-all');
		await done();
	});
});

describe('Filling by itself', () => {
	test('an import of the app\'s own CSV fills a placeholder and moves a wish to Got it, with Undo; the setting off fills nothing', async () => {
		const {done, page} = await open();

		// A placeholder for tst9-005, a wish for it, and a CSV with one copy
		// of it that is not on this phone.
		const {album, csv, entryId} = await page.evaluate(async () => {
			const [binders, wishlist, {collectionCsv}, {cardIndex}] = await Promise.all([
				import('/pokemon-card-tracker/js/binders.js'),
				import('/pokemon-card-tracker/js/wishlist.js'),
				import('/pokemon-card-tracker/js/cards-view.js'),
				import('/pokemon-card-tracker/js/catalog.js'),
			]);
			const binder = await binders.createBinder({cols: 3, cover_color: '#1d2e60', name: 'Album', page_count: 2, rows: 3});

			await binders.placePlaceholder(binder.id, 1, 5, {card_id: 'tst9-005', catalog: 'international', name: 'Mockmon'});
			await wishlist.addToWishlist('tst9-005', {catalog: 'international'});

			const id = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000005';
			const copy = {card_id: 'tst9-005', catalog: 'international', created_at: '2026-10-31T10:00:00.000Z', deleted_at: null, id, language: 'en', language_source: 'manual', updated_at: '2026-10-31T10:00:00.000Z'};

			return {album: binder.id, csv: collectionCsv([copy], await cardIndex()), entryId: id};
		});

		await page.goto(url('import'));
		await page.setInputFiles('#monprice-file', {buffer: Buffer.from(csv), mimeType: 'text/csv', name: 'card-tracker-2026-10-31.csv'});
		await page.waitForSelector('#import-save:not([disabled])');
		await page.click('#import-save');
		await page.waitForSelector('text=Saved. 1 added');
		await undoOn(page, '1 card went into a binder. 1 wish moved to Got it.').waitFor();
		assert.deepEqual(await where(page, entryId), {binder_id: album, binder_name: 'Album', col: 2, page: 1, position: 5, row: 2});
		await page.screenshot({fullPage: true, path: '/tmp/placeholder-fill-import.png'});

		await page.goto(url('wishlist'));
		await page.waitForSelector('#wishlist-got:not([hidden]) .wl-got');
		assert.match(await page.locator('#wishlist-got .wl-got span').textContent(), /^Got it [A-Z][a-z]{2} \d{1,2}$/);
		assert.equal(await page.locator('#wishlist-items .wl-item').count(), 0, 'no longer wanted');
		await page.screenshot({fullPage: true, path: '/tmp/placeholder-fill-got.png'});

		// Want again puts it back on the list.
		await page.click('#wishlist-got .wl-got-back');
		await page.waitForSelector('#wishlist-got[hidden]', {state: 'attached'});
		await page.waitForSelector('#wishlist-items .wl-item:not(.wl-loading)');

		// With the setting off, a copy added fills nothing.
		await page.evaluate(async () => {
			const doc = await (await import('/pokemon-card-tracker/js/collection.js')).loadDocument();

			doc.settings = {...doc.settings, fill_placeholders: false};
		});

		const off = await page.evaluate(async () => (await import('/pokemon-card-tracker/js/placeholder-fill.js')).addCopies([{card_id: 'tst9-005', catalog: 'international', language: 'en'}]));

		assert.deepEqual(off.placed, []);
		await done();
	});

	test('the Undo on the import toast puts the placeholder back and the wish back to wanted', async () => {
		const {done, page} = await open();
		const {album, csv} = await page.evaluate(async () => {
			const [binders, wishlist, {collectionCsv}, {cardIndex}] = await Promise.all([
				import('/pokemon-card-tracker/js/binders.js'),
				import('/pokemon-card-tracker/js/wishlist.js'),
				import('/pokemon-card-tracker/js/cards-view.js'),
				import('/pokemon-card-tracker/js/catalog.js'),
			]);
			const binder = await binders.createBinder({cols: 3, cover_color: '#1d2e60', name: 'Album', page_count: 2, rows: 3});

			await binders.placePlaceholder(binder.id, 1, 2, {card_id: 'tst9-006', catalog: 'international', name: 'Shammon'});
			await wishlist.addToWishlist('tst9-006', {catalog: 'international'});

			const copy = {card_id: 'tst9-006', catalog: 'international', created_at: '2026-10-31T10:00:00.000Z', deleted_at: null, id: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000006', language: 'en', language_source: 'manual', updated_at: '2026-10-31T10:00:00.000Z'};

			return {album: binder.id, csv: collectionCsv([copy], await cardIndex())};
		});

		await page.goto(url('import'));
		await page.setInputFiles('#monprice-file', {buffer: Buffer.from(csv), mimeType: 'text/csv', name: 'card-tracker-2026-10-31.csv'});
		await page.waitForSelector('#import-save:not([disabled])');
		await page.click('#import-save');
		await undoOn(page, '1 card went into a binder.').click();
		await page.locator('#toasts .toast', {hasText: 'The placeholders and wishes are as they were.'}).waitFor();

		const state = await page.evaluate(async (binderId) => {
			const [binders, wishlist] = await Promise.all([import('/pokemon-card-tracker/js/binders.js'), import('/pokemon-card-tracker/js/wishlist.js')]);
			const binder = await binders.getBinder(binderId);

			return {
				pocket: binders.pageSlots(binder, 1, binders.placements([binder])).get(2).want.card_id,
				wanted: (await wishlist.listWishlist()).map((item) => item.card_id),
			};
		}, album);

		assert.deepEqual(state, {pocket: 'tst9-006', wanted: ['tst9-006']});
		await done();
	});
});
